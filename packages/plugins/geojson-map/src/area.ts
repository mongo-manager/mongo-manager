/**
 * Map 1.2 (research 2026-10-28: COMPASS-3781, Compass draws a shape to filter by it): an area drawn
 * on the map — a polygon, a circle, or the area in view — as the filter selecting the documents whose
 * shapes lie within it, by MongoDB's $geoWithin (on GeoJSON and on legacy [lng, lat] pairs alike).
 */
import { langTag, shown } from '../../kit/src/ui'
import { TEXT } from './text'
import { MAX_LAT, wrapLng, type LngLat } from './projection'

export type Doc = Record<string, unknown>

/** MongoDB's radius of the Earth for $centerSphere (in metres; its docs use 6,378.1 km). */
export const EARTH_RADIUS = 6_378_100

/**
 * A polygon's ring for the strict-winding CRS, which MongoDB reads as the area on the left of its
 * edges: any size, a hemisphere or more too (the area in view, zoomed out). Counterclockwise, as
 * drawn on a flat map; closed, as GeoJSON wants it.
 */
const STRICT = { type: 'name', properties: { name: 'urn:x-mongodb:crs:strictwinding:EPSG:4326' } }
const dbl = (n: number): Doc => ({ $numberDouble: String(n) })
/** A longitude within the world: 180 stays 180 (wrapLng makes it -180, a corner of the other side). */
const inWorld = (lng: number) => (lng >= -180 && lng <= 180 ? lng : wrapLng(lng))
const clampLat = (lat: number) => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat))
/** Mercator's y of a latitude, and back: a straight line on the map is a straight line in (lng, y). */
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (clampLat(lat) * Math.PI) / 360))
const latOf = (y: number) => (360 / Math.PI) * Math.atan(Math.exp(y)) - 90
/** A place as the map lays it out, its y in degrees: the plane its edges are straight in. */
const onMap = (p: LngLat): LngLat => ({ lng: p.lng, lat: (mercY(p.lat) * 180) / Math.PI })

/**
 * Twice the signed area of a ring on the map (Mercator, where its edges are drawn straight):
 * positive when counterclockwise.
 */
function signedArea(ring: readonly LngLat[]): number {
  let sum = 0
  for (let i = 0; i < ring.length; i++) {
    const a = onMap(ring[i]!)
    const b = onMap(ring[(i + 1) % ring.length]!)
    sum += a.lng * b.lat - b.lng * a.lat
  }
  return sum
}

/**
 * The corners as one line on the map: each within 180° of longitude of the one before (a corner
 * placed after the map was moved across the antimeridian is the same place 360° away), so the ring's
 * winding is the one drawn (review C1).
 */
export function continuous(points: readonly LngLat[]): LngLat[] {
  const out: LngLat[] = []
  for (const p of points) {
    const before = out.at(-1)
    const lng = before ? p.lng - Math.round((p.lng - before.lng) / 360) * 360 : p.lng
    out.push({ lng, lat: p.lat })
  }
  return out
}

/** Corners without repeats (a double click is one corner said twice) or a closing copy: 3 at least. */
export function cleanRing(points: readonly LngLat[]): LngLat[] | null {
  const ring: LngLat[] = []
  for (const p of points) {
    const last = ring.at(-1)
    if (!last || last.lng !== p.lng || last.lat !== p.lat) ring.push(p)
  }
  if (ring.length > 1 && ring[0]!.lng === ring.at(-1)!.lng && ring[0]!.lat === ring.at(-1)!.lat) ring.pop()
  return ring.length >= 3 ? ring : null
}

const side = (p: LngLat, q: LngLat, r: LngLat) =>
  (q.lng - p.lng) * (r.lat - p.lat) - (q.lat - p.lat) * (r.lng - p.lng)
const span = (p: LngLat, q: LngLat) => Math.hypot(q.lng - p.lng, q.lat - p.lat)
/** On one line, within rounding: a side value that small next to the lengths it is made of. */
const inLine = (p: LngLat, q: LngLat, r: LngLat) => Math.abs(side(p, q, r)) <= 1e-9 * span(p, q) * span(p, r)
/** r on segment pq, the line known: within its box. */
const within = (p: LngLat, q: LngLat, r: LngLat) =>
  Math.min(p.lng, q.lng) <= r.lng &&
  r.lng <= Math.max(p.lng, q.lng) &&
  Math.min(p.lat, q.lat) <= r.lat &&
  r.lat <= Math.max(p.lat, q.lat)

/** Whether segments ab and cd meet — cross, touch or overlap (two edges not side by side never may). */
function meets(a: LngLat, b: LngLat, c: LngLat, d: LngLat): boolean {
  const d1 = side(c, d, a)
  const d2 = side(c, d, b)
  const d3 = side(a, b, c)
  const d4 = side(a, b, d)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true
  return (
    (inLine(c, d, a) && within(c, d, a)) ||
    (inLine(c, d, b) && within(c, d, b)) ||
    (inLine(a, b, c) && within(a, b, c)) ||
    (inLine(a, b, d) && within(a, b, d))
  )
}

/**
 * Why a drawn polygon makes no area MongoDB takes (review 2026-10-28): fewer than three corners, no
 * size (its corners on one line of the map), or edges that cross, touch or double back (a bow tie;
 * a spike: an edge going back along the one before ends on it, where the next one starts). Null when
 * it makes one. Its size is told next to its length, at any scale: a building's outline is an area
 * (review I7).
 */
export function polygonProblem(points: readonly LngLat[]): 'corners' | 'empty' | 'crossing' | null {
  const clean = cleanRing(points)
  if (!clean) return 'corners'
  // On the map, where its edges are straight.
  const ring = continuous(clean).map(onMap)
  const n = ring.length
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue
      if (meets(ring[i]!, ring[(i + 1) % n]!, ring[j]!, ring[(j + 1) % n]!)) return 'crossing'
    }
  }
  // Twice its area, measured from its first corner (rounding stays small), next to its length squared.
  const o = ring[0]!
  let area = 0
  let length = 0
  for (let i = 0; i < n; i++) {
    const a = ring[i]!
    const b = ring[(i + 1) % n]!
    area += (a.lng - o.lng) * (b.lat - o.lat) - (b.lng - o.lng) * (a.lat - o.lat)
    length += span(a, b)
  }
  return Math.abs(area) <= 1e-9 * length * length ? 'empty' : null
}

/**
 * Corners a ring is made of, at most: past this, its edges go in longer steps. They are longest for
 * the area in view zoomed out (about 4° for the whole world), where the gap between such a step and
 * the globe's shorter way is under a kilometre: less than a pixel at that zoom.
 */
export const MAX_CORNERS = 360

/**
 * The ring with corners along each edge as the map draws it — a straight line on Mercator, steps of
 * 1° at most — since MongoDB joins two corners by the shortest way round the globe, which bows toward
 * a pole away from the line drawn (review I1). A long ring takes longer steps, MAX_CORNERS in all.
 */
export function densify(ring: readonly LngLat[], step = 1): LngLat[] {
  const n = ring.length
  // In degrees of longitude, and of Mercator's y (never less than the latitude it spans).
  const spans = ring.map((a, i) => {
    const b = ring[(i + 1) % n]!
    return Math.max(Math.abs(b.lng - a.lng), (Math.abs(mercY(b.lat) - mercY(a.lat)) * 180) / Math.PI)
  })
  const total = spans.reduce((sum, s) => sum + Math.max(1, Math.ceil(s / step)), 0)
  const size = total > MAX_CORNERS ? (step * total) / MAX_CORNERS : step
  const out: LngLat[] = []
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % n]!
    const parts = Math.max(1, Math.ceil(spans[i]! / size))
    const ya = mercY(a.lat)
    const yb = mercY(b.lat)
    for (let k = 0; k < parts; k++) {
      const t = k / parts
      // Along a parallel the latitude stays as it is (its y back and forth would not be exact).
      const lat = a.lat === b.lat ? a.lat : latOf(ya + (yb - ya) * t)
      out.push(k === 0 ? a : { lng: a.lng + (b.lng - a.lng) * t, lat })
    }
  })
  return out
}

/** A ring on the map (each edge as drawn, any width) as the filter: counterclockwise, densified, closed. */
function ringFilter(field: string, drawn: readonly LngLat[]): Doc {
  const ring = densify(signedArea(drawn) < 0 ? [...drawn].reverse() : drawn)
  const coordinates = [...ring, ring[0]!].map((p) => [dbl(inWorld(p.lng)), dbl(clampLat(p.lat))])
  return {
    [field]: { $geoWithin: { $geometry: { type: 'Polygon', coordinates: [coordinates], crs: STRICT } } },
  }
}

/** The polygon's filter; null when it makes no area (see polygonProblem). */
export function withinPolygon(field: string, points: readonly LngLat[]): Doc | null {
  if (polygonProblem(points)) return null
  return ringFilter(field, continuous(cleanRing(points)!))
}

/** The great-circle distance between two places, in metres. */
export function distance(a: LngLat, b: LngLat): number {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLng = (b.lng - a.lng) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * The circle's outline on the globe, as the filter reads it — the places `metres` from the centre,
 * every 360/n degrees of bearing — for the map to draw (review 2026-10-28: a circle of pixels is not
 * the area a spherical cap holds). Longitudes stay near the centre's.
 */
export function circleOutline(center: LngLat, metres: number, n = 64): LngLat[] {
  const rad = Math.PI / 180
  const d = Math.min(Math.PI, metres / EARTH_RADIUS)
  const lat1 = center.lat * rad
  const out: LngLat[] = []
  for (let i = 0; i < n; i++) {
    const bearing = (2 * Math.PI * i) / n
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(bearing))
    const dLng = Math.atan2(
      Math.sin(bearing) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    )
    out.push({ lng: center.lng + dLng / rad, lat: lat2 / rad })
  }
  return out
}

export function withinCircle(field: string, center: LngLat, metres: number): Doc | null {
  if (!(metres > 0)) return null
  return {
    [field]: {
      $geoWithin: {
        $centerSphere: [[dbl(inWorld(center.lng)), dbl(center.lat)], dbl(metres / EARTH_RADIUS)],
      },
    },
  }
}

export interface Bounds {
  west: number
  east: number
  south: number
  north: number
}

/**
 * The area in view, as a polygon whose edges follow the map's (densify). A view the whole width of
 * the world (zoomed out, or past 360°) stops just short of the antimeridian, where it would meet
 * itself; its south and north stop at the map's own edges (Mercator never shows a pole).
 */
export function withinBounds(field: string, b: Bounds): Doc | null {
  // Past the map's own poles it is clamped as every corner is (ringFilter).
  const { south, north } = b
  if (!(north > south) || !(b.east > b.west)) return null
  const whole = b.east - b.west >= 360
  const west = whole ? -180 : b.west
  const east = whole ? 180 - 1e-6 : b.east
  // Its edges may be wider than half the world: taken as they are, never the short way round.
  return ringFilter(field, [
    { lng: west, lat: south },
    { lng: east, lat: south },
    { lng: east, lat: north },
    { lng: west, lat: north },
  ])
}

/** A distance in words, for the circle being drawn. */
export function distanceText(metres: number, locale: string): string {
  const n = new Intl.NumberFormat(langTag(shown(TEXT, locale)), { maximumFractionDigits: 1 })
  return metres >= 1000 ? `${n.format(metres / 1000)} km` : `${n.format(Math.round(metres))} m`
}
