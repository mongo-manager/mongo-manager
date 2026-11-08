// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'

// Research plugins' review (minor): local days across a daylight saving change, in a zone that has
// one whose midnight does not exist — Santiago moves its clocks from 00:00 to 01:00 on the first
// Sunday of September. Each test file runs in a process of its own.
process.env.TZ = 'America/Santiago'
const { presetRange, lastRange } = await import('../src/ranges')

describe('local days across a daylight saving change (America/Santiago)', () => {
  it('starts a day whose midnight does not exist at its first hour, and gives it 23 hours', () => {
    const noon = new Date(2026, 8, 6, 12)
    expect(noon.getTimezoneOffset()).toBe(180)
    const today = presetRange('today', noon)
    expect([today.start.getDate(), today.start.getHours()]).toEqual([6, 1])
    expect([today.end.getDate(), today.end.getHours()]).toEqual([7, 0])
    expect(today.end.getTime() - today.start.getTime()).toBe(23 * 3_600_000)
  })

  it('counts calendar days, not 24-hour steps, back across the change', () => {
    const after = new Date(2026, 8, 8, 12)
    const week = lastRange(3, 'days', after)
    expect([week.start.getDate(), week.start.getHours()]).toEqual([6, 1])
    expect([week.end.getDate(), week.end.getHours()]).toEqual([9, 0])
    // The last 24 hours are 24 hours whatever the clocks did.
    const day = presetRange('last24h', new Date(2026, 8, 6, 12))
    expect(day.end.getTime() - day.start.getTime()).toBe(24 * 3_600_000)
  })
})
