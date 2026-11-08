// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { gunzipSync } from 'node:zlib'
import { PassThrough } from 'node:stream'
import { Decimal128, Double, Int32, Long, MongoClient, ObjectId } from 'mongodb'
import { EJSON } from 'bson'
import { ExportRequestSchema, toWire } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, teamHarness, type DataHarness } from './support/data'
import { runSqlPlugin } from './support/sql-plugin'
import { waitJob } from './support/jobs'
import { docWriter } from '../src/transfer/writers'
import { contentDisposition } from '../src/routes/transfer'
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

const NS = '/databases/exp/collections/items'
const DOCS = [
  {
    _id: new ObjectId('65a1b2c3d4e5f6a7b8c9d0e1'),
    n: new Int32(1),
    big: Long.fromString('9007199254740993'),
    d: new Double(2),
    dec: Decimal128.fromString('0.1'),
    at: new Date('2024-01-01T00:00:00Z'),
    name: '=cmd',
    tags: ['a', 'b'],
    sub: { x: new Int32(1) },
  },
  { _id: new ObjectId('65a1b2c3d4e5f6a7b8c9d0e2'), n: new Int32(2), name: 'Veli', extra: true },
]
beforeEach(async () => {
  await client.db('exp').dropDatabase()
  await client
    .db('exp')
    .collection('items')
    .insertMany(DOCS.map((d) => ({ ...d })))
})

async function exportAs(h: DataHarness, body: object) {
  const res = await h.call('POST', `${NS}/export`, body)
  expect(res.statusCode).toBe(202)
  const job = await waitJob(h.t, res.json().job.id)
  const file = await h.get(`/api/transfer/files/${job.id}`)
  const report = (await h.get(`/api/transfer/jobs/${job.id}/report`)).json()
  return { job, file, report }
}

describe('export (spec §4.3, §5.4)', () => {
  it('writes canonical JSON and NDJSON that keep every type (Review Focus 3)', async () => {
    const h = await dataHarness(mongo)
    try {
      const json = await exportAs(h, { source: { kind: 'collection' }, format: 'json' })
      expect(json.job.state).toBe('done')
      expect(json.report).toMatchObject({ kind: 'export', written: 2, masked: false })
      expect(toWire(EJSON.parse(json.file.body, { relaxed: false }))).toBe(toWire(DOCS))
      const nd = await exportAs(h, { source: { kind: 'collection' }, format: 'ndjson', gzip: true })
      expect(nd.file.headers['content-type']).toBe('application/gzip')
      const lines = gunzipSync(nd.file.rawPayload).toString().trim().split('\n')
      expect(lines.map((l) => toWire(EJSON.parse(l, { relaxed: false })))).toEqual(DOCS.map((d) => toWire(d)))
    } finally {
      await h.t.close()
    }
  }, 60_000)

  it('exports then imports to an identical collection (Review Focus 3)', async () => {
    const h = await dataHarness(mongo)
    try {
      const nd = await exportAs(h, { source: { kind: 'collection' }, format: 'ndjson' })
      const up = (await h.raw('PUT', '/transfer/uploads?name=x.ndjson', Buffer.from(nd.file.body))).json()
      const imp = await h.call('POST', '/databases/exp/collections/copy/import', {
        uploadId: up.uploadId,
        format: 'ndjson',
        mode: 'insert',
      })
      await waitJob(h.t, imp.json().job.id)
      const copy = await client
        .db('exp')
        .collection('copy')
        .find({}, { promoteValues: false, promoteLongs: false })
        .toArray()
      expect(toWire(copy)).toBe(toWire(DOCS))
    } finally {
      await h.t.close()
    }
  }, 60_000)

  it('writes CSV with chosen columns, guards formulas and names omitted fields (Review Focus 4)', async () => {
    const h = await dataHarness(mongo)
    try {
      const csv = await exportAs(h, {
        source: { kind: 'query', filter: {}, sort: { n: { $numberInt: '1' } } },
        format: 'csv',
        fields: ['n', 'name', 'big', 'tags.1', 'sub'],
        csv: { delimiter: ';', bom: false, lineEnding: 'lf' },
      })
      expect(csv.file.body).toBe(`n;name;big;tags.1;sub\n1;'=cmd;9007199254740993;b;"{""x"":1}"\n2;Veli;;;\n`)
      // tags.0 too: only tags.1 was chosen (review of the data fixes, Minor 1).
      expect(csv.report.omittedFields).toEqual(['_id', 'd', 'dec', 'at', 'tags.0', 'extra'])
      expect(csv.file.headers['content-disposition']).toMatch(
        /^attachment; filename="items-.*\.csv"; filename\*=UTF-8''/,
      )
      expect(csv.file.headers['x-content-type-options']).toBe('nosniff')
      expect(csv.file.headers['content-security-policy']).toContain('sandbox')
      expect(csv.file.headers['cache-control']).toBe('no-store')
      // Data review 2026-10-13 (M8): for a file meant for another program, the text as it is.
      const plain = await exportAs(h, {
        source: { kind: 'query', filter: {}, sort: { n: { $numberInt: '1' } } },
        format: 'csv',
        fields: ['n', 'name'],
        csv: { delimiter: ';', bom: false, lineEnding: 'lf', formulaGuard: false },
      })
      expect(plain.file.body).toBe(`n;name\n1;=cmd\n2;Veli\n`)
      // Short names review 7: the BOM, written as an escape in source now, is the three bytes still.
      const bom = await exportAs(h, {
        source: { kind: 'query', filter: {}, sort: { n: { $numberInt: '1' } } },
        format: 'csv',
        fields: ['n'],
        csv: { delimiter: ';', bom: true, lineEnding: 'lf' },
      })
      expect([...bom.file.rawPayload.subarray(0, 4)]).toEqual([0xef, 0xbb, 0xbf, 0x6e])
    } finally {
      await h.t.close()
    }
  }, 60_000)

  it('writes a SQL file for the dialect chosen, named after the collection, served as SQL (user request 2026-10-10)', async () => {
    const h = await dataHarness(mongo)
    // SQL is the SQL → MongoDB plugin's (user request 2026-11-02).
    runSqlPlugin(h.t.app)
    try {
      const pg = await exportAs(h, { source: { kind: 'collection' }, format: 'sql' })
      expect(pg.file.headers['content-type']).toBe('application/sql; charset=utf-8')
      expect(pg.file.headers['content-disposition']).toMatch(/^attachment; filename="items-.*\.sql"/)
      expect(pg.file.body).toContain('CREATE TABLE "items" (')
      expect(pg.file.body).toContain('INSERT INTO "items"')
      expect(pg.file.body).toContain("'65a1b2c3d4e5f6a7b8c9d0e1'")
      expect(pg.report.written).toBe(2)
      const my = await exportAs(h, {
        source: { kind: 'collection' },
        format: 'sql',
        sql: { dialect: 'mysql', table: 'my items' },
      })
      expect(my.file.body).toContain('CREATE TABLE `my items` (')
      expect(my.file.body).not.toContain('CREATE TABLE "items"')
    } finally {
      await h.t.close()
    }
  }, 60_000)

  // Review M7 (2026-10-10): a sub-document with a field named "_bsontype" (another driver can store
  // one; here through a Map) is data, in every format, and never stops the export.
  it('exports a sub-document holding a field named _bsontype as data, in every format', async () => {
    const h = await dataHarness(mongo)
    // Every format: SQL among them, the SQL → MongoDB plugin's (user request 2026-11-02).
    runSqlPlugin(h.t.app)
    try {
      await client
        .db('exp')
        .collection('items')
        .insertOne({
          _id: 'fake' as never,
          v: new Map<string, unknown>([
            ['_bsontype', 'Decimal128'],
            ['x', 1],
          ]),
        })
      for (const format of ['json', 'ndjson', 'csv', 'sql'] as const) {
        const out = await exportAs(h, {
          source: { kind: 'query', filter: { _id: 'fake' } },
          format,
          ...(format === 'sql' || format === 'csv' ? { fields: ['_id', 'v'] } : {}),
        })
        expect(out.job.state, `${format}: ${out.job.error}`).toBe('done')
        expect(out.file.body).toContain('_bsontype')
        expect(out.file.body).not.toContain('[object Object]')
      }
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('exports a filtered, limited query and a pipeline; refuses $out and $merge in it', async () => {
    const h = await dataHarness(mongo)
    try {
      const q = await exportAs(h, {
        source: { kind: 'query', filter: { name: 'Veli' }, projection: { _id: 0, name: 1 } },
        format: 'ndjson',
      })
      expect(q.file.body).toBe('{"name":"Veli"}\n')
      const p = await exportAs(h, {
        source: { kind: 'pipeline', stages: [{ $project: { _id: 0, name: 1 } }] },
        format: 'ndjson',
      })
      expect(p.file.body.trim().split('\n')).toEqual(['{"name":"=cmd"}', '{"name":"Veli"}'])
      for (const stage of [{ $out: 'x' }, { $merge: { into: 'x' } }])
        expect(
          (
            await h.call('POST', `${NS}/export`, {
              source: { kind: 'pipeline', stages: [stage] },
              format: 'json',
            })
          ).statusCode,
        ).toBe(400)
    } finally {
      await h.t.close()
    }
  }, 60_000)

  it('fails at the quota and leaves no file', async () => {
    const h = await dataHarness(mongo, {
      transfer: { maxUploadMb: 1, quotaMb: 16, totalQuotaMb: 51_200, ttlHours: 24, maxJobHours: 6 },
    })
    try {
      await client
        .db('exp')
        .collection('items')
        .insertMany(Array.from({ length: 20 }, () => ({ blob: 'x'.repeat(1024 * 1024) })))
      const res = await h.call('POST', `${NS}/export`, { source: { kind: 'collection' }, format: 'json' })
      const job = await waitJob(h.t, res.json().job.id)
      expect(job.state).toBe('failed')
      expect(h.t.app.ctx.transfer.files.usage('local')).toBe(0)
      expect((await h.get(`/api/transfer/files/${job.id}`)).statusCode).toBe(404)
    } finally {
      await h.t.close()
    }
  })

  it('lets only its owner download, and viewers do not export by default', async () => {
    const h = await teamHarness(mongo)
    try {
      const editor = h.user('editor')
      const res = await editor.call('POST', `${NS}/export`, {
        source: { kind: 'collection' },
        format: 'json',
      })
      expect(res.statusCode).toBe(202)
      const job = await waitJob(h.t, res.json().job.id)
      expect((await h.user('editor').get(`/api/transfer/files/${job.id}`)).statusCode).toBe(404)
      expect((await editor.get(`/api/transfer/files/${job.id}`)).statusCode).toBe(200)
      expect(
        (
          await h
            .user('viewer')
            .call('POST', `${NS}/export`, { source: { kind: 'collection' }, format: 'json' })
        ).statusCode,
      ).toBe(403)
    } finally {
      await h.t.close()
    }
  })

  it('gives a viewer file export on one connection through the export grant (phase 3d-1)', async () => {
    const h = await teamHarness(mongo)
    try {
      const admin = h.user('admin')
      const viewer = h.user('viewer')
      const exportOnce = () =>
        viewer.call('POST', `${NS}/export`, { source: { kind: 'collection' }, format: 'json' })
      const flag = async () =>
        ((await viewer.get('/api/connections')).json() as Array<{ id: string; export?: boolean }>).find(
          (c) => c.id === h.connectionId,
        )?.export
      expect(await flag()).toBe(false)
      expect(
        (await admin.call('PUT', `/grants/${viewer.id}`, { role: 'viewer', export: true })).statusCode,
      ).toBe(204)
      expect(await flag()).toBe(true)
      const res = await exportOnce()
      expect(res.statusCode).toBe(202)
      await waitJob(h.t, res.json().job.id)
      expect(
        (await admin.call('PUT', `/grants/${viewer.id}`, { role: 'viewer', export: false })).statusCode,
      ).toBe(204)
      expect((await exportOnce()).statusCode).toBe(403)
      // The file made under the grant is no longer handed out either (plan ruling 3).
      expect((await viewer.get(`/api/transfer/files/${res.json().job.id}`)).statusCode).toBe(410)
    } finally {
      await h.t.close()
    }
  })

  it('refuses more rows than an xlsx sheet holds (with a small limit)', async () => {
    const req = ExportRequestSchema.parse({ source: { kind: 'collection' }, format: 'xlsx', fields: ['a'] })
    const out = new PassThrough()
    out.resume()
    const w = docWriter(out, req, { xlsxMaxRows: 2 })
    await w.write({ a: 1 })
    await w.write({ a: 2 })
    await expect(w.write({ a: 3 })).rejects.toMatchObject({ details: { reason: 'xlsx_rows' } })
  })

  it('builds download names that cannot break a header (T14)', () => {
    expect(contentDisposition('kişiler\r\n"x".csv')).toBe(
      `attachment; filename="ki_iler___x_.csv"; filename*=UTF-8''ki%C5%9Filer%0D%0A%22x%22.csv`,
    )
  })
})
