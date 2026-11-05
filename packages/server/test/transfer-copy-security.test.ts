// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EJSON } from 'bson'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { BSON, MongoClient, type Document } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { transferHarness } from './support/transfer2'
import { waitJob } from './support/jobs'
import { READ_OPTIONS } from '../src/data/ejson-io'
import { JobRepo } from '../src/jobs/repo'
import { dropLeftoverStaging } from '../src/jobs/duplicate'
import { TargetWriter } from '../src/transfer/target-writer'
import type { JobKind } from '../src/jobs/types'
import { slow } from './support/slowness'

/** Phase 3d-2 spec §9: one abuse case per threat, T1–T16. Personal values carry a sentinel. */
const S = 'S3NT1N3L'
let a: TestMongo
let b: TestMongo
let ca: MongoClient
let cb: MongoClient
beforeAll(async () => {
  ;[a, b] = await Promise.all([startMongo(), startMongo()])
  ;[ca, cb] = await Promise.all([
    new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect(),
    new MongoClient(`mongodb://127.0.0.1:${b.port}`).connect(),
  ])
}, slow(180_000))
afterAll(async () => {
  await Promise.all([ca?.close(), cb?.close()])
  await Promise.all([a?.stop(), b?.stop()])
})
beforeEach(async () => {
  await Promise.all([ca, cb].flatMap((c) => ['shop', 'copy', 'copyall'].map((d) => c.db(d).dropDatabase())))
  await ca
    .db('shop')
    .collection('orders')
    .insertMany(
      Array.from({ length: 50 }, (_, i) => ({
        _id: i as never,
        name: `n${i}`,
        email: `${S}-${i}@x`,
        nested: { phone: `${S}-p${i}`, city: 'Izmir' },
      })),
    )
})
afterEach(() => {
  vi.restoreAllMocks()
})

type H = Awaited<ReturnType<typeof transferHarness>>
type U = ReturnType<H['user']>
const RULES = [
  { db: 'shop', coll: 'orders', field: 'email' },
  { db: 'shop', coll: 'orders', field: 'nested.phone' },
]
const ORDERS = (h: H, id = h.ids.A) => `/api/connections/${id}/databases/shop/collections/orders`

async function copy(h: H, u: U, body: object, base = `${ORDERS(h)}/copy`) {
  const plan = await u.call('POST', `${base}/plan`, body)
  if (plan.statusCode !== 200) return { status: plan.statusCode, body: plan.json() }
  const res = await u.call('POST', base, { ...body, planHash: plan.json().planHash })
  if (res.statusCode !== 202) return { status: res.statusCode, body: res.json(), plan: plan.json() }
  const job = await waitJob(h.t, res.json().job.id, 60_000)
  return { status: 202, job, report: (await u.get(`/api/transfer/jobs/${job.id}/report`)).json() }
}

async function compare(h: H, u: U, target: object, extra: object = {}) {
  const res = await u.call('POST', `${ORDERS(h)}/compare`, { target, ...extra })
  if (res.statusCode !== 202) return { status: res.statusCode, body: res.json() }
  const job = await waitJob(h.t, res.json().job.id, 60_000)
  return { status: 202, job, report: (await u.get(`/api/transfer/jobs/${job.id}/report`)).json() }
}

/** Every document of a database, as canonical EJSON text. */
async function dump(client: MongoClient, db: string): Promise<string> {
  let out = ''
  for (const c of await client.db(db).listCollections({}, { nameOnly: true }).toArray())
    out += EJSON.stringify(await client.db(db).collection(c.name).find().toArray(), { relaxed: false })
  return out
}

describe('copy, compare and sync abuse cases (phase 3d-2 spec §9)', () => {
  it('T1: an unreachable target is 404, a viewer role 403, a system namespace 403 — copy and compare', async () => {
    const h = await transferHarness(a, b)
    try {
      const target = (connectionId: string, db = 'copy', coll = 'orders') => ({
        source: { kind: 'collection' },
        target: { connectionId, db, coll },
        mode: 'insert',
        indexes: false,
      })
      const none = h.user({ on: { B: 'none' } })
      expect((await copy(h, none, target(h.ids.B))).status).toBe(404)
      expect((await compare(h, none, { connectionId: h.ids.B, db: 'shop', coll: 'orders' })).status).toBe(404)
      const viewer = h.user({ on: { B: 'viewer' } })
      expect((await copy(h, viewer, target(h.ids.B))).status).toBe(403)
      const admin = h.user({ role: 'admin' })
      expect((await copy(h, admin, target(h.ids.B, 'admin'))).status).toBe(403)
      expect((await copy(h, admin, target(h.ids.B, 'copy', 'system.js'))).status).toBe(403)
      expect((await compare(h, admin, { connectionId: h.ids.B, db: 'local', coll: 'x' })).status).toBe(403)
    } finally {
      await h.t.close()
    }
  })

  // Fourth review of the open's stop (minor 1): a target that cannot open is named as a source is
  // (its host not found, here), not as a failure of the network or of the request.
  it('names a side that cannot open as its connection’s failure — copy, compare and sync', async () => {
    const h = await transferHarness(a, b)
    try {
      const lost = ConnectionSettingsSchema.parse({
        hosts: [{ host: 'mm-target.invalid', port: 27017 }],
        // Fifth review (nit 4): a stall longer than the selection would answer a timeout instead.
        serverSelectionTimeoutMS: 4_000,
      })
      const gone = h.t.app.ctx.connections.create(
        { name: 'Gone', favorite: false, readOnly: false, settings: lost },
        null,
      ).id
      const admin = h.user({ role: 'admin' })
      const plan = await copy(h, admin, {
        source: { kind: 'collection' },
        target: { connectionId: gone, db: 'copy', coll: 'orders' },
        mode: 'insert',
        indexes: false,
      })
      expect(plan).toMatchObject({ status: 502, body: { code: 'MONGO_ERROR', details: { kind: 'dns' } } })
      const compared = await compare(h, admin, { connectionId: gone, db: 'shop', coll: 'orders' })
      expect(compared).toMatchObject({ status: 502, body: { code: 'MONGO_ERROR', details: { kind: 'dns' } } })
      // A sync from a comparison whose source cannot open now.
      const done = await compare(h, admin, { connectionId: h.ids.B, db: 'shop', coll: 'orders' })
      expect(done.status).toBe(202)
      h.t.app.ctx.connections.update(h.ids.A, { settings: lost })
      await h.t.app.ctx.manager.invalidate(h.ids.A)
      const sync = await admin.call('POST', '/api/transfer/sync', { compareJobId: done.job!.id })
      expect(sync.statusCode, sync.body).toBe(502)
      expect(sync.json()).toMatchObject({ code: 'MONGO_ERROR', details: { kind: 'dns' } })
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('T2: a restricted source never puts a personal value in the target, whatever the source kind', async () => {
    const h = await transferHarness(a, b)
    try {
      h.rules('A', RULES)
      const u = h.user({ masked: ['A'] })
      const to = (coll: string) => ({ connectionId: h.ids.B, db: 'copy', coll })
      const sources = [
        { kind: 'collection' },
        { kind: 'query', filter: { name: { $ne: 'x' } } },
        { kind: 'pipeline', stages: [{ $match: {} }, { $addFields: { tag: 1 } }] },
      ]
      for (const [i, source] of sources.entries()) {
        const r = await copy(h, u, { source, target: to(`c${i}`), mode: 'insert', indexes: false })
        expect(r.status, JSON.stringify(r.body ?? '')).toBe(202)
        expect(r.job!.state, r.job!.error ?? '').toBe('done')
      }
      const db = await copy(
        h,
        u,
        { target: { connectionId: h.ids.B, db: 'copyall' }, mode: 'insert', indexes: false },
        `/api/connections/${h.ids.A}/databases/shop/copy`,
      )
      expect(db.status).toBe(202)
      const copied = (await dump(cb, 'copy')) + (await dump(cb, 'copyall'))
      expect(copied).toContain('***')
      expect(copied).not.toContain(S)
      const leak = await copy(h, u, {
        source: { kind: 'pipeline', stages: [{ $project: { copy: '$email' } }] },
        target: to('leak'),
        mode: 'insert',
        indexes: false,
      })
      expect(leak.status).toBe(403)
    } finally {
      await h.t.close()
    }
  }, 300_000)

  it('T3: compare and its samples never tell a hidden value, restricted on either side or both', async () => {
    const h = await transferHarness(a, b)
    try {
      await cb
        .db('shop')
        .collection('orders')
        .insertMany(
          Array.from({ length: 50 }, (_, i) => ({
            _id: i as never,
            name: `n${i}`,
            email: i < 10 ? `guess-${i}@x` : `${S}-${i}@x`,
            nested: { phone: `${S}-p${i}`, city: 'Izmir' },
          })),
        )
      h.rules('A', RULES)
      h.rules('B', RULES)
      for (const masked of [['A'], ['B'], ['A', 'B']] as Array<Array<'A' | 'B'>>) {
        const u = h.user({ masked })
        const r = await compare(h, u, { connectionId: h.ids.B, db: 'shop', coll: 'orders' })
        expect(r.status).toBe(202)
        // Documents that differ only in a hidden value are "same".
        expect(r.report.collections[0]).toMatchObject({ same: 50, different: 0 })
        const text = JSON.stringify(r.report)
        expect(text).not.toContain(S)
        expect(text).not.toContain('guess-')
      }
    } finally {
      await h.t.close()
    }
  }, 240_000)

  it('T4: a unique index over personal data on the target answers a restricted user with codes only', async () => {
    const h = await transferHarness(a, b)
    try {
      h.rules('B', [{ db: 'copy', coll: 'orders', field: 'email' }])
      await cb.db('copy').collection('orders').createIndex({ email: 1 }, { unique: true })
      await cb
        .db('copy')
        .collection('orders')
        .insertOne({ _id: 'kept' as never, email: `${S}-3@x` })
      const u = h.user({ masked: ['B'] })
      const r = await copy(h, u, {
        source: { kind: 'collection' },
        target: { connectionId: h.ids.B, db: 'copy', coll: 'orders' },
        mode: 'insert',
        indexes: false,
        confirmPersonal: true,
      })
      expect(r.status).toBe(202)
      expect(r.report.collections[0].failed).toBe(50)
      const text = JSON.stringify(r.report) + (r.job!.error ?? '')
      expect(text).not.toContain(S)
      expect(await cb.db('copy').collection('orders').countDocuments()).toBe(1)
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('T5: replace and sync never destroy the source through another name of the same server', async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user()
      const r = await copy(h, u, {
        source: { kind: 'collection' },
        target: { connectionId: h.ids.A2, db: 'shop', coll: 'orders' },
        mode: 'replace',
        indexes: false,
      })
      expect(r.status).toBe(409)
      expect(r.body.details.reasons).toContain('same_namespace')
      const c = await compare(h, u, { connectionId: h.ids.A2, db: 'shop', coll: 'orders' })
      expect(c.status).toBe(202)
      const sync = await u.call('POST', '/api/transfer/sync', { compareJobId: c.job!.id })
      expect(sync.statusCode).toBe(409)
      expect(sync.json().details.reason).toBe('same_namespace')
      expect(await ca.db('shop').collection('orders').countDocuments()).toBe(50)
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('T6: a view that runs JavaScript is not created; TTL indexes need a confirmation', async () => {
    const h = await transferHarness(a, b)
    try {
      // MongoDB refuses $where/$function in validators itself; the allowlist test covers them (Task 7).
      await ca.db('shop').createCollection('vjs', {
        viewOn: 'orders',
        pipeline: [
          { $match: { $expr: { $function: { body: 'function() { return true }', args: [], lang: 'js' } } } },
        ],
      })
      const u = h.user()
      const r = await copy(
        h,
        u,
        {
          target: { connectionId: h.ids.B, db: 'copy' },
          mode: 'insert',
          indexes: false,
          collections: ['orders'],
        },
        `/api/connections/${h.ids.A}/databases/shop/copy`,
      )
      expect(r.status).toBe(202)
      expect(r.report.views).toEqual([
        { name: 'vjs', created: false, reason: expect.stringMatching(/JavaScript/) },
      ])
      expect(await cb.db('copy').listCollections({ name: 'vjs' }).toArray()).toEqual([])
      await ca.db('shop').collection('orders').createIndex({ at: 1 }, { expireAfterSeconds: 60 })
      const ttl = await copy(h, u, {
        source: { kind: 'collection' },
        target: { connectionId: h.ids.B, db: 'copy', coll: 'orders' },
        mode: 'insert',
      })
      expect(ttl.status).toBe(409)
      expect(ttl.body.details.reasons).toEqual(['confirm_ttl'])
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('T7: hostile field names are copied as data, byte for byte; a merge refuses path-like names', async () => {
    const h = await transferHarness(a, b)
    try {
      const doc: Document = { _id: 'h' as never, 'a.b': 1, constructor: 'c', sub: { $x: 1 } }
      Object.defineProperty(doc, '__proto__', {
        value: { p: 1 },
        enumerable: true,
        writable: true,
        configurable: true,
      })
      await ca.db('shop').collection('hostile').insertOne(doc)
      const u = h.user()
      const base = `/api/connections/${h.ids.A}/databases/shop/collections/hostile/copy`
      const r = await copy(
        h,
        u,
        {
          source: { kind: 'collection' },
          target: { connectionId: h.ids.B, db: 'copy', coll: 'hostile' },
          mode: 'insert',
          indexes: false,
        },
        base,
      )
      expect(r.job!.state, r.job!.error ?? '').toBe('done')
      const [src] = await ca.db('shop').collection('hostile').find({}, READ_OPTIONS).toArray()
      const [dst] = await cb.db('copy').collection('hostile').find({}, READ_OPTIONS).toArray()
      expect(Buffer.from(BSON.serialize(dst!)).equals(Buffer.from(BSON.serialize(src!)))).toBe(true)
      const merge = await copy(
        h,
        u,
        {
          source: { kind: 'collection' },
          target: { connectionId: h.ids.B, db: 'copy', coll: 'merged' },
          mode: 'merge',
          indexes: false,
        },
        base,
      )
      expect(merge.report.collections[0].failed).toBe(1)
      expect(await cb.db('copy').collection('merged').countDocuments()).toBe(0)
    } finally {
      await h.t.close()
    }
  }, 180_000)

  it('T8: at most two transfers per user run at once, counting copies', async () => {
    const h = await transferHarness(a, b)
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const kinds = h.ctx.jobKinds as Record<string, JobKind<unknown>>
    const real = kinds['data.copy']!
    kinds['data.copy'] = {
      name: 'data.copy',
      run: () => held,
      cancel: async () => true,
      recover: () => 'interrupted',
    }
    try {
      const u = h.user()
      const body = {
        source: { kind: 'collection' },
        target: { connectionId: h.ids.B, db: 'copy', coll: 'orders' },
        mode: 'insert',
        indexes: false,
      }
      const plan = (await u.call('POST', `${ORDERS(h)}/copy/plan`, body)).json()
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          u.call('POST', `${ORDERS(h)}/copy`, { ...body, planHash: plan.planHash }),
        ),
      )
      expect(results.filter((r) => r.statusCode === 202)).toHaveLength(2)
      expect(results.filter((r) => r.statusCode === 409)).toHaveLength(2)
    } finally {
      release()
      kinds['data.copy'] = real
      await h.t.close()
    }
  })

  it("T9: another user cannot see, use or read a copy's or a compare's job, report or sync", async () => {
    const h = await transferHarness(a, b)
    try {
      const x = h.user()
      const y = h.user()
      const c = await compare(h, x, { connectionId: h.ids.B, db: 'shop', coll: 'orders' })
      const id = c.job!.id
      const listed = (await y.get('/api/jobs')).json() as { jobs: Array<{ id: string }> }
      expect(listed.jobs.map((j) => j.id)).not.toContain(id)
      expect((await y.get(`/api/jobs/${id}`)).statusCode).toBe(404)
      expect((await y.get(`/api/transfer/jobs/${id}/report`)).statusCode).toBe(404)
      expect((await y.call('POST', '/api/transfer/sync', { compareJobId: id })).statusCode).toBe(404)
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('T10: adding rules to the target needs the admin role there, and only appends', async () => {
    const h = await transferHarness(a, b)
    try {
      h.rules('A', RULES)
      h.rules('B', [{ db: 'other', coll: 'x', field: 'y' }])
      const body = {
        source: { kind: 'collection' },
        target: { connectionId: h.ids.B, db: 'copy', coll: 'orders' },
        mode: 'insert',
        indexes: false,
        addRulesToTarget: true,
      }
      const editor = h.user()
      const refused = await copy(h, editor, body)
      expect(refused.status).toBe(409)
      expect(refused.body.details.reasons).toContain('add_rules_forbidden')
      const admin = h.user({ role: 'admin' })
      const done = await copy(h, admin, body)
      expect(done.status).toBe(202)
      expect(done.report.rulesAdded).toBe(2)
      expect(h.ctx.personalFields.get(h.ids.B).rules).toEqual([
        { db: 'other', coll: 'x', field: 'y' },
        { db: 'copy', coll: 'orders', field: 'email' },
        { db: 'copy', coll: 'orders', field: 'nested.phone' },
      ])
      expect(h.ctx.audit.list({ action: 'connections.personalFields' }).length).toBe(1)
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('T11: an unmasked copy stops when the source rules change under it', async () => {
    const h = await transferHarness(a, b)
    try {
      await ca
        .db('shop')
        .collection('big')
        .insertMany(Array.from({ length: 2500 }, (_, i) => ({ _id: i as never })))
      const realWrite = TargetWriter.prototype.write
      let written = false
      vi.spyOn(TargetWriter.prototype, 'write').mockImplementation(async function (
        this: TargetWriter,
        batch,
      ) {
        await realWrite.call(this, batch)
        written = true
      })
      const fields = h.ctx.personalFields
      const realGet = fields.get.bind(fields)
      vi.spyOn(fields, 'get').mockImplementation((id: string) => {
        const v = realGet(id)
        return written && id === h.ids.A ? { ...v, version: v.version + 1 } : v
      })
      const r = await copy(
        h,
        h.user(),
        {
          source: { kind: 'collection' },
          target: { connectionId: h.ids.B, db: 'copy', coll: 'big' },
          mode: 'insert',
          indexes: false,
        },
        `/api/connections/${h.ids.A}/databases/shop/collections/big/copy`,
      )
      expect(r.job!.state).toBe('failed')
      expect(r.job!.error).toMatch(/rules changed/)
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('T12: no URI, host or port in jobs, reports or audit details', async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user()
      const cp = await copy(h, u, {
        source: { kind: 'collection' },
        target: { connectionId: h.ids.B, db: 'copy', coll: 'orders' },
        mode: 'insert',
        indexes: false,
      })
      const c = await compare(h, u, { connectionId: h.ids.B, db: 'copy', coll: 'orders' })
      const s = await u.call('POST', '/api/transfer/sync', { compareJobId: c.job!.id })
      await waitJob(h.t, s.json().job.id, 60_000)
      const text = JSON.stringify([
        (await u.get('/api/jobs')).json(),
        cp.report,
        c.report,
        h.ctx.audit.list({ limit: 100 }).map((row) => row.details),
      ])
      for (const bad of ['127.0.0.1', 'localhost', `:${a.port}`, `:${b.port}`, 'mongodb://'])
        expect(text).not.toContain(bad)
    } finally {
      await h.t.close()
    }
  }, 240_000)

  it('T13: a read-only target refuses writes; reading it to compare still works', async () => {
    const h = await transferHarness(a, b)
    try {
      h.ctx.store.db.prepare('UPDATE connections SET read_only = 1 WHERE id = ?').run(h.ids.B)
      const u = h.user()
      const r = await copy(h, u, {
        source: { kind: 'collection' },
        target: { connectionId: h.ids.B, db: 'copy', coll: 'orders' },
        mode: 'insert',
        indexes: false,
      })
      expect(r.status).toBe(403)
      expect(r.body.code).toBe('READ_ONLY')
      expect((await compare(h, u, { connectionId: h.ids.B, db: 'shop', coll: 'orders' })).status).toBe(202)
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('T14: rejected documents count against the quota', async () => {
    const h = await transferHarness(a, b, {
      transfer: { maxUploadMb: 64, quotaMb: 16, totalQuotaMb: 51_200, ttlHours: 1, maxJobHours: 1 },
    })
    try {
      const big = 'r'.repeat(1024 * 1024)
      await ca
        .db('shop')
        .collection('wide')
        .insertMany(Array.from({ length: 20 }, (_, i) => ({ _id: i as never, 'a.b': big })))
      const r = await copy(
        h,
        h.user(),
        {
          source: { kind: 'collection' },
          target: { connectionId: h.ids.B, db: 'copy', coll: 'wide' },
          mode: 'merge',
          indexes: false,
        },
        `/api/connections/${h.ids.A}/databases/shop/collections/wide/copy`,
      )
      expect(r.report.collections[0].failed).toBe(20)
      expect(r.report).toMatchObject({ rejectedFile: false, rejectedDropped: true })
      expect(h.ctx.transfer.files.usage(r.job!.userId ?? 'local')).toBeLessThanOrEqual(16 * 1024 * 1024)
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('T15: a sync takes nothing from the client but its switches, and only a comparison', async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user()
      const c = await compare(h, u, { connectionId: h.ids.B, db: 'shop', coll: 'orders' })
      const extra = await u.call('POST', '/api/transfer/sync', {
        compareJobId: c.job!.id,
        target: { connectionId: h.ids.A, db: 'shop', coll: 'orders' },
      })
      expect(extra.statusCode).toBe(400)
      const dry = await copy(h, u, {
        source: { kind: 'collection' },
        target: { connectionId: h.ids.B, db: 'copy', coll: 'orders' },
        mode: 'insert',
        indexes: false,
        dryRun: true,
      })
      expect((await u.call('POST', '/api/transfer/sync', { compareJobId: dry.job!.id })).statusCode).toBe(404)
    } finally {
      await h.t.close()
    }
  }, 180_000)

  it('T16: a copy staging collection left on the target connection is dropped when that connection opens', async () => {
    const h = await transferHarness(a, b)
    try {
      const repo = new JobRepo(h.ctx.store.db)
      const base = {
        kind: 'data.copy' as const,
        userId: null,
        connectionId: h.ids.A,
        targetConnectionId: h.ids.B,
        db: 'shop',
        coll: 'orders',
        target: 'copy.orders',
        state: 'interrupted' as const,
        progress: null,
        estimate: null,
        error: null,
        stagingConnectionId: h.ids.B,
        stagingDb: 'copy',
        startedAt: 1,
        finishedAt: 2,
      }
      repo.insert({ ...base, id: crypto.randomUUID(), staging: 'mm_copy_0123456789abcdef' })
      repo.insert({ ...base, id: crypto.randomUUID(), staging: 'orders' })
      await cb.db('copy').createCollection('mm_copy_0123456789abcdef')
      await cb.db('copy').createCollection('orders')
      await dropLeftoverStaging(h.ctx.jobs, h.ids.B, cb, { warn: () => undefined })
      const names = (await cb.db('copy').listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name)
      expect(names).toEqual(['orders'])
      expect(repo.withStaging(h.ids.B).map((j) => j.staging)).toEqual(['orders'])
    } finally {
      await h.t.close()
    }
  })
})
