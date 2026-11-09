// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createHmac } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AggregationCursor, Collection, FindCursor, MongoClient, type Document } from 'mongodb'
import { deserializeValue, toWire } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { restrictedApp } from './support/restricted'
import { registerKeyVaults } from '../src/connections/access'
import { compileRules } from '../src/masking/match'
import { gateDepsFor, viewAwareMasker } from '../src/masking/restricted'
import type { TestApp } from './helpers'
import { slow } from './support/slowness'

/** Phase 3c-1 final review: the route-level holes (C3, C4, C5, I3, M1, M4), each pinned by a test. */
const S = 'S3NT1N3L'
const RULES = [
  { db: 'crm', coll: 'users', field: 'email' },
  { db: 'crm', coll: 'users', field: 'customer.phone' },
]
const USERS = '/databases/crm/collections/users'
let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
  const client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
  const crm = client.db('crm')
  const doc: Document = { _id: 1, email: `${S}@x`, name: 'Ali', customer: { phone: `${S}-p`, city: 'Izmir' } }
  await crm.collection('users').insertMany([doc, { _id: 2, email: 'b@x', name: 'Bea', customer: 'none' }])
  await crm.collection('copy').insertOne(doc)
  await crm.collection('notes').insertOne({ text: 'n' })
  await crm.createCollection('v1', { viewOn: 'users', pipeline: [{ $project: { email: 1, name: 1 } }] })
  await crm.createCollection('view2', { viewOn: 'v1', pipeline: [{ $match: { email: `${S}@x` } }] })
  await crm.createCollection('by_email', { viewOn: 'users', pipeline: [{ $group: { _id: '$email' } }] })
  await client.close()
}, slow(120_000))
afterAll(async () => {
  await mongo?.stop()
})
const apps: TestApp[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const t of apps.splice(0)) await t.close()
})
async function setup() {
  const r = await restrictedApp(mongo, RULES)
  apps.push(r.t)
  return r
}
const hashes = (body: string) => [...body.matchAll(/"hash":"([0-9a-f]{64})"/g)].map((m) => m[1])

describe('final review, routes (phase 3c-1)', () => {
  it('C3: a restricted user gets no reproducible pin for anything but a stored document', async () => {
    const { as } = await setup()
    const user = as('editor', true)
    const run = () =>
      user('POST', `${USERS}/aggregate/run`, {
        stages: [{ $project: { _id: 0, 'customer.phone': 1 } }],
        limit: 5,
      })
    expect(hashes((await run()).body)).not.toEqual(hashes((await run()).body))
    const projected = () => user('POST', `${USERS}/find`, { filter: {}, projection: { name: 1 }, limit: 5 })
    expect(hashes((await projected()).body)).not.toEqual(hashes((await projected()).body))
    const whole = () => user('POST', `${USERS}/find`, { filter: {}, limit: 5 })
    expect(hashes((await whole()).body)).toEqual(hashes((await whole()).body))
    // The same stored document in another namespace has another pin.
    const copy = await user('POST', '/databases/crm/collections/copy/find', { filter: { _id: 1 }, limit: 1 })
    const original = await user('POST', `${USERS}/find`, { filter: { _id: 1 }, limit: 1 })
    expect(hashes(copy.body)[0]).not.toBe(hashes(original.body)[0])
    // A document pin still works for an editor who sees everything.
    const editor = as('editor')
    const found = (await editor('POST', `${USERS}/find`, { filter: { _id: 2 }, limit: 1 })).json()
    const updated = await editor('POST', `${USERS}/documents/update`, {
      _id: { $numberInt: '2' },
      set: { name: 'Bea2' },
      hash: found.documents[0].hash,
    })
    expect(updated.statusCode).toBe(200)
  })

  it('C3: the rules version is not keyed like a document pin', async () => {
    const { ctx, as } = await setup()
    const state = (await as('admin')('GET', `${USERS}/validation`)).json()
    const rules = {
      validator: state.validator,
      validationLevel: state.validationLevel,
      validationAction: state.validationAction,
    }
    expect(state.version).not.toBe(createHmac('sha256', ctx.docPinKey).update(toWire(rules)).digest('hex'))
  })

  it('C4: an aggregation write cannot read or write a ruled namespace', async () => {
    const { as } = await setup()
    const user = as('editor', true)
    const lookup = await user('POST', '/databases/crm/collections/notes/aggregate/write-preview', {
      stages: [{ $lookup: { from: 'users', pipeline: [], as: 'u' } }, { $out: 'mine' }],
    })
    expect(lookup.statusCode).toBe(403)
    const merge = await user('POST', '/databases/crm/collections/notes/aggregate/write-preview', {
      stages: [{ $merge: { into: 'users' } }],
    })
    expect(merge.statusCode).toBe(403)
    const write = await user('POST', '/databases/crm/collections/notes/aggregate/write', {
      stages: [{ $lookup: { from: 'users', pipeline: [], as: 'u' } }, { $out: 'mine' }],
      token: 'x',
    })
    expect(write.statusCode).toBe(403)
  })

  it('C5: a view over ruled data counts as ruled for writes', async () => {
    const { as } = await setup()
    const user = as('editor', true)
    expect((await user('POST', '/databases/crm/collections/v1/duplicate', { to: 'copied' })).statusCode).toBe(
      403,
    )
    const out = await user('POST', '/databases/crm/collections/v1/aggregate/write-preview', {
      stages: [{ $out: 'copied' }],
    })
    expect(out.statusCode).toBe(403)
  })

  it('I3: definitions and shared items follow views to their source rules', async () => {
    const { as } = await setup()
    const colls = await as('viewer', true)('GET', '/databases/crm/collections')
    expect(colls.statusCode).toBe(200)
    expect(colls.body).not.toContain(S)
    const admin = as('admin')
    expect(
      (
        await admin('POST', '/databases/crm/collections/v1/favourites', {
          name: 'on view',
          tags: [],
          shared: true,
          query: { filter: { email: `${S}@x` } },
        })
      ).statusCode,
    ).toBe(201)
    const favs = await as('viewer', true)('GET', '/databases/crm/collections/v1/favourites')
    expect(favs.body).not.toContain(S)
    expect((await as('viewer', true)('GET', '/library')).body).not.toContain(S)
  })

  it('I3: a view-aware masker follows view chains and masks everything it cannot resolve', async () => {
    const { t, as } = await setup()
    void as
    const client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
    try {
      const masker = compileRules(RULES)
      const deps = {
        masker,
        view: async (db: string, coll: string) => {
          const [info] = await client.db(db).listCollections({ name: coll }, { nameOnly: false }).toArray()
          const o = (info?.options ?? {}) as { viewOn?: string; pipeline?: never[] }
          return info?.type === 'view' ? { viewOn: String(o.viewOn), pipeline: o.pipeline ?? [] } : null
        },
        indexes: async () => [],
      }
      const aware = await viewAwareMasker(masker, deps, [
        ['crm', 'view2'],
        ['crm', 'by_email'],
      ])
      expect(aware.forNs('crm', 'view2').matches(['email'])).toBe(true)
      expect(aware.forNs('crm', 'by_email').matches(['anything'])).toBe(true)
      expect(aware.forNs('crm', 'notes').any).toBe(false)
    } finally {
      await client.close()
      void t
    }
  })

  it('a grouping explain shows no byte count, even one given per accumulator (sixth review)', async () => {
    const { as } = await setup()
    const res = await as('viewer', true)('POST', `${USERS}/explain`, {
      kind: 'aggregate',
      stages: [{ $match: { _id: 1 } }, { $group: { _id: null, c: { $push: '$$ROOT' } } }],
      verbosity: 'executionStats',
    })
    expect(res.statusCode, res.body).toBe(200)
    // The answer comes as canonical EJSON: read back, its figures are numbers again.
    const raw = deserializeValue(res.json().raw)
    const sizes: unknown[] = []
    const walk = (v: unknown, sized: boolean) => {
      if (Array.isArray(v)) v.forEach((x) => walk(x, sized))
      else if (v && typeof v === 'object' && !('_bsontype' in v))
        for (const [k, x] of Object.entries(v)) {
          // The server's own settings measure no data.
          if (k === 'serverParameters') continue
          // MongoDB's size figures by name: bytes, data and storage sizes, spills, memory, disk.
          walk(x, sized || /Bytes|DataSize|StorageSize|^spill|^memUsage$|^memLimit$|^usedDisk$/.test(k))
        }
      else if (sized && v !== '***') sizes.push(v)
    }
    walk(raw, false)
    expect(sizes).toEqual([])
  })

  it('refuses the explain of a plan that reads an index holding personal data (eighth review)', async () => {
    const { as, ctx } = await setup()
    const client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
    const users = client.db('crm').collection('users')
    try {
      await users.createIndex({ name: 1, 'customer.phone': 1 }, { name: 'name_phone' })
      const explain = (path: string, body: object) => as('viewer', true)('POST', `${path}/explain`, body)
      // Refused before anything runs: the plan alone is read first (ninth review, M3).
      const verbosities: unknown[] = []
      const explainOf = FindCursor.prototype.explain
      vi.spyOn(FindCursor.prototype, 'explain').mockImplementation(function (this: FindCursor, ...args) {
        verbosities.push((args[0] as { verbosity?: unknown } | undefined)?.verbosity)
        return explainOf.apply(this, args)
      })
      const first = await explain(USERS, {
        kind: 'find',
        filter: { name: 'Ali' },
        verbosity: 'executionStats',
      })
      expect(first.statusCode).toBe(403)
      expect(verbosities).toEqual(['queryPlanner'])
      vi.restoreAllMocks()
      // An aggregation's plan is read first too.
      const aggregated: unknown[] = []
      const explainAgg = AggregationCursor.prototype.explain
      vi.spyOn(AggregationCursor.prototype, 'explain').mockImplementation(function (
        this: AggregationCursor,
        ...args
      ) {
        aggregated.push((args[0] as { verbosity?: unknown } | undefined)?.verbosity)
        return explainAgg.apply(this, args)
      })
      const grouped = await explain(USERS, {
        kind: 'aggregate',
        stages: [{ $match: { name: 'Ali' } }, { $group: { _id: null, n: { $sum: 1 } } }],
        verbosity: 'executionStats',
      })
      expect(grouped.statusCode).toBe(403)
      expect(aggregated).toEqual(['queryPlanner'])
      vi.restoreAllMocks()
      // Audited as every refusal of the gate is (ninth review, I5).
      expect(
        ctx.audit.list({ action: 'masking.refused' }).map((r) => (r.details as { reason?: unknown }).reason),
      ).toContain('personal_index')
      for (const [path, body] of [
        [USERS, { kind: 'find', filter: { name: 'Ali' }, verbosity: 'executionStats' }],
        [USERS, { kind: 'find', filter: { name: 'Ali' }, verbosity: 'queryPlanner' }],
        [
          USERS,
          {
            kind: 'aggregate',
            stages: [{ $match: { name: 'Ali' } }, { $group: { _id: null, n: { $sum: 1 } } }],
          },
        ],
        // A join into the collection reads its index too.
        [
          '/databases/crm/collections/notes',
          {
            kind: 'aggregate',
            stages: [{ $lookup: { from: 'users', localField: 'text', foreignField: 'name', as: 'u' } }],
          },
        ],
      ] as const) {
        const res = await explain(path, body)
        expect(res.statusCode, JSON.stringify(body)).toBe(403)
        // It names the collection whose index it is, a joined one too.
        expect(res.json().details, JSON.stringify(body)).toEqual({
          reason: 'personal_index',
          ns: 'crm.users',
        })
        expect(res.body).not.toContain(S)
      }
      await users.dropIndex('name_phone')
      await users.createIndex({ name: 1 }, { name: 'name_only' })
      // An index that holds no personal data: the plan and its counts are shown.
      const res = await explain(USERS, { kind: 'find', filter: { name: 'Ali' }, verbosity: 'executionStats' })
      expect(res.statusCode, res.body).toBe(200)
      expect(JSON.stringify(deserializeValue(res.json().raw))).toMatch(/"totalKeysExamined":\d/)
    } finally {
      await users.dropIndex('name_phone').catch(() => undefined)
      await users.dropIndex('name_only').catch(() => undefined)
      await client.close()
    }
  })

  it('runs the explain when the plan check runs out of time, and checks its answer (tenth review, M4)', async () => {
    const { as } = await setup()
    const seen: unknown[] = []
    const explain = FindCursor.prototype.explain
    vi.spyOn(FindCursor.prototype, 'explain').mockImplementation(function (this: FindCursor, ...args) {
      const verbosity = (args[0] as { verbosity?: unknown } | undefined)?.verbosity
      seen.push(verbosity)
      if (seen.length === 1)
        return Promise.reject(
          Object.assign(new Error('operation exceeded time limit'), { name: 'MongoServerError', code: 50 }),
        )
      return explain.apply(this, args)
    })
    const res = await as('viewer', true)('POST', `${USERS}/explain`, {
      kind: 'find',
      filter: { name: 'Ali' },
      verbosity: 'executionStats',
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(seen).toEqual(['queryPlanner', 'executionStats'])
  })

  it('refuses after the run what the plan check could not read in time, and asks no plan again (eleventh review)', async () => {
    const { as } = await setup()
    const client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
    const users = client.db('crm').collection('users')
    const ranOut = () =>
      Object.assign(new Error('operation exceeded time limit'), { name: 'MongoServerError', code: 50 })
    try {
      await users.createIndex({ name: 1, 'customer.phone': 1 }, { name: 'name_phone' })
      const seen: unknown[] = []
      const explain = FindCursor.prototype.explain
      let failing = 1
      vi.spyOn(FindCursor.prototype, 'explain').mockImplementation(function (this: FindCursor, ...args) {
        seen.push((args[0] as { verbosity?: unknown } | undefined)?.verbosity)
        if (seen.length <= failing) return Promise.reject(ranOut())
        return explain.apply(this, args)
      })
      const ask = () =>
        as('viewer', true)('POST', `${USERS}/explain`, {
          kind: 'find',
          filter: { name: 'Ali' },
          verbosity: 'executionStats',
        })
      // The plan check runs out of time; the run's answer shows the index: refused.
      const refused = await ask()
      expect(refused.statusCode).toBe(403)
      expect(refused.json().details).toMatchObject({ reason: 'personal_index' })
      expect(seen).toEqual(['queryPlanner', 'executionStats'])
      // The plan check and the run both run out of time: no plan is asked for a third time.
      seen.length = 0
      failing = 2
      const late = await ask()
      expect(late.statusCode).toBe(504)
      expect(seen).toEqual(['queryPlanner', 'executionStats'])
    } finally {
      vi.restoreAllMocks()
      await users.dropIndex('name_phone').catch(() => undefined)
      await client.close()
    }
  })

  it('checks nothing for a restricted user where no rule applies (eleventh review, M5)', async () => {
    const r = await restrictedApp(mongo, [])
    apps.push(r.t)
    const seen: unknown[] = []
    const explain = FindCursor.prototype.explain
    vi.spyOn(FindCursor.prototype, 'explain').mockImplementation(function (this: FindCursor, ...args) {
      seen.push((args[0] as { verbosity?: unknown } | undefined)?.verbosity)
      return explain.apply(this, args)
    })
    const res = await r.as('viewer', true)('POST', `${USERS}/explain`, {
      kind: 'find',
      filter: { name: 'Ali' },
      verbosity: 'executionStats',
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(seen).toEqual(['executionStats'])
  })

  it('checks a plan where only a key vault’s own rules apply (eleventh review, M1)', async () => {
    const stop = registerKeyVaults({ keyVaultNamespaces: () => new Set(['crm.keys']) })
    try {
      const r = await restrictedApp(mongo, [])
      apps.push(r.t)
      const seen: unknown[] = []
      const explain = FindCursor.prototype.explain
      vi.spyOn(FindCursor.prototype, 'explain').mockImplementation(function (this: FindCursor, ...args) {
        seen.push((args[0] as { verbosity?: unknown } | undefined)?.verbosity)
        return explain.apply(this, args)
      })
      const res = await r.as('viewer', true)('POST', `${USERS}/explain`, {
        kind: 'find',
        filter: { name: 'Ali' },
        verbosity: 'executionStats',
      })
      expect(res.statusCode, res.body).toBe(200)
      expect(seen).toEqual(['queryPlanner', 'executionStats'])
    } finally {
      stop()
    }
  })

  it('tells a namespace’s kind from its listing: a view, a time-series collection, missing (eleventh review)', async () => {
    const client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
    try {
      const crm = client.db('crm')
      await crm
        .createCollection('metrics', { timeseries: { timeField: 't', metaField: 'm' } })
        .catch(() => undefined)
      const deps = gateDepsFor(compileRules([]), client)
      expect(await deps.kind!('crm', 'metrics')).toBe('timeseries')
      expect(await deps.kind!('crm', 'v1')).toBe('view')
      expect(await deps.kind!('crm', 'users')).toBe('collection')
      expect(await deps.kind!('crm', 'nowhere')).toBe('missing')
    } finally {
      await client.close()
    }
  })

  it('names an unindexed join to a restricted user too (sixth review)', async () => {
    const { as } = await setup()
    const res = await as('viewer', true)('POST', `${USERS}/explain`, {
      kind: 'aggregate',
      stages: [{ $lookup: { from: 'notes', localField: 'name', foreignField: 'text', as: 'n' } }],
      verbosity: 'executionStats',
    })
    expect(res.statusCode, res.body).toBe(200)
    expect((res.json() as { warnings: Array<{ code: string }> }).warnings.map((w) => w.code)).toContain(
      'UNINDEXED_LOOKUP',
    )
  })

  it('M1: an explain answer hides figures that tell the size of a value', async () => {
    const { as } = await setup()
    const res = await as('viewer', true)('POST', `${USERS}/explain`, {
      kind: 'find',
      // Every document sorted in memory: the sort's byte counts are in the answer.
      filter: {},
      sort: { name: 1 },
      verbosity: 'executionStats',
    })
    expect(res.statusCode).toBe(200)
    const sizes: unknown[] = []
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) {
          // The server's own settings (its memory limits) measure no data: they are shown as set.
          if (k === 'serverParameters') continue
          if (/bytes|datasize|memusage/i.test(k)) sizes.push(x)
          else walk(x)
        }
    }
    walk(res.json().raw)
    expect(sizes.length).toBeGreaterThan(0)
    // A count given per accumulator is an object: each of its leaves is hidden.
    const hidden = (x: unknown): boolean =>
      x !== null && typeof x === 'object' ? Object.values(x).every(hidden) : x === '***'
    expect(sizes.every(hidden)).toBe(true)
  })

  it('an explain that ran out of time gives the plan alone through the same gate, masked', async () => {
    const { as } = await setup()
    const finds: unknown[][] = []
    const find = Collection.prototype.find
    vi.spyOn(Collection.prototype, 'find').mockImplementation(function (
      this: Collection,
      ...args: unknown[]
    ) {
      finds.push(args)
      return find.apply(this, args as never) as FindCursor
    } as typeof find)
    const explain = FindCursor.prototype.explain
    let calls = 0
    vi.spyOn(FindCursor.prototype, 'explain').mockImplementation(function (this: FindCursor, ...args) {
      // The run itself (the plan was read alone first, as a restricted user's is) runs out of time.
      const verbosity = (args[0] as { verbosity?: unknown } | undefined)?.verbosity
      if (verbosity !== 'queryPlanner' && calls++ === 0)
        return Promise.reject(
          Object.assign(new Error('operation exceeded time limit'), { name: 'MongoServerError', code: 50 }),
        )
      return explain.apply(this, args)
    })
    const res = await as('viewer', true)('POST', `${USERS}/explain`, {
      kind: 'find',
      filter: { name: 'Ali' },
      verbosity: 'executionStats',
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().incomplete).toMatchObject({ planOnly: true })
    // The plan read first (and given again as the plan alone), the run: the gate's query each time.
    expect(finds).toHaveLength(2)
    for (const f of finds.slice(1)) expect(JSON.stringify(f)).toBe(JSON.stringify(finds[0]))
    expect(res.body).not.toContain(S)
    // The plan is masked as any explain answer: the user's own literal too.
    expect(JSON.stringify(res.json().raw)).toContain('"***"')
    expect(res.body).not.toContain('Ali')
  })

  it('a pipeline explain that ran out of time gives the plan alone through the same gate, masked', async () => {
    const { as } = await setup()
    const calls: unknown[][] = []
    const aggregate = Collection.prototype.aggregate
    vi.spyOn(Collection.prototype, 'aggregate').mockImplementation(function (
      this: Collection,
      ...args: unknown[]
    ) {
      calls.push(args)
      return aggregate.apply(this, args as never) as AggregationCursor
    } as typeof aggregate)
    const explain = AggregationCursor.prototype.explain
    let tries = 0
    vi.spyOn(AggregationCursor.prototype, 'explain').mockImplementation(function (
      this: AggregationCursor,
      ...args
    ) {
      const verbosity = (args[0] as { verbosity?: unknown } | undefined)?.verbosity
      if (verbosity !== 'queryPlanner' && tries++ === 0)
        return Promise.reject(
          Object.assign(new Error('operation exceeded time limit'), { name: 'MongoServerError', code: 50 }),
        )
      return explain.apply(this, args)
    })
    const stages = [{ $match: { name: 'Ali' } }, { $project: { name: 1, email: 1 } }]
    const res = await as('viewer', true)('POST', `${USERS}/explain`, {
      kind: 'aggregate',
      stages,
      verbosity: 'executionStats',
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().incomplete).toMatchObject({ planOnly: true })
    expect(calls).toHaveLength(2)
    // What the gate let through, the same each time; the plan read first is the plan alone.
    for (const c of calls.slice(1)) expect(JSON.stringify(c)).toBe(JSON.stringify(calls[0]))
    expect(res.body).not.toContain(S)
    expect(res.body).not.toContain('Ali')
  })

  it('a partial explain hides MongoDB’s words from a restricted user (fourth review)', async () => {
    const { as } = await setup()
    vi.spyOn(FindCursor.prototype, 'explain').mockResolvedValue({
      queryPlanner: { winningPlan: { stage: 'COLLSCAN' } },
      executionStats: {
        executionSuccess: false,
        errorCode: 292,
        // A reason that starts with "$" is hidden too (hide keeps such strings, as field names).
        errorMessage: `$sort exceeded memory limit while sorting on a value starting ${S}`,
        nReturned: 0,
        executionTimeMillis: 1,
        totalKeysExamined: 0,
        totalDocsExamined: 1,
        executionStages: { stage: 'COLLSCAN', nReturned: 0, docsExamined: 1 },
      },
    })
    const res = await as('viewer', true)('POST', `${USERS}/explain`, {
      kind: 'find',
      filter: { name: 'Ali' },
      verbosity: 'executionStats',
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().incomplete).toMatchObject({ code: 292, message: '***' })
    expect(res.body).not.toContain(S)
    expect(res.body).not.toContain('sort exceeded')
  })

  it('an SBE plan’s slots and stages are hidden from a restricted user (fifth review)', async () => {
    const { as } = await setup()
    vi.spyOn(FindCursor.prototype, 'explain').mockResolvedValue({
      explainVersion: '2',
      queryPlanner: {
        winningPlan: {
          queryPlan: { stage: 'COLLSCAN', filter: { name: { $eq: 'Ali' } } },
          slotBasedPlan: {
            slots: `$$RESULT=s5 env: { s1 = "${S}", s2 = Nothing }`,
            stages: `[1] filter {(s4 == "${S}")} [1] scan s5 s6`,
          },
        },
      },
    })
    const res = await as('viewer', true)('POST', `${USERS}/explain`, {
      kind: 'find',
      filter: { name: 'Ali' },
      verbosity: 'queryPlanner',
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.body).not.toContain(S)
    expect(res.json().raw.queryPlanner.winningPlan.slotBasedPlan).toBe('***')
  })

  it('M4: the applied rules follow a view, and a preview says which output paths are hidden', async () => {
    const { as } = await setup()
    const user = as('viewer', true)
    const applied = await user('GET', '/personal-fields/applied?db=crm&coll=v1')
    expect(applied.json().patterns).toContainEqual(['email'])
    const preview = await as('editor', true)('POST', `${USERS}/aggregate/preview`, {
      stages: [{ $project: { c: '$customer' } }],
      sample: { mode: 'limit', size: 5 },
      perStage: 5,
    })
    expect(preview.json().masked).toContainEqual(['c', 'phone'])
    const full = await as('editor')('POST', `${USERS}/aggregate/preview`, {
      stages: [{ $project: { c: '$customer' } }],
      sample: { mode: 'limit', size: 5 },
      perStage: 5,
    })
    expect(full.json()).not.toHaveProperty('masked')
  })
})
