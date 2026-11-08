// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { EJSON, type Binary, type BSONRegExp, type DBRef, type Document, type Timestamp } from 'bson'
import { bsonClassOf } from '../ejson'
import { isParam } from './marker'

export interface FormatOptions {
  /** Spaces per level; 0 renders on a single line. Default 2. */
  indent?: number
  /**
   * Query parameters (spec 2026-10-28): a marker written as `{{name}}`, for a query's template in
   * the query bar. Elsewhere (a document) it is the object it is.
   */
  params?: boolean
  /** Every key quoted, as JSON writes it (user report 2026-11-05: the document's edit view). */
  quoteKeys?: boolean
}

/** Whether the formatting under way writes markers as parameters (formatShell is not re-entered). */
let writingParams = false
/** Whether the formatting under way quotes every key. */
let quotingKeys = false

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
const JS_REGEX_FLAGS = /^[imsu]*$/

export function formatShell(value: unknown, options: FormatOptions = {}): string {
  // undefined alone is shown as mongosh shows it (a printed value); inside a value it has no
  // syntax the parser reads, so it is left out or written as null (review of the deferred fixes).
  if (value === undefined) return 'undefined'
  writingParams = options.params === true
  quotingKeys = options.quoteKeys === true
  try {
    return fmt(value, options.indent ?? 2, 0)
  } finally {
    writingParams = false
    quotingKeys = false
  }
}

function num(n: number): string {
  if (Number.isNaN(n)) return 'NaN'
  if (n === Infinity) return 'Infinity'
  if (n === -Infinity) return '-Infinity'
  if (Object.is(n, -0)) return '-0'
  return String(n)
}

function regex(pattern: string, flags: string): string {
  if (pattern !== '' && JS_REGEX_FLAGS.test(flags)) {
    try {
      if (new RegExp(pattern, flags).source === pattern) return `/${pattern}/${flags}`
    } catch {
      // not a valid JS regex; fall through to the RegExp() form
    }
  }
  return `RegExp(${JSON.stringify(pattern)}, ${JSON.stringify(flags)})`
}

function block(items: string[], open: string, close: string, indent: number, level: number, spaced: boolean) {
  if (items.length === 0) return open + close
  if (indent === 0)
    return spaced ? `${open} ${items.join(', ')} ${close}` : `${open}${items.join(', ')}${close}`
  const pad = ' '.repeat(indent * (level + 1))
  return `${open}\n${items.map((i) => pad + i).join(',\n')}\n${' '.repeat(indent * level)}${close}`
}

function fmt(v: unknown, indent: number, level: number): string {
  // An array slot left undefined is written as EJSON writes it (an object's is left out, below):
  // the parser has no undefined (plan 1a deferred minor).
  if (v === null || v === undefined) return 'null'
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v)
    case 'boolean':
      return String(v)
    case 'number':
      return num(v)
    case 'bigint':
      return `NumberLong("${v}")`
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'new Date(NaN)' : `ISODate("${v.toISOString()}")`
  if (v instanceof RegExp) return regex(v.source, v.flags)
  if (Array.isArray(v)) {
    return block(
      v.map((x) => fmt(x, indent, level + 1)),
      '[',
      ']',
      indent,
      level,
      false,
    )
  }
  const tagged = v as { value?: number; toString(encoding?: string): string }
  switch (bsonClassOf(v)) {
    case 'ObjectId':
      return `ObjectId("${tagged.toString()}")`
    case 'Int32':
      return num(tagged.value as number)
    case 'Double': {
      const d = tagged.value as number
      // Integral doubles need the wrapper, otherwise they re-parse as int32.
      return Number.isInteger(d) ? `Double(${num(d)})` : num(d)
    }
    case 'Long':
      return `NumberLong("${tagged.toString()}")`
    case 'Decimal128':
      return `NumberDecimal("${tagged.toString()}")`
    case 'Binary': {
      const bin = v as Binary
      if (bin.sub_type === 4 && bin.position === 16) return `UUID("${bin.toUUID().toHexString(true)}")`
      return `BinData(${bin.sub_type}, "${bin.toString('base64')}")`
    }
    case 'Timestamp': {
      const ts = v as Timestamp
      return `Timestamp({ t: ${ts.t}, i: ${ts.i} })`
    }
    case 'BSONRegExp': {
      const re = v as BSONRegExp
      return regex(re.pattern, re.options)
    }
    case 'MinKey':
      return 'MinKey()'
    case 'MaxKey':
      return 'MaxKey()'
    case 'DBRef': {
      const ref = v as DBRef
      const hasFields = Object.keys(ref.fields).length > 0
      const db = ref.db ? `, ${JSON.stringify(ref.db)}` : hasFields ? ', null' : ''
      const fields = hasFields ? `, ${fmt(ref.fields, indent, level)}` : ''
      return `DBRef(${JSON.stringify(ref.collection)}, ${fmt(ref.oid, indent, level)}${db}${fields})`
    }
    case 'Code':
    case 'BSONSymbol':
      return fmt(EJSON.serialize(v as Document, { relaxed: false }), indent, level)
  }
  // Query parameters: written as typed in the query bar.
  if (writingParams && isParam(v)) return `{{${v.$$param}}}`
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== undefined)
    .map(
      ([k, x]) =>
        `${!quotingKeys && IDENTIFIER.test(k) ? k : JSON.stringify(k)}: ${fmt(x, indent, level + 1)}`,
    )
  return block(entries, '{', '}', indent, level, true)
}
