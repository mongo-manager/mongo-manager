// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { parseQueryObject, type FieldStats, type SchemaType } from '@mongo-manager/shared/browser'
import { decodeValue, toQueryShell } from '@/documents/values'

/**
 * W2 (2026-10-16): the Schema tab's values, ranges, types and map areas as filter conditions, and
 * the Documents filter with one more of them (Compass's "click to add to the query").
 */

/**
 * The field as a query names it: its keys joined by "." (an array's elements are matched through
 * the array's path). Null for a key no dotted path can name ("a.b", "$x", empty).
 */
export function queryPath(keys: ReadonlyArray<string | null>): string | null {
  const named = keys.filter((k): k is string => k !== null)
  if (named.length === 0) return null
  if (named.some((k) => k === '' || k.includes('.') || k.startsWith('$') || k.includes('\0'))) return null
  return named.join('.')
}

type Top = NonNullable<FieldStats['top']>[number]

/** A top value as itself, in its type; null for a value cut short (it would match nothing). */
export function topCondition(top: Top): unknown {
  if (top.cut) return null
  switch (top.type) {
    case 'bool':
      return top.value === 'true'
    case 'objectId':
      return /^[0-9a-f]{24}$/i.test(top.value) ? decodeValue({ $oid: top.value }) : null
    default:
      return top.value
  }
}

/** One histogram bar as its range: from its start, up to the next bar's (the last one closed). */
export function binCondition(f: FieldStats, index: number): unknown {
  const range = f.numbers
    ? { min: f.numbers.min, max: f.numbers.max, bins: f.numbers.bins.length, date: false }
    : f.dates
      ? { min: Date.parse(f.dates.min), max: Date.parse(f.dates.max), bins: f.dates.bins.length, date: true }
      : null
  if (!range || index < 0 || index >= range.bins) return null
  const step = (range.max - range.min) / range.bins
  const last = index === range.bins - 1
  const from = range.min + step * index
  const to = last ? range.max : range.min + step * (index + 1)
  const value = (n: number) => (range.date ? decodeValue({ $date: new Date(n).toISOString() }) : n)
  return last ? { $gte: value(from), $lte: value(to) } : { $gte: value(from), $lt: value(to) }
}

/** MongoDB's $type alias for each type the analysis tells apart. */
const TYPE_ALIASES: Partial<Record<SchemaType, string>> = {
  string: 'string',
  int: 'int',
  long: 'long',
  double: 'double',
  decimal: 'decimal',
  bool: 'bool',
  date: 'date',
  objectId: 'objectId',
  null: 'null',
  object: 'object',
  array: 'array',
  binData: 'binData',
  regex: 'regex',
  timestamp: 'timestamp',
  minKey: 'minKey',
  maxKey: 'maxKey',
}

export function typeCondition(type: SchemaType): unknown {
  const alias = TYPE_ALIASES[type]
  return alias ? { $type: alias } : null
}

export interface Area {
  west: number
  south: number
  east: number
  north: number
}

/**
 * The places within an area: a GeoJSON polygon for GeoJSON values, a $box for legacy pairs (each
 * kind matches only its own). Null for an area a GeoJSON polygon cannot say: one 180° wide or more
 * is read by MongoDB as the smaller polygon on the other side of the world.
 */
export function areaCondition(area: Area, kind: 'geojson' | 'legacy'): unknown {
  const { west, south, east, north } = area
  if (!(west < east && south < north)) return null
  if (kind === 'legacy')
    return {
      $geoWithin: {
        $box: [
          [west, south],
          [east, north],
        ],
      },
    }
  if (east - west >= 180) return null
  // W2 review (I2): a GeoJSON edge is a great circle, the map's south and north edges are lines of
  // latitude: a point every degree keeps each edge within a thousandth of a degree of the map's.
  // Counter-clockwise: the south edge west to east, up the east meridian, the north edge back west.
  const ring = [
    ...along(south, west, east),
    [east, south],
    ...along(north, east, west),
    [west, north],
    [west, south],
  ]
  return { $geoWithin: { $geometry: { type: 'Polygon', coordinates: [ring] } } }
}

const round = (n: number) => Math.round(n * 1e6) / 1e6
/** A line of latitude from one longitude towards another, a point every degree (its end left out). */
function along(lat: number, from: number, to: number): number[][] {
  const steps = Math.max(1, Math.ceil(Math.abs(to - from)))
  return Array.from({ length: steps }, (_, i) => [round(from + ((to - from) * i) / steps), lat])
}

/**
 * The filter text with one more condition: added beside the others, or AND-ed (in $and) when the
 * filter has a condition on that field already. A filter that does not parse is not changed.
 */
export function addCondition(
  filter: string,
  path: string,
  condition: unknown,
): { text: string } | { error: string } {
  let current: Record<string, unknown>
  try {
    current = parseQueryObject(filter, { params: true })
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
  let next: Record<string, unknown>
  if (!Object.hasOwn(current, path)) next = { ...current, [path]: condition }
  else {
    const and = Array.isArray(current.$and) ? (current.$and as unknown[]) : []
    next = { ...current, $and: [...and, { [path]: condition }] }
  }
  return { text: toQueryShell(next, 0) }
}
