import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { H, makeApp, type TestApp } from './helpers'
import { startMongo, type TestMongo } from './support/mongo'
import { fakeCryptSharedLib } from './support/crypt-shared'
import { isAdminOnlyNamespace, isAdminOnlyNs, isRestrictedNamespace } from '../src/connections/access'
import { assertCopyTarget, resolveSide } from '../src/transfer/copy-access'
import { compileRules } from '../src/masking/match'
import { commandPolicy } from '../src/shell/proxy/policy'
import type { OptionalModules } from '../src/optional/modules'

/**
 * W8, security review C1: client-side encryption's own collections — the key vault (data keys,
 * however wrapped, with their alternate names and master key endpoints) and Queryable Encryption's
 * metadata (enxcol_.*.esc / .ecoc) — are a connection administrator's only, on every path: an editor
 * who could rewrite a data key's master key endpoint would have the next decrypting read send the
 * KMS token to their host. Someone from whom personal data is hidden never reads them either.
 */
let mongo: TestMongo
let client: MongoClient
beforeAll(async () => {
  mongo = await startMongo()
  client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
  await client
    .db('encryption')
    .collection('__keyVault')
    .insertOne({ keyAltNames: ['customer-42'] })
  await client.db('shop').collection('people').insertOne({ name: 'Ana' })
})
afterAll(async () => {
  await client?.close()
  await mongo?.stop()
})
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

const present: OptionalModules = {
  distribution: 'npm',
  clientEncryption: { status: 'available', version: '6.5.0' },
  kerberos: { status: 'missing', version: null },
}
const settings = (keyVaultNamespace = 'encryption.__keyVault') =>
  ConnectionSettingsSchema.parse({
    hosts: [{ host: '127.0.0.1', port: mongo.port }],
    serverSelectionTimeoutMS: 3_000,
    encryption: {
      enabled: true,
      // Values as stored (an editor reads no decrypted value here): the plain client is enough.
      mode: 'auto',
      keyVaultNamespace,
      kms: { local: { key: 'A'.repeat(128) } },
      cryptSharedLibPath: fakeCryptSharedLib(),
    },
  })

async function team() {
  const t = await makeApp(
    {
      auth: true,
      encryption: { cryptSharedLibPath: fakeCryptSharedLib(), privateNetworks: [], allowedHosts: [] },
    },
    { optionalModules: present },
  )
  apps.push(t)
  const conn = t.app.ctx.connections.create(
    { name: 'e', favorite: false, readOnly: false, settings: settings() },
    null,
  )
  const user = t.app.ctx.users.create({ username: 'ed', passwordHash: 'x', role: 'editor' })
  const { sessionId, session } = t.app.ctx.sessions.create(user.id, {})
  const call = (method: 'GET' | 'POST' | 'DELETE' | 'PATCH', path: string, payload?: object) =>
    t.app.inject({
      method,
      url: `/api/connections/${conn.id}${path}`,
      headers: { ...H, 'x-csrf-token': session.csrfToken },
      cookies: { mm_sid: sessionId },
      ...(payload ? { payload } : {}),
    })
  return { t, conn, call }
}

describe('W8 (security review C1): the key vault and enxcol_ collections', () => {
  it('are admin-only namespaces once a connection names its key vault, and enxcol_ always', async () => {
    const { t } = await team()
    expect(isAdminOnlyNamespace('encryption', '__keyVault')).toBe(true)
    expect(isAdminOnlyNs('encryption.__keyVault')).toBe(true)
    expect(isAdminOnlyNamespace('shop', 'enxcol_.patients.esc')).toBe(true)
    expect(isAdminOnlyNamespace('shop', 'enxcol_.patients.ecoc')).toBe(true)
    expect(isRestrictedNamespace('encryption', '__keyVault', true)).toBe(true)
    expect(isRestrictedNamespace('shop', 'enxcol_.x.esc', false)).toBe(true)
    expect(isAdminOnlyNamespace('shop', 'people')).toBe(false)
    // A changed key vault is protected at once (the registry follows the connections).
    const id = t.app.ctx.connections.list()[0]!.id
    t.app.ctx.connections.update(id, { settings: settings('vault.keys') })
    expect(isAdminOnlyNamespace('vault', 'keys')).toBe(true)
  })

  // Abuse case: an editor reads the data keys, or rewrites a master key endpoint.
  it('are refused to an editor: reads, writes, a $lookup from them and a $merge into them', async () => {
    const { call } = await team()
    const read = await call('POST', '/databases/encryption/collections/__keyVault/find', { filter: {} })
    expect(read.statusCode).toBe(403)
    const write = await call('POST', '/databases/encryption/collections/__keyVault/documents', {
      documents: [{ masterKey: { provider: 'azure', keyVaultEndpoint: 'attacker.example' } }],
    })
    expect(write.statusCode).toBe(403)
    const lookup = await call('POST', '/databases/shop/collections/people/aggregate/preview', {
      stages: [{ $lookup: { from: { db: 'encryption', coll: '__keyVault' }, pipeline: [], as: 'k' } }],
    })
    expect(lookup.statusCode).toBe(403)
    const viaOtherDb = await call('POST', '/databases/shop/collections/people/aggregate/preview', {
      stages: [{ $unionWith: { coll: 'enxcol_.people.esc' } }],
    })
    expect(viaOtherDb.statusCode).toBe(403)
    const merge = await call('POST', '/databases/shop/collections/people/aggregate/write-preview', {
      stages: [{ $merge: { into: { db: 'encryption', coll: '__keyVault' } } }],
    })
    expect(merge.statusCode).toBe(403)
    expect(
      await client
        .db('encryption')
        .collection('__keyVault')
        .countDocuments({ 'masterKey.keyVaultEndpoint': 'attacker.example' }),
    ).toBe(0)
  })

  // Abuse case: an editor with a shell grant reads or rewrites the data keys from the shell.
  it('are refused to a non-admin in the shell: find, update, a pipeline, a rename', async () => {
    await team()
    const check = commandPolicy({ readOnly: false, admin: false })
    const c = (name: string, body: Record<string, unknown>, db = 'encryption') =>
      check({ name, db, body }).allow
    expect(c('find', { find: '__keyVault' })).toBe(false)
    expect(c('update', { update: '__keyVault', updates: [] })).toBe(false)
    expect(c('find', { find: 'enxcol_.people.esc' }, 'shop')).toBe(false)
    expect(
      c(
        'aggregate',
        {
          aggregate: 'people',
          pipeline: [{ $lookup: { from: { db: 'encryption', coll: '__keyVault' }, as: 'k', pipeline: [] } }],
          cursor: {},
        },
        'shop',
      ),
    ).toBe(false)
    expect(c('dataSize', { dataSize: 'encryption.__keyVault' }, 'shop')).toBe(false)
    expect(
      c('renameCollection', { renameCollection: 'shop.people', to: 'encryption.__keyVault' }, 'admin'),
    ).toBe(false)
    expect(c('find', { find: 'people' }, 'shop')).toBe(true)
  })

  // Re-review item 1, abuse case: an editor drops the database holding the key vault — every data
  // key gone — or drops / renames the key vault itself, through the routes or the shell.
  it('let no non-admin drop the key vault’s database, or drop or rename the key vault', async () => {
    const { call } = await team()
    const vault = client.db('encryption').collection('__keyVault')
    const before = await vault.countDocuments()
    const dropDb = await call('DELETE', '/databases/encryption', { confirm: 'encryption' })
    expect(dropDb.statusCode).toBe(403)
    const dropColl = await call('DELETE', '/databases/encryption/collections/__keyVault', {
      confirm: '__keyVault',
    })
    expect(dropColl.statusCode).toBe(403)
    const rename = await call('POST', '/databases/encryption/collections/__keyVault/rename', { to: 'gone' })
    expect(rename.statusCode).toBe(403)
    expect(await vault.countDocuments()).toBe(before)
    const check = commandPolicy({ readOnly: false, admin: false })
    expect(check({ name: 'dropDatabase', db: 'encryption', body: { dropDatabase: 1 } }).allow).toBe(false)
    expect(check({ name: 'drop', db: 'encryption', body: { drop: '__keyVault' } }).allow).toBe(false)
    expect(
      check({
        name: 'renameCollection',
        db: 'admin',
        body: { renameCollection: 'encryption.__keyVault', to: 'encryption.gone' },
      }).allow,
    ).toBe(false)
    expect(check({ name: 'dropDatabase', db: 'shop', body: { dropDatabase: 1 } }).allow).toBe(true)
    // An administrator still may (they keep the keys).
    expect(
      commandPolicy({ readOnly: false, admin: true })({
        name: 'dropDatabase',
        db: 'encryption',
        body: { dropDatabase: 1 },
      }).allow,
    ).toBe(true)
  })

  // W4 × W8 (merge): the drills' scratch databases and the key vault are refused side by side.
  it('are refused next to a restore drill’s scratch database, each with its own reason', async () => {
    const { call } = await team()
    const scratch = await call('POST', '/databases/mm_drill_0123456789ab/collections/x/find', { filter: {} })
    expect(scratch.statusCode).toBe(403)
    expect(scratch.json().message).toMatch(/drill/)
    const vault = await call('POST', '/databases/encryption/collections/__keyVault/find', { filter: {} })
    expect(vault.statusCode).toBe(403)
    expect(() => assertCopyTarget('mm_drill_0123456789ab', 'x')).toThrow(/drill/)
    expect(() => assertCopyTarget('encryption', '__keyVault')).toThrow(/encryption/i)
  })

  it('are never a copy’s target, whoever copies', async () => {
    await team()
    expect(() => assertCopyTarget('shop', 'enxcol_.people.esc')).toThrow(/encryption/i)
    expect(() => assertCopyTarget('encryption', '__keyVault')).toThrow(/encryption/i)
    expect(() => assertCopyTarget('shop', 'people')).not.toThrow()
  })

  // Abuse case (Minor 10): every path that masks for someone who may not see personal data — export,
  // value search, Watch, the data model — hides a data key's material, alternate names and master key.
  it('hide key material, alternate names and master keys from whoever personal data is hidden from', async () => {
    await team()
    const m = compileRules([{ db: 'shop', coll: 'people', field: 'name' }])
    expect(m.anyInDb('encryption')).toBe(true)
    const ns = m.forNs('encryption', '__keyVault')
    expect(ns.matches(['keyMaterial'])).toBe(true)
    expect(ns.matches(['keyAltNames'])).toBe(true)
    expect(ns.matches(['keyAltNames', '0'])).toBe(true)
    expect(ns.matches(['masterKey', 'keyVaultEndpoint'])).toBe(true)
    expect(m.forNs('shop', 'orders').any).toBe(false)
  })

  // Minor 8, abuse case: someone from whom personal data is hidden writes plain values onto an
  // encrypted connection through a copy (or a fetched backup's restore) instead of the documents view.
  it('refuses a copy onto an encrypted connection to someone from whom personal data is hidden', async () => {
    const { t, conn } = await team()
    const { ctx } = t.app
    const ed = ctx.users.list().find((u) => u.username === 'ed')!
    ctx.grants.set(conn.id, ed.id, 'editor')
    ctx.grants.setMasked(conn.id, ed.id, true)
    const principal = { kind: 'user' as const, userId: ed.id, username: 'ed', role: 'editor' } as never
    expect(() => resolveSide(ctx, principal, conn.id, ['documents:write', 'jobs:run'])).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ reason: 'encryption_masked_write' }) }),
    )
    // Reading it (a copy's source) stays theirs, masked.
    expect(() => resolveSide(ctx, principal, conn.id, ['documents:read'])).not.toThrow()
    ctx.grants.setMasked(conn.id, ed.id, false)
    expect(() => resolveSide(ctx, principal, conn.id, ['documents:write', 'jobs:run'])).not.toThrow()
  })

  // Abuse case: the local user who hides personal data (an admin) still never reads the key vault.
  it('are refused to an administrator from whom personal data is hidden', async () => {
    const t = await makeApp({}, { optionalModules: present })
    apps.push(t)
    const conn = t.app.ctx.connections.create(
      { name: 'e', favorite: false, readOnly: false, settings: settings() },
      null,
    )
    t.app.ctx.personalFields.set(conn.id, [{ db: 'shop', coll: 'people', field: 'name' }])
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/connections/${conn.id}/databases/encryption/collections/__keyVault/find`,
      headers: { ...H, 'x-csrf-token': t.app.ctx.localCsrfToken },
      payload: { filter: {} },
    })
    expect(res.statusCode).toBe(403)
    expect(res.body).not.toContain('customer-42')
  })
})
