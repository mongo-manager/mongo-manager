// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { CronError, cronDay, parseCron } from '../src/index'

const field = (expression: string): string | null => {
  try {
    parseCron(expression)
    return 'ok'
  } catch (e) {
    expect(e).toBeInstanceOf(CronError)
    return (e as CronError).field
  }
}

describe('cron expressions (phase 3d-3c spec §1.3, D8)', () => {
  it('reads values, lists, ranges, steps and names', () => {
    const c = parseCron('0,30 2-4 */10 JAN,jul mon-FRI')
    expect(c.minutes).toEqual([0, 30])
    expect(c.hours).toEqual([2, 3, 4])
    expect(c.daysOfMonth).toEqual([1, 11, 21, 31])
    expect(c.months).toEqual([1, 7])
    expect(c.daysOfWeek).toEqual([1, 2, 3, 4, 5])
    expect(c).toMatchObject({ domStar: true, dowStar: false })
    expect(parseCron('5/20 * * * *').minutes).toEqual([5, 25, 45])
    expect(parseCron('0 0 * * 7').daysOfWeek).toEqual([0])
    expect(parseCron('0 0 * * 0-7').daysOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(parseCron('  15   3  *  *  *  ').hours).toEqual([3])
    expect(parseCron('0 0 1-10/3 * *').daysOfMonth).toEqual([1, 4, 7, 10])
  })

  it('refuses what it does not support, naming the field', () => {
    expect(field('@daily')).toBe(null)
    expect(field('@reboot')).toBe(null)
    expect(field('0 0 * *')).toBe(null)
    expect(field('0 0 * * * *')).toBe(null)
    expect(field('60 * * * *')).toBe('minute')
    expect(field('* 24 * * *')).toBe('hour')
    expect(field('* * 0 * *')).toBe('dayOfMonth')
    expect(field('* * 32 * *')).toBe('dayOfMonth')
    expect(field('* * L * *')).toBe('dayOfMonth')
    expect(field('* * * 13 *')).toBe('month')
    expect(field('* * * FOO *')).toBe('month')
    expect(field('* * * * 8')).toBe('dayOfWeek')
    expect(field('* * * * 1#2')).toBe('dayOfWeek')
    expect(field('5-1 * * * *')).toBe('minute')
    expect(field('*/0 * * * *')).toBe('minute')
    expect(field('*/61 * * * *')).toBe('minute')
    expect(field('1,,2 * * * *')).toBe('minute')
    expect(field('-1 * * * *')).toBe('minute')
  })

  it('bounds the expression and its lists (D8)', () => {
    expect(field('0 '.repeat(101))).toBe(null)
    expect(() => parseCron(`${Array.from({ length: 61 }, (_, i) => i % 60).join(',')} * * * *`)).toThrow(
      /60 items/,
    )
  })

  it('combines day of month and day of week with OR, as Vixie cron', () => {
    // 2026-03-13 is a Friday, 2026-03-06 a Friday, 2026-03-14 a Saturday, 2026-03-03 a Tuesday.
    const both = parseCron('0 0 13 * FRI')
    expect(cronDay(both, { year: 2026, month: 3, day: 13 })).toBe(true)
    expect(cronDay(both, { year: 2026, month: 3, day: 6 })).toBe(true)
    expect(cronDay(both, { year: 2026, month: 3, day: 14 })).toBe(false)
    expect(cronDay(parseCron('0 0 13 * *'), { year: 2026, month: 3, day: 6 })).toBe(false)
    expect(cronDay(parseCron('0 0 * * FRI'), { year: 2026, month: 3, day: 13 })).toBe(true)
    // A field written from "*" does not restrict: both must match (plan ruling 5).
    expect(cronDay(parseCron('0 0 */2 * FRI'), { year: 2026, month: 3, day: 3 })).toBe(false)
    expect(cronDay(parseCron('0 0 1 2 *'), { year: 2026, month: 3, day: 1 })).toBe(false)
  })
})

// Final review minor 2: each refusal carries a code and its values, so the web says it in TR too.
describe('cron refusals as codes', () => {
  const problem = (expression: string) => {
    try {
      parseCron(expression)
    } catch (e) {
      const err = e as CronError
      return { field: err.field, code: err.code, params: err.params }
    }
    return null
  }
  it('names the field, the kind of problem and its values', () => {
    expect(problem('x * * * *')).toEqual({ field: 'minute', code: 'not_number', params: { text: 'x' } })
    expect(problem('0 0 * FOO *')).toEqual({
      field: 'month',
      code: 'not_name_or_number',
      params: { text: 'FOO' },
    })
    expect(problem('0 25 * * *')).toEqual({
      field: 'hour',
      code: 'out_of_range',
      params: { n: 25, min: 0, max: 23 },
    })
    expect(problem('0 0 5-1 * *')).toEqual({
      field: 'dayOfMonth',
      code: 'backwards',
      params: { range: '5-1' },
    })
    expect(problem('*/0 * * * *')).toEqual({
      field: 'minute',
      code: 'bad_step',
      params: { step: '0', max: 59 },
    })
    expect(problem('0 0 ? * *')).toEqual({ field: 'dayOfMonth', code: 'not_item', params: { item: '?' } })
    expect(problem('@daily')).toEqual({ field: null, code: 'shortcut', params: {} })
    expect(problem('0 0 * *')).toEqual({ field: null, code: 'fields', params: {} })
    expect(problem('0'.repeat(201))).toEqual({ field: null, code: 'too_long', params: { max: 200 } })
    expect(problem(`${Array.from({ length: 61 }, (_, i) => i % 60).join(',')} * * * *`)).toEqual({
      field: 'minute',
      code: 'too_many',
      params: { max: 60 },
    })
  })
})
