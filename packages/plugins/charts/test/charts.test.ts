import { describe, expect, it } from 'vitest'
import { fieldInfo, fieldsFor, kindOf } from '../src/fields'
import {
  bucketFilter,
  groupPipeline,
  binsPipeline,
  extentPipeline,
  nextPeriod,
  numberOf,
  periodFilter,
  readGroups,
  rowFilter,
  scatterPipeline,
  timePipeline,
} from '../src/pipelines'
import { arcPath, linePath, niceTicks, scaleLinear } from '../src/svg'

const int = (n: number) => ({ $numberInt: String(n) })

describe('the fields a sample holds, by kind (charts)', () => {
  it('reads each value’s kind from canonical Extended JSON', () => {
    expect(kindOf({ $numberInt: '1' })).toBe('number')
    expect(kindOf({ $numberDouble: '1.5' })).toBe('number')
    expect(kindOf({ $numberLong: '7' })).toBe('number')
    expect(kindOf({ $numberDecimal: '1.25' })).toBe('number')
    expect(kindOf({ $date: { $numberLong: '0' } })).toBe('date')
    expect(kindOf('x')).toBe('string')
    expect(kindOf(true)).toBe('bool')
    expect(kindOf({ $oid: '65a1b2c3d4e5f60718293a4b' })).toBe('objectId')
    expect(kindOf([1])).toBe('other')
    expect(kindOf({ a: 1 })).toBe('other')
    expect(kindOf(null)).toBe('other')
  })

  it('lists the fields, nested ones by path, the most common first', () => {
    const info = fieldInfo([
      { _id: { $oid: 'a'.repeat(24) }, city: 'Izmir', total: int(5), at: { $date: { $numberLong: '1' } } },
      {
        _id: { $oid: 'b'.repeat(24) },
        city: 'Ankara',
        total: { $numberDouble: '2.5' },
        address: { zip: '35' },
      },
      { _id: { $oid: 'c'.repeat(24) }, city: 7, tags: ['x'] },
    ])
    expect(info.map((f) => f.path)).toEqual(['_id', 'city', 'total', 'address.zip', 'at', 'tags'])
    expect(info.find((f) => f.path === 'city')!.kinds).toEqual({ string: 2, number: 1 })
    expect(fieldsFor(info, ['number'])).toEqual(['total', 'city'])
    expect(fieldsFor(info, ['date'])).toEqual(['at'])
    expect(fieldsFor(info, ['string', 'number', 'bool', 'objectId', 'date'])).not.toContain('tags')
  })
})

describe('the pipelines a chart runs (charts)', () => {
  it('groups by a field within the query, the largest first, with the totals for "Other"', () => {
    expect(
      groupPipeline({ field: 'city', measure: 'sum', of: 'total', filter: { active: true }, top: 50 }),
    ).toEqual([
      { $match: { active: true } },
      {
        $facet: {
          groups: [
            {
              $group: {
                _id: '$city',
                count: { $sum: int(1) },
                sum: { $sum: '$total' },
                avg: { $avg: '$total' },
                min: { $min: '$total' },
                max: { $max: '$total' },
              },
            },
            { $sort: { sum: -1, _id: 1 } },
            { $limit: int(50) },
          ],
          total: [{ $group: { _id: null, count: { $sum: int(1) }, sum: { $sum: '$total' } } }],
        },
      },
    ])
    const [facet] = groupPipeline({ field: 'city', measure: 'count', filter: {}, top: 8 })
    expect(facet).toEqual({
      $facet: {
        groups: [
          { $group: { _id: '$city', count: { $sum: int(1) } } },
          { $sort: { count: -1, _id: 1 } },
          { $limit: int(8) },
        ],
        total: [{ $group: { _id: null, count: { $sum: int(1) } } }],
      },
    })
  })

  it('refuses a field path that is no field', () => {
    for (const field of ['$where', '', 'a..b', 'a.'])
      expect(() => groupPipeline({ field, measure: 'count', filter: {}, top: 5 }), field).toThrow()
    expect(() => scatterPipeline({ x: 'a', y: '$b', filter: {}, size: 10 })).toThrow()
  })

  it('reads the groups, the rest summed as "Other" where a sum means something', () => {
    const answer = [
      {
        groups: [
          { _id: 'Izmir', count: int(5), sum: { $numberDouble: '12.5' } },
          { _id: null, count: int(2), sum: int(0) },
        ],
        total: [{ _id: null, count: int(9), sum: { $numberDouble: '20' } }],
      },
    ]
    expect(readGroups(answer, 'count')).toEqual({
      rows: [
        { key: 'Izmir', count: 5, sum: 12.5, avg: null, min: null, max: null },
        { key: null, count: 2, sum: 0, avg: null, min: null, max: null },
      ],
      other: 2,
      rest: { count: 2, sum: 7.5 },
    })
    expect(readGroups(answer, 'sum').other).toBe(7.5)
    expect(readGroups(answer, 'avg').other).toBeNull()
    // The table still says what the rest holds (review M5).
    expect(readGroups(answer, 'avg').rest).toEqual({ count: 2, sum: 7.5 })
    expect(readGroups([{ groups: [], total: [] }], 'count')).toEqual({ rows: [], other: null, rest: null })
  })

  it('reads numbers of every kind, and nothing else', () => {
    expect(numberOf(int(3))).toBe(3)
    expect(numberOf({ $numberLong: '9' })).toBe(9)
    expect(numberOf({ $numberDecimal: '1.5' })).toBe(1.5)
    expect(numberOf({ $numberDouble: 'NaN' })).toBeNull()
    expect(numberOf('3')).toBeNull()
    expect(numberOf(null)).toBeNull()
  })

  it('counts over time by a period, dates only', () => {
    expect(timePipeline({ field: 'at', unit: 'month', measure: 'count', filter: {} })).toEqual([
      { $match: { at: { $type: 'date', $not: { $type: 'array' } } } },
      {
        $group: {
          _id: { $dateTrunc: { date: '$at', unit: 'month' } },
          count: { $sum: int(1) },
        },
      },
      { $sort: { _id: int(-1) } },
      // One more than the chart holds: the page tells exactly 1,000 periods from more.
      { $limit: int(1001) },
    ])
    expect(timePipeline({ field: 'at', unit: 'day', measure: 'avg', of: 'n', filter: { a: 1 } })[0]).toEqual({
      $match: { $and: [{ a: 1 }, { at: { $type: 'date', $not: { $type: 'array' } } }] },
    })
  })

  it('bins numbers by one width (not $bucketAuto’s equal counts), and samples points for a scatter', () => {
    const numbers = { price: { $type: 'number', $not: { $type: 'array' } } }
    expect(extentPipeline({ field: 'price', filter: { a: 1 } })).toEqual([
      { $match: { $and: [{ a: 1 }, numbers] } },
      { $group: { _id: null, min: { $min: '$price' }, max: { $max: '$price' } } },
    ])
    expect(binsPipeline({ field: 'price', filter: {}, start: 0, step: 2.5, bins: 4 })).toEqual([
      { $match: numbers },
      {
        $group: {
          _id: {
            $max: [
              int(0),
              {
                $min: [
                  int(3),
                  {
                    $floor: {
                      $divide: [
                        { $subtract: ['$price', { $numberDouble: '0.0' }] },
                        { $numberDouble: '2.5' },
                      ],
                    },
                  },
                ],
              },
            ],
          },
          count: { $sum: int(1) },
        },
      },
      { $sort: { _id: int(1) } },
      { $limit: int(4) },
    ])
    for (const bad of [
      { start: 0, step: 0, bins: 4 },
      { start: Number.NaN, step: 1, bins: 4 },
      { start: 0, step: 1, bins: 0 },
      { start: 0, step: 1, bins: 61 },
    ])
      expect(() => binsPipeline({ field: 'price', filter: {}, ...bad }), JSON.stringify(bad)).toThrow()
    expect(scatterPipeline({ x: 'a', y: 'b.c', filter: {}, size: 1000 })).toEqual([
      {
        $match: {
          $and: [
            { a: { $type: 'number', $not: { $type: 'array' } } },
            { 'b.c': { $type: 'number', $not: { $type: 'array' } } },
          ],
        },
      },
      { $sample: { size: int(1000) } },
      { $project: { _id: 0, x: '$a', y: '$b.c' } },
    ])
  })

  it('shows a group, a period or a bucket in Documents by values, never operators', () => {
    expect(rowFilter('city', 'Izmir', {})).toEqual({ city: { $eq: 'Izmir' } })
    // $group puts missing and null together: the filter finds both.
    expect(rowFilter('city', null, { a: 1 })).toEqual({ $and: [{ a: 1 }, { city: null }] })
    expect(rowFilter('meta', { $where: 'x' }, {})).toEqual({ meta: { $eq: { $where: 'x' } } })
    const start = Date.UTC(2026, 0, 31)
    expect(periodFilter('at', start, 'month', {})).toEqual({
      at: { $gte: { $date: '2026-01-31T00:00:00.000Z' }, $lt: { $date: '2026-02-28T00:00:00.000Z' } },
    })
    expect(bucketFilter('price', int(1), int(5), false, {})).toEqual({ price: { $gte: int(1), $lt: int(5) } })
    expect(bucketFilter('price', int(5), int(9), true, {})).toEqual({ price: { $gte: int(5), $lte: int(9) } })
  })

  it('finds the start of the next period in UTC', () => {
    const t = Date.UTC(2026, 9, 10, 13)
    expect(nextPeriod(t, 'hour')).toBe(Date.UTC(2026, 9, 10, 14))
    expect(nextPeriod(t, 'day')).toBe(Date.UTC(2026, 9, 11, 13))
    expect(nextPeriod(t, 'week')).toBe(Date.UTC(2026, 9, 17, 13))
    expect(nextPeriod(Date.UTC(2026, 11, 1), 'month')).toBe(Date.UTC(2027, 0, 1))
    expect(nextPeriod(Date.UTC(2026, 0, 1), 'year')).toBe(Date.UTC(2027, 0, 1))
  })
})

describe('the drawing (charts)', () => {
  it('chooses round ticks over the values', () => {
    expect(niceTicks(0, 97)).toEqual([0, 20, 40, 60, 80, 100])
    expect(niceTicks(0, 0)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1])
    expect(niceTicks(-12, 30)).toEqual([-20, -10, 0, 10, 20, 30])
    expect(niceTicks(0.2, 0.9)).toEqual([0.2, 0.4, 0.6, 0.8, 1])
  })

  it('never loops where doubles cannot step (beyond 2^53), and spreads a single value (review I2)', () => {
    for (const [min, max] of [
      [1e17, 1e17 + 16],
      [1e18, 1e18 + 128],
      [1e17, 1e17],
      [-5, -5],
      [7, 7],
    ]) {
      const ticks = niceTicks(min!, max!)
      expect(ticks.length, `${min}..${max}`).toBeGreaterThanOrEqual(2)
      expect(ticks.length, `${min}..${max}`).toBeLessThanOrEqual(50)
      expect(ticks[0]!, `${min}..${max}`).toBeLessThanOrEqual(min!)
      expect(ticks.at(-1)!, `${min}..${max}`).toBeGreaterThanOrEqual(max!)
      expect(new Set(ticks).size, `${min}..${max}`).toBe(ticks.length)
    }
  })

  it('maps values to positions', () => {
    const y = scaleLinear([0, 100], [200, 0])
    expect(y(0)).toBe(200)
    expect(y(50)).toBe(100)
    expect(scaleLinear([5, 5], [0, 10])(5)).toBe(0)
  })

  it('draws lines and donut segments', () => {
    expect(
      linePath([
        [0, 10],
        [5, 0],
      ]),
    ).toBe('M0 10L5 0')
    expect(linePath([])).toBe('')
    const half = arcPath(50, 50, 40, 20, 0, Math.PI)
    expect(half.startsWith('M50 10A40 40 0 0 1 50 90L50 70A20 20 0 0 0 50 30Z')).toBe(true)
    // A whole circle is drawn as two halves (one arc cannot close on itself).
    expect(arcPath(50, 50, 40, 20, 0, 2 * Math.PI).match(/A40/g)).toHaveLength(2)
  })
})
