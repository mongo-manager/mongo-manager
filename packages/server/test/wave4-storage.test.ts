// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { CompactEstimate, ShardKeyAnalysis, StorageReport } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { teamHarness } from './support/data'
import { slow, SET_START_MS } from './support/slowness'

/**
 * Plugins wave 4 (2026-10-27): what the storage report, compact and the shard key analyzer read
 * through the app — as the user, with their rights; nothing a restricted user may not know.
 */
let mongo: TestMongo
let client: MongoClient
let set: MongoMemoryReplSet
const DB = 'wave4'
beforeAll(async () => {
  ;[mongo, set] = await Promise.all([startMongo(), MongoMemoryReplSet.create({ replSet: { count: 1 } })])
  client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
  const big = client.db(DB).collection('big')
  await big.insertMany(
    Array.from({ length: 2000 }, (_, i) => ({ n: i, email: `p${i}@example.com`, pad: 'x'.repeat(200) })),
  )
  await big.createIndex({ email: 1 })
  // Space freed inside the files, for compact to give back.
  await big.deleteMany({ n: { $lt: 1500 } })
  await client.db(DB).collection('plain').insertOne({ a: 1 })
  await client.db(DB).createCollection('view', { viewOn: 'plain', pipeline: [] })
}, slow(SET_START_MS))
afterAll(async () => {
  await client?.close()
  await Promise.all([mongo?.stop(), set?.stop()])
})

const version = async () => String((await client.db('admin').command({ buildInfo: 1 })).version)
const atLeast = async (major: number) => Number((await version()).split('.')[0]) >= major

describe('a database’s storage', () => {
  it('says each collection’s sizes, free space and indexes; a view is not storage', async () => {
    const h = await teamHarness(mongo)
    try {
      const res = await h.user('viewer').call('GET', `/databases/${DB}/storage`)
      expect(res.statusCode, res.body).toBe(200)
      const report = res.json() as StorageReport
      expect(report.more).toBe(false)
      expect(report.collections.map((c) => c.name)).toEqual(['big', 'plain'])
      const big = report.collections[0]!
      expect(big).toMatchObject({ type: 'collection', count: 500 })
      expect(big.storageSize).toBeGreaterThan(0)
      expect(big.size).toBeGreaterThan(0)
      expect(big.freeBytes).toEqual(expect.any(Number))
      expect(big.indexes.map((i) => i.name).sort()).toEqual(['_id_', 'email_1'])
      expect(big.indexSize).toBe(big.indexes.reduce((n, i) => n + i.size!, 0))
    } finally {
      await h.t.close()
    }
  })

  it('hides the sizes of a collection the rules reach from a restricted user, keeping its count', async () => {
    const h = await teamHarness(mongo)
    try {
      h.t.app.ctx.personalFields.set(h.connectionId, [{ db: DB, coll: 'big', field: 'email' }])
      const masked = h.user('editor')
      h.t.app.ctx.grants.set(h.connectionId, masked.id, 'editor')
      h.t.app.ctx.grants.setMasked(h.connectionId, masked.id, true)
      const report = (await masked.call('GET', `/databases/${DB}/storage`)).json() as StorageReport
      const big = report.collections.find((c) => c.name === 'big')!
      expect(big).toMatchObject({
        count: 500,
        size: null,
        storageSize: null,
        freeBytes: null,
        indexSize: null,
        indexFreeBytes: null,
        sizesHidden: true,
      })
      expect(big.indexes.every((i) => i.size === null && i.freeBytes === null)).toBe(true)
      expect(report.collections.find((c) => c.name === 'plain')!.size).toEqual(expect.any(Number))
    } finally {
      await h.t.close()
    }
  })
})

describe('compact', () => {
  it('estimates what compact would give back (MongoDB 8.0+), for a connection admin only', async () => {
    const h = await teamHarness(mongo)
    try {
      const res = await h.user('admin').call('POST', `/databases/${DB}/collections/big/compact-estimate`)
      expect(res.statusCode, res.body).toBe(200)
      const estimate = res.json() as CompactEstimate
      if (await atLeast(8)) expect(estimate).toEqual({ available: true, estimatedBytes: expect.any(Number) })
      else expect(estimate).toEqual({ available: false, reason: 'version' })
      expect(
        (await h.user('editor').call('POST', `/databases/${DB}/collections/big/compact-estimate`)).statusCode,
      ).toBe(403)
    } finally {
      await h.t.close()
    }
  })

  it('compacts only on the collection’s name typed, audited, never on a read-only connection', async () => {
    const h = await teamHarness(mongo)
    try {
      const admin = h.user('admin')
      const path = `/databases/${DB}/collections/big/compact`
      expect((await admin.call('POST', path, { confirm: 'other' })).statusCode).toBe(400)
      expect((await admin.call('POST', path, {})).statusCode).toBe(400)
      const done = await admin.call('POST', path, { confirm: 'big' })
      expect(done.statusCode, done.body).toBe(200)
      expect(done.json()).toEqual({ bytesFreed: expect.any(Number) })
      expect(h.t.app.ctx.audit.list({ action: 'collections.compact' }).length).toBeGreaterThan(0)
      expect((await h.user('editor').call('POST', path, { confirm: 'big' })).statusCode).toBe(403)
    } finally {
      await h.t.close()
    }
    const ro = await teamHarness(mongo, {}, { readOnly: true })
    try {
      const res = await ro
        .user('admin')
        .call('POST', `/databases/${DB}/collections/big/compact`, { confirm: 'big' })
      expect(res.statusCode).toBe(403)
    } finally {
      await ro.t.close()
    }
  })

  it('refuses a restricted user compact where the rules reach', async () => {
    const h = await teamHarness(mongo)
    try {
      h.t.app.ctx.personalFields.set(h.connectionId, [{ db: DB, coll: 'big', field: 'email' }])
      // An administrator who hides the values from themselves (the one restricted admin there is).
      const masked = h.user('admin')
      h.t.app.ctx.personalFields.setHiddenFromSelf(h.connectionId, masked.id, true)
      expect(
        (await masked.call('POST', `/databases/${DB}/collections/big/compact-estimate`)).statusCode,
      ).toBe(403)
    } finally {
      await h.t.close()
    }
  })
})

describe('a shard key’s analysis', () => {
  it('says a standalone server cannot analyse, and refuses a key that is not one', async () => {
    const h = await teamHarness(mongo)
    try {
      const path = `/databases/${DB}/collections/big/shard-key-analysis`
      const viewer = h.user('viewer')
      const res = await viewer.call('POST', path, { key: { email: 1 } })
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toEqual({
        available: false,
        reason: (await atLeast(7)) ? 'standalone' : 'version',
      })
      for (const key of [{}, { $bad: 1 }, { a: -1 }, { a: 'hashed', b: 'hashed' }])
        expect((await viewer.call('POST', path, { key })).statusCode, JSON.stringify(key)).toBe(400)
    } finally {
      await h.t.close()
    }
  })

  it('analyses a candidate key on a replica set: cardinality, common values, monotonicity', async () => {
    const setClient = await new MongoClient(set.getUri()).connect()
    const coll = setClient.db(DB).collection('orders')
    await coll.insertMany(
      Array.from({ length: 300 }, (_, i) => ({ seq: i, city: ['Izmir', 'Ankara', 'Bursa'][i % 3] })),
    )
    await coll.createIndex({ city: 1 })
    await coll.createIndex({ seq: 1 })
    const port = Number(new URL(set.getUri().replace('mongodb://', 'http://')).port)
    const h = await teamHarness({ port } as TestMongo)
    try {
      if (!(await atLeast(7))) return
      const viewer = h.user('viewer')
      const path = `/databases/${DB}/collections/orders/shard-key-analysis`
      const city = (await viewer.call('POST', path, { key: { city: 1 } })).json() as ShardKeyAnalysis
      expect(city).toMatchObject({ available: true, numDistinctValues: 3, monotonicity: 'not monotonic' })
      if (city.available)
        expect(city.mostCommonValues.map((v) => v.value).sort()).toEqual(['Ankara', 'Bursa', 'Izmir'])
      const seq = (await viewer.call('POST', path, { key: { seq: 1 } })).json() as ShardKeyAnalysis
      expect(seq).toMatchObject({ available: true, numDistinctValues: 300, monotonicity: 'monotonic' })
      // No index starting with the key: said so.
      expect((await viewer.call('POST', path, { key: { nope: 1 } })).json()).toEqual({
        available: false,
        reason: 'no_index',
      })
      // A restricted user where the rules reach: refused (its values are data).
      h.t.app.ctx.personalFields.set(h.connectionId, [{ db: DB, coll: 'orders', field: 'city' }])
      const masked = h.user('editor')
      h.t.app.ctx.grants.set(h.connectionId, masked.id, 'editor')
      h.t.app.ctx.grants.setMasked(h.connectionId, masked.id, true)
      expect((await masked.call('POST', path, { key: { city: 1 } })).statusCode).toBe(403)
    } finally {
      await h.t.close()
      await setClient.close()
    }
  })
})

describe('storage and analysis as read', () => {
  it('adds up what each shard says, free space included', async () => {
    const { storageOf } = await import('../src/routes/data/storage')
    const shard = (size: number, free: number, idx: number, idxFree: number) => ({
      count: 10,
      storageStats: {
        size,
        storageSize: size * 2,
        totalIndexSize: idx,
        indexSizes: { _id_: idx },
        wiredTiger: { 'block-manager': { 'file bytes available for reuse': free } },
        indexDetails: { _id_: { 'block-manager': { 'file bytes available for reuse': idxFree } } },
      },
    })
    expect(storageOf('c', 'collection', [shard(100, 5, 40, 2), shard(50, 1, 10, 3)], false)).toEqual({
      name: 'c',
      type: 'collection',
      count: 20,
      size: 150,
      storageSize: 300,
      freeBytes: 6,
      indexSize: 50,
      indexFreeBytes: 5,
      indexes: [{ name: '_id_', size: 50, freeBytes: 5 }],
    })
  })

  it('names a compound key’s common values whole, and an unknown monotonicity as unknown', async () => {
    const { analysisOf } = await import('../src/routes/data/storage')
    const a = analysisOf(
      {
        keyCharacteristics: {
          numDistinctValues: 2,
          mostCommonValues: [{ value: { city: 'Izmir', n: 1 }, frequency: 7 }],
          monotonicity: { type: 'unknown' },
        },
      },
      { city: 1, n: 1 },
    )
    expect(a).toMatchObject({
      available: true,
      numDistinctValues: 2,
      numDocsTotal: null,
      isUnique: null,
      // Canonical EJSON: a number keeps its type.
      mostCommonValues: [{ value: { city: 'Izmir', n: { $numberInt: '1' } }, frequency: 7 }],
      monotonicity: 'unknown',
    })
  })
})

describe('the final review of wave 4', () => {
  it('hides a GridFS bucket’s chunk sizes where a rule reaches its files (Minor 6)', async () => {
    await client.db(DB).collection('fs.files').insertOne({ filename: 'a', length: 1, chunkSize: 255 })
    await client
      .db(DB)
      .collection('fs.chunks')
      .insertOne({ files_id: 1, n: 0, data: Buffer.from('x') })
    const h = await teamHarness(mongo)
    try {
      h.t.app.ctx.personalFields.set(h.connectionId, [{ db: DB, coll: 'fs.files', field: 'filename' }])
      const masked = h.user('editor')
      h.t.app.ctx.grants.set(h.connectionId, masked.id, 'editor')
      h.t.app.ctx.grants.setMasked(h.connectionId, masked.id, true)
      const report = (await masked.call('GET', `/databases/${DB}/storage`)).json() as StorageReport
      expect(report.collections.find((c) => c.name === 'fs.chunks')).toMatchObject({
        size: null,
        sizesHidden: true,
      })
      const stats = (await masked.call('GET', `/databases/${DB}/collections/fs.chunks/stats`)).json()
      expect(stats).toMatchObject({ size: null, sizesHidden: true })
    } finally {
      await h.t.close()
      await client.db(DB).collection('fs.files').drop()
      await client.db(DB).collection('fs.chunks').drop()
    }
  })

  it('counts a time series’ measurements, and offers it no compact (Minor 5, 7)', async () => {
    await client.db(DB).createCollection('ticks', { timeseries: { timeField: 't', metaField: 'm' } })
    await client
      .db(DB)
      .collection('ticks')
      .insertMany([0, 1, 2].map((i) => ({ t: new Date(Date.UTC(2026, 0, 1, 0, i)), m: 'a', v: i })))
    const h = await teamHarness(mongo)
    try {
      const report = (await h.user('viewer').call('GET', `/databases/${DB}/storage`)).json() as StorageReport
      expect(report.collections.find((c) => c.name === 'ticks')).toMatchObject({
        type: 'timeseries',
        count: 3,
      })
      const admin = h.user('admin')
      expect(
        (await admin.call('POST', `/databases/${DB}/collections/ticks/compact-estimate`)).json(),
      ).toEqual({ available: false, reason: 'timeseries' })
      expect(
        (await admin.call('POST', `/databases/${DB}/collections/ticks/compact`, { confirm: 'ticks' }))
          .statusCode,
      ).toBe(400)
    } finally {
      await h.t.close()
      await client.db(DB).collection('ticks').drop()
    }
  })

  it('refuses a restricted user compact itself where the rules reach (Minor 20)', async () => {
    const h = await teamHarness(mongo)
    try {
      h.t.app.ctx.personalFields.set(h.connectionId, [{ db: DB, coll: 'big', field: 'email' }])
      const masked = h.user('admin')
      h.t.app.ctx.personalFields.setHiddenFromSelf(h.connectionId, masked.id, true)
      const res = await masked.call('POST', `/databases/${DB}/collections/big/compact`, { confirm: 'big' })
      expect(res.statusCode).toBe(403)
      expect(
        h.t.app.ctx.audit.list({ action: 'collections.compact' }).filter((a) => a.outcome === 'success'),
      ).toHaveLength(0)
    } finally {
      await h.t.close()
    }
  })

  it('refuses a key field named as an integer: JavaScript would reorder it (Minor 13)', async () => {
    const h = await teamHarness(mongo)
    try {
      const res = await h
        .user('viewer')
        .call('POST', `/databases/${DB}/collections/big/shard-key-analysis`, { key: { a: 1, '0': 1 } })
      expect(res.statusCode).toBe(400)
    } finally {
      await h.t.close()
    }
  })

  it('reads a version it cannot tell as too old, and a refusal by its kind (Minor 1, 13)', async () => {
    const { versionAtLeast, shardKeyRefusal } = await import('../src/routes/data/storage')
    expect(versionAtLeast('8.0.4', 8)).toBe(true)
    expect(versionAtLeast('7.0.12', 8)).toBe(false)
    expect(versionAtLeast(undefined, 8)).toBe(false)
    expect(versionAtLeast('x', 7)).toBe(false)
    expect(shardKeyRefusal({ code: 59 })).toBe('version')
    expect(shardKeyRefusal({ code: 27, errmsg: 'index not found' })).toBe('no_index')
    expect(
      shardKeyRefusal({ code: 20, errmsg: 'Cannot analyze a shard key without a supporting index' }),
    ).toBe('no_index')
    expect(shardKeyRefusal({ code: 20, errmsg: 'Cannot analyze a shard key for a view' })).toBeNull()
  })

  it('says a free space WiredTiger did not tell is not known, never 0 (Minor 7)', async () => {
    const { storageOf } = await import('../src/routes/data/storage')
    const c = storageOf(
      'c',
      'collection',
      [{ count: 1, storageStats: { size: 10, storageSize: 20, totalIndexSize: 5, indexSizes: { _id_: 5 } } }],
      false,
    )
    expect(c).toMatchObject({
      freeBytes: null,
      indexFreeBytes: null,
      indexes: [{ name: '_id_', size: 5, freeBytes: null }],
    })
  })
})

describe('compact before MongoDB 8.0', () => {
  it(
    'says there is no estimate, never fails',
    async () => {
      const old = await startMongo({ version: '7.0.45' })
      try {
        const h = await teamHarness(old)
        try {
          const c = await h.client()
          await c.db(DB).collection('x').insertOne({ a: 1 })
          const res = await h.user('admin').call('POST', `/databases/${DB}/collections/x/compact-estimate`)
          expect(res.statusCode, res.body).toBe(200)
          expect(res.json()).toEqual({ available: false, reason: 'version' })
        } finally {
          await h.t.close()
        }
      } finally {
        await old.stop()
      }
    },
    slow(120_000),
  )
})
