import { createHash, createHmac, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Phase 3a-1 spec §5.2: a SCRAM client (RFC 5802 / 7677) for the proxy to authenticate upstream, so
 * the worker never receives credentials. MongoDB uses SCRAM-SHA-1 with an MD5(user:mongo:pass)
 * "digest" password and SCRAM-SHA-256 with the raw password (SASLprep, approximated by the trim the
 * driver also applies). The messages are the `payload` of saslStart / saslContinue commands.
 */
export type ScramMechanism = 'SCRAM-SHA-1' | 'SCRAM-SHA-256'

interface Hasher {
  digest: 'sha1' | 'sha256'
  keyLength: number
}
const HASHERS: Record<ScramMechanism, Hasher> = {
  'SCRAM-SHA-1': { digest: 'sha1', keyLength: 20 },
  'SCRAM-SHA-256': { digest: 'sha256', keyLength: 32 },
}

function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ b[i]!
  return out
}

function hmac(digest: string, key: Buffer, data: string | Buffer): Buffer {
  return createHmac(digest, key).update(data).digest()
}

function h(digest: string, data: Buffer): Buffer {
  return createHash(digest).update(data).digest()
}

/** MongoDB's password for SCRAM-SHA-1 is MD5 of "user:mongo:password", hex. SHA-256 uses it raw. */
function mongoPassword(mechanism: ScramMechanism, username: string, password: string): string {
  if (mechanism === 'SCRAM-SHA-256') return password
  return createHash('md5').update(`${username}:mongo:${password}`).digest('hex')
}

/**
 * Security review 2026-10-16 (I-4): PBKDF2 (15 000 iterations by MongoDB's default) ran on the
 * server's main thread for every proxy connection and every kill. It now runs on libuv's thread
 * pool, and a salted password is kept per connection, mechanism, password, salt and iteration count,
 * as the drivers do. Keyed by a hash of the password, never the password itself; at most 64 kept, the
 * oldest dropped first. Kept per connection (second review 2026-10-16): a server replaying a salt
 * cannot learn by timing whether another connection uses the same password, and a connection's
 * entries go when it is changed or deleted (forgetScram).
 */
const SALTED = new Map<string, { scope: string; derived: Buffer }>()
// CodeQL 2026-11-01: the password in a key is an HMAC under a key this process makes and never
// shows, so a key read out of memory says nothing about the password elsewhere.
const CACHE_KEY = randomBytes(32)
const MAX_SALTED = 64
let derivations = 0

/**
 * The iteration counts accepted: the Node driver refuses fewer than 4096; more than a million would
 * only let a hostile server hold a thread for minutes (2 147 483 647: hours).
 */
const MIN_ITERATIONS = 4096
const MAX_ITERATIONS = 1_000_000

/** How many salted passwords were derived so far (for tests). */
export function scramDerivations(): number {
  return derivations
}

/** Forget a connection's salted passwords: it was changed or deleted. */
export function forgetScram(scope: string): void {
  for (const [key, entry] of SALTED) if (entry.scope === scope) SALTED.delete(key)
}

async function saltedPassword(
  hasher: Hasher,
  password: string,
  salt: Buffer,
  iterations: number,
  scope: string,
): Promise<Buffer> {
  const key = [
    scope,
    hasher.digest,
    createHmac('sha256', CACHE_KEY).update(password).digest('base64'),
    salt.toString('base64'),
    iterations,
  ].join('\u0000')
  const known = SALTED.get(key)
  if (known) return known.derived
  derivations++
  const derived = await new Promise<Buffer>((resolve, reject) =>
    pbkdf2(password, salt, iterations, hasher.keyLength, hasher.digest, (err, out) =>
      err ? reject(err) : resolve(out),
    ),
  )
  if (SALTED.size >= MAX_SALTED) SALTED.delete(SALTED.keys().next().value as string)
  SALTED.set(key, { scope, derived })
  return derived
}

/** RFC 5802 §5.1: `,` and `=` in the username are escaped. */
function saslName(name: string): string {
  return name.split('=').join('=3D').split(',').join('=2C')
}

/**
 * A SCRAM conversation. `start()` gives the client-first payload; `handleServerFirst()` gives the
 * client-final payload; `verifyServerFinal()` checks the server signature. Payloads are the raw
 * SASL message bytes carried in the saslStart/saslContinue `payload`.
 */
export class ScramConversation {
  private readonly hasher: Hasher
  private readonly clientNonce: string
  private readonly password: string
  private clientFirstBare = ''
  private serverSignature: Buffer | null = null

  constructor(
    private readonly mechanism: ScramMechanism,
    private readonly username: string,
    password: string,
    nonce: Buffer = randomBytes(24),
    /** The connection the credentials are of: the salted-password cache is kept per connection. */
    private readonly scope = '',
  ) {
    this.hasher = HASHERS[mechanism]
    this.clientNonce = nonce.toString('base64')
    this.password = mongoPassword(mechanism, username, password)
  }

  start(): Buffer {
    this.clientFirstBare = `n=${saslName(this.username)},r=${this.clientNonce}`
    return Buffer.from(`n,,${this.clientFirstBare}`, 'utf8')
  }

  async clientFinal(serverFirst: Buffer): Promise<Buffer> {
    const text = serverFirst.toString('utf8')
    const attrs = Object.fromEntries(text.split(',').map((p) => [p[0], p.slice(2)]))
    const rnonce = attrs.r
    const salt = Buffer.from(attrs.s ?? '', 'base64')
    const iterations = Number(attrs.i)
    if (!rnonce || !rnonce.startsWith(this.clientNonce)) throw new Error('scram: server nonce mismatch')
    if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS)
      throw new Error(`scram: iteration count ${attrs.i} out of bounds`)

    const { digest } = this.hasher
    const salted = await saltedPassword(this.hasher, this.password, salt, iterations, this.scope)
    const clientKey = hmac(digest, salted, 'Client Key')
    const storedKey = h(digest, clientKey)
    const clientFinalNoProof = `c=biws,r=${rnonce}`
    const authMessage = `${this.clientFirstBare},${text},${clientFinalNoProof}`
    const clientSignature = hmac(digest, storedKey, authMessage)
    const clientProof = xor(clientKey, clientSignature)
    const serverKey = hmac(digest, salted, 'Server Key')
    this.serverSignature = hmac(digest, serverKey, authMessage)
    return Buffer.from(`${clientFinalNoProof},p=${clientProof.toString('base64')}`, 'utf8')
  }

  verifyServerFinal(serverFinal: Buffer): void {
    const text = serverFinal.toString('utf8')
    const attrs = Object.fromEntries(text.split(',').map((p) => [p[0], p.slice(2)]))
    if (attrs.e) throw new Error(`scram: server error ${attrs.e}`)
    const received = Buffer.from(attrs.v ?? '', 'base64')
    if (
      !this.serverSignature ||
      received.length !== this.serverSignature.length ||
      !timingSafeEqual(received, this.serverSignature)
    ) {
      throw new Error('scram: server signature mismatch')
    }
  }
}
