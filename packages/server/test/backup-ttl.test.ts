// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { countExpiring } from '../src/backup/restore-job'
import { collectionExpiry, ttlRulesOf } from '../src/backup/restore-plan'
import { slow } from './support/slowness'

// Backup review M10, I5: what deletes restored documents by age, and how many at once.
describe('age rules of a restored collection', () => {
  it('reads TTL indexes of one field with their partial filters, and a collection-level expiry', () => {
    expect(
      ttlRulesOf([
        { key: { at: 1 }, name: 'at_ttl', expireAfterSeconds: 3600, partialFilterExpression: { k: 1 } },
        { key: { email: 1 }, name: 'email_1' },
        { key: { a: 1, b: 1 }, name: 'two', expireAfterSeconds: 10 },
        { key: { z: 1 }, name: 'z', expireAfterSeconds: 0 },
      ]),
    ).toEqual([
      { field: 'at', ms: 3_600_000, partial: { k: 1 } },
      { field: 'z', ms: 0 },
    ])
    expect(collectionExpiry({ clusteredIndex: { key: { _id: 1 } }, expireAfterSeconds: 60 })).toEqual([
      { field: '_id', ms: 60_000 },
    ])
    // A restore writes a time series' buckets: their latest time is what expires.
    expect(collectionExpiry({ timeseries: { timeField: 't' }, expireAfterSeconds: 60 })).toEqual([
      { field: 'control.max.t', ms: 60_000 },
    ])
    expect(collectionExpiry({ capped: true })).toEqual([])
  })
})

describe('counting what expires at once', () => {
  let m: TestMongo
  let c: MongoClient
  beforeAll(async () => {
    m = await startMongo()
    c = await new MongoClient(`mongodb://127.0.0.1:${m.port}`).connect()
  }, slow(180_000))
  afterAll(async () => {
    await c?.close()
    await m?.stop()
  })
  const opts = { comment: 'test', maxTimeMS: 30_000 }

  it('counts as the server reads it: arrays, paths through arrays, partial filters, only dates', async () => {
    const now = Date.UTC(2026, 9, 14)
    const old = new Date(now - 7_200_000)
    const fresh = new Date(now - 60_000)
    const docs = [
      { _id: 1, at: old, kind: 'log' },
      { _id: 2, at: fresh, kind: 'log' },
      { _id: 3, at: [fresh, old], kind: 'log' },
      { _id: 4, at: old, kind: 'other' },
      { _id: 5, at: '2000-01-01', kind: 'log' },
      { _id: 6, events: [{ at: old }] },
      // A field name an expression would read as an operator is data here.
      { _id: 7, $odd: 1, at: old, kind: 'log' },
    ]
    const rules = [
      { field: 'at', ms: 3_600_000, partial: { kind: { $eq: 'log' } } },
      { field: 'events.at', ms: 3_600_000 },
    ]
    expect(await countExpiring(c.db('t'), docs, rules, now, opts)).toBe(4)
    expect(await countExpiring(c.db('t'), docs, [], now, opts)).toBe(0)
  })

  it('counts a document with a very large array of dates (review M2), and batches of any size', async () => {
    const now = Date.now()
    const dates = Array.from({ length: 250_000 }, (_, i) => new Date(now - i))
    dates.push(new Date(now - 7_200_000))
    const many = Array.from({ length: 3000 }, (_, i) => ({
      _id: i,
      at: new Date(now - 7_200_000),
      pad: 'x'.repeat(4000),
    }))
    const rules = [{ field: 'at', ms: 3_600_000 }]
    expect(await countExpiring(c.db('t'), [{ _id: 'big', at: dates }], rules, now, opts)).toBe(1)
    expect(await countExpiring(c.db('t'), many, rules, now, opts)).toBe(3000)
  })
})
