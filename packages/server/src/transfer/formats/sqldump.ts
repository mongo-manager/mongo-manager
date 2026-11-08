// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { isUtf8 } from 'node:buffer'
import { Binary, Decimal128, Double, Long, ObjectId } from 'bson'
import type { Document } from 'mongodb'
import { MAX_RECORD_CHARS, MiB } from '../limits'
import { INVALID_TEXT } from '../text'
import { isUnusualKey, parseJsonValue } from './json'
import type { DocRecord, RecordFailure } from './types'

/**
 * SQL transfer spec §2: a streaming reader of SQL dumps (mysqldump, pg_dump, sqlite3 .dump, plain
 * SQL). Only CREATE TABLE (and a primary key added by ALTER TABLE), INSERT … VALUES and COPY … FROM
 * stdin are read; every other statement is skipped and counted by kind. Nothing is ever executed.
 *
 * A hand-written scanner turns text into tokens; a statement machine reads them. Rows stream out one
 * at a time, so neither a dump nor a statement is ever held whole. Skipped statements, tables nobody
 * asked for and rows only counted are scanned without building their text.
 *
 * The bytes are scanned as latin1, one character per byte: a dump mixes UTF-8 text with raw bytes
 * (mysqldump writes BLOBs as they are), so each literal is decoded on its own — bytes for a binary
 * column or a _binary string, strict UTF-8 for everything else (a bad sequence fails that value only).
 *
 * Choices: arrays (`integer[]`) and other types without a BSON match are text; a value whose literal
 * contradicts its column (a word in an int column) stays as it is written; casts (`'x'::jsonb`,
 * `NULL::text`) take their literal; a function call is the row's failure.
 */

export type SqlDialect = 'mysql' | 'postgres' | 'sqlite' | 'standard'
export type SqlValueKind =
  'int' | 'long' | 'decimal' | 'double' | 'bool' | 'date' | 'json' | 'binary' | 'string' | 'unknown'

export interface SqlColumn {
  name: string
  /** As written, e.g. 'decimal(10,2)'; '' for a SQLite column without a type. */
  type: string
  kind: SqlValueKind
}

export interface SqlTable {
  /** The table's identity in this dump: `schema.name`, or `name` where the dump gives no schema. */
  key: string
  /** Unqualified, as the dump names it. */
  name: string
  schema?: string
  columns: SqlColumn[]
  primaryKey: string[]
  /** The number of columns in the definition; `columns` may hold fewer (columnsPerTable). */
  columnCount: number
  rows: number
  /** The first rows, converted as the import would. */
  samples: Document[]
  /** Why no row of this table can be read (too many columns, a definition too large). */
  error?: string
}

export interface SqlScan {
  /** A best guess. */
  dialect: SqlDialect
  tables: SqlTable[]
  /** Statement kind ('DROP TABLE', 'CREATE INDEX', 'SET', 'LOCK', 'other'…) → count. */
  skipped: Record<string, number>
  /** The scan stopped early: too many tables, or the dump ends inside a string, comment or row. */
  truncated: boolean
  error?: string
}

interface SqlCommonOptions {
  /** The dialect, when the caller knows it; otherwise it is guessed from the dump. */
  dialect?: SqlDialect
  /** Stops the pass at the next slice of input: the scan resolves with what it found, the read ends. */
  signal?: AbortSignal
  /** Column names starting with $, holding dots or named __proto__ (refused by default). */
  allowUnusual?: boolean
}

export interface SqlScanOptions extends SqlCommonOptions {
  maxTables?: number
  /** Sample rows per table (5). */
  samples?: number
  /** The samples' total size across tables, in bytes of row text (16 MiB). */
  sampleBytes?: number
  /** Columns kept per table in the result (all); `columnCount` has the true number. */
  columnsPerTable?: number
  primaryKeyAsId?: boolean
}

export interface SqlReadOptions extends SqlCommonOptions {
  /** Table keys (SqlTable.key) to read; the others are skipped without building their text. */
  tables: ReadonlySet<string>
  primaryKeyAsId: boolean
  /** Primary keys from the scan, by table key: pg_dump declares them after the data. */
  primaryKeys?: Readonly<Record<string, readonly string[]>>
  /** Counts of skipped statements by kind are added here while reading. */
  skipped?: Record<string, number>
}

/**
 * `table` is a table key; '' is a failure of the dump itself (it ends inside a string…), `n` 0.
 * A record's `raw` is a statement that loads on its own (INSERT … VALUES (…); or a COPY block), or a
 * `--` comment for a row too large to keep.
 */
export type SqlRecord = { table: string; record: DocRecord | RecordFailure }

export const MAX_STATEMENT_CHARS = 64 * MiB
export const MAX_SQL_TABLES = 1000
export const MAX_SQL_COLUMNS = 1000
/** One part of a table's name (schema or name): schema.name stays within 511 characters. */
export const MAX_SQL_NAME = 255
const MAX_NAME = 4096
const MAX_NUMBER = 1024
const MAX_DEF_TOKENS = 100_000
const MAX_DEF_CHARS = 4 * MiB
const MAX_ALL_DEF_CHARS = 32 * MiB
const MAX_HEAD_TOKENS = MAX_SQL_COLUMNS * 2 + 64
const MAX_VALUE_TOKENS = 64
const SAMPLE_ROW_BYTES = 64 * 1024
const SAMPLE_BUDGET = 16 * MiB
const SLICE = 64 * 1024

// ---------------------------------------------------------------------------------------------
// Tokens

type Kind = 'word' | 'qid' | 'dq' | 'str' | 'num' | 'op' | 'dollar' | 'cc' | 'end'
interface Tok {
  t: Kind
  v: string
  /** A string's prefix: E (escapes), X (hex), B (bits), N (national). */
  pre?: string
  /** Longer than its limit; the text is dropped. */
  big?: boolean
  /** A quoted name's closing quote: ", `, ]. */
  q?: number
}

interface Sink {
  token(tok: Tok): void
  line(text: string): void
  copyRow(fields: Array<string | null> | null, extra: number, raw: string, big: boolean): void
  copyEnd(): void
  eof(unterminated: string | null): void
}

type State =
  | 'normal'
  | 'word'
  | 'num'
  | 'str'
  | 'strQuote'
  | 'esc'
  | 'oct'
  | 'hex'
  | 'uni'
  | 'qid'
  | 'qidQuote'
  | 'lineComment'
  | 'blockFirst'
  | 'block'
  | 'dollarTag'
  | 'dollar'
  | 'rawLine'
  | 'copySkip'
  | 'copy'
  | 'copyLight'

const isDigit = (c: number) => c >= 48 && c <= 57
const isWordStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 0x80
const isWordChar = (c: number) => isWordStart(c) || isDigit(c) || c === 36
const isSpace = (c: number) => c === 32 || (c >= 9 && c <= 13)
function hexVal(c: number): number {
  if (c >= 48 && c <= 57) return c - 48
  if (c >= 97 && c <= 102) return c - 87
  if (c >= 65 && c <= 70) return c - 55
  return -1
}

const MYSQL_ESCAPES: Record<string, string> = {
  '0': '\0',
  b: '\b',
  n: '\n',
  r: '\r',
  t: '\t',
  Z: '\x1a',
  // MySQL keeps the backslash of \% and \_ outside LIKE patterns.
  '%': '\\%',
  _: '\\_',
}
const PG_ESCAPES: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }

/**
 * Text to tokens, fed chunk by chunk: every construct may be cut anywhere by a chunk boundary.
 * In light mode the text of strings, quoted names and numbers is not kept (words always are).
 */
class Lexer {
  dialect: SqlDialect | undefined
  /**
   * The dump is the app's own export ("-- Mongo Manager export"): its CHAR(24) columns hold
   * ObjectIds and its "sub.a" columns a nested field (data review 2026-10-13, M9).
   */
  ours = false
  /** pg's standard_conforming_strings = off: backslash escapes in plain strings. */
  pgBackslash = false
  delimiter = ';'
  light = false
  /** Characters before the current chunk, and the index of the last emitted token's end. */
  base = 0
  cur = 0
  private s = ''
  private st: State = 'normal'
  private pend = 0
  private adj = false
  private opRun = ''
  private kind: Kind = 'str'
  private keep = true
  private parts: string[] = []
  private len = 0
  private cap = 0
  private big = false
  private pre: string | undefined
  private closer = 0
  /** 'probe': no dialect yet; a \' or \\ makes the dump MySQL. */
  private esc: 'mysql' | 'pg' | 'probe' | null = null
  private escBack: 'str' | 'copy' = 'str'
  private escVal = 0
  private escN = 0
  private escMax = 0
  private numFirst = 0
  private numLen = 0
  private numHex = false
  private numLast = 0
  private tag = ''
  private close = ''
  private match = 0
  private depth = 0
  private prev = 0
  private cc = false
  private note = ''
  private noteOn = false
  private noteFirst = false
  private capOn = false
  private capParts: string[] = []
  private capLen = 0
  private capFrom = 0
  private fields: Array<string | null> = []
  private extra = 0
  private fieldRaw = 0
  private nullField = false
  private lineStart = 0
  private lineCR = false
  private lineKept = 0
  private lineBig = false
  private head = ''
  private lineLen = 0

  constructor(private readonly sink: Sink) {}

  get at(): number {
    return this.base + this.cur
  }

  mark(d: SqlDialect): void {
    this.dialect ??= d
  }

  readLine(): void {
    this.st = 'rawLine'
    this.note = ''
  }

  startCopy(): void {
    this.st = 'copySkip'
  }

  startCapture(from = this.cur): void {
    this.capOn = true
    this.capParts = []
    this.capLen = 0
    this.capFrom = from
  }

  /** The captured text up to `to` (exclusive) in the current chunk, at most one record's size. */
  stopCapture(to = this.cur + 1): string {
    if (!this.capOn) return ''
    this.capAppend(this.s, this.capFrom, to)
    this.capOn = false
    const raw = this.capParts.join('')
    this.capParts = []
    return raw
  }

  endCapture(): void {
    this.capOn = false
    this.capParts = []
  }

  private capAppend(s: string, a: number, b: number): void {
    if (this.capLen >= MAX_RECORD_CHARS || b <= a) return
    const piece = s.slice(a, Math.min(b, a + MAX_RECORD_CHARS - this.capLen))
    this.capParts.push(piece)
    this.capLen += piece.length
  }

  feed(s: string): void {
    this.s = s
    if (this.capOn) this.capFrom = 0
    const n = s.length
    let i = 0
    while (i < n) i = this.step(s, i, n)
    if (this.capOn) this.capAppend(s, this.capFrom, n)
    this.base += n
    this.cur = 0
  }

  private step(s: string, i: number, n: number): number {
    switch (this.st) {
      case 'normal':
        return this.normal(s, i)
      case 'word':
        return this.word(s, i, n)
      case 'num':
        return this.num(s, i, n)
      case 'str':
        return this.str(s, i, n)
      case 'strQuote':
        return this.strQuote(s, i)
      case 'esc':
        return this.escape(s, i)
      case 'oct':
      case 'hex':
      case 'uni':
        return this.escDigits(s, i)
      case 'qid':
        return this.qid(s, i, n)
      case 'qidQuote':
        return this.qidQuote(s, i)
      case 'lineComment':
        return this.lineComment(s, i, n)
      case 'blockFirst':
        return this.blockFirst(s, i)
      case 'block':
        return this.block(s, i, n)
      case 'dollarTag':
        return this.dollarTag(s, i)
      case 'dollar':
        return this.dollar(s, i, n)
      case 'rawLine':
        return this.rawLine(s, i, n)
      case 'copySkip':
        return this.copySkip(s, i, n)
      case 'copy':
        return this.copy(s, i, n)
      case 'copyLight':
        return this.copyLight(s, i, n)
    }
  }

  // --- token text

  private begin(kind: Kind, cap: number): void {
    this.kind = kind
    this.keep = kind === 'word' || !this.light
    this.parts = []
    this.len = 0
    this.cap = cap
    this.big = false
    this.pre = undefined
  }

  private add(s: string): void {
    if (!this.keep || this.big || s.length === 0) return
    if (this.len + s.length > this.cap) return this.overflow()
    this.parts.push(s)
    this.len += s.length
  }

  private overflow(): void {
    this.big = true
    this.parts = []
    this.len = 0
  }

  private text(): string {
    const v = this.parts.length === 1 ? this.parts[0]! : this.parts.join('')
    this.parts = []
    this.len = 0
    return v
  }

  private emit(t: Kind, v: string, at: number, pre?: string, big?: boolean, q?: number): void {
    this.cur = at
    const tok: Tok = { t, v }
    if (pre) tok.pre = pre
    if (big) tok.big = true
    if (q) tok.q = q
    this.sink.token(tok)
  }

  private op(v: string, at: number): void {
    this.emit('op', v, at)
    if (this.delimiter !== ';') {
      this.opRun = (this.opRun + v).slice(-32)
      if (this.opRun.endsWith(this.delimiter)) {
        this.opRun = ''
        this.emit('end', '', at)
      }
    }
  }

  private emitWord(v: string, at: number, big: boolean): void {
    this.opRun = ''
    if (this.delimiter !== ';' && v === this.delimiter) this.emit('end', '', at)
    else this.emit('word', v, at, undefined, big)
  }

  // --- states

  private normal(s: string, i: number): number {
    const c = s.charCodeAt(i)
    if (this.pend) {
      const p = this.pend
      this.pend = 0
      if (p === 45 && c === 45) {
        this.st = 'lineComment'
        this.note = ''
        // The notes at the start of a dump: its tool, its dialect, and whether it is ours (its
        // first line, after a byte order mark).
        this.noteFirst = this.base + i - 1 <= 1
        this.noteOn = this.dialect === undefined || this.noteFirst
        return i + 1
      }
      if (p === 47 && c === 42) {
        this.st = 'blockFirst'
        this.depth = 1
        this.prev = 0
        return i + 1
      }
      if (p === 58 && c === 58) {
        this.op('::', i)
        return i + 1
      }
      this.op(String.fromCharCode(p), i)
      return i
    }
    if (isSpace(c)) {
      this.opRun = ''
      this.adj = false
      return i + 1
    }
    const adj = this.adj
    this.adj = false
    if (isWordStart(c)) {
      this.begin('word', MAX_NAME)
      this.st = 'word'
      return i
    }
    if (isDigit(c)) {
      this.begin('num', MAX_NUMBER)
      this.numFirst = c
      this.numLen = 0
      this.numHex = false
      this.numLast = 0
      this.st = 'num'
      return i
    }
    switch (c) {
      case 0x27:
        this.openStr(undefined)
        return i + 1
      case 0x22:
        if (this.dialect === 'mysql') {
          this.begin('dq', MAX_RECORD_CHARS)
          this.closer = c
          this.esc = 'mysql'
          this.st = 'str'
        } else this.openQid(c)
        return i + 1
      case 0x60:
        this.mark('mysql')
        this.openQid(c)
        return i + 1
      case 0x5b:
        // [name] (SQL Server, SQLite); right after a word it is an array subscript: integer[].
        if (this.dialect !== 'postgres' && !adj) {
          this.openQid(0x5d)
          return i + 1
        }
        break
      case 0x2d:
      case 0x2f:
      case 0x3a:
        this.pend = c
        return i + 1
      case 0x23:
        if (this.dialect !== 'postgres') {
          this.st = 'lineComment'
          this.note = ''
          this.noteOn = false
          return i + 1
        }
        break
      case 0x24:
        if (this.dialect !== 'mysql') {
          this.tag = ''
          this.st = 'dollarTag'
          return i + 1
        }
        break
      case 0x3b:
        if (this.delimiter === ';') {
          this.opRun = ''
          this.emit('end', '', i)
          return i + 1
        }
        break
    }
    this.op(s[i]!, i)
    return i + 1
  }

  private openStr(pre: string | undefined): void {
    this.begin('str', MAX_RECORD_CHARS)
    this.pre = pre
    this.closer = 0x27
    if (pre === 'E') this.esc = 'pg'
    else if (pre === 'X' || pre === 'B') this.esc = null
    else if (this.dialect === 'mysql') this.esc = 'mysql'
    else if (this.pgBackslash) this.esc = 'pg'
    else this.esc = this.dialect === undefined ? 'probe' : null
    this.st = 'str'
  }

  private openQid(closer: number): void {
    this.begin('qid', MAX_NAME)
    this.closer = closer
    this.st = 'qid'
  }

  private word(s: string, i: number, n: number): number {
    let j = i
    while (j < n && isWordChar(s.charCodeAt(j))) j++
    this.add(s.slice(i, j))
    if (j === n) return j
    const big = this.big
    const v = this.text()
    this.st = 'normal'
    if (s.charCodeAt(j) === 0x27 && v.length === 1 && 'EeXxBbNn'.includes(v)) {
      this.openStr(v.toUpperCase())
      return j + 1
    }
    this.adj = true
    this.emitWord(v, j, big)
    return j
  }

  private num(s: string, i: number, n: number): number {
    let j = i
    while (j < n) {
      const c = s.charCodeAt(j)
      const sign =
        (c === 0x2b || c === 0x2d) && (this.numLast === 0x65 || this.numLast === 0x45) && !this.numHex
      if (!isWordChar(c) && c !== 0x2e && !sign) break
      if (this.numLen === 1 && this.numFirst === 0x30 && (c === 0x78 || c === 0x58)) this.numHex = true
      this.numLast = c
      this.numLen++
      j++
    }
    this.add(s.slice(i, j))
    if (j === n) return j
    const big = this.big
    this.st = 'normal'
    this.adj = true
    this.emit('num', this.text(), j, undefined, big)
    return j
  }

  private str(s: string, i: number, n: number): number {
    const q = this.closer
    let j: number
    if (this.esc) {
      j = i
      while (j < n) {
        const c = s.charCodeAt(j)
        if (c === q || c === 0x5c) break
        j++
      }
    } else {
      j = s.indexOf(String.fromCharCode(q), i)
      if (j < 0) j = n
    }
    this.add(s.slice(i, j))
    if (j === n) return n
    if (s.charCodeAt(j) === 0x5c) {
      this.st = 'esc'
      this.escBack = 'str'
      return j + 1
    }
    this.st = 'strQuote'
    return j + 1
  }

  private strQuote(s: string, i: number): number {
    if (s.charCodeAt(i) === this.closer) {
      this.add(s[i]!)
      this.st = 'str'
      return i + 1
    }
    this.finishStr(i)
    return i
  }

  private finishStr(at: number): void {
    const big = this.big
    const v = this.text()
    this.st = 'normal'
    this.emit(this.kind, v, at, this.pre, big)
  }

  private escape(s: string, i: number): number {
    const c = s.charCodeAt(i)
    const ch = s[i]!
    const copy = this.escBack === 'copy'
    if (copy) {
      if (c === 0x4e && this.fieldRaw === 1) this.nullField = true
      this.fieldRaw++
    }
    if (!copy && this.esc === 'probe') {
      // Standard SQL has no escapes, but \' and \\ only make sense in MySQL: the dump is MySQL.
      if (c !== 0x27 && c !== 0x5c) {
        this.add('\\')
        this.st = 'str'
        return i
      }
      this.mark('mysql')
      this.esc = 'mysql'
    }
    if (!copy && this.esc === 'mysql') {
      this.add(MYSQL_ESCAPES[ch] ?? ch)
      this.st = 'str'
      return i + 1
    }
    if (c >= 0x30 && c <= 0x37) {
      this.escVal = c - 48
      this.escN = 1
      this.escMax = 3
      this.st = 'oct'
      return i + 1
    }
    if (c === 0x78 || (!copy && (c === 0x75 || c === 0x55))) {
      this.escVal = 0
      this.escN = 0
      this.escMax = c === 0x78 ? 2 : c === 0x75 ? 4 : 8
      this.st = c === 0x78 ? 'hex' : 'uni'
      return i + 1
    }
    this.add(PG_ESCAPES[ch] ?? ch)
    this.st = this.escBack
    return i + 1
  }

  /** Octal (\101), hex (\x41) and Unicode (\u00e7) escapes of pg E'' strings and COPY data. */
  private escDigits(s: string, i: number): number {
    const c = s.charCodeAt(i)
    const d = this.st === 'oct' ? (c >= 48 && c <= 55 ? c - 48 : -1) : hexVal(c)
    if (d >= 0 && this.escN < this.escMax) {
      this.escVal = this.escVal * (this.st === 'oct' ? 8 : 16) + d
      this.escN++
      if (this.escBack === 'copy') this.fieldRaw++
      if (this.escN < this.escMax) return i + 1
      this.endEscape()
      return i + 1
    }
    this.endEscape()
    return i
  }

  /** Text is held as bytes (latin1): a byte escape is one character, a code point its UTF-8 bytes. */
  private endEscape(): void {
    if (this.st === 'oct') this.add(String.fromCharCode(this.escVal & 0xff))
    else if (this.st === 'hex') this.add(this.escN === 0 ? 'x' : String.fromCharCode(this.escVal))
    else {
      const cp = this.escVal
      const ok = this.escN === this.escMax && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)
      // An impossible code point becomes a byte that is never UTF-8: the value fails, not the dump.
      this.add(ok ? Buffer.from(String.fromCodePoint(cp), 'utf8').toString('latin1') : '\xff')
    }
    this.st = this.escBack
  }

  private qid(s: string, i: number, n: number): number {
    let j = s.indexOf(String.fromCharCode(this.closer), i)
    if (j < 0) j = n
    this.add(s.slice(i, j))
    if (j === n) return n
    this.st = 'qidQuote'
    return j + 1
  }

  private qidQuote(s: string, i: number): number {
    if (s.charCodeAt(i) === this.closer) {
      this.add(s[i]!)
      this.st = 'qid'
      return i + 1
    }
    const big = this.big
    this.st = 'normal'
    this.adj = true
    this.emit('qid', this.text(), i, undefined, big, this.closer)
    return i
  }

  private lineComment(s: string, i: number, n: number): number {
    const j = s.indexOf('\n', i)
    const end = j < 0 ? n : j
    if (this.noteOn && this.note.length < 64)
      this.note += s.slice(i, Math.min(end, i + 64 - this.note.length))
    if (j < 0) return n
    this.st = 'normal'
    this.endNote()
    return j + 1
  }

  private endNote(): void {
    if (!this.noteOn) return
    this.noteOn = false
    const s = this.note.trim().toLowerCase()
    // The app's mark counts only as the dump's first line (review of the fix, Minor 4).
    if (s === 'mongo manager export') this.ours = this.noteFirst
    else if (s.startsWith('mysql dump') || s.startsWith('mariadb dump') || s.startsWith('phpmyadmin'))
      this.mark('mysql')
    else if (s.startsWith('postgresql database dump')) this.mark('postgres')
    // Our own export names its dialect (data review 2026-10-13, H2: a SQLite export was guessed
    // MySQL at its first backslash, and its text changed).
    else if (s === 'dialect: sqlite') this.mark('sqlite')
    else if (s === 'dialect: postgresql') this.mark('postgres')
    else if (s === 'dialect: mysql') this.mark('mysql')
  }

  private blockFirst(s: string, i: number): number {
    this.st = 'block'
    this.note = ''
    this.cc = s.charCodeAt(i) === 0x21
    if (!this.cc) return i
    // MySQL's /*!40101 … */: its content is never run, only read for the statement's kind.
    this.mark('mysql')
    return i + 1
  }

  private block(s: string, i: number, n: number): number {
    const nest = this.dialect === 'postgres'
    let j = i
    while (j < n) {
      const c = s.charCodeAt(j)
      j++
      if (this.prev === 42 && c === 47) {
        this.prev = 0
        if (--this.depth === 0) {
          this.st = 'normal'
          if (this.cc) {
            const v = this.note.endsWith('*') ? this.note.slice(0, -1) : this.note
            this.emit('cc', v, j - 1)
          }
          return j
        }
        continue
      }
      if (nest && this.prev === 47 && c === 42) {
        this.depth++
        this.prev = 0
        continue
      }
      this.prev = c
      if (this.cc && this.note.length < 128) this.note += String.fromCharCode(c)
    }
    return j
  }

  private dollarTag(s: string, i: number): number {
    const c = s.charCodeAt(i)
    if (c === 0x24) {
      this.begin('dollar', MAX_RECORD_CHARS)
      this.close = '$' + this.tag + '$'
      this.match = 0
      this.st = 'dollar'
      this.mark('postgres')
      return i + 1
    }
    const tagChar = (c < 0x80 && isWordStart(c)) || (isDigit(c) && this.tag.length > 0)
    if (tagChar && this.tag.length < 64) {
      this.tag += s[i]
      return i + 1
    }
    // Not a dollar quote ($1, a stray $): an operator and whatever followed it.
    this.st = 'normal'
    this.op('$', i)
    if (this.tag) this.emitWord(this.tag, i, false)
    return i
  }

  private dollar(s: string, i: number, n: number): number {
    if (this.match === 0) {
      const j = s.indexOf('$', i)
      if (j < 0) {
        this.add(s.slice(i))
        return n
      }
      this.add(s.slice(i, j))
      this.match = 1
      return j + 1
    }
    if (s.charCodeAt(i) === this.close.charCodeAt(this.match)) {
      if (++this.match < this.close.length) return i + 1
      const big = this.big
      this.st = 'normal'
      this.emit('dollar', this.text(), i, undefined, big)
      return i + 1
    }
    // The tag holds no '$', so a failed match can only restart at the current character.
    this.add(this.close.slice(0, this.match))
    this.match = 0
    return i
  }

  private rawLine(s: string, i: number, n: number): number {
    const j = s.indexOf('\n', i)
    const end = j < 0 ? n : j
    if (this.note.length < 64) this.note += s.slice(i, Math.min(end, i + 64 - this.note.length))
    if (j < 0) return n
    this.st = 'normal'
    this.cur = j
    this.sink.line(this.note)
    return j + 1
  }

  // --- COPY … FROM stdin data: tab-separated lines up to a line "\."

  private copySkip(s: string, i: number, n: number): number {
    const j = s.indexOf('\n', i)
    if (j < 0) return n
    this.startLine(j + 1)
    return j + 1
  }

  private startLine(at: number): void {
    this.lineStart = this.base + at
    this.lineCR = false
    if (this.light) {
      this.st = 'copyLight'
      this.head = ''
      this.lineLen = 0
      return
    }
    this.st = 'copy'
    this.fields = []
    this.extra = 0
    this.lineKept = 0
    this.lineBig = false
    this.startField()
    this.startCapture(at)
  }

  private startField(): void {
    this.begin('str', Math.max(0, MAX_RECORD_CHARS - this.lineKept))
    this.keep = !this.lineBig
    this.fieldRaw = 0
    this.nullField = false
  }

  private copy(s: string, i: number, n: number): number {
    let j = i
    while (j < n) {
      const c = s.charCodeAt(j)
      if (c === 9 || c === 10 || c === 92) break
      j++
    }
    if (j > i) {
      this.add(s.slice(i, j))
      this.fieldRaw += j - i
      this.lineCR = s.charCodeAt(j - 1) === 13
    }
    if (j === n) return n
    const c = s.charCodeAt(j)
    if (c === 92) {
      this.fieldRaw++
      this.lineCR = false
      this.st = 'esc'
      this.escBack = 'copy'
      return j + 1
    }
    if (c === 9) {
      this.endField(false)
      this.lineCR = false
      this.startField()
      return j + 1
    }
    this.endLine(j)
    return j + 1
  }

  private endField(last: boolean): void {
    if (this.big) this.lineBig = true
    let v: string | null = this.text()
    if (last && this.lineCR) v = v.slice(0, -1)
    if (this.nullField && this.fieldRaw === 2) v = null
    if (this.lineBig) v = ''
    if (this.fields.length <= MAX_SQL_COLUMNS) this.fields.push(v)
    else this.extra++
    this.lineKept += v?.length ?? 0
  }

  private endLine(j: number): void {
    this.cur = j
    let raw = this.stopCapture(j)
    if (this.lineCR && raw.endsWith('\r')) raw = raw.slice(0, -1)
    const length = this.base + j - this.lineStart - (this.lineCR ? 1 : 0)
    if (length === 2 && raw === '\\.') {
      this.text()
      this.st = 'normal'
      this.sink.copyEnd()
      return
    }
    this.endField(true)
    const fields = this.fields
    this.fields = []
    this.sink.copyRow(fields, this.extra, raw, this.lineBig || length > MAX_RECORD_CHARS)
    this.startLine(j + 1)
  }

  private copyLight(s: string, i: number, n: number): number {
    const j = s.indexOf('\n', i)
    const end = j < 0 ? n : j
    if (this.head.length < 3) this.head += s.slice(i, Math.min(end, i + 3 - this.head.length))
    this.lineLen += end - i
    if (j < 0) return n
    this.cur = j
    if ((this.lineLen === 2 && this.head === '\\.') || (this.lineLen === 3 && this.head === '\\.\r')) {
      this.st = 'normal'
      this.sink.copyEnd()
      return j + 1
    }
    this.sink.copyRow(null, 0, '', false)
    this.startLine(j + 1)
    return j + 1
  }

  /** The end of the input: finish the open token; report a string, comment or COPY left open. */
  end(): void {
    this.s = ''
    let bad: string | null = null
    let st = this.st
    if ((st === 'esc' || st === 'oct' || st === 'hex' || st === 'uni') && this.escBack === 'copy') {
      if (st !== 'esc') this.endEscape()
      st = 'copy'
    }
    switch (st) {
      case 'normal':
        if (this.pend) {
          const p = this.pend
          this.pend = 0
          this.op(String.fromCharCode(p), this.cur)
        }
        break
      case 'word': {
        const big = this.big
        this.st = 'normal'
        this.emitWord(this.text(), this.cur, big)
        break
      }
      case 'num': {
        const big = this.big
        this.st = 'normal'
        this.emit('num', this.text(), this.cur, undefined, big)
        break
      }
      case 'strQuote':
        this.finishStr(this.cur)
        break
      case 'qidQuote': {
        const big = this.big
        this.st = 'normal'
        this.emit('qid', this.text(), this.cur, undefined, big)
        break
      }
      case 'str':
      case 'esc':
      case 'oct':
      case 'hex':
      case 'uni':
        bad = 'a string'
        break
      case 'qid':
        bad = 'a quoted name'
        break
      case 'lineComment':
        this.endNote()
        break
      case 'blockFirst':
      case 'block':
        bad = 'a comment'
        break
      case 'dollarTag':
        this.st = 'normal'
        this.op('$', this.cur)
        if (this.tag) this.emitWord(this.tag, this.cur, false)
        break
      case 'dollar':
        bad = 'a dollar-quoted string'
        break
      case 'rawLine':
        this.st = 'normal'
        this.sink.line(this.note)
        break
      case 'copySkip':
        bad = 'COPY data that never ends with \\.'
        break
      case 'copy': {
        const length = this.base - this.lineStart
        let raw = this.stopCapture()
        if (this.lineCR && raw.endsWith('\r')) raw = raw.slice(0, -1)
        if (length > 0 && raw !== '\\.') {
          this.endField(true)
          this.sink.copyRow(this.fields, this.extra, raw, this.lineBig || length > MAX_RECORD_CHARS)
        }
        if (raw !== '\\.') bad = 'COPY data that never ends with \\.'
        else this.sink.copyEnd()
        break
      }
      case 'copyLight': {
        const h = this.head.endsWith('\r') ? this.head.slice(0, -1) : this.head
        if (h === '\\.' && this.lineLen <= 3) this.sink.copyEnd()
        else {
          if (this.lineLen > 0) this.sink.copyRow(null, 0, '', false)
          bad = 'COPY data that never ends with \\.'
        }
        break
      }
    }
    this.sink.eof(bad)
  }
}

// ---------------------------------------------------------------------------------------------
// Values

type Lit =
  | { k: 'null' }
  | { k: 'default' }
  | { k: 'bool'; v: boolean }
  | { k: 'str'; v: string; bin?: boolean }
  | { k: 'num'; v: string }
  | { k: 'hex'; v: string }
  | { k: 'bits'; v: string }
  | { k: 'bad'; why: string }

/** A set of words written as one space-separated string. */
const wordSet = (words: string) => new Set(words.split(' '))

class Bad {
  constructor(readonly why: string) {}
}

const bad = (why: string): Lit => ({ k: 'bad', why })
const clip = (s: string) => (s.length > 64 ? s.slice(0, 64) + '…' : s)
const isOp = (t: Tok | undefined, v: string) => t?.t === 'op' && t.v === v
const isWord = (t: Tok | undefined, v: string) => t?.t === 'word' && t.v.toUpperCase() === v
const upper = (t: Tok | undefined) => (t?.t === 'word' && t.v.length <= 32 ? t.v.toUpperCase() : '')

/** [+-] digits [. digits] [e [+-] digits], or [+-] . digits …: scanned by hand. */
function isNumeric(s: string): boolean {
  if (s.length === 0 || s.length > MAX_NUMBER) return false
  let i = s[0] === '-' || s[0] === '+' ? 1 : 0
  const run = () => {
    const from = i
    while (i < s.length && isDigit(s.charCodeAt(i))) i++
    return i - from
  }
  let digits = run()
  if (s[i] === '.') {
    i++
    digits += run()
  }
  if (digits === 0) return false
  if (s[i] === 'e' || s[i] === 'E') {
    i++
    if (s[i] === '-' || s[i] === '+') i++
    if (run() === 0) return false
  }
  return i === s.length
}

const SPECIAL_NUMBERS: Record<string, number> = { NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity }

function isHex(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (hexVal(s.charCodeAt(i)) < 0) return false
  return true
}

/** Each value of a row as the tokens between its commas: a literal, maybe with a cast. */
function interpret(toks: Tok[], over: boolean): Lit {
  if (over) return bad('An expression is not a value')
  if (toks.length === 0) return bad('A value is missing')
  let i = 0
  let sign = ''
  if ((isOp(toks[0], '-') || isOp(toks[0], '+')) && toks[1]?.t === 'num') {
    sign = toks[0]!.v === '-' ? '-' : ''
    i = 1
  }
  const t = toks[i]!
  if (t.big) return bad('The value is larger than 16 MiB')
  let lit: Lit
  switch (t.t) {
    case 'num':
      if (t.v.length > 2 && (t.v[1] === 'x' || t.v[1] === 'X') && t.v[0] === '0') {
        const h = t.v.slice(2)
        lit =
          sign || !isHex(h) ? bad(`${clip(t.v)} is not a value`) : { k: 'hex', v: h.length % 2 ? '0' + h : h }
      } else lit = isNumeric(t.v) ? { k: 'num', v: sign + t.v } : bad(`${clip(t.v)} is not a value`)
      break
    case 'str':
      if (t.pre === 'X')
        lit = isHex(t.v) && t.v.length % 2 === 0 ? { k: 'hex', v: t.v } : bad('An invalid hexadecimal value')
      else if (t.pre === 'B') lit = /^[01]*$/.test(t.v) ? { k: 'bits', v: t.v } : bad('An invalid bit value')
      else lit = { k: 'str', v: t.v }
      break
    case 'dq':
    case 'dollar':
      lit = { k: 'str', v: t.v }
      break
    case 'qid':
      return bad(`"${clip(t.v)}" is a quoted name, not a value`)
    case 'word': {
      const w = upper(t)
      const next = toks[i + 1]
      if (w === 'NULL') lit = { k: 'null' }
      else if (w === 'TRUE' || w === 'FALSE') lit = { k: 'bool', v: w === 'TRUE' }
      else if (w === 'DEFAULT' && toks.length === 1) return { k: 'default' }
      else if (t.v.startsWith('_') && next?.t === 'str') {
        // A MySQL character set introducer: _utf8mb4'…', _binary '…'.
        i++
        if (next.big) return bad('The value is larger than 16 MiB')
        lit = next.pre === 'X' ? interpret([next], false) : { k: 'str', v: next.v, bin: w === '_BINARY' }
      } else if (w === 'CAST' && isOp(next, '(')) return castLit(toks, i)
      else if (isOp(next, '(')) return bad(`${clip(t.v)}() is a function call, not a value`)
      else return bad(`${clip(t.v)} is not a value`)
      break
    }
    default:
      return bad('An expression is not a value')
  }
  if (lit.k === 'bad') return lit
  i++
  if (i === toks.length) return lit
  if (isOp(toks[i], '::') && castTail(toks, i)) return lit
  if (isWord(toks[i], 'COLLATE') && i + 2 === toks.length) return lit
  return bad('An expression is not a value')
}

/** `::type`, `::character varying(10)[]`: names, numbers and brackets only. */
function castTail(toks: Tok[], from: number): boolean {
  for (let i = from; i < toks.length; i++) {
    const t = toks[i]!
    if (t.t === 'word' || t.t === 'qid' || t.t === 'dq' || t.t === 'num') continue
    if (t.t === 'op' && ['::', '(', ')', '[', ']', '.', ','].includes(t.v)) continue
    return false
  }
  return true
}

/** CAST(literal AS type): the literal. */
function castLit(toks: Tok[], at: number): Lit {
  let as = -1
  for (let i = at + 2; i < toks.length; i++)
    if (isWord(toks[i], 'AS')) {
      as = i
      break
    }
  if (as < 0 || !isOp(toks[toks.length - 1], ')')) return bad('An expression is not a value')
  return interpret(toks.slice(at + 2, as), false)
}

const INT32_MIN = -2147483648n
const INT32_MAX = 2147483647n
const INT64_MIN = -9223372036854775808n
const INT64_MAX = 9223372036854775807n

function fromBig(big: bigint, long: boolean): unknown {
  if (!long && big >= INT32_MIN && big <= INT32_MAX) return Number(big)
  if (big >= INT64_MIN && big <= INT64_MAX) return Long.fromBigInt(big)
  return Decimal128.fromString(big.toString())
}

/** An integer's text as Int32 (or Long for a BIGINT column), Long beyond, Decimal128 beyond that. */
function integer(v: string, long: boolean): unknown {
  const neg = v[0] === '-'
  let i = neg || v[0] === '+' ? 1 : 0
  if (i === v.length || v.length - i > 40) return undefined
  for (let k = i; k < v.length; k++) if (!isDigit(v.charCodeAt(k))) return undefined
  while (i < v.length - 1 && v[i] === '0') i++
  const digits = v.slice(i)
  if (digits.length > 19) {
    if (digits.length > 34) return undefined
    return Decimal128.fromString((neg ? '-' : '') + digits)
  }
  return fromBig(BigInt((neg ? '-' : '') + digits), long)
}

function double(v: string): Double | undefined {
  if (Object.hasOwn(SPECIAL_NUMBERS, v)) return new Double(SPECIAL_NUMBERS[v]!)
  if (!isNumeric(v)) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? new Double(n) : undefined
}

function decimal(v: string): Decimal128 | undefined {
  if (!(Object.hasOwn(SPECIAL_NUMBERS, v) || isNumeric(v))) return undefined
  try {
    return Decimal128.fromString(v[0] === '+' ? v.slice(1) : v)
  } catch {
    return undefined
  }
}

const BOOL_TEXT: Record<string, boolean> = {
  '1': true,
  '0': false,
  t: true,
  f: false,
  true: true,
  false: false,
  y: true,
  n: false,
  yes: true,
  no: false,
  on: true,
  off: false,
}

function boolText(v: string): boolean | undefined {
  if (v.length > 5) return undefined
  const k = v.toLowerCase()
  return Object.hasOwn(BOOL_TEXT, k) ? BOOL_TEXT[k] : undefined
}

/**
 * 'YYYY-MM-DD', 'YYYY-MM-DD HH:MM[:SS[.fraction]]' (or with T), with a zone (Z, +03, +03:00, +0300)
 * or UTC without one. Read by hand; an impossible date is no date.
 */
export function parseSqlDate(v: string): Date | undefined {
  if (v.length < 10 || v.length > 48) return undefined
  const num = (a: number, b: number): number => {
    let n = 0
    for (let k = a; k < b; k++) {
      const c = v.charCodeAt(k)
      if (!isDigit(c)) return NaN
      n = n * 10 + c - 48
    }
    return n
  }
  const y = num(0, 4)
  const mo = num(5, 7)
  const d = num(8, 10)
  if (v[4] !== '-' || v[7] !== '-') return undefined
  let h = 0
  let mi = 0
  let s = 0
  let ms = 0
  let i = 10
  if (i < v.length && (v[i] === ' ' || v[i] === 'T')) {
    h = num(i + 1, i + 3)
    if (v[i + 3] !== ':') return undefined
    mi = num(i + 4, i + 6)
    i += 6
    if (v[i] === ':') {
      s = num(i + 1, i + 3)
      i += 3
      if (v[i] === '.') {
        i++
        let k = i
        while (k < v.length && k - i < 9 && isDigit(v.charCodeAt(k))) k++
        if (k === i) return undefined
        ms = Number(v.slice(i, k).padEnd(3, '0').slice(0, 3))
        i = k
      }
    }
  }
  let offset = 0
  if (i < v.length && v[i] === ' ') i++
  if (v[i] === 'Z' || v[i] === 'z') i++
  else if (v[i] === '+' || v[i] === '-') {
    const sign = v[i] === '+' ? 1 : -1
    const zh = num(i + 1, i + 3)
    i += 3
    let zm = 0
    if (v[i] === ':') {
      zm = num(i + 1, i + 3)
      i += 3
    } else if (i < v.length) {
      zm = num(i, i + 2)
      i += 2
    }
    if (!(zh <= 23 && zm <= 59)) return undefined
    offset = sign * (zh * 60 + zm) * 60_000
  }
  if (i !== v.length) return undefined
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h <= 23 && mi <= 59 && s <= 59)) return undefined
  const date = new Date(0)
  date.setUTCFullYear(y, mo - 1, d)
  date.setUTCHours(h, mi, s, ms)
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d)
    return undefined
  return new Date(date.getTime() - offset)
}

/** pg's bytea hex output: \x0a0b. */
function byteaHex(v: string): Buffer | undefined {
  if (v.length < 2 || v[0] !== '\\' || v[1] !== 'x') return undefined
  const h = v.slice(2)
  return h.length % 2 === 0 && isHex(h) ? Buffer.from(h, 'hex') : undefined
}

function fromNumber(v: string, kind: SqlValueKind): unknown {
  switch (kind) {
    case 'string':
      return v
    case 'bool':
      if (v === '1' || v === '0') return v === '1'
      break
    case 'decimal':
      return decimal(v) ?? v
    case 'double':
      return double(v) ?? v
    case 'long':
      return integer(v, true) ?? whole(v) ?? double(v) ?? v
  }
  return integer(v, false) ?? whole(v) ?? double(v) ?? v
}

/**
 * Data review 2026-10-13 (low): an integer longer than Decimal128 holds (34 digits) is kept as its
 * text, exactly — never a rounded double.
 */
function whole(v: string): string | undefined {
  return /^[+-]?\d+$/.test(v) ? v : undefined
}

const HIGH_BYTE = /[\x80-\xff]/

/** Bytes held as latin1 to UTF-8 text; undefined when they are not UTF-8. */
function utf8(v: string): string | undefined {
  if (!HIGH_BYTE.test(v)) return v
  const buf = Buffer.from(v, 'latin1')
  return isUtf8(buf) ? buf.toString('utf8') : undefined
}

/** Bytes held as latin1 to text, a bad sequence as U+FFFD: for names and messages only. */
const lenientUtf8 = (v: string) => (HIGH_BYTE.test(v) ? Buffer.from(v, 'latin1').toString('utf8') : v)

function fromText(v: string, kind: SqlValueKind, allowUnusual: boolean): unknown {
  switch (kind) {
    case 'int':
      return integer(v, false) ?? v
    case 'long':
      return integer(v, true) ?? v
    case 'decimal':
      return decimal(v) ?? v
    case 'double':
      return double(v) ?? v
    case 'bool':
      if (v.length === 1 && v.charCodeAt(0) <= 1) return v.charCodeAt(0) === 1
      return boolText(v) ?? v
    case 'date':
      if (v.startsWith('0000-00-00')) return null
      return parseSqlDate(v) ?? v
    case 'json':
      try {
        return parseJsonValue(v, { allowUnusual })
      } catch {
        return v
      }
  }
  return v
}

function fromBytes(buf: Buffer, kind: SqlValueKind, allowUnusual: boolean): unknown {
  switch (kind) {
    case 'bool':
      if (buf.length === 1 && buf[0]! <= 1) return buf[0] === 1
      break
    case 'int':
    case 'long':
      if (buf.length <= 8) return fromBig(BigInt('0x' + (buf.toString('hex') || '0')), kind === 'long')
      break
    case 'string':
    case 'json':
      if (isUtf8(buf)) return fromText(buf.toString('utf8'), kind, allowUnusual)
      break
  }
  return new Binary(buf)
}

function fromBits(v: string, kind: SqlValueKind): unknown {
  let i = 0
  while (i < v.length && v[i] === '0') i++
  const s = v.slice(i)
  if (kind === 'bool' && s.length <= 1) return s === '1'
  if (s.length <= 64) return fromBig(BigInt('0b' + (s || '0')), kind === 'long')
  return v
}

function convert(lit: Lit, kind: SqlValueKind, allowUnusual: boolean): unknown {
  switch (lit.k) {
    case 'null':
      return null
    case 'bool':
      return lit.v
    case 'num':
      return fromNumber(lit.v, kind)
    case 'str': {
      // Bytes for a binary column (pg's \x… hex, or the bytes as written), and for _binary '…'
      // where the column is unknown; strict UTF-8 text for everything else.
      if (kind === 'binary') return new Binary(byteaHex(lit.v) ?? Buffer.from(lit.v, 'latin1'))
      if (lit.bin && kind === 'unknown') return new Binary(Buffer.from(lit.v, 'latin1'))
      const text = utf8(lit.v)
      if (text === undefined) return new Bad('The text is not valid UTF-8')
      return fromText(text, kind, allowUnusual)
    }
    case 'hex':
      return fromBytes(Buffer.from(lit.v, 'hex'), kind, allowUnusual)
    case 'bits':
      return fromBits(lit.v, kind)
    default:
      return new Bad('Not a value')
  }
}

const OID_TEXT = /^[0-9a-f]{24}$/

/** A "sub.a" column of our own export: names MongoDB takes once split at the dots. */
function nestedName(n: string): boolean {
  return n.includes('.') && n.split('.').every((s) => s !== '' && !isUnusualKey(s))
}

/**
 * Our own export's row as the document it was: "sub.a" a field of sub. A NULL there is a field the
 * document did not have (the export writes both as NULL). Null when a column and one inside it
 * both hold a value.
 */
function nest(entries: Array<[string, unknown]>): Document | null {
  const doc: Document = {}
  // Defined, never set: a "__proto__" segment stays data (review of the fix, Minor 3).
  const define = (o: object, k: string, value: unknown) =>
    Object.defineProperty(o, k, { value, writable: true, enumerable: true, configurable: true })
  const isNode = (v: unknown): v is Document =>
    v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype
  for (const [name, v] of entries) {
    // A NULL is a field the document did not have, at the top too (review of the fix, Minor 5) —
    // but the _id, which names it.
    if (v === null && name !== '_id') continue
    const segs = name.split('.')
    let node = doc
    for (const s of segs.slice(0, -1)) {
      if (!Object.hasOwn(node, s)) define(node, s, {})
      const next: unknown = node[s]
      if (!isNode(next)) return null
      node = next
    }
    const last = segs[segs.length - 1]!
    if (Object.hasOwn(node, last)) return null
    define(node, last, v)
  }
  return doc
}

function quoteText(v: string, dialect: SqlDialect | undefined): string {
  if (dialect !== 'mysql') return `'${v.replaceAll("'", "''")}'`
  return `'${v.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\0', '\\0')}'`
}

/**
 * A row's values written back as SQL, for a row whose text holds bytes that are not UTF-8 (a rejected
 * file is text): such a string becomes hex — X'…' (pg: '\x…', its bytea form), everything else as read.
 */
function tupleText(lits: Lit[], dialect: SqlDialect | undefined): string {
  const out = lits.map((l): string => {
    switch (l.k) {
      case 'default':
        return 'DEFAULT'
      case 'bool':
        return l.v ? 'TRUE' : 'FALSE'
      case 'num':
        return l.v
      case 'hex':
        return `X'${l.v}'`
      case 'bits':
        return `b'${l.v}'`
      case 'str': {
        const intro = l.bin && dialect === 'mysql' ? '_binary ' : ''
        const text = utf8(l.v)
        if (text !== undefined) return intro + quoteText(text, dialect)
        const hex = Buffer.from(l.v, 'latin1').toString('hex')
        return dialect === 'postgres' ? `'\\x${hex}'` : `${intro}X'${hex}'`
      }
      default:
        return 'NULL'
    }
  })
  return `(${out.join(',')})`
}

// ---------------------------------------------------------------------------------------------
// Statements

interface TableInfo {
  key: string
  name: string
  schema?: string
  columns: SqlColumn[]
  kinds: Map<string, SqlValueKind>
  primaryKey: string[]
  error?: string
  rows: number
  samples: Document[]
}

const FIRST_WORDS = wordSet(
  'SET LOCK UNLOCK BEGIN COMMIT START ROLLBACK END PRAGMA GRANT REVOKE COMMENT SELECT USE DELIMITER ' +
    'COPY INSERT REPLACE UPDATE DELETE TRUNCATE ANALYZE VACUUM SAVEPOINT RELEASE DROP CREATE ALTER DO ' +
    'CALL REINDEX REFRESH CLUSTER FLUSH RENAME WITH EXPLAIN DECLARE PREPARE EXECUTE SHOW LOAD ' +
    'REASSIGN CHECKPOINT NOTIFY LISTEN DISCARD RESET ATTACH DETACH SECURITY',
)
const OBJECTS = wordSet(
  'TABLE INDEX VIEW SEQUENCE FUNCTION PROCEDURE TRIGGER SCHEMA DATABASE TYPE EXTENSION DOMAIN EVENT ' +
    'ROLE USER RULE POLICY AGGREGATE OPERATOR COLLATION PUBLICATION SUBSCRIPTION SERVER TABLESPACE ' +
    'STATISTICS CAST CONVERSION LANGUAGE',
)

/** A statement's kind for the skipped counts: a fixed vocabulary, never text from the dump. */
function kindOf(words: string[]): string {
  const first = words[0] ?? ''
  if (!FIRST_WORDS.has(first)) return 'other'
  if (first === 'CREATE' || first === 'DROP' || first === 'ALTER') {
    const obj = words.slice(1, 8).find((w) => OBJECTS.has(w))
    return obj ? `${first} ${obj}` : first
  }
  return first
}

/** The words at the start of a MySQL conditional comment ("40101 SET NAMES utf8" → SET, NAMES…). */
function ccWords(text: string): string[] {
  const out: string[] = []
  let w = ''
  for (let i = 0; i <= text.length && out.length < 8; i++) {
    const c = i < text.length ? text.charCodeAt(i) : 32
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) w += text[i]
    else if (w) {
      out.push(w.toUpperCase())
      w = ''
    }
  }
  return out
}

/** A name token as text; a name that is not UTF-8 holds INVALID_TEXT and is refused where it is used. */
const ident = (t: Tok | undefined): string | undefined =>
  t && !t.big && (t.t === 'word' || t.t === 'qid' || t.t === 'dq' || t.t === 'str')
    ? (utf8(t.v) ?? INVALID_TEXT)
    : undefined

/** A name as the dump writes it, quotes doubled inside: for the statements of rejected rows. */
function written(t: Tok, name: string): string {
  if (t.t === 'word') return name
  if (t.t === 'str') return `'${name.replaceAll("'", "''")}'`
  if (t.t === 'qid' && t.q === 0x22) return `"${name.replaceAll('"', '""')}"`
  if (t.t === 'qid' && t.q === 0x5d) return `[${name.replaceAll(']', ']]')}]`
  // `name`, and MySQL's "name" (a string elsewhere, so never written back with its escapes).
  return `\`${name.replaceAll('`', '``')}\``
}

interface Name {
  schema?: string
  name: string
  /** As written: `a`.`t`. */
  text: string
  next: number
}

/** [db.][schema.]name; each part at most MAX_SQL_NAME characters of valid text. */
function parseName(toks: Tok[], at: number): Name | undefined {
  const parts: string[] = []
  const texts: string[] = []
  let i = at
  for (;;) {
    const id = ident(toks[i])
    if (id === undefined || id.length > MAX_SQL_NAME || !id.isWellFormed()) return undefined
    parts.push(id)
    texts.push(written(toks[i]!, id))
    i++
    if (parts.length < 3 && isOp(toks[i], '.')) {
      i++
      continue
    }
    break
  }
  const name = parts[parts.length - 1]!
  const text = texts.join('.')
  return parts.length > 1
    ? { schema: parts[parts.length - 2]!, name, text, next: i }
    : { name, text, next: i }
}

/** ( a, b, … ): names (and the list as written), or undefined when it is not a plain list. */
function nameList(toks: Tok[], at: number): { names: string[]; text: string; next: number } | undefined {
  if (!isOp(toks[at], '(')) return undefined
  const names: string[] = []
  const texts: string[] = []
  let i = at + 1
  if (isOp(toks[i], ')')) return { names, text: '()', next: i + 1 }
  for (;;) {
    const id = ident(toks[i])
    if (id === undefined) return undefined
    names.push(id)
    texts.push(written(toks[i]!, id))
    i++
    if (isOp(toks[i], ',')) i++
    else if (isOp(toks[i], ')')) return { names, text: `(${texts.join(', ')})`, next: i + 1 }
    else return undefined
  }
}

/** PRIMARY KEY [USING …] (a, b(10) DESC, …): the first name of each part. */
function keyColumns(toks: Tok[], at: number): string[] {
  let i = at
  while (i < toks.length && !isOp(toks[i], '(')) i++
  const out: string[] = []
  let depth = 0
  let partStart = true
  for (; i < toks.length; i++) {
    const t = toks[i]!
    if (isOp(t, '(')) {
      depth++
      continue
    }
    if (isOp(t, ')')) {
      if (--depth === 0) break
      continue
    }
    if (depth === 1 && isOp(t, ',')) {
      partStart = true
      continue
    }
    if (depth === 1 && partStart) {
      const id = ident(t)
      if (id !== undefined && out.length < MAX_SQL_COLUMNS) out.push(id)
      partStart = false
    }
  }
  return out
}

const TYPE_STOPS = wordSet(
  'NOT NULL DEFAULT PRIMARY UNIQUE REFERENCES CHECK CONSTRAINT AUTO_INCREMENT AUTOINCREMENT COLLATE ' +
    'GENERATED COMMENT ON AS IDENTITY KEY CHARSET STORED VIRTUAL VISIBLE INVISIBLE SRID COMPRESSION ' +
    'STORAGE',
)
const TABLE_CONSTRAINTS = new Set(['UNIQUE', 'FOREIGN', 'CHECK', 'EXCLUDE', 'LIKE', 'PERIOD', 'CONSTRAINT'])
const MYSQL_INDEXES = new Set(['KEY', 'INDEX', 'FULLTEXT', 'SPATIAL'])

const isAtom = (t: Tok) => t.t === 'word' || t.t === 'qid' || t.t === 'num' || t.t === 'str' || t.t === 'dq'

/** A column type's tokens back to text: "decimal(10,2)", "timestamp with time zone", "integer[]". */
function render(toks: Tok[]): string {
  let out = ''
  let prev: Tok | undefined
  for (const t of toks) {
    const s =
      t.t === 'str' ? `'${t.v.replaceAll("'", "''")}'` : t.t === 'qid' || t.t === 'dq' ? `"${t.v}"` : t.v
    if (prev && isAtom(t) && (isAtom(prev) || isOp(prev, ')'))) out += ' '
    out += s
    if (out.length > 256) break
    prev = t
  }
  return lenientUtf8(out.slice(0, 256))
}

/** Spec §2: a column type to the kind its values convert to. */
export function sqlKind(type: string, dialect: SqlDialect | undefined): SqlValueKind {
  const t = type.toLowerCase()
  if (t === '') return 'unknown'
  const words: string[] = []
  let w = ''
  for (let i = 0; i <= t.length; i++) {
    const c = i < t.length ? t.charCodeAt(i) : 32
    if ((c >= 97 && c <= 122) || isDigit(c) || c === 95) w += t[i]
    else if (w) {
      words.push(w)
      w = ''
    }
  }
  if (t.includes('[') || words.includes('array')) return 'string'
  const open = t.indexOf('(')
  const args = open >= 0 ? t.slice(open + 1, t.indexOf(')', open)).trim() : ''
  const base = words[0] ?? ''
  switch (base) {
    case 'tinyint':
      return args === '1' && dialect !== 'postgres' && dialect !== 'sqlite' ? 'bool' : 'int'
    case 'bit':
      if (dialect === 'postgres' || words[1] === 'varying') return 'string'
      return args === '' || args === '1' ? 'bool' : 'long'
    case 'bool':
    case 'boolean':
      return 'bool'
    case 'smallint':
    case 'mediumint':
    case 'middleint':
    case 'int':
    case 'integer':
    case 'int1':
    case 'int2':
    case 'int3':
    case 'int4':
    case 'year':
    case 'smallserial':
    case 'serial2':
    case 'serial4':
      return 'int'
    case 'serial':
      return dialect === 'mysql' ? 'long' : 'int'
    case 'bigint':
    case 'int8':
    case 'bigserial':
    case 'serial8':
      return 'long'
    case 'decimal':
    case 'numeric':
    case 'dec':
    case 'fixed':
    case 'number':
      return 'decimal'
    case 'float':
    case 'double':
    case 'real':
    case 'float4':
    case 'float8':
      return 'double'
    case 'date':
    case 'datetime':
    case 'datetime2':
    case 'smalldatetime':
    case 'datetimeoffset':
    case 'timestamp':
    case 'timestamptz':
      return 'date'
    case 'json':
    case 'jsonb':
      return 'json'
    case 'binary':
    case 'varbinary':
    case 'blob':
    case 'tinyblob':
    case 'mediumblob':
    case 'longblob':
    case 'bytea':
    case 'image':
      return 'binary'
    case 'long':
      return words[1] === 'varbinary' ? 'binary' : 'string'
  }
  return 'string'
}

interface TableDef {
  schema?: string
  name: string
  columns: SqlColumn[]
  primaryKey: string[]
  error?: string
}

/** CREATE … TABLE [IF NOT EXISTS] name ( defs ) [options]: columns, types and the primary key. */
function parseCreateTable(toks: Tok[], dialect: SqlDialect | undefined): TableDef | undefined {
  let i = toks.findIndex((t) => isWord(t, 'TABLE')) + 1
  if (isWord(toks[i], 'IF') && isWord(toks[i + 1], 'NOT') && isWord(toks[i + 2], 'EXISTS')) i += 3
  const nm = parseName(toks, i)
  if (!nm || !isOp(toks[nm.next], '(')) return undefined
  const defs: Tok[][] = []
  let cur: Tok[] = []
  let depth = 1
  for (i = nm.next + 1; i < toks.length; i++) {
    const t = toks[i]!
    if (isOp(t, '(')) depth++
    else if (isOp(t, ')')) {
      if (--depth === 0) break
    } else if (isOp(t, ',') && depth === 1) {
      defs.push(cur)
      cur = []
      continue
    }
    cur.push(t)
  }
  if (cur.length) defs.push(cur)
  const columns: SqlColumn[] = []
  let primaryKey: string[] = []
  let error: string | undefined
  for (const d of defs) {
    const k = isWord(d[0], 'CONSTRAINT') ? 2 : 0
    const w = upper(d[k])
    if (w === 'PRIMARY' && isWord(d[k + 1], 'KEY')) {
      primaryKey = keyColumns(d, k + 2)
      continue
    }
    if (k > 0 || TABLE_CONSTRAINTS.has(w) || (dialect === 'mysql' && MYSQL_INDEXES.has(w))) continue
    const name = ident(d[0])
    if (name === undefined) continue
    if (columns.length >= MAX_SQL_COLUMNS) {
      error = `The table has more than ${MAX_SQL_COLUMNS.toLocaleString('en-US')} columns`
      break
    }
    let j = 1
    let level = 0
    const type: Tok[] = []
    for (; j < d.length; j++) {
      const t = d[j]!
      if (level === 0 && t.t === 'word') {
        const u = upper(t)
        if (TYPE_STOPS.has(u) || (u === 'CHARACTER' && isWord(d[j + 1], 'SET'))) break
      }
      if (isOp(t, '(')) level++
      else if (isOp(t, ')')) level--
      type.push(t)
    }
    const text = render(type)
    columns.push({ name, type: text, kind: sqlKind(text, dialect) })
    for (; j < d.length - 1; j++)
      if (isWord(d[j], 'PRIMARY') && isWord(d[j + 1], 'KEY')) {
        if (primaryKey.length === 0) primaryKey = [name]
        break
      }
  }
  if (columns.length === 0 && !error) return undefined
  return error
    ? { schema: nm.schema, name: nm.name, columns: [], primaryKey: [], error }
    : { schema: nm.schema, name: nm.name, columns, primaryKey }
}

const INSERT_MODIFIERS = wordSet('LOW_PRIORITY DELAYED HIGH_PRIORITY IGNORE OR REPLACE ABORT FAIL ROLLBACK')

/** The table an INSERT names. */
function insertTarget(toks: Tok[]): Name | undefined {
  let i = 1
  while (i < toks.length && INSERT_MODIFIERS.has(upper(toks[i]))) i++
  if (isWord(toks[i], 'INTO')) i++
  return parseName(toks, i)
}

/** INSERT [modifiers] [INTO] name [AS alias] [(cols)] [OVERRIDING … VALUE] — up to VALUES. */
function parseInsertHead(toks: Tok[]): (Name & { cols?: string[]; prefix: string }) | undefined {
  const nm = insertTarget(toks)
  if (!nm) return undefined
  let i = nm.next
  if (isWord(toks[i], 'AS')) i += 2
  let cols: string[] | undefined
  let colsText = ''
  if (isOp(toks[i], '(')) {
    const list = nameList(toks, i)
    if (!list) return undefined
    cols = list.names
    colsText = ' ' + list.text
    i = list.next
  }
  if (isWord(toks[i], 'OVERRIDING')) i += 3
  if (i !== toks.length) return undefined
  return { ...nm, cols, prefix: `INSERT INTO ${nm.text}${colsText} VALUES ` }
}

const COPY_UNSUPPORTED = new Set(['CSV', 'BINARY', 'DELIMITER', 'HEADER', 'QUOTE', 'ESCAPE', 'NULL'])

/** Is this COPY followed by data lines? Asked apart from the name, so bad names still skip the data. */
function copyFromStdin(toks: Tok[]): boolean {
  for (let i = 1; i < toks.length - 1; i++) if (isWord(toks[i], 'FROM')) return isWord(toks[i + 1], 'STDIN')
  return false
}

function parseCopyHead(
  toks: Tok[],
): (Name & { cols?: string[]; unsupported: boolean; prefix: string }) | undefined {
  const nm = parseName(toks, 1)
  if (!nm) return undefined
  let i = nm.next
  let cols: string[] | undefined
  let colsText = ''
  if (isOp(toks[i], '(')) {
    const list = nameList(toks, i)
    if (!list) return undefined
    cols = list.names
    colsText = ' ' + list.text
    i = list.next
  }
  if (!isWord(toks[i], 'FROM') || !isWord(toks[i + 1], 'STDIN')) return undefined
  const unsupported = toks.slice(i + 2).some((t) => COPY_UNSUPPORTED.has(upper(t)))
  return { ...nm, cols, unsupported, prefix: `COPY ${nm.text}${colsText} FROM stdin;\n` }
}

const PG_SETTINGS = wordSet(
  'standard_conforming_strings search_path client_encoding check_function_bodies ' +
    'client_min_messages row_security default_tablespace default_table_access_method xmloption ' +
    'idle_in_transaction_session_timeout lock_timeout statement_timeout',
)

type Phase =
  | 'start'
  | 'kind'
  | 'create'
  | 'alter'
  | 'insert'
  | 'tuples'
  | 'copyHead'
  | 'copy'
  | 'set'
  | 'use'
  | 'delimiter'
  | 'skip'
  | 'ignore'

interface ReaderOptions {
  scan: boolean
  chosen?: ReadonlySet<string>
  pkAsId: boolean
  allowUnusual: boolean
  samples: number
  sampleBytes: number
  maxTables: number
  pks?: Map<string, string[]>
  skipped: Record<string, number>
}

/** The statement machine: tokens in, tables, counts and records out. */
class Reader implements Sink {
  readonly lexer = new Lexer(this)
  readonly tables = new Map<string, TableInfo>()
  private readonly named = new Map<string, string[]>()
  out: SqlRecord[] = []
  stopped = false
  truncated = false
  error: string | undefined
  private db: string | undefined
  private sampleUsed = 0
  private defChars = 0
  // the statement
  private phase: Phase = 'start'
  private toks: Tok[] = []
  private chars = 0
  private overflow = false
  private words: string[] = []
  private start = 0
  private block: 'none' | 'begin' | 'paren' = 'none'
  private depth = 0
  private prevEnd = false
  // INSERT and COPY
  private target: TableInfo | null = null
  /** The statement a rejected row is written back with: "INSERT INTO t (a, b) VALUES " or a COPY line. */
  private prefix = ''
  private names: string[] | null = null
  private rowError: string | undefined
  private hasId = false
  /** In our own export: the columns holding ObjectIds. */
  private oids: Set<string> | null = null
  private inTuple = false
  private afterTuple = false
  private full = false
  private rowBig = false
  private rowN = 0
  private values: Lit[] = []
  private extra = 0
  private valToks: Tok[] = []
  private valOver = false
  private tupleStart = 0

  constructor(private readonly o: ReaderOptions) {}

  // --- tables

  private resolve(schema: string | undefined, name: string): string {
    const s = schema ?? this.db
    const key = s !== undefined ? `${s}.${name}` : name
    if (this.tables.has(key)) return key
    if (s !== undefined && this.tables.has(name)) return name
    if (s === undefined) {
      const keys = this.named.get(name)
      if (keys?.length === 1) return keys[0]!
    }
    return key
  }

  private register(key: string, schema: string | undefined, name: string): TableInfo {
    const t: TableInfo = { key, name, columns: [], kinds: new Map(), primaryKey: [], rows: 0, samples: [] }
    const s = schema ?? this.db
    if (s !== undefined) t.schema = s
    t.primaryKey = this.o.pks?.get(key) ?? []
    this.tables.set(key, t)
    const keys = this.named.get(name)
    if (keys) keys.push(key)
    else this.named.set(name, [key])
    return t
  }

  /**
   * The table rows go to: null when it is not read (not chosen) or past the table limit. Every name
   * is registered in both passes alike, so a bare name resolves in the read as it did in the scan.
   */
  private tableFor(schema: string | undefined, name: string): TableInfo | null {
    const key = this.resolve(schema, name)
    let t = this.tables.get(key)
    if (!t) {
      if (this.full_()) return null
      t = this.register(key, schema, name)
    }
    return this.o.scan || this.o.chosen?.has(key) ? t : null
  }

  /** No room for one more table: the scan stops there (the read never chose what lies beyond). */
  private full_(): boolean {
    if (this.tables.size < this.o.maxTables) return false
    if (this.o.scan)
      this.stop(
        `The dump has more than ${this.o.maxTables.toLocaleString('en-US')} tables; the rest is not read`,
      )
    return true
  }

  private stop(msg: string): void {
    this.stopped = true
    this.truncated = true
    this.error ??= msg
  }

  // --- statements

  private reset(): void {
    this.phase = 'start'
    this.toks = []
    this.chars = 0
    this.overflow = false
    this.words = []
    this.block = 'none'
    this.depth = 0
    this.prevEnd = false
    this.target = null
    this.names = null
    this.rowError = undefined
    this.inTuple = false
    this.afterTuple = false
    this.full = false
    this.rowBig = false
    this.values = []
    this.valToks = []
    this.lexer.light = false
    this.lexer.endCapture()
    this.start = this.lexer.at + 1
  }

  private count(): void {
    const kind = kindOf(this.words)
    this.o.skipped[kind] = (this.o.skipped[kind] ?? 0) + 1
  }

  private toSkip(): void {
    this.phase = 'skip'
    this.lexer.light = true
  }

  private ignore(): void {
    this.phase = 'ignore'
    this.lexer.light = true
    this.lexer.endCapture()
    this.inTuple = false
  }

  token(tok: Tok): void {
    if (this.stopped) return
    switch (this.phase) {
      case 'start':
        return this.first(tok)
      case 'kind':
        return this.kindTok(tok)
      case 'create':
      case 'alter':
      case 'copyHead':
      case 'set':
        return this.collect(tok)
      case 'insert':
        return this.insertHead(tok)
      case 'tuples':
        return this.tuple(tok)
      case 'use':
        return this.use(tok)
      case 'skip':
        return this.skipTok(tok)
      case 'ignore':
        if (tok.t === 'end') this.reset()
        return
      default:
        return
    }
  }

  private first(tok: Tok): void {
    if (tok.t === 'cc') {
      for (const w of ccWords(tok.v)) if (this.words.length < 8) this.words.push(w)
      return
    }
    if (tok.t === 'end') {
      if (this.words.length) this.count()
      this.reset()
      return
    }
    if (tok.t !== 'word') return this.toSkip()
    const w = upper(tok)
    this.words.push(w)
    if (this.words.length > 1) return this.toSkip()
    switch (w) {
      case 'INSERT':
      case 'REPLACE':
        this.phase = 'insert'
        this.toks = [tok]
        return
      case 'COPY':
        this.phase = 'copyHead'
        this.toks = [tok]
        return
      case 'CREATE':
      case 'ALTER':
        this.phase = 'kind'
        this.toks = [tok]
        return
      case 'SET':
        this.phase = 'set'
        this.toks = [tok]
        return
      case 'USE':
        this.phase = 'use'
        return
      case 'DELIMITER':
        if (this.lexer.dialect !== 'postgres') {
          this.phase = 'delimiter'
          this.lexer.readLine()
          return
        }
        break
      case 'PRAGMA':
        this.lexer.mark('sqlite')
        break
    }
    this.toSkip()
  }

  private skipTok(tok: Tok): void {
    if (tok.t === 'end') {
      if (this.depth > 0) return
      this.count()
      this.reset()
      return
    }
    if (tok.t === 'word') {
      const w = upper(tok)
      if (this.words.length < 8) {
        this.words.push(w)
        if (
          this.words.length === 2 &&
          w === 'TABLES' &&
          (this.words[0] === 'LOCK' || this.words[0] === 'UNLOCK')
        )
          this.lexer.mark('mysql')
        if (this.words.length === 2 && w === 'TRANSACTION' && this.words[0] === 'BEGIN')
          this.lexer.mark('sqlite')
      }
      if (this.block === 'begin') {
        // BEGIN … END and CASE … END nest; "END CASE" closes one, it opens none.
        if (w === 'BEGIN' || (w === 'CASE' && !this.prevEnd)) this.depth++
        else if (w === 'END' && this.depth > 0) this.depth--
      }
      this.prevEnd = w === 'END'
      return
    }
    this.prevEnd = false
    if (tok.t === 'op') {
      if (tok.v === '::') this.lexer.mark('postgres')
      if (this.block === 'paren') {
        if (tok.v === '(') this.depth++
        else if (tok.v === ')' && this.depth > 0) this.depth--
      }
    }
  }

  private kindTok(tok: Tok): void {
    if (tok.t === 'cc') return
    if (tok.t === 'end') {
      this.count()
      this.reset()
      return
    }
    this.chars += tok.v.length
    if (this.chars > MAX_DEF_CHARS) return this.toSkip()
    this.toks.push(tok)
    if (tok.t === 'word') {
      const w = upper(tok)
      if (this.words.length < 8) this.words.push(w)
      if (OBJECTS.has(w)) {
        const first = this.words[0]
        if (w === 'TABLE') {
          this.phase = first === 'CREATE' ? 'create' : 'alter'
          return
        }
        // Statements with bodies: a ';' inside BEGIN … END (or a rule's parentheses) does not end them.
        if (first === 'CREATE' && this.lexer.delimiter === ';') {
          if (w === 'TRIGGER' || w === 'FUNCTION' || w === 'PROCEDURE') this.block = 'begin'
          else if (w === 'RULE') this.block = 'paren'
        }
        return this.toSkip()
      }
    }
    if (this.toks.length > 16) this.toSkip()
  }

  private collect(tok: Tok): void {
    if (tok.t === 'cc') return
    if (tok.t === 'end') return this.finishCollected()
    if (tok.t === 'op' && tok.v === '::') this.lexer.mark('postgres')
    if (this.phase === 'create' && this.depth === 0 && upper(tok) === 'ENGINE') this.lexer.mark('mysql')
    if (this.overflow) return
    // CHECK expressions and other deep parts of a definition are never needed: kept to two levels.
    if (this.phase === 'create') {
      const opens = isOp(tok, '(')
      const closes = isOp(tok, ')')
      if (opens) this.depth++
      const keep = this.depth <= 2
      if (closes) this.depth--
      this.lexer.light = this.depth > 2
      if (!keep) return
    }
    this.chars += tok.v.length
    const max = this.phase === 'set' ? 16 : MAX_DEF_TOKENS
    if (this.toks.length >= max || this.chars > MAX_DEF_CHARS) {
      this.overflow = true
      this.lexer.light = true
      return
    }
    this.toks.push(tok)
  }

  private finishCollected(): void {
    switch (this.phase) {
      case 'create':
        this.createTable()
        break
      case 'alter':
        this.alterTable()
        this.count()
        break
      case 'copyHead':
        this.copyHead()
        return
      case 'set':
        this.setStatement()
        this.count()
        break
    }
    this.reset()
  }

  private createTable(): void {
    const def = parseCreateTable(this.toks, this.lexer.dialect)
    if (!def) {
      if (this.overflow) {
        const i = this.toks.findIndex((t) => isWord(t, 'TABLE')) + 1
        const nm = parseName(this.toks, isWord(this.toks[i], 'IF') ? i + 3 : i)
        if (nm)
          this.define({
            ...nm,
            columns: [],
            primaryKey: [],
            error: 'The CREATE TABLE statement is too large to read',
          })
        return
      }
      return this.count()
    }
    if (this.overflow) {
      def.columns = []
      def.primaryKey = []
      def.error = 'The CREATE TABLE statement is too large to read'
    }
    this.define(def)
  }

  private define(def: TableDef): void {
    const key = this.resolve(def.schema, def.name)
    let t = this.tables.get(key)
    if (!t) {
      if (this.full_()) return
      t = this.register(key, def.schema, def.name)
    }
    if (!this.o.scan && !this.o.chosen?.has(key)) return
    for (const c of def.columns) this.defChars += c.name.length + c.type.length
    if (this.defChars > MAX_ALL_DEF_CHARS) {
      this.stop('The table definitions are larger than 32 MiB; the rest of the dump is not read')
      if (!this.o.scan) this.fail(t, t.rows + 1, 'The table definitions are larger than 32 MiB')
      return
    }
    t.columns = def.columns
    t.kinds = new Map(def.columns.map((c) => [c.name, c.kind]))
    t.primaryKey = this.o.pks?.get(key) ?? def.primaryKey
    if (def.error) t.error = def.error
    else delete t.error
  }

  /** ALTER TABLE [ONLY] name ADD [CONSTRAINT x] PRIMARY KEY (…): pg_dump's way, read by the scan. */
  private alterTable(): void {
    if (!this.o.scan || this.overflow) return
    let i = this.toks.findIndex((t) => isWord(t, 'TABLE')) + 1
    while (['ONLY', 'IF', 'EXISTS'].includes(upper(this.toks[i]))) i++
    const nm = parseName(this.toks, i)
    if (!nm) return
    const t = this.tables.get(this.resolve(nm.schema, nm.name))
    if (!t || t.primaryKey.length) return
    for (let j = nm.next; j < this.toks.length; j++) {
      if (!isWord(this.toks[j], 'ADD')) continue
      let k = j + 1
      if (isWord(this.toks[k], 'CONSTRAINT')) k += 2
      if (isWord(this.toks[k], 'PRIMARY') && isWord(this.toks[k + 1], 'KEY')) {
        t.primaryKey = keyColumns(this.toks, k + 2)
        return
      }
    }
  }

  private setStatement(): void {
    let i = 1
    if (['SESSION', 'LOCAL'].includes(upper(this.toks[i]))) i++
    const name = this.toks[i]?.t === 'word' ? this.toks[i]!.v.toLowerCase() : ''
    if (!PG_SETTINGS.has(name)) return
    this.lexer.mark('postgres')
    if (name !== 'standard_conforming_strings') return
    const value = ident(this.toks[i + 2])?.toLowerCase()
    if (value === 'off') this.lexer.pgBackslash = true
    else if (value === 'on') this.lexer.pgBackslash = false
  }

  private use(tok: Tok): void {
    if (tok.t === 'end') {
      this.count()
      this.reset()
      return
    }
    if (this.chars++ === 0) {
      const id = ident(tok)
      if (id !== undefined && id.length <= MAX_SQL_NAME && id.isWellFormed()) this.db = id
    }
  }

  line(text: string): void {
    if (this.phase !== 'delimiter' || this.stopped) return
    const d = text.trim().split(/\s/, 1)[0] ?? ''
    if (d.length > 0 && d.length <= 16 && !/['"`\\]/.test(d)) this.lexer.delimiter = d
    this.lexer.mark('mysql')
    this.count()
    this.reset()
  }

  // --- rows

  /** Names that cannot be fields: the whole statement's rows fail with this. */
  private checkNames(names: string[]): string | undefined {
    if (names.length > MAX_SQL_COLUMNS)
      return `The row names more than ${MAX_SQL_COLUMNS.toLocaleString('en-US')} columns`
    const seen = new Set<string>()
    for (const n of names) {
      if (seen.has(n)) return `The column "${clip(n)}" appears twice`
      seen.add(n)
      if (!n.isWellFormed() || n.includes('\0')) return 'A column name is not valid text'
      if (!this.o.allowUnusual && isUnusualKey(n) && !(this.lexer.ours && nestedName(n)))
        return `The column name "${clip(n)}" is not allowed`
    }
    return undefined
  }

  private aim(t: TableInfo, cols: string[] | undefined): void {
    this.target = t
    this.names = cols ?? (t.columns.length ? t.columns.map((c) => c.name) : null)
    this.rowError =
      t.error ??
      (this.names ? this.checkNames(this.names) : `No column list and no CREATE TABLE for ${clip(t.name)}`)
    this.hasId = this.names?.includes('_id') ?? false
    this.oids = this.lexer.ours
      ? new Set(t.columns.filter((c) => /^char\s*\(\s*24\s*\)$/i.test(c.type.trim())).map((c) => c.name))
      : null
  }

  private needFull(t: TableInfo): boolean {
    if (!this.o.scan) return true
    return !this.rowError && t.samples.length < this.o.samples && this.sampleUsed < this.o.sampleBytes
  }

  private insertHead(tok: Tok): void {
    if (tok.t === 'cc') return
    if (tok.t === 'end') {
      // INSERT … SELECT, INSERT … DEFAULT VALUES, INSERT … SET: not read.
      this.count()
      this.reset()
      return
    }
    if (tok.t === 'word' && this.depth === 0) {
      const w = upper(tok)
      const prev = upper(this.toks[this.toks.length - 1])
      if (w === 'VALUES' || (w === 'VALUE' && prev !== 'SYSTEM' && prev !== 'USER')) return this.beginRows()
      if ((w === 'SELECT' || w === 'WITH' || w === 'SET' || w === 'TABLE') && this.toks.length > 2) {
        this.words.push(w)
        return this.toSkip()
      }
    }
    if (isOp(tok, '(')) this.depth++
    else if (isOp(tok, ')')) this.depth--
    this.chars += tok.v.length
    if (this.toks.length >= MAX_HEAD_TOKENS || this.chars > MAX_DEF_CHARS) {
      const nm = insertTarget(this.toks)
      const t = nm ? this.tableFor(nm.schema, nm.name) : null
      if (t) this.fail(t, ++t.rows, 'The INSERT column list is too long')
      return this.ignore()
    }
    this.toks.push(tok)
  }

  private beginRows(): void {
    this.depth = 0
    const head = parseInsertHead(this.toks)
    if (!head) return this.toSkip()
    if (head.name.toLowerCase().startsWith('sqlite_')) return this.toSkip()
    const t = this.tableFor(head.schema, head.name)
    if (this.stopped) return
    if (!t) return this.ignore()
    this.aim(t, head.cols)
    this.prefix = head.prefix
    this.phase = 'tuples'
  }

  private fail(t: TableInfo | null, n: number, error: string, raw?: string): void {
    if (this.o.scan) return
    const record: RecordFailure = raw === undefined ? { n, error } : { n, error, raw }
    this.out.push({ table: t?.key ?? '', record })
  }

  /** A `--` line for a row with no statement to write back; the table's name kept on one line. */
  private note(t: TableInfo, n: number, what: string): string {
    // eslint-disable-next-line no-control-regex
    return `-- row ${n} of ${clip(t.key).replace(/[\x00-\x1f\x7f]/g, '?')}: ${what}`
  }

  /** The row as a statement that loads on its own; bytes that are no text are written as hex. */
  private insertRaw(tuple: string, lits: Lit[] | null): string {
    let text = utf8(tuple)
    if (text === undefined)
      text =
        lits && lits.every((l) => l.k !== 'bad') ? tupleText(lits, this.lexer.dialect) : lenientUtf8(tuple)
    return `${this.prefix}${text};`
  }

  private broken(error: string, what = 'not a complete row'): void {
    const t = this.target!
    const n = this.inTuple ? this.rowN : ++t.rows
    this.fail(t, n, error, this.note(t, n, what))
    this.ignore()
  }

  private tuple(tok: Tok): void {
    if (tok.t === 'cc') return
    if (this.lexer.at - this.start > MAX_STATEMENT_CHARS)
      return this.broken(
        'The INSERT statement is larger than 64 MiB; the rest of it is skipped',
        'over the size limit',
      )
    if (!this.inTuple) {
      if (tok.t === 'end') return this.reset()
      if (isOp(tok, '(') && !this.afterTuple) return this.openTuple()
      if (isOp(tok, ',') && this.afterTuple) {
        this.afterTuple = false
        return
      }
      // ON DUPLICATE KEY UPDATE, ON CONFLICT, RETURNING, AS alias: the rows are all read.
      if (tok.t === 'word' && this.afterTuple) return this.ignore()
      return this.broken('The INSERT statement is not a list of rows; the rest of it is skipped')
    }
    if (tok.t === 'end') return this.broken('The statement ends inside a row')
    if (this.full && this.lexer.at - this.tupleStart > MAX_RECORD_CHARS) {
      this.full = false
      this.rowBig = true
      this.values = []
      this.valToks = []
      this.lexer.light = true
    }
    if (tok.t === 'op') {
      if (tok.v === '(') this.depth++
      else if (tok.v === ')') {
        if (--this.depth === 0) return this.closeTuple()
      } else if (tok.v === ',' && this.depth === 1) {
        if (this.full) this.endValue()
        return
      }
    }
    if (!this.full) return
    if (this.valToks.length < MAX_VALUE_TOKENS) this.valToks.push(tok)
    else this.valOver = true
  }

  private openTuple(): void {
    const t = this.target!
    this.rowN = ++t.rows
    this.inTuple = true
    this.depth = 1
    this.full = this.needFull(t)
    this.rowBig = false
    this.lexer.light = !this.full
    this.values = []
    this.extra = 0
    this.valToks = []
    this.valOver = false
    this.tupleStart = this.lexer.at
    if (this.full && !this.o.scan) this.lexer.startCapture()
  }

  private endValue(): void {
    const lit = interpret(this.valToks, this.valOver)
    if (this.values.length <= MAX_SQL_COLUMNS) this.values.push(lit)
    else this.extra++
    this.valToks = []
    this.valOver = false
  }

  private closeTuple(): void {
    const t = this.target!
    this.inTuple = false
    this.afterTuple = true
    const tuple = this.lexer.stopCapture()
    if (this.rowBig)
      return this.fail(
        t,
        this.rowN,
        'The row is larger than 16 MiB',
        this.note(t, this.rowN, 'over the size limit'),
      )
    if (!this.full) return
    this.endValue()
    const lits = this.values
    const extra = this.extra
    const raw = () => this.insertRaw(tuple, extra ? null : lits)
    this.row(t, this.rowN, raw, this.lexer.at - this.tupleStart + 1, lits, extra)
  }

  /** `raw` is built only when a record is written: never in the scan. */
  private row(t: TableInfo, n: number, raw: () => string, size: number, lits: Lit[], extra: number): void {
    if (this.o.scan && this.rowError) return
    if (this.rowError) return this.fail(t, n, this.rowError, raw())
    const names = this.names!
    if (lits.length + extra !== names.length)
      return this.fail(t, n, `The row has ${lits.length + extra} values for ${names.length} columns`, raw())
    const entries: Array<[string, unknown]> = []
    for (let i = 0; i < names.length; i++) {
      const lit = lits[i]!
      const name = names[i]!
      if (lit.k === 'default') continue
      const v =
        lit.k === 'bad' ? new Bad(lit.why) : convert(lit, t.kinds.get(name) ?? 'unknown', this.o.allowUnusual)
      if (v instanceof Bad) return this.fail(t, n, `Value ${i + 1} (${clip(name)}): ${v.why}`, raw())
      entries.push([
        name,
        this.oids?.has(name) && typeof v === 'string' && OID_TEXT.test(v) ? new ObjectId(v) : v,
      ])
    }
    const pk = t.primaryKey
    if (this.o.pkAsId && pk.length === 1 && !this.hasId) {
      const at = entries.findIndex(([k]) => k === pk[0])
      if (at >= 0) {
        const moved = entries.splice(at, 1)[0]!
        entries.unshift(['_id', moved[1]])
      }
    }
    // Object.fromEntries defines own properties: a "__proto__" column stays data.
    const doc = this.lexer.ours ? nest(entries) : (Object.fromEntries(entries) as Document)
    if (doc === null) return this.fail(t, n, 'A column and one inside it both hold a value', raw())
    if (!this.o.scan) {
      this.out.push({ table: t.key, record: { n, doc, raw: raw() } })
      return
    }
    if (size <= SAMPLE_ROW_BYTES && this.sampleUsed + size <= this.o.sampleBytes) {
      t.samples.push(doc)
      this.sampleUsed += size
    }
  }

  private copyHead(): void {
    if (!copyFromStdin(this.toks)) {
      this.count()
      return this.reset()
    }
    this.lexer.mark('postgres')
    // A head that cannot be read (a name too long) still has data lines: they are skipped as data.
    const h = parseCopyHead(this.toks)
    if (!h) this.count()
    const t = h ? this.tableFor(h.schema, h.name) : null
    if (this.stopped) return
    this.phase = 'copy'
    this.target = t
    if (t && h) {
      this.aim(t, h.cols)
      this.prefix = h.prefix
      if (h.unsupported) this.rowError = 'COPY data in CSV, binary or a custom text format is not read'
    }
    this.lexer.light = !t || !this.needFull(t)
    this.lexer.startCopy()
  }

  copyRow(fields: Array<string | null> | null, extra: number, raw: string, big: boolean): void {
    if (this.phase !== 'copy' || this.stopped) return
    const t = this.target
    if (!t) return
    const n = ++t.rows
    if (fields) {
      if (big) this.fail(t, n, 'The row is larger than 16 MiB', this.note(t, n, 'over the size limit'))
      else {
        const lits: Lit[] = fields.map((f) => (f === null ? { k: 'null' } : { k: 'str', v: f }))
        const statement = () => `${this.prefix}${utf8(raw) ?? lenientUtf8(raw)}\n\\.`
        this.row(t, n, statement, raw.length, lits, extra)
      }
    }
    this.lexer.light = !this.needFull(t)
  }

  copyEnd(): void {
    if (this.phase === 'copy') this.reset()
  }

  eof(unterminated: string | null): void {
    if (this.stopped) return
    if (unterminated) return this.fatal(`The dump ends inside ${unterminated}`)
    switch (this.phase) {
      case 'tuples':
        if (this.inTuple) this.fatal('The dump ends inside a row')
        return
      case 'create':
      case 'alter':
      case 'set':
      case 'copyHead':
        return this.finishCollected()
      case 'skip':
        if (this.depth > 0) return this.fatal(`The dump ends inside a ${kindOf(this.words)} statement`)
        return this.count()
      case 'kind':
      case 'insert':
      case 'use':
        return this.count()
      case 'start':
        if (this.words.length) this.count()
        return
    }
  }

  private fatal(msg: string): void {
    if (this.o.scan) {
      this.truncated = true
      this.error ??= msg
      return
    }
    const t = this.target
    this.fail(t, t ? (this.inTuple ? this.rowN : t.rows + 1) : 0, msg)
  }
}

// ---------------------------------------------------------------------------------------------
// Entry points

export type SqlInput = AsyncIterable<Uint8Array | string>

const asBuffer = (c: Uint8Array | string): Buffer =>
  typeof c === 'string' ? Buffer.from(c, 'utf8') : Buffer.from(c.buffer, c.byteOffset, c.byteLength)

/**
 * The dump's bytes as latin1 text, one character per byte (a string chunk is taken as its UTF-8
 * bytes). A UTF-8 byte order mark is dropped; a UTF-16 dump (by its mark) is turned into UTF-8 first.
 */
async function* asLatin1(input: SqlInput): AsyncGenerator<string> {
  let head: Buffer | null = Buffer.alloc(0)
  let utf16: TextDecoder | undefined
  const out = (b: Buffer) =>
    utf16 ? Buffer.from(utf16.decode(b, { stream: true }), 'utf8').toString('latin1') : b.toString('latin1')
  const start = (b: Buffer): Buffer => {
    if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3)
    if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) {
      utf16 = new TextDecoder(b[0] === 0xff ? 'utf-16le' : 'utf-16be')
      return b.subarray(2)
    }
    return b
  }
  for await (const c of input) {
    let b = asBuffer(c)
    if (head) {
      b = Buffer.concat([head, b])
      if (b.length < 3) {
        head = b
        continue
      }
      head = null
      b = start(b)
    }
    const s = out(b)
    if (s) yield s
  }
  if (head?.length) yield out(start(head))
  const tail = utf16?.decode()
  if (tail) yield Buffer.from(tail, 'utf8').toString('latin1')
}

async function* run(input: SqlInput, r: Reader, signal: AbortSignal | undefined): AsyncGenerator<SqlRecord> {
  const aborted = () => {
    if (!signal?.aborted) return false
    r.stopped = true
    r.truncated = true
    r.error ??= 'The pass was stopped'
    return true
  }
  for await (const text of asLatin1(input)) {
    // Slices bound the work between two looks at the signal, however large the chunk.
    for (let at = 0; at < text.length; at += SLICE) {
      if (aborted()) return
      r.lexer.feed(text.length <= SLICE ? text : text.slice(at, at + SLICE))
      const out = r.out
      r.out = []
      for (const rec of out) {
        if (aborted()) return
        yield rec
      }
      if (r.stopped) return
    }
  }
  if (aborted()) return
  r.lexer.end()
  for (const rec of r.out) {
    if (aborted()) return
    yield rec
  }
  r.out = []
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.floor(v)))

/**
 * One pass over a dump: its tables (columns, primary keys, row counts, first rows) and skipped
 * statements. Stopped by `signal`, it resolves with what it found so far, `truncated` set.
 */
export async function scanSqlDump(input: SqlInput, opts: SqlScanOptions = {}): Promise<SqlScan> {
  const skipped: Record<string, number> = {}
  const pkAsId = opts.primaryKeyAsId ?? true
  const r = new Reader({
    scan: true,
    pkAsId,
    allowUnusual: opts.allowUnusual ?? false,
    samples: clamp(opts.samples ?? 5, 0, 100),
    sampleBytes: clamp(opts.sampleBytes ?? SAMPLE_BUDGET, 0, SAMPLE_BUDGET),
    maxTables: clamp(opts.maxTables ?? MAX_SQL_TABLES, 1, MAX_SQL_TABLES),
    skipped,
  })
  if (opts.dialect) r.lexer.dialect = opts.dialect
  for await (const rec of run(input, r, opts.signal)) void rec
  const perTable = clamp(opts.columnsPerTable ?? MAX_SQL_COLUMNS, 0, MAX_SQL_COLUMNS)
  const tables: SqlTable[] = []
  for (const t of r.tables.values()) {
    const pk = t.primaryKey
    // A primary key declared after the data (pg_dump): the samples get their _id now.
    const samples =
      pkAsId && pk.length === 1
        ? t.samples.map((d) =>
            Object.hasOwn(d, pk[0]!) && !Object.hasOwn(d, '_id')
              ? Object.fromEntries([['_id', d[pk[0]!]], ...Object.entries(d).filter(([k]) => k !== pk[0])])
              : d,
          )
        : t.samples
    const out: SqlTable = {
      key: t.key,
      name: t.name,
      columns: t.columns.slice(0, perTable),
      columnCount: t.columns.length,
      primaryKey: pk,
      rows: t.rows,
      samples,
    }
    if (t.schema !== undefined) out.schema = t.schema
    if (t.error) out.error = t.error
    tables.push(out)
  }
  const scan: SqlScan = { dialect: r.lexer.dialect ?? 'standard', tables, skipped, truncated: r.truncated }
  if (r.error) scan.error = r.error
  return scan
}

/**
 * One pass over a dump: the rows of the chosen tables, in file order, as documents or failures.
 * Stopped by `signal`, it yields nothing more.
 */
export async function* readSqlDump(input: SqlInput, opts: SqlReadOptions): AsyncGenerator<SqlRecord> {
  const pks = opts.primaryKeys
    ? new Map(Object.entries(opts.primaryKeys).map(([k, v]) => [k, [...v]]))
    : undefined
  const r = new Reader({
    scan: false,
    chosen: opts.tables,
    pkAsId: opts.primaryKeyAsId,
    allowUnusual: opts.allowUnusual ?? false,
    samples: 0,
    sampleBytes: 0,
    maxTables: MAX_SQL_TABLES,
    pks,
    skipped: opts.skipped ?? {},
  })
  if (opts.dialect) r.lexer.dialect = opts.dialect
  yield* run(input, r, opts.signal)
}
