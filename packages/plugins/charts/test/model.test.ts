import { describe, expect, it } from 'vitest'
import {
  binEdges,
  fillPeriods,
  fitText,
  groupMarks,
  hueOf,
  paletteFrom,
  spreadIndices,
  withLightness,
} from '../src/model'
import type { GroupRow } from '../src/pipelines'

const row = (key: unknown, count: number, avg: number | null = null): GroupRow => ({
  key,
  count,
  sum: null,
  avg,
  min: null,
  max: null,
})

describe('the bars of a grouped chart (charts redesign)', () => {
  it('puts the largest first and "Other" last', () => {
    const marks = groupMarks([row('a', 2), row('b', 9), row(null, 4)], 'count', 30)
    expect(marks).toEqual([
      { key: 'b', value: 9 },
      { key: null, value: 4 },
      { key: 'a', value: 2 },
      { key: null, value: 30, other: true },
    ])
  })

  it('has no "Other" where nothing is left out, and reads a missing measure as zero', () => {
    expect(groupMarks([row('a', 2)], 'count', null)).toEqual([{ key: 'a', value: 2 }])
    expect(groupMarks([row('a', 2)], 'count', 0)).toEqual([{ key: 'a', value: 2 }])
    expect(groupMarks([row('a', 2, null), row('b', 1, 5)], 'avg', null).map((m) => m.value)).toEqual([5, 0])
  })
})

describe('periods without documents (charts redesign)', () => {
  const jan = Date.UTC(2026, 0, 1)
  const mar = Date.UTC(2026, 2, 1)
  const apr = Date.UTC(2026, 3, 1)

  it('draws a count of a period without documents as zero', () => {
    expect(
      fillPeriods(
        [
          { ms: jan, value: 3 },
          { ms: mar, value: 1 },
          { ms: apr, value: 2 },
        ],
        'month',
        'count',
      ),
    ).toEqual([
      { ms: jan, value: 3 },
      { ms: Date.UTC(2026, 1, 1), value: 0, empty: true },
      { ms: mar, value: 1 },
      { ms: apr, value: 2 },
    ])
  })

  it('leaves an average as it is, and more periods than a chart holds', () => {
    const points = [
      { ms: jan, value: 3 },
      { ms: apr, value: 2 },
    ]
    expect(fillPeriods(points, 'month', 'avg')).toBe(points)
    expect(fillPeriods(points, 'day', 'count', 50)).toBe(points)
    expect(fillPeriods(points, 'day', 'count')).toHaveLength(91)
  })

  it('draws what came where the periods do not fall on the steps', () => {
    const odd = [
      { ms: jan, value: 1 },
      { ms: jan + 5 * 3_600_000, value: 1 },
      { ms: jan + 86_400_000, value: 1 },
    ]
    expect(fillPeriods(odd, 'day', 'count')).toBe(odd)
  })
})

describe('the bins of a histogram (charts redesign)', () => {
  it('cuts the values’ range into round bins of one width', () => {
    expect(binEdges(0.13, 499.9)).toEqual([0, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500])
    expect(binEdges(-12, 30)).toEqual([-15, -10, -5, 0, 5, 10, 15, 20, 25, 30])
  })

  it('gives whole numbers a bin each, the largest too', () => {
    expect(binEdges(1, 9)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('spreads a single value, and never holds more than 60 bins', () => {
    expect(binEdges(7, 7).length).toBeGreaterThanOrEqual(2)
    expect(binEdges(0, 1e300).length).toBeLessThanOrEqual(61)
    expect(binEdges(1e17, 1e17 + 16).length).toBeLessThanOrEqual(61)
  })
})

describe('labels that fit (charts redesign)', () => {
  it('spreads at most so many labels, the first and last among them', () => {
    expect(spreadIndices(10, 4)).toEqual([0, 3, 6, 9])
    expect(spreadIndices(3, 8)).toEqual([0, 1, 2])
    expect(spreadIndices(5, 1)).toEqual([0])
    expect(spreadIndices(0, 4)).toEqual([])
  })

  it('cuts a text to its room with an ellipsis', () => {
    expect(fitText('Izmir', 100)).toBe('Izmir')
    const cut = fitText('a very long city name indeed', 72)
    expect(cut.endsWith('…')).toBe(true)
    expect(cut.length).toBeLessThanOrEqual(10)
  })
})

describe('colours from the user’s accent (charts redesign)', () => {
  it('starts with the accent and keeps seven distinct colours, never cycled', () => {
    const p = paletteFrom('#2563eb', false)
    expect(p[0]).toBe('#2563eb')
    expect(p).toHaveLength(7)
    expect(new Set(p).size).toBe(7)
    // The reference blue gave its place to the accent: no second blue beside it.
    expect(p).not.toContain('#2a78d6')
  })

  it('takes the place of the nearest hue and keeps the checked order after it', () => {
    // Emerald replaces aqua; the order goes on from there: yellow, magenta, green…
    expect(paletteFrom('#047a4d', false)).toEqual([
      '#047a4d',
      '#eda100',
      '#e87ba4',
      '#008300',
      '#4a3aa7',
      '#e34948',
      '#2a78d6',
    ])
  })

  it('brings a bright dark-theme accent into the band the other colours share', () => {
    const [first] = paletteFrom('#2fbf7f', true)
    expect(first).not.toBe('#2fbf7f')
    expect(Math.abs(hueOf(first!) - hueOf('#2fbf7f'))).toBeLessThan(12)
    expect(withLightness('#2a78d6', 0.43, 0.77)).toBe('#2a78d6')
  })

  it('falls back to the brand colour for anything that is not a colour', () => {
    for (const bad of ['', 'red', 'url(x)', '#12345', 'var(--x)'])
      expect(paletteFrom(bad, false)[0], bad).toBe('#047a4d')
  })
})
