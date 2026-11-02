import { h, langTag, shown } from '../../kit/src/ui'
import { TEXT } from './text'
import { cluster, type Cluster } from './cluster'
import { thinLines, type Feature, type Geometry } from './geo'
import { circleOutline, continuous, distance, distanceText } from './area'
import {
  boundsOf,
  clampCenter,
  fitView,
  MAX_LAT,
  minZoomFor,
  project,
  TILE,
  unproject,
  unwrapLine,
  worldSize,
  wrapLng,
  type Bounds,
  type LngLat,
  type Pixel,
  type Size,
} from './projection'

/**
 * Map redesign (spec plugin-tabs-redesign §2.5): the map itself, with no library — Web Mercator
 * tiles as images (only an administrator's tile server may serve them: the frame's policy), the
 * shapes and places as SVG in the accent, places close together as one circle with their count.
 * Drag, wheel, pinch, double click and the keyboard move it; the page asks it to fit, zoom and show.
 */

export const MAX_ZOOM = 19
/** The closest a fit goes: one place shows its street, not its doorstep. */
export const FIT_MAX_ZOOM = 15
const RADIUS = 28
const PADDING = 48
/** A frame not laid out yet (a hidden tab) is drawn at this size until it is. */
const FALLBACK: Size = { width: 800, height: 480 }

/** What a click on the map chose: one shape's item, several at one spot, or nothing. */
export type Pick = { kind: 'one'; item: number; at: LngLat } | { kind: 'many'; items: number[]; at: LngLat }

export interface MapText {
  cluster(count: string): string
  point(item: number): string
  compass: { n: string; s: string; e: string; w: string }
  locale: string
}

/** Map 1.2 (research 2026-10-28): an area drawn to filter by. */
export type DrawKind = 'polygon' | 'circle'
export type Drawn = { kind: 'polygon'; ring: LngLat[] } | { kind: 'circle'; center: LngLat; radius: number }

export interface MapView {
  setItems(features: Feature[]): void
  /**
   * Draws an area: a polygon corner by corner (a click on its first corner, a double click or Enter
   * ends it), or a circle (its centre, then its edge). Space puts a corner (or the circle's centre,
   * then its edge) at the map's centre, for the keyboard. `done` gets the area, or null when the
   * drawing is given up (Escape, or another drawing).
   */
  draw(kind: DrawKind, done: (area: Drawn | null) => void): void
  stopDrawing(): void
  /** The area in view: west to east may pass ±180 (as far as the map was moved). */
  viewBounds(): { west: number; east: number; south: number; north: number }
  fit(): void
  zoomBy(delta: number): void
  /** Shows one item: zoomed until it stands apart, then picked. */
  show(item: number): void
  select(item: number | null): void
  zoom(): number
  limits(): { min: number; max: number }
  /** Where a place is in the map's element, on the copy of the world nearest the middle. */
  toScreen(p: LngLat): Pixel
  /** Labels again (a language change). */
  refresh(): void
}

interface Mark extends LngLat {
  item: number
}
interface Shape {
  item: number
  lines: number[][][]
  area: boolean
  bounds: Bounds
}

const SVG = 'http://www.w3.org/2000/svg'
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) {
  const el = document.createElementNS(SVG, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}
/** What a mark says on hover. */
function tip(el: SVGElement, label: string): SVGElement {
  const title = svg('title')
  title.textContent = label
  el.prepend(title)
  return el
}

/** A tile's address from the administrator's template: {s} a subdomain, {z}/{x}/{y} the tile, {-y} counted from the south, {r} nothing. */
export function tileSrc(template: string, z: number, x: number, y: number): string {
  return template.replace(/\{(s|z|x|y|-y|r)\}/g, (_, k: string) =>
    k === 's'
      ? 'abc'[Math.abs(x + y) % 3]!
      : k === 'z'
        ? String(z)
        : k === 'x'
          ? String(x)
          : k === 'y'
            ? String(y)
            : k === '-y'
              ? String(2 ** z - 1 - y)
              : '',
  )
}

/** Graticule spacings in degrees, each with the coarser one that carries labels. */
const GRID: Array<[number, number]> = [
  [30, 90],
  [10, 30],
  [5, 10],
  [2, 10],
  [1, 5],
  [0.5, 1],
  [0.25, 1],
  [0.1, 0.5],
  [0.05, 0.1],
  [0.025, 0.1],
  [0.01, 0.05],
  [0.005, 0.01],
  [0.0025, 0.01],
  [0.001, 0.005],
  [0.0005, 0.001],
]
const multipleOf = (v: number, step: number) => Math.abs(v / step - Math.round(v / step)) < 1e-6

function degrees(v: number, positive: string, negative: string): string {
  const n = Number(v.toFixed(6))
  if (n === 0 || Math.abs(n) === 180) return `${Math.abs(n)}°`
  return `${Math.abs(n)}°${n > 0 ? positive : negative}`
}

/** The circle's size by how many it holds. */
const radiusOf = (n: number) => (n < 10 ? 13 : n < 100 ? 16 : n < 1000 ? 19 : 22)

export function createMap(
  el: HTMLElement,
  o: {
    tiles: { url: string; credit: string } | null
    text: () => MapText
    onPick: (pick: Pick | null) => void
    onView: () => void
    /** Pixels at the bottom a note covers: a fit keeps the places above them. */
    inset?: () => number
  },
): MapView {
  el.classList.add('gm-map', o.tiles ? 'gm-tiled' : 'gm-plain')
  el.tabIndex = 0
  el.setAttribute('role', 'region')
  const tileLayer = h('div', { class: 'gm-tiles', attrs: { 'aria-hidden': 'true' } })
  // Drawn for the pointer: the page's table of shapes offers the same by keyboard and to readers.
  const root = svg('svg', { class: 'gm-svg', width: '100%', height: '100%', 'aria-hidden': 'true' })
  const grid = svg('g', { class: 'gm-grid', 'aria-hidden': 'true' })
  const content = svg('g', { class: 'gm-content' })
  const shapeLayer = svg('g', { class: 'gm-shapes' })
  const markLayer = svg('g', { class: 'gm-marks' })
  content.append(shapeLayer, markLayer)
  // The area being drawn, in the element's own pixels: drawn again on every move.
  const sketchLayer = svg('g', { class: 'gm-sketch' })
  root.append(grid, content, sketchLayer)
  el.append(tileLayer, root)
  if (o.tiles) el.append(h('div', { class: 'gm-credit', text: o.tiles.credit }))

  let marks: Mark[] = []
  let shapes: Shape[] = []
  let extent: Bounds | null = null
  let center: LngLat = { lng: 0, lat: 20 }
  let zoom = 2
  let touched = false
  let selected: number | null = null
  let sketch: {
    kind: DrawKind
    points: LngLat[]
    hover: LngLat | null
    done: (area: Drawn | null) => void
  } | null = null
  /** When a drawing last ended: the double click that ended it zooms nothing (review 2026-10-28). */
  let finishedAt = -Infinity
  let clusters: { zoom: number; list: Cluster[] } | null = null
  /** Where the content was drawn from: its world-pixel origin, so SVG numbers stay small at zoom 19. */
  let drawn: { zoom: number; cx: number; cy: number; ox: number; oy: number } | null = null

  const size = (): Size =>
    el.clientWidth > 0 && el.clientHeight > 0 ? { width: el.clientWidth, height: el.clientHeight } : FALLBACK
  const limits = () => ({ min: minZoomFor(size()), max: MAX_ZOOM })
  const clampZoom = (z: number) => Math.max(limits().min, Math.min(MAX_ZOOM, z))
  const origin = () => {
    const s = size()
    const c = project(center, zoom)
    return { x: c.x - s.width / 2, y: c.y - s.height / 2 }
  }
  const clustersNow = () => {
    if (!clusters || clusters.zoom !== zoom) clusters = { zoom, list: cluster(marks, zoom, RADIUS) }
    return clusters.list
  }

  // ---- drawing
  const tiles = new Map<string, HTMLImageElement>()
  function drawTiles(ox: number, oy: number, s: Size): void {
    const tz = Math.max(0, Math.min(MAX_ZOOM, Math.round(zoom)))
    const ts = TILE * 2 ** (zoom - tz)
    const n = 2 ** tz
    const x0 = Math.floor(ox / ts)
    const x1 = Math.floor((ox + s.width) / ts)
    const y0 = Math.max(0, Math.floor(oy / ts))
    const y1 = Math.min(n - 1, Math.floor((oy + s.height) / ts))
    const keep = new Set<string>()
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 600)
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const key = `${tz}/${x}/${y}`
          keep.add(key)
          let img = tiles.get(key)
          if (!img) {
            img = document.createElement('img')
            img.className = 'gm-tile'
            img.alt = ''
            img.decoding = 'async'
            img.draggable = false
            img.referrerPolicy = 'no-referrer'
            const tile = img
            tile.addEventListener('load', () => tile.classList.add('gm-loaded'))
            tile.addEventListener('error', () => tile.classList.add('gm-failed'))
            // Wrapped round the world: the tile east of the last is the first again.
            img.src = tileSrc(o.tiles!.url, tz, ((x % n) + n) % n, y)
            tiles.set(key, img)
            tileLayer.append(img)
          }
          img.style.left = `${x * ts - ox}px`
          img.style.top = `${y * ts - oy}px`
          img.style.width = img.style.height = `${ts + 0.5}px`
        }
    for (const [key, img] of tiles)
      if (!keep.has(key)) {
        img.remove()
        tiles.delete(key)
      }
  }

  function drawGrid(ox: number, oy: number, s: Size): void {
    const world = worldSize(zoom)
    const perDegree = world / 360
    let [minor, major] = GRID[0]!
    for (const [m, M] of GRID) if (m * perDegree >= 56) [minor, major] = [m, M]
    const nodes: SVGElement[] = []
    const labels: SVGElement[] = []
    const top = Math.max(0, -oy)
    const bottom = Math.min(s.height, world - oy)
    const west = ox / perDegree - 180
    const east = (ox + s.width) / perDegree - 180
    const { compass } = o.text()
    // Every line carries its label when they are far enough apart; else the coarser ones only.
    const labelled = (v: number) => multipleOf(v, minor * perDegree >= 90 ? minor : major)
    for (let i = Math.ceil(west / minor); i * minor <= east; i++) {
      const lng = i * minor
      const x = ((lng + 180) * perDegree - ox).toFixed(1)
      const isMajor = multipleOf(lng, major)
      const zero = multipleOf(lng, 180) && multipleOf(lng / 180, 2)
      nodes.push(
        svg('line', {
          class: `gm-grid-line${isMajor ? ' gm-grid-major' : ''}${zero ? ' gm-grid-zero' : ''}`,
          x1: x,
          x2: x,
          y1: top,
          y2: bottom,
        }),
      )
      if (labelled(lng)) {
        const label = svg('text', { class: 'gm-grid-label', x: Number(x) + 4, y: top + 14 })
        label.textContent = degrees(wrapLng(Number(lng.toFixed(6))), compass.e, compass.w)
        labels.push(label)
      }
    }
    const north = unproject({ x: 0, y: oy + top }, zoom).lat
    const south = unproject({ x: 0, y: oy + bottom }, zoom).lat
    for (let i = Math.ceil(south / minor); i * minor <= north; i++) {
      const lat = i * minor
      if (Math.abs(lat) > 85) continue
      const y = (project({ lng: 0, lat }, zoom).y - oy).toFixed(1)
      const isMajor = multipleOf(lat, major)
      nodes.push(
        svg('line', {
          class: `gm-grid-line${isMajor ? ' gm-grid-major' : ''}${Math.abs(lat) < 1e-9 ? ' gm-grid-zero' : ''}`,
          x1: 0,
          x2: s.width,
          y1: y,
          y2: y,
        }),
      )
      if (labelled(lat) && Number(y) > top + 22) {
        const label = svg('text', { class: 'gm-grid-label', x: 6, y: Number(y) - 4 })
        label.textContent = degrees(lat, compass.n, compass.s)
        labels.push(label)
      }
    }
    grid.replaceChildren(...nodes, ...labels)
  }

  function drawContent(s: Size): void {
    const world = worldSize(zoom)
    const c = project(center, zoom)
    const ox = c.x - s.width / 2
    const oy = c.y - s.height / 2
    drawn = { zoom, cx: c.x, cy: c.y, ox, oy }
    // The copy of the world nearest the middle; only what is within a view's width around it.
    const near = (x: number) => Math.round((c.x - x) / world) * world
    const left = ox - s.width
    const right = ox + 2 * s.width
    const up = oy - s.height
    const down = oy + 2 * s.height
    const text = o.text()
    const shapeNodes: SVGElement[] = []
    for (const shape of shapes) {
      const nw = project({ lng: shape.bounds.west, lat: shape.bounds.north }, zoom)
      const se = project({ lng: shape.bounds.east, lat: shape.bounds.south }, zoom)
      const shift = near((nw.x + se.x) / 2)
      if (se.x + shift < left || nw.x + shift > right || se.y < up || nw.y > down) continue
      const d = shape.lines
        .map(
          (line) =>
            line
              .map(([lng, lat], i) => {
                const p = project({ lng: lng!, lat: lat! }, zoom)
                return `${i ? 'L' : 'M'}${(p.x + shift - ox).toFixed(1)} ${(p.y - oy).toFixed(1)}`
              })
              .join('') + (shape.area ? 'Z' : ''),
        )
        .join('')
      const on = selected === shape.item ? ' gm-selected' : ''
      const label = text.point(shape.item)
      if (shape.area)
        shapeNodes.push(tip(svg('path', { class: `gm-area${on}`, d, 'data-item': shape.item }), label))
      else {
        // A line is hard to hit at its drawn width: a wider, invisible one takes the clicks.
        const g = svg('g', { class: `gm-line${on}`, 'data-item': shape.item })
        g.append(svg('path', { class: 'gm-line-hit', d }), svg('path', { class: 'gm-line-stroke', d }))
        shapeNodes.push(tip(g, label))
      }
    }
    shapeLayer.replaceChildren(...shapeNodes)
    const markNodes: SVGElement[] = []
    clustersNow().forEach((cl, index) => {
      const p = project(cl, zoom)
      const x = p.x + near(p.x)
      if (x < left || x > right || p.y < up || p.y > down) return
      const items = [...new Set(cl.members.map((m) => marks[m]!.item))]
      const at = `translate(${(x - ox).toFixed(1)} ${(p.y - oy).toFixed(1)})`
      const on = selected !== null && items.includes(selected) ? ' gm-selected' : ''
      if (cl.members.length === 1) {
        const g = svg('g', {
          class: `gm-marker${on}`,
          transform: at,
          'data-cluster': index,
          'data-items': items[0]!,
        })
        g.append(svg('circle', { class: 'gm-hit', r: 12 }), svg('circle', { class: 'gm-dot', r: 6.5 }))
        markNodes.push(tip(g, text.point(items[0]!)))
        return
      }
      const r = radiusOf(cl.members.length)
      const count = new Intl.NumberFormat(langTag(shown(TEXT, text.locale)), {
        notation: cl.members.length >= 1000 ? 'compact' : 'standard',
        maximumFractionDigits: 1,
      }).format(cl.members.length)
      const g = svg('g', {
        class: `gm-cluster${on}`,
        transform: at,
        'data-cluster': index,
      })
      const label = svg('text', { class: 'gm-count', 'text-anchor': 'middle', dy: '0.35em' })
      label.textContent = count
      g.append(svg('circle', { class: 'gm-halo', r: r + 5 }), svg('circle', { class: 'gm-ring', r }), label)
      markNodes.push(tip(g, text.cluster(count)))
    })
    markLayer.replaceChildren(...markNodes)
  }

  function render(force = false): void {
    const s = size()
    zoom = clampZoom(zoom)
    center = clampCenter(center, zoom, s)
    const c = project(center, zoom)
    const ox = c.x - s.width / 2
    const oy = c.y - s.height / 2
    if (o.tiles) drawTiles(ox, oy, s)
    else drawGrid(ox, oy, s)
    if (
      force ||
      !drawn ||
      drawn.zoom !== zoom ||
      Math.abs(c.x - drawn.cx) > s.width / 2 ||
      Math.abs(c.y - drawn.cy) > s.height / 2
    )
      drawContent(s)
    content.setAttribute(
      'transform',
      `translate(${(drawn!.ox - ox).toFixed(1)} ${(drawn!.oy - oy).toFixed(1)})`,
    )
    el.dataset.zoom = String(zoom)
    drawSketch()
    o.onView()
  }

  // ---- drawing an area
  /** A place where the pointer is, on the copy of the world under it. */
  const placeAt = (p: Pixel): LngLat => {
    const start = origin()
    return unproject({ x: start.x + p.x, y: start.y + p.y }, zoom)
  }
  /** Where a place is in the element: `near` keeps a drawing on one copy of the world. */
  const screenOf = (p: LngLat, near?: number): Pixel => {
    const start = origin()
    const at = project(p, zoom)
    let x = at.x - start.x
    if (near !== undefined) x += Math.round((near - x) / worldSize(zoom)) * worldSize(zoom)
    return { x, y: at.y - start.y }
  }
  function drawSketch(): void {
    if (!sketch) return void sketchLayer.replaceChildren()
    const nodes: SVGElement[] = []
    const pts: Pixel[] = []
    for (const p of sketch.points) pts.push(screenOf(p, pts.at(-1)?.x ?? size().width / 2))
    const hover = sketch.hover ? screenOf(sketch.hover, pts.at(-1)?.x ?? size().width / 2) : null
    const f = (n: number) => n.toFixed(1)
    // The map's centre, where Space puts the next corner.
    const s = size()
    nodes.push(
      svg('path', {
        class: 'gm-sketch-aim',
        d: `M${f(s.width / 2 - 7)} ${f(s.height / 2)}h14M${f(s.width / 2)} ${f(s.height / 2 - 7)}v14`,
      }),
    )
    if (sketch.kind === 'polygon') {
      const line = [...pts, ...(hover ? [hover] : [])]
      if (line.length > 1)
        nodes.push(
          svg('path', {
            class: 'gm-sketch-area',
            d: `${line.map((q, i) => `${i ? 'L' : 'M'}${f(q.x)} ${f(q.y)}`).join('')}${pts.length > 2 ? 'Z' : ''}`,
          }),
        )
      pts.forEach((q, i) =>
        nodes.push(
          svg('circle', {
            class: i ? 'gm-sketch-corner' : 'gm-sketch-first',
            cx: f(q.x),
            cy: f(q.y),
            r: i ? 4 : 6,
          }),
        ),
      )
    } else if (pts[0]) {
      const c = pts[0]
      nodes.push(svg('circle', { class: 'gm-sketch-corner', cx: f(c.x), cy: f(c.y), r: 4 }))
      if (hover) {
        // As the filter reads it: the places that far from the centre on the globe, not a round of pixels.
        const center = sketch.points[0]!
        const radius = distance(center, sketch.hover!)
        // Around one pole, the outline spans every longitude: closed along the map's edge past it.
        // Around both, it is a small round about the opposite place: the map less that round.
        const poles = [90, -90].filter((lat) => distance(center, { lng: center.lng, lat }) < radius)
        const round = continuous(circleOutline(center, radius))
        const ring =
          poles.length === 1
            ? [
                ...round,
                { lng: round.at(-1)!.lng, lat: Math.sign(poles[0]!) * MAX_LAT },
                { lng: round[0]!.lng, lat: Math.sign(poles[0]!) * MAX_LAT },
              ]
            : round
        const outline: Pixel[] = []
        for (const q of ring) outline.push(screenOf(q, outline.at(-1)?.x ?? c.x))
        const path = `${outline.map((q, i) => `${i ? 'L' : 'M'}${f(q.x)} ${f(q.y)}`).join('')}Z`
        nodes.push(
          svg('path', {
            class: 'gm-sketch-area',
            ...(poles.length === 2
              ? { d: `M0 0H${f(s.width)}V${f(s.height)}H0Z${path}`, 'fill-rule': 'evenodd' }
              : { d: path }),
          }),
        )
        const label = svg('text', { class: 'gm-sketch-label', x: f(hover.x + 8), y: f(hover.y - 8) })
        label.textContent = distanceText(distance(sketch.points[0]!, sketch.hover!), o.text().locale)
        nodes.push(label)
      }
    }
    sketchLayer.replaceChildren(...nodes)
  }
  /**
   * The drawing ends. By the pointer (a click on the first corner, the circle's edge, a double
   * click), the clicks and double click that come right after are its own, never the map's.
   */
  function finishSketch(area: Drawn | null, byPointer = false): void {
    const done = sketch?.done
    sketch = null
    if (byPointer) finishedAt = performance.now()
    el.classList.remove('gm-drawing')
    drawSketch()
    done?.(area)
  }
  function sketchClick(p: Pixel, byPointer = true): void {
    if (!sketch) return
    const points = sketch.points
    /** Within 10 pixels of a corner: a click there adds none (the second click of a double click). */
    const near = (q: LngLat) => {
      const at = screenOf(q, p.x)
      return Math.hypot(at.x - p.x, at.y - p.y) <= 10
    }
    if (sketch.kind === 'circle') {
      if (!points.length) {
        points.push(placeAt(p))
        return drawSketch()
      }
      if (near(points[0]!)) return
      return finishSketch(
        { kind: 'circle', center: points[0]!, radius: distance(points[0]!, placeAt(p)) },
        byPointer,
      )
    }
    // A click on the first corner closes the polygon, of three corners at least.
    if (points.length >= 3 && near(points[0]!))
      return finishSketch({ kind: 'polygon', ring: [...points] }, byPointer)
    // Where the last corner is: the second click of a double click, or a slip.
    if (points.length && near(points.at(-1)!)) return
    points.push(placeAt(p))
    drawSketch()
  }
  el.addEventListener('pointermove', (e) => {
    // While drawing, the pointer's place shows the next corner (or the circle's edge).
    if (!sketch || pointers.size) return
    sketch.hover = placeAt(pointer(e))
    drawSketch()
  })

  /**
   * The view showing the bounds above the inset a note covers: fitted in the part above it, the
   * middle of the view half the inset lower. `middle` is the bounds' own middle.
   */
  function fitted(bounds: Bounds, padding: number, minZoom: number, maxZoom: number) {
    const s = size()
    const inset = Math.max(0, Math.min(o.inset?.() ?? 0, s.height / 3))
    const v = fitView(bounds, { width: s.width, height: s.height - inset }, { padding, minZoom, maxZoom })
    const c = project(v.center, v.zoom)
    return { zoom: v.zoom, center: unproject({ x: c.x, y: c.y + inset / 2 }, v.zoom), middle: v.center }
  }

  function setView(at: LngLat, z: number): void {
    zoom = clampZoom(z)
    center = at
    render()
  }

  /** Zooms keeping the place under `anchor` (a pixel of the element) where it is. */
  function zoomAround(anchor: Pixel, z: number): void {
    const next = clampZoom(z)
    if (next === zoom) return
    const start = origin()
    const k = 2 ** (next - zoom)
    const s = size()
    const c = {
      x: (start.x + anchor.x) * k - anchor.x + s.width / 2,
      y: (start.y + anchor.y) * k - anchor.y + s.height / 2,
    }
    zoom = next
    center = unproject(c, next)
    touched = true
    render()
  }

  function panBy(dx: number, dy: number): void {
    const c = project(center, zoom)
    center = unproject({ x: c.x + dx, y: c.y + dy }, zoom)
    touched = true
    render()
  }

  // ---- picking
  const pointer = (e: MouseEvent): Pixel => {
    const r = el.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  function pickCluster(index: number): void {
    const cl = clustersNow()[index]
    if (!cl) return
    const items = [...new Set(cl.members.map((m) => marks[m]!.item))]
    if (cl.members.length === 1) return o.onPick({ kind: 'one', item: items[0]!, at: cl })
    const b = boundsOf(cl.members.map((m) => marks[m]!))!
    const apart = b.west !== b.east || b.south !== b.north
    if (!apart || zoom >= MAX_ZOOM) return o.onPick({ kind: 'many', items, at: cl })
    // Zoomed until its places fit apart: at least one step in.
    const view = fitted(b, 64, zoom + 1, MAX_ZOOM)
    touched = true
    o.onPick(null)
    setView(view.center, view.zoom)
  }

  let dragged = false
  root.addEventListener('click', (e) => {
    if (dragged) {
      dragged = false
      return
    }
    if (sketch) return sketchClick(pointer(e))
    // The click that came with the end of a drawing picks nothing.
    if (performance.now() - finishedAt < 600) return
    const target = e.target as Element
    const marker = target.closest('[data-cluster]')
    if (marker) return pickCluster(Number(marker.getAttribute('data-cluster')))
    const shape = target.closest('[data-item]')
    if (shape) {
      const p = pointer(e)
      const start = origin()
      const at = unproject({ x: start.x + p.x, y: start.y + p.y }, zoom)
      return o.onPick({ kind: 'one', item: Number(shape.getAttribute('data-item')), at })
    }
    o.onPick(null)
  })

  // ---- moving: drag and pinch (pointers), wheel, double click, keys
  const pointers = new Map<number, Pixel>()
  let drag: { start: Pixel; origin: Pixel; moved: boolean } | null = null
  let pinch: { distance: number; zoom: number } | null = null
  const spread = () => {
    const [a, b] = [...pointers.values()]
    return {
      distance: Math.hypot(a!.x - b!.x, a!.y - b!.y),
      middle: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 },
    }
  }
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    dragged = false
    pointers.set(e.pointerId, pointer(e))
    if (pointers.size === 1) {
      const c = project(center, zoom)
      drag = { start: pointer(e), origin: c, moved: false }
    } else if (pointers.size === 2) {
      drag = null
      pinch = { distance: spread().distance, zoom }
    }
  })
  el.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return
    pointers.set(e.pointerId, pointer(e))
    if (pinch && pointers.size === 2) {
      const { distance, middle } = spread()
      if (pinch.distance > 0) zoomAround(middle, pinch.zoom + Math.log2(distance / pinch.distance))
      return
    }
    if (!drag) return
    const p = pointer(e)
    const dx = p.x - drag.start.x
    const dy = p.y - drag.start.y
    if (!drag.moved && Math.hypot(dx, dy) < 4) return
    if (!drag.moved) {
      drag.moved = true
      el.classList.add('gm-dragging')
      // Captured only once it is a drag: a click keeps its target (the circle under it).
      try {
        el.setPointerCapture(e.pointerId)
      } catch {
        /* a pointer that is gone */
      }
    }
    center = unproject({ x: drag.origin.x - dx, y: drag.origin.y - dy }, zoom)
    touched = true
    render()
  })
  const release = (e: PointerEvent) => {
    pointers.delete(e.pointerId)
    if (drag?.moved || pinch) dragged = true
    if (pointers.size < 2) pinch = null
    drag = null
    el.classList.remove('gm-dragging')
  }
  el.addEventListener('pointerup', release)
  el.addEventListener('pointercancel', release)

  let wheel = 0
  let wheelAt: Pixel = { x: 0, y: 0 }
  let wheelQueued = false
  const later = (fn: () => void) =>
    typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16)
  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      wheel += e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1)
      wheelAt = pointer(e)
      if (wheelQueued) return
      wheelQueued = true
      later(() => {
        wheelQueued = false
        const dz = Math.max(-1, Math.min(1, -wheel / 120))
        wheel = 0
        zoomAround(wheelAt, zoom + dz)
      })
    },
    { passive: false },
  )
  el.addEventListener('dblclick', (e) => {
    // Drawing a polygon: a double click ends it (its two clicks were one corner, said twice); the
    // double click that ended a drawing (on its first corner, its circle's edge) zooms nothing.
    if (sketch || performance.now() - finishedAt < 600) {
      e.preventDefault()
      if (sketch?.kind === 'polygon' && sketch.points.length >= 3)
        finishSketch({ kind: 'polygon', ring: [...sketch.points] }, true)
      return
    }
    if ((e.target as Element).closest('[data-cluster],[data-item]')) return
    e.preventDefault()
    zoomAround(pointer(e), zoom + (e.shiftKey ? -1 : 1))
  })
  el.addEventListener('keydown', (e) => {
    if (sketch && (e.key === 'Escape' || e.key === 'Enter' || e.key === 'Backspace' || e.key === ' ')) {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') return finishSketch(null)
      if (e.key === ' ') {
        const s = size()
        return sketchClick({ x: s.width / 2, y: s.height / 2 }, false)
      }
      if (e.key === 'Backspace') {
        sketch.points.pop()
        return drawSketch()
      }
      if (sketch.kind === 'polygon' && sketch.points.length >= 3)
        finishSketch({ kind: 'polygon', ring: [...sketch.points] })
      return
    }
    const s = size()
    const middle = { x: s.width / 2, y: s.height / 2 }
    const step = 100
    const moves: Record<string, () => void> = {
      ArrowLeft: () => panBy(-step, 0),
      ArrowRight: () => panBy(step, 0),
      ArrowUp: () => panBy(0, -step),
      ArrowDown: () => panBy(0, step),
      '+': () => zoomAround(middle, Math.floor(zoom) + 1),
      '=': () => zoomAround(middle, Math.floor(zoom) + 1),
      '-': () => zoomAround(middle, Math.ceil(zoom) - 1),
    }
    const move = moves[e.key]
    if (!move || e.ctrlKey || e.metaKey || e.altKey) return
    e.preventDefault()
    move()
    // Drawing by keyboard: the next corner is where the map's centre is now.
    if (sketch) {
      sketch.hover = placeAt(middle)
      drawSketch()
    }
  })

  // A frame laid out late (a tab shown after it loaded) fits again, unless the user moved the map.
  if (typeof ResizeObserver === 'function')
    new ResizeObserver(() => (touched ? render() : view.fit())).observe(el)

  const view: MapView = {
    setItems(features) {
      marks = []
      shapes = []
      const add = (g: Geometry, item: number) => {
        const c = g.coordinates as never
        if (g.type === 'Point') marks.push({ item, lng: (c as number[])[0]!, lat: (c as number[])[1]! })
        else if (g.type === 'MultiPoint')
          for (const [lng, lat] of c as number[][]) marks.push({ item, lng: lng!, lat: lat! })
        else if (g.type === 'LineString') addShape(item, [c], false)
        else if (g.type === 'MultiLineString') addShape(item, c, false)
        else if (g.type === 'Polygon') addShape(item, c, true)
        else if (g.type === 'MultiPolygon') addShape(item, (c as number[][][][]).flat(), true)
        else if (g.type === 'GeometryCollection') for (const part of g.geometries ?? []) add(part, item)
      }
      const addShape = (item: number, raw: number[][][], area: boolean) => {
        // Every part on the same copy of the world as the first (a shape across the antimeridian).
        const first = raw[0]?.[0]?.[0] ?? 0
        const lines = raw.map((line) => {
          const unwrapped = unwrapLine(line)
          const shift = Math.round((first - unwrapped[0]![0]!) / 360) * 360
          return unwrapped.map(([lng, lat]) => [lng! + shift, lat!])
        })
        // A loop, not Math.min(...all): a spread of a few hundred thousand overflows the stack.
        const bounds = { west: Infinity, east: -Infinity, south: Infinity, north: -Infinity }
        for (const line of lines)
          for (const [lng, lat] of line) {
            bounds.west = Math.min(bounds.west, lng!)
            bounds.east = Math.max(bounds.east, lng!)
            bounds.south = Math.min(bounds.south, lat!)
            bounds.north = Math.max(bounds.north, lat!)
          }
        shapes.push({ item, lines: thinLines(lines), area, bounds })
      }
      features.forEach((f, item) => add(f.geometry, item))
      extent = boundsOf([
        ...marks,
        ...shapes.flatMap((s) => [
          { lng: s.bounds.west, lat: s.bounds.south },
          { lng: s.bounds.east, lat: s.bounds.north },
        ]),
      ])
      clusters = null
      selected = null
      render(true)
    },
    fit() {
      const s = size()
      touched = false
      if (!extent) {
        zoom = clampZoom(2)
        center = { lng: 0, lat: 20 }
        return render(true)
      }
      const v = fitted(extent, PADDING, minZoomFor(s), FIT_MAX_ZOOM)
      zoom = v.zoom
      center = v.center
      render(true)
    },
    zoomBy(delta) {
      const s = size()
      const whole = delta > 0 ? Math.floor(zoom) + delta : Math.ceil(zoom) + delta
      zoomAround({ x: s.width / 2, y: s.height / 2 }, whole)
    },
    show(item) {
      const own = marks.filter((m) => m.item === item)
      if (own.length) {
        const index = marks.indexOf(own[0]!)
        // The least zoom (from where the map is) at which this place stands alone.
        let z = Math.max(zoom, 3)
        while (
          z < FIT_MAX_ZOOM &&
          cluster(marks, z, RADIUS).some((c) => c.members.length > 1 && c.members.includes(index))
        )
          z = Math.min(FIT_MAX_ZOOM, Math.floor(z) + 1)
        selected = item
        touched = true
        zoom = clampZoom(z)
        center = own[0]!
        render(true)
        return o.onPick({ kind: 'one', item, at: own[0]! })
      }
      const shape = shapes.find((s) => s.item === item)
      if (!shape) return
      const v = fitted(shape.bounds, PADDING, limits().min, FIT_MAX_ZOOM)
      selected = item
      touched = true
      zoom = v.zoom
      center = v.center
      render(true)
      o.onPick({ kind: 'one', item, at: v.middle })
    },
    select(item) {
      if (selected === item) return
      selected = item
      render(true)
    },
    zoom: () => zoom,
    limits,
    toScreen(p) {
      const s = size()
      const start = origin()
      const at = project(p, zoom)
      const world = worldSize(zoom)
      let x = at.x - start.x
      x += Math.round((s.width / 2 - x) / world) * world
      return { x, y: at.y - start.y }
    },
    refresh: () => render(true),
    draw(kind, done) {
      if (sketch) finishSketch(null)
      sketch = { kind, points: [], hover: null, done }
      el.classList.add('gm-drawing')
      drawSketch()
    },
    stopDrawing() {
      if (sketch) finishSketch(null)
    },
    viewBounds() {
      const s = size()
      const start = origin()
      const nw = unproject(start, zoom)
      const se = unproject({ x: start.x + s.width, y: start.y + s.height }, zoom)
      return { west: nw.lng, east: se.lng, south: se.lat, north: nw.lat }
    },
  }
  render(true)
  return view
}
