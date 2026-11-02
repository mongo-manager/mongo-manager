import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { JobView } from '@mongo-manager/shared'
import { useJobsStore } from '../src/jobs/store'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
})
afterEach(() => vi.useRealTimers())

const job = (done: number, over: Partial<JobView> = {}): JobView => ({
  id: 'j1',
  kind: 'data.export',
  connectionId: 'c1',
  db: 'shop',
  coll: 'orders',
  targetConnectionId: null,
  target: 'o.json',
  state: 'running',
  progress: { done, total: 100 },
  estimate: null,
  error: null,
  startedAt: 0,
  finishedAt: null,
  mine: true,
  cancellable: true,
  ...over,
})

describe('the time a running job has left (user, 2026-10-08: the jobs page redesigned)', () => {
  it('measures the pace from the progress updates, and says nothing before it can', () => {
    const store = useJobsStore()
    store.upsert(job(10))
    expect(store.timeLeft('j1')).toBeNull()
    vi.setSystemTime(1_001_000)
    store.upsert(job(30))
    expect(store.rateOf('j1')).toBe(20)
    expect(store.timeLeft('j1')).toBe(3.5)
    vi.setSystemTime(1_002_000)
    store.replaceAll([job(30, { state: 'done', finishedAt: 1_002_000 })])
    expect(store.timeLeft('j1')).toBeNull()
  })

  it('remembers which job another view asked to show', () => {
    const store = useJobsStore()
    store.focus('j1')
    expect(store.focused).toBe('j1')
    store.focus(null)
    expect(store.focused).toBeNull()
  })
})
