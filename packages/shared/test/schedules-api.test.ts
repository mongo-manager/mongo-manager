// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import {
  CadenceSchema,
  InspectRequestSchema,
  KeyConfirmSchema,
  KeyImportSchema,
  RETENTION_PRESETS,
  RestoreRequestSchema,
  RetentionSchema,
  ScheduleInputSchema,
  SchedulePatchSchema,
  SchedulePreviewSchema,
  isTimeZone,
} from '../src/index'

const id = '0e3f3d4a-2b1c-4d5e-8f90-a1b2c3d4e5f6'
const base = {
  name: 'Nightly shop',
  connectionId: 'c1',
  dump: { scope: { kind: 'database', db: 'shop' } },
  cadence: { kind: 'daily', times: ['02:00'] },
  timeZone: 'Europe/Berlin',
  destinations: [id],
}

describe('schedule contracts (phase 3d-3c spec §1.2–§1.4, §3.4)', () => {
  it('defaults to an encrypted backup, the standard retention and no server copy', () => {
    expect(ScheduleInputSchema.parse(base)).toMatchObject({
      format: 'mmbak',
      keepOnServer: false,
      retention: RETENTION_PRESETS.standard,
      dump: { engine: 'builtin', indexes: true, options: true, anonymous: false },
    })
    expect(RETENTION_PRESETS).toEqual({
      daily30: { last: 7, daily: 30, weekly: 0, monthly: 0 },
      standard: { last: 7, daily: 14, weekly: 8, monthly: 12 },
      long: { last: 7, daily: 30, weekly: 26, monthly: 60 },
    })
  })

  it('takes each preset and a cron expression, and refuses malformed cadences', () => {
    for (const c of [
      { kind: 'hourly', every: 6, minute: 15 },
      { kind: 'daily', times: ['02:00', '14:30'] },
      { kind: 'weekly', days: [1, 5], time: '23:59' },
      { kind: 'monthly', day: 'last', time: '03:00' },
      { kind: 'monthly', day: 28, time: '03:00' },
      { kind: 'cron', expression: '0 2 * * 1-5' },
    ])
      expect(CadenceSchema.safeParse(c).success, JSON.stringify(c)).toBe(true)
    for (const c of [
      { kind: 'hourly', every: 0, minute: 0 },
      { kind: 'hourly', every: 25, minute: 0 },
      { kind: 'hourly', every: 1, minute: 60 },
      { kind: 'daily', times: [] },
      { kind: 'daily', times: ['02:00', '02:00'] },
      { kind: 'daily', times: ['01:00', '02:00', '03:00', '04:00', '05:00'] },
      { kind: 'daily', times: ['24:00'] },
      { kind: 'daily', times: ['2:00'] },
      { kind: 'weekly', days: [0], time: '02:00' },
      { kind: 'weekly', days: [1, 1], time: '02:00' },
      { kind: 'monthly', day: 29, time: '02:00' },
      { kind: 'cron', expression: 'x'.repeat(201) },
      { kind: 'yearly' },
    ])
      expect(CadenceSchema.safeParse(c).success, JSON.stringify(c)).toBe(false)
  })

  it('checks time zones with Intl (D8)', () => {
    for (const ok of ['Europe/Berlin', 'UTC', 'America/New_York', 'Etc/GMT+5'])
      expect(isTimeZone(ok), ok).toBe(true)
    for (const bad of ['Mars/Olympus', '', '../etc', 'Europe/Berlin\u0000', 'x'.repeat(65), 42, null])
      expect(isTimeZone(bad), String(bad)).toBe(false)
    expect(ScheduleInputSchema.safeParse({ ...base, timeZone: 'Nowhere/Land' }).success).toBe(false)
  })

  it('bounds destinations, retention tiers and names (D4)', () => {
    const bad = (patch: object) => ScheduleInputSchema.safeParse({ ...base, ...patch }).success
    expect(bad({ destinations: [] })).toBe(false)
    expect(bad({ destinations: Array.from({ length: 9 }, (_, i) => id.replace(/.$/, String(i))) })).toBe(
      false,
    )
    expect(bad({ destinations: [id, id] })).toBe(false)
    expect(bad({ name: '' })).toBe(false)
    expect(bad({ name: 'n'.repeat(81) })).toBe(false)
    expect(bad({ connectionId: '' })).toBe(false)
    for (const r of [
      { last: 0, daily: 0, weekly: 0, monthly: 0 },
      { last: 101, daily: 0, weekly: 0, monthly: 0 },
      { last: 7, daily: 91, weekly: 0, monthly: 0 },
      { last: 7, daily: 0, weekly: 53, monthly: 0 },
      { last: 7, daily: 0, weekly: 0, monthly: 61 },
      { last: 7, daily: 0, weekly: 0 },
    ])
      expect(RetentionSchema.safeParse(r).success, JSON.stringify(r)).toBe(false)
  })

  it('patches without the connection, with a removal confirmation', () => {
    expect(SchedulePatchSchema.parse({ confirmRemovals: 12 })).toEqual({ confirmRemovals: 12 })
    expect(SchedulePatchSchema.safeParse({ connectionId: 'c2' }).success).toBe(false)
    expect(SchedulePatchSchema.safeParse({ destinations: [] }).success).toBe(false)
    expect(SchedulePreviewSchema.parse({})).toEqual({ locale: 'en' })
  })

  it('takes a kit when opening a backup, and bounds kits and key names (D7)', () => {
    const source = { kind: 'backup', backupId: id }
    expect(InspectRequestSchema.safeParse({ source, kit: 'MMKEY1-…' }).success).toBe(true)
    expect(InspectRequestSchema.safeParse({ source, kit: 'x'.repeat(8193) }).success).toBe(false)
    expect(
      RestoreRequestSchema.safeParse({
        source,
        kit: 'k',
        mapping: [{ from: { db: 'a', coll: 'b' }, to: { db: 'a', coll: 'b' } }],
      }).success,
    ).toBe(true)
    expect(KeyImportSchema.safeParse({ kit: 'k', name: '' }).success).toBe(false)
    expect(KeyImportSchema.safeParse({ kit: '' }).success).toBe(false)
    expect(KeyConfirmSchema.safeParse({ check: 'ABCD' }).success).toBe(true)
    expect(KeyConfirmSchema.safeParse({ check: 'x'.repeat(17) }).success).toBe(false)
  })
})
