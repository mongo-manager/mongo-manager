import { createHmac } from 'node:crypto'
import type { Document } from 'mongodb'
import { bsonClassOf, deserializeValue, serializeValue, toWire } from '@mongo-manager/shared'
import { Errors, type AppError } from '../errors'
import type { NsMasker } from '../masking/match'

/** Keep BSON wrapper classes: 1.0 stays Double, large Longs keep precision (spec §4.2). */
export const READ_OPTIONS = {
  promoteValues: false,
  promoteLongs: false,
  promoteBuffers: false,
  bsonRegExp: true,
} as const

/** What in a document the app would not write back as stored (data review 2026-10-13, M3). */
export interface Caution {
  kind: EjsonHazardKind
  field: string
  /** How many more such fields the document holds (at most MAX_CAUTIONS). */
  others?: number
}
const MAX_CAUTIONS = 100
export type DocumentItem =
  { document: unknown; hash: string; caution?: Caution } | { unsupported: { _id: unknown; reason: string } }

/**
 * Exact version of a stored document: type-aware (Int32 1 ≠ Double 1.0) and order-aware. An HMAC
 * with the server's pin key, bound to the namespace (phase 3c §4.1, final review C3): a restricted
 * user cannot confirm a guessed value by getting the same document hashed somewhere else.
 */
export function hashDocument(doc: Document, key: Buffer, ns: string): string {
  return createHmac('sha256', key)
    .update(ns)
    .update(Buffer.from([0]))
    .update(toWire(doc))
    .digest('hex')
}

/**
 * Decodes a client _id for an exact match. Objects with $-keys would act as query operators
 * ({ $ne: … } matching any document), so they are refused; use the result as { _id: { $eq: id } }.
 */
export function exactId(value: unknown): unknown {
  const id = fromClient<unknown>(value, '_id')
  if (
    id !== null &&
    typeof id === 'object' &&
    !Array.isArray(id) &&
    !(id instanceof Date) &&
    bsonClassOf(id) === undefined
  ) {
    if (Object.keys(id).some((k) => k.startsWith('$')))
      throw Errors.validation('_id must be a value, not a query operator')
  }
  return id
}

export function fromClient<T = Document>(value: unknown, what: string): T {
  try {
    return deserializeValue<T>(value)
  } catch (e) {
    throw Errors.validation(`${what} is not valid Extended JSON: ${(e as Error).message}`)
  }
}

/**
 * The names Extended JSON reads as a typed value (bson's own list, with $date, $code and
 * $dbPointer); `$undefined` only when true, as bson reads it.
 */
const EJSON_KEYS = new Set([
  '$oid',
  '$binary',
  '$uuid',
  '$symbol',
  '$numberInt',
  '$numberDecimal',
  '$numberDouble',
  '$numberLong',
  '$minKey',
  '$maxKey',
  '$regex',
  '$regularExpression',
  '$timestamp',
  '$date',
  '$code',
  '$dbPointer',
])
const MAX_HAZARD_DEPTH = 200

/**
 * What the app cannot write back as stored: a field named like Extended JSON, the old undefined
 * type, nesting too deep — or, found when a write misses an unchanged version, a form it cannot
 * match exactly (a reference with its fields in another order).
 */
export type EjsonHazardKind = 'ejson_like' | 'undefined' | 'too_deep' | 'unmatched' | 'bad_date'
export interface EjsonHazard {
  /** Dotted, with array positions: as an update names it. */
  path: string
  /** Its field names, without array positions: as a personal-data rule names it. */
  fields: readonly string[]
  kind: EjsonHazardKind
}

/** A plain object Extended JSON would read as a typed value. */
function misread(o: Record<string, unknown>): boolean {
  if (o.$undefined) return true
  if (typeof o.$ref === 'string' && o.$id !== undefined && o.$id !== null) return true
  for (const k of Object.keys(o)) if (EJSON_KEYS.has(k) && o[k] !== undefined && o[k] !== null) return true
  return false
}

/**
 * Data review 2026-10-13 (H3, I2): where a stored document would not read back as it is through
 * Extended JSON — a field named like a typed value ({$numberInt: "5"}, {$regex, $options}) that
 * the app shows as that value, or an `undefined` that reads back as null — inside references and
 * code too (round 2, I2). Written back from here, those fields would change. A walk of the
 * document, no copy of it, its paths built only for what it finds (M1, round 2 M15); a NaN is any
 * NaN.
 */
export function ejsonHazards(doc: Document, limit = Infinity): EjsonHazard[] {
  const found: EjsonHazard[] = []
  const at: Array<string | number> = []
  const hit = (kind: EjsonHazardKind) =>
    found.push({ path: at.join('.'), fields: at.filter((s): s is string => typeof s === 'string'), kind })
  const into = (segment: string | number, value: unknown, depth: number) => {
    at.push(segment)
    walk(value, depth)
    at.pop()
  }
  const walk = (value: unknown, depth: number): void => {
    if (found.length >= limit) return
    if (value === undefined) return void hit('undefined')
    if (value instanceof Date) {
      // A date JavaScript cannot represent (BSON allows ±2^63 ms) is found by the same walk (M15).
      if (Number.isNaN(value.getTime())) hit('bad_date')
      return
    }
    if (value === null || typeof value !== 'object' || value instanceof RegExp) return
    if (ArrayBuffer.isView(value)) return
    if (depth > MAX_HAZARD_DEPTH) return void hit('too_deep')
    const kind = bsonClassOf(value)
    if (kind === 'DBRef') {
      const ref = value as { oid: unknown; fields?: Record<string, unknown> }
      into('$id', ref.oid, depth + 1)
      for (const [k, v] of Object.entries(ref.fields ?? {})) into(k, v, depth + 1)
      return
    }
    if (kind === 'Code') {
      const scope = (value as { scope?: unknown }).scope
      if (scope) into('$scope', scope, depth + 1)
      return
    }
    if (kind !== undefined) return
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) into(i, value[i], depth + 1)
      return
    }
    const o = value as Record<string, unknown>
    if (misread(o)) return void hit('ejson_like')
    for (const k of Object.keys(o)) into(k, o[k], depth + 1)
  }
  walk(doc, 0)
  return found
}

/** What an update does at a path: sets a value there, or removes what is there. */
export interface Change {
  set: readonly string[]
  unset: readonly string[]
}

/**
 * Where an update's path stands to a hazard's: the same field, above it, inside it, or apart. A
 * positional segment ($, $[], $[name]) stands for any element (round 2, M7).
 */
function relation(path: string, hazard: string): 'same' | 'above' | 'inside' | 'apart' {
  if (hazard === '') return 'inside'
  const a = path.split('.')
  const b = hazard.split('.')
  for (let i = 0; i < Math.min(a.length, b.length); i++)
    if (a[i] !== b[i] && !a[i]!.startsWith('$')) return 'apart'
  return a.length === b.length ? 'same' : a.length < b.length ? 'above' : 'inside'
}

/** Whether a change touches a hazard: a value set at, above or inside it; a removal inside it. */
export function touchesHazard(hazard: EjsonHazard, change: Change): boolean {
  // The old undefined type can never be matched as read: no change of the document is made (I1).
  if (hazard.kind === 'undefined' || hazard.kind === 'too_deep') return true
  return (
    change.set.some((p) => relation(p, hazard.path) !== 'apart') ||
    // Removing such a field, or what holds it, misreads nothing (round 2, M6).
    change.unset.some((p) => relation(p, hazard.path) === 'inside')
  )
}

/**
 * Refuses a change the app could not write back as stored: of the whole document (a replace), or
 * one that touches such a field (an update rewrites only its paths). A hidden value is left to the
 * masking gate — kept as stored by a replace, refused by an update — and never named.
 */
export function refuseHazards(current: Document, change: Change | null, hidden: NsMasker | null): void {
  const hazard = ejsonHazards(current).find(
    (h) =>
      !(hidden?.any && h.fields.length && (hidden.matches(h.fields) || hidden.under(h.fields))) &&
      (!change || touchesHazard(h, change)),
  )
  if (hazard) throw notRoundTrip(hazard)
}

const HAZARD_TEXT: Record<EjsonHazardKind, string> = {
  ejson_like:
    'holds a value named like Extended JSON ($numberInt, $regex…) that the app reads as a typed value: changing it from here would change it',
  undefined:
    'holds the old "undefined" type, which the app cannot write back: this document cannot be changed from here',
  too_deep: 'is nested deeper than the app can check: it cannot be changed from here',
  bad_date: 'holds a date outside the range the app can read: it cannot be changed from here',
  unmatched:
    'is stored in a form the app cannot match exactly (a reference with its fields in another order…): it cannot be changed from here',
}

/** The refusal of a change the app could not write back as stored; the shell can make it. */
export function notRoundTrip(hazard: Pick<EjsonHazard, 'path' | 'kind'>): AppError {
  const where = hazard.path ? `The field "${hazard.path.slice(0, 200)}"` : 'This document'
  return Errors.conflict(`${where} ${HAZARD_TEXT[hazard.kind]}. Use the shell.`, {
    reason: 'not_round_trip',
    kind: hazard.kind,
    field: hazard.path.slice(0, 200),
  })
}

export function toClient(value: unknown): unknown {
  return serializeValue(value)
}

function safeId(id: unknown): unknown {
  try {
    return serializeValue(id)
  } catch {
    return null
  }
}

/** One unrenderable document must not break a whole page (1a carry-over). */
export function toClientDocument(doc: Document, hash: (doc: Document) => string): DocumentItem {
  const hazards = ejsonHazards(doc)
  const badDate = hazards.find((h) => h.kind === 'bad_date')
  if (badDate) {
    return {
      unsupported: {
        _id: safeId(doc._id),
        reason: `Field "${badDate.path || '(root)'}" holds a date outside the range JavaScript can represent; view or edit this document in the shell`,
      },
    }
  }
  try {
    // Round 2 (M13): an _id the app would read as another value names another document.
    if (hazards.some((h) => h.fields[0] === '_id'))
      return {
        unsupported: {
          _id: null,
          reason:
            'Its _id is named like Extended JSON and would be read as another value; view or change it in the shell',
        },
      }
    const item: DocumentItem = { document: serializeValue(doc), hash: hash(doc) }
    const [first] = hazards
    if (first) {
      item.caution = { kind: first.kind, field: first.path.slice(0, 200) }
      if (hazards.length > 1) item.caution.others = Math.min(hazards.length - 1, MAX_CAUTIONS)
    }
    return item
  } catch (e) {
    return {
      unsupported: { _id: safeId(doc._id), reason: `This document cannot be shown: ${(e as Error).message}` },
    }
  }
}
