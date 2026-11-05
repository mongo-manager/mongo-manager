// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { hint } from '../src/hints'
import { LANGUAGES } from '../../kit/src/i18n'
import manifest from '../public/mongo-manager-plugin.json'

const utc = (value: unknown, locale = 'en') => hint(value, locale, 'UTC')

const ID = { $oid: '6ac625df13a09509ca0da14f' }

describe('time hints (plugins wave 1)', () => {
  it('tells when an ObjectId was made', () => {
    expect(utc(ID)!.tone).toBe('neutral')
    expect(utc(ID)!.text).toMatch(/^Oct 7, 2026, 10:58\sAM$/)
  })

  it('reads Unix times in seconds and in milliseconds as approximate dates', () => {
    const want = utc({ $numberInt: '1700000000' })!
    expect(want.tone).toBe('neutral')
    expect(want.text).toMatch(/^≈ Nov 14, 2023, 10:13\sPM$/)
    expect(utc({ $numberLong: '1700000000000' })!.text).toBe(want.text)
    expect(utc({ $numberDouble: '1700000000.5' })!.text).toBe(want.text)
  })

  it('leaves other numbers and values alone', () => {
    for (const value of [
      { $numberInt: '42' },
      { $numberInt: '999999999' },
      { $numberLong: '5000000000' },
      { $numberLong: '99999999999999' },
      { $numberDouble: 'NaN' },
      'text',
      null,
      { $oid: 'zz' },
      { $date: { $numberLong: '0' } },
    ])
      expect(utc(value), JSON.stringify(value)).toBeNull()
  })

  it('writes the moment in each language of the app', () => {
    const texts = new Set(LANGUAGES.map((language) => utc(ID, language)!.text))
    expect(texts.size).toBeGreaterThanOrEqual(8)
    for (const language of LANGUAGES) {
      expect(utc(ID, language)!.text, language).toMatch(/2026/)
      expect(utc({ $numberInt: '1700000000' }, language)!.text, language).toMatch(/^≈ .*2023/)
    }
  })

  it('writes the moment the way each language does', () => {
    // Korean: year first, Hangul meridiem.
    expect(utc(ID, 'ko')!.text).toMatch(/^2026\. 10\. 7\. [가-힣]+ /)
    // German: day.month.year, zero padded.
    expect(utc(ID, 'de')!.text).toMatch(/^07\.10\.2026, 10:58$/)
    // French: day, abbreviated month name, year.
    expect(utc(ID, 'fr')!.text).toMatch(/^7 oct\. 2026/)
    // Russian: Cyrillic month and the year marker.
    expect(utc(ID, 'ru')!.text).toMatch(/^7 [а-я]+\. 2026 г\./)
    // English: month first, 12-hour clock.
    expect(utc(ID, 'en')!.text).toMatch(/^Oct 7, 2026, 10:58\sAM$/)
  })

  it('falls back to English for an unknown locale', () => {
    expect(utc(ID, 'xx')).toEqual(utc(ID, 'en'))
    expect(utc({ $numberInt: '1700000000' }, 'xx')).toEqual(utc({ $numberInt: '1700000000' }, 'en'))
    expect(utc(ID, 'xx')!.text).toMatch(/^Oct 7, 2026, /)
  })
})

describe('time hints manifest', () => {
  const languages = [...LANGUAGES]
  const localized: Record<string, string>[] = [
    manifest.name,
    manifest.description,
    ...manifest.changelog.map((entry) => entry.notes),
  ]

  it('speaks every language everywhere', () => {
    for (const texts of localized) expect(Object.keys(texts).sort()).toEqual([...languages].sort())
  })

  it('stays within the length limits', () => {
    for (const lang of languages) {
      const name = (manifest.name as Record<string, string>)[lang]!
      const description = (manifest.description as Record<string, string>)[lang]!
      expect(name.length).toBeLessThanOrEqual(40)
      expect(description.length).toBeLessThanOrEqual(300)
      for (const entry of manifest.changelog)
        expect((entry.notes as Record<string, string>)[lang]!.length).toBeLessThanOrEqual(1000)
    }
  })

  it('shows its title in the new languages', () => {
    expect(manifest.name.ko).toBe('시간 힌트')
    expect(manifest.name.de).toBe('Zeithinweise')
    expect(manifest.name.fr).toBe('Indices temporels')
    expect(manifest.name.ru).toBe('Подсказки времени')
  })

  it('announces this release', () => {
    expect(manifest.version).toBe('1.3.0')
    expect(manifest.changelog[0]!.version).toBe(manifest.version)
    expect(manifest.publishedAt).toBe('2026-10-29')
  })
})
