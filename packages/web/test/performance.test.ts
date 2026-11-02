import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref } from 'vue'
import { PERMISSIONS } from '@mongo-manager/shared'
import { setCsrfToken } from '../src/api/client'
import { setJobsSocketFactory, useJobsLive } from '../src/jobs/live'
import type { SocketLike } from '../src/jobs/socket'
import PerformanceView from '../src/monitor/PerformanceView.vue'
import ConnectionTab from '../src/workspace/tabs/ConnectionTab.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { useToastStore } from '../src/stores/toasts'
import { useSessionStore } from '../src/stores/session'
import { useWorkspaceDialogs } from '../src/stores/workspaceDialogs'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, chartOptions, pick } from './support/dom'

beforeEach(() => {
  shown.value = true
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  // The operations filter is kept per connection in sessionStorage (phase 3b): start clean.
  sessionStorage.clear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const sample = (t: number, over: object = {}) => ({
  connectionId: 'c1',
  t,
  ops: { insert: 1, query: 2, update: 0, delete: 0, getmore: 0, command: 5 },
  network: { inPerSec: 1024, outPerSec: 2048 },
  connections: { current: 7, available: 93 },
  memory: { residentMb: 120, virtualMb: 900 },
  cache: { usedBytes: 50 * 1024 ** 2, dirtyBytes: 1024 ** 2, maxBytes: 256 * 1024 ** 2 },
  queues: { readers: 1, writers: 0 },
  restarted: false,
  ...over,
})

/** The live socket, as the header would open it, driven by the test. */
function liveSocket() {
  const sent: unknown[] = []
  let socket!: SocketLike
  setJobsSocketFactory(() => {
    socket = {
      send: (d) => sent.push(JSON.parse(d)),
      close: () => undefined,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    }
    return socket
  })
  setCsrfToken('t')
  const receive = (m: unknown) => socket.onmessage?.({ data: JSON.stringify(m) })
  return {
    sent,
    ready: () => {
      socket.onopen?.()
      receive({ type: 'ready' })
    },
    receive,
  }
}

/** A figure of the "Right now" card, by its label. */
const figure = (label: string) =>
  [...document.querySelectorAll('dl > div')]
    .find((d) => d.querySelector('dt')?.textContent?.trim() === label)
    ?.querySelector('dd')
    ?.textContent?.trim()

/** The entries of the menu a button opens (UI redesign R3: a row's actions are in its "…"). */
async function openMenu(label: string): Promise<HTMLElement[]> {
  const trigger = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!trigger) return []
  trigger.click()
  await flushPromises()
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}
const itemNamed = (items: HTMLElement[], name: string) =>
  items.find((i) => i.querySelector('span > span')?.textContent?.trim() === name)

const OPS = [
  {
    opid: '11',
    op: 'query',
    ns: 'shop.orders',
    secsRunning: 12.5,
    waitingForLock: false,
    desc: 'conn1',
    planSummary: 'COLLSCAN',
  },
]

function api(extra: Record<string, (body?: unknown, url?: URL) => [number, unknown?]> = {}) {
  return mockApi({
    'GET connections/c1/server/operations': () => [200, { operations: OPS }],
    'GET connections/c1/server/top': () => [
      200,
      { collections: [{ ns: 'shop.orders', totalMs: 900, readMs: 800, writeMs: 100, count: 12 }] },
    ],
    'GET connections/c1/server/status': () => [200, sample(Date.now())],
    // Phase 3b: the profiler and slow-query panels of the same view.
    'GET connections/c1/server/profiler': () => [200, { scope: 'mongod', databases: [] }],
    'GET connections/c1/server/slow-queries': () => [200, { entries: [], refused: {} }],
    'GET connections/c1/server/history/settings': () => [
      200,
      { enabled: true, samples: 2, lastError: false, lastErrorAt: null },
    ],
    ...extra,
  })
}

/** The tab lives inside the signed-in workspace, whose header keeps the socket; closing the tab leaves it open. */
const shown = ref(true)
const Host = (props: { canOperate: boolean; live?: boolean }) =>
  defineComponent(() => {
    if (props.live) useJobsLive()
    return () =>
      h('div', [
        shown.value ? h(PerformanceView, { connectionId: 'c1', canOperate: props.canOperate }) : null,
        h(DialogHost),
      ])
  })

describe('the Performance tab (phase 1i spec §7)', () => {
  it('watches the server over the live socket, keeps 150 samples, and stops watching when closed', async () => {
    api()
    const live = liveSocket()
    const { wrapper } = mountApp(Host({ canOperate: false, live: true }))
    await flushPromises()
    live.ready()
    expect(live.sent).toContainEqual({ ch: 'monitor', type: 'sub', connectionId: 'c1' })
    for (let i = 0; i < 160; i++) live.receive({ ch: 'monitor', type: 'sample', payload: sample(i) })
    await flushPromises()
    const charts = chartOptions()
    expect(charts.length).toBeGreaterThanOrEqual(4)
    const ops = charts.find((c) => c.label.startsWith('Operations per second'))!
    expect(pick(ops.option, 'series.0.data')).toHaveLength(150)
    // UI redesign R3: the latest reading is a card of figures (not a live region: it changes every 2 s).
    expect(figure('Connections')).toBe('7')
    expect(figure('Queued (read · write)')).toBe('1 · 0')
    // Review of the Monitoring redesign (minor): how full the cache is, is a meter, not progress.
    expect(document.querySelector('[role="meter"]')!.getAttribute('aria-label')).toBe('Cache fill')
    expect(document.querySelector('[data-performance] [role="progressbar"]')).toBeNull()
    expect(document.querySelector('[data-performance] [aria-live]')).toBeNull()
    shown.value = false
    await flushPromises()
    expect(live.sent.at(-1)).toEqual({ ch: 'monitor', type: 'unsub', connectionId: 'c1' })
    wrapper.unmount()
  })

  it('says why the server cannot be watched', async () => {
    api()
    const live = liveSocket()
    mountApp(Host({ canOperate: false, live: true }))
    await flushPromises()
    live.ready()
    live.receive({ ch: 'monitor', type: 'error', payload: { connectionId: 'c1', code: 'NOT_PERMITTED' } })
    await flushPromises()
    expect(document.body.textContent).toContain(
      'MongoDB refused serverStatus: the account needs the clusterMonitor role.',
    )
  })

  it('asks for the status every 5 seconds when there is no live socket', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { calls } = api()
    mountApp(Host({ canOperate: false }))
    await flushPromises()
    const polls = () => calls.filter((c) => c.path === 'connections/c1/server/status').length
    const first = polls()
    vi.advanceTimersByTime(10_000)
    await flushPromises()
    expect(polls()).toBe(first + 2)
  })

  it('lists the slowest operations; only a connection admin sees commands and may kill, after confirming', async () => {
    let killedGone = false
    const { calls } = api({
      'GET connections/c1/server/operations': () => [
        200,
        {
          operations: killedGone
            ? []
            : [{ ...OPS[0], command: '{"find":"orders"}', startedAt: 1_700_000_000_000, member: 'abc123' }],
        },
      ],
      'POST connections/c1/server/operations/11/kill': () => {
        killedGone = true
        return [200, { killed: '11' }]
      },
    })
    mountApp(Host({ canOperate: true }))
    await flushPromises()
    const row = document.querySelector('[data-op="11"]')!.closest('tr')!
    expect(row.textContent).toContain('shop.orders')
    expect(row.textContent).toContain('12.5 s')
    expect(row.textContent).toContain('COLLSCAN')
    // UI redesign R3: no red button on the row; the command and Kill are in the row's "…".
    expect(row.querySelector('.text-danger')).toBeNull()
    let items = await openMenu('Actions for operation 11')
    expect(items.map((i) => i.querySelector('span > span')?.textContent?.trim())).toEqual([
      'Show command',
      'Kill operation',
    ])
    expect(itemNamed(items, 'Kill operation')!.className).toContain('text-danger')
    itemNamed(items, 'Show command')!.click()
    await flushPromises()
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('{"find":"orders"}')
    document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"]')!.click()
    await flushPromises()
    items = await openMenu('Actions for operation 11')
    itemNamed(items, 'Kill operation')!.click()
    await flushPromises()
    // Nothing is killed before the confirmation.
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
    button('Kill operation').click()
    await flushPromises()
    // Review of B3 (M-3): what the dialog showed is what may be stopped — the route checks it.
    expect(calls.find((c) => c.method === 'POST' && c.path.endsWith('/11/kill'))?.body).toEqual({
      ns: 'shop.orders',
      op: 'query',
      startedAt: 1_700_000_000_000,
      member: 'abc123',
    })
    expect(useToastStore().toasts.at(-1)?.message).toBe('Operation 11 was killed.')
    // Review of the Monitoring redesign (minor): the row gone, focus lands on the card's title, not
    // on the page's body.
    killedGone = true
    await flushPromises()
    await flushPromises()
    expect(document.activeElement?.textContent?.trim()).toBe('Slowest operations')
  })

  it('filters the operations, says when there are more or only its own, and pauses (phase 3b §4)', async () => {
    const asked: URLSearchParams[] = []
    api({
      'GET connections/c1/server/operations': (_b?: unknown, url?: URL) => {
        asked.push(url!.searchParams)
        return [200, { operations: OPS, more: true, scope: 'own' }]
      },
    })
    mountApp(Host({ canOperate: false }))
    await flushPromises()
    expect(document.querySelector('[data-ops-more]')).not.toBeNull()
    // Review of the Monitoring redesign (minor): the count says there are more than it lists.
    expect(document.querySelector('[data-operations] header .tabular-nums')!.textContent).toBe('1+')
    expect(document.querySelector('[data-ops-own-only]')?.textContent).toContain('clusterMonitor')
    const ns = document.querySelector('[data-ops-ns]') as HTMLInputElement
    ns.value = 'crm'
    ns.dispatchEvent(new Event('input'))
    ;(document.querySelector('[data-ops-kind="query"]') as HTMLInputElement).click()
    ;(document.querySelector('[data-ops-filter]') as HTMLFormElement).dispatchEvent(new Event('submit'))
    await flushPromises()
    expect(Object.fromEntries(asked.at(-1)!)).toEqual({ ns: 'crm', op: 'query' })
    const before = asked.length
    ;(document.querySelector('[data-ops-pause]') as HTMLButtonElement).click()
    await flushPromises()
    expect(document.querySelector('[data-ops-pause]')?.textContent).toContain('Resume')
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(11_000)
    vi.useRealTimers()
    expect(asked.length).toBe(before)
  })

  it('draws a stored range from the history instead of the live samples (phase 3b §6)', async () => {
    const asked: string[] = []
    const now = Date.now()
    const step = 5 * 60_000
    api({
      'GET connections/c1/server/history': (_b?: unknown, url?: URL) => {
        asked.push(url!.searchParams.get('range')!)
        return [
          200,
          {
            range: '24h',
            stepMs: step,
            from: new Date(now - 24 * 3600_000).toISOString(),
            to: new Date(now).toISOString(),
            points: [
              {
                t: Math.floor(now / step) * step,
                ops: { insert: 0, query: 42, update: 0, delete: 0, getmore: 0, command: 0 },
                network: { inPerSec: 1, outPerSec: 1 },
                connections: { current: 7, available: 1 },
                memory: { residentMb: 1, virtualMb: 1 },
                cache: null,
                queues: { readers: 0, writers: 0 },
                restarted: false,
              },
            ],
          },
        ]
      },
    })
    mountApp(
      defineComponent(
        () => () => h(PerformanceView, { connectionId: 'c1', canOperate: false, range: '24h' }),
      ),
    )
    await flushPromises()
    expect(asked).toEqual(['24h'])
    const ops = chartOptions().find((c) => c.label.startsWith('Operations per second'))!
    expect(ops.label).toContain('query 42')
    expect(document.querySelector('[data-history-note]')).toBeNull()
  })

  it('says why a stored span is empty when history is not recorded (phase 3b §6)', async () => {
    api({
      'GET connections/c1/server/history/settings': () => [
        200,
        { enabled: false, samples: 0, lastError: false, lastErrorAt: null },
      ],
      'GET connections/c1/server/history': () => [
        200,
        {
          range: '1h',
          stepMs: 60_000,
          from: new Date().toISOString(),
          to: new Date().toISOString(),
          points: [],
        },
      ],
    })
    mountApp(
      defineComponent(() => () => h(PerformanceView, { connectionId: 'c1', canOperate: false, range: '1h' })),
    )
    await flushPromises()
    expect(document.querySelector('[data-history-note]')!.textContent).toContain('not being recorded')
  })

  it('shows no kill button or command to an editor, and the hottest collections as bars', async () => {
    api()
    mountApp(Host({ canOperate: false }))
    await flushPromises()
    // Neither a command (the server sends none) nor Kill: the row has no menu at all.
    expect(await openMenu('Actions for operation 11')).toEqual([])
    const hottest = chartOptions().find((c) => c.label.startsWith('Total time'))!
    expect(pick(hottest.option, 'yAxis.data')).toEqual(['shop.orders'])
    expect(document.body.textContent).toContain('shop.orders')
  })
})

describe('the connection tab (phase 1i)', () => {
  const connection = (permissions: string[]) => ({
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
    access: 'editor',
    permissions,
  })

  it('offers the Performance section only with server:monitor', async () => {
    mockApi({
      'GET connections': () => [200, [connection(PERMISSIONS.filter((p) => p !== 'server:monitor'))]],
      'GET connections/c1/databases': () => [200, { databases: [], totalSize: 0 }],
    })
    mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    await flushPromises()
    // Phase 3e-1: Watch remains (documents:read); Performance does not. W3: Users & roles follows
    // for a connection admin (databases:admin).
    const names = [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent?.trim())
    // User request 2026-10-23: Backups and Personal data after them.
    expect(names).toEqual(['Overview', 'Watch', 'Users & roles', 'Backups', 'Personal data'])
  })

  // Review of the short connection form (2026-10-16): a connection that cannot list its databases is
  // fixed from its own tab, beside Retry.
  it('offers Edit connection beside Retry when the databases cannot be read', async () => {
    mockApi({
      'GET connections': () => [200, [connection([...PERMISSIONS])]],
      'GET connections/c1/databases': () => [500, { code: 'INTERNAL', message: 'down' }],
    })
    useSessionStore().me = { permissions: [...PERMISSIONS] } as never
    mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    await flushPromises()
    await flushPromises()
    const edit = document.querySelector<HTMLButtonElement>('[data-edit-connection]')!
    expect(edit.textContent?.trim()).toBe('Edit connection')
    edit.click()
    expect(useWorkspaceDialogs().current).toMatchObject({ kind: 'connection', connection: { id: 'c1' } })
  })

  it('switches to Performance', async () => {
    api({
      'GET connections': () => [200, [connection([...PERMISSIONS])]],
      'GET connections/c1/databases': () => [200, { databases: [], totalSize: 0 }],
    })
    mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    await flushPromises()
    const tab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (t) => t.textContent?.trim() === 'Performance',
    )!
    tab.click()
    await flushPromises()
    expect(chartOptions().length).toBeGreaterThanOrEqual(4)
  })

  // UI redesign R3 §4: the time span is in the connection's header while Performance is open.
  it('chooses Performance’s time span in the header', async () => {
    const asked: string[] = []
    api({
      'GET connections': () => [200, [connection([...PERMISSIONS])]],
      'GET connections/c1/databases': () => [200, { databases: [], totalSize: 0 }],
      'GET connections/c1/server/history': (_b?: unknown, url?: URL) => {
        asked.push(url!.searchParams.get('range')!)
        return [
          200,
          {
            range: '7d',
            stepMs: 3_600_000,
            from: new Date().toISOString(),
            to: new Date().toISOString(),
            points: [],
          },
        ]
      },
    })
    const { wrapper } = mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    await flushPromises()
    const span = () => document.querySelector('header [role="radiogroup"][aria-label="Time span"]')
    expect(span()).toBeNull()
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((t) => t.textContent?.trim() === 'Performance')!
      .click()
    await flushPromises()
    const choice = [...span()!.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
      (r) => r.textContent?.trim() === '7 days',
    )!
    choice.click()
    await flushPromises()
    expect(choice.getAttribute('aria-checked')).toBe('true')
    expect(asked).toEqual(['7d'])
    // Review of the Monitoring redesign (minor): kept with the tab, as its section is — another
    // workspace tab shown and this one shown again finds the same span.
    wrapper.unmount()
    document.body.innerHTML = ''
    mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    await flushPromises()
    const again = [...span()!.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
      (r) => r.textContent?.trim() === '7 days',
    )!
    expect(again.getAttribute('aria-checked')).toBe('true')
  })
})

// Third review of B3 (M1, M6): an operation not on the primary is listed, never offered to stop; a kill
// refused because another runs under that opid is said in its own words.
describe('stopping an operation, reviewed', () => {
  it('offers no Kill for an operation another member runs', async () => {
    api({
      'GET connections/c1/server/operations': () => [200, { operations: [{ ...OPS[0], killable: false }] }],
    })
    mountApp(Host({ canOperate: true }))
    await flushPromises()
    const items = await openMenu('Actions for operation 11')
    expect(itemNamed(items, 'Kill operation')).toBeUndefined()
  })

  it('says when another operation runs under that opid now', async () => {
    api({
      'GET connections/c1/server/operations': () => [200, { operations: [OPS[0]] }],
      'POST connections/c1/server/operations/11/kill': () => [
        409,
        { code: 'CONFLICT', message: 'x', details: { reason: 'operation_changed' } },
      ],
    })
    mountApp(Host({ canOperate: true }))
    await flushPromises()
    itemNamed(await openMenu('Actions for operation 11'), 'Kill operation')!.click()
    await flushPromises()
    button('Kill operation').click()
    await flushPromises()
    expect(useToastStore().toasts.at(-1)?.message).toBe(
      'Another operation runs under that opid now: nothing was stopped.',
    )
  })
})
