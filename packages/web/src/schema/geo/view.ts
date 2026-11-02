import land from './land-110m.json'
import type { Area } from '../conditions'

/**
 * W2 (2026-10-16): the Schema tab's offline map — no tiles and no network: the world as Natural
 * Earth's 1:110m land (public domain, bundled), in an equirectangular projection where one unit is
 * one degree (x = longitude, y = −latitude), and a view onto it that pans and zooms.
 */

export const MIN_ZOOM = 1
export const MAX_ZOOM = 64
const WORLD = { width: 360, height: 180 }

/** The land as SVG path data. Each ring is tenth-degree integers: its first point, then steps. */
let path: string | null = null
export function landPath(): string {
  if (path !== null) return path
  const parts: string[] = []
  for (const ring of land as number[][]) {
    let x = 0
    let y = 0
    const points: string[] = []
    for (let i = 0; i + 1 < ring.length; i += 2) {
      x += ring[i]!
      y += ring[i + 1]!
      points.push(`${x / 10} ${-y / 10}`)
    }
    parts.push(`M${points.join('L')}Z`)
  }
  path = parts.join('')
  return path
}

/** Where the view looks (its middle, in map units) and how close. */
export interface View {
  cx: number
  cy: number
  zoom: number
}
export const WORLD_VIEW: View = { cx: 0, cy: 0, zoom: 1 }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** The view kept inside the world and the zoom limits. */
export function settle(view: View): View {
  const zoom = clamp(view.zoom, MIN_ZOOM, MAX_ZOOM)
  const w = WORLD.width / zoom / 2
  const h = WORLD.height / zoom / 2
  return { zoom, cx: clamp(view.cx, -180 + w, 180 - w), cy: clamp(view.cy, -90 + h, 90 - h) }
}

/** The SVG viewBox of a view. */
export function viewBox(view: View): { x: number; y: number; width: number; height: number } {
  const width = WORLD.width / view.zoom
  const height = WORLD.height / view.zoom
  return { x: view.cx - width / 2, y: view.cy - height / 2, width, height }
}

/** The view's area in longitudes and latitudes. */
export function areaOf(view: View): Area {
  const box = viewBox(view)
  const round = (n: number) => Math.round(n * 1e4) / 1e4
  return {
    west: round(box.x),
    east: round(box.x + box.width),
    north: round(-box.y),
    south: round(-(box.y + box.height)),
  }
}

/** Zoomed by a factor around a map point (it stays where it is on the screen). */
export function zoomAt(
  view: View,
  factor: number,
  at: { x: number; y: number } = { x: view.cx, y: view.cy },
): View {
  const zoom = clamp(view.zoom * factor, MIN_ZOOM, MAX_ZOOM)
  const k = view.zoom / zoom
  return settle({ zoom, cx: at.x + (view.cx - at.x) * k, cy: at.y + (view.cy - at.y) * k })
}

/** Moved by a share of the view's width and height. */
export function panBy(view: View, dx: number, dy: number): View {
  const box = viewBox(view)
  return settle({ ...view, cx: view.cx + dx * box.width, cy: view.cy + dy * box.height })
}

/** The closest view that shows every point, with a margin; the world when there are none. */
export function fitPoints(points: ReadonlyArray<readonly [number, number]>): View {
  if (points.length === 0) return WORLD_VIEW
  let west = Infinity
  let east = -Infinity
  let south = Infinity
  let north = -Infinity
  for (const [lng, lat] of points) {
    west = Math.min(west, lng)
    east = Math.max(east, lng)
    south = Math.min(south, lat)
    north = Math.max(north, lat)
  }
  // At least a few degrees across, so one place shows its region, not a blank square.
  const width = Math.max(east - west, 4) * 1.3
  const height = Math.max(north - south, 2) * 1.3
  const zoom = Math.min(WORLD.width / width, WORLD.height / height)
  return settle({ zoom, cx: (west + east) / 2, cy: -(south + north) / 2 })
}
