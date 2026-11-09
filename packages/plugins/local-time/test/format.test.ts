// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { LANGUAGES, langTag, shown, type Language } from '../../kit/src/i18n'
import { localTime, UNKNOWN_ZONE, utcOffset, zoneOrNull } from '../src/format'

/**
 * Plugins wave 3 (spec §8a): a date in the user's local time — or a zone they set — with its UTC
 * offset, and the relative time if asked; text only, in the app's language.
 */
const AT = Date.UTC(2026, 9, 26, 11, 3, 12)
const ejson = (ms: number) => ({ $date: { $numberLong: String(ms) } })
const NOW = Date.UTC(2026, 9, 29, 11, 3, 12)

describe('a date in local time', () => {
  it('says the date in the zone asked, with its offset from UTC', () => {
    expect(localTime(ejson(AT), 'tr', { timeZone: 'Europe/Istanbul', relative: false, now: NOW })).toBe(
      `${new Intl.DateTimeFormat('tr', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Europe/Istanbul' }).format(AT)} (Europe/Istanbul, UTC+3)`,
    )
    expect(localTime(ejson(AT), 'en', { timeZone: 'Asia/Kolkata', relative: false, now: NOW })).toContain(
      '(Asia/Kolkata, UTC+5:30)',
    )
    expect(localTime(ejson(AT), 'en', { timeZone: 'UTC', relative: false, now: NOW })).toMatch(/\(UTC\)$/)
  })

  it('takes the browser’s zone when none is set, or the one set is not a zone', () => {
    const browser = localTime(ejson(AT), 'en', { timeZone: '', relative: false, now: NOW })!
    expect(browser).toMatch(/\(UTC([+-]\d{1,2}(:\d\d)?)?\)$/)
    // The browser's, and the zone set is said to be unknown.
    expect(localTime(ejson(AT), 'en', { timeZone: 'Mars/Olympus', relative: false, now: NOW })).toBe(
      `${browser} · unknown zone "Mars/Olympus"`,
    )
    expect(zoneOrNull('Mars/Olympus')).toBeNull()
    expect(zoneOrNull('Europe/Istanbul')).toBe('Europe/Istanbul')
    expect(zoneOrNull('')).toBeNull()
  })

  it('adds how long ago, or how far ahead, when asked', () => {
    expect(localTime(ejson(AT), 'en', { timeZone: 'UTC', relative: true, now: NOW })).toMatch(/· 3 days ago$/)
    expect(localTime(ejson(AT), 'tr', { timeZone: 'UTC', relative: true, now: NOW })).toMatch(/· 3 gün önce$/)
    expect(localTime(ejson(NOW + 7_200_000), 'en', { timeZone: 'UTC', relative: true, now: NOW })).toMatch(
      /· in 2 hours$/,
    )
  })

  it('reads a date written as text too, and leaves alone what is no date or out of range', () => {
    expect(
      localTime({ $date: '2026-10-26T11:03:12Z' }, 'en', { timeZone: 'UTC', relative: false, now: NOW }),
    ).toContain('11:03:12')
    for (const v of [
      '2026',
      42,
      null,
      { $date: 'soon' },
      { $oid: 'x' },
      ejson(Date.UTC(1850, 0, 1)),
      ejson(Date.UTC(2300, 0, 1)),
    ])
      expect(localTime(v, 'en', { timeZone: 'UTC', relative: false, now: NOW }), JSON.stringify(v)).toBeNull()
  })

  it('writes an offset as UTC±h[:mm]', () => {
    expect(utcOffset(AT, 'Europe/Istanbul')).toBe('UTC+3')
    expect(utcOffset(AT, 'Asia/Kolkata')).toBe('UTC+5:30')
    expect(utcOffset(AT, 'America/New_York')).toBe('UTC-4')
    expect(utcOffset(AT, 'UTC')).toBe('UTC')
  })
})

describe('a date in local time, review fixes', () => {
  const opts = { relative: false, now: NOW }
  // Wave 3 review: "(UTC, UTC)".
  it('names a zone that is UTC once', () => {
    for (const zone of ['UTC', 'Etc/UTC', 'GMT', 'Etc/GMT', 'Zulu'])
      expect(localTime(ejson(AT), 'en', { ...opts, timeZone: zone }), zone).toMatch(/\(UTC\)$/)
    // A zone at UTC for the moment is still named.
    expect(localTime(ejson(Date.UTC(2026, 0, 5)), 'en', { ...opts, timeZone: 'Europe/London' })).toMatch(
      /\(Europe\/London, UTC\)$/,
    )
  })

  it('keeps the seconds of an old offset', () => {
    expect(utcOffset(Date.UTC(1880, 0, 1), 'Europe/Istanbul')).toBe('UTC+1:56:56')
    expect(utcOffset(Date.UTC(1950, 0, 1), 'Africa/Monrovia')).toBe('UTC-0:44:30')
  })

  it('says a unit in the next one up when it rounds to it', () => {
    const ago = (ms: number) =>
      localTime(ejson(NOW - ms), 'en', { timeZone: 'UTC', relative: true, now: NOW })!.split(' · ')[1]
    const HOUR = 3_600_000
    const DAY = 24 * HOUR
    expect(ago(23.6 * HOUR)).toBe('yesterday')
    expect(ago(59.6 * 60_000)).toBe('1 hour ago')
    expect(ago(59.6 * 1000)).toBe('1 minute ago')
    expect(ago(6.6 * DAY)).toBe('last week')
    expect(ago(29.6 * DAY)).toBe('last month')
    expect(ago(354 * DAY)).toBe('last year')
    expect(ago(3 * DAY)).toBe('3 days ago')
  })

  // Wave 3 second review: "yesterday" was said of 23.5 hours earlier the same day.
  it('says yesterday only of the day before in the zone shown, around midnight', () => {
    const rel = (at: string, now: string, timeZone = 'UTC') =>
      localTime({ $date: at }, 'en', { timeZone, relative: true, now: Date.parse(now) })!.split(' · ')[1]
    // The same day, 23.5 hours earlier: hours, never yesterday.
    expect(rel('2026-10-29T00:20:00Z', '2026-10-29T23:50:00Z')).toBe('23 hours ago')
    // And ahead: 23.5 hours later the same day is in 23 hours, never tomorrow.
    expect(rel('2026-10-29T23:40:00Z', '2026-10-29T00:10:00Z')).toBe('in 23 hours')
    // Just past midnight: minutes, not yesterday.
    expect(rel('2026-10-28T23:50:00Z', '2026-10-29T00:10:00Z')).toBe('20 minutes ago')
    // The day before, ten hours earlier: yesterday.
    expect(rel('2026-10-28T22:00:00Z', '2026-10-29T08:00:00Z')).toBe('yesterday')
    // The same instants in Tokyo are the same day there.
    expect(rel('2026-10-28T22:00:00Z', '2026-10-29T08:00:00Z', 'Asia/Tokyo')).toBe('10 hours ago')
    // Two calendar days back, 30 hours earlier: 2 days ago; the day after: tomorrow.
    expect(rel('2026-10-27T23:00:00Z', '2026-10-29T05:00:00Z')).toBe('2 days ago')
    expect(rel('2026-10-30T20:00:00Z', '2026-10-29T08:00:00Z')).toBe('tomorrow')
  })

  it('says a zone it does not know, the browser’s used instead', () => {
    const browser = localTime(ejson(AT), 'en', { ...opts, timeZone: '' })!
    expect(localTime(ejson(AT), 'en', { ...opts, timeZone: 'Mars/Olympus' })).toBe(
      `${browser} · unknown zone "Mars/Olympus"`,
    )
    expect(localTime(ejson(AT), 'tr', { ...opts, timeZone: 'Europe/Istambul' })).toMatch(
      / · bilinmeyen saat dilimi "Europe\/Istambul"$/,
    )
    // Within the 80 characters a cell shows.
    expect(
      localTime(ejson(AT), 'en', {
        relative: true,
        now: NOW,
        timeZone: 'Not/A_Zone_With_A_Very_Long_Name_Indeed',
      })!.length,
    ).toBeLessThanOrEqual(80)
  })
})

describe('the languages', () => {
  const at = (locale: string, extra: Partial<Parameters<typeof localTime>[2]> = {}) =>
    localTime(ejson(AT), locale, { timeZone: 'Europe/Istanbul', relative: false, now: NOW, ...extra })!

  const when = (l: Language) =>
    new Intl.DateTimeFormat(langTag(l), {
      dateStyle: 'medium',
      timeStyle: 'medium',
      timeZone: 'Europe/Istanbul',
    }).format(AT)

  it('says a date and an unknown zone in each language', () => {
    for (const l of ['zh', 'ja', 'es', 'pt', 'ko', 'de', 'fr', 'ru'] as const)
      expect(at(l), l).toBe(`${when(l)} (Europe/Istanbul, UTC+3)`)
    const bad = { timeZone: 'Mars/Olympus' }
    expect(at('zh', bad)).toMatch(/ · 未知时区“Mars\/Olympus”$/)
    expect(at('ja', bad)).toMatch(/ · 不明なタイムゾーン "Mars\/Olympus"$/)
    expect(at('es', bad)).toMatch(/ · zona horaria desconocida "Mars\/Olympus"$/)
    expect(at('pt', bad)).toMatch(/ · fuso horário desconhecido "Mars\/Olympus"$/)
    expect(at('ko', bad)).toMatch(/ · 알 수 없는 시간대 "Mars\/Olympus"$/)
    expect(at('de', bad)).toMatch(/ · unbekannte Zeitzone „Mars\/Olympus“$/)
    expect(at('fr', bad)).toMatch(/ · fuseau horaire inconnu «\u202fMars\/Olympus\u202f»$/)
    expect(at('ru', bad)).toMatch(/ · неизвестный часовой пояс «Mars\/Olympus»$/)
  })

  it('says how long ago in each language', () => {
    const rel = { timeZone: 'UTC', relative: true }
    expect(at('zh', rel)).toMatch(/· 3天前$/)
    expect(at('ja', rel)).toMatch(/· 3 日前$/)
    expect(at('es', rel)).toMatch(/· hace 3 días$/)
    expect(at('pt', rel)).toMatch(/· há 3 dias$/)
    expect(at('ko', rel)).toMatch(/· 3일 전$/)
    expect(at('de', rel)).toMatch(/· vor 3 Tagen$/)
    expect(at('fr', rel)).toMatch(/· il y a 3 jours$/)
    expect(at('ru', rel)).toMatch(/· 3 дня назад$/)
  })

  it('has a word for every language written, and reads English for an unknown one', () => {
    for (const [language, say] of Object.entries(UNKNOWN_ZONE)) expect(say!('x'), language).toContain('x')
    expect(Object.keys(UNKNOWN_ZONE).sort()).toEqual([...LANGUAGES].sort())
    // Every language has the same shape as English: a function of the zone's name, naming it once.
    for (const say of Object.values(UNKNOWN_ZONE)) expect(say('a/b').split('a/b')).toHaveLength(2)
    expect(at('xx', { timeZone: 'Mars/Olympus' })).toBe(at('en', { timeZone: 'Mars/Olympus' }))
    expect(at('xx')).toBe(at('en'))
  })
})

describe('a language the plugin lacks', () => {
  // The words and the numbers are English, so the page is marked English.
  it('shows English words and English date formatting', () => {
    const opts = { timeZone: 'Europe/Istanbul', relative: true, now: NOW }
    const unknown = localTime(ejson(AT), 'xx', opts)!
    expect(unknown).toBe(localTime(ejson(AT), 'en', opts))
    expect(unknown).toContain('Oct 26, 2026')
    expect(unknown).toMatch(/· 3 days ago$/)
    expect(langTag(shown(UNKNOWN_ZONE, 'xx'))).toBe('en')
    // A table that really lacks Korean reads English for it, and its page is marked English.
    const partial = { en: UNKNOWN_ZONE.en, tr: UNKNOWN_ZONE.tr }
    expect(shown(partial, 'ko')).toBe('en')
    expect(langTag(shown(partial, 'ko'))).toBe('en')
    expect(shown(partial, 'tr')).toBe('tr')
    expect(langTag(shown(UNKNOWN_ZONE, 'ko'))).toBe('ko')
  })
})

describe('the Russian text', () => {
  it('is written with е, not ё', () => {
    expect(UNKNOWN_ZONE.ru('x')).not.toMatch(/ё/)
  })
})
