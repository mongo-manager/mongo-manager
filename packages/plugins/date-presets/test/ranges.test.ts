// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { PRESETS, betweenRange, lastRange, presetRange, rangeFilter, type Range } from '../src/ranges'

// Wednesday 28 October 2026, 15:30:20.500 UTC.
const NOW = new Date(Date.UTC(2026, 9, 28, 15, 30, 20, 500))
const iso = (r: Range) => [r.start.toISOString(), r.end.toISOString()]

describe('the presets, in UTC', () => {
  it('give each its [start, end) range', () => {
    const u = (p: (typeof PRESETS)[number]) => iso(presetRange(p, NOW, true))
    expect(u('today')).toEqual(['2026-10-28T00:00:00.000Z', '2026-10-29T00:00:00.000Z'])
    expect(u('yesterday')).toEqual(['2026-10-27T00:00:00.000Z', '2026-10-28T00:00:00.000Z'])
    expect(u('last24h')).toEqual(['2026-10-27T15:30:20.500Z', '2026-10-28T15:30:20.500Z'])
    expect(u('last7d')).toEqual(['2026-10-22T00:00:00.000Z', '2026-10-29T00:00:00.000Z'])
    expect(u('last30d')).toEqual(['2026-09-29T00:00:00.000Z', '2026-10-29T00:00:00.000Z'])
    // Weeks start on Monday: the 26th.
    expect(u('thisWeek')).toEqual(['2026-10-26T00:00:00.000Z', '2026-11-02T00:00:00.000Z'])
    expect(u('lastWeek')).toEqual(['2026-10-19T00:00:00.000Z', '2026-10-26T00:00:00.000Z'])
    expect(u('thisMonth')).toEqual(['2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'])
    expect(u('lastMonth')).toEqual(['2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'])
    expect(u('thisYear')).toEqual(['2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'])
  })

  it('count a Sunday as the last day of its week, and cross months and years', () => {
    const sunday = new Date(Date.UTC(2026, 10, 1, 9))
    expect(iso(presetRange('thisWeek', sunday, true))).toEqual([
      '2026-10-26T00:00:00.000Z',
      '2026-11-02T00:00:00.000Z',
    ])
    const january = new Date(Date.UTC(2027, 0, 3))
    expect(iso(presetRange('lastMonth', january, true))).toEqual([
      '2026-12-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z',
    ])
    expect(iso(presetRange('last7d', january, true))).toEqual([
      '2026-12-28T00:00:00.000Z',
      '2027-01-04T00:00:00.000Z',
    ])
  })
})

describe('the presets, in UTC whatever the browser’s time', () => {
  it('count the UTC day at either end of it', () => {
    // In any time zone but UTC itself one of these is another day locally.
    for (const at of [Date.UTC(2026, 9, 28, 0, 0, 1), Date.UTC(2026, 9, 28, 23, 59, 59)])
      expect(iso(presetRange('today', new Date(at), true))).toEqual([
        '2026-10-28T00:00:00.000Z',
        '2026-10-29T00:00:00.000Z',
      ])
  })
})

describe('the presets, in the browser’s time', () => {
  it('start at local midnight', () => {
    const r = presetRange('today', NOW)
    expect([r.start.getHours(), r.start.getMinutes(), r.start.getDate()]).toEqual([0, 0, NOW.getDate()])
    expect(r.end.getTime() - r.start.getTime()).toBeGreaterThanOrEqual(23 * 3_600_000)
    const week = presetRange('thisWeek', NOW)
    expect(week.start.getDay()).toBe(1)
  })
})

describe('the last n units, and a range between two days', () => {
  it('counts hours up to now, and whole days, weeks and months with the current one', () => {
    expect(iso(lastRange(6, 'hours', NOW, true))).toEqual([
      '2026-10-28T09:30:20.500Z',
      '2026-10-28T15:30:20.500Z',
    ])
    expect(iso(lastRange(3, 'days', NOW, true))).toEqual([
      '2026-10-26T00:00:00.000Z',
      '2026-10-29T00:00:00.000Z',
    ])
    expect(iso(lastRange(2, 'weeks', NOW, true))).toEqual([
      '2026-10-15T00:00:00.000Z',
      '2026-10-29T00:00:00.000Z',
    ])
    expect(iso(lastRange(3, 'months', NOW, true))).toEqual([
      '2026-08-01T00:00:00.000Z',
      '2026-11-01T00:00:00.000Z',
    ])
  })

  it('takes both days in, and refuses what is no range', () => {
    expect(iso(betweenRange('2026-10-01', '2026-10-03', true)!)).toEqual([
      '2026-10-01T00:00:00.000Z',
      '2026-10-04T00:00:00.000Z',
    ])
    expect(iso(betweenRange('2026-10-03', '2026-10-03', true)!)).toEqual([
      '2026-10-03T00:00:00.000Z',
      '2026-10-04T00:00:00.000Z',
    ])
    expect(betweenRange('2026-10-04', '2026-10-03', true)).toBeNull()
    expect(betweenRange('', '2026-10-03', true)).toBeNull()
    expect(betweenRange('2026-1-4', '2026-10-03', true)).toBeNull()
    // A day that is none is refused, never moved to the next month.
    expect(betweenRange('2026-02-31', '2026-03-03', true)).toBeNull()
    expect(betweenRange('2026-02-28', '2026-02-30', true)).toBeNull()
    // A year below 100 is that year, not 19xx.
    expect(iso(betweenRange('0050-03-01', '0050-03-01', true)!)).toEqual([
      '0050-03-01T00:00:00.000Z',
      '0050-03-02T00:00:00.000Z',
    ])
    expect(betweenRange('0050-03-01', '0050-03-01')!.start.getFullYear()).toBe(50)
  })
})

describe('the filter for a range', () => {
  const range = presetRange('today', NOW, true)
  it('selects a date field’s dates as canonical Extended JSON', () => {
    expect(rangeFilter('createdAt', range)).toEqual({
      createdAt: {
        $gte: { $date: { $numberLong: String(Date.UTC(2026, 9, 28)) } },
        $lt: { $date: { $numberLong: String(Date.UTC(2026, 9, 29)) } },
      },
    })
  })

  it('selects the ObjectIds made in the range by their time', () => {
    const start = (Date.UTC(2026, 9, 28) / 1000).toString(16)
    const end = (Date.UTC(2026, 9, 29) / 1000).toString(16)
    expect(rangeFilter('_id', range, true)).toEqual({
      _id: { $gte: { $oid: `${start}0000000000000000` }, $lt: { $oid: `${end}0000000000000000` } },
    })
    expect(start).toHaveLength(8)
    // An early time is written with its leading zeros.
    expect(
      rangeFilter(
        '_id',
        { start: new Date(Date.UTC(1971, 0, 1)), end: new Date(Date.UTC(1971, 0, 2)) },
        true,
      ),
    ).toEqual({
      _id: { $gte: { $oid: '01e13380' + '0'.repeat(16) }, $lt: { $oid: '01e28500' + '0'.repeat(16) } },
    })
    // After 2106 an ObjectId holds no more seconds: the largest time it can.
    expect(
      rangeFilter(
        '_id',
        { start: new Date(Date.UTC(2200, 0, 1)), end: new Date(Date.UTC(2200, 0, 2)) },
        true,
      ),
    ).toEqual({
      _id: { $gte: { $oid: 'ffffffff' + '0'.repeat(16) }, $lt: { $oid: 'ffffffff' + '0'.repeat(16) } },
    })
    // Before 1970 there is no ObjectId time: the smallest one.
    expect(rangeFilter('_id', { start: new Date(-5000), end: new Date(0) }, true)).toEqual({
      _id: { $gte: { $oid: '0'.repeat(24) }, $lt: { $oid: '0'.repeat(24) } },
    })
  })
})
