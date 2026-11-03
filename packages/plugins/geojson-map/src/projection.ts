/**
 * Map redesign (spec plugin-tabs-redesign §2.5): Web Mercator as tile servers cut the world — a
 * 256 px square at zoom 0, twice as large at each zoom — and the view's arithmetic: fitting places,
 * the zoom limits, and longitudes across the antimeridian.
 */

export const TILE = 256
/** Where the Mercator square ends: the world is cut here, as every tile server cuts it. */
export const MAX_LAT = 85.0511287798066

export interface LngLat {
  lng: number
  lat: number
}
export interface Pixel {
  x: number
  y: number
}
export interface Size {
  width: number
  height: number
}
/** West to east; `east` may pass 180 when the span crosses the antimeridian. */
export interface Bounds {
  west: number
  east: number
  south: number
  north: number
}

export const worldSize = (zoom: number) => TILE * 2 ** zoom

const clampLat = (lat: number) => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat))

/** A longitude in [-180, 180). */
export function wrapLng(lng: number): number {
  if (lng >= -180 && lng < 180) return lng
  const w = (((lng + 180) % 360) + 360) % 360
  return w - 180
}

/** A place as world pixels at a zoom (longitudes past ±180 land past the square's edges). */
export function project(p: LngLat, zoom: number): Pixel {
  const size = worldSize(zoom)
  const s = Math.sin((clampLat(p.lat) * Math.PI) / 180)
  return {
    x: ((p.lng + 180) / 360) * size,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size,
  }
}

export function unproject(p: Pixel, zoom: number): LngLat {
  const size = worldSize(zoom)
  const n = Math.PI - (2 * Math.PI * p.y) / size
  return {
    lng: (p.x / size) * 360 - 180,
    lat: (180 / Math.PI) * Math.atan(Math.sinh(n)),
  }
}

/**
 * The longitudes places span, the short way round: the widest gap between them is what lies
 * outside (a span across the antimeridian was once the whole world).
 */
export function lngSpan(lngs: number[]): { west: number; east: number } {
  const sorted = [...new Set(lngs.map(wrapLng))].sort((a, b) => a - b)
  if (sorted.length <= 1) return { west: sorted[0] ?? 0, east: sorted[0] ?? 0 }
  let gap = sorted[0]! + 360 - sorted.at(-1)!
  let west = sorted[0]!
  let east = sorted.at(-1)!
  for (let i = 0; i + 1 < sorted.length; i++) {
    const g = sorted[i + 1]! - sorted[i]!
    if (g > gap) {
      gap = g
      west = sorted[i + 1]!
      east = sorted[i]! + 360
    }
  }
  return { west, east }
}

export function boundsOf(points: LngLat[]): Bounds | null {
  if (!points.length) return null
  let south = Infinity
  let north = -Infinity
  for (const p of points) {
    south = Math.min(south, p.lat)
    north = Math.max(north, p.lat)
  }
  return { ...lngSpan(points.map((p) => p.lng)), south, north }
}

/** A line's positions, each within 180° of the one before: a line across the antimeridian is drawn the short way. */
export function unwrapLine(line: number[][]): number[][] {
  let previous: number | null = null
  return line.map(([lng, lat]) => {
    let x = lng!
    if (previous !== null) {
      while (x - previous > 180) x -= 360
      while (x - previous < -180) x += 360
    }
    previous = x
    return [x, lat!]
  })
}

/** The least zoom: the world at least as tall as the view, so there is no empty band at the poles. */
export function minZoomFor(size: Size): number {
  if (!(size.height > TILE)) return 0
  return Math.ceil(Math.log2(size.height / TILE) * 4) / 4
}

/** The centre kept so the view never shows past the poles; longitudes wrap. */
export function clampCenter(center: LngLat, zoom: number, size: Size): LngLat {
  const world = worldSize(zoom)
  const half = size.height / 2
  const y = project(center, zoom).y
  const kept = world <= size.height ? world / 2 : Math.max(half, Math.min(world - half, y))
  return { lng: wrapLng(center.lng), lat: kept === y ? center.lat : unproject({ x: 0, y: kept }, zoom).lat }
}

/**
 * The view that shows the bounds whole within the padding, as close as the limits allow, in
 * quarter steps (so a fitted view always fits).
 */
export function fitView(
  bounds: Bounds,
  size: Size,
  o: { padding: number; minZoom: number; maxZoom: number },
): { center: LngLat; zoom: number } {
  if (bounds.west === bounds.east && bounds.south === bounds.north)
    return { center: { lng: wrapLng(bounds.west), lat: bounds.north }, zoom: o.maxZoom }
  const nw = project({ lng: bounds.west, lat: bounds.north }, 0)
  const se = project({ lng: bounds.east, lat: bounds.south }, 0)
  const dx = se.x - nw.x
  const dy = se.y - nw.y
  const width = Math.max(1, size.width - 2 * o.padding)
  const height = Math.max(1, size.height - 2 * o.padding)
  const fits = Math.min(dx > 0 ? width / dx : Infinity, dy > 0 ? height / dy : Infinity)
  const raw = Number.isFinite(fits) ? Math.floor(Math.log2(fits) * 4) / 4 : o.maxZoom
  const zoom = Math.max(o.minZoom, Math.min(o.maxZoom, raw))
  const middle = unproject({ x: (nw.x + se.x) / 2, y: (nw.y + se.y) / 2 }, 0)
  return { center: { lng: wrapLng(middle.lng), lat: middle.lat }, zoom }
}
