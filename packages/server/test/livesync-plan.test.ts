// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MongoClient, UUID } from 'mongodb'
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server'
import type { LiveSyncPlan } from '@mongo-manager/shared'
import { closesLoop, oplogWarning, oplogWindowEstimate, settingsStamp } from '../src/livesync/plan'
import { liveSyncHarness, syncBody, type LiveSyncHarness } from './support/livesync'
import { slow } from './support/slowness'

let a: MongoMemoryReplSet
let b: MongoMemoryReplSet
let solo: MongoMemoryServer
let ma: MongoClient
let mb: MongoClient
beforeAll(async () => {
  ;[a, b, solo] = await Promise.all([
    MongoMemoryReplSet.create({ replSet: { count: 1 } }),
    MongoMemoryReplSet.create({ replSet: { count: 1 } }),
    MongoMemoryServer.create(),
  ])
  ma = await new MongoClient(a.getUri()).connect()
  mb = await new MongoClient(b.getUri()).connect()
}, slow(180_000))
afterAll(async () => {
  await ma?.close()
  await mb?.close()
  await Promise.all([a?.stop(), b?.stop(), solo?.stop()])
})
const harnesses: LiveSyncHarness[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close()
})
const name = (p: string) => `${p}${randomUUID().slice(0, 8)}`

async function setup() {
  const h = await liveSyncHarness(a.getUri(), b.getUri(), solo.getUri())
  harnesses.push(h)
  const admin = h.user()
  const plan = async (from: 'A' | 'B' | 'A2' | 'S', body: object) => {
    const r = await admin.call('POST', `/api/connections/${h.ids[from]}/live-syncs/plan`, body)
    return { status: r.statusCode, plan: r.json() as LiveSyncPlan }
  }
  return { ids: h.ids, user: h.user, rules: h.rules, admin, plan }
}

describe('a live sync’s plan (phase 3e-2 spec §1.1, §1.3, §3)', () => {
  it('plans a collection sync between two replica sets, with the copy’s plan and an estimate', async () => {
    const s = await setup()
    const coll = name('p')
    await ma
      .db('live')
      .collection(coll)
      .insertMany([{ n: 1 }, { n: 2 }])
    const { status, plan } = await s.plan('A', syncBody(s.ids, 'A', 'B', { db: 'live', coll }))
    expect(status).toBe(200)
    expect(plan.refusals).toEqual([])
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/)
    expect(plan.copy.collections).toMatchObject([{ source: coll, target: coll, exists: false }])
    expect(plan.estimate.documents).toBe(2)
    expect(plan.warnings).toContain('overwrite')
    expect(plan.masked).toBe(false)
  })

  it('asks for the overwrite warning to be confirmed', async () => {
    const s = await setup()
    const coll = name('o')
    await ma.db('live').collection(coll).insertOne({ n: 1 })
    const body = { ...syncBody(s.ids, 'A', 'B', { db: 'live', coll }), confirmOverwrite: false }
    expect((await s.plan('A', body)).plan.refusals).toContain('confirm_overwrite')
  })

  it('refuses a standalone source, a time-series source and a capped target', async () => {
    const s = await setup()
    const solo1 = await new MongoClient(solo.getUri()).connect()
    try {
      await solo1.db('live').collection('x').insertOne({ n: 1 })
      expect(
        (await s.plan('S', syncBody(s.ids, 'S', 'B', { db: 'live', coll: 'x' }))).plan.refusals,
      ).toContain('source_not_replica_set')
    } finally {
      await solo1.close()
    }
    const ts = name('ts')
    await ma.db('live').createCollection(ts, { timeseries: { timeField: 't' } })
    expect((await s.plan('A', syncBody(s.ids, 'A', 'B', { db: 'live', coll: ts }))).plan.refusals).toContain(
      'timeseries',
    )
    const capped = name('c')
    await ma.db('live').collection(capped).insertOne({ n: 1 })
    await mb.db('live').createCollection(capped, { capped: true, size: 1 << 20 })
    expect(
      (await s.plan('A', syncBody(s.ids, 'A', 'B', { db: 'live', coll: capped }))).plan.refusals,
    ).toContain('capped_target')
  })

  // Final review of explain masking (I-1, M-1): a time series target takes none of a sync's
  // replacements; refused in the plan, by its own reason (a collection's and a database's sync).
  it('refuses a time series target in every start', async () => {
    const s = await setup()
    const coll = name('tst')
    await ma.db('live').collection(coll).insertOne({ n: 1 })
    await mb.db('live').createCollection(coll, { timeseries: { timeField: 't' } })
    for (const startMode of ['copy', 'merge', 'from_now'] as const) {
      const { status, plan } = await s.plan(
        'A',
        syncBody(s.ids, 'A', 'B', { db: 'live', coll }, { startMode }),
      )
      expect(status, startMode).toBe(200)
      expect(plan.refusals, startMode).toContain('timeseries_target')
    }
    const replace = await s.plan(
      'A',
      syncBody(s.ids, 'A', 'B', { db: 'live', coll }, { startMode: 'replace', confirmTarget: coll }),
    )
    // Nor can replace rename its copy over one (measured on 8.2; final review, I-1).
    expect(replace.status).toBe(200)
    expect(replace.plan.refusals).toContain('timeseries_target')
    // A database sync: that collection's pair is refused too, never only left out of the copy.
    const db = name('tsdb')
    await ma.db(db).collection('a').insertOne({ n: 1 })
    await ma.db(db).collection('b').insertOne({ n: 1 })
    await mb.db(db).createCollection('b', { timeseries: { timeField: 't' } })
    const all = await s.plan('A', syncBody(s.ids, 'A', 'B', { db }, { startMode: 'merge' }))
    expect(all.status).toBe(200)
    expect(all.plan.refusals).toContain('timeseries_target')
    // Nor in a database sync's replace.
    const again = await s.plan(
      'A',
      syncBody(s.ids, 'A', 'B', { db }, { startMode: 'replace', confirmTarget: db }),
    )
    expect(again.status).toBe(200)
    expect(again.plan.refusals).toContain('timeseries_target')
  })

  // Final review of explain masking (M-5): a pair the initial copy leaves out (here, stored in the
  // order of a hidden _id, in an anonymous sync) is refused, not followed into a partial target.
  it('refuses a collection its initial copy leaves out', async () => {
    const s = await setup()
    const db = name('lo')
    await ma.db(db).createCollection('k', { clusteredIndex: { key: { _id: 1 }, unique: true } })
    await ma
      .db(db)
      .collection('k')
      .insertOne({ _id: 'a@x' as never, n: 1 })
    s.rules('A', [{ db, coll: 'k', field: '_id' }])
    const { status, plan } = await s.plan('A', syncBody(s.ids, 'A', 'B', { db }, { anonymous: true }))
    expect(status).toBe(200)
    expect(plan.refusals).toContain('left_out')
    // Named, for the wizard to say which and why (review of the agent's gate, nit).
    expect(plan.leftOut).toEqual(['k'])
    // A sync from now has no copy, and still follows none of it.
    const body = syncBody(s.ids, 'A', 'B', { db }, { anonymous: true })
    const now = await s.plan('A', { ...body, startMode: 'from_now' })
    expect(now.plan.refusals).toContain('left_out')
  })

  // Final review of the masking side channels (M-2): a Queryable Encryption collection is refused for
  // what it is, once, not also as left out.
  it('refuses a Queryable Encryption collection once, for its encryption', async () => {
    const s = await setup()
    const db = name('qe')
    // CI 2026-10-23: by the server's own command, as 6.0 (Queryable Encryption's preview) keeps such
    // collections too; the driver's createCollection refuses to make one before 7.0.
    await ma.db(db).command({
      create: 'e',
      encryptedFields: { fields: [{ path: 'ssn', bsonType: 'string', keyId: new UUID() }] },
    })
    const { status, plan } = await s.plan('A', syncBody(s.ids, 'A', 'B', { db }))
    expect(status).toBe(200)
    expect(plan.refusals).toContain('encrypted_collection')
    expect(plan.refusals).not.toContain('left_out')
    expect(plan.leftOut).toBeUndefined()
  })

  it('refuses the same namespace on the same deployment, also under another connection’s name', async () => {
    const s = await setup()
    const coll = name('s')
    await ma.db('live').collection(coll).insertOne({ n: 1 })
    expect((await s.plan('A', syncBody(s.ids, 'A', 'A', { db: 'live', coll }))).plan.refusals).toContain(
      'same_namespace',
    )
    expect((await s.plan('A', syncBody(s.ids, 'A', 'A2', { db: 'live', coll }))).plan.refusals).toEqual(
      expect.arrayContaining([expect.stringMatching(/^same_namespace/)]),
    )
  })

  it('needs an empty target to copy first, and the typed name to replace it', async () => {
    const s = await setup()
    const coll = name('t')
    await ma.db('live').collection(coll).insertOne({ n: 1 })
    await mb.db('live').collection(coll).insertOne({ there: true })
    const body = syncBody(s.ids, 'A', 'B', { db: 'live', coll })
    expect((await s.plan('A', body)).plan.refusals).toContain('target_not_empty')
    expect((await s.plan('A', { ...body, startMode: 'merge' })).plan.refusals).toEqual([])
    expect((await s.plan('A', { ...body, startMode: 'from_now' })).plan.refusals).toEqual([])
    expect((await s.plan('A', { ...body, startMode: 'replace' })).plan.refusals).toContain('confirm_target')
    expect((await s.plan('A', { ...body, startMode: 'replace', confirmTarget: coll })).plan.refusals).toEqual(
      [],
    )
  })

  it('needs the target rights a sync uses, and export on the source', async () => {
    const s = await setup()
    const coll = name('r')
    await ma.db('live').collection(coll).insertOne({ n: 1 })
    // A sync deletes, creates collections and builds indexes on the target (spec §3.1), even
    // where its initial copy would not.
    const reader = s.user({ role: 'viewer', on: { A: 'admin', B: 'viewer' } })
    const r = await reader.call(
      'POST',
      `/api/connections/${s.ids.A}/live-syncs/plan`,
      syncBody(s.ids, 'A', 'B', { db: 'live', coll }, { startMode: 'from_now' }),
    )
    expect(r.statusCode).toBe(403)
    const editor = s.user({ role: 'viewer', on: { A: 'admin', B: 'editor' } })
    expect(
      (
        await editor.call(
          'POST',
          `/api/connections/${s.ids.A}/live-syncs/plan`,
          syncBody(s.ids, 'A', 'B', { db: 'live', coll }),
        )
      ).statusCode,
    ).toBe(200)
    const viewer = s.user({ role: 'viewer', on: { A: 'viewer', B: 'admin' } })
    expect(
      (
        await viewer.call(
          'POST',
          `/api/connections/${s.ids.A}/live-syncs/plan`,
          syncBody(s.ids, 'A', 'B', { db: 'live', coll }),
        )
      ).statusCode,
    ).toBe(403)
  })

  it('masks for a user restricted on the source, and refuses a restricted user’s ruled target', async () => {
    const s = await setup()
    const coll = name('m')
    await ma.db('live').collection(coll).insertOne({ email: 'a@x' })
    s.rules('A', [{ db: 'live', coll, field: 'email' }])
    const masked = s.user({ role: 'editor', on: { A: 'editor', B: 'admin' }, masked: ['A'] })
    const r = await masked.call(
      'POST',
      `/api/connections/${s.ids.A}/live-syncs/plan`,
      syncBody(s.ids, 'A', 'B', { db: 'live', coll }),
    )
    expect((r.json() as LiveSyncPlan).masked).toBe(true)
    // Twelfth review of explain masking (I3): nor its size, nor the time its size would take.
    expect((r.json() as LiveSyncPlan).estimate).toMatchObject({ documents: 1, bytes: null, seconds: null })
    expect((r.json() as LiveSyncPlan).copy.collections[0]!.sourceBytes).toBeNull()
    s.rules('B', [{ db: 'live', coll, field: 'email' }])
    const target = s.user({ role: 'editor', on: { A: 'admin', B: 'editor' }, masked: ['B'] })
    const t = await target.call(
      'POST',
      `/api/connections/${s.ids.A}/live-syncs/plan`,
      syncBody(s.ids, 'A', 'B', { db: 'live', coll }),
    )
    expect((t.json() as LiveSyncPlan).refusals).toContain('personal_target')
  })

  // Security review 2026-10-13 round 2 (I2): a live sync of a database by a masked user would carry
  // GridFS file contents denied to them: refused.
  // User report 2026-10-27: where a rule reaches the bucket; one on another collection leaves it free.
  it('refuses a masked user a database sync holding a GridFS bucket a rule reaches', async () => {
    const s = await setup()
    const db = name('g')
    await ma.db(db).collection('fs.chunks').insertOne({ files_id: 1, n: 0, data: 'x' })
    await ma.db(db).collection('fs.files').insertOne({ filename: 'a', length: 1, chunkSize: 255 })
    await ma.db(db).collection('people').insertOne({ email: 'a@x' })
    s.rules('A', [{ db, coll: 'people', field: 'email' }])
    const masked = s.user({ role: 'editor', on: { A: 'editor', B: 'admin' }, masked: ['A'] })
    const refusals = async () =>
      (
        (
          await masked.call(
            'POST',
            `/api/connections/${s.ids.A}/live-syncs/plan`,
            syncBody(s.ids, 'A', 'B', { db }),
          )
        ).json() as LiveSyncPlan
      ).refusals
    expect(await refusals()).not.toContain('gridfs_masked')
    s.rules('A', [
      { db, coll: 'people', field: 'email' },
      { db, coll: 'fs.files', field: 'metadata.owner' },
    ])
    expect(await refusals()).toContain('gridfs_masked')
  })

  it('asks to confirm personal data going unmasked to a target without the rules', async () => {
    const s = await setup()
    const coll = name('u')
    await ma.db('live').collection(coll).insertOne({ email: 'a@x' })
    s.rules('A', [{ db: 'live', coll, field: 'email' }])
    const body = syncBody(s.ids, 'A', 'B', { db: 'live', coll })
    const first = (await s.plan('A', body)).plan
    expect(first.refusals).toContain('confirm_personal')
    expect(first.warnings).toContain('personal_unruled')
    expect((await s.plan('A', { ...body, confirmPersonal: true })).plan.refusals).toEqual([])
  })

  it('names the source in the path: a body for another source is refused', async () => {
    const s = await setup()
    const r = await s.admin.call(
      'POST',
      `/api/connections/${s.ids.B}/live-syncs/plan`,
      syncBody(s.ids, 'A', 'B', { db: 'live', coll: 'x' }),
    )
    expect(r.statusCode).toBe(400)
  })
})

describe('what a plan warns about (phase 3e-2 spec §5)', () => {
  it('asks to confirm TTL indexes, and says which unique indexes a masked sync does not build', async () => {
    const s = await setup()
    const coll = name('w')
    await ma.db('live').collection(coll).insertOne({ email: 'a@x', at: new Date() })
    await ma.db('live').collection(coll).createIndex({ at: 1 }, { expireAfterSeconds: 3600 })
    await ma.db('live').collection(coll).createIndex({ email: 1 }, { unique: true })
    s.rules('A', [{ db: 'live', coll, field: 'email' }])
    const plan = (await s.plan('A', syncBody(s.ids, 'A', 'B', { db: 'live', coll }, { anonymous: true })))
      .plan
    expect(plan.warnings).toEqual(expect.arrayContaining(['ttl', 'unique_masked']))
    expect(plan.refusals).toContain('confirm_ttl')
    const confirmed = (
      await s.plan(
        'A',
        syncBody(s.ids, 'A', 'B', { db: 'live', coll }, { anonymous: true, confirmTtl: true }),
      )
    ).plan
    expect(confirmed.refusals).toEqual([])
  })

  it('does not find a chosen collection the database lacks', async () => {
    const s = await setup()
    const db = name('db')
    await ma.db(db).collection('real').insertOne({ n: 1 })
    const body = {
      ...syncBody(s.ids, 'A', 'B', { db }),
      source: { connectionId: s.ids.A, db, collections: ['real', 'ghost'] },
    }
    expect((await s.plan('A', body)).status).toBe(404)
  })
})

describe('loops and the oplog window (phase 3e-2 spec §3.4, §1.3)', () => {
  // A deployment by its name: a set with its own id, so two names are two sets.
  const n = (name: string, db: string, coll: string | null = null) => ({
    deployment: { kind: 'replicaSet' as const, setName: name, hosts: [`${name}:1`], replicaSetId: name },
    db,
    coll,
  })
  it('finds a loop back to the source, directly or through a chain, and not between unrelated namespaces', () => {
    expect(
      closesLoop([{ source: n('B', 'shop'), target: n('A', 'shop') }], n('A', 'shop'), n('B', 'shop')),
    ).toBe(true)
    expect(
      closesLoop(
        [
          { source: n('B', 'shop', 'o'), target: n('C', 'shop', 'o') },
          { source: n('C', 'shop'), target: n('A', 'shop') },
        ],
        n('A', 'shop', 'o'),
        n('B', 'shop', 'o'),
      ),
    ).toBe(true)
    expect(
      closesLoop(
        [{ source: n('B', 'shop', 'x'), target: n('A', 'shop', 'y') }],
        n('A', 'shop', 'o'),
        n('B', 'shop', 'o'),
      ),
    ).toBe(false)
    expect(closesLoop([], n('A', 'shop'), n('B', 'shop'))).toBe(false)
  })

  it('warns when the copy may outlast half the oplog window, and when the window is unknown', () => {
    expect(oplogWarning(100, 1000)).toBeNull()
    expect(oplogWarning(600, 1000)).toBe('oplog_window')
    expect(oplogWarning(100, null)).toBe('oplog_unknown')
    expect(oplogWarning(null, 1000)).toBeNull()
  })

  it('estimates the window of an oplog that is not full yet from how fast it fills', () => {
    // 10 minutes of history fill 1% of the oplog: it will hold about 1,000 minutes.
    expect(oplogWindowEstimate(600, 1, 100)).toBe(60_000)
    expect(oplogWindowEstimate(600, 100, 100)).toBe(600)
    expect(oplogWindowEstimate(600, null, null)).toBe(600)
    expect(oplogWindowEstimate(0, 1, 100)).toBeNull()
    expect(oplogWindowEstimate(null, 1, 100)).toBeNull()
  })

  it('stamps connection settings by what they point to', () => {
    expect(settingsStamp({ hosts: [{ host: 'a', port: 1 }] })).toBe(
      settingsStamp({ hosts: [{ port: 1, host: 'a' }] }),
    )
    expect(settingsStamp({ hosts: [{ host: 'a', port: 1 }] })).not.toBe(
      settingsStamp({ hosts: [{ host: 'b', port: 1 }] }),
    )
  })
})
