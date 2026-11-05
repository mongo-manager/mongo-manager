// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AggregationCursor, BSON, Collection, FindCursor, MongoClient, type Document } from 'mongodb'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConnectionSettingsSchema, type ExplainResult } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, teamHarness, type DataHarness } from './support/data'
import { H } from './helpers'

let mongo: TestMongo
beforeAll(async () => {
  // Test commands: a fail point stands for a time limit MongoDB itself reports.
  mongo = await startMongo({ args: ['--setParameter', 'enableTestCommands=1'] })
})
afterAll(async () => {
  await mongo?.stop()
})
const closers: Array<{ t: { close(): Promise<void> } }> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const h of closers.splice(0)) await h.t.close()
})

async function local(): Promise<DataHarness> {
  const h = await dataHarness(mongo)
  closers.push(h)
  return h
}

/** 3 000 documents {n, g, s}: s is not indexed. */
async function seed(h: { client(): Promise<MongoClient> }) {
  const db = `d${randomUUID().slice(0, 8)}`
  const client = await h.client()
  await client
    .db(db)
    .collection('items')
    .insertMany(Array.from({ length: 3000 }, (_, n) => ({ n, g: n % 7, s: `s${n % 50}` })))
  await client
    .db(db)
    .collection('other')
    .insertMany([{ k: 1 }, { k: 2 }])
  return { db, client, path: `/databases/${db}/collections/items/explain` }
}

const codes = (r: ExplainResult) => r.warnings.map((w) => w.code)

describe('explain (phase 2b spec §2.1)', () => {
  it('flags a collection scan with a suggestion, and not once the index exists', async () => {
    const h = await local()
    const { path, client, db } = await seed(h)
    const before = (await h.call('POST', path, { kind: 'find', filter: { s: 's3' } })).json() as ExplainResult
    expect(before.winning?.stage).toBe('COLLSCAN')
    expect(codes(before)).toContain('COLLSCAN')
    expect(before.suggestion).toEqual({ key: [['s', 1]], reason: { equality: ['s'], sort: [], range: [] } })
    expect(before.summary).toMatchObject({ nReturned: 60, totalDocsExamined: 3000 })
    await client.db(db).collection('items').createIndex({ s: 1 })
    const after = (await h.call('POST', path, { kind: 'find', filter: { s: 's3' } })).json() as ExplainResult
    expect(JSON.stringify(after.winning)).toContain('IXSCAN')
    expect(codes(after)).not.toContain('COLLSCAN')
    expect(after.suggestion).toBeNull()
  })

  it('flags a sort done in memory', async () => {
    const h = await local()
    const { path } = await seed(h)
    const res = (
      await h.call('POST', path, { kind: 'find', filter: { g: 1 }, sort: { n: -1 } })
    ).json() as ExplainResult
    expect(codes(res)).toContain('IN_MEMORY_SORT')
  })

  it('explains a pipeline, with the stages after the query', async () => {
    const h = await local()
    const { path } = await seed(h)
    const res = await h.call('POST', path, {
      kind: 'aggregate',
      stages: [{ $match: { g: 2 } }, { $group: { _id: '$s', c: { $sum: 1 } } }, { $sort: { c: -1 } }],
    })
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json() as ExplainResult
    expect(body.winning).not.toBeNull()
    expect(body.pipeline.map((s) => s.stage)).toContain('$sort')
  })

  it('flags a join on a field with no index, and not once it has one', async () => {
    const h = await local()
    const { path, client, db } = await seed(h)
    const stages = [
      { $limit: 5 },
      { $lookup: { from: 'other', localField: 'g', foreignField: 'k', as: 'o' } },
    ]
    const before = (await h.call('POST', path, { kind: 'aggregate', stages })).json() as ExplainResult
    expect(codes(before)).toContain('UNINDEXED_LOOKUP')
    await client.db(db).collection('other').createIndex({ k: 1 })
    const after = (await h.call('POST', path, { kind: 'aggregate', stages })).json() as ExplainResult
    expect(codes(after)).not.toContain('UNINDEXED_LOOKUP')
  })

  // W5 re-review: through mongos the join is in each shard's plan, not the merge's: still checked.
  it('flags a join pushed into a shard’s plan on a field with no index, and not once it has one', async () => {
    const h = await local()
    const { path, client, db } = await seed(h)
    const sharded = BSON.EJSON.parse(
      readFileSync(join(__dirname, 'fixtures', 'explain', 'hand', 'sharded-query.json'), 'utf8'),
      { relaxed: true },
    ) as { raw: Document }
    vi.spyOn(AggregationCursor.prototype, 'explain').mockResolvedValue(sharded.raw as never)
    const stages = [{ $lookup: { from: 'other', localField: 'g', foreignField: 'k', as: 'o' } }]
    const before = (await h.call('POST', path, { kind: 'aggregate', stages })).json() as ExplainResult
    expect(before.winning?.stage).toBe('SHARD_MERGE')
    expect(before.warnings).toContainEqual(
      expect.objectContaining({ code: 'UNINDEXED_LOOKUP', detail: { coll: 'other', field: 'k' } }),
    )
    await client.db(db).collection('other').createIndex({ k: 1 })
    const after = (await h.call('POST', path, { kind: 'aggregate', stages })).json() as ExplainResult
    expect(codes(after)).not.toContain('UNINDEXED_LOOKUP')
  })

  it('refuses to explain a pipeline that writes, and inspects the rest as the builder does', async () => {
    const h = await teamHarness(mongo)
    closers.push(h)
    const { path } = await seed(h)
    const editor = h.user('editor')
    const write = await editor.call('POST', path, { kind: 'aggregate', stages: [{ $out: 'x' }] })
    expect(write.statusCode).toBe(400)
    const lookup = await editor.call('POST', path, {
      kind: 'aggregate',
      stages: [{ $lookup: { from: 'system.users', as: 'u', pipeline: [] } }],
    })
    expect(lookup.statusCode).toBe(403)
    const js = await editor.call('POST', path, { kind: 'find', filter: { $where: 'true' } })
    expect(js.statusCode).toBe(400)
  })

  it('explains a query on a view (Review Focus 2)', async () => {
    const h = await local()
    const { client, db } = await seed(h)
    await client.db(db).createCollection('v', { viewOn: 'items', pipeline: [{ $match: { g: 1 } }] })
    const res = await h.call('POST', `/databases/${db}/collections/v/explain`, {
      kind: 'find',
      filter: { n: 5 },
    })
    expect(res.statusCode, res.body).toBe(200)
    expect((res.json() as ExplainResult).winning).not.toBeNull()
  })

  it('gives no execution numbers for the planner verbosity', async () => {
    const h = await local()
    const { path } = await seed(h)
    const res = (
      await h.call('POST', path, { kind: 'find', filter: { g: 1 }, verbosity: 'queryPlanner' })
    ).json()
    expect((res as ExplainResult).summary.nReturned).toBeUndefined()
  })

  it('tags the explain with the request comment', async () => {
    const h = await local()
    const { path } = await seed(h)
    const original = Collection.prototype.find
    const options: unknown[] = []
    vi.spyOn(Collection.prototype, 'find').mockImplementation(function (
      this: Collection,
      ...args: unknown[]
    ) {
      options.push(args[1])
      return original.apply(this, args as never) as FindCursor
    } as typeof original)
    await h.call('POST', path, { kind: 'find', filter: { g: 1 }, maxTimeMS: 5000 })
    // The time limit rides on the explain itself (a find option is ignored there): the live test
    // 'stops at its time limit' proves it (final review 2b, C1).
    expect(options[0]).toMatchObject({ comment: expect.stringMatching(/^mm:/) })
  })

  it('lets a viewer explain a query and a pipeline', async () => {
    const h = await teamHarness(mongo)
    closers.push(h)
    const { path } = await seed(h)
    const viewer = h.user('viewer')
    expect((await viewer.call('POST', path, { kind: 'find', filter: {} })).statusCode).toBe(200)
    expect(
      (await viewer.call('POST', path, { kind: 'aggregate', stages: [{ $match: {} }] })).statusCode,
    ).toBe(200)
  })

  it('reads a plan from every request shape this server answers (live capture, run on every CI version)', async () => {
    const h = await local()
    const { path, client, db } = await seed(h)
    await client.db(db).collection('items').createIndex({ g: 1, n: -1 })
    for (const body of [
      { kind: 'find', filter: { s: 's1' } },
      { kind: 'find', filter: { g: 3, n: { $gt: 10 } }, verbosity: 'allPlansExecution' },
      { kind: 'find', filter: { g: 3 }, sort: { n: -1 }, limit: 5 },
      { kind: 'find', filter: { _id: 1 } },
      { kind: 'aggregate', stages: [{ $match: { g: 2 } }, { $group: { _id: '$s', c: { $sum: 1 } } }] },
      { kind: 'aggregate', stages: [{ $match: { g: 1 } }, { $count: 'n' }] },
      { kind: 'aggregate', stages: [{ $sort: { n: 1 } }, { $limit: 3 }, { $project: { n: 1 } }] },
    ]) {
      const res = await h.call('POST', path, body)
      expect(res.statusCode, JSON.stringify(body)).toBe(200)
      expect((res.json() as ExplainResult).winning, JSON.stringify(body)).not.toBeNull()
    }
  })
})

describe('explain cost control (final review 2b, C1)', () => {
  async function slow(h: DataHarness, count = 40) {
    const db = `d${randomUUID().slice(0, 8)}`
    await (
      await h.client()
    )
      .db(db)
      .collection('items')
      .insertMany(Array.from({ length: count }, (_, n) => ({ n })))
    return `/databases/${db}/collections/items/explain`
  }

  it('stops at its time limit, and says the numbers are partial', async () => {
    const h = await dataHarness(mongo, { allowServerJs: true })
    closers.push(h)
    // CI 2026-10-21 (Windows): 40 documents (2 s in all) against a 1.5 s bound left a loaded runner
    // too little room (1.7 s). 200 take 10 s in all: stopped at 1 s, it is done well within 5 s.
    const path = await slow(h, 200)
    // CI 2026-10-21 (Windows, again): the limit can run out before the query runs (its JavaScript
    // engine started within it), and the server then says only that it ran out (504; mapped in
    // data-io.test). Started first, and given 1 s, so the limit stops the query itself.
    const warm = await h.call('POST', path, { kind: 'find', filter: { $where: 'true' }, limit: 1 })
    expect(warm.statusCode, warm.body).toBe(200)
    const started = Date.now()
    const res = await h.call('POST', path, {
      kind: 'find',
      filter: { $where: 'sleep(50) || true' },
      maxTimeMS: 1000,
    })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json() as ExplainResult
    expect(body.incomplete).toMatchObject({ code: 50 })
    expect(codes(body)).toContain('INCOMPLETE')
  })

  it('is killed when the client leaves', async () => {
    const h = await dataHarness(mongo, { allowServerJs: true })
    closers.push(h)
    const path = await slow(h)
    const kill = vi.fn(async () => 1)
    h.t.app.ctx.ops.kill = kill
    await h.t.app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = h.t.app.server.address() as { port: number }
    const controller = new AbortController()
    const pending = fetch(`http://127.0.0.1:${port}/api/connections/${h.connectionId}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': h.t.app.ctx.localCsrfToken,
        cookie: H.cookie,
        'x-mm-local': H['x-mm-local'],
      },
      body: JSON.stringify({ kind: 'find', filter: { $where: 'sleep(50) || true' }, maxTimeMS: 60_000 }),
      signal: controller.signal,
    }).catch(() => 'aborted')
    await new Promise((r) => setTimeout(r, 300))
    controller.abort()
    expect(await pending).toBe('aborted')
    await vi.waitFor(
      () => expect(kill).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/^mm:/)),
      {
        timeout: 3_000,
      },
    )
  })
})

const ranOut = () =>
  Object.assign(new Error('operation exceeded time limit'), {
    name: 'MongoServerError',
    code: 50,
    codeName: 'MaxTimeMSExpired',
  })

/** Each explain's verbosity and time limit; the first `fail` of them fail with `error`. */
function explains(
  proto: { explain: (...a: never[]) => Promise<Document> },
  fail = 1,
  error: () => Error = ranOut,
) {
  const seen: Array<{ verbosity: unknown; maxTimeMS?: unknown; timeoutMS?: unknown }> = []
  const original = proto.explain
  vi.spyOn(proto, 'explain').mockImplementation(function (this: unknown, ...args: unknown[]) {
    const opts = args[0] as { verbosity?: unknown; maxTimeMS?: unknown }
    const timeout = args[1] as { timeoutMS?: unknown } | undefined
    seen.push({
      verbosity: opts?.verbosity,
      ...(opts?.maxTimeMS !== undefined ? { maxTimeMS: opts.maxTimeMS } : {}),
      ...(timeout?.timeoutMS !== undefined ? { timeoutMS: timeout.timeoutMS } : {}),
    })
    if (seen.length <= fail) return Promise.reject(error())
    return original.apply(this, args as never)
  } as never)
  return seen
}

describe('a plan when the run ran out of time (CI 2026-10-21 review idea)', () => {
  it('shows the plan alone, marked as such, when a query runs out of time before it gives one', async () => {
    const h = await local()
    const { path, client, db } = await seed(h)
    await client.db(db).collection('items').createIndex({ g: 1 })
    const seen = explains(FindCursor.prototype as never)
    const res = await h.call('POST', path, { kind: 'find', filter: { g: 3 }, maxTimeMS: 1500 })
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json() as ExplainResult
    expect(seen).toEqual([
      { verbosity: 'executionStats', maxTimeMS: 1500 },
      { verbosity: 'queryPlanner', maxTimeMS: 1500 },
    ])
    expect(JSON.stringify(body.winning)).toContain('IXSCAN')
    expect(body.summary.nReturned).toBeUndefined()
    expect(body.incomplete).toEqual({
      code: 50,
      message: 'The operation exceeded its time limit (maxTimeMS)',
      planOnly: true,
    })
    expect(body.warnings).toContainEqual({ code: 'INCOMPLETE', detail: body.incomplete })
  })

  it('gives the plan a short limit of its own: planning that takes longer was the trouble', async () => {
    const h = await local()
    const { path } = await seed(h)
    const seen = explains(FindCursor.prototype as never)
    const res = await h.call('POST', path, { kind: 'find', filter: { g: 3 }, maxTimeMS: 60_000 })
    expect(res.statusCode, res.body).toBe(200)
    expect(seen).toEqual([
      { verbosity: 'executionStats', maxTimeMS: 60_000 },
      { verbosity: 'queryPlanner', maxTimeMS: 5_000 },
    ])
  })

  it('still names a collection scan, and the index for it, without a count', async () => {
    const h = await local()
    const { path } = await seed(h)
    explains(FindCursor.prototype as never)
    const body = (await h.call('POST', path, { kind: 'find', filter: { s: 's3' } })).json() as ExplainResult
    expect(body.incomplete).toMatchObject({ planOnly: true })
    expect(body.warnings).toContainEqual({ code: 'COLLSCAN', stage: 'COLLSCAN', detail: { uncounted: true } })
    expect(body.suggestion).toEqual({ key: [['s', 1]], reason: { equality: ['s'], sort: [], range: [] } })
  })

  it('names a collection scan without a count when only the plan was asked for, as after a timeout', async () => {
    const h = await local()
    const { path } = await seed(h)
    const res = await h.call('POST', path, { kind: 'find', filter: { s: 's3' }, verbosity: 'queryPlanner' })
    const body = res.json() as ExplainResult
    expect(body.incomplete).toBeUndefined()
    expect(body.warnings).toContainEqual({ code: 'COLLSCAN', stage: 'COLLSCAN', detail: { uncounted: true } })
    expect(body.suggestion).toMatchObject({ key: [['s', 1]] })
  })

  it('names no scan without a count when nothing filters it (the whole collection is asked for)', async () => {
    const h = await local()
    const { path } = await seed(h)
    const body = (
      await h.call('POST', path, { kind: 'find', filter: {}, verbosity: 'queryPlanner' })
    ).json() as ExplainResult
    expect(body.warnings.map((w) => w.code)).not.toContain('COLLSCAN')
  })

  it('asks nothing more when the time ran out reaching the server', async () => {
    const h = await local()
    const { path } = await seed(h)
    const seen = explains(FindCursor.prototype as never, 1, () =>
      Object.assign(new Error('Timed out during server selection'), {
        name: 'MongoOperationTimeoutError',
        cause: Object.assign(new Error('Server selection timed out'), { name: 'MongoServerSelectionError' }),
      }),
    )
    const res = await h.call('POST', path, { kind: 'find', filter: { g: 3 } })
    expect([res.statusCode, res.json().details]).toEqual([502, { kind: 'network' }])
    expect(seen).toHaveLength(1)
  })

  it('does the same for a pipeline, with the same stages and options', async () => {
    const h = await local()
    const { path } = await seed(h)
    const calls: unknown[][] = []
    const aggregate = Collection.prototype.aggregate
    vi.spyOn(Collection.prototype, 'aggregate').mockImplementation(function (
      this: Collection,
      ...args: unknown[]
    ) {
      calls.push(args)
      return aggregate.apply(this, args as never) as AggregationCursor
    } as typeof aggregate)
    const seen = explains(AggregationCursor.prototype as never)
    const pipeline = [{ $match: { g: 2 } }, { $group: { _id: '$s', c: { $sum: 1 } } }]
    const res = await h.call('POST', path, {
      kind: 'aggregate',
      stages: pipeline,
      verbosity: 'allPlansExecution',
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(seen.map((s) => s.verbosity)).toEqual(['allPlansExecution', 'queryPlanner'])
    expect(calls).toHaveLength(2)
    expect(JSON.stringify(calls[0]![0])).toBe(JSON.stringify(pipeline))
    expect(JSON.stringify(calls[1])).toBe(JSON.stringify(calls[0]))
    // The request's comment rides on both, so the retry is killed with it when the client leaves.
    expect(calls[1]![1]).toMatchObject({ comment: expect.stringMatching(/^mm:/), allowDiskUse: true })
    const body = res.json() as ExplainResult
    expect(body.incomplete).toMatchObject({ code: 50, planOnly: true })
    expect(JSON.stringify(body.winning)).toContain('COLLSCAN')
  })

  it('answers the time limit as before when only the plan was asked for', async () => {
    const h = await local()
    const { path } = await seed(h)
    const seen = explains(FindCursor.prototype as never)
    const res = await h.call('POST', path, { kind: 'find', filter: { g: 3 }, verbosity: 'queryPlanner' })
    expect(res.statusCode).toBe(504)
    expect(res.json().details).toMatchObject({ code: 50 })
    expect(seen).toHaveLength(1)
  })

  it('answers the time limit as before when the plan runs out of time too', async () => {
    const h = await local()
    const { path } = await seed(h)
    const seen = explains(FindCursor.prototype as never, 2)
    const res = await h.call('POST', path, { kind: 'find', filter: { g: 3 } })
    expect(res.statusCode).toBe(504)
    expect(res.json().details).toMatchObject({ code: 50, codeName: 'MaxTimeMSExpired' })
    expect(seen).toHaveLength(2)
  })

  it('answers the first failure, not the plan’s, when the plan fails otherwise', async () => {
    const h = await local()
    const { path } = await seed(h)
    let calls = 0
    const original = FindCursor.prototype.explain
    vi.spyOn(FindCursor.prototype, 'explain').mockImplementation(function (this: FindCursor, ...args) {
      calls += 1
      if (calls === 1) return Promise.reject(ranOut())
      if (calls === 2)
        return Promise.reject(
          Object.assign(new Error('not authorized'), { name: 'MongoServerError', code: 13 }),
        )
      return original.apply(this, args as never)
    })
    const res = await h.call('POST', path, { kind: 'find', filter: { g: 3 } })
    expect(res.statusCode).toBe(504)
    expect(calls).toBe(2)
  })

  it('tries nothing more for any other failure', async () => {
    const h = await local()
    const { path } = await seed(h)
    const seen = explains(FindCursor.prototype as never, 1, () =>
      Object.assign(new Error('bad'), { name: 'MongoServerError', code: 2, codeName: 'BadValue' }),
    )
    const res = await h.call('POST', path, { kind: 'find', filter: { g: 3 } })
    expect(res.statusCode).toBe(400)
    expect(seen).toHaveLength(1)
  })

  afterEach(async () => {
    const admin = new MongoClient(`mongodb://127.0.0.1:${mongo.port}`)
    try {
      await admin.db('admin').command({ configureFailPoint: 'failCommand', mode: 'off' })
    } finally {
      await admin.close()
    }
  })

  it('reads the time limit as MongoDB itself sends it (a fail point, through the real driver)', async () => {
    const h = await local()
    const { path } = await seed(h)
    const admin = (await h.client()).db('admin')
    await admin.command({
      configureFailPoint: 'failCommand',
      mode: { times: 1 },
      data: { failCommands: ['explain'], errorCode: 50 },
    })
    try {
      const res = await h.call('POST', path, { kind: 'find', filter: { g: 3 } })
      expect(res.statusCode, res.body).toBe(200)
      expect((res.json() as ExplainResult).incomplete).toMatchObject({ code: 50, planOnly: true })
    } finally {
      await admin.command({ configureFailPoint: 'failCommand', mode: 'off' })
    }
  })

  it('tries nothing more once the client has left', async () => {
    const h = await dataHarness(mongo)
    closers.push(h)
    const { path } = await seed(h)
    let calls = 0
    let left!: () => void
    const gone = new Promise<void>((r) => (left = r))
    vi.spyOn(FindCursor.prototype, 'explain').mockImplementation(async function () {
      calls += 1
      await gone
      throw ranOut()
    })
    // Called once the response is closed, after it is marked destroyed: the server has seen it.
    const kill = vi.fn(async () => 0)
    h.t.app.ctx.ops.kill = kill
    await h.t.app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = h.t.app.server.address() as { port: number }
    const controller = new AbortController()
    const pending = fetch(`http://127.0.0.1:${port}/api/connections/${h.connectionId}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': h.t.app.ctx.localCsrfToken,
        cookie: H.cookie,
        'x-mm-local': H['x-mm-local'],
      },
      body: JSON.stringify({ kind: 'find', filter: { g: 3 } }),
      signal: controller.signal,
    }).catch(() => 'aborted')
    await vi.waitFor(() => expect(calls).toBe(1), { timeout: 5_000 })
    controller.abort()
    expect(await pending).toBe('aborted')
    await vi.waitFor(() => expect(kill).toHaveBeenCalled(), { timeout: 5_000 })
    left()
    await new Promise((r) => setTimeout(r, 300))
    expect(calls).toBe(1)
  })
})

describe('explain on a stored connection that still holds timeoutMS (third review)', () => {
  it('explains with its own limit: the driver is given no timeoutMS', async () => {
    const h = await local()
    const { path } = await seed(h)
    const settings = ConnectionSettingsSchema.parse({
      hosts: [{ host: '127.0.0.1', port: mongo.port }],
      serverSelectionTimeoutMS: 3_000,
    })
    const { id } = h.t.app.ctx.connections.create(
      {
        name: 'Old',
        favorite: false,
        readOnly: false,
        settings: { ...settings, options: { timeoutMS: '20000' } as never },
      },
      null,
    )
    const seen = explains(FindCursor.prototype as never, 0)
    const res = await h.t.app.inject({
      method: 'POST',
      url: `/api/connections/${id}${path}`,
      headers: { ...H, 'x-csrf-token': h.t.app.ctx.localCsrfToken },
      payload: { kind: 'find', filter: { g: 3 }, maxTimeMS: 1500 },
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(seen).toEqual([{ verbosity: 'executionStats', maxTimeMS: 1500 }])
  })
})
