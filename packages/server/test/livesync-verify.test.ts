// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { LiveSyncPlan, LiveSyncView } from '@mongo-manager/shared'
import { liveSyncHarness, syncBody, until, type LiveSyncHarness } from './support/livesync'
import { verifySync } from '../src/livesync/verify'
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

async function live(extra: Record<string, unknown> = {}, seed = 0, personal?: string) {
  const h = await liveSyncHarness(a.getUri(), b.getUri(), undefined, {}, timing as never)
  harnesses.push(h)
  const admin = h.user()
  const coll = name('v')
  await ma.db('live').createCollection(coll)
  if (personal) h.ctx.personalFields.set(h.ids.A, [{ db: 'live', coll, field: personal }])
  if (seed)
    await ma
      .db('live')
      .collection(coll)
      .insertMany(Array.from({ length: seed }, (_, i) => ({ _id: i, n: i })) as never[])
  const body = syncBody(h.ids, 'A', 'B', { db: 'live', coll }, extra)
  const plan = (
    await admin.call('POST', `/api/connections/${h.ids.A}/live-syncs/plan`, body)
  ).json() as LiveSyncPlan
  const view = (
    await admin.call('POST', `/api/connections/${h.ids.A}/live-syncs`, { ...body, planHash: plan.planHash })
  ).json() as LiveSyncView
  const get = () => h.ctx.liveSync.repo.get(view.id)!
  // Caught up, not only live: a copy's changes start a second before T0 and replay what the copy
  // already wrote (final review m9); the tests write behind the sync once that is done.
  await until(() => get().state === 'live' && get().counters.caughtUpAt !== null, 30_000)
  return {
    h,
    admin,
    coll,
    id: view.id,
    get,
    source: ma.db('live').collection(coll),
    target: mb.db('live').collection(coll),
  }
}

describe('verify (phase 3e-2 spec §1.5, plan ruling 8)', () => {
  it('reports the target equal to the source', async () => {
    const s = await live({}, 500)
    expect((await s.admin.call('POST', `/api/live-syncs/${s.id}/verify`)).json()).toMatchObject({
      verify: { state: 'running' },
    })
    await until(() => s.get().verify?.state === 'done', 30_000)
    expect(s.get().verify!.pairs).toEqual([
      {
        source: s.coll,
        target: s.coll,
        same: 500,
        different: 0,
        onlySource: 0,
        onlyTarget: 0,
        unsettled: 0,
        ids: [],
      },
    ])
    expect(s.h.ctx.liveSync.repo.events(s.id).some((e) => e.kind === 'verify')).toBe(true)
  })

  it('settles what changed while it compared: only what is still different counts', async () => {
    const s = await live({}, 2000)
    // The target falls behind on 100 documents while the join reads them; the sync catches up
    // before they are read again (the settling hook resumes it and waits).
    await s.admin.call('POST', `/api/live-syncs/${s.id}/pause`)
    for (let i = 0; i < 100; i++) await s.source.updateOne({ _id: i } as never, { $inc: { n: 1 } })
    let settling = 0
    const result = await verifySync(
      {
        ctx: s.h.ctx,
        settled: async () => {
          settling++
          const at = Date.now()
          await s.admin.call('POST', `/api/live-syncs/${s.id}/resume`)
          await until(() => (s.get().counters.caughtUpAt ?? 0) > at, 30_000)
          return true
        },
      },
      s.get(),
      new AbortController().signal,
      true,
    )
    expect(settling).toBe(1)
    expect(result).toMatchObject({ state: 'done' })
    expect(result.pairs[0]).toMatchObject({
      same: 2000,
      different: 0,
      onlySource: 0,
      onlyTarget: 0,
      unsettled: 0,
    })
  }, 90_000)

  it('says what differs when someone writes to the target behind the sync', async () => {
    const s = await live({}, 10)
    await s.target.updateOne({ _id: 3 } as never, { $set: { n: -1 } })
    await s.target.insertOne({ _id: 'stray' } as never)
    await s.target.deleteOne({ _id: 7 } as never)
    await s.admin.call('POST', `/api/live-syncs/${s.id}/verify`)
    await until(() => s.get().verify?.state === 'done', 30_000)
    expect(s.get().verify!.pairs[0]).toMatchObject({
      same: 8,
      different: 1,
      onlySource: 1,
      onlyTarget: 1,
      ids: [{ $numberInt: '3' }, { $numberInt: '7' }, 'stray'],
    })
  })

  it('compares the masked source for a masked sync', async () => {
    const h0 = await liveSyncHarness(a.getUri(), b.getUri(), undefined, {}, timing as never)
    harnesses.push(h0)
    const coll = name('mv')
    await ma
      .db('live')
      .collection(coll)
      .insertMany([
        { _id: 1, email: 'a@x' },
        { _id: 2, email: 'b@x' },
      ] as never[])
    h0.rules('A', [{ db: 'live', coll, field: 'email' }])
    // Restricted on the source (an editor with the masked grant; admins are never restricted).
    const editor = h0.user({ role: 'editor', on: { A: 'editor', B: 'admin' }, masked: ['A'] })
    const body = syncBody(h0.ids, 'A', 'B', { db: 'live', coll })
    const plan = (
      await editor.call('POST', `/api/connections/${h0.ids.A}/live-syncs/plan`, body)
    ).json() as LiveSyncPlan
    expect(plan.masked).toBe(true)
    const view = (
      await editor.call('POST', `/api/connections/${h0.ids.A}/live-syncs`, {
        ...body,
        planHash: plan.planHash,
      })
    ).json() as LiveSyncView
    await until(() => h0.ctx.liveSync.repo.get(view.id)!.state === 'live', 30_000)
    expect(
      await mb
        .db('live')
        .collection(coll)
        .find({}, { sort: { _id: 1 } })
        .toArray(),
    ).toEqual([
      { _id: 1, email: '***' },
      { _id: 2, email: '***' },
    ])
    await editor.call('POST', `/api/live-syncs/${view.id}/verify`)
    await until(() => h0.ctx.liveSync.repo.get(view.id)!.verify?.state === 'done', 30_000)
    expect(h0.ctx.liveSync.repo.get(view.id)!.verify!.pairs[0]).toMatchObject({ same: 2, different: 0 })
  }, 60_000)

  it('ends a verification a restart cut, and verifies again afterwards', async () => {
    const s = await live({}, 20_000)
    await s.admin.call('POST', `/api/live-syncs/${s.id}/verify`)
    await s.h.restart()
    expect(s.get().verify).toMatchObject({ state: 'failed', error: 'aborted' })
    expect((await s.admin.call('POST', `/api/live-syncs/${s.id}/verify`)).statusCode).toBe(200)
    await until(() => s.get().verify?.state === 'done', 60_000)
  }, 120_000)

  it('runs one verify per sync at a time', async () => {
    const s = await live({}, 20_000)
    await s.admin.call('POST', `/api/live-syncs/${s.id}/verify`)
    expect((await s.admin.call('POST', `/api/live-syncs/${s.id}/verify`)).json()).toMatchObject({
      details: { reason: 'verify_running' },
    })
  }, 90_000)
})

describe('finish (phase 3e-2 spec §1.6, Review Focus 5)', () => {
  it('applies everything up to the moment it was asked, verifies, and ends completed', async () => {
    const s = await live({}, 100)
    let i = 1000
    let writing = true
    const writer = (async () => {
      while (writing) await s.source.insertOne({ _id: i++, n: 0 } as never)
    })()
    await new Promise((r) => setTimeout(r, 300))
    const finished = await s.admin.call('POST', `/api/live-syncs/${s.id}/finish`, { verify: true })
    expect(finished.json()).toMatchObject({ state: 'cutting_over' })
    const t1 = s.get().finish!.t1
    await until(() => s.get().state === 'completed', 60_000)
    writing = false
    await writer
    expect(t1).toMatch(/^\d+\.\d+$/)
    expect(s.get().finishedAt).toEqual(expect.any(Number))
    // Writes went on after T1: the target holds a prefix of the source, unchanged, and verify says
    // honestly what it lacks (only inserts happened, so nothing differs and nothing is extra).
    expect(await s.target.countDocuments()).toBeGreaterThan(100)
    expect(s.get().verify).toMatchObject({ state: 'done' })
    expect(s.get().verify!.pairs[0]).toMatchObject({ different: 0, onlyTarget: 0 })
    expect(s.get().verify!.pairs[0]!.onlySource).toBeGreaterThan(0)
    // Nothing is applied after completion.
    await s.source.insertOne({ _id: 'late' } as never)
    await new Promise((r) => setTimeout(r, 300))
    expect(await s.target.findOne({ _id: 'late' } as never)).toBeNull()
  }, 120_000)

  it('finishes only a live sync, and only for its owner', async () => {
    const s = await live({}, 1)
    const admin2 = s.h.user()
    expect(
      (await admin2.call('POST', `/api/live-syncs/${s.id}/finish`, { verify: false })).json(),
    ).toMatchObject({ details: { reason: 'not_owner' } })
    await s.admin.call('POST', `/api/live-syncs/${s.id}/pause`)
    expect(
      (await s.admin.call('POST', `/api/live-syncs/${s.id}/finish`, { verify: false })).json(),
    ).toMatchObject({ details: { reason: 'not_live' } })
  })
})

describe('the source’s new options (phase 3e-2 spec §1.4, plan ruling 12)', () => {
  it('waits for a person, then applies the source’s validator or ignores it, and carries on', async () => {
    const s = await live({}, 1)
    await ma.db('live').command({ collMod: s.coll, validator: { n: { $type: 'int' } } })
    await until(() => s.get().state === 'attention')
    expect(s.get()).toMatchObject({ reason: 'schema_changed', detail: `live.${s.coll}` })
    expect(
      (await s.admin.call('POST', `/api/live-syncs/${s.id}/apply-schema`, { ignore: false })).json(),
    ).toMatchObject({ state: 'catching_up' })
    await until(() => s.get().state === 'live')
    const [info] = await mb.db('live').listCollections({ name: s.coll }, { nameOnly: false }).toArray()
    expect(info?.options).toMatchObject({ validator: { n: { $type: 'int' } } })
    await s.source.insertOne({ _id: 'after', n: 5 } as never)
    await until(async () => (await s.target.findOne({ _id: 'after' } as never)) !== null)

    await ma.db('live').command({ collMod: s.coll, validationLevel: 'off' })
    await until(() => s.get().state === 'attention')
    await s.admin.call('POST', `/api/live-syncs/${s.id}/apply-schema`, { ignore: true })
    await until(() => s.get().state === 'live')
    const [kept] = await mb.db('live').listCollections({ name: s.coll }, { nameOnly: false }).toArray()
    expect(kept?.options?.validationLevel).not.toBe('off')
  }, 90_000)
})

// Independent review of the security pass (I3): a masked sync never writes the source's validator
// when it names a value masking would change — the new options can only be ignored.
describe('the new options of a masked sync', () => {
  it('refuses to apply a validator that names a hidden value, and lets it be ignored', async () => {
    const s = await live({ anonymous: true }, 1, 'email')
    await ma.db('live').command({ collMod: s.coll, validator: { email: { $ne: 'ceo@corp.example' } } })
    await until(() => s.get().state === 'attention')
    const applied = await s.admin.call('POST', `/api/live-syncs/${s.id}/apply-schema`, { ignore: false })
    expect(applied.statusCode).toBe(409)
    expect(applied.json()).toMatchObject({ details: { reason: 'validator_masked' } })
    const [info] = await mb.db('live').listCollections({ name: s.coll }, { nameOnly: false }).toArray()
    expect(JSON.stringify(info?.options ?? {})).not.toContain('ceo@corp.example')
    expect(s.get().state).toBe('attention')
    await s.admin.call('POST', `/api/live-syncs/${s.id}/apply-schema`, { ignore: true })
    await until(() => s.get().state === 'live')
  }, 90_000)

  it('applies a validator that names no hidden value, as an unmasked sync does', async () => {
    const s = await live({ anonymous: true }, 1, 'email')
    await ma.db('live').command({ collMod: s.coll, validator: { n: { $type: 'int' } } })
    await until(() => s.get().state === 'attention')
    const applied = await s.admin.call('POST', `/api/live-syncs/${s.id}/apply-schema`, { ignore: false })
    expect(applied.statusCode).toBe(200)
    await until(() => s.get().state === 'live')
    const [info] = await mb.db('live').listCollections({ name: s.coll }, { nameOnly: false }).toArray()
    expect(info?.options).toMatchObject({ validator: { n: { $type: 'int' } } })
  }, 90_000)
})

describe('final review fixes in verify and the options (phase 3e-2)', () => {
  it('m10: answers a target that cannot take the options in words, not with a server error', async () => {
    const s = await live({}, 1)
    await ma.db('live').command({ collMod: s.coll, validator: { n: { $type: 'int' } } })
    await until(() => s.get().state === 'attention')
    await s.target.drop()
    const r = await s.admin.call('POST', `/api/live-syncs/${s.id}/apply-schema`, { ignore: false })
    expect(r.statusCode).toBeLessThan(500)
  }, 90_000)

  it('m13: settles each collection on its own (no suspects of every collection held at once)', async () => {
    const h = await liveSyncHarness(a.getUri(), b.getUri(), undefined, {}, timing as never)
    harnesses.push(h)
    const admin = h.user()
    const db = name('vd')
    await ma
      .db(db)
      .collection('one')
      .insertMany([{ _id: 1 }, { _id: 2 }] as never[])
    await ma
      .db(db)
      .collection('two')
      .insertMany([{ _id: 1 }, { _id: 2 }] as never[])
    const body = { ...syncBody(h.ids, 'A', 'B', { db }) }
    const plan = (
      await admin.call('POST', `/api/connections/${h.ids.A}/live-syncs/plan`, body)
    ).json() as LiveSyncPlan
    const view = (
      await admin.call('POST', `/api/connections/${h.ids.A}/live-syncs`, { ...body, planHash: plan.planHash })
    ).json() as LiveSyncView
    await until(() => h.ctx.liveSync.repo.get(view.id)!.state === 'live', 30_000)
    await mb
      .db(db)
      .collection('one')
      .insertOne({ _id: 'x' } as never)
    await mb
      .db(db)
      .collection('two')
      .insertOne({ _id: 'y' } as never)
    let settling = 0
    const result = await verifySync(
      { ctx: h.ctx, settled: async () => (++settling, true) },
      h.ctx.liveSync.repo.get(view.id)!,
      new AbortController().signal,
      true,
    )
    expect(settling).toBe(2)
    expect(result.pairs.map((p) => p.onlyTarget)).toEqual([1, 1])
  }, 90_000)
})

describe('metrics (phase 3e-2 spec §2.6)', () => {
  it('counts syncs by state, the largest lag and the changes applied', async () => {
    const s = await live({ startMode: 'from_now' })
    await s.source.insertMany([{ n: 1 }, { n: 2 }])
    await until(() => s.get().counters.inserted === 2)
    expect(s.h.ctx.liveSync.metrics()).toMatchObject({ states: { live: 1, paused: 0 }, changes: 2 })
  })
})
