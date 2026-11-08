// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import {
  addDays,
  compileCadence,
  instantOf,
  intervalOf,
  nextRuns,
  retain,
  wallOf,
  type Cadence,
  type RetentionPolicy,
} from '@mongo-manager/shared/browser'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/**
 * Spec §5 "a timeline preview of what stays": the cadence's backups over the policy's horizon, run
 * through the same retention the server applies; the ages (ms before `now`) of the kept ones. Older
 * days are one backup each — only a day's newest can stay past the "last" tier. Null for a cadence
 * that cannot be read. Final review minor 22: the timeline and the editor's space estimate share it.
 */
export function keptAges(
  retention: RetentionPolicy,
  cadence: Cadence,
  timeZone: string,
  now: number,
): number[] | null {
  let compiled: ReturnType<typeof compileCadence>
  let interval: number
  try {
    compiled = compileCadence(cadence)
    interval = intervalOf(cadence)
  } catch {
    return null
  }
  const r = retention
  const horizon = Math.min(5 * 366, Math.max(r.daily, r.weekly * 7, r.monthly * 31, 1) + 31) * DAY
  const recentFrom = now - Math.min(horizon, (r.last + 1) * interval + DAY)
  const items = nextRuns(compiled, timeZone, recentFrom, 400, { minGapMs: HOUR, until: now }).map((at) => ({
    id: `r${at}`,
    at,
  }))
  const lastTime = compiled.times.at(-1)
  const start = wallOf(recentFrom, timeZone)
  for (let i = 1; lastTime && i <= horizon / DAY; i++) {
    const day = addDays(start, -i)
    if (!compiled.day(day)) continue
    const at = instantOf({ ...day, ...lastTime }, timeZone)
    if (at < now - horizon) break
    items.push({ id: `d${at}`, at })
  }
  const keep = new Set(retain(items, r, timeZone, now).keep)
  return items.filter((i) => keep.has(i.id)).map((i) => now - i.at)
}
