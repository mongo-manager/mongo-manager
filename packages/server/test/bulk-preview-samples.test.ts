// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Collection, MongoClient, type Document } from 'mongodb'
import { deserializeValue } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, type DataHarness } from './support/data'
import { restrictedApp } from './support/restricted'
import type { TestApp } from './helpers'

/**
 * W2.3 (2026-10-16): a bulk update's preview shows a few sampled documents before and after the
 * change, computed by MongoDB in an aggregation (nothing is written), masked as any read is.
 */
let mongo: TestMongo
let client: MongoClient
beforeAll(async () => {
  mongo = await startMongo()
  client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
})
afterAll(async () => {
  await client?.close()
  await mongo?.stop()
})
const harnesses: DataHarness[] = []
const apps: TestApp[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const h of harnesses.splice(0)) await h.t.close()
  for (const t of apps.splice(0)) await t.close()
})

interface Sample {
  before: Record<string, unknown>
  after?: Record<string, unknown>
  fails?: true
}
type Samples = { documents: Sample[] } | { unavailable: string }

async function setup(docs: Document[]) {
  const h = await dataHarness(mongo)
  harnesses.push(h)
  const db = `d${randomUUID().slice(0, 8)}`
  const coll = client.db(db).collection('items')
  await coll.insertMany(docs)
  return { h, coll, base: `/databases/${db}/collections/items` }
}

const DOCS = (): Document[] => [
  {
    _id: 1,
    n: 1,
    tag: 'a',
    meta: { views: 3, label: 'x' },
    list: [1, 2, 3],
    set: ['p'],
    old: 'keep',
    lo: 5,
    m: 5,
    hi: 5,
  },
  { _id: 2, n: 2.5, tag: 'b', list: [], lo: 1, hi: 9, m: 1 },
  { _id: 3, n: 3, tag: 'c', meta: { views: 0 }, list: [7], set: ['p', 'q'], old: 'go' },
  { _id: 4, n: 4, tag: 'd' },
]

describe('bulk update preview samples', () => {
  it('shows each sampled document as the update would leave it, exactly, without writing', async () => {
    const { h, coll, base } = await setup(DOCS())
    const update = {
      $set: { tag: 'z', 'meta.label': 'new', 'deep.a.b': true },
      $unset: { hi: '' },
      $inc: { n: 10, 'meta.views': 1 },
      $mul: { lo: 2 },
      $min: { m: 3 },
      $max: { score: 7 },
      $rename: { old: 'renamed' },
      $push: { list: { $each: [8, 9] } },
      $addToSet: { set: 'q' },
    }
    const request = { filter: { _id: { $lte: 3 } }, operation: 'update', update }
    const before = await coll.find().sort({ _id: 1 }).toArray()
    const res = await h.call('POST', `${base}/bulk/preview`, request)
    expect(res.statusCode).toBe(200)
    const preview = res.json() as { matched: number; samples: Samples; filterHash: string }
    expect(preview.matched).toBe(3)
    // Nothing written by the preview.
    expect(await coll.find().sort({ _id: 1 }).toArray()).toEqual(before)
    const samples = (preview.samples as { documents: Sample[] }).documents
    expect(samples).toHaveLength(3)
    expect(samples.every((s) => s.after && !s.fails)).toBe(true)
    // The real update gives the same documents, value for value and type for type.
    const run = await h.call('POST', `${base}/bulk/execute`, { ...request, filterHash: preview.filterHash })
    expect(run.json()).toEqual({ matched: 3, modified: 3 })
    for (const s of samples) {
      const id = deserializeValue((s.before as { _id: unknown })._id)
      const stored = await coll.findOne({ _id: id as never }, { promoteValues: false })
      const after = deserializeValue(s.after) as Document
      expect(sortKeys(after), `document ${String(id)}`).toEqual(sortKeys(stored!))
    }
  })

  it('previews $pop, $pull and $currentDate, and a pipeline update', async () => {
    const { h, coll, base } = await setup(DOCS())
    const ops = {
      filter: { _id: { $in: [1, 3] } },
      operation: 'update',
      update: { $pop: { list: 1 }, $pull: { set: 'p' }, $currentDate: { touched: true } },
    }
    const s = ((await h.call('POST', `${base}/bulk/preview`, ops)).json().samples as { documents: Sample[] })
      .documents
    const first = deserializeValue(s[0]!.after) as Document
    expect((first.list as unknown[]).map(Number)).toEqual([1, 2])
    expect(first.set).toEqual([])
    expect(first.touched).toBeInstanceOf(Date)
    const pipeline = {
      filter: { _id: 2 },
      operation: 'update',
      update: [{ $set: { total: { $add: ['$lo', '$hi'] } } }, { $unset: 'tag' }],
    }
    const p = (
      (await h.call('POST', `${base}/bulk/preview`, pipeline)).json().samples as { documents: Sample[] }
    ).documents
    expect(p).toHaveLength(1)
    const after = deserializeValue(p[0]!.after) as Document
    expect(Number(after.total)).toBe(10)
    expect(after).not.toHaveProperty('tag')
    expect(await coll.countDocuments({ total: { $exists: true } })).toBe(0)
  })

  it('leaves a missing field missing where the update does nothing ($pop, $pull, $rename)', async () => {
    const { h, coll, base } = await setup([
      { _id: 1, meta: { tags: ['x', 'y'] }, list: [1] },
      { _id: 2 },
      { _id: 3, a: { b: 1 } },
    ])
    const request = {
      filter: {},
      operation: 'update',
      update: { $pop: { list: -1 }, $pull: { 'meta.tags': 'x' }, $rename: { 'a.b': 'c.d' } },
    }
    const preview = (await h.call('POST', `${base}/bulk/preview`, request)).json()
    const samples = (preview.samples as { documents: Sample[] }).documents
    expect(samples).toHaveLength(3)
    await h.call('POST', `${base}/bulk/execute`, {
      ...request,
      filterHash: preview.filterHash,
      confirm: 'items',
    })
    for (const s of samples) {
      const id = deserializeValue((s.before as { _id: unknown })._id)
      const stored = await coll.findOne({ _id: id as never }, { promoteValues: false })
      expect(sortKeys(deserializeValue(s.after)), `document ${String(id)}`).toEqual(sortKeys(stored!))
    }
  })

  it('marks a sampled document the update would fail on, and shows at most three', async () => {
    const { h, base } = await setup([
      { _id: 1, n: 'text' },
      { _id: 2, n: 1 },
      { _id: 3, n: 2 },
      { _id: 4, n: 3 },
      { _id: 5, a: [{ b: 1 }] },
    ])
    const res = await h.call('POST', `${base}/bulk/preview`, {
      filter: {},
      operation: 'update',
      update: { $inc: { n: 1 } },
    })
    const s = (res.json().samples as { documents: Sample[] }).documents
    expect(s).toHaveLength(3)
    expect(s[0]).toMatchObject({ fails: true })
    expect(s[0]).not.toHaveProperty('after')
    // A path through an array is not previewed per document either: MongoDB would refuse it.
    const through = await h.call('POST', `${base}/bulk/preview`, {
      filter: { _id: 5 },
      operation: 'update',
      update: { $set: { 'a.b': 2 } },
    })
    expect(through.json().samples, through.body).toMatchObject({ documents: [{ fails: true }] })
  })

  it('says why an update cannot be previewed on samples, and still counts', async () => {
    const { h, base } = await setup(DOCS())
    const cases: Array<[unknown, string]> = [
      [{ $set: { 'list.$[]': 0 } }, 'positional'],
      [{ $set: { 'list.0': 0 } }, 'path'],
      [{ $push: { list: { $each: [1], $slice: 2 } } }, 'modifier'],
      [{ $bit: { n: { and: 1 } } }, 'operator'],
      [{ $pull: { list: { $gt: 1 } } }, 'condition'],
      [{ $currentDate: { at: { $type: 'timestamp' } } }, 'timestamp'],
      [{ $set: { meta: 1, 'meta.views': 2 } }, 'conflict'],
      [[{ $out: 'x' }], 'stage'],
    ]
    for (const [update, reason] of cases) {
      const res = await h.call('POST', `${base}/bulk/preview`, { filter: {}, operation: 'update', update })
      expect(res.statusCode, reason).toBe(200)
      expect(res.json().samples, reason).toEqual({ unavailable: reason })
      expect(res.json().matched, reason).toBe(4)
    }
  })

  it('shows the documents a delete would remove', async () => {
    const { h, base } = await setup(DOCS())
    const res = await h.call('POST', `${base}/bulk/preview`, { filter: { _id: 4 }, operation: 'delete' })
    const s = (res.json().samples as { documents: Sample[] }).documents
    expect(s).toEqual([{ before: { _id: { $numberInt: '4' }, n: { $numberInt: '4' }, tag: 'd' } }])
  })

  it('reads the samples in two bounded, tagged aggregations that never write', async () => {
    const { h, base } = await setup(DOCS())
    const spy = vi.spyOn(Collection.prototype, 'aggregate')
    await h.call('POST', `${base}/bulk/preview`, {
      filter: {},
      operation: 'update',
      update: { $set: { a: 1 } },
    })
    const calls = spy.mock.calls.slice(-2)
    const ops = calls.map(([pipeline]) => (pipeline as Document[]).map((s) => Object.keys(s)[0]))
    // The documents as they are, then in the same order what the update makes of them.
    expect(ops[0]).toEqual(['$match', '$sort', '$limit'])
    expect(ops[1]!.slice(0, 4)).toEqual(['$match', '$set', '$sort', '$unset'])
    for (const [i, [, options]] of calls.entries()) {
      expect(ops[i]).not.toContain('$out')
      expect(ops[i]).not.toContain('$merge')
      expect(options).toMatchObject({ maxTimeMS: expect.any(Number), allowDiskUse: false })
      expect(String((options as { comment?: unknown }).comment)).toMatch(/^mm:/)
    }
  })
})

/** W2 review (I3, minors 1–3): what MongoDB refuses, leaves alone or orders, the preview says so too. */
describe('bulk preview samples agree with MongoDB', () => {
  const previewThenRun = async (docs: Document[], update: unknown, filter: Document = {}) => {
    const { h, coll, base } = await setup(docs)
    const request = { filter, operation: 'update', update }
    const preview = (await h.call('POST', `${base}/bulk/preview`, request)).json()
    const run = await h.call('POST', `${base}/bulk/execute`, {
      ...request,
      filterHash: preview.filterHash,
      confirm: 'items',
    })
    return { samples: preview.samples as Samples, run, coll }
  }

  it('says an update of _id cannot be previewed, as MongoDB refuses it', async () => {
    for (const update of [
      { $set: { _id: 5 } },
      { $set: { '_id.x': 1 } },
      { $rename: { _id: 'old' } },
      { $rename: { n: '_id' } },
      { $unset: { _id: '' } },
    ]) {
      const { samples, run } = await previewThenRun([{ _id: 1, n: 1 }], update)
      expect(samples, JSON.stringify(update)).toEqual({ unavailable: 'id' })
      expect(run.statusCode, JSON.stringify(update)).toBeGreaterThanOrEqual(400)
    }
  })

  it('says a $setOnInsert on a path another operator changes is a conflict, as MongoDB does', async () => {
    const { samples, run } = await previewThenRun([{ _id: 1 }], { $set: { a: 1 }, $setOnInsert: { a: 2 } })
    expect(samples).toEqual({ unavailable: 'conflict' })
    expect(run.statusCode).toBeGreaterThanOrEqual(400)
  })

  it('keeps _id where a pipeline removes it, and marks a pipeline that changes it', async () => {
    for (const update of [
      [{ $unset: '_id' }],
      [{ $project: { n: 1, _id: 0 } }],
      [{ $replaceWith: { n: 2 } }],
    ]) {
      const { samples, run, coll } = await previewThenRun([{ _id: 1, n: 1, x: 'y' }], update)
      expect(run.statusCode, JSON.stringify(update)).toBe(200)
      const [s] = (samples as { documents: Sample[] }).documents
      const stored = await coll.findOne({ _id: 1 } as Document, { promoteValues: false })
      expect(deserializeValue(s!.after), JSON.stringify(update)).toEqual(stored)
    }
    const { samples, run } = await previewThenRun([{ _id: 1, n: 1 }], [{ $set: { _id: 2 } }])
    expect((samples as { documents: Sample[] }).documents[0]).toMatchObject({ fails: true })
    expect(run.statusCode).toBeGreaterThanOrEqual(400)
  })

  it('leaves alone a path $unset finds under an array or a scalar, as MongoDB does', async () => {
    const docs = [
      { _id: 1, a: [{ b: 1 }, { b: 2 }] },
      { _id: 2, a: 'text' },
      { _id: 3, a: { b: 1, c: 2 } },
    ]
    const { samples, coll } = await previewThenRun(docs, { $unset: { 'a.b': '' } })
    const shown = (samples as { documents: Sample[] }).documents
    expect(shown.every((s) => !s.fails)).toBe(true)
    for (const s of shown) {
      const id = deserializeValue((s.before as { _id: unknown })._id)
      const stored = await coll.findOne({ _id: id } as Document, { promoteValues: false })
      expect(deserializeValue(s.after)).toEqual(stored)
    }
  })

  it('adds new fields in the order MongoDB adds them', async () => {
    const { samples, coll } = await previewThenRun([{ _id: 1, z: 1 }], { $set: { b: 1, a: 1, c: { y: 1 } } })
    const [s] = (samples as { documents: Sample[] }).documents
    const stored = (await coll.findOne({ _id: 1 } as Document))!
    expect(Object.keys(deserializeValue(s!.after) as Document)).toEqual(Object.keys(stored))
  })

  it('previews large documents: before and after are never one answer', async () => {
    const big = 'x'.repeat(5_500_000)
    const docs = [1, 2, 3].map((i) => ({ _id: i, big, n: i }))
    const { h, base } = await setup(docs)
    const res = await h.call('POST', `${base}/bulk/preview`, {
      filter: {},
      operation: 'update',
      update: [{ $set: { m: 1 } }],
    })
    // Three 5.5 MB documents read and changed without an error; none fits a glance.
    expect(res.statusCode).toBe(200)
    expect(res.json().samples).toEqual({ unavailable: 'large' })
  }, 60_000)

  // Re-review (minor 5): a glance of a megabyte or two, and the page told when some were left out.
  it('shows what fits in 2 MB, and says that the rest were left out', async () => {
    const docs = [1, 2, 3].map((i) => ({ _id: i, big: 'y'.repeat(600_000), n: i }))
    const { h, base } = await setup(docs)
    const samples = (
      await h.call('POST', `${base}/bulk/preview`, {
        filter: {},
        operation: 'update',
        update: { $set: { m: 1 } },
      })
    ).json().samples as { documents: Sample[]; cut?: true }
    expect(samples.documents).toHaveLength(1)
    expect(samples.cut).toBe(true)
    const small = await setup([{ _id: 1, n: 1 }])
    const whole = (
      await small.h.call('POST', `${small.base}/bulk/preview`, {
        filter: {},
        operation: 'update',
        update: { $set: { m: 1 } },
      })
    ).json().samples
    expect(whole).not.toHaveProperty('cut')
  }, 60_000)

  // Re-review (minor 4): without an upsert, $setOnInsert does nothing, _id included.
  it('previews a $setOnInsert of _id as the nothing MongoDB does with it', async () => {
    const { samples, run } = await previewThenRun([{ _id: 1, n: 1 }], {
      $set: { n: 2 },
      $setOnInsert: { _id: 9 },
    })
    expect(run.statusCode).toBe(200)
    const [s] = (samples as { documents: Sample[] }).documents
    expect(Number((deserializeValue(s!.after) as { _id: unknown })._id)).toBe(1)
  })
})

/**
 * W2 review (C1): a bulk preview masked its samples with the rules of the namespace asked for only.
 * Through a view over a ruled collection, that is none: the samples showed the real values. A view
 * cannot be written in bulk at all, so its preview is refused; and the samples of a collection are
 * masked with the gate's own (view-aware) output, as every read is.
 */
describe('bulk preview on a view (review C1)', () => {
  it('refuses the preview on a view, so no sample of a ruled source is ever shown through it', async () => {
    const db = `v${randomUUID().slice(0, 8)}`
    await client
      .db(db)
      .collection('users')
      .insertMany([{ _id: 1, email: 'S3CR3T@x', name: 'Ali' }] as Document[])
    await client.db(db).createCollection('users_v', { viewOn: 'users', pipeline: [] })
    const r = await restrictedApp(mongo, [{ db, coll: 'users', field: 'email' }])
    apps.push(r.t)
    for (const user of [r.as('editor', true), r.as('editor')]) {
      for (const body of [
        { filter: {}, operation: 'delete' },
        { filter: {}, operation: 'update', update: { $set: { seen: true } } },
      ]) {
        const res = await user('POST', `/databases/${db}/collections/users_v/bulk/preview`, body)
        expect(res.statusCode, JSON.stringify(body)).toBe(400)
        expect(res.body).not.toContain('S3CR3T')
      }
    }
  })

  it('masks the samples with the gate’s output, which follows views and every rule that applies', async () => {
    const { guardBulkUpdate } = await import('../src/masking/gate/write')
    const { compileRules } = await import('../src/masking/match')
    const masker = compileRules([{ db: 'crm', coll: 'users', field: 'email' }])
    const deps = {
      masker,
      view: async (_db: string, coll: string) =>
        coll === 'users_v' ? { viewOn: 'users', pipeline: [] } : null,
      indexes: async () => [],
    }
    const guarded = await guardBulkUpdate('crm', 'users_v', { name: 'Ali' }, { $set: { seen: true } }, deps)
    expect(guarded.output.matches(['email'])).toBe(true)
    // The namespace's own rules alone know nothing of the view.
    expect(masker.forNs('crm', 'users_v').matches(['email'])).toBe(false)
  })
})

describe('bulk update preview samples and personal data', () => {
  it('masks personal values before and after for a restricted user', async () => {
    const db = `m${randomUUID().slice(0, 8)}`
    await client
      .db(db)
      .collection('users')
      .insertMany([
        { _id: 1, email: 'S3CR3T@x', name: 'Ali' },
        { _id: 2, email: 'other@x', name: 'Bea' },
      ] as Document[])
    const r = await restrictedApp(mongo, [{ db, coll: 'users', field: 'email' }])
    apps.push(r.t)
    const res = await r.as('editor', true)('POST', `/databases/${db}/collections/users/bulk/preview`, {
      filter: { name: 'Ali' },
      operation: 'update',
      update: { $set: { status: 'seen' } },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('S3CR3T')
    const [s] = (res.json().samples as { documents: Sample[] }).documents
    expect(s!.before.email).toBe('***')
    expect(s!.after!.email).toBe('***')
    expect(s!.after!.status).toBe('seen')
    // Someone who may see personal data sees it.
    const full = await r.as('editor')('POST', `/databases/${db}/collections/users/bulk/preview`, {
      filter: { name: 'Ali' },
      operation: 'update',
      update: { $set: { status: 'seen' } },
    })
    expect(full.body).toContain('S3CR3T')
    // MongoDB's error can quote a value: a restricted user gets the reason without the words.
    const failing = {
      filter: { name: 'Ali' },
      operation: 'update',
      update: [{ $set: { n: { $toInt: '$name' } } }],
    }
    const hidden = await r.as('editor', true)(
      'POST',
      `/databases/${db}/collections/users/bulk/preview`,
      failing,
    )
    expect(hidden.json().samples).toEqual({ unavailable: 'error' })
    const shown = await r.as('editor')('POST', `/databases/${db}/collections/users/bulk/preview`, failing)
    expect(shown.json().samples).toMatchObject({
      unavailable: 'error',
      message: expect.stringContaining('Ali'),
    })
  })
})

/** Field order aside (a rename or a new field may land elsewhere), the same document. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    )
  return value
}
