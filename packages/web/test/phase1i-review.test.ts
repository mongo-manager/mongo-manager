// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { PERMISSIONS, SchemaAnalyser } from '@mongo-manager/shared'
import LineChart from '../src/charts/LineChart.vue'
import BarChart from '../src/charts/BarChart.vue'
import OperationsTable from '../src/monitor/OperationsTable.vue'
import PerformanceView from '../src/monitor/PerformanceView.vue'
import SchemaView from '../src/schema/SchemaView.vue'
import ConnectionTab from '../src/workspace/tabs/ConnectionTab.vue'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, chartOptions, pick } from './support/dom'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

/** The entries of an operation's row menu (none when it has no menu), closed again after reading. */
async function rowMenu(opid: string): Promise<string[]> {
  const trigger = document.querySelector<HTMLButtonElement>(
    `button[aria-label="Actions for operation ${opid}"]`,
  )
  if (!trigger) return []
  trigger.click()
  await flushPromises()
  const items = [...document.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent?.trim() ?? '')
  trigger.click()
  await flushPromises()
  return items
}

const connection = (over: object = {}) => ({
  id: 'c1',
  name: 'Prod',
  group: null,
  color: null,
  favorite: false,
  readOnly: false,
  settings: {},
  uri: 'mongodb://db1:27017',
  createdAt: 0,
  updatedAt: 0,
  lastUsedAt: null,
  access: 'admin',
  permissions: [...PERMISSIONS],
  ...over,
})

describe('final review 1i (web)', () => {
  it('moves between connection sections with the arrow keys, Home and End (Important 4)', async () => {
    mockApi({
      'GET connections': () => [200, [connection()]],
      'GET connections/c1/databases': () => [200, { databases: [], totalSize: 0 }],
      'GET connections/c1/server/operations': () => [200, { operations: [] }],
      'GET connections/c1/server/top': () => [200, { collections: [] }],
      'GET connections/c1/server/status': () => [200, null],
    })
    mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    await flushPromises()
    const tabs = () => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    const panel = document.querySelector('[role="tabpanel"]')!
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs()[0]!.id)
    expect(tabs()[0]!.getAttribute('aria-controls')).toBe(panel.id)
    tabs()[0]!.focus()
    tabs()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await flushPromises()
    expect(document.activeElement).toBe(tabs()[1])
    expect(tabs()[1]!.getAttribute('aria-selected')).toBe('true')
    tabs()[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    await flushPromises()
    expect(document.activeElement).toBe(tabs()[0])
    tabs()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    await flushPromises()
    // Phase 3e-1: Watch, then (W3) Users & roles for a connection admin, the last section now.
    expect(document.activeElement).toBe(tabs().at(-1))
    expect(tabs().at(-1)!.textContent?.trim()).toBe('Personal data')
  })

  it('draws no rate for a sample that has nothing to compare with (Minor 4)', async () => {
    const sample = (t: number, baseline: boolean) => ({
      t,
      ops: { insert: baseline ? 0 : 5, query: 0, update: 0, delete: 0, getmore: 0, command: 0 },
      network: { inPerSec: 0, outPerSec: 0 },
      connections: { current: 3, available: 7 },
      memory: { residentMb: 1, virtualMb: 1 },
      cache: null,
      queues: { readers: 0, writers: 0 },
      restarted: false,
      baseline,
    })
    let n = 0
    mockApi({
      'GET connections/c1/server/status': () => [200, sample(n++, n === 1)],
      'GET connections/c1/server/operations': () => [200, { operations: [] }],
      'GET connections/c1/server/top': () => [200, { collections: [] }],
    })
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      mountApp(PerformanceView, { props: { connectionId: 'c1', canOperate: false } })
      await flushPromises()
      vi.advanceTimersByTime(5_000)
      await flushPromises()
      const chart = (name: string) => chartOptions().find((c) => c.label.startsWith(name))!
      // One point after the baseline: no line down to a zero that was never measured.
      expect(pick(chart('Operations per second').option, 'series.0.data')).toEqual([5])
      expect(pick(chart('Connections').option, 'series.0.data')).toEqual([3, 3])
    } finally {
      vi.useRealTimers()
    }
  })

  it('names the missing MongoDB role when polling is refused (Minor 5)', async () => {
    mockApi({
      'GET connections/c1/server/status': () => [
        403,
        { code: 'FORBIDDEN', message: 'x', details: { reason: 'mongo_not_permitted' } },
      ],
      'GET connections/c1/server/operations': () => [200, { operations: [] }],
      'GET connections/c1/server/top': () => [200, { collections: [] }],
    })
    mountApp(PerformanceView, { props: { connectionId: 'c1', canOperate: false } })
    await flushPromises()
    expect(document.body.textContent).toContain('the account needs the clusterMonitor role')
  })

  it('keeps bars right when labels repeat (Minor 15)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const same = (value: number) => ({ label: '5 – 5', value })
    const { wrapper } = mountApp(BarChart, { props: { label: 'x', items: [same(1), same(2), same(4)] } })
    await wrapper.setProps({ items: [same(4), same(2)] })
    await flushPromises()
    expect(pick(chartOptions()[0]!.option, 'series.0.data')).toEqual([4, 2])
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/Duplicate keys/)
    warn.mockRestore()
  })

  it('analyses only on Analyse, whatever the size chosen afterwards (Minor 16)', async () => {
    const a = new SchemaAnalyser()
    a.add({ x: 1 })
    const { calls } = mockApi({
      'POST connections/c1/databases/shop/collections/orders/schema': () => [200, a.result()],
    })
    mountApp(SchemaView, { props: { target: { connectionId: 'c1', db: 'shop', coll: 'orders' } } })
    await flushPromises()
    button('Analyse').click()
    await flushPromises()
    const size = byLabel<HTMLSelectElement>('Sample size')
    size.value = '10000'
    size.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
    expect(document.querySelector('[data-field="x"]')).not.toBeNull()
  })

  it('offers kill only where the server would do it (Minor 17)', async () => {
    const op = (opid: string, ns: string, command?: string) => ({
      opid,
      op: 'query',
      ns,
      secsRunning: 1,
      waitingForLock: false,
      desc: 'conn',
      ...(command ? { command } : {}),
    })
    mockApi({
      'GET connections': () => [200, [connection()]],
      'GET connections/c1/server/operations': () => [
        200,
        {
          operations: [
            op('1', 'shop.orders', '{"find":"orders"}'),
            op('2', 'admin.things'),
            op('3', 'shop.jobs', '{"find":"jobs","comment":"mm-job:9"}'),
          ],
        },
      ],
    })
    mountApp(OperationsTable, { props: { connectionId: 'c1', canOperate: true } })
    await flushPromises()
    // UI redesign R3: Kill is an entry of each row's "…" menu.
    const killable: string[] = []
    for (const opid of ['1', '2', '3'])
      if ((await rowMenu(opid)).includes('Kill operation')) killable.push(opid)
    expect(killable).toEqual(['1'])
  })

  it('offers no kill on a read-only connection (Minor 17)', async () => {
    mockApi({
      'GET connections': () => [200, [connection({ readOnly: true })]],
      'GET connections/c1/server/operations': () => [
        200,
        {
          operations: [
            { opid: '1', op: 'query', ns: 'shop.orders', secsRunning: 1, waitingForLock: false, desc: '' },
          ],
        },
      ],
    })
    mountApp(OperationsTable, { props: { connectionId: 'c1', canOperate: true } })
    await flushPromises()
    expect(await rowMenu('1')).not.toContain('Kill operation')
  })

  it('says the latest values in its name (Minor 18)', async () => {
    mountApp(LineChart, {
      props: {
        label: 'Operations per second',
        series: [{ name: 'insert', points: [1, 3] }],
        format: (v: number) => `${v}/s`,
      },
    })
    await flushPromises()
    // The latest values are in the chart's accessible name (axis labels are drawn by ECharts).
    expect(chartOptions()[0]!.label).toBe('Operations per second: insert 3/s')
  })
})
