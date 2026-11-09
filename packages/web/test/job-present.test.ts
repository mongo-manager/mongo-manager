// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import type { JobView } from '@mongo-manager/shared'
import { clock, dayOf, jobSentence, progressUnit, statusOf } from '../src/jobs/present'

const NOW = new Date(2026, 9, 8, 15, 0).getTime()
const job = (over: Partial<JobView>): JobView => ({
  id: 'j',
  kind: 'data.export',
  connectionId: 'c1',
  db: 'shop',
  coll: 'orders',
  targetConnectionId: null,
  target: 'orders.json',
  state: 'done',
  progress: null,
  estimate: null,
  error: null,
  startedAt: NOW - 60_000,
  finishedAt: NOW - 57_000,
  mine: true,
  cancellable: false,
  ...over,
})

describe('how a job reads (user, 2026-10-08: the jobs page redesigned)', () => {
  it('says where the work went, in its direction', () => {
    expect(jobSentence(job({}))).toEqual({ from: 'shop.orders', to: 'orders.json' })
    expect(jobSentence(job({ kind: 'data.import', target: 'in.csv' }))).toEqual({ from: 'in.csv', to: 'shop.orders' })
    expect(jobSentence(job({ kind: 'backup.dump', db: '*', coll: '*', target: 'all.mmbak' }))).toEqual({
      from: null,
      to: 'all.mmbak',
    })
    expect(jobSentence(job({ kind: 'backup.restore', coll: '*', target: 'nightly.mmbak' }))).toEqual({
      from: 'nightly.mmbak',
      to: 'shop',
    })
    expect(jobSentence(job({ kind: 'collection.duplicate', target: 'orders_copy' }))).toEqual({
      from: 'shop.orders',
      to: 'shop.orders_copy',
    })
    expect(jobSentence(job({ kind: 'data.copy', target: 'archive.orders', targetConnectionId: 'c2' }))).toEqual({
      from: 'shop.orders',
      to: 'archive.orders',
    })
    expect(jobSentence(job({ kind: 'backup.send', target: 'n.mmbak' }))).toEqual({ from: 'n.mmbak', to: null })
  })

  it('shows its state as one of five, an interrupted job as a warning', () => {
    expect(statusOf('running')).toBe('running')
    expect(statusOf('done')).toBe('done')
    expect(statusOf('failed')).toBe('failed')
    expect(statusOf('cancelled')).toBe('cancelled')
    expect(statusOf('interrupted')).toBe('warning')
    expect(statusOf('unknown')).toBe('warning')
  })

  it('counts a backup’s progress in bytes and the rest in documents', () => {
    expect(progressUnit('backup.dump')).toBe('bytes')
    expect(progressUnit('backup.send')).toBe('bytes')
    expect(progressUnit('data.export')).toBe('documents')
    expect(progressUnit('index.create')).toBe('items')
  })

  it('names the time of day for today, and the date before it — never "ago"', () => {
    expect(clock(new Date(2026, 9, 8, 14, 38).getTime(), NOW, 'tr')).toBe('14:38')
    expect(clock(new Date(2026, 9, 6, 9, 5).getTime(), NOW, 'tr')).toMatch(/6 Eki.*09:05/)
    expect(clock(new Date(2025, 11, 31, 9, 5).getTime(), NOW, 'en')).toMatch(/2025/)
  })

  it('groups by day: today, yesterday, then the date', () => {
    expect(dayOf(new Date(2026, 9, 8, 0, 5).getTime(), NOW, 'en')).toEqual({ key: '2026-10-08', label: 'today' })
    expect(dayOf(new Date(2026, 9, 7, 23, 59).getTime(), NOW, 'en')).toEqual({
      key: '2026-10-07',
      label: 'yesterday',
    })
    const older = dayOf(new Date(2026, 9, 6, 12).getTime(), NOW, 'tr')
    expect(older.key).toBe('2026-10-06')
    expect(older.label).toMatch(/6 Ekim/)
  })
})
