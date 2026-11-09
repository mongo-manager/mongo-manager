// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { decodeValue, toShell, typeOf } from './values'

/**
 * UI redesign R1 review ("sorgu filtreleme alanı çok eksik ve basit"): the filter builder's model —
 * conditions on fields, joined by All ($and) or Any ($or), written as MQL and read back from it.
 */
export type ValueType = 'string' | 'number' | 'boolean' | 'date' | 'objectId' | 'null'
export type FilterOp =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'nin'
  | 'exists'
  | 'missing'
  | 'contains'
  | 'starts'
  | 'ends'
export interface Condition {
  id: string
  field: string
  op: FilterOp
  /** As typed: a list is comma-separated. */
  value: string
  type: ValueType
}
export interface FilterGroup {
  mode: 'and' | 'or'
  conditions: Condition[]
}

export const FILTER_OPS: readonly FilterOp[] = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'nin',
  'contains',
  'starts',
  'ends',
  'exists',
  'missing',
]
export const VALUE_TYPES: readonly ValueType[] = ['string', 'number', 'boolean', 'date', 'objectId', 'null']
/** The operators that take no value. */
export const NO_VALUE: ReadonlySet<FilterOp> = new Set(['exists', 'missing'])
/** The operators whose value is text matched in part. */
const TEXT_MATCH: ReadonlySet<FilterOp> = new Set(['contains', 'starts', 'ends'])
const COMPARE: Partial<Record<FilterOp, string>> = {
  ne: '$ne',
  gt: '$gt',
  gte: '$gte',
  lt: '$lt',
  lte: '$lte',
  in: '$in',
  nin: '$nin',
}

type Failure = { ok: false; id: string; reason: ValueType | 'list' }
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** One typed value as BSON, or the reason it is not one. */
function typed(raw: string, type: ValueType): { ok: true; value: unknown } | { ok: false } {
  const text = raw.trim()
  switch (type) {
    case 'string':
      return { ok: true, value: raw }
    case 'number': {
      if (text === '' || !Number.isFinite(Number(text))) return { ok: false }
      return { ok: true, value: Number(text) }
    }
    case 'boolean':
      if (text !== 'true' && text !== 'false') return { ok: false }
      return { ok: true, value: text === 'true' }
    case 'date': {
      // A bare date is midnight UTC, as the server stores dates.
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : text
      const ms = Date.parse(iso)
      if (!text || Number.isNaN(ms)) return { ok: false }
      return { ok: true, value: decodeValue({ $date: new Date(ms).toISOString() }) }
    }
    case 'objectId':
      if (!/^[0-9a-fA-F]{24}$/.test(text)) return { ok: false }
      return { ok: true, value: decodeValue({ $oid: text.toLowerCase() }) }
    case 'null':
      return { ok: true, value: null }
  }
}

/** One condition's value for its field: a plain value (equals) or an operator document. */
function part(c: Condition): { ok: true; ops: Array<[string, unknown]> } | Failure {
  if (c.op === 'exists') return { ok: true, ops: [['$exists', true]] }
  if (c.op === 'missing') return { ok: true, ops: [['$exists', false]] }
  if (TEXT_MATCH.has(c.op)) {
    const body = escapeRegex(c.value)
    const pattern = c.op === 'starts' ? `^${body}` : c.op === 'ends' ? `${body}$` : body
    return {
      ok: true,
      ops: [
        ['$regex', pattern],
        ['$options', 'i'],
      ],
    }
  }
  if (c.op === 'in' || c.op === 'nin') {
    const items = c.value.split(',').filter((s) => s.trim() !== '')
    if (items.length === 0) return { ok: false, id: c.id, reason: 'list' }
    const values: unknown[] = []
    for (const item of items) {
      const v = typed(c.type === 'string' ? item.trim() : item, c.type)
      if (!v.ok) return { ok: false, id: c.id, reason: c.type }
      values.push(v.value)
    }
    return { ok: true, ops: [[COMPARE[c.op]!, values]] }
  }
  const v = typed(c.value, c.type)
  if (!v.ok) return { ok: false, id: c.id, reason: c.type }
  return { ok: true, ops: [[c.op === 'eq' ? '$eq' : COMPARE[c.op]!, v.value]] }
}

/** A field's conditions as one value: a single "equals" stays plain ({ status: "paid" }). */
function fieldValue(ops: Array<[string, unknown]>): unknown {
  return ops.length === 1 && ops[0]![0] === '$eq' ? ops[0]![1] : Object.fromEntries(ops)
}

/** The builder's filter as shell text ('' when it has no condition). */
export function toFilter(group: FilterGroup): { ok: true; text: string } | Failure {
  const used = group.conditions.filter((c) => c.field.trim() !== '')
  if (used.length === 0) return { ok: true, text: '' }
  const parts: Array<{ field: string; ops: Array<[string, unknown]> }> = []
  for (const c of used) {
    const p = part(c)
    if (!p.ok) return p
    parts.push({ field: c.field.trim(), ops: p.ops })
  }
  let filter: Record<string, unknown>
  if (group.mode === 'or' && parts.length > 1) {
    filter = { $or: parts.map((p) => ({ [p.field]: fieldValue(p.ops) })) }
  } else {
    // All: conditions on one field share its document, unless the same operator comes twice.
    const byField = new Map<string, Array<[string, unknown]>>()
    let clash = false
    for (const p of parts) {
      const ops = byField.get(p.field) ?? []
      for (const [op] of p.ops) if (ops.some(([o]) => o === op)) clash = true
      byField.set(p.field, [...ops, ...p.ops])
    }
    filter = clash
      ? { $and: parts.map((p) => ({ [p.field]: fieldValue(p.ops) })) }
      : Object.fromEntries([...byField].map(([field, ops]) => [field, fieldValue(ops)]))
  }
  return { ok: true, text: toShell(filter, 0) }
}

let nextId = 0
const newId = () => `c${++nextId}`
/** A new, empty condition. */
export const emptyCondition = (field = ''): Condition => ({
  id: newId(),
  field,
  op: 'eq',
  value: '',
  type: 'string',
})

/**
 * A BSON value as the builder shows it, or null when it is not one the builder edits. Reviewer B I4:
 * only values it writes back the same — a Long or a Decimal128 would come back a double, which
 * MongoDB compares differently, so they stay in the text.
 */
function shown(value: unknown): { value: string; type: ValueType } | null {
  switch (typeOf(value)) {
    case 'string':
      return { value: value as string, type: 'string' }
    case 'int32':
    case 'double':
      return Number.isFinite(Number(value)) ? { value: String(value), type: 'number' } : null
    case 'boolean':
      return { value: String(value), type: 'boolean' }
    case 'date':
      return { value: (value as Date).toISOString(), type: 'date' }
    case 'objectId':
      return { value: (value as { toHexString(): string }).toHexString(), type: 'objectId' }
    case 'null':
      return { value: '', type: 'null' }
    default:
      return null
  }
}
/** The characters escapeRegex escapes. */
const REGEX_SPECIAL = new Set('.*+?^${}()|[]\\')
/**
 * Only patterns the builder wrote: each special character escaped, nothing else escaped (\\d is a
 * digit, not a "d"), no bare special character — or null (reviewer B I4).
 */
const unescapeRegex = (s: string): string | null => {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (ch === '\\') {
      const next = s[i + 1]
      if (next === undefined || !REGEX_SPECIAL.has(next)) return null
      out += next
      i++
    } else if (REGEX_SPECIAL.has(ch)) return null
    else out += ch
  }
  return out
}
const OP_OF: Record<string, FilterOp> = {
  $eq: 'eq',
  $ne: 'ne',
  $gt: 'gt',
  $gte: 'gte',
  $lt: 'lt',
  $lte: 'lte',
  $in: 'in',
  $nin: 'nin',
}

/** One field's value as conditions, or null. */
function readField(field: string, value: unknown): Condition[] | null {
  const plain = shown(value)
  if (plain) return [{ id: newId(), field, op: 'eq', ...plain }]
  if (typeOf(value) !== 'object') return null
  const doc = value as Record<string, unknown>
  const keys = Object.keys(doc)
  if (keys.length === 0 || keys.some((k) => !k.startsWith('$'))) return null
  const out: Condition[] = []
  if ('$regex' in doc) {
    if (doc.$options !== 'i' || typeof doc.$regex !== 'string' || keys.length !== 2) return null
    const raw = doc.$regex
    const starts = raw.startsWith('^')
    const ends = raw.endsWith('$') && !raw.endsWith('\\$')
    const body = unescapeRegex(raw.slice(starts ? 1 : 0, ends ? -1 : undefined))
    if (body === null || (starts && ends)) return null
    return [
      { id: newId(), field, op: starts ? 'starts' : ends ? 'ends' : 'contains', value: body, type: 'string' },
    ]
  }
  for (const key of keys) {
    const v = doc[key]
    if (key === '$exists') {
      if (typeof v !== 'boolean') return null
      out.push({ id: newId(), field, op: v ? 'exists' : 'missing', value: '', type: 'string' })
      continue
    }
    const op = OP_OF[key]
    if (!op) return null
    if (op === 'in' || op === 'nin') {
      if (!Array.isArray(v) || v.length === 0) return null
      const items = v.map(shown)
      const type = items[0]?.type
      if (items.some((i) => !i || i.type !== type) || !type) return null
      // Items are written comma-separated and trimmed: one holding a comma or edge spaces stays text.
      if (items.some((i) => i!.value.includes(',') || i!.value.trim() !== i!.value || i!.value === ''))
        return null
      out.push({ id: newId(), field, op, value: items.map((i) => i!.value).join(', '), type })
      continue
    }
    const one = shown(v)
    if (!one) return null
    out.push({ id: newId(), field, op, ...one })
  }
  return out
}

/** A document of fields, each read in turn. */
function readDocument(doc: Record<string, unknown>): Condition[] | null {
  const out: Condition[] = []
  for (const [field, value] of Object.entries(doc)) {
    if (field.startsWith('$')) return null
    const conditions = readField(field, value)
    if (!conditions) return null
    out.push(...conditions)
  }
  return out
}

/**
 * The builder's view of a filter, or null when the filter holds anything it cannot show (then it is
 * edited as text: the builder never drops part of a filter).
 */
export function fromFilter(filter: Record<string, unknown>): FilterGroup | null {
  const keys = Object.keys(filter)
  if (keys.length === 0) return { mode: 'and', conditions: [] }
  if (keys.length === 1 && (keys[0] === '$or' || keys[0] === '$and')) {
    const list = filter[keys[0]!]
    if (!Array.isArray(list) || list.length === 0) return null
    const conditions: Condition[] = []
    for (const item of list) {
      if (typeOf(item) !== 'object') return null
      const read = readDocument(item as Record<string, unknown>)
      // Any: one condition per alternative (several would need their own All group).
      if (!read || (keys[0] === '$or' && read.length !== 1)) return null
      conditions.push(...read)
    }
    return { mode: keys[0] === '$or' ? 'or' : 'and', conditions }
  }
  const conditions = readDocument(filter)
  return conditions ? { mode: 'and', conditions } : null
}
