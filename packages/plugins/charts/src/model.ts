// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { MAX_BINS, MAX_PERIODS, nextPeriod, type GroupRow, type Measure, type Unit } from './pipelines'
import { niceTicks } from './svg'

/**
 * Charts, redesigned (spec plugin-tabs-redesign §2.3): what a chart shows, as pure functions — the
 * bars of a grouped chart with "Other" last, periods without documents as zero, the colours taken
 * from the user's accent, and labels that fit their room.
 */

export interface Mark {
  key: unknown
  value: number
  /** The groups past the top ones, together. */
  other?: boolean
}

/** A group's value in a measure (a count, or a sum, average… of another field). */
export const valueOf = (r: GroupRow, m: Measure): number => (m === 'count' ? r.count : (r[m] ?? 0))

/** The bars or slices of a grouped chart: the largest first, "Other" (when there is one) last. */
export function groupMarks(rows: GroupRow[], measure: Measure, other: number | null): Mark[] {
  const marks: Mark[] = rows
    .map((r, i) => ({ key: r.key, value: valueOf(r, measure), i }))
    .sort((a, b) => b.value - a.value || a.i - b.i)
    .map(({ key, value }) => ({ key, value }))
  if (other !== null && other > 0) marks.push({ key: null, value: other, other: true })
  return marks
}

export interface PeriodPoint {
  ms: number
  value: number
  /** A period no document falls in, drawn as zero. */
  empty?: boolean
}

/**
 * The periods between the first and the last, those without documents as zero — a count or a sum
 * of nothing is zero, and a line drawn straight over a gap says otherwise. An average, min or max
 * of nothing is no value: those are left as they are, as are more periods than a chart holds.
 */
export function fillPeriods(
  points: Array<{ ms: number; value: number }>,
  unit: Unit,
  measure: Measure,
  cap = MAX_PERIODS,
): PeriodPoint[] {
  if (points.length < 2 || (measure !== 'count' && measure !== 'sum')) return points
  const byMs = new Map(points.map((p) => [p.ms, p.value]))
  const out: PeriodPoint[] = []
  const last = points.at(-1)!.ms
  for (let ms = points[0]!.ms; ms <= last; ms = nextPeriod(ms, unit)) {
    if (out.length >= cap) return points
    const value = byMs.get(ms)
    out.push(value === undefined ? { ms, value: 0, empty: true } : { ms, value })
  }
  // Periods the server counted differently than these steps: draw what came, rather than guess.
  if (out.filter((p) => !p.empty).length !== points.length) return points
  return out
}

/**
 * The edges of a histogram's bins over [min, max]: round, one width, about `count` of them. Bins
 * of one over whole numbers give the largest value a bin of its own (1–9 is nine bins, not eight).
 */
export function binEdges(min: number, max: number, count = 12): number[] {
  const edges = niceTicks(min, max, count).slice(0, MAX_BINS + 1)
  const step = edges.length > 1 ? edges[1]! - edges[0]! : 0
  if (step === 1 && Number.isInteger(max) && max === edges.at(-1) && edges.length <= MAX_BINS)
    edges.push(max + 1)
  return edges
}

/** At most `max` indices of `n` items, spread evenly, the first and the last among them. */
export function spreadIndices(n: number, max: number): number[] {
  if (n <= 0) return []
  const k = Math.max(1, Math.min(n, Math.floor(max)))
  if (k === 1) return [0]
  if (k >= n) return [...Array(n).keys()]
  const step = (n - 1) / (k - 1)
  return [...new Set([...Array(k).keys()].map((i) => Math.round(i * step)))]
}

/** About how wide a text is, in pixels, at a font size (no layout to measure in). */
export const textWidth = (s: string, px = 12): number => Math.ceil(s.length * px * 0.6)

/** A text cut with an ellipsis to fit a width. */
export function fitText(s: string, width: number, px = 12): string {
  const max = Math.max(1, Math.floor(width / (px * 0.6)))
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s
}

// ---- colours

/**
 * The validated categorical hues (dataviz reference palette), light and dark steps: blue, orange,
 * aqua, yellow, magenta, green, violet, red. The accent takes the place of the one nearest its hue.
 */
const HUES = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
}
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

function rgbOf(hex: string): [number, number, number] {
  const h = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c).join('') : hex.slice(1)
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
}

/** The hue of a colour, in degrees. */
export function hueOf(hex: string): number {
  const [r, g, b] = rgbOf(hex).map((v) => v / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  if (!d) return 0
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}

const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b))

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const toGamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)

/** A colour with its OKLab lightness kept within [min, max] (its hue and chroma as they were). */
export function withLightness(hex: string, min: number, max: number): string {
  const [r, g, b] = rgbOf(hex).map((v) => toLinear(v / 255)) as [number, number, number]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  if (L >= min && L <= max) return hex.toLowerCase()
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  const L2 = Math.min(max, Math.max(min, L))
  const l2 = (L2 + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m2 = (L2 - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s2 = (L2 - 0.0894841775 * A - 1.291485548 * B) ** 3
  const rgb = [
    4.0767416621 * l2 - 3.3077115913 * m2 + 0.2309699292 * s2,
    -1.2684380046 * l2 + 2.6097574011 * m2 - 0.3413193965 * s2,
    -0.0041960863 * l2 - 0.7034186147 * m2 + 1.707614701 * s2,
  ]
  return `#${rgb
    .map((v) => Math.round(Math.min(1, Math.max(0, toGamma(Math.max(0, v)))) * 255))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`
}

/**
 * Colours for the parts of a chart, in a fixed order, the accent first: the accent takes the place
 * of the reference hue nearest it (two greens side by side read as one) and the order turns to start
 * there, so neighbours stay the pairs the palette was checked for. The accent's lightness is kept
 * within the band the others share (the app's dark accents are brighter). Never cycled: a part past
 * the last colour belongs in "Other".
 */
export function paletteFrom(accent: string, dark: boolean, count = 7): string[] {
  const hues = HUES[dark ? 'dark' : 'light']
  // Anything that is not a colour is the brand's Emerald, as the kit reads an unknown accent.
  const given = HEX.test(accent.trim()) ? accent.trim() : dark ? '#2fbf7f' : '#047a4d'
  const first = withLightness(given, dark ? 0.5 : 0.45, dark ? 0.65 : 0.75)
  const h = hueOf(first)
  let nearest = 0
  hues.forEach((c, i) => {
    if (hueGap(hueOf(c), h) < hueGap(hueOf(hues[nearest]!), h)) nearest = i
  })
  const placed = hues.map((c, i) => (i === nearest ? first : c))
  return [...placed.slice(nearest), ...placed.slice(0, nearest)].slice(0, Math.min(count, hues.length))
}
