// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { AggregationCursor, Collection } from 'mongodb'
import type { PreviewResponse } from '@mongo-manager/shared'
import { PreviewCache } from '../src/aggregation/cache'
import { runPreview } from '../src/aggregation/preview'
import { toClientDocument } from '../src/data/ejson-io'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, teamHarness, type DataHarness } from './support/data'
import { H } from './helpers'

let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
})
afterAll(async () => {
  await mongo?.stop()
})
const closers: Array<{ t: { close(): Promise<void> } }> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const h of closers.splice(0)) await h.t.close()
})

/** 50 documents {n, g: n % 3}: g = 1 for 17 of them. */
async function seed(h: { client(): Promise<import('mongodb').MongoClient> }) {
  const db = `d${randomUUID().slice(0, 8)}`
  const client = await h.client()
  await client
    .db(db)
    .collection('items')
    .insertMany(Array.from({ length: 50 }, (_, n) => ({ n, g: n % 3 })))
  return { db, client, path: `/databases/${db}/collections/items/aggregate/preview` }
}

async function local(): Promise<DataHarness> {
  const h = await dataHarness(mongo)
  closers.push(h)
  return h
}

const ns = (docs: ReadonlyArray<object>) =>
  docs.map((d) => (d as { document: { n: { $numberInt: string } } }).document.n.$numberInt).map(Number)

/** Counts aggregate calls, and the most that were running at once. */
function watchAggregates() {
  const stats = { calls: 0, active: 0, peak: 0, options: [] as unknown[] }
  const original = Collection.prototype.aggregate
  vi.spyOn(Collection.prototype, 'aggregate').mockImplementation(function (this: Collection, ...args) {
    stats.calls++
    stats.options.push(args[1])
    const cursor = original.apply(this, args as never) as AggregationCursor
    // A prefix is read document by document: its time is from the first read to the cursor's end.
    const iterate = cursor[Symbol.asyncIterator].bind(cursor)
    cursor[Symbol.asyncIterator] = async function* () {
      stats.active++
      stats.peak = Math.max(stats.peak, stats.active)
      try {
        await new Promise((r) => setTimeout(r, 20))
        yield* { [Symbol.asyncIterator]: iterate }
      } finally {
        stats.active--
      }
    } as never
    return cursor
  } as typeof original)
  return stats
}

describe('aggregation preview (phase 2a spec §3.2)', () => {
  it('previews every stage from one request, each on the growing prefix', async () => {
    const h = await local()
    const { path } = await seed(h)
    const res = await h.call('POST', path, {
      stages: [{ $match: { g: 1 } }, { $sort: { n: -1 } }, { $limit: 2 }],
      perStage: 5,
    })
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json() as PreviewResponse
    expect(body.stages).toHaveLength(3)
    const [a, b, c] = body.stages as Array<{ documents: Array<{ document?: unknown }>; count: number }>
    expect([a!.count, ns(a!.documents)]).toEqual([5, [1, 4, 7, 10, 13]])
    expect(ns(b!.documents)).toEqual([49, 46, 43, 40, 37])
    expect([c!.count, ns(c!.documents)]).toEqual([2, [49, 46]])
    expect(body.sample?.count).toBe(5)
  })

  it('runs every stage on the sample only: a $group counts the sampled documents', async () => {
    const h = await local()
    const { path } = await seed(h)
    const res = await h.call('POST', path, {
      stages: [{ $group: { _id: null, c: { $sum: 1 } } }],
      sample: { mode: 'limit', size: 10 },
    })
    const [group] = (res.json() as PreviewResponse).stages as Array<{
      documents: Array<{ document: unknown }>
    }>
    expect(group!.documents[0]!.document).toMatchObject({ c: { $numberInt: '10' } })
  })

  it('answers only the stages from `from` on, the earlier ones null', async () => {
    const h = await local()
    const { path } = await seed(h)
    const body = (
      await h.call('POST', path, { stages: [{ $match: {} }, { $skip: 1 }, { $limit: 1 }], from: 2 })
    ).json() as PreviewResponse
    expect(body.stages[0]).toBeNull()
    expect(body.stages[1]).toBeNull()
    expect(body.stages[2]).toMatchObject({ count: 1 })
    expect(body.sample).toBeNull()
  })

  it('answers the sample itself for an empty pipeline (Review Focus 4)', async () => {
    const h = await local()
    const { path } = await seed(h)
    const body = (await h.call('POST', path, { stages: [], perStage: 3 })).json() as PreviewResponse
    expect(body.stages).toEqual([])
    expect(ns(body.sample!.documents)).toEqual([0, 1, 2])
  })

  it('reuses a cached prefix instead of asking MongoDB again', async () => {
    const h = await local()
    const { path } = await seed(h)
    const body = { stages: [{ $match: { g: 1 } }, { $limit: 3 }] }
    await h.call('POST', path, body)
    const stats = watchAggregates()
    await h.call('POST', path, body)
    expect(stats.calls).toBe(0)
    // An edit of the last stage recomputes that stage only.
    await h.call('POST', path, { stages: [{ $match: { g: 1 } }, { $limit: 2 }], from: 1 })
    expect(stats.calls).toBe(1)
  })

  it('never serves one user the cache of another', async () => {
    const h = await teamHarness(mongo)
    closers.push(h)
    const { path } = await seed(h)
    const [a, b] = [h.user('editor'), h.user('viewer')]
    const body = { stages: [{ $match: { g: 2 } }] }
    expect((await a.call('POST', path, body)).statusCode).toBe(200)
    const stats = watchAggregates()
    const res = await b.call('POST', path, body)
    expect(res.statusCode, res.body).toBe(200)
    expect(stats.calls).toBeGreaterThan(0)
  })

  it('reports a failing stage, and skips the stages after it', async () => {
    const h = await local()
    const { path } = await seed(h)
    const body = (
      await h.call('POST', path, {
        stages: [{ $match: {} }, { $project: { a: { $bogus: 1 } } }, { $limit: 1 }],
      })
    ).json() as PreviewResponse
    expect(body.stages[0]).toMatchObject({ count: 20 })
    expect(body.stages[1]).toMatchObject({
      error: { code: expect.any(String), message: expect.stringContaining('$bogus') },
    })
    expect(body.stages[2]).toEqual({ skipped: 'previous' })
  })

  it('never runs a write stage in a preview', async () => {
    const h = await local()
    const { path, client, db } = await seed(h)
    const body = (
      await h.call('POST', path, { stages: [{ $match: {} }, { $out: 'copy' }] })
    ).json() as PreviewResponse
    expect(body.stages[1]).toEqual({ skipped: 'write' })
    const names = (await client.db(db).listCollections().toArray()).map((c) => c.name)
    expect(names).not.toContain('copy')
  })

  it('samples at random with $sample', async () => {
    const h = await local()
    const { path } = await seed(h)
    const stats = watchAggregates()
    const body = (
      await h.call('POST', path, {
        stages: [{ $match: {} }],
        sample: { mode: 'sample', size: 7 },
        perStage: 50,
      })
    ).json() as PreviewResponse
    expect(body.stages[0]).toMatchObject({ count: 7 })
    expect(stats.calls).toBeGreaterThan(0)
  })

  it('runs at most 4 prefixes at once, each tagged with the request comment and a time limit', async () => {
    const h = await local()
    const { path } = await seed(h)
    const stats = watchAggregates()
    const stages = Array.from({ length: 9 }, (_, i) => ({ $skip: i }))
    const res = await h.call('POST', path, { stages, maxTimeMS: 5000 })
    expect(res.statusCode).toBe(200)
    expect(stats.calls).toBe(10) // the sample and 9 prefixes
    expect(stats.peak).toBeLessThanOrEqual(4)
    expect(stats.peak).toBeGreaterThan(1)
    for (const options of stats.options)
      expect(options).toMatchObject({ comment: expect.stringMatching(/^mm:/), maxTimeMS: 5000 })
  })

  it('lets a viewer preview, and inspects the pipeline first', async () => {
    const h = await teamHarness(mongo)
    closers.push(h)
    const { path } = await seed(h)
    const viewer = h.user('viewer')
    expect((await viewer.call('POST', path, { stages: [{ $match: {} }] })).statusCode).toBe(200)
    const lookup = await viewer.call('POST', path, { stages: [{ $unionWith: 'system.users' }] })
    expect(lookup.statusCode).toBe(403)
    expect((await viewer.call('POST', path, { stages: [{ $currentOp: {} }] })).statusCode).toBe(400)
  })
})

describe('PreviewCache', () => {
  it('forgets entries after the TTL, and the least recently used beyond the maximum', () => {
    let now = 0
    const cache = new PreviewCache({ ttlMs: 1000, max: 2, now: () => now })
    const v = (count: number) => ({ documents: [], count })
    cache.set('a', v(1))
    cache.set('b', v(2))
    expect(cache.get('a')).toEqual(v(1)) // a is now the most recent
    cache.set('c', v(3))
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toEqual(v(1))
    now = 1001
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('c')).toBeUndefined()
  })
})

describe('preview fixes (final review 2a)', () => {
  it('runs a stage that must come first before the sample, not after it (I3)', async () => {
    const h = await local()
    const { path } = await seed(h)
    const body = (
      await h.call('POST', path, { stages: [{ $collStats: { count: {} } }, { $project: { count: 1 } }] })
    ).json() as PreviewResponse
    expect(body.stages[0]).toMatchObject({ count: 1 })
    expect(body.stages[1]).toMatchObject({ count: 1 })
  })

  it('keeps each stage preview within a byte budget, saying it was cut (I4)', async () => {
    const h = await local()
    const { client, db } = await seed(h)
    const big = 'x'.repeat(1_500_000)
    await client
      .db(db)
      .collection('big')
      .insertMany(Array.from({ length: 5 }, (_, n) => ({ n, big })))
    const res = await h.call('POST', `/databases/${db}/collections/big/aggregate/preview`, {
      stages: [{ $match: {} }],
      perStage: 5,
    })
    const stage = (res.json() as PreviewResponse).stages[0] as { documents: unknown[]; truncated?: boolean }
    expect(stage.truncated).toBe(true)
    expect(stage.documents.length).toBeLessThan(5)
    expect(res.body.length).toBeLessThan(2 * 5 * 1024 * 1024)
  })

  it('shows fresh previews after the builder wrote into the collection (Minor 9)', async () => {
    const h = await local()
    const { path, db } = await seed(h)
    const body = { stages: [{ $match: { g: 1 } }] }
    await h.call('POST', path, body)
    const stages = [{ $match: {} }, { $merge: { into: 'items', whenMatched: 'keepExisting' } }]
    const { token } = (
      await h.call('POST', `/databases/${db}/collections/items/aggregate/write-preview`, { stages })
    ).json()
    expect(
      (await h.call('POST', `/databases/${db}/collections/items/aggregate/write`, { stages, token }))
        .statusCode,
    ).toBe(200)
    const stats = watchAggregates()
    await h.call('POST', path, body)
    expect(stats.calls).toBeGreaterThan(0)
  })

  it('shows fresh previews after the connection was edited (Minor 9)', async () => {
    const h = await local()
    const { path } = await seed(h)
    const body = { stages: [{ $match: { g: 2 } }] }
    await h.call('POST', path, body)
    const headers = { ...H, 'x-csrf-token': h.t.app.ctx.localCsrfToken }
    const url = `/api/connections/${h.connectionId}`
    const { settings } = (await h.t.app.inject({ method: 'GET', url, headers })).json()
    // An edit of its settings (a new name alone changes nothing it was made of: manager-opening.test.ts).
    const edited = await h.t.app.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { settings: { ...settings, appName: 'edited' } },
    })
    expect(edited.statusCode, edited.body).toBe(200)
    const stats = watchAggregates()
    await h.call('POST', path, body)
    expect(stats.calls).toBeGreaterThan(0)
  })

  it('admits at most 4 previews at a time per user (Minor 11)', async () => {
    const h = await local()
    const { path } = await seed(h)
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const original = Collection.prototype.aggregate
    vi.spyOn(Collection.prototype, 'aggregate').mockImplementation(function (this: Collection, ...args) {
      const cursor = original.apply(this, args as never) as AggregationCursor
      const toArray = cursor.toArray.bind(cursor)
      cursor.toArray = async () => {
        await held
        return toArray()
      }
      return cursor
    } as typeof original)
    const requests = Array.from({ length: 5 }, (_, i) => h.call('POST', path, { stages: [{ $skip: i }] }))
    await new Promise((r) => setTimeout(r, 200))
    release()
    const codes = (await Promise.all(requests)).map((r) => r.statusCode).sort()
    expect(codes).toEqual([200, 200, 200, 200, 429])
  })
})

describe('an abandoned preview (final review 2a, I5)', () => {
  it('starts no new prefix once the client has gone', async () => {
    let calls = 0
    const collection = {
      aggregate: () => {
        calls++
        return {
          close: async () => undefined,
          // A prefix that answers nothing, after a while.
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise((r) => setTimeout(() => r({ done: true, value: undefined }), 20)),
          }),
        }
      },
    } as unknown as Collection
    let gone = false
    const running = runPreview({
      collection,
      stages: Array.from({ length: 12 }, (_, i) => ({ $skip: i })),
      sample: { mode: 'limit', size: 10 },
      perStage: 5,
      maxTimeMS: 1000,
      from: 0,
      comment: 'mm:t',
      cache: new PreviewCache({ ttlMs: 1000, max: 10 }),
      scope: { userId: null, connectionId: 'c', db: 'd', coll: 'e', view: 'full' },
      gone: () => gone,
      present: (doc) => toClientDocument(doc, () => randomBytes(32).toString('hex')),
    })
    gone = true
    await running
    expect(calls).toBe(4)
  })
})

// Security review 2026-10-13 (M3): a stage's documents are read one by one up to the byte cap —
// 50 of up to 16 MB each are never held at once — and the rest only counted.
describe('a stage preview past its byte cap', () => {
  it('stops keeping documents at the cap, never reading the whole stage into memory', async () => {
    const big = 'x'.repeat(400 * 1024)
    let presented = 0
    const collection = {
      aggregate: () => ({
        toArray: () => Promise.reject(new Error('the whole stage was read at once')),
        close: async () => undefined,
        async *[Symbol.asyncIterator]() {
          for (let n = 0; n < 50; n++) yield { _id: n, big }
        },
      }),
    } as unknown as Collection
    const res = await runPreview({
      collection,
      stages: [],
      sample: { mode: 'limit', size: 50 },
      perStage: 50,
      maxTimeMS: 1000,
      from: 0,
      comment: 'mm:t',
      cache: new PreviewCache({ ttlMs: 1000, max: 10 }),
      scope: { userId: null, connectionId: 'c', db: 'd', coll: 'e', view: 'full' },
      present: (doc) => (presented++, toClientDocument(doc, () => 'h'.repeat(64))),
    })
    expect(res.sample).toMatchObject({ count: 50, truncated: true })
    expect(res.sample!.documents.length).toBeLessThan(15)
    expect(presented).toBeLessThan(15)
  })
})

describe('PreviewCache byte budget (final review 2a, I4)', () => {
  it('keeps no result above the entry limit, and evicts to stay within its bytes', () => {
    const cache = new PreviewCache({ ttlMs: 1000, max: 100, maxBytes: 100, maxEntryBytes: 60 })
    const v = (count: number) => ({ documents: [], count })
    cache.set('big', v(1), 61)
    expect(cache.get('big')).toBeUndefined()
    cache.set('a', v(1), 50)
    cache.set('b', v(2), 50)
    cache.set('c', v(3), 50)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toEqual(v(2))
    expect(cache.get('c')).toEqual(v(3))
  })
})
