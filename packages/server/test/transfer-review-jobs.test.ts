import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { Collection, DBRef, MongoClient, ObjectId } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, teamHarness } from './support/data'
import { restrictedApp } from './support/restricted'
import { waitJob } from './support/jobs'
import { rawZip } from './support/hostile'
import { importKind } from '../src/transfer/import-job'
import { exportKind } from '../src/transfer/export-job'
import type { JobContext, JobKind } from '../src/jobs/types'
import { slow } from './support/slowness'

/** Phase 3d-1 final review: the jobs and routes, each finding pinned by a test. */
const S = 'S3NT1N3L'
const RULES = [{ db: 'crm', coll: 'users', field: 'customer.phone' }]
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
  await client.db('crm').dropDatabase()
  await client.db('imp').dropDatabase()
})
afterEach(() => {
  vi.restoreAllMocks()
})

const map = (source: string, path: string, type = 'string', extra: object = {}) => ({
  source,
  path,
  type,
  include: true,
  empty: 'skip',
  onError: 'error',
  ...extra,
})
const PEOPLE = '/databases/imp/collections/people'
const people = () => client.db('imp').collection('people')

describe('final review, exports (phase 3d-1)', () => {
  it('C1: a restricted export masks inside a DBRef and keeps BSON values whole', async () => {
    const oid = new ObjectId()
    await client
      .db('crm')
      .collection('users')
      .insertMany([
        {
          _id: 3 as never,
          name: 'Cem',
          customer: new DBRef('accounts', 7 as never, undefined, { phone: S }),
        },
        { _id: 4 as never, name: 'Dan', customer: oid },
      ])
    const { t, as } = await restrictedApp(mongo, RULES)
    try {
      const user = as('editor', true)
      const res = await user('POST', '/databases/crm/collections/users/export', {
        source: { kind: 'collection' },
        format: 'json',
      })
      const job = await waitJob(t, res.json().job.id)
      expect(job.state).toBe('done')
      const text = (await user.get(`/api/transfer/files/${job.id}`)).body
      expect(text).not.toContain(S)
      expect(text).toContain('"$ref"')
      expect(text).toContain('***')
      expect(JSON.parse(text)[1].customer).toEqual({ $oid: oid.toHexString() })
    } finally {
      await t.close()
    }
  })

  it('I1: an export pipeline gets the aggregation checks (credential collections, refused stages)', async () => {
    const { t, as } = await restrictedApp(mongo, RULES)
    try {
      const user = as('editor', false)
      const exp = (stages: object[]) =>
        user('POST', '/databases/crm/collections/users/export', {
          source: { kind: 'pipeline', stages },
          format: 'json',
        })
      const lookup = await exp([
        { $lookup: { from: { db: 'admin', coll: 'system.users' }, pipeline: [], as: 'x' } },
      ])
      expect(lookup.statusCode).toBe(403)
      expect((await exp([{ $currentOp: {} }])).statusCode).toBe(400)
    } finally {
      await t.close()
    }
  })

  it('I8: exports and imports are cancelled by killing their operation, and run with a time limit', async () => {
    const fake = {} as MongoClient
    const kill = vi.fn(async () => 1)
    const ctx = {
      id: 'j1',
      signal: new AbortController().signal,
      comment: 'mm-job:j1',
      target: { userId: null, connectionId: 'c', db: 'd', coll: 'x', target: 't' },
      progress() {},
      setStaging() {},
      setEstimate() {},
      setParts() {},
    } as JobContext
    const kinds: Array<JobKind<never>> = [
      importKind({ client: async () => fake, ctx: () => null as never, kill }) as JobKind<never>,
      exportKind({ client: async () => fake, ctx: () => null as never, kill }) as JobKind<never>,
    ]
    for (const kind of kinds) expect(await kind.cancel(ctx, undefined as never)).toBe(true)
    expect(kill.mock.calls).toEqual([
      [fake, 'mm-job:j1'],
      [fake, 'mm-job:j1'],
    ])

    const h = await dataHarness(mongo)
    try {
      await people().insertMany([{ a: 1 }, { a: 2 }])
      const find = vi.spyOn(Collection.prototype, 'find')
      const aggregate = vi.spyOn(Collection.prototype, 'aggregate')
      const bulk = vi.spyOn(Collection.prototype, 'bulkWrite')
      for (const source of [{ kind: 'collection' }, { kind: 'pipeline', stages: [{ $match: {} }] }]) {
        const res = await h.call('POST', `${PEOPLE}/export`, { source, format: 'json' })
        expect((await waitJob(h.t, res.json().job.id)).state).toBe('done')
      }
      const up = await h.raw('PUT', '/transfer/uploads', Buffer.from('{"a":3}\n'))
      const imp = await h.call('POST', `${PEOPLE}/import`, {
        uploadId: up.json().uploadId,
        format: 'ndjson',
        mode: 'insert',
      })
      expect((await waitJob(h.t, imp.json().job.id)).state).toBe('done')
      const limit = (opts: unknown) => (opts as { maxTimeMS?: number } | undefined)?.maxTimeMS ?? 0
      expect(limit(find.mock.calls.at(-1)![1])).toBeGreaterThan(0)
      expect(limit(aggregate.mock.calls.at(-1)![1])).toBeGreaterThan(0)
      expect(limit(bulk.mock.calls.at(-1)![1])).toBeGreaterThan(0)
    } finally {
      await h.t.close()
    }
  }, 60_000)

  it('I9: concurrent starts never pass the limit of running transfers', async () => {
    const h = await dataHarness(mongo)
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const hanging: JobKind<unknown> = {
      name: 'data.export',
      run: () => held,
      cancel: async () => true,
      recover: () => 'interrupted',
    }
    const kinds = h.t.app.ctx.jobKinds as Record<string, JobKind<unknown>>
    const real = kinds['data.export']!
    kinds['data.export'] = hanging
    try {
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          h.call('POST', `${PEOPLE}/export`, { source: { kind: 'collection' }, format: 'json' }),
        ),
      )
      expect(results.filter((r) => r.statusCode === 202)).toHaveLength(2)
      expect(results.filter((r) => r.statusCode === 409)).toHaveLength(2)
    } finally {
      release()
      kinds['data.export'] = real
      await h.t.close()
    }
  })

  it('I6: an export stops when another file of its owner fills the quota meanwhile', async () => {
    const h = await dataHarness(mongo, {
      transfer: { maxUploadMb: 64, quotaMb: 16, totalQuotaMb: 51_200, ttlHours: 1, maxJobHours: 1 },
    })
    try {
      await people().insertMany(Array.from({ length: 3000 }, (_, i) => ({ i, pad: 'p'.repeat(100) })))
      const files = h.t.app.ctx.transfer.files
      const grow = files.grow.bind(files)
      let other: string | null = null
      vi.spyOn(files, 'grow').mockImplementation((id, size) => {
        if (!other) {
          // Another job of the same owner writes 16 MiB while this export runs.
          const { file } = files.reserve({
            owner: 'local',
            kind: 'export',
            connectionId: h.connectionId,
            name: 'o',
            jobId: 'other',
          })
          other = file.id
          grow(other, 16 * 1024 * 1024)
        }
        grow(id, size)
      })
      const res = await h.call('POST', `${PEOPLE}/export`, { source: { kind: 'collection' }, format: 'json' })
      const job = await waitJob(h.t, res.json().job.id)
      expect(job.state).toBe('failed')
      expect(job.error).toMatch(/transfer storage is full/)
    } finally {
      await h.t.close()
    }
  })
})

describe('final review, imports (phase 3d-1)', () => {
  it('I3: a restricted upsert on a collection without rules replaces the document', async () => {
    await client
      .db('crm')
      .collection('other')
      .insertOne({ _id: 1 as never, a: 1, b: 2 })
    const { t, as } = await restrictedApp(mongo, RULES)
    try {
      const user = as('editor', true)
      const up = (await user.raw('PUT', '/transfer/uploads', Buffer.from('id,a\n1,5\n2,6\n'))).json()
      const res = await user('POST', '/databases/crm/collections/other/import', {
        uploadId: up.uploadId,
        format: 'csv',
        mapping: [map('id', '_id', 'int32'), map('a', 'a', 'int32')],
        mode: 'upsert',
        keys: ['_id'],
      })
      expect(res.statusCode).toBe(202)
      const job = await waitJob(t, res.json().job.id)
      expect(job.state).toBe('done')
      const docs = await client.db('crm').collection('other').find().sort({ _id: 1 }).toArray()
      expect(docs).toEqual([
        { _id: 1, a: 5 },
        { _id: 2, a: 6 },
      ])
    } finally {
      await t.close()
    }
  })

  it('I4: a key value is matched as a value, never as a query operator; $-keys are refused', async () => {
    const h = await dataHarness(mongo)
    try {
      await people().insertMany([
        { k: 'a', v: 1 },
        { k: 'b', v: 1 },
      ])
      // A finished import deletes its upload: each start gets one of its own.
      const start = async (body: object) => {
        const up = await h.raw('PUT', '/transfer/uploads', Buffer.from('{"k":{"$ne":null},"v":9}\n'))
        return h.call('POST', `${PEOPLE}/import`, {
          uploadId: up.json().uploadId,
          format: 'ndjson',
          allowUnusualKeys: true,
          ...body,
        })
      }
      const res = await start({ mode: 'merge', keys: ['k'], updateOnly: true })
      expect(res.statusCode).toBe(202)
      await waitJob(h.t, res.json().job.id)
      expect(await people().countDocuments({ v: 9 })).toBe(0)
      for (const keys of [['$where'], ['a.$x']]) {
        const refused = await start({ mode: 'merge', keys })
        expect(refused.statusCode).toBe(400)
      }
    } finally {
      await h.t.close()
    }
  })

  it('M3: a merge refuses a field name that would be read as a path', async () => {
    const h = await dataHarness(mongo)
    try {
      await people().insertOne({ _id: 1 as never, a: { b: 1 } })
      const up = await h.raw('PUT', '/transfer/uploads', Buffer.from('{"_id":1,"a.b":2}\n'))
      const res = await h.call('POST', `${PEOPLE}/import`, {
        uploadId: up.json().uploadId,
        format: 'ndjson',
        allowUnusualKeys: true,
        mode: 'merge',
        keys: ['_id'],
      })
      const job = await waitJob(h.t, res.json().job.id)
      const report = (await h.get(`/api/transfer/jobs/${job.id}/report`)).json()
      expect(report).toMatchObject({ failed: 1, modified: 0 })
      expect(await people().findOne({ _id: 1 as never })).toEqual({ _id: 1, a: { b: 1 } })
    } finally {
      await h.t.close()
    }
  })

  it('M4: an import that fails is audited as a failure', async () => {
    const h = await dataHarness(mongo)
    try {
      const up = await h.raw('PUT', '/transfer/uploads', Buffer.from('id,name\n1,"Ali\n'))
      const res = await h.call('POST', `${PEOPLE}/import`, {
        uploadId: up.json().uploadId,
        format: 'csv',
        mapping: [map('id', 'id', 'int32'), map('name', 'name')],
        mode: 'insert',
      })
      expect((await waitJob(h.t, res.json().job.id)).state).toBe('failed')
      const [row] = h.t.app.ctx.audit.list({ action: 'transfer.import' })
      expect(row!.outcome).toBe('failure')
    } finally {
      await h.t.close()
    }
  })

  it('M6: only the owner sees a transfer job, and a stop names no record content', async () => {
    const h = await teamHarness(mongo)
    try {
      const a = h.user('editor')
      const b = h.user('editor')
      const up = await a.raw('PUT', '/transfer/uploads?name=secret-plan.csv', Buffer.from('n\n1\nZ9Q\n'))
      const res = await a.call('POST', `${PEOPLE}/import`, {
        uploadId: up.json().uploadId,
        format: 'csv',
        mapping: [map('n', 'n', 'int32')],
        mode: 'insert',
        onError: 'stop',
      })
      const job = await waitJob(h.t, res.json().job.id)
      expect(job.error).toMatch(/^Stopped at record 2/)
      expect(job.error).not.toContain('Z9Q')
      expect(job.error).not.toContain('int32')
      const seen = (await b.get('/api/jobs')).json() as { jobs: Array<{ id: string }> }
      expect(seen.jobs.map((j) => j.id)).not.toContain(job.id)
      expect((await b.get(`/api/jobs/${job.id}`)).statusCode).toBe(404)
      const own = (await a.get('/api/jobs')).json() as { jobs: Array<{ id: string }> }
      expect(own.jobs.map((j) => j.id)).toContain(job.id)
    } finally {
      await h.t.close()
    }
  })

  it('I6: the rejected-records file is dropped, not kept past the quota', async () => {
    const h = await dataHarness(mongo, {
      transfer: { maxUploadMb: 64, quotaMb: 16, totalQuotaMb: 51_200, ttlHours: 1, maxJobHours: 1 },
    })
    try {
      const line = `{"a":"${'r'.repeat(1000)}",}\n`
      const up = await h.raw('PUT', '/transfer/uploads', Buffer.from(line.repeat(10_000)))
      expect(up.statusCode).toBe(201)
      const res = await h.call('POST', `${PEOPLE}/import`, {
        uploadId: up.json().uploadId,
        format: 'ndjson',
        mode: 'insert',
      })
      const job = await waitJob(h.t, res.json().job.id, 60_000)
      const report = (await h.get(`/api/transfer/jobs/${job.id}/report`)).json()
      expect(report).toMatchObject({ failed: 10_000, rejectedFile: false, rejectedDropped: true })
      expect(h.t.app.ctx.transfer.files.usage('local')).toBeLessThanOrEqual(16 * 1024 * 1024)
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('I6: concurrent uploads never pass the quota together', async () => {
    const h = await dataHarness(mongo, {
      transfer: { maxUploadMb: 64, quotaMb: 16, totalQuotaMb: 51_200, ttlHours: 1, maxJobHours: 1 },
    })
    try {
      const body = Buffer.alloc(10 * 1024 * 1024, 0x61)
      const results = await Promise.all([
        h.raw('PUT', '/transfer/uploads', body),
        h.raw('PUT', '/transfer/uploads', body),
      ])
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409])
      expect(h.t.app.ctx.transfer.files.usage('local')).toBeLessThanOrEqual(16 * 1024 * 1024)
    } finally {
      await h.t.close()
    }
  })

  it('I6: the inflated copy of a gzip xlsx counts against the quota', async () => {
    const h = await dataHarness(mongo, {
      transfer: { maxUploadMb: 64, quotaMb: 16, totalQuotaMb: 51_200, ttlHours: 1, maxJobHours: 1 },
    })
    try {
      // Random text barely compresses: a 9 MiB upload that inflates to a 12 MiB copy.
      const filler = randomBytes(9 * 1024 * 1024).toString('base64')
      const zip = rawZip([{ name: 'filler', data: Buffer.from(filler) }])
      const up = await h.raw('PUT', '/transfer/uploads?name=b.xlsx.gz', gzipSync(zip))
      expect(up.statusCode).toBe(201)
      const res = await h.call('POST', `/transfer/uploads/${up.json().uploadId}/preview`, { format: 'xlsx' })
      expect(res.statusCode).toBe(409)
      expect(res.json().details.reason).toBe('transfer_quota')
    } finally {
      await h.t.close()
    }
  })
})

describe('final review, preview (phase 3d-1)', () => {
  it('C3: preview cells and records are cut, and wide files read fewer rows', async () => {
    const h = await dataHarness(mongo)
    try {
      const long = 'w'.repeat(20_000)
      const csv = await h.raw('PUT', '/transfer/uploads', Buffer.from(`a,b\n${long},1\n`))
      const table = (await h.call('POST', `/transfer/uploads/${csv.json().uploadId}/preview`, {})).json()
      expect(String(table.records[0].a).length).toBeLessThanOrEqual(201)
      const nd = await h.raw('PUT', '/transfer/uploads', Buffer.from(`{"a":"${long}","b":{"c":"${long}"}}\n`))
      const docs = (await h.call('POST', `/transfer/uploads/${nd.json().uploadId}/preview`, {})).json()
      expect(docs.records[0].a.length).toBeLessThanOrEqual(201)
      expect(docs.records[0].b.c.length).toBeLessThanOrEqual(201)

      // 2 000 columns: the preview reads at most 100 000 cells (50 rows), so row 60 is not seen.
      const width = 2_000
      const header = Array.from({ length: width }, (_, i) => `c${i}`).join(',')
      const row = (v: string) => [v, ...new Array<string>(width - 1).fill('1')].join(',')
      const rows = Array.from({ length: 100 }, (_, i) => row(i === 59 ? 'x' : '1'))
      const wide = await h.raw('PUT', '/transfer/uploads', Buffer.from(`${header}\n${rows.join('\n')}\n`))
      const preview = (await h.call('POST', `/transfer/uploads/${wide.json().uploadId}/preview`, {})).json()
      expect(preview.fields[0].suggestedType).toBe('int32')
    } finally {
      await h.t.close()
    }
  })

  it('C3: one preview at a time per user', async () => {
    const h = await dataHarness(mongo)
    try {
      const big = Buffer.from(`a\n${'1\n'.repeat(2_000_000)}`)
      const up = await h.raw('PUT', '/transfer/uploads', big)
      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          h.call('POST', `/transfer/uploads/${up.json().uploadId}/preview`, {}),
        ),
      )
      const busy = results.filter((r) => r.statusCode === 409)
      expect(busy.length).toBeGreaterThan(0)
      expect(busy[0]!.json().details.reason).toBe('preview_busy')
      expect(results.some((r) => r.statusCode === 200)).toBe(true)
    } finally {
      await h.t.close()
    }
  })
})
