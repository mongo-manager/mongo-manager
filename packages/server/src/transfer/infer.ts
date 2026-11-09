// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { Decimal128, Double, Int32, Long, ObjectId } from 'bson'
import type { FieldType } from '@mongo-manager/shared'
import { INFER_CHARS } from './limits'
import { RecordError, parseJsonValue } from './formats/json'
import { bsonKind, ejsonText, numberValue } from './bson-kind'

const INT = /^[+-]?\d{1,20}$/
/**
 * "007", "-012": a code, not a number (plan ruling 9). "0" and "0.5" are numbers. A leading "+" is
 * a code too: a phone number ("+90532…"), never Long 90532… (data review 2026-10-13, M2).
 */
const CODE = /^\+|^-?0\d/
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d{1,4})?$/
const SPECIAL = /^(NaN|[+-]?Infinity)$/
const ISO =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/
const OID = /^[0-9a-fA-F]{24}$/
const BOOL_INFER = /^(true|false)$/i
const BOOL = /^(true|false|1|0|yes|no)$/i
const INT32: readonly [bigint, bigint] = [-2147483648n, 2147483647n]
const INT64: readonly [bigint, bigint] = [-9223372036854775808n, 9223372036854775807n]

/** Spec §5.2: ISO 8601 and "YYYY-MM-DD[ HH:MM[:SS]]"; without a zone it is UTC (plan ruling 8). */
export function parseIsoDate(text: string): Date | null {
  const m = ISO.exec(text)
  if (!m) return null
  const [y, mo, d, h = '0', mi = '0', s = '0'] = m.slice(1, 7) as string[]
  const ms = Number((m[7] ?? '0').padEnd(3, '0').slice(0, 3))
  const parts = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)] as const
  const check = new Date(Date.UTC(...parts, ms))
  if (
    check.getUTCFullYear() !== parts[0] ||
    check.getUTCMonth() !== parts[1] ||
    check.getUTCDate() !== parts[2] ||
    check.getUTCHours() !== parts[3] ||
    check.getUTCMinutes() !== parts[4] ||
    check.getUTCSeconds() !== parts[5]
  )
    return null
  let offset = 0
  const zone = m[8]
  if (zone && zone !== 'Z') {
    const z = /^([+-])(\d{2}):?(\d{2})$/.exec(zone)!
    if (Number(z[2]) > 23 || Number(z[3]) > 59) return null
    offset = (z[1] === '+' ? 1 : -1) * (Number(z[2]) * 60 + Number(z[3])) * 60_000
  }
  return new Date(check.getTime() - offset)
}

const inRange = (big: bigint, [lo, hi]: readonly [bigint, bigint]) => big >= lo && big <= hi
/** A decimal number's digits and the power of ten of its first: "1.10" and "11e-1" are one. */
function canonical(text: string): string {
  const m = /^[+-]?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text)
  if (!m) return text
  const whole = m[1] ?? ''
  let digits = whole + (m[2] ?? '')
  let exp = Number(m[3] ?? 0) + whole.length
  const lead = /^0*/.exec(digits)![0].length
  digits = digits.slice(lead).replace(/0+$/, '')
  exp -= lead
  return digits ? `${text.startsWith('-') ? '-' : ''}${digits}e${exp}` : '0'
}

/**
 * Whether a double holds the number the text writes: as JavaScript writes the double back, the
 * same digits (0.30000000000000004 yes, 12345678901234567 no) — review of the M1 fix (I1).
 */
const exactDouble = (s: string) => {
  const n = Number(s)
  return Number.isFinite(n) && canonical(s) === canonical(String(n))
}

const empty = (v: unknown) => v === null || v === undefined || v === ''
/**
 * Data review 2026-10-13 (M1): a later row is read by the rules the sample was — a code is never a
 * number, a double never a rounded one. Why not, or null.
 */
function notANumber(s: string, type: FieldType): string | null {
  if (CODE.test(s)) return 'looks like a code (a leading + or 0), not a number'
  if (type === 'double' && DECIMAL.test(s) && !exactDouble(s))
    return 'has more digits than a double holds: it would be another number'
  return null
}

function fitsText(type: FieldType, v: string): boolean {
  // Spec §5.2: only the first 64 characters are looked at; longer text is text (or JSON by its start).
  if (v.length > INFER_CHARS) return type === 'string' || (type === 'json' && /^\s*[[{]/.test(v))
  const s = v.trim()
  switch (type) {
    case 'boolean':
      return BOOL_INFER.test(s)
    case 'int32':
      return INT.test(s) && !CODE.test(s) && inRange(BigInt(s), INT32)
    case 'int64':
      return INT.test(s) && !CODE.test(s) && inRange(BigInt(s), INT64)
    case 'double':
      // M2: a NaN or Infinity among numbers keeps the column numeric.
      return (DECIMAL.test(s) && !CODE.test(s) && exactDouble(s)) || SPECIAL.test(s)
    case 'decimal128':
      return DECIMAL.test(s) && !CODE.test(s)
    case 'date':
      return parseIsoDate(s) !== null
    case 'objectId':
      return OID.test(s)
    case 'json':
      if (!/^[[{]/.test(s)) return false
      try {
        parseJsonValue(s, { allowUnusual: false })
        return true
      } catch {
        return false
      }
    default:
      return type === 'string'
  }
}

function fits(type: FieldType, v: unknown): boolean {
  if (typeof v === 'string') return fitsText(type, v)
  if (typeof v === 'number')
    return (
      (type === 'int32' && Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) ||
      (type === 'int64' && Number.isSafeInteger(v)) ||
      type === 'double' ||
      type === 'string'
    )
  if (typeof v === 'boolean') return type === 'boolean' || type === 'string'
  if (v instanceof Date) return type === 'date' || type === 'string'
  return type === 'string'
}

const ORDER: readonly FieldType[] = [
  'boolean',
  'int32',
  'int64',
  'double',
  'decimal128',
  'date',
  'objectId',
  'json',
  'string',
]

/** Spec §5.2: the narrowest type every non-empty sample fits. */
export function inferType(samples: unknown[]): FieldType {
  const values = samples.filter((v) => !empty(v))
  if (!values.length) return 'string'
  // Only "NaN" and "Infinity" are words, not numbers.
  const words = values.every((v) => typeof v === 'string' && SPECIAL.test(v.trim()))
  return ORDER.find((t) => !(words && t === 'double') && values.every((v) => fits(t, v))) ?? 'string'
}

/** A value as text: what a "string" target and the preview samples show. */
export function asText(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString()
  switch (bsonKind(v)) {
    case 'ObjectId':
      return (v as { toHexString(): string }).toHexString()
    case 'Int32':
    case 'Double':
      return String(numberValue(v))
    case 'Long':
    case 'Decimal128':
      return String(v)
    case 'Binary':
      return (v as { toString(encoding: 'base64'): string }).toString('base64')
  }
  return ejsonText(v, { relaxed: true })
}

export type Converted = { ok: true; value: unknown } | { ok: false; reason: string }
const fail = (type: FieldType): Converted => ({ ok: false, reason: `cannot be read as ${type}` })
const done = (value: unknown): Converted => ({ ok: true, value })
const numberOf = numberValue
const isLong = (v: unknown) => bsonKind(v) === 'Long'
const int32Of = (n: number | null) =>
  n !== null && Number.isInteger(n) && n >= -2147483648 && n <= 2147483647 ? done(new Int32(n)) : null

/** Spec §5.3, §7 T17: a value in the target type, or why it is not; never a rounded guess. */
export function convert(v: unknown, type: FieldType, opts: { allowUnusual: boolean }): Converted {
  const s = typeof v === 'string' ? v.trim() : null
  if (s !== null && (type === 'int32' || type === 'int64' || type === 'double' || type === 'decimal128')) {
    const why = notANumber(s, type)
    if (why) return { ok: false, reason: why }
  }
  switch (type) {
    case 'keep':
      if (typeof v === 'number') return int32Of(v) ?? done(new Double(v))
      // Final review I5: a date that is not one is refused, never written as 1970 or null.
      if (v instanceof Date && Number.isNaN(v.getTime())) return fail('date')
      return done(v)
    case 'null':
      return done(null)
    case 'string':
      return done(asText(v))
    case 'int32': {
      if (s !== null)
        return INT.test(s) && inRange(BigInt(s), INT32) ? done(new Int32(Number(s))) : fail(type)
      if (typeof v === 'boolean') return done(new Int32(v ? 1 : 0))
      if (isLong(v))
        return inRange(BigInt(String(v)), INT32) ? done(new Int32(Number(String(v)))) : fail(type)
      return int32Of(numberOf(v)) ?? fail(type)
    }
    case 'int64': {
      if (s !== null) return INT.test(s) && inRange(BigInt(s), INT64) ? done(Long.fromString(s)) : fail(type)
      if (isLong(v)) return done(Long.fromString(String(v)))
      const n = numberOf(v)
      return n !== null && Number.isSafeInteger(n) ? done(Long.fromNumber(n)) : fail(type)
    }
    case 'double': {
      // Final review M8: Infinity only when the text says so; "1e999" overflowing to it is refused.
      if (s !== null) {
        if (SPECIAL.test(s)) return done(new Double(Number(s)))
        return DECIMAL.test(s) && Number.isFinite(Number(s)) ? done(new Double(Number(s))) : fail(type)
      }
      if (isLong(v)) return done(new Double(Number(String(v))))
      if (bsonKind(v) === 'Decimal128') {
        const text = String(v)
        const n = Number(text)
        return Number.isFinite(n) || SPECIAL.test(text) ? done(new Double(n)) : fail(type)
      }
      const n = numberOf(v)
      return n !== null ? done(new Double(n)) : fail(type)
    }
    case 'decimal128': {
      const n = numberOf(v)
      const text = s ?? (n !== null ? String(n) : isLong(v) ? String(v) : null)
      if (text === null || !(DECIMAL.test(text) || SPECIAL.test(text))) return fail(type)
      try {
        return done(Decimal128.fromString(text))
      } catch {
        return { ok: false, reason: 'has more digits than decimal128 holds' }
      }
    }
    case 'boolean':
      if (s !== null) return BOOL.test(s) ? done(/^(true|1|yes)$/i.test(s)) : fail(type)
      if (typeof v === 'boolean') return done(v)
      return numberOf(v) === 1 ? done(true) : numberOf(v) === 0 ? done(false) : fail(type)
    case 'date': {
      if (v instanceof Date) return Number.isNaN(v.getTime()) ? fail(type) : done(v)
      const d = s !== null ? parseIsoDate(s) : null
      return d ? done(d) : fail(type)
    }
    case 'objectId':
      if (bsonKind(v) === 'ObjectId') return done(v)
      return s !== null && OID.test(s) ? done(new ObjectId(s)) : fail(type)
    case 'json':
      if (s === null)
        return typeof v === 'object' && v !== null && !(v instanceof Date) ? done(v) : fail(type)
      try {
        return done(parseJsonValue(s, opts))
      } catch (e) {
        return {
          ok: false,
          reason: e instanceof RecordError ? `is not valid JSON: ${e.message}` : 'is not valid JSON',
        }
      }
  }
}
