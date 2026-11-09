// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import {
  RETENTION_PRESETS,
  addDays,
  presetOf,
  retain,
  shortestKeepDays,
  wallOf,
  type RetentionItem,
} from '../src/index'

const DAY = 86_400_000
const now = Date.parse('2026-06-30T12:00:00Z')
/** One backup a day at 02:00 UTC, today and `days - 1` days before. */
const daily = (days: number): RetentionItem[] =>
  Array.from({ length: days }, (_, i) => ({
    id: new Date(Date.parse('2026-06-30T02:00:00Z') - i * DAY).toISOString().slice(0, 10),
    at: Date.parse('2026-06-30T02:00:00Z') - i * DAY,
  }))
/** mulberry32: the same seed gives the same inputs on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('retention (phase 3d-3c spec §1.4)', () => {
  it('keeps the newest N, then the newest of each day, ISO week and month in the window', () => {
    const { keep, remove } = retain(daily(400), { last: 3, daily: 7, weekly: 4, monthly: 3 }, 'UTC', now)
    // 2026-06-30 is a Tuesday: its ISO week starts on 06-29.
    expect(keep).toEqual([
      '2026-06-30',
      '2026-06-29',
      '2026-06-28',
      '2026-06-27',
      '2026-06-26',
      '2026-06-25',
      '2026-06-24',
      '2026-06-21',
      '2026-06-14',
      '2026-05-31',
      '2026-04-30',
    ])
    expect(remove).toHaveLength(400 - 11)
  })

  it('counts days, weeks and months in the schedule’s zone', () => {
    // 23:30 UTC on 06-29 is 06-30 in Tokyo: one Tokyo day holds two backups, the newer stays.
    const items = [
      { id: 'a', at: Date.parse('2026-06-29T23:30:00Z') },
      { id: 'b', at: Date.parse('2026-06-30T03:00:00Z') },
    ]
    expect(retain(items, { last: 1, daily: 2, weekly: 0, monthly: 0 }, 'Asia/Tokyo', now).remove).toEqual([
      'a',
    ])
    expect(retain(items, { last: 1, daily: 2, weekly: 0, monthly: 0 }, 'UTC', now).remove).toEqual([])
  })

  it('always keeps the newest, keeps what each tier promises, and removes idempotently (property)', () => {
    const r = rng(7)
    const zones = ['UTC', 'Europe/Berlin', 'America/New_York', 'Asia/Tokyo']
    for (let round = 0; round < 200; round++) {
      const items = Array.from({ length: Math.floor(r() * 120) }, (_, i) => ({
        id: `b${i}`,
        at: now - Math.floor(r() * 500 * DAY),
      }))
      const policy = {
        last: 1 + Math.floor(r() * 10),
        daily: Math.floor(r() * 30),
        weekly: Math.floor(r() * 10),
        monthly: Math.floor(r() * 12),
      }
      const zone = zones[round % zones.length]!
      const { keep, remove } = retain(items, policy, zone, now)
      expect(new Set([...keep, ...remove]).size).toBe(items.length)
      const newestFirst = [...items].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1))
      if (items.length) expect(keep[0]).toBe(newestFirst[0]!.id)
      expect(keep.length).toBeGreaterThanOrEqual(Math.min(policy.last, items.length))
      const today = wallOf(now, zone)
      for (let d = 0; d < policy.daily; d++) {
        const day = addDays(today, -d)
        const newestThatDay = newestFirst.find((i) => {
          const w = wallOf(i.at, zone)
          return w.year === day.year && w.month === day.month && w.day === day.day
        })
        if (newestThatDay) expect(keep, `${zone} day -${d}`).toContain(newestThatDay.id)
      }
      const again = retain(
        items.filter((i) => keep.includes(i.id)),
        policy,
        zone,
        now,
      )
      expect(again.remove).toEqual([])
    }
  })

  it('names presets and measures the shortest time a backup is kept', () => {
    expect(presetOf(RETENTION_PRESETS.standard)).toBe('standard')
    expect(presetOf({ ...RETENTION_PRESETS.long })).toBe('long')
    expect(presetOf({ last: 7, daily: 14, weekly: 8, monthly: 11 })).toBe('custom')
    expect(shortestKeepDays({ last: 7, daily: 30, weekly: 0, monthly: 0 }, DAY)).toBe(30)
    expect(shortestKeepDays({ last: 7, daily: 0, weekly: 0, monthly: 0 }, DAY)).toBe(7)
    expect(shortestKeepDays({ last: 7, daily: 30, weekly: 0, monthly: 0 }, 6 * 3_600_000)).toBeCloseTo(1.75)
  })
})
