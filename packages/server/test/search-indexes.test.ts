// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Collection, MongoClient, MongoServerError, type Document } from 'mongodb'
import { toClient } from '../src/data/ejson-io'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, type DataHarness } from './support/data'
import { restrictedApp } from './support/restricted'
import type { TestApp } from './helpers'

/**
 * W2.6 (2026-10-16): Atlas Search and Vector Search indexes in the Indexes tab — listed with their
 * status, created, updated and dropped. No Atlas here: the driver's answers are mocked, and the
 * test server (no mongot) shows how a server without search is told apart.
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
async function setup() {
  const h = await dataHarness(mongo)
  harnesses.push(h)
  const db = `s${randomUUID().slice(0, 8)}`
  await client.db(db).collection('movies').insertOne({ title: 'x' })
  return { h, db, base: `/databases/${db}/collections/movies/search-indexes` }
}

/** What Atlas answers to $listSearchIndexes. */
const ATLAS = [
  {
    id: '6524096020da840844a4c4a7',
    name: 'default',
    type: 'search',
    status: 'READY',
    queryable: true,
    latestDefinitionVersion: { version: 0, createdAt: new Date('2026-10-01T00:00:00Z') },
    latestDefinition: { mappings: { dynamic: true } },
    statusDetail: [{ hostname: 'atlas-shard-00-01', status: 'READY', queryable: true }],
  },
  {
    id: '6524096020da840844a4c4a8',
    name: 'vector_index',
    type: 'vectorSearch',
    status: 'BUILDING',
    queryable: false,
    latestDefinition: {
      fields: [
        { type: 'vector', path: 'plot_embedding', numDimensions: 1536, similarity: 'cosine' },
        { type: 'filter', path: 'year' },
      ],
    },
  },
  {
    id: '6524096020da840844a4c4a9',
    name: 'broken',
    status: 'FAILED',
    queryable: false,
    message: 'Index build failed: mapping for "plot" is not valid',
    latestDefinition: { mappings: { fields: { plot: { type: 'nope' } } } },
  },
]
const listing = (items: Document[]) =>
  vi
    .spyOn(Collection.prototype, 'listSearchIndexes')
    .mockReturnValue({ toArray: async () => items } as unknown as ReturnType<Collection['listSearchIndexes']>)

describe('search indexes', () => {
  it('lists each index with its type, status, whether it can be queried and its definition', async () => {
    const { h, base } = await setup()
    listing(ATLAS)
    const res = await h.call('GET', base)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.supported).toBe(true)
    expect(body.indexes).toEqual([
      {
        name: 'default',
        type: 'search',
        status: 'READY',
        queryable: true,
        definition: { mappings: { dynamic: true } },
      },
      {
        name: 'vector_index',
        type: 'vectorSearch',
        status: 'BUILDING',
        queryable: false,
        definition: {
          fields: [
            {
              type: 'vector',
              path: 'plot_embedding',
              numDimensions: { $numberInt: '1536' },
              similarity: 'cosine',
            },
            { type: 'filter', path: 'year' },
          ],
        },
      },
      {
        name: 'broken',
        type: 'search',
        status: 'FAILED',
        queryable: false,
        message: 'Index build failed: mapping for "plot" is not valid',
        definition: { mappings: { fields: { plot: { type: 'nope' } } } },
      },
    ])
  })

  it('says plainly when the server has no search (no Atlas, no mongot)', async () => {
    const { h, base } = await setup()
    // The real test server: MongoDB without mongot.
    const real = await h.call('GET', base)
    expect(real.statusCode).toBe(200)
    expect(real.json()).toMatchObject({ supported: false, indexes: [] })
    // Atlas's own refusal of a cluster tier without search, mocked.
    vi.spyOn(Collection.prototype, 'listSearchIndexes').mockReturnValue({
      toArray: async () => {
        throw new MongoServerError({
          code: 31082,
          codeName: 'SearchNotEnabled',
          errmsg: 'Search not enabled',
        })
      },
    } as unknown as ReturnType<Collection['listSearchIndexes']>)
    expect((await h.call('GET', base)).json()).toEqual({
      supported: false,
      reason: 'not_enabled',
      indexes: [],
    })
  })

  it('creates a search index and a vector index, as written, and audits each', async () => {
    const { h, base } = await setup()
    const create = vi.spyOn(Collection.prototype, 'createSearchIndex').mockResolvedValue('made')
    const search = await h.call('POST', base, {
      name: 'default',
      type: 'search',
      definition: { mappings: { dynamic: true } },
    })
    expect(search.statusCode).toBe(201)
    const vector = await h.call('POST', base, {
      name: 'vector_index',
      type: 'vectorSearch',
      definition: {
        fields: [
          { type: 'vector', path: 'emb', numDimensions: { $numberInt: '3' }, similarity: 'dotProduct' },
          { type: 'filter', path: 'genre' },
        ],
      },
    })
    expect(vector.statusCode).toBe(201)
    // Sent to MongoDB as BSON (numDimensions an Int32), exactly as written.
    expect(create.mock.calls.map(([d]) => toClient(d))).toEqual([
      { name: 'default', type: 'search', definition: { mappings: { dynamic: true } } },
      {
        name: 'vector_index',
        type: 'vectorSearch',
        definition: {
          fields: [
            { type: 'vector', path: 'emb', numDimensions: { $numberInt: '3' }, similarity: 'dotProduct' },
            { type: 'filter', path: 'genre' },
          ],
        },
      },
    ])
    const rows = h.t.app.ctx.audit.list({ action: 'searchIndexes.create' })
    expect(rows.map((r) => r.details)).toEqual([
      expect.objectContaining({ name: 'vector_index', type: 'vectorSearch' }),
      expect.objectContaining({ name: 'default', type: 'search' }),
    ])
  })

  it('refuses a bad name, a bad vector definition, server JavaScript and an oversized definition', async () => {
    const { h, base } = await setup()
    const create = vi.spyOn(Collection.prototype, 'createSearchIndex').mockResolvedValue('made')
    const bad: unknown[] = [
      { name: '../x', type: 'search', definition: {} },
      { name: 'v', type: 'vectorSearch', definition: { fields: [] } },
      {
        name: 'v',
        type: 'vectorSearch',
        definition: { fields: [{ type: 'vector', path: 'e', numDimensions: 0, similarity: 'cosine' }] },
      },
      {
        name: 'v',
        type: 'vectorSearch',
        definition: { fields: [{ type: 'vector', path: 'e', numDimensions: 3, similarity: 'manhattan' }] },
      },
      { name: 's', type: 'search', definition: { mappings: { $where: 'sleep(1)' } } },
      { name: 's', type: 'search', definition: { analyzers: ['x'.repeat(70_000)] } },
      { name: 's', type: 'other', definition: {} },
    ]
    for (const body of bad)
      expect((await h.call('POST', base, body)).statusCode, JSON.stringify(body).slice(0, 80)).toBe(400)
    expect(create).not.toHaveBeenCalled()
  })

  it('updates and drops an index by name', async () => {
    const { h, base } = await setup()
    const update = vi.spyOn(Collection.prototype, 'updateSearchIndex').mockResolvedValue(undefined)
    const drop = vi.spyOn(Collection.prototype, 'dropSearchIndex').mockResolvedValue(undefined)
    const res = await h.call('PATCH', `${base}/default`, { definition: { mappings: { dynamic: false } } })
    expect(res.statusCode).toBe(200)
    expect(update).toHaveBeenCalledWith('default', { mappings: { dynamic: false } })
    expect((await h.call('DELETE', `${base}/default`)).statusCode).toBe(204)
    expect(drop).toHaveBeenCalledWith('default')
    expect(h.t.app.ctx.audit.list({ action: 'searchIndexes.update' })).toHaveLength(1)
    expect(h.t.app.ctx.audit.list({ action: 'searchIndexes.drop' })).toHaveLength(1)
  })

  // W2 review (minor 8): an edited vector index is checked as a new one is.
  it('checks an edited vector definition as a new one, and leaves a search definition to Atlas', async () => {
    const { h, base } = await setup()
    listing(ATLAS)
    const update = vi.spyOn(Collection.prototype, 'updateSearchIndex').mockResolvedValue(undefined)
    const bad = await h.call('PATCH', `${base}/vector_index`, {
      definition: { fields: [{ type: 'vector', path: 'e', numDimensions: 0, similarity: 'cosine' }] },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().details).toMatchObject({ reason: 'vector_dimensions' })
    expect(update).not.toHaveBeenCalled()
    const good = await h.call('PATCH', `${base}/default`, { definition: { mappings: { dynamic: true } } })
    expect(good.statusCode).toBe(200)
  })

  // W2 review (minor 10): MongoDB 7.0 Community answers $listSearchIndexes with its own code.
  it.each([
    [31082, 'SearchNotEnabled', 'not_enabled'],
    [6047401, 'Location6047401', 'not_enabled'],
    [40324, 'Location40324', 'unsupported'],
  ])('reads code %i (%s) as a server without search', async (code, codeName, reason) => {
    const { h, base } = await setup()
    vi.spyOn(Collection.prototype, 'listSearchIndexes').mockReturnValue({
      toArray: async () => {
        throw new MongoServerError({
          code,
          codeName,
          errmsg: '$listSearchIndexes stage is only allowed on MongoDB Atlas',
        })
      },
    } as unknown as ReturnType<Collection['listSearchIndexes']>)
    expect((await h.call('GET', base)).json()).toEqual({ supported: false, reason, indexes: [] })
  })

  it('passes on MongoDB’s refusal of a create where search is not available', async () => {
    const { h, base } = await setup()
    const res = await h.call('POST', base, {
      name: 'default',
      type: 'search',
      definition: { mappings: { dynamic: true } },
    })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(res.json().code).toBe('MONGO_ERROR')
  })
})

describe('search indexes and personal data', () => {
  it('lets a restricted user list them, and change none where rules apply', async () => {
    const db = `p${randomUUID().slice(0, 8)}`
    await client.db(db).collection('users').insertOne({ email: 'x@y' })
    const r = await restrictedApp(mongo, [{ db, coll: 'users', field: 'email' }])
    apps.push(r.t)
    listing(ATLAS)
    const create = vi.spyOn(Collection.prototype, 'createSearchIndex').mockResolvedValue('made')
    const user = r.as('editor', true)
    const base = `/databases/${db}/collections/users/search-indexes`
    expect((await user('GET', base)).statusCode).toBe(200)
    // W2 review (minor 11): analysers and synonyms can hold words someone chose (stop words, synonym
    // lists): hidden from a restricted user, the fields an index covers still shown.
    listing([
      {
        name: 'withWords',
        type: 'search',
        status: 'READY',
        queryable: true,
        latestDefinition: {
          mappings: { dynamic: false, fields: { title: { type: 'string', analyzer: 'mine' } } },
          analyzers: [{ name: 'mine', tokenFilters: [{ type: 'stopword', tokens: ['S3CR3T'] }] }],
          synonyms: [{ name: 's', source: { collection: 'syn' }, analyzer: 'lucene.standard' }],
        },
      },
    ])
    const hidden = await user('GET', base)
    expect(hidden.body).not.toContain('S3CR3T')
    const [index] = hidden.json().indexes
    expect(index.definition).toMatchObject({
      mappings: { fields: { title: { type: 'string' } } },
      analyzers: '***',
      synonyms: '***',
    })
    expect((await r.as('editor')('GET', base)).body).toContain('S3CR3T')
    // Re-review (minor 2): where no rule applies, the same user sees (and may edit) it whole —
    // masks they would save back would replace the analysers.
    await client.db(db).collection('notes').insertOne({ text: 'x' })
    const free = await user('GET', `/databases/${db}/collections/notes/search-indexes`)
    expect(free.body).toContain('S3CR3T')
    const made = await user('POST', base, {
      name: 'default',
      type: 'search',
      definition: { mappings: { dynamic: true } },
    })
    expect(made.statusCode).toBe(403)
    expect(made.json().details).toMatchObject({ reason: 'masking_unsupported' })
    expect(create).not.toHaveBeenCalled()
  })
})
