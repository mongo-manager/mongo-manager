import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { H, makeApp, type TestApp } from './helpers'
import { startMongo, type TestMongo } from './support/mongo'
import { openStore } from '../src/store/db'
import { createSecretBox, loadOrCreateKey } from '../src/crypto/secret-box'
import { ConnectionRepo } from '../src/connections/repo'
import { QueryHistoryRepo } from '../src/queries/history'

let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
})
afterAll(async () => {
  await mongo?.stop()
})
const apps: TestApp[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const settings = () =>
  ConnectionSettingsSchema.parse({
    hosts: [{ host: '127.0.0.1', port: mongo.port }],
    serverSelectionTimeoutMS: 3_000,
  })

async function team() {
  const t = await makeApp({ auth: true })
  apps.push(t)
  const conn = t.app.ctx.connections.create(
    { name: 'Test', favorite: false, readOnly: false, settings: settings() },
    null,
  )
  const as = (role: 'admin' | 'editor' | 'viewer') => {
    const user = t.app.ctx.users.create({
      username: `u${Math.random().toString(36).slice(2, 8)}`,
      passwordHash: 'x',
      role,
    })
    const { sessionId, session } = t.app.ctx.sessions.create(user.id, {})
    const opts = { headers: { ...H, 'x-csrf-token': session.csrfToken }, cookies: { mm_sid: sessionId } }
    const url = (coll = 'items') => `/api/connections/${conn.id}/databases/shop/collections/${coll}`
    return {
      user,
      find: (body: object, coll?: string) =>
        t.app.inject({ method: 'POST', url: `${url(coll)}/find`, payload: body, ...opts }),
      recent: (coll?: string) => t.app.inject({ method: 'GET', url: `${url(coll)}/recent-queries`, ...opts }),
      clear: (coll?: string) =>
        t.app.inject({ method: 'DELETE', url: `${url(coll)}/recent-queries`, ...opts }),
    }
  }
  return { t, conn, as }
}

const queries = async (res: Promise<{ json(): unknown }>) =>
  ((await res).json() as { queries: Array<{ query: { filter: unknown } }> }).queries.map((q) => q.query)

describe('recent queries (phase 1g-1, Review Focus 3)', () => {
  it('records a find with a query, newest first, without duplicates', async () => {
    const { as } = await team()
    const ada = as('editor')
    await ada.find({ filter: {} }) // nothing to remember
    await ada.find({ filter: { a: 1 } })
    await ada.find({ filter: { b: 2 }, sort: { b: -1 }, hint: { b: 1 } })
    await ada.find({ filter: { a: 1 } })
    expect(await queries(ada.recent())).toEqual([
      { filter: { a: 1 } },
      { filter: { b: 2 }, sort: { b: -1 }, hint: { b: 1 } },
    ])
  })

  it('keeps the latest 20 per collection', async () => {
    const { as } = await team()
    const ada = as('editor')
    for (let i = 0; i < 25; i++) await ada.find({ filter: { n: i } })
    const list = await queries(ada.recent())
    expect(list).toHaveLength(20)
    expect(list[0]).toEqual({ filter: { n: 24 } })
    expect(await queries(ada.recent('other'))).toEqual([])
  })

  it('belongs to its user: others never see it', async () => {
    const { as } = await team()
    const ada = as('editor')
    const bob = as('admin')
    await ada.find({ filter: { secret: 'ssn-123' } })
    expect(await queries(bob.recent())).toEqual([])
  })

  it('refuses a user without access to the connection and records nothing', async () => {
    const { t, conn, as } = await team()
    const eve = as('viewer')
    t.app.ctx.grants.set(conn.id, eve.user.id, 'none')
    expect((await eve.find({ filter: { a: 1 } })).statusCode).toBe(404)
    expect((await eve.recent()).statusCode).toBe(404)
    const rows = t.app.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM query_history').get() as { n: number }
    expect(rows.n).toBe(0)
  })

  it('is sealed at rest: the row holds no query text', async () => {
    const { t, as } = await team()
    await as('editor').find({ filter: { email: 'ada@example.com' } })
    const row = t.app.ctx.store.db.prepare('SELECT * FROM query_history').get() as Record<string, unknown>
    expect(JSON.stringify(row)).not.toContain('ada@example.com')
    expect(String(row.body)).toMatch(/^v1\./)
  })

  it('is cleared on request and removed with its user or connection', async () => {
    const { t, conn, as } = await team()
    const ada = as('editor')
    await ada.find({ filter: { a: 1 } })
    expect((await ada.clear()).statusCode).toBe(204)
    expect(await queries(ada.recent())).toEqual([])
    await ada.find({ filter: { a: 1 } })
    const bob = as('editor')
    await bob.find({ filter: { b: 1 } })
    const count = () =>
      (t.app.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM query_history').get() as { n: number }).n
    expect(count()).toBe(2)
    t.app.ctx.users.delete(ada.user.id)
    expect(count()).toBe(1)
    t.app.ctx.connections.delete(conn.id)
    expect(count()).toBe(0)
  })

  it('works in local mode', async () => {
    const t = await makeApp()
    apps.push(t)
    const conn = t.app.ctx.connections.create(
      { name: 'L', favorite: false, readOnly: false, settings: settings() },
      null,
    )
    const url = `/api/connections/${conn.id}/databases/shop/collections/items`
    const headers = { ...H, 'x-csrf-token': t.app.ctx.localCsrfToken }
    await t.app.inject({ method: 'POST', url: `${url}/find`, headers, payload: { filter: { a: 1 } } })
    const res = await t.app.inject({ method: 'GET', url: `${url}/recent-queries`, headers })
    expect(res.json()).toMatchObject({ queries: [{ query: { filter: { a: 1 } } }] })
  })

  it('skips oversized queries instead of storing them', async () => {
    const { as } = await team()
    const ada = as('editor')
    await ada.find({ filter: { big: 'x'.repeat(70_000) } })
    expect(await queries(ada.recent())).toEqual([])
  })
})

describe('recent queries: final review 1g-1', () => {
  async function store() {
    const dir = mkdtempSync(join(tmpdir(), 'mm-recent-'))
    dirs.push(dir)
    const box = createSecretBox(loadOrCreateKey({ dataDir: dir }))
    const s = await openStore(dir)
    const conn = new ConnectionRepo(s.db, box, Date.now).create(
      { name: 'P', settings: { hosts: [{ host: 'h' }] } } as never,
      null,
    )
    let t = 0
    return { dir, s, box, conn, repo: new QueryHistoryRepo(s.db, box, () => ++t) }
  }

  it('a row moved to another owner or collection in the file no longer opens (Minor 12)', async () => {
    const { s, conn, repo } = await store()
    repo.record(null, conn.id, 'shop', 'items', 'find', { filter: { a: 1 } })
    s.db.prepare("UPDATE query_history SET coll = 'other'").run()
    expect(repo.list({ owner: null, connectionId: conn.id, coll: 'other', limit: 10 })).toEqual([])
    s.close()
  })

  it('are forgotten when access to the connection is removed (Minor 11)', async () => {
    const { t, conn, as } = await team()
    const ada = as('editor')
    await ada.find({ filter: { a: 1 } })
    t.app.ctx.grants.set(conn.id, ada.user.id, 'none')
    const n = (t.app.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM query_history').get() as { n: number }).n
    expect(n).toBe(0)
  })

  // Team mode has no owner-less user: nobody could see or clear these rows, which may hold personal
  // data (1g-1 Minor 11; kept after final review 2c, I4, with the count logged).
  it("local mode's rows are removed when the store starts in team mode (Minor 11)", async () => {
    const { dir, s, conn, repo } = await store()
    repo.record(null, conn.id, 'shop', 'items', 'find', { filter: { a: 1 } })
    s.close()
    const { resolveConfig } = await import('../src/config')
    const { buildApp } = await import('../src/http/app')
    const reopened = await openStore(dir)
    const app = await buildApp({
      config: resolveConfig({ cli: { dataDir: dir, logLevel: 'silent', auth: true } }),
      store: reopened,
      secretBox: createSecretBox(loadOrCreateKey({ dataDir: dir })),
    })
    const n = (reopened.db.prepare('SELECT COUNT(*) AS n FROM query_history').get() as { n: number }).n
    await app.close()
    reopened.close()
    expect(n).toBe(0)
  })
})
