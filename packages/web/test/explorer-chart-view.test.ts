import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DocumentsView from '../src/documents/DocumentsView.vue'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { chartOptions, pick } from './support/dom'

// W1 (completion §2): the results as a chart, beside Table, Cards and JSON.
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const T = { connectionId: 'c1', db: 'shop', coll: 'orders' }
const PREFIX = 'connections/c1/databases/shop/collections/orders'
const doc = (i: number, status: string, total: number, email = 'x@y.z') => ({
  document: { _id: { $numberInt: String(i) }, status, total: { $numberInt: String(total) }, email },
  hash: String(i).padStart(64, '0'),
})
const page = [doc(1, 'paid', 10), doc(2, 'paid', 5), doc(3, 'open', 7)]
const select = (label: string) =>
  [...document.querySelectorAll<HTMLSelectElement>('[data-results-chart] select')].find(
    (s) => document.querySelector(`label[for="${s.id}"]`)?.textContent?.trim() === label,
  )!
async function choose(label: string, value: string): Promise<void> {
  const s = select(label)
  s.value = value
  s.dispatchEvent(new Event('change'))
  await flushPromises()
}
/** The chart view loads on first use: wait for it, then for its read. */
async function settle(): Promise<void> {
  await flushPromises()
  await vi.dynamicImportSettled()
  await flushPromises()
}
const finds = (calls: Array<{ path: string; body: unknown }>) => calls.filter((c) => c.path.endsWith('/find'))

describe('chart view', () => {
  it('draws a bar chart of the query’s results from chosen fields, read apart from the page', async () => {
    const { calls } = mockApi({
      'GET connections/c1/personal-fields/applied': () => [200, { rules: [], patterns: [['email']] }],
      [`POST ${PREFIX}/find`]: () => [200, { documents: page, hasMore: false }],
      [`POST ${PREFIX}/count`]: () => [200, { count: 3, exact: true }],
    })
    const state = useCollectionViewsStore().stateFor('tab-c')
    state.query = { filter: { total: { $gt: { $numberInt: '1' } } }, skip: 0, limit: 20, maxTimeMS: 60_000 }
    mountApp(DocumentsView, { props: { target: T, tabId: 'tab-c', canWrite: true, isView: false } })
    await flushPromises()
    document.querySelector<HTMLElement>('[role="radio"][aria-label="Chart"]')!.click()
    await settle()
    expect(state.mode).toBe('chart')
    // Pages are the table's: the chart reads the query's documents itself.
    expect(document.querySelector('button[aria-label="Next page"]')).toBeNull()
    // A first field is chosen for the X axis; the hidden one is never offered.
    expect(state.chart.x).toBe('status')
    const xs = [...select('X axis').options].map((o) => o.value)
    expect(xs).not.toContain('email')
    expect(xs).toEqual(expect.arrayContaining(['status', 'total']))
    const read = finds(calls).at(-1)!.body as Record<string, unknown>
    expect(read).toMatchObject({
      filter: { total: { $gt: { $numberInt: '1' } } },
      limit: 1000,
      skip: 0,
      record: false,
      projection: { _id: 0, status: 1 },
      // W1 review (minor 3): the user's own time limit, not a plugin read's 10 s.
      maxTimeMS: 60_000,
    })
    expect(read).not.toHaveProperty('remember')
    let [chart] = chartOptions()
    expect(chart!.label).toBe('Count by status')
    expect(pick(chart!.option, 'xAxis.data')).toEqual(['paid', 'open'])
    expect(pick(chart!.option, 'series.0.data')).toEqual([2, 1])
    // A screen reader reads the numbers from a table.
    expect(
      [...document.querySelectorAll('[data-results-chart] .sr-only table td')].map((c) => c.textContent),
    ).toEqual(['paid', '2', 'open', '1'])
    await choose('Measure', 'sum')
    await choose('Value', 'total')
    ;[chart] = chartOptions()
    expect(chart!.label).toBe('Sum of total by status')
    expect(pick(chart!.option, 'series.0.data')).toEqual([15, 7])
    expect(finds(calls).at(-1)!.body).toMatchObject({ projection: { _id: 0, status: 1, total: 1 } })
  })

  it('says when only the first documents were charted', async () => {
    mockApi({
      [`POST ${PREFIX}/find`]: (body) =>
        (body as { limit: number }).limit === 1000
          ? [200, { documents: Array.from({ length: 1000 }, (_, i) => doc(i, 'paid', 1)), hasMore: true }]
          : [200, { documents: page, hasMore: true }],
      [`POST ${PREFIX}/count`]: () => [200, { count: 12345, exact: true }],
    })
    const state = useCollectionViewsStore().stateFor('tab-n')
    state.mode = 'chart'
    state.chart = { kind: 'pie', x: 'status', y: '', group: '', measure: 'count' }
    mountApp(DocumentsView, { props: { target: T, tabId: 'tab-n', canWrite: true, isView: false } })
    await settle()
    expect(document.querySelector('[data-results-chart]')!.textContent).toContain(
      'Charted the first 1,000 of 12,345 matching documents.',
    )
    expect(pick(chartOptions()[0]!.option, 'series.0.type')).toBe('pie')
  })

  it('refuses a hidden field kept from before, and never asks the server for it (phase 3c)', async () => {
    const { calls } = mockApi({
      'GET connections/c1/personal-fields/applied': () => [200, { rules: [], patterns: [['email']] }],
      [`POST ${PREFIX}/find`]: () => [200, { documents: page, hasMore: false }],
      [`POST ${PREFIX}/count`]: () => [200, { count: 3, exact: true }],
    })
    const state = useCollectionViewsStore().stateFor('tab-m')
    state.mode = 'chart'
    state.chart = { kind: 'bar', x: 'email', y: '', group: '', measure: 'count' }
    mountApp(DocumentsView, { props: { target: T, tabId: 'tab-m', canWrite: true, isView: false } })
    await settle()
    expect(document.querySelector('[data-results-chart]')!.textContent).toContain(
      '“email” holds personal data hidden from you, so it is not charted.',
    )
    expect(chartOptions()).toEqual([])
    expect(finds(calls).filter((c) => (c.body as { limit: number }).limit === 1000)).toEqual([])
  })

  // W1 review (minor 5, minor 6): a pie offers count and sum only, and says why it draws no negative
  // sum; a change of field shows the skeleton while the new read loads, never "Nothing to chart".
  it('offers a pie count and sum only, refuses negative sums, and waits with a skeleton', async () => {
    let release: (() => void) | undefined
    let hold = false
    mockApi({
      [`POST ${PREFIX}/find`]: (body) => {
        const b = body as { limit: number }
        if (b.limit !== 1000) return [200, { documents: page, hasMore: false }]
        const docs = [doc(1, 'paid', -10), doc(2, 'open', 5)]
        if (!hold) return [200, { documents: docs, hasMore: false }]
        return new Promise((resolve) => {
          release = () => resolve([200, { documents: docs, hasMore: false }])
        })
      },
      [`POST ${PREFIX}/count`]: () => [200, { count: 2, exact: true }],
    })
    const state = useCollectionViewsStore().stateFor('tab-p')
    state.mode = 'chart'
    state.chart = { kind: 'pie', x: 'status', y: '', group: '', measure: 'avg' }
    mountApp(DocumentsView, { props: { target: T, tabId: 'tab-p', canWrite: true, isView: false } })
    await settle()
    expect([...select('Measure').options].map((o) => o.value)).toEqual(['count', 'sum'])
    expect(state.chart.measure).toBe('sum')
    await choose('Value', 'total')
    const chart = document.querySelector('[data-results-chart]')!
    expect(chart.textContent).toContain('A pie cannot show negative sums.')
    expect(chartOptions()).toEqual([])
    await choose('Measure', 'count')
    expect(chartOptions()).toHaveLength(1)
    // Another field: the last documents are not drawn with it while the new read loads.
    hold = true
    await choose('Slices', 'email')
    expect(chart.querySelector('[data-chart-loading]')).not.toBeNull()
    expect(chart.textContent).not.toContain('Nothing to chart')
    release!()
    await settle()
    expect(chart.querySelector('[data-chart-loading]')).toBeNull()
  })
})
