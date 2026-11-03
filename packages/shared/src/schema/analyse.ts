/**
 * Sampled schema analysis (phase 1i spec §5). A pure function of the documents it is given: the
 * server feeds it a $sample stream and never keeps the documents. Values come as the driver
 * returns them with promoteValues off (Int32, Double, Long…), or as plain JavaScript values.
 */

export const SCHEMA_TYPES = [
  'string',
  'int',
  'long',
  'double',
  'decimal',
  'bool',
  'date',
  'objectId',
  'null',
  'object',
  'array',
  'binData',
  'regex',
  'timestamp',
  'minKey',
  'maxKey',
  'other',
] as const
export type SchemaType = (typeof SCHEMA_TYPES)[number]

export interface FieldStats {
  /** For display: the keys joined by "." (array elements as "name[]"). */
  path: string
  /**
   * The keys from the top, null for an array element: a dotted key stays one key, and a field
   * literally named "[]" stays a field.
   */
  keys: Array<string | null>
  /** Documents (or array elements) holding it. */
  count: number
  types: Partial<Record<SchemaType, number>>
  numbers?: { min: number; max: number; bins: number[] }
  dates?: { min: string; max: string; bins: number[] }
  /**
   * W2 (2026-10-16): each value with its type (a filter condition in the Schema tab); `cut` when it
   * was longer than SCHEMA_MAX_VALUE_LENGTH and only its start is given.
   */
  top?: Array<{ value: string; count: number; type: TopValueType; cut?: true }>
  arrays?: { minLength: number; maxLength: number; avgLength: number }
  /**
   * W2 (2026-10-16): the places among its values — GeoJSON Point and MultiPoint, legacy coordinate
   * pairs ([lng, lat] or { lng, lat }) — as [longitude, latitude], at most SCHEMA_GEO_POINTS of
   * them; `count` is how many values were places, `geojson` how many of those were GeoJSON (an area
   * filter is written for GeoJSON or for legacy pairs, never for a mix).
   */
  geo?: { points: Array<[number, number]>; count: number; geojson: number }
  /** Phase 3c: personal data hidden from this user; only the count is given. */
  masked?: boolean
}

export interface SchemaAnalysis {
  sampled: number
  fields: FieldStats[]
  /** More distinct paths than SCHEMA_MAX_PATHS were seen; the rest are left out. */
  truncated: boolean
}

export const SCHEMA_MAX_DEPTH = 8
export const SCHEMA_MAX_PATHS = 500
export const SCHEMA_MAX_TRACKED_VALUES = 1000
export const SCHEMA_MAX_VALUE_LENGTH = 100
export const SCHEMA_TOP_VALUES = 10
export const SCHEMA_BINS = 10
/** Places kept per path for the Schema tab's map. */
export const SCHEMA_GEO_POINTS = 1000
/** Places kept in all: a collection of many pair-like arrays never makes a large answer. */
export const SCHEMA_GEO_TOTAL = 10_000

/** The types whose values are counted for the top values. */
export type TopValueType = 'string' | 'objectId' | 'bool'
/** A counted value's key starts with its type's letter; a cut string's with its capital. */
const TOP_TAGS: Record<string, TopValueType> = { s: 'string', S: 'string', o: 'objectId', b: 'bool' }
/** Numbers kept per path to build histograms: the largest sample size (spec §5). */
const MAX_KEPT = 10_000

const BSON_TYPES: Record<string, SchemaType> = {
  Int32: 'int',
  Double: 'double',
  Long: 'long',
  Decimal128: 'decimal',
  ObjectId: 'objectId',
  Binary: 'binData',
  BSONRegExp: 'regex',
  Timestamp: 'timestamp',
  MinKey: 'minKey',
  MaxKey: 'maxKey',
}

function bsonTag(value: object): string | undefined {
  const tag = (value as { _bsontype?: unknown })._bsontype
  return typeof tag === 'string' ? tag : undefined
}

function typeOf(value: unknown): SchemaType {
  if (value === null || value === undefined) return 'null'
  switch (typeof value) {
    case 'string':
      return 'string'
    case 'boolean':
      return 'bool'
    case 'number':
      return Number.isInteger(value) ? 'int' : 'double'
    case 'bigint':
      return 'long'
    case 'object':
      break
    default:
      return 'other'
  }
  if (value instanceof Date) return 'date'
  if (value instanceof RegExp) return 'regex'
  if (Array.isArray(value)) return 'array'
  const tag = bsonTag(value as object)
  if (tag !== undefined) return BSON_TYPES[tag] ?? 'other'
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null ? 'object' : 'other'
}

function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return Number(value)
  if (value && typeof value === 'object') {
    const tag = bsonTag(value)
    if (tag === 'Int32' || tag === 'Double') return Number((value as { valueOf(): number }).valueOf())
    if (tag === 'Long' || tag === 'Decimal128') {
      const n = Number(String(value))
      return Number.isFinite(n) ? n : null
    }
  }
  return null
}

interface Acc {
  keys: Array<string | null>
  count: number
  types: Partial<Record<SchemaType, number>>
  numbers: number[]
  dates: number[]
  values: Map<string, number>
  arrays: { min: number; max: number; sum: number; n: number } | null
  geo: { points: Array<[number, number]>; count: number; geojson: number } | null
  /** Fields below it, and its array elements under the key null: looked up without building ids. */
  children: Map<string | null, Acc>
}

const newAcc = (keys: Array<string | null>): Acc => ({
  keys,
  count: 0,
  types: {},
  numbers: [],
  dates: [],
  values: new Map(),
  arrays: null,
  geo: null,
  children: new Map(),
})

/** A longitude and a latitude within the world's bounds, or null. */
function place(x: unknown, y: unknown): [number, number] | null {
  const lng = numberOf(x)
  const lat = numberOf(y)
  if (lng === null || lat === null) return null
  return Math.abs(lng) <= 180 && Math.abs(lat) <= 90 ? [lng, lat] : null
}
/** [lng, lat] as an array of exactly two numbers. */
const pairOf = (v: unknown): [number, number] | null =>
  Array.isArray(v) && v.length === 2 ? place(v[0], v[1]) : null
/** A GeoJSON position: [lng, lat], or [lng, lat, altitude]. */
const positionOf = (v: unknown): [number, number] | null =>
  Array.isArray(v) && (v.length === 2 || v.length === 3) ? place(v[0], v[1]) : null
/**
 * W2 review (minor 4): a bare [x, y] is a place only under a name that says so — size: [10, 20] is
 * no map. The nearest named key above the array counts (coords: [[lng, lat], …]).
 */
const PLACE_WORDS = new Set([
  'loc',
  'location',
  'locations',
  'coord',
  'coords',
  'coordinate',
  'coordinates',
  'geo',
  'geopoint',
  'gps',
  'position',
  'pos',
  'point',
  'lnglat',
  'latlng',
  'lonlat',
  'longlat',
  'center',
  'centre',
  'place',
])
/**
 * The words of a name (re-review minor 6): camelCase and snake_case segments, and the name whole
 * (latLng, LatLng) — endpoint, checkpoint and repos are no place.
 */
function nameWords(key: string): string[] {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
  return [...words, key.replace(/[^A-Za-z]/g, '').toLowerCase()]
}
function placeNamed(keys: ReadonlyArray<string | null>): boolean {
  for (let i = keys.length - 1; i >= 0; i--) {
    const key = keys[i]
    if (key !== null && key !== undefined) return nameWords(key).some((w) => PLACE_WORDS.has(w))
  }
  return false
}
const LNG_KEYS = new Set(['lng', 'lon', 'long', 'longitude', 'x'])
const LAT_KEYS = new Set(['lat', 'latitude', 'y'])

/**
 * The places a value holds: a GeoJSON Point or MultiPoint, or a legacy pair as an embedded document
 * whose two fields are named as a longitude and a latitude ({ lng, lat }, { x, y }). Arrays of two
 * numbers are looked at by the caller (see `record`). Null when it is no place.
 */
function geoOf(value: Record<string, unknown>): { points: Array<[number, number]>; geojson: boolean } | null {
  const keys = Object.keys(value)
  if (value.type === 'Point') {
    const p = positionOf(value.coordinates)
    return p ? { points: [p], geojson: true } : null
  }
  if (value.type === 'MultiPoint' && Array.isArray(value.coordinates) && value.coordinates.length > 0) {
    const points = value.coordinates.map(positionOf)
    return points.every((p) => p !== null)
      ? { points: points as Array<[number, number]>, geojson: true }
      : null
  }
  if (keys.length === 2 && LNG_KEYS.has(keys[0]!.toLowerCase()) && LAT_KEYS.has(keys[1]!.toLowerCase())) {
    const p = place(value[keys[0]!], value[keys[1]!])
    return p ? { points: [p], geojson: false } : null
  }
  return null
}

function bins(values: number[]): { min: number; max: number; bins: number[] } {
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const counts = new Array<number>(SCHEMA_BINS).fill(0)
  // Halved, so a range across the whole double range does not overflow to Infinity.
  const span = max / 2 - min / 2
  for (const v of values) {
    const i = span === 0 ? 0 : Math.min(SCHEMA_BINS - 1, Math.floor(((v / 2 - min / 2) / span) * SCHEMA_BINS))
    counts[i]!++
  }
  return { min, max, bins: counts }
}

/**
 * A copy of the first characters that does not point into the original: a V8 substring keeps its
 * whole parent alive, so a kept 100-character cut could pin a whole document string (final review
 * 1i, Important 1).
 */
function cut(value: string): string {
  return value.length > SCHEMA_MAX_VALUE_LENGTH
    ? value.slice(0, SCHEMA_MAX_VALUE_LENGTH).split('').join('')
    : value
}

export class SchemaAnalyser {
  private readonly root = newAcc([])
  private paths = 0
  private sampled = 0
  private truncated = false
  /** Inside a GeoJSON value: its coordinates are its parent's place, not a legacy pair of their own. */
  private inGeo = 0
  /** Places kept so far, across every path. */
  private geoKept = 0

  add(doc: Record<string, unknown>): void {
    this.sampled++
    this.walk(this.root, doc, 1)
  }

  private walk(parent: Acc, object: Record<string, unknown>, depth: number): void {
    for (const key of Object.keys(object)) {
      const acc = this.child(parent, key)
      if (acc) this.record(acc, object[key], depth)
    }
  }

  private child(parent: Acc, key: string | null): Acc | null {
    let acc = parent.children.get(key)
    if (!acc) {
      if (this.paths >= SCHEMA_MAX_PATHS) {
        this.truncated = true
        return null
      }
      this.paths++
      acc = newAcc([...parent.keys, key])
      parent.children.set(key, acc)
    }
    return acc
  }

  private record(acc: Acc, value: unknown, depth: number): void {
    acc.count++
    let type = typeOf(value)
    // Deeper than SCHEMA_MAX_DEPTH: counted, never walked.
    if ((type === 'object' || type === 'array') && depth >= SCHEMA_MAX_DEPTH) type = 'other'
    acc.types[type] = (acc.types[type] ?? 0) + 1
    switch (type) {
      case 'object': {
        const places = this.inGeo === 0 ? geoOf(value as Record<string, unknown>) : null
        if (places) this.places(acc, places.points, places.geojson)
        if (places) this.inGeo++
        try {
          this.walk(acc, value as Record<string, unknown>, depth + 1)
        } finally {
          if (places) this.inGeo--
        }
        return
      }
      case 'array': {
        const items = value as unknown[]
        const pair = this.inGeo === 0 && placeNamed(acc.keys) ? pairOf(items) : null
        if (pair) this.places(acc, [pair], false)
        const a = (acc.arrays ??= { min: Infinity, max: -Infinity, sum: 0, n: 0 })
        a.min = Math.min(a.min, items.length)
        a.max = Math.max(a.max, items.length)
        a.sum += items.length
        a.n++
        // The element path is found once per array, not once per element.
        const element = items.length > 0 ? this.child(acc, null) : null
        if (element) for (const item of items) this.record(element, item, depth + 1)
        return
      }
      case 'int':
      case 'long':
      case 'double':
      case 'decimal': {
        const n = numberOf(value)
        if (n !== null && acc.numbers.length < MAX_KEPT) acc.numbers.push(n)
        return
      }
      case 'date': {
        const t = (value as Date).getTime()
        if (Number.isFinite(t) && acc.dates.length < MAX_KEPT) acc.dates.push(t)
        return
      }
      case 'string':
        this.count(acc, 's', value as string)
        return
      case 'objectId':
        this.count(acc, 'o', (value as { toHexString(): string }).toHexString())
        return
      case 'bool':
        this.count(acc, 'b', String(value))
        return
      default:
        // Binary, regular expressions and the rest: only their type is counted, never their content.
        return
    }
  }

  /** The value counted under its type's letter (a cut one under the capital: it is only a start). */
  private count(acc: Acc, tag: 's' | 'o' | 'b', raw: string): void {
    const long = raw.length > SCHEMA_MAX_VALUE_LENGTH
    const key = long ? `S${raw.slice(0, SCHEMA_MAX_VALUE_LENGTH)}` : tag + raw
    const seen = acc.values.get(key)
    if (seen !== undefined) acc.values.set(key, seen + 1)
    else if (acc.values.size < SCHEMA_MAX_TRACKED_VALUES) acc.values.set(long ? `S${cut(raw)}` : key, 1)
  }

  private places(acc: Acc, points: Array<[number, number]>, geojson: boolean): void {
    const geo = (acc.geo ??= { points: [], count: 0, geojson: 0 })
    geo.count++
    if (geojson) geo.geojson++
    for (const p of points) {
      if (geo.points.length >= SCHEMA_GEO_POINTS || this.geoKept >= SCHEMA_GEO_TOTAL) break
      geo.points.push(p)
      this.geoKept++
    }
  }

  private all(): Acc[] {
    const out: Acc[] = []
    const visit = (acc: Acc) => {
      for (const child of acc.children.values()) {
        out.push(child)
        visit(child)
      }
    }
    visit(this.root)
    return out
  }

  result(): SchemaAnalysis {
    const fields = this.all().map((acc): FieldStats => {
      const f: FieldStats = {
        path: acc.keys.map((k, i) => (k === null ? '[]' : i === 0 ? k : `.${k}`)).join(''),
        keys: acc.keys,
        count: acc.count,
        types: acc.types,
      }
      if (acc.numbers.length > 0) f.numbers = bins(acc.numbers)
      if (acc.dates.length > 0) {
        const d = bins(acc.dates)
        f.dates = { min: new Date(d.min).toISOString(), max: new Date(d.max).toISOString(), bins: d.bins }
      }
      if (acc.values.size > 0) {
        f.top = [...acc.values]
          // Ties by value, then by type (the key's first letter).
          .sort((a, b) => b[1] - a[1] || order(a[0].slice(1), b[0].slice(1)) || order(a[0], b[0]))
          .slice(0, SCHEMA_TOP_VALUES)
          .map(([key, count]) => ({
            value: key.slice(1),
            count,
            type: TOP_TAGS[key[0]!]!,
            ...(key[0] === 'S' ? { cut: true as const } : {}),
          }))
      }
      if (acc.geo) f.geo = { points: acc.geo.points, count: acc.geo.count, geojson: acc.geo.geojson }
      if (acc.arrays)
        f.arrays = {
          minLength: acc.arrays.min,
          maxLength: acc.arrays.max,
          avgLength: acc.arrays.sum / acc.arrays.n,
        }
      return f
    })
    // Sorted by keys, so a path's children follow it and the order is stable.
    fields.sort((a, b) => compareKeys(a.keys, b.keys))
    return { sampled: this.sampled, fields, truncated: this.truncated }
  }
}

const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Array elements (null) first, then keys in code-unit order. */
function compareKeys(a: Array<string | null>, b: Array<string | null>): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!
    const y = b[i]!
    if (x === y) continue
    if (x === null) return -1
    if (y === null) return 1
    return x < y ? -1 : 1
  }
  return a.length - b.length
}
