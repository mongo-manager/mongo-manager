import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Binary, MongoClient } from 'mongodb'
import { ConnectionSettingsSchema, type ConnectionSettings } from '@mongo-manager/shared'
import { H, makeApp, type TestApp } from './helpers'
import { startMongo, type TestMongo } from './support/mongo'
import { fakeCryptSharedLib } from './support/crypt-shared'
import type { OptionalModules } from '../src/optional/modules'
import type { EncryptionTools } from '../src/encryption/tools'
import type { PartialConfig } from '../src/config'

let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
})
afterAll(async () => mongo?.stop())

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

const present: OptionalModules = {
  distribution: 'npm',
  clientEncryption: { status: 'available', version: '6.5.0' },
  kerberos: { status: 'available', version: '2.2.2' },
}
const absent: OptionalModules = {
  distribution: 'npm',
  clientEncryption: { status: 'missing', version: null },
  kerberos: { status: 'missing', version: null },
}
const standalone: OptionalModules = {
  distribution: 'standalone',
  clientEncryption: { status: 'not_in_package', version: null },
  kerberos: { status: 'not_in_package', version: null },
}

const LOCAL_KEY = Buffer.alloc(96, 3).toString('base64')
const encrypted = (e: object = {}): ConnectionSettings =>
  ConnectionSettingsSchema.parse({
    hosts: [{ host: '127.0.0.1', port: mongo.port }],
    serverSelectionTimeoutMS: 2_000,
    encryption: {
      enabled: true,
      keyVaultNamespace: 'encryption.__keyVault',
      kms: { local: { key: LOCAL_KEY } },
      cryptSharedLibPath: fakeCryptSharedLib(),
      ...e,
    },
  })
const kerberos = { hosts: [{ host: 'db.example' }], auth: { mechanism: 'GSSAPI', username: 'u@REALM' } }

async function app(
  config: PartialConfig,
  modules: OptionalModules,
  encryptionTools?: (t: EncryptionTools) => void,
) {
  const fake: EncryptionTools = {
    createDataKey: vi.fn(async () => new Binary(Buffer.alloc(16, 9), Binary.SUBTYPE_UUID)),
    rewrapManyDataKey: vi.fn(async () => ({ bulkWriteResult: { modifiedCount: 2 } })),
    createEncryptedCollection: vi.fn(async (_db, _name, o) => ({
      encryptedFields: {
        fields: (o.createCollectionOptions.encryptedFields.fields as Array<{ path: string }>).map((f) => ({
          ...f,
          keyId: new Binary(Buffer.alloc(16, 1), Binary.SUBTYPE_UUID),
        })),
      },
    })),
  }
  encryptionTools?.(fake)
  const t = await makeApp(config, { optionalModules: modules, encryptionTools: async () => fake })
  apps.push(t)
  const me = config.auth ? null : await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: H })
  const headers = me ? { ...H, 'x-csrf-token': me.json().csrfToken as string } : H
  return { t, ctx: t.app.ctx, headers, fake }
}

function teamUser(t: TestApp, role: 'admin' | 'editor' | 'viewer', name: string = role) {
  const user = t.app.ctx.users.create({ username: name, passwordHash: 'x', role })
  const { sessionId, session } = t.app.ctx.sessions.create(user.id, {})
  return { user, cookies: { mm_sid: sessionId }, headers: { ...H, 'x-csrf-token': session.csrfToken } }
}

describe('W7, W8: what the connection form may offer', () => {
  it('says the optional packages are missing, and how to install them, in the npm package', async () => {
    const { t, headers } = await app({ auth: false }, absent)
    const caps = (await t.app.inject({ method: 'GET', url: '/api/connections/capabilities', headers })).json()
    expect(caps).toMatchObject({
      mode: 'local',
      distribution: 'npm',
      kerberos: { available: false, allowed: true },
    })
    expect(caps.kerberos.reason).toMatch(/npm i -g kerberos/)
    expect(caps.encryption.reason).toMatch(/npm i -g mongodb-client-encryption/)
    expect(caps.oidc.redirectUri).toBe('http://localhost:4321/oidc/callback')
  })

  it('says the standalone binary has neither, and points at the npm package', async () => {
    const { t, headers } = await app({ auth: false }, standalone)
    const caps = (await t.app.inject({ method: 'GET', url: '/api/connections/capabilities', headers })).json()
    expect(caps.kerberos.reason).toMatch(/not available in this package/)
    expect(caps.encryption.reason).toMatch(/not available in this package/)
  })

  it('says Kerberos and workload identities are off in team mode until an administrator allows them', async () => {
    const { t } = await app({ auth: true }, present)
    const admin = teamUser(t, 'admin')
    const caps = (
      await t.app.inject({
        method: 'GET',
        url: '/api/connections/capabilities',
        headers: admin.headers,
        cookies: admin.cookies,
      })
    ).json()
    expect(caps).toMatchObject({
      mode: 'team',
      kerberos: { available: true, allowed: false },
      oidc: { workloadIdentity: false },
    })
  })
})

describe('W8: Kerberos in team mode is refused unless allowed', () => {
  it('refuses to save, import or test a Kerberos connection', async () => {
    const { t } = await app({ auth: true }, present)
    const admin = teamUser(t, 'admin')
    const req = { headers: admin.headers, cookies: admin.cookies }
    const create = await t.app.inject({
      method: 'POST',
      url: '/api/connections',
      ...req,
      payload: { name: 'k', settings: kerberos },
    })
    expect(create.statusCode).toBe(400)
    expect(create.json().details).toMatchObject({ reason: 'kerberos_team_disabled' })
    const imported = await t.app.inject({
      method: 'POST',
      url: '/api/connections/import',
      ...req,
      payload: {
        format: 'mongo-manager-connections',
        version: 1,
        connections: [{ name: 'k', settings: kerberos }],
      },
    })
    expect(imported.statusCode).toBe(400)
    expect(t.app.ctx.connections.count()).toBe(0)
    const tested = await t.app.inject({
      method: 'POST',
      url: '/api/connections/test',
      ...req,
      payload: { settings: kerberos },
    })
    expect(tested.json()).toMatchObject({ ok: false, error: { kind: 'config' } })
    expect(tested.json().error.message).toMatch(/MM_ALLOW_KERBEROS/)
  })

  it('saves one once the server allows it', async () => {
    const { t } = await app({ auth: true, allowKerberos: true }, present)
    const admin = teamUser(t, 'admin')
    const create = await t.app.inject({
      method: 'POST',
      url: '/api/connections',
      headers: admin.headers,
      cookies: admin.cookies,
      payload: { name: 'k', settings: kerberos },
    })
    expect(create.statusCode).toBe(200)
  })
})

describe('W8: client-side encryption settings', () => {
  // Security review I2, abuse case: a connections file someone sends names a library on their share;
  // importing it would have this server load and run their code at the first connect.
  it('drops a crypt_shared path from an imported connection, and says so', async () => {
    const { t, ctx, headers } = await app({ auth: false }, present)
    const planted = encrypted({ cryptSharedLibPath: '\\\\attacker.example\\share\\mongo_crypt_v1.dll' })
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/connections/import',
      headers,
      payload: {
        format: 'mongo-manager-connections',
        version: 1,
        connections: [
          { name: 'planted', settings: planted },
          { name: 'own', settings: encrypted() },
          { name: 'cryptd', settings: encrypted({ library: 'mongocryptd', cryptSharedLibPath: undefined }) },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ created: 3, libraryPathsDropped: 2 })
    for (const c of ctx.connections.list()) expect(c.settings.encryption?.cryptSharedLibPath).toBeUndefined()
    // It is typed again in the form before the connection can encrypt.
    const saved = ctx.connections.list().find((c) => c.name === 'planted')!
    const test = await t.app.inject({
      method: 'POST',
      url: '/api/connections/test',
      headers,
      payload: { settings: saved.settings },
    })
    expect(test.json()).toMatchObject({ ok: false })
  })

  // Security review I3, abuse case: a connections file carries a token resource "already confirmed".
  it('drops a token resource’s confirmation from an imported connection, and nothing else is let through', async () => {
    const { t, ctx, headers } = await app({ auth: false }, present)
    const workload = {
      hosts: [{ host: 'cluster0.ab12.mongodb.net' }],
      tls: { enabled: true },
      auth: {
        mechanism: 'MONGODB-OIDC',
        oidc: {
          environment: 'azure',
          environmentConfirmed: 'azure',
          tokenResource: 'api://evil',
          tokenResourceConfirmed: 'api://evil',
        },
      },
    }
    // Re-review item 3: a Kubernetes identity (no token resource) "already confirmed" too.
    const k8s = {
      ...workload,
      hosts: [{ host: 'localhost' }],
      auth: { mechanism: 'MONGODB-OIDC', oidc: { environment: 'k8s', environmentConfirmed: 'k8s' } },
    }
    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/connections/import',
      headers,
      payload: {
        format: 'mongo-manager-connections',
        version: 1,
        connections: [
          { name: 'w', settings: workload },
          { name: 'k', settings: k8s },
        ],
      },
    })
    expect(ok.statusCode).toBe(200)
    const saved = ctx.connections.list().find((c) => c.name === 'w')!
    expect(saved.settings.auth.oidc).toEqual({ environment: 'azure', tokenResource: 'api://evil' })
    expect(ctx.connections.list().find((c) => c.name === 'k')!.settings.auth.oidc).toEqual({
      environment: 'k8s',
    })
    // The same file over plain text is still refused: only the dropped confirmation is tolerated.
    const clear = await t.app.inject({
      method: 'POST',
      url: '/api/connections/import',
      headers,
      payload: {
        format: 'mongo-manager-connections',
        version: 1,
        connections: [{ name: 'w', settings: { ...workload, tls: { enabled: false } } }],
      },
    })
    expect(clear.statusCode).toBe(400)
    expect(clear.json().details).toMatchObject({ reason: 'oidc_needs_tls' })
  })

  it('refuses to save a crypt_shared path on a network share', async () => {
    const { t, headers } = await app({ auth: false }, present)
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/connections',
      headers,
      payload: {
        name: 'e',
        settings: encrypted({ cryptSharedLibPath: '//attacker.example/share/mongo_crypt_v1.so' }),
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().details).toMatchObject({ reason: 'crypt_shared_path_invalid' })
  })

  it('refuses to save encryption without mongodb-client-encryption', async () => {
    const { t, headers } = await app({ auth: false }, absent)
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/connections',
      headers,
      payload: { name: 'e', settings: encrypted() },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().details).toMatchObject({ reason: 'encryption_unavailable' })
  })

  it('keeps KMS credentials sealed at rest and out of every answer', async () => {
    const { t, ctx, headers } = await app({ auth: false }, present)
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/connections',
      headers,
      payload: {
        name: 'e',
        settings: encrypted({
          kms: {
            local: { key: LOCAL_KEY },
            aws: { accessKeyId: 'AKIA', secretAccessKey: 'aws-secret-value' },
          },
        }),
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain(LOCAL_KEY)
    expect(res.body).not.toContain('aws-secret-value')
    const list = await t.app.inject({ method: 'GET', url: '/api/connections', headers })
    expect(list.body).not.toContain('aws-secret-value')
    const raw = JSON.stringify(ctx.store.db.prepare('SELECT * FROM connections').all())
    expect(raw).not.toContain('aws-secret-value')
    expect(raw).not.toContain(LOCAL_KEY)
    const exported = await t.app.inject({
      method: 'POST',
      url: '/api/connections/export',
      headers,
      payload: {},
    })
    expect(exported.body).not.toContain('aws-secret-value')
  })

  // Abuse case: the crypt_shared path is code the server loads; in team mode only the operator's.
  it('refuses a connection’s own crypt_shared library in team mode', async () => {
    const { t } = await app({ auth: true }, present)
    const admin = teamUser(t, 'admin')
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/connections',
      headers: admin.headers,
      cookies: admin.cookies,
      payload: { name: 'e', settings: encrypted() },
    })
    expect(res.json().details).toMatchObject({ reason: 'crypt_shared_path_team' })
  })
})

describe('W8: decrypted values only for those who may see the data', () => {
  async function setup(mode: 'auto' | 'decryptOnly' = 'auto') {
    const h = await app(
      {
        auth: true,
        encryption: { cryptSharedLibPath: fakeCryptSharedLib(), privateNetworks: [], allowedHosts: [] },
      },
      present,
    )
    const conn = h.ctx.connections.create(
      {
        name: 'e',
        favorite: false,
        readOnly: false,
        settings: encrypted({ cryptSharedLibPath: undefined, mode }),
      },
      null,
    )
    const editor = teamUser(h.t, 'editor', 'ed')
    const masked = teamUser(h.t, 'editor', 'masked')
    h.ctx.grants.set(conn.id, masked.user.id, 'editor')
    h.ctx.grants.setMasked(conn.id, masked.user.id, true)
    return { ...h, conn, editor, masked }
  }

  it('gives a user who may see the data the decrypting client, and a masked user values as stored', async () => {
    const { t, ctx, conn, editor, masked } = await setup()
    const spy = vi.spyOn(ctx.manager, 'getClient')
    const read = (p: typeof editor) =>
      t.app.inject({
        method: 'POST',
        url: `/api/connections/${conn.id}/databases/shop/collections/people/find`,
        headers: p.headers,
        cookies: p.cookies,
        payload: { filter: {} },
      })
    const first = await read(editor)
    expect(first.statusCode, first.body).not.toBe(400)
    await read(masked)
    const asked = spy.mock.calls.map(([, as]) => as)
    expect(asked).toContainEqual({ user: editor.user.id, decrypt: true })
    expect(asked).toContainEqual({ user: masked.user.id, decrypt: false })
    expect(asked).not.toContainEqual({ user: masked.user.id, decrypt: true })
  })

  // Abuse case: a masked user's write would go through a client that does not encrypt.
  it('refuses document writes by a masked user, and every document write when it only decrypts', async () => {
    const { t, conn, masked } = await setup()
    const insert = (p: typeof masked) =>
      t.app.inject({
        method: 'POST',
        url: `/api/connections/${conn.id}/databases/shop/collections/people/documents`,
        headers: p.headers,
        cookies: p.cookies,
        payload: { document: '{"ssn": "123"}' },
      })
    const refused = await insert(masked)
    expect(refused.statusCode).toBe(403)
    expect(refused.json().details).toMatchObject({ reason: 'encryption_masked_write' })
    const only = await setup('decryptOnly')
    const editorRefused = await only.t.app.inject({
      method: 'POST',
      url: `/api/connections/${only.conn.id}/databases/shop/collections/people/documents`,
      headers: only.editor.headers,
      cookies: only.editor.cookies,
      payload: { document: '{"ssn": "123"}' },
    })
    expect(editorRefused.json().details).toMatchObject({ reason: 'encryption_decrypt_only' })
  })
})

describe('W8: data keys and encrypted collections', () => {
  async function setup() {
    const h = await app({ auth: false }, present)
    const conn = h.ctx.connections.create(
      { name: 'e', favorite: false, readOnly: false, settings: encrypted() },
      null,
    )
    return { ...h, conn }
  }

  it('lists data keys without their key material', async () => {
    const { t, conn, headers } = await setup()
    const client = await MongoClient.connect(`mongodb://127.0.0.1:${mongo.port}`)
    try {
      await client.db('encryption').collection('__keyVault').deleteMany({})
      await client
        .db('encryption')
        .collection('__keyVault')
        .insertOne({
          _id: new Binary(Buffer.alloc(16, 5), Binary.SUBTYPE_UUID),
          keyAltNames: ['customer-42'],
          keyMaterial: new Binary(Buffer.from('wrapped-key-material')),
          masterKey: { provider: 'local' },
          creationDate: new Date(0),
          updateDate: new Date(0),
          status: 0,
        } as never)
    } finally {
      await client.close()
    }
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/connections/${conn.id}/encryption/keys`,
      headers,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([
      expect.objectContaining({ id: '05'.repeat(16), keyAltNames: ['customer-42'], provider: 'local' }),
    ])
    expect(res.body).not.toMatch(/keyMaterial|d3JhcHBlZC1rZXktbWF0ZXJpYWw/)
  })

  // Security review C1: a master key naming another host would have the KMS token sent there.
  it('refuses a master key whose endpoint is not a key management service, for a key, a rewrap and a collection', async () => {
    const { t, conn, headers, fake } = await setup()
    const s = t.app.ctx.connections.get(conn.id)!.settings
    t.app.ctx.connections.update(conn.id, {
      settings: {
        ...s,
        encryption: {
          ...s.encryption!,
          kms: {
            ...s.encryption!.kms,
            azure: { tenantId: 't', clientId: 'c', clientSecret: 'azure-secret' },
          },
        },
      },
    })
    const masterKey = { provider: 'azure', keyVaultEndpoint: 'attacker.example', keyName: 'k' }
    for (const [url, payload] of [
      [`/api/connections/${conn.id}/encryption/keys`, { masterKey }],
      [`/api/connections/${conn.id}/encryption/keys/rewrap`, { masterKey }],
      [
        `/api/connections/${conn.id}/databases/shop/encrypted-collections`,
        { name: 'c', masterKey, fields: [{ path: 'ssn', bsonType: 'string' }] },
      ],
    ] as const) {
      const res = await t.app.inject({ method: 'POST', url, headers, payload })
      expect(res.statusCode, url).toBe(400)
      expect(res.json().details).toMatchObject({ reason: 'kms_host_not_allowed' })
    }
    expect(fake.createDataKey).not.toHaveBeenCalled()
    expect(fake.rewrapManyDataKey).not.toHaveBeenCalled()
    expect(fake.createEncryptedCollection).not.toHaveBeenCalled()
    const ok = await t.app.inject({
      method: 'POST',
      url: `/api/connections/${conn.id}/encryption/keys`,
      headers,
      payload: { masterKey: { ...masterKey, keyVaultEndpoint: 'myvault.vault.azure.net' } },
    })
    expect(ok.statusCode).toBe(200)
  })

  it('creates a data key and rewraps keys with a provider of the connection only', async () => {
    const { t, conn, headers, fake } = await setup()
    const created = await t.app.inject({
      method: 'POST',
      url: `/api/connections/${conn.id}/encryption/keys`,
      headers,
      payload: { masterKey: { provider: 'local' }, keyAltNames: ['orders'] },
    })
    expect(created.json()).toEqual({ id: '09'.repeat(16) })
    expect(fake.createDataKey).toHaveBeenCalledWith('local', { keyAltNames: ['orders'] })
    const otherProvider = await t.app.inject({
      method: 'POST',
      url: `/api/connections/${conn.id}/encryption/keys`,
      headers,
      payload: { masterKey: { provider: 'aws', region: 'eu-west-1', key: 'arn:aws:kms:x' } },
    })
    expect(otherProvider.json().details).toMatchObject({ reason: 'kms_provider_missing' })
    const rewrap = await t.app.inject({
      method: 'POST',
      url: `/api/connections/${conn.id}/encryption/keys/rewrap`,
      headers,
      payload: { masterKey: { provider: 'local' } },
    })
    expect(rewrap.json()).toEqual({ rewrapped: 2 })
  })

  it('creates a Queryable Encryption collection with a key per field', async () => {
    const { t, conn, headers, fake } = await setup()
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/connections/${conn.id}/databases/shop/encrypted-collections`,
      headers,
      payload: {
        name: 'patients',
        masterKey: { provider: 'local' },
        fields: [
          { path: 'ssn', bsonType: 'string', queries: { queryType: 'equality' } },
          { path: 'billing.amount', bsonType: 'int', queries: { queryType: 'range', min: 0, max: 100000 } },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().fields.map((f: { path: string }) => f.path)).toEqual(['ssn', 'billing.amount'])
    const [, name, options] = (fake.createEncryptedCollection as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(name).toBe('patients')
    expect(options.createCollectionOptions.encryptedFields.fields[0]).toMatchObject({
      path: 'ssn',
      keyId: null,
    })
  })

  it('marks the encrypted fields of a collection from its validator and the connection’s maps', async () => {
    const h = await app({ auth: false }, present)
    const conn = h.ctx.connections.create(
      {
        name: 'e',
        favorite: false,
        readOnly: false,
        settings: encrypted({
          encryptedFieldsMap: JSON.stringify({
            'shop.people': {
              fields: [{ path: 'card', bsonType: 'string', queries: { queryType: 'equality' } }],
            },
          }),
        }),
      },
      null,
    )
    const client = await MongoClient.connect(`mongodb://127.0.0.1:${mongo.port}`)
    try {
      await client
        .db('shop')
        .dropCollection('people')
        .catch(() => undefined)
      await client.db('shop').createCollection('people', {
        validator: {
          $jsonSchema: {
            bsonType: 'object',
            properties: {
              ssn: {
                encrypt: { bsonType: 'string', algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Deterministic' },
              },
            },
          },
        },
      })
    } finally {
      await client.close()
    }
    const res = await h.t.app.inject({
      method: 'GET',
      url: `/api/connections/${conn.id}/databases/shop/collections/people/encrypted-fields`,
      headers: h.headers,
    })
    expect(res.json()).toEqual({
      kind: 'queryable',
      fields: [
        { path: 'card', kind: 'queryable', bsonType: 'string', queryType: 'equality', source: 'connection' },
        { path: 'ssn', kind: 'deterministic', bsonType: 'string', source: 'server' },
      ],
    })
  })
})
