// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import {
  BSONRegExp,
  Binary,
  DBRef,
  Decimal128,
  Double,
  EJSON,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  UUID,
  type Document,
} from 'bson'

export type BsonConstructor = (args: unknown[]) => unknown

const INT32_MIN = -2147483648
const INT32_MAX = 2147483647
const UINT32_MAX = 0xffffffff
const MAX_DATE_MS = 8.64e15
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const DECIMAL_INTEGER = /^[+-]?\d+$/
const ISO_DATE =
  /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i

function str(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`${what} must be a string`)
  return value
}

function integer(value: unknown, what: string): number {
  if (typeof value === 'string') {
    if (!DECIMAL_INTEGER.test(value.trim())) throw new Error(`${what} must be an integer`)
    return Number(value)
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${what} must be an integer`)
  return value
}

function dateFromMs(ms: number): Date {
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_MS)
    throw new Error(`${ms} is outside the supported date range`)
  return new Date(ms)
}

function daysInMonth(year: number, month: number): number {
  const d = new Date(0)
  d.setUTCFullYear(year, month, 0)
  return d.getUTCDate()
}

/** Strict ISO-8601; a time without an offset is UTC (like mongosh), never the host timezone. */
function parseIsoDate(text: string): Date {
  const m = ISO_DATE.exec(text.trim())
  if (!m) throw new Error(`invalid date "${text}"; use ISO-8601 such as 2024-01-31T12:00:00Z`)
  const [, y = '', mo = '', d = '', h = '00', mi = '00', s = '00', frac = '', zone] = m
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new Error(`invalid date "${text}"`)
  }
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) throw new Error(`invalid time in "${text}"`)
  let offset = 'Z'
  if (zone && zone.toUpperCase() !== 'Z') {
    offset =
      zone.length === 3 ? `${zone}:00` : zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`
  }
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}.${frac.padEnd(3, '0').slice(0, 3)}${offset}`)
  return dateFromMs(date.getTime())
}

function toDate(value: unknown): Date {
  if (typeof value === 'number') return dateFromMs(value)
  return parseIsoDate(str(value, 'argument'))
}

function makeDate(args: unknown[]): Date {
  if (args.length === 0) return new Date()
  if (args.length === 1) return toDate(args[0])
  const parts = args.map((a, i) => integer(a, `argument ${i + 1}`))
  return dateFromMs(Date.UTC(...(parts as [number, ...number[]])))
}

function makeInt(args: unknown[]): Int32 {
  const n = integer(args[0] ?? 0, 'argument')
  if (n < INT32_MIN || n > INT32_MAX) throw new Error(`${n} does not fit in a 32-bit integer`)
  return new Int32(n)
}

function makeLong(args: unknown[]): Long {
  const value = args[0] ?? 0
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error('number argument must be a safe integer; pass a string for larger values')
    }
    return Long.fromNumber(value)
  }
  const text = str(value, 'argument').trim()
  if (!DECIMAL_INTEGER.test(text)) throw new Error(`"${text}" is not an integer`)
  const canonical = text
    .replace(/^\+/, '')
    .replace(/^(-?)0+(?=\d)/, '$1')
    .replace(/^-0$/, '0')
  let long: Long
  try {
    long = Long.fromString(canonical)
  } catch {
    throw new Error(`"${text}" is out of range for a 64-bit integer`)
  }
  if (long.toString() !== canonical) throw new Error(`"${text}" is out of range for a 64-bit integer`)
  return long
}

function makeTimestamp(args: unknown[]): Timestamp {
  // mongosh's Timestamp() is the zero timestamp, which the server fills in on insert.
  if (args.length === 0) return new Timestamp({ t: 0, i: 0 })
  const [first, second] = args
  const source =
    args.length === 1 && first !== null && typeof first === 'object'
      ? (first as Record<string, unknown>)
      : { t: first, i: second }
  const t = integer(source.t, 't')
  const i = integer(source.i, 'i')
  if (t < 0 || t > UINT32_MAX || i < 0 || i > UINT32_MAX) {
    throw new Error('t and i must be unsigned 32-bit integers')
  }
  return new Timestamp({ t, i })
}

/** A decimal number as text (no hex, no separators), or NaN / Infinity spelled as JavaScript does. */
const DECIMAL_TEXT = /^(?:[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|NaN|[+-]?Infinity)$/

function makeDecimal(args: unknown[]): Decimal128 {
  if (args.length === 0) return Decimal128.fromString('0')
  const value = args[0]
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new Error('argument must be a number or a string')
  return Decimal128.fromString(String(value))
}

export const BSON_CONSTRUCTORS: Readonly<Record<string, BsonConstructor>> = {
  ObjectId: (args) => {
    if (args.length === 0) return new ObjectId()
    const hex = str(args[0], 'argument')
    if (!/^[0-9a-fA-F]{24}$/.test(hex)) throw new Error('requires a 24-character hex string')
    return ObjectId.createFromHexString(hex)
  },
  ISODate: makeDate,
  Date: makeDate,
  NumberInt: makeInt,
  NumberLong: makeLong,
  NumberDecimal: makeDecimal,
  Decimal128: makeDecimal,
  Double: (args) => {
    if (args.length === 0) return new Double(0)
    const value = args[0]
    // A number, or one written as text; never "" or null, which Number() would quietly make 0.
    if (typeof value === 'number') return new Double(value)
    if (typeof value === 'string' && DECIMAL_TEXT.test(value.trim())) return new Double(Number(value))
    throw new Error('argument must be a number')
  },
  UUID: (args) => (args.length === 0 ? new UUID() : new UUID(str(args[0], 'argument'))),
  BinData: (args) => {
    const subtype = integer(args[0], 'subtype')
    if (subtype < 0 || subtype > 255) throw new Error('subtype must be between 0 and 255')
    const data = str(args[1], 'data')
    if (!BASE64.test(data) || data.length % 4 !== 0) throw new Error('data must be valid base64')
    return Binary.createFromBase64(data, subtype)
  },
  Timestamp: makeTimestamp,
  MinKey: () => new MinKey(),
  MaxKey: () => new MaxKey(),
  RegExp: (args) => {
    const [pattern, flags] = args
    if (pattern instanceof BSONRegExp)
      return new BSONRegExp(pattern.pattern, str(flags ?? pattern.options, 'flags'))
    return new BSONRegExp(str(pattern, 'pattern'), str(flags ?? '', 'flags'))
  },
  DBRef: (args) => {
    const collection = str(args[0], 'collection')
    if (args[1] === undefined) throw new Error('id is required')
    const db = args[2] === undefined || args[2] === null ? undefined : str(args[2], 'db')
    const fields = args[3]
    if (fields !== undefined && (fields === null || typeof fields !== 'object' || Array.isArray(fields))) {
      throw new Error('fields must be an object')
    }
    return new DBRef(collection, args[1] as ObjectId, db, fields as Document | undefined)
  },
}

/**
 * Converts a pasted Extended JSON wrapper (children still raw JSON) with the same validation as the
 * matching constructor, so both spellings accept and reject exactly the same values.
 */
export function fromEjsonWrapper(keyset: string, obj: Record<string, unknown>): unknown {
  switch (keyset) {
    case '$numberInt':
      return makeInt([str(obj.$numberInt, '$numberInt')])
    case '$numberLong':
      return makeLong([str(obj.$numberLong, '$numberLong')])
    case '$timestamp':
      return makeTimestamp([obj.$timestamp])
    // The legacy form an old mongoexport wrote: base64 data and a hex subtype side by side.
    case '$binary,$type': {
      const data = str(obj.$binary, '$binary')
      const type = str(obj.$type, '$type')
      if (!BASE64.test(data) || data.length % 4 !== 0) throw new Error('$binary must be valid base64')
      if (!/^[0-9a-fA-F]{1,2}$/.test(type)) throw new Error('$type must be a hex subtype, e.g. "00"')
      return Binary.createFromBase64(data, parseInt(type, 16))
    }
    // Deprecated in BSON; read as null, the value it stands for in every current driver.
    case '$undefined':
      if (obj.$undefined !== true) throw new Error('$undefined must be true')
      return null
    case '$dbPointer': {
      const pointer = obj.$dbPointer as { $ref?: unknown; $id?: unknown } | null
      const id = pointer && typeof pointer === 'object' ? (pointer.$id as { $oid?: unknown } | null) : null
      if (typeof pointer?.$ref !== 'string' || !id || typeof id !== 'object' || typeof id.$oid !== 'string')
        throw new Error('$dbPointer must be { "$ref": "<collection>", "$id": { "$oid": "<hex>" } }')
      return EJSON.deserialize(obj as Document, { relaxed: false })
    }
    case '$date': {
      const value = obj.$date
      if (typeof value === 'string') return parseIsoDate(value)
      if (typeof value === 'number') return dateFromMs(value)
      if (value !== null && typeof value === 'object' && Object.keys(value).join(',') === '$numberLong') {
        const long = makeLong([str((value as { $numberLong: unknown }).$numberLong, '$numberLong')])
        return dateFromMs(Number(long.toString()))
      }
      throw new Error('$date must be an ISO-8601 string or { "$numberLong": "<ms>" }')
    }
    default:
      return EJSON.deserialize(obj as Document, { relaxed: false })
  }
}
