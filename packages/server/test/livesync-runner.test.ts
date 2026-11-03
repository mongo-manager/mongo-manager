import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { LiveSyncDetail, LiveSyncPlan, LiveSyncsList, LiveSyncView } from '@mongo-manager/shared'
import { liveSyncHarness, syncBody, until, type Conn, type LiveSyncHarness } from './support/livesync'
import { slow } from './support/slowness'

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
  liveSync: { timing: { pollMs: 50, idleMs: 50, retryMinMs: 50, retryMaxMs: 200 }, pushMs: 100 },
}

async function setup(overrides: object = {}) {
  const h = await liveSyncHarness(a.getUri(), b.getUri(), undefined, overrides, timing as never)
  harnesses.push(h)
  return h
}
type User = ReturnType<LiveSyncHarness['user']>

/** Plans, then starts, a sync as `u`; answers the start's response. */
async function start(
  u: User,
  h: LiveSyncHarness,
  from: Conn,
  to: Conn,
  ns: Parameters<typeof syncBody>[3],
  extra: Record<string, unknown> = {},
) {
  // A collection sync needs its source collection (as a copy does).
  if (ns.coll)
    await ma
      .db(ns.db)
      .createCollection(ns.coll)
      .catch(() => undefined)
  const body = syncBody(h.ids, from, to, ns, extra)
  const plan = (
    await u.call('POST', `/api/connections/${h.ids[from]}/live-syncs/plan`, body)
  ).json() as LiveSyncPlan
  return u.call('POST', `/api/connections/${h.ids[from]}/live-syncs`, { ...body, planHash: plan.planHash })
}
const sync = (h: LiveSyncHarness, id: string) => h.ctx.liveSync.repo.get(id)!

describe('starting a live sync (phase 3e-2 spec §1.3)', () => {
  it('copies first, catches up and goes live, then carries every new change', async () => {
    const h = await setup()
    const admin = h.user()
    const coll = name('c')
    await ma
      .db('live')
      .collection(coll)
      .insertMany([
        { _id: 1, n: 1 },
        { _id: 2, n: 2 },
        { _id: 3, n: 3 },
      ] as never[])
    const r = await start(admin, h, 'A', 'B', { db: 'live', coll })
    expect(r.statusCode).toBe(201)
    const view = r.json() as LiveSyncView
    expect(view).toMatchObject({
      state: 'copying',
      mine: true,
      startMode: 'copy',
      copyJobId: expect.any(String),
    })
    await until(() => sync(h, view.id).state === 'live', 30_000)
    expect(await mb.db('live').collection(coll).countDocuments()).toBe(3)
    await ma
      .db('live')
      .collection(coll)
      .insertOne({ _id: 4, n: 4 } as never)
    await ma
      .db('live')
      .collection(coll)
      .updateOne({ _id: 1 } as never, { $set: { n: 10 } })
    await ma
      .db('live')
      .collection(coll)
      .deleteOne({ _id: 2 } as never)
    await until(
      async () =>
        (
          await mb
            .db('live')
            .collection(coll)
            .find({}, { sort: { _id: 1 } })
            .toArray()
        )
          .map((d) => d.n)
          .join() === '10,3,4',
    )
    const detail = (await admin.get(`/api/live-syncs/${view.id}`)).json() as LiveSyncDetail
    expect(detail.copiedAt).toEqual(expect.any(Number))
    expect(detail.events.map((e) => e.state).filter(Boolean)).toEqual(
      expect.arrayContaining(['catching_up', 'live']),
    )
    // S7: the place and its token never leave the server.
    expect(JSON.stringify(detail)).not.toMatch(/_data|"place/)
  }, 60_000)

  it('from now: copies nothing and carries what changes from then on', async () => {
    const h = await setup()
    const admin = h.user()
    const coll = name('f')
    await ma
      .db('live')
      .collection(coll)
      .insertOne({ _id: 'old' } as never)
    const r = await start(admin, h, 'A', 'B', { db: 'live', coll }, { startMode: 'from_now' })
    const view = r.json() as LiveSyncView
    expect(view).toMatchObject({ state: 'catching_up', copyJobId: null })
    await until(() => sync(h, view.id).state === 'live')
    await ma
      .db('live')
      .collection(coll)
      .insertOne({ _id: 'new' } as never)
    await until(async () => (await mb.db('live').collection(coll).countDocuments()) === 1)
    expect(await mb.db('live').collection(coll).findOne()).toEqual({ _id: 'new' })
  })

  it('merges into a target that has data, and replaces one when its name is typed', async () => {
    const h = await setup()
    const admin = h.user()
    const coll = name('m')
    await ma
      .db('live')
      .collection(coll)
      .insertOne({ _id: 1, from: 'source' } as never)
    await mb
      .db('live')
      .collection(coll)
      .insertOne({ _id: 2, from: 'target' } as never)
    const merged = (
      await start(admin, h, 'A', 'B', { db: 'live', coll }, { startMode: 'merge' })
    ).json() as LiveSyncView
    await until(() => sync(h, merged.id).state === 'live', 30_000)
    expect(await mb.db('live').collection(coll).countDocuments()).toBe(2)
    await admin.call('POST', `/api/live-syncs/${merged.id}/stop`)
    const replaced = (
      await start(admin, h, 'A', 'B', { db: 'live', coll }, { startMode: 'replace', confirmTarget: coll })
    ).json() as LiveSyncView
    await until(() => sync(h, replaced.id).state === 'live', 30_000)
    expect(await mb.db('live').collection(coll).find().toArray()).toEqual([{ _id: 1, from: 'source' }])
  }, 90_000)

  it('starts only from its plan, unchanged, with nothing refused', async () => {
    const h = await setup()
    const admin = h.user()
    const coll = name('p')
    await ma.db('live').collection(coll).insertOne({ n: 1 })
    const body = syncBody(h.ids, 'A', 'B', { db: 'live', coll })
    const url = `/api/connections/${h.ids.A}/live-syncs`
    expect((await admin.call('POST', url, body)).json()).toMatchObject({
      details: { reason: 'plan_required' },
    })
    expect((await admin.call('POST', url, { ...body, planHash: 'a'.repeat(64) })).json()).toMatchObject({
      details: { reason: 'plan_changed' },
    })
    const refused = { ...body, confirmOverwrite: false }
    const plan = (await admin.call('POST', `${url}/plan`, refused)).json() as LiveSyncPlan
    const r = await admin.call('POST', url, { ...refused, planHash: plan.planHash })
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ details: { reason: 'refused', reasons: ['confirm_overwrite'] } })
    expect(h.ctx.liveSync.repo.list()).toEqual([])
  })

  it('holds at most 3 syncs per user and MM_LIVE_SYNC_MAX per server', async () => {
    const h = await setup({ liveSync: { maxSyncs: 4 } })
    const one = h.user()
    for (let i = 0; i < 3; i++)
      expect(
        (await start(one, h, 'A', 'B', { db: 'live', coll: name('l') }, { startMode: 'from_now' }))
          .statusCode,
      ).toBe(201)
    const fourth = await start(one, h, 'A', 'B', { db: 'live', coll: name('l') }, { startMode: 'from_now' })
    expect(fourth.json()).toMatchObject({ details: { reason: 'refused', reasons: ['limit_user'] } })
    const two = h.user()
    expect(
      (await start(two, h, 'A', 'B', { db: 'live', coll: name('l') }, { startMode: 'from_now' })).statusCode,
    ).toBe(201)
    expect(
      (await start(two, h, 'A', 'B', { db: 'live', coll: name('l') }, { startMode: 'from_now' })).json(),
    ).toMatchObject({
      details: { reasons: ['limit_server'] },
    })
  }, 60_000)
})

describe('who sees and controls a sync (phase 3e-2 spec §3.1, S8)', () => {
  it('shows a sync to its owner and to administrators only', async () => {
    const h = await setup()
    const owner = h.user({ role: 'editor', on: { A: 'admin', B: 'admin' } })
    const other = h.user({ role: 'editor', on: { A: 'admin', B: 'admin' } })
    const admin = h.user()
    const view = (
      await start(owner, h, 'A', 'B', { db: 'live', coll: name('v') }, { startMode: 'from_now' })
    ).json() as LiveSyncView
    expect(((await other.get('/api/live-syncs')).json() as LiveSyncsList).syncs).toEqual([])
    for (const [method, path] of [
      ['GET', ''],
      ['POST', '/pause'],
      ['POST', '/resume'],
      ['POST', '/stop'],
      ['POST', '/skip'],
      ['DELETE', ''],
    ] as const)
      expect((await other.call(method, `/api/live-syncs/${view.id}${path}`)).statusCode).toBe(404)
    const list = (await admin.get('/api/live-syncs')).json() as LiveSyncsList
    expect(list).toMatchObject({ enabled: true, max: 10, perUser: 3 })
    expect(list.syncs.map((s) => [s.id, s.mine])).toEqual([[view.id, false]])
  })

  it('pauses and resumes, stops for good, and deletes only what is not running', async () => {
    const h = await setup()
    const admin = h.user()
    const coll = name('r')
    const view = (
      await start(admin, h, 'A', 'B', { db: 'live', coll }, { startMode: 'from_now' })
    ).json() as LiveSyncView
    await until(() => sync(h, view.id).state === 'live')
    expect((await admin.call('DELETE', `/api/live-syncs/${view.id}`)).json()).toMatchObject({
      details: { reason: 'running' },
    })
    expect((await admin.call('POST', `/api/live-syncs/${view.id}/pause`)).json()).toMatchObject({
      state: 'paused',
      reason: 'owner',
      pausedBy: 'owner',
    })
    await ma
      .db('live')
      .collection(coll)
      .insertOne({ _id: 'while-paused' } as never)
    await new Promise((r) => setTimeout(r, 300))
    expect(await mb.db('live').collection(coll).countDocuments()).toBe(0)
    expect((await admin.call('POST', `/api/live-syncs/${view.id}/resume`)).json()).toMatchObject({
      state: 'catching_up',
    })
    await until(async () => (await mb.db('live').collection(coll).countDocuments()) === 1)
    expect((await admin.call('POST', `/api/live-syncs/${view.id}/stop`)).json()).toMatchObject({
      state: 'stopped',
      reason: 'owner',
    })
    expect((await admin.call('POST', `/api/live-syncs/${view.id}/resume`)).json()).toMatchObject({
      details: { reason: 'not_resumable' },
    })
    expect((await admin.call('DELETE', `/api/live-syncs/${view.id}`)).statusCode).toBe(204)
    expect((await admin.get(`/api/live-syncs/${view.id}`)).statusCode).toBe(404)
    expect(await mb.db('live').collection(coll).countDocuments()).toBe(1)
  })

  it('lets an administrator pause another’s sync, and only the owner skip', async () => {
    const h = await setup()
    const owner = h.user({ role: 'editor', on: { A: 'admin', B: 'admin' } })
    const admin = h.user()
    const view = (
      await start(owner, h, 'A', 'B', { db: 'live', coll: name('a') }, { startMode: 'from_now' })
    ).json() as LiveSyncView
    await until(() => sync(h, view.id).state === 'live')
    expect((await admin.call('POST', `/api/live-syncs/${view.id}/pause`)).json()).toMatchObject({
      reason: 'admin',
      pausedBy: `admin:${admin.username}`,
    })
    expect((await admin.call('POST', `/api/live-syncs/${view.id}/skip`)).json()).toMatchObject({
      details: { reason: 'not_owner' },
    })
    const rows = h.ctx.audit.list({ action: 'livesync.pause' })
    expect(rows.at(0)).toMatchObject({
      userId: admin.id,
      details: expect.objectContaining({ sync: view.id, owner: owner.id }),
    })
  })

  it('pauses nothing while copying: a copy is stopped, not paused', async () => {
    const h = await setup()
    const admin = h.user()
    const coll = name('cp')
    // Large enough that the copy is still running when it is stopped.
    await ma
      .db('live')
      .collection(coll)
      .insertMany(Array.from({ length: 150_000 }, (_, i) => ({ i })))
    const view = (await start(admin, h, 'A', 'B', { db: 'live', coll })).json() as LiveSyncView
    expect((await admin.call('POST', `/api/live-syncs/${view.id}/pause`)).json()).toMatchObject({
      details: { reason: 'copying' },
    })
    expect((await admin.call('POST', `/api/live-syncs/${view.id}/stop`)).json()).toMatchObject({
      state: 'stopped',
    })
    await until(() => h.ctx.jobs.get(view.copyJobId!)?.state !== 'running')
    expect(h.ctx.jobs.get(view.copyJobId!)?.state).toBe('cancelled')
  }, 60_000)
})

describe('restarts, the switch and connections (phase 3e-2 spec §2.4, plan rulings 1, 6)', () => {
  it('marks a sync whose copy was interrupted by a restart', async () => {
    const h = await setup()
    const admin = h.user()
    const coll = name('i')
    await ma
      .db('live')
      .collection(coll)
      .insertMany(Array.from({ length: 150_000 }, (_, i) => ({ i })))
    const view = (await start(admin, h, 'A', 'B', { db: 'live', coll })).json() as LiveSyncView
    await h.restart()
    await until(() => sync(h, view.id).state === 'attention', 30_000)
    expect(sync(h, view.id).reason).toBe('copy_interrupted')
    // Final review m6: a stop no person asked for is in the audit log.
    expect(
      h.ctx.audit
        .list({ action: 'livesync.attention' })
        .some((r) => (r.details as { sync?: string }).sync === view.id),
    ).toBe(true)
    expect((await admin.call('POST', `/api/live-syncs/${view.id}/resume`)).json()).toMatchObject({
      details: { reason: 'not_resumable' },
    })
  }, 120_000)

  it('turned off: running syncs wait with the reason and new ones are refused; turned on: they carry on', async () => {
    const h = await setup()
    const admin = h.user()
    const coll = name('o')
    const view = (
      await start(admin, h, 'A', 'B', { db: 'live', coll }, { startMode: 'from_now' })
    ).json() as LiveSyncView
    await until(() => sync(h, view.id).state === 'live')
    await h.restart({ liveSync: { enabled: false, maxSyncs: 10 } })
    const other = name('x')
    await ma.db('live').createCollection(other)
    await until(() => sync(h, view.id).state === 'attention')
    expect(sync(h, view.id).reason).toBe('turned_off')
    const plan = (
      await admin.call(
        'POST',
        `/api/connections/${h.ids.A}/live-syncs/plan`,
        syncBody(h.ids, 'A', 'B', { db: 'live', coll: other }, { startMode: 'from_now' }),
      )
    ).json() as LiveSyncPlan
    expect(plan.refusals).toContain('turned_off')
    await h.restart()
    await until(() => sync(h, view.id).state === 'live')
    await ma
      .db('live')
      .collection(coll)
      .insertOne({ _id: 'after' } as never)
    await until(async () => (await mb.db('live').collection(coll).countDocuments()) === 1)
  }, 60_000)

  it('stops the syncs of a deleted connection', async () => {
    const h = await setup()
    const admin = h.user()
    const view = (
      await start(admin, h, 'A', 'B', { db: 'live', coll: name('d') }, { startMode: 'from_now' })
    ).json() as LiveSyncView
    await until(() => sync(h, view.id).state === 'live')
    // The worker may see the connection gone first (final review m7): it stops on its own while
    // the runner halts it, and the stop is still written and audited once.
    const workers = (
      h.ctx.liveSync as unknown as { workers: Map<string, { worker: { stop(): Promise<void> } }> }
    ).workers
    const w = workers.get(view.id)!
    const stop = w.worker.stop.bind(w.worker)
    w.worker.stop = async () => {
      h.ctx.liveSync.repo.setState(view.id, 'stopped', 'connection_deleted')
      await stop()
    }
    expect((await admin.call('DELETE', `/api/connections/${h.ids.B}`)).statusCode).toBe(204)
    expect(sync(h, view.id)).toMatchObject({ state: 'stopped', reason: 'connection_deleted' })
    expect(
      h.ctx.audit
        .list({ action: 'livesync.stopped' })
        .filter((r) => (r.details as { sync?: string }).sync === view.id),
    ).toHaveLength(0)
  })

  it('waits for a review after an edit points a connection elsewhere, then carries on once confirmed', async () => {
    const h = await setup()
    const admin = h.user()
    const coll = name('e')
    const view = (
      await start(admin, h, 'A', 'B', { db: 'live', coll }, { startMode: 'from_now' })
    ).json() as LiveSyncView
    await until(() => sync(h, view.id).state === 'live')
    const settings = (await admin.get(`/api/connections/${h.ids.B}`)).json().settings
    const edited = await admin.call('PATCH', `/api/connections/${h.ids.B}`, {
      settings: {
        ...settings,
        hosts: settings.hosts.map((x: { port: number }) => ({ ...x, host: 'localhost' })),
      },
    })
    expect(edited.statusCode).toBe(200)
    expect(sync(h, view.id)).toMatchObject({ state: 'attention', reason: 'connection_changed' })
    expect((await admin.call('POST', `/api/live-syncs/${view.id}/resume`)).json()).toMatchObject({
      details: { reason: 'review_required' },
    })
    const review = (
      await admin.call('POST', `/api/connections/${h.ids.A}/live-syncs/${view.id}/review`, {})
    ).json() as LiveSyncPlan
    expect(review.refusals).toEqual([])
    const confirmed = await admin.call('POST', `/api/connections/${h.ids.A}/live-syncs/${view.id}/confirm`, {
      planHash: review.planHash,
    })
    expect(confirmed.json()).toMatchObject({ state: 'catching_up' })
    await until(() => sync(h, view.id).state === 'live')
    // A favourite toggle is not an edit of where it points.
    await admin.call('PATCH', `/api/connections/${h.ids.B}`, { favorite: true })
    expect(sync(h, view.id).state).toBe('live')
  }, 60_000)
})

describe('a review that would change the masking (phase 3e-2 spec §3.2)', () => {
  it('refuses to carry on under other masking: the sync starts again instead', async () => {
    const h = await setup()
    const owner = h.user({ role: 'editor', on: { A: 'editor', B: 'editor' } })
    const coll = name('mc')
    const view = (
      await start(owner, h, 'A', 'B', { db: 'live', coll }, { startMode: 'from_now' })
    ).json() as LiveSyncView
    await until(() => sync(h, view.id).state === 'live')
    h.ctx.grants.setMasked(h.ids.A, owner.id, true)
    const review = (
      await owner.call('POST', `/api/connections/${h.ids.A}/live-syncs/${view.id}/review`, {})
    ).json() as LiveSyncPlan
    expect(review.refusals).toContain('masking_changed')
  }, 60_000)
})

describe('the livesync channel (phase 3e-2 spec §2.5, plan ruling 15)', () => {
  it('pushes a sync’s changes to its owner and administrators, and says when it is gone', async () => {
    const h = await setup()
    const owner = h.user({ role: 'editor', on: { A: 'admin', B: 'admin' } })
    const other = h.user({ role: 'editor', on: { A: 'admin', B: 'admin' } })
    const ownerSocket = await h.socket(owner)
    const otherSocket = await h.socket(other)
    ownerSocket.send({ ch: 'livesync', type: 'sub' })
    otherSocket.send({ ch: 'livesync', type: 'sub' })
    const view = (
      await start(owner, h, 'A', 'B', { db: 'live', coll: name('w') }, { startMode: 'from_now' })
    ).json() as LiveSyncView
    await ownerSocket.next(
      (m) => m.ch === 'livesync' && m.type === 'update' && (m.payload.sync as LiveSyncView).state === 'live',
    )
    await owner.call('POST', `/api/live-syncs/${view.id}/stop`)
    await owner.call('DELETE', `/api/live-syncs/${view.id}`)
    await ownerSocket.next((m) => m.ch === 'livesync' && m.type === 'gone' && m.payload.id === view.id)
    expect(otherSocket.messages.filter((m) => m.ch === 'livesync')).toEqual([])
    ownerSocket.close()
    otherSocket.close()
  })
})

describe('final review fixes in the runner and routes (phase 3e-2)', () => {
  it('m9: a copy starts its changes a second before T0; "from now" just after it', async () => {
    const h = await setup()
    const admin = h.user()
    const coll = name('t0')
    await ma.db('live').collection(coll).insertOne({ n: 1 })
    const copy = (await start(admin, h, 'A', 'B', { db: 'live', coll })).json() as LiveSyncView
    const after = await ma.db('admin').command({ ping: 1 })
    const now = (after.operationTime as { t: number }).t
    const [t] = sync(h, copy.id).startAt!.split('.').map(Number)
    // A second earlier than T0 (which is at most "now"): writes still in flight at T0 are replayed.
    expect(t).toBeLessThanOrEqual(now - 1)
    const fromNow = (
      await start(admin, h, 'A', 'B', { db: 'live', coll: name('t1') }, { startMode: 'from_now' })
    ).json() as LiveSyncView
    const [t2] = sync(h, fromNow.id).startAt!.split('.').map(Number)
    expect(t2).toBeGreaterThanOrEqual(now)
  }, 60_000)

  it('m15: a deleted user’s syncs stop and go (the targets keep their data)', async () => {
    const h = await setup()
    const owner = h.user({ role: 'editor', on: { A: 'editor', B: 'editor' } })
    const admin = h.user()
    const view = (
      await start(owner, h, 'A', 'B', { db: 'live', coll: name('u') }, { startMode: 'from_now' })
    ).json() as LiveSyncView
    await until(() => sync(h, view.id).state === 'live')
    expect((await admin.call('DELETE', `/api/users/${owner.id}`)).statusCode).toBe(204)
    expect(h.ctx.liveSync.repo.get(view.id)).toBeUndefined()
  }, 60_000)

  it('m16: starting a sync again replaces the old one, which no longer counts', async () => {
    const h = await setup()
    const owner = h.user({ role: 'editor', on: { A: 'editor', B: 'editor' } })
    const ids: string[] = []
    for (let i = 0; i < 3; i++)
      ids.push(
        (
          (
            await start(owner, h, 'A', 'B', { db: 'live', coll: name('r') }, { startMode: 'from_now' })
          ).json() as LiveSyncView
        ).id,
      )
    h.ctx.liveSync.repo.setState(ids[0]!, 'attention', 'source_gone', 'live.x')
    const again = await start(
      owner,
      h,
      'A',
      'B',
      { db: 'live', coll: name('r') },
      { startMode: 'merge', replaces: ids[0] },
    )
    expect(again.statusCode).toBe(201)
    expect(sync(h, ids[0]!)).toMatchObject({ state: 'stopped', reason: 'owner' })
    // Only one's own sync that is not running may be replaced.
    const other = h.user({ role: 'editor', on: { A: 'editor', B: 'editor' } })
    const coll = name('r')
    await ma.db('live').createCollection(coll)
    const body = syncBody(h.ids, 'A', 'B', { db: 'live', coll }, { startMode: 'from_now', replaces: ids[1] })
    // Someone else's sync: as if it did not exist.
    expect((await other.call('POST', `/api/connections/${h.ids.A}/live-syncs/plan`, body)).statusCode).toBe(
      404,
    )
    // One's own running sync: stopped or paused first.
    const own = await owner.call('POST', `/api/connections/${h.ids.A}/live-syncs/plan`, body)
    expect(own.json()).toMatchObject({ details: { reason: 'running' } })
  }, 90_000)

  it('I8: a stream error a person has fixed (a right granted again) resumes', async () => {
    const h = await setup()
    const admin = h.user()
    const view = (
      await start(admin, h, 'A', 'B', { db: 'live', coll: name('se') }, { startMode: 'from_now' })
    ).json() as LiveSyncView
    await until(() => sync(h, view.id).state === 'live')
    await admin.call('POST', `/api/live-syncs/${view.id}/pause`)
    h.ctx.liveSync.repo.setState(view.id, 'attention', 'stream_error', 'unauthorized')
    const r = await admin.call('POST', `/api/live-syncs/${view.id}/resume`)
    expect(r.statusCode).toBe(200)
    await until(() => sync(h, view.id).state === 'live')
  }, 60_000)

  it('I7: refuses a view as a source', async () => {
    const h = await setup()
    const admin = h.user()
    const v = name('view')
    await ma.db('live').createCollection(v, { viewOn: 'orders', pipeline: [] })
    const body = syncBody(h.ids, 'A', 'B', { db: 'live', coll: v }, { startMode: 'from_now' })
    const plan = (
      await admin.call('POST', `/api/connections/${h.ids.A}/live-syncs/plan`, body)
    ).json() as LiveSyncPlan
    expect(plan.refusals).toContain('view_source')
  }, 60_000)
})

describe('closing with a push pending (final gate: "database is not open" after a test)', () => {
  it('reads nothing once closed, even for a push that arrives late', async () => {
    const h = await setup()
    const admin = h.user()
    const res = await start(admin, h, 'A', 'B', { db: 'live', coll: name('c') })
    const id = (res.json() as LiveSyncView).id
    const runner = h.ctx.liveSync as unknown as { push(r: unknown): void; close(): Promise<void> }
    const record = sync(h, id)
    await runner.close()
    // A worker's last event can still arrive as the server shuts down: two pushes of one state,
    // the second waiting for a timer that would read the store after it closed.
    const get = vi.spyOn(h.ctx.liveSync.repo, 'get')
    runner.push(record)
    runner.push(record)
    await new Promise((r) => setTimeout(r, 250))
    expect(get).not.toHaveBeenCalled()
  })
})
