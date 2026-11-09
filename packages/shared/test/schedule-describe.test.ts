// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { describeCadence } from '../src/index'

describe('cadence words (phase 3d-3c spec §1.3, §5)', () => {
  it('says presets in English', () => {
    expect(describeCadence({ kind: 'hourly', every: 1, minute: 15 }, 'en')).toBe('Every hour at minute 15')
    expect(describeCadence({ kind: 'hourly', every: 6, minute: 0 }, 'en')).toBe(
      'Every 6 hours, at 00:00, 06:00, 12:00 and 18:00',
    )
    expect(describeCadence({ kind: 'hourly', every: 2, minute: 30 }, 'en')).toBe('Every 2 hours at minute 30')
    expect(describeCadence({ kind: 'daily', times: ['14:30', '02:00'] }, 'en')).toBe(
      'Every day at 02:00 and 14:30',
    )
    expect(describeCadence({ kind: 'weekly', days: [5, 1], time: '02:00' }, 'en')).toBe(
      'Every Monday and Friday at 02:00',
    )
    expect(describeCadence({ kind: 'weekly', days: [1, 2, 3, 4, 5], time: '02:00' }, 'en')).toBe(
      'Every Monday through Friday at 02:00',
    )
    expect(describeCadence({ kind: 'weekly', days: [1, 2, 3, 4, 5, 6, 7], time: '02:00' }, 'en')).toBe(
      'Every day at 02:00',
    )
    expect(describeCadence({ kind: 'monthly', day: 5, time: '03:00' }, 'en')).toBe(
      'On day 5 of every month at 03:00',
    )
    expect(describeCadence({ kind: 'monthly', day: 'last', time: '03:00' }, 'en')).toBe(
      'On the last day of every month at 03:00',
    )
  })

  it('says cron expressions in English', () => {
    expect(describeCadence({ kind: 'cron', expression: '0 2 * * 1-5' }, 'en')).toBe(
      'At 02:00 on Monday through Friday',
    )
    expect(describeCadence({ kind: 'cron', expression: '0 2 * * *' }, 'en')).toBe('At 02:00 every day')
    expect(describeCadence({ kind: 'cron', expression: '30 */4 * * *' }, 'en')).toBe(
      'At 00:30, 04:30, 08:30, 12:30, 16:30 and 20:30 every day',
    )
    expect(describeCadence({ kind: 'cron', expression: '15 * * * *' }, 'en')).toBe(
      'At minute 15 of every hour',
    )
    expect(describeCadence({ kind: 'cron', expression: '0 3 1,15 * *' }, 'en')).toBe(
      'At 03:00 on day 1 and 15 of the month',
    )
    expect(describeCadence({ kind: 'cron', expression: '0 3 * JAN,JUL *' }, 'en')).toBe(
      'At 03:00 in January and July',
    )
    expect(describeCadence({ kind: 'cron', expression: '0 3 13 * FRI' }, 'en')).toBe(
      'At 03:00 on day 13 of the month or on Friday',
    )
    expect(describeCadence({ kind: 'cron', expression: '0,30 9-17 * * *' }, 'en')).toBe(
      'At minute 0 and 30 of hours 9–17 every day',
    )
    expect(describeCadence({ kind: 'cron', expression: 'nonsense' }, 'en')).toBeNull()
  })

  it('says the same in Turkish', () => {
    expect(describeCadence({ kind: 'hourly', every: 1, minute: 15 }, 'tr')).toBe('Her saatin 15. dakikasında')
    expect(describeCadence({ kind: 'hourly', every: 6, minute: 0 }, 'tr')).toBe(
      '6 saatte bir, saat 00:00, 06:00, 12:00 ve 18:00',
    )
    expect(describeCadence({ kind: 'daily', times: ['02:00', '14:30'] }, 'tr')).toBe(
      'Her gün saat 02:00 ve 14:30',
    )
    expect(describeCadence({ kind: 'weekly', days: [1, 5], time: '02:00' }, 'tr')).toBe(
      'Her Pazartesi ve Cuma saat 02:00',
    )
    expect(describeCadence({ kind: 'weekly', days: [1, 2, 3, 4, 5], time: '02:00' }, 'tr')).toBe(
      'Her Pazartesi–Cuma saat 02:00',
    )
    expect(describeCadence({ kind: 'monthly', day: 5, time: '03:00' }, 'tr')).toBe(
      'Her ayın 5. günü saat 03:00',
    )
    expect(describeCadence({ kind: 'monthly', day: 'last', time: '03:00' }, 'tr')).toBe(
      'Her ayın son günü saat 03:00',
    )
    expect(describeCadence({ kind: 'cron', expression: '0 2 * * 1-5' }, 'tr')).toBe(
      'Pazartesi–Cuma günleri saat 02:00',
    )
    expect(describeCadence({ kind: 'cron', expression: '0 2 * * *' }, 'tr')).toBe('Her gün saat 02:00')
    expect(describeCadence({ kind: 'cron', expression: '0 3 * JAN,JUL *' }, 'tr')).toBe(
      'Ocak ve Temmuz aylarında saat 03:00',
    )
    // Final review minor 3: "arasında" (between) is for one range of hours, not for scattered ones.
    expect(describeCadence({ kind: 'cron', expression: '0 1,3,5,7,9,11,13 * * *' }, 'tr')).toBe(
      'Her gün şu saatlerin 0. dakikasında: 1, 3, 5, 7, 9, 11 ve 13',
    )
    expect(describeCadence({ kind: 'cron', expression: '0 8-18 * * *' }, 'tr')).toBe(
      'Her gün saat 8–18 arasında her saatin 0. dakikasında',
    )
  })
})
