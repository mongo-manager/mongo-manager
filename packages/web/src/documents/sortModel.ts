import { decodeValue, typeOf } from './values'

const NUMERIC = new Set(['int32', 'double', 'long', 'decimal128'])

/**
 * W1 (completion §2): the table's headers sort the results by writing the query's sort — the
 * Options' sort stays the one source of truth, the headers only read it and change it.
 */
export type SortDir = 1 | -1
export interface SortEntry {
  field: string
  /** null: not a direction ({ $meta: 'textScore' }), kept as it is. */
  dir: SortDir | null
}

/** A direction from a sort's value (1, -1, Int32, Long, Double, "asc", "desc"), or null. */
function directionOf(value: unknown): SortDir | null {
  if (value === 'asc' || value === 'ascending') return 1
  if (value === 'desc' || value === 'descending') return -1
  if (!NUMERIC.has(typeOf(value))) return null
  const n = Number(String(value))
  return n === 1 ? 1 : n === -1 ? -1 : null
}

/** The run query's sort (canonical EJSON) as its fields in order. */
export function sortOf(sort: Record<string, unknown> | undefined): SortEntry[] {
  if (!sort) return []
  const decoded = decodeValue(sort) as Record<string, unknown>
  return Object.entries(decoded).map(([field, value]) => ({ field, dir: directionOf(value) }))
}

/** How a column is sorted: its direction, its place among the sort's fields, and how many there are. */
export function sortState(
  sort: Record<string, unknown> | undefined,
  field: string,
): { dir: SortDir; position: number; count: number } | null {
  const entries = sortOf(sort)
  const at = entries.findIndex((e) => e.field === field)
  const dir = at < 0 ? null : entries[at]!.dir
  return dir === null ? null : { dir, position: at + 1, count: entries.length }
}

/**
 * The sort after a header is used, as plain values (undefined: no sort). A click sorts by this column
 * alone: ascending, then descending, then not at all. Added to the sort (Shift), the column joins the
 * others, turns, then leaves them. `to` sets a direction (null: none) instead of the next one.
 */
export function cycleSort(
  sort: Record<string, unknown> | undefined,
  field: string,
  additive = false,
  to?: SortDir | null,
): Record<string, unknown> | undefined {
  const decoded = sort ? (decodeValue(sort) as Record<string, unknown>) : {}
  // Alone, a column turns only when the sort is by it alone; one of several starts again ascending.
  const counted = additive || Object.keys(decoded).length === 1
  const current = directionOf(counted && Object.hasOwn(decoded, field) ? decoded[field] : undefined)
  const next: SortDir | null = to !== undefined ? to : current === null ? 1 : current === 1 ? -1 : null
  let out: Record<string, unknown>
  if (additive) {
    // The other fields keep their places, their directions as plain numbers.
    out = Object.fromEntries(Object.entries(decoded).map(([k, v]) => [k, directionOf(v) ?? v]))
    if (next === null) delete out[field]
    else out[field] = next
  } else out = next === null ? {} : { [field]: next }
  return Object.keys(out).length ? out : undefined
}
