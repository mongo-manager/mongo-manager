// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { h } from '../../kit/src/ui'
import { fitText, spreadIndices, textWidth } from './model'
import { arcPath, linePath, niceTicks, scaleLinear } from './svg'

/**
 * Charts, redesigned (spec plugin-tabs-redesign §2.3): the charts as SVG — gridlines, tick and
 * value labels, the accent and the colours taken from it — drawn to the frame's width. Every text
 * is a text node; each mark hands its words to the page's tooltip.
 */
export interface Paint {
  width: number
  /** The parts' colours, the accent first (model.paletteFrom). */
  palette: string[]
  /** "Other", in a grey that is no part's colour. */
  neutral: string
  /** A mark's words, for the tooltip. */
  tip(el: Element, lines: string[]): void
  num(n: number): string
  compact(n: number): string
  /** A share (0–1) as a percent, in the user's language. */
  pct(share: number): string
}
export interface Part {
  label: string
  value: number
  other?: boolean
  tip: string[]
}

const NS = 'http://www.w3.org/2000/svg'
function s<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number>,
  parent?: Element,
  text?: string,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, name)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  if (text !== undefined) node.textContent = text
  parent?.append(node)
  return node
}

function canvas(host: HTMLElement, width: number, height: number, label: string): SVGSVGElement {
  const root = s('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img', 'aria-label': label })
  host.replaceChildren(root)
  return root
}

/** About how many ticks fit a length, each with room for its label. */
const tickCount = (length: number, room: number) => Math.max(2, Math.min(8, Math.floor(length / room)))

/** Horizontal gridlines with their values on the left. */
function yGrid(
  root: SVGSVGElement,
  ticks: number[],
  y: (v: number) => number,
  left: number,
  right: number,
  p: Paint,
) {
  for (const t of ticks) {
    s('line', { x1: left, x2: right, y1: y(t), y2: y(t), class: t === 0 ? 'ch-axis' : 'ch-grid' }, root)
    s('text', { x: left - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'ch-tick' }, root, p.compact(t))
  }
}
const yRoom = (ticks: number[], p: Paint) => Math.max(...ticks.map((t) => textWidth(p.compact(t), 11))) + 14

/** Horizontal bars: a label, the bar from zero and its value at the tip, gridlines under them. */
export function bars(host: HTMLElement, parts: Part[], p: Paint, label: string): void {
  const W = p.width
  const [rowH, barH, top, axisH] = [30, 18, 6, 26]
  const longest = Math.max(...parts.map((m) => textWidth(m.label, 12)))
  const labelW = Math.min(Math.max(longest + 14, 56), Math.round(W * 0.36))
  const valueW = Math.max(...parts.map((m) => textWidth(p.num(m.value), 11.5))) + 10
  const values = parts.map((m) => m.value)
  const min = Math.min(0, ...values)
  const left = labelW + (min < 0 ? valueW : 0)
  const right = Math.max(left + 40, W - valueW - 4)
  const ticks = niceTicks(min, Math.max(0, ...values), tickCount(right - left, 90))
  const x = scaleLinear([ticks[0]!, ticks.at(-1)!], [left, right])
  const bottom = top + parts.length * rowH
  const root = canvas(host, W, bottom + axisH, label)
  for (const t of ticks) {
    s('line', { x1: x(t), x2: x(t), y1: top, y2: bottom, class: t === 0 ? 'ch-axis' : 'ch-grid' }, root)
    s('text', { x: x(t), y: bottom + 17, 'text-anchor': 'middle', class: 'ch-tick' }, root, p.compact(t))
  }
  parts.forEach((m, i) => {
    const y = top + i * rowH
    const g = s('g', { class: 'ch-mark' }, root)
    s('rect', { x: 0, y, width: W, height: rowH, class: 'ch-hit' }, g)
    s(
      'text',
      {
        x: labelW - 10,
        y: y + rowH / 2 + 4,
        'text-anchor': 'end',
        class: m.other ? 'ch-label ch-other' : 'ch-label',
      },
      g,
      fitText(m.label, labelW - 14),
    )
    const [a, b] = [x(0), x(m.value)]
    s(
      'rect',
      {
        x: Math.min(a, b),
        y: y + (rowH - barH) / 2,
        width: Math.max(1, Math.abs(b - a)),
        height: barH,
        rx: 3,
        fill: m.other ? p.neutral : p.palette[0]!,
        class: 'ch-bar',
      },
      g,
    )
    const negative = m.value < 0
    s(
      'text',
      {
        x: negative ? b - 6 : b + 6,
        y: y + rowH / 2 + 4,
        'text-anchor': negative ? 'end' : 'start',
        class: 'ch-value',
      },
      g,
      p.num(m.value),
    )
    p.tip(g, m.tip)
  })
}

/** A donut: parts of a whole in the palette's order, the total inside, a legend beside it. */
export function donut(
  host: HTMLElement,
  parts: Part[],
  p: Paint,
  label: string,
  total: string,
  sub: string,
): void {
  const size = 220
  const root = s('svg', {
    viewBox: `0 0 ${size} ${size}`,
    height: size,
    width: size,
    role: 'img',
    'aria-label': label,
  })
  const sum = parts.reduce((n, m) => n + Math.max(0, m.value), 0)
  const colour = (m: Part, i: number) => (m.other ? p.neutral : p.palette[i % p.palette.length]!)
  let angle = 0
  parts.forEach((m, i) => {
    const part = sum ? (Math.max(0, m.value) / sum) * 2 * Math.PI : 0
    if (part <= 0) return
    const g = s('g', { class: 'ch-mark' }, root)
    s(
      'path',
      { d: arcPath(size / 2, size / 2, 104, 66, angle, angle + part), fill: colour(m, i), class: 'ch-seg' },
      g,
    )
    p.tip(g, m.tip)
    angle += part
  })
  s('text', { x: size / 2, y: size / 2 + 2, 'text-anchor': 'middle', class: 'ch-total' }, root, total)
  s('text', { x: size / 2, y: size / 2 + 20, 'text-anchor': 'middle', class: 'ch-sub' }, root, sub)
  const legend = h('ul', { class: 'ch-legend' })
  parts.forEach((m, i) => {
    const swatch = h('span', { class: 'ch-swatch', attrs: { 'aria-hidden': 'true' } })
    swatch.style.backgroundColor = colour(m, i)
    const share = sum ? Math.max(0, m.value) / sum : 0
    const li = h(
      'li',
      { class: m.other ? 'ch-other' : '' },
      swatch,
      h('span', { class: 'ch-legend-label', title: m.label, text: m.label }),
      h('span', { class: 'ch-legend-value', text: p.num(m.value) }),
      h('span', { class: 'ch-legend-share', text: p.pct(share) }),
    )
    p.tip(li, m.tip)
    legend.append(li)
  })
  host.replaceChildren(h('div', { class: 'ch-donut' }, root, legend))
}

export interface TimePoint {
  ms: number
  value: number
  empty?: boolean
  tip: string[]
}

/** A line over time, the area under it washed in the accent; each period a hover band. */
export function line(
  host: HTMLElement,
  points: TimePoint[],
  p: Paint,
  label: string,
  when: (ms: number) => string,
): void {
  const W = p.width
  const H = 260
  const values = points.map((q) => q.value)
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values), 5)
  const left = yRoom(ticks, p)
  // Room on the right for the last date, centred under its point.
  const [right, top, bottom] = [W - 30, 12, H - 30]
  const root = canvas(host, W, H, label)
  const y = scaleLinear([ticks[0]!, ticks.at(-1)!], [bottom, top])
  const single = points.length === 1
  const x = single ? () => (left + right) / 2 : scaleLinear([points[0]!.ms, points.at(-1)!.ms], [left, right])
  yGrid(root, ticks, y, left, right, p)
  const colour = p.palette[0]!
  const xy = points.map((q) => [x(q.ms), y(q.value)] as [number, number])
  const path = linePath(xy)
  // The ticks always hold zero (they start at min(0, …)): the area grows from it.
  const base = y(0)
  if (!single) {
    s(
      'path',
      { d: `${path}L${xy.at(-1)![0]} ${base}L${xy[0]![0]} ${base}Z`, fill: colour, class: 'ch-area' },
      root,
    )
    s('path', { d: path, stroke: colour, class: 'ch-line' }, root)
  }
  const real = points.filter((q) => !q.empty).length
  points.forEach((q, i) => {
    const [cx, cy] = xy[i]!
    const from = i === 0 ? left : (xy[i - 1]![0] + cx) / 2
    const to = i === points.length - 1 ? right : (cx + xy[i + 1]![0]) / 2
    const g = s('g', { class: 'ch-mark' }, root)
    s(
      'rect',
      { x: from, y: top, width: Math.max(1, to - from), height: bottom - top, class: 'ch-hit ch-band' },
      g,
    )
    s('line', { x1: cx, x2: cx, y1: top, y2: bottom, class: 'ch-rule' }, g)
    if (!q.empty && (real <= 60 || single)) s('circle', { cx, cy, r: 3.5, fill: colour, class: 'ch-dot' }, g)
    s('circle', { cx, cy, r: 5, fill: colour, class: 'ch-focus' }, g)
    p.tip(g, q.tip)
  })
  const labels = points.map((q) => when(q.ms))
  const room = Math.max(...labels.map((t) => textWidth(t, 11))) + 18
  const marks = single ? [0] : spreadIndices(points.length, (right - left) / room)
  marks.forEach((i) =>
    s(
      'text',
      {
        x: xy[i]![0],
        y: H - 10,
        'text-anchor': 'middle',
        class: 'ch-tick',
      },
      root,
      labels[i]!,
    ),
  )
}

/** Columns side by side (a histogram): the bounds under the edges, a value on each cap that fits. */
export function columns(host: HTMLElement, parts: Part[], edges: string[], p: Paint, label: string): void {
  const W = p.width
  const H = 260
  const ticks = niceTicks(0, Math.max(0, ...parts.map((c) => c.value)), 5)
  const left = yRoom(ticks, p)
  const [right, top, bottom] = [W - 24, 20, H - 30]
  const root = canvas(host, W, H, label)
  const y = scaleLinear([0, ticks.at(-1)!], [bottom, top])
  yGrid(root, ticks, y, left, right, p)
  const slot = (right - left) / parts.length
  parts.forEach((c, i) => {
    const g = s('g', { class: 'ch-mark' }, root)
    s('rect', { x: left + i * slot, y: top, width: slot, height: bottom - top, class: 'ch-hit' }, g)
    const yv = y(Math.max(0, c.value))
    s(
      'rect',
      {
        x: left + i * slot + 1,
        y: yv,
        width: Math.max(1, slot - 2),
        height: Math.max(0, bottom - yv),
        rx: 2,
        fill: p.palette[0]!,
        class: 'ch-bar',
      },
      g,
    )
    const value = p.num(c.value)
    if (textWidth(value, 11) + 4 <= slot)
      s(
        'text',
        { x: left + (i + 0.5) * slot, y: yv - 5, 'text-anchor': 'middle', class: 'ch-value' },
        g,
        value,
      )
    p.tip(g, c.tip)
  })
  const room = Math.max(...edges.map((t) => textWidth(t, 11))) + 14
  const shown = spreadIndices(edges.length, (right - left) / room)
  shown.forEach((i) =>
    s(
      'text',
      {
        x: left + i * slot,
        y: H - 10,
        'text-anchor': 'middle',
        class: 'ch-tick',
      },
      root,
      edges[i]!,
    ),
  )
}

/** Points of two numeric fields, both axes gridded and named. */
export function scatter(
  host: HTMLElement,
  points: Array<{ x: number; y: number; tip: string[] }>,
  p: Paint,
  label: string,
  names: { x: string; y: string },
): void {
  const W = p.width
  const H = 300
  const xs = points.map((q) => q.x)
  const ys = points.map((q) => q.y)
  const yt = niceTicks(Math.min(...ys), Math.max(...ys), 5)
  const left = yRoom(yt, p)
  const [right, top, bottom] = [W - 18, 24, H - 44]
  const xt = niceTicks(Math.min(...xs), Math.max(...xs), tickCount(right - left, 80))
  const root = canvas(host, W, H, label)
  const x = scaleLinear([xt[0]!, xt.at(-1)!], [left, right])
  const y = scaleLinear([yt[0]!, yt.at(-1)!], [bottom, top])
  yGrid(root, yt, y, left, right, p)
  for (const t of xt) {
    s('line', { x1: x(t), x2: x(t), y1: top, y2: bottom, class: 'ch-grid' }, root)
    s('text', { x: x(t), y: bottom + 17, 'text-anchor': 'middle', class: 'ch-tick' }, root, p.compact(t))
  }
  s(
    'text',
    { x: left, y: 12, 'text-anchor': 'start', class: 'ch-axis-title' },
    root,
    fitText(names.y, W / 2, 11.5),
  )
  s(
    'text',
    { x: right, y: H - 6, 'text-anchor': 'end', class: 'ch-axis-title' },
    root,
    fitText(names.x, W / 2, 11.5),
  )
  for (const q of points) {
    const dot = s('circle', { cx: x(q.x), cy: y(q.y), r: 4, fill: p.palette[0]!, class: 'ch-point' }, root)
    p.tip(dot, q.tip)
  }
}
