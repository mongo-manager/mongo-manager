import { describe, expect, it } from 'vitest'
import { bucketFilter, countOf, countPipeline, duration, ttlIndexes, type TtlIndex } from '../src/ttl'

const int = (n: number) => ({ $numberInt: String(n) })
const d = (ms: number) => ({ $date: { $numberLong: String(ms) } })
const NOW = Date.UTC(2026, 9, 28, 12)
const HOUR = 3_600_000

describe('the TTL indexes of a collection', () => {
  it('are those with expireAfterSeconds on one field, with their partial filter', () => {
    expect(
      ttlIndexes([
        { name: '_id_', key: { _id: int(1) }, options: {} },
        { name: 'createdAt_1', key: { createdAt: int(1) }, options: { expireAfterSeconds: int(3600) } },
        {
          name: 'at_1',
          key: { at: int(1) },
          options: { expireAfterSeconds: { $numberLong: '0' }, partialFilterExpression: { kind: 'temp' } },
        },
        { name: 'a_1_b_1', key: { a: int(1), b: int(1) }, options: { expireAfterSeconds: int(5) } },
        { name: 'neg', key: { x: int(1) }, options: { expireAfterSeconds: int(-1) } },
        { name: 'plain', key: { y: int(1) }, options: { expireAfterSeconds: 'soon' } },
      ]),
    ).toEqual([
      { name: 'createdAt_1', field: 'createdAt', after: 3600, partial: null },
      { name: 'at_1', field: 'at', after: 0, partial: { kind: 'temp' } },
    ])
  })
})

describe('the documents of each bucket', () => {
  const ttl: TtlIndex = { name: 'c', field: 'createdAt', after: 3600, partial: null }
  // The field's date expiring now.
  const t = NOW - HOUR

  it('by the field’s earliest date: past expiry, in the next hour, day, week, later, and never', () => {
    // A date before the bucket's end, none before its start: the earliest falls in it, for an
    // array of dates too, whose earliest TTL acts on (review I3; checked on a real MongoDB).
    expect(bucketFilter(ttl, 'waiting', NOW)).toEqual({ createdAt: { $lt: d(t) } })
    expect(bucketFilter(ttl, 'hour', NOW)).toEqual({ createdAt: { $lt: d(t + HOUR), $not: { $lt: d(t) } } })
    expect(bucketFilter(ttl, 'day', NOW)).toEqual({
      createdAt: { $lt: d(t + 24 * HOUR), $not: { $lt: d(t + HOUR) } },
    })
    expect(bucketFilter(ttl, 'week', NOW)).toEqual({
      createdAt: { $lt: d(t + 168 * HOUR), $not: { $lt: d(t + 24 * HOUR) } },
    })
    expect(bucketFilter(ttl, 'later', NOW)).toEqual({
      createdAt: { $gte: d(t + 168 * HOUR), $not: { $lt: d(t + 168 * HOUR) } },
    })
    expect(bucketFilter(ttl, 'never', NOW)).toEqual({ createdAt: { $not: { $type: 'date' } } })
  })

  it('within a partial index’s filter, and never outside it', () => {
    const partial = { ...ttl, partial: { kind: 'temp' } }
    expect(bucketFilter(partial, 'hour', NOW)).toEqual({
      $and: [{ kind: 'temp' }, { createdAt: { $lt: d(t + HOUR), $not: { $lt: d(t) } } }],
    })
    expect(bucketFilter(partial, 'never', NOW)).toEqual({
      $or: [{ $nor: [{ kind: 'temp' }] }, { createdAt: { $not: { $type: 'date' } } }],
    })
  })

  it('counted by a pipeline whose answer may hold no document', () => {
    expect(countPipeline({ a: 1 })).toEqual([{ $match: { a: 1 } }, { $count: 'n' }])
    expect(countOf([{ n: int(12) }])).toBe(12)
    expect(countOf([{ n: { $numberLong: '7' } }])).toBe(7)
    expect(countOf([])).toBe(0)
  })
})

describe('a duration in words', () => {
  it('says the largest whole unit, and the field’s own date for 0', () => {
    expect(duration(3600, 'en')).toBe('1 hour after it')
    expect(duration(7200, 'en')).toBe('2 hours after it')
    expect(duration(86_400 * 30, 'en')).toBe('30 days after it')
    expect(duration(604_800, 'en')).toBe('1 week after it')
    expect(duration(90, 'en')).toBe('90 seconds after it')
    expect(duration(0, 'en')).toBe('at the field’s date')
    expect(duration(3600, 'tr')).toBe('1 saat sonra')
    expect(duration(0, 'tr')).toBe('alandaki tarihte')
  })
})
