import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Collection, Db, MongoClient, MongoServerError } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { transferHarness } from './support/transfer2'
import { waitJob } from './support/jobs'
import { driverWrapped } from './support/driver-wrap'
import { slow } from './support/slowness'

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
  await Promise.all([ca.db('app').dropDatabase(), cb.db('app2').dropDatabase()])
  const db = ca.db('app')
  await db.collection('orders').insertMany([{ _id: 1 as never, at: new Date(), v: 1 }])
  await db.collection('orders').createIndex({ at: 1 }, { expireAfterSeconds: 3600, name: 'ttl' })
  await db.createCollection('metrics', {
    timeseries: { timeField: 't', metaField: 'm', granularity: 'hours' },
  })
  await db.collection('metrics').insertOne({ t: new Date(), m: 'a', v: 1 })
  await db.createCollection('v1', { viewOn: 'orders', pipeline: [{ $match: { v: 1 } }] })
  await db.createCollection('view2', { viewOn: 'v1', pipeline: [] })
})

type H = Awaited<ReturnType<typeof transferHarness>>
const base = (h: H) => `/api/connections/${h.ids.A}/databases/app/copy`

describe('database copy (phase 3d-2 spec §7.4)', () => {
  it('copies a database with views in order, options, and the TTL confirmation', async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user({ role: 'editor' })
      const body = { target: { connectionId: h.ids.B, db: 'app2' }, mode: 'insert' }
      const plan = (await u.call('POST', `${base(h)}/plan`, body)).json()
      expect(plan.refusals).toEqual(['confirm_ttl'])
      expect(plan.views).toEqual(['v1', 'view2'])
      expect(plan.collections.map((c: { source: string }) => c.source).sort()).toEqual(['metrics', 'orders'])
      const confirmed = { ...body, confirmTtl: true }
      const plan2 = (await u.call('POST', `${base(h)}/plan`, confirmed)).json()
      const res = await u.call('POST', base(h), { ...confirmed, planHash: plan2.planHash })
      expect(res.statusCode, res.body).toBe(202)
      const job = await waitJob(h.t, res.json().job.id, 60_000)
      expect(job.state, job.error ?? '').toBe('done')
      const infos = await cb.db('app2').listCollections({}, { nameOnly: false }).toArray()
      expect(infos.find((i) => i.name === 'metrics')!.type).toBe('timeseries')
      expect(infos.find((i) => i.name === 'view2')).toMatchObject({ type: 'view', options: { viewOn: 'v1' } })
      expect((await cb.db('app2').collection('orders').indexes()).map((i) => i.name)).toContain('ttl')
      const report = (await u.get(`/api/transfer/jobs/${job.id}/report`)).json()
      expect(report.views).toEqual([
        { name: 'v1', created: true },
        { name: 'view2', created: true },
      ])
      expect(await cb.db('app2').collection('view2').countDocuments()).toBe(1)
    } finally {
      await h.t.close()
    }
  }, 90_000)

  // Second independent review (Minor 1): an index or a view MongoDB refused through the driver's own
  // wrapper is said with the server's words, or its code to a user restricted on the target.
  it("says an index or a view refused under the driver's wrapper as the server did", async () => {
    const h = await transferHarness(a, b)
    try {
      vi.spyOn(Collection.prototype, 'createIndex').mockRejectedValue(driverWrapped())
      const createCollection = Db.prototype.createCollection
      vi.spyOn(Db.prototype, 'createCollection').mockImplementation(function (this: Db, ...args: unknown[]) {
        if ((args[1] as { viewOn?: unknown } | undefined)?.viewOn) return Promise.reject(driverWrapped())
        return createCollection.apply(this, args as never)
      } as typeof createCollection)
      h.rules('B', [{ db: 'app2', coll: 'elsewhere', field: 'secret' }])
      for (const [u, index, view] of [
        [
          h.user({ role: 'editor', masked: ['B'] }),
          'Index build refused (code 20)',
          'View creation refused (code 20)',
        ],
        [h.user({ role: 'editor' }), 'refused here', 'refused here'],
      ] as const) {
        const body = {
          target: { connectionId: h.ids.B, db: 'app2' },
          mode: 'insert',
          confirmTtl: true,
          confirmPersonal: true,
        }
        const plan = (await u.call('POST', `${base(h)}/plan`, body)).json()
        const res = await u.call('POST', base(h), { ...body, planHash: plan.planHash })
        expect(res.statusCode, res.body).toBe(202)
        const job = await waitJob(h.t, res.json().job.id, 60_000)
        expect(job.state, job.error ?? '').toBe('done')
        const report = (await u.get(`/api/transfer/jobs/${job.id}/report`)).json()
        const orders = report.collections.find((c: { source: string }) => c.source === 'orders')
        expect(orders.indexes.skipped).toEqual([{ name: 'ttl', reason: index }])
        expect(report.views.map((v: { reason?: string }) => v.reason)).toEqual([view, view])
        await cb.db('app2').dropDatabase()
      }
    } finally {
      vi.restoreAllMocks()
      await h.t.close()
    }
  }, 180_000)

  // Security review 2026-10-13 round 2 (I2): a database copy by a user who cannot see personal data
  // leaves a GridFS bucket out — its file contents are denied to them.
  // User report 2026-10-27: where a rule reaches the bucket; one on another collection leaves it in.
  it('leaves a GridFS bucket out of a masked database copy where a rule reaches it', async () => {
    const h = await transferHarness(a, b)
    try {
      await ca.db('app').collection('fs.files').insertOne({ filename: 'a.txt', length: 1, chunkSize: 255 })
      await ca.db('app').collection('fs.chunks').insertOne({ files_id: 1, n: 0, data: 'secret-bytes' })
      h.rules('A', [{ db: 'app', coll: 'orders', field: 'v' }])
      const u = h.user({ role: 'editor', masked: ['A'] })
      const body = { target: { connectionId: h.ids.B, db: 'app2' }, mode: 'insert', confirmTtl: true }
      const skippedIn = async () => {
        const plan = (await u.call('POST', `${base(h)}/plan`, body)).json()
        return (name: string) =>
          plan.collections.find((c: { source: string }) => c.source === name)?.skipped as string | undefined
      }
      expect((await skippedIn())('fs.chunks')).toBeUndefined()
      h.rules('A', [{ db: 'app', coll: 'fs.chunks', field: 'data' }])
      const plan = (await u.call('POST', `${base(h)}/plan`, body)).json()
      const skipped = (name: string) =>
        plan.collections.find((c: { source: string }) => c.source === name)?.skipped as string | undefined
      expect(skipped('fs.chunks')).toMatch(/GridFS/)
      expect(skipped('fs.files')).toMatch(/GridFS/)
      const res = await u.call('POST', base(h), { ...body, planHash: plan.planHash, confirmPersonal: true })
      if (res.statusCode === 202) await waitJob(h.t, res.json().job.id, 60_000)
      expect(await cb.db('app2').collection('fs.chunks').countDocuments()).toBe(0)
    } finally {
      await h.t.close()
    }
  }, 90_000)

  // Seventeenth review of explain masking (I1-b): the target's insertion order is the read's.
  it('reads a masked database copy in the gate’s order, leaving out what no order hides', async () => {
    const h = await transferHarness(a, b)
    try {
      await ca.db('app').createCollection('keyed', { clusteredIndex: { key: { _id: 1 }, unique: true } })
      await ca
        .db('app')
        .collection('keyed')
        .insertMany([{ _id: 'b@x' as never }, { _id: 'a@x' as never }])
      await ca.db('app').createCollection('series', { timeseries: { timeField: 'at', metaField: 'meta' } })
      await ca
        .db('app')
        .collection('series')
        .insertMany([
          { _id: 1 as never, at: new Date(1), meta: { email: 'b@x' } },
          { _id: 1 as never, at: new Date(2), meta: { email: 'a@x' } },
        ])
      h.rules('A', [
        { db: 'app', coll: 'keyed', field: '_id' },
        { db: 'app', coll: 'series', field: 'meta.email' },
      ])
      const u = h.user({ role: 'editor', masked: ['A'] })
      const body = {
        target: { connectionId: h.ids.B, db: 'app2' },
        mode: 'insert',
        confirmTtl: true,
        collections: ['keyed'],
      }
      const plan = (await u.call('POST', `${base(h)}/plan`, body)).json()
      const keyed = plan.collections.find((c: { source: string }) => c.source === 'keyed')
      expect(keyed.skipped).toMatch(/order of a hidden value/)
      // Its hidden _id is not written: no personal_id refusal (review of the side channels, M-2).
      expect(plan.refusals).not.toContain('personal_id')
      // The series' equal _ids would land in the target in its hidden storage order: refused.
      const seriesBody = { ...body, collections: ['series'], confirmPersonal: true }
      const seriesPlan = (await u.call('POST', `${base(h)}/plan`, seriesBody)).json()
      const res = await u.call('POST', base(h), { ...seriesBody, planHash: seriesPlan.planHash })
      expect(res.statusCode, res.body).toBe(202)
      const job = await waitJob(h.t, res.json().job.id, 60_000)
      // That collection alone fails, asked before anything was made, and the database copy goes on
      // (nineteenth and eleventh reviews, I4, Minor 9, M1).
      expect(job.state).toBe('done')
      const report = (await u.get(`/api/transfer/jobs/${job.id}/report`)).json() as {
        collections: Array<{ source: string; failure?: string }>
      }
      expect(report.collections.find((c) => c.source === 'series')?.failure).toMatch(/repeats/)
      expect(await cb.db('app2').listCollections({ name: 'series' }).toArray()).toEqual([])
      // A series with unique _ids lands in _id order, never in its hidden storage order (by meta).
      await ca.db('app').createCollection('readings', { timeseries: { timeField: 'at', metaField: 'meta' } })
      await ca
        .db('app')
        .collection('readings')
        .insertMany([
          { _id: 2 as never, at: new Date(0), meta: { email: 'a@x' } },
          { _id: 1 as never, at: new Date(7_200_000), meta: { email: 'b@x' } },
        ])
      // Stored in buckets hours apart: read as they are, they come 2, 1.
      expect((await ca.db('app').collection('readings').find({}).toArray()).map((d) => d._id)).toEqual([2, 1])
      await cb.db('app2').createCollection('readings')
      h.rules('A', [{ db: 'app', coll: 'readings', field: 'meta.email' }])
      const readingsBody = { ...body, collections: ['readings'], confirmPersonal: true }
      const readingsPlan = (await u.call('POST', `${base(h)}/plan`, readingsBody)).json()
      const started = await u.call('POST', base(h), { ...readingsBody, planHash: readingsPlan.planHash })
      expect(started.statusCode, started.body).toBe(202)
      expect((await waitJob(h.t, started.json().job.id, 60_000)).state).toBe('done')
      const landed = await cb
        .db('app2')
        .collection('readings')
        .find({}, { hint: { $natural: 1 } })
        .toArray()
      expect(landed.map((d) => d._id)).toEqual([1, 2])
    } finally {
      await h.t.close()
    }
  }, 150_000)

  // Thirteenth review of explain masking (I-2, M-7): a collection's _ids a collation makes equal.
  it('refuses a masked copy whose collation makes a collection’s _ids equal', async () => {
    const h = await transferHarness(a, b)
    try {
      await ca
        .db('app')
        .collection('named')
        .insertMany([
          { _id: 'Bob' as never, t: 7, email: 'z@x' },
          { _id: 'bob' as never, t: 7, email: 'a@x' },
        ])
      await ca.db('app').collection('named').createIndex({ t: 1, email: 1 })
      h.rules('A', [{ db: 'app', coll: 'named', field: 'email' }])
      const u = h.user({ role: 'editor', masked: ['A'] })
      const url = `/api/connections/${h.ids.A}/databases/app/collections/named/copy`
      const body = {
        source: { kind: 'query', filter: { t: 7 }, collation: { locale: 'en', strength: 2 } },
        target: { connectionId: h.ids.B, db: 'app2', coll: 'named' },
        mode: 'insert',
        indexes: false,
        confirmPersonal: true,
      }
      const plan = await u.call('POST', `${url}/plan`, body)
      expect(plan.statusCode, plan.body).toBe(200)
      const res = await u.call('POST', url, { ...body, planHash: plan.json().planHash })
      expect(res.statusCode, res.body).toBe(202)
      const job = await waitJob(h.t, res.json().job.id, 60_000)
      expect(job.state).toBe('failed')
      expect(job.error).toMatch(/repeats/)
      expect(await cb.db('app2').collection('named').countDocuments()).toBe(0)
    } finally {
      await h.t.close()
    }
  }, 90_000)

  // Final review of explain masking (Minors 1, 2): MongoDB changes no single document of a time
  // series; a copy by key into one is refused in its plan, a database copy leaves it out.
  it('refuses a copy by key into a time series, and leaves one out of a database copy', async () => {
    const h = await transferHarness(a, b)
    try {
      await cb.db('app2').createCollection('ts', { timeseries: { timeField: 't' } })
      const u = h.user({ role: 'editor' })
      const one = await u.call(
        'POST',
        `/api/connections/${h.ids.A}/databases/app/collections/orders/copy/plan`,
        {
          source: { kind: 'collection' },
          target: { connectionId: h.ids.B, db: 'app2', coll: 'ts' },
          mode: 'upsert',
        },
      )
      expect(one.statusCode, one.body).toBe(409)
      expect(one.json()).toMatchObject({ details: { reason: 'target_timeseries', collection: 'ts' } })
      // Nor a replace: its copy cannot be renamed over one (measured on 8.2; final review, I-1).
      const replace = await u.call(
        'POST',
        `/api/connections/${h.ids.A}/databases/app/collections/orders/copy/plan`,
        {
          source: { kind: 'collection' },
          target: { connectionId: h.ids.B, db: 'app2', coll: 'ts' },
          mode: 'replace',
        },
      )
      expect(replace.statusCode, replace.body).toBe(409)
      // The target is the series: copied into with inserts, or elsewhere (review of the side channels, M-4).
      expect(replace.json()).toMatchObject({
        details: { reason: 'replace_into_timeseries', collection: 'ts' },
      })
      // The source's series "metrics", to be created as one: left out of an upsert copy.
      const all = await u.call('POST', `${base(h)}/plan`, {
        target: { connectionId: h.ids.B, db: 'app2' },
        mode: 'upsert',
      })
      expect(all.statusCode, all.body).toBe(200)
      const metrics = all.json().collections.find((c: { source: string }) => c.source === 'metrics')
      expect(metrics.skipped).toMatch(/time series/)
      const orders = all.json().collections.find((c: { source: string }) => c.source === 'orders')
      expect(orders.skipped).toBeUndefined()
      // A target recreated as another kind since the plan is another plan (final review, M-3).
      await cb.db('app2').createCollection('orders')
      const before = await u.call('POST', `${base(h)}/plan`, {
        target: { connectionId: h.ids.B, db: 'app2' },
        mode: 'upsert',
        confirmTtl: true,
      })
      await cb.db('app2').dropCollection('orders')
      await cb.db('app2').createCollection('orders', { timeseries: { timeField: 't' } })
      const start = await u.call('POST', base(h), {
        target: { connectionId: h.ids.B, db: 'app2' },
        mode: 'upsert',
        confirmTtl: true,
        planHash: before.json().planHash,
      })
      expect(start.statusCode, start.body).toBe(409)
      expect(start.json().details.reason).toBe('plan_changed')
    } finally {
      await h.t.close()
    }
  }, 90_000)

  // Final reviews of explain masking (I-1, M-1): a replace fills a staging collection and renames it
  // into place; MongoDB renames no time series (measured on 8.2): a series source is left out of a
  // database replace, which goes on with the rest.
  it('leaves a time series out of a database replace copy', async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user({ role: 'editor' })
      const body = { target: { connectionId: h.ids.B, db: 'app2' }, mode: 'replace', confirmTtl: true }
      const plan = await u.call('POST', `${base(h)}/plan`, body)
      expect(plan.statusCode, plan.body).toBe(200)
      const metrics = plan.json().collections.find((c: { source: string }) => c.source === 'metrics')
      expect(metrics.skipped).toMatch(/time series/)
      const res = await u.call('POST', base(h), { ...body, planHash: plan.json().planHash })
      expect(res.statusCode, res.body).toBe(202)
      const job = await waitJob(h.t, res.json().job.id, 60_000)
      expect(job.state, job.error ?? '').toBe('done')
      expect(await cb.db('app2').listCollections({ name: 'metrics' }).toArray()).toEqual([])
      expect(await cb.db('app2').collection('orders').countDocuments()).toBe(1)
      // A collection copy of the series by replace: refused, naming the series; with its options left
      // out it is a plain collection, staged and renamed as any (final review, M-1, M-2).
      const url = `/api/connections/${h.ids.A}/databases/app/collections/metrics/copy/plan`
      const kept = await u.call('POST', url, {
        source: { kind: 'collection' },
        target: { connectionId: h.ids.B, db: 'app2', coll: 'm2' },
        mode: 'replace',
      })
      expect(kept.statusCode, kept.body).toBe(409)
      expect(kept.json()).toMatchObject({ details: { reason: 'replace_timeseries', collection: 'metrics' } })
      const plain = await u.call('POST', url, {
        source: { kind: 'collection' },
        target: { connectionId: h.ids.B, db: 'app2', coll: 'm2' },
        mode: 'replace',
        options: false,
      })
      expect(plain.statusCode, plain.body).toBe(200)
      // A database replace whose plain source's target is a series: that pair left out.
      await cb.db('app2').dropCollection('orders')
      await cb.db('app2').createCollection('orders', { timeseries: { timeField: 'at' } })
      const over = await u.call('POST', `${base(h)}/plan`, body)
      const orders = over.json().collections.find((c: { source: string }) => c.source === 'orders')
      expect(orders.skipped).toMatch(/time series/)
      // A pair left out asks for nothing: orders' TTL is not to be confirmed (final review, nit).
      const unconfirmed = await u.call('POST', `${base(h)}/plan`, { ...body, confirmTtl: false })
      expect(unconfirmed.json().refusals).not.toContain('confirm_ttl')
    } finally {
      await h.t.close()
    }
  }, 90_000)

  // Review of the agent's gate (M-4): a database copy leaves out a collection whose indexes cannot be
  // read (a target restricted for its user), as its other refusals, and copies the rest.
  it('leaves out a collection whose target indexes cannot be read, and copies the rest', async () => {
    const h = await transferHarness(a, b)
    try {
      // A rule on a field the records do not hold: they reach the unique indexes' check.
      h.rules('B', [{ db: 'app4', coll: 'orders', field: 'phone' }])
      const u = h.user({ role: 'editor', masked: ['B'] })
      const body = {
        target: { connectionId: h.ids.B, db: 'app4' },
        mode: 'insert',
        confirmTtl: true,
        confirmPersonal: true,
        collections: ['orders', 'metrics'],
      }
      const plan = await u.call('POST', `${base(h)}/plan`, body)
      expect(plan.statusCode, plan.body).toBe(200)
      expect(plan.json().refusals).toEqual([])
      const listIndexes = Collection.prototype.listIndexes
      vi.spyOn(Collection.prototype, 'listIndexes').mockImplementation(function (
        this: Collection,
        ...args: unknown[]
      ) {
        if (this.dbName === 'app4' && this.collectionName === 'orders')
          return {
            toArray: () => Promise.reject(new MongoServerError({ message: 'not authorized', code: 13 })),
          } as never
        return listIndexes.apply(this, args as never)
      } as typeof listIndexes)
      const res = await u.call('POST', base(h), { ...body, planHash: plan.json().planHash })
      expect(res.statusCode, res.body).toBe(202)
      const job = await waitJob(h.t, res.json().job.id, 60_000)
      expect(job.state, job.error ?? '').toBe('done')
      const report = (await u.get(`/api/transfer/jobs/${job.id}/report`)).json() as {
        collections: Array<{ source: string; failure?: string }>
      }
      expect(report.collections.find((c) => c.source === 'orders')?.failure).toMatch(/indexes cannot be read/)
      expect(await cb.db('app4').collection('metrics').countDocuments()).toBe(1)
      // Nothing left behind for it: refused before it was made (next round, M-C).
      expect(await cb.db('app4').listCollections({ name: 'orders' }).toArray()).toEqual([])
      // A dry run says the same of an existing target whose indexes cannot be read (next round, M-4).
      await cb
        .db('app4')
        .collection('orders')
        .insertOne({ _id: 9 as never, v: 9 })
      const dryBody = { ...body, dryRun: true }
      const dryPlan = await u.call('POST', `${base(h)}/plan`, dryBody)
      expect(dryPlan.statusCode, dryPlan.body).toBe(200)
      const dryRes = await u.call('POST', base(h), { ...dryBody, planHash: dryPlan.json().planHash })
      const dryJob = await waitJob(h.t, dryRes.json().job.id, 60_000)
      expect(dryJob.state, dryJob.error ?? '').toBe('done')
      const dryReport = (await u.get(`/api/transfer/jobs/${dryJob.id}/report`)).json() as {
        collections: Array<{ source: string; failure?: string }>
      }
      expect(dryReport.collections.find((c) => c.source === 'orders')?.failure).toMatch(
        /indexes cannot be read/,
      )
      // A server's own failure there stops the copy, nothing made for it (next round, M-5).
      vi.restoreAllMocks()
      h.rules('B', [{ db: 'app5', coll: 'orders', field: 'phone' }])
      const body5 = { ...body, target: { connectionId: h.ids.B, db: 'app5' } }
      const plan5 = await u.call('POST', `${base(h)}/plan`, body5)
      expect(plan5.statusCode, plan5.body).toBe(200)
      vi.spyOn(Collection.prototype, 'listIndexes').mockImplementation(function (
        this: Collection,
        ...args: unknown[]
      ) {
        if (this.dbName === 'app5' && this.collectionName === 'orders')
          return {
            toArray: () =>
              Promise.reject(new MongoServerError({ message: 'interrupted at shutdown', code: 91 })),
          } as never
        return listIndexes.apply(this, args as never)
      } as typeof listIndexes)
      const res5 = await u.call('POST', base(h), { ...body5, planHash: plan5.json().planHash })
      const job5 = await waitJob(h.t, res5.json().job.id, 60_000)
      expect(job5.state).toBe('failed')
      expect(job5.error ?? '').toMatch(/interrupted at shutdown/)
      expect(await cb.db('app5').listCollections({ name: 'orders' }).toArray()).toEqual([])
    } finally {
      vi.restoreAllMocks()
      await cb.db('app4').dropDatabase()
      await cb.db('app5').dropDatabase()
      await h.t.close()
    }
  }, 300_000)

  // Next round of the agent's gate (I-1): a target-restricted database copy leaves out a GridFS
  // bucket's chunks the gate refuses there, and copies the rest.
  it('leaves out a bucket’s chunks for a user restricted on the target where a rule reaches it, and copies the rest', async () => {
    const h = await transferHarness(a, b)
    try {
      await ca.db('gfs').dropDatabase()
      await ca
        .db('gfs')
        .collection('fs.files')
        .insertOne({ _id: 1 as never, filename: 'a.txt', length: 1 })
      await ca
        .db('gfs')
        .collection('fs.chunks')
        .insertOne({ files_id: 1, n: 0, data: 'x' } as never)
      await ca.db('gfs').collection('notes').insertOne({ n: 1 })
      h.rules('B', [{ db: 'gfs2', coll: 'notes', field: 'secret' }])
      const u = h.user({ role: 'editor', masked: ['B'] })
      const body = {
        target: { connectionId: h.ids.B, db: 'gfs2' },
        mode: 'insert',
        confirmTtl: true,
        confirmPersonal: true,
      }
      const gbase = `/api/connections/${h.ids.A}/databases/gfs/copy`
      // User report 2026-10-27: a rule on another collection of the target leaves its bucket free.
      const free = (await u.call('POST', `${gbase}/plan`, body)).json().collections as Array<{
        source: string
        skipped?: string
      }>
      expect(free.filter((c) => c.skipped)).toEqual([])
      h.rules('B', [
        { db: 'gfs2', coll: 'notes', field: 'secret' },
        { db: 'gfs2', coll: 'fs.files', field: 'metadata.owner' },
      ])
      const plan = await u.call('POST', `${gbase}/plan`, body)
      expect(plan.statusCode, plan.body).toBe(200)
      const res = await u.call('POST', gbase, { ...body, planHash: plan.json().planHash })
      expect(res.statusCode, res.body).toBe(202)
      const job = await waitJob(h.t, res.json().job.id, 60_000)
      expect(job.state, job.error ?? '').toBe('done')
      const report = (await u.get(`/api/transfer/jobs/${job.id}/report`)).json() as {
        collections: Array<{ source: string; failure?: string }>
      }
      expect(report.collections.find((c) => c.source === 'fs.chunks')?.failure).toBeTruthy()
      expect(await cb.db('gfs2').collection('notes').countDocuments()).toBe(1)
      expect(await cb.db('gfs2').listCollections({ name: 'fs.chunks' }).toArray()).toEqual([])
      // The bucket is left out whole, its files with its contents, and the plan says so (next round, I-1).
      expect(await cb.db('gfs2').listCollections({ name: 'fs.files' }).toArray()).toEqual([])
      const shown = plan.json().collections as Array<{ source: string; skipped?: string }>
      expect(
        shown
          .filter((c) => c.skipped)
          .map((c) => c.source)
          .sort(),
      ).toEqual(['fs.chunks', 'fs.files'])
      // Said as the target's rules, not as a mask (next round, nit).
      expect(shown.find((c) => c.source === 'fs.files')?.skipped).toMatch(/target's rules/)
    } finally {
      await ca.db('gfs').dropDatabase()
      await cb.db('gfs2').dropDatabase()
      await h.t.close()
    }
  }, 90_000)

  // Review of the agent's gate (M-2): a replace whose staged copy is dropped when it fails reports
  // none of it as written.
  it('reports nothing written of a replace whose staged copy a failure drops', async () => {
    const h = await transferHarness(a, b)
    try {
      await ca.db('stg').dropDatabase()
      await ca
        .db('stg')
        .collection('rows')
        .insertMany(Array.from({ length: 1500 }, (_, i) => ({ n: i })))
      await cb.db('stg2').collection('rows').insertOne({ kept: true })
      const u = h.user({ role: 'admin' })
      const url = `/api/connections/${h.ids.A}/databases/stg/collections/rows/copy`
      const body = {
        source: { kind: 'collection' },
        target: { connectionId: h.ids.B, db: 'stg2', coll: 'rows' },
        mode: 'replace',
      }
      const plan = await u.call('POST', `${url}/plan`, body)
      expect(plan.statusCode, plan.body).toBe(200)
      const bulkWrite = Collection.prototype.bulkWrite
      const insertMany = Collection.prototype.insertMany
      let writes = 0
      const failSecond = function (
        this: Collection,
        original: (this: Collection, ...a: never[]) => unknown,
        args: unknown[],
      ) {
        if (this.dbName === 'stg2' && this.collectionName !== 'rows' && ++writes === 2)
          return Promise.reject(new MongoServerError({ message: 'interrupted at shutdown', code: 91 }))
        return original.apply(this, args as never[])
      }
      vi.spyOn(Collection.prototype, 'bulkWrite').mockImplementation(function (
        this: Collection,
        ...args: unknown[]
      ) {
        return failSecond.call(this, bulkWrite, args) as never
      } as typeof bulkWrite)
      vi.spyOn(Collection.prototype, 'insertMany').mockImplementation(function (
        this: Collection,
        ...args: unknown[]
      ) {
        return failSecond.call(this, insertMany, args) as never
      } as typeof insertMany)
      const res = await u.call('POST', url, { ...body, planHash: plan.json().planHash })
      expect(res.statusCode, res.body).toBe(202)
      const job = await waitJob(h.t, res.json().job.id, 60_000)
      expect(job.state).toBe('failed')
      const report = (await u.get(`/api/transfer/jobs/${job.id}/report`)).json() as {
        collections: Array<{ inserted: number }>
      }
      expect(writes).toBeGreaterThanOrEqual(2)
      expect(report.collections[0]).toMatchObject({ inserted: 0 })
      expect(
        await cb
          .db('stg2')
          .collection('rows')
          .find({}, { projection: { _id: 0 } })
          .toArray(),
      ).toEqual([{ kept: true }])
    } finally {
      vi.restoreAllMocks()
      await ca.db('stg').dropDatabase()
      await cb.db('stg2').dropDatabase()
      await h.t.close()
    }
  }, 180_000)

  // Final review of explain masking (I-1): a start adds the rules its plan showed, never a left-out pair's.
  it('adds no rule of a pair the copy leaves out', async () => {
    const h = await transferHarness(a, b)
    try {
      h.rules('A', [
        { db: 'app', coll: 'metrics', field: 'm' },
        { db: 'app', coll: 'orders', field: 'v' },
      ])
      const u = h.user({ role: 'admin' })
      const body = {
        target: { connectionId: h.ids.B, db: 'app2' },
        mode: 'replace',
        confirmTtl: true,
        addRulesToTarget: true,
      }
      const plan = await u.call('POST', `${base(h)}/plan`, body)
      expect(plan.statusCode, plan.body).toBe(200)
      const res = await u.call('POST', base(h), { ...body, planHash: plan.json().planHash })
      expect(res.statusCode, res.body).toBe(202)
      await waitJob(h.t, res.json().job.id, 60_000)
      const added = h.ctx.personalFields.stored(h.ids.B).rules
      expect(added.map((r) => `${r.db}.${r.coll}.${r.field}`)).toEqual(['app2.orders.v'])
    } finally {
      await h.t.close()
    }
  }, 90_000)

  // Final review of explain masking (M-1): the refusal names the view.
  it('refuses a database copy onto a view, naming it', async () => {
    const h = await transferHarness(a, b)
    try {
      await cb.db('app2').createCollection('base')
      await cb.db('app2').createCollection('orders', { viewOn: 'base', pipeline: [] })
      const u = h.user({ role: 'editor' })
      const res = await u.call('POST', `${base(h)}/plan`, {
        target: { connectionId: h.ids.B, db: 'app2' },
        mode: 'insert',
      })
      expect(res.statusCode, res.body).toBe(409)
      expect(res.json()).toMatchObject({ details: { reason: 'target_is_view', collection: 'orders' } })
    } finally {
      await h.t.close()
    }
  }, 90_000)

  // Eighteenth review (I-2): a query's collation is the question's too.
  it('refuses a masked copy of a series whose _ids are alike by the query’s collation', async () => {
    const h = await transferHarness(a, b)
    try {
      await ca.db('app').createCollection('cased', { timeseries: { timeField: 'at', metaField: 'meta' } })
      await ca
        .db('app')
        .collection('cased')
        .insertMany([
          { _id: 'a' as never, at: new Date(1), meta: { email: 'b@x' } },
          { _id: 'A' as never, at: new Date(2), meta: { email: 'a@x' } },
        ])
      h.rules('A', [{ db: 'app', coll: 'cased', field: 'meta.email' }])
      const u = h.user({ role: 'editor', masked: ['A'] })
      const url = `/api/connections/${h.ids.A}/databases/app/collections/cased/copy`
      const body = {
        source: { kind: 'query', filter: {}, collation: { locale: 'en', strength: 2 } },
        target: { connectionId: h.ids.B, db: 'app2', coll: 'cased' },
        mode: 'insert',
        indexes: false,
        confirmPersonal: true,
      }
      const plan = await u.call('POST', `${url}/plan`, body)
      expect(plan.statusCode, plan.body).toBe(200)
      const res = await u.call('POST', url, { ...body, planHash: plan.json().planHash })
      expect(res.statusCode, res.body).toBe(202)
      const job = await waitJob(h.t, res.json().job.id, 60_000)
      // A copy of one collection fails as a whole, asked before anything was made (tenth review).
      expect(job.state).toBe('failed')
      expect(job.error).toMatch(/repeats/)
      expect(await cb.db('app2').listCollections({ name: 'cased' }).toArray()).toEqual([])
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('copies only the chosen collections, and refuses system databases', async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user({ role: 'editor' })
      const body = {
        target: { connectionId: h.ids.B, db: 'app2' },
        mode: 'insert',
        collections: ['orders'],
        views: false,
        indexes: false,
      }
      const plan = (await u.call('POST', `${base(h)}/plan`, body)).json()
      expect(plan.collections.map((c: { source: string }) => c.source)).toEqual(['orders'])
      expect(plan.views).toEqual([])
      const missing = { ...body, collections: ['nope'] }
      expect((await u.call('POST', `${base(h)}/plan`, missing)).statusCode).toBe(404)
      const admin = h.user({ role: 'admin' })
      const sys = { ...body, target: { connectionId: h.ids.B, db: 'config' } }
      expect((await admin.call('POST', `${base(h)}/plan`, sys)).statusCode).toBe(403)
      const fromAdmin = `/api/connections/${h.ids.A}/databases/admin/copy/plan`
      expect((await admin.call('POST', fromAdmin, { ...body, collections: undefined })).statusCode).toBe(403)
    } finally {
      await h.t.close()
    }
  })

  it('reports a view whose pipeline runs JavaScript as not created', async () => {
    const h = await transferHarness(a, b)
    try {
      await ca.db('app').createCollection('vjs', {
        viewOn: 'orders',
        pipeline: [
          { $match: { $expr: { $function: { body: 'function() { return true }', args: [], lang: 'js' } } } },
        ],
      })
      const u = h.user({ role: 'editor' })
      const body = { target: { connectionId: h.ids.B, db: 'app2' }, mode: 'insert', indexes: false }
      const plan = (await u.call('POST', `${base(h)}/plan`, body)).json()
      const res = await u.call('POST', base(h), { ...body, planHash: plan.planHash })
      const job = await waitJob(h.t, res.json().job.id, 60_000)
      const report = (await u.get(`/api/transfer/jobs/${job.id}/report`)).json()
      expect(report.views.find((v: { name: string }) => v.name === 'vjs')).toMatchObject({
        created: false,
        reason: expect.stringMatching(/JavaScript/),
      })
    } finally {
      await h.t.close()
    }
  }, 90_000)
})
