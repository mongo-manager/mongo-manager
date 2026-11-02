import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Collection, Db, Decimal128, Long, MongoClient, MongoServerError, type Document } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { transferHarness } from './support/transfer2'
import { waitJob } from './support/jobs'
import { TargetWriter } from '../src/transfer/target-writer'
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
  await Promise.all([
    ca.db('shop').dropDatabase(),
    ca.db('shop2').dropDatabase(),
    cb.db('copy').dropDatabase(),
  ])
  await ca
    .db('shop')
    .collection('orders')
    .insertMany(
      Array.from({ length: 2500 }, (_, i) => ({
        _id: i as never,
        email: `u${i}@x`,
        total: Decimal128.fromString(`${i}.50`),
        big: Long.fromString('9223372036854775807'),
        nested: { phone: `555-${i}`, city: 'Izmir' },
      })),
    )
})

const S = '/databases/shop/collections/orders'
type H = Awaited<ReturnType<typeof transferHarness>>

async function copy(h: H, u: ReturnType<H['user']>, body: object, path = S) {
  const url = `/api/connections/${h.ids.A}${path}/copy`
  const plan = await u.call('POST', `${url}/plan`, body)
  expect(plan.statusCode, plan.body).toBe(200)
  const res = await u.call('POST', url, { ...body, planHash: plan.json().planHash })
  expect(res.statusCode, res.body).toBe(202)
  const job = await waitJob(h.t, res.json().job.id, 60_000)
  const report = (await u.get(`/api/transfer/jobs/${job.id}/report`)).json()
  return { job, report }
}

describe('copy job, streamed (phase 3d-2 spec §7.2)', () => {
  // Data review 2026-10-13 (M5): a replace takes the target's place only when every document was
  // copied; and the source's validator is set after the load, so the documents already stored that
  // predate it are copied too, as MongoDB's own copy does.
  // Review of the data fixes (I2): a readWrite user cannot change a validator afterwards. The copy
  // then sets it before the load, as it did, and says so: what it refuses is not copied.
  it('sets the validator first, saying so, where the target user may not change it', async () => {
    const h = await transferHarness(a, b)
    const command = Db.prototype.command
    const spy = vi.spyOn(Db.prototype, 'command').mockImplementation(function (
      this: Db,
      cmd: Document,
      ...rest
    ) {
      if ('collMod' in cmd)
        return Promise.reject(
          new MongoServerError({ code: 13, codeName: 'Unauthorized', errmsg: 'not authorized' }),
        )
      return command.call(this, cmd, ...(rest as []))
    } as typeof command)
    try {
      const u = h.user({ role: 'editor' })
      const src = ca.db('shop2')
      await src.collection('v').insertMany([
        { _id: 1, n: 'one' },
        { _id: 2, n: 2 },
      ] as never)
      await command.call(src, {
        collMod: 'v',
        validator: { $jsonSchema: { properties: { n: { bsonType: 'string' } } } },
      })
      const done = await copy(
        h,
        u,
        {
          source: { kind: 'collection' },
          target: { connectionId: h.ids.B, db: 'copy', coll: 'v' },
          mode: 'insert',
        },
        '/databases/shop2/collections/v',
      )
      expect(done.job.state, done.job.error ?? '').toBe('done')
      expect(done.report.collections[0]).toMatchObject({ inserted: 1, failed: 1, validatorBeforeLoad: true })
      const [info] = await cb.db('copy').listCollections({ name: 'v' }).toArray()
      expect((info as { options: { validator?: unknown } }).options.validator).toBeTruthy()
    } finally {
      spy.mockRestore()
      await h.t.close()
    }
  }, 90_000)

  // Review of the data fixes (I3): a new collection keeps the source's validator when its copy
  // fails or stops part way — what is in it was copied.
  it('gives a new collection its validator when the copy fails part way', async () => {
    const h = await transferHarness(a, b)
    const spy = vi
      .spyOn(Collection.prototype, 'bulkWrite')
      .mockRejectedValue(new Error('the network went away'))
    try {
      const u = h.user({ role: 'editor' })
      const src = ca.db('shop2')
      await src.createCollection('s', {
        validator: { $jsonSchema: { properties: { n: { bsonType: 'int' } } } },
      })
      await src.collection('s').insertOne({ _id: 1, n: 1 } as never)
      const failed = await copy(
        h,
        u,
        {
          source: { kind: 'collection' },
          target: { connectionId: h.ids.B, db: 'copy', coll: 's' },
          mode: 'insert',
        },
        '/databases/shop2/collections/s',
      )
      expect(failed.job.state).toBe('failed')
      const [info] = await cb.db('copy').listCollections({ name: 's' }).toArray()
      expect((info as { options: { validator?: unknown } }).options.validator).toBeTruthy()
    } finally {
      spy.mockRestore()
      await h.t.close()
    }
  }, 90_000)

  // Review of the data fixes (Minor 8): MongoDB's own copy (one server) into a new collection by
  // upsert sets the validator after the load too.
  it('upserts into a new collection on one server, the validator set after', async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user({ role: 'editor' })
      const src = ca.db('shop2')
      await src.collection('o').insertMany([
        { _id: 1, n: 'one' },
        { _id: 2, n: 2 },
      ] as never)
      await src.command({
        collMod: 'o',
        validator: { $jsonSchema: { properties: { n: { bsonType: 'string' } } } },
      })
      const done = await copy(
        h,
        u,
        {
          source: { kind: 'collection' },
          target: { connectionId: h.ids.A, db: 'shop5', coll: 'o' },
          mode: 'upsert',
        },
        '/databases/shop2/collections/o',
      )
      expect(done.job.state, done.job.error ?? '').toBe('done')
      expect(await ca.db('shop5').collection('o').countDocuments()).toBe(2)
      const [info] = await ca.db('shop5').listCollections({ name: 'o' }).toArray()
      expect((info as { options: { validator?: unknown } }).options.validator).toBeTruthy()
    } finally {
      await ca.db('shop5').dropDatabase()
      await h.t.close()
    }
  }, 90_000)

  it('replaces the target only with a whole copy, the validator set after the load', async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user({ role: 'editor' })
      const src = ca.db('shop2')
      await src.collection('v').insertMany([
        { _id: 1, n: 'one' },
        { _id: 2, n: 2 },
      ] as never)
      await src.command({
        collMod: 'v',
        validator: { $jsonSchema: { properties: { n: { bsonType: 'string' } } } },
      })
      await cb
        .db('copy')
        .collection('v')
        .insertOne({ _id: 'kept' } as never)
      const whole = await copy(
        h,
        u,
        {
          source: { kind: 'collection' },
          target: { connectionId: h.ids.B, db: 'copy', coll: 'v' },
          mode: 'replace',
        },
        '/databases/shop2/collections/v',
      )
      expect(whole.job.state, whole.job.error ?? '').toBe('done')
      expect(await cb.db('copy').collection('v').countDocuments()).toBe(2)
      const [info] = await cb.db('copy').listCollections({ name: 'v' }).toArray()
      expect((info as { options: { validator?: unknown } }).options.validator).toBeTruthy()

      // Two documents of one _id (an $unwind): one is refused, so the target stays as it was.
      await cb
        .db('copy')
        .collection('w')
        .insertOne({ _id: 'kept' } as never)
      await src.collection('w').insertOne({ _id: 1, tags: ['a', 'b'] } as never)
      const part = await copy(
        h,
        u,
        {
          source: { kind: 'pipeline', stages: [{ $unwind: '$tags' }] },
          target: { connectionId: h.ids.B, db: 'copy', coll: 'w' },
          mode: 'replace',
        },
        '/databases/shop2/collections/w',
      )
      expect(part.job.state).toBe('failed')
      expect(part.job.error).toContain('left as it was')
      expect(await cb.db('copy').collection('w').find().toArray()).toEqual([{ _id: 'kept' }])
    } finally {
      await h.t.close()
    }
  }, 180_000)

  // Data review 2026-10-13 round 2 (I4): with "stop", a refusal waits for the records before it to
  // be written — an empty key among them is the record it stops at, and nothing after it is lost
  // unreported.
  it('stops at the first refusal in order, an empty key in a batch still being written included', async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user({ role: 'editor' })
      await ca
        .db('shop2')
        .collection('items')
        .insertMany([
          { _id: 1, k: 'a' },
          { _id: 2 },
          { _id: 3, k: 'c' },
          { _id: 4, k: 'd', 'x.y': 1 },
        ] as never)
      const { report } = await copy(
        h,
        u,
        {
          source: { kind: 'collection' },
          target: { connectionId: h.ids.B, db: 'copy', coll: 'items' },
          mode: 'merge',
          keys: ['k'],
          onError: 'stop',
          indexes: false,
        },
        '/databases/shop2/collections/items',
      )
      expect(report.stoppedAt).toMatchObject({ record: 2 })
      expect(report.collections[0].errors.map((e: { record: number }) => e.record)).toEqual([2])
      expect(
        await cb
          .db('copy')
          .collection('items')
          .find({}, { projection: { _id: 0 } })
          .toArray(),
      ).toEqual([{ k: 'a' }])
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('copies a collection to another server keeping every BSON type', async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user({ role: 'editor' })
      const { job, report } = await copy(h, u, {
        source: { kind: 'collection' },
        target: { connectionId: h.ids.B, db: 'copy', coll: 'orders' },
        mode: 'insert',
        indexes: false,
      })
      expect(job.state, job.error ?? '').toBe('done')
      expect(job.targetConnectionId).toBe(h.ids.B)
      expect(report).toMatchObject({
        kind: 'copy',
        collections: [{ read: 2500, inserted: 2500, failed: 0, path: 'stream' }],
      })
      const doc = await cb
        .db('copy')
        .collection('orders')
        .findOne({ _id: 7 as never }, { promoteLongs: false })
      expect(doc!.total).toEqual(Decimal128.fromString('7.50'))
      expect(String(doc!.big)).toBe('9223372036854775807')
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('copies a query, merges into an existing target, and reports MongoDB refusals', async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user({ role: 'editor' })
      await cb
        .db('copy')
        .collection('orders')
        .insertOne({ _id: 1 as never, keep: true, nested: { zip: '35' } })
      await cb.db('copy').collection('orders').createIndex({ email: 1 }, { unique: true, sparse: true })
      await cb
        .db('copy')
        .collection('orders')
        .insertOne({ _id: 99_999 as never, email: 'u2@x' })
      const { report } = await copy(h, u, {
        source: { kind: 'query', filter: { _id: { $lt: 3 } } },
        target: { connectionId: h.ids.B, db: 'copy', coll: 'orders' },
        mode: 'merge',
        indexes: false,
      })
      expect(report.collections[0]).toMatchObject({ read: 3, matched: 1, upserted: 1, failed: 1 })
      expect(
        await cb
          .db('copy')
          .collection('orders')
          .findOne({ _id: 1 as never }),
      ).toMatchObject({
        keep: true,
        nested: { zip: '35', phone: '555-1', city: 'Izmir' },
      })
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('a dry run writes nothing and counts key matches', async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user({ role: 'editor' })
      await cb
        .db('copy')
        .collection('orders')
        .insertOne({ _id: 1 as never })
      const { report } = await copy(h, u, {
        source: { kind: 'collection' },
        target: { connectionId: h.ids.B, db: 'copy', coll: 'orders' },
        mode: 'upsert',
        indexes: false,
        dryRun: true,
      })
      expect(report).toMatchObject({ dryRun: true, collections: [{ read: 2500, wouldMatch: 1 }] })
      expect(await cb.db('copy').collection('orders').countDocuments()).toBe(1)
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('masks for a restricted source, and anonymises on request', async () => {
    const h = await transferHarness(a, b)
    try {
      h.rules('A', [
        { db: 'shop', coll: 'orders', field: 'email' },
        { db: 'shop', coll: 'orders', field: 'nested.phone' },
      ])
      h.rules('B', [
        { db: 'copy', coll: '*', field: 'email' },
        { db: 'copy', coll: '*', field: 'nested.phone' },
      ])
      const restricted = h.user({ role: 'editor', masked: ['A'] })
      const target = { connectionId: h.ids.B, db: 'copy', coll: 'masked' }
      const one = await copy(h, restricted, {
        source: { kind: 'collection' },
        target,
        mode: 'insert',
        indexes: false,
      })
      expect(one.report).toMatchObject({ masked: true })
      expect(
        await cb
          .db('copy')
          .collection('masked')
          .findOne({ _id: 3 as never }),
      ).toMatchObject({
        email: '***',
        nested: { phone: '***', city: 'Izmir' },
      })
      const free = h.user({ role: 'editor' })
      await copy(h, free, {
        source: { kind: 'collection' },
        target: { connectionId: h.ids.B, db: 'copy', coll: 'anon' },
        mode: 'insert',
        indexes: false,
        anonymous: true,
      })
      expect(
        (await cb
          .db('copy')
          .collection('anon')
          .findOne({ _id: 3 as never }))!.email,
      ).toBe('***')
    } finally {
      await h.t.close()
    }
  }, 180_000)

  it('needs the plan hash, refuses a changed plan, and refuses unconfirmed personal data', async () => {
    const h = await transferHarness(a, b)
    try {
      h.rules('A', [{ db: 'shop', coll: 'orders', field: 'email' }])
      const u = h.user({ role: 'editor' })
      const url = `/api/connections/${h.ids.A}${S}/copy`
      const body = {
        source: { kind: 'collection' },
        target: { connectionId: h.ids.B, db: 'copy', coll: 'orders' },
        mode: 'insert',
        indexes: false,
      }
      expect((await u.call('POST', url, body)).statusCode).toBe(400)
      const plan = (await u.call('POST', `${url}/plan`, body)).json()
      const refused = await u.call('POST', url, { ...body, planHash: plan.planHash })
      expect(refused.statusCode).toBe(409)
      expect(refused.json().details.reasons).toEqual(['confirm_personal'])
      const confirmed = { ...body, confirmPersonal: true }
      const plan2 = (await u.call('POST', `${url}/plan`, confirmed)).json()
      h.rules('B', [{ db: 'other', coll: 'x', field: 'y' }])
      const changed = await u.call('POST', url, { ...confirmed, planHash: plan2.planHash })
      expect(changed.json().details.reason).toBe('plan_changed')
    } finally {
      await h.t.close()
    }
  })
})

describe('copy job: collections, indexes, replace and the shortcut (phase 3d-2 spec §7.1, §7.3)', () => {
  it('creates the target with the source options and validator, and builds indexes after the data', async () => {
    const h = await transferHarness(a, b)
    try {
      await ca.db('shop').createCollection('capped', {
        capped: true,
        size: 1 << 20,
        validator: { total: { $exists: true } },
      })
      await ca.db('shop').collection('capped').insertOne({ total: 1, email: 'a' })
      await ca.db('shop').collection('capped').createIndex({ email: 1 }, { unique: true })
      const u = h.user({ role: 'editor' })
      const { job, report } = await copy(
        h,
        u,
        {
          source: { kind: 'collection' },
          target: { connectionId: h.ids.B, db: 'copy', coll: 'capped' },
          mode: 'insert',
        },
        '/databases/shop/collections/capped',
      )
      expect(job.state, job.error ?? '').toBe('done')
      const [info] = await cb.db('copy').listCollections({ name: 'capped' }, { nameOnly: false }).toArray()
      expect(info!.options).toMatchObject({ capped: true, validator: { total: { $exists: true } } })
      expect((await cb.db('copy').collection('capped').indexes()).map((i) => i.name)).toContain('email_1')
      expect(report.collections[0].indexes.built).toEqual(['email_1'])
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('replaces the target only when the copy completes, and leaves no staging', async () => {
    const h = await transferHarness(a, b)
    try {
      await cb
        .db('copy')
        .collection('orders')
        .insertOne({ _id: 'old' as never })
      const u = h.user({ role: 'editor' })
      const { job } = await copy(h, u, {
        source: { kind: 'collection' },
        target: { connectionId: h.ids.B, db: 'copy', coll: 'orders' },
        mode: 'replace',
        indexes: false,
      })
      expect(job.state, job.error ?? '').toBe('done')
      expect(await cb.db('copy').collection('orders').countDocuments()).toBe(2500)
      expect(
        await cb
          .db('copy')
          .collection('orders')
          .findOne({ _id: 'old' as never }),
      ).toBeNull()
      expect(
        (
          await cb
            .db('copy')
            .listCollections({ name: /^mm_copy_/ })
            .toArray()
        ).length,
      ).toBe(0)
      expect(h.ctx.jobs.get(job.id)!.staging).toBeNull()
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('a failed replace leaves the target as it was and drops its staging', async () => {
    const h = await transferHarness(a, b)
    try {
      await cb
        .db('copy')
        .collection('orders')
        .insertOne({ _id: 'old' as never })
      // The second batch fails as if MongoDB had gone away.
      const real = TargetWriter.prototype.write
      let calls = 0
      vi.spyOn(TargetWriter.prototype, 'write').mockImplementation(function (this: TargetWriter, batch) {
        if (++calls === 2) return Promise.reject(new Error('connection lost'))
        return real.call(this, batch)
      })
      const u = h.user({ role: 'editor' })
      const { job } = await copy(h, u, {
        source: { kind: 'collection' },
        target: { connectionId: h.ids.B, db: 'copy', coll: 'orders' },
        mode: 'replace',
        indexes: false,
      })
      expect(job.state).toBe('failed')
      expect(await cb.db('copy').collection('orders').countDocuments()).toBe(1)
      expect(
        (
          await cb
            .db('copy')
            .listCollections({ name: /^mm_copy_/ })
            .toArray()
        ).length,
      ).toBe(0)
      expect(h.ctx.jobs.get(job.id)!.staging).toBeNull()
    } finally {
      vi.restoreAllMocks()
      await h.t.close()
    }
  }, 90_000)

  // Review of the data fixes (C1): "update only" with Upsert took the $merge shortcut, which inserts
  // whatever matches nothing. It copies record by record, and inserts nothing new.
  it('never inserts with "update only", on one connection or across two', async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user({ role: 'editor' })
      for (const [connectionId, client] of [
        [h.ids.A, ca],
        [h.ids.B, cb],
      ] as const) {
        await client.db('shop2').dropDatabase()
        await client
          .db('shop2')
          .collection('known')
          .insertMany([
            { _id: 1, email: 'old' },
            { _id: 2, email: 'old' },
          ] as never)
        const body = {
          source: { kind: 'collection' },
          target: { connectionId, db: 'shop2', coll: 'known' },
          mode: 'upsert',
          updateOnly: true,
          indexes: false,
        }
        const url = `/api/connections/${h.ids.A}${S}/copy`
        const plan = (await u.call('POST', `${url}/plan`, body)).json()
        expect(plan.collections[0].path).not.toBe('shortcut')
        const res = await u.call('POST', url, { ...body, planHash: plan.planHash })
        const job = await waitJob(h.t, res.json().job.id, 60_000)
        expect(job.state, job.error ?? '').toBe('done')
        const known = client.db('shop2').collection('known')
        expect(await known.countDocuments()).toBe(2)
        expect(await known.findOne({ _id: 1 as never })).toMatchObject({ email: 'u1@x' })
        const report = (await u.get(`/api/transfer/jobs/${job.id}/report`)).json()
        // Every record is accounted for: two matched, the rest skipped (review I3).
        expect(report.collections[0]).toMatchObject({ read: 2500, matched: 2, skipped: 2498, failed: 0 })
      }
    } finally {
      await ca.db('shop2').dropDatabase()
      await cb.db('shop2').dropDatabase()
      await h.t.close()
    }
  }, 180_000)

  it('copies inside the server on one connection, with $out and $merge, and reports the path', async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user({ role: 'editor' })
      for (const mode of ['insert', 'replace', 'upsert'] as const) {
        const body = {
          source: { kind: 'collection' },
          target: { connectionId: h.ids.A, db: 'shop2', coll: 'fresh' },
          mode,
          indexes: false,
        }
        const url = `/api/connections/${h.ids.A}${S}/copy`
        const plan = (await u.call('POST', `${url}/plan`, body)).json()
        expect(plan.collections[0].path).toBe('shortcut')
        const res = await u.call('POST', url, { ...body, planHash: plan.planHash })
        const job = await waitJob(h.t, res.json().job.id, 60_000)
        expect(job.state, job.error ?? '').toBe('done')
        const report = (await u.get(`/api/transfer/jobs/${job.id}/report`)).json()
        expect(report.collections[0]).toMatchObject({ path: 'shortcut', read: 2500, failed: 0 })
      }
      expect(await ca.db('shop2').collection('fresh').countDocuments()).toBe(2500)
      expect(
        (
          await ca
            .db('shop2')
            .listCollections({ name: /^mm_copy_/ })
            .toArray()
        ).length,
      ).toBe(0)
    } finally {
      await h.t.close()
    }
  }, 240_000)
})
