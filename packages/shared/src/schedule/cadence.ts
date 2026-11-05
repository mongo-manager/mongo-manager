// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Cadence, CadenceProblem } from '../api/schedules'
import { CronError, cronDay, parseCron } from './cron'
import { addDays, daysInMonth, instantOf, isoWeekday, wallOf, type CivilDate } from './zone'

export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000
/** Spec §1.3: at least one hour between runs. */
export const MIN_GAP_MS = HOUR_MS
/** Spec §1.3, D8: the next 50 runs are checked; the search looks at most five years ahead. */
export const PREVIEW_RUNS = 50
const MAX_DAYS = 5 * 366
/** Plan ruling 6: a run at most this late is the scheduled one, not a catch-up. */
export const GRACE_MS = 60_000
/** D8: a stop is counted to this many due times, no further. */
const SCAN = 2000

/** A cadence as wall times of a matching day. */
export interface CompiledCadence {
  times: Array<{ hour: number; minute: number }>
  day(d: CivilDate): boolean
}

const hm = (s: string) => ({ hour: Number(s.slice(0, 2)), minute: Number(s.slice(3, 5)) })
const byTime = (a: { hour: number; minute: number }, b: { hour: number; minute: number }) =>
  a.hour - b.hour || a.minute - b.minute

/** Throws CronError for an expression it cannot read. */
export function compileCadence(c: Cadence): CompiledCadence {
  switch (c.kind) {
    case 'hourly': {
      // Plan ruling 4: wall-clock hours 0, N, 2N … below 24.
      const times: CompiledCadence['times'] = []
      for (let hour = 0; hour < 24; hour += c.every) times.push({ hour, minute: c.minute })
      return { times, day: () => true }
    }
    case 'daily':
      return { times: [...new Set(c.times)].map(hm).sort(byTime), day: () => true }
    case 'weekly':
      return { times: [hm(c.time)], day: (d) => c.days.includes(isoWeekday(d)) }
    case 'monthly':
      return {
        times: [hm(c.time)],
        day: (d) => d.day === (c.day === 'last' ? daysInMonth(d.year, d.month) : c.day),
      }
    case 'cron': {
      const spec = parseCron(c.expression)
      const times = spec.hours.flatMap((hour) => spec.minutes.map((minute) => ({ hour, minute })))
      return { times, day: (d) => cronDay(spec, d) }
    }
  }
}

/**
 * The next `count` runs after `after`. A wall time a DST gap maps onto an earlier run's instant runs
 * once; with `minGapMs`, a run closer than that to the previous one (or to `lastRun`) is dropped
 * (plan ruling 3).
 */
export function nextRuns(
  c: CompiledCadence,
  zone: string,
  after: number,
  count: number,
  opts: { lastRun?: number; minGapMs?: number; until?: number } = {},
): number[] {
  const out: number[] = []
  let prev = opts.lastRun ?? Number.NEGATIVE_INFINITY
  const start = wallOf(after, zone)
  for (let i = 0; i <= MAX_DAYS && out.length < count; i++) {
    const d = addDays(start, i)
    if (!c.day(d)) continue
    for (const { hour, minute } of c.times) {
      const t = instantOf({ ...d, hour, minute }, zone)
      // Runs come in order: past `until` nothing more is wanted.
      if (opts.until !== undefined && t > opts.until) return out
      if (t <= after || t <= prev) continue
      if (opts.minGapMs && t - prev < opts.minGapMs) continue
      out.push(t)
      prev = t
      if (out.length >= count) break
    }
  }
  return out
}

/** The run after `after`, an hour at least from `lastRun`. */
export function nextRunAfter(
  c: CompiledCadence,
  zone: string,
  after: number,
  lastRun?: number,
): number | null {
  return (
    nextRuns(c, zone, after, 1, {
      minGapMs: MIN_GAP_MS,
      ...(lastRun !== undefined ? { lastRun } : {}),
    })[0] ?? null
  )
}

/**
 * Spec §1.3: refused when the cron is invalid, when it never runs within five years, or when two of
 * its next 50 runs are less than an hour apart — on the pattern, in UTC (plan ruling 3).
 */
export function cadenceProblem(c: Cadence, now: number): CadenceProblem | null {
  let compiled: CompiledCadence
  try {
    compiled = compileCadence(c)
  } catch (e) {
    if (e instanceof CronError)
      return { reason: 'cron', field: e.field, message: e.message, code: e.code, params: e.params }
    throw e
  }
  const runs = nextRuns(compiled, 'UTC', now, PREVIEW_RUNS)
  if (!runs.length) return { reason: 'never' }
  let min = Number.POSITIVE_INFINITY
  for (let i = 1; i < runs.length; i++) min = Math.min(min, runs[i]! - runs[i - 1]!)
  return min < MIN_GAP_MS ? { reason: 'min_gap', minutes: Math.round(min / 60_000) } : null
}

/** Due times in [from, to]: the latest exactly, how many came before it (bounded, D8). */
export function runsBetween(
  c: CompiledCadence,
  zone: string,
  from: number,
  to: number,
): { latest: number | null; earlier: number; more: boolean } {
  if (to < from) return { latest: null, earlier: 0, more: false }
  // A stop longer than 400 days is not walked from its start: only its end matters for a catch-up.
  const start = Math.max(from - 1, to - 400 * DAY_MS)
  const first = nextRuns(c, zone, start, SCAN, { minGapMs: MIN_GAP_MS, until: to })
  let inside = first
  let more = start > from - 1
  if (first.length === SCAN) {
    // A dense cadence: the latest is looked for near `to`.
    more = true
    inside = nextRuns(c, zone, Math.max(start, to - 2 * DAY_MS), SCAN, { minGapMs: MIN_GAP_MS, until: to })
  }
  const latest = inside.at(-1) ?? null
  return { latest, earlier: Math.max(0, (more ? first.length : inside.length) - 1), more }
}

export interface DueDecision {
  kind: 'scheduled' | 'catchup' | 'missed'
  dueAt: number
  /** Due times before `dueAt` that were missed (at least, when `more`). */
  earlier: number
  more: boolean
  nextRunAt: number | null
}

/**
 * Spec §1.3 "missed runs", plan ruling 6: the latest due time is run as scheduled when on time, as a
 * catch-up when no older than its own interval (capped at 24 h), and recorded missed otherwise.
 */
export function decideDue(c: CompiledCadence, zone: string, nextRunAt: number, now: number): DueDecision {
  const { latest, earlier, more } = runsBetween(c, zone, nextRunAt, now)
  if (latest === null)
    return { kind: 'missed', dueAt: nextRunAt, earlier: 0, more: true, nextRunAt: nextRunAfter(c, zone, now) }
  const next = nextRunAfter(c, zone, latest, latest)
  const late = now - latest
  const interval = Math.min(next === null ? DAY_MS : next - latest, DAY_MS)
  const kind = late <= GRACE_MS ? 'scheduled' : late <= interval ? 'catchup' : 'missed'
  return { kind, dueAt: latest, earlier, more, nextRunAt: next }
}

const REFERENCE = Date.UTC(2026, 0, 5)
/** A cadence's shortest gap between runs, on its pattern in UTC (for the Cold Storage warning). */
export function intervalOf(c: Cadence): number {
  const runs = nextRuns(compileCadence(c), 'UTC', REFERENCE, PREVIEW_RUNS)
  let min = Number.POSITIVE_INFINITY
  for (let i = 1; i < runs.length; i++) min = Math.min(min, runs[i]! - runs[i - 1]!)
  return Number.isFinite(min) ? min : 365 * DAY_MS
}
