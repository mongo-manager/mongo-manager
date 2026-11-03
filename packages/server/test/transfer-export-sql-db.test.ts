import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { gunzipSync } from 'node:zlib'
import { Collection, MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness as baseDataHarness, teamHarness as baseTeamHarness } from './support/data'
import { runSqlPlugin } from './support/sql-plugin'

// User request 2026-11-02: SQL import and export come with the SQL → MongoDB plugin, on here as an
// administrator would have turned it on.
const dataHarness: typeof baseDataHarness = async (...args) => {
  const h = await baseDataHarness(...args)
  runSqlPlugin(h.t.app)
  return h
}
const teamHarness: typeof baseTeamHarness = async (...args) => {
  const h = await baseTeamHarness(...args)
  runSqlPlugin(h.t.app)
  return h
}
import { restrictedApp } from './support/restricted'

/** A restricted app with the SQL → MongoDB plugin on, so its SQL routes test the masking (2026-11-02). */
const restrictedSql: typeof restrictedApp = async (...args) => {
  const r = await restrictedApp(...args)
  runSqlPlugin(r.t.app)
  return r
}
import { waitJob } from './support/jobs'
import { exportKind } from '../src/transfer/export-job'
import { listCollectionNames } from '../src/routes/data/transfer'
import type { JobContext } from '../src/jobs/types'
import { slow } from './support/slowness'

// User request 2026-10-11: the SQL ↔ MongoDB page exports the collections chosen of a database
// as one SQL file — each its CREATE TABLE and INSERTs — as any export is: rights, masking, quota.
let mongo: TestMongo
let client: MongoClient
beforeAll(async () => {
  mongo = await startMongo()
  client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
}, slow(120_000))
afterAll(async () => {
  await client?.close()
  await mongo?.stop()
})
beforeEach(async () => {
  await client.db('exp').dropDatabase()
  const db = client.db('exp')
  await db.collection('items').insertMany([
    { _id: 1 as never, name: 'pen' },
    { _id: 2 as never, name: 'ink' },
  ])
  await db.collection('people').insertOne({ _id: 1 as never, name: 'Ali' })
  await db.collection('other').insertOne({ _id: 1 as never, secret: 'not chosen' })
  await db.createCollection('cheap', { viewOn: 'items', pipeline: [{ $match: { name: 'ink' } }] })
})

const PATH = '/databases/exp/export-sql'
/** Collections of the database "exp", with options. */
const body = (collections: string[], extra: Record<string, unknown> = {}) => ({
  collections,
  ...extra,
})

describe('exporting a database’s collections as one SQL file', () => {
  it('writes every chosen collection, and only those, into one file named after the database', async () => {
    const h = await dataHarness(mongo)
    try {
      const res = await h.call('POST', PATH, body(['items', 'people', 'cheap']))
      expect(res.statusCode).toBe(202)
      const job = await waitJob(h.t, res.json().job.id)
      expect(job.state).toBe('done')
      const file = await h.get(`/api/transfer/files/${job.id}`)
      expect(file.headers['content-type']).toBe('application/sql; charset=utf-8')
      expect(file.headers['content-disposition']).toMatch(/^attachment; filename="exp-.*\.sql"/)
      for (const table of ['items', 'people', 'cheap']) {
        expect(file.body).toContain(`CREATE TABLE "${table}" (`)
        expect(file.body).toContain(`INSERT INTO "${table}"`)
      }
      expect(file.body).not.toContain('not chosen')
      expect(file.body).not.toContain('"other"')
      const report = (await h.get(`/api/transfer/jobs/${job.id}/report`)).json()
      expect(report).toMatchObject({ kind: 'export', written: 4, masked: false })
    } finally {
      await h.t.close()
    }
  })

  it('writes for the dialect chosen, gzipped when asked', async () => {
    const h = await dataHarness(mongo)
    try {
      const res = await h.call(
        'POST',
        PATH,
        body(['items'], { sql: { dialect: 'mysql', rowsPerInsert: 1, transaction: false }, gzip: true }),
      )
      // Its name says what it is: the page offers the download under it (review minor 8).
      expect(res.json().job.target).toMatch(/^exp-\d{8}-\d{6}\.sql\.gz$/)
      const job = await waitJob(h.t, res.json().job.id)
      const file = await h.get(`/api/transfer/files/${job.id}`)
      expect(file.headers['content-type']).toBe('application/gzip')
      expect(file.headers['content-disposition']).toMatch(/\.sql\.gz"?$/)
      const text = gunzipSync(file.rawPayload).toString()
      expect(text).toContain('CREATE TABLE `items` (')
      expect(text.match(/INSERT INTO `items`/g)).toHaveLength(2)
      expect(text).not.toMatch(/^BEGIN/m)
      expect(text).not.toContain('START TRANSACTION')
      // One database (user request 2026-10-12): no database of its own written into the file.
      expect(text).not.toContain('CREATE DATABASE')
      expect(text).not.toMatch(/^USE /m)
    } finally {
      await h.t.close()
    }
  })

  // User request 2026-10-12: nested values in LONGTEXT for older tools, when asked; JSON otherwise.
  it('writes nested values in LONGTEXT for older tools when asked', async () => {
    await client.db('exp').collection('nested').deleteMany({})
    await client
      .db('exp')
      .collection('nested')
      .insertOne({ _id: 1 as never, tags: ['a', 'b'] })
    const h = await dataHarness(mongo)
    try {
      const file = async (jsonAsText: boolean) => {
        const res = await h.call(
          'POST',
          PATH,
          body(['nested'], { sql: { dialect: 'mysql', rowsPerInsert: 100, transaction: true, jsonAsText } }),
        )
        const job = await waitJob(h.t, res.json().job.id)
        return (await h.get(`/api/transfer/files/${job.id}`)).body
      }
      expect(await file(true)).toMatch(/`tags` LONGTEXT/)
      expect(await file(false)).toMatch(/`tags` JSON/)
    } finally {
      await h.t.close()
      await client.db('exp').collection('nested').drop()
    }
  }, 60_000)

  it('refuses no collection, too many, the same twice, one that is not there, a system one', async () => {
    const h = await dataHarness(mongo)
    try {
      for (const collections of [[], ['items', 'items'], Array.from({ length: 501 }, (_, i) => `c${i}`)]) {
        const res = await h.call('POST', PATH, { collections })
        expect(res.statusCode, JSON.stringify(collections).slice(0, 40)).toBe(400)
      }
      expect((await h.call('POST', PATH, body(['nope']))).statusCode).toBe(404)
      expect((await h.call('POST', PATH, body(['system.views']))).statusCode).toBe(400)
      expect((await h.call('POST', PATH, body(['items'], { extra: 1 }))).statusCode).toBe(400)
    } finally {
      await h.t.close()
    }
  })

  it('needs the export right', async () => {
    const h = await teamHarness(mongo)
    try {
      const viewer = h.user('viewer')
      expect((await viewer.call('POST', PATH, body(['items']))).statusCode).toBe(403)
      expect((await h.user('editor').call('POST', PATH, body(['items']))).statusCode).toBe(202)
    } finally {
      await h.t.close()
    }
  })

  it('masks for a restricted user as any export: *** and never the value', async () => {
    const S = 'S3NT1N3L'
    await client
      .db('exp')
      .collection('people')
      .insertOne({ _id: 2 as never, name: 'Bea', email: `${S}@x` })
    const { t, as } = await restrictedSql(mongo, [{ db: 'exp', coll: 'people', field: 'email' }])
    try {
      const user = as('editor', true)
      const res = await user('POST', PATH, body(['people', 'items']))
      expect(res.statusCode).toBe(202)
      const job = await waitJob(t, res.json().job.id)
      expect(job.state).toBe('done')
      const file = await user.get(`/api/transfer/files/${job.id}`)
      expect(file.body).not.toContain(S)
      expect(file.body).toContain('***')
      expect(file.body).toContain('INSERT INTO "items"')
      expect((await user.get(`/api/transfer/jobs/${job.id}/report`)).json()).toMatchObject({ masked: true })
    } finally {
      await t.close()
    }
  })

  // Review 2026-10-11 (second, I1): a restricted user's gate reads at most 100 views per lookup set;
  // each collection has its own, so a whole-connection export is not refused as "too complex".
  it('exports more than 100 collections for a restricted user', async () => {
    const db = client.db('many')
    const names = Array.from({ length: 120 }, (_, i) => `c${String(i).padStart(3, '0')}`)
    for (const n of names) await db.collection(n).insertOne({ _id: 1 as never, v: n })
    const { t, as } = await restrictedSql(mongo, [{ db: 'exp', coll: 'people', field: 'email' }])
    try {
      const res = await as('editor', true)('POST', '/databases/many/export-sql', {
        collections: names,
      })
      expect(res.statusCode).toBe(202)
      const job = await waitJob(t, res.json().job.id)
      expect(job.state).toBe('done')
    } finally {
      await t.close()
      await db.dropDatabase()
    }
  })

  // Review 2026-10-11 (I1): two collections never become one table — SQLite and MySQL compare
  // names without case; a renamed table is said in the report.
  it('gives each collection a table of its own name, renamed when two would clash', async () => {
    await client
      .db('exp')
      .collection('Items')
      .insertOne({ _id: 9 as never, name: 'cap' })
    const h = await dataHarness(mongo)
    try {
      const res = await h.call(
        'POST',
        PATH,
        body(['items', 'Items'], { sql: { dialect: 'sqlite', rowsPerInsert: 100, transaction: true } }),
      )
      const job = await waitJob(h.t, res.json().job.id)
      const file = (await h.get(`/api/transfer/files/${job.id}`)).body
      expect(file).toContain('CREATE TABLE "items" (')
      expect(file).toContain('CREATE TABLE "Items_2" (')
      const report = (await h.get(`/api/transfer/jobs/${job.id}/report`)).json()
      expect(report.tables).toEqual([
        { database: 'exp', collection: 'items', table: 'items', written: 2, omittedFields: [], cutCells: 0 },
        {
          database: 'exp',
          collection: 'Items',
          table: 'Items_2',
          written: 1,
          omittedFields: [],
          cutCells: 0,
        },
      ])
      // PostgreSQL tells them apart: no rename.
      const pg = await h.call('POST', PATH, body(['items', 'Items']))
      const pgJob = await waitJob(h.t, pg.json().job.id)
      const pgReport = (await h.get(`/api/transfer/jobs/${pgJob.id}/report`)).json()
      expect(pgReport.tables.map((t: { table: string }) => t.table)).toEqual(['items', 'Items'])
    } finally {
      await h.t.close()
    }
  }, 60_000)

  // Review 2026-10-11 (I2): what each table left out is said for that table.
  it('reports per table the fields a later document held that its table has no column for', async () => {
    const people = client.db('exp').collection('people')
    for (let i = 2; i < 1100; i++) await people.insertOne({ _id: i as never, name: `p${i}` })
    await people.insertOne({ _id: 5000 as never, name: 'late', nickname: 'only here' })
    const h = await dataHarness(mongo)
    try {
      const res = await h.call('POST', PATH, body(['items', 'people']))
      const job = await waitJob(h.t, res.json().job.id)
      const report = (await h.get(`/api/transfer/jobs/${job.id}/report`)).json()
      const byName = Object.fromEntries(
        (report.tables as Array<{ collection: string; omittedFields: string[] }>).map((t) => [
          t.collection,
          t.omittedFields,
        ]),
      )
      expect(byName.items).toEqual([])
      expect(byName.people).toContain('nickname')
    } finally {
      await h.t.close()
    }
  })

  it('accepts 500 collections, and audits at most 100 of their names with the count', async () => {
    const h = await dataHarness(mongo)
    try {
      const db = client.db('exp')
      const many = Array.from({ length: 499 }, (_, i) => `c${String(i).padStart(3, '0')}`)
      // Created 25 at a time: 499 one after another took most of the time on a loaded machine.
      for (let i = 0; i < many.length; i += 25)
        await Promise.all(many.slice(i, i + 25).map((name) => db.createCollection(name)))
      const res = await h.call('POST', PATH, body(['items', ...many]))
      expect(res.statusCode).toBe(202)
      // Review of the limits (important 3): its own bound, as long as its limit allows.
      await waitJob(h.t, res.json().job.id, 45_000)
      const audit = h.t.app.ctx.audit.list({ limit: 50 }).find((r) => r.action === 'transfer.export')!
      const details = audit.details as { collections: string[]; collectionCount: number }
      expect(details.collectionCount).toBe(500)
      expect(details.collections).toHaveLength(100)
    } finally {
      await h.t.close()
    }
    // A real export of 500 collections: more than the default 20 s on a loaded CI runner.
  }, 60_000)

  // Review 2026-10-11 (I3): a MongoDB user allowed some collections only may list their names.
  it('lists names as a user limited to some collections can', async () => {
    const calls: unknown[] = []
    const db = {
      listCollections: (_filter: unknown, options: unknown) => {
        calls.push(options)
        return {
          toArray: async () => {
            if (!(options as { authorizedCollections?: boolean }).authorizedCollections)
              throw Object.assign(new Error('not authorized'), { code: 13 })
            return [{ name: 'orders' }]
          },
        }
      },
    }
    expect(await listCollectionNames(db as never)).toEqual(['orders'])
    expect(calls).toEqual([{ nameOnly: true }, { nameOnly: true, authorizedCollections: true }])
  })

  // Review 2026-10-11 (minor 13): a cancel is seen before the next collection, its file never kept.
  it('opens no query for the next collection once cancelled, and keeps no file', async () => {
    const h = await dataHarness(mongo)
    const abort = new AbortController()
    // The first collection's query cancels the job: the second's is never opened.
    const original = Collection.prototype.find
    let finds = 0
    vi.spyOn(Collection.prototype, 'find').mockImplementation(function (this: Collection, ...args) {
      finds++
      if (finds === 1) abort.abort()
      return original.apply(this, args as never)
    })
    try {
      const kind = exportKind({ client: async () => client, ctx: () => h.t.app.ctx })
      const plan = { kind: 'find' as const, filter: {}, options: {}, finish: null, output: null }
      const ctx = {
        id: 'cancel-1',
        signal: abort.signal,
        comment: 'mm-job:cancel-1',
        target: { userId: null, connectionId: 'c', db: 'exp', coll: '*', target: 'exp.sql' },
        progress() {},
        setStaging() {},
        setEstimate() {},
        setParts() {},
      } as JobContext
      await kind.run(ctx, {
        owner: 'local',
        request: {
          source: { kind: 'collection' },
          format: 'sql',
          gzip: false,
          csv: {},
          json: {},
          sql: { dialect: 'postgres', rowsPerInsert: 100, transaction: true },
        } as never,
        plan,
        parts: [
          { db: 'exp', coll: 'items', table: 'items', plan },
          { db: 'exp', coll: 'people', table: 'people', plan },
        ],
        masked: false,
        rulesVersion: 0,
        name: 'exp-cancel',
      })
      expect(finds).toBe(1)
      expect(h.t.app.ctx.transfer.files.byJob('local', 'cancel-1', 'export')).toBeUndefined()
    } finally {
      vi.restoreAllMocks()
      await h.t.close()
    }
  })

  // Review 2026-10-11 (second): a time-series collection is listed on the page; it exports too.
  it('exports a time-series collection', async () => {
    const db = client.db('exp_ts')
    await db.dropDatabase()
    await db.createCollection('ticks', { timeseries: { timeField: 't', metaField: 'm' } })
    await db.collection('ticks').insertOne({ t: new Date(0), m: 'a', v: 1 })
    const h = await dataHarness(mongo)
    try {
      const res = await h.call('POST', '/databases/exp_ts/export-sql', { collections: ['ticks'] })
      expect(res.statusCode).toBe(202)
      const job = await waitJob(h.t, res.json().job.id)
      expect(job.state).toBe('done')
      const text = (await h.get(`/api/transfer/files/${job.id}`)).body
      expect(text).toContain('CREATE TABLE "ticks" (')
      expect(text).toContain('INSERT INTO "ticks"')
    } finally {
      await h.t.close()
      await db.dropDatabase()
    }
  })

  // Review 2026-10-11 (second, minor 9): the counts before writing stop on a cancel too.
  it('counts no further collection once cancelled', async () => {
    const h = await dataHarness(mongo)
    const abort = new AbortController()
    const original = Collection.prototype.estimatedDocumentCount
    let counts = 0
    vi.spyOn(Collection.prototype, 'estimatedDocumentCount').mockImplementation(function (
      this: Collection,
      ...args
    ) {
      counts++
      if (counts === 1) abort.abort()
      return original.apply(this, args as never)
    })
    const finds = vi.spyOn(Collection.prototype, 'find')
    try {
      const kind = exportKind({ client: async () => client, ctx: () => h.t.app.ctx })
      const plan = { kind: 'find' as const, filter: {}, options: {}, finish: null, output: null }
      const ctx = {
        id: 'cancel-2',
        signal: abort.signal,
        comment: 'mm-job:cancel-2',
        target: { userId: null, connectionId: 'c', db: 'exp', coll: '*', target: 'exp.sql' },
        progress() {},
        setStaging() {},
        setEstimate() {},
        setParts() {},
      } as JobContext
      await kind.run(ctx, {
        owner: 'local',
        request: {
          source: { kind: 'collection' },
          format: 'sql',
          gzip: false,
          csv: {},
          json: {},
          sql: { dialect: 'postgres', rowsPerInsert: 100, transaction: true },
        } as never,
        plan,
        parts: [
          { db: 'exp', coll: 'items', table: 'items', plan },
          { db: 'exp', coll: 'people', table: 'people', plan },
        ],
        masked: false,
        rulesVersion: 0,
        name: 'exp-cancel-2',
      })
      expect(counts).toBe(1)
      expect(finds).not.toHaveBeenCalled()
      expect(h.t.app.ctx.transfer.files.byJob('local', 'cancel-2', 'export')).toBeUndefined()
    } finally {
      vi.restoreAllMocks()
      await h.t.close()
    }
  })

  // User request 2026-10-12: one database at a time, as the page offers — never several, never a
  // system one; the database is the address's (as the import's), so every audit names it.
  it('exports one database only: refuses several, a system one, or another named in the body', async () => {
    const h = await dataHarness(mongo)
    try {
      for (const db of ['admin', 'local', 'config'])
        expect((await h.call('POST', `/databases/${db}/export-sql`, { collections: ['x'] })).statusCode).toBe(
          400,
        )
      expect((await h.call('POST', '/databases/*/export-sql', { collections: ['items'] })).statusCode).toBe(
        400,
      )
      const extra = (payload: object) => h.call('POST', PATH, { collections: ['items'], ...payload })
      expect((await extra({ db: 'exp2' })).statusCode).toBe(400)
      expect((await extra({ databases: [{ name: 'exp2', collections: ['items'] }] })).statusCode).toBe(400)
      expect((await extra({})).statusCode).toBe(202)
    } finally {
      await h.t.close()
    }
  })

  // Review 2026-10-12 (I2): the start's audit names the database, a refused start's too.
  it('audits the database it exports, and the one a refused export asked for', async () => {
    const h = await dataHarness(mongo)
    try {
      await h.call('POST', PATH, body(['items']))
      await h.call('POST', PATH, body(['nope']))
      const starts = h.t.app.ctx.audit
        .list({ limit: 50 })
        .filter((r) => r.action === 'transfer.exportSql.start')
      expect(starts.map((r) => [r.namespace, r.outcome])).toEqual(
        expect.arrayContaining([
          ['exp', 'success'],
          ['exp', expect.not.stringMatching(/^success$/)],
        ]),
      )
    } finally {
      await h.t.close()
    }
  })
})
