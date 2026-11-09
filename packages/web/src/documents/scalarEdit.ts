// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { BsonTypeName } from '@mongo-manager/shared/browser'
import { decodeValue, typeOf } from './values'

/** Types a table cell edits in place; everything else opens the document editor. */
const EDITABLE = new Set<BsonTypeName>([
  'string',
  'int32',
  'double',
  'long',
  'decimal128',
  'boolean',
  'date',
  'objectId',
  'null',
])

export const editableType = (type: BsonTypeName): boolean => EDITABLE.has(type)

/** The types a value can be given in place, in the order a type picker offers them. */
export const EDITABLE_TYPES: readonly BsonTypeName[] = [...EDITABLE]

export type ScalarResult = { ok: true; value: unknown } | { ok: false; error: BsonTypeName }

const INT = /^[-+]?\d+$/
const DECIMAL_NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i
const DECIMAL128 = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/
const INT32 = { min: -(2 ** 31), max: 2 ** 31 - 1 }
const LONG = { min: -(2n ** 63n), max: 2n ** 63n - 1n }

/** The value decoded from canonical EJSON, so it has exactly the BSON type asked for. */
const fromEjson = (ejson: unknown): ScalarResult => ({ ok: true, value: decodeValue(ejson) })

/**
 * Text typed into a cell, as a value of the cell's own type (Review Focus 2: Int32 stays Int32).
 * Anything that does not fit the type is refused; changing the type needs the document editor.
 */
export function parseScalar(type: BsonTypeName, input: string): ScalarResult {
  const text = type === 'string' ? input : input.trim()
  const fail: ScalarResult = { ok: false, error: type }
  switch (type) {
    case 'string':
      return { ok: true, value: text }
    case 'int32': {
      if (!INT.test(text)) return fail
      const n = Number(text)
      return n >= INT32.min && n <= INT32.max ? fromEjson({ $numberInt: String(n) }) : fail
    }
    case 'double': {
      const n = Number(text)
      if (!DECIMAL_NUMBER.test(text) || !Number.isFinite(n)) return fail
      return fromEjson({ $numberDouble: Object.is(n, -0) ? '-0.0' : String(n) })
    }
    case 'long': {
      if (!INT.test(text)) return fail
      const n = BigInt(text)
      return n >= LONG.min && n <= LONG.max ? fromEjson({ $numberLong: n.toString() }) : fail
    }
    case 'decimal128': {
      if (!DECIMAL128.test(text)) return fail
      try {
        return fromEjson({ $numberDecimal: text })
      } catch {
        return fail
      }
    }
    case 'boolean':
      return text === 'true' || text === 'false' ? { ok: true, value: text === 'true' } : fail
    case 'date': {
      if (!ISO_DATE.test(text)) return fail
      const ms = Date.parse(text)
      // Date.parse rolls 2024-02-30 over to March: the calendar date must survive the round trip.
      if (Number.isNaN(ms) || !sameCalendarDay(text, ms)) return fail
      return fromEjson({ $date: { $numberLong: String(ms) } })
    }
    case 'objectId':
      return /^[0-9a-f]{24}$/i.test(text) ? fromEjson({ $oid: text.toLowerCase() }) : fail
    case 'null':
      return text === 'null' ? { ok: true, value: null } : fail
    default:
      return fail
  }
}

function sameCalendarDay(text: string, ms: number): boolean {
  const offset = /([+-])(\d{2}):(\d{2})$/.exec(text)
  const shift = offset ? (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3])) : 0
  return new Date(ms + shift * 60_000).toISOString().slice(0, 10) === text.slice(0, 10)
}

/**
 * Review 2026-11-07 (critical): how a string breaks its lines. A text box gives each break back as
 * \n — one written with \r\n gets them back as they were; one with a lone \r, or both kinds, cannot
 * pass through a box without changing breaks the user never touched (it is edited in the text).
 */
export function lineBreaks(text: string): 'none' | 'lf' | 'crlf' | 'mixed' {
  if (!/[\r\n]/.test(text)) return 'none'
  if (/\r(?!\n)/.test(text)) return 'mixed'
  const crlf = /\r\n/.test(text)
  if (crlf && /(?<!\r)\n/.test(text)) return 'mixed'
  return crlf ? 'crlf' : 'lf'
}

/**
 * Review 2026-11-07: whether a date can be edited at all — one JavaScript cannot hold (BSON allows
 * ±2^63 ms) is read as an Invalid Date, its time lost: nothing typed could keep it, so it is not
 * offered (the server shows such a document only to the shell).
 */
export const editableDate = (value: unknown): boolean =>
  typeOf(value) !== 'date' || !Number.isNaN((value as Date).getTime())

/** The text an inline editor starts with. */
export function editText(value: unknown): string {
  switch (typeOf(value)) {
    case 'string':
      return value as string
    case 'null':
      return 'null'
    case 'date':
      return editableDate(value) ? (value as Date).toISOString() : ''
    case 'objectId':
      return (value as { toHexString(): string }).toHexString()
    case 'int32':
    case 'double': {
      const n = Number((value as { valueOf(): number }).valueOf())
      return Object.is(n, -0) ? '-0' : String(n)
    }
    default:
      return String(value)
  }
}
