// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { compileRules } from '../src/masking/match'
import { Shape } from '../src/masking/gate/shape'
import { newCtx } from '../src/masking/gate/context'
import { guardValue } from '../src/masking/gate/expression'
import { startMongo, type TestMongo } from './support/mongo'
import { slow } from './support/slowness'

/** Phase 3c §3.3: the type guard, proven on a real server rather than by reading the expression. */
const SENTINEL = 'S3NT1N3L'
let mongo: TestMongo
let client: MongoClient
beforeAll(async () => {
  mongo = await startMongo()
  client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
  await client
    .db('g')
    .collection('c')
    .insertOne({
      name: 'n',
      customer: { phone: SENTINEL, city: 'x' },
      items: [{ cardNo: SENTINEL, qty: 2 }],
      tags: ['a', 'b'],
    })
}, slow(120_000))
afterAll(async () => {
  await client?.close()
  await mongo?.stop()
})

const masker = compileRules([
  { db: 'g', coll: 'c', field: 'customer.phone' },
  { db: 'g', coll: 'c', field: 'items.cardNo' },
])
const deps = { masker, view: async () => null, indexes: async () => [] }
const guarded = (expr: unknown) =>
  guardValue(expr, new Shape('g.c', masker.forNs('g', 'c').patterns), newCtx(deps, 'g'))
const run = (expr: unknown) =>
  client
    .db('g')
    .collection('c')
    .aggregate([{ $project: { _id: 0, out: guarded(expr) } }])
    .toArray()

describe('the type guard on a real server (phase 3c §3.3)', () => {
  it.each<[string, unknown]>([
    ['$objectToArray', { $objectToArray: '$customer' }],
    ['$getField with input', { $getField: { field: 'phone', input: '$customer' } }],
    ['$mergeObjects', { $ifNull: [{ $mergeObjects: ['$customer'] }, null] }],
    ['$convert', { $convert: { input: '$customer', to: 'string', onError: 'e', onNull: 'n' } }],
    ['$$ROOT', { $objectToArray: '$$ROOT' }],
    ['$filter', { $filter: { input: '$items', cond: true } }],
  ])('%s reaches no personal value', async (_label, expr) => {
    const result = await run(expr).catch((e: Error) => [{ error: e.message }])
    expect(JSON.stringify(result)).not.toContain(SENTINEL)
  })

  it('cannot compare a guarded document with a guess', async () => {
    const [doc] = await run({ $eq: ['$customer', { phone: SENTINEL, city: 'x' }] })
    expect(doc).toEqual({ out: false })
  })

  it('groups documents of a may-hold path into one hidden key', async () => {
    const out = await client
      .db('g')
      .collection('c')
      .aggregate([{ $group: { _id: guarded('$customer'), n: { $sum: 1 } } }])
      .toArray()
    expect(out).toEqual([{ _id: '***', n: 1 }])
  })

  it('still lets clean values through', async () => {
    const [size] = await run({ $size: '$tags' })
    expect(size).toEqual({ out: 2 })
    const [qty] = await run({ $map: { input: '$items', in: '$$this.qty' } })
    expect(qty).toEqual({ out: [2] })
  })
})
