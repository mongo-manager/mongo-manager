import { once } from 'node:events'
import type { Writable } from 'node:stream'
import type { Document } from 'bson'
import { Errors } from '../../errors'
import { bsonKind, ejsonText, numberValue } from '../bson-kind'
import { OmittedFields, cellValue, leafPaths, outCell, wholeAbove } from '../flatten'
import { MAX_FIELDS, MiB } from '../limits'

/**
 * Spec §4: a collection as a SQL file — CREATE TABLE, then batched INSERTs.
 *
 * Decisions:
 * - MySQL output targets the default sql_mode. Quotes are doubled (never \'), so a literal ends in
 *   the same place under NO_BACKSLASH_ESCAPES too; there only \\ \0 \n \r \Z would read as written.
 * - PostgreSQL output depends on no server setting: a string with a backslash is an E'…' string,
 *   one without is a standard string, bytes are E'\\x…' (bytea's hex input). Text cannot hold NUL, so
 *   NUL characters (and \u0000 in jsonb) are dropped and counted as cut cells.
 * - SQLite keeps NUL: such a string is CAST(X'<UTF-8 bytes>' AS TEXT) (a UTF-8 database).
 * - Decimal128 stays exact: NUMERIC in PostgreSQL, TEXT in SQLite (its NUMERIC would round to
 *   double), DECIMAL(65,s) in MySQL with s the decimals its first values are written with (234.20:
 *   2), at most 30 — never 30 zeros on every amount (user request 2026-10-12). More than two
 *   trailing zeros are padding, not a scale (a DECIMAL(65,30) value read back: 524.660…0 is 2).
 *   Written in plain notation. A later value with more decimals widens the column (ALTER TABLE …
 *   MODIFY; MySQL commits the rows before it, so a transaction starts again after); one no DECIMAL
 *   can hold with the values before it (more than 30 decimals, more than 65 digits) is cut, never
 *   rounded.
 * - Nested values are MySQL JSON, or LONGTEXT holding the same JSON text when asked (jsonAsText:
 *   older tools, such as phpMyAdmin before 4.7, do not know the JSON type).
 * - NaN and ±Infinity: PostgreSQL 'NaN'::float8 and friends (numeric infinities need 14+); SQLite
 *   ±9e999; otherwise NULL, counted as a cut cell.
 * - Dates are UTC: MySQL DATETIME(3), PostgreSQL TIMESTAMPTZ, SQLite ISO 8601 text.
 * - Types come from the first documents. A later value its column cannot hold is NULL and counted
 *   as a cut cell; a later _id the key cannot hold stops the export (a NULL key would not load).
 */

export type SqlExportDialect = 'mysql' | 'postgres' | 'sqlite'

export interface SqlExportOptions {
  dialect: SqlExportDialect
  table: string
  /** Rows in one INSERT, 1..1000. */
  rowsPerInsert: number
  transaction: boolean
  /** The chosen columns (dot paths), else the leaf paths of the first documents. */
  fields: string[] | null
  /** The export time written in the header; now by default. */
  now?: Date
  /** MySQL: nested values in LONGTEXT (the same JSON text) instead of JSON, for older tools. */
  jsonAsText?: boolean
}

type Dialect = SqlExportDialect
type Kind = 'int' | 'long' | 'double' | 'decimal' | 'bool' | 'date' | 'oid' | 'text' | 'binary' | 'json'

interface Column {
  path: string
  /** Quoted for the dialect. */
  name: string
  kind: Kind
  key: boolean
  /** A MySQL DECIMAL's decimals (0–30), from its first values; widened by a later one. */
  scale?: number
  /** A MySQL DECIMAL's most whole digits written: what a wider scale must leave room for. */
  whole?: number
}

/** Documents read before the columns and their types are fixed. */
const SAMPLE_DOCS = 100
/** InnoDB holds 1017 columns, PostgreSQL 1600: a wider table would not load. */
const MAX_COLUMNS = Math.min(MAX_FIELDS, 1000)
/** An INSERT ends once it is this long (as mysqldump's net_buffer_length), far below max_allowed_packet. */
const INSERT_CHARS = MiB
/** Longest name: MySQL counts characters, PostgreSQL bytes; SQLite has no limit, this keeps lines sane. */
const NAME_MAX: Record<Dialect, number> = { mysql: 64, postgres: 63, sqlite: 1024 }
/** InnoDB keys hold 3072 bytes: 768 four-byte characters. */
const MYSQL_KEY_CHARS = 768
const MYSQL_KEY_BYTES = 3072

const TYPES: Record<Kind, Record<Dialect, string>> = {
  int: { mysql: 'INT', postgres: 'INTEGER', sqlite: 'INTEGER' },
  long: { mysql: 'BIGINT', postgres: 'BIGINT', sqlite: 'INTEGER' },
  double: { mysql: 'DOUBLE', postgres: 'DOUBLE PRECISION', sqlite: 'REAL' },
  decimal: { mysql: 'DECIMAL', postgres: 'NUMERIC', sqlite: 'TEXT' },
  bool: { mysql: 'TINYINT(1)', postgres: 'BOOLEAN', sqlite: 'INTEGER' },
  date: { mysql: 'DATETIME(3)', postgres: 'TIMESTAMPTZ', sqlite: 'TEXT' },
  // CHAR(24) in SQLite too (TEXT affinity): it tells the app's own reader an ObjectId (review M9).
  oid: { mysql: 'CHAR(24)', postgres: 'CHAR(24)', sqlite: 'CHAR(24)' },
  text: { mysql: 'LONGTEXT', postgres: 'TEXT', sqlite: 'TEXT' },
  binary: { mysql: 'LONGBLOB', postgres: 'BYTEA', sqlite: 'BLOB' },
  // "JSON TEXT" in SQLite: TEXT affinity, and a reader (ours too) knows the column holds JSON — an
  // array or a sub-document comes back as one (review of the data fixes, Minor 5).
  json: { mysql: 'JSON', postgres: 'JSONB', sqlite: 'JSON TEXT' },
}

const LABEL: Record<Dialect, string> = { mysql: 'MySQL', postgres: 'PostgreSQL', sqlite: 'SQLite' }

const put = async (out: Writable, text: string): Promise<void> => {
  if (!out.write(text)) await once(out, 'drain')
}

// ---- names ----

const utf8Bytes = (cp: number) => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4)

/** At most `max` characters (bytes for PostgreSQL), never splitting one. */
function shorten(s: string, d: Dialect, max: number): string {
  let used = 0
  let end = 0
  for (const ch of s) {
    used += d === 'postgres' ? utf8Bytes(ch.codePointAt(0)!) : 1
    if (used > max) break
    end += ch.length
  }
  return s.slice(0, end)
}

/** A name every dialect accepts: no NUL; MySQL also no character beyond the BMP, no trailing space. */
function cleanName(name: string, d: Dialect): string {
  let s = name.replaceAll('\0', '_')
  if (d === 'mysql') {
    let bmp = ''
    for (const ch of s) bmp += ch.length > 1 ? '_' : ch
    s = bmp
  }
  s = shorten(s, d, NAME_MAX[d])
  if (d === 'mysql') {
    let end = s.length
    while (end > 0 && s[end - 1] === ' ') end--
    s = s.slice(0, end) + '_'.repeat(s.length - end)
  }
  return s || '_'
}

const quoteName = (name: string, d: Dialect) =>
  d === 'mysql' ? `\`${name.replaceAll('`', '``')}\`` : `"${name.replaceAll('"', '""')}"`

/** Names (columns, tables), unique as the dialect compares them (MySQL and SQLite ignore case). */
export function uniqueNames(paths: string[], d: Dialect): string[] {
  const seen = new Set<string>()
  const key = (s: string) => (d === 'postgres' ? s : s.toLowerCase())
  return paths.map((path) => {
    const base = cleanName(path, d)
    let name = base
    for (let n = 2; seen.has(key(name)); n++) {
      const suffix = `_${n}`
      name = shorten(base, d, NAME_MAX[d] - suffix.length) + suffix
    }
    seen.add(key(name))
    return name
  })
}

/** A name in a comment: one line, whatever it holds. */
function oneLine(s: string): string {
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    out += c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 ? '?' : ch
  }
  return out
}

// ---- values ----

const MYSQL_ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  "'": "''",
  '\0': '\\0',
  '\n': '\\n',
  '\r': '\\r',
  '\x1a': '\\Z',
}

/** A string literal: the only place a value's text is written. */
function quoteString(s: string, d: Dialect, cut: () => void): string {
  if (d === 'mysql') {
    let out = "'"
    let from = 0
    for (let i = 0; i < s.length; i++) {
      const esc = MYSQL_ESCAPES[s[i]!]
      if (esc === undefined) continue
      out += s.slice(from, i) + esc
      from = i + 1
    }
    return `${out}${s.slice(from)}'`
  }
  if (d === 'sqlite') {
    if (s.includes('\0')) return `CAST(X'${Buffer.from(s, 'utf8').toString('hex')}' AS TEXT)`
    return `'${s.replaceAll("'", "''")}'`
  }
  if (s.includes('\0')) {
    s = s.replaceAll('\0', '')
    cut()
  }
  // E'…' reads backslashes the same whatever standard_conforming_strings says.
  if (s.includes('\\')) return `E'${s.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`
  return `'${s.replaceAll("'", "''")}'`
}

/** JSON text without its \u0000 escapes (jsonb refuses them); an escaped backslash stays. */
function dropNulEscapes(json: string, cut: () => void): string {
  if (!json.includes('\\u0000')) return json
  let out = ''
  let from = 0
  for (let i = 0; i < json.length; i++) {
    if (json[i] !== '\\') continue
    if (json.startsWith('u0000', i + 1)) {
      out += json.slice(from, i)
      from = i + 6
      i += 5
    } else i++
  }
  cut()
  return out + json.slice(from)
}

/** What a value is, for its column's type. */
function kindOf(v: unknown): Kind | null {
  if (v === undefined || v === null) return null
  if (typeof v === 'string') return 'text'
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'bigint') return 'long'
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) return 'double'
    return v >= -2147483648 && v <= 2147483647 ? 'int' : Number.isSafeInteger(v) ? 'long' : 'double'
  }
  if (v instanceof Date) return 'date'
  switch (bsonKind(v)) {
    case 'Int32':
      return 'int'
    case 'Long':
      return 'long'
    case 'Double':
      return 'double'
    case 'Decimal128':
      return 'decimal'
    case 'ObjectId':
      return 'oid'
    case 'Binary':
      return 'binary'
  }
  return 'json'
}

const NUMERIC: ReadonlySet<Kind> = new Set(['int', 'long', 'double', 'decimal'])

/** One kind for a column's values: numbers widen, other mixes are text. */
function widen(values: unknown[]): Kind {
  const kinds = new Set<Kind>()
  for (const v of values) {
    const k = kindOf(v)
    if (k) kinds.add(k)
  }
  if (kinds.size === 0) return 'text'
  if (kinds.size === 1) return [...kinds][0]!
  // A sub-document beside other values: JSON holds them all, and gives each back (review Minor 5).
  if (kinds.has('json')) return 'json'
  if (![...kinds].every((k) => NUMERIC.has(k))) return 'text'
  return kinds.has('decimal') ? 'decimal' : kinds.has('double') ? 'double' : 'long'
}

/** An integer value's digits (Int32, Long, bigint, a whole number), else null. */
function integerText(v: unknown): string | null {
  if (typeof v === 'bigint') return String(v)
  const kind = bsonKind(v)
  if (kind === 'Long') return /^-?\d+$/.test(String(v)) ? String(v) : null
  if (typeof v !== 'number' && kind !== 'Int32' && kind !== 'Double') return null
  const n = numberValue(v)
  return n !== null && Number.isSafeInteger(n) ? String(n) : null
}

const INT32 = [-(2n ** 31n), 2n ** 31n - 1n] as const
const INT64 = [-(2n ** 63n), 2n ** 63n - 1n] as const
const within = (digits: string, [lo, hi]: readonly [bigint, bigint]) => {
  const b = BigInt(digits)
  return b >= lo && b <= hi
}

/** A number's text: digits, a decimal's exact text, a double's shortest; "NaN", "Infinity", "-Infinity". */
function numericText(v: unknown): string | null {
  const t = integerText(v)
  if (t !== null) return checkedNumber(t)
  if (bsonKind(v) === 'Decimal128') return checkedNumber(String(v))
  const n = numberValue(v)
  return n === null ? null : checkedNumber(String(n))
}

/** Review M7: text written unquoted is a number's, or nothing is written as it. */
const NUMBER = /^-?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|NaN|Infinity)$/
const checkedNumber = (t: string): string | null => (NUMBER.test(t) ? t : null)

const isSpecial = (s: string) => s === 'NaN' || s === 'Infinity' || s === '-Infinity'

/** MySQL's DECIMAL: 65 digits, of which at most 30 decimals. */
const DECIMAL_DIGITS = 65
const DECIMAL_SCALE = 30

/** Trailing zeros beyond this many are padding, never a scale to keep. */
const PADDING_ZEROS = 2

/**
 * A number's digits: whole ones, the decimals it is written with (Decimal128 keeps them: "234.20"
 * has 2) and those that are not trailing zeros (1).
 */
interface DecimalShape {
  whole: number
  written: number
  significant: number
}
function decimalShape(s: string): DecimalShape | null {
  const m = /^-?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s)
  if (!m) return null
  const frac = m[2] ?? ''
  // The value is digits × 10^exp.
  const exp = Number(m[3] ?? '0') - frac.length
  const digits = (m[1]! + frac).replace(/^0+/, '')
  const zeros = digits.length - digits.replace(/0+$/, '').length
  return {
    whole: digits ? Math.max(0, digits.length + exp) : 0,
    written: Math.max(0, -exp),
    significant: digits ? Math.max(0, -(exp + zeros)) : 0,
  }
}
/** The decimals a value asks of its column: as written, unless its trailing zeros are padding. */
function shapeScale(x: DecimalShape): number {
  return x.written - x.significant <= PADDING_ZEROS
    ? x.written
    : Math.max(x.significant, Math.min(x.written, PADDING_ZEROS))
}
/** A numeric value's shape; null for none, NaN or ±Infinity. */
function decimalOf(v: unknown): DecimalShape | null {
  const t = v === undefined || v === null ? null : numericText(v)
  return t === null || isSpecial(t) ? null : decimalShape(t)
}

/**
 * A number in plain notation if DECIMAL(65,scale) holds it exactly (MySQL reads 1E5 as a double):
 * never more decimals than the scale (it would round), never more whole digits than 65 - scale.
 */
function plainDecimal(s: string, scale: number): string | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s)
  if (!m) return null
  const frac = m[3] ?? ''
  let digits = m[2]! + frac
  let start = 0
  while (start < digits.length && digits[start] === '0') start++
  digits = digits.slice(start)
  if (!digits) return '0'
  let e = Number(m[4] ?? '0') - frac.length
  let end = digits.length
  while (digits[end - 1] === '0') end--
  e += digits.length - end
  digits = digits.slice(0, end)
  const intDigits = digits.length + e
  if (intDigits > DECIMAL_DIGITS - scale || -e > scale) return null
  const plain =
    e >= 0
      ? digits + '0'.repeat(e)
      : intDigits > 0
        ? `${digits.slice(0, intDigits)}.${digits.slice(intDigits)}`
        : `0.${'0'.repeat(-intDigits)}${digits}`
  return m[1] + plain
}

/** NaN and the infinities where a column cannot hold them as numbers. */
function special(s: string, type: 'float8' | 'numeric', d: Dialect, cut: () => void): string {
  if (d === 'postgres') return `'${s}'::${type}`
  if (d === 'sqlite' && s !== 'NaN') return s === 'Infinity' ? '9e999' : '-9e999'
  cut()
  return 'NULL'
}

function dateText(v: unknown, d: Dialect): string | null {
  if (!(v instanceof Date) || Number.isNaN(v.getTime())) return null
  const y = v.getUTCFullYear()
  if (d === 'mysql' ? y < 1000 || y > 9999 : d === 'postgres' ? y < 1 || y > 9999 : false) return null
  const iso = v.toISOString()
  if (d === 'sqlite') return iso
  const s = `${iso.slice(0, 10)} ${iso.slice(11, 23)}`
  return d === 'postgres' ? `${s}+00` : s
}

/** A value as text, for a column of mixed kinds (as CSV writes it). */
function textForm(v: unknown): string | null {
  const c = outCell(v)
  switch (c.t) {
    case 'text':
    case 'digits':
      return c.v
    case 'num':
    case 'bool':
      return String(c.v)
    case 'date':
      return Number.isNaN(c.v.getTime()) ? null : c.v.toISOString()
    case 'empty':
      return null
  }
}

/** A value as a literal for its column, or null when the column cannot hold it. */
function literal(v: unknown, col: Column, d: Dialect, cut: () => void): string | null {
  switch (col.kind) {
    case 'int':
    case 'long': {
      const t = integerText(v)
      return t !== null && within(t, col.kind === 'int' ? INT32 : INT64) ? t : null
    }
    case 'double': {
      const t = numericText(v)
      if (t === null) return null
      const n = Number(t)
      return Number.isFinite(n) ? (integerText(v) ?? String(n)) : special(String(n), 'float8', d, cut)
    }
    case 'decimal': {
      const t = numericText(v)
      if (t === null) return null
      if (d === 'sqlite') return quoteString(t, d, cut)
      if (isSpecial(t)) return special(t, 'numeric', d, cut)
      return d === 'postgres' ? t : plainDecimal(t, col.scale ?? DECIMAL_SCALE)
    }
    case 'bool':
      if (typeof v !== 'boolean') return null
      return d === 'postgres' ? (v ? 'TRUE' : 'FALSE') : v ? '1' : '0'
    case 'date': {
      const t = dateText(v, d)
      return t === null ? null : quoteString(t, d, cut)
    }
    case 'oid':
      return bsonKind(v) === 'ObjectId'
        ? quoteString((v as { toHexString(): string }).toHexString(), d, cut)
        : null
    case 'binary': {
      if (bsonKind(v) !== 'Binary') return null
      const hex = (v as { toString(encoding: 'hex'): string }).toString('hex')
      if (!/^[0-9a-f]*$/.test(hex)) return null
      if (d === 'mysql' && col.key && hex.length / 2 > MYSQL_KEY_BYTES) return null
      // bytea's hex input, in an E'' string whatever the server's settings — a value, never a
      // function call a reader refuses (data review 2026-10-13, M9).
      return d === 'postgres' ? `E'\\\\x${hex}'` : `X'${hex}'`
    }
    case 'text': {
      const t = textForm(v)
      if (t === null || (d === 'mysql' && col.key && t.length > MYSQL_KEY_CHARS)) return null
      return quoteString(t, d, cut)
    }
    case 'json': {
      let json: string
      try {
        json = ejsonText(v, { relaxed: true })
      } catch {
        return null
      }
      return quoteString(d === 'postgres' ? dropNulEscapes(json, cut) : json, d, cut)
    }
  }
}

function columnType(col: Column, d: Dialect, jsonAsText: boolean): string {
  if (d === 'mysql' && col.kind === 'decimal')
    return `DECIMAL(${DECIMAL_DIGITS},${col.scale ?? DECIMAL_SCALE})`
  if (d === 'mysql' && col.kind === 'json' && jsonAsText) return TYPES.text.mysql
  if (col.key && d === 'mysql') {
    // A key needs a length, and a case-sensitive one: "a" and "A" are two _ids.
    if (col.kind === 'text') return `VARCHAR(${MYSQL_KEY_CHARS}) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`
    if (col.kind === 'binary') return `VARBINARY(${MYSQL_KEY_BYTES})`
  }
  return TYPES[col.kind][d]
}

// ---- columns ----

function columnPaths(docs: Document[], fields: string[] | null): string[] {
  if (fields) return [...new Set(fields)].slice(0, MAX_COLUMNS)
  const seen = new Set<string>()
  for (const doc of docs)
    for (const p of leafPaths(doc, MAX_COLUMNS)) {
      if (seen.size >= MAX_COLUMNS) break
      seen.add(p)
    }
  const paths = wholeAbove([...seen])
  return paths.includes('_id') ? ['_id', ...paths.filter((p) => p !== '_id')] : paths
}

const noCut = () => undefined

/** Types from the first documents; _id is the key when every one has an _id the key column holds. */
function inferColumns(paths: string[], docs: Document[], d: Dialect): Column[] {
  const names = uniqueNames(paths, d)
  return paths.map((path, i) => {
    const values = docs.map((doc) => cellValue(doc, path))
    const col: Column = { path, name: quoteName(names[i]!, d), kind: widen(values), key: false }
    // A MySQL DECIMAL's decimals: those its first values ask (more than 30: text).
    if (d === 'mysql' && col.kind === 'decimal') {
      const shapes = values.map(decimalOf).filter((x): x is DecimalShape => x !== null)
      col.scale = Math.min(DECIMAL_SCALE + 1, Math.max(0, ...shapes.map(shapeScale)))
      col.whole = Math.max(0, ...shapes.map((x) => x.whole))
      if (col.scale > DECIMAL_SCALE) col.kind = 'text'
    }
    const holds = (c: Column) =>
      values.every((v) => v === undefined || v === null || literal(v, c, d, noCut) !== null)
    if (!holds(col)) col.kind = 'text'
    if (
      path === '_id' &&
      col.kind !== 'json' &&
      values.length > 0 &&
      values.every((v) => v !== undefined && v !== null) &&
      holds({ ...col, key: true })
    )
      col.key = true
    return col
  })
}

const idError = () =>
  Errors.validation(
    'A document has an _id the key column chosen from the first documents cannot hold; export as JSON, or without _id',
    { reason: 'sql_id_type' },
  )

/** Spec §4: same contract as the other writers (backpressure; omitted top-level fields as CSV). */
export function sqlWriter(
  out: Writable,
  opts: SqlExportOptions,
): { write(doc: Document): Promise<void>; end(): Promise<{ cutCells: number; omittedFields: string[] }> } {
  const d = opts.dialect
  const perInsert = Math.min(1000, Math.max(1, Math.floor(opts.rowsPerInsert) || 1))
  const table = quoteName(cleanName(opts.table, d), d)
  let cutCells = 0
  const cut = () => {
    cutCells++
  }
  let sample: Document[] | null = []
  let columns: Column[] = []
  let omitted = new OmittedFields([])
  let insertHead = ''
  let rows = 0
  let chars = 0

  const header = (): string => {
    const lines = [
      '-- Mongo Manager export',
      `-- Table: ${oneLine(table)}`,
      `-- Dialect: ${LABEL[d]}`,
      `-- Exported: ${(opts.now ?? new Date()).toISOString()}`,
    ]
    const block = (s: string) => lines.push('', s)
    if (d === 'mysql') block('SET NAMES utf8mb4;')
    if (d === 'postgres') block("SET client_encoding = 'UTF8';")
    if (!columns.length) {
      block('-- No columns to export.')
      return lines.join('\n') + '\n'
    }
    // MySQL commits before any CREATE TABLE: its transaction holds the rows only.
    if (opts.transaction && d !== 'mysql') block('BEGIN;')
    const defs = columns.map(
      (c) => `  ${c.name} ${columnType(c, d, opts.jsonAsText === true)}${c.key ? ' NOT NULL' : ''}`,
    )
    const key = columns.find((c) => c.key)
    if (key) defs.push(`  PRIMARY KEY (${key.name})`)
    block(
      `CREATE TABLE ${table} (\n${defs.join(',\n')}\n)${d === 'mysql' ? ' DEFAULT CHARSET=utf8mb4' : ''};`,
    )
    if (opts.transaction && d === 'mysql') block('START TRANSACTION;')
    insertHead = `INSERT INTO ${table} (${columns.map((c) => c.name).join(', ')}) VALUES`
    return lines.join('\n') + '\n'
  }

  const cell = (doc: Document, col: Column): string => {
    const v = cellValue(doc, col.path)
    const lit = v === undefined || v === null ? 'NULL' : literal(v, col, d, cut)
    if (col.key && (lit === null || lit === 'NULL')) throw idError()
    if (lit !== null) return lit
    cut()
    return 'NULL'
  }

  /**
   * A MySQL DECIMAL a later value needs more decimals of is widened before its row, when the values
   * before it still fit (65 digits in all); the INSERT being written ends first. ALTER TABLE commits
   * in MySQL: the transaction is ended and started again, said so.
   */
  const widenFor = async (doc: Document) => {
    for (const col of columns) {
      if (col.kind !== 'decimal' || col.scale === undefined) continue
      const x = decimalOf(cellValue(doc, col.path))
      if (!x) continue
      const whole = Math.max(col.whole ?? 0, x.whole)
      if (x.significant <= col.scale && x.whole <= DECIMAL_DIGITS - col.scale) {
        col.whole = whole
        continue
      }
      const scale = Math.max(col.scale, shapeScale(x))
      if (scale > DECIMAL_SCALE || whole > DECIMAL_DIGITS - scale) continue
      col.scale = scale
      col.whole = whole
      const lines = [
        '-- A later value needs more decimals: the column is widened (MySQL commits the rows before it).',
        ...(opts.transaction ? ['COMMIT;'] : []),
        `ALTER TABLE ${table} MODIFY ${col.name} ${columnType(col, d, false)}${col.key ? ' NOT NULL' : ''};`,
        ...(opts.transaction ? ['START TRANSACTION;'] : []),
      ]
      await put(out, `${rows ? ';\n' : ''}\n${lines.join('\n')}\n`)
      rows = 0
      chars = 0
    }
  }

  const row = async (doc: Document) => {
    omitted.see(doc)
    if (!columns.length) return
    if (d === 'mysql') await widenFor(doc)
    const values = `(${columns.map((c) => cell(doc, c)).join(', ')})`
    const piece = rows === 0 ? `\n${insertHead}\n${values}` : `,\n${values}`
    rows++
    chars += piece.length
    if (rows < perInsert && chars < INSERT_CHARS) return put(out, piece)
    rows = 0
    chars = 0
    await put(out, `${piece};\n`)
  }

  const begin = async () => {
    const docs = sample!
    sample = null
    const paths = columnPaths(docs, opts.fields)
    columns = inferColumns(paths, docs, d)
    omitted = new OmittedFields(paths)
    await put(out, header())
    for (const doc of docs) await row(doc)
  }

  return {
    async write(doc) {
      if (!sample) return row(doc)
      sample.push(doc)
      if (sample.length >= SAMPLE_DOCS) await begin()
    },
    async end() {
      if (sample) await begin()
      if (columns.length) {
        if (rows) await put(out, ';\n')
        if (opts.transaction) await put(out, '\nCOMMIT;\n')
      }
      return { cutCells, omittedFields: omitted.names() }
    },
  }
}
