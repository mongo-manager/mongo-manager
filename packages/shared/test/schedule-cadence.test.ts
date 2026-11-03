import { describe, expect, it } from 'vitest'
import {
  cadenceProblem,
  compileCadence,
  decideDue,
  instantOf,
  intervalOf,
  isoWeek,
  nextRuns,
  wallOf,
  type Cadence,
} from '../src/index'

const iso = (t: number) => new Date(t).toISOString()
const at = (s: string) => Date.parse(s)
const runs = (c: Cadence, zone: string, after: string, n: number) =>
  nextRuns(compileCadence(c), zone, at(after), n).map(iso)

describe('wall-clock time in a zone (phase 3d-3c spec §1.3)', () => {
  it('reads and makes wall times', () => {
    expect(wallOf(at('2026-07-01T00:30:00Z'), 'Europe/Berlin')).toEqual({
      year: 2026,
      month: 7,
      day: 1,
      hour: 2,
      minute: 30,
    })
    expect(iso(instantOf({ year: 2026, month: 1, day: 15, hour: 9, minute: 0 }, 'America/New_York'))).toBe(
      '2026-01-15T14:00:00.000Z',
    )
    expect(isoWeek({ year: 2026, month: 1, day: 1 })).toEqual({ year: 2026, week: 1 })
    expect(isoWeek({ year: 2027, month: 1, day: 1 })).toEqual({ year: 2026, week: 53 })
  })

  it('runs a skipped wall time once, at the first minute after the gap', () => {
    // Berlin springs forward 2026-03-29 02:00 → 03:00; New York 2026-03-08 02:00 → 03:00.
    expect(iso(instantOf({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, 'Europe/Berlin'))).toBe(
      '2026-03-29T01:00:00.000Z',
    )
    expect(iso(instantOf({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York'))).toBe(
      '2026-03-08T07:00:00.000Z',
    )
    expect(runs({ kind: 'daily', times: ['02:30'] }, 'Europe/Berlin', '2026-03-28T00:00:00Z', 3)).toEqual([
      '2026-03-28T01:30:00.000Z',
      '2026-03-29T01:00:00.000Z',
      '2026-03-30T00:30:00.000Z',
    ])
  })

  it('runs a repeated wall time once, at its first occurrence', () => {
    // Berlin falls back 2026-10-25 03:00 → 02:00; New York 2026-11-01 02:00 → 01:00.
    expect(iso(instantOf({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, 'Europe/Berlin'))).toBe(
      '2026-10-25T00:30:00.000Z',
    )
    expect(iso(instantOf({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York'))).toBe(
      '2026-11-01T05:30:00.000Z',
    )
    expect(runs({ kind: 'daily', times: ['02:30'] }, 'Europe/Berlin', '2026-10-24T12:00:00Z', 2)).toEqual([
      '2026-10-25T00:30:00.000Z',
      '2026-10-26T01:30:00.000Z',
    ])
  })

  it('never brings two hourly runs closer than an hour across a DST change', () => {
    const c = compileCadence({ kind: 'hourly', every: 1, minute: 30 })
    for (const [zone, from] of [
      ['Europe/Berlin', '2026-03-28T20:00:00Z'],
      ['Europe/Berlin', '2026-10-24T20:00:00Z'],
      ['America/New_York', '2026-03-08T01:00:00Z'],
      ['America/New_York', '2026-10-31T23:00:00Z'],
    ] as const) {
      const list = nextRuns(c, zone, at(from), 30, { minGapMs: 3_600_000 })
      expect(list).toHaveLength(30)
      for (let i = 1; i < list.length; i++)
        expect(list[i]! - list[i - 1]!, `${zone} ${iso(list[i]!)}`).toBeGreaterThanOrEqual(3_600_000)
    }
  })
})

describe('next runs (spec §1.3)', () => {
  it('follows each preset in its zone', () => {
    expect(runs({ kind: 'hourly', every: 6, minute: 15 }, 'UTC', '2026-05-01T00:20:00Z', 4)).toEqual([
      '2026-05-01T06:15:00.000Z',
      '2026-05-01T12:15:00.000Z',
      '2026-05-01T18:15:00.000Z',
      '2026-05-02T00:15:00.000Z',
    ])
    expect(
      runs({ kind: 'daily', times: ['14:30', '02:00'] }, 'Europe/Istanbul', '2026-05-01T00:00:00Z', 3),
    ).toEqual(['2026-05-01T11:30:00.000Z', '2026-05-01T23:00:00.000Z', '2026-05-02T11:30:00.000Z'])
    // 2026-05-01 is a Friday.
    expect(runs({ kind: 'weekly', days: [1, 5], time: '02:00' }, 'UTC', '2026-05-01T03:00:00Z', 3)).toEqual([
      '2026-05-04T02:00:00.000Z',
      '2026-05-08T02:00:00.000Z',
      '2026-05-11T02:00:00.000Z',
    ])
    expect(runs({ kind: 'monthly', day: 'last', time: '03:00' }, 'UTC', '2026-01-31T04:00:00Z', 3)).toEqual([
      '2026-02-28T03:00:00.000Z',
      '2026-03-31T03:00:00.000Z',
      '2026-04-30T03:00:00.000Z',
    ])
    expect(runs({ kind: 'monthly', day: 'last', time: '03:00' }, 'UTC', '2028-01-31T04:00:00Z', 1)).toEqual([
      '2028-02-29T03:00:00.000Z',
    ])
    expect(runs({ kind: 'cron', expression: '0 2 * * 1-5' }, 'UTC', '2026-05-01T03:00:00Z', 2)).toEqual([
      '2026-05-04T02:00:00.000Z',
      '2026-05-05T02:00:00.000Z',
    ])
  })

  it('stops at five years and at the asked count (D8)', () => {
    expect(runs({ kind: 'cron', expression: '0 0 30 2 *' }, 'UTC', '2026-01-01T00:00:00Z', 5)).toEqual([])
    expect(runs({ kind: 'cron', expression: '0 0 29 2 *' }, 'UTC', '2026-01-01T00:00:00Z', 50)).toEqual([
      '2028-02-29T00:00:00.000Z',
    ])
    expect(runs({ kind: 'hourly', every: 1, minute: 0 }, 'UTC', '2026-01-01T00:00:00Z', 3)).toHaveLength(3)
  })
})

describe('the one-hour rule (spec §1.3, D8)', () => {
  it('refuses runs closer than an hour, an invalid cron and one that never runs', () => {
    const now = at('2026-05-01T00:00:00Z')
    expect(cadenceProblem({ kind: 'hourly', every: 1, minute: 0 }, now)).toBeNull()
    expect(cadenceProblem({ kind: 'daily', times: ['02:00', '02:30'] }, now)).toEqual({
      reason: 'min_gap',
      minutes: 30,
    })
    expect(cadenceProblem({ kind: 'daily', times: ['23:30', '00:15'] }, now)).toEqual({
      reason: 'min_gap',
      minutes: 45,
    })
    expect(cadenceProblem({ kind: 'cron', expression: '*/30 * * * *' }, now)).toEqual({
      reason: 'min_gap',
      minutes: 30,
    })
    expect(cadenceProblem({ kind: 'cron', expression: '0 0 30 2 *' }, now)).toEqual({ reason: 'never' })
    expect(cadenceProblem({ kind: 'cron', expression: '61 * * * *' }, now)).toMatchObject({
      reason: 'cron',
      field: 'minute',
    })
  })
})

describe('what is due (spec §1.3 missed runs, plan ruling 6)', () => {
  const daily = compileCadence({ kind: 'daily', times: ['02:00'] })

  it('decides scheduled, catch-up and missed', () => {
    const next = at('2026-05-01T02:00:00Z')
    expect(decideDue(daily, 'UTC', next, at('2026-05-01T02:00:20Z'))).toEqual({
      kind: 'scheduled',
      dueAt: next,
      earlier: 0,
      more: false,
      nextRunAt: at('2026-05-02T02:00:00Z'),
    })
    // Down from before 02:00 until 09:00: one catch-up.
    expect(decideDue(daily, 'UTC', next, at('2026-05-01T09:00:00Z'))).toMatchObject({
      kind: 'catchup',
      dueAt: next,
      earlier: 0,
    })
    // Down for almost three days: the latest is run (within its day), two are missed.
    expect(decideDue(daily, 'UTC', next, at('2026-05-03T20:00:00Z'))).toMatchObject({
      kind: 'catchup',
      dueAt: at('2026-05-03T02:00:00Z'),
      earlier: 2,
      nextRunAt: at('2026-05-04T02:00:00Z'),
    })
    // A weekly run two days late is older than 24 hours: missed.
    const weekly = compileCadence({ kind: 'weekly', days: [1], time: '02:00' })
    expect(decideDue(weekly, 'UTC', at('2026-05-04T02:00:00Z'), at('2026-05-06T02:00:00Z'))).toMatchObject({
      kind: 'missed',
      dueAt: at('2026-05-04T02:00:00Z'),
      earlier: 0,
      nextRunAt: at('2026-05-11T02:00:00Z'),
    })
    // An hourly run half an hour late is within its interval; two hours late, the latest of three is.
    const hourly = compileCadence({ kind: 'hourly', every: 1, minute: 0 })
    expect(decideDue(hourly, 'UTC', at('2026-05-01T10:00:00Z'), at('2026-05-01T10:30:00Z'))).toMatchObject({
      kind: 'catchup',
    })
    expect(decideDue(hourly, 'UTC', at('2026-05-01T10:00:00Z'), at('2026-05-01T12:10:00Z'))).toMatchObject({
      kind: 'catchup',
      dueAt: at('2026-05-01T12:00:00Z'),
      earlier: 2,
    })
  })

  it('counts a long stop without walking all of it (D8)', () => {
    const hourly = compileCadence({ kind: 'hourly', every: 1, minute: 0 })
    expect(decideDue(hourly, 'UTC', at('2026-01-01T00:00:00Z'), at('2026-12-31T23:30:00Z'))).toMatchObject({
      kind: 'catchup',
      dueAt: at('2026-12-31T23:00:00Z'),
      more: true,
    })
  })

  it('measures a cadence by its shortest gap', () => {
    expect(intervalOf({ kind: 'daily', times: ['02:00', '14:00'] })).toBe(12 * 3_600_000)
    expect(intervalOf({ kind: 'weekly', days: [1], time: '02:00' })).toBe(7 * 86_400_000)
  })
})
