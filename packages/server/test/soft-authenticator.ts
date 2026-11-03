import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor> | { [key: string]: Cbor }

function head(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length])
  if (length < 256) return Buffer.from([(major << 5) | 24, length])
  const b = Buffer.alloc(3)
  b[0] = (major << 5) | 25
  b.writeUInt16BE(length, 1)
  return b
}

/** Minimal CBOR encoder: small ints, text, bytes and maps — all WebAuthn "none" attestation needs. */
function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value)
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8')
    return Buffer.concat([head(3, bytes.length), bytes])
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)])
  const entries: Array<[Cbor, Cbor]> = value instanceof Map ? [...value.entries()] : Object.entries(value)
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)])])
}

const u32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}
const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url')

/** A software FIDO2 authenticator producing real ES256 registration and assertion responses. */
export class SoftAuthenticator {
  private readonly credentials = new Map<string, { privateKey: KeyObject; counter: number }>()
  private readonly rpIdHash: Buffer

  constructor(
    private readonly origin: string,
    rpID: string,
  ) {
    this.rpIdHash = createHash('sha256').update(rpID).digest()
  }

  register(options: { challenge: string }) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
    const credentialId = randomBytes(16)
    const coseKey = cbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, 'base64url')],
        [-3, Buffer.from(jwk.y, 'base64url')],
      ]),
    )
    const lengthBytes = Buffer.alloc(2)
    lengthBytes.writeUInt16BE(credentialId.length)
    const authData = Buffer.concat([
      this.rpIdHash,
      Buffer.from([0x45]),
      u32(0),
      Buffer.alloc(16),
      lengthBytes,
      credentialId,
      coseKey,
    ])
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: 'webauthn.create',
        challenge: options.challenge,
        origin: this.origin,
        crossOrigin: false,
      }),
    )
    const id = b64url(credentialId)
    this.credentials.set(id, { privateKey, counter: 0 })
    return {
      id,
      rawId: id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(cbor({ fmt: 'none', attStmt: {}, authData })),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    }
  }

  authenticate(
    options: { challenge: string; allowCredentials?: Array<{ id: string }> },
    credentialId?: string,
  ) {
    const id = credentialId ?? options.allowCredentials?.[0]?.id
    const credential = id ? this.credentials.get(id) : undefined
    if (!id || !credential) throw new Error('No matching credential in the soft authenticator')
    credential.counter += 1
    const authData = Buffer.concat([this.rpIdHash, Buffer.from([0x05]), u32(credential.counter)])
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: options.challenge,
        origin: this.origin,
        crossOrigin: false,
      }),
    )
    const signed = Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()])
    return {
      id,
      rawId: id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(sign('sha256', signed, credential.privateKey)),
      },
      clientExtensionResults: {},
    }
  }

  /** Simulates a cloned authenticator by moving the signature counter backwards. */
  rewind(credentialId: string): void {
    const credential = this.credentials.get(credentialId)
    if (credential) credential.counter = 0
  }
}
