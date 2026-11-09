// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { transferHarness } from './support/transfer2'
import { waitJob } from './support/jobs'
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
      { _id: 1 as never, v: 1, email: 'a@x', at: 1 },
      { _id: 2 as never, v: 2, email: 'b@x', at: 1 },
      { _id: 3 as never, v: 3, email: 'c@x', at: 1 },
    ])
  await cb
    .db('shop')
    .collection('orders')
    .insertMany([
      { _id: 2 as never, v: 9, email: 'b@x', at: 2 },
      { _id: 3 as never, v: 3, email: 'c@x', at: 2 },
      { _id: 4 as never, v: 4, email: 'd@x', at: 2 },
    ])
})

type H = Awaited<ReturnType<typeof transferHarness>>
const URL_ = (h: H) => `/api/connections/${h.ids.A}/databases/shop/collections/orders/compare`

async function compare(h: H, u: ReturnType<H['user']>, body: object) {
  const res = await u.call('POST', URL_(h), body)
  expect(res.statusCode, res.body).toBe(202)
  const job = await waitJob(h.t, res.json().job.id, 60_000)
  return { job, report: (await u.get(`/api/transfer/jobs/${job.id}/report`)).json() }
}

describe('compare (phase 3d-2 spec §6)', () => {
  it('counts the four groups with samples and field diffs; ignored fields and a filter apply to both sides', async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user({ role: 'editor' })
      const target = { connectionId: h.ids.B, db: 'shop', coll: 'orders' }
      const { job, report } = await compare(h, u, { target, ignore: ['at'] })
      expect(job.state, job.error ?? '').toBe('done')
      expect(job.targetConnectionId).toBe(h.ids.B)
      expect(report.collections[0]).toMatchObject({ onlySource: 1, onlyTarget: 1, different: 1, same: 1 })
      expect(report.collections[0].samples.onlySource[0].id).toEqual({ $numberInt: '1' })
      expect(report.collections[0].samples.different[0].changes).toEqual([
        { path: 'v', before: { $numberInt: '9' }, after: { $numberInt: '2' } },
      ])
      const filtered = await compare(h, u, { target, ignore: ['at'], filter: { _id: { $gte: 3 } } })
      expect(filtered.report.collections[0]).toMatchObject({
        onlySource: 0,
        onlyTarget: 1,
        different: 0,
        same: 1,
      })
    } finally {
      await h.t.close()
    }
  }, 180_000)

  it('compare masks both sides when the caller is restricted on the target', async () => {
    const h = await transferHarness(a, b)
    try {
      h.rules('B', [{ db: 'shop', coll: 'orders', field: 'email' }])
      await ca
        .db('shop')
        .collection('orders')
        .updateOne({ _id: 3 as never }, { $set: { email: 'guess@x' } })
      const u = h.user({ role: 'editor', masked: ['B'] })
      const target = { connectionId: h.ids.B, db: 'shop', coll: 'orders' }
      const { report } = await compare(h, u, { target, ignore: ['at'] })
      // _id 3 differs only in the hidden email: masked on both sides, it is "same".
      expect(report.collections[0]).toMatchObject({ same: 1, different: 1, onlySource: 1, onlyTarget: 1 })
      expect(report.masked).toBe(true)
      const text = JSON.stringify(report)
      for (const hidden of ['d@x', 'c@x', 'b@x']) expect(text).not.toContain(hidden)
      const filtered = await u.call('POST', URL_(h), { target, filter: { email: 'c@x' } })
      expect(filtered.statusCode).toBe(403)
      // Tenth review of the open's stop (minor 1): the refusal names the field, as the masking
      // gate's do, so the user is told which one, not "undefined" or a query they never wrote.
      // Eleventh review (minor 2): as the gate's refusals, with the namespace.
      expect(filtered.json().details).toMatchObject({
        reason: 'personal_field',
        field: 'email',
        ns: 'shop.orders',
      })
      const ignored = await u.call('POST', URL_(h), { target, ignore: ['email'] })
      expect(ignored.statusCode).toBe(403)
      expect(ignored.json().details).toMatchObject({ reason: 'personal_field', field: 'email' })
      h.rules('B', [{ db: 'shop', coll: 'orders', field: '_id.k' }])
      const byId = await u.call('POST', URL_(h), { target })
      expect(byId.statusCode, byId.body).toBe(403)
      expect(byId.json().details).toMatchObject({ reason: 'personal_field', field: '_id', ns: 'shop.orders' })
      // Twelfth review (minor 1): the side whose rule it is, here the target's own collection.
      h.rules('B', [{ db: 'shop', coll: 'orders_b', field: 'notes' }])
      const onTarget = { connectionId: h.ids.B, db: 'shop', coll: 'orders_b' }
      const named = await u.call('POST', URL_(h), { target: onTarget, ignore: ['notes'] })
      expect(named.statusCode, named.body).toBe(403)
      expect(named.json().details).toMatchObject({ field: 'notes', ns: 'shop.orders_b' })
      // Twelfth review (nit 2): as the gate's, a long path is cut short.
      const long = `notes.${'x'.repeat(250)}`
      const cut = await u.call('POST', URL_(h), { target: onTarget, ignore: [long] })
      expect(cut.statusCode, cut.body).toBe(403)
      expect(cut.json().details.field).toBe(`${long.slice(0, 200)}…`)
      // Twelfth review (minor 2): the server's own words name no query either.
      expect(cut.json().message).not.toMatch(/query/i)
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('compares chosen collections of a database, with bounded samples', async () => {
    const h = await transferHarness(a, b)
    try {
      await ca
        .db('shop')
        .collection('many')
        .insertMany(Array.from({ length: 30 }, (_, i) => ({ _id: i as never })))
      const u = h.user({ role: 'editor' })
      const res = await u.call('POST', `/api/connections/${h.ids.A}/databases/shop/compare`, {
        target: { connectionId: h.ids.B, db: 'shop' },
        collections: ['orders', 'many'],
      })
      expect(res.statusCode, res.body).toBe(202)
      const job = await waitJob(h.t, res.json().job.id, 60_000)
      const report = (await u.get(`/api/transfer/jobs/${job.id}/report`)).json()
      const many = report.collections.find((c: { source: string }) => c.source === 'many')
      expect(many).toMatchObject({ onlySource: 30 })
      expect(many.samples.onlySource).toHaveLength(10)
    } finally {
      await h.t.close()
    }
  }, 90_000)
})
