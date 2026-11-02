/**
 * Plugins wave 3 (spec §8a, Compass feedback "dates in local time instead of UTC"): a date as the
 * user reads it — in their browser's time zone or the one set — with its offset from UTC, and how
 * long ago it was if asked. Text only, in the app's language.
 */

import { langTag, pick, shown, type Language } from '../../kit/src/i18n'

export interface LocalTimeOptions {
  /** An IANA zone; empty, or not a zone, is the browser's. */
  timeZone: string
  relative: boolean
  now: number
}

/** The earliest and latest dates told (the app shows others as they are). */
const FIRST = Date.UTC(1900, 0, 1)
const LAST = Date.UTC(2200, 0, 1)

/**
 * The zone as the user wrote it, if the browser knows it (named as written: the browser may name
 * Asia/Kolkata by its older name), else null.
 */
export function zoneOrNull(zone: string): string | null {
  const name = zone.trim()
  if (!name) return null
  try {
    new Intl.DateTimeFormat('en', { timeZone: name })
    return name
  } catch {
    return null
  }
}

/** A date's milliseconds from canonical or relaxed Extended JSON, or null. */
function msOf(value: unknown): number | null {
  if (!value || typeof value !== 'object' || !('$date' in value)) return null
  const d = (value as { $date: unknown }).$date
  const ms =
    typeof d === 'string'
      ? Date.parse(d)
      : d && typeof d === 'object' && typeof (d as { $numberLong?: unknown }).$numberLong === 'string'
        ? Number((d as { $numberLong: string }).$numberLong)
        : typeof d === 'number'
          ? d
          : NaN
  return Number.isFinite(ms) && ms >= FIRST && ms < LAST ? ms : null
}

/**
 * The offset from UTC at that moment in that zone: "UTC+3", "UTC+5:30", "UTC-4", "UTC" — and an old
 * local mean time's seconds, "UTC+1:56:56" (wave 3 review: they were cut).
 */
export function utcOffset(ms: number, zone: string | undefined): string {
  const part = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(ms)
    .find((p) => p.type === 'timeZoneName')?.value
  const m = /GMT([+-])(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(part ?? '')
  const seconds = m?.[4] && m[4] !== '00' ? m[4] : null
  if (!m || (Number(m[2]) === 0 && m[3] === '00' && !seconds)) return 'UTC'
  const hours = Number(m[2])
  return `UTC${m[1]}${hours}${m[3] === '00' && !seconds ? '' : `:${m[3]}`}${seconds ? `:${seconds}` : ''}`
}

/** The names of UTC itself: such a zone is named once, "(UTC)" (wave 3 review: "(UTC, UTC)"). */
const UTC_NAMES = new Set(
  ['UTC', 'UCT', 'GMT', 'GMT0', 'GMT+0', 'GMT-0', 'Zulu', 'Universal', 'Greenwich'].flatMap((n) => [
    n.toUpperCase(),
    `ETC/${n.toUpperCase()}`,
  ]),
)

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['week', 7 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
  ['second', 1000],
]

/**
 * When a unit, rounded, reaches the next one up, it is said in that one (wave 3 review: "24 hours
 * ago", "12 months ago"): 60 seconds, 60 minutes, 24 hours, 7 days, 4 weeks, 12 months.
 */
const UP: Partial<Record<Intl.RelativeTimeFormatUnit, [Intl.RelativeTimeFormatUnit, number]>> = {
  second: ['minute', 60],
  minute: ['hour', 60],
  hour: ['day', 24],
  day: ['week', 7],
  week: ['month', 4],
  month: ['year', 12],
}

const DAY = 86_400_000
/** Closer than this, a time is said in hours or minutes even across midnight ("20 minutes ago"). */
const NEAR = 6 * 3_600_000
/** The day a moment falls on in the zone shown, as a count of days. */
function dayOf(ms: number, zone: string | undefined): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(ms)
  const part = (type: string) => Number(parts.find((x) => x.type === type)?.value)
  return Math.round(Date.UTC(part('year'), part('month') - 1, part('day')) / DAY)
}

/**
 * "3 days ago", "in 2 hours": the largest unit it is at least one of. Wave 3 second review: within a
 * week, days are calendar days in the zone shown — "yesterday" is the day before there, never 23
 * hours earlier the same day; the same day (or within a few hours across midnight) says hours.
 */
function relativeOf(ms: number, now: number, locale: string, zone?: string): string {
  const diff = ms - now
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (Math.abs(diff) < 7 * DAY) {
    const days = dayOf(ms, zone) - dayOf(now, zone)
    if (days !== 0 && Math.abs(diff) >= NEAR && Math.abs(days) < 7) return format.format(days, 'day')
    if (Math.abs(diff) < DAY) {
      const [unit, size] = UNITS.slice(4).find(([, s]) => Math.abs(diff) >= s) ?? UNITS[UNITS.length - 1]!
      let n = Math.round(diff / size)
      // Within the day: never rounded up to one (23.6 hours is 23 hours, not a day).
      if (unit === 'hour' && Math.abs(n) >= 24) n = Math.sign(n) * 23
      else if (unit !== 'hour' && Math.abs(n) >= 60)
        return format.format(Math.sign(n), unit === 'second' ? 'minute' : 'hour')
      return format.format(n, unit)
    }
  }
  let [unit, size] = UNITS.find(([, s]) => Math.abs(diff) >= s) ?? UNITS[UNITS.length - 1]!
  let n = Math.round(diff / size)
  for (let up = UP[unit]; up && Math.abs(n) >= up[1]; up = UP[unit]) {
    unit = up[0]
    size = UNITS.find(([u]) => u === unit)![1]
    n = Math.round(diff / size)
  }
  return format.format(n, unit)
}

/** What a cell may show: the app shows at most 80 characters. */
const CELL_CHARS = 80
export const UNKNOWN_ZONE = {
  en: (name) => `unknown zone "${name}"`,
  tr: (name) => `bilinmeyen saat dilimi "${name}"`,
  zh: (name) => `未知时区“${name}”`,
  ja: (name) => `不明なタイムゾーン "${name}"`,
  es: (name) => `zona horaria desconocida "${name}"`,
  pt: (name) => `fuso horário desconhecido "${name}"`,
  ko: (name) => `알 수 없는 시간대 "${name}"`,
  de: (name) => `unbekannte Zeitzone „${name}“`,
  fr: (name) => `fuseau horaire inconnu « ${name} »`,
  ru: (name) => `неизвестный часовой пояс «${name}»`,
} satisfies Record<Language, (name: string) => string>
const unknownZone = (locale: string, name: string) => pick(UNKNOWN_ZONE, locale)(name)

/** The date in local time, or null for what is no date (or one out of range). */
export function localTime(value: unknown, app: string, options: LocalTimeOptions): string | null {
  const locale = langTag(shown(UNKNOWN_ZONE, app))
  const ms = msOf(value)
  if (ms === null) return null
  const zone = zoneOrNull(options.timeZone) ?? undefined
  const when = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: zone,
  }).format(ms)
  const offset = utcOffset(ms, zone)
  const named = zone && !(UTC_NAMES.has(zone.toUpperCase()) && offset === 'UTC') ? `${zone}, ` : ''
  const text = `${when} (${named}${offset})`
  const told = options.relative ? `${text} · ${relativeOf(ms, options.now, locale, zone)}` : text
  // A zone set that the browser does not know is said, the browser's used instead (wave 3 review:
  // a mistyped zone fell back without a word) — its name cut to stay within a cell's 80 characters.
  const asked = options.timeZone.trim()
  if (!asked || zone) return told
  const room = CELL_CHARS - told.length - 3 - unknownZone(app, '').length
  const name = asked.length <= room ? asked : `${asked.slice(0, Math.max(1, room - 1))}…`
  return `${told} · ${unknownZone(app, name)}`
}
