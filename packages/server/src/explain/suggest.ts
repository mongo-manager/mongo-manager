import type { Document } from 'mongodb'
import type { IndexSuggestion } from './types'

const RANGE = new Set(['$gt', '$gte', '$lt', '$lte', '$ne', '$nin', '$regex', '$exists', '$type'])

const isObject = (v: unknown): v is Document =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  !(v instanceof Date) &&
  !('_bsontype' in (v as object))

/** Fields by how the query uses them; null when the filter's shape cannot be served by one index. */
/** A regular expression value, as the driver or the parser gives it. */
const isRegex = (v: unknown) =>
  v instanceof RegExp ||
  (v !== null && typeof v === 'object' && (v as { _bsontype?: unknown })._bsontype === 'BSONRegExp')

function classify(filter: Document, equality: string[], range: string[], fromIn: string[]): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' && Array.isArray(value)) {
      for (const part of value) if (!isObject(part) || !classify(part, equality, range, fromIn)) return false
      continue
    }
    // $or, $nor, $expr, $text…: one compound index is not the answer.
    if (key.startsWith('$')) return false
    // A regex literal matches a range of keys, as $regex does (final review 2b, I6).
    if (isRegex(value)) {
      range.push(key)
      continue
    }
    const ops = isObject(value) ? Object.keys(value) : []
    if (ops.length && ops.every((op) => op.startsWith('$'))) {
      if (ops.every((op) => op === '$eq' || op === '$in')) {
        equality.push(key)
        if (ops.includes('$in')) fromIn.push(key)
      } else if (ops.some((op) => RANGE.has(op))) range.push(key)
      else return false
    } else equality.push(key)
  }
  return true
}

/**
 * Phase 2b spec §2.1: an index for the query by the ESR rule (equality, sort, range), or null when
 * none is needed: no fields, an _id lookup, or an existing index that already starts with it.
 */
export function suggestIndex(
  input: { filter?: Document; sort?: Document; stages?: Document[] },
  existing: Array<{ key: Document }>,
): IndexSuggestion | null {
  let filter = input.filter ?? {}
  let sort = input.sort ?? {}
  if (input.stages) {
    const [first, second] = input.stages
    if (isObject(first?.$match)) {
      filter = first.$match
      if (isObject(second?.$sort)) sort = second.$sort
    } else if (isObject(first?.$sort)) sort = first.$sort
  }
  const equality: string[] = []
  const range: string[] = []
  const fromIn: string[] = []
  if (!classify(filter, equality, range, fromIn)) return null
  if (equality.includes('_id')) return null
  const sortFields = Object.entries(sort).filter(([, d]) => d === 1 || d === -1) as Array<[string, 1 | -1]>
  const key: Array<[string, 1 | -1]> = []
  const add = (field: string, dir: 1 | -1) => {
    if (!key.some(([f]) => f === field)) key.push([field, dir])
  }
  for (const f of equality) add(f, 1)
  for (const [f, d] of sortFields) add(f, d)
  for (const f of range) add(f, 1)
  if (key.length === 0) return null
  // Covered when an index starts with the equality fields in any order, then the sort fields in
  // order with all directions the same or all reversed, then the range fields (final review 2b, M5).
  const eq = key.slice(0, new Set(equality).size)
  const sorted = key.slice(eq.length, eq.length + sortFields.filter(([f]) => !equality.includes(f)).length)
  const ranged = key.slice(eq.length + sorted.length)
  const covered = existing.some(({ key: k }) => {
    const entries = Object.entries(k).map(([f, d]) => [f, Number(d)] as const)
    if (entries.length < key.length) return false
    const head = entries.slice(0, eq.length).map(([f]) => f)
    if (!eq.every(([f]) => head.includes(f))) return false
    const mid = entries.slice(eq.length, eq.length + sorted.length)
    const same = sorted.every(([f, d], i) => mid[i]?.[0] === f && mid[i]?.[1] === d)
    const reversed = sorted.every(([f, d], i) => mid[i]?.[0] === f && mid[i]?.[1] === -d)
    if (!same && !reversed) return false
    const tail = entries.slice(eq.length + sorted.length, key.length).map(([f]) => f)
    return ranged.every(([f]) => tail.includes(f))
  })
  if (covered) return null
  return {
    key,
    reason: {
      equality: equality.filter((f, i) => equality.indexOf(f) === i),
      sort: sortFields.map(([f]) => f).filter((f) => !equality.includes(f)),
      range: range.filter((f) => !equality.includes(f) && !sortFields.some(([s]) => s === f)),
      // A long $in list with a sort behaves like a range for that sort (M6).
      ...(fromIn.length && sortFields.length ? { inWithSort: true as const } : {}),
    },
  }
}
