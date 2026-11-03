import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { EJSON } from 'bson'
import { Decimal128, Double, Int32, Long, MongoClient } from 'mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { AppEvent, LiveSyncDetail, LiveSyncPlan, LiveSyncView } from '@mongo-manager/shared'

import { liveSyncHarness, syncBody, until, type Conn, type LiveSyncHarness } from './support/livesync'
import { slow } from './support/slowness'

/**
 * W4 item 6 (completion design §2 W4.6): live sync — the rejected-records file, verify samples,
 * the lag history, filtered syncs, a scheduled start and two-way syncs, on two real replica sets.
 */
let a: MongoMemoryReplSet
let b: MongoMemoryReplSet
let ma: MongoClient
let mb: MongoClient
beforeAll(async () => {
  ;[a, b] = await Promise.all([
    MongoMemoryReplSet.create({ replSet: { count: 1 } }),
    MongoMemoryReplSet.create({ replSet: { count: 1 } }),
  ])
  ma = await new MongoClient(a.getUri()).connect()
  mb = await new MongoClient(b.getUri()).connect()
}, slow(180_000))
afterAll(async () => {
  await ma?.close()
  await mb?.close()
  await Promise.all([a?.stop(), b?.stop()])
})
const harnesses: LiveSyncHarness[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close()
})
const name = (p: string) => `${p}${randomUUID().slice(0, 8)}`
const timing = {
  liveSync: { timing: { pollMs: 50, idleMs: 50, retryMinMs: 50, retryMaxMs: 400 }, pushMs: 100 },
}

async function harness() {
  const h = await liveSyncHarness(a.getUri(), b.getUri(), undefined, {}, timing as never)
  harnesses.push(h)
  return { h, admin: h.user() }
}
async function start(
  h: LiveSyncHarness,
  u: ReturnType<LiveSyncHarness['user']>,
  from: Conn,
  to: Conn,
  ns: Parameters<typeof syncBody>[3],
  extra: Record<string, unknown> = {},
) {
  if (ns.coll)
    await (from === 'A' ? ma : mb)
      .db(ns.db)
      .createCollection(ns.coll)
      .catch(() => undefined)
  const body = syncBody(h.ids, from, to, ns, extra)
  const plan = (
    await u.call('POST', `/api/connections/${h.ids[from]}/live-syncs/plan`, body)
  ).json() as LiveSyncPlan
  expect(plan.refusals).toEqual([])
  const r = await u.call('POST', `/api/connections/${h.ids[from]}/live-syncs`, {
    ...body,
    planHash: plan.planHash,
  })
  expect(r.statusCode, r.body).toBe(201)
  return (r.json() as LiveSyncView).id
}
const view = async (u: ReturnType<LiveSyncHarness['user']>, id: string) =>
  (await u.get(`/api/live-syncs/${id}`)).json() as LiveSyncDetail

describe('the rejected-records file (W4.6)', () => {
  it('keeps what the target refused, for its owner only, while they may still read it', async () => {
    const { h, admin } = await harness()
    const owner = h.user({ role: 'editor', on: { A: 'editor', B: 'editor' } })
    const db = name('rj')
    await mb.db(db).collection('orders').createIndex({ email: 1 }, { unique: true })
    await mb
      .db(db)
      .collection('orders')
      .insertOne({ _id: 'held' as never, email: 'taken@example.com' })
    const id = await start(
      h,
      owner,
      'A',
      'B',
      { db, coll: 'orders' },
      { startMode: 'merge', errorPolicy: 'skip' },
    )
    await until(async () => (await view(owner, id)).state === 'live', 30_000)
    await ma
      .db(db)
      .collection('orders')
      .insertMany([
        { _id: 1 as never, email: 'taken@example.com', note: 'refused' },
        { _id: 2 as never, email: 'free@example.com' },
      ])
    await until(async () => (await view(owner, id)).counters.skipped === 1, 30_000)
    const file = await owner.get(`/api/live-syncs/${id}/rejected`)
    expect(file.statusCode, file.body).toBe(200)
    expect(file.headers['content-disposition']).toMatch(/attachment/)
    const lines = file.body
      .trim()
      .split('\n')
      .map((l) => EJSON.parse(l))
    expect(lines).toEqual([{ _id: 1, email: 'taken@example.com', note: 'refused' }])
    // W4 review I7: a restart keeps it (it grows for as long as the sync runs), and the sync, still
    // there, gives it its time again (W4 re-review minor).
    const kept0 = h.ctx.transfer.files.byJob(owner.id, id, 'rejected')!.expiresAt
    await new Promise((r) => setTimeout(r, 20))
    await h.restart()
    expect(h.ctx.transfer.files.byJob(owner.id, id, 'rejected')!.expiresAt).toBeGreaterThan(kept0)
    const kept = await owner.get(`/api/live-syncs/${id}/rejected`)
    expect([kept.statusCode, kept.body]).toEqual([200, file.body])
    // Another user does not learn it exists; an administrator is not its owner.
    const other = h.user({ role: 'editor', on: { A: 'editor', B: 'editor' } })
    expect((await other.get(`/api/live-syncs/${id}/rejected`)).statusCode).toBe(404)
    expect((await admin.get(`/api/live-syncs/${id}/rejected`)).statusCode).toBe(403)
    // The owner may no longer see personal values on the source: an unmasked file is not given.
    h.rules('A', [{ db, coll: 'orders', field: 'email' }])
    h.ctx.grants.setMasked(h.ids.A, owner.id, true)
    const masked = await owner.get(`/api/live-syncs/${id}/rejected`)
    expect([masked.statusCode, masked.json().details?.reason]).toEqual([403, 'masked_now'])
    // Deleting the sync deletes its file.
    await owner.call('POST', `/api/live-syncs/${id}/stop`)
    await owner.call('DELETE', `/api/live-syncs/${id}`)
    expect(h.ctx.transfer.files.byJob(owner.id, id, 'rejected')).toBeUndefined()
  })
})

// W4 final review (I): a sync writes values with the types the source stores them in.
describe('values’ types through a one-way sync (W4 final review)', () => {
  it('keeps a Double, a Long, an Int32 and a Decimal128 as they are', async () => {
    const { h, admin } = await harness()
    const db = name('ty')
    const id = await start(h, admin, 'A', 'B', { db, coll: 'orders' }, { startMode: 'from_now' })
    await until(async () => (await view(admin, id)).state === 'live', 30_000)
    await ma
      .db(db)
      .collection('orders')
      .insertOne({
        _id: 1 as never,
        d: new Double(1),
        l: Long.fromString('9007199254740993'),
        small: Long.fromNumber(5),
        i: new Int32(7),
        m: Decimal128.fromString('1.50'),
      })
    const raw = async () => {
      const d = await mb
        .db(db)
        .collection('orders')
        .findOne({ _id: 1 as never }, { promoteValues: false, promoteLongs: false })
      return d ? EJSON.stringify(d, { relaxed: false }) : ''
    }
    await until(async () => (await raw()) !== '', 30_000)
    const there = await raw()
    expect(there).toContain('"d":{"$numberDouble":"1.0"}')
    expect(there).toContain('"l":{"$numberLong":"9007199254740993"}')
    expect(there).toContain('"small":{"$numberLong":"5"}')
    expect(there).toContain('"i":{"$numberInt":"7"}')
    expect(there).toContain('"m":{"$numberDecimal":"1.50"}')
  })
})

describe('verify with samples and field diffs (W4.6)', () => {
  it('keeps samples of what differs for the owner only, never in the sync’s view', async () => {
    const { h, admin } = await harness()
    const owner = h.user({ role: 'editor', on: { A: 'editor', B: 'editor' } })
    const db = name('vf')
    await ma
      .db(db)
      .collection('orders')
      .insertMany([
        { _id: 1 as never, total: 10, city: 'Ankara' },
        { _id: 2 as never, total: 20 },
      ])
    const id = await start(h, owner, 'A', 'B', { db, coll: 'orders' }, { startMode: 'copy' })
    await until(async () => (await view(owner, id)).state === 'live', 30_000)
    // The changes replayed from just before the copy are applied once a later one has arrived.
    await ma
      .db(db)
      .collection('orders')
      .insertOne({ _id: 4 as never, total: 40 })
    await until(
      async () =>
        !!(await mb
          .db(db)
          .collection('orders')
          .findOne({ _id: 4 as never })),
      30_000,
    )
    // Writes on the target behind the sync's back: one changed, one extra.
    await mb
      .db(db)
      .collection('orders')
      .updateOne({ _id: 1 as never }, { $set: { total: 99 } })
    await mb
      .db(db)
      .collection('orders')
      .insertOne({ _id: 3 as never, stray: true })
    await owner.call('POST', `/api/live-syncs/${id}/verify`)
    await until(async () => (await view(owner, id)).verify?.state === 'done', 30_000)
    const v = await view(owner, id)
    expect(v.verify!.pairs[0]).toMatchObject({ different: 1, onlyTarget: 1, same: 2 })
    expect(JSON.stringify(v)).not.toContain('Ankara')
    expect(v.verify!.pairs[0]).not.toHaveProperty('samples')
    const samples = await owner.get(`/api/live-syncs/${id}/verify/samples`)
    expect(samples.statusCode, samples.body).toBe(200)
    const pair = samples.json().pairs[0]
    expect(pair.samples.different[0].changes).toEqual([
      { path: 'total', before: { $numberInt: '99' }, after: { $numberInt: '10' } },
    ])
    expect(pair.samples.onlyTarget[0].doc).toMatchObject({ stray: true })
    expect((await admin.get(`/api/live-syncs/${id}/verify/samples`)).statusCode).toBe(403)
    const other = h.user({ role: 'editor', on: { A: 'editor', B: 'editor' } })
    expect((await other.get(`/api/live-syncs/${id}/verify/samples`)).statusCode).toBe(404)
    // Restricted on the source since: an unmasked sync's samples are not shown.
    h.rules('A', [{ db, coll: 'orders', field: 'city' }])
    h.ctx.grants.setMasked(h.ids.A, owner.id, true)
    const hidden = await owner.get(`/api/live-syncs/${id}/verify/samples`)
    expect([hidden.statusCode, hidden.json().details?.reason]).toEqual([403, 'masked_now'])
  })
})

describe('a filtered sync (W4.6)', () => {
  const ids = async (db: string) =>
    (
      await mb
        .db(db)
        .collection('orders')
        .find({}, { sort: { _id: 1 } })
        .toArray()
    ).map((d) => d._id)

  it('carries only the documents its filter matches, and removes one that leaves it', async () => {
    const { h, admin } = await harness()
    const db = name('ft')
    await ma
      .db(db)
      .collection('orders')
      .insertMany([
        { _id: 1 as never, status: 'paid' },
        { _id: 2 as never, status: 'open' },
      ])
    const id = await start(h, admin, 'A', 'B', { db, coll: 'orders' }, { filter: { status: 'paid' } })
    await until(async () => (await view(admin, id)).state === 'live', 30_000)
    expect(await ids(db)).toEqual([1])
    expect((await view(admin, id)).filter).toEqual({ status: 'paid' })
    const src = ma.db(db).collection('orders')
    await src.updateOne({ _id: 2 as never }, { $set: { status: 'paid' } })
    await until(async () => JSON.stringify(await ids(db)) === '[1,2]', 30_000)
    await src.updateOne({ _id: 1 as never }, { $set: { status: 'open' } })
    await src.insertOne({ _id: 3 as never, status: 'open' })
    await src.insertOne({ _id: 4 as never, status: 'paid' })
    await until(async () => JSON.stringify(await ids(db)) === '[2,4]', 30_000)
    await src.deleteOne({ _id: 2 as never })
    await until(async () => JSON.stringify(await ids(db)) === '[4]', 30_000)
  })

  it('refuses a filter on a database sync, and on a value a masked sync hides', async () => {
    const { h, admin } = await harness()
    const db = name('fm')
    await ma.db(db).createCollection('orders')
    const plan = (
      extra: Record<string, unknown>,
      ns: Parameters<typeof syncBody>[3] = { db, coll: 'orders' },
    ) =>
      admin.call('POST', `/api/connections/${h.ids.A}/live-syncs/plan`, syncBody(h.ids, 'A', 'B', ns, extra))
    expect((await plan({ filter: { status: 'paid' } }, { db })).statusCode).toBe(400)
    h.rules('A', [
      { db, coll: 'orders', field: 'email' },
      { db, coll: 'orders', field: 'contact.phone' },
    ])
    // Refused by the query gate (403), or by the sync's own check where the gate would let it pass.
    const refused = async (filter: Record<string, unknown>) => {
      const res = await plan({ anonymous: true, filter })
      return res.statusCode === 403 || (res.json().refusals as string[]).includes('filter_masked')
    }
    // The hidden path itself, one above it, or an expression that can read it.
    for (const filter of [
      { email: 'a@example.com' },
      { 'contact.phone': '1' },
      { contact: { phone: '1' } },
      { $or: [{ status: 'paid' }, { email: 'x' }] },
    ])
      expect(await refused(filter), JSON.stringify(filter)).toBe(true)
    // The gate lets an expression over other fields pass; a masked sync still refuses it.
    const expr = (await plan({ anonymous: true, filter: { $expr: { $eq: ['$status', 'x'] } } })).json()
    expect(expr.refusals).toContain('filter_masked')
    for (const filter of [{ status: 'paid' }, { 'contact.city': 'Izmir' }])
      expect(await refused(filter), JSON.stringify(filter)).toBe(false)
  })
})

describe('a scheduled start (W4.6)', () => {
  const create = async (
    h: LiveSyncHarness,
    u: ReturnType<LiveSyncHarness['user']>,
    db: string,
    extra: Record<string, unknown>,
  ) => {
    await ma
      .db(db)
      .createCollection('orders')
      .catch(() => undefined)
    const body = syncBody(h.ids, 'A', 'B', { db, coll: 'orders' }, extra)
    const plan = (
      await u.call('POST', `/api/connections/${h.ids.A}/live-syncs/plan`, body)
    ).json() as LiveSyncPlan
    return u.call('POST', `/api/connections/${h.ids.A}/live-syncs`, { ...body, planHash: plan.planHash })
  }

  it('waits, paused, until its time; then plans again and starts as its owner', async () => {
    const { h } = await harness()
    const owner = h.user({ role: 'editor', on: { A: 'editor', B: 'editor' } })
    const db = name('sc')
    await ma
      .db(db)
      .collection('orders')
      .insertMany([{ n: 1 }, { n: 2 }])
    const at = Date.now() + 3600_000
    const res = await create(h, owner, db, { startAt: at })
    expect(res.statusCode, res.body).toBe(201)
    const id = (res.json() as LiveSyncView).id
    expect(res.json()).toMatchObject({
      state: 'paused',
      reason: 'scheduled',
      scheduledAt: at,
      copyJobId: null,
    })
    // Nothing is read or written before its time.
    await h.ctx.liveSync.startDue(Date.now())
    expect((await view(owner, id)).state).toBe('paused')
    expect(await mb.db(db).collection('orders').countDocuments()).toBe(0)
    // A restart keeps it waiting; its time comes.
    await h.restart()
    await h.ctx.liveSync.startDue(at + 1)
    await until(async () => (await view(owner, id)).state === 'live', 30_000)
    expect(await mb.db(db).collection('orders').countDocuments()).toBe(2)
    await ma.db(db).collection('orders').insertOne({ n: 3 })
    await until(async () => (await mb.db(db).collection('orders').countDocuments()) === 3, 30_000)
  })

  it('starts now on its owner’s word only, and refuses a time too soon or too far', async () => {
    const { h, admin } = await harness()
    const owner = h.user({ role: 'editor', on: { A: 'editor', B: 'editor' } })
    const db = name('sn')
    for (const startAt of [Date.now() + 10_000, Date.now() + 40 * 86400_000]) {
      const bad = await create(h, owner, db, { startAt })
      expect([bad.statusCode, bad.json().details?.reason]).toEqual([400, 'start_at'])
    }
    const id = ((await create(h, owner, db, { startAt: Date.now() + 3600_000 })).json() as LiveSyncView).id
    const byAdmin = await admin.call('POST', `/api/live-syncs/${id}/resume`)
    expect([byAdmin.statusCode, byAdmin.json().details?.reason]).toEqual([403, 'not_owner'])
    expect((await owner.call('POST', `/api/live-syncs/${id}/resume`)).statusCode).toBe(200)
    await until(async () => (await view(owner, id)).state === 'live', 30_000)
  })

  it('needs a person when its plan no longer holds at its time', async () => {
    const { h } = await harness()
    const owner = h.user({ role: 'editor', on: { A: 'editor', B: 'editor' } })
    const db = name('sr')
    const id = ((await create(h, owner, db, { startAt: Date.now() + 3600_000 })).json() as LiveSyncView).id
    // "Copy first" needs an empty target; someone filled it meanwhile.
    await mb.db(db).collection('orders').insertOne({ stray: true })
    await h.ctx.liveSync.startDue(Date.now() + 7200_000)
    const v = await view(owner, id)
    expect([v.state, v.reason, v.detail]).toEqual(['attention', 'scheduled_refused', 'target_not_empty'])
  })

  // W4 review C3: the owner's rights on the source are read again at the start, as before every batch.
  it('does not start for an owner who lost the source’s export right meanwhile — at its time or now', async () => {
    const { h } = await harness()
    const owner = h.user({ role: 'editor', on: { A: 'editor', B: 'editor' } })
    const db = name('sv')
    await ma
      .db(db)
      .collection('orders')
      .insertMany([{ n: 1 }, { n: 2 }])
    const id = ((await create(h, owner, db, { startAt: Date.now() + 3600_000 })).json() as LiveSyncView).id
    // A viewer of the source, without the export grant: may read, may not take the data away.
    h.ctx.grants.set(h.ids.A, owner.id, 'viewer')
    await h.ctx.liveSync.startDue(Date.now() + 7200_000)
    const v = await view(owner, id)
    expect([v.state, v.reason, v.detail]).toEqual(['attention', 'owner_access', 'source'])
    expect(v.copyJobId).toBeNull()
    expect(await mb.db(db).collection('orders').countDocuments()).toBe(0)
    // Its owner asks to try again: still refused, still nothing read.
    expect((await owner.call('POST', `/api/live-syncs/${id}/resume`)).statusCode).toBe(200)
    expect((await view(owner, id)).reason).toBe('owner_access')
    expect(await mb.db(db).collection('orders').countDocuments()).toBe(0)
    // The right back: trying again starts it (planned now — it never started).
    h.ctx.grants.set(h.ids.A, owner.id, 'editor')
    expect((await owner.call('POST', `/api/live-syncs/${id}/resume`)).statusCode).toBe(200)
    await until(async () => (await view(owner, id)).state === 'live', 30_000)
    expect(await mb.db(db).collection('orders').countDocuments()).toBe(2)
  })

  it('does not start now for an owner without the source’s read right', async () => {
    const { h } = await harness()
    const owner = h.user({ role: 'editor', on: { A: 'editor', B: 'editor' } })
    const db = name('sw')
    await ma.db(db).collection('orders').insertOne({ n: 1 })
    const id = ((await create(h, owner, db, { startAt: Date.now() + 3600_000 })).json() as LiveSyncView).id
    h.ctx.grants.set(h.ids.A, owner.id, 'none')
    // The route hides a connection the owner may no longer see; the runner refuses as well.
    await h.ctx.liveSync.resume(h.ctx.liveSync.repo.get(id)!, false)
    const r = h.ctx.liveSync.repo.get(id)!
    expect([r.state, r.reason]).toEqual(['attention', 'owner_access'])
    expect(await mb.db(db).collection('orders').countDocuments()).toBe(0)
  })

  it('waits for room among its owner’s transfers before its copy starts', async () => {
    const { h } = await harness()
    const owner = h.user({ role: 'editor', on: { A: 'editor', B: 'editor' } })
    const db = name('sq')
    await ma.db(db).collection('orders').insertOne({ n: 1 })
    const id = ((await create(h, owner, db, { startAt: Date.now() + 3600_000 })).json() as LiveSyncView).id
    const list = h.ctx.jobs.list.bind(h.ctx.jobs)
    const busy = Array.from({ length: 10 }, () => ({ kind: 'data.copy', userId: owner.id }))
    h.ctx.jobs.list = ((q?: { state?: string }) =>
      q?.state === 'running' ? busy : list(q as never)) as never
    try {
      // At its time: it keeps waiting (the timer tries again).
      await h.ctx.liveSync.startDue(Date.now() + 7200_000)
      expect(h.ctx.liveSync.repo.get(id)).toMatchObject({
        state: 'paused',
        reason: 'scheduled',
        copyJobId: null,
      })
      // "Start now": said.
      const now = await owner.call('POST', `/api/live-syncs/${id}/resume`)
      expect([now.statusCode, now.json().details?.reason]).toEqual([409, 'transfer_busy'])
    } finally {
      h.ctx.jobs.list = list
    }
    await h.ctx.liveSync.startDue(Date.now() + 7200_000)
    await until(async () => (await view(owner, id)).state === 'live', 30_000)
  })

  it('asks its owner to review rules added after it was scheduled before it starts', async () => {
    const { h } = await harness()
    const owner = h.user({ role: 'editor', on: { A: 'editor', B: 'editor' } })
    const db = name('sp')
    await ma.db(db).collection('orders').insertOne({ email: 'a@example.com' })
    const id = ((await create(h, owner, db, { startAt: Date.now() + 3600_000 })).json() as LiveSyncView).id
    h.rules('A', [{ db, coll: 'orders', field: 'email' }])
    await h.ctx.liveSync.startDue(Date.now() + 7200_000)
    const v = await view(owner, id)
    expect([v.state, v.reason]).toEqual(['attention', 'rules_changed'])
    expect(await mb.db(db).collection('orders').countDocuments()).toBe(0)
    // Resuming without the review is refused; the review's confirmation starts it.
    const plain = await owner.call('POST', `/api/live-syncs/${id}/resume`)
    expect(plain.json().details?.reason).toBe('review_required')
    const review = (
      await owner.call('POST', `/api/connections/${h.ids.A}/live-syncs/${id}/review`, {
        confirmPersonal: true,
      })
    ).json() as LiveSyncPlan
    const ok = await owner.call('POST', `/api/connections/${h.ids.A}/live-syncs/${id}/confirm`, {
      planHash: review.planHash,
      confirmPersonal: true,
    })
    expect(ok.statusCode, ok.body).toBe(200)
    await until(async () => (await view(owner, id)).state === 'live', 30_000)
    expect(await mb.db(db).collection('orders').countDocuments()).toBe(1)
  })
})

describe('a sync that stops by itself, as an alert (W4.6, W4 review I4)', () => {
  it('is one alert, from the sync’s own record, with the reason as a code', async () => {
    const { h, admin } = await harness()
    h.ctx.alerts.repo.createRule(
      {
        kind: 'event',
        event: 'liveSync.stopped',
        connectionId: null,
        enabled: true,
        channels: { inApp: true, email: false, webhooks: [] },
      },
      null,
    )
    const stopped = () =>
      h.ctx.alerts.repo.history({ limit: 50 }).filter((e) => e.event === 'liveSync.stopped')
    const db = name('ev')
    const id = await start(h, admin, 'A', 'B', { db, coll: 'orders' }, { startMode: 'from_now' })
    await until(async () => (await view(admin, id)).state === 'live', 30_000)
    // The rules move under it: it stops for a person.
    h.rules('A', [{ db, coll: 'orders', field: 'email' }])
    await ma.db(db).collection('orders').insertOne({ n: 1 })
    await until(() => stopped().length > 0, 30_000)
    await new Promise((r) => setTimeout(r, 300))
    // Raised once: the app events no longer carry it (one source, W3's).
    expect(stopped()).toHaveLength(1)
    expect(stopped()[0]!.detail).toMatchObject({ sync: id, state: 'attention', reason: 'rules_changed' })
  })
})

describe('a two-way sync (W4.6)', () => {
  const twoWayBody = (h: LiveSyncHarness, db: string, extra: Record<string, unknown> = {}) =>
    syncBody(
      h.ids,
      'A',
      'B',
      { db, coll: 'orders' },
      {
        startMode: 'from_now',
        twoWay: true,
        enablePreImages: true,
        confirmTwoWay: true,
        ...extra,
      },
    )
  /** Both sides seeded with the same documents, then a two-way sync between them. */
  async function twoWay(h: LiveSyncHarness, u: ReturnType<LiveSyncHarness['user']>, db: string) {
    // A value that reads like a field path: a pre-image is compared as a literal, never evaluated.
    const docs = [
      { _id: 1, v: 0, tag: '$v' },
      { _id: 2, v: 0, tag: '$v' },
    ]
    await ma
      .db(db)
      .collection('orders')
      .insertMany(docs as never)
    await mb
      .db(db)
      .collection('orders')
      .insertMany(docs as never)
    const body = twoWayBody(h, db)
    const plan = (
      await u.call('POST', `/api/connections/${h.ids.A}/live-syncs/plan`, body)
    ).json() as LiveSyncPlan
    expect(plan.refusals).toEqual([])
    expect(plan.warnings).toContain('two_way')
    const res = await u.call('POST', `/api/connections/${h.ids.A}/live-syncs`, {
      ...body,
      planHash: plan.planHash,
    })
    expect(res.statusCode, res.body).toBe(201)
    const forward = res.json() as LiveSyncView
    expect(forward.twoWay).toMatchObject({ side: 'forward' })
    const reverse = forward.twoWay!.partner
    await until(
      async () => (await view(u, forward.id)).state === 'live' && (await view(u, reverse)).state === 'live',
      30_000,
    )
    return { forward: forward.id, reverse }
  }
  const both = async (db: string) => ({
    a: await ma
      .db(db)
      .collection('orders')
      .find({}, { sort: { _id: 1 } })
      .toArray(),
    b: await mb
      .db(db)
      .collection('orders')
      .find({}, { sort: { _id: 1 } })
      .toArray(),
  })
  const same = async (db: string) => {
    const { a, b } = await both(db)
    return JSON.stringify(a) === JSON.stringify(b)
  }

  it('carries changes both ways, and never sends a change back where it came from', async () => {
    const { h, admin } = await harness()
    const db = name('tw')
    const { forward, reverse } = await twoWay(h, admin, db)
    await ma
      .db(db)
      .collection('orders')
      .insertOne({ _id: 3 as never, v: 'from a' })
    await until(
      async () =>
        !!(await mb
          .db(db)
          .collection('orders')
          .findOne({ _id: 3 as never })),
      30_000,
    )
    await mb
      .db(db)
      .collection('orders')
      .updateOne({ _id: 1 as never }, { $set: { v: 'from b' } })
    await until(
      async () =>
        (
          await ma
            .db(db)
            .collection('orders')
            .findOne({ _id: 1 as never })
        )?.v === 'from b',
      30_000,
    )
    await ma
      .db(db)
      .collection('orders')
      .deleteOne({ _id: 2 as never })
    await until(
      async () =>
        !(await mb
          .db(db)
          .collection('orders')
          .findOne({ _id: 2 as never })),
      30_000,
    )
    await until(() => same(db), 30_000)
    // Quiet: what each direction wrote is its own side's changes only (no echo came back).
    await new Promise((r) => setTimeout(r, 1500))
    const f = await view(admin, forward)
    const r = await view(admin, reverse)
    expect([f.counters.inserted, f.counters.replaced, f.counters.deleted]).toEqual([1, 0, 1])
    expect([r.counters.inserted, r.counters.replaced, r.counters.deleted]).toEqual([0, 1, 0])
    expect((f.counters.conflicts ?? 0) + (r.counters.conflicts ?? 0)).toBe(0)
    expect(await same(db)).toBe(true)
    // The mark: the forward direction's write on B carries its session, which the way back skips.
    const marks = h.ctx.liveSync.repo.get(forward)!.options.twoWay!.echo
    expect(marks.length).toBeGreaterThan(0)
    const watch = mb.db(db).collection('orders').watch([], { startAtOperationTime: undefined })
    try {
      await ma
        .db(db)
        .collection('orders')
        .insertOne({ _id: 4 as never, v: 'marked' })
      const e = (await watch.next()) as unknown as { lsid?: { id: { toString(enc: string): string } } }
      expect(marks.map((m) => m.split(':')[0])).toContain(e.lsid!.id.toString('hex'))
    } finally {
      await watch.close()
    }
  })

  it(
    'settles the same after a restart in the middle, the later writer winning either way',
    { timeout: 90_000 },
    async () => {
      const { h, admin } = await harness()
      const db = name('tx')
      const { forward, reverse } = await twoWay(h, admin, db)
      await admin.call('POST', `/api/live-syncs/${reverse}/pause`)
      expect((await view(admin, forward)).state).toBe('paused')
      await mb
        .db(db)
        .collection('orders')
        .updateOne({ _id: 1 as never }, { $set: { v: 'b first' } })
      await new Promise((r) => setTimeout(r, 30))
      await ma
        .db(db)
        .collection('orders')
        .updateOne({ _id: 1 as never }, { $set: { v: 'a later' } })
      await h.restart()
      await admin.call('POST', `/api/live-syncs/${reverse}/resume`)
      await until(async () => {
        const { a, b } = await both(db)
        return (
          JSON.stringify(a) === JSON.stringify(b) && a.find((d) => (d._id as unknown) === 1)?.v === 'a later'
        )
      }, 30_000)
      await new Promise((r) => setTimeout(r, 1500))
      expect((await both(db)).a.find((d) => (d._id as unknown) === 1)?.v).toBe('a later')
      expect(await same(db)).toBe(true)
    },
  )

  it(
    'settles a conflict for the last writer on both sides, lists it and raises the event',
    { timeout: 90_000 },
    async () => {
      const { h, admin } = await harness()
      const events: AppEvent[] = []
      const off = h.ctx.events.on((e) => void events.push(e))
      try {
        const db = name('tc')
        const { forward, reverse } = await twoWay(h, admin, db)
        // Both directions paused: both sides change the same documents, in a known order.
        await admin.call('POST', `/api/live-syncs/${forward}/pause`)
        expect((await view(admin, reverse)).state).toBe('paused')
        await ma
          .db(db)
          .collection('orders')
          .updateOne({ _id: 1 as never }, { $set: { v: 'a first' } })
        await new Promise((r) => setTimeout(r, 30))
        await mb
          .db(db)
          .collection('orders')
          .updateOne({ _id: 1 as never }, { $set: { v: 'b later' } })
        await mb
          .db(db)
          .collection('orders')
          .updateOne({ _id: 2 as never }, { $set: { v: 'b first' } })
        await new Promise((r) => setTimeout(r, 30))
        await ma
          .db(db)
          .collection('orders')
          .deleteOne({ _id: 2 as never })
        await admin.call('POST', `/api/live-syncs/${forward}/resume`)
        await until(async () => {
          const { a, b } = await both(db)
          return JSON.stringify(a) === JSON.stringify(b) && a.length === 1 && a[0]!.v === 'b later'
        }, 30_000).catch(async (e) => {
          throw new Error(
            `${String(e)}: ${JSON.stringify(await both(db))} ${JSON.stringify([
              (await view(admin, forward)).state,
              (await view(admin, reverse)).state,
              (await view(admin, forward)).events.slice(-4),
              (await view(admin, reverse)).events.slice(-4),
            ])}`,
          )
        })
        const f = await view(admin, forward)
        const r = await view(admin, reverse)
        expect((f.counters.conflicts ?? 0) + (r.counters.conflicts ?? 0)).toBe(2)
        const listed = [
          ...(await view(admin, forward)).events,
          ...(await view(admin, reverse)).events,
        ].filter((e) => e.kind === 'conflict')
        expect(listed).toHaveLength(2)
        expect(listed.map((e) => e.detail).join(' ')).toMatch(/both/)
        await until(() => events.some((e) => e.kind === 'liveSync.conflicts'), 10_000)
        // Stays settled: nothing more moves.
        await new Promise((r) => setTimeout(r, 1500))
        expect(await same(db)).toBe(true)
      } finally {
        off()
      }
    },
  )

  // W4 review I5: a direction left running alone would hold its changes for ever, waiting.
  it(
    'pauses one direction when the other stops by itself, and resumes both together',
    { timeout: 90_000 },
    async () => {
      const { h, admin } = await harness()
      const db = name('tp')
      // A refuses a value B accepts (set before the sync: a change of options would stop it first).
      await ma.db(db).createCollection('orders', { validator: { v: { $ne: 'bad' } } })
      const { forward, reverse } = await twoWay(h, admin, db)
      // The way back stops for a person.
      await mb
        .db(db)
        .collection('orders')
        .updateOne({ _id: 1 as never }, { $set: { v: 'bad' } })
      // Read from the store: the routes' rate limit is not what is tested here.
      const state = (id: string) => h.ctx.liveSync.repo.get(id)!
      await until(() => state(reverse).state === 'attention', 30_000)
      await until(() => state(forward).state === 'paused', 30_000)
      expect(state(forward).reason).toBe('partner_stopped')
      // Its owner skips the refused change: both go on.
      const skip = await admin.call('POST', `/api/live-syncs/${reverse}/skip`)
      expect(skip.statusCode, skip.body).toBe(200)
      await until(() => state(forward).state === 'live' && state(reverse).state === 'live', 30_000).catch(
        (e: Error) => {
          const of = (id: string) => {
            const r = state(id)
            const events = h.ctx.liveSync.repo.events(id).slice(-6)
            return { state: r.state, reason: r.reason, detail: r.detail, events }
          }
          throw new Error(`${e.message}: ${JSON.stringify({ forward: of(forward), reverse: of(reverse) })}`)
        },
      )
      await ma
        .db(db)
        .collection('orders')
        .updateOne({ _id: 2 as never }, { $set: { v: 'again' } })
      await until(
        async () =>
          (
            await mb
              .db(db)
              .collection('orders')
              .findOne({ _id: 2 as never })
          )?.v === 'again',
        30_000,
      )
    },
  )

  // CI 2026-10-20: a skip that came while the stopped worker was still closing its stream found it
  // there and started none; once it was gone the direction sat in catching_up for ever.
  it(
    'starts the direction again when the skip comes while its stopped worker is still closing',
    { timeout: 90_000 },
    async () => {
      const { h, admin } = await harness()
      const db = name('tq')
      await ma.db(db).createCollection('orders', { validator: { v: { $ne: 'bad' } } })
      // The way back's stream closes only when let go.
      let held: string | null = null
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      type Opener = (id: string, from: unknown) => Promise<{ close(): Promise<void> }>
      const runner = h.ctx.liveSync as unknown as { open: Opener }
      const open = runner.open.bind(runner)
      vi.spyOn(runner, 'open').mockImplementation(async (id, from) => {
        const s = await open(id, from)
        const close = s.close.bind(s)
        s.close = async () => {
          if (id === held) await gate
          await close()
        }
        return s
      })
      try {
        const { forward, reverse } = await twoWay(h, admin, db)
        const state = (id: string) => h.ctx.liveSync.repo.get(id)!
        held = reverse
        await mb
          .db(db)
          .collection('orders')
          .updateOne({ _id: 1 as never }, { $set: { v: 'bad' } })
        await until(() => state(reverse).state === 'attention', 30_000)
        await until(() => state(forward).state === 'paused', 30_000)
        // Its stopped worker is still closing its stream when the skip comes.
        const skip = await admin.call('POST', `/api/live-syncs/${reverse}/skip`)
        expect(skip.statusCode, skip.body).toBe(200)
        held = null
        release()
        await until(() => state(forward).state === 'live' && state(reverse).state === 'live', 30_000).catch(
          (e: Error) => {
            const of = (id: string) => {
              const r = state(id)
              return { state: r.state, reason: r.reason, events: h.ctx.liveSync.repo.events(id).slice(-6) }
            }
            throw new Error(`${e.message}: ${JSON.stringify({ forward: of(forward), reverse: of(reverse) })}`)
          },
        )
        await mb
          .db(db)
          .collection('orders')
          .updateOne({ _id: 2 as never }, { $set: { v: 'back again' } })
        await until(
          async () =>
            (
              await ma
                .db(db)
                .collection('orders')
                .findOne({ _id: 2 as never })
            )?.v === 'back again',
          30_000,
        )
      } finally {
        release()
        vi.restoreAllMocks()
      }
    },
  )

  // Review of the CI fix 2026-10-20 (important): a halt left its worker unknown while it ended, so a
  // pause in that moment returned at once and a resume started a second worker beside the first,
  // both writing and saving places. Second review (minor 5): nor does the partner's halt, ending
  // while the pause still writes its state, start it again.
  it(
    'never runs two workers for one direction when it is paused and resumed while being halted',
    { timeout: 90_000 },
    async () => {
      const { h, admin } = await harness()
      const db = name('th')
      await ma.db(db).createCollection('orders', { validator: { v: { $ne: 'bad' } } })
      // The forward worker, once holding, is kept busy in its pull until let go.
      let held: string | null = null
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      let parked!: () => void
      const parkedAt = new Promise<void>((r) => (parked = r))
      type Stream = { tryNext(): Promise<unknown> }
      const runner = h.ctx.liveSync as unknown as {
        open: (id: string, from: unknown) => Promise<Stream>
        halt: (id: string) => Promise<void>
        workers: Map<string, { done: Promise<void> }>
      }
      const opener = runner.open.bind(runner)
      vi.spyOn(runner, 'open').mockImplementation(async (id, from) => {
        const s = await opener(id, from)
        const next = s.tryNext.bind(s)
        s.tryNext = async () => {
          if (id === held) {
            parked()
            await gate
          }
          return next()
        }
        return s
      })
      // Every halt asked, and how many of a direction's workers run at once (from their start to
      // their loop's end) and in all.
      const halts: string[] = []
      const halt = runner.halt.bind(runner)
      vi.spyOn(runner, 'halt').mockImplementation((id) => {
        halts.push(id)
        return halt(id)
      })
      const alive = new Map<string, number>()
      const most = new Map<string, number>()
      const started = new Map<string, number>()
      const set = runner.workers.set.bind(runner.workers)
      runner.workers.set = (id, entry) => {
        alive.set(id, (alive.get(id) ?? 0) + 1)
        most.set(id, Math.max(most.get(id) ?? 0, alive.get(id)!))
        started.set(id, (started.get(id) ?? 0) + 1)
        void entry.done.finally(() => alive.set(id, alive.get(id)! - 1))
        return set(id, entry)
      }
      try {
        const { forward, reverse } = await twoWay(h, admin, db)
        const state = (id: string) => h.ctx.liveSync.repo.get(id)!
        const count = (id: string) => halts.filter((x) => x === id).length
        held = forward
        await parkedAt
        const before = started.get(forward)
        // The way back stops for a person; the forward worker, halted for it, is slow to end.
        await mb
          .db(db)
          .collection('orders')
          .updateOne({ _id: 1 as never }, { $set: { v: 'bad' } })
        await until(() => state(reverse).state === 'attention' && count(forward) === 1, 30_000)
        // Meanwhile its owner pauses it, then resumes it: the pause waits for the worker to end, so
        // the resume finds it still running and starts nothing beside it.
        const pausing = admin.call('POST', `/api/live-syncs/${forward}/pause`)
        await until(() => count(forward) === 2, 30_000)
        const early = await admin.call('POST', `/api/live-syncs/${forward}/resume`)
        expect(early.statusCode, early.body).toBe(409)
        expect(most.get(forward)).toBe(1)
        // And the way back is set going again before the pause has written its state.
        const skip = await admin.call('POST', `/api/live-syncs/${reverse}/skip`)
        expect(skip.statusCode, skip.body).toBe(200)
        held = null
        release()
        expect((await pausing).statusCode).toBe(200)
        await until(() => !runner.workers.has(forward) && !runner.workers.has(reverse), 30_000)
        // The pause wrote last, and no forward worker started after the one it halted.
        expect(state(forward)).toMatchObject({ state: 'paused', reason: 'owner' })
        expect(state(reverse)).toMatchObject({ state: 'paused', reason: 'owner' })
        expect(started.get(forward)).toBe(before)
        expect(most.get(forward)).toBe(1)
      } finally {
        release()
        vi.restoreAllMocks()
      }
    },
  )

  // W4 review (minor): without pre-images every change would look like a conflict-free overwrite.
  it(
    'waits when a side’s pre-images are turned off, until they are on again',
    { timeout: 90_000 },
    async () => {
      const { h, admin } = await harness()
      const db = name('ti')
      const { forward, reverse } = await twoWay(h, admin, db)
      const state = (id: string) => h.ctx.liveSync.repo.get(id)!
      await mb.db(db).command({ collMod: 'orders', changeStreamPreAndPostImages: { enabled: false } })
      // The change of options stops the way back first; passing it over still finds the images off.
      await until(() => state(reverse).state === 'attention', 30_000)
      if (state(reverse).reason === 'schema_changed') {
        const ignore = await admin.call('POST', `/api/live-syncs/${reverse}/apply-schema`, { ignore: true })
        expect(ignore.statusCode, ignore.body).toBe(200)
      }
      await until(() => state(reverse).reason === 'pre_images_off', 30_000)
      await until(() => state(forward).state === 'paused', 30_000)
      await mb.db(db).command({ collMod: 'orders', changeStreamPreAndPostImages: { enabled: true } })
      const again = await admin.call('POST', `/api/live-syncs/${reverse}/resume`)
      expect(again.statusCode, again.body).toBe(200)
      // That change of options is passed over as well (a person decides on every one).
      await until(() => state(reverse).reason === 'schema_changed', 30_000)
      await admin.call('POST', `/api/live-syncs/${reverse}/apply-schema`, { ignore: true })
      await until(() => state(forward).state === 'live' && state(reverse).state === 'live', 30_000)
    },
  )

  // W4 final review: a side that resumes while the other is still being paused for it takes the
  // other one along — never both left paused, each for the other.
  it(
    'resumes both when a side resumes before the other finished pausing for it',
    { timeout: 90_000 },
    async () => {
      const { h, admin } = await harness()
      const db = name('tq')
      const { forward, reverse } = await twoWay(h, admin, db)
      const state = (id: string) => h.ctx.liveSync.repo.get(id)!
      const svc = h.ctx.liveSync as unknown as {
        system: (...a: unknown[]) => unknown
        restart: (r: unknown) => unknown
      }
      svc.system(reverse, 'attention', 'schema_changed', null)
      // The way back resumes at once: the forward direction's worker is still being stopped.
      svc.restart(state(reverse))
      await until(() => state(forward).state === 'live' && state(reverse).state === 'live', 30_000)
      await new Promise((done) => setTimeout(done, 1500))
      expect([state(forward).state, state(reverse).state]).toEqual(['live', 'live'])
    },
  )

  // W4 re-review 2 (minor): after a backlog, the side that lagged catches up first.
  it(
    'resumes the lagging side first after a backlog, the other once it is live',
    { timeout: 90_000 },
    async () => {
      const { h, admin } = await harness()
      const db = name('tb')
      const { forward, reverse } = await twoWay(h, admin, db)
      const state = (id: string) => h.ctx.liveSync.repo.get(id)!
      ;(h.ctx.liveSync as unknown as { system: (...a: unknown[]) => unknown }).system(
        forward,
        'attention',
        'two_way_backlog',
        null,
      )
      await until(() => state(reverse).state === 'paused', 30_000)
      const res = await admin.call('POST', `/api/live-syncs/${forward}/resume`)
      expect(res.statusCode, res.body).toBe(200)
      expect([state(forward).state, state(forward).reason]).toEqual(['paused', 'partner_catching_up'])
      expect(['catching_up', 'live']).toContain(state(reverse).state)
      await until(() => state(forward).state === 'live' && state(reverse).state === 'live', 30_000)
    },
  )

  it('refuses what two-way cannot keep safe, and goes as one: stop, no cutover', async () => {
    const { h, admin } = await harness()
    const db = name('tr')
    await ma.db(db).createCollection('orders')
    await mb.db(db).createCollection('orders')
    const refusals = async (
      extra: Record<string, unknown>,
      ns: Parameters<typeof syncBody>[3] = { db, coll: 'orders' },
    ) =>
      (
        await admin.call(
          'POST',
          `/api/connections/${h.ids.A}/live-syncs/plan`,
          syncBody(h.ids, 'A', 'B', ns, {
            startMode: 'from_now',
            twoWay: true,
            enablePreImages: true,
            confirmTwoWay: true,
            ...extra,
          }),
        )
      ).json().refusals as string[]
    expect(await refusals({ startMode: 'copy' })).toContain('two_way_from_now')
    expect(await refusals({ confirmTwoWay: false })).toContain('confirm_two_way')
    expect(await refusals({ enablePreImages: false })).toContain('pre_images_off')
    expect(await refusals({ anonymous: true })).toContain('two_way_masked')
    expect(await refusals({ filter: { v: 1 } })).toContain('two_way_filter')
    expect(await refusals({}, { db })).toContain('two_way_collection')
    h.rules('B', [{ db, coll: 'orders', field: 'email' }])
    expect(await refusals({})).toContain('two_way_rules')
    h.rules('B', [])
    // A user who may not read the target cannot sync back from it.
    const oneSided = h.user({ role: 'editor', on: { A: 'editor', B: 'editor' } })
    h.ctx.grants.setMasked(h.ids.B, oneSided.id, true)
    h.rules('B', [{ db: 'elsewhere', coll: 'x', field: 'y' }])
    const res = await oneSided.call('POST', `/api/connections/${h.ids.A}/live-syncs/plan`, twoWayBody(h, db))
    expect(res.json().refusals).toContain('two_way_masked')
    h.rules('B', [])
    const db2 = name('ts')
    const { forward, reverse } = await twoWay(h, admin, db2)
    const finish = await admin.call('POST', `/api/live-syncs/${reverse}/finish`, { verify: false })
    expect([finish.statusCode, finish.json().details?.reason]).toEqual([409, 'two_way_finish'])
    await admin.call('POST', `/api/live-syncs/${reverse}/stop`)
    expect([(await view(admin, forward)).state, (await view(admin, reverse)).state]).toEqual([
      'stopped',
      'stopped',
    ])
    expect((await admin.call('DELETE', `/api/live-syncs/${forward}`)).statusCode).toBe(204)
    expect((await admin.get(`/api/live-syncs/${reverse}`)).statusCode).toBe(404)
  })
})

describe('the lag history (W4.6)', () => {
  it('is kept on the server for whoever may see the sync, and survives a restart', async () => {
    const { h, admin } = await harness()
    const db = name('lag')
    const id = await start(h, admin, 'A', 'B', { db, coll: 'orders' }, { startMode: 'from_now' })
    await until(async () => (await view(admin, id)).state === 'live', 30_000)
    await ma.db(db).collection('orders').insertOne({ n: 1 })
    await until(
      async () => ((await admin.get(`/api/live-syncs/${id}/lag?minutes=10`)).json().points.length ?? 0) > 0,
      30_000,
    )
    await h.restart()
    const after = await admin.get(`/api/live-syncs/${id}/lag?minutes=10`)
    expect(after.json().points[0]).toEqual({ at: expect.any(Number), lag: expect.any(Number) })
    expect((await admin.get(`/api/live-syncs/${id}/lag?minutes=5`)).statusCode).toBe(400)
    const other = h.user({ role: 'editor', on: { A: 'editor', B: 'editor' } })
    expect((await other.get(`/api/live-syncs/${id}/lag`)).statusCode).toBe(404)
  })
})
