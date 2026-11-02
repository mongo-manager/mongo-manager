import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { focusManager } from '@tanstack/vue-query'
import type { Widget } from '@mongo-manager/shared'
import WidgetSlot from '../src/workspace/overview/widgets/WidgetSlot.vue'
import { _resetSharedMonitors } from '../src/workspace/overview/widgets/sharedMonitor'
import { useDashboardStore } from '../src/stores/dashboard'
import { useTabsStore } from '../src/stores/tabs'
import { useTabSectionsStore } from '../src/stores/tabSections'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'

/** Widgets wave 2 (2026-10-27): the widgets built on what the server already reads. */
const C = '00000000-0000-4000-8000-0000000000c1'
const CONN = { id: C, name: 'Production', permissions: ['server:monitor', 'documents:read'] }
const ID = '00000000-0000-4000-8000-000000000021'

beforeEach(() => {
  setActivePinia(createPinia())
  _resetSharedMonitors()
  i18n.global.locale.value = 'en'
})
afterEach(() => {
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
const onServer = (type: Widget['type'], settings: object = { connectionId: C }) =>
  ({ id: ID, type, size: 'm', settings }) as Widget
const frame = () => document.querySelector('[data-widget]')!
const text = () => frame().textContent!.replace(/\s+/g, ' ')
const settle = async () => {
  await flushPromises()
  await flushPromises()
}
const linkTo = (label: string) =>
  [...frame().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(label))!
function openedSection(): string | null {
  const tabs = useTabsStore()
  const tab = tabs.tabs.find((x) => x.kind === 'connection')
  return tab ? useTabSectionsStore().get(tab.id, 'overview') : null
}

describe('the slow queries widget', () => {
  const ENTRY = {
    source: 'profile',
    ts: '2026-10-27T10:00:00.000Z',
    ns: 'shop.orders',
    op: 'query',
    durationMs: 1250,
    planSummary: 'COLLSCAN',
    docsExamined: 4000,
    nreturned: 100,
    command: '{"filter":{"email":"a-literal-value"}}',
  }

  it('lists the latest slow operations, never their command, and opens Performance for all', async () => {
    const asked: string[] = []
    mockApi({
      'GET connections': () => [200, [CONN]],
      [`GET connections/${C}/server/slow-queries`]: (_b, url) => {
        asked.push(url.search)
        return [
          200,
          { entries: [ENTRY, { ...ENTRY, ns: 'shop.users', durationMs: 300, nreturned: 0 }], refused: {} },
        ]
      },
    })
    show(onServer('slowQueries'))
    await settle()
    expect(asked[0]).toContain('limit=5')
    // The server log, which holds every database's slow operations (the profiler is one database's).
    expect(asked[0]).toContain('source=log')
    const rows = [...frame().querySelectorAll('[data-slow-query]')].map((r) =>
      r.textContent!.replace(/\s+/g, ' '),
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('shop.orders')
    expect(rows[0]).toContain('1,250 ms')
    expect(rows[0]).toContain('40 examined per returned')
    expect(rows[0]).toContain('COLLSCAN')
    // Nothing returned: no ratio to say.
    expect(rows[1]).not.toContain('per returned')
    expect(text()).not.toContain('a-literal-value')
    expect(text()).not.toContain('filter')
    linkTo('See all on the performance page').click()
    await flushPromises()
    expect(openedSection()).toBe('performance')
  })

  it('says when there are none, and which source MongoDB refused', async () => {
    mockApi({
      'GET connections': () => [200, [CONN]],
      [`GET connections/${C}/server/slow-queries`]: () => [
        200,
        { entries: [], refused: { log: 'not_permitted' } },
      ],
    })
    show(onServer('slowQueries'))
    await settle()
    expect(text()).toContain('No slow operation')
    expect(text()).toContain('MongoDB refused the server log: the account needs the clusterMonitor role.')
  })
})

describe('the alerts widget', () => {
  const alert = (over: object) => ({
    id: 'a1',
    ruleId: 'r1',
    connectionId: C,
    connectionName: 'Production',
    metric: 'connections',
    event: null,
    state: 'firing',
    value: 950,
    threshold: 800,
    startedAt: '2026-10-27T09:00:00.000Z',
    resolvedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    detail: {},
    deliveries: [],
    snoozed: false,
    ...over,
  })

  it('shows the alerts firing now, not the resolved ones, and opens Alerts', async () => {
    mockApi({
      'GET alerts/active': () => [
        200,
        [alert({}), alert({ id: 'a2', state: 'resolved', metric: 'opcounters' })],
      ],
      'GET me/alerts': () => [200, { inApp: true, available: true }],
    })
    show({ id: ID, type: 'alerts', size: 'm', settings: {} } as Widget)
    await settle()
    const rows = [...frame().querySelectorAll('[data-alert]')]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.textContent).toContain('Production')
    linkTo('See all alerts').click()
    await flushPromises()
    expect(useTabsStore().tabs.some((x) => x.kind === 'alerts')).toBe(true)
  })

  it('says all is quiet, and says when the bell is off for the user or alerts are off', async () => {
    let optIn = { inApp: true, available: true }
    mockApi({
      'GET alerts/active': () => [200, []],
      'GET me/alerts': () => [200, optIn],
    })
    show({ id: ID, type: 'alerts', size: 'm', settings: {} } as Widget)
    await settle()
    expect(text()).toContain('No alert is firing')
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    optIn = { inApp: false, available: true }
    show({ id: ID, type: 'alerts', size: 'm', settings: {} } as Widget)
    await settle()
    expect(text()).toContain('turned off for you')
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    optIn = { inApp: false, available: false }
    show({ id: ID, type: 'alerts', size: 'm', settings: {} } as Widget)
    await settle()
    expect(text()).toContain('not turned on')
  })
})

describe('the index health widget', () => {
  it('counts the missing, unused and repeated indexes of its database, and names the first suggestions', async () => {
    const asked: string[] = []
    mockApi({
      'GET connections': () => [200, [CONN]],
      [`GET connections/${C}/server/index-advice`]: (_b, url) => {
        asked.push(url.searchParams.get('db')!)
        return [
          200,
          {
            suggestions: [
              {
                ns: 'shop.orders',
                key: [
                  ['status', 1],
                  ['at', -1],
                ],
                count: 9,
                totalMs: 900,
                avgMs: 100,
                ratio: 50,
                reason: { equality: ['status'], sort: ['at'], range: [] },
              },
            ],
            unneeded: [
              { ns: 'shop.orders', name: 'old_1', key: { old: 1 }, reason: 'unused' },
              { ns: 'shop.users', name: 'a_1', key: { a: 1 }, reason: 'prefix', of: 'a_1_b_1' },
              { ns: 'shop.users', name: 'c_1', key: { c: 1 }, reason: 'unused' },
            ],
            skipped: 0,
            refused: {},
          },
        ]
      },
    })
    show(onServer('indexHealth', { connectionId: C, db: 'shop' }))
    await settle()
    expect(asked).toEqual(['shop'])
    const count = (k: string) => frame().querySelector(`[data-index-count="${k}"]`)!.textContent!.trim()
    expect([count('missing'), count('unused'), count('prefix')]).toEqual(['1', '2', '1'])
    expect(text()).toContain('shop')
    expect(text()).toContain('shop.orders')
    expect(text()).toContain('status: 1, at: -1')
  })

  // Review of wave 2 (M4): index advice reads the profiler and the log: not at each focus of the window.
  it('reads the advice on its own ten-minute timer, never when the window is focused', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let asked = 0
    mockApi({
      'GET connections': () => [200, [CONN]],
      [`GET connections/${C}/server/index-advice`]: () => {
        asked++
        return [200, { suggestions: [], unneeded: [], skipped: 0, refused: {} }]
      },
    })
    show(onServer('indexHealth', { connectionId: C, db: 'shop' }))
    await settle()
    expect(asked).toBe(1)
    // Past its ten minutes: a focus alone does not read it again (its own timer does).
    vi.setSystemTime(Date.now() + 11 * 60_000)
    focusManager.setFocused(false)
    focusManager.setFocused(true)
    await settle()
    expect(asked).toBe(1)
    focusManager.setFocused(undefined)
    vi.useRealTimers()
  })

  it('says all is well when there is nothing to change', async () => {
    mockApi({
      'GET connections': () => [200, [CONN]],
      [`GET connections/${C}/server/index-advice`]: () => [
        200,
        { suggestions: [], unneeded: [], skipped: 0, refused: {} },
      ],
    })
    show(onServer('indexHealth', { connectionId: C, db: 'shop' }))
    await settle()
    expect(text()).toContain('No index to add or drop')
  })
})

describe('the shard balance widget', () => {
  const VIEW = {
    shards: [
      {
        id: 'rs1',
        hosts: 'rs1/host-one.internal:27018',
        draining: false,
        tags: [],
        collections: 2,
        chunks: 40,
      },
      {
        id: 'rs2',
        hosts: 'rs2/host-two.internal:27018',
        draining: true,
        tags: [],
        collections: 2,
        chunks: 10,
      },
    ],
    balancer: { mode: 'full', inRound: true, rounds: 3, window: null },
    mongos: [],
    collections: [
      {
        ns: 'shop.orders',
        key: { _id: 'hashed' },
        unique: false,
        balancing: true,
        chunks: {},
        imbalance: 30,
        jumbo: 2,
      },
      {
        ns: 'shop.users',
        key: { _id: 1 },
        unique: false,
        balancing: true,
        chunks: {},
        imbalance: 0,
        jumbo: 0,
      },
    ],
    more: false,
    refused: {},
  }

  it('shows each shard’s chunks and collections by its id, never its hosts, and the balancer', async () => {
    mockApi({
      'GET connections': () => [200, [CONN]],
      [`GET connections/${C}/server/sharding`]: () => [200, VIEW],
    })
    show(onServer('shardBalance'))
    await settle()
    const shards = [...frame().querySelectorAll('[data-shard]')].map((s) =>
      s.textContent!.replace(/\s+/g, ' '),
    )
    expect(shards).toHaveLength(2)
    expect(shards[0]).toContain('rs1')
    expect(shards[0]).toContain('40')
    expect(shards[1]).toContain('draining')
    expect(text()).not.toContain('host-one')
    expect(text()).not.toContain('host-two')
    expect(text()).toContain('balancing now')
    expect(text()).toContain('1 collection out of balance')
    expect(text()).toContain('2 jumbo chunks')
  })

  // Review of wave 2 (M5): a server that is not a mongos is not asked again every minute.
  it('stops asking a server that is not a mongos', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let asked = 0
    mockApi({
      'GET connections': () => [200, [CONN]],
      [`GET connections/${C}/server/sharding`]: () => {
        asked++
        return [409, { code: 'CONFLICT', message: 'not a mongos', details: { reason: 'not_sharded' } }]
      },
    })
    show(onServer('shardBalance'))
    await settle()
    expect(asked).toBe(1)
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    await settle()
    expect(asked).toBe(1)
    vi.useRealTimers()
  })

  it('says a server that is not a mongos is not sharded', async () => {
    mockApi({
      'GET connections': () => [200, [CONN]],
      [`GET connections/${C}/server/sharding`]: () => [
        409,
        { code: 'CONFLICT', message: 'not a mongos', details: { reason: 'not_sharded' } },
      ],
    })
    show(onServer('shardBalance'))
    await settle()
    expect(text()).toContain('not a sharded cluster')
    expect(frame().querySelector('[data-widget-retry]')).toBeNull()
  })
})

describe('the replication headroom widget', () => {
  it('shows each secondary’s headroom, the oplog’s rate and the last election', async () => {
    mockApi({
      'GET connections': () => [200, [CONN]],
      [`GET connections/${C}/server/replica`]: () => [
        200,
        {
          mode: 'replicaSet',
          set: 'rs0',
          date: '2026-10-27T10:00:00.000Z',
          primary: 'db1:27017',
          majorityLagSeconds: 0,
          oplogWindowHours: 10,
          oplog: { usedMb: 5120, maxMb: 51200, gbPerHour: 0.5 },
          lastElection: '2026-10-20T10:00:00.000Z',
          members: [
            { name: 'db1:27017', state: 'PRIMARY', healthy: true, lagSeconds: 0, arbiter: false },
            { name: 'db2:27017', state: 'SECONDARY', healthy: true, lagSeconds: 3600, arbiter: false },
            { name: 'db3:27017', state: 'SECONDARY', healthy: true, lagSeconds: 34_200, arbiter: false },
            {
              name: 'db4:27017',
              state: '(not reachable/healthy)',
              healthy: false,
              lagSeconds: null,
              arbiter: false,
            },
          ],
        },
      ],
    })
    show(onServer('replication'))
    await settle()
    const rows = [...frame().querySelectorAll('[data-headroom]')]
    expect(rows.map((r) => r.getAttribute('data-headroom'))).toEqual(['short', 'low', 'unknown'])
    expect(rows[0]!.textContent).toContain('9 h')
    expect(rows[1]!.textContent).toContain('30 min')
    expect(text()).toContain('0.5 GB per hour')
    expect(text()).toContain('5 GB of 50 GB')
    expect(text()).toMatch(/elected .*2026|elected/)
  })

  it('says a standalone server has no replication', async () => {
    mockApi({
      'GET connections': () => [200, [CONN]],
      [`GET connections/${C}/server/replica`]: () => [200, { mode: 'standalone' }],
    })
    show(onServer('replication'))
    await settle()
    expect(text()).toContain('not part of a replica set')
  })
})

describe('the collection latency widget', () => {
  const kind = (ops: number, avgMs: number | null, p95Ms: number | null) => ({ ops, avgMs, p95Ms })

  it('shows the busiest collections’ read and write latency, and says what MongoDB did not tell', async () => {
    mockApi({
      'GET connections': () => [200, [CONN]],
      [`GET connections/${C}/server/collection-latency`]: () => [
        200,
        {
          collections: [
            {
              ns: 'shop.orders',
              reads: kind(120, 1.5, 4),
              writes: kind(30, 12.25, 32),
              commands: kind(0, null, null),
            },
            {
              ns: 'shop.users',
              reads: kind(0, null, null),
              writes: kind(0, null, null),
              commands: kind(0, null, null),
            },
            { ns: 'shop.secret', reads: null, writes: null, commands: null },
          ],
        },
      ],
    })
    show(onServer('collectionLatency'))
    await settle()
    const rows = [...frame().querySelectorAll('[data-latency]')].map((r) =>
      r.textContent!.replace(/\s+/g, ' '),
    )
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain('shop.orders')
    expect(rows[0]).toContain('1.5 ms')
    expect(rows[0]).toContain('p95 ≥ 4 ms')
    expect(rows[0]).toContain('12.25 ms')
    expect(rows[1]).toContain('—')
    expect(rows[2]).toContain('not known')
    // Review nit: where more is seen.
    linkTo('See all on the performance page').click()
    await flushPromises()
    expect(openedSection()).toBe('performance')
  })

  it('says when no collection has been busy yet', async () => {
    mockApi({
      'GET connections': () => [200, [CONN]],
      [`GET connections/${C}/server/collection-latency`]: () => [200, { collections: [] }],
    })
    show(onServer('collectionLatency'))
    await settle()
    expect(text()).toContain('No collection has been busy yet')
  })
})

describe('the server facts widget', () => {
  it('shows the version, compatibility, engine, cores, memory, system and start-up warnings', async () => {
    mockApi({
      'GET connections': () => [200, [CONN]],
      [`GET connections/${C}/server/facts`]: () => [
        200,
        {
          version: '8.0.4',
          fcv: '7.0',
          storageEngine: 'wiredTiger',
          cores: 8,
          memoryMb: 16_384,
          os: { type: 'Linux', name: 'Ubuntu' },
          warnings: ['Access control is not enabled for the database'],
          refused: [],
        },
      ],
    })
    show(onServer('serverFacts'))
    await settle()
    expect(text()).toContain('8.0.4')
    expect(text()).toContain('7.0')
    expect(text()).toContain('wiredTiger')
    expect(text()).toContain('8 cores')
    expect(text()).toContain('16 GB')
    expect(text()).toContain('Linux · Ubuntu')
    expect([...frame().querySelectorAll('[data-warning]')].map((w) => w.textContent!.trim())).toEqual([
      'Access control is not enabled for the database',
    ])
    // Review nit: the connection's page, for the rest of what is known of it.
    linkTo('Open the connection').click()
    await flushPromises()
    expect(openedSection()).toBe('overview')
    // A compatibility version behind the server's own is said.
    expect(text()).toContain('behind the server')
  })

  it('says no warnings, and says what MongoDB did not tell', async () => {
    mockApi({
      'GET connections': () => [200, [CONN]],
      [`GET connections/${C}/server/facts`]: () => [
        200,
        {
          version: '8.0.4',
          fcv: '8.0',
          storageEngine: null,
          cores: null,
          memoryMb: null,
          os: null,
          warnings: [],
          refused: ['hostInfo', 'status'],
        },
      ],
    })
    show(onServer('serverFacts'))
    await settle()
    expect(text()).toContain('No start-up warning')
    expect(text()).not.toContain('behind the server')
    expect(text()).toContain('not known')
    // Review nit: what MongoDB did not give is said, not only shown as unknown.
    expect(text()).toContain('MongoDB did not give: host information, server status')
  })
})
