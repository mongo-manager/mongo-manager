import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AggregationCursor, MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { slow } from './support/slowness'

const S = 'S3NT1N3L'
let a: TestMongo
let b: TestMongo
let ca: MongoClient
beforeAll(async () => {
  ;[a, b] = await Promise.all([startMongo(), startMongo()])
  ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
}, slow(180_000))
afterAll(async () => {
  await ca?.close()
  await Promise.all([a?.stop(), b?.stop()])
})
beforeEach(async () => {
  await ca.db('shop').dropDatabase()
  await ca.db('other').dropDatabase()
  const shop = ca.db('shop')
  await shop
    .collection('orders')
    .insertMany(Array.from({ length: 50 }, (_, i) => ({ _id: i as never, email: `${S}-${i}@x`, n: i })))
  await shop.collection('orders').createIndex({ email: 1 }, { unique: true, name: 'email_u' })
  await shop.collection('orders').createIndex({ at: 1 }, { expireAfterSeconds: 60, name: 'at_ttl' })
  await shop.createCollection('v', { viewOn: 'orders', pipeline: [{ $match: { email: `${S}@x` } }] })
  await shop.createCollection('ts', { timeseries: { timeField: 't' } })
  await shop.collection('ts').insertOne({ t: new Date(), email: `${S}@ts` })
  await shop.createCollection('val', { validator: { email: { $ne: `${S}@v` } } })
  await ca.db('other').collection('x').insertOne({ a: 1 })
})

type H = Awaited<ReturnType<typeof backupHarness>>
const plan = (h: H, u: ReturnType<H['user']>, body: object) =>
  u.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)

// Second review of the personal-data rework (A): the schedule editor plans as the schedule will run
// (on its own), or it offers a plain format its save refuses; a grant still masks.
describe('dump plan as a schedule runs (2026-10-24)', () => {
  it('plans as work on its own for one who hides the values from themselves, masked for a grant', async () => {
    const h = await backupHarness(a, b)
    try {
      h.rules('A', [{ db: 'shop', coll: 'orders', field: 'email' }])
      const admin = h.user({ role: 'admin' })
      h.ctx.personalFields.setHiddenFromSelf(h.ids.A, admin.id, true)
      const body = { scope: { kind: 'database', db: 'shop' }, format: 'gzip' }
      const url = `/api/connections/${h.ids.A}/backup/plan`
      const viewed = (await admin.call('POST', url, body)).json()
      expect(viewed.masked).toBe(true)
      const scheduled = (await admin.call('POST', `${url}?asScheduled=1`, body)).json()
      expect(scheduled.masked).toBe(false)
      expect(scheduled.namespaces.find((n: { coll: string }) => n.coll === 'orders').personal).toEqual([
        'shop.orders.email',
      ])
      // One who may not see personal data is masked however it runs.
      const masked = h.user({ masked: ['A'] })
      const theirs = (await masked.call('POST', `${url}?asScheduled=1`, body)).json()
      expect(theirs.masked).toBe(true)
      expect(JSON.stringify(theirs)).not.toContain('shop.orders.email')
      expect(theirs.scheduledPersonal).toBe(false)
      expect((await admin.call('POST', `${url}?asScheduled=yes`, body)).statusCode).toBe(400)
      // The save judges by the rules' names (it reads no MongoDB): a rule naming a collection gone
      // still refuses a plain schedule, and the plan says so for the editor (third review, N4).
      h.rules('A', [{ db: 'shop', coll: 'gone', field: 'email' }])
      expect((await admin.call('POST', `${url}?asScheduled=1`, body)).json().scheduledPersonal).toBe(true)
      expect((await admin.call('POST', url, body)).json().scheduledPersonal).toBeUndefined()
      // One who may not see personal data learns nothing of a rule by it: masked, never refused.
      expect((await masked.call('POST', `${url}?asScheduled=1`, body)).json().scheduledPersonal).toBe(false)
      const anonymous = { ...body, anonymous: true }
      expect((await admin.call('POST', `${url}?asScheduled=1`, anonymous)).json().scheduledPersonal).toBe(
        false,
      )
      h.rules('A', [{ db: 'crm', coll: 'gone', field: 'email' }])
      expect((await admin.call('POST', `${url}?asScheduled=1`, body)).json().scheduledPersonal).toBe(false)
    } finally {
      await h.t.close()
    }
  })
})

describe('dump plan (spec §3.1, §5.1, §6, U1, U2)', () => {
  it('plans a database: namespaces, sizes, TTL, the personal warning and the recommendation', async () => {
    const h = await backupHarness(a, b)
    try {
      h.rules('A', [{ db: 'shop', coll: 'orders', field: 'email' }])
      const res = await plan(h, h.user(), { scope: { kind: 'database', db: 'shop' }, format: 'gzip' })
      expect(res.statusCode, res.body).toBe(200)
      const p = res.json()
      expect(p.namespaces.map((n: { coll: string; type: string }) => `${n.coll}:${n.type}`).sort()).toEqual([
        'orders:collection',
        'ts:timeseries',
        'v:view',
        'val:collection',
      ])
      const orders = p.namespaces.find((n: { coll: string }) => n.coll === 'orders')
      expect(orders).toMatchObject({ documents: 50, ttl: ['at_ttl'], personal: ['shop.orders.email'] })
      expect(p.recommended).toEqual({ format: 'mmbak', engine: 'builtin', reason: 'personal' })
      expect(p.checks.find((c: { key: string }) => c.key === 'personal')).toMatchObject({
        level: 'warn',
        fix: { kind: 'encrypt' },
        // Final review minor 11: the other ways out, in one click each.
        more: [{ kind: 'anonymous' }, { kind: 'exclude', names: ['shop.orders'] }],
      })
      expect(p.masked).toBe(false)
      expect(p.planHash).toMatch(/^[0-9a-f]{64}$/)
      expect(p.refusals).toEqual([])
      // The same settings give the same hash; another format another one.
      const again = (
        await plan(h, h.user(), { scope: { kind: 'database', db: 'shop' }, format: 'gzip' })
      ).json()
      expect(again.planHash).toBe(p.planHash)
      const other = (
        await plan(h, h.user(), { scope: { kind: 'database', db: 'shop' }, format: 'archive' })
      ).json()
      expect(other.planHash).not.toBe(p.planHash)
    } finally {
      await h.t.close()
    }
  })

  it('masks for a restricted caller: time series skipped, changed definitions left out (plan ruling 14)', async () => {
    const h = await backupHarness(a, b)
    try {
      h.rules('A', [
        { db: 'shop', coll: 'orders', field: 'email' },
        { db: 'shop', coll: 'ts', field: 'email' },
        { db: 'shop', coll: 'val', field: 'email' },
      ])
      const u = h.user({ masked: ['A'] })
      const res = await plan(h, u, { scope: { kind: 'database', db: 'shop' } })
      expect(res.statusCode, res.body).toBe(200)
      const p = res.json()
      expect(p.masked).toBe(true)
      const by = (c: string) => p.namespaces.find((n: { coll: string }) => n.coll === c)
      expect(by('ts').skipped).toMatch(/time series/i)
      expect(by('v').skipped).toMatch(/definition/i)
      // Final review minor 16: a collection keeps its data; only its validator is left out.
      expect(by('val').skipped).toBeUndefined()
      expect(by('val').note).toMatch(/validator/i)
      expect(by('orders').personal).toEqual([])
      expect(by('orders').skipped).toBeUndefined()
      expect(JSON.stringify(p)).not.toContain(S)
      expect(p.checks.find((c: { key: string }) => c.key === 'masked')).toMatchObject({ level: 'ok' })
    } finally {
      await h.t.close()
    }
  })

  it('plans a server without the system databases, and refuses the tools engine when it is not allowed (B8)', async () => {
    const h = await backupHarness(a, b)
    try {
      const p = (await plan(h, h.user(), { scope: { kind: 'server' } })).json()
      expect([...new Set(p.namespaces.map((n: { db: string }) => n.db))].sort()).toEqual(['other', 'shop'])
      const tools = (await plan(h, h.user(), { scope: { kind: 'server' }, engine: 'tools' })).json()
      expect(tools.refusals).toContain('tools_unavailable')
      expect(tools.checks.find((c: { key: string }) => c.key === 'tools')).toMatchObject({ level: 'block' })
      expect((await plan(h, h.user({ role: 'viewer' }), { scope: { kind: 'server' } })).statusCode).toBe(403)
      expect(
        (await plan(h, h.user(), { scope: { kind: 'database', db: 'nope' } })).json().refusals,
      ).toContain('empty')
    } finally {
      await h.t.close()
    }
  })

  it("counts each connection's own collections, whatever another connection planned (final review I4)", async () => {
    const h = await backupHarness(a, b)
    const cb = await new MongoClient(`mongodb://127.0.0.1:${b.port}`).connect()
    try {
      await cb.db('shop').dropDatabase()
      await cb
        .db('shop')
        .collection('orders')
        .insertMany([{ x: 1 }, { x: 2 }, { x: 3 }])
      const u = h.user({ role: 'admin' })
      const body = { scope: { kind: 'collection', db: 'shop', coll: 'orders' }, format: 'gzip' }
      const onA = (await plan(h, u, body)).json()
      const onB = (await u.call('POST', `/api/connections/${h.ids.B}/backup/plan`, body)).json()
      expect(onA.namespaces[0].documents).toBe(50)
      expect(onB.namespaces[0].documents).toBe(3)
    } finally {
      await cb.db('shop').dropDatabase()
      await cb.close()
      await h.t.close()
    }
  })

  it('reads collection sizes several at a time (final review minor 17)', async () => {
    const h = await backupHarness(a, b)
    try {
      for (let i = 0; i < 6; i++) await ca.db('many').collection(`c${i}`).insertOne({ i })
      const real = AggregationCursor.prototype.toArray
      let running = 0
      let peak = 0
      const spy = vi.spyOn(AggregationCursor.prototype, 'toArray').mockImplementation(async function (
        this: AggregationCursor,
      ) {
        running++
        peak = Math.max(peak, running)
        try {
          await new Promise((r) => setTimeout(r, 20))
          return await real.call(this)
        } finally {
          running--
        }
      })
      const res = await plan(h, h.user({ role: 'admin' }), {
        scope: { kind: 'database', db: 'many' },
        format: 'gzip',
      })
      spy.mockRestore()
      expect(res.statusCode, res.body).toBe(200)
      expect(peak).toBeGreaterThan(1)
    } finally {
      await ca.db('many').dropDatabase()
      await h.t.close()
    }
  })

  it('answers the tools availability per connection without the version for non-admins', async () => {
    const h = await backupHarness(a, b)
    try {
      const r = await h.user().get(`/api/connections/${h.ids.A}/backup/tools`)
      expect(r.statusCode).toBe(200)
      expect(r.json().available).toBe(false)
      expect(r.json().version).toBeUndefined()
    } finally {
      await h.t.close()
    }
  })
})
