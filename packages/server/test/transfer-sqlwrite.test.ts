// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { PassThrough, Writable } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import fc from 'fast-check'
import { Binary, Decimal128, Double, Int32, Long, MaxKey, ObjectId, Timestamp, type Document } from 'bson'
import { AppError } from '../src/errors'
import { sqlWriter, type SqlExportDialect, type SqlExportOptions } from '../src/transfer/formats/sqlwrite'

const NOW = new Date('2026-10-10T00:00:00.000Z')
const DIALECTS: SqlExportDialect[] = ['mysql', 'postgres', 'sqlite']

async function exportSql(docs: Document[], o: Partial<SqlExportOptions> = {}) {
  const out = new PassThrough()
  out.setEncoding('utf8')
  const chunks: string[] = []
  out.on('data', (c: string) => chunks.push(c))
  const w = sqlWriter(out, {
    dialect: 'mysql',
    table: 'items',
    rowsPerInsert: 100,
    transaction: true,
    fields: null,
    now: NOW,
    ...o,
  })
  for (const d of docs) await w.write(d)
  const res = await w.end()
  out.end()
  await new Promise((r) => setImmediate(r))
  return { sql: chunks.join(''), ...res }
}

async function reason(p: Promise<unknown>) {
  try {
    await p
  } catch (e) {
    return e instanceof AppError ? (e.details as { reason?: string }).reason : String(e)
  }
  return 'ok'
}

/** The declared type of a column in the CREATE TABLE. */
function columnType(sql: string, quotedName: string): string | undefined {
  const line = sql.split('\n').find((l) => l.startsWith(`  ${quotedName} `))
  return line?.slice(quotedName.length + 3).replace(/,$/, '')
}

/** The value rows of the INSERTs, one string per row, as written. */
const valueRows = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => l.startsWith('('))
    .map((l) => l.replace(/[,;]$/, ''))

const q = (d: SqlExportDialect, name: string) => (d === 'mysql' ? `\`${name}\`` : `"${name}"`)

// A small SQL tokenizer per dialect, written independently of the writer: it finds where every
// literal and quoted name ends, the comments and the statement terminators outside them.
interface Scan {
  statements: string[]
  strings: string[][]
  idents: string[][]
  comments: string[]
}
function scan(sql: string, d: SqlExportDialect): Scan {
  const res: Scan = { statements: [], strings: [], idents: [], comments: [] }
  let stmt = ''
  let strings: string[] = []
  let idents: string[] = []
  let i = 0
  const identQuote = d === 'mysql' ? '`' : '"'
  while (i < sql.length) {
    const c = sql[i]!
    if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end < 0 ? sql.length : end
      res.comments.push(sql.slice(i, stop))
      i = stop
      continue
    }
    if (c === '/' && sql[i + 1] === '*') throw new Error(`block comment at ${i}`)
    if (c === '#' && d === 'mysql') throw new Error(`hash comment at ${i}`)
    // Other quotes each dialect reads: MySQL's "…" strings, SQLite's `…` names, PostgreSQL's $$…$$.
    if ((c === '"' && d === 'mysql') || (c === '`' && d !== 'mysql') || (c === '$' && d === 'postgres'))
      throw new Error(`unexpected ${c} at ${i}`)
    if ((c === 'X' || c === 'x') && sql[i + 1] === "'" && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? ' ')) {
      const end = sql.indexOf("'", i + 2)
      const hex = sql.slice(i + 2, end)
      if (!/^([0-9A-Fa-f]{2})*$/.test(hex)) throw new Error(`bad hex at ${i}`)
      strings.push(Buffer.from(hex, 'hex').toString('utf8'))
      stmt += 'X?'
      i = end + 1
      continue
    }
    if (c === "'") {
      const escapes = d === 'mysql' || (d === 'postgres' && sql[i - 1] === 'E')
      let v = ''
      i++
      for (;;) {
        if (i >= sql.length) throw new Error('unclosed string')
        const ch = sql[i]!
        if (ch === '\\' && escapes) {
          const n = sql[i + 1]!
          const map: Record<string, string> = { '0': '\0', n: '\n', r: '\r', Z: '\x1a', '\\': '\\' }
          if (!(n in map)) throw new Error(`unexpected escape \\${n}`)
          v += map[n]
          i += 2
        } else if (ch === "'") {
          if (sql[i + 1] === "'") {
            v += "'"
            i += 2
          } else {
            i++
            break
          }
        } else {
          if (ch === '\0') throw new Error('raw NUL in a literal')
          v += ch
          i++
        }
      }
      strings.push(v)
      stmt += "'?'"
      continue
    }
    if (c === identQuote) {
      let v = ''
      i++
      for (;;) {
        if (i >= sql.length) throw new Error('unclosed name')
        const ch = sql[i]!
        if (ch === identQuote) {
          if (sql[i + 1] === identQuote) {
            v += ch
            i += 2
          } else {
            i++
            break
          }
        } else {
          v += ch
          i++
        }
      }
      idents.push(v)
      stmt += 'I'
      continue
    }
    if (c === ';') {
      res.statements.push(stmt.trim())
      res.strings.push(strings)
      res.idents.push(idents)
      stmt = ''
      strings = []
      idents = []
      i++
      continue
    }
    if (c === '\0') throw new Error('raw NUL outside a literal')
    stmt += c
    i++
  }
  if (stmt.trim()) throw new Error(`text after the last statement: ${stmt.trim().slice(0, 40)}`)
  return res
}

const OID1 = new ObjectId('65a1b2c3d4e5f6a7b8c9d0e1')
const OID2 = new ObjectId('65a1b2c3d4e5f6a7b8c9d0e2')
const SMALL: Document[] = [
  {
    _id: OID1,
    n: new Int32(1),
    name: 'it\'s \\ "x"',
    ok: true,
    at: new Date('2024-01-02T03:04:05.006Z'),
    tags: ['a', 'b'],
    sub: { x: new Int32(1) },
  },
  { _id: OID2, n: new Int32(2), name: 'Veli', ok: false, sub: { x: new Int32(2) } },
]

describe('SQL export: whole files (spec §4)', () => {
  it('writes a MySQL file', async () => {
    const { sql, cutCells, omittedFields } = await exportSql(SMALL, { dialect: 'mysql' })
    expect(sql).toBe(
      [
        '-- Mongo Manager export',
        '-- Table: `items`',
        '-- Dialect: MySQL',
        '-- Exported: 2026-10-10T00:00:00.000Z',
        '',
        'SET NAMES utf8mb4;',
        '',
        'CREATE TABLE `items` (',
        '  `_id` CHAR(24) NOT NULL,',
        '  `n` INT,',
        '  `name` LONGTEXT,',
        '  `ok` TINYINT(1),',
        '  `at` DATETIME(3),',
        '  `tags` JSON,',
        '  `sub.x` INT,',
        '  PRIMARY KEY (`_id`)',
        ') DEFAULT CHARSET=utf8mb4;',
        '',
        'START TRANSACTION;',
        '',
        'INSERT INTO `items` (`_id`, `n`, `name`, `ok`, `at`, `tags`, `sub.x`) VALUES',
        "('65a1b2c3d4e5f6a7b8c9d0e1', 1, 'it''s \\\\ \"x\"', 1, '2024-01-02 03:04:05.006', '[\"a\",\"b\"]', 1),",
        "('65a1b2c3d4e5f6a7b8c9d0e2', 2, 'Veli', 0, NULL, NULL, 2);",
        '',
        'COMMIT;',
        '',
      ].join('\n'),
    )
    expect(cutCells).toBe(0)
    expect(omittedFields).toEqual([])
  })

  it('writes a PostgreSQL file', async () => {
    const { sql } = await exportSql(SMALL, { dialect: 'postgres' })
    expect(sql).toBe(
      [
        '-- Mongo Manager export',
        '-- Table: "items"',
        '-- Dialect: PostgreSQL',
        '-- Exported: 2026-10-10T00:00:00.000Z',
        '',
        "SET client_encoding = 'UTF8';",
        '',
        'BEGIN;',
        '',
        'CREATE TABLE "items" (',
        '  "_id" CHAR(24) NOT NULL,',
        '  "n" INTEGER,',
        '  "name" TEXT,',
        '  "ok" BOOLEAN,',
        '  "at" TIMESTAMPTZ,',
        '  "tags" JSONB,',
        '  "sub.x" INTEGER,',
        '  PRIMARY KEY ("_id")',
        ');',
        '',
        'INSERT INTO "items" ("_id", "n", "name", "ok", "at", "tags", "sub.x") VALUES',
        "('65a1b2c3d4e5f6a7b8c9d0e1', 1, E'it''s \\\\ \"x\"', TRUE, '2024-01-02 03:04:05.006+00', '[\"a\",\"b\"]', 1),",
        "('65a1b2c3d4e5f6a7b8c9d0e2', 2, 'Veli', FALSE, NULL, NULL, 2);",
        '',
        'COMMIT;',
        '',
      ].join('\n'),
    )
  })

  it('writes a SQLite file', async () => {
    const { sql } = await exportSql(SMALL, { dialect: 'sqlite' })
    expect(sql).toBe(
      [
        '-- Mongo Manager export',
        '-- Table: "items"',
        '-- Dialect: SQLite',
        '-- Exported: 2026-10-10T00:00:00.000Z',
        '',
        'BEGIN;',
        '',
        'CREATE TABLE "items" (',
        '  "_id" CHAR(24) NOT NULL,',
        '  "n" INTEGER,',
        '  "name" TEXT,',
        '  "ok" INTEGER,',
        '  "at" TEXT,',
        '  "tags" JSON TEXT,',
        '  "sub.x" INTEGER,',
        '  PRIMARY KEY ("_id")',
        ');',
        '',
        'INSERT INTO "items" ("_id", "n", "name", "ok", "at", "tags", "sub.x") VALUES',
        "('65a1b2c3d4e5f6a7b8c9d0e1', 1, 'it''s \\ \"x\"', 1, '2024-01-02T03:04:05.006Z', '[\"a\",\"b\"]', 1),",
        "('65a1b2c3d4e5f6a7b8c9d0e2', 2, 'Veli', 0, NULL, NULL, 2);",
        '',
        'COMMIT;',
        '',
      ].join('\n'),
    )
  })

  it('leaves the transaction out when asked; MySQL keeps it around the rows only (its DDL commits)', async () => {
    for (const d of DIALECTS) {
      const { sql } = await exportSql(SMALL, { dialect: d, transaction: false })
      expect(sql).not.toMatch(/BEGIN|START TRANSACTION|COMMIT/)
      expect(sql.endsWith(');\n')).toBe(true)
    }
    const my = (await exportSql(SMALL, { dialect: 'mysql' })).sql
    expect(my.indexOf('START TRANSACTION;')).toBeGreaterThan(my.indexOf('CREATE TABLE'))
    const pg = (await exportSql(SMALL, { dialect: 'postgres' })).sql
    expect(pg.indexOf('BEGIN;')).toBeLessThan(pg.indexOf('CREATE TABLE'))
  })

  it('writes no statement but the header for an empty export without columns', async () => {
    for (const d of DIALECTS) {
      const { sql } = await exportSql([], { dialect: d })
      expect(sql).not.toMatch(/CREATE|INSERT|BEGIN|START|COMMIT/)
      expect(sql).toContain('-- No columns to export.')
    }
  })

  it('creates the table without rows when columns are chosen and nothing matches', async () => {
    const { sql } = await exportSql([], { dialect: 'postgres', fields: ['_id', 'a'] })
    expect(sql).toContain('CREATE TABLE "items" (\n  "_id" TEXT,\n  "a" TEXT\n);')
    expect(sql).not.toContain('INSERT')
  })
})

describe('SQL export: column types', () => {
  const KINDS: Array<[string, unknown, Record<SqlExportDialect, string>]> = [
    ['Int32', new Int32(-5), { mysql: 'INT', postgres: 'INTEGER', sqlite: 'INTEGER' }],
    ['Long', Long.fromString('9007199254740993'), { mysql: 'BIGINT', postgres: 'BIGINT', sqlite: 'INTEGER' }],
    ['Double', new Double(1.5), { mysql: 'DOUBLE', postgres: 'DOUBLE PRECISION', sqlite: 'REAL' }],
    [
      'Decimal128',
      Decimal128.fromString('0.1'),
      { mysql: 'DECIMAL(65,1)', postgres: 'NUMERIC', sqlite: 'TEXT' },
    ],
    ['bool', true, { mysql: 'TINYINT(1)', postgres: 'BOOLEAN', sqlite: 'INTEGER' }],
    [
      'Date',
      new Date('2024-01-01T00:00:00Z'),
      { mysql: 'DATETIME(3)', postgres: 'TIMESTAMPTZ', sqlite: 'TEXT' },
    ],
    ['ObjectId', OID1, { mysql: 'CHAR(24)', postgres: 'CHAR(24)', sqlite: 'CHAR(24)' }],
    ['string', 'x', { mysql: 'LONGTEXT', postgres: 'TEXT', sqlite: 'TEXT' }],
    ['Binary', new Binary(Buffer.from([0, 255])), { mysql: 'LONGBLOB', postgres: 'BYTEA', sqlite: 'BLOB' }],
    ['array', [1, 2], { mysql: 'JSON', postgres: 'JSONB', sqlite: 'JSON TEXT' }],
    ['empty document', {}, { mysql: 'JSON', postgres: 'JSONB', sqlite: 'JSON TEXT' }],
    ['Timestamp', new Timestamp({ t: 1, i: 2 }), { mysql: 'JSON', postgres: 'JSONB', sqlite: 'JSON TEXT' }],
    ['MaxKey', new MaxKey(), { mysql: 'JSON', postgres: 'JSONB', sqlite: 'JSON TEXT' }],
    ['null only', null, { mysql: 'LONGTEXT', postgres: 'TEXT', sqlite: 'TEXT' }],
  ]
  for (const [kind, value, types] of KINDS)
    it(`infers ${kind}`, async () => {
      for (const d of DIALECTS) {
        const { sql } = await exportSql([{ v: value }], { dialect: d })
        expect(columnType(sql, q(d, 'v')), d).toBe(types[d])
      }
    })

  it('writes each kind as its literal', async () => {
    const LITS: Array<[unknown, Record<SqlExportDialect, string>]> = [
      [new Int32(-5), { mysql: '-5', postgres: '-5', sqlite: '-5' }],
      [
        Long.fromString('-9223372036854775808'),
        { mysql: '-9223372036854775808', postgres: '-9223372036854775808', sqlite: '-9223372036854775808' },
      ],
      [new Double(1.5), { mysql: '1.5', postgres: '1.5', sqlite: '1.5' }],
      [new Double(1e300), { mysql: '1e+300', postgres: '1e+300', sqlite: '1e+300' }],
      [Decimal128.fromString('1.23E+5'), { mysql: '123000', postgres: '1.23E+5', sqlite: "'1.23E+5'" }],
      [
        Decimal128.fromString('-0.000001'),
        { mysql: '-0.000001', postgres: '-0.000001', sqlite: "'-0.000001'" },
      ],
      [false, { mysql: '0', postgres: 'FALSE', sqlite: '0' }],
      [
        new Date('1999-12-31T23:59:59.999Z'),
        {
          mysql: "'1999-12-31 23:59:59.999'",
          postgres: "'1999-12-31 23:59:59.999+00'",
          sqlite: "'1999-12-31T23:59:59.999Z'",
        },
      ],
      [
        OID1,
        {
          mysql: "'65a1b2c3d4e5f6a7b8c9d0e1'",
          postgres: "'65a1b2c3d4e5f6a7b8c9d0e1'",
          sqlite: "'65a1b2c3d4e5f6a7b8c9d0e1'",
        },
      ],
      [
        new Binary(Buffer.from([0, 0xab, 0xff])),
        { mysql: "X'00abff'", postgres: "E'\\\\x00abff'", sqlite: "X'00abff'" },
      ],
      [
        { a: new Int32(1), d: new Date('2024-01-01T00:00:00Z') },
        {
          mysql: '\'{"a":1,"d":{"$date":"2024-01-01T00:00:00Z"}}\'',
          postgres: '\'{"a":1,"d":{"$date":"2024-01-01T00:00:00Z"}}\'',
          sqlite: '\'{"a":1,"d":{"$date":"2024-01-01T00:00:00Z"}}\'',
        },
      ],
    ]
    for (const [value, lits] of LITS)
      for (const d of DIALECTS) {
        // A sub-document needs a leaf: the column is chosen.
        const fields = bsonIsDoc(value) ? ['v'] : null
        const { sql } = await exportSql([{ v: value }], { dialect: d, fields })
        expect(valueRows(sql), `${d} ${String(value)}`).toEqual([`(${lits[d]})`])
      }
  })

  it('writes NaN and infinities as each dialect allows, counting the ones it cannot hold', async () => {
    const docs = [{ v: new Double(NaN) }, { v: new Double(Infinity) }, { v: new Double(-Infinity) }]
    const my = await exportSql(docs, { dialect: 'mysql' })
    expect(valueRows(my.sql)).toEqual(['(NULL)', '(NULL)', '(NULL)'])
    expect(my.cutCells).toBe(3)
    expect(columnType(my.sql, '`v`')).toBe('DOUBLE')
    const pg = await exportSql(docs, { dialect: 'postgres' })
    expect(valueRows(pg.sql)).toEqual(["('NaN'::float8)", "('Infinity'::float8)", "('-Infinity'::float8)"])
    expect(pg.cutCells).toBe(0)
    const lite = await exportSql(docs, { dialect: 'sqlite' })
    expect(valueRows(lite.sql)).toEqual(['(NULL)', '(9e999)', '(-9e999)'])
    expect(lite.cutCells).toBe(1)
    const dec = [{ v: Decimal128.fromString('NaN') }, { v: Decimal128.fromString('-Infinity') }]
    expect(valueRows((await exportSql(dec, { dialect: 'postgres' })).sql)).toEqual([
      "('NaN'::numeric)",
      "('-Infinity'::numeric)",
    ])
    const myDec = await exportSql(dec, { dialect: 'mysql' })
    expect(valueRows(myDec.sql)).toEqual(['(NULL)', '(NULL)'])
    expect(myDec.cutCells).toBe(2)
  })

  it('widens numbers and falls back to text for mixed kinds', async () => {
    const t = async (vals: unknown[], d: SqlExportDialect = 'postgres') =>
      columnType(
        (
          await exportSql(
            vals.map((v) => ({ v })),
            { dialect: d },
          )
        ).sql,
        q(d, 'v'),
      )
    expect(await t([new Int32(1), Long.fromNumber(2)])).toBe('BIGINT')
    expect(await t([new Int32(1), new Double(2.5)])).toBe('DOUBLE PRECISION')
    expect(await t([Long.fromNumber(1), Decimal128.fromString('2.5')])).toBe('NUMERIC')
    expect(await t([new Int32(1), 'x'])).toBe('TEXT')
    expect(await t([true, new Int32(1)])).toBe('TEXT')
    expect(await t([[1], { a: 1 }])).toBe('JSONB')
    expect(await t([null, new Int32(1), undefined])).toBe('INTEGER')
    const mixed = await exportSql([{ v: new Int32(1) }, { v: 'x' }, { v: true }, { v: OID1 }], {
      dialect: 'mysql',
    })
    expect(valueRows(mixed.sql)).toEqual(["('1')", "('x')", "('true')", "('65a1b2c3d4e5f6a7b8c9d0e1')"])
    // A decimal MySQL's DECIMAL cannot hold makes the column text, written exactly.
    const big = await exportSql([{ v: Decimal128.fromString('1E+70') }], { dialect: 'mysql' })
    expect(columnType(big.sql, '`v`')).toBe('LONGTEXT')
    expect(valueRows(big.sql)).toEqual(["('1E+70')"])
    // A date MySQL's DATETIME cannot hold, the same.
    const old = await exportSql([{ v: new Date('0999-01-01T00:00:00Z') }], { dialect: 'mysql' })
    expect(columnType(old.sql, '`v`')).toBe('LONGTEXT')
  })

  // User request 2026-10-12: "tutar çıktıları 524.660000000000000000000000000000 bu şekilde çıkıyor".
  // A MySQL DECIMAL's scale is the one its first values are written with (Decimal128 keeps it:
  // 234.20 has two), at most 30; its whole digits the rest of 65.
  it('gives a MySQL DECIMAL the scale its values are written with, up to 65 digits and 30 decimals', async () => {
    const t = async (s: string) => {
      const { sql } = await exportSql([{ v: Decimal128.fromString(s) }], { dialect: 'mysql' })
      return [columnType(sql, '`v`'), valueRows(sql)[0]]
    }
    expect(await t('234.20')).toEqual(['DECIMAL(65,2)', '(234.2)'])
    expect(await t('12.3400')).toEqual(['DECIMAL(65,4)', '(12.34)'])
    expect(await t('7')).toEqual(['DECIMAL(65,0)', '(7)'])
    expect(await t('-0')).toEqual(['DECIMAL(65,0)', '(0)'])
    expect(await t('1E+64')).toEqual(['DECIMAL(65,0)', `(1${'0'.repeat(64)})`])
    expect(await t('1E+65')).toEqual(['LONGTEXT', "('1E+65')"])
    expect(await t('-1E-30')).toEqual(['DECIMAL(65,30)', `(-0.${'0'.repeat(29)}1)`])
    expect(await t('1E-31')).toEqual(['LONGTEXT', "('1E-31')"])
  })

  // Review 2026-10-12 (I3): a long run of trailing zeros is padding (a DECIMAL(65,30) value read
  // back, say), never a scale to keep: amounts would show 30 zeros again after a round trip.
  it('takes a run of more than two trailing zeros as padding, never as the scale', async () => {
    const t = async (s: string) => {
      const { sql } = await exportSql([{ v: Decimal128.fromString(s) }], { dialect: 'mysql' })
      return [columnType(sql, '`v`'), valueRows(sql)[0]]
    }
    expect(await t(`524.66${'0'.repeat(28)}`)).toEqual(['DECIMAL(65,2)', '(524.66)'])
    expect(await t(`1.5${'0'.repeat(31)}`)).toEqual(['DECIMAL(65,2)', '(1.5)'])
    expect(await t('0E-40')).toEqual(['DECIMAL(65,2)', '(0)'])
    expect(await t('1.50E-7')).toEqual(['DECIMAL(65,9)', '(0.00000015)'])
    expect(await t('1.2E+3')).toEqual(['DECIMAL(65,0)', '(1200)'])
    expect(await t('3.000')).toEqual(['DECIMAL(65,2)', '(3)'])
  })

  // Review 2026-10-12 (I2): whole amounts first, a fraction later — never lost to a NULL.
  it('widens a MySQL DECIMAL for a later value with more decimals, its rows committed before', async () => {
    const money = (s: string) => ({ total: Decimal128.fromString(s) })
    const docs = [...Array.from({ length: 100 }, () => money('250')), money('99.99'), money('0.125')]
    const { sql, cutCells } = await exportSql(docs, { dialect: 'mysql', rowsPerInsert: 1000 })
    expect(columnType(sql, '`total`')).toBe('DECIMAL(65,0)')
    expect(sql).toContain('COMMIT;\nALTER TABLE `items` MODIFY `total` DECIMAL(65,2);\nSTART TRANSACTION;')
    expect(sql).toContain('ALTER TABLE `items` MODIFY `total` DECIMAL(65,3);')
    expect(valueRows(sql).slice(-2)).toEqual(['(99.99)', '(0.125)'])
    expect(cutCells).toBe(0)
    // The INSERT before it ends there, every statement whole; why is said in a comment.
    const said = sql.indexOf('-- A later value needs more decimals')
    expect(said).toBeGreaterThan(0)
    expect(sql.slice(0, said).trimEnd().endsWith(');')).toBe(true)
    // The rows after it are a new INSERT, never the rest of the one ended.
    expect(sql.slice(said)).toMatch(
      /START TRANSACTION;\n\nINSERT INTO `items` \(`total`\) VALUES\n\(99\.99\);/,
    )
    // Without a transaction, no COMMIT of its own.
    const plain = await exportSql(docs, { dialect: 'mysql', transaction: false })
    expect(plain.sql).toContain('\nALTER TABLE `items` MODIFY `total` DECIMAL(65,2);\n')
    expect(plain.sql).not.toContain('COMMIT;')
    // Other dialects never widen: their NUMERIC holds every value.
    const pg = await exportSql(docs, { dialect: 'postgres' })
    expect(pg.sql).not.toContain('ALTER TABLE')
  })

  it('writes NULL, counted, for a later decimal no DECIMAL can hold with the values before it', async () => {
    const money = (s: string) => ({ total: Decimal128.fromString(s) })
    // 65 whole digits leave no room for a decimal: the fraction cannot be held, never rounded.
    const wide = await exportSql([...Array.from({ length: 100 }, () => money('1E+64')), money('0.5')], {
      dialect: 'mysql',
    })
    expect(columnType(wide.sql, '`total`')).toBe('DECIMAL(65,0)')
    expect(valueRows(wide.sql)[100]).toBe('(NULL)')
    expect(wide.cutCells).toBe(1)
    expect(wide.sql).not.toContain('ALTER TABLE')
    // More than 30 decimals, or more whole digits than 65 less the scale: the same.
    const fine = await exportSql(
      [...Array.from({ length: 100 }, () => money('0.25')), money('1E-31'), money('1E+63'), money('1E+62')],
      { dialect: 'mysql' },
    )
    expect(valueRows(fine.sql).slice(100)).toEqual(['(NULL)', '(NULL)', `(1${'0'.repeat(62)})`])
    expect(fine.sql).not.toContain('ALTER TABLE')
    expect(fine.cutCells).toBe(2)
    // Whole digits written later count too: 65 of them leave no room for the decimal after.
    const later = await exportSql(
      [...Array.from({ length: 100 }, () => money('1')), money('1E+64'), money('0.5')],
      { dialect: 'mysql' },
    )
    expect(later.sql).not.toContain('ALTER TABLE')
    expect(valueRows(later.sql).slice(100)).toEqual([`(1${'0'.repeat(64)})`, '(NULL)'])
  })

  // Review 2026-10-12 (M1): a decimal _id with more decimals later widens its key, never aborts.
  it('widens a decimal key column too, keeping it NOT NULL', async () => {
    const docs = [...Array.from({ length: 100 }, (_, i) => ({ _id: Decimal128.fromString(String(i)) }))]
    docs.push({ _id: Decimal128.fromString('1.5') })
    const { sql } = await exportSql(docs, { dialect: 'mysql' })
    expect(sql).toContain('ALTER TABLE `items` MODIFY `_id` DECIMAL(65,1) NOT NULL;')
    expect(valueRows(sql).at(-1)).toBe('(1.5)')
  })

  // Review 2026-10-12 (M2): a double in a decimal column is written exactly: its digits are its value.
  it('gives a double in a decimal column the decimals its exact text needs', async () => {
    const { sql } = await exportSql([{ v: Decimal128.fromString('1.5') }, { v: new Double(0.1 + 0.2) }], {
      dialect: 'mysql',
    })
    expect(columnType(sql, '`v`')).toBe('DECIMAL(65,17)')
    expect(valueRows(sql)).toEqual(['(1.5)', '(0.30000000000000004)'])
  })

  // User request 2026-10-12: older tools (phpMyAdmin before 4.7) do not know MySQL's JSON type.
  it('writes nested values in a LONGTEXT column for older tools when asked, as JSON text still', async () => {
    const doc = { tags: ['a', 'b'], meta: { n: new Int32(1) } }
    const plain = await exportSql([doc], { dialect: 'mysql' })
    expect(columnType(plain.sql, '`tags`')).toBe('JSON')
    const old = await exportSql([doc], { dialect: 'mysql', jsonAsText: true })
    expect(columnType(old.sql, '`tags`')).toBe('LONGTEXT')
    expect(columnType(old.sql, '`meta.n`')).toBe('INT')
    expect(valueRows(old.sql)[0]).toContain(`'["a","b"]'`)
    // Only MySQL's JSON is in question: PostgreSQL keeps its jsonb.
    const pg = await exportSql([doc], { dialect: 'postgres', jsonAsText: true })
    expect(columnType(pg.sql, '"tags"')).toBe('JSONB')
  })

  it('keeps integers within their column', async () => {
    const t = async (vals: unknown[]) =>
      valueRows(
        (
          await exportSql(
            vals.map((v) => ({ v })),
            { dialect: 'postgres' },
          )
        ).sql,
      )
    expect(
      await t([new Int32(1), Long.fromNumber(2147483647), Long.fromNumber(2147483648), -2147483648]),
    ).toEqual(['(1)', '(2147483647)', '(2147483648)', '(-2147483648)'])
    const docs: Document[] = Array.from({ length: 100 }, () => ({ v: new Int32(0) }))
    docs.push({ v: Long.fromNumber(2147483648) }, { v: Long.fromNumber(-2147483648) }, { v: new Double(1.5) })
    const { sql, cutCells } = await exportSql(docs, { dialect: 'postgres' })
    expect(valueRows(sql).slice(100)).toEqual(['(NULL)', '(-2147483648)', '(NULL)'])
    expect(cutCells).toBe(2)
  })

  it('writes a later value that does not fit its column as NULL and counts it', async () => {
    const docs: Document[] = Array.from({ length: 100 }, (_, i) => ({ v: new Int32(i) }))
    docs.push({ v: 'abc' }, { v: Long.fromNumber(7) }, { v: Long.fromString('9007199254740993') }, { v: 2.0 })
    const { sql, cutCells } = await exportSql(docs, { dialect: 'postgres', rowsPerInsert: 1000 })
    expect(columnType(sql, '"v"')).toBe('INTEGER')
    expect(valueRows(sql).slice(100)).toEqual(['(NULL)', '(7)', '(NULL)', '(2)'])
    expect(cutCells).toBe(2)
  })

  it('infers from the first 100 documents only', async () => {
    const docs: Document[] = Array.from({ length: 101 }, (_, i) => ({ _id: new Int32(i), a: new Int32(i) }))
    docs[99] = { _id: new Int32(99), a: new Int32(99), b: 'x' }
    docs[100] = { _id: new Int32(100), a: new Int32(100), c: 'late' }
    const { sql, omittedFields } = await exportSql(docs, { dialect: 'sqlite' })
    expect(columnType(sql, '"b"')).toBe('TEXT')
    expect(columnType(sql, '"c"')).toBeUndefined()
    expect(omittedFields).toEqual(['c'])
  })
})

const bsonIsDoc = (v: unknown) =>
  v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype

describe('SQL export: columns and the primary key', () => {
  it('puts _id first, takes the union of the first documents and writes NULL for a missing field', async () => {
    const { sql } = await exportSql(
      [
        { a: 1, _id: new Int32(1) },
        { _id: new Int32(2), b: { c: 'x', d: [1] } },
      ],
      { dialect: 'postgres' },
    )
    expect(sql).toContain('INSERT INTO "items" ("_id", "a", "b.c", "b.d") VALUES')
    expect(valueRows(sql)).toEqual(['(1, 1, NULL, NULL)', "(2, NULL, 'x', '[1]')"])
    expect(sql).toContain('  "_id" INTEGER NOT NULL,')
    expect(sql).toContain('  PRIMARY KEY ("_id")')
  })

  it('keeps the chosen columns in their order, without duplicates, and reports the rest as omitted', async () => {
    const { sql, omittedFields } = await exportSql(
      [{ _id: new Int32(1), a: 'x', b: { c: new Int32(2) }, z: 1 }],
      { dialect: 'mysql', fields: ['b.c', '_id', 'b.c', 'missing'] },
    )
    expect(sql).toContain('INSERT INTO `items` (`b.c`, `_id`, `missing`) VALUES')
    expect(valueRows(sql)).toEqual(['(2, 1, NULL)'])
    expect(omittedFields).toEqual(['a', 'z'])
  })

  it('makes _id the key only when every first document has one that fits', async () => {
    const pk = async (docs: Document[], d: SqlExportDialect = 'mysql') =>
      (await exportSql(docs, { dialect: d })).sql.includes('PRIMARY KEY')
    expect(await pk([{ _id: OID1 }])).toBe(true)
    expect(await pk([{ _id: OID1 }, { x: 1 }])).toBe(false)
    expect(await pk([{ _id: OID1 }, { _id: null }])).toBe(false)
    expect(await pk([{ _id: { a: 1 } }])).toBe(false)
    expect(await pk([{ _id: [] as unknown[] }], 'postgres')).toBe(false)
    expect(await pk([{ _id: 'x'.repeat(768) }])).toBe(true)
    expect(await pk([{ _id: 'x'.repeat(769) }])).toBe(false)
    expect(await pk([{ _id: 'x'.repeat(769) }], 'postgres')).toBe(true)
    const my = (await exportSql([{ _id: 'a' }, { _id: 'A' }], { dialect: 'mysql' })).sql
    // A case-insensitive key would refuse "a" next to "A".
    expect(my).toContain('  `_id` VARCHAR(768) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,')
    const uuid = (await exportSql([{ _id: new Binary(Buffer.alloc(16), 4) }], { dialect: 'mysql' })).sql
    expect(uuid).toContain('  `_id` VARBINARY(3072) NOT NULL,')
  })

  it('refuses a later _id the key column cannot hold rather than write a file that fails to load', async () => {
    const docs: Document[] = Array.from({ length: 100 }, () => ({ _id: new ObjectId() }))
    expect(await reason(exportSql([...docs, { _id: 'text' }], { dialect: 'postgres' }))).toBe('sql_id_type')
    expect(await reason(exportSql([...docs, { a: 1 }], { dialect: 'postgres' }))).toBe('sql_id_type')
  })

  it('quotes, cleans and shortens names per dialect', async () => {
    const names = { 'a`b': 1, 'c"d': 2, 'nul\0x': 3, 'end ': 4, '': 5, Name: 6, name: 7, ['\u{1F600}']: 8 }
    const my = (await exportSql([names], { dialect: 'mysql', table: 'my`table' })).sql
    // MySQL: no NUL, no trailing space, nothing beyond the BMP, names case-insensitive.
    expect(my).toContain(
      'INSERT INTO `my``table` (`a``b`, `c"d`, `nul_x`, `end_`, `_`, `Name`, `name_2`, `__2`) VALUES',
    )
    const pg = (await exportSql([names], { dialect: 'postgres', table: 'pg"t' })).sql
    expect(pg).toContain(
      'INSERT INTO "pg""t" ("a`b", "c""d", "nul_x", "end ", "_", "Name", "name", "\u{1F600}") VALUES',
    )
    const lite = (await exportSql([names], { dialect: 'sqlite' })).sql
    expect(lite).toContain('"Name", "name_2"')
    const long = 'é'.repeat(100)
    expect(
      columnType((await exportSql([{ [long]: 1 }], { dialect: 'mysql' })).sql, `\`${'é'.repeat(64)}\``),
    ).toBe('INT')
    // PostgreSQL counts bytes: 31 two-byte letters fit in 63, 30 beside "_2".
    const pgLong = (await exportSql([{ [long]: 1, [long + 'x']: 2 }], { dialect: 'postgres' })).sql
    expect(pgLong).toContain(`("${'é'.repeat(31)}", "${'é'.repeat(30)}_2")`)
  })

  it('keeps names out of comments except the table, on one line', async () => {
    const { sql } = await exportSql([{ v: 'SECRET' }], {
      dialect: 'postgres',
      table: 'x\nDROP TABLE y; --\r\u2028z',
    })
    const comments = sql.split('\n').filter((l) => l.startsWith('--'))
    expect(comments).toEqual([
      '-- Mongo Manager export',
      '-- Table: "x?DROP TABLE y; --??z"',
      '-- Dialect: PostgreSQL',
      '-- Exported: 2026-10-10T00:00:00.000Z',
    ])
    expect(scan(sql, 'postgres').statements.map((s) => s.split(/\s/)[0])).toEqual([
      'SET',
      'BEGIN',
      'CREATE',
      'INSERT',
      'COMMIT',
    ])
  })
})

describe('SQL export: batching and backpressure', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ _id: new Int32(i) }))
  const inserts = (sql: string) => sql.split('\n').filter((l) => l.startsWith('INSERT INTO')).length

  it('splits rows by rowsPerInsert at the boundaries', async () => {
    expect(inserts((await exportSql(rows(0), { fields: ['_id'], rowsPerInsert: 3 })).sql)).toBe(0)
    expect(inserts((await exportSql(rows(1), { rowsPerInsert: 3 })).sql)).toBe(1)
    expect(inserts((await exportSql(rows(3), { rowsPerInsert: 3 })).sql)).toBe(1)
    expect(inserts((await exportSql(rows(4), { rowsPerInsert: 3 })).sql)).toBe(2)
    expect(inserts((await exportSql(rows(4), { rowsPerInsert: 1 })).sql)).toBe(4)
    const { sql } = await exportSql(rows(250), { rowsPerInsert: 100 })
    expect(inserts(sql)).toBe(3)
    expect(valueRows(sql)).toHaveLength(250)
    expect(scan(sql, 'mysql').statements).toHaveLength(2 + 3 + 2)
  })

  it('clamps rowsPerInsert to 1..1000', async () => {
    expect(inserts((await exportSql(rows(3), { rowsPerInsert: 0 })).sql)).toBe(3)
    expect(inserts((await exportSql(rows(1001), { rowsPerInsert: 5000 })).sql)).toBe(2)
  })

  it('ends an INSERT once it holds a mebibyte, whatever rowsPerInsert says', async () => {
    const big = Array.from({ length: 3 }, (_, i) => ({ _id: new Int32(i), s: 'x'.repeat(600_000) }))
    expect(inserts((await exportSql(big, { rowsPerInsert: 100 })).sql)).toBe(2)
  })

  it('waits for the stream to drain', async () => {
    let max = 0
    let total = 0
    class Slow extends Writable {
      constructor() {
        super({ highWaterMark: 64 })
      }
      override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
        total += chunk.length
        // Everything written and not yet taken: without backpressure the whole file piles up here.
        max = Math.max(max, this.writableLength)
        setImmediate(cb)
      }
    }
    const out = new Slow()
    const w = sqlWriter(out, {
      dialect: 'sqlite',
      table: 't',
      rowsPerInsert: 10,
      transaction: true,
      fields: null,
    })
    for (let i = 0; i < 2000; i++) await w.write({ _id: new Int32(i), s: 'some text value' })
    await w.end()
    await new Promise<void>((r) => out.end(r))
    expect(total).toBeGreaterThan(50_000)
    expect(max).toBeLessThan(5_000)
  })
})

describe('SQL export: injection', () => {
  const HOSTILE = [
    "'",
    "''",
    '"',
    '`',
    '\\',
    "\\'",
    ';',
    '--',
    '/*',
    '*/',
    '#',
    '\0',
    '\n',
    '\r',
    '\x1a',
    '\t',
    'é',
    '\u{1F600}',
    '\u2028',
    '$$',
    'E',
    'X',
    'a',
    ' ',
    "'); DROP TABLE items; --",
  ]
  const hostile = fc.array(fc.constantFrom(...HOSTILE), { maxLength: 12 }).map((a) => a.join(''))

  it('MySQL escapes per the default sql_mode', async () => {
    const { sql } = await exportSql([{ v: 'a\'b\\c\0d\ne\rf\x1ag"h`' }], { dialect: 'mysql' })
    expect(valueRows(sql)).toEqual(["('a''b\\\\c\\0d\\ne\\rf\\Zg\"h`')"])
  })

  it('PostgreSQL doubles quotes, uses E-strings only for backslashes and drops NUL', async () => {
    const text = await exportSql([{ v: "a'b\0c" }, { v: 'x\\y' }], { dialect: 'postgres' })
    expect(valueRows(text.sql)).toEqual(["('a''bc')", "(E'x\\\\y')"])
    expect(text.cutCells).toBe(1)
    // jsonb refuses \u0000 as well.
    const json = await exportSql([{ v: { s: 'n\0l', t: '\\u0000' } }], { dialect: 'postgres', fields: ['v'] })
    expect(valueRows(json.sql)).toEqual(['(E\'{"s":"nl","t":"\\\\\\\\u0000"}\')'])
    expect(json.cutCells).toBe(1)
    expect((await exportSql([{ v: 'é\n' }], { dialect: 'postgres' })).sql).toContain("('é\n');")
  })

  it('SQLite keeps NUL through a cast of the UTF-8 bytes', async () => {
    const { sql } = await exportSql([{ v: 'a\0é' }], { dialect: 'sqlite' })
    expect(valueRows(sql)).toEqual(["(CAST(X'6100c3a9' AS TEXT))"])
  })

  for (const d of DIALECTS)
    it(`${d}: every literal and name ends where it should (property)`, async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(hostile, { minLength: 1, maxLength: 5 }),
          hostile,
          hostile,
          async (vals, field, table) => {
            const docs = vals.map((v, i) => ({ _id: new Int32(i), [field || 'f']: v, j: [v] }))
            const { sql } = await exportSql(docs, { dialect: d, table, rowsPerInsert: 2, fields: null })
            const s = scan(sql, d)
            const heads = s.statements.map((st) => st.split(/\s/)[0])
            const ins = Math.ceil(vals.length / 2)
            const expected =
              d === 'mysql'
                ? ['SET', 'CREATE', 'START', ...Array(ins).fill('INSERT'), 'COMMIT']
                : [
                    ...(d === 'postgres' ? ['SET'] : []),
                    'BEGIN',
                    'CREATE',
                    ...Array(ins).fill('INSERT'),
                    'COMMIT',
                  ]
            expect(heads).toEqual(expected)
            expect(s.comments).toHaveLength(4)
            // The string values read back as written, in order (PostgreSQL text cannot hold NUL).
            const read = s.strings.filter((_, i) => heads[i] === 'INSERT').flat()
            const clean = (v: string) => (d === 'postgres' ? v.replaceAll('\0', '') : v)
            const wantStrings = vals.flatMap((v) => [clean(v), JSON.stringify([clean(v)])])
            expect(read).toEqual(wantStrings)
            // Every quoted name is one of the table's or columns' names.
            const create = s.idents[heads.indexOf('CREATE')]!
            expect(create).toHaveLength(1 + 3 + 1)
          },
        ),
        { numRuns: 300, seed: 20261010 },
      )
    })

  it('SQLite: the file loads and every value reads back exactly (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(hostile, { minLength: 1, maxLength: 5 }), hostile, async (vals, field) => {
        const name = field || 'f'
        const docs = vals.map((v, i) => ({ _id: v + `#${i}`, [name]: v }))
        const { sql } = await exportSql(docs, { dialect: 'sqlite', table: field, rowsPerInsert: 2 })
        const db = new DatabaseSync(':memory:')
        try {
          db.exec(sql)
          const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
          expect(tables).toHaveLength(1)
          const table = String(tables[0]!.name)
          const cols = db
            .prepare(`SELECT name FROM pragma_table_info(?)`)
            .all(table)
            .map((r) => String(r.name))
          expect(cols).toHaveLength(2)
          const got = db
            .prepare(
              `SELECT hex(${dq(cols[0]!)}) AS id, hex(${dq(cols[1]!)}) AS v FROM ${dq(table)} ORDER BY rowid`,
            )
            .all()
          expect(got).toEqual(vals.map((v, i) => ({ id: hexOf(v + `#${i}`), v: hexOf(v) })))
        } finally {
          db.close()
        }
      }),
      { numRuns: 300, seed: 1010 },
    )
  })
})

const dq = (s: string) => `"${s.replaceAll('"', '""')}"`
const hexOf = (s: string) => Buffer.from(s, 'utf8').toString('hex').toUpperCase()

describe('SQL export: SQLite round trip of every kind', () => {
  it('loads into SQLite and reads back', async () => {
    const docs: Document[] = [
      {
        _id: new Int32(1),
        i: new Int32(-2147483648),
        l: Long.fromString('-9223372036854775808'),
        d: new Double(0.1),
        inf: new Double(Infinity),
        dec: Decimal128.fromString('12345678901234567890.123456789'),
        b: true,
        at: new Date('2024-02-29T12:34:56.789Z'),
        o: OID1,
        s: "it's\n\\ 'quoted' \u{1F600}",
        bin: new Binary(Buffer.from([0, 1, 254, 255])),
        arr: [1, 'two', { three: 3 }],
      },
      { _id: new Int32(2), l: Long.fromString('9223372036854775807'), b: false },
    ]
    const { sql, cutCells } = await exportSql(docs, { dialect: 'sqlite', rowsPerInsert: 1 })
    expect(cutCells).toBe(0)
    const db = new DatabaseSync(':memory:')
    try {
      db.exec(sql)
      const st = db.prepare('SELECT * FROM "items" ORDER BY "_id"')
      st.setReadBigInts(true)
      const [a, b] = st.all() as Array<Record<string, unknown>>
      expect(a).toEqual({
        _id: 1n,
        i: -2147483648n,
        l: -9223372036854775808n,
        d: 0.1,
        inf: Infinity,
        dec: '12345678901234567890.123456789',
        b: 1n,
        at: '2024-02-29T12:34:56.789Z',
        o: '65a1b2c3d4e5f6a7b8c9d0e1',
        s: "it's\n\\ 'quoted' \u{1F600}",
        bin: new Uint8Array([0, 1, 254, 255]),
        arr: '[1,"two",{"three":3}]',
      })
      expect(b).toMatchObject({ _id: 2n, l: 9223372036854775807n, b: 0n, i: null, s: null })
    } finally {
      db.close()
    }
  })
})

// Review M7: a stored sub-document that merely has a "_bsontype" field (another driver can store
// one) is data, never taken for a BSON value written as it is.
describe('a field named _bsontype', () => {
  const fakes = [
    { _bsontype: 'Decimal128', x: 1 },
    { _bsontype: 'Long', low: 1 },
    { _bsontype: 'ObjectId', id: 'zz' },
    { _bsontype: 'Binary', sub: 0 },
    { _bsontype: 'Int32', value: '1); DROP TABLE x; --' },
    { _bsontype: 'Double', value: 'NaN-ish' },
  ]
  // A field chosen whole (the fields list) is written as one value: the case the tag could fool.
  for (const d of DIALECTS)
    it(`is written as its JSON text in ${d}, for every column kind`, async () => {
      for (const fake of fakes) {
        const { sql } = await exportSql([{ _id: 1, v: fake }], { dialect: d, fields: ['_id', 'v'] })
        expect(sql).not.toContain('[object Object]')
        expect(sql).not.toMatch(/\(1, (?:X'|decode\(|1\); DROP)/)
        expect(sql).toContain('_bsontype')
      }
    })

  it('writes unquoted only text that is a number, whatever a value claims to be', async () => {
    const odd = Object.assign(Object.create({}), {
      _bsontype: 'Decimal128',
      toString: () => '1); DROP TABLE x; --',
    })
    for (const d of DIALECTS) {
      const { sql } = await exportSql([{ _id: 1, v: odd }], { dialect: d, fields: ['_id', 'v'] })
      expect(sql).not.toMatch(/\(1, 1\); DROP/)
    }
  })

  it('leaves real BSON values as they are', async () => {
    const { sql } = await exportSql([{ _id: 1, v: Decimal128.fromString('1.50') }], {
      dialect: 'postgres',
      fields: ['_id', 'v'],
    })
    expect(sql).toContain('(1, 1.50)')
  })
})
