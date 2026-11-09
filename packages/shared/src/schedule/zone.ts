// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Phase 3d-3c spec §1.3: wall-clock times in an IANA zone, with Intl only (plan ruling 2). A time
 * skipped by DST becomes the first instant after the gap; a time that happens twice, its first one.
 */
export interface CivilDate {
  year: number
  month: number
  day: number
}
export interface Wall extends CivilDate {
  hour: number
  minute: number
}

const MINUTE = 60_000
const DAY = 86_400_000
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    })
    // D8: zones are validated before they get here; the cache stays bounded whatever arrives.
    if (formatters.size >= 64) formatters.clear()
    formatters.set(zone, f)
  }
  return f
}

/** D8: an IANA zone name Intl knows ("UTC", "Europe/Berlin"); nothing else reaches Intl. */
export function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || zone.length < 1 || zone.length > 64) return false
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(zone)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** The wall clock in `zone` at instant `t` (to the minute). */
export function wallOf(t: number, zone: string): Wall {
  const parts = formatter(zone).formatToParts(new Date(t))
  const n = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value)
  return { year: n('year'), month: n('month'), day: n('day'), hour: n('hour') % 24, minute: n('minute') }
}

/** A wall time as a number that orders like it (its digits read as UTC). */
export const wallKey = (w: Wall): number => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute)

const floorMinute = (t: number) => Math.floor(t / MINUTE) * MINUTE
/** The zone's offset east of UTC at instant `t`, in ms. */
export const offsetAt = (t: number, zone: string): number => wallKey(wallOf(t, zone)) - floorMinute(t)

/** The instant of a wall time: its first occurrence, or the first minute after a DST gap. */
export function instantOf(w: Wall, zone: string): number {
  const guess = wallKey(w)
  const offsets = [
    ...new Set([offsetAt(guess - DAY, zone), offsetAt(guess, zone), offsetAt(guess + DAY, zone)]),
  ]
  const hits = offsets.map((o) => guess - o).filter((t) => wallKey(wallOf(t, zone)) === guess)
  if (hits.length) return Math.min(...hits)
  // Skipped: between `lo` (its wall clock before w) and `hi` (after w) the clock jumped over w.
  let lo = guess - Math.max(...offsets)
  let hi = guess - Math.min(...offsets)
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / (2 * MINUTE)) * MINUTE
    if (wallKey(wallOf(mid, zone)) > guess) hi = mid
    else lo = mid
  }
  return hi
}

export function addDays(d: CivilDate, n: number): CivilDate {
  const x = new Date(Date.UTC(d.year, d.month - 1, d.day + n))
  return { year: x.getUTCFullYear(), month: x.getUTCMonth() + 1, day: x.getUTCDate() }
}

export const daysInMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate()

/** 1 Monday … 7 Sunday. */
export const isoWeekday = (d: CivilDate): number =>
  ((new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() + 6) % 7) + 1

/** ISO 8601 week: the year of its Thursday, and its number. */
export function isoWeek(d: CivilDate): { year: number; week: number } {
  const thursday = new Date(Date.UTC(d.year, d.month - 1, d.day + 4 - isoWeekday(d)))
  const year = thursday.getUTCFullYear()
  return { year, week: Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY / 7) + 1 }
}
