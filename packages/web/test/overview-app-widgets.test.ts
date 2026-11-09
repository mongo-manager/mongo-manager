// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { Widget } from '@mongo-manager/shared'
import WidgetSlot from '../src/workspace/overview/widgets/WidgetSlot.vue'
import { useDashboardStore } from '../src/stores/dashboard'
import { useJobsStore } from '../src/jobs/store'
import { useTabsStore } from '../src/stores/tabs'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  // A save still waiting would reach the next test's mocked server.
  useDashboardStore().reset()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function show(type: 'appStatus' | 'aiUsage') {
  const widget = { id: '00000000-0000-4000-8000-0000000000a1', type, size: 'm', settings: {} } as Widget
  const store = useDashboardStore()
  store.widgets = [widget]
  store.status = 'ready'
  return mountApp(WidgetSlot, { props: { widget, position: 0, count: 1, editing: false } })
}
const row = (name: string) => document.querySelector<HTMLElement>(`[data-app-row="${name}"]`)
const stat = (name: string) => document.querySelector<HTMLElement>(`[data-ai-stat="${name}"]`)!.textContent!

const HOUR = 3600_000
const sync = (mine: boolean, state: string) => ({ id: crypto.randomUUID(), mine, state })
const schedule = (mine: boolean, state: string, nextRunAt: number | null, lastRuns: object[] = []) => ({
  id: crypto.randomUUID(),
  mine,
  state,
  nextRunAt,
  lastRuns,
})
function appApi(over: Record<string, () => [number, unknown]> = {}) {
  return mockApi({
    'GET live-syncs': () => [
      200,
      { syncs: [sync(true, 'live'), sync(true, 'attention'), sync(false, 'live'), sync(false, 'failed')] },
    ],
    'GET backup-schedules': () => [
      200,
      {
        schedules: [
          schedule(true, 'active', Date.now() + 2 * HOUR),
          schedule(true, 'active', Date.now() + 5 * HOUR, [{ outcome: 'failed' }]),
          schedule(false, 'paused', null),
        ],
      },
    ],
    'GET backups/usage': () => [
      200,
      { used: 2 * 1024 ** 2, quota: 10 * 1024 ** 2, ttlHours: 24, chunkMb: 64 },
    ],
    ...over,
  })
}

describe('Mongo Manager status widget (user review 2026-10-09)', () => {
  it('says what the app is doing: jobs, live syncs, schedules and the backup room — the user’s own', async () => {
    appApi()
    useJobsStore().upsert({ id: 'j1', state: 'running', startedAt: Date.now() } as never)
    useJobsStore().upsert({ id: 'j2', state: 'done', startedAt: Date.now() } as never)
    show('appStatus')
    await flushPromises()
    expect(document.querySelector('[data-widget]')!.textContent).toContain('Mongo Manager')
    expect(row('jobs')!.textContent).toContain('1 running')
    // Another user's syncs and schedules are not counted.
    expect(row('liveSyncs')!.textContent).toContain('1 running')
    expect(row('liveSyncs')!.textContent).toContain('1 needs attention')
    expect(row('schedules')!.textContent).toContain('2 active')
    expect(row('schedules')!.textContent).toContain('1 needs attention')
    expect(row('schedules')!.textContent).toContain('next in 2 hours')
    expect(row('backups')!.textContent).toContain('2 MB of 10 MB')
    expect(row('backups')!.querySelector('[role="meter"]')!.getAttribute('aria-valuenow')).toBe('20')
  })

  it('says when nothing runs, and opens each page', async () => {
    appApi({
      'GET live-syncs': () => [200, { syncs: [] }],
      'GET backup-schedules': () => [200, { schedules: [] }],
    })
    show('appStatus')
    await flushPromises()
    expect(row('jobs')!.textContent).toContain('Nothing running')
    expect(row('liveSyncs')!.textContent).toContain('None set up')
    expect(row('schedules')!.textContent).toContain('None set up')
    const tabs = useTabsStore()
    for (const [name, kind] of [
      ['jobs', 'jobs'],
      ['liveSyncs', 'liveSyncs'],
      ['schedules', 'schedules'],
    ] as const) {
      row(name)!.querySelector('button')!.click()
      await flushPromises()
      expect(tabs.tabs.find((t) => t.id === tabs.activeId)!.kind).toBe(kind)
    }
  })

  it('leaves out what it may not read, and keeps the rest', async () => {
    appApi({
      'GET backups/usage': () => [403, { code: 'FORBIDDEN', message: 'no' }],
      'GET live-syncs': () => [500, { code: 'INTERNAL', message: 'down' }],
    })
    show('appStatus')
    await flushPromises()
    expect(row('backups')).toBeNull()
    expect(row('liveSyncs')).toBeNull()
    expect(row('jobs')).not.toBeNull()
    expect(row('schedules')!.textContent).toContain('2 active')
  })
})

/** A local day as the widget names it (YYYY-MM-DD), `back` days ago. */
function localDay(back = 0): string {
  const d = new Date()
  d.setDate(d.getDate() - back)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const count = (requests: number, tokens: number, cost: number | null) => ({
  requests,
  input: tokens / 2,
  output: tokens / 2,
  cost: cost === null ? [] : [{ amount: cost, currency: 'USD' }],
})

describe('AI usage widget (user review 2026-10-09)', () => {
  it('asks the usage by day in the reader’s time zone and shows today, this month and each day', async () => {
    // Today, and a day earlier this month when there is one (else last month, not counted in it).
    const sameMonth = new Date().getDate() > 1
    const days = [
      { day: localDay(0), ...count(3, 1500, 0.25) },
      { day: localDay(1), ...count(2, 500, 0.25) },
      { day: localDay(40), ...count(9, 9000, 9) },
    ]
    const { calls } = mockApi({
      'GET ai/usage': () => [200, { since: 0, totals: count(14, 11_000, 9.5), byModel: [], byDay: days }],
    })
    show('aiUsage')
    await flushPromises()
    const asked = calls.find((c) => c.path === 'ai/usage')!
    expect(asked).toBeDefined()
    const url = new URL(
      String(vi.mocked(fetch).mock.calls.find((c) => String(c[0]).includes('ai/usage'))![0]),
    )
    expect(url.searchParams.get('tz')).toBe(String(-new Date().getTimezoneOffset()))
    expect(url.searchParams.get('days')).toBe('31')
    expect(stat('today')).toContain('3 requests')
    expect(stat('today')).toContain('1,500 tokens')
    expect(stat('month')).toContain(sameMonth ? '5 requests' : '3 requests')
    expect(stat('month')).toContain(sameMonth ? '$0.50' : '$0.25')
    // The last 30 days, one bar each (empty days too), with a table for screen readers.
    const cells = [...document.querySelectorAll('[data-ai-days] tbody tr')]
    expect(cells).toHaveLength(30)
    expect(cells.at(-1)!.textContent).toContain('3')
    expect(document.querySelectorAll('[data-ai-days] rect[data-day]')).toHaveLength(30)
  })

  it('says when there is no price, and when nothing was asked today', async () => {
    mockApi({
      'GET ai/usage': () => [
        200,
        {
          since: 0,
          totals: count(1, 10, null),
          byModel: [],
          byDay: [{ day: localDay(1), ...count(1, 10, null) }],
        },
      ],
    })
    show('aiUsage')
    await flushPromises()
    expect(stat('today')).toContain('0 requests')
    if (new Date().getDate() > 1) expect(stat('month')).toContain('No price set')
  })

  it('opens the AI history, and says when the usage cannot be read', async () => {
    mockApi({ 'GET ai/usage': () => [500, { code: 'INTERNAL', message: 'down' }] })
    show('aiUsage')
    await flushPromises()
    expect(document.querySelector('[data-widget] [role="alert"]')).not.toBeNull()
    expect(document.querySelector('[data-widget] [data-widget-retry]')).not.toBeNull()
    ;[...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Open AI history'))!.click()
    await flushPromises()
    const tabs = useTabsStore()
    expect(tabs.tabs.find((t) => t.id === tabs.activeId)!.kind).toBe('aiHistory')
  })

  it('moves on to a new day at midnight (final review 8)', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    try {
      vi.setSystemTime(new Date(2026, 9, 31, 23, 58))
      mockApi({
        'GET ai/usage': () => [
          200,
          {
            since: 0,
            totals: count(3, 30, null),
            byModel: [],
            byDay: [{ day: '2026-10-31', ...count(3, 30, null) }],
          },
        ],
      })
      show('aiUsage')
      await flushPromises()
      expect(stat('today')).toContain('3 requests')
      expect(stat('month')).toContain('3 requests')
      vi.setSystemTime(new Date(2026, 10, 1, 0, 1))
      vi.advanceTimersByTime(60_000)
      await flushPromises()
      expect(stat('today')).toContain('0 requests')
      // A new month too.
      expect(stat('month')).toContain('0 requests')
      expect(document.querySelectorAll('[data-ai-days] rect[data-day]')[29]!.getAttribute('data-day')).toBe(
        '2026-11-01',
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
