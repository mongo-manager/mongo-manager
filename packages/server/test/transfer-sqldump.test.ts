// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Binary, Decimal128, Double, Long } from 'bson'
import {
  readSqlDump,
  scanSqlDump,
  type SqlReadOptions,
  type SqlRecord,
} from '../src/transfer/formats/sqldump'
import { isFailure, type DocRecord, type RecordFailure } from '../src/transfer/formats/types'
import { mutate, rng } from './support/fuzz'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sql')
const fixture = (name: string) => readFileSync(join(FIXTURES, name))
const MYSQL = fixture('mysqldump.sql')
const PG = fixture('pgdump.sql')

const SQLITE = [
  'PRAGMA foreign_keys=OFF;',
  'BEGIN TRANSACTION;',
  'CREATE TABLE notes(id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT, data BLOB, rating REAL, flag BOOLEAN, misc);',
  "INSERT INTO notes VALUES(1,'hello',X'DEADBEEF',4.5,1,'x');",
  "INSERT INTO notes VALUES(2,'it''s',NULL,NULL,0,42);",
  "INSERT INTO \"notes\" VALUES(3,'C:\\path\\',NULL,1e3,'t',3.25);",
  'DELETE FROM sqlite_sequence;',
  "INSERT INTO sqlite_sequence VALUES('notes',3);",
  'CREATE INDEX notes_body ON notes(body);',
  'CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN',
  "  UPDATE notes SET body = CASE WHEN new.body IS NULL THEN '' ELSE new.body END WHERE id = new.id;",
  "  INSERT INTO notes VALUES (99, 'it''s; fine', NULL, NULL, 0, NULL);",
  'END;',
  'CREATE VIEW v AS SELECT * FROM notes;',
  'COMMIT;',
  '',
].join('\n')

async function* chunks(...parts: Array<string | Buffer>): AsyncGenerator<string | Buffer> {
  for (const p of parts) yield p
}
async function* bytesBy(buf: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size)
}
async function collect(it: AsyncIterable<SqlRecord>): Promise<SqlRecord[]> {
  const out: SqlRecord[] = []
  for await (const r of it) out.push(r)
  return out
}
const read = (input: AsyncIterable<string | Buffer>, tables: string[], more: Partial<SqlReadOptions> = {}) =>
  collect(readSqlDump(input, { tables: new Set(tables), primaryKeyAsId: true, ...more }))
const docs = (recs: SqlRecord[], table: string) =>
  recs.filter((r) => r.table === table && !isFailure(r.record)).map((r) => (r.record as DocRecord).doc)
const fails = (recs: SqlRecord[], table?: string) =>
  recs
    .filter((r) => (table === undefined || r.table === table) && isFailure(r.record))
    .map((r) => r.record as RecordFailure)
const utc = (s: string) => new Date(s)

// Data review 2026-10-13 (H2): our own export carries no MySQL or PostgreSQL marker; the first \' or
// \\ made the reader take it for MySQL, so \\server\share came back \servershare, C:\new with a
// newline, and a value ending in \ failed the import. Its "-- Dialect:" line names the dialect.
describe('SQL dump reading: our own export, by its dialect line', () => {
  const ours = (dialect: string, rows: string[]) =>
    [
      '-- Mongo Manager export',
      '-- Table: paths',
      `-- Dialect: ${dialect}`,
      '-- Exported: 2026-10-13T00:00:00.000Z',
      '',
      'CREATE TABLE "paths" ("id" INTEGER PRIMARY KEY, "p" TEXT);',
      ...rows,
      '',
    ].join('\n')
  it('reads backslashes as they are in SQLite and PostgreSQL text', async () => {
    const rows = [
      String.raw`INSERT INTO "paths" ("id", "p") VALUES (1, '\\server\share');`,
      String.raw`INSERT INTO "paths" ("id", "p") VALUES (2, 'C:\new');`,
      String.raw`INSERT INTO "paths" ("id", "p") VALUES (3, 'ends\');`,
      String.raw`INSERT INTO "paths" ("id", "p") VALUES (4, 'it''s');`,
    ]
    for (const dialect of ['SQLite', 'PostgreSQL']) {
      const recs = await read(chunks(ours(dialect, rows)), ['paths'])
      expect([dialect, fails(recs)]).toEqual([dialect, []])
      expect(docs(recs, 'paths').map((d) => d.p)).toEqual([
        String.raw`\\server\share`,
        String.raw`C:\new`,
        'ends\\',
        "it's",
      ])
    }
  })
})

describe('SQL dump reading: mysqldump', () => {
  it('scans tables, columns, kinds, primary keys, rows, samples and skipped statements', async () => {
    const scan = await scanSqlDump(chunks(MYSQL))
    expect(scan.dialect).toBe('mysql')
    expect(scan.truncated).toBe(false)
    expect(scan.tables.map((t) => [t.key, t.name, t.rows])).toEqual([
      ['customers', 'customers', 3],
      ['events', 'events', 5],
    ])
    const c = scan.tables[0]!
    expect(c.primaryKey).toEqual(['id'])
    expect(c.columns.map((x) => [x.name, x.type, x.kind])).toEqual([
      ['id', 'int unsigned', 'int'],
      ['name', 'varchar(100)', 'string'],
      ['balance', 'decimal(12,2)', 'decimal'],
      ['active', 'tinyint(1)', 'bool'],
      ['created_at', 'datetime(6)', 'date'],
      ['prefs', 'json', 'json'],
      ['avatar', 'blob', 'binary'],
      ['score', 'double', 'double'],
      ['big', 'bigint unsigned', 'long'],
      ['born', 'date', 'date'],
    ])
    expect(c.samples).toHaveLength(3)
    expect(c.samples[0]!._id).toBe(1)
    const e = scan.tables[1]!
    expect(e.columns.map((x) => x.kind)).toEqual(['long', 'bool', 'binary', 'int', 'date'])
    expect(e.samples).toHaveLength(3)
    expect(scan.skipped).toMatchObject({
      'DROP TABLE': 2,
      LOCK: 2,
      UNLOCK: 2,
      'ALTER TABLE': 2,
      'CREATE PROCEDURE': 1,
      'CREATE TRIGGER': 1,
      DELIMITER: 4,
      INSERT: 1,
    })
    expect(scan.skipped.SET).toBeGreaterThanOrEqual(10)
  })

  it('reads rows: backslash escapes, decimals, dates, tinyint(1), json, hex blobs, unsigned bigint', async () => {
    const recs = await read(chunks(MYSQL), ['customers'])
    expect(recs.every((r) => r.table === 'customers')).toBe(true)
    const [a, b, c] = docs(recs, 'customers')
    expect(a).toEqual({
      _id: 1,
      name: "Ali O'Brien",
      balance: Decimal128.fromString('1234.50'),
      active: true,
      created_at: utc('2026-01-02T03:04:05.123Z'),
      prefs: { tags: ['a', 'b'], n: 5 },
      avatar: new Binary(Buffer.from([1, 2, 255])),
      score: new Double(1.5),
      big: Decimal128.fromString('18446744073709551615'),
      born: utc('1990-05-06T00:00:00Z'),
    })
    expect(Object.keys(a!)[0]).toBe('_id')
    expect(b).toMatchObject({
      _id: 2,
      name: 'Ayşe\\Line\nTwo',
      balance: Decimal128.fromString('-0.01'),
      active: false,
      created_at: null,
      prefs: null,
      score: new Double(-0.0025),
      big: Long.fromNumber(42),
      born: null,
    })
    expect(c).toMatchObject({
      _id: 3,
      name: 'Tab\there; semi "q" \x1a\0end',
      prefs: 'not json',
      avatar: new Binary(Buffer.alloc(0)),
      born: null,
    })
    const first = recs[0]!.record as DocRecord
    expect(first.n).toBe(1)
    expect(first.raw.startsWith("INSERT INTO `customers` VALUES (1,'Ali O\\'Brien'")).toBe(true)
    expect(first.raw.endsWith("'1990-05-06');")).toBe(true)
  })

  it('reads a column list, bit(1), _binary, DEFAULT, a string in an int column, and fails bad rows', async () => {
    const recs = await read(chunks(MYSQL), ['events'])
    const rows = docs(recs, 'events')
    expect(rows).toEqual([
      {
        _id: Long.fromNumber(10),
        flag: true,
        payload: new Binary(Buffer.from('a\0b')),
        count: 7,
        at: utc('2026-05-06T07:08:09Z'),
      },
      { _id: Long.fromNumber(11), flag: false, payload: null, count: 'abc', at: null },
      { _id: Long.fromNumber(14), flag: null, payload: null, at: null },
    ])
    const bad = fails(recs, 'events')
    expect(bad.map((f) => f.n)).toEqual([3, 4])
    expect(bad[0]!.error).toContain('now() is a function call')
    expect(bad[0]!.raw).toBe(
      'INSERT INTO `events` (`id`, `flag`, `payload`, `count`, `at`) VALUES (12,NULL,NULL,now(),NULL);',
    )
    expect(bad[1]!.error).toBe('The row has 3 values for 5 columns')
  })

  it('never reads statements inside conditional comments, procedures or triggers', async () => {
    const recs = await read(chunks(MYSQL), ['customers', 'events'])
    const ids = recs.filter((r) => !isFailure(r.record)).map((r) => String((r.record as DocRecord).doc._id))
    expect(ids).not.toContain('77')
    expect(ids).not.toContain('88')
    expect(ids).not.toContain('99')
  })

  it('keeps the primary key under its own name when asked', async () => {
    const recs = await read(chunks(MYSQL), ['customers'], { primaryKeyAsId: false })
    expect(docs(recs, 'customers')[0]).toMatchObject({ id: 1, name: "Ali O'Brien" })
    expect(docs(recs, 'customers')[0]!._id).toBeUndefined()
  })

  it('counts skipped statements into the caller’s record while reading', async () => {
    const skipped: Record<string, number> = {}
    await read(chunks(MYSQL), ['customers'], { skipped })
    expect(skipped).toMatchObject({ 'DROP TABLE': 2, LOCK: 2, 'CREATE TRIGGER': 1 })
    expect(skipped.SET).toBeGreaterThanOrEqual(10)
  })
})

describe('SQL dump reading: pg_dump', () => {
  it('scans COPY tables, the primary key from ALTER TABLE, and skips functions with $$ bodies', async () => {
    const scan = await scanSqlDump(chunks(PG))
    expect(scan.dialect).toBe('postgres')
    expect(scan.tables.map((t) => [t.key, t.name, t.schema, t.rows])).toEqual([
      ['public.orders', 'orders', 'public', 2],
      ['public.items', 'items', 'public', 5],
    ])
    const o = scan.tables[0]!
    expect(o.primaryKey).toEqual(['id'])
    expect(o.columns.map((x) => [x.type, x.kind])).toEqual([
      ['integer', 'int'],
      ['character varying(100)', 'string'],
      ['numeric(10,2)', 'decimal'],
      ['boolean', 'bool'],
      ['timestamp with time zone', 'date'],
      ['jsonb', 'json'],
      ['text[]', 'string'],
      ['bytea', 'binary'],
      ['text', 'string'],
    ])
    // The primary key came after the data: the samples still carry it as _id.
    expect(o.samples[0]!._id).toBe(1)
    expect(scan.tables[1]!.primaryKey).toEqual(['order_id', 'sku'])
    expect(scan.skipped).toMatchObject({
      'CREATE FUNCTION': 2,
      'ALTER FUNCTION': 1,
      'CREATE SEQUENCE': 1,
      'ALTER SEQUENCE': 1,
      'ALTER TABLE': 3,
      'CREATE INDEX': 1,
      'CREATE TRIGGER': 1,
      SELECT: 2,
    })
  })

  it('reads COPY rows with \\N, escapes, octal UTF-8, bytea and zones', async () => {
    const recs = await read(chunks(PG), ['public.orders'], { primaryKeys: { 'public.orders': ['id'] } })
    expect(fails(recs)).toEqual([])
    const [a, b] = docs(recs, 'public.orders')
    expect(a).toEqual({
      _id: 1,
      customer: 'Zeynep Çelik',
      total: Decimal128.fromString('99.95'),
      paid: true,
      placed: utc('2026-03-04T02:06:07Z'),
      meta: { vip: true, n: 1 },
      tags: '{a,b}',
      blob: new Binary(Buffer.from([1, 255])),
      note: 'line1\nline2\ttabbed',
    })
    expect(b).toEqual({
      _id: 2,
      customer: 'Bob',
      total: null,
      paid: false,
      placed: utc('2026-03-04T05:06:07.500Z'),
      meta: null,
      tags: null,
      blob: null,
      note: 'back\\slash \\N',
    })
    expect((recs[0]!.record as DocRecord).raw).toBe(
      'COPY public.orders (id, customer, total, paid, placed, meta, tags, blob, note) FROM stdin;\n' +
        '1\tZeynep \\303\\207elik\t99.95\tt\t2026-03-04 05:06:07+03\t{"vip": true, "n": 1}\t{a,b}\t\\\\x01ff\tline1\\nline2\\ttabbed\n\\.',
    )
  })

  it('reads INSERTs: E strings, standard strings, casts, OVERRIDING, ON CONFLICT; a composite key stays', async () => {
    const recs = await read(chunks(PG), ['public.items'])
    expect(docs(recs, 'public.items')).toEqual([
      { order_id: 1, sku: 'A-1', qty: 2 },
      { order_id: 1, sku: "B'2\\nAA", qty: 3 },
      { order_id: 2, sku: "C'3\\", qty: null },
      { order_id: 3, sku: '{1,2}', qty: 7 },
    ])
    const bad = fails(recs)
    expect(bad).toHaveLength(1)
    expect(bad[0]).toMatchObject({ n: 4 })
    expect(bad[0]!.error).toContain('now() is a function call')
  })

  it('without the scanned primary keys a key declared after the data stays a field', async () => {
    const recs = await read(chunks(PG), ['public.orders'])
    expect(docs(recs, 'public.orders')[0]).toMatchObject({ id: 1 })
  })
})

describe('SQL dump reading: sqlite3 .dump and plain SQL', () => {
  it('reads a sqlite dump: no backslash escapes, typeless columns, triggers skipped whole', async () => {
    const scan = await scanSqlDump(chunks(SQLITE))
    expect(scan.dialect).toBe('sqlite')
    expect(scan.tables.map((t) => [t.key, t.rows])).toEqual([['notes', 3]])
    expect(scan.tables[0]!.columns.map((c) => c.kind)).toEqual([
      'int',
      'string',
      'binary',
      'double',
      'bool',
      'unknown',
    ])
    expect(scan.skipped).toMatchObject({
      PRAGMA: 1,
      BEGIN: 1,
      COMMIT: 1,
      DELETE: 1,
      INSERT: 1,
      'CREATE INDEX': 1,
      'CREATE TRIGGER': 1,
      'CREATE VIEW': 1,
    })
    const recs = await read(chunks(SQLITE), ['notes'])
    expect(docs(recs, 'notes')).toEqual([
      {
        _id: 1,
        body: 'hello',
        data: new Binary(Buffer.from('deadbeef', 'hex')),
        rating: new Double(4.5),
        flag: true,
        misc: 'x',
      },
      { _id: 2, body: "it's", data: null, rating: null, flag: false, misc: 42 },
      {
        _id: 3,
        body: 'C:\\path\\',
        data: null,
        rating: new Double(1000),
        flag: true,
        misc: new Double(3.25),
      },
    ])
  })

  // Data review 2026-10-13 (low): an integer longer than Decimal128 holds (34 digits) became a
  // rounded double. It is kept exactly, as its text — in a typed column and an untyped one alike.
  it('keeps an integer too long for Decimal128 exactly, as text', async () => {
    const huge = '1234567890123456789012345678901234567' // 37 digits
    const sql =
      'CREATE TABLE n (id INT, big NUMERIC(40, 0), any_ BIGINT);\n' +
      `INSERT INTO n (id, big, any_) VALUES (1, ${huge}, -${huge});\n` +
      `INSERT INTO m (a) VALUES (${huge});\n`
    const recs = await read(chunks(sql), ['n', 'm'])
    expect(docs(recs, 'n')).toEqual([{ id: 1, big: huge, any_: `-${huge}` }])
    expect(docs(recs, 'm')).toEqual([{ a: huge }])
  })

  it('without CREATE TABLE: a column list keeps literal kinds; no column list is a failure per row', async () => {
    const sql =
      "INSERT INTO t VALUES (1,'a'),(2,'b');\n" +
      "INSERT INTO u (a, b, c, d) VALUES (1, 'x', TRUE, X'00ff'), (2.5, NULL, -7, 9999999999), (12345678901234567890123, '', FALSE, 0x41);\n"
    const scan = await scanSqlDump(chunks(sql))
    expect(scan.dialect).toBe('standard')
    expect(scan.tables.map((t) => [t.key, t.rows, t.columns.length])).toEqual([
      ['t', 2, 0],
      ['u', 3, 0],
    ])
    const recs = await read(chunks(sql), ['t', 'u'])
    expect(fails(recs, 't')).toEqual([
      { n: 1, error: 'No column list and no CREATE TABLE for t', raw: "INSERT INTO t VALUES (1,'a');" },
      { n: 2, error: 'No column list and no CREATE TABLE for t', raw: "INSERT INTO t VALUES (2,'b');" },
    ])
    expect(docs(recs, 'u')).toEqual([
      { a: 1, b: 'x', c: true, d: new Binary(Buffer.from([0, 255])) },
      { a: new Double(2.5), b: null, c: -7, d: Long.fromString('9999999999') },
      {
        a: Decimal128.fromString('12345678901234567890123'),
        b: '',
        c: false,
        d: new Binary(Buffer.from('A')),
      },
    ])
  })

  it('reads only the chosen tables, in file order, and resolves names across schemas', async () => {
    const sql =
      'CREATE TABLE a (x int);\nCREATE TABLE s.b (x int);\n' +
      'INSERT INTO a VALUES (1);\nINSERT INTO b VALUES (2);\nINSERT INTO s.b VALUES (3);\nINSERT INTO a VALUES (4);\n'
    const recs = await read(chunks(sql), ['s.b'])
    expect(recs.map((r) => [r.table, (r.record as DocRecord).doc])).toEqual([
      ['s.b', { x: 2 }],
      ['s.b', { x: 3 }],
    ])
  })

  it('converts per column kind and keeps a contradicting literal as it is', async () => {
    const sql = [
      'CREATE TABLE k (i int, l bigint, d decimal(5,2), f float, b boolean, t timestamp, j json, s varchar(9), y bytea);',
      "INSERT INTO k VALUES ('12', '-5', '1e2', '2.5', 'yes', '2026-01-02T03:04:05+03:00', '[1,{\"a\":null}]', 5, '\\x0a0b');",
      "INSERT INTO k VALUES ('x', 'y', 'z', 'w', 'maybe', 'soon', '{bad', 'q', 'plain');",
      "INSERT INTO k VALUES (3000000000, 9223372036854775808, 1.005, 1e400, 1, '2026-02-30', 'null', TRUE, NULL);",
      "INSERT INTO k VALUES (NULL, NULL, 'NaN', 'Infinity', 'f', '2026-01-02 03:04:05.1234567-0230', '\"s\"', NULL, NULL);",
    ].join('\n')
    const recs = await read(chunks(sql), ['k'])
    expect(fails(recs)).toEqual([])
    const [a, b, c, d] = docs(recs, 'k')
    expect(a).toEqual({
      i: 12,
      l: Long.fromNumber(-5),
      d: Decimal128.fromString('1e2'),
      f: new Double(2.5),
      b: true,
      t: utc('2026-01-02T00:04:05Z'),
      j: [1, { a: null }],
      s: '5',
      y: new Binary(Buffer.from([10, 11])),
    })
    expect(b).toEqual({
      i: 'x',
      l: 'y',
      d: 'z',
      f: 'w',
      b: 'maybe',
      t: 'soon',
      j: '{bad',
      s: 'q',
      y: new Binary(Buffer.from('plain')),
    })
    expect(c).toEqual({
      i: Long.fromNumber(3000000000),
      l: Decimal128.fromString('9223372036854775808'),
      d: Decimal128.fromString('1.005'),
      f: '1e400',
      b: true,
      t: '2026-02-30',
      j: null,
      s: true,
      y: null,
    })
    expect(d).toMatchObject({ d: Decimal128.fromString('NaN'), f: new Double(Infinity), b: false, j: 's' })
    expect(d!.t).toEqual(utc('2026-01-02T05:34:05.123Z'))
  })

  it('handles COPY with CRLF lines, octal and hex escapes, and a table missing from the dump', async () => {
    const sql =
      'COPY x (a, b) FROM stdin;\r\n1\t\\x41\\102\\\\\r\n\\N\t\r\n\\.\r\nINSERT INTO x VALUES (5);\r\n'
    const recs = await read(chunks(sql), ['x'])
    expect(recs.map((r) => r.record)).toEqual([
      { n: 1, doc: { a: '1', b: 'AB\\' }, raw: 'COPY x (a, b) FROM stdin;\n1\t\\x41\\102\\\\\n\\.' },
      { n: 2, doc: { a: null, b: '' }, raw: 'COPY x (a, b) FROM stdin;\n\\N\t\n\\.' },
      { n: 3, error: 'No column list and no CREATE TABLE for x', raw: 'INSERT INTO x VALUES (5);' },
    ])
  })

  it('follows MySQL DELIMITER changes and treats a pg $tag$ body as one string', async () => {
    const sql =
      'DELIMITER //\nCREATE PROCEDURE p() BEGIN IF 1 THEN INSERT INTO t VALUES (9); END IF; INSERT INTO t VALUES (8); END //\nDELIMITER ;\n' +
      'CREATE TABLE t (a int);\nINSERT INTO t VALUES (1);\n'
    const recs = await read(chunks(sql), ['t'])
    expect(recs.map((r) => r.record)).toEqual([{ n: 1, doc: { a: 1 }, raw: 'INSERT INTO t VALUES (1);' }])
    const pg =
      "CREATE TABLE t (a int);\nCREATE FUNCTION f() RETURNS int AS $f$ SELECT 1; INSERT INTO t VALUES (9); ' $f$ LANGUAGE sql;\n" +
      'INSERT INTO t VALUES (2);\n'
    expect(docs(await read(chunks(pg), ['t']), 't')).toEqual([{ a: 2 }])
  })

  it('keeps MySQL databases apart after USE, and reads [bracketed] names and nested pg comments', async () => {
    const my =
      'USE `a`;\nCREATE TABLE `t` (`x` int);\nINSERT INTO `t` VALUES (1);\n' +
      'USE `b`;\nCREATE TABLE `t` (`x` int);\nINSERT INTO `t` VALUES (2);\nINSERT INTO `a`.`t` VALUES (3);\n'
    const scan = await scanSqlDump(chunks(my))
    expect(scan.tables.map((t) => [t.key, t.schema, t.name, t.rows])).toEqual([
      ['a.t', 'a', 't', 2],
      ['b.t', 'b', 't', 1],
    ])
    expect(docs(await read(chunks(my), ['a.t']), 'a.t')).toEqual([{ x: 1 }, { x: 3 }])
    const brackets =
      "CREATE TABLE [dbo].[t] ([id] int PRIMARY KEY, [n] text);\nINSERT INTO [dbo].[t] ([id], [n]) VALUES (1, 'a]b');\n"
    expect(docs(await read(chunks(brackets), ['dbo.t']), 'dbo.t')).toEqual([{ _id: 1, n: 'a]b' }])
    const pg =
      "SET search_path = public;\n/* a /* nested ' */ comment */\nCREATE TABLE t (a text);\nINSERT INTO t VALUES ('x');\n"
    expect(docs(await read(chunks(pg), ['t']), 't')).toEqual([{ a: 'x' }])
  })

  it('reads backslash escapes in pg strings when standard_conforming_strings is off', async () => {
    const sql =
      "SET standard_conforming_strings = off;\nCREATE TABLE t (a text);\nINSERT INTO t VALUES ('a\\'b\\\\c\\n');\n"
    expect(docs(await read(chunks(sql), ['t']), 't')).toEqual([{ a: "a'b\\c\n" }])
  })

  it('leaves the primary key a field when an _id column exists; IF NOT EXISTS; samples bounded', async () => {
    const sql =
      'CREATE TABLE IF NOT EXISTS t (k int PRIMARY KEY, _id text);\n' +
      "INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c');\n"
    expect(docs(await read(chunks(sql), ['t']), 't')[0]).toEqual({ k: 1, _id: 'a' })
    const scan = await scanSqlDump(chunks(sql), { samples: 2 })
    expect(scan.tables[0]!.primaryKey).toEqual(['k'])
    expect(scan.tables[0]!.samples).toEqual([
      { k: 1, _id: 'a' },
      { k: 2, _id: 'b' },
    ])
    expect(scan.tables[0]!.rows).toBe(3)
  })

  it('fails the rows of an INSERT whose column list is too long', async () => {
    const cols = Array.from({ length: 1100 }, (_, i) => `c${i}`).join(', ')
    const recs = await read(chunks(`INSERT INTO t (${cols}) VALUES (1);\nINSERT INTO t (c0) VALUES (2);\n`), [
      't',
    ])
    expect(fails(recs)).toEqual([{ n: 1, error: 'The INSERT column list is too long' }])
    expect(docs(recs, 't')).toEqual([{ c0: 2 }])
  })

  it('refuses unusual column names unless allowed, without touching prototypes', async () => {
    const sql =
      'CREATE TABLE t ("__proto__" text, "a.b" int, "$x" int);\nINSERT INTO t VALUES (\'{"polluted":1}\', 1, 2);\n'
    const refused = await read(chunks(sql), ['t'])
    expect(fails(refused)[0]!.error).toContain('__proto__')
    const allowed = await read(chunks(sql), ['t'], { allowUnusual: true })
    const doc = docs(allowed, 't')[0]!
    expect(Object.getPrototypeOf(doc)).toBe(Object.prototype)
    expect(Object.keys(doc)).toEqual(['__proto__', 'a.b', '$x'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('SQL dump reading: chunks and encodings', () => {
  it('gives identical results with one byte per chunk', async () => {
    for (const [buf, tables] of [
      [MYSQL, ['customers', 'events']],
      [PG, ['public.orders', 'public.items']],
      [Buffer.from(SQLITE), ['notes']],
    ] as const) {
      const whole = await read(chunks(buf), [...tables])
      const bytes = await read(bytesBy(buf, 1), [...tables])
      expect(bytes).toEqual(whole)
      expect(await scanSqlDump(bytesBy(buf, 1))).toEqual(await scanSqlDump(chunks(buf)))
    }
  })

  it('gives identical results for every two-chunk split of a small dump', async () => {
    const text =
      "CREATE TABLE `t` (`a` int, `b` text);\n/*!40000 x */;\nINSERT INTO `t` VALUES (1,'x\\'y;--'),(-2,'ü😀');\n" +
      'COPY t (a, b) FROM stdin;\n3\tz\\tw\n\\.\n'
    const buf = Buffer.from(text)
    const whole = await read(chunks(buf), ['t'])
    expect(docs(whole, 't')).toEqual([
      { a: 1, b: "x'y;--" },
      { a: -2, b: 'ü😀' },
      { a: 3, b: 'z\tw' },
    ])
    for (let cut = 1; cut < buf.length; cut++)
      expect(await read(chunks(buf.subarray(0, cut), buf.subarray(cut)), ['t'])).toEqual(whole)
  })

  it('splits multibyte UTF-8 (Turkish, emoji) across chunks', async () => {
    const buf = Buffer.from("CREATE TABLE t (s text);\nINSERT INTO t VALUES ('ğüşıöçİ — 😀👍🏽');\n")
    for (const size of [1, 2, 3, 5, 7])
      expect(docs(await read(bytesBy(buf, size), ['t']), 't')).toEqual([{ s: 'ğüşıöçİ — 😀👍🏽' }])
  })

  it('accepts decoded text chunks and a UTF-8 byte order mark', async () => {
    const sql = "CREATE TABLE t (s text);\nINSERT INTO t VALUES ('a');\n"
    expect(docs(await read(chunks(...sql.split('')), ['t']), 't')).toEqual([{ s: 'a' }])
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(sql)])
    expect(docs(await read(chunks(bom), ['t']), 't')).toEqual([{ s: 'a' }])
    // A UTF-16 dump (Windows redirection), by its byte order mark, cut anywhere.
    const text = "CREATE TABLE t (s text);\nINSERT INTO t VALUES ('ğü 😀');\n"
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    const be = Buffer.from(le).swap16()
    for (const buf of [le, be])
      for (const size of [1, 3, 1000])
        expect(docs(await read(bytesBy(buf, size), ['t']), 't')).toEqual([{ s: 'ğü 😀' }])
    // A table name in UTF-8 resolves the same in every chunking.
    const named = Buffer.from("CREATE TABLE şehir (ad text);\nINSERT INTO şehir VALUES ('İzmir');\n")
    expect(docs(await read(bytesBy(named, 1), ['şehir']), 'şehir')).toEqual([{ ad: 'İzmir' }])
  })

  it('fails only the row holding invalid UTF-8', async () => {
    const buf = Buffer.concat([
      Buffer.from("CREATE TABLE t (s text);\nINSERT INTO t VALUES ('ok'),('"),
      Buffer.from([0xc3, 0x28]),
      Buffer.from("'),('fine');\n"),
    ])
    const recs = await read(chunks(buf), ['t'])
    expect(docs(recs, 't')).toEqual([{ s: 'ok' }, { s: 'fine' }])
    expect(fails(recs)[0]).toMatchObject({ n: 2 })
    expect(fails(recs)[0]!.error).toContain('UTF-8')
  })
})

describe('SQL dump reading: hostile input', () => {
  it('ends with a failure at an unterminated string or comment; the scan is truncated', async () => {
    const sql = "CREATE TABLE t (a text);\nINSERT INTO t VALUES ('ok'),('never ends);\n"
    const recs = await read(chunks(sql), ['t'])
    expect(docs(recs, 't')).toEqual([{ a: 'ok' }])
    expect(fails(recs)).toEqual([{ n: 2, error: 'The dump ends inside a string' }])
    const scan = await scanSqlDump(chunks(sql))
    expect(scan.truncated).toBe(true)
    expect(scan.error).toBe('The dump ends inside a string')
    const comment = await read(chunks('SELECT 1; /* open'), ['t'])
    expect(comment).toEqual([{ table: '', record: { n: 0, error: 'The dump ends inside a comment' } }])
    expect((await scanSqlDump(chunks('COPY t (a) FROM stdin;\n1\n'))).error).toContain('COPY')
  })

  it('fails a statement over 64 MiB, skips to its end and reads on', async () => {
    const mib = 'a'.repeat(1024 * 1024)
    async function* huge(): AsyncGenerator<string> {
      yield "CREATE TABLE t (a text);\nINSERT INTO t VALUES ('first'),('"
      for (let i = 0; i < 70; i++) yield mib
      yield "'),('lost');\nINSERT INTO t VALUES ('after');\n"
    }
    const recs = await read(huge(), ['t'])
    expect(docs(recs, 't')).toEqual([{ a: 'first' }, { a: 'after' }])
    const bad = fails(recs)
    expect(bad).toHaveLength(1)
    expect(bad[0]!.n).toBe(2)
    expect(bad[0]!.error).toContain('64 MiB')
    expect(bad[0]!.raw).toBe('-- row 2 of t: over the size limit')
    const scan = await scanSqlDump(huge())
    expect(scan.tables[0]!.rows).toBe(3)
  })

  it('fails a row over 16 MiB and keeps the rest of the statement', async () => {
    const big = 'b'.repeat(17 * 1024 * 1024)
    const recs = await read(chunks(`CREATE TABLE t (a text);\nINSERT INTO t VALUES ('${big}'),('ok');\n`), [
      't',
    ])
    expect(fails(recs)[0]).toMatchObject({ n: 1, raw: '-- row 1 of t: over the size limit' })
    expect(fails(recs)[0]!.error).toContain('16 MiB')
    expect(docs(recs, 't')).toEqual([{ a: 'ok' }])
    // Each value under the limit, the row over it.
    const nine = 'n'.repeat(9 * 1024 * 1024)
    const wide = await read(
      chunks(`CREATE TABLE t (a text, b text);\nINSERT INTO t VALUES ('${nine}', '${nine}'),('x','y');\n`),
      ['t'],
    )
    expect(fails(wide).map((f) => [f.n, f.error])).toEqual([[1, 'The row is larger than 16 MiB']])
    expect(docs(wide, 't')).toEqual([{ a: 'x', b: 'y' }])
  })

  it('survives deeply nested parentheses', async () => {
    const deep = '('.repeat(200_000) + ')'.repeat(200_000)
    const sql = `CREATE TABLE t (a int);\nINSERT INTO t VALUES (${deep}),(1);\nCREATE TABLE u (a int CHECK ${deep});\nINSERT INTO u VALUES (2);\n`
    const recs = await read(chunks(sql), ['t', 'u'])
    expect(fails(recs, 't')).toHaveLength(1)
    expect(docs(recs, 't')).toEqual([{ a: 1 }])
    expect(docs(recs, 'u')).toEqual([{ a: 2 }])
  })

  it('stops the scan after 1,000 tables and refuses a table over 1,000 columns', async () => {
    let sql = ''
    for (let i = 0; i < 1001; i++) sql += `CREATE TABLE t${i} (a int);\n`
    const scan = await scanSqlDump(chunks(sql))
    expect(scan.tables).toHaveLength(1000)
    expect(scan.truncated).toBe(true)
    const small = await scanSqlDump(chunks(sql), { maxTables: 3 })
    expect(small.tables).toHaveLength(3)
    const cols = Array.from({ length: 1001 }, (_, i) => `c${i} int`).join(', ')
    const wide = `CREATE TABLE w (${cols});\nINSERT INTO w VALUES (1);\n`
    expect((await scanSqlDump(chunks(wide))).tables[0]!.error).toContain('1,000 columns')
    expect(fails(await read(chunks(wide), ['w']))[0]!.error).toContain('1,000 columns')
  })

  it('fails a value list longer than the columns', async () => {
    const recs = await read(chunks('CREATE TABLE t (a int);\nINSERT INTO t VALUES (1, 2, 3);\n'), ['t'])
    expect(fails(recs)).toEqual([
      { n: 1, error: 'The row has 3 values for 1 columns', raw: 'INSERT INTO t VALUES (1, 2, 3);' },
    ])
    const many = '(' + Array.from({ length: 5000 }, () => '1').join(',') + ')'
    const more = await read(chunks(`CREATE TABLE t (a int);\nINSERT INTO t VALUES ${many};\n`), ['t'])
    expect(fails(more)[0]!.error).toBe('The row has 5000 values for 1 columns')
  })

  it('never throws on mutated dumps', async () => {
    const r = rng(7)
    for (let i = 0; i < 150; i++) {
      const base = [MYSQL, PG, Buffer.from(SQLITE)][i % 3]!
      const bad = mutate(base, r)
      await scanSqlDump(bytesBy(bad, 1 + (i % 50)))
      await read(bytesBy(bad, 3 + (i % 70)), [
        'customers',
        'events',
        'public.orders',
        'public.items',
        'notes',
        '',
      ])
    }
  })
})

describe('SQL dump reading: review findings', () => {
  const rowsByTable = (recs: SqlRecord[]) => {
    const out: Record<string, number> = {}
    for (const r of recs) out[r.table] = (out[r.table] ?? 0) + 1
    return out
  }

  it('resolves every table name the same way in the scan and the read (finding 4)', async () => {
    const sql = [
      'CREATE TABLE c1 (x int);',
      'INSERT INTO c1 VALUES (1);',
      'INSERT INTO n1 (x) VALUES (2);',
      'INSERT INTO a.t (x) VALUES (3);',
      'INSERT INTO b.t (x) VALUES (4);',
      'INSERT INTO t (x) VALUES (5);',
      'CREATE TABLE s.q (x int);',
      'INSERT INTO q VALUES (6);',
      'INSERT INTO s.q VALUES (7);',
      'USE `d`;',
      'CREATE TABLE `u` (`x` int);',
      'INSERT INTO `u` VALUES (8);',
      'INSERT INTO `d`.`u` VALUES (9);',
      'INSERT INTO c1 VALUES (10);',
      '',
    ].join('\n')
    const scan = await scanSqlDump(chunks(sql))
    const rows = Object.fromEntries(scan.tables.map((t) => [t.key, t.rows]))
    expect(rows).toEqual({ c1: 2, n1: 1, 'a.t': 1, 'b.t': 1, t: 1, 's.q': 2, 'd.u': 2 })
    // Every table alone, a pair whose bare name is ambiguous, and all of them: the same rows.
    const choices = [...scan.tables.map((t) => [t.key]), ['a.t', 't'], scan.tables.map((t) => t.key)]
    for (const chosen of choices) {
      const got = rowsByTable(await read(chunks(sql), chosen))
      expect(got).toEqual(Object.fromEntries(chosen.map((k) => [k, rows[k]])))
    }
    const pair = await read(chunks(sql), ['a.t', 't'])
    expect(docs(pair, 't')).toEqual([{ x: 5 }])
    expect(docs(pair, 'a.t')).toEqual([{ x: 3 }])
  })

  it('reads raw bytes of MySQL BLOBs and _binary strings without --hex-blob (finding 5)', async () => {
    const buf = Buffer.concat([
      Buffer.from(
        "CREATE TABLE `b` (`id` int, `v` blob, `w` varbinary(4), `s` text);\nINSERT INTO `b` VALUES (1,'",
      ),
      Buffer.from([0xff, 0xfe, 0x80]),
      Buffer.from("\\0',_binary '"),
      Buffer.from([0xc3, 0x28]),
      Buffer.from("','ok ğ😀'),(2,NULL,NULL,'"),
      Buffer.from([0xff]),
      Buffer.from("'),(3,_binary '"),
      Buffer.from([0xff]),
      Buffer.from("');\nINSERT INTO x (a) VALUES (_binary '"),
      Buffer.from([0x80, 0x00]),
      Buffer.from("');\n"),
    ])
    const expected = async (input: AsyncIterable<Buffer | string>) => {
      const recs = await read(input, ['b', 'x'])
      expect(docs(recs, 'b')).toEqual([
        {
          id: 1,
          v: new Binary(Buffer.from([0xff, 0xfe, 0x80, 0])),
          w: new Binary(Buffer.from([0xc3, 0x28])),
          s: 'ok ğ😀',
        },
      ])
      expect(docs(recs, 'x')).toEqual([{ a: new Binary(Buffer.from([0x80, 0])) }])
      const bad = fails(recs, 'b')
      expect(bad.map((f) => [f.n, f.error])).toEqual([
        [2, 'Value 4 (s): The text is not valid UTF-8'],
        [3, 'The row has 2 values for 4 columns'],
      ])
      // The rejected row stays loadable: bytes that are no text are written as hex.
      expect(bad[1]!.raw).toBe("INSERT INTO `b` VALUES (3,_binary X'ff');")
      return recs
    }
    const whole = await expected(chunks(buf))
    expect(await expected(bytesBy(buf, 1))).toEqual(whole)
  })

  it('keeps the whole row as a statement that loads on its own (finding 6)', async () => {
    const long = 'L'.repeat(10_000)
    const sql = `CREATE TABLE "My T" (a text, b int);\nINSERT INTO "My T" ("a", b) VALUES ('${long}', now()), ('x', 1);\n`
    const recs = await read(chunks(sql), ['My T'])
    expect(fails(recs)[0]!.raw).toBe(`INSERT INTO "My T" ("a", b) VALUES ('${long}', now());`)
    expect((recs[1]!.record as DocRecord).raw).toBe(`INSERT INTO "My T" ("a", b) VALUES ('x', 1);`)
    // The same over many small chunks.
    expect(await read(bytesBy(Buffer.from(sql), 700), ['My T'])).toEqual(recs)
  })

  it("takes \\' or \\\\ in a string of an unmarked dump as MySQL; the dialect can be forced (finding 13)", async () => {
    const sql =
      "CREATE TABLE t (a text);\nINSERT INTO t VALUES ('it\\'s'),('back\\\\slash');\nINSERT INTO t VALUES ('z');\n"
    const scan = await scanSqlDump(chunks(sql))
    expect(scan.dialect).toBe('mysql')
    expect(scan.truncated).toBe(false)
    expect(docs(await read(chunks(sql), ['t']), 't')).toEqual([
      { a: "it's" },
      { a: 'back\\slash' },
      { a: 'z' },
    ])
    const slashes = "CREATE TABLE t (a text);\nINSERT INTO t VALUES ('a\\\\b');\n"
    expect((await scanSqlDump(chunks(slashes))).dialect).toBe('mysql')
    expect(docs(await read(chunks(slashes), ['t']), 't')).toEqual([{ a: 'a\\b' }])
    const win = "CREATE TABLE t (a text);\nINSERT INTO t VALUES ('C:\\'),('D:\\');\n"
    expect(docs(await read(chunks(win), ['t'], { dialect: 'standard' }), 't')).toEqual([
      { a: 'C:\\' },
      { a: 'D:\\' },
    ])
    expect((await scanSqlDump(chunks(win), { dialect: 'standard' })).dialect).toBe('standard')
    const forced = await scanSqlDump(chunks(MYSQL), { dialect: 'postgres' })
    expect(forced.dialect).toBe('postgres')
  })

  it('stops at an abort: the scan resolves with what it found, the read stops yielding (finding 3)', async () => {
    const ac = new AbortController()
    async function* parts(): AsyncGenerator<string> {
      yield 'CREATE TABLE a (x int);\nINSERT INTO a VALUES (1);\n'
      ac.abort()
      yield 'CREATE TABLE b (x int);\nINSERT INTO b VALUES (2);\n'
    }
    const scan = await scanSqlDump(parts(), { signal: ac.signal })
    expect(scan.truncated).toBe(true)
    expect(scan.tables.map((t) => t.key)).toEqual(['a'])
    const pre = new AbortController()
    pre.abort()
    expect(await read(chunks(MYSQL), ['customers'], { signal: pre.signal })).toEqual([])
    // One chunk of many rows: an abort while reading it stops within it.
    const many =
      'CREATE TABLE t (x int);\nINSERT INTO t VALUES ' +
      Array.from({ length: 100_000 }, (_, i) => `(${i})`).join(',') +
      ';\n'
    const stop = new AbortController()
    let seen = 0
    for await (const r of readSqlDump(chunks(many), {
      tables: new Set(['t']),
      primaryKeyAsId: true,
      signal: stop.signal,
    })) {
      void r
      if (++seen === 1) stop.abort()
    }
    expect(seen).toBe(1)
  })

  it('skips a table whose name is longer than 255 characters (finding 11)', async () => {
    const ok = 'n'.repeat(255)
    const long = 'n'.repeat(256)
    const sql =
      `CREATE TABLE s.${ok} (x int);\nINSERT INTO s.${ok} VALUES (1);\n` +
      `CREATE TABLE ${long} (x int);\nINSERT INTO ${long} VALUES (2);\nINSERT INTO ${ok}.t VALUES (3);\nINSERT INTO ${long}.t VALUES (4);\n` +
      // Its COPY data is still skipped as data, never read as SQL.
      `COPY ${long} (x) FROM stdin;\n1\t'it\n\\.\nINSERT INTO s.${ok} VALUES (5);\n`
    const scan = await scanSqlDump(chunks(sql))
    expect(scan.truncated).toBe(false)
    expect(scan.tables.map((t) => [t.key.length, t.rows])).toEqual([
      [257, 2],
      [257, 1],
    ])
    expect(scan.skipped).toMatchObject({ 'CREATE TABLE': 1, INSERT: 2, COPY: 1 })
  })

  it('bounds the preview: a sample budget, large rows unsampled, columns capped (finding 17)', async () => {
    const big = 'b'.repeat(70 * 1024)
    const cols = Array.from({ length: 5 }, (_, i) => `c${i} text`).join(', ')
    const sql =
      `CREATE TABLE t (${cols});\nINSERT INTO t VALUES ('${big}','2','3','4','5'),('1','2','3','4','5'),('1','2','3','4','5');\n` +
      "CREATE TABLE u (a text);\nINSERT INTO u VALUES ('x'),('y');\n"
    const all = await scanSqlDump(chunks(sql))
    expect(all.tables.map((t) => t.samples.length)).toEqual([2, 2])
    expect(all.tables[0]!.columnCount).toBe(5)
    const small = await scanSqlDump(chunks(sql), { sampleBytes: 25, columnsPerTable: 2 })
    expect(small.tables[0]!.samples).toHaveLength(1)
    expect(small.tables[1]!.samples).toHaveLength(0)
    expect(small.tables[0]!.columns.map((c) => c.name)).toEqual(['c0', 'c1'])
    expect(small.tables[0]!.columnCount).toBe(5)
    expect(small.tables[0]!.rows).toBe(3)
  })
})
