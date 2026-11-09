// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Collection, Db, Double, FindCursor, MongoClient, MongoServerError, type Document } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { restrictedApp } from './support/restricted'
import { toView } from '../src/jobs/visibility'
import { refuseAnyRepeat, refuseRepeats } from '../src/masking/repeats'
import { gateDepsFor } from '../src/masking/restricted'
import { IndexListingFailed } from '../src/masking/gate'
import { compileRules } from '../src/masking/match'
import type { TestApp } from './helpers'
import { slow } from './support/slowness'

/** Side channels a restricted user could read sizes, counts or orders through (ninth review). */
const RULES = [{ db: 'crm', coll: 'users', field: 'customer.phone' }]
const USERS = '/databases/crm/collections/users'
let mongo: TestMongo
let client: MongoClient
beforeAll(async () => {
  mongo = await startMongo()
  client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
  const crm = client.db('crm')
  await crm.collection('users').insertMany([
    { _id: 1 as never, name: 'Ali', customer: { phone: '555-0101' } },
    { _id: 2 as never, name: 'Ali', customer: { phone: '555-0100' } },
  ])
  await crm.collection('users').createIndex({ name: 1, 'customer.phone': 1 })
  await crm.collection('notes').insertOne({ text: 'n' })
  // A view that drops _id and a time series, read as MongoDB reads them (second review, M7).
  const other = client.db('crm2')
  await other.collection('people').insertMany([
    { name: 'Ali', email: 'b@x' },
    { name: 'Ali', email: 'a@x' },
  ])
  await other.collection('people').createIndex({ name: 1, email: 1 })
  await other.createCollection('slim', { viewOn: 'people', pipeline: [{ $project: { _id: 0, name: 1 } }] })
  await other.createCollection('series', { timeseries: { timeField: 'at', metaField: 'meta' } })
  await other.collection('series').insertOne({ at: new Date(1), meta: { email: 'a@x' }, x: 1 })
  // Only an index on a shown field: the series is ordered for how it is stored, not for its indexes.
  for (const index of await other.collection('series').listIndexes().toArray())
    await other.collection('series').dropIndex(String(index.name))
  await other.collection('series').createIndex({ x: 1 })
  await other.createCollection('keyed', { clusteredIndex: { key: { _id: 1 }, unique: true } })
  await other.collection('keyed').insertMany([{ _id: 'b@x' as never }, { _id: 'a@x' as never }])
  await other.collection('keyed').createIndex({ loc: '2dsphere' })
  await other.createCollection('nested', { clusteredIndex: { key: { _id: 1 }, unique: true } })
  await other.collection('nested').insertMany([{ _id: { k: 1 } as never, name: 'a' }])
  // A collection with composite _ids, and a bucket with one (fifteenth review, Minor 5, I-3).
  await other.collection('composite').insertMany([
    { _id: { k: 1 } as never, name: 'a', profile: { a: 1 } },
    { _id: 2 as never, name: 'a', profile: 'none' },
  ])
  // A time series some of whose _ids repeat (sixteenth review, I1).
  await other.createCollection('series2', { timeseries: { timeField: 'at', metaField: 'meta' } })
  await other.collection('series2').insertMany([
    { _id: 1 as never, at: new Date(1), meta: { email: 'b@x' }, x: 1 },
    { _id: 1 as never, at: new Date(2), meta: { email: 'a@x' }, x: 2 },
  ])
  // A series whose _ids are documents, two alike (eighteenth review, I-3).
  await other.createCollection('series3', { timeseries: { timeField: 'at', metaField: 'meta' } })
  await other.collection('series3').insertMany([
    { _id: { k: 1, email: 'a@x' } as never, at: new Date(1), meta: { email: 'b@x' } },
    { _id: { k: 1, email: 'a@x' } as never, at: new Date(2), meta: { email: 'a@x' } },
  ])
  // An array _id, which a series takes (tenth review).
  await other.createCollection('arrays', { timeseries: { timeField: 'at', metaField: 'meta' } })
  await other.collection('arrays').insertMany([
    { _id: [3, 9] as never, at: new Date(0), meta: { email: 'a@x' } },
    { _id: 3 as never, at: new Date(1), meta: { email: 'b@x' } },
  ])
  // _ids alike only by a collation's (eighteenth review, I-2).
  await other.createCollection('cased', { timeseries: { timeField: 'at', metaField: 'meta' } })
  await other.collection('cased').insertMany([
    { _id: 'a' as never, at: new Date(1), meta: { email: 'b@x' } },
    { _id: 'A' as never, at: new Date(2), meta: { email: 'a@x' } },
  ])
  await other.collection('composite').createIndex({ name: 1 })
  // _ids a query's collation makes equal, in a hidden index's order (thirteenth review, I-2).
  await other.collection('named').insertMany([
    { _id: 'Bob' as never, t: 7, email: 'z@x' },
    { _id: 'bob' as never, t: 7, email: 'a@x' },
  ])
  await other.collection('named').createIndex({ t: 1, email: 1 })
  // A collection whose own collation its joins read under (sixteenth review, I-2).
  await other.createCollection('folded', { collation: { locale: 'en', strength: 2 } })
  await other.collection('folded').insertOne({ _id: 1 as never })
  // A view whose own collation makes them equal (fourteenth review, I-1).
  await other.createCollection('namedView', {
    viewOn: 'named',
    pipeline: [],
    collation: { locale: 'en', strength: 2 },
  })
  await other.collection('pics.files').insertMany([
    { _id: { k: 1 } as never, filename: 'same', length: 1, chunkSize: 1, uploadDate: new Date(1) },
    { _id: 'x' as never, filename: 'same', length: 1, chunkSize: 1, uploadDate: new Date(2) },
  ])
  await other.collection('pics.files').createIndex({ filename: 1, uploadDate: 1 })
  // Equal names in the order of a value hidden inside their _id.
  await other.collection('pics.files').createIndex({ filename: 1, '_id.x': 1 })
  // Some of whose customers are documents that may hold the hidden phone (fifteenth review, nit).
  await other.collection('mixed').insertMany([
    { _id: 1 as never, name: 'A', customer: { phone: '1' } },
    { _id: 2 as never, name: 'A', customer: 'none' },
  ])
  await crm.collection('fs.files').insertMany([
    { _id: 'b' as never, filename: 'same', length: 1, chunkSize: 1, uploadDate: new Date(1) },
    { _id: 'a' as never, filename: 'same', length: 1, chunkSize: 1, uploadDate: new Date(2) },
  ])
  // GridFS's own index: equal names come in their upload dates' order.
  await crm.collection('fs.files').createIndex({ filename: 1, uploadDate: 1 })
}, slow(120_000))
afterAll(async () => {
  await client?.close()
  await mongo?.stop()
})
const apps: TestApp[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const t of apps.splice(0)) await t.close()
})
async function setup(rules = RULES) {
  const r = await restrictedApp(mongo, rules)
  apps.push(r.t)
  return r
}

// Final review of the agent's gate (M-C): a duplicate key under a unique index whose partial filter
// reads a hidden value answers whether a stored document's value passes that filter.
describe('a unique index over what is hidden', () => {
  it('takes no restricted insert where its filter reads personal data', async () => {
    const scoped = client.db('crm').collection('scoped')
    await scoped.insertOne({ code: 'C', customer: { phone: '555-0199' } })
    await scoped.createIndex(
      { code: 1 },
      { unique: true, partialFilterExpression: { 'customer.phone': { $gt: '5' } } },
    )
    try {
      const { as } = await setup([...RULES, { db: 'crm', coll: 'scoped', field: 'customer.phone' }])
      const res = await as('editor', true)('POST', '/databases/crm/collections/scoped/documents', {
        documents: [{ code: 'C' }],
      })
      expect(res.statusCode, res.body).toBe(403)
      expect(await scoped.countDocuments()).toBe(1)
    } finally {
      await scoped.drop()
    }
  })

  it('takes an insert that would fall under it, a replace that leaves its filter as it was, nothing else', async () => {
    const coll = client.db('crm').collection('flagged')
    await coll.insertOne({ _id: 1 as never, code: 'C', flag: false, customer: { phone: '555-0199' } })
    await coll.createIndex(
      { code: 1 },
      {
        unique: true,
        partialFilterExpression: { $or: [{ 'customer.phone': { $gt: '5' } }, { flag: true }] },
      },
    )
    const plain = client.db('crm').collection('plainUnique')
    await plain.createIndex({ code: 1 }, { unique: true })
    try {
      const { as } = await setup([
        ...RULES,
        { db: 'crm', coll: 'flagged', field: 'customer.phone' },
        { db: 'crm', coll: 'plainUnique', field: 'customer.phone' },
      ])
      const editor = as('editor', true)
      const base = '/databases/crm/collections/flagged'
      // A record that falls under the index by its own flag: its duplicate key would answer.
      const fall = await editor('POST', `${base}/documents`, { documents: [{ code: 'C', flag: true }] })
      expect(fall.statusCode, fall.body).toBe(403)
      const got = await editor('POST', `${base}/documents/get`, { _id: 1 })
      expect(got.statusCode, got.body).toBe(200)
      const { hash, document } = got.json() as { hash: string; document: Record<string, unknown> }
      // A change to what the filter reads moves the document under it: refused.
      const moved = await editor('POST', `${base}/documents/update`, {
        _id: 1,
        hash,
        set: { flag: true },
        unset: [],
      })
      expect(moved.statusCode, moved.body).toBe(403)
      // A replace that leaves it as it was (its hidden phone restored) passes.
      const kept = await editor('POST', `${base}/documents/replace`, {
        _id: 1,
        hash,
        document: { ...document, note: 'n' },
      })
      expect(kept.statusCode, kept.body).toBe(200)
      expect(await coll.findOne({ _id: 1 as never })).toMatchObject({
        flag: false,
        note: 'n',
        customer: { phone: '555-0199' },
      })
      // A unique index over nothing hidden takes the insert.
      const fine = await editor('POST', '/databases/crm/collections/plainUnique/documents', {
        documents: [{ code: 'D' }],
      })
      expect(fine.statusCode, fine.body).toBe(200)
    } finally {
      await coll.drop()
      await plain.drop()
    }
  })

  // Next round of the agent's gate (M-B, M-F): a listing that ran out of time answers the insert as a
  // time limit (504), not as a right the user lacks.
  it('answers an insert whose index listing ran out of time as the time limit', async () => {
    const scoped = client.db('crm').collection('timed')
    await scoped.insertOne({ code: 'A' })
    try {
      const { as } = await setup([...RULES, { db: 'crm', coll: 'timed', field: 'customer.phone' }])
      const listIndexes = Collection.prototype.listIndexes
      vi.spyOn(Collection.prototype, 'listIndexes').mockImplementation(function (
        this: Collection,
        ...args: unknown[]
      ) {
        if (this.collectionName === 'timed')
          return {
            toArray: () =>
              Promise.reject(new MongoServerError({ message: 'operation exceeded time limit', code: 50 })),
          } as never
        return listIndexes.apply(this, args as never)
      } as typeof listIndexes)
      const res = await as('editor', true)('POST', '/databases/crm/collections/timed/documents', {
        documents: [{ code: 'B' }],
      })
      expect(res.statusCode, res.body).toBe(504)
      expect(await scoped.countDocuments()).toBe(1)
    } finally {
      vi.restoreAllMocks()
      await scoped.drop()
    }
  })

  // Next round of the agent's gate (M-2): a failed catalog listing is the writer's to stop on, and is
  // read again next time.
  it('stops on a failed catalog listing, and reads it again next time', async () => {
    const deps = gateDepsFor(compileRules(RULES), client)
    const listCollections = Db.prototype.listCollections
    let failures = 1
    vi.spyOn(Db.prototype, 'listCollections').mockImplementation(function (this: Db, ...args: unknown[]) {
      if (this.databaseName === 'crm' && failures-- > 0)
        return {
          toArray: () => Promise.reject(new MongoServerError({ message: 'host unreachable', code: 6 })),
        } as never
      return listCollections.apply(this, args as never)
    } as typeof listCollections)
    await expect(deps.view('crm', 'users')).rejects.toBeInstanceOf(IndexListingFailed)
    expect(await deps.view('crm', 'users')).toBeNull()
  })

  // Next round of the agent's gate (M-E): a job's listing keeps to its time left and its comment (a
  // cancel kills it).
  it('lists a job’s indexes within its time left, under its comment', async () => {
    const deps = gateDepsFor(compileRules(RULES), client, { comment: 'mm-job-x', timeLeft: () => 1234 })
    const listed = vi.spyOn(Collection.prototype, 'listIndexes')
    await deps.indexes('crm', 'users')
    expect(listed.mock.calls[0]?.[0]).toEqual({ maxTimeMS: 1234, comment: 'mm-job-x' })
    const long = gateDepsFor(compileRules(RULES), client, { timeLeft: () => 10_000_000 })
    await long.indexes('crm', 'users')
    expect(listed.mock.calls[1]?.[0]).toEqual({ maxTimeMS: 30_000 })
  })

  // Review of the agent's gate (M-4): one failed listing answers none for now, not for the gate's life.
  it('reads a collection’s indexes again after a failed listing', async () => {
    const deps = gateDepsFor(compileRules(RULES), client)
    const listIndexes = Collection.prototype.listIndexes
    let failures = 1
    vi.spyOn(Collection.prototype, 'listIndexes').mockImplementation(function (
      this: Collection,
      ...args: unknown[]
    ) {
      if (this.collectionName === 'users' && failures-- > 0)
        return { toArray: () => Promise.reject(new Error('listing failed')) } as never
      return listIndexes.apply(this, args as never)
    } as typeof listIndexes)
    expect(await deps.indexes('crm', 'users')).toEqual([])
    expect(deps.indexesUnread?.('crm', 'users')).toBe(true)
    expect((await deps.indexes('crm', 'users')).length).toBeGreaterThan(0)
    expect(deps.indexesUnread?.('crm', 'users')).toBe(false)
    // A namespace that does not exist has none, kept: not listed again for each record (M-2).
    vi.restoreAllMocks()
    const listed = vi.spyOn(Collection.prototype, 'listIndexes')
    expect(await deps.indexes('crm', 'nowhere')).toEqual([])
    expect(await deps.indexes('crm', 'nowhere')).toEqual([])
    expect(listed.mock.calls.length).toBe(1)
    expect(deps.indexesUnread?.('crm', 'nowhere')).toBe(false)
    // Nor is a view's (it lists none of its own; next review, M-1): a write there is not said to lack
    // a right.
    await client.db('crm').createCollection('usersView', { viewOn: 'users', pipeline: [] })
    try {
      expect(await deps.indexes('crm', 'usersView')).toEqual([])
      expect(deps.indexesUnread?.('crm', 'usersView')).toBe(false)
    } finally {
      await client.db('crm').collection('usersView').drop()
    }
  })
})

describe('order', () => {
  it('reads a restricted user’s page in _id order after their own, never an index’s', async () => {
    const { as } = await setup()
    const sorts: unknown[] = []
    const find = Collection.prototype.find
    vi.spyOn(Collection.prototype, 'find').mockImplementation(function (
      this: Collection,
      ...args: unknown[]
    ) {
      if (this.collectionName === 'users') sorts.push((args[1] as { sort?: unknown } | undefined)?.sort)
      return find.apply(this, args as never) as FindCursor
    } as typeof find)
    const page = await as('viewer', true)('POST', `${USERS}/find`, { filter: { name: 'Ali' }, limit: 5 })
    expect(page.statusCode, page.body).toBe(200)
    expect(sorts).toEqual([{ _id: 1 }])
    // The documents come in that order: 1 before 2, whatever the phones' order in the index.
    expect(
      (page.json() as { documents: Array<{ document: { _id: unknown } }> }).documents.map(
        (d) => d.document._id,
      ),
    ).toEqual([{ $numberInt: '1' }, { $numberInt: '2' }])
    sorts.length = 0
    await as('admin')('POST', `${USERS}/find`, { filter: { name: 'Ali' }, limit: 5 })
    expect(sorts).toEqual([undefined])
  })
})

/** The options each find on `coll` was sent with, while `run` runs. */
async function findOptions(coll: string, run: () => Promise<unknown>): Promise<Document[]> {
  const seen: Document[] = []
  const find = Collection.prototype.find
  const spy = vi.spyOn(Collection.prototype, 'find').mockImplementation(function (
    this: Collection,
    ...args: unknown[]
  ) {
    if (this.collectionName === coll) seen.push((args[1] as Document | undefined) ?? {})
    return find.apply(this, args as never) as FindCursor
  } as typeof find)
  try {
    await run()
  } finally {
    spy.mockRestore()
  }
  return seen
}

describe('order, twelfth review', () => {
  it('reads a page in natural order where _id is hidden, never sorting by it (C1)', async () => {
    const { as } = await setup([...RULES, { db: 'crm', coll: 'users', field: '_id' }])
    const viewer = as('viewer', true)
    const [options] = await findOptions('users', async () => {
      const page = await viewer('POST', `${USERS}/find`, { filter: { name: 'Ali' }, limit: 5 })
      expect(page.statusCode, page.body).toBe(200)
    })
    expect(options).toMatchObject({ hint: { $natural: 1 } })
    expect(options!.sort).toBeUndefined()
  })

  it('explains the find the documents route runs, in its order (Minor 2)', async () => {
    const { as } = await setup()
    const viewer = as('viewer', true)
    const [options] = await findOptions('users', () =>
      viewer('POST', `${USERS}/explain`, {
        kind: 'find',
        filter: { name: 'Ali' },
        verbosity: 'queryPlanner',
      }),
    )
    expect(options!.sort).toEqual({ _id: 1 })
  })

  it('shows failing documents of a validator test in the gate’s order (Minor 4)', async () => {
    const { as } = await setup()
    const viewer = as('viewer', true)
    const [options] = await findOptions('users', async () => {
      const r = await viewer('POST', `${USERS}/validation/test`, { validator: { name: 'Bob' } })
      expect(r.statusCode, r.body).toBe(200)
      expect((r.json() as { failing: number }).failing).toBe(2)
    })
    expect(options!.sort).toEqual({ _id: 1 })
  })

  it('lists a bucket’s files in natural order where their _id is hidden and an index holds a hidden key (Minor 6)', async () => {
    const { as } = await setup([
      ...RULES,
      { db: 'crm', coll: 'fs.files', field: '_id' },
      { db: 'crm', coll: 'fs.files', field: 'uploadDate' },
    ])
    const viewer = as('viewer', true)
    const [options] = await findOptions('fs.files', async () => {
      const r = await viewer('GET', '/databases/crm/gridfs/fs/files?sort=filename')
      expect(r.statusCode, r.body).toBe(200)
    })
    expect(options).toMatchObject({ hint: { $natural: 1 } })
  })
})

describe('order, second review', () => {
  const OTHER = [
    { db: 'crm2', coll: 'people', field: 'email' },
    { db: 'crm2', coll: 'series', field: 'meta.email' },
  ]

  it('reads a view that drops _id and a time series against MongoDB (M7)', async () => {
    const { as } = await setup([...RULES, ...OTHER])
    const viewer = as('viewer', true)
    const [options] = await findOptions('slim', async () => {
      const r = await viewer('POST', '/databases/crm2/collections/slim/find', { filter: { name: 'Ali' } })
      expect(r.statusCode, r.body).toBe(200)
      expect((r.json() as { documents: unknown[] }).documents).toHaveLength(2)
    })
    expect(options).toMatchObject({ hint: { $natural: 1 } })
    const [seriesOptions] = await findOptions('series', async () => {
      const series = await viewer('POST', '/databases/crm2/collections/series/find', { filter: {} })
      expect(series.statusCode, series.body).toBe(200)
      expect((series.json() as { documents: unknown[] }).documents).toHaveLength(1)
    })
    // Stored by its hidden meta field, the series is read by _id (thirteenth review, I3).
    expect(seriesOptions!.sort).toEqual({ _id: 1 })
  })

  it('refuses a find of a collection clustered by a hidden _id, MongoDB’s own (thirteenth review, I2)', async () => {
    const { as } = await setup([...RULES, { db: 'crm2', coll: 'keyed', field: '_id' }])
    const viewer = as('viewer', true)
    const r = await viewer('POST', '/databases/crm2/collections/keyed/find', { filter: {} })
    expect(r.statusCode, r.body).toBe(403)
    expect(r.body).toContain('masking_unsupported')
    const run = await as('editor', true)('POST', '/databases/crm2/collections/keyed/aggregate/run', {
      stages: [{ $match: {} }],
    })
    expect(run.statusCode, run.body).toBe(200)
  })

  it('knows a collection clustered by a hidden _id from its listing where its indexes cannot be read (M3)', async () => {
    const { as } = await setup([...RULES, { db: 'crm2', coll: 'keyed', field: '_id' }])
    const listIndexes = Collection.prototype.listIndexes
    vi.spyOn(Collection.prototype, 'listIndexes').mockImplementation(function (
      this: Collection,
      ...args: unknown[]
    ) {
      if (this.collectionName === 'keyed')
        return { toArray: () => Promise.reject(new Error('not authorized')) } as never
      return listIndexes.apply(this, args as never)
    } as typeof listIndexes)
    const r = await as('viewer', true)('POST', '/databases/crm2/collections/keyed/find', { filter: {} })
    expect(r.statusCode, r.body).toBe(403)
  })

  it('puts a $geoNear’s ties at random where a clustered _id is hidden, against MongoDB (I-C)', async () => {
    const { as } = await setup([...RULES, { db: 'crm2', coll: 'keyed', field: '_id' }])
    const pipelines: Document[][] = []
    const aggregate = Collection.prototype.aggregate
    vi.spyOn(Collection.prototype, 'aggregate').mockImplementation(function (
      this: Collection,
      ...args: unknown[]
    ) {
      if (this.collectionName === 'keyed') pipelines.push(args[0] as Document[])
      return aggregate.apply(this, args as never)
    } as typeof aggregate)
    const r = await as('editor', true)('POST', '/databases/crm2/collections/keyed/aggregate/run', {
      stages: [
        { $geoNear: { near: { type: 'Point', coordinates: [0, 0] }, distanceField: 'd', key: 'loc' } },
      ],
    })
    expect(r.statusCode, r.body).toBe(200)
    expect(JSON.stringify(pipelines.at(-1))).toContain('$rand')
  })

  it('reads a page of composite _ids again in natural order (fifteenth review, Minor 5)', async () => {
    const { as } = await setup([...RULES, { db: 'crm2', coll: 'composite', field: '**.phone' }])
    const seen = await findOptions('composite', async () => {
      const r = await as('viewer', true)('POST', '/databases/crm2/collections/composite/find', {
        filter: { name: 'a' },
      })
      expect(r.statusCode, r.body).toBe(200)
      expect((r.json() as { documents: unknown[] }).documents).toHaveLength(2)
    })
    expect(seen.map((o) => o.hint ?? o.sort)).toEqual([{ _id: 1 }, { $natural: 1 }])
    // The natural read carries no _id sort.
    expect(seen[1]!.sort).toBeUndefined()
    // Where the user's own sort names _id, the page is refused (sixteenth review, C1).
    const own = await as('viewer', true)('POST', '/databases/crm2/collections/composite/find', {
      filter: { name: 'a' },
      sort: { _id: 1 },
    })
    expect(own.statusCode, own.body).toBe(403)
    // A page refused for another key is not read again (sixteenth review, M1).
    const again = await findOptions('composite', async () => {
      const r = await as('viewer', true)('POST', '/databases/crm2/collections/composite/find', {
        filter: { name: 'a' },
        sort: { profile: 1 },
      })
      expect(r.statusCode, r.body).toBe(403)
    })
    expect(again).toHaveLength(1)
  })

  it('checks a bucket’s page as any page the gate orders, and keeps _id as a tie where it is shown (fifteenth review, I-3, Minor 2)', async () => {
    const { as } = await setup([...RULES, { db: 'crm2', coll: 'pics.files', field: '_id.x' }])
    // The page holds a document _id: refused in the gate's order, it is read again in natural order
    // (sixteenth review, M7).
    const listed = await findOptions('pics.files', async () => {
      const r = await as('viewer', true)('GET', '/databases/crm2/gridfs/pics/files?sort=filename')
      expect(r.statusCode, r.body).toBe(200)
      expect((r.json() as { files: unknown[] }).files).toHaveLength(2)
    })
    expect(listed.map((o) => o.hint)).toEqual([undefined, { $natural: 1 }])
    const sorts: unknown[] = []
    const sort = FindCursor.prototype.sort
    vi.spyOn(FindCursor.prototype, 'sort').mockImplementation(function (
      this: FindCursor,
      ...args: unknown[]
    ) {
      sorts.push(args[0])
      return sort.apply(this, args as never)
    } as typeof sort)
    const { as: plainAs } = await setup([
      ...RULES,
      { db: 'crm2', coll: 'pics.files', field: 'metadata.owner' },
    ])
    const ok = await plainAs('viewer', true)('GET', '/databases/crm2/gridfs/pics/files?sort=filename')
    expect(ok.statusCode, ok.body).toBe(200)
    expect(sorts.at(-1)).toEqual({ filename: -1, _id: 1 })
  })

  it('answers a validator test’s counts where the samples’ page is refused (fourteenth review, Minor 1)', async () => {
    const { as } = await setup([...RULES, { db: 'crm2', coll: 'nested', field: '**.phone' }])
    const r = await as('viewer', true)('POST', '/databases/crm2/collections/nested/validation/test', {
      validator: { name: 'x' },
    })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ failing: 1, sample: [] })
  })

  it('refuses a time series’ page of equal _ids, and still counts its validator test (sixteenth review, I1, M3)', async () => {
    const { as } = await setup([...RULES, { db: 'crm2', coll: 'series2', field: 'meta.email' }])
    const viewer = as('viewer', true)
    // Whichever page holds one of them, and whatever its edges (seventeenth review, I1-a).
    for (const [skip, limit] of [
      [0, 1],
      [0, 2],
      [1, 1],
    ] as const) {
      const r = await viewer('POST', '/databases/crm2/collections/series2/find', { filter: {}, skip, limit })
      expect(r.statusCode, `skip ${skip}, limit ${limit}: ${r.body}`).toBe(403)
      expect(r.json()).toMatchObject({ details: { reason: 'masking_unsupported', order: true } })
    }
    // Nor the storage-first of them by _id (seventeenth review, I1-e).
    const one = await viewer('POST', '/databases/crm2/collections/series2/documents/get', { _id: 1 })
    expect(one.statusCode, one.body).toBe(403)
    // A part of _id would not be the stored one (seventeenth review, I1-c).
    const part = await viewer('POST', '/databases/crm2/collections/series2/find', {
      filter: {},
      projection: { '_id.a': 1, x: 1 },
    })
    expect(part.statusCode, part.body).toBe(403)
    const hidden = await viewer('POST', '/databases/crm2/collections/series2/find', {
      filter: {},
      projection: { _id: 0, x: 1 },
    })
    expect(hidden.statusCode, hidden.body).toBe(403)
    const test = await viewer('POST', '/databases/crm2/collections/series2/validation/test', {
      validator: { x: 5 },
    })
    expect(test.statusCode, test.body).toBe(200)
    expect(test.json()).toMatchObject({ failing: 2, sample: [] })
  })

  it('asks MongoDB whether an _id read repeats, by its own equality and by _id alone (seventeenth and eighteenth reviews, I1)', async () => {
    const series = client.db('crm2').collection('series2')
    await expect(refuseRepeats(series, [1])).rejects.toMatchObject({ details: { order: true } })
    // MongoDB takes 1 and 1.0 for one _id.
    await expect(refuseRepeats(series, [new Double(1)])).rejects.toMatchObject({ details: { order: true } })
    await expect(refuseRepeats(series, [2, 3])).resolves.toBeUndefined()
    await expect(refuseAnyRepeat(series)).rejects.toMatchObject({ details: { order: true } })
    await expect(refuseAnyRepeat(client.db('crm2').collection('people'))).resolves.toBeUndefined()
    // By the read's collation too.
    const cased = client.db('crm2').collection('cased')
    await expect(refuseAnyRepeat(cased)).resolves.toBeUndefined()
    await expect(refuseAnyRepeat(cased, { collation: { locale: 'en', strength: 2 } })).rejects.toMatchObject({
      details: { order: true },
    })
  })

  it('refuses whatever a filter that answers otherwise each time picks (eighteenth review, I-1)', async () => {
    const { as } = await setup([...RULES, { db: 'crm2', coll: 'series2', field: 'meta.email' }])
    const viewer = as('viewer', true)
    let refused = 0
    for (let i = 0; i < 12; i++) {
      const r = await viewer('POST', '/databases/crm2/collections/series2/find', {
        filter: { $expr: { $lt: [{ $rand: {} }, 0.5] } },
      })
      if (r.statusCode === 200) {
        // Only when the filter kept neither twin.
        expect((r.json() as { documents: unknown[] }).documents, r.body).toEqual([])
        continue
      }
      expect(r.json(), r.body).toMatchObject({ details: { order: true } })
      refused++
    }
    // Each try keeps a twin three times in four: twelve without one would be (1/4)^12.
    expect(refused).toBeGreaterThan(0)
  })

  // Final reviews of explain masking (I-B, I-1): a delete by _id where it may repeat in an order
  // rules hide would take the storage-first of twins added at any moment; no filter can pin the one
  // read there (a series' delete evaluates $expr on its buckets): it is refused, nothing deleted.
  it('refuses a delete by _id where documents may share it, deleting nothing', async () => {
    const coll = client.db('crm2').collection('seriesdel')
    await client
      .db('crm2')
      .createCollection('seriesdel', { timeseries: { timeField: 'at', metaField: 'meta' } })
    await coll.insertOne({ _id: 7 as never, at: new Date(5_000_000), meta: { email: 'b@x' }, v: 'read' })
    const { as } = await setup([...RULES, { db: 'crm2', coll: 'seriesdel', field: 'meta.email' }])
    const r = await as('editor', true)('POST', '/databases/crm2/collections/seriesdel/documents/delete', {
      _id: 7,
    })
    expect(r.statusCode, r.body).toBe(403)
    expect(r.json()).toMatchObject({ details: { reason: 'masking_unsupported', order: true } })
    expect(await coll.countDocuments()).toBe(1)
    // Where no rule hides how it is stored, the delete goes through (final review, Minor 3a), from
    // MongoDB 7.0: 6.0 deletes no single document of a time series, and says so (CI 2026-10-23).
    const open = await setup([...RULES, { db: 'crm2', coll: 'seriesdel', field: 'v' }])
    const deleted = await open.as('editor', true)(
      'POST',
      '/databases/crm2/collections/seriesdel/documents/delete',
      {
        _id: 7,
      },
    )
    const { version } = await client.db('admin').command({ buildInfo: 1 })
    if (Number(String(version).split('.')[0]) >= 7) {
      expect(deleted.statusCode, deleted.body).toBe(204)
      expect(await coll.countDocuments()).toBe(0)
    } else {
      expect(deleted.statusCode, deleted.body).toBe(400)
      // The server's code, not the driver's wrapper's none (independent review, Minor 3).
      expect(deleted.json()).toMatchObject({ code: 'MONGO_ERROR', details: { code: 20, hidden: true } })
      expect(await coll.countDocuments()).toBe(1)
    }
    await coll.drop()
  })

  it('refuses a page whose collation makes its _ids equal (thirteenth review, I-2)', async () => {
    const { as } = await setup([...RULES, { db: 'crm2', coll: 'named', field: 'email' }])
    const viewer = as('viewer', true)
    const find = (collation?: object) =>
      viewer('POST', '/databases/crm2/collections/named/find', {
        filter: { t: 7 },
        ...(collation ? { collation } : {}),
      })
    const folded = await find({ locale: 'en', strength: 2 })
    expect(folded.statusCode, folded.body).toBe(403)
    expect(folded.json()).toMatchObject({ details: { reason: 'masking_unsupported', order: true } })
    // Without one, or with a simple one, the _ids tell the documents apart.
    expect((await find()).statusCode).toBe(200)
    expect((await find({ locale: 'simple' })).statusCode).toBe(200)
    // Nor where they differ under it.
    const other = await viewer('POST', '/databases/crm2/collections/named/find', {
      filter: { _id: 'Bob' },
      collation: { locale: 'en', strength: 3 },
    })
    expect(other.statusCode, other.body).toBe(200)
  })

  it('refuses a view’s page, and its read by _id, where its own collation makes _ids equal (fourteenth review, I-1)', async () => {
    const { as } = await setup([
      ...RULES,
      { db: 'crm2', coll: 'namedView', field: 'email' },
      { db: 'crm2', coll: 'named', field: 'email' },
    ])
    const viewer = as('viewer', true)
    const page = await viewer('POST', '/databases/crm2/collections/namedView/find', { filter: { t: 7 } })
    expect(page.statusCode, page.body).toBe(403)
    expect(page.json()).toMatchObject({ details: { reason: 'masking_unsupported', order: true } })
    const one = await viewer('POST', '/databases/crm2/collections/namedView/documents/get', { _id: 'bob' })
    expect(one.statusCode, one.body).toBe(403)
    // Explain is the query the page runs (M-6): a part of _id is refused where the _ids are asked about.
    const explain = (collation?: object) =>
      viewer('POST', '/databases/crm2/collections/named/explain', {
        kind: 'find',
        // No index that holds what is hidden serves it: only the refusal differs.
        filter: { other: 1 },
        ...(collation ? { collation } : {}),
        projection: { '_id.a': 1, t: 1 },
      })
    const plain = await explain()
    expect(plain.statusCode, plain.body).toBe(200)
    const explained = await explain({ locale: 'en', strength: 2 })
    expect(explained.statusCode, explained.body).toBe(403)
  })

  it('breaks the ties of what a collection whose collation folds joins (sixteenth review, I-2)', async () => {
    const { as } = await setup([...RULES, { db: 'crm2', coll: 'named', field: 'email' }])
    const pipelines: Document[][] = []
    const aggregate = Collection.prototype.aggregate
    vi.spyOn(Collection.prototype, 'aggregate').mockImplementation(function (
      this: Collection,
      ...args: unknown[]
    ) {
      if (this.collectionName === 'folded') pipelines.push(args[0] as Document[])
      return aggregate.apply(this, args as never)
    } as typeof aggregate)
    const r = await as('editor', true)('POST', '/databases/crm2/collections/folded/aggregate/preview', {
      stages: [{ $unionWith: { coll: 'named', pipeline: [{ $match: { t: 7 } }] } }],
    })
    expect(r.statusCode, r.body).toBe(200)
    const unions = pipelines.flat().filter((s) => '$unionWith' in s)
    expect(unions.length).toBeGreaterThan(0)
    for (const u of unions) expect(JSON.stringify(u)).toContain('$rand')
  })

  // Final review of explain masking (I-2): what a $skip or a $limit keeps depends on the order: a
  // count of it is counted in the run's order; one of filters alone is not reordered.
  it('counts a pipeline in the run’s order unless it only filters', async () => {
    const { as } = await setup(RULES)
    const pipelines: Document[][] = []
    const aggregate = Collection.prototype.aggregate
    vi.spyOn(Collection.prototype, 'aggregate').mockImplementation(function (
      this: Collection,
      ...args: unknown[]
    ) {
      if (this.collectionName === 'users') pipelines.push(args[0] as Document[])
      return aggregate.apply(this, args as never)
    } as typeof aggregate)
    const viewer = as('viewer', true)
    const ranked = await viewer('POST', `${USERS}/aggregate/count`, {
      stages: [{ $match: { name: 'Ali' } }, { $skip: 1 }, { $limit: 1 }],
    })
    expect(ranked.statusCode, ranked.body).toBe(200)
    const kept = pipelines.at(-1)!
    expect(kept.findIndex((s) => '$sort' in s)).toBeGreaterThan(-1)
    expect(kept.findIndex((s) => '$sort' in s)).toBeLessThan(kept.findIndex((s) => '$skip' in s))
    const filtered = await viewer('POST', `${USERS}/aggregate/count`, {
      stages: [{ $match: { name: 'Ali' } }],
    })
    expect(filtered.statusCode, filtered.body).toBe(200)
    expect(JSON.stringify(pipelines.at(-1))).not.toContain('$sort')
  })

  it('draws an aggregation preview’s sample in the gate’s order (eleventh review, I1)', async () => {
    const { as } = await setup([...RULES, { db: 'crm2', coll: 'keyed', field: '_id' }])
    const pipelines: Document[][] = []
    const aggregate = Collection.prototype.aggregate
    vi.spyOn(Collection.prototype, 'aggregate').mockImplementation(function (
      this: Collection,
      ...args: unknown[]
    ) {
      if (this.collectionName === 'keyed') pipelines.push(args[0] as Document[])
      return aggregate.apply(this, args as never)
    } as typeof aggregate)
    const r = await as('editor', true)('POST', '/databases/crm2/collections/keyed/aggregate/preview', {
      stages: [{ $match: {} }],
    })
    expect(r.statusCode, r.body).toBe(200)
    // Each prefix draws its sample after the random order, never in the hidden _id's.
    expect(pipelines.length).toBeGreaterThan(0)
    for (const p of pipelines) {
      const limit = p.findIndex((s) => '$limit' in s)
      expect(JSON.stringify(p.slice(0, limit)), JSON.stringify(p)).toContain('$rand')
    }
  })

  it('draws a $geoNear preview’s sample after the gate’s tie order (twelfth review, I-1)', async () => {
    const { as } = await setup([...RULES, { db: 'crm2', coll: 'keyed', field: '_id' }])
    const pipelines: Document[][] = []
    const aggregate = Collection.prototype.aggregate
    vi.spyOn(Collection.prototype, 'aggregate').mockImplementation(function (
      this: Collection,
      ...args: unknown[]
    ) {
      if (this.collectionName === 'keyed') pipelines.push(args[0] as Document[])
      return aggregate.apply(this, args as never)
    } as typeof aggregate)
    const r = await as('editor', true)('POST', '/databases/crm2/collections/keyed/aggregate/preview', {
      stages: [
        { $geoNear: { near: { type: 'Point', coordinates: [0, 0] }, key: 'loc', distanceField: 'd' } },
      ],
    })
    expect(r.statusCode, r.body).toBe(200)
    const drawn = pipelines.filter((p) => p.length > 1)
    expect(drawn.length).toBeGreaterThan(0)
    for (const p of drawn) {
      const limit = p.findIndex((s) => '$limit' in s)
      const tie = p.findIndex((s) => '$sort' in s)
      expect(tie, JSON.stringify(p)).toBeGreaterThan(0)
      expect(limit, JSON.stringify(p)).toBeGreaterThan(tie)
    }
  })

  it('shows no bulk preview samples of a time series whose _id repeats (eleventh review, I2)', async () => {
    const { as } = await setup([...RULES, { db: 'crm2', coll: 'series2', field: 'meta.email' }])
    const r = await as('editor', true)('POST', '/databases/crm2/collections/series2/bulk/preview', {
      filter: {},
      operation: 'update',
      update: { $set: { x: 9 } },
    })
    expect(r.statusCode, r.body).toBe(200)
    // Its own reason, said in the reader's language (twelfth and thirteenth reviews, M-2, N-1).
    expect(r.json().samples).toEqual({ unavailable: 'repeats' })
  })

  it('leaves a validator test’s sample out when its question runs out of time (nineteenth review, I1)', async () => {
    const { as } = await setup([...RULES, { db: 'crm2', coll: 'series2', field: 'meta.email' }])
    const aggregate = Collection.prototype.aggregate
    vi.spyOn(Collection.prototype, 'aggregate').mockImplementation(function (
      this: Collection,
      ...args: unknown[]
    ) {
      const stages = args[0] as Document[]
      // The question alone: { _id: { $in } }, then a group (the counts group too).
      const asked = (stages[0]?.$match as Document | undefined)?._id as Document | undefined
      if (this.collectionName === 'series2' && asked?.$in)
        return {
          toArray: () => Promise.reject(new MongoServerError({ code: 50, errmsg: 'time limit' })),
        } as never
      return aggregate.apply(this, args as never)
    } as typeof aggregate)
    const r = await as('viewer', true)('POST', '/databases/crm2/collections/series2/validation/test', {
      validator: { x: 5 },
    })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ failing: 2, sample: [] })
  })

  it('refuses an array _id, which ties by its least element (nineteenth review, Minor 5)', async () => {
    await expect(refuseRepeats(client.db('crm2').collection('people'), [[1, 2]])).rejects.toMatchObject({
      details: { order: true },
    })
    // A series holds one, MongoDB 8.2 sorting it with 3 (tenth review).
    const arrays = client.db('crm2').collection('arrays')
    await expect(refuseAnyRepeat(arrays)).rejects.toMatchObject({ details: { order: true } })
    // Document _ids the read refuses by itself are left out of the question.
    const series3 = client.db('crm2').collection('series3')
    await expect(refuseAnyRepeat(series3)).rejects.toMatchObject({ details: { order: true } })
    await expect(refuseAnyRepeat(series3, {}, true)).resolves.toBeUndefined()
  })

  it('answers a page’s own refusal before asking about its _ids (eighteenth review, I-3)', async () => {
    const { as } = await setup([
      ...RULES,
      { db: 'crm2', coll: 'series3', field: 'meta.email' },
      { db: 'crm2', coll: 'series3', field: '_id.email' },
    ])
    const r = await as('viewer', true)('POST', '/databases/crm2/collections/series3/find', { filter: {} })
    expect(r.statusCode, r.body).toBe(403)
    expect(r.json()).toMatchObject({ details: { reason: 'personal_field', field: '_id' } })
  })

  it('changes no document of a time series by an _id that repeats (eighteenth review, I-4)', async () => {
    const { as } = await setup([...RULES, { db: 'crm2', coll: 'series2', field: 'meta.email' }])
    const editor = as('editor', true)
    const r = await editor('POST', '/databases/crm2/collections/series2/documents/delete', { _id: 1 })
    expect(r.statusCode, r.body).toBe(403)
    expect(
      await client
        .db('crm2')
        .collection('series2')
        .countDocuments({ _id: 1 as never }),
    ).toBe(2)
    // Nor updated (nineteenth review): the twins' count comes before the version read.
    const u = await editor('POST', '/databases/crm2/collections/series2/documents/update', {
      _id: 1,
      hash: '0'.repeat(64),
      set: { x: 9 },
      unset: [],
    })
    expect(u.statusCode, u.body).toBe(403)
    expect(u.json()).toMatchObject({ details: { order: true } })
  })

  it('still counts a validator test where no order hides the samples (M5)', async () => {
    const { as } = await setup([...RULES, { db: 'crm2', coll: 'keyed', field: '_id' }])
    const r = await as('viewer', true)('POST', '/databases/crm2/collections/keyed/validation/test', {
      validator: { name: 'x' },
    })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ failing: 2, sample: [] })
  })

  it('refuses an empty hint, which MongoDB takes for none (thirteenth review, C1)', async () => {
    const { as } = await setup()
    const viewer = as('viewer', true)
    for (const hint of [{}, { $hint: 'name_1_customer.phone_1' }]) {
      const r = await viewer('POST', `${USERS}/find`, { filter: { name: 'Ali' }, hint })
      expect(r.statusCode, JSON.stringify(hint)).toBe(403)
    }
  })

  it('samples a bulk update’s preview of what its count counts (thirteenth review, I1)', async () => {
    const { as } = await setup()
    const editor = as('editor', true)
    // Each document's customer is a document that may hold the hidden phone: the update skips it.
    const r = await editor('POST', `${USERS}/bulk/preview`, {
      filter: { name: 'Ali' },
      operation: 'update',
      update: { $set: { customer: { since: 2020 } } },
    })
    expect(r.statusCode, r.body).toBe(200)
    const body = r.json() as { matched: number; samples: { documents: unknown[] } }
    expect(body.matched).toBe(0)
    expect(body.samples.documents).toEqual([])
    // Where the update changes some, the samples are those (fifteenth review, nit).
    const { as: mixedAs } = await setup([...RULES, { db: 'crm2', coll: 'mixed', field: 'customer.phone' }])
    const some = await mixedAs('editor', true)('POST', '/databases/crm2/collections/mixed/bulk/preview', {
      filter: { name: 'A' },
      operation: 'update',
      update: { $set: { customer: { since: 2020 } } },
    })
    expect(some.statusCode, some.body).toBe(200)
    const mixed = some.json() as { matched: number; samples: { documents: Array<{ before: Document }> } }
    expect(mixed.matched).toBe(1)
    expect(mixed.samples.documents.map((d) => d.before._id)).toEqual([{ $numberInt: '2' }])
  })

  it('shows no key count of an index build where rules apply to the viewer (thirteenth review, I2)', async () => {
    const { ctx, connectionId, as } = await setup()
    const viewer = as('viewer', true)
    const admin = as('admin')
    const job = {
      id: 'j1',
      kind: 'index.create',
      state: 'running',
      connectionId,
      targetConnectionId: null,
      userId: admin.id,
      db: 'crm',
      coll: 'users',
      target: 'name_1',
      progress: { done: 5, total: 9 },
      error: null,
      staging: null,
      stagingConnectionId: null,
      stagingDb: null,
    } as never
    const seen = (userId: string, role: string) =>
      toView(ctx, { kind: 'user', userId, role } as never, job).progress
    expect(seen(viewer.id, 'viewer')).toBeNull()
    expect(seen(admin.id, 'admin')).toEqual({ done: 5, total: 9 })
  })

  it('lets the gate’s own sort spill to disk in a run (M5)', async () => {
    const { as } = await setup()
    const editor = as('editor', true)
    const seen: Document[] = []
    const aggregate = Collection.prototype.aggregate
    vi.spyOn(Collection.prototype, 'aggregate').mockImplementation(function (
      this: Collection,
      ...args: unknown[]
    ) {
      if (this.collectionName === 'users') seen.push((args[1] as Document | undefined) ?? {})
      return aggregate.apply(this, args as never)
    } as typeof aggregate)
    const r = await editor('POST', `${USERS}/aggregate/run`, {
      stages: [{ $match: { name: 'Ali' } }],
      allowDiskUse: false,
    })
    expect(r.statusCode, r.body).toBe(200)
    expect(seen.at(-1)).toMatchObject({ allowDiskUse: true })
  })

  it('shows a bulk preview’s samples in no hidden _id’s order, each paired with its result (I4)', async () => {
    const { as } = await setup([...RULES, { db: 'crm', coll: 'users', field: '_id' }])
    const viewer = as('editor', true)
    const pipelines: Document[][] = []
    const aggregate = Collection.prototype.aggregate
    vi.spyOn(Collection.prototype, 'aggregate').mockImplementation(function (
      this: Collection,
      ...args: unknown[]
    ) {
      if (this.collectionName === 'users') pipelines.push(args[0] as Document[])
      return aggregate.apply(this, args as never)
    } as typeof aggregate)
    const r = await viewer('POST', `${USERS}/bulk/preview`, {
      filter: { name: 'Ali' },
      operation: 'update',
      update: { $set: { seen: true } },
    })
    expect(r.statusCode, r.body).toBe(200)
    // The count's own aggregation aside: the sample read, then the read of what the update makes.
    const [first, second] = pipelines.filter((p) => p.some((stage) => '$limit' in stage || '$unset' in stage))
    expect(JSON.stringify(first)).not.toContain('{"$sort":{"_id":1}}')
    expect(JSON.stringify(first)).toContain('$rand')
    expect(JSON.stringify(second)).toContain('$indexOfArray')
    const samples = (r.json() as { samples: { documents: Array<{ before: Document; after: Document }> } })
      .samples
    expect(samples.documents).toHaveLength(2)
    for (const d of samples.documents) expect(d.after).toMatchObject({ ...d.before, seen: true })
  })
})

describe('sizes', () => {
  it('shows a restricted user a collection’s counts, never its sizes, where rules apply', async () => {
    const { as } = await setup()
    const hidden = (await as('viewer', true)('GET', `${USERS}/stats`)).json()
    expect(hidden).toMatchObject({ count: 2, nindexes: 2, sizesHidden: true })
    for (const k of ['size', 'storageSize', 'avgObjSize', 'totalIndexSize']) expect(hidden[k], k).toBeNull()
    expect(hidden.indexSizes).toEqual({})
    const shown = (await as('admin')('GET', `${USERS}/stats`)).json()
    expect(shown.size).toBeGreaterThan(0)
    expect(shown.sizesHidden).toBeUndefined()
    // A collection without rules shows its sizes to anyone.
    expect(
      (await as('viewer', true)('GET', '/databases/crm/collections/notes/stats')).json().size,
    ).toBeGreaterThan(0)
  })

  it('hides a database’s sizes, and its size on disk in the list, where rules apply in it', async () => {
    const { as } = await setup()
    const stats = (await as('viewer', true)('GET', '/databases/crm/stats')).json()
    expect(stats).toMatchObject({
      objects: 5,
      sizesHidden: true,
      dataSize: null,
      storageSize: null,
      indexSize: null,
    })
    const list = (await as('viewer', true)('GET', '/databases')).json() as {
      databases: Array<{ name: string; sizeOnDisk: number | null }>
      totalSize: number | null
    }
    expect(list.databases.find((d) => d.name === 'crm')?.sizeOnDisk).toBeNull()
    // The total would tell what the hidden one adds.
    expect(list.totalSize).toBeNull()
    expect((await as('admin')('GET', '/databases')).json().totalSize).toBeGreaterThan(0)
  })
})

describe('slow queries', () => {
  it('never shows a restricted user how many keys a query examined', async () => {
    const { as } = await setup()
    const crm = client.db('crm')
    await crm.command({ profile: 2 })
    try {
      await crm.collection('users').find({ name: 'Ali' }).toArray()
      const read = async (masked: boolean) =>
        (
          await as(masked ? 'editor' : 'admin', masked)('GET', '/server/slow-queries?db=crm&source=profile')
        ).json() as { entries: Array<{ ns: string; keysExamined?: number }> }
      const shown = await read(false)
      expect(shown.entries.some((e) => e.ns === 'crm.users' && e.keysExamined !== undefined)).toBe(true)
      const hidden = await read(true)
      expect(hidden.entries.some((e) => e.ns === 'crm.users')).toBe(true)
      expect(hidden.entries.every((e) => e.keysExamined === undefined)).toBe(true)
    } finally {
      await crm.command({ profile: 0 })
    }
  })
})
