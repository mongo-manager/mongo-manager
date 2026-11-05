// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { formatElapsed } from '../src/jobs/elapsed'

/**
 * Review of the languages (I1): an elapsed time is in the reader's language — the jobs tray, an
 * aggregation run and "firing since" read "3 min 12 s" on no Chinese or Japanese page.
 */
const unit = (n: number, u: 'second' | 'minute' | 'hour', locale: string) =>
  new Intl.NumberFormat(locale, { style: 'unit', unit: u, unitDisplay: 'short' }).format(n)

describe('elapsed time in every language', () => {
  it('keeps English and Turkish as they were', () => {
    expect(formatElapsed(192_000, 'en')).toBe('3 min 12 s')
    expect(formatElapsed(7_500_000, 'tr')).toBe('2 sa 5 dk')
  })

  it('says the units in the other languages’ own words', () => {
    for (const locale of ['zh', 'ja', 'es', 'pt', 'ko', 'de', 'fr', 'ru']) {
      expect(formatElapsed(12_000, locale), locale).toBe(unit(12, 'second', locale))
      expect(formatElapsed(192_000, locale), locale).toBe(
        `${unit(3, 'minute', locale)} ${unit(12, 'second', locale)}`,
      )
      expect(formatElapsed(7_500_000, locale), locale).toBe(
        `${unit(2, 'hour', locale)} ${unit(5, 'minute', locale)}`,
      )
    }
    expect(formatElapsed(192_000, 'ja')).not.toMatch(/min/)
  })
})
