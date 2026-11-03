import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gunzipSync } from 'node:zlib'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { restrictedApp } from './support/restricted'
import { runSqlPlugin } from './support/sql-plugin'

/** A restricted app with the SQL → MongoDB plugin on, so its SQL routes test the masking (2026-11-02). */
const restrictedSql: typeof restrictedApp = async (...args) => {
  const r = await restrictedApp(...args)
  runSqlPlugin(r.t.app)
  return r
}
import { waitJob } from './support/jobs'
import { InflateBudget, ZipReader } from '../src/transfer/formats/zip'
import { slow } from './support/slowness'

/** Spec §8, §10: what a restricted user exports holds no personal value, in any format. */
const S = 'S3NT1N3L'
const RULES = [
  { db: 'crm', coll: 'users', field: 'email' },
  { db: 'crm', coll: 'users', field: 'customer.phone' },
]
const NS = '/databases/crm/collections/users'
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
  await client
    .db('crm')
    .collection('users')
    .insertMany([
      { _id: 1 as never, email: `${S}@x`, name: 'Ali', customer: { phone: `${S}-p`, city: 'Izmir' } },
      { _id: 2 as never, email: `${S}@y`, name: 'Bea', customer: { phone: `${S}-q`, city: 'Ankara' } },
    ])
})

/** Every part of an xlsx, inflated, as text: the sentinel scan reads it all. */
async function xlsxText(bytes: Buffer): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'mm-x-'))
  const path = join(dir, 'f.xlsx')
  writeFileSync(path, bytes)
  const handle = await open(path, 'r')
  try {
    const zip = await ZipReader.open(handle, bytes.length)
    let out = ''
    for (const n of zip.names()) out += (await zip.readAll(n, new InflateBudget(1e9), 1e9)).toString()
    return out
  } finally {
    await handle.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const FIELDS = ['_id', 'name', 'email', 'customer.phone', 'customer.city']

describe('restricted exports (spec §8.1)', () => {
  for (const format of ['csv', 'json', 'ndjson', 'xlsx'] as const)
    for (const gzip of [false, true])
      it(`${format}${gzip ? '.gz' : ''} holds *** and never the value`, async () => {
        const { t, as } = await restrictedApp(mongo, RULES)
        try {
          const user = as('editor', true)
          const res = await user('POST', `${NS}/export`, {
            source: { kind: 'collection' },
            format,
            gzip,
            fields: FIELDS,
          })
          expect(res.statusCode).toBe(202)
          const job = await waitJob(t, res.json().job.id)
          expect(job.state).toBe('done')
          const file = await user.get(`/api/transfer/files/${job.id}`)
          expect(file.statusCode).toBe(200)
          const bytes = gzip ? gunzipSync(file.rawPayload) : file.rawPayload
          const text = format === 'xlsx' ? await xlsxText(bytes) : bytes.toString()
          expect(text).not.toContain(S)
          expect(text).toContain('***')
          expect(text).toContain('Izmir')
          const report = (await user.get(`/api/transfer/jobs/${job.id}/report`)).json()
          expect(report).toMatchObject({ kind: 'export', masked: true, written: 2 })
        } finally {
          await t.close()
        }
      })

  it('refuses a filter, sort or pipeline on a personal field (403)', async () => {
    const { t, as } = await restrictedApp(mongo, RULES)
    try {
      const user = as('editor', true)
      const exp = (source: object) => user('POST', `${NS}/export`, { source, format: 'json' })
      expect((await exp({ kind: 'query', filter: { email: `${S}@x` } })).statusCode).toBe(403)
      expect(
        (await exp({ kind: 'query', filter: {}, sort: { email: { $numberInt: '1' } } })).statusCode,
      ).toBe(403)
      expect((await exp({ kind: 'pipeline', stages: [{ $group: { _id: '$email' } }] })).statusCode).toBe(403)
      expect(
        (await exp({ kind: 'pipeline', stages: [{ $project: { copy: '$customer.phone' } }] })).statusCode,
      ).toBe(403)
    } finally {
      await t.close()
    }
  })

  it('refuses a download after the rules change or the user becomes restricted (410)', async () => {
    const { t, ctx, as, connectionId } = await restrictedApp(mongo, RULES)
    try {
      const restricted = as('editor', true)
      const a = await restricted('POST', `${NS}/export`, { source: { kind: 'collection' }, format: 'json' })
      await waitJob(t, a.json().job.id)
      expect((await restricted.get(`/api/transfer/files/${a.json().job.id}`)).statusCode).toBe(200)
      t.clock.now += 1000
      ctx.personalFields.set(connectionId, [...RULES, { db: 'crm', coll: 'users', field: 'name' }])
      expect((await restricted.get(`/api/transfer/files/${a.json().job.id}`)).statusCode).toBe(410)
      const free = as('editor', false)
      const b = await free('POST', `${NS}/export`, { source: { kind: 'collection' }, format: 'json' })
      await waitJob(t, b.json().job.id)
      const plain = await free.get(`/api/transfer/files/${b.json().job.id}`)
      expect(plain.statusCode).toBe(200)
      expect(plain.body).toContain(S)
      free.makeRestricted()
      expect((await free.get(`/api/transfer/files/${b.json().job.id}`)).statusCode).toBe(410)
    } finally {
      await t.close()
    }
  }, 60_000)
})

describe('restricted imports (spec §8.2)', () => {
  const m = (source: string, path: string, type = 'string') => ({
    source,
    path,
    type,
    include: true,
    empty: 'skip',
    onError: 'error',
  })

  it('refuses a mapping onto a personal path, a personal key, and upsert on a ruled collection', async () => {
    const { t, as } = await restrictedApp(mongo, RULES)
    try {
      const user = as('editor', true)
      const { uploadId } = (
        await user.raw('PUT', '/transfer/uploads', Buffer.from('name,mail\nX,y\n'))
      ).json()
      const start = (body: object) => user('POST', `${NS}/import`, { uploadId, format: 'csv', ...body })
      const personal = await start({ mapping: [m('mail', 'email')], mode: 'insert' })
      expect(personal.statusCode).toBe(403)
      expect(personal.json().details.reason).toBe('personal_write')
      expect((await start({ mapping: [m('mail', 'customer.phone')], mode: 'insert' })).statusCode).toBe(403)
      expect((await start({ mapping: [m('mail', 'customer')], mode: 'insert' })).statusCode).toBe(202)
      expect((await start({ mapping: [m('name', 'name')], mode: 'merge', keys: ['email'] })).statusCode).toBe(
        403,
      )
      expect((await start({ mapping: [m('name', 'name')], mode: 'upsert', keys: ['name'] })).statusCode).toBe(
        403,
      )
    } finally {
      await t.close()
    }
  })

  it('JSON records holding a personal field fail one by one; errors are code-only; merges leave personal values', async () => {
    const { t, as } = await restrictedApp(mongo, RULES)
    try {
      await client.db('crm').collection('users').createIndex({ name: 1 }, { unique: true })
      const user = as('editor', true)
      const nd = `{"_id":3,"name":"Cem"}\n{"_id":4,"email":"x@y"}\n{"_id":5,"name":"Ali"}\n{"_id":6,"customer":{"phone":"1"}}\n`
      const up = (await user.raw('PUT', '/transfer/uploads', Buffer.from(nd))).json()
      const res = await user('POST', `${NS}/import`, {
        uploadId: up.uploadId,
        format: 'ndjson',
        mode: 'insert',
      })
      const job = await waitJob(t, res.json().job.id)
      const report = (await user.get(`/api/transfer/jobs/${job.id}/report`)).json()
      expect(report).toMatchObject({ inserted: 1, failed: 3 })
      expect(JSON.stringify(report)).not.toContain(S)
      expect(report.errors.find((e: { record: number }) => e.record === 3).reason).toMatch(/code 11000/)
      expect(report.errors.find((e: { record: number }) => e.record === 3).reason).not.toContain('Ali')
      const merge = (await user.raw('PUT', '/transfer/uploads', Buffer.from('id,city\n1,Bursa\n'))).json()
      const merged = await user('POST', `${NS}/import`, {
        uploadId: merge.uploadId,
        format: 'csv',
        mapping: [m('id', '_id', 'int32'), m('city', 'customer.city')],
        mode: 'merge',
        keys: ['_id'],
      })
      expect(merged.statusCode).toBe(202)
      await waitJob(t, merged.json().job.id)
      expect(
        await client
          .db('crm')
          .collection('users')
          .findOne({ _id: 1 as never }),
      ).toMatchObject({
        email: `${S}@x`,
        customer: { phone: `${S}-p`, city: 'Bursa' },
      })
      // A merge onto a sub-document holding personal data is skipped, never written over.
      const over = (await user.raw('PUT', '/transfer/uploads', Buffer.from('id,c\n2,flat\n'))).json()
      const overRes = await user('POST', `${NS}/import`, {
        uploadId: over.uploadId,
        format: 'csv',
        mapping: [m('id', '_id', 'int32'), m('c', 'customer')],
        mode: 'merge',
        keys: ['_id'],
      })
      const overJob = await waitJob(t, overRes.json().job.id)
      const overReport = (await user.get(`/api/transfer/jobs/${overJob.id}/report`)).json()
      expect(overReport).toMatchObject({ failed: 1, modified: 0 })
      expect(
        await client
          .db('crm')
          .collection('users')
          .findOne({ _id: 2 as never }),
      ).toMatchObject({
        customer: { phone: `${S}-q` },
      })
    } finally {
      await t.close()
    }
  }, 60_000)
})

// Review M8 (user request 2026-10-10): a SQL dump's tables are checked like a file import's plan.
describe('restricted SQL dump imports (spec §8.2)', () => {
  const importSql = async (
    user: ReturnType<Awaited<ReturnType<typeof restrictedApp>>['as']>,
    dump: string,
    body: object,
  ) => {
    const { uploadId } = (await user.raw('PUT', '/transfer/uploads?name=d.sql', Buffer.from(dump))).json()
    return user('POST', '/databases/crm/import-sql', { uploadId, ...body })
  }

  it('refuses an upsert into a ruled collection before any job', async () => {
    const { t, as } = await restrictedSql(mongo, RULES)
    try {
      const user = as('editor', true)
      const res = await importSql(user, 'INSERT INTO users VALUES (9);', {
        tables: [{ table: 'users', collection: 'users' }],
        mode: 'upsert',
      })
      expect(res.statusCode).toBe(403)
    } finally {
      await t.close()
    }
  })

  it('fails a table holding a personal column before writing any row, and leaves the others', async () => {
    const { t, as } = await restrictedSql(mongo, RULES)
    try {
      const user = as('editor', true)
      const dump =
        'CREATE TABLE users (id int PRIMARY KEY, name text, email text);\n' +
        "INSERT INTO users VALUES (7, 'Eve', 'eve@example.com');\n"
      const res = await importSql(user, dump, { tables: [{ table: 'users', collection: 'users' }] })
      expect(res.statusCode).toBe(202)
      const job = await waitJob(t, res.json().job.id)
      expect(job.state).toBe('failed')
      expect(job.error).toMatch(/personal/i)
      expect(await client.db('crm').collection('users').countDocuments()).toBe(2)
      const report = (await user.get(`/api/transfer/jobs/${job.id}/report`)).json()
      expect(JSON.stringify(report)).not.toContain(S)

      const fine = await importSql(
        user,
        "CREATE TABLE users (id int PRIMARY KEY, name text);\nINSERT INTO users VALUES (8, 'Fay');\n",
        { tables: [{ table: 'users', collection: 'users' }] },
      )
      expect((await waitJob(t, fine.json().job.id)).state).toBe('done')
      expect(await client.db('crm').collection('users').countDocuments()).toBe(3)
    } finally {
      await t.close()
    }
  }, 60_000)
})
