import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { ConnectionSettingsSchema, type Role } from '@mongo-manager/shared'
import { H, makeApp, type TestApp } from './helpers'
import { startMongo, type TestMongo } from './support/mongo'
import { accessError } from '../src/dbaccess/commands'
import { resolveOwnAccount } from '../src/dbaccess/own'
import { slow } from './support/slowness'

/**
 * W3.1: MongoDB's users and roles (Atlas "Database Access") against a real MongoDB with
 * authentication on. Threat model: a Mongo Manager user without databases:admin reaching MongoDB's
 * user management; a password stored, logged, audited or sent back; a change locking the
 * connection out unannounced; a restricted user seeing accounts; MongoDB's refusal disguised as
 * the app's.
 */
const ROOT = { user: 'root', password: 'root-pass-0123456789' }
let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo({ auth: ROOT })
  // An account that may only read one database: MongoDB refuses it user management.
  const client = await MongoClient.connect(
    `mongodb://${ROOT.user}:${ROOT.password}@127.0.0.1:${mongo.port}/?authSource=admin`,
  )
  await client.db('shop').command({ createUser: 'reader', pwd: 'reader-pass-0123', roles: ['read'] })
  await client.close()
}, slow(120_000))
afterAll(async () => {
  await mongo?.stop()
})

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

const settings = (user: string, password: string, authSource = 'admin') =>
  ConnectionSettingsSchema.parse({
    hosts: [{ host: '127.0.0.1', port: mongo.port }],
    serverSelectionTimeoutMS: 3_000,
    auth: { mechanism: 'DEFAULT', username: user, password, authSource },
  })

async function team(opts: { readOnly?: boolean; as?: 'root' | 'reader' } = {}) {
  const t = await makeApp({ auth: true })
  apps.push(t)
  const { ctx } = t.app
  const connectionId = ctx.connections.create(
    {
      name: 'Secured',
      favorite: false,
      readOnly: opts.readOnly ?? false,
      settings:
        opts.as === 'reader'
          ? settings('reader', 'reader-pass-0123', 'shop')
          : settings(ROOT.user, ROOT.password),
    },
    null,
  ).id
  const as = (role: Role) => {
    const user = ctx.users.create({ username: `u-${role}-${Math.random()}`, passwordHash: 'x', role })
    const { sessionId, session } = ctx.sessions.create(user.id, {})
    return (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: unknown) =>
      t.app.inject({
        method,
        url: `/api/connections/${connectionId}/database-access${path}`,
        headers: { ...H, 'x-csrf-token': session.csrfToken },
        cookies: { mm_sid: sessionId },
        ...(payload !== undefined ? { payload: payload as object } : {}),
      })
  }
  const audit = () =>
    t.app.ctx.store.db.prepare('SELECT action, outcome, details FROM audit_log ORDER BY id').all() as Array<{
      action: string
      outcome: string
      details: string | null
    }>
  return { t, connectionId, as, audit }
}

const signIn = async (user: string, password: string, db: string) => {
  const client = new MongoClient(
    `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${mongo.port}/?authSource=${db}`,
    { serverSelectionTimeoutMS: 3_000 },
  )
  try {
    await client.db(db).command({ ping: 1 })
    return true
  } catch {
    return false
  } finally {
    await client.close()
  }
}

describe('database users (W3.1)', () => {
  it('lists the users of every database, marks the connection’s own account, never credentials', async () => {
    const { as } = await team()
    const admin = as('admin')
    const all = await admin('GET', '/users')
    expect(all.statusCode).toBe(200)
    const body = all.json()
    expect(body.refused).toBeNull()
    const root = body.users.find((u: { user: string }) => u.user === 'root')
    expect(root).toMatchObject({ db: 'admin', own: true, roles: [{ role: 'root', db: 'admin' }] })
    expect(body.users.find((u: { user: string }) => u.user === 'reader')).toMatchObject({
      db: 'shop',
      own: false,
    })
    // No hashes, salts or stored keys, under any name.
    expect(all.body).not.toMatch(/credentials|storedKey|serverKey|salt/i)
    const shop = await admin('GET', '/users?db=shop')
    expect(shop.json().users.map((u: { user: string }) => u.user)).toEqual(['reader'])
  })

  it('creates a user with SCRAM-SHA-256, never returning, auditing or storing the password', async () => {
    const { t, as, audit } = await team()
    const admin = as('admin')
    const password = 'Sekret-Pa55word-xyz'
    const res = await admin('POST', '/users', {
      db: 'shop',
      user: 'app1',
      password,
      roles: [{ role: 'readWrite', db: 'shop' }],
    })
    expect(res.statusCode).toBe(201)
    expect(res.body).not.toContain(password)
    expect(res.json()).toMatchObject({ user: 'app1', db: 'shop', mechanisms: ['SCRAM-SHA-256'] })
    expect(await signIn('app1', password, 'shop')).toBe(true)
    const row = audit().find((r) => r.action === 'mongo.users.create')!
    expect(row.outcome).toBe('success')
    expect(JSON.parse(row.details!)).toMatchObject({ user: 'app1', db: 'shop', roles: ['readWrite@shop'] })
    // Nowhere in the app's own store: every table, every row.
    const db = t.app.ctx.store.db
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string
      }>
    ).map((r) => r.name)
    for (const table of tables)
      expect(JSON.stringify(db.prepare(`SELECT * FROM "${table}"`).all()), table).not.toContain(password)
    // A duplicate is a conflict, said as such.
    const again = await admin('POST', '/users', { db: 'shop', user: 'app1', password, roles: [] })
    expect(again.statusCode).toBe(409)
    expect(again.json().details).toMatchObject({ reason: 'user_exists' })
    expect(again.body).not.toContain(password)
  })

  it('grants and revokes roles, changes the password, and drops the user (audited)', async () => {
    const { as, audit } = await team()
    const admin = as('admin')
    await admin('POST', '/users', { db: 'shop', user: 'app2', password: 'first-password-123', roles: [] })
    const granted = await admin('POST', '/users/shop/app2/grant', {
      roles: [
        { role: 'read', db: 'reports' },
        { role: 'readWrite', db: 'shop' },
      ],
    })
    expect(granted.statusCode).toBe(200)
    expect(granted.json().roles).toEqual(
      expect.arrayContaining([
        { role: 'read', db: 'reports' },
        { role: 'readWrite', db: 'shop' },
      ]),
    )
    const revoked = await admin('POST', '/users/shop/app2/revoke', {
      roles: [{ role: 'read', db: 'reports' }],
    })
    expect(revoked.json().roles).toEqual([{ role: 'readWrite', db: 'shop' }])
    const changed = await admin('PATCH', '/users/shop/app2', { password: 'second-password-456' })
    expect(changed.statusCode).toBe(200)
    expect(await signIn('app2', 'second-password-456', 'shop')).toBe(true)
    expect(await signIn('app2', 'first-password-123', 'shop')).toBe(false)
    const detail = await admin('GET', '/users/shop/app2')
    expect(detail.json().inheritedPrivileges).toEqual(
      expect.arrayContaining([expect.objectContaining({ resource: { db: 'shop', collection: '' } })]),
    )
    const dropped = await admin('DELETE', '/users/shop/app2')
    expect(dropped.statusCode).toBe(204)
    expect(await signIn('app2', 'second-password-456', 'shop')).toBe(false)
    const actions = audit().map((r) => r.action)
    expect(actions).toEqual(
      expect.arrayContaining([
        'mongo.users.grant',
        'mongo.users.revoke',
        'mongo.users.update',
        'mongo.users.drop',
      ]),
    )
    const update = audit().find((r) => r.action === 'mongo.users.update')!
    expect(update.details).not.toContain('second-password-456')
    expect(JSON.parse(update.details!)).toMatchObject({ newCredential: true })
  })

  it('refuses a change to the connection’s own account unless it is confirmed', async () => {
    const { as } = await team()
    const admin = as('admin')
    const drop = await admin('DELETE', '/users/admin/root')
    expect(drop.statusCode).toBe(409)
    expect(drop.json().details).toMatchObject({ reason: 'own_account' })
    const revoke = await admin('POST', '/users/admin/root/revoke', { roles: [{ role: 'root', db: 'admin' }] })
    expect(revoke.json().details).toMatchObject({ reason: 'own_account' })
    const password = await admin('PATCH', '/users/admin/root', { password: 'another-pass-1234' })
    expect(password.json().details).toMatchObject({ reason: 'own_account' })
    // Still signed in as before: nothing changed.
    expect(await signIn(ROOT.user, ROOT.password, 'admin')).toBe(true)
    // Granting more to itself is no lock-out risk... but it is the same account: confirmed too.
    const grant = await admin('POST', '/users/admin/root/grant', {
      roles: [{ role: 'read', db: 'shop' }],
      confirmOwn: true,
    })
    expect(grant.statusCode).toBe(200)
  })

  it('validates what reaches MongoDB', async () => {
    const { as } = await team()
    const admin = as('admin')
    const short = await admin('POST', '/users', { db: 'shop', user: 'x', password: 'short', roles: [] })
    expect(short.statusCode).toBe(400)
    const external = await admin('POST', '/users', {
      db: '$external',
      user: 'CN=x',
      password: 'a-long-password-1',
      roles: [],
    })
    expect(external.statusCode).toBe(400)
    const extra = await admin('POST', '/users', {
      db: 'shop',
      user: 'x',
      password: 'a-long-password-1',
      roles: [],
      mechanisms: ['SCRAM-SHA-1'],
    })
    expect(extra.statusCode).toBe(400)
    const operatorRole = await admin('POST', '/users', {
      db: 'shop',
      user: 'x',
      password: 'a-long-password-1',
      roles: [{ role: 'read', db: 'shop', $where: '1' }],
    })
    expect(operatorRole.statusCode).toBe(400)
    const control = await admin('POST', '/users', {
      db: 'shop',
      user: 'bad\nname',
      password: 'a-long-password-1',
      roles: [],
    })
    expect(control.statusCode).toBe(400)
  })
})

describe('custom roles (W3.1)', () => {
  it('creates, lists with privileges, edits and drops a custom role', async () => {
    const { as, audit } = await team()
    const admin = as('admin')
    const created = await admin('POST', '/roles', {
      db: 'shop',
      role: 'orderReader',
      privileges: [{ resource: { db: 'shop', collection: 'orders' }, actions: ['find'] }],
      roles: [{ role: 'read', db: 'reports' }],
    })
    // MongoDB's own rule, said in its words: a role outside admin inherits from its database only.
    expect(created.statusCode).toBe(400)
    expect(created.json().message).toMatch(/Roles on the 'shop' database cannot/)
    const made = await admin('POST', '/roles', {
      db: 'shop',
      role: 'orderReader',
      privileges: [{ resource: { db: 'shop', collection: 'orders' }, actions: ['find'] }],
      roles: [{ role: 'read', db: 'shop' }],
    })
    expect(made.statusCode).toBe(201)
    const listed = await admin('GET', '/roles?db=shop')
    const role = listed.json().roles.find((r: { role: string }) => r.role === 'orderReader')
    expect(role).toMatchObject({
      db: 'shop',
      builtin: false,
      roles: [{ role: 'read', db: 'shop' }],
      privileges: [{ resource: { db: 'shop', collection: 'orders' }, actions: ['find'] }],
    })
    // Built-in roles are never listed as custom ones.
    expect(listed.json().roles.some((r: { builtin: boolean }) => r.builtin)).toBe(false)
    const all = await admin('GET', '/roles')
    expect(all.json().roles.map((r: { role: string }) => r.role)).toContain('orderReader')
    const edited = await admin('PATCH', '/roles/shop/orderReader', {
      privileges: [{ resource: { db: 'shop', collection: 'orders' }, actions: ['find', 'insert'] }],
    })
    expect(edited.statusCode).toBe(200)
    expect(edited.json().privileges[0].actions.sort()).toEqual(['find', 'insert'])
    // A role can be granted to a user like a built-in one.
    await admin('POST', '/users', {
      db: 'shop',
      user: 'clerk',
      password: 'clerk-password-1',
      roles: [{ role: 'orderReader', db: 'shop' }],
    })
    const dropped = await admin('DELETE', '/roles/shop/orderReader')
    expect(dropped.statusCode).toBe(204)
    await admin('DELETE', '/users/shop/clerk')
    expect(audit().map((r) => r.action)).toEqual(
      expect.arrayContaining(['mongo.roles.create', 'mongo.roles.update', 'mongo.roles.drop']),
    )
    // A resource with a key MongoDB would read differently is refused before MongoDB.
    const odd = await admin('POST', '/roles', {
      db: 'shop',
      role: 'odd',
      privileges: [{ resource: { db: 'shop', collection: '', cluster: true }, actions: ['find'] }],
      roles: [],
    })
    expect(odd.statusCode).toBe(400)
  })
})

describe('who may manage MongoDB users (W3.1 abuse cases)', () => {
  it('refuses editors and viewers, listings included', async () => {
    const { as } = await team()
    for (const role of ['editor', 'viewer'] as const) {
      const user = as(role)
      expect((await user('GET', '/users')).statusCode).toBe(403)
      expect((await user('GET', '/roles')).statusCode).toBe(403)
      const create = await user('POST', '/users', {
        db: 'shop',
        user: 'sneaky',
        password: 'sneaky-password-1',
        roles: [{ role: 'root', db: 'admin' }],
      })
      expect(create.statusCode).toBe(403)
    }
    expect(await signIn('sneaky', 'sneaky-password-1', 'shop')).toBe(false)
  })

  it('lists but changes nothing on a read-only connection', async () => {
    const { as } = await team({ readOnly: true })
    const admin = as('admin')
    expect((await admin('GET', '/users')).statusCode).toBe(200)
    const create = await admin('POST', '/users', {
      db: 'shop',
      user: 'ro',
      password: 'ro-password-123',
      roles: [],
    })
    expect([create.statusCode, create.json().code]).toEqual([403, 'READ_ONLY'])
    const role = await admin('POST', '/roles', { db: 'shop', role: 'r', privileges: [], roles: [] })
    expect([role.statusCode, role.json().code]).toEqual([403, 'READ_ONLY'])
    expect((await admin('DELETE', '/users/shop/reader')).json().code).toBe('READ_ONLY')
  })

  it('says plainly when MongoDB refuses the connection’s account', async () => {
    const { as, audit } = await team({ as: 'reader' })
    const admin = as('admin')
    const res = await admin('POST', '/users', {
      db: 'shop',
      user: 'nope',
      password: 'nope-password-1',
      roles: [],
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().details).toMatchObject({ reason: 'mongo_not_permitted', command: 'createUser' })
    expect(res.json().message).toMatch(/MongoDB refused createUser/)
    expect(res.body).not.toContain('nope-password-1')
    expect(audit().find((r) => r.action === 'mongo.users.create')?.outcome).toBe('denied')
    // A listing MongoDB refuses is said as refused, not as an empty deployment.
    const listed = await admin('GET', '/users')
    expect(listed.statusCode).toBe(200)
    expect(listed.json()).toMatchObject({ users: [], refused: 'not_permitted' })
  })

  // User report 2026-10-30: local mode's one person edits the rules that hide values from them; hiding
  // is how they view documents, not what they may do — MongoDB's accounts stay theirs to manage.
  it('shows users and roles to a local user whose personal data is hidden', async () => {
    const t = await makeApp()
    apps.push(t)
    const { ctx } = t.app
    const id = ctx.connections.create(
      { name: 'L', favorite: false, readOnly: false, settings: settings(ROOT.user, ROOT.password) },
      null,
    ).id
    ctx.personalFields.set(id, [{ db: 'shop', coll: 'orders', field: 'email' }])
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/connections/${id}/database-access/users`,
      headers: { ...H, 'x-csrf-token': ctx.localCsrfToken },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().users.map((u: { user: string }) => u.user)).toContain(ROOT.user)
  })
})

describe('accessError', () => {
  // W3 review (M3): with a password sent, MongoDB's words are never shown — its code name is.
  it('shows only the code name when a password went with the command, in any of its spellings', () => {
    const password = `pa"ss\\word-${'x'.repeat(600)}`
    for (const text of [
      `bad thing near pwd: "${password}" in createUser`,
      `pwd: ${JSON.stringify(password)}`,
      `uri mongodb://u:${encodeURIComponent(password)}@h`,
      `${'y'.repeat(480)} ${password}`,
    ]) {
      const err = Object.assign(new Error(text), { name: 'MongoServerError', code: 2, codeName: 'BadValue' })
      const shown = accessError(err, 'createUser', 'shop', [password]) as Error
      expect(shown.message).toBe('MongoDB refused createUser on shop: BadValue')
      expect(JSON.stringify(shown)).not.toMatch(/pa"ss|pa\\"ss|ss\\\\word|xxxx/)
    }
  })

  it('keeps MongoDB’s words, scrubbed, when no password went with it', () => {
    const err = Object.assign(new Error('Roles on the shop database cannot inherit'), {
      name: 'MongoServerError',
      code: 2,
    })
    expect((accessError(err, 'createRole', 'shop') as Error).message).toContain('cannot inherit')
  })
})

describe('own account, as MongoDB says it (W3 review M2)', () => {
  it('asks MongoDB who the connection is, whatever its settings say (SRV, X.509)', async () => {
    const fake = {
      db: () => ({
        command: async () => ({
          authInfo: {
            authenticatedUsers: [{ user: 'CN=svc,O=Acme', db: '$external' }],
            authenticatedUserRoles: [],
          },
        }),
      }),
    }
    const srv = ConnectionSettingsSchema.parse({
      scheme: 'mongodb+srv',
      hosts: [{ host: 'cluster0.example.net' }],
      defaultDatabase: 'shop',
      auth: { mechanism: 'MONGODB-X509' },
    })
    expect(await resolveOwnAccount(fake as never, srv)).toMatchObject({
      user: 'CN=svc,O=Acme',
      db: '$external',
    })
  })

  it('confirms a change to a custom role the connection’s account holds', async () => {
    const { as } = await team()
    const admin = as('admin')
    await admin('POST', '/roles', {
      db: 'admin',
      role: 'opsRole',
      privileges: [{ resource: { db: 'shop', collection: '' }, actions: ['find'] }],
      roles: [],
    })
    await admin('POST', '/users/admin/root/grant', {
      roles: [{ role: 'opsRole', db: 'admin' }],
      confirmOwn: true,
    })
    const listed = (await admin('GET', '/roles?db=admin')).json()
    expect(listed.roles.find((r: { role: string }) => r.role === 'opsRole')).toMatchObject({ own: true })
    const edit = await admin('PATCH', '/roles/admin/opsRole', {
      privileges: [{ resource: { db: 'shop', collection: '' }, actions: ['find', 'insert'] }],
    })
    expect(edit.json().details).toMatchObject({ reason: 'own_account' })
    expect((await admin('DELETE', '/roles/admin/opsRole')).json().details).toMatchObject({
      reason: 'own_account',
    })
    expect((await admin('DELETE', '/roles/admin/opsRole?confirmOwn=true')).statusCode).toBe(204)
  })
})

describe('broad rights, confirmed on the server (W3 review M4)', () => {
  it('refuses a broad role without confirmBroad, built-in or custom, and takes it confirmed', async () => {
    const { as } = await team()
    const admin = as('admin')
    for (const role of [
      'root',
      'restore',
      'backup',
      'readWriteAnyDatabase',
      'dbAdminAnyDatabase',
      'clusterManager',
    ]) {
      const res = await admin('POST', '/users', {
        db: 'admin',
        user: `b-${role}`,
        password: 'a-long-password-1',
        roles: [{ role, db: 'admin' }],
      })
      expect([res.statusCode, res.json().details?.reason, role]).toEqual([409, 'broad_role', role])
    }
    // Review of B4 (I1): admin's other built-ins (every database's data, the cluster's state), and any
    // role of local (the oplog) or config (sharding's own) — confirmed too.
    for (const ref of [
      { role: 'readAnyDatabase', db: 'admin' },
      { role: 'clusterMonitor', db: 'admin' },
      { role: 'enableSharding', db: 'admin' },
      { role: 'read', db: 'local' },
      { role: 'readWrite', db: 'config' },
    ]) {
      const res = await admin('POST', '/users', {
        db: 'shop',
        user: `b-${ref.role}-${ref.db}`,
        password: 'a-long-password-1',
        roles: [ref],
      })
      expect([res.statusCode, res.json().details?.reason, ref]).toEqual([409, 'broad_role', ref])
    }
    // Rights on every database at once are broad in a custom role.
    const everywhere = await admin('POST', '/roles', {
      db: 'admin',
      role: 'everyReader',
      privileges: [{ resource: { db: '', collection: '' }, actions: ['find'] }],
      roles: [],
    })
    expect(everywhere.json().details).toMatchObject({ reason: 'broad_role' })
    // A database's own roles are not.
    // Review of B5 (M6): a user MongoDB has not is said as such (the agent reads that reason only).
    const ghost = await admin('GET', '/users/shop/ghost-user')
    expect([ghost.statusCode, ghost.json().details?.reason]).toEqual([404, 'user_unknown'])
    const plain = await admin('POST', '/users', {
      db: 'shop',
      user: 'b-plain',
      password: 'a-long-password-1',
      roles: [{ role: 'readWrite', db: 'shop' }],
    })
    expect(plain.statusCode).toBe(201)
    const ok = await admin('POST', '/users', {
      db: 'admin',
      user: 'b-root',
      password: 'a-long-password-1',
      roles: [{ role: 'root', db: 'admin' }],
      confirmBroad: true,
    })
    expect(ok.statusCode).toBe(201)
    // A custom role that can make users is broad too, made and granted.
    const made = await admin('POST', '/roles', {
      db: 'admin',
      role: 'userMaker',
      privileges: [{ resource: { db: '', collection: '' }, actions: ['createUser', 'grantRole'] }],
      roles: [],
    })
    expect(made.json().details).toMatchObject({ reason: 'broad_role' })
    const madeOk = await admin('POST', '/roles', {
      db: 'admin',
      role: 'userMaker',
      privileges: [{ resource: { db: '', collection: '' }, actions: ['createUser', 'grantRole'] }],
      roles: [],
      confirmBroad: true,
    })
    expect(madeOk.statusCode).toBe(201)
    expect(madeOk.json()).toMatchObject({ broad: true })
    const inherits = await admin('POST', '/roles', {
      db: 'admin',
      role: 'allReader',
      privileges: [],
      roles: [{ role: 'userAdminAnyDatabase', db: 'admin' }],
    })
    expect(inherits.json().details).toMatchObject({ reason: 'broad_role' })
    const grant = await admin('POST', '/users/shop/reader/grant', {
      roles: [{ role: 'userMaker', db: 'admin' }],
    })
    expect(grant.json().details).toMatchObject({ reason: 'broad_role' })
    const patch = await admin('PATCH', '/users/shop/reader', { roles: [{ role: 'userMaker', db: 'admin' }] })
    expect(patch.json().details).toMatchObject({ reason: 'broad_role' })
    const granted = await admin('POST', '/users/shop/reader/grant', {
      roles: [{ role: 'userMaker', db: 'admin' }],
      confirmBroad: true,
    })
    expect(granted.statusCode).toBe(200)
    await admin('POST', '/users/shop/reader/revoke', { roles: [{ role: 'userMaker', db: 'admin' }] })
    await admin('DELETE', '/users/admin/b-root')
    await admin('DELETE', '/roles/admin/userMaker')
  })
})
