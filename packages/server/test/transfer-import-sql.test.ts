import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { gzipSync } from 'node:zlib'
import { Binary, Decimal128, MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import {
  dataHarness as baseDataHarness,
  teamHarness as baseTeamHarness,
  type DataHarness,
  type TeamUser,
} from './support/data'
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
import { waitJob } from './support/jobs'
import { hostile, rawZip } from './support/hostile'
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
  await client.db('sqlimp').dropDatabase()
})

const PG = `--
-- PostgreSQL database dump
--
SET statement_timeout = 0;
SET client_encoding = 'UTF8';
DROP TABLE IF EXISTS public.orders;
CREATE TABLE public.customers (
    id integer NOT NULL,
    name text,
    since date
);
CREATE TABLE public.orders (
    id integer NOT NULL,
    customer_id integer,
    total numeric(10,2),
    paid boolean,
    note text
);
COPY public.customers (id, name, since) FROM stdin;
1\tAda\t2026-01-05
2\tGrace\t\\N
\\.
COPY public.orders (id, customer_id, total, paid, note) FROM stdin;
10\t1\t234.20\tt\tİlk sipariş
11\t2\t8.48\tf\t\\N
\\.
ALTER TABLE ONLY public.customers ADD CONSTRAINT customers_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.orders ADD CONSTRAINT orders_pkey PRIMARY KEY (id);
CREATE INDEX orders_customer ON public.orders USING btree (customer_id);
`

const MYSQL =
  "/*!40101 SET NAMES utf8mb4 */;\nCREATE TABLE `users` (\n  `id` int NOT NULL,\n  `email` varchar(255) DEFAULT NULL,\n  `active` tinyint(1) DEFAULT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB;\nLOCK TABLES `users` WRITE;\nINSERT INTO `users` VALUES (1,'a@example.com',1),(2,'it\\'s@example.com',0),(3,now(),1);\nUNLOCK TABLES;\n"

async function upload(
  h: { raw: DataHarness['raw'] },
  text: string | Buffer,
  name = 'dump.sql',
): Promise<string> {
  const res = await h.raw('PUT', `/transfer/uploads?name=${name}`, Buffer.from(text))
  expect(res.statusCode).toBe(201)
  return res.json().uploadId
}
async function importSql(h: DataHarness | TeamUser, uploadId: string, body: object) {
  return h.call('POST', '/databases/sqlimp/import-sql', { uploadId, ...body })
}
async function runImport(h: DataHarness, text: string | Buffer, body: object) {
  const uploadId = await upload(h, text)
  const res = await importSql(h, uploadId, body)
  expect(res.statusCode, res.body).toBe(202)
  const job = await waitJob(h.t, res.json().job.id)
  const report = (await h.get(`/api/transfer/jobs/${job.id}/report`)).json()
  return { job, report, uploadId }
}

// User request 2026-10-10: SQL dumps into collections.
describe('SQL dump import', () => {
  it('previews a dump: its tables by key, columns, primary keys, rows and first rows, what is skipped', async () => {
    const h = await dataHarness(mongo)
    try {
      const uploadId = await upload(h, gzipSync(Buffer.from(PG)), 'dump.sql.gz')
      const res = await h.call('POST', `/transfer/uploads/${uploadId}/sql-preview`, {})
      expect(res.statusCode, res.body).toBe(200)
      const preview = res.json()
      expect(preview).toMatchObject({ gzip: true, dialect: 'postgres', truncated: false })
      expect(preview.tables.map((t: { key: string }) => t.key)).toEqual(['public.customers', 'public.orders'])
      expect(preview.tables[1]).toMatchObject({ name: 'orders', primaryKey: ['id'], rows: 2 })
      expect(preview.tables[1].columns.map((c: { kind: string }) => c.kind)).toEqual([
        'int',
        'int',
        'decimal',
        'bool',
        'string',
      ])
      expect(preview.tables[1].samples[0]).toMatchObject({ _id: { $numberInt: '10' } })
      expect(preview.skipped).toMatchObject({ SET: 2 })
    } finally {
      await h.t.close()
    }
  })

  it('imports the chosen tables into collections, the primary key as _id, never running the dump', async () => {
    const h = await dataHarness(mongo)
    try {
      const { job, report } = await runImport(h, PG, {
        tables: [
          { table: 'public.customers', collection: 'customers' },
          { table: 'public.orders', collection: 'orders' },
        ],
      })
      expect(job.state, JSON.stringify(report)).toBe('done')
      const orders = await client.db('sqlimp').collection('orders').find().sort({ _id: 1 }).toArray()
      expect(orders).toEqual([
        { _id: 10, customer_id: 1, total: Decimal128.fromString('234.20'), paid: true, note: 'İlk sipariş' },
        { _id: 11, customer_id: 2, total: Decimal128.fromString('8.48'), paid: false, note: null },
      ])
      const ada = await client.db('sqlimp').collection<{ _id: number }>('customers').findOne({ _id: 1 })
      expect(ada).toEqual({ _id: 1, name: 'Ada', since: new Date('2026-01-05T00:00:00Z') })
      // The DROP and CREATE INDEX were read, not run.
      expect(await client.db('sqlimp').collection('orders').indexes()).toHaveLength(1)
      expect(report).toMatchObject({ kind: 'importSql', mode: 'insert', dryRun: false })
      expect(report.tables).toEqual([
        expect.objectContaining({
          table: 'public.customers',
          collection: 'customers',
          read: 2,
          inserted: 2,
          failed: 0,
        }),
        expect.objectContaining({
          table: 'public.orders',
          collection: 'orders',
          read: 2,
          inserted: 2,
          failed: 0,
        }),
      ])
      expect(report.skipped).toMatchObject({ SET: 2, 'DROP TABLE': 1, 'CREATE INDEX': 1 })
    } finally {
      await h.t.close()
    }
  })

  it('leaves out a table not chosen, and reports a row it cannot read with its table and row', async () => {
    const h = await dataHarness(mongo)
    try {
      const { job, report } = await runImport(h, MYSQL, {
        tables: [{ table: 'users', collection: 'people' }],
      })
      expect(job.state).toBe('done')
      const people = await client.db('sqlimp').collection('people').find().sort({ _id: 1 }).toArray()
      expect(people).toEqual([
        { _id: 1, email: 'a@example.com', active: true },
        { _id: 2, email: "it's@example.com", active: false },
      ])
      expect(report.tables[0]).toMatchObject({ read: 3, inserted: 2, failed: 1 })
      expect(report.errors[0]).toMatchObject({ table: 'users', record: 3 })
      expect(report.errors[0].reason).toContain('now()')
      expect(report.rejectedFile).toBe(true)
      const rejected = await h.get(`/api/transfer/jobs/${job.id}/rejected`)
      expect(rejected.statusCode).toBe(200)
      // Review M6: the whole row, as a statement that runs on its own once fixed.
      expect(rejected.body).toBe('INSERT INTO `users` VALUES (3,now(),1);\n')
    } finally {
      await h.t.close()
    }
  })

  it('writes nothing on a dry run; upserts a second import by the primary key', async () => {
    const h = await dataHarness(mongo)
    try {
      const tables = [{ table: 'public.orders', collection: 'orders' }]
      const dry = await runImport(h, PG, { tables, dryRun: true })
      expect(dry.job.state).toBe('done')
      expect(await client.db('sqlimp').collection('orders').countDocuments()).toBe(0)
      expect(dry.report.tables[0]).toMatchObject({ read: 2 })
      await runImport(h, PG, { tables })
      // The table not chosen is not written.
      expect(await client.db('sqlimp').listCollections({ name: 'customers' }).toArray()).toEqual([])
      await client
        .db('sqlimp')
        .collection<{ _id: number }>('orders')
        .updateOne({ _id: 10 }, { $set: { paid: false } })
      const again = await runImport(h, PG, { tables, mode: 'upsert' })
      expect(again.job.state).toBe('done')
      expect(again.report.tables[0]).toMatchObject({ matched: 2, modified: 1 })
      expect(
        await client.db('sqlimp').collection<{ _id: number }>('orders').findOne({ _id: 10 }),
      ).toMatchObject({
        paid: true,
      })
    } finally {
      await h.t.close()
    }
  }, 60_000)

  // Twenty-first and twenty-second reviews of explain masking (nit, M-5): asked once for every table.
  it('refuses an import whose table goes into a view, before it starts', async () => {
    const h = await dataHarness(mongo)
    try {
      await client.db('sqlimp').createCollection('base')
      await client.db('sqlimp').createCollection('orders', { viewOn: 'base', pipeline: [] })
      const uploadId = await upload(h, PG)
      const res = await importSql(h, uploadId, {
        tables: [
          { table: 'public.customers', collection: 'customers' },
          { table: 'public.orders', collection: 'orders' },
        ],
      })
      expect(res.statusCode, res.body).toBe(409)
      expect(res.json()).toMatchObject({ details: { reason: 'target_is_view', collection: 'orders' } })
      expect(await client.db('sqlimp').collection('customers').countDocuments()).toBe(0)
    } finally {
      await h.t.close()
    }
  })

  it('says when the dump itself ends cut short', async () => {
    const h = await dataHarness(mongo)
    try {
      const cut =
        "CREATE TABLE t (id int PRIMARY KEY, s text);\nINSERT INTO t VALUES (1, 'ok');\nINSERT INTO t VALUES (2, 'never closed"
      const { report } = await runImport(h, cut, { tables: [{ table: 't', collection: 't' }] })
      // Inside a row: that row fails, saying why.
      expect(report.tables[0]).toMatchObject({ inserted: 1, failed: 1 })
      expect(report.errors[0]).toMatchObject({ table: 't', record: 2 })
      expect(report.errors[0].reason).toContain('ends inside')
      // Outside any row (an open comment): the dump's own error.
      const comment = await runImport(
        h,
        'CREATE TABLE u (id int PRIMARY KEY);\nINSERT INTO u VALUES (1);\n/* never closed',
        {
          tables: [{ table: 'u', collection: 'u' }],
        },
      )
      expect(comment.report.dumpError).toBeTruthy()
      expect(comment.report.tables[0]).toMatchObject({ inserted: 1 })
      // Review 14: what was read is kept, but the job does not say it finished.
      expect(comment.job.state).toBe('failed')
      expect(comment.job.error).toContain('could not be read to its end')
      // With "stop", the job fails saying so, not "row 0 of" no table.
      await client.db('sqlimp').dropDatabase()
      const stop = await runImport(
        h,
        'CREATE TABLE u (id int PRIMARY KEY);\nINSERT INTO u VALUES (1);\n/* never closed',
        { tables: [{ table: 'u', collection: 'u' }], onError: 'stop' },
      )
      expect(stop.job.state).toBe('failed')
      expect(stop.job.error).toContain('could not be read to its end')
      expect(stop.report.dumpError).toBeTruthy()
    } finally {
      await h.t.close()
    }
  }, 60_000)

  it('refuses no table, a table twice, and a system collection, before any job', async () => {
    const h = await dataHarness(mongo)
    try {
      const uploadId = await upload(h, PG)
      const none = await importSql(h, uploadId, {
        tables: [{ table: 'public.orders', collection: 'o', include: false }],
      })
      expect(none.statusCode).toBe(400)
      const twice = await importSql(h, uploadId, {
        tables: [
          { table: 'public.orders', collection: 'a' },
          { table: 'public.orders', collection: 'b' },
        ],
      })
      expect(twice.statusCode).toBe(400)
      const system = await importSql(h, uploadId, {
        tables: [{ table: 'public.orders', collection: 'system.views' }],
      })
      expect(system.statusCode).toBe(400)
      const someoneElses = await importSql(h, '3b241101-e2bb-4255-8caf-4136c566a962', {
        tables: [{ table: 'public.orders', collection: 'o' }],
      })
      expect(someoneElses.statusCode).toBe(404)
      // Data review 2026-10-13 (M7): in upsert and merge, rows of two tables with the same key
      // would replace each other in one collection; each table goes to its own there.
      const shared = (mode: string) =>
        importSql(h, uploadId, {
          mode,
          tables: [
            { table: 'public.orders', collection: 'all' },
            { table: 'public.customers', collection: 'all' },
          ],
        })
      for (const mode of ['upsert', 'merge']) {
        const res = await shared(mode)
        expect([mode, res.statusCode]).toEqual([mode, 400])
        expect(res.json().message).toContain('its own collection')
      }
      expect((await shared('insert')).statusCode).toBe(202)
    } finally {
      await h.t.close()
    }
  })

  it('lets a viewer neither preview nor import, an editor not into a system database', async () => {
    const team = await teamHarness(mongo)
    try {
      const viewer = team.user('viewer')
      const editor = team.user('editor')
      const uploadId = await upload(editor, PG)
      expect((await viewer.call('POST', `/transfer/uploads/${uploadId}/sql-preview`, {})).statusCode).toBe(
        403,
      )
      expect(
        (await importSql(viewer, uploadId, { tables: [{ table: 'public.orders', collection: 'o' }] }))
          .statusCode,
      ).toBe(403)
      const admin = await editor.call('POST', '/databases/admin/import-sql', {
        uploadId,
        tables: [{ table: 'public.orders', collection: 'o' }],
      })
      expect(admin.statusCode).toBe(403)
      // Another user's upload is not theirs to import.
      const other = team.user('editor')
      expect(
        (await importSql(other, uploadId, { tables: [{ table: 'public.orders', collection: 'o' }] }))
          .statusCode,
      ).toBe(404)
    } finally {
      await team.t.close()
    }
  })

  // Review I1, M16, T: a preview that cannot read the file gives the user's preview back.
  it('gives the preview back when a file cannot be read; refuses a workbook; stops a gzip bomb', async () => {
    const h = await dataHarness(mongo)
    try {
      const reason = async (bytes: Buffer) => {
        const id = await upload(h, bytes)
        const res = await h.call('POST', `/transfer/uploads/${id}/sql-preview`, {})
        expect((await h.t.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200)
        return res.statusCode === 200 ? 'ok' : (res.json().details?.reason ?? res.json().code)
      }
      const ole = Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(600)])
      expect(await reason(ole)).not.toBe('ok')
      expect(await reason(ole)).not.toBe('preview_busy')
      expect(await reason(rawZip([{ name: 'xl/workbook.xml', data: Buffer.from('<x/>') }]))).toBe('not_sql')
      expect(await reason(hostile.gzipBomb(1000))).toBe('inflate')
      expect(await reason(Buffer.from(PG))).toBe('ok')
    } finally {
      await h.t.close()
    }
  })

  // Review I5: mysqldump without --hex-blob writes a BLOB's bytes as they are.
  it('imports a BLOB written as raw bytes as those very bytes', async () => {
    const h = await dataHarness(mongo)
    try {
      const dump = Buffer.concat([
        Buffer.from(
          "CREATE TABLE `f` (`id` int NOT NULL, `b` blob, `s` text, PRIMARY KEY (`id`));\nINSERT INTO `f` VALUES (1,_binary '",
        ),
        Buffer.from([0xff, 0xfe, 0x80, 0x41]),
        Buffer.from("','Çağrı');\n"),
      ])
      const { job } = await runImport(h, dump, { tables: [{ table: 'f', collection: 'f' }] })
      expect(job.state).toBe('done')
      const doc = await client.db('sqlimp').collection('f').findOne({})
      expect(Buffer.from((doc!.b as Binary).buffer).toString('hex')).toBe('fffe8041')
      expect(doc!.s).toBe('Çağrı')
    } finally {
      await h.t.close()
    }
  })

  it('reads a UTF-16 dump (as SQL Server and some Windows tools save them)', async () => {
    const h = await dataHarness(mongo)
    try {
      const text = "CREATE TABLE t (id int PRIMARY KEY, s text);\nINSERT INTO t VALUES (1, 'Çağrı');\n"
      const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
      const { job } = await runImport(h, utf16, { tables: [{ table: 't', collection: 't' }] })
      expect(job.state).toBe('done')
      expect(await client.db('sqlimp').collection('t').findOne({})).toEqual({ _id: 1, s: 'Çağrı' })
    } finally {
      await h.t.close()
    }
  })

  // Review I2: with "stop", rows are written in the dump's order, whatever their table.
  it('stops in the dump’s order when a write fails, the other table’s earlier rows kept', async () => {
    const h = await dataHarness(mongo)
    try {
      const dump =
        'CREATE TABLE a (id int PRIMARY KEY);\nCREATE TABLE b (id int PRIMARY KEY);\n' +
        'INSERT INTO b VALUES (1);\nINSERT INTO a VALUES (1),(1);\nINSERT INTO b VALUES (2);\n'
      const { job, report } = await runImport(h, dump, {
        tables: [
          { table: 'a', collection: 'a' },
          { table: 'b', collection: 'b' },
        ],
        onError: 'stop',
      })
      expect(job.state).toBe('failed')
      expect(await client.db('sqlimp').collection('b').find().toArray()).toEqual([{ _id: 1 }])
      expect(await client.db('sqlimp').collection('a').find().toArray()).toEqual([{ _id: 1 }])
      expect(report.stoppedAt).toEqual({ table: 'a', record: 2 })
      // What it wrote before it stopped (data review 2026-10-13).
      expect(report.unfinished).toEqual({ written: 2, notWritten: 0 })
      expect(report.tables.find((t: { table: string }) => t.table === 'b')).toMatchObject({
        read: 1,
        inserted: 1,
      })
    } finally {
      await h.t.close()
    }
  })

  it('audits the tables and counts, never a row', async () => {
    const h = await dataHarness(mongo)
    try {
      await runImport(h, PG, { tables: [{ table: 'public.orders', collection: 'orders' }] })
      const rows = h.t.app.ctx.audit
        .list({ limit: 20 })
        .filter((r) => r.action.startsWith('transfer.importSql'))
      expect(rows.map((r) => r.action).sort()).toEqual(['transfer.importSql', 'transfer.importSql.start'])
      expect(rows.find((r) => r.action === 'transfer.importSql')!.details).toMatchObject({
        tables: ['public.orders→orders'],
        inserted: 2,
      })
      expect(JSON.stringify(rows)).not.toContain('İlk sipariş')
      expect(JSON.stringify(rows)).not.toContain('234.20')
    } finally {
      await h.t.close()
    }
  })

  // Review I3: a dump's passes stop at the job's time limit.
  it('stops reading at the job’s time limit, writing nothing', async () => {
    const h = await dataHarness(mongo)
    try {
      const row = `'${'x'.repeat(200)}'`
      const big =
        'CREATE TABLE big (id int PRIMARY KEY, s text);\n' +
        Array.from({ length: 40_000 }, (_, i) => `INSERT INTO big VALUES (${i}, ${row});`).join('\n')
      const uploadId = await upload(h, big)
      h.t.app.ctx.transfer.limits.maxJobMs = 5
      const res = await importSql(h, uploadId, { tables: [{ table: 'big', collection: 'big' }] })
      const job = await waitJob(h.t, res.json().job.id)
      expect(job.state).toBe('failed')
      expect(job.error).toContain('longer than allowed')
      expect(await client.db('sqlimp').collection('big').countDocuments()).toBe(0)
    } finally {
      await h.t.close()
    }
  })

  it('previews a dump too big to read in time as cut short, saying so', async () => {
    const h = await dataHarness(mongo)
    try {
      const row = `'${'x'.repeat(200)}'`
      const big =
        'CREATE TABLE big (id int PRIMARY KEY, s text);\n' +
        Array.from({ length: 40_000 }, (_, i) => `INSERT INTO big VALUES (${i}, ${row});`).join('\n')
      const uploadId = await upload(h, big)
      h.t.app.ctx.transfer.limits.previewMs = 1
      const res = await h.call('POST', `/transfer/uploads/${uploadId}/sql-preview`, {})
      expect(res.statusCode).toBe(200)
      expect(res.json().truncated).toBe(true)
    } finally {
      await h.t.close()
    }
  })

  it('says why a table or the dump cannot be read, in the preview', async () => {
    const h = await dataHarness(mongo)
    try {
      const cols = Array.from({ length: 1001 }, (_, i) => `c${i} int`).join(', ')
      const dump = `CREATE TABLE wide (${cols});\nCREATE TABLE ok (id int);\nINSERT INTO ok VALUES (1);\n/* never closed`
      const id = await upload(h, dump)
      const preview = (await h.call('POST', `/transfer/uploads/${id}/sql-preview`, {})).json()
      expect(preview.error).toBeTruthy()
      const wide = preview.tables.find((t: { key: string }) => t.key === 'wide')
      expect(wide.error).toBeTruthy()
      // Review M17: of a table read, the first 200 columns are listed, with how many there are.
      const many = Array.from({ length: 300 }, (_, i) => `c${i} int`).join(', ')
      const id2 = await upload(h, `CREATE TABLE many (${many});\n`)
      const listed = (await h.call('POST', `/transfer/uploads/${id2}/sql-preview`, {})).json().tables[0]
      expect(listed.columns).toHaveLength(200)
      expect(listed.columnCount).toBe(300)
      expect(preview.tables.find((t: { key: string }) => t.key === 'ok').error).toBeUndefined()
    } finally {
      await h.t.close()
    }
  })

  it('refuses a read-only connection', async () => {
    const team = await teamHarness(mongo, {}, { readOnly: true })
    try {
      const admin = team.user('admin')
      const id = '3b241101-e2bb-4255-8caf-4136c566a962'
      expect((await admin.call('POST', `/transfer/uploads/${id}/sql-preview`, {})).statusCode).toBe(403)
      expect(
        (await importSql(admin, id, { tables: [{ table: 'public.orders', collection: 'o' }] })).statusCode,
      ).toBe(403)
    } finally {
      await team.t.close()
    }
  })
})
