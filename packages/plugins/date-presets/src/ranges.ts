/**
 * Date filters (research 2026-10-28: CUSTOMER-I-6571, Studio 3T's date tags): the ranges people
 * filter by — today, the last 7 days, this month — as [start, end) instants, in the browser's time
 * or in UTC, and the filter that selects a range on a date field, or on _id by its ObjectId's time.
 * Weeks start on Monday (ISO 8601).
 */
export type Preset =
  | 'today'
  | 'yesterday'
  | 'last24h'
  | 'last7d'
  | 'last30d'
  | 'thisWeek'
  | 'lastWeek'
  | 'thisMonth'
  | 'lastMonth'
  | 'thisYear'
export const PRESETS: Preset[] = [
  'today',
  'yesterday',
  'last24h',
  'last7d',
  'last30d',
  'thisWeek',
  'lastWeek',
  'thisMonth',
  'lastMonth',
  'thisYear',
]

export type Unit = 'hours' | 'days' | 'weeks' | 'months'
export const UNITS: Unit[] = ['hours', 'days', 'weeks', 'months']

export interface Range {
  /** Inclusive. */
  start: Date
  /** Exclusive. */
  end: Date
}

/** Calendar arithmetic in local time or in UTC, the same code either way. */
interface Calendar {
  parts(d: Date): { y: number; m: number; d: number; wd: number }
  at(y: number, m: number, d: number): Date
}
/**
 * The Date API reads a year below 100 as 19xx: such a day is made 400 years later (the calendar
 * repeats every 400 years, leap days and weekdays alike) and moved back (research plugins' review).
 */
const LOCAL: Calendar = {
  parts: (d) => ({ y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), wd: d.getDay() }),
  at: (y, m, d) => {
    if (y >= 100) return new Date(y, m, d)
    const t = new Date(y + 400, m, d)
    t.setFullYear(t.getFullYear() - 400)
    return t
  },
}
const UTC: Calendar = {
  parts: (d) => ({ y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay() }),
  at: (y, m, d) => {
    if (y >= 100) return new Date(Date.UTC(y, m, d))
    const t = new Date(Date.UTC(y + 400, m, d))
    t.setUTCFullYear(t.getUTCFullYear() - 400)
    return t
  },
}

const HOUR = 3_600_000

/** A preset's range at `now`. */
export function presetRange(preset: Preset, now: Date, utc = false): Range {
  const c = utc ? UTC : LOCAL
  const { y, m, d, wd } = c.parts(now)
  // Monday is the first day of the week: Sunday (0) is its seventh.
  const monday = d - ((wd + 6) % 7)
  switch (preset) {
    case 'today':
      return { start: c.at(y, m, d), end: c.at(y, m, d + 1) }
    case 'yesterday':
      return { start: c.at(y, m, d - 1), end: c.at(y, m, d) }
    case 'last24h':
      return { start: new Date(now.getTime() - 24 * HOUR), end: new Date(now.getTime()) }
    case 'last7d':
      return { start: c.at(y, m, d - 6), end: c.at(y, m, d + 1) }
    case 'last30d':
      return { start: c.at(y, m, d - 29), end: c.at(y, m, d + 1) }
    case 'thisWeek':
      return { start: c.at(y, m, monday), end: c.at(y, m, monday + 7) }
    case 'lastWeek':
      return { start: c.at(y, m, monday - 7), end: c.at(y, m, monday) }
    case 'thisMonth':
      return { start: c.at(y, m, 1), end: c.at(y, m + 1, 1) }
    case 'lastMonth':
      return { start: c.at(y, m - 1, 1), end: c.at(y, m, 1) }
    case 'thisYear':
      return { start: c.at(y, 0, 1), end: c.at(y + 1, 0, 1) }
  }
}

/** The last `n` hours (up to now), or the last `n` days, weeks or months (whole ones, today's included). */
export function lastRange(n: number, unit: Unit, now: Date, utc = false): Range {
  const c = utc ? UTC : LOCAL
  const { y, m, d } = c.parts(now)
  switch (unit) {
    case 'hours':
      return { start: new Date(now.getTime() - n * HOUR), end: new Date(now.getTime()) }
    case 'days':
      return { start: c.at(y, m, d - n + 1), end: c.at(y, m, d + 1) }
    case 'weeks':
      return { start: c.at(y, m, d - 7 * n + 1), end: c.at(y, m, d + 1) }
    case 'months':
      return { start: c.at(y, m - n + 1, 1), end: c.at(y, m + 1, 1) }
  }
}

/** From the start of one day to the end of another (`YYYY-MM-DD`, as a date field gives them); null when not a range. */
export function betweenRange(from: string, to: string, utc = false): Range | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/
  const a = day.exec(from)
  const b = day.exec(to)
  if (!a || !b) return null
  const c = utc ? UTC : LOCAL
  const day1 = [Number(a[1]), Number(a[2]) - 1, Number(a[3])] as const
  const day2 = [Number(b[1]), Number(b[2]) - 1, Number(b[3])] as const
  // A day that is none (the 31st of February) is not moved to the next month: it is refused.
  const real = ([y, m, d]: readonly [number, number, number]) => {
    const p = c.parts(c.at(y, m, d))
    return p.y === y && p.m === m && p.d === d
  }
  if (!real(day1) || !real(day2)) return null
  const start = c.at(...day1)
  const end = c.at(day2[0], day2[1], day2[2] + 1)
  if (end <= start) return null
  return { start, end }
}

export type Doc = Record<string, unknown>

const date = (d: Date): Doc => ({ $date: { $numberLong: String(d.getTime()) } })
/** The smallest ObjectId of a second: its time (1970 to 2106, as an ObjectId holds it), then zeros. */
const firstId = (d: Date): Doc => ({
  $oid: `${Math.min(0xffffffff, Math.max(0, Math.floor(d.getTime() / 1000)))
    .toString(16)
    .padStart(8, '0')}${'0'.repeat(16)}`,
})

/**
 * The filter selecting a range, as canonical Extended JSON: on a date field its dates, on _id (an
 * ObjectId) the ids made in it — an ObjectId begins with the second it was made.
 */
export function rangeFilter(field: string, range: Range, byId = false): Doc {
  if (byId) return { [field]: { $gte: firstId(range.start), $lt: firstId(range.end) } }
  return { [field]: { $gte: date(range.start), $lt: date(range.end) } }
}
