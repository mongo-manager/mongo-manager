// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Cadence } from '../api/schedules'
import { parseCron, type CronSpec } from './cron'
import type { UiLanguage } from '../languages'
import { WORDS, type OtherLanguage, type Words } from './words'

/** Plan ruling 27: the words are composed here, in every language, with Intl's day and month names. */
export type WordsLocale = UiLanguage

const pad = (n: number) => String(n).padStart(2, '0')
const clock = (hour: number, minute: number) => `${pad(hour)}:${pad(minute)}`
/** "a, b and c" / "a, b ve c" — not Intl.ListFormat, whose English comma varies by data version. */
function list(items: string[], locale: WordsLocale): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} ${locale === 'tr' ? 've' : 'and'} ${items.at(-1)}`
}
/** Numbers with runs of three or more written as ranges: 1, 2, 3, 7 → "1–3", "7". */
function compact(values: number[]): string[] {
  const out: string[] = []
  for (let i = 0; i < values.length;) {
    let j = i
    while (j + 1 < values.length && values[j + 1] === values[j]! + 1) j++
    if (j - i >= 2) out.push(`${values[i]}–${values[j]}`)
    else for (let k = i; k <= j; k++) out.push(String(values[k]))
    i = j + 1
  }
  return out
}
const dayName = (iso: number, locale: WordsLocale) =>
  // 2024-01-01 was a Monday.
  new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(Date.UTC(2024, 0, iso))
const monthName = (month: number, locale: WordsLocale) =>
  new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(Date.UTC(2024, month - 1, 1))

/** ISO days (1–7) in words, consecutive runs of three or more as ranges. */
function days(iso: number[], locale: WordsLocale): string {
  const sorted = [...new Set(iso)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length;) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++
    if (j - i >= 2)
      parts.push(
        locale === 'tr'
          ? `${dayName(sorted[i]!, locale)}–${dayName(sorted[j]!, locale)}`
          : `${dayName(sorted[i]!, locale)} through ${dayName(sorted[j]!, locale)}`,
      )
    else for (let k = i; k <= j; k++) parts.push(dayName(sorted[k]!, locale))
    i = j + 1
  }
  return list(parts, locale)
}

const capital = (s: string, locale: WordsLocale) => s.charAt(0).toLocaleUpperCase(locale) + s.slice(1)

function cronWords(spec: CronSpec, locale: WordsLocale): string {
  const allHours = spec.hours.length === 24
  const count = spec.hours.length * spec.minutes.length
  const times = spec.hours.flatMap((h) => spec.minutes.map((m) => clock(h, m)))
  const minutes = list(compact(spec.minutes), locale)
  const domRestricted = spec.daysOfMonth.length < 31
  const dowRestricted = spec.daysOfWeek.length < 7
  const isoDays = spec.daysOfWeek.map((d) => (d === 0 ? 7 : d))
  const dom = list(compact(spec.daysOfMonth), locale)
  const months =
    spec.months.length < 12
      ? list(
          spec.months.map((m) => monthName(m, locale)),
          locale,
        )
      : null
  const or = !spec.domStar && !spec.dowStar
  if (locale === 'tr') {
    const hours = compact(spec.hours)
    // Final review minor 3: "arasında" (between) only for one range; scattered hours are listed
    // after the minute, which needs no suffix that follows the number's sound ("13'te", "9'da").
    const time = allHours
      ? `her saatin ${minutes}. dakikasında`
      : count <= 6
        ? `saat ${list(times, locale)}`
        : hours.length === 1 && hours[0]!.includes('–')
          ? `saat ${hours[0]} arasında her saatin ${minutes}. dakikasında`
          : `şu saatlerin ${minutes}. dakikasında: ${list(hours, locale)}`
    const dayPart =
      domRestricted && dowRestricted
        ? `ayın ${dom}. ${spec.daysOfMonth.length > 1 ? 'günleri' : 'günü'} ${or ? 'veya' : 've'} ${days(isoDays, locale)} günleri `
        : domRestricted
          ? `ayın ${dom}. ${spec.daysOfMonth.length > 1 ? 'günleri' : 'günü'} `
          : dowRestricted
            ? `${days(isoDays, locale)} günleri `
            : ''
    const monthPart = months ? `${months} aylarında ` : ''
    const everyDay = !dayPart && !monthPart && !allHours ? 'her gün ' : ''
    return capital(`${monthPart}${dayPart}${everyDay}${time}`, locale)
  }
  const time = allHours
    ? `At minute ${minutes} of every hour`
    : count <= 6
      ? `At ${list(times, locale)}`
      : `At minute ${minutes} of hours ${list(compact(spec.hours), locale)}`
  const dayPart =
    domRestricted && dowRestricted
      ? or
        ? ` on day ${dom} of the month or on ${days(isoDays, locale)}`
        : ` on day ${dom} of the month when it falls on ${days(isoDays, locale)}`
      : domRestricted
        ? ` on day ${dom} of the month`
        : dowRestricted
          ? ` on ${days(isoDays, locale)}`
          : ''
  const monthPart = months ? ` in ${months}` : ''
  const everyDay = !dayPart && !monthPart && !allHours ? ' every day' : ''
  return `${time}${dayPart}${monthPart}${everyDay}`
}

/** Languages (2026-10-29): the parts of a cron expression, for a language's own sentence. */
function otherCronWords(spec: CronSpec, locale: OtherLanguage, w: Words): string {
  const isoDays = spec.daysOfWeek.map((d) => (d === 0 ? 7 : d))
  const sorted = [...new Set(isoDays)].sort((a, b) => a - b)
  return w.cron({
    allHours: spec.hours.length === 24,
    few: spec.hours.length * spec.minutes.length <= 6,
    times: spec.hours.flatMap((h) => spec.minutes.map((m) => clock(h, m))),
    minutes: compact(spec.minutes),
    hours: compact(spec.hours),
    dom: spec.daysOfMonth.length < 31 ? compact(spec.daysOfMonth) : null,
    domMany: spec.daysOfMonth.length > 1,
    days: spec.daysOfWeek.length < 7 ? otherDays(sorted, locale, w) : null,
    months: spec.months.length < 12 ? spec.months.map((m) => monthName(m, locale)) : null,
  })
}

function otherDays(iso: number[], locale: OtherLanguage, w: Words): string {
  const sorted = [...new Set(iso)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length;) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++
    if (j - i >= 2) parts.push(w.range(dayName(sorted[i]!, locale), dayName(sorted[j]!, locale)))
    else for (let k = i; k <= j; k++) parts.push(dayName(sorted[k]!, locale))
    i = j + 1
  }
  return w.list(parts)
}

function otherCadence(c: Cadence, locale: OtherLanguage): string | null {
  const w = WORDS[locale]
  switch (c.kind) {
    case 'hourly': {
      const hours: string[] = []
      for (let h = 0; h < 24; h += c.every) hours.push(clock(h, c.minute))
      if (c.every === 1) return w.hourly(c.minute)
      return hours.length <= 6 ? w.everyHoursAt(c.every, hours) : w.everyHoursMinute(c.every, c.minute)
    }
    case 'daily':
      return w.daily([...new Set(c.times)].sort())
    case 'weekly':
      return new Set(c.days).size === 7 ? w.daily([c.time]) : w.weekly(otherDays(c.days, locale, w), c.time)
    case 'monthly':
      return c.day === 'last' ? w.monthlyLast(c.time) : w.monthly(c.day, c.time)
    case 'cron':
      try {
        return otherCronWords(parseCron(c.expression), locale, w)
      } catch {
        return null
      }
  }
}

/** Spec §1.3: a cadence in words ("At 02:00 on Monday through Friday"); null for an unreadable cron. */
export function describeCadence(c: Cadence, locale: WordsLocale): string | null {
  if (locale !== 'en' && locale !== 'tr') return otherCadence(c, locale)
  const tr = locale === 'tr'
  switch (c.kind) {
    case 'hourly': {
      const hours: string[] = []
      for (let h = 0; h < 24; h += c.every) hours.push(clock(h, c.minute))
      if (c.every === 1)
        return tr ? `Her saatin ${c.minute}. dakikasında` : `Every hour at minute ${c.minute}`
      if (hours.length <= 6)
        return tr
          ? `${c.every} saatte bir, saat ${list(hours, locale)}`
          : `Every ${c.every} hours, at ${list(hours, locale)}`
      return tr
        ? `${c.every} saatte bir, saatin ${c.minute}. dakikasında`
        : `Every ${c.every} hours at minute ${c.minute}`
    }
    case 'daily': {
      const times = list([...new Set(c.times)].sort(), locale)
      return tr ? `Her gün saat ${times}` : `Every day at ${times}`
    }
    case 'weekly': {
      if (new Set(c.days).size === 7) return tr ? `Her gün saat ${c.time}` : `Every day at ${c.time}`
      return tr ? `Her ${days(c.days, locale)} saat ${c.time}` : `Every ${days(c.days, locale)} at ${c.time}`
    }
    case 'monthly':
      if (c.day === 'last')
        return tr ? `Her ayın son günü saat ${c.time}` : `On the last day of every month at ${c.time}`
      return tr ? `Her ayın ${c.day}. günü saat ${c.time}` : `On day ${c.day} of every month at ${c.time}`
    case 'cron':
      try {
        return cronWords(parseCron(c.expression), locale)
      } catch {
        return null
      }
  }
}
