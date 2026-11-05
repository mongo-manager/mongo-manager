// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { RETENTION_PRESETS, type RetentionPolicy, type RetentionPreset } from '../api/schedules'
import { addDays, isoWeek, wallOf, type CivilDate } from './zone'

const DAY = 86_400_000

/** A complete, verified backup at one location (spec §1.4), with its dump's start (plan ruling 17). */
export interface RetentionItem {
  id: string
  at: number
}

const dayKey = (d: CivilDate) => `${d.year}-${d.month}-${d.day}`
const weekKey = (d: CivilDate) => {
  const w = isoWeek(d)
  return `${w.year}-W${w.week}`
}
const monthKey = (d: CivilDate) => `${d.year}-${d.month}`

/**
 * Spec §1.4: the newest `last`; the newest of each of the last `daily` calendar days, `weekly` ISO
 * weeks and `monthly` months (in the schedule's zone, today included). A backup stays when any tier
 * keeps it; the newest always stays. Both lists newest first.
 */
export function retain(
  items: RetentionItem[],
  policy: RetentionPolicy,
  zone: string,
  now: number,
): { keep: string[]; remove: string[] } {
  const sorted = [...items].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  const keep = new Set(sorted.slice(0, Math.max(1, policy.last)).map((i) => i.id))
  const today = wallOf(now, zone)
  const window = (count: number, key: (d: CivilDate) => string, step: (i: number) => CivilDate) =>
    new Set(Array.from({ length: count }, (_, i) => key(step(i))))
  const tiers = [
    { keys: window(policy.daily, dayKey, (i) => addDays(today, -i)), key: dayKey },
    { keys: window(policy.weekly, weekKey, (i) => addDays(today, -7 * i)), key: weekKey },
    {
      keys: window(policy.monthly, monthKey, (i) => {
        const m = today.month - 1 - i
        return { year: today.year + Math.floor(m / 12), month: (((m % 12) + 12) % 12) + 1, day: 1 }
      }),
      key: monthKey,
    },
  ].map((t) => ({ ...t, seen: new Set<string>() }))
  // Newest first: the first item of a day, week or month is its newest.
  for (const item of sorted) {
    const d = wallOf(item.at, zone)
    for (const tier of tiers) {
      const k = tier.key(d)
      if (tier.keys.has(k) && !tier.seen.has(k)) {
        tier.seen.add(k)
        keep.add(item.id)
      }
    }
  }
  return {
    keep: sorted.filter((i) => keep.has(i.id)).map((i) => i.id),
    remove: sorted.filter((i) => !keep.has(i.id)).map((i) => i.id),
  }
}

/** The preset a policy is, or "custom". */
export function presetOf(p: RetentionPolicy): RetentionPreset {
  for (const [name, preset] of Object.entries(RETENTION_PRESETS))
    if (
      preset.last === p.last &&
      preset.daily === p.daily &&
      preset.weekly === p.weekly &&
      preset.monthly === p.monthly
    )
      return name as RetentionPreset
  return 'custom'
}

/**
 * Spec §1.4 (Cold Storage): about how many days the policy keeps its shortest-lived backup. Below a
 * day's cadence a backup that is not its day's newest goes after `last` runs; from a day on, every
 * backup is its day's newest and the daily tier holds it too.
 */
export function shortestKeepDays(p: RetentionPolicy, intervalMs: number): number {
  const byLast = (p.last * intervalMs) / DAY
  return intervalMs >= DAY ? Math.max(byLast, p.daily) : byLast
}
