import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { Widget } from '@mongo-manager/shared'
import WidgetSlot from '../src/workspace/overview/widgets/WidgetSlot.vue'
import { _resetSharedMonitors } from '../src/workspace/overview/widgets/sharedMonitor'
import { useDashboardStore } from '../src/stores/dashboard'
import { useTabsStore } from '../src/stores/tabs'
import { useTabSectionsStore } from '../src/stores/tabSections'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'

const C = '00000000-0000-4000-8000-0000000000c1'
const CONN = { id: C, name: 'Production', permissions: ['server:monitor', 'documents:read'] }
const SAMPLE = {
  t: 1,
  ops: { insert: 1, query: 2, update: 3, delete: 4, getmore: 5, command: 6 },
  network: { inPerSec: 100, outPerSec: 200 },
  connections: { current: 7, available: 93 },
  memory: { residentMb: 50, virtualMb: 500 },
  cache: { usedBytes: 25, dirtyBytes: 5, maxBytes: 100 },
  queues: { readers: 1, writers: 2 },
  restarted: false,
  uptimeSec: 90_000,
  version: '8.0.4',
}
const REPLICA = {
  mode: 'replicaSet',
  set: 'rs0',
  date: null,
  primary: 'db1:27017',
  majorityLagSeconds: 0,
  oplogWindowHours: 48,
  members: [],
}

beforeEach(() => {
  setActivePinia(createPinia())
  _resetSharedMonitors()
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  // A save still waiting would reach the next test's mocked server.
  useDashboardStore().reset()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function show(widget: Widget) {
  const store = useDashboardStore()
  store.widgets = [widget]
  store.status = 'ready'
  return mountApp(WidgetSlot, { props: { widget, position: 0, count: 1, editing: false } })
}
const serverCalls = (calls: Array<{ path: string }>) => calls.filter((c) => c.path.includes('/server/'))
const frame = () => document.querySelector('[data-widget]')!

describe('MongoDB widgets (user review 2026-10-09: "Mongo durumu, sunucu durumu")', () => {
  it('shows a server’s status: role, version, uptime, connections, memory, cache and queues', async () => {
    mockApi({
      'GET connections': () => [200, [CONN]],
      [`GET connections/${C}/server/status`]: () => [200, SAMPLE],
      [`GET connections/${C}/server/replica`]: () => [200, REPLICA],
    })
    show({
      id: '00000000-0000-4000-8000-000000000001',
      type: 'serverStatus',
      size: 'm',
      settings: { connectionId: C },
    })
    await flushPromises()
    await flushPromises()
    expect(frame().querySelector('h2')!.textContent).toBe('Server status · Production')
    const text = frame().textContent!
    expect(text).toContain('Replica set rs0')
    expect(text).toContain('8.0.4')
    expect(text).toContain('1 d 1 h')
    expect(text).toContain('7 of 100')
    expect(text).toContain('50 MB')
    expect(text).toContain('25%')
    expect(frame().querySelector('[data-stat="queues"]')!.textContent).toContain('1 / 2')
  })

  it('says when its connection is gone, and asks nothing of the server', async () => {
    const { calls } = mockApi({ 'GET connections': () => [200, []] })
    show({
      id: '00000000-0000-4000-8000-000000000001',
      type: 'serverStatus',
      size: 'm',
      settings: { connectionId: C },
    })
    await flushPromises()
    expect(frame().querySelector('[data-widget-state]')!.textContent).toContain(
      'This connection is no longer there',
    )
    expect(serverCalls(calls)).toHaveLength(0)
  })

  it('says when the user may not see the server, and asks nothing of it', async () => {
    const { calls } = mockApi({
      'GET connections': () => [200, [{ ...CONN, permissions: ['documents:read'] }]],
    })
    show({
      id: '00000000-0000-4000-8000-000000000001',
      type: 'serverStatus',
      size: 'm',
      settings: { connectionId: C },
    })
    await flushPromises()
    expect(frame().querySelector('[data-widget-state]')!.textContent).toContain(
      'You may not see this server’s status',
    )
    expect(serverCalls(calls)).toHaveLength(0)
  })

  it('says when MongoDB refuses to tell', async () => {
    mockApi({
      'GET connections': () => [200, [CONN]],
      [`GET connections/${C}/server/status`]: () => [
        403,
        { code: 'FORBIDDEN', message: 'x', details: { reason: 'mongo_not_permitted' } },
      ],
      [`GET connections/${C}/server/replica`]: () => [200, REPLICA],
    })
    show({
      id: '00000000-0000-4000-8000-000000000001',
      type: 'serverStatus',
      size: 'm',
      settings: { connectionId: C },
    })
    await flushPromises()
    await flushPromises()
    expect(frame().textContent).toContain('clusterMonitor')
  })

  it('draws a metric live, and from stored history for a longer range', async () => {
    const ranges: string[] = []
    mockApi({
      'GET connections': () => [200, [CONN]],
      [`GET connections/${C}/server/status`]: () => [200, SAMPLE],
      [`GET connections/${C}/server/history`]: (_b, url) => {
        ranges.push(url.searchParams.get('range')!)
        return [
          200,
          {
            range: '24h',
            stepMs: 60_000,
            from: new Date(0).toISOString(),
            to: new Date(60_000).toISOString(),
            points: [],
          },
        ]
      },
    })
    show({
      id: '00000000-0000-4000-8000-000000000002',
      type: 'metric',
      size: 'l',
      settings: { connectionId: C, metric: 'connections', range: 'live' },
    })
    await flushPromises()
    await flushPromises()
    expect(frame().querySelector('h2')!.textContent).toBe('Connections · Production')
    expect(frame().querySelector('[data-metric-chart]')).not.toBeNull()
    expect(ranges).toEqual([])
    // A longer range is the widget's setting, kept with the dashboard.
    ;[...frame().querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((b) => b.textContent?.trim() === '24 h')!
      .click()
    await flushPromises()
    expect(useDashboardStore().widgets[0]!.settings).toMatchObject({ range: '24h' })
  })

  // User report 2026-10-27: a chart's range is not one another chart of its metric shows already.
  it('offers a chart’s ranges but those another chart of its server and metric shows', async () => {
    mockApi({
      'GET connections': () => [200, [CONN]],
      [`GET connections/${C}/server/status`]: () => [200, SAMPLE],
    })
    const widget: Widget = {
      id: '00000000-0000-4000-8000-000000000002',
      type: 'metric',
      size: 'l',
      settings: { connectionId: C, metric: 'connections', range: 'live' },
    }
    const other: Widget = {
      id: '00000000-0000-4000-8000-000000000003',
      type: 'metric',
      size: 'l',
      settings: { connectionId: C, metric: 'connections', range: '24h' },
    }
    show(widget)
    useDashboardStore().widgets = [widget, other]
    await flushPromises()
    const radio = (label: string) =>
      [...frame().querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
        (b) => b.textContent?.trim() === label,
      )!
    expect(radio('24 h').disabled).toBe(true)
    expect(radio('7 d').disabled).toBe(false)
    radio('24 h').click()
    await flushPromises()
    expect(useDashboardStore().widgets[0]!.settings).toMatchObject({ range: 'live' })
  })

  const W = (type: Widget['type']) =>
    ({ id: '00000000-0000-4000-8000-000000000009', type, size: 'm', settings: { connectionId: C } }) as Widget

  it('lists a replica set’s members, their state and lag; a standalone server says so', async () => {
    mockApi({
      'GET connections': () => [200, [CONN]],
      [`GET connections/${C}/server/replica`]: () => [
        200,
        {
          ...REPLICA,
          majorityLagSeconds: 2,
          members: [
            { name: 'db1:27017', state: 'PRIMARY', healthy: true, self: true, lagSeconds: 0, pingMs: null },
            { name: 'db2:27017', state: 'SECONDARY', healthy: true, self: false, lagSeconds: 2, pingMs: 3 },
            {
              name: 'db3:27017',
              state: '(not reachable/healthy)',
              healthy: false,
              self: false,
              lagSeconds: null,
              pingMs: null,
            },
          ],
        },
      ],
    })
    show(W('replica'))
    await flushPromises()
    const rows = [...frame().querySelectorAll('[data-member]')].map((r) => r.textContent!)
    expect(rows).toHaveLength(3)
    expect(rows[1]).toContain('db2:27017')
    expect(rows[1]).toContain('SECONDARY')
    expect(rows[1]).toContain('2 s')
    expect(frame().querySelector('[data-member][data-healthy="false"]')).not.toBeNull()
    expect(frame().textContent).toContain('48 h')
  })

  it('says a standalone server has no replica set', async () => {
    mockApi({
      'GET connections': () => [200, [CONN]],
      [`GET connections/${C}/server/replica`]: () => [200, { mode: 'standalone' }],
    })
    show(W('replica'))
    await flushPromises()
    expect(frame().textContent).toContain('This server is not part of a replica set.')
  })

  it('shows the longest operations, and opens the connection’s performance page for all', async () => {
    const asked: string[] = []
    const op = (n: number, secs: number) => ({
      opid: String(n),
      op: 'query',
      ns: `shop.c${n}`,
      secsRunning: secs,
      waitingForLock: false,
      desc: 'conn',
    })
    mockApi({
      'GET connections': () => [200, [CONN]],
      [`GET connections/${C}/server/operations`]: (_b, url) => {
        asked.push(url.searchParams.get('minSecs') ?? '')
        return [
          200,
          { operations: [1, 2, 3, 4, 5, 6, 7].map((n) => op(n, n * 3)), more: false, scope: 'all' },
        ]
      },
    })
    show(W('operations'))
    await flushPromises()
    expect(asked).toEqual(['1'])
    const rows = [...frame().querySelectorAll('[data-operation]')].map((r) => r.textContent!)
    expect(rows).toHaveLength(5)
    expect(rows[0]).toContain('shop.c7')
    expect(rows[0]).toContain('21 s')
    ;[...frame().querySelectorAll('button')].find((b) => b.textContent?.includes('See all'))!.click()
    await flushPromises()
    const tabs = useTabsStore()
    expect(tabs.active).toMatchObject({ kind: 'connection', params: { connectionId: C } })
    expect(useTabSectionsStore().get(tabs.active!.id, 'overview')).toBe('performance')
  })

  it('charts the busiest collections and the databases’ sizes', async () => {
    mockApi({
      'GET connections': () => [200, [{ ...CONN, permissions: ['server:monitor', 'databases:read'] }]],
      [`GET connections/${C}/server/top`]: () => [
        200,
        { collections: [{ ns: 'shop.orders', totalMs: 1200, readMs: 1000, writeMs: 200, count: 9 }] },
      ],
      [`GET connections/${C}/databases`]: () => [
        200,
        { databases: [{ name: 'shop', sizeOnDisk: 2 * 1024 ** 2, empty: false }], totalSize: 2 * 1024 ** 2 },
      ],
    })
    show(W('topCollections'))
    await flushPromises()
    expect(frame().querySelector('table')!.textContent).toContain('shop.orders')
    document.body.innerHTML = ''
    show(W('databaseSizes'))
    await flushPromises()
    expect(frame().querySelector('table')!.textContent).toContain('shop')
    expect(frame().querySelector('table')!.textContent).toContain('2 MB')
  })

  it('says how many databases’ sizes are hidden instead of drawing them (twelfth review)', async () => {
    mockApi({
      'GET connections': () => [200, [{ ...CONN, permissions: ['server:monitor', 'databases:read'] }]],
      [`GET connections/${C}/databases`]: () => [
        200,
        {
          databases: [
            { name: 'shop', sizeOnDisk: null, empty: false },
            { name: 'logs', sizeOnDisk: 1024, empty: false },
          ],
          totalSize: null,
        },
      ],
    })
    show(W('databaseSizes'))
    await flushPromises()
    expect(frame().querySelector('table')!.textContent).toContain('logs')
    expect(frame().querySelector('table')!.textContent).not.toContain('shop')
    expect(frame().textContent).toContain('1 database is not drawn: its size is hidden from you')
    expect(frame().textContent).not.toContain('in all')
  })

  it('asks a databases widget for reading databases, not for watching the server', async () => {
    const { calls } = mockApi({
      'GET connections': () => [200, [{ ...CONN, permissions: ['server:monitor'] }]],
    })
    show(W('databaseSizes'))
    await flushPromises()
    expect(frame().querySelector('[data-widget-state]')!.textContent).toContain(
      'You may not see this connection’s databases',
    )
    expect(calls.some((c) => c.path.includes('/databases'))).toBe(false)
  })

  it('shows a value the server does not report as unknown, never as zero', async () => {
    mockApi({
      'GET connections': () => [200, [CONN]],
      [`GET connections/${C}/server/status`]: () => [
        200,
        { ...SAMPLE, memory: { residentMb: 0, virtualMb: 0 } },
      ],
      [`GET connections/${C}/server/replica`]: () => [200, REPLICA],
    })
    show({
      id: '00000000-0000-4000-8000-000000000001',
      type: 'serverStatus',
      size: 'm',
      settings: { connectionId: C },
    })
    await flushPromises()
    await flushPromises()
    expect(frame().querySelector('[data-stat="memory"] dd')!.textContent!.trim()).toBe('—')
  })

  it('says when a range has no stored readings, instead of an empty chart', async () => {
    mockApi({
      'GET connections': () => [200, [CONN]],
      [`GET connections/${C}/server/history`]: () => [
        200,
        {
          range: '24h',
          stepMs: 60_000,
          from: new Date(0).toISOString(),
          to: new Date(120_000).toISOString(),
          points: [],
        },
      ],
    })
    show({
      id: '00000000-0000-4000-8000-000000000002',
      type: 'metric',
      size: 'l',
      settings: { connectionId: C, metric: 'memory', range: '24h' },
    })
    await flushPromises()
    await flushPromises()
    expect(frame().textContent).toContain('No readings are stored for this range')
  })

  it('asks nothing while the window is hidden: a live widget keeps what it showed (final review 12)', async () => {
    const { calls } = mockApi({
      'GET connections': () => [200, [CONN]],
      [`GET connections/${C}/server/status`]: () => [200, SAMPLE],
      [`GET connections/${C}/server/replica`]: () => [200, REPLICA],
      [`GET connections/${C}/server/history`]: () => [
        200,
        { range: '1h', stepMs: 60_000, from: '', to: '', points: [] },
      ],
    })
    const store = useDashboardStore()
    const metric = {
      id: '00000000-0000-4000-8000-000000000003',
      type: 'metric',
      size: 'l',
      settings: { connectionId: C, metric: 'memory', range: 'live' },
    } as Widget
    const status = {
      id: '00000000-0000-4000-8000-000000000004',
      type: 'serverStatus',
      size: 'm',
      settings: { connectionId: C },
    } as Widget
    store.widgets = [metric, status]
    store.status = 'ready'
    mountApp(WidgetSlot, { props: { widget: metric, position: 0, count: 2, editing: false } })
    mountApp(WidgetSlot, { props: { widget: status, position: 1, count: 2, editing: false } })
    await flushPromises()
    await flushPromises()
    const before = calls.length
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => 'hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    await flushPromises()
    expect(calls.slice(before).map((c) => c.path)).toEqual([])
    hidden.mockRestore()
  })

  it('says why a widget cannot read the server, and tries again on Retry (final review 3, 4)', async () => {
    const refused = { code: 'FORBIDDEN', message: 'x', details: { reason: 'mongo_not_permitted' } }
    let replica: [number, unknown] = [403, refused]
    const { calls } = mockApi({
      'GET connections': () => [200, [CONN]],
      [`GET connections/${C}/server/replica`]: () => replica,
      [`GET connections/${C}/server/operations`]: () => [403, { code: 'FORBIDDEN', message: 'x' }],
      [`GET connections/${C}/server/top`]: () => [502, { code: 'UNREACHABLE', message: 'x' }],
    })
    const store = useDashboardStore()
    const make = (type: string, n: number) =>
      ({
        id: `00000000-0000-4000-8000-00000000001${n}`,
        type,
        size: 'm',
        settings: { connectionId: C },
      }) as Widget
    const widgets = [make('replica', 1), make('operations', 2), make('topCollections', 3)]
    store.widgets = widgets
    store.status = 'ready'
    for (const [i, w] of widgets.entries())
      mountApp(WidgetSlot, { props: { widget: w, position: i, count: 3, editing: false } })
    await flushPromises()
    await flushPromises()
    const text = (type: string) =>
      document.querySelector(`[data-widget="${type}"] [role="alert"]`)!.textContent!
    expect(text('replica')).toContain('clusterMonitor')
    expect(text('operations')).toContain('You may not')
    expect(text('topCollections')).toContain('cannot be reached')
    // Retry asks again, and shows the answer.
    replica = [200, REPLICA]
    const before = calls.filter((c) => c.path.endsWith('/replica')).length
    const retry = document.querySelector<HTMLButtonElement>('[data-widget="replica"] [data-widget-retry]')!
    retry.click()
    await flushPromises()
    await flushPromises()
    expect(calls.filter((c) => c.path.endsWith('/replica')).length).toBe(before + 1)
    expect(document.querySelector('[data-widget="replica"] [role="alert"]')).toBeNull()
  })
})
