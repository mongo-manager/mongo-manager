// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { Widget } from '@mongo-manager/shared'
import WidgetSlot from '../src/workspace/overview/widgets/WidgetSlot.vue'
import { useDashboardStore } from '../src/stores/dashboard'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'

/**
 * Widgets wave 2 (2026-10-27; Atlas Charts' number and bar charts): a number or bars from one of the
 * user's saved pipelines, run as the aggregation page runs it — gated and masked for a restricted
 * user — and never one that writes.
 */
const C = '00000000-0000-4000-8000-0000000000c1'
const P = '00000000-0000-4000-8000-0000000000a1'
const CONN = { id: C, name: 'Production', permissions: ['aggregation:run', 'documents:read'] }
const ID = '00000000-0000-4000-8000-000000000031'
const BASE = `connections/${C}/databases/shop/collections/orders`

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  useDashboardStore().reset()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const kpi = (over: object = {}): Widget =>
  ({
    id: ID,
    type: 'dataKpi',
    size: 'm',
    settings: {
      connectionId: C,
      db: 'shop',
      coll: 'orders',
      pipelineId: P,
      display: 'number',
      refresh: 'manual',
      ...over,
    },
  }) as Widget
function show(widget: Widget) {
  const store = useDashboardStore()
  store.widgets = [widget]
  store.status = 'ready'
  return mountApp(WidgetSlot, { props: { widget, position: 0, count: 1, editing: false } })
}
const frame = () => document.querySelector('[data-widget]')!
const text = () => frame().textContent!.replace(/\s+/g, ' ')
/** The NDJSON reader yields to the browser (a timer) between chunks. */
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await flushPromises()
    await new Promise((r) => setTimeout(r, 5))
  }
}
const ndjson = (
  docs: unknown[],
  extra: unknown[] = [{ end: { count: docs.length, truncated: false, bytes: 1 } }],
) =>
  new Response(
    [...docs.map((document) => ({ document, hash: 'h' })), ...extra].map((l) => JSON.stringify(l)).join('\n'),
    {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
    },
  )
const STAGES = [{ $group: { _id: null, total: { $sum: '$amount' } } }]
function api(
  options: { stages?: unknown[]; docs?: unknown[]; extra?: unknown[]; pipelines?: unknown[] } = {},
) {
  const runs: unknown[] = []
  mockApi({
    'GET connections': () => [200, [CONN]],
    [`GET ${BASE}/pipelines`]: () => [
      200,
      {
        pipelines: options.pipelines ?? [
          {
            id: P,
            name: 'Revenue',
            stages: options.stages ?? STAGES,
            tags: [],
            shared: false,
            mine: true,
            owner: null,
            updatedAt: '2026-10-27T10:00:00.000Z',
          },
        ],
      },
    ],
    [`POST ${BASE}/aggregate/run`]: (body) => {
      runs.push(body)
      return ndjson(options.docs ?? [{ _id: null, total: { $numberInt: '1234' } }], options.extra)
    },
  })
  return { runs }
}

describe('the data KPI widget', () => {
  it('shows the first document’s first number, named, from a run that is no recent pipeline', async () => {
    const { runs } = api()
    show(kpi())
    await settle()
    expect(frame().querySelector('[data-kpi-value]')!.textContent!.trim()).toBe('1,234')
    expect(text()).toContain('total')
    expect(text()).toContain('Revenue')
    expect(runs).toEqual([{ stages: STAGES, limit: 20, maxTimeMS: 15_000, remember: false }])
  })

  it('reads every kind of number EJSON gives, and shows a value that is not a number as hidden', async () => {
    api({
      docs: [
        { _id: 'paid', n: { $numberLong: '5000000000' } },
        { _id: 'open', n: { $numberDouble: '2.5' } },
        { _id: 'void', n: '••••' },
        { _id: { $oid: '65f0a1b2c3d4e5f601234567' }, n: { $numberDecimal: '7' } },
      ],
    })
    show(kpi({ display: 'bars' }))
    await settle()
    const bars = [...frame().querySelectorAll('[data-kpi-bar]')].map((b) =>
      b.textContent!.replace(/\s+/g, ' '),
    )
    expect(bars).toHaveLength(4)
    expect(bars[0]).toContain('paid')
    expect(bars[0]).toContain('5,000,000,000')
    expect(bars[1]).toContain('2.5')
    expect(bars[2]).toContain('void')
    expect(bars[2]).toContain('hidden')
    expect(bars[3]).toContain('65f0a1b2c3d4e5f601234567')
    // An ObjectId is named by its hex, never as EJSON.
    expect(bars[3]).not.toContain('$oid')
  })

  it('says a number it cannot find as hidden, never as zero', async () => {
    api({ docs: [{ _id: null, total: '••••' }] })
    show(kpi())
    await settle()
    expect(frame().querySelector('[data-kpi-value]')).toBeNull()
    expect(text()).toContain('hidden')
    expect(text()).not.toMatch(/\b0\b/)
  })

  it('never runs a pipeline that writes', async () => {
    const { runs } = api({ stages: [...STAGES, { $merge: { into: 'totals' } }] })
    show(kpi())
    await settle()
    expect(runs).toEqual([])
    expect(text()).toContain('writes')
  })

  it('says a pipeline that is gone or no longer shared, and offers Settings', async () => {
    // The collection has other pipelines, not this one.
    const { runs } = api({
      pipelines: [
        {
          id: '00000000-0000-4000-8000-0000000000b9',
          name: 'Another',
          stages: STAGES,
          tags: [],
          shared: true,
          mine: false,
          owner: 'ada',
          updatedAt: '2026-10-27T10:00:00.000Z',
        },
      ],
    })
    show(kpi())
    await settle()
    expect(runs).toEqual([])
    expect(text()).toContain('no longer there')
    expect([...frame().querySelectorAll('button')].some((b) => b.textContent?.includes('Settings'))).toBe(
      true,
    )
  })

  it('says what the run answered when it failed, and says no result for no document', async () => {
    api({ docs: [], extra: [{ error: { code: 'MONGO_ERROR', message: 'Exceeded time limit' } }] })
    show(kpi())
    await settle()
    expect(text()).toContain('Exceeded time limit')
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    api({ docs: [] })
    show(kpi())
    await settle()
    expect(text()).toContain('no document')
  })

  it('runs once and on Refresh when manual, and again on its own when set to', async () => {
    const { runs } = api()
    show(kpi())
    await settle()
    expect(runs).toHaveLength(1)
    ;[...frame().querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.includes('Refresh'))!
      .click()
    await settle()
    expect(runs).toHaveLength(2)
  })

  it('runs again after its interval when set to', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { runs } = api()
    show(kpi({ refresh: '5m' }))
    await settle()
    expect(runs).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 100)
    await settle()
    expect(runs).toHaveLength(2)
  })
})

// Review of wave 2 (I1, M8, M9): a user has two runs at a time; a dashboard of KPIs must not take them
// all, nor be told "cannot be reached" when they are busy.
describe('the data KPI widget and the user’s runs', () => {
  const P2 = '00000000-0000-4000-8000-0000000000a2'
  const pipe = (id: string, stages: unknown[] = STAGES) => ({
    id,
    name: id === P ? 'Revenue' : 'Other',
    stages,
    tags: [],
    shared: false,
    mine: true,
    owner: null,
    updatedAt: '2026-10-27T10:00:00.000Z',
  })

  it('runs one KPI at a time, and lets the next run when one goes away', async () => {
    const runs: unknown[] = []
    mockApi({
      'GET connections': () => [200, [CONN]],
      [`GET ${BASE}/pipelines`]: () => [200, { pipelines: [pipe(P), pipe(P2, [{ $count: 'n' }])] }],
      [`POST ${BASE}/aggregate/run`]: (body) => {
        runs.push(body)
        // The first never answers until it is stopped.
        return runs.length === 1 ? new Promise<never>(() => {}) : ndjson([{ n: { $numberInt: '7' } }])
      },
    })
    const first = show(kpi())
    await settle()
    show(kpi({ pipelineId: P2 }))
    await settle()
    expect(runs).toHaveLength(1)
    // Leaving stops its run (TanStack's signal), and the next one runs.
    first.wrapper.unmount()
    await settle()
    expect(runs).toHaveLength(2)
  })

  it('tries again while the user’s runs are busy, and says so when they stay busy', async () => {
    let busy = 1
    const runs: unknown[] = []
    mockApi({
      'GET connections': () => [200, [CONN]],
      [`GET ${BASE}/pipelines`]: () => [200, { pipelines: [pipe(P)] }],
      [`POST ${BASE}/aggregate/run`]: (body) => {
        runs.push(body)
        if (busy-- > 0) return [429, { code: 'RATE_LIMITED', message: 'busy', details: { retryAfterMs: 10 } }]
        return ndjson([{ _id: null, total: { $numberInt: '9' } }])
      },
    })
    show(kpi())
    await settle()
    await new Promise((r) => setTimeout(r, 60))
    await settle()
    expect(frame().querySelector('[data-kpi-value]')!.textContent!.trim()).toBe('9')
    expect(runs).toHaveLength(2)
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    busy = 100
    show(kpi())
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 60))
      await settle()
    }
    expect(text()).toContain('Too many runs at once')
    expect(text()).not.toContain('cannot be reached')
  })

  it('never runs a pipeline with no stage, and says so', async () => {
    const { runs } = api({ stages: [] })
    show(kpi())
    await settle()
    expect(runs).toEqual([])
    expect(text()).toContain('has no stage')
  })

  it('shows the first number of the document, past fields that are not numbers', async () => {
    api({ docs: [{ _id: 1, label: 'Oct', count: { $numberInt: '5' } }] })
    show(kpi())
    await settle()
    expect(frame().querySelector('[data-kpi-value]')!.textContent!.trim()).toBe('5')
    expect(text()).toContain('count')
  })

  it('is let go with its connection’s cached answers (a refresh, a dropped collection)', async () => {
    const { runs } = api()
    const { queryClient } = show(kpi())
    await settle()
    expect(runs).toHaveLength(1)
    await queryClient.invalidateQueries({
      queryKey: ['connections', C, 'databases', 'shop', 'collections', 'orders'],
    })
    await settle()
    expect(runs).toHaveLength(2)
  })
})

describe('the data KPI widget’s bars', () => {
  it('draws a value below zero in another colour, its text keeping the sign', async () => {
    api({
      docs: [
        { _id: 'up', n: { $numberInt: '4' } },
        { _id: 'down', n: { $numberInt: '-2' } },
      ],
    })
    show(kpi({ display: 'bars' }))
    await settle()
    const bars = [...frame().querySelectorAll('[data-kpi-bar]')]
    expect(bars[1]!.textContent).toContain('-2')
    expect(bars[1]!.querySelector('.bg-warning')).not.toBeNull()
    expect(bars[0]!.querySelector('.bg-accent')).not.toBeNull()
  })
})
