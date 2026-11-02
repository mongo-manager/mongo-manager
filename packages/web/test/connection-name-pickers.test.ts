import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import LiveSyncWizard from '../src/livesync/LiveSyncWizard.vue'
import CopyWizard from '../src/transfer/CopyWizard.vue'
import ReportDialog from '../src/alerts/ReportDialog.vue'
import ShardingPanel from '../src/monitor/ShardingPanel.vue'
import { i18n } from '../src/i18n'
import { mockApi, mountApp, type Handler } from './support/app'
import { button, byLabel, choose } from './support/dom'

/**
 * User report 2026-10-30: where a connection is picked, its databases — and the chosen database's
 * collections — are offered by name, not typed from memory; a name not in the list is still taken.
 */
const ALL = [
  'documents:read',
  'documents:write',
  'databases:write',
  'indexes:write',
  'jobs:run',
  'data:export',
]
const CONNS = [
  { id: 'c1', name: 'Prod', access: 'editor', permissions: ALL, export: true, restricted: false },
  { id: 'c2', name: 'Reporting', access: 'admin', permissions: ALL, export: true },
]
const dbs =
  (...names: string[]) =>
  () =>
    [200, { databases: names.map((name) => ({ name, sizeOnDisk: 1, empty: false })), totalSize: 1 }] as [
      number,
      unknown,
    ]
const colls =
  (...names: string[]) =>
  () =>
    [
      200,
      [
        ...names.map((name) => ({ name, type: 'collection', options: {}, readOnly: false })),
        { name: 'recent', type: 'view', options: {}, readOnly: true },
        { name: 'system.profile', type: 'collection', options: {}, readOnly: false },
      ],
    ] as [number, unknown]
const NAMES: Record<string, Handler> = {
  'GET connections': () => [200, CONNS],
  'GET connections/c1/databases': dbs('shop', 'crm'),
  'GET connections/c1/databases/shop/collections': colls('orders', 'users'),
  'GET connections/c2/databases': dbs('reports'),
  'GET connections/c2/databases/reports/collections': colls('daily'),
}

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

/** What the field labelled `label` offers once opened (its list closed again after). */
async function offers(label: string): Promise<string[]> {
  const input = byLabel(label)
  expect(input.getAttribute('role')).toBe('combobox')
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  await flushPromises()
  const names = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent?.trim() ?? '')
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await flushPromises()
  return names
}
async function pickName(label: string, name: string): Promise<void> {
  const input = byLabel(label)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  await flushPromises()
  ;[...document.querySelectorAll<HTMLElement>('[role="option"]')]
    .find((o) => o.textContent?.trim() === name)!
    .click()
  await flushPromises()
}

describe('the live sync wizard', () => {
  it('offers the source connection’s databases, then the chosen one’s collections', async () => {
    const { calls } = mockApi(NAMES)
    mountApp(LiveSyncWizard)
    await flushPromises()
    await choose(byLabel<HTMLSelectElement>('Source connection'), 'c1')
    await flushPromises()
    expect(await offers('Database')).toEqual(['shop', 'crm'])
    // A name being typed asks the server nothing until it is one of the connection's.
    const typed = calls.length
    const db = byLabel('Database')
    db.value = 'sh'
    db.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    expect(calls.slice(typed).filter((c) => c.path.endsWith('/collections'))).toEqual([])
    await pickName('Database', 'shop')
    expect(byLabel('Database').value).toBe('shop')
    // Views and system collections are not synced.
    expect(await offers('Collection (empty: the whole database)')).toEqual(['orders', 'users'])
    expect(calls.slice(typed).filter((c) => c.path.endsWith('/collections')).length).toBeGreaterThan(0)
  })

  it('offers the target connection’s databases, and keeps a new one typed', async () => {
    mockApi(NAMES)
    mountApp(LiveSyncWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'orders' } })
    await flushPromises()
    await choose(byLabel<HTMLSelectElement>('Target connection'), 'c2')
    await flushPromises()
    expect(await offers('Database')).toEqual(['reports'])
    await pickName('Database', 'reports')
    expect(await offers('Collection')).toEqual(['daily'])
    // Review of the branch (I1): a collection's name may hold a space; it is typed as it is written.
    const coll = byLabel('Collection')
    for (const text of ['my', 'my ', 'my c']) {
      coll.value = text
      coll.dispatchEvent(new Event('input', { bubbles: true }))
      await flushPromises()
    }
    expect(coll.value).toBe('my c')
    const db = byLabel('Database')
    db.value = 'archive '
    db.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    expect(button('Next').disabled).toBe(false)
  })
})

describe('the other forms that name a database or a collection', () => {
  it('offers the copy target connection’s names', async () => {
    mockApi({ ...NAMES, 'GET transfer/presets': () => [200, { presets: [] }] })
    mountApp(CopyWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'orders' } })
    await flushPromises()
    button('Next').click()
    await flushPromises()
    await choose(document.querySelector<HTMLSelectElement>('[data-test="target-connection"] select')!, 'c2')
    await flushPromises()
    expect(await offers('Database')).toEqual(['reports'])
    await pickName('Database', 'reports')
    expect(await offers('Collection')).toEqual(['daily'])
  })

  it('offers each report count its connection’s databases and that database’s collections', async () => {
    mockApi({ ...NAMES, 'GET alerts/channels': () => [200, { email: null, webhooks: [] }] })
    mountApp(ReportDialog)
    await flushPromises()
    await choose(
      document.querySelector<HTMLSelectElement>(
        'select[data-report-connection], [data-report-connection] select',
      )!,
      'c1',
    )
    await flushPromises()
    expect(await offers('Database of count 1')).toEqual(['shop', 'crm'])
    await pickName('Database of count 1', 'shop')
    expect(await offers('Collection of count 1')).toEqual(['orders', 'users'])
  })

  it('offers a namespace filter the databases, then a database’s collections after its dot', async () => {
    mockApi({
      ...NAMES,
      'GET connections/c1/server/sharding': () => [
        200,
        {
          shards: [],
          balancer: { mode: 'full', inRound: false, rounds: 0, window: null },
          mongos: [],
          collections: [],
          more: false,
          refused: {},
        },
      ],
    })
    mountApp(ShardingPanel, { props: { connectionId: 'c1' } })
    await flushPromises()
    expect(await offers('Database or database.collection')).toEqual(['shop', 'crm'])
    const ns = byLabel('Database or database.collection')
    ns.value = 'shop.'
    ns.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    // Views too: a filter names any namespace.
    expect([...document.querySelectorAll('[role="option"]')].map((o) => o.textContent?.trim())).toEqual([
      'shop.orders',
      'shop.recent',
      'shop.users',
    ])
  })
})
