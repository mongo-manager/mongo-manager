// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import type { JobView } from '@mongo-manager/shared'
import { filterJobs, jobCounts, stateGroup, type JobFilters } from '../src/jobs/jobFilters'

const NOW = Date.UTC(2026, 9, 8, 12)
const HOUR = 3_600_000
let n = 0
const job = (over: Partial<JobView>): JobView => ({
  id: `j${++n}`,
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
  startedAt: NOW - HOUR,
  finishedAt: NOW - HOUR + 1000,
  mine: true,
  cancellable: false,
  ...over,
})
const ALL: JobFilters = { state: 'all', kind: 'all', connectionId: 'all', mine: false, search: '', since: null }
const label = (kind: string) => ({ 'data.export': 'Export', 'backup.dump': 'Backup' })[kind] ?? kind

describe('the background jobs page’s filters (user, 2026-10-08: a page for background jobs)', () => {
  const jobs = [
    job({ state: 'running', kind: 'backup.dump', coll: '*', target: 'nightly', scheduleName: 'Every night' }),
    job({ state: 'failed', error: 'boom', startedAt: NOW - 2 * HOUR }),
    job({ state: 'interrupted', startedAt: NOW - 30 * HOUR, finishedAt: NOW - 29 * HOUR }),
    job({ state: 'cancelled', connectionId: 'c2', mine: false }),
    job({ state: 'done', coll: 'customers', target: 'customers.csv' }),
  ]

  it('groups the states as the filter shows them', () => {
    expect(stateGroup('running')).toBe('running')
    expect(stateGroup('done')).toBe('done')
    expect(stateGroup('failed')).toBe('failed')
    expect(stateGroup('interrupted')).toBe('failed')
    expect(stateGroup('unknown')).toBe('failed')
    expect(stateGroup('cancelled')).toBe('cancelled')
  })

  it('filters by state, kind, connection and who started them', () => {
    const ids = (f: Partial<JobFilters>) => filterJobs(jobs, { ...ALL, ...f }, label).map((j) => j.state)
    expect(ids({})).toHaveLength(5)
    expect(ids({ state: 'running' })).toEqual(['running'])
    expect(ids({ state: 'failed' })).toEqual(['failed', 'interrupted'])
    expect(ids({ kind: 'backup.dump' })).toEqual(['running'])
    expect(ids({ connectionId: 'c2' })).toEqual(['cancelled'])
    expect(ids({ mine: true })).not.toContain('cancelled')
    // The summary cards: the last 24 hours (a job counts by when it ended, or started).
    expect(ids({ since: NOW - 24 * HOUR })).not.toContain('interrupted')
    expect(ids({ since: NOW - 24 * HOUR })).toHaveLength(4)
  })

  it('searches the place, the target, the schedule and the kind’s name, ignoring case', () => {
    const states = (search: string) => filterJobs(jobs, { ...ALL, search }, label).map((j) => j.target)
    expect(states('CUSTOMERS')).toEqual(['customers.csv'])
    expect(states('every night')).toEqual(['nightly'])
    expect(states('backup')).toEqual(['nightly'])
    expect(states('shop.orders')).toHaveLength(3)
    expect(states('nothing like it')).toEqual([])
  })

  it('counts the running jobs, and those that failed in the last 24 hours', () => {
    expect(jobCounts(jobs, NOW)).toEqual({
      running: 1,
      recent: 3,
      failedRecently: 1,
      byState: { all: 5, running: 1, done: 1, failed: 2, cancelled: 1 },
    })
  })
})
