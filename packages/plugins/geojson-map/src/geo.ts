/**
 * Phase 4b §4: shapes in documents. Documents come over the bridge as canonical Extended JSON; their
 * numbers are read back, and GeoJSON geometries, features and feature collections — and legacy
 * `[lng, lat]` pairs — are found in any field, a few levels deep.
 */

export interface Geometry {
  type: string
  coordinates?: unknown
  geometries?: Geometry[]
}
export interface Feature {
  type: 'Feature'
  geometry: Geometry
  /**
   * The document's `_id`, the field the shape is in, and the document's name when it has one.
   * `query`: the path a filter on the shape takes — its keys, array positions left out (a filter
   * reads into arrays); a Feature's under its geometry, a FeatureCollection's under its features
   * (`zones.features.geometry`) — or null where a key is none a path can name (a dot or a $ in it,
   * or empty; review 2026-10-28).
   */
  properties: { _id: unknown; field: string; label: string | null; query: string | null }
}

const GEOMETRIES = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
])
const MAX_DEPTH = 6
/**
 * Fields a legacy `[lng, lat]` pair is taken from — named for a place (4b map review: any two numbers
 * in range, a version or a size, are no point). "latlng" is left out: it usually holds latitude first.
 */
const PLACE =
  /^(loc|locs|location|locations|coordinates|coords|coord|position|positions|pos|point|points|geo|lnglat|lonlat|lng_lat|lon_lat|center|centre)$/i
/** The field a value sits in, by its last name that is not a position in an array. */
const placeName = (field: string) =>
  field
    .split('.')
    .reverse()
    .find((part) => !/^\d+$/.test(part)) ?? ''
const GEOJSON_TYPES = new Set([...GEOMETRIES, 'Feature', 'FeatureCollection'])
const MAX_SHAPES = 50

/** Canonical Extended JSON numbers as numbers; everything else as it is. */
export function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain)
  if (!value || typeof value !== 'object') return value
  const o = value as Record<string, unknown>
  const keys = Object.keys(o)
  if (keys.length === 1) {
    const k = keys[0]!
    if (k === '$numberDouble' || k === '$numberInt' || k === '$numberLong' || k === '$numberDecimal') {
      const x = Number(o[k])
      return Number.isFinite(x) ? x : null
    }
  }
  return Object.fromEntries(keys.map((k) => [k, plain(o[k])]))
}

const isPosition = (v: unknown): v is number[] =>
  Array.isArray(v) &&
  v.length >= 2 &&
  v.length <= 3 &&
  v.every((x) => typeof x === 'number' && Number.isFinite(x)) &&
  Math.abs(v[0] as number) <= 180 &&
  Math.abs(v[1] as number) <= 90

/** Whether nested coordinates hold positions only (as deep as the type says). */
function coordinatesOk(type: string, c: unknown): boolean {
  const depth: Record<string, number> = {
    Point: 0,
    MultiPoint: 1,
    LineString: 1,
    MultiLineString: 2,
    Polygon: 2,
    MultiPolygon: 3,
  }
  const walk = (v: unknown, d: number): boolean =>
    d === 0 ? isPosition(v) : Array.isArray(v) && v.length > 0 && v.every((x) => walk(x, d - 1))
  return type in depth && walk(c, depth[type]!)
}

function geometryOf(v: unknown): Geometry | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const g = v as Record<string, unknown>
  if (typeof g.type !== 'string' || !GEOMETRIES.has(g.type)) return null
  if (g.type === 'GeometryCollection') {
    const parts = Array.isArray(g.geometries) ? g.geometries.map(geometryOf) : []
    return parts.length && parts.every(Boolean) ? { type: g.type, geometries: parts as Geometry[] } : null
  }
  return coordinatesOk(g.type, g.coordinates) ? { type: g.type, coordinates: g.coordinates } : null
}

/** A key a filter's path can name: not empty, no dot, not an operator. */
const nameable = (key: string) => key !== '' && !key.includes('.') && !key.startsWith('$')

/** The shapes of one document (canonical EJSON), each with its document's `_id` and its field. */
export function featuresOf(document: Record<string, unknown>): Feature[] {
  const id = document._id
  const named = [document.name, document.title, document.label].find((v) => typeof v === 'string' && v.trim())
  const label = typeof named === 'string' ? named.trim().slice(0, 60) : null
  const out: Feature[] = []
  const add = (geometry: Geometry, field: string, keys: string[] | null) => {
    if (out.length < MAX_SHAPES)
      out.push({
        type: 'Feature',
        geometry,
        properties: { _id: id, field, label, query: keys?.join('.') ?? null },
      })
  }
  const under = (keys: string[] | null, key: string) => (keys && nameable(key) ? [...keys, key] : null)
  const walk = (raw: unknown, field: string, depth: number, keys: string[] | null): void => {
    if (depth > MAX_DEPTH || out.length >= MAX_SHAPES) return
    const v = plain(raw)
    if (isPosition(v) && v.length === 2) {
      if (PLACE.test(placeName(field))) add({ type: 'Point', coordinates: v }, field, keys)
      return
    }
    if (!v || typeof v !== 'object') return
    if (Array.isArray(v))
      return v.slice(0, MAX_SHAPES).forEach((x, i) => walk(x, `${field}.${i}`, depth + 1, keys))
    const o = v as Record<string, unknown>
    if (o.type === 'Feature') {
      const g = geometryOf(o.geometry)
      if (g) add(g, field, under(keys, 'geometry'))
      return
    }
    if (o.type === 'FeatureCollection' && Array.isArray(o.features)) {
      const features = under(keys, 'features')
      o.features
        .slice(0, MAX_SHAPES)
        .forEach((f, i) => walk(f, `${field}.features.${i}`, depth + 1, features))
      return
    }
    const g = geometryOf(o)
    if (g) return add(g, field, keys)
    // A shape that does not hold together is left out whole, never read as loose points.
    if (typeof o.type === 'string' && GEOJSON_TYPES.has(o.type)) return
    for (const [k, x] of Object.entries(o)) walk(x, field ? `${field}.${k}` : k, depth + 1, under(keys, k))
  }
  // A document that is a FeatureCollection itself: its features at the top (`features.geometry`).
  const collection = document.type === 'FeatureCollection' && Array.isArray(document.features)
  if (collection) walk({ type: 'FeatureCollection', features: document.features }, 'features', 1, [])
  for (const [k, x] of Object.entries(document))
    if (k !== '_id' && !(collection && (k === 'type' || k === 'features'))) walk(x, k, 1, under([], k))
  return out
}

/**
 * The field a shape is in, as the field picker names it: positions in arrays left out
 * (`stops.2.loc` is `stops.loc`, a FeatureCollection's `zones.features.4` is `zones`).
 */
export function fieldOf(field: string): string {
  const parts = field.split('.')
  const kept = parts.filter(
    (part, i) => !/^\d+$/.test(part) && !(part === 'features' && /^\d+$/.test(parts[i + 1] ?? '')),
  )
  return kept.join('.') || field
}

/** The most of one shape the map draws: past this, a frame would freeze on every move. */
export const MAX_VERTICES = 10_000
export const MAX_PARTS = 1_000

/**
 * A shape's lines (rings, parts) as the map draws them: the first MAX_PARTS, and at most
 * MAX_VERTICES positions, every n-th kept evenly, with each line's first and last (a ring stays shut).
 */
export function thinLines(lines: number[][][]): number[][][] {
  const parts = lines.length > MAX_PARTS ? lines.slice(0, MAX_PARTS) : lines
  let total = 0
  for (const line of parts) total += line.length
  if (total <= MAX_VERTICES) return parts
  // A line keeps up to two more than its share (a rounded-up count, and its last): room for them.
  const step = Math.ceil(total / (MAX_VERTICES - 2 * parts.length))
  return parts.map((line) => {
    const kept: number[][] = []
    for (let i = 0; i < line.length - 1; i += step) kept.push(line[i]!)
    if (line.length) kept.push(line.at(-1)!)
    return kept
  })
}

/** A point as a cell shows it: "lat, lng"; nothing for any other value. */
export function cellText(value: unknown): { text: string; tone: 'info' } | null {
  const v = plain(value) as { type?: unknown; geometry?: unknown } | null
  const g = geometryOf(v && typeof v === 'object' && v.type === 'Feature' ? v.geometry : v)
  if (!g || g.type !== 'Point') return null
  const [lng, lat] = g.coordinates as number[]
  return { text: `${lat!.toFixed(5)}, ${lng!.toFixed(5)}`, tone: 'info' }
}
