// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it, vi } from 'vitest'
import { Binary } from 'bson'
import selfsigned from 'selfsigned'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { autoEncryptionFor, kmsProvidersFor, masterKeyProblem } from '../src/encryption/options'
import type { ConnectionPolicy } from '../src/connections/policy'
import { createEgress } from '../src/net/egress'

const KEY = Buffer.alloc(96, 7).toString('base64')
const policy = (over: Partial<ConnectionPolicy> = {}): ConnectionPolicy => ({
  teamMode: false,
  allowKerberos: false,
  allowWorkloadIdentity: false,
  cryptSharedLibPath: undefined,
  kmsAllowedHosts: [],
  modules: {
    distribution: 'npm',
    clientEncryption: { status: 'available', version: '6.5.0' },
    kerberos: { status: 'missing', version: null },
  },
  ...over,
})
const settings = (e: object = {}) =>
  ConnectionSettingsSchema.parse({
    hosts: [{ host: 'db.example' }],
    encryption: {
      enabled: true,
      keyVaultNamespace: 'encryption.__keyVault',
      kms: { local: { key: KEY } },
      cryptSharedLibPath: '/opt/mongo_crypt_v1.so',
      ...e,
    },
  })
const egress = createEgress({ networks: [], networksSetting: 'MM_KMS_PRIVATE_NETWORKS' })

describe('W8: the KMS providers of a connection', () => {
  it('maps every provider with the connection’s own credentials, never an on-demand (host) identity', () => {
    const kms = kmsProvidersFor(
      settings({
        kms: {
          local: { key: KEY },
          aws: { accessKeyId: 'AKIA', secretAccessKey: 's', sessionToken: 't' },
          azure: {
            tenantId: 't',
            clientId: 'c',
            clientSecret: 's',
            identityPlatformEndpoint: 'login.example',
          },
          gcp: { email: 'sa@p.iam', privateKey: 'k' },
          kmip: { endpoint: 'kmip.example' },
        },
      }).encryption!,
    )
    expect(Buffer.from(kms.local!.key as Uint8Array)).toEqual(Buffer.alloc(96, 7))
    expect(kms.aws).toEqual({ accessKeyId: 'AKIA', secretAccessKey: 's', sessionToken: 't' })
    expect(kms.azure).toEqual({
      tenantId: 't',
      clientId: 'c',
      clientSecret: 's',
      identityPlatformEndpoint: 'login.example',
    })
    expect(kms.gcp).toEqual({ email: 'sa@p.iam', privateKey: 'k' })
    // A KMIP endpoint always has a port (5696 by default).
    expect(kms.kmip).toEqual({ endpoint: 'kmip.example:5696' })
    for (const p of Object.values(kms)) expect(Object.keys(p as object).length).toBeGreaterThan(0)
  })

  it('leaves out a provider whose secret was never stored (no empty provider: the host’s identity)', () => {
    const s = settings({ kms: { aws: { accessKeyId: 'AKIA', secretAccessKey: 'x' } } })
    delete (s.encryption!.kms.aws as { secretAccessKey?: string }).secretAccessKey
    expect(() => kmsProvidersFor(s.encryption!)).toThrow(/aws/)
  })
})

describe('W8: automatic encryption options', () => {
  it('loads the crypt_shared library named, required, and never spawns mongocryptd then', async () => {
    const o = await autoEncryptionFor(settings(), policy(), egress)
    expect(o.keyVaultNamespace).toBe('encryption.__keyVault')
    expect(o.extraOptions).toEqual({
      cryptSharedLibPath: '/opt/mongo_crypt_v1.so',
      cryptSharedLibRequired: true,
      mongocryptdBypassSpawn: true,
      // Security review I1: never the system's library search.
      cryptSharedLibSearchPaths: [],
    })
    expect(o.bypassAutoEncryption).toBeUndefined()
  })

  it('loads only the operator’s library in team mode', async () => {
    const o = await autoEncryptionFor(
      settings({ cryptSharedLibPath: undefined }),
      policy({ teamMode: true, cryptSharedLibPath: '/srv/lib/mongo_crypt_v1.so' }),
      egress,
    )
    expect(o.extraOptions?.cryptSharedLibPath).toBe('/srv/lib/mongo_crypt_v1.so')
  })

  it('spawns mongocryptd from PATH only, never from a path a connection names', async () => {
    const o = await autoEncryptionFor(
      settings({ library: 'mongocryptd', mongocryptdUri: 'mongodb://localhost:27020' }),
      policy(),
      egress,
    )
    // Security review I1: and no system search for a crypt_shared library ($SYSTEM, the driver's
    // default whenever none is named) — mongocryptd mode would otherwise load one from the library path.
    expect(o.extraOptions).toEqual({
      mongocryptdURI: 'mongodb://localhost:27020',
      cryptSharedLibSearchPaths: [],
    })
    expect(o.extraOptions).not.toHaveProperty('mongocryptdSpawnPath')
  })

  it('reads only (decrypts) in decryptOnly mode', async () => {
    const o = await autoEncryptionFor(settings({ mode: 'decryptOnly' }), policy(), egress)
    expect(o.bypassAutoEncryption).toBe(true)
  })

  it('takes the entered maps as Extended JSON, key ids as UUIDs', async () => {
    const schemaMap = JSON.stringify({
      'shop.people': {
        bsonType: 'object',
        properties: {
          ssn: {
            encrypt: {
              keyId: [{ $binary: { base64: 'AAAAAAAAAAAAAAAAAAAAAA==', subType: '04' } }],
              bsonType: 'string',
              algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Deterministic',
            },
          },
        },
      },
    })
    const o = await autoEncryptionFor(settings({ schemaMap }), policy(), egress)
    const keyId = (o.schemaMap as Record<string, { properties: { ssn: { encrypt: { keyId: unknown[] } } } }>)[
      'shop.people'
    ]!.properties.ssn.encrypt.keyId[0]
    expect(keyId).toBeInstanceOf(Binary)
  })

  it('refuses a map that is not Extended JSON or not keyed by namespaces, without quoting it', async () => {
    await expect(
      autoEncryptionFor(settings({ schemaMap: '{"a.b": {"secret-value": ' }), policy(), egress),
    ).rejects.toThrow(/not valid Extended JSON/)
    await expect(
      autoEncryptionFor(settings({ schemaMap: '{"a.b": {"x": 1}' }), policy(), egress).catch(
        (e: Error) => e.message,
      ),
    ).resolves.not.toContain('secret')
    await expect(
      autoEncryptionFor(settings({ encryptedFieldsMap: '{"nodot": {"fields": []}}' }), policy(), egress),
    ).rejects.toThrow(/database.collection/)
  })

  // Abuse case: a KMS endpoint naming the cloud metadata service (or any address the egress guard
  // refuses) is never reached: every KMS socket is opened through it.
  it('opens every KMS socket through the egress guard', async () => {
    const socket = vi.fn(egress.socket)
    const o = await autoEncryptionFor(
      settings(),
      policy({ kmsAllowedHosts: ['169.254.169.254', '10.0.0.5:5696'] }),
      { ...egress, socket },
    )
    const signal = new AbortController().signal
    await expect(o.kmsConnectCallback!({ host: '169.254.169.254', port: 443, signal })).rejects.toMatchObject(
      {
        reason: 'address_never',
      },
    )
    await expect(o.kmsConnectCallback!({ host: '10.0.0.5', port: 5696, signal })).rejects.toMatchObject({
      reason: 'address_refused',
    })
    expect(socket).toHaveBeenCalledTimes(2)
  })
})

describe('W8 (security review C1): KMS sockets go only to key management services', () => {
  const okSocket = () => vi.fn(async () => ({ fake: true }) as never)
  const signal = new AbortController().signal

  // Abuse case: an editor rewrites a data key's masterKey.keyVaultEndpoint (Azure) or endpoint (GCP)
  // to their own host; the next decrypting read would send them a token minted with the
  // connection's sealed secret.
  it('refuses any host that is not a key management service, the connection’s own or the operator’s', async () => {
    const socket = okSocket()
    const o = await autoEncryptionFor(settings(), policy(), { socket })
    for (const host of [
      'attacker.example',
      'vault.azure.net.attacker.example',
      'evil-googleapis.com',
      // Re-review item 2: any other Google API (storage serves anyone's bucket), and any other AWS host.
      'storage.googleapis.com',
      'attacker-bucket.storage.googleapis.com',
      'x.cloudkms.googleapis.com',
      'kms.attacker.amazonaws.com',
      'kms.us-east-1.s3.amazonaws.com',
      'kms.attacker-bucket-1.amazonaws.com',
    ])
      await expect(o.kmsConnectCallback!({ host, port: 443, signal }), host).rejects.toMatchObject({
        reason: 'kms_host_not_allowed',
      })
    expect(socket).not.toHaveBeenCalled()
  })

  it('reaches the providers’ own hosts on 443 only', async () => {
    const socket = okSocket()
    const o = await autoEncryptionFor(settings(), policy(), { socket })
    for (const host of [
      'kms.eu-west-1.amazonaws.com',
      'kms-fips.us-east-1.amazonaws.com',
      'myvault.vault.azure.net',
      'myhsm.managedhsm.azure.net',
      'login.microsoftonline.com',
      'login.microsoftonline.us',
      'myvault.vault.usgovcloudapi.net',
      'oauth2.googleapis.com',
      'cloudkms.googleapis.com',
      'cloudkms.europe-west1.rep.googleapis.com',
      'kms.us-gov-west-1.amazonaws.com',
      'kms.cn-north-1.amazonaws.com.cn',
      'kms-fips.ca-central-1.amazonaws.com',
    ])
      await expect(o.kmsConnectCallback!({ host, port: 443, signal }), host).resolves.toBeDefined()
    await expect(
      o.kmsConnectCallback!({ host: 'myvault.vault.azure.net', port: 8443, signal }),
    ).rejects.toMatchObject({ reason: 'kms_host_not_allowed' })
    expect(socket).toHaveBeenCalledTimes(13)
  })

  it('reaches the endpoints the connection names, and the operator’s list (MM_KMS_ALLOWED_HOSTS)', async () => {
    const socket = okSocket()
    const s = settings({
      kms: {
        kmip: { endpoint: 'kmip.corp.example' },
        azure: {
          tenantId: 't',
          clientId: 'c',
          clientSecret: 's',
          identityPlatformEndpoint: 'login.corp.example:8443',
        },
      },
    })
    const o = await autoEncryptionFor(
      s,
      policy({ kmsAllowedHosts: ['kms.vpce.example', 'hsm.example:9000'] }),
      {
        socket,
      },
    )
    await expect(
      o.kmsConnectCallback!({ host: 'kmip.corp.example', port: 5696, signal }),
    ).resolves.toBeDefined()
    await expect(
      o.kmsConnectCallback!({ host: 'login.corp.example', port: 8443, signal }),
    ).resolves.toBeDefined()
    await expect(
      o.kmsConnectCallback!({ host: 'kms.vpce.example', port: 443, signal }),
    ).resolves.toBeDefined()
    await expect(o.kmsConnectCallback!({ host: 'hsm.example', port: 9000, signal })).resolves.toBeDefined()
    for (const [host, port] of [
      ['kmip.corp.example', 443],
      ['kms.vpce.example', 444],
      ['hsm.example', 443],
    ] as const)
      await expect(o.kmsConnectCallback!({ host, port, signal }), `${host}:${port}`).rejects.toMatchObject({
        reason: 'kms_host_not_allowed',
      })
  })

  // CI on Linux: the connection itself mends PEM blocks pasted run together; the KMIP certificate,
  // read from the same kind of field, was taken as it is, and OpenSSL refuses it ("bad end line").
  it('reads a KMIP certificate and key pasted run together, as the connection reads its own', async () => {
    const pair = await selfsigned.generate([{ name: 'commonName', value: 'kmip-client' }], {
      keySize: 2048,
      algorithm: 'sha256',
    })
    const o = await autoEncryptionFor(
      settings({
        kms: {
          kmip: {
            endpoint: 'kmip.corp.example',
            caPem: pair.cert,
            certificateKeyPem: pair.cert.trim() + pair.private,
          },
        },
      }),
      policy(),
      egress,
    )
    expect(o.tlsOptions?.kmip).toHaveProperty('secureContext')
  })

  it('judges a master key’s endpoints the same way', () => {
    const s = settings({ kms: { local: { key: KEY } } })
    const p = policy({ kmsAllowedHosts: ['kms.vpce.example'] })
    expect(
      masterKeyProblem({ provider: 'azure', keyVaultEndpoint: 'attacker.example', keyName: 'k' }, s, p),
    ).toMatch(/attacker\.example/)
    expect(
      masterKeyProblem(
        {
          provider: 'gcp',
          projectId: 'p',
          location: 'l',
          keyRing: 'r',
          keyName: 'k',
          endpoint: 'evil.example',
        },
        s,
        p,
      ),
    ).toBeTruthy()
    expect(
      masterKeyProblem(
        { provider: 'aws', region: 'eu-west-1', key: 'arn', endpoint: 'kms.vpce.example' },
        s,
        p,
      ),
    ).toBeNull()
    expect(
      masterKeyProblem(
        { provider: 'azure', keyVaultEndpoint: 'myvault.vault.azure.net', keyName: 'k' },
        s,
        p,
      ),
    ).toBeNull()
    expect(masterKeyProblem({ provider: 'local' }, s, p)).toBeNull()
  })
})
