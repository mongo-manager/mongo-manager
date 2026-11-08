// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { Collection, Db, MongoClient, MongoServerError } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { waitJob } from './support/jobs'
import { fixture } from './support/mongo-tools'
import { driverWrapped } from './support/driver-wrap'
import { slow } from './support/slowness'

const PW = 'correct horse battery staple'
let a: TestMongo
let b: TestMongo
let cb: MongoClient
beforeAll(async () => {
  ;[a, b] = await Promise.all([startMongo(), startMongo()])
  cb = await new MongoClient(`mongodb://127.0.0.1:${b.port}`).connect()
}, slow(180_000))
afterAll(async () => {
  await cb?.close()
  await Promise.all([a?.stop(), b?.stop()])
})
beforeEach(async () => {
  for (const d of ['shop', 'shop2', 'shop3', 'shopw']) await cb.db(d).dropDatabase()
})
afterEach(() => vi.restoreAllMocks())

type H = Awaited<ReturnType<typeof backupHarness>>
type U = ReturnType<H['user']>
async function upload(u: U, file: Buffer, name = 'x.archive') {
  const id = (await u.call('POST', '/api/backups/uploads', { name, size: file.length })).json().uploadId
  await u.raw('PUT', `/api/backups/uploads/${id}?offset=0`, file)
  return id as string
}
async function restore(h: H, u: U, body: Record<string, unknown>) {
  const base = `/api/connections/${h.ids.B}/restore`
  const plan = await u.call('POST', `${base}/plan`, body)
  expect(plan.statusCode, plan.body).toBe(200)
  const res = await u.call('POST', base, { ...body, planHash: plan.json().planHash })
  expect(res.statusCode, res.body).toBe(202)
  const job = await waitJob(h.t, res.json().job.id, 60_000)
  return { job, report: (await u.get(`/api/transfer/jobs/${job.id}/report`)).json() }
}
const map = (to: string, colls: string[]) =>
  colls.map((c) => ({ from: { db: 'shop', coll: c }, to: { db: to, coll: c } }))
const expected = JSON.parse(readFileSync(new URL('./fixtures/backup/fixtures.json', import.meta.url), 'utf8'))

/** The archive with the stored CRC of `coll`'s end header changed (the EOF: true header). */
function damaged(coll: string): Buffer {
  const file = Buffer.from(fixture('shop.archive'))
  const name = Buffer.from(
    `collection\0${String.fromCharCode(coll.length + 1)}\0\0\0${coll}\0\x08EOF\0\x01`,
    'latin1',
  )
  const at = file.indexOf(name)
  expect(at).toBeGreaterThan(0)
  const crc = file.indexOf(Buffer.from('\x12CRC\0', 'latin1'), at)
  file[crc + 5] = file[crc + 5]! ^ 0xff
  return file
}

describe('restore job (spec §5.2)', () => {
  it('restores a real mongodump archive into a new database: data, indexes, options, view, time series', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user({ role: 'admin' })
      const id = await upload(u, fixture('shop.archive'))
      const r = await restore(h, u, {
        source: { kind: 'upload', uploadId: id },
        mapping: map('shop2', ['orders', 'empty', 'capped', 'ts', 'v']),
        confirmTtl: true,
      })
      expect(r.job.state, JSON.stringify(r.report)).toBe('done')
      const db = cb.db('shop2')
      expect(await db.collection('orders').countDocuments()).toBe(expected.counts['shop.orders'])
      expect((await db.collection('orders').indexes()).map((i) => i.name).sort()).toEqual([
        '_id_',
        'at_ttl',
        'email_1',
      ])
      expect(
        (await db.listCollections({ name: 'capped' }, { nameOnly: false }).toArray())[0]?.options,
      ).toMatchObject({ capped: true })
      expect((await db.listCollections({ name: 'v' }).toArray())[0]?.type).toBe('view')
      expect(await db.collection('ts').countDocuments()).toBe(expected.counts['shop.ts'])
      expect(r.report.namespaces.find((n: { to: string }) => n.to === 'shop2.orders')).toMatchObject({
        crc: 'ok',
        inserted: expected.counts['shop.orders'],
      })
      expect(r.report.views).toEqual([{ name: 'shop2.v', created: true }])
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('restores a time series as a time series even without collection options (final review I5)', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user({ role: 'admin' })
      const id = await upload(u, fixture('shop.archive'))
      const r = await restore(h, u, {
        source: { kind: 'upload', uploadId: id },
        mapping: map('shop2', ['ts']),
        options: false,
      })
      expect(r.job.state, JSON.stringify(r.report)).toBe('done')
      expect((await cb.db('shop2').listCollections({ name: 'ts' }).toArray())[0]?.type).toBe('timeseries')
      expect(await cb.db('shop2').collection('ts').countDocuments()).toBe(expected.counts['shop.ts'])
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it("points a restored view at its source's new name (final review I8)", async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user({ role: 'admin' })
      const id = await upload(u, fixture('shop.archive'))
      const r = await restore(h, u, {
        source: { kind: 'upload', uploadId: id },
        confirmTtl: true,
        mapping: [
          { from: { db: 'shop', coll: 'orders' }, to: { db: 'shop2', coll: 'orders_r' } },
          { from: { db: 'shop', coll: 'v' }, to: { db: 'shop2', coll: 'v' } },
        ],
      })
      expect(r.job.state, JSON.stringify(r.report)).toBe('done')
      const v = (await cb.db('shop2').listCollections({ name: 'v' }, { nameOnly: false }).toArray())[0] as {
        options?: { viewOn?: string }
      }
      expect(v.options?.viewOn).toBe('orders_r')
      // A view whose source goes to another database cannot follow it: it is not restored.
      const id2 = await upload(u, fixture('shop.archive'))
      const p = (
        await u.call('POST', `/api/connections/${h.ids.B}/restore/plan`, {
          source: { kind: 'upload', uploadId: id2 },
          confirmTtl: true,
          mapping: [
            { from: { db: 'shop', coll: 'orders' }, to: { db: 'shop3', coll: 'orders' } },
            { from: { db: 'shop', coll: 'v' }, to: { db: 'shop2', coll: 'view2' } },
          ],
        })
      ).json()
      expect(p.namespaces.find((n: { to: { coll: string } }) => n.to.coll === 'view2').skipped).toMatch(
        /another database/,
      )
    } finally {
      await h.t.close()
    }
  }, 90_000)

  // Security review 2026-10-13 (M4): reading a backup to inspect or plan it can hold hundreds of
  // megabytes (an encrypted part is up to 128 MiB): one such read per owner, a few on the server.
  it('reads a backup for an inspection or a plan one at a time per owner, a few on the server', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user({ role: 'admin' })
      const id = await upload(u, fixture('shop.archive'))
      const inspect = () =>
        u.call('POST', '/api/backups/inspect', { source: { kind: 'upload', uploadId: id } })
      const plan = () =>
        u.call('POST', `/api/connections/${h.ids.B}/restore/plan`, {
          source: { kind: 'upload', uploadId: id },
          mapping: map('shop9', ['orders']),
        })
      const reads = h.ctx.backup.reads
      const mine = reads.enter(u.id)
      const busy = await inspect()
      expect(busy.statusCode).toBe(429)
      // Its own reason: the web waits and asks again, never taking it for the password throttle.
      expect(busy.json().details).toMatchObject({ reason: 'backup_read_busy' })
      expect((await plan()).statusCode).toBe(429)
      mine()
      const others = Array.from({ length: 3 }, (_, i) => reads.enter(`someone-${i}`))
      expect((await inspect()).statusCode).toBe(429)
      for (const leave of others) leave()
      expect((await inspect()).statusCode).toBe(200)
      expect((await plan()).statusCode).toBe(200)
    } finally {
      await h.t.close()
    }
  })

  // Security review 2026-10-13 round 2 (I4): a user who cannot see personal data on the target does
  // not restore a GridFS bucket there — its contents would be written chunk by chunk and refused,
  // leaving files without them. The plan says so before anything is written.
  // User report 2026-10-27: where a rule reaches the target bucket; one on another collection leaves it in.
  it('leaves a GridFS bucket out of a restore by a masked user where a rule reaches it, saying why', async () => {
    const h = await backupHarness(a, b)
    try {
      // Their own backup, made where they see everything; restored where they do not.
      const admin = h.user({ on: { A: 'admin', B: 'editor' }, masked: ['B'] })
      const ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
      await ca.db('shopg').dropDatabase()
      await ca.db('shopg').collection('fs.files').insertOne({ filename: 'a', length: 1, chunkSize: 255 })
      await ca.db('shopg').collection('fs.chunks').insertOne({ files_id: 1, n: 0, data: 'x' })
      await ca.db('shopg').collection('people').insertOne({ n: 1 })
      await ca.close()
      const body = { scope: { kind: 'database', db: 'shopg' }, format: 'gzip' }
      const dp = (await admin.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
      const dj = await waitJob(
        h.t,
        (
          await admin.call('POST', `/api/connections/${h.ids.A}/backup`, { ...body, planHash: dp.planHash })
        ).json().job.id,
        60_000,
      )
      const backupId = (await admin.get(`/api/transfer/jobs/${dj.id}/report`)).json().backupId
      const masked = admin
      const restorePlan = async () => {
        const plan = await masked.call('POST', `/api/connections/${h.ids.B}/restore/plan`, {
          source: { kind: 'backup', backupId },
          mapping: ['fs.files', 'fs.chunks', 'people'].map((c) => ({
            from: { db: 'shopg', coll: c },
            to: { db: 'shopg2', coll: c },
          })),
        })
        expect(plan.statusCode, plan.body).toBe(200)
        return (coll: string) =>
          plan.json().namespaces.find((n: { to: { coll: string } }) => n.to.coll === coll)?.skipped
      }
      h.rules('B', [{ db: 'shopg2', coll: 'people', field: 'n' }])
      const free = await restorePlan()
      expect(free('fs.chunks')).toBeUndefined()
      expect(free('fs.files')).toBeUndefined()
      expect(free('people')).toBeUndefined()
      // A rule on the bucket's files alone, then one on every collection of the database.
      for (const rule of [
        { db: 'shopg2', coll: 'fs.files', field: 'metadata.owner' },
        { db: 'shopg2', coll: '*', field: 'n' },
      ]) {
        h.rules('B', [rule])
        const skipped = await restorePlan()
        expect(skipped('fs.chunks'), JSON.stringify(rule)).toMatch(/GridFS/)
        expect(skipped('fs.files'), JSON.stringify(rule)).toMatch(/GridFS/)
      }
    } finally {
      await h.t.close()
    }
  }, 90_000)

  // Seventeenth review of explain masking (nit): each namespace its own gate lookups, as a dump's
  // (one job's lookups stopped at 100 namespaces).
  it('restores many collections for a masked user, none refused as one query too complex', async () => {
    const h = await backupHarness(a, b)
    try {
      const admin = h.user({ on: { A: 'admin', B: 'editor' }, masked: ['B'] })
      const ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
      await ca.db('shopm').dropDatabase()
      const names = Array.from({ length: 110 }, (_, i) => `c${i}`)
      for (const n of names) await ca.db('shopm').collection(n).insertOne({ n: 1 })
      await ca.close()
      const body = { scope: { kind: 'database', db: 'shopm' }, format: 'gzip' }
      const dp = (await admin.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
      const dj = await waitJob(
        h.t,
        (
          await admin.call('POST', `/api/connections/${h.ids.A}/backup`, { ...body, planHash: dp.planHash })
        ).json().job.id,
        120_000,
      )
      const backupId = (await admin.get(`/api/transfer/jobs/${dj.id}/report`)).json().backupId
      h.rules('B', [{ db: 'shopm2', coll: 'c0', field: 'secret' }])
      const restore = {
        source: { kind: 'backup', backupId },
        mapping: names.map((c) => ({ from: { db: 'shopm', coll: c }, to: { db: 'shopm2', coll: c } })),
      }
      const plan = await admin.call('POST', `/api/connections/${h.ids.B}/restore/plan`, restore)
      expect(plan.statusCode, plan.body).toBe(200)
      const res = await admin.call('POST', `/api/connections/${h.ids.B}/restore`, {
        ...restore,
        planHash: plan.json().planHash,
      })
      expect(res.statusCode, res.body).toBe(202)
      const job = await waitJob(h.t, res.json().job.id, 120_000)
      expect(job.state, job.error ?? '').toBe('done')
      const cb2 = await new MongoClient(`mongodb://127.0.0.1:${b.port}`).connect()
      try {
        const counts = await Promise.all(names.map((n) => cb2.db('shopm2').collection(n).countDocuments()))
        expect(counts.every((c) => c === 1)).toBe(true)
        await cb2.db('shopm2').dropDatabase()
      } finally {
        await cb2.close()
      }
    } finally {
      await h.t.close()
    }
  }, 250_000)

  it('replace keeps the target on a CRC mismatch and on cancel (Review Focus 1)', async () => {
    const h = await backupHarness(a, b)
    try {
      await cb
        .db('shop')
        .collection('orders')
        .insertMany([{ keep: 1 }, { keep: 2 }])
      const u = h.user({ role: 'admin' })
      const keep = () =>
        cb
          .db('shop')
          .collection('orders')
          .find({}, { projection: { _id: 0 } })
          .toArray()
      const staging = async () =>
        (await cb.db('shop').listCollections().toArray())
          .map((c) => c.name)
          .filter((n) => n.startsWith('mm_restore_'))
      const body = {
        mode: 'replace',
        mapping: map('shop', ['orders']),
        confirmTtl: true,
        confirmNames: ['shop.orders'],
      }
      const r = await restore(h, u, {
        ...body,
        source: { kind: 'upload', uploadId: await upload(u, damaged('orders')) },
      })
      expect(r.job.state).toBe('failed')
      expect(r.report.namespaces[0].crc).toBe('mismatch')
      expect(await keep()).toEqual([{ keep: 1 }, { keep: 2 }])
      expect(await staging()).toEqual([])
      // Cancel: a write that waits until the job is cancelled.
      const real = Collection.prototype.bulkWrite
      vi.spyOn(Collection.prototype, 'bulkWrite').mockImplementation(async function (
        this: Collection,
        ...args: unknown[]
      ) {
        await new Promise((resolve) => setTimeout(resolve, 1_500))
        return (real as (...a: unknown[]) => Promise<unknown>).apply(this, args) as never
      } as never)
      const body2 = {
        ...body,
        source: { kind: 'upload', uploadId: await upload(u, fixture('shop.archive')) },
      }
      const base = `/api/connections/${h.ids.B}/restore`
      const plan = (await u.call('POST', `${base}/plan`, body2)).json()
      const start = await u.call('POST', base, { ...body2, planHash: plan.planHash })
      expect(start.statusCode, start.body).toBe(202)
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect((await u.call('POST', `/api/jobs/${start.json().job.id}/cancel`)).statusCode).toBeLessThan(300)
      const job = await waitJob(h.t, start.json().job.id, 60_000)
      expect(job.state).toBe('cancelled')
      expect(await keep()).toEqual([{ keep: 1 }, { keep: 2 }])
      expect(await staging()).toEqual([])
    } finally {
      await h.t.close()
    }
  }, 180_000)

  // Backup review M9: an Insert restore stopped partway, run again, met every document it had
  // written as a duplicate-key failure. A stored document that is the backup's, byte for byte, is
  // already there; one that differs is still refused.
  it('counts a document already restored as there, not as a failure, when a restore runs again', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user({ role: 'admin' })
      const body = {
        mode: 'insert',
        mapping: map('shop', ['orders']),
        confirmTtl: true,
        source: { kind: 'upload', uploadId: await upload(u, fixture('shop.archive')) },
      }
      const first = await restore(h, u, body)
      expect(first.job.state).toBe('done')
      const orders = cb.db('shop').collection('orders')
      const total = await orders.countDocuments()
      expect(total).toBe(2)
      // One document changed since: still refused. The other is as the backup has it.
      const [x] = await orders.find().limit(1).toArray()
      await orders.updateOne({ _id: x!._id }, { $set: { changed: true } })
      const again = await restore(h, u, {
        ...body,
        source: { kind: 'upload', uploadId: await upload(u, fixture('shop.archive')) },
      })
      const ns = again.report.namespaces.find((n: { to: string }) => n.to === 'shop.orders')
      expect(ns).toMatchObject({ inserted: 0, failed: 1, alreadyThere: 1 })
      expect(await orders.countDocuments()).toBe(total)
    } finally {
      await h.t.close()
    }
  }, 180_000)

  // Backup review M8: Replace replaces the documents. Restored without the backup's indexes or
  // options, the target lost its own as well (the swap drops it); they are kept.
  it('replace keeps the target’s own indexes and validator when the backup’s are not restored', async () => {
    const h = await backupHarness(a, b)
    try {
      const orders = cb.db('shop').collection('orders')
      await cb.db('shop').createCollection('orders', {
        validator: { $jsonSchema: { bsonType: 'object', properties: { keep: { bsonType: 'int' } } } },
      })
      await orders.createIndex({ keep: 1 }, { name: 'keep_1' })
      await orders.insertOne({ keep: 1 })
      const u = h.user({ role: 'admin' })
      const body = {
        mode: 'replace',
        mapping: map('shop', ['orders']),
        indexes: false,
        options: false,
        confirmTtl: true,
        confirmNames: ['shop.orders'],
        source: { kind: 'upload', uploadId: await upload(u, fixture('shop.archive')) },
      }
      // The plan says so before anything is written.
      const plan = (await u.call('POST', `/api/connections/${h.ids.B}/restore/plan`, body)).json()
      expect(plan.namespaces[0].keepsOwn).toEqual({ indexes: true, options: true })
      const r = await restore(h, u, body)
      expect(r.job.state, JSON.stringify(r.report)).toBe('done')
      expect(await orders.countDocuments({ keep: 1 })).toBe(0)
      expect((await orders.indexes()).map((i) => i.name)).toContain('keep_1')
      const [info] = await cb.db('shop').listCollections({ name: 'orders' }).toArray()
      expect((info as { options: { validator?: unknown } }).options.validator).toEqual({
        $jsonSchema: { bsonType: 'object', properties: { keep: { bsonType: 'int' } } },
      })
    } finally {
      await h.t.close()
    }
  }, 90_000)

  // Backup review I1, I2: with "stop", a record already there stopped the batch although nothing
  // failed, and the records after it were never written; the dry run refused what the run counts.
  it('runs again with "stop" past what is already there, and the dry run says so too', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user({ role: 'admin' })
      const body = {
        mode: 'insert',
        onError: 'stop',
        mapping: map('shop', ['orders']),
        confirmTtl: true,
        source: { kind: 'upload', uploadId: await upload(u, fixture('shop.archive')) },
      }
      expect((await restore(h, u, body)).job.state).toBe('done')
      const orders = cb.db('shop').collection('orders')
      // The first document is there as the backup has it; the second, after it, is gone.
      await orders.deleteOne({ _id: { $ne: 1 } } as never)
      const again = {
        ...body,
        source: { kind: 'upload', uploadId: await upload(u, fixture('shop.archive')) },
      }
      const dry = await restore(h, u, { ...again, dryRun: true })
      expect(dry.report.namespaces[0]).toMatchObject({ failed: 0, alreadyThere: 1 })
      const r = await restore(h, u, {
        ...again,
        source: { kind: 'upload', uploadId: await upload(u, fixture('shop.archive')) },
      })
      expect(r.job.state, JSON.stringify(r.report)).toBe('done')
      expect(r.report.namespaces[0]).toMatchObject({ inserted: 1, failed: 0, alreadyThere: 1 })
      expect(await orders.countDocuments()).toBe(2)
    } finally {
      await h.t.close()
    }
  }, 240_000)

  // Backup review I3: a time series target cannot be renamed over; it was refused only when the
  // backup's collection was one.
  it('refuses to replace a time series target with a plain backup', async () => {
    const h = await backupHarness(a, b)
    try {
      await cb.db('shop').createCollection('orders', { timeseries: { timeField: 'at' } })
      const u = h.user({ role: 'admin' })
      const plan = (
        await u.call('POST', `/api/connections/${h.ids.B}/restore/plan`, {
          mode: 'replace',
          mapping: map('shop', ['orders']),
          options: false,
          confirmTtl: true,
          confirmNames: ['shop.orders'],
          source: { kind: 'upload', uploadId: await upload(u, fixture('shop.archive')) },
        })
      ).json()
      expect(plan.refusals).toContain('timeseries_replace')
    } finally {
      await h.t.close()
    }
  })

  // Backup review I4: a kept cap dropped the oldest restored documents, and the report said done.
  it('fails a replace that a kept cap would cut short, and leaves the target as it was', async () => {
    const h = await backupHarness(a, b)
    try {
      await cb.db('shop').createCollection('orders', { capped: true, size: 4096, max: 1 })
      await cb.db('shop').collection('orders').insertOne({ mine: true })
      const u = h.user({ role: 'admin' })
      const body = {
        mode: 'replace',
        mapping: map('shop', ['orders']),
        options: false,
        confirmTtl: true,
        confirmNames: ['shop.orders'],
        source: { kind: 'upload', uploadId: await upload(u, fixture('shop.archive')) },
      }
      const plan = (await u.call('POST', `/api/connections/${h.ids.B}/restore/plan`, body)).json()
      expect(plan.checks.find((c: { key: string }) => c.key === 'capped')).toMatchObject({
        level: 'warn',
        params: { names: 'shop.orders' },
      })
      const r = await restore(h, u, body)
      expect(r.job.state).toBe('failed')
      expect(r.job.error).toMatch(/capped: it kept 1 of the 2 documents/)
      expect(await cb.db('shop').collection('orders').find().toArray()).toMatchObject([{ mine: true }])
    } finally {
      await h.t.close()
    }
  }, 90_000)

  // Review M4: a kept unique index the backup's documents break was skipped, and the target lost it.
  it('fails a replace whose target cannot keep its own unique index', async () => {
    const h = await backupHarness(a, b)
    try {
      const orders = cb.db('shop').collection('orders')
      await orders.insertOne({ mine: true })
      // Both backed-up documents lack the field: a unique index over it is broken by them.
      await orders.createIndex({ missing: 1 }, { unique: true, name: 'missing_1' })
      const u = h.user({ role: 'admin' })
      const r = await restore(h, u, {
        mode: 'replace',
        mapping: map('shop', ['orders']),
        indexes: false,
        confirmTtl: true,
        confirmNames: ['shop.orders'],
        source: { kind: 'upload', uploadId: await upload(u, fixture('shop.archive')) },
      })
      expect(r.job.state).toBe('failed')
      expect(r.job.error).toMatch(/could not keep its own index missing_1/)
      expect(await orders.find({}, { projection: { _id: 0 } }).toArray()).toEqual([{ mine: true }])
    } finally {
      await h.t.close()
    }
  }, 90_000)

  // Second independent review (Minor 1): the index it could not keep is said with the server's own
  // words, from under the driver's wrapper, not the driver's advice.
  it("says why the target could not keep its own index, as the server did under the driver's wrapper", async () => {
    const h = await backupHarness(a, b)
    try {
      const orders = cb.db('shop').collection('orders')
      await orders.insertOne({ mine: true })
      await orders.createIndex({ missing: 1 }, { name: 'missing_1' })
      vi.spyOn(Collection.prototype, 'createIndex').mockRejectedValue(driverWrapped())
      const u = h.user({ role: 'admin' })
      const r = await restore(h, u, {
        mode: 'replace',
        mapping: map('shop', ['orders']),
        indexes: false,
        confirmTtl: true,
        confirmNames: ['shop.orders'],
        source: { kind: 'upload', uploadId: await upload(u, fixture('shop.archive')) },
      })
      expect(r.job.state).toBe('failed')
      expect(r.job.error).toMatch(/could not keep its own index missing_1 \(refused here\)/)
    } finally {
      await h.t.close()
    }
  }, 90_000)

  // Third independent review (Minor 1): a staged copy MongoDB would not put in place is said with the
  // server's own words, from under the driver's wrapper.
  it("says why a staged copy could not be put in place, as the server did under the driver's wrapper", async () => {
    const h = await backupHarness(a, b)
    try {
      await cb.db('shop').collection('orders').insertOne({ mine: true })
      vi.spyOn(Collection.prototype, 'rename').mockRejectedValue(driverWrapped())
      const u = h.user({ role: 'admin' })
      const r = await restore(h, u, {
        mode: 'replace',
        mapping: map('shop', ['orders']),
        confirmTtl: true,
        confirmNames: ['shop.orders'],
        source: { kind: 'upload', uploadId: await upload(u, fixture('shop.archive')) },
      })
      expect(r.job.state).toBe('failed')
      expect(r.job.error).toMatch(
        /shop\.orders could not be put in place \(refused here\); no target was changed/,
      )
      // Its code alone where the restorer is restricted, a namespace with no rules replaced (final
      // review, Minor 1), as for an index it could not keep.
      await cb.db('shop').dropDatabase()
      await cb.db('shop').collection('orders').insertOne({ mine: true })
      h.rules('B', [{ db: 'shopw', coll: 'elsewhere', field: 'secret' }])
      const masked = h.user({ on: { A: 'admin', B: 'editor' }, masked: ['B'] })
      const m = await restore(h, masked, {
        mode: 'replace',
        mapping: map('shop', ['orders']),
        confirmTtl: true,
        confirmNames: ['shop.orders'],
        source: { kind: 'upload', uploadId: await upload(masked, fixture('shop.archive')) },
      })
      expect(m.job.state).toBe('failed')
      expect(m.job.error).toMatch(/shop\.orders could not be put in place \(code 20\); no target was changed/)
    } finally {
      await h.t.close()
    }
  }, 200_000)

  // Backup review I5, M10, M3: a target's own TTL indexes delete what is restored: a replace that
  // keeps them asks first, and what they delete at once is counted (partial filters, arrays and
  // paths through sub-documents as the server reads them; never a refused record).
  it('confirms the TTL a replace keeps, and counts what an age rule deletes as soon as it is written', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user({ role: 'admin' })
      const old = new Date(Date.now() - 7 * 86_400_000)
      const now = new Date()
      const ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
      await ca.db('shop').dropDatabase()
      await ca
        .db('shop')
        .collection('ev')
        .insertMany([
          { _id: 1, at: old, kind: 'log' },
          { _id: 2, at: now, kind: 'log' },
          { _id: 3, at: [now, old], kind: 'log' },
          { _id: 4, at: old, kind: 'other' },
          { _id: 5, at: '2000-01-01', kind: 'log' },
          { _id: 6, events: [{ at: old }] },
        ] as never)
      await ca.close()
      const body = { scope: { kind: 'collection', db: 'shop', coll: 'ev' }, format: 'mmbak' }
      const dp = (await u.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
      const started = await u.call('POST', `/api/connections/${h.ids.A}/backup`, {
        ...body,
        planHash: dp.planHash,
        password: PW,
      })
      const dj = await waitJob(h.t, started.json().job.id, 60_000)
      const backupId = (await u.get(`/api/transfer/jobs/${dj.id}/report`)).json().backupId
      const ev = cb.db('shop3').collection('ev')
      await ev.createIndex(
        { at: 1 },
        { name: 'at_1', expireAfterSeconds: 3600, partialFilterExpression: { kind: { $eq: 'log' } } },
      )
      await ev.createIndex({ 'events.at': 1 }, { name: 'events_at', expireAfterSeconds: 3600 })
      // Stored differently: refused, so never counted.
      await ev.insertOne({ _id: 1, at: now, kind: 'mine' } as never)
      const src = {
        source: { kind: 'backup', backupId },
        password: PW,
        indexes: false,
        mapping: [{ from: { db: 'shop', coll: 'ev' }, to: { db: 'shop3', coll: 'ev' } }],
      }
      const added = { ...src, mode: 'insert', confirmTtl: true }
      const dry = await restore(h, u, { ...added, dryRun: true })
      expect(dry.job.state, JSON.stringify([dry.job.error, dry.report])).toBe('done')
      expect(dry.report.namespaces[0]).toMatchObject({ failed: 1, expiring: 2 })
      const r = await restore(h, u, added)
      expect(r.report.namespaces[0]).toMatchObject({ inserted: 5, failed: 1, expiring: 2 })
      // Replaced, the target keeps both TTL indexes: confirmed first, counted after.
      const replace = { ...src, mode: 'replace', confirmNames: ['shop3.ev'] }
      const plan = (await u.call('POST', `/api/connections/${h.ids.B}/restore/plan`, replace)).json()
      expect(plan.refusals).toContain('confirm_ttl')
      expect(plan.namespaces[0].ttl.sort()).toEqual(['at_1', 'events_at'])
      const replaced = await restore(h, u, { ...replace, confirmTtl: true })
      expect(replaced.job.state, JSON.stringify(replaced.report)).toBe('done')
      expect(replaced.report.namespaces[0]).toMatchObject({ inserted: 6, expiring: 3 })
    } finally {
      await h.t.close()
    }
  }, 300_000)

  // Review M5: the backup's indexes keep their own collation under a target's kept default one.
  it('gives the backup’s indexes their own collation when the target’s options are kept', async () => {
    const h = await backupHarness(a, b)
    try {
      await cb.db('shop').createCollection('orders', { collation: { locale: 'fr', strength: 1 } })
      const u = h.user({ role: 'admin' })
      const r = await restore(h, u, {
        mode: 'replace',
        mapping: map('shop', ['orders']),
        options: false,
        confirmTtl: true,
        confirmNames: ['shop.orders'],
        source: { kind: 'upload', uploadId: await upload(u, fixture('shop.archive')) },
      })
      expect(r.job.state, JSON.stringify(r.report)).toBe('done')
      const [info] = await cb.db('shop').listCollections({ name: 'orders' }).toArray()
      expect((info as { options: Record<string, unknown> }).options).toMatchObject({
        collation: { locale: 'fr', strength: 1 },
      })
      const email = (await cb.db('shop').collection('orders').indexes()).find((i) => i.name === 'email_1')
      expect((email?.collation as { locale?: string } | undefined)?.locale ?? 'simple').toBe('simple')
    } finally {
      await h.t.close()
    }
  }, 90_000)

  // Review M6: the plan hash covers the target's own settings a replace keeps.
  it('refuses to start when the target’s own indexes changed since the plan', async () => {
    const h = await backupHarness(a, b)
    try {
      const orders = cb.db('shop').collection('orders')
      await orders.insertOne({ mine: true })
      const u = h.user({ role: 'admin' })
      const body = {
        mode: 'replace',
        mapping: map('shop', ['orders']),
        indexes: false,
        confirmTtl: true,
        confirmNames: ['shop.orders'],
        source: { kind: 'upload', uploadId: await upload(u, fixture('shop.archive')) },
      }
      const base = `/api/connections/${h.ids.B}/restore`
      const plan = (await u.call('POST', `${base}/plan`, body)).json()
      await orders.createIndex({ late: 1 }, { name: 'late_1' })
      const res = await u.call('POST', base, { ...body, planHash: plan.planHash })
      expect(res.statusCode).toBe(409)
      expect(res.json().details.reason).toBe('plan_changed')
    } finally {
      await h.t.close()
    }
  })

  // Fifth review of B2 (M-2): the plan hash covers a target turned capped since the plan.
  it('refuses to start when a target turned capped since the plan', async () => {
    const h = await backupHarness(a, b)
    try {
      const orders = cb.db('shop').collection('orders')
      await orders.insertOne({ mine: true })
      const u = h.user({ role: 'admin' })
      const body = {
        mode: 'insert',
        mapping: map('shop', ['orders']),
        indexes: false,
        confirmTtl: true,
        source: { kind: 'upload', uploadId: await upload(u, fixture('shop.archive')) },
      }
      const base = `/api/connections/${h.ids.B}/restore`
      const plan = (await u.call('POST', `${base}/plan`, body)).json()
      expect(plan.namespaces[0].capped).toBeUndefined()
      await cb.db('shop').command({ convertToCapped: 'orders', size: 1_000_000 })
      const res = await u.call('POST', base, { ...body, planHash: plan.planHash })
      expect(res.statusCode).toBe(409)
      expect(res.json().details.reason).toBe('plan_changed')
    } finally {
      await h.t.close()
    }
  })

  it('replaces several namespaces all or nothing: a cancel before the swap changes none (final review I3)', async () => {
    const h = await backupHarness(a, b)
    try {
      await cb
        .db('shop')
        .collection('orders')
        .insertMany([{ keep: 'o' }])
      await cb
        .db('shop')
        .collection('empty')
        .insertMany([{ keep: 'e' }])
      const u = h.user({ role: 'admin' })
      const id = await upload(u, fixture('shop.archive'))
      // "empty" has no index to build and comes first; "orders" builds two, slowly.
      const real = Collection.prototype.createIndex
      vi.spyOn(Collection.prototype, 'createIndex').mockImplementation(async function (
        this: Collection,
        ...args: unknown[]
      ) {
        await new Promise((resolve) => setTimeout(resolve, 1_500))
        return (real as (...a: unknown[]) => Promise<unknown>).apply(this, args) as never
      } as never)
      const body = {
        source: { kind: 'upload', uploadId: id },
        mode: 'replace',
        confirmTtl: true,
        confirmNames: ['shop.orders', 'shop.empty'],
        mapping: map('shop', ['empty', 'orders']),
      }
      const base = `/api/connections/${h.ids.B}/restore`
      const plan = (await u.call('POST', `${base}/plan`, body)).json()
      expect(plan.refusals).toEqual([])
      const start = await u.call('POST', base, { ...body, planHash: plan.planHash })
      expect(start.statusCode, start.body).toBe(202)
      await new Promise((resolve) => setTimeout(resolve, 600))
      await u.call('POST', `/api/jobs/${start.json().job.id}/cancel`)
      const job = await waitJob(h.t, start.json().job.id, 60_000)
      expect(job.state).toBe('cancelled')
      const left = async (c: string) =>
        (
          await cb
            .db('shop')
            .collection(c)
            .find({}, { projection: { _id: 0 } })
            .toArray()
        ).map((d) => d.keep)
      expect(await left('empty')).toEqual(['e'])
      expect(await left('orders')).toEqual(['o'])
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('restores an encrypted backup with its password, upserts, dry-runs and reports rejected documents', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user({ role: 'admin' })
      const ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
      await ca.db('shop').dropDatabase()
      await ca
        .db('shop')
        .collection('t')
        .insertMany([
          { _id: 1, v: 'a' },
          { _id: 2, v: 'b' },
        ] as never)
      await ca.close()
      const body = { scope: { kind: 'collection', db: 'shop', coll: 't' }, format: 'mmbak' }
      const dp = (await u.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
      const started = await u.call('POST', `/api/connections/${h.ids.A}/backup`, {
        ...body,
        planHash: dp.planHash,
        password: PW,
      })
      const dj = await waitJob(h.t, started.json().job.id, 60_000)
      const backupId = (await u.get(`/api/transfer/jobs/${dj.id}/report`)).json().backupId
      await cb
        .db('shop3')
        .collection('t')
        .insertOne({ _id: 1, v: 'old' } as never)
      const src = {
        source: { kind: 'backup', backupId },
        password: PW,
        mapping: [{ from: { db: 'shop', coll: 't' }, to: { db: 'shop3', coll: 't' } }],
      }
      const dry = await restore(h, u, { ...src, mode: 'upsert', dryRun: true })
      expect(dry.report).toMatchObject({ dryRun: true })
      expect(dry.report.namespaces[0]).toMatchObject({ read: 2, wouldMatch: 1 })
      expect(
        await cb
          .db('shop3')
          .collection('t')
          .findOne({ _id: 1 } as never),
      ).toMatchObject({ v: 'old' })
      const ins = await restore(h, u, { ...src, mode: 'insert' })
      expect(ins.report.namespaces[0]).toMatchObject({ inserted: 1, failed: 1 })
      expect(ins.report.rejectedFile).toBe(true)
      const up = await restore(h, u, { ...src, mode: 'upsert' })
      expect(up.job.state).toBe('done')
      expect(
        await cb
          .db('shop3')
          .collection('t')
          .findOne({ _id: 1 } as never),
      ).toMatchObject({ v: 'a' })
      const wrong = await u.call('POST', `/api/connections/${h.ids.B}/restore/plan`, {
        ...src,
        password: 'not the password',
      })
      expect(wrong.json().details.reason).toBe('backup_password')
      const rows = JSON.stringify(h.ctx.store.db.prepare('SELECT * FROM audit_log').all())
      expect(rows).not.toContain(PW)
    } finally {
      await h.t.close()
    }
  }, 300_000)

  // Review of the agent's gate (M-2): a masked restore inserts nothing a unique index's duplicate key
  // would answer for (its partial filter reading a hidden value), saying so for that record.
  it('restores no record under a unique index whose filter reads what is hidden, for a masked user', async () => {
    const h = await backupHarness(a, b)
    try {
      const admin = h.user({ on: { A: 'admin', B: 'editor' }, masked: ['B'] })
      const ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
      await ca.db('shopu').dropDatabase()
      await ca
        .db('shopu')
        .collection('flags')
        .insertMany([
          { _id: 1, code: 'C', flag: true },
          { _id: 2, code: 'D', flag: false },
        ] as never)
      await ca.close()
      const body = { scope: { kind: 'collection', db: 'shopu', coll: 'flags' }, format: 'gzip' }
      const dp = (await admin.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
      const dj = await waitJob(
        h.t,
        (
          await admin.call('POST', `/api/connections/${h.ids.A}/backup`, { ...body, planHash: dp.planHash })
        ).json().job.id,
        60_000,
      )
      const backupId = (await admin.get(`/api/transfer/jobs/${dj.id}/report`)).json().backupId
      const target = cb.db('shopu2').collection('flags')
      await target.insertOne({ _id: 9, code: 'C', flag: false, phone: '555-0199' } as never)
      await target.createIndex(
        { code: 1 },
        { unique: true, partialFilterExpression: { $or: [{ phone: { $gt: '5' } }, { flag: true }] } },
      )
      h.rules('B', [{ db: 'shopu2', coll: 'flags', field: 'phone' }])
      const run = await restore(h, admin, {
        source: { kind: 'backup', backupId },
        mapping: [{ from: { db: 'shopu', coll: 'flags' }, to: { db: 'shopu2', coll: 'flags' } }],
        mode: 'insert',
      })
      expect(run.report.namespaces[0]).toMatchObject({ read: 2, failed: 2 })
      expect(await target.countDocuments()).toBe(1)
      await cb.db('shopu2').dropDatabase()
    } finally {
      await h.t.close()
    }
  }, 240_000)

  // Independent reviews (Minor 5; second, Minor 1): an index or a view MongoDB refused through the
  // driver's own wrapper (no code of its own) is said with the server's words, or its code to a
  // masked user — never as unknown, never as the driver's advice.
  it("says an index or a view refused under the driver's wrapper as the server did", async () => {
    const h = await backupHarness(a, b)
    try {
      vi.spyOn(Collection.prototype, 'createIndex').mockRejectedValue(driverWrapped())
      const createCollection = Db.prototype.createCollection
      vi.spyOn(Db.prototype, 'createCollection').mockImplementation(function (this: Db, ...args: unknown[]) {
        if ((args[1] as { viewOn?: unknown } | undefined)?.viewOn) return Promise.reject(driverWrapped())
        return createCollection.apply(this, args as never)
      } as typeof createCollection)
      const masked = h.user({ on: { A: 'admin', B: 'editor' }, masked: ['B'] })
      const open = h.user({ role: 'admin' })
      // Rules elsewhere: the view and the indexes reach MongoDB, refused there.
      h.rules('B', [{ db: 'shopw', coll: 'elsewhere', field: 'secret' }])
      for (const [u, index, view] of [
        [masked, 'Index build refused (code 20)', 'View creation refused (code 20)'],
        [open, 'refused here', 'refused here'],
      ] as const) {
        const run = await restore(h, u, {
          source: { kind: 'upload', uploadId: await upload(u, fixture('shop.archive')) },
          mapping: [
            { from: { db: 'shop', coll: 'orders' }, to: { db: 'shopw', coll: 'orders_r' } },
            { from: { db: 'shop', coll: 'v' }, to: { db: 'shopw', coll: 'v' } },
          ],
          mode: 'insert',
          confirmTtl: true,
        })
        expect(run.job.state, run.job.error ?? '').toBe('done')
        const orders = run.report.namespaces.find((n: { to: string }) => n.to === 'shopw.orders_r')
        const skipped = orders.indexes.skipped as Array<{ reason: string }>
        expect(skipped.length).toBeGreaterThan(0)
        expect(skipped.map((s) => s.reason)).toEqual(skipped.map(() => index))
        expect(run.report.views).toEqual([{ name: 'shopw.v', created: false, reason: view }])
        await cb.db('shopw').dropDatabase()
      }
    } finally {
      await h.t.close()
    }
  }, 240_000)

  // Next review of the agent's gate (M-5): a restore stopped mid-batch reports what it wrote.
  it('reports what it wrote of a batch that a job-level failure stops', async () => {
    const h = await backupHarness(a, b)
    try {
      const admin = h.user({ on: { A: 'admin', B: 'editor' }, masked: ['B'] })
      const ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
      await ca.db('shopw').dropDatabase()
      await ca
        .db('shopw')
        .collection('rows')
        .insertMany([
          { _id: 1, n: 1 },
          { _id: 2, n: 2 },
          { _id: 3, n: 3 },
        ] as never)
      await ca.close()
      const body = { scope: { kind: 'collection', db: 'shopw', coll: 'rows' }, format: 'gzip' }
      const dp = (await admin.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
      const dj = await waitJob(
        h.t,
        (
          await admin.call('POST', `/api/connections/${h.ids.A}/backup`, { ...body, planHash: dp.planHash })
        ).json().job.id,
        60_000,
      )
      const backupId = (await admin.get(`/api/transfer/jobs/${dj.id}/report`)).json().backupId
      // A rule there (on a field the rows do not hold): the restricted writer inserts one at a time.
      h.rules('B', [{ db: 'shopw2', coll: 'rows', field: 'secret' }])
      const insertOne = Collection.prototype.insertOne
      let calls = 0
      vi.spyOn(Collection.prototype, 'insertOne').mockImplementation(function (
        this: Collection,
        ...args: unknown[]
      ) {
        if (this.dbName === 'shopw2' && ++calls === 2)
          return Promise.reject(
            new MongoServerError({ message: 'interrupted at shutdown', code: 91 }),
          ) as never
        return insertOne.apply(this, args as never)
      } as typeof insertOne)
      const run = await restore(h, admin, {
        source: { kind: 'backup', backupId },
        mapping: [{ from: { db: 'shopw', coll: 'rows' }, to: { db: 'shopw2', coll: 'rows' } }],
        mode: 'insert',
      })
      expect(run.job.state).toBe('failed')
      const written = await cb.db('shopw2').collection('rows').countDocuments()
      expect(written).toBe(1)
      expect(run.report.namespaces[0]).toMatchObject({ inserted: written })
      vi.restoreAllMocks()
      // A new target whose indexes cannot be read is not made (next round, M-4).
      const listIndexes = Collection.prototype.listIndexes
      vi.spyOn(Collection.prototype, 'listIndexes').mockImplementation(function (
        this: Collection,
        ...args: unknown[]
      ) {
        if (this.dbName === 'shopw3')
          return {
            toArray: () => Promise.reject(new MongoServerError({ message: 'not authorized', code: 13 })),
          } as never
        return listIndexes.apply(this, args as never)
      } as typeof listIndexes)
      h.rules('B', [
        { db: 'shopw2', coll: 'rows', field: 'secret' },
        { db: 'shopw3', coll: 'rows', field: 'secret' },
      ])
      const fresh = await restore(h, admin, {
        source: { kind: 'backup', backupId },
        mapping: [{ from: { db: 'shopw', coll: 'rows' }, to: { db: 'shopw3', coll: 'rows' } }],
        mode: 'insert',
      })
      expect(fresh.job.state).toBe('failed')
      expect(await cb.db('shopw3').listCollections({ name: 'rows' }).toArray()).toEqual([])
    } finally {
      vi.restoreAllMocks()
      await cb.db('shopw2').dropDatabase()
      await cb.db('shopw3').dropDatabase()
      await h.t.close()
    }
  }, 400_000)

  // Review of the agent's gate (M-3): every target's indexes are checked before any is made: a
  // restore refused at its second collection leaves nothing made for the first.
  it('makes nothing when one target’s indexes cannot be read', async () => {
    const h = await backupHarness(a, b)
    try {
      const admin = h.user({ on: { A: 'admin', B: 'editor' }, masked: ['B'] })
      const ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
      await ca.db('shopz').dropDatabase()
      await ca.db('shopz').collection('a1').insertOne({ n: 1 })
      await ca.db('shopz').collection('b2').insertOne({ n: 2 })
      await ca.close()
      const body = { scope: { kind: 'database', db: 'shopz' }, format: 'gzip' }
      const dp = (await admin.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
      const dj = await waitJob(
        h.t,
        (
          await admin.call('POST', `/api/connections/${h.ids.A}/backup`, { ...body, planHash: dp.planHash })
        ).json().job.id,
        60_000,
      )
      const backupId = (await admin.get(`/api/transfer/jobs/${dj.id}/report`)).json().backupId
      h.rules('B', [
        { db: 'shopz2', coll: 'a1', field: 'secret' },
        { db: 'shopz2', coll: 'b2', field: 'secret' },
      ])
      const listIndexes = Collection.prototype.listIndexes
      vi.spyOn(Collection.prototype, 'listIndexes').mockImplementation(function (
        this: Collection,
        ...args: unknown[]
      ) {
        if (this.dbName === 'shopz2' && this.collectionName === 'b2')
          return {
            toArray: () => Promise.reject(new MongoServerError({ message: 'not authorized', code: 13 })),
          } as never
        return listIndexes.apply(this, args as never)
      } as typeof listIndexes)
      const run = await restore(h, admin, {
        source: { kind: 'backup', backupId },
        mapping: [
          { from: { db: 'shopz', coll: 'a1' }, to: { db: 'shopz2', coll: 'a1' } },
          { from: { db: 'shopz', coll: 'b2' }, to: { db: 'shopz2', coll: 'b2' } },
        ],
        mode: 'insert',
      })
      expect(run.job.state).toBe('failed')
      expect(await cb.db('shopz2').listCollections().toArray()).toEqual([])
    } finally {
      vi.restoreAllMocks()
      await cb.db('shopz2').dropDatabase()
      await h.t.close()
    }
  }, 400_000)

  it('predicts in a dry run the documents the target would refuse (final review I7)', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user({ role: 'admin' })
      const ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
      await ca.db('shop').dropDatabase()
      await ca
        .db('shop')
        .collection('t')
        .insertMany([
          { _id: 1, v: 'a' },
          { _id: 2, v: 5 },
          { _id: 3, v: 'c' },
        ] as never)
      await ca.close()
      const body = { scope: { kind: 'collection', db: 'shop', coll: 't' }, format: 'gzip' }
      const dp = (await u.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
      const dj = await waitJob(
        h.t,
        (
          await u.call('POST', `/api/connections/${h.ids.A}/backup`, { ...body, planHash: dp.planHash })
        ).json().job.id,
        60_000,
      )
      const backupId = (await u.get(`/api/transfer/jobs/${dj.id}/report`)).json().backupId
      // The target holds _id 1 and wants v to be a string.
      await cb
        .db('shop3')
        .createCollection('t', { validator: { $jsonSchema: { properties: { v: { bsonType: 'string' } } } } })
      await cb
        .db('shop3')
        .collection('t')
        .insertOne({ _id: 1, v: 'old' } as never)
      const src = {
        source: { kind: 'backup', backupId },
        mapping: [{ from: { db: 'shop', coll: 't' }, to: { db: 'shop3', coll: 't' } }],
        dryRun: true,
      }
      const add = await restore(h, u, { ...src, mode: 'insert' })
      // _id 1 is already there; _id 2 fails the validator; _id 3 would be added.
      expect(add.report.namespaces[0]).toMatchObject({ read: 3, failed: 2 })
      const up = await restore(h, u, { ...src, mode: 'upsert' })
      expect(up.report.namespaces[0]).toMatchObject({ read: 3, wouldMatch: 1, failed: 1 })
      expect(await cb.db('shop3').collection('t').countDocuments()).toBe(1)
    } finally {
      await h.t.close()
    }
  }, 240_000)

  // Nineteenth review of explain masking (M-4): a record whose key matches is replaced as the run
  // replaces it: a stored personal value kept where the record holds the mask, refused where it
  // would change it; the dry run predicts both, not an insert's refusal.
  it('predicts a masked upsert restore of matched records as the run makes it', async () => {
    const h = await backupHarness(a, b)
    try {
      h.rules('B', [{ db: 'shopx2', coll: 't', field: 'secret' }])
      const u = h.user({ on: { A: 'admin', B: 'editor' }, masked: ['B'] })
      const ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
      await ca.db('shopx').dropDatabase()
      await ca
        .db('shopx')
        .collection('t')
        .insertMany([
          { _id: 1, secret: '***', v: 1 },
          { _id: 2, secret: 'new', v: 1 },
        ] as never)
      await ca.close()
      const body = { scope: { kind: 'collection', db: 'shopx', coll: 't' }, format: 'gzip' }
      const dp = (await u.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
      const dj = await waitJob(
        h.t,
        (
          await u.call('POST', `/api/connections/${h.ids.A}/backup`, { ...body, planHash: dp.planHash })
        ).json().job.id,
        60_000,
      )
      const backupId = (await u.get(`/api/transfer/jobs/${dj.id}/report`)).json().backupId
      await cb.db('shopx2').dropDatabase()
      await cb
        .db('shopx2')
        .collection('t')
        .insertMany([
          { _id: 1, secret: 'kept', v: 0 },
          { _id: 2, secret: 'old', v: 0 },
        ] as never)
      const src = {
        source: { kind: 'backup', backupId },
        mapping: [{ from: { db: 'shopx', coll: 't' }, to: { db: 'shopx2', coll: 't' } }],
        mode: 'upsert',
      }
      const dry = await restore(h, u, { ...src, dryRun: true })
      expect(dry.report.namespaces[0], JSON.stringify(dry.report.namespaces[0])).toMatchObject({
        read: 2,
        wouldMatch: 1,
        failed: 1,
      })
      const run = await restore(h, u, src)
      expect(run.report.namespaces[0], JSON.stringify(run.report.namespaces[0])).toMatchObject({
        read: 2,
        failed: 1,
      })
      const docs = await cb
        .db('shopx2')
        .collection('t')
        .find({}, { sort: { _id: 1 } })
        .toArray()
      expect(docs).toEqual([
        { _id: 1, secret: 'kept', v: 1 },
        { _id: 2, secret: 'old', v: 0 },
      ])
      await cb.db('shopx2').dropDatabase()
    } finally {
      await h.t.close()
    }
  }, 190_000)

  // Data review 2026-10-13 round 2 (Minor 1): a record the dry run refuses for its empty key is
  // refused once, not again by the validator; a null _id comes back as it was (Minor 3).
  it('refuses a record with an empty key once in a dry run, and keeps a null _id when added', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user({ role: 'admin' })
      const ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
      await ca.db('shop').dropDatabase()
      await ca
        .db('shop')
        .collection('t')
        .insertMany([
          { _id: 1, k: 'a', v: 'x' },
          { _id: 2, v: 5 },
        ] as never)
      await ca.db('shop').command({ insert: 't', documents: [{ _id: null, k: 'n', v: 'y' }] })
      await ca.close()
      const body = { scope: { kind: 'collection', db: 'shop', coll: 't' }, format: 'gzip' }
      const dp = (await u.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
      const dj = await waitJob(
        h.t,
        (
          await u.call('POST', `/api/connections/${h.ids.A}/backup`, { ...body, planHash: dp.planHash })
        ).json().job.id,
        60_000,
      )
      const backupId = (await u.get(`/api/transfer/jobs/${dj.id}/report`)).json().backupId
      await cb
        .db('shop4')
        .createCollection('t', { validator: { $jsonSchema: { properties: { v: { bsonType: 'string' } } } } })
      const src = {
        source: { kind: 'backup', backupId },
        mapping: [{ from: { db: 'shop', coll: 't' }, to: { db: 'shop4', coll: 't' } }],
      }
      const dry = await restore(h, u, { ...src, mode: 'upsert', keys: ['k'], dryRun: true })
      expect(dry.report.namespaces[0]).toMatchObject({ read: 3, failed: 1 })
      await cb.db('shop4').collection('t').drop()
      const added = await restore(h, u, { ...src, mode: 'insert' })
      expect(added.report.namespaces[0]).toMatchObject({ read: 3, inserted: 3 })
      expect(await cb.db('shop4').collection('t').findOne({ k: 'n' })).toEqual({ _id: null, k: 'n', v: 'y' })
    } finally {
      await h.t.close()
    }
  }, 240_000)

  it('keeps its file for as long as the restore may run (final review minor 5)', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user({ role: 'admin' })
      const id = await upload(u, fixture('shop.archive'))
      // A file about to expire when the restore starts.
      const started = h.ctx.now()
      h.ctx.store.db.prepare('UPDATE backups SET expires_at = ? WHERE id = ?').run(started + 1_000, id)
      await restore(h, u, { source: { kind: 'upload', uploadId: id }, mapping: map('shop2', ['empty']) })
      const after = h.ctx.backup.store.get(u.id, id)!.expiresAt
      expect(after).toBeGreaterThanOrEqual(started + h.ctx.backup.limits.maxJobMs)
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('adds the missing rules to the target before writing when an admin asks', async () => {
    const h = await backupHarness(a, b)
    try {
      h.rules('A', [{ db: 'shop', coll: 't', field: 'email' }])
      const ca = await new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect()
      await ca.db('shop').dropDatabase()
      await ca.db('shop').collection('t').insertOne({ email: 'a@x' })
      await ca.close()
      const u = h.user({ role: 'admin' })
      const body = { scope: { kind: 'collection', db: 'shop', coll: 't' }, format: 'gzip' }
      const dp = (await u.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
      const dj = await waitJob(
        h.t,
        (
          await u.call('POST', `/api/connections/${h.ids.A}/backup`, { ...body, planHash: dp.planHash })
        ).json().job.id,
        60_000,
      )
      const backupId = (await u.get(`/api/transfer/jobs/${dj.id}/report`)).json().backupId
      const r = await restore(h, u, {
        source: { kind: 'backup', backupId },
        mapping: [{ from: { db: 'shop', coll: 't' }, to: { db: 'shop2', coll: 't' } }],
        addRulesToTarget: true,
      })
      expect(r.job.state).toBe('done')
      expect(r.report.rulesAdded).toBe(1)
      expect(h.ctx.personalFields.get(h.ids.B).rules).toEqual([{ db: 'shop2', coll: 't', field: 'email' }])
    } finally {
      await h.t.close()
    }
  }, 180_000)
})
