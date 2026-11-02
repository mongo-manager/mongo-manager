import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { LiveSyncDetail, LiveSyncPlan, LiveSyncsList, LiveSyncView } from '@mongo-manager/shared'
import { createSecretBox } from '../src/crypto/secret-box'
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
type User = ReturnType<LiveSyncHarness['user']>

async function harness() {
  const h = await liveSyncHarness(a.getUri(), b.getUri(), undefined, {}, timing as never)
  harnesses.push(h)
  return h
}
const plan = async (h: LiveSyncHarness, u: User, from: Conn, body: Record<string, unknown>) => {
  const r = await u.call('POST', `/api/connections/${h.ids[from]}/live-syncs/plan`, body)
  const json = r.json() as LiveSyncPlan & { details?: { reason?: string } }
  return { status: r.statusCode, body: { ...json, reason: json.details?.reason } }
}
async function start(
  h: LiveSyncHarness,
  u: User,
  from: Conn,
  to: Conn,
  ns: Parameters<typeof syncBody>[3],
  extra: Record<string, unknown> = {},
) {
  // A collection sync needs its source collection (Task 5 ruling).
  if (ns.coll)
    await ma
      .db(ns.db)
      .createCollection(ns.coll)
      .catch(() => undefined)
  const body = syncBody(h.ids, from, to, ns, extra)
  const p = await plan(h, u, from, body)
  expect(p.body.refusals).toEqual([])
  const r = await u.call('POST', `/api/connections/${h.ids[from]}/live-syncs`, {
    ...body,
    planHash: p.body.planHash,
  })
  expect(r.statusCode).toBe(201)
  const id = (r.json() as LiveSyncView).id
  await until(() => h.ctx.liveSync.repo.get(id)!.state === 'live', 30_000)
  return id
}
const state = (h: LiveSyncHarness, id: string) => h.ctx.liveSync.repo.get(id)!
const quiet = () => new Promise((r) => setTimeout(r, 400))

describe('S1 reading or writing what one may not', () => {
  it('refuses MongoDB’s own namespaces as a source or a target', async () => {
    const h = await harness()
    const admin = h.user()
    for (const ns of [
      { db: 'admin', coll: 'system.users', targetDb: 'copy', targetColl: 'users' },
      { db: 'local', coll: 'oplog.rs', targetDb: 'copy', targetColl: 'oplog' },
      { db: 'live', coll: 'x', targetDb: 'config', targetColl: 'x' },
      { db: 'live', coll: 'x', targetDb: 'live', targetColl: 'system.js' },
    ]) {
      const r = await plan(h, admin, 'A', syncBody(h.ids, 'A', 'B', ns))
      expect(r.status).toBe(403)
      expect(r.body.reason).toBe('system_namespace')
    }
  })

  it('hides a connection the user cannot see, and refuses one they may only read', async () => {
    const h = await harness()
    const coll = name('s1')
    await ma.db('live').collection(coll).insertOne({ n: 1 })
    const hidden = h.user({ role: 'editor', on: { A: 'admin', B: 'none' } })
    expect((await plan(h, hidden, 'A', syncBody(h.ids, 'A', 'B', { db: 'live', coll }))).status).toBe(404)
    const reader = h.user({ role: 'editor', on: { A: 'admin', B: 'viewer' } })
    expect((await plan(h, reader, 'A', syncBody(h.ids, 'A', 'B', { db: 'live', coll }))).status).toBe(403)
    const noExport = h.user({ role: 'viewer', on: { A: 'viewer', B: 'admin' } })
    expect((await plan(h, noExport, 'A', syncBody(h.ids, 'A', 'B', { db: 'live', coll }))).status).toBe(403)
  })
})

describe('S2 rights lost while running', () => {
  it('stops before the next batch when the owner loses the target, and writes nothing more', async () => {
    const h = await harness()
    const owner = h.user({ role: 'editor', on: { A: 'editor', B: 'editor' } })
    const coll = name('s2')
    const id = await start(h, owner, 'A', 'B', { db: 'live', coll }, { startMode: 'from_now' })
    h.ctx.grants.set(h.ids.B, owner.id, 'viewer')
    await ma
      .db('live')
      .collection(coll)
      .insertOne({ _id: 'after' } as never)
    await until(() => state(h, id).state === 'attention')
    expect(state(h, id)).toMatchObject({ reason: 'owner_access', detail: 'target' })
    await quiet()
    expect(await mb.db('live').collection(coll).countDocuments()).toBe(0)
  })

  it('stops for a disabled account, and keeps running for one that only signed out', async () => {
    const h = await harness()
    const owner = h.user({ role: 'editor', on: { A: 'editor', B: 'editor' } })
    const coll = name('s2b')
    const id = await start(h, owner, 'A', 'B', { db: 'live', coll }, { startMode: 'from_now' })
    h.ctx.sessions.revokeAllForUser(owner.id)
    await ma
      .db('live')
      .collection(coll)
      .insertOne({ _id: 1 } as never)
    await until(async () => (await mb.db('live').collection(coll).countDocuments()) === 1)
    expect(state(h, id).state).toBe('live')
    h.ctx.users.setDisabled(owner.id, true)
    await ma
      .db('live')
      .collection(coll)
      .insertOne({ _id: 2 } as never)
    await until(() => state(h, id).state === 'attention')
    expect(state(h, id)).toMatchObject({ reason: 'owner_access', detail: 'account' })
    expect(await mb.db('live').collection(coll).countDocuments()).toBe(1)
  })
})

describe('S3 personal data', () => {
  it('masks every change of a restricted owner’s sync, and of an anonymous one', async () => {
    const h = await harness()
    for (const [who, extra] of [
      ['restricted', {}],
      ['anonymous', { anonymous: true }],
    ] as const) {
      const coll = name('s3')
      h.rules('A', [{ db: 'live', coll, field: 'email' }])
      const u =
        who === 'restricted'
          ? h.user({ role: 'editor', on: { A: 'editor', B: 'admin' }, masked: ['A'] })
          : h.user()
      const id = await start(h, u, 'A', 'B', { db: 'live', coll }, { startMode: 'from_now', ...extra })
      expect(state(h, id).options.masked).toBe(true)
      await ma
        .db('live')
        .collection(coll)
        .insertOne({ _id: 1, email: 'a@x', n: 1 } as never)
      await ma
        .db('live')
        .collection(coll)
        .updateOne({ _id: 1 } as never, { $set: { email: 'b@x' } })
      await until(
        async () =>
          (await mb
            .db('live')
            .collection(coll)
            .findOne({ _id: 1 } as never)) !== null,
      )
      await quiet()
      expect(
        await mb
          .db('live')
          .collection(coll)
          .findOne({ _id: 1 } as never),
      ).toEqual({ _id: 1, email: '***', n: 1 })
    }
  })

  it('stops when the rules change on either side, before writing under the new rules', async () => {
    const h = await harness()
    const admin = h.user()
    const coll = name('s3r')
    const id = await start(h, admin, 'A', 'B', { db: 'live', coll }, { startMode: 'from_now' })
    h.rules('A', [{ db: 'live', coll, field: 'ssn' }])
    await ma
      .db('live')
      .collection(coll)
      .insertOne({ _id: 1, ssn: '123' } as never)
    await until(() => state(h, id).state === 'attention')
    expect(state(h, id).reason).toBe('rules_changed')
    await quiet()
    expect(await mb.db('live').collection(coll).countDocuments()).toBe(0)
    expect((await admin.call('POST', `/api/live-syncs/${id}/resume`)).json()).toMatchObject({
      details: { reason: 'review_required' },
    })
  })

  it('stops when the owner becomes restricted on a ruled target', async () => {
    const h = await harness()
    const owner = h.user({ role: 'editor', on: { A: 'editor', B: 'editor' } })
    const coll = name('s3t')
    h.rules('B', [{ db: 'live', coll, field: 'secret' }])
    const id = await start(h, owner, 'A', 'B', { db: 'live', coll }, { startMode: 'from_now' })
    // A whole-document write cannot respect a restricted user's rules field by field (spec §3.2).
    h.ctx.grants.setMasked(h.ids.B, owner.id, true)
    await ma
      .db('live')
      .collection(coll)
      .insertOne({ _id: 1, secret: 'x' } as never)
    await until(() => state(h, id).state === 'attention')
    expect(state(h, id)).toMatchObject({ reason: 'owner_access', detail: 'personal_target' })
    await quiet()
    expect(await mb.db('live').collection(coll).countDocuments()).toBe(0)
  })

  it('shows an owner restricted on the target the error code, never MongoDB’s text', async () => {
    const h = await harness()
    const coll = name('s3e')
    await mb.db('live').collection(coll).createIndex({ n: 1 }, { unique: true })
    await mb
      .db('live')
      .collection(coll)
      .insertOne({ _id: 'there', n: 1 } as never)
    // Restricted on B, which has no rules: allowed to sync there (spec §3.2), but MongoDB's words
    // can quote a value, so only the code is kept (spec §3.3).
    const owner = h.user({ role: 'editor', on: { A: 'editor', B: 'editor' }, masked: ['B'] })
    const id = await start(h, owner, 'A', 'B', { db: 'live', coll }, { startMode: 'from_now' })
    await ma
      .db('live')
      .collection(coll)
      .insertOne({ _id: 'clash', n: 1 } as never)
    await until(() => state(h, id).state === 'attention')
    const r = state(h, id)
    expect(r.reason).toBe('write_error')
    expect(r.detail).toMatch(/code 11000$/)
    expect(r.detail).not.toMatch(/E11000|dup key|there/)
    const events = JSON.stringify(h.ctx.liveSync.repo.events(id))
    expect(events).not.toMatch(/E11000|dup key/)
  })

  it('keeps MongoDB’s words out of the audit log, even for an owner who may read them', async () => {
    const h = await harness()
    const coll = name('s3a')
    await mb.db('live').collection(coll).createIndex({ n: 1 }, { unique: true })
    await mb
      .db('live')
      .collection(coll)
      .insertOne({ _id: 'there', n: 'secret@x' } as never)
    const id = await start(h, h.user(), 'A', 'B', { db: 'live', coll }, { startMode: 'from_now' })
    await ma
      .db('live')
      .collection(coll)
      .insertOne({ _id: 'clash', n: 'secret@x' } as never)
    await until(() => state(h, id).state === 'attention')
    // The owner sees MongoDB's words on the card; the audit log (kept far longer) keeps the code.
    expect(state(h, id).detail).toMatch(/dup key/)
    const row = h.ctx.audit
      .list({ action: 'livesync.attention' })
      .find((r) => (r.details as { sync?: string }).sync === id)
    expect(row?.details).toMatchObject({ reason: 'write_error', code: '11000' })
    expect(JSON.stringify(row)).not.toMatch(/secret@x|dup key/)
  })
})

describe('S4 destroying data', () => {
  it('never deletes a target document the source did not delete', async () => {
    const h = await harness()
    const admin = h.user()
    const coll = name('s4')
    await ma
      .db('live')
      .collection(coll)
      .insertOne({ _id: 1 } as never)
    const id = await start(h, admin, 'A', 'B', { db: 'live', coll })
    await mb
      .db('live')
      .collection(coll)
      .insertOne({ _id: 'only-on-target' } as never)
    await ma
      .db('live')
      .collection(coll)
      .deleteOne({ _id: 1 } as never)
    await ma
      .db('live')
      .collection(coll)
      .insertOne({ _id: 2 } as never)
    // The batch is written unordered (one change per _id, spec §1.7): wait for all of it — the
    // counters are saved once the whole batch is written.
    await until(
      async () =>
        state(h, id).counters.deleted >= 1 &&
        (await mb
          .db('live')
          .collection(coll)
          .findOne({ _id: 2 } as never)) !== null,
    )
    expect(
      (
        await mb
          .db('live')
          .collection(coll)
          .find({}, { sort: { _id: 1 } })
          .toArray()
      ).map((d) => d._id),
    ).toEqual([2, 'only-on-target'])
    expect(state(h, id).state).toBe('live')
  })

  it('needs an empty target to copy first, and the typed name to replace it', async () => {
    const h = await harness()
    const admin = h.user()
    const coll = name('s4t')
    await ma.db('live').collection(coll).insertOne({ n: 1 })
    await mb.db('live').collection(coll).insertOne({ keep: true })
    const body = syncBody(h.ids, 'A', 'B', { db: 'live', coll })
    expect((await plan(h, admin, 'A', body)).body.refusals).toContain('target_not_empty')
    expect(
      (await plan(h, admin, 'A', { ...body, startMode: 'replace', confirmTarget: 'wrong' })).body.refusals,
    ).toContain('confirm_target')
    expect(await mb.db('live').collection(coll).countDocuments({ keep: true })).toBe(1)
  })
})

describe('S5 loops and self-sync', () => {
  it('refuses the way back, a chain that closes a loop, and the source itself under another name', async () => {
    const h = await harness()
    const admin = h.user()
    const coll = name('s5')
    await ma.db('live').collection(coll).insertOne({ n: 1 })
    await start(h, admin, 'A', 'B', { db: 'live', coll })
    expect(
      (await plan(h, admin, 'B', syncBody(h.ids, 'B', 'A', { db: 'live', coll }, { startMode: 'from_now' })))
        .body.refusals,
    ).toContain('loop')
    // B → A2 is B → A under another name.
    expect(
      (await plan(h, admin, 'B', syncBody(h.ids, 'B', 'A2', { db: 'live', coll }, { startMode: 'from_now' })))
        .body.refusals,
    ).toContain('loop')
    // A database sync back onto the collection's database closes it too.
    expect(
      (await plan(h, admin, 'B', syncBody(h.ids, 'B', 'A', { db: 'live' }, { startMode: 'from_now' }))).body
        .refusals,
    ).toContain('loop')
    expect(
      (await plan(h, admin, 'A', syncBody(h.ids, 'A', 'A2', { db: 'live', coll }, { startMode: 'from_now' })))
        .body.refusals,
    ).toEqual(expect.arrayContaining([expect.stringMatching(/^same_namespace/)]))
  })
})

describe('S6 resource abuse', () => {
  it('lets go of both connections when a sync stops', async () => {
    const h = await harness()
    const admin = h.user()
    let held = 0
    const hold = h.ctx.manager.hold.bind(h.ctx.manager)
    h.ctx.manager.hold = (id: string) => {
      held++
      const release = hold(id)
      let once = false
      return () => {
        if (once) return
        once = true
        held--
        release()
      }
    }
    const id = await start(h, admin, 'A', 'B', { db: 'live', coll: name('s6') }, { startMode: 'from_now' })
    expect(held).toBe(2)
    await admin.call('POST', `/api/live-syncs/${id}/pause`)
    expect(held).toBe(0)
    await admin.call('POST', `/api/live-syncs/${id}/resume`)
    await until(() => held === 2)
    await admin.call('POST', `/api/live-syncs/${id}/stop`)
    expect(held).toBe(0)
  })
})

describe('S7 token secrecy', () => {
  it('never sends a place or a token, in the list, the detail, the socket or the audit log', async () => {
    const h = await harness()
    const admin = h.user()
    const coll = name('s7')
    const socket = await h.socket(admin)
    socket.send({ ch: 'livesync', type: 'sub' })
    const id = await start(h, admin, 'A', 'B', { db: 'live', coll }, { startMode: 'from_now' })
    await ma
      .db('live')
      .collection(coll)
      .insertOne({ _id: 1 } as never)
    await until(async () => (await mb.db('live').collection(coll).countDocuments()) === 1)
    const list = (await admin.get('/api/live-syncs')).json() as LiveSyncsList
    const detail = (await admin.get(`/api/live-syncs/${id}`)).json() as LiveSyncDetail
    const audit = h.ctx.audit.list({ limit: 100 })
    for (const text of [
      JSON.stringify(list),
      JSON.stringify(detail),
      JSON.stringify(socket.messages),
      JSON.stringify(audit),
    ])
      expect(text).not.toMatch(/_data|resumeToken|"place"/)
    socket.close()
  })

  it('cannot open a place with another secret key', async () => {
    const h = await harness()
    const admin = h.user()
    const id = await start(h, admin, 'A', 'B', { db: 'live', coll: name('s7k') }, { startMode: 'from_now' })
    const sealed = (
      h.ctx.store.db.prepare('SELECT place FROM live_syncs WHERE id = ?').get(id) as { place: string }
    ).place
    expect(sealed).toBeTruthy()
    expect(() => createSecretBox(randomBytes(32)).open(sealed, `live-sync:${id}`)).toThrow()
  })
})

describe('S8 cross-user control', () => {
  it('lets only the owner finish, confirm, review, skip and apply options; others do not find the sync', async () => {
    const h = await harness()
    const owner = h.user({ role: 'editor', on: { A: 'editor', B: 'editor' } })
    const admin = h.user()
    const other = h.user({ role: 'editor', on: { A: 'editor', B: 'editor' } })
    const id = await start(h, owner, 'A', 'B', { db: 'live', coll: name('s8') }, { startMode: 'from_now' })
    const calls: Array<[string, unknown]> = [
      [`/api/live-syncs/${id}/finish`, { verify: false }],
      [`/api/live-syncs/${id}/skip`, undefined],
      [`/api/live-syncs/${id}/apply-schema`, { ignore: true }],
      [`/api/connections/${h.ids.A}/live-syncs/${id}/review`, {}],
      [`/api/connections/${h.ids.A}/live-syncs/${id}/confirm`, { planHash: 'a'.repeat(64) }],
    ]
    for (const [url, body] of calls) {
      expect((await admin.call('POST', url, body)).json()).toMatchObject({ details: { reason: 'not_owner' } })
      expect((await other.call('POST', url, body)).statusCode).toBe(404)
    }
    expect(state(h, id).state).toBe('live')
  })
})

describe('S9 a connection changed under a sync', () => {
  it('refuses to carry on when the edited target now points at the source itself', async () => {
    const h = await harness()
    const admin = h.user()
    const coll = name('s9')
    const id = await start(h, admin, 'A', 'B', { db: 'live', coll }, { startMode: 'from_now' })
    const a0 = (await admin.get(`/api/connections/${h.ids.A}`)).json().settings
    const b0 = (await admin.get(`/api/connections/${h.ids.B}`)).json().settings
    expect(
      (
        await admin.call('PATCH', `/api/connections/${h.ids.B}`, {
          settings: { ...b0, hosts: a0.hosts, replicaSet: a0.replicaSet },
        })
      ).statusCode,
    ).toBe(200)
    expect(state(h, id)).toMatchObject({ state: 'attention', reason: 'connection_changed' })
    const review = (
      await admin.call('POST', `/api/connections/${h.ids.A}/live-syncs/${id}/review`, {})
    ).json() as LiveSyncPlan
    expect(review.refusals).toEqual(expect.arrayContaining([expect.stringMatching(/^same_namespace|^loop$/)]))
    // Final review I10: the target is another server now; the sync starts again instead.
    expect(review.refusals).toContain('deployment_changed')
    const confirm = await admin.call('POST', `/api/connections/${h.ids.A}/live-syncs/${id}/confirm`, {
      planHash: review.planHash,
    })
    expect(confirm.json()).toMatchObject({ details: { reason: 'refused' } })
    expect(state(h, id).state).toBe('attention')
  })
})

describe('S10 audit', () => {
  it('records every create, control action and automatic stop, with both sides', async () => {
    const h = await harness()
    const admin = h.user()
    const coll = name('s10')
    const id = await start(h, admin, 'A', 'B', { db: 'live', coll }, { startMode: 'from_now' })
    for (const path of ['pause', 'resume', 'verify'])
      await admin.call('POST', `/api/live-syncs/${id}/${path}`)
    await until(() => state(h, id).verify?.state === 'done')
    h.rules('B', [{ db: 'live', coll, field: 'x' }])
    await ma
      .db('live')
      .collection(coll)
      .insertOne({ _id: 1 } as never)
    await until(() => state(h, id).state === 'attention')
    await admin.call('POST', `/api/live-syncs/${id}/stop`)
    await admin.call('DELETE', `/api/live-syncs/${id}`)
    const rows = h.ctx.audit.list({ limit: 200 }).filter((r) => r.action.startsWith('livesync.'))
    const actions = rows.map((r) => r.action)
    for (const action of [
      'livesync.create',
      'livesync.pause',
      'livesync.resume',
      'livesync.verify',
      'livesync.attention',
      'livesync.stop',
      'livesync.delete',
    ])
      expect(actions).toContain(action)
    for (const r of rows) expect(r.details).toMatchObject({ sync: id, target: h.ids.B })
    expect(rows.find((r) => r.action === 'livesync.attention')).toMatchObject({
      userId: null,
      details: expect.objectContaining({ reason: 'rules_changed' }),
    })
  })
})

describe('I5: an administrator’s pause is an administrator’s to lift', () => {
  it('refuses the owner’s resume of a sync an administrator paused', async () => {
    const h = await harness()
    const owner = h.user({ role: 'editor', on: { A: 'editor', B: 'editor' } })
    const admin = h.user()
    const id = await start(h, owner, 'A', 'B', { db: 'live', coll: name('i5') }, { startMode: 'from_now' })
    await admin.call('POST', `/api/live-syncs/${id}/pause`)
    const r = await owner.call('POST', `/api/live-syncs/${id}/resume`)
    expect(r.statusCode).toBe(403)
    expect(r.json()).toMatchObject({ details: { reason: 'paused_by_admin' } })
    expect((await admin.call('POST', `/api/live-syncs/${id}/resume`)).statusCode).toBe(200)
  })
})
