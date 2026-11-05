// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Int32, Long, MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, type DataHarness } from './support/data'
import { waitJob } from './support/jobs'
import { assertTransferRoom } from '../src/routes/data/transfer'
import { slow } from './support/slowness'

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
  await client.db('imp').dropDatabase()
})

const NS = '/databases/imp/collections/people'
const people = () => client.db('imp').collection('people')
const map = (source: string, path: string, type: string, extra: object = {}) => ({
  source,
  path,
  type,
  include: true,
  empty: 'skip',
  onError: 'error',
  ...extra,
})

async function upload(h: DataHarness, text: string | Buffer): Promise<string> {
  const res = await h.raw('PUT', '/transfer/uploads?name=f.csv', Buffer.from(text))
  expect(res.statusCode).toBe(201)
  return res.json().uploadId
}

async function run(h: DataHarness, text: string | Buffer, body: object) {
  const uploadId = await upload(h, text)
  const res = await h.call('POST', `${NS}/import`, { uploadId, ...body })
  expect(res.statusCode).toBe(202)
  const job = await waitJob(h.t, res.json().job.id)
  const report = (await h.get(`/api/transfer/jobs/${job.id}/report`)).json()
  return { job, report, uploadId }
}

const CSV = 'id,name,age\n1,Ali,30\n2,Veli,x\n3,Ayşe,41\n'

describe('import job (spec §6)', () => {
  it('inserts with mapping and types; continue skips bad rows and reports them', async () => {
    const h = await dataHarness(mongo)
    try {
      const { job, report } = await run(h, CSV, {
        format: 'csv',
        mapping: [map('id', '_id', 'int32'), map('name', 'name', 'string'), map('age', 'age', 'int32')],
        mode: 'insert',
      })
      expect(job.state).toBe('done')
      expect(report).toMatchObject({
        read: 3,
        inserted: 2,
        failed: 1,
        errors: [{ record: 2, field: 'age' }],
        rejectedFile: true,
        fields: [
          { source: 'id', converted: 3, failed: 0 },
          { source: 'name', converted: 3, failed: 0 },
          { source: 'age', converted: 2, failed: 1 },
        ],
      })
      expect(await people().findOne({ _id: 3 as never })).toEqual({ _id: 3, name: 'Ayşe', age: 41 })
      const rejected = await h.get(`/api/transfer/jobs/${job.id}/rejected`)
      expect(rejected.statusCode).toBe(200)
      expect(rejected.headers['content-disposition']).toMatch(/^attachment;/)
      expect(rejected.body).toContain('id,name,age')
      expect(rejected.body).toContain('Veli')
      expect(rejected.body).not.toContain('Ali')
      expect(report.unfinished).toBeUndefined()
    } finally {
      await h.t.close()
    }
  })

  // Review of the data fixes (I4): a row refused for its width goes to the rejected-records file,
  // so it can be fixed and imported again.
  it('puts a row of another width into the rejected file', async () => {
    const h = await dataHarness(mongo)
    try {
      const { job, report } = await run(h, ['id,name,age', '1,Ali,30', '2,Veli,Can,40', ''].join('\n'), {
        format: 'csv',
        mapping: [map('id', '_id', 'int32'), map('name', 'name', 'string'), map('age', 'age', 'int32')],
        mode: 'insert',
      })
      expect(job.state).toBe('done')
      expect(report).toMatchObject({ read: 2, inserted: 1, failed: 1, rejectedFile: true })
      const rejected = await h.get(`/api/transfer/jobs/${job.id}/rejected`)
      expect(rejected.body).toContain('2,Veli,Can,40')
    } finally {
      await h.t.close()
    }
  })

  // Data review 2026-10-13 (low): the rejected file was comma-separated whatever the source used
  // (a semicolon file came back as one field per row), and a row with bytes that are not text was
  // left out of it altogether.
  it('writes rejected rows with the source’s delimiter, those with bad bytes included', async () => {
    const h = await dataHarness(mongo)
    try {
      const text = Buffer.concat([
        Buffer.from('id;name;age\n1;Ali;30\n2;Veli;x\n3;'),
        Buffer.from([0xff, 0xfe]),
        Buffer.from(';41\n'),
      ])
      const { job, report } = await run(h, text, {
        format: 'csv',
        dialect: { delimiter: ';' },
        mapping: [map('id', '_id', 'int32'), map('name', 'name', 'string'), map('age', 'age', 'int32')],
        mode: 'insert',
      })
      expect(job.state).toBe('done')
      expect(report).toMatchObject({ read: 3, inserted: 1, failed: 2, rejectedFile: true })
      const rejected = (await h.get(`/api/transfer/jobs/${job.id}/rejected`)).body
      expect(rejected.split(/\r?\n/).filter(Boolean)).toEqual(['id;name;age', '2;Veli;x', '3;��;41'])
    } finally {
      await h.t.close()
    }
  })

  it('stop writes the records before the first bad one and ends the job failed', async () => {
    const h = await dataHarness(mongo)
    try {
      const { job, report } = await run(h, CSV, {
        format: 'csv',
        mapping: [map('id', '_id', 'int32'), map('age', 'age', 'int32')],
        mode: 'insert',
        onError: 'stop',
      })
      expect(job.state).toBe('failed')
      expect(report).toMatchObject({ stoppedAt: 2, inserted: 1, failed: 1 })
      // Data review 2026-10-13 (low): a run that did not finish says what it wrote, so running it
      // again with Insert is not done blind (it would write those records twice).
      expect(report.unfinished).toEqual({ written: 1, notWritten: 0 })
      expect(await people().countDocuments()).toBe(1)
    } finally {
      await h.t.close()
    }
  })

  it('reports duplicate _id inserts with their MongoDB code', async () => {
    const h = await dataHarness(mongo)
    try {
      await people().insertOne({ _id: 1 as never })
      const { report } = await run(h, CSV, {
        format: 'csv',
        mapping: [map('id', '_id', 'int32')],
        mode: 'insert',
      })
      expect(report.errors).toEqual([expect.objectContaining({ record: 1, code: 11000 })])
      expect(report.inserted).toBe(2)
    } finally {
      await h.t.close()
    }
  })

  it('merges keeping other fields (update only inserts nothing), and upserts by key', async () => {
    const h = await dataHarness(mongo)
    try {
      await people().insertMany([{ code: 'a', name: 'Old', keep: true }])
      const csv = 'code,name\na,New\nb,Bee\n'
      const mapping = [map('code', 'code', 'string'), map('name', 'name', 'string')]
      const merged = await run(h, csv, {
        format: 'csv',
        mapping,
        mode: 'merge',
        keys: ['code'],
        updateOnly: true,
      })
      expect(merged.report).toMatchObject({ matched: 1, modified: 1, upserted: 0 })
      expect(await people().findOne({ code: 'a' }, { projection: { _id: 0 } })).toEqual({
        code: 'a',
        name: 'New',
        keep: true,
      })
      expect(await people().countDocuments()).toBe(1)
      const up = await run(h, csv, { format: 'csv', mapping, mode: 'upsert', keys: ['code'] })
      expect(up.report).toMatchObject({ matched: 1, upserted: 1 })
      expect(await people().findOne({ code: 'a' }, { projection: { _id: 0 } })).toEqual({
        code: 'a',
        name: 'New',
      })
      const missing = await run(h, 'name\nZed\n', {
        format: 'csv',
        mapping: [map('name', 'name', 'string')],
        mode: 'merge',
        keys: ['code'],
      })
      expect(missing.report.errors[0].reason).toMatch(/key field "code" is missing/)
    } finally {
      await h.t.close()
    }
  }, 60_000)

  it('merges into sub-documents field by field, keeping the fields the record does not have', async () => {
    const h = await dataHarness(mongo)
    try {
      await people().insertOne({ code: 'a', addr: { city: 'X', zip: '1' }, tags: ['t'] })
      const { report } = await run(h, 'code,addr.city,tags\na,Y,"[""u""]"\n', {
        format: 'csv',
        mapping: [
          map('code', 'code', 'string'),
          map('addr.city', 'addr.city', 'string'),
          map('tags', 'tags', 'json'),
        ],
        mode: 'merge',
        keys: ['code'],
      })
      expect(report).toMatchObject({ matched: 1, modified: 1 })
      expect(await people().findOne({ code: 'a' }, { projection: { _id: 0 } })).toEqual({
        code: 'a',
        addr: { city: 'Y', zip: '1' },
        tags: ['u'],
      })
    } finally {
      await h.t.close()
    }
  })

  it('a dry run writes nothing, keeps the upload and counts matches', async () => {
    const h = await dataHarness(mongo)
    try {
      await people().insertOne({ code: 'a' })
      const { report, uploadId } = await run(h, 'code\na\nb\n', {
        format: 'csv',
        mapping: [map('code', 'code', 'string')],
        mode: 'upsert',
        keys: ['code'],
        dryRun: true,
      })
      expect(report).toMatchObject({ dryRun: true, read: 2, wouldMatch: 1, inserted: 0 })
      expect(h.t.app.ctx.jobs.list().find((j) => j.target.endsWith('(dry run)'))).toBeTruthy()
      expect(await people().countDocuments()).toBe(1)
      const again = await h.call('POST', `${NS}/import`, {
        uploadId,
        format: 'csv',
        mapping: [map('code', 'code', 'string')],
        mode: 'insert',
      })
      expect(again.statusCode).toBe(202)
      await waitJob(h.t, again.json().job.id)
      expect(await people().countDocuments()).toBe(3)
      expect((await h.call('POST', `/transfer/uploads/${uploadId}/preview`, {})).statusCode).toBe(404)
    } finally {
      await h.t.close()
    }
  }, 60_000)

  it('imports EJSON keeping BSON types, and refuses unusual keys unless allowed', async () => {
    const h = await dataHarness(mongo)
    try {
      const text =
        '{"_id":1,"n":{"$numberLong":"9007199254740993"},"$weird":1}\n{"_id":2,"n":{"$numberInt":"5"}}\n'
      const { report } = await run(h, text, { format: 'ndjson', mode: 'insert' })
      expect(report).toMatchObject({ inserted: 1, failed: 1 })
      expect((await people().findOne({ _id: 2 as never }, { promoteValues: false }))!.n).toEqual(new Int32(5))
      const allowed = await run(h, text.split('\n')[0]!, {
        format: 'ndjson',
        mode: 'insert',
        allowUnusualKeys: true,
      })
      expect(allowed.report.inserted).toBe(1)
      expect((await people().findOne({ _id: 1 as never }, { promoteLongs: false }))!.n).toEqual(
        Long.fromString('9007199254740993'),
      )
    } finally {
      await h.t.close()
    }
  }, 60_000)

  it('allows at most two running transfers per user (spec §7 T2, T18)', () => {
    const running = (kind: string, userId: string | null) => ({ kind, userId, state: 'running' })
    const ctx = (list: object[]) => ({ jobs: { list: () => list } }) as never
    const local = { kind: 'local', userId: 'local' } as never
    expect(() =>
      assertTransferRoom(ctx([running('data.import', null), running('data.export', null)]), local),
    ).toThrow(/2 transfers/)
    expect(() =>
      assertTransferRoom(ctx([running('data.import', 'u2'), running('index.create', null)]), local),
    ).not.toThrow()
  })

  // Twenty-first review of explain masking (nit): MongoDB refuses every write into a view.
  it('refuses an import into a view before it starts', async () => {
    const h = await dataHarness(mongo)
    try {
      await client.db('imp').createCollection('base')
      await client.db('imp').createCollection('people', { viewOn: 'base', pipeline: [] })
      const uploadId = await upload(h, CSV)
      const res = await h.call('POST', `${NS}/import`, {
        uploadId,
        format: 'csv',
        mode: 'insert',
        mapping: [map('id', 'id', 'int32')],
      })
      expect(res.statusCode, res.body).toBe(409)
      expect(res.json()).toMatchObject({ details: { reason: 'target_is_view', collection: 'people' } })
    } finally {
      await h.t.close()
    }
  })

  it('refuses CSV without a mapping, an unknown upload and a mapping that writes one path twice', async () => {
    const h = await dataHarness(mongo)
    try {
      const uploadId = await upload(h, CSV)
      expect(
        (await h.call('POST', `${NS}/import`, { uploadId, format: 'csv', mode: 'insert' })).statusCode,
      ).toBe(400)
      expect(
        (
          await h.call('POST', `${NS}/import`, {
            uploadId,
            format: 'csv',
            mode: 'insert',
            mapping: [map('id', 'a', 'string'), map('name', 'a', 'string')],
          })
        ).statusCode,
      ).toBe(400)
      expect(
        (
          await h.call('POST', `${NS}/import`, {
            uploadId: '00000000-0000-4000-8000-000000000000',
            format: 'csv',
            mode: 'insert',
            mapping: [],
          })
        ).statusCode,
      ).toBe(404)
    } finally {
      await h.t.close()
    }
  })
})
