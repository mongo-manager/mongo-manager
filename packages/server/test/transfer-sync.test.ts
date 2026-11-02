import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Collection, MongoClient, MongoServerError } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { transferHarness } from './support/transfer2'
import { waitJob } from './support/jobs'
import { driverWrapped } from './support/driver-wrap'
import { READ_OPTIONS } from '../src/data/ejson-io'
import { keepTargetValues, pinnedReplace } from '../src/transfer/sync-job'
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
  await Promise.all([ca.db('shop').dropDatabase(), cb.db('shop').dropDatabase()])
  await ca
    .db('shop')
    .collection('orders')
    .insertMany([
      { _id: 1 as never, v: 1 },
      { _id: 2 as never, v: 2 },
      { _id: 3 as never, v: 3 },
    ])
  await cb
    .db('shop')
    .collection('orders')
    .insertMany([
      { _id: 2 as never, v: 9 },
      { _id: 3 as never, v: 3 },
      { _id: 4 as never, v: 4 },
    ])
})

type H = Awaited<ReturnType<typeof transferHarness>>
type U = ReturnType<H['user']>

async function compared(h: H, u: U) {
  const res = await u.call('POST', `/api/connections/${h.ids.A}/databases/shop/collections/orders/compare`, {
    target: { connectionId: h.ids.B, db: 'shop', coll: 'orders' },
  })
  expect(res.statusCode, res.body).toBe(202)
  return (await waitJob(h.t, res.json().job.id, 60_000)).id
}

async function sync(h: H, u: U, body: object) {
  const res = await u.call('POST', '/api/transfer/sync', body)
  if (res.statusCode !== 202) return { status: res.statusCode, body: res.json() }
  const job = await waitJob(h.t, res.json().job.id, 60_000)
  return { status: 202, job, report: (await u.get(`/api/transfer/jobs/${job.id}/report`)).json() }
}

describe('sync (phase 3d-2 spec §6.4)', () => {
  it('inserts the missing, replaces the different, and deletes the extra only when asked and confirmed', async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user({ role: 'editor' })
      const id = await compared(h, u)
      expect((await sync(h, u, { compareJobId: id, delete: true })).status).toBe(400)
      expect((await sync(h, u, { compareJobId: id, delete: true, confirm: 'wrong' })).status).toBe(400)
      const done = await sync(h, u, { compareJobId: id, delete: true, confirm: 'orders' })
      expect(done.job!.state, done.job!.error ?? '').toBe('done')
      expect(done.job!.targetConnectionId).toBe(h.ids.B)
      expect(done.report.collections[0]).toMatchObject({
        inserted: 1,
        replaced: 1,
        deleted: 1,
        changedMeanwhile: 0,
      })
      expect(await cb.db('shop').collection('orders').find().sort({ _id: 1 }).toArray()).toEqual([
        { _id: 1, v: 1 },
        { _id: 2, v: 2 },
        { _id: 3, v: 3 },
      ])
    } finally {
      await h.t.close()
    }
  }, 180_000)

  // Review of the agent's gate (M-3): a restricted target whose indexes cannot be read stops the sync
  // once, as it would refuse each document alike.
  it('stops once where a restricted target’s indexes cannot be read', async () => {
    const h = await transferHarness(a, b)
    try {
      h.rules('B', [{ db: 'shop', coll: 'orders', field: 'phone' }])
      const u = h.user({ role: 'editor', masked: ['B'] })
      const id = await compared(h, u)
      const listIndexes = Collection.prototype.listIndexes
      vi.spyOn(Collection.prototype, 'listIndexes').mockImplementation(function (
        this: Collection,
        ...args: unknown[]
      ) {
        if (this.dbName === 'shop' && this.collectionName === 'orders')
          return {
            toArray: () => Promise.reject(new MongoServerError({ message: 'not authorized', code: 13 })),
          } as never
        return listIndexes.apply(this, args as never)
      } as typeof listIndexes)
      const done = await sync(h, u, { compareJobId: id })
      expect(done.job!.state).toBe('failed')
      expect(done.job!.error ?? '').toMatch(/indexes cannot be read/)
      // Stopped as a whole, not one document failed after another.
      expect(done.report.collections[0]).toMatchObject({ failed: 0, replaced: 0, inserted: 0 })
      // A server's own failure stops it too, said as itself (next round, M-A).
      vi.restoreAllMocks()
      vi.spyOn(Collection.prototype, 'listIndexes').mockImplementation(function (
        this: Collection,
        ...args: unknown[]
      ) {
        if (this.dbName === 'shop' && this.collectionName === 'orders')
          return {
            toArray: () =>
              Promise.reject(new MongoServerError({ message: 'interrupted at shutdown', code: 91 })),
          } as never
        return listIndexes.apply(this, args as never)
      } as typeof listIndexes)
      const again = await sync(h, u, { compareJobId: await compared(h, u) })
      expect(again.job!.state).toBe('failed')
      expect(again.job!.error ?? '').toMatch(/interrupted at shutdown/)
      expect(again.report.collections[0]).toMatchObject({ failed: 0 })
      expect(await cb.db('shop').collection('orders').find().sort({ _id: 1 }).toArray()).toEqual([
        { _id: 2, v: 9 },
        { _id: 3, v: 3 },
        { _id: 4, v: 4 },
      ])
    } finally {
      vi.restoreAllMocks()
      await h.t.close()
    }
  }, 300_000)

  // Next round of the agent's gate (M-A): a server's own failure on a replacement stops the sync,
  // not one document failed after another.
  it('stops on a server failure while it replaces', async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user({ role: 'editor' })
      const id = await compared(h, u)
      vi.spyOn(Collection.prototype, 'replaceOne').mockRejectedValue(
        new MongoServerError({ message: 'interrupted at shutdown', code: 91 }),
      )
      const done = await sync(h, u, { compareJobId: id })
      expect(done.job!.state).toBe('failed')
      expect(done.job!.error ?? '').toMatch(/interrupted at shutdown/)
      expect(done.report.collections[0]).toMatchObject({ failed: 0, replaced: 0 })
    } finally {
      vi.restoreAllMocks()
      await h.t.close()
    }
  }, 180_000)

  // Final review of the validation details (Minor 6): a sync's report names the rules too.
  it('names the validator rules a replacement did not meet', async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user({ role: 'editor' })
      const id = await compared(h, u)
      const errInfo = {
        details: {
          operatorName: '$jsonSchema',
          schemaRulesNotSatisfied: [{ operatorName: 'required', missingProperties: ['name'] }],
        },
      }
      vi.spyOn(Collection.prototype, 'replaceOne').mockRejectedValue(
        new MongoServerError({ message: 'Document failed validation', code: 121, errInfo }),
      )
      const done = await sync(h, u, { compareJobId: id })
      expect(done.job!.state, done.job!.error ?? '').toBe('done')
      expect(done.report.collections[0].errors).toEqual([
        expect.objectContaining({ reason: 'Document failed validation: name: required', code: 121 }),
      ])
    } finally {
      vi.restoreAllMocks()
      await h.t.close()
    }
  }, 180_000)

  // Second independent review (Minor 1): a replacement MongoDB refused through the driver's own
  // wrapper is failed with the server's words and code, not the driver's advice.
  it("fails a replacement refused under the driver's wrapper as the server did", async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user({ role: 'editor' })
      const id = await compared(h, u)
      vi.spyOn(Collection.prototype, 'replaceOne').mockRejectedValue(driverWrapped())
      vi.spyOn(Collection.prototype, 'deleteOne').mockRejectedValue(driverWrapped())
      const done = await sync(h, u, { compareJobId: id, delete: true, confirm: 'orders' })
      expect(done.job!.state, done.job!.error ?? '').toBe('done')
      expect(done.report.collections[0]).toMatchObject({ replaced: 0, deleted: 0 })
      const errors = done.report.collections[0].errors as Array<{ reason: string; code?: number }>
      // One replacement, one deletion.
      expect(errors).toEqual([
        expect.objectContaining({ reason: 'refused here', code: 20 }),
        expect.objectContaining({ reason: 'refused here', code: 20 }),
      ])
      // Its code alone to one restricted on the target (third independent review, Minor 3).
      vi.restoreAllMocks()
      vi.spyOn(Collection.prototype, 'replaceOne').mockRejectedValue(driverWrapped())
      h.rules('B', [{ db: 'shop', coll: 'elsewhere', field: 'secret' }])
      const masked = h.user({ role: 'editor', masked: ['B'] })
      const coded = await sync(h, masked, { compareJobId: await compared(h, masked) })
      expect(coded.job!.state, coded.job!.error ?? '').toBe('done')
      expect(coded.report.collections[0].errors).toEqual([
        expect.objectContaining({ reason: 'MongoDB refused the write (code 20)', code: 20 }),
      ])
      h.rules('B', [])
      // Defensive: a server not there under it stops the sync, as it does unwrapped.
      for (const method of ['replaceOne', 'deleteOne'] as const) {
        vi.restoreAllMocks()
        vi.spyOn(Collection.prototype, method).mockRejectedValue(driverWrapped('shutting down', 91))
        const stopped = await sync(h, u, {
          compareJobId: await compared(h, u),
          delete: true,
          confirm: 'orders',
        })
        expect(stopped.job!.state, method).toBe('failed')
        // Stopped by that, not by something else (final review, nit 3).
        expect(stopped.job!.error ?? '', method).toMatch(/shutting down/)
      }
    } finally {
      vi.restoreAllMocks()
      await h.t.close()
    }
  }, 600_000)

  // Data review 2026-10-13 (M10): with a filter, a target document matching it whose source no
  // longer does is not "only in the target" — its source is still there; it is kept, and said.
  it('keeps a target document whose source left the filter but is still there', async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user({ role: 'editor' })
      const res = await u.call(
        'POST',
        `/api/connections/${h.ids.A}/databases/shop/collections/orders/compare`,
        {
          target: { connectionId: h.ids.B, db: 'shop', coll: 'orders' },
          filter: { v: { $gte: { $numberInt: '3' } } },
        },
      )
      expect(res.statusCode, res.body).toBe(202)
      const id = (await waitJob(h.t, res.json().job.id, 60_000)).id
      // Review of the fix (I6): the source is asked once for the documents in question, not once
      // for each; and the audit row counts what was kept.
      const lookups: unknown[] = []
      const find = Collection.prototype.find
      const spy = vi.spyOn(Collection.prototype, 'find').mockImplementation(function (
        this: Collection,
        ...args: unknown[]
      ) {
        const filter = args[0] as { _id?: { $in?: unknown } } | undefined
        if (filter?._id?.$in) lookups.push(filter)
        return find.apply(this, args as never)
      } as typeof find)
      const done = await sync(h, u, { compareJobId: id, delete: true, confirm: 'orders' })
      spy.mockRestore()
      expect(done.job!.state, done.job!.error ?? '').toBe('done')
      expect(done.report.collections[0]).toMatchObject({ deleted: 1, outsideFilter: 1 })
      expect(lookups).toHaveLength(1)
      const row = h.t.app.ctx.audit.list({ action: 'transfer.sync' })[0]
      expect(JSON.stringify(row?.details)).toContain('"outsideFilter":1')
      expect(await cb.db('shop').collection('orders').find().sort({ _id: 1 }).toArray()).toEqual([
        { _id: 2, v: 9 },
        { _id: 3, v: 3 },
      ])
    } finally {
      await h.t.close()
    }
  }, 180_000)

  it('without deletions keeps the extra, and the switches turn inserts and replacements off', async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user({ role: 'editor' })
      const id = await compared(h, u)
      const done = await sync(h, u, { compareJobId: id, replace: false })
      expect(done.report.collections[0]).toMatchObject({ inserted: 1, replaced: 0, deleted: 0 })
      expect(await cb.db('shop').collection('orders').countDocuments()).toBe(4)
    } finally {
      await h.t.close()
    }
  }, 180_000)

  it('refuses deleting when the source reads nothing', async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user({ role: 'editor' })
      const id = await compared(h, u)
      await ca.db('shop').collection('orders').deleteMany({})
      const r = await sync(h, u, { compareJobId: id, delete: true, confirm: 'orders' })
      expect(r.job!.state).toBe('failed')
      expect(await cb.db('shop').collection('orders').countDocuments()).toBe(3)
    } finally {
      await h.t.close()
    }
  }, 180_000)

  it('stops deleting past the compared count', async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user({ role: 'editor' })
      const extra = Array.from({ length: 300 }, (_, i) => ({ _id: 1000 + i, v: 0 }))
      await ca
        .db('shop')
        .collection('orders')
        .insertMany(extra as never[])
      await cb
        .db('shop')
        .collection('orders')
        .insertMany(extra as never[])
      const id = await compared(h, u)
      await ca
        .db('shop')
        .collection('orders')
        .deleteMany({ _id: { $gte: 1000 as never } })
      const r = await sync(h, u, { compareJobId: id, delete: true, confirm: 'orders' })
      expect(r.report.collections[0].deletionStopped).toBe(true)
      expect(r.report.collections[0].deleted).toBeLessThanOrEqual(101)
      expect(await cb.db('shop').collection('orders').countDocuments()).toBeGreaterThanOrEqual(200)
    } finally {
      await h.t.close()
    }
  }, 180_000)

  it("refuses another user's comparison and one made under other rules", async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user({ role: 'editor' })
      const id = await compared(h, u)
      const other = h.user({ role: 'editor' })
      expect((await sync(h, other, { compareJobId: id })).status).toBe(404)
      h.rules('A', [{ db: 'x', coll: 'y', field: 'z' }])
      expect((await sync(h, u, { compareJobId: id })).body.details.reason).toBe('rules_changed')
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('never overwrites a change made after the read (pinned replace)', async () => {
    const coll = cb.db('shop').collection('orders')
    const current = (await coll.findOne({ _id: 2 as never }, READ_OPTIONS))!
    await coll.updateOne({ _id: 2 as never }, { $set: { v: 77 } })
    expect(await pinnedReplace(coll, current, { _id: 2, v: 2 }, 'mm-test', 10_000)).toBe(false)
    expect((await coll.findOne({ _id: 2 as never }))!.v).toBe(77)
  })

  // Final review of explain masking (Minor 1): MongoDB replaces or deletes no single document of a
  // time series; a sync that would is refused up front, not reported as changed meanwhile.
  it('refuses a sync that replaces or deletes into a time series, and inserts into one', async () => {
    const h = await transferHarness(a, b)
    try {
      await cb.db('shop').createCollection('ts', { timeseries: { timeField: 'at', metaField: 'm' } })
      await cb
        .db('shop')
        .collection('ts')
        .insertOne({ _id: 2 as never, at: new Date(1), m: 'x', v: 8 })
      const u = h.user({ role: 'editor' })
      const res = await u.call(
        'POST',
        `/api/connections/${h.ids.A}/databases/shop/collections/orders/compare`,
        {
          target: { connectionId: h.ids.B, db: 'shop', coll: 'ts' },
        },
      )
      expect(res.statusCode, res.body).toBe(202)
      const id = (await waitJob(h.t, res.json().job.id, 60_000)).id
      const refused = await sync(h, u, { compareJobId: id })
      expect(refused.status).toBe(409)
      expect(refused.body).toMatchObject({ details: { reason: 'target_timeseries', collection: 'ts' } })
      const inserted = await sync(h, u, { compareJobId: id, replace: false })
      expect(inserted.job!.state, inserted.job!.error ?? '').toBe('done')
      // The inserts are MongoDB's to take (the orders hold no time field: each is refused there).
    } finally {
      await h.t.close()
    }
  }, 130_000)

  it('keeps the target value at masked paths (plan ruling 9)', () => {
    expect(
      keepTargetValues(
        { _id: 1, email: '***', c: { phone: '***', city: 'X' } },
        { _id: 1, email: 'real', c: { phone: 'p' } },
        [['email'], ['c', 'phone']],
      ),
    ).toEqual({ _id: 1, email: 'real', c: { phone: 'p', city: 'X' } })
  })
})
