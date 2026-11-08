// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { deserializeValue } from '@mongo-manager/shared/browser'
import {
  NO_VALUE,
  chartData,
  chartFields,
  chartProjection,
  type ChartSpec,
} from '../src/documents/chartModel'

// W1 (completion §2): a chart of the results, drawn in the app (not only by the plugin).
const spec = (over: Partial<ChartSpec>): ChartSpec => ({
  kind: 'bar',
  x: 'status',
  y: '',
  group: '',
  measure: 'count',
  ...over,
})
const none = () => false
// Decoded BSON numbers, as the table holds them.
const int = (n: number) => deserializeValue({ $numberInt: String(n) })
const double = (n: number) => deserializeValue({ $numberDouble: String(n) })
const docs = [
  { status: 'paid', total: int(10), region: 'eu' },
  { status: 'paid', total: double(5.5), region: 'us' },
  { status: 'open', total: 7, region: 'eu' },
  { status: 'open', total: 'n/a', region: 'eu' },
  { total: 3 },
]

describe('chartData', () => {
  it('counts documents per value of x, largest first, saying how many lacked x', () => {
    expect(chartData(docs, spec({}), none)).toEqual({
      kind: 'categories',
      categories: ['paid', 'open'],
      series: [{ name: 'count', values: [2, 2] }],
      other: false,
      skipped: 1,
    })
  })

  it('sums and averages a number field, leaving out values that are not numbers', () => {
    const sum = chartData(docs, spec({ measure: 'sum', y: 'total' }), none)
    expect(sum).toMatchObject({
      categories: ['paid', 'open'],
      series: [{ name: 'total', values: [15.5, 7] }],
    })
    const avg = chartData(docs, spec({ measure: 'avg', y: 'total' }), none)
    expect(avg).toMatchObject({ series: [{ values: [7.75, 7] }] })
  })

  it('splits bars into one series per group value', () => {
    const out = chartData(docs, spec({ group: 'region' }), none)
    expect(out).toMatchObject({
      categories: ['paid', 'open'],
      series: [
        { name: 'eu', values: [1, 2] },
        { name: 'us', values: [1, null] },
      ],
    })
  })

  it('orders numbers and dates by value, and folds the smallest of many categories into Other', () => {
    const numeric = [{ n: 3 }, { n: 1 }, { n: 2 }, { n: 1 }]
    expect(chartData(numeric, spec({ x: 'n', kind: 'line' }), none)).toMatchObject({
      categories: ['1', '2', '3'],
      series: [{ values: [2, 1, 1] }],
    })
    const many = Array.from({ length: 40 }, (_, i) => ({ k: `v${i}` }))
    const out = chartData(many, spec({ x: 'k' }), none)
    expect(out.kind === 'categories' && out.categories.length).toBe(31)
    expect(out.kind === 'categories' && out.other).toBe(true)
    const pie = chartData(many, spec({ x: 'k', kind: 'pie' }), none)
    expect(pie.kind === 'categories' && pie.categories.length).toBe(11)
  })

  it('plots scatter points of two numbers, per group', () => {
    const points = [
      { a: 1, b: int(2), g: 'x' },
      { a: 2, b: 4, g: 'y' },
      { a: 'no', b: 1, g: 'x' },
    ]
    expect(chartData(points, spec({ kind: 'scatter', x: 'a', y: 'b', group: 'g' }), none)).toEqual({
      kind: 'points',
      xType: 'number',
      series: [
        { name: 'x', points: [[1, 2]] },
        { name: 'y', points: [[2, 4]] },
      ],
      skipped: 1,
    })
  })

  it('orders a scatter’s series largest first, as bars do, so a group keeps its colour', () => {
    const points = [
      { a: 1, b: 1, g: 'rare' },
      { a: 2, b: 2, g: 'common' },
      { a: 3, b: 3, g: 'common' },
    ]
    const out = chartData(points, spec({ kind: 'scatter', x: 'a', y: 'b', group: 'g' }), none)
    expect(out.kind === 'points' && out.series.map((s) => s.name)).toEqual(['common', 'rare'])
  })

  // W1 review (minor 5): a category is its type and value, and says which when two read alike.
  it('keeps a number and a string apart, and a missing group apart from null', () => {
    const out = chartData(
      [{ k: 1, g: null }, { k: '1' }, { k: '1', g: 'x' }, { k: true, g: 'x' }],
      spec({ x: 'k', group: 'g' }),
      none,
    )
    expect(out).toMatchObject({ categories: ['"1"', '1', 'true'] })
    expect(out.kind === 'categories' && out.series.map((s) => s.name)).toEqual(['x', 'null', NO_VALUE])
  })

  it('orders by value only when every category is a number, or every one a date', () => {
    // A number larger than the date's milliseconds: by value it would come after the date.
    const big = 2_000_000_000_000
    const mixed = [{ k: big }, { k: deserializeValue({ $date: '2026-01-01T00:00:00Z' }) }, { k: big }]
    expect(chartData(mixed, spec({ x: 'k' }), none)).toMatchObject({
      categories: [String(big), '2026-01-01'],
      series: [{ values: [2, 1] }],
    })
    const dates = [
      { k: deserializeValue({ $date: '2026-03-01T00:00:00Z' }) },
      { k: deserializeValue({ $date: '2026-01-01T00:00:00Z' }) },
      { k: deserializeValue({ $date: '2026-01-01T00:00:00Z' }) },
    ]
    expect(chartData(dates, spec({ x: 'k' }), none)).toMatchObject({
      categories: ['2026-01-01', '2026-03-01'],
    })
  })

  it('draws no pie of negative sums, nor of averages', () => {
    const docs = [
      { s: 'a', n: 5 },
      { s: 'b', n: -2 },
    ]
    expect(chartData(docs, spec({ kind: 'pie', x: 's', y: 'n', measure: 'sum' }), none)).toEqual({
      kind: 'negative',
    })
    // An average is drawn as a sum would be refused: a pie offers count and sum only.
    expect(chartData(docs, spec({ kind: 'pie', x: 's', y: 'n', measure: 'avg' }), none)).toEqual({
      kind: 'negative',
    })
    expect(
      chartData([{ s: 'a', n: 5 }], spec({ kind: 'pie', x: 's', y: 'n', measure: 'avg' }), none),
    ).toMatchObject({ series: [{ values: [5] }] })
  })

  it('refuses a hidden field and never reads its values (phase 3c)', () => {
    const masked = (p: readonly string[]) => p[0] === 'total'
    expect(chartData(docs, spec({ measure: 'sum', y: 'total' }), masked)).toEqual({
      kind: 'refused',
      field: 'total',
    })
    expect(chartData(docs, spec({ x: 'total' }), masked)).toEqual({ kind: 'refused', field: 'total' })
    expect(chartData(docs, spec({ group: 'total' }), masked)).toEqual({ kind: 'refused', field: 'total' })
  })

  it('reads nested fields', () => {
    expect(chartData([{ a: { b: 'x' } }, { a: { b: 'x' } }], spec({ x: 'a.b' }), none)).toMatchObject({
      categories: ['x'],
      series: [{ values: [2] }],
    })
  })
})

describe('chartProjection', () => {
  it('reads only the fields drawn, a parent once for its children (no path collision)', () => {
    expect(chartProjection(spec({ x: 'status' }))).toEqual({ _id: 0, status: 1 })
    expect(chartProjection(spec({ x: 'a.b', y: 'n', group: 'a', measure: 'sum' }))).toEqual({
      _id: 0,
      a: 1,
      n: 1,
    })
    // A y left from another measure is not read for a count, nor a group for a pie.
    expect(chartProjection(spec({ x: 's', y: 'n', group: 'g', kind: 'pie' }))).toEqual({ _id: 0, s: 1 })
    expect(chartProjection(spec({ x: '_id' }))).toEqual({ _id: 1 })
  })

  // W1 review (minor 4): the query's own projection decides what there is; only the fields drawn of it
  // are read, never whole documents.
  it('reads the fields drawn of the query’s own projection', () => {
    const one = { $numberInt: '1' }
    const zero = { $numberInt: '0' }
    const sum = (over: Partial<ChartSpec>) => spec({ measure: 'sum', y: 'total', ...over })
    expect(chartProjection(sum({}), { status: one, total: one, note: one })).toEqual({
      _id: 0,
      status: 1,
      total: 1,
    })
    // A computed field is read as computed; a field the projection left out is not read.
    const doubled = { $multiply: ['$total', { $numberInt: '2' }] }
    expect(chartProjection(sum({}), { status: one, total: doubled })).toEqual({
      _id: 0,
      status: 1,
      total: doubled,
    })
    expect(chartProjection(sum({}), { status: one })).toEqual({ _id: 0, status: 1 })
    // An exclusion: what it leaves out is not read; nothing drawn left is the _id alone, never all.
    expect(chartProjection(sum({}), { total: zero })).toEqual({ _id: 0, status: 1 })
    expect(chartProjection(spec({ x: 'secret' }), { secret: zero })).toEqual({ _id: 1 })
    // A child of a field drawn is read as the projection names it.
    expect(chartProjection(spec({ x: 'address' }), { 'address.city': one })).toEqual({
      _id: 0,
      'address.city': 1,
    })
  })
})

describe('chartFields', () => {
  it('lists the fields that can be charted, never a hidden one', () => {
    const fields = chartFields(
      [{ _id: 1, name: 'a', email: 'e', tags: ['x'], address: { city: 'c' }, n: 1 }],
      (p) => p[0] === 'email',
    )
    expect(fields).toEqual(['_id', 'name', 'address.city', 'n'])
  })

  it('leaves out names a field path cannot reach (a dot inside, a leading $)', () => {
    expect(chartFields([{ 'a.b': 1, $c: 2, d: { 'e.f': 3, $g: 4, h: 5 } }], none)).toEqual(['d.h'])
  })
})
