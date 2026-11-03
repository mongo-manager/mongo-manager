import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { PERMISSIONS, type PersonalRule } from '@mongo-manager/shared'
import ConnectionTab from '../src/workspace/tabs/ConnectionTab.vue'
import CollectionTab from '../src/workspace/tabs/CollectionTab.vue'
import DatabaseTab from '../src/workspace/tabs/DatabaseTab.vue'
import { i18n } from '../src/i18n'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { useSessionStore } from '../src/stores/session'
import { mockApi, mountApp, type Handler } from './support/app'
import { offered, openPicker, pick } from './support/pickers'

/**
 * User request 2026-10-23: the connection's Backups and Personal data are tabs beside Performance,
 * Watch, Users and roles and Alerts; and each collection has a Personal data tab of its own, with
 * only what can be set on that collection. User request 2026-10-24: a database's too, beside its
 * Backups tab; what a rule names is picked, and saved at once.
 */
beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  useSessionStore().status = { mode: 'team', setupRequired: false, authenticated: true } as never
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const conn = (permissions: readonly string[] = PERMISSIONS) => ({
  id: 'c1',
  name: 'Prod',
  group: null,
  color: null,
  favorite: false,
  readOnly: false,
  settings: {},
  uri: 'mongodb://db1/shop',
  createdAt: 0,
  updatedAt: 0,
  lastUsedAt: null,
  access: 'admin',
  permissions: [...permissions],
  export: true,
  shell: false,
})
const DATABASES = { databases: [{ name: 'shop', sizeOnDisk: 2, empty: false }], totalSize: 2 }
const RULES: PersonalRule[] = [
  { db: 'shop', coll: 'orders', field: 'email' },
  { db: 'shop', coll: 'customers', field: 'phone' },
  { db: '*', coll: '*', field: 'ssn' },
  { db: 'shop', coll: '*', field: 'address.**' },
]
const sectionNames = () => [...document.querySelectorAll('[role="tab"]')].map((x) => x.textContent?.trim())
const tab = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((x) => x.textContent?.trim() === name)!

function api(
  extra: Record<string, Handler> = {},
  permissions?: readonly string[],
  first: PersonalRule[] = RULES,
) {
  let saved: PersonalRule[] = first
  const handlers = mockApi({
    'GET connections': () => [200, [conn(permissions)]],
    'GET connections/c1/databases': () => [200, DATABASES],
    'GET backups': () => [200, []],
    'GET backups/usage': () => [200, { used: 0, quota: 1024 ** 3, ttlHours: 24 }],
    'GET connections/c1/personal-fields': () => [200, { rules: saved }],
    'PUT connections/c1/personal-fields': (body) => {
      const { rules, base } = body as { rules: PersonalRule[]; base?: PersonalRule[] }
      if (base && JSON.stringify(base) !== JSON.stringify(saved))
        return [409, { code: 'CONFLICT', message: 'changed' }]
      saved = rules
      return [200, { rules: saved }]
    },
    'GET connections/c1/databases/shop/stats': () => [
      200,
      { collections: 1, views: 1, objects: 1, indexes: 1, dataSize: 1, storageSize: 1, indexSize: 1 },
    ],
    'POST connections/c1/databases/shop/collections/orders/schema': () => [
      200,
      {
        sampled: 2,
        truncated: false,
        fields: [
          { path: 'email', keys: ['email'], count: 2, types: { string: 2 } },
          { path: 'card', keys: ['card'], count: 1, types: { object: 1 } },
          { path: 'card.number', keys: ['card', 'number'], count: 1, types: { string: 1 } },
          { path: 'ssn', keys: ['ssn'], count: 2, types: { string: 2 } },
        ],
      },
    ],
    'GET connections/c1/databases/shop/collections': () => [
      200,
      [
        { name: 'orders', type: 'collection', options: {}, readOnly: false },
        { name: 'recent', type: 'view', options: { viewOn: 'orders', pipeline: [] }, readOnly: true },
      ],
    ],
    ...extra,
  })
  return { ...handlers, saved: () => saved, change: (next: PersonalRule[]) => (saved = next) }
}

const cells = (marker: string) =>
  [...document.querySelectorAll(`[${marker}]`)].map((x) => x.textContent?.trim())
const rows = () => cells('data-rule-row')

describe("a connection's Backups and Personal data", () => {
  it('are tabs of their own, beside the others, and no longer on its overview', async () => {
    api()
    // An administrator of the app: Alerts is offered too.
    useSessionStore().me = { permissions: [...PERMISSIONS] } as never
    mountApp(ConnectionTab, { props: { connectionId: 'c1', tabId: 't-c1' } })
    await flushPromises()
    expect(sectionNames()).toEqual(expect.arrayContaining(['Performance', 'Watch', 'Alerts']))
    expect(sectionNames().slice(-2)).toEqual(['Backups', 'Personal data'])
    // The overview keeps its databases, not these.
    expect(document.querySelector('#backups-c1')).toBeNull()
    expect(document.querySelector('[data-personal-data]')).toBeNull()
    tab('Backups').click()
    await flushPromises()
    expect(document.querySelector('#backups-c1')).not.toBeNull()
    expect(document.body.textContent).toContain('Take the first backup')
    tab('Personal data').click()
    await flushPromises()
    expect(document.querySelector('[data-personal-data]')).not.toBeNull()
    expect(cells('data-rule-db-cell')).toEqual(['shop', 'shop', '*', 'shop'])
    expect(rows()).toEqual(['email', 'phone', 'ssn', 'address.**'])
  })

  it('are offered only to those who may back up or manage the connection', async () => {
    api({}, ['connections:read', 'databases:read', 'documents:read'])
    mountApp(ConnectionTab, { props: { connectionId: 'c1', tabId: 't-c1' } })
    await flushPromises()
    expect(sectionNames()).not.toContain('Backups')
    expect(sectionNames()).not.toContain('Personal data')
  })

  it("shows a connection's Backups tab to its administrators for a drill's leftovers, though they may not back up (M7)", async () => {
    api(
      {
        'GET connections/c1/backup/drill-leftovers': () => [
          200,
          { databases: [{ name: 'mm_drill_1', sizeOnDisk: 1 }], running: false },
        ],
      },
      ['connections:read', 'databases:read', 'documents:read', 'connections:manage'],
    )
    mountApp(ConnectionTab, { props: { connectionId: 'c1', tabId: 't-c1' } })
    await flushPromises()
    expect(sectionNames()).toContain('Backups')
    tab('Backups').click()
    await flushPromises()
    expect(document.querySelector('#backups-c1')).toBeNull()
    expect(document.body.textContent).toContain('mm_drill_1')
  })

  it('shows no empty Backups tab to an administrator who may not back up and has no leftovers', async () => {
    api({ 'GET connections/c1/backup/drill-leftovers': () => [200, { databases: [], running: false }] }, [
      'connections:read',
      'databases:read',
      'documents:read',
      'connections:manage',
    ])
    mountApp(ConnectionTab, { props: { connectionId: 'c1', tabId: 't-c1' } })
    await flushPromises()
    expect(sectionNames()).not.toContain('Backups')
  })
})

describe('a rule saved in local mode (e2e 16, 2026-10-24)', () => {
  it('keeps the tab where it is and what was picked: the views follow without being dropped', async () => {
    useSessionStore().status = { mode: 'local', setupRequired: false, authenticated: true } as never
    const { calls } = api()
    mountApp(ConnectionTab, { props: { connectionId: 'c1', tabId: 't-c1' } })
    await flushPromises()
    tab('Personal data').click()
    await flushPromises()
    await pick('data-rule-db', 'shop')
    await pick('data-rule-coll', 'orders')
    const reads = calls.filter((c) => c.path === 'connections/c1/databases').length
    await pick('data-rule-field', 'card')
    await flushPromises()
    // The values hidden from me now: what is shown is read again...
    expect(calls.filter((c) => c.path === 'connections/c1/databases').length).toBeGreaterThan(reads)
    // ...while the tab stays on Personal data, with the database and collection still picked.
    expect(document.querySelector('[role="tab"][aria-selected="true"]')!.textContent?.trim()).toBe(
      'Personal data',
    )
    expect(document.querySelector('[data-rule-field]')).not.toBeNull()
    expect(document.querySelector('[data-rules-status]')!.textContent).toContain('Saved.')
  })

  it('reads the fields of a collection only once its field picker is opened', async () => {
    const { calls } = api()
    mountApp(ConnectionTab, { props: { connectionId: 'c1', tabId: 't-c1' } })
    await flushPromises()
    tab('Personal data').click()
    await flushPromises()
    await pick('data-rule-db', 'shop')
    await pick('data-rule-coll', 'orders')
    const sampled = () => calls.filter((c) => c.path.endsWith('/schema')).length
    expect(sampled()).toBe(0)
    await openPicker('data-rule-field')
    expect(sampled()).toBe(1)
    expect(offered()).toContain('card')
  })
})

async function databaseTab(
  permissions?: readonly string[],
  db = 'shop',
  extra: Record<string, Handler> = {},
) {
  const handlers = api(extra, permissions)
  mountApp(DatabaseTab, { props: { connectionId: 'c1', db, tabId: `t-${db}` } })
  await flushPromises()
  await flushPromises()
  return handlers
}

describe("a database's Backups and Personal data (user request 2026-10-24)", () => {
  it('are tabs of their own, beside Model and Watch, and no longer on its overview', async () => {
    await databaseTab()
    expect(sectionNames()).toEqual(['Overview', 'Model', 'Watch', 'Backups', 'Personal data'])
    expect(document.querySelector('#backups-c1-shop')).toBeNull()
    expect(document.querySelector('[data-personal-data]')).toBeNull()
    tab('Backups').click()
    await flushPromises()
    expect(document.querySelector('#backups-c1-shop')).not.toBeNull()
    tab('Personal data').click()
    await flushPromises()
    expect(document.querySelector('[data-personal-data]')).not.toBeNull()
  })

  it("lists the rules of that database's collections only, and the connection's that reach it", async () => {
    await databaseTab()
    tab('Personal data').click()
    await flushPromises()
    const card = document.querySelector('[data-personal-data]')!
    expect(card.textContent).toContain('Fields of the collections of shop')
    // By collection and field: the database is this one.
    expect(card.querySelector('[data-rule-db-cell]')).toBeNull()
    expect(cells('data-rule-coll-cell')).toEqual(['orders', 'customers', '*'])
    expect(rows()).toEqual(['email', 'phone', 'address.**'])
    expect(cells('data-rule-inherited')).toEqual(['*.*.ssn'])
  })

  it('adds a field of a collection of it, picked and saved at once, keeping every other rule', async () => {
    const { saved, calls } = await databaseTab()
    tab('Personal data').click()
    await flushPromises()
    // No database to pick: it is this one. A view is no collection to pick.
    expect(document.querySelector('[data-rule-db]')).toBeNull()
    await openPicker('data-rule-coll')
    expect(offered()).toEqual(['orders'])
    await pick('data-rule-coll', 'orders')
    await openPicker('data-rule-field')
    // email is listed already for orders.
    expect(offered()).toEqual(['card', 'card.number', 'ssn'])
    await pick('data-rule-field', 'card.number')
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1)
    expect(saved()).toEqual([...RULES, { db: 'shop', coll: 'orders', field: 'card.number' }])
    expect(rows()).toEqual(['email', 'phone', 'address.**', 'card.number'])
  })

  it('says a field picked is hidden there already by a wider rule, and adds it all the same', async () => {
    await databaseTab()
    tab('Personal data').click()
    await flushPromises()
    await pick('data-rule-coll', 'orders')
    await pick('data-rule-field', 'ssn')
    expect(document.querySelector('[data-rule-covered]')!.textContent).toContain('*.*.ssn')
    expect(rows()).toContain('ssn')
  })

  it('are offered only to those who may back up, or manage the connection', async () => {
    await databaseTab(['connections:read', 'databases:read', 'documents:read'])
    expect(sectionNames()).toEqual(['Overview', 'Model', 'Watch'])
    document.body.innerHTML = ''
    await databaseTab(['connections:read', 'databases:read', 'documents:read', 'connections:manage'])
    expect(sectionNames()).toEqual(['Overview', 'Model', 'Watch', 'Personal data'])
  })

  it("is no Personal data tab on a database named * (a rule's wildcard)", async () => {
    await databaseTab(undefined, '*', {
      'GET connections/c1/databases/*/collections': () => [200, []],
    })
    expect(sectionNames()).toContain('Backups')
    expect(sectionNames()).not.toContain('Personal data')
  })
})

async function collectionTab(coll = 'orders', permissions?: readonly string[]) {
  const handlers = api({}, permissions)
  mountApp(CollectionTab, { props: { connectionId: 'c1', db: 'shop', coll, tabId: `t-${coll}` } })
  await flushPromises()
  await flushPromises()
  return handlers
}

describe("a collection's Personal data", () => {
  it('is a tab of its own, with the rules of that collection only, and those that reach it', async () => {
    await collectionTab()
    tab('Personal data').click()
    await flushPromises()
    const card = document.querySelector('[data-personal-data]')!
    expect(rows()).toEqual(['email'])
    // Another collection's rule is not shown; the connection's wider rules are, as theirs.
    expect(card.textContent).not.toContain('phone')
    expect(cells('data-rule-inherited')).toEqual(['*.*.ssn', 'shop.*.address.**'])
    // A field is all it asks for: the database and collection are this one.
    expect(card.querySelector('[data-rule-db]')).toBeNull()
    expect(card.querySelector('[data-rule-coll]')).toBeNull()
    expect(card.querySelector('[data-rule-coll-cell]')).toBeNull()
  })

  it('adds a field picked and removes one, each saved at once, keeping every other rule', async () => {
    const { saved } = await collectionTab()
    useCollectionViewsStore().stateFor('t-orders').section = 'personalData'
    await flushPromises()
    await pick('data-rule-field', 'card')
    expect(saved()).toEqual([...RULES, { db: 'shop', coll: 'orders', field: 'card' }])
    document.querySelector<HTMLButtonElement>('button[aria-label="Remove email"]')!.click()
    await flushPromises()
    expect(saved()).toEqual([
      { db: 'shop', coll: 'customers', field: 'phone' },
      { db: '*', coll: '*', field: 'ssn' },
      { db: 'shop', coll: '*', field: 'address.**' },
      { db: 'shop', coll: 'orders', field: 'card' },
    ])
    expect(rows()).toEqual(['card'])
  })

  it('is not on a view, nor for those who may not manage the connection', async () => {
    await collectionTab('recent')
    expect(sectionNames()).not.toContain('Personal data')
    document.body.innerHTML = ''
    await collectionTab('orders', ['connections:read', 'databases:read', 'documents:read'])
    expect(sectionNames()).toContain('Documents')
    expect(sectionNames()).not.toContain('Personal data')
  })

  it('tells a rule from another by its parts, not its text (M4)', async () => {
    // shop + a + b.c and shop + a.b + c read the same, "shop.a.b.c": they are two rules.
    api(
      {
        'GET connections/c1/databases/shop/collections': () => [
          200,
          [{ name: 'a.b', type: 'collection', options: {}, readOnly: false }],
        ],
        'POST connections/c1/databases/shop/collections/a.b/schema': () => [
          200,
          {
            sampled: 1,
            truncated: false,
            fields: [{ path: 'c', keys: ['c'], count: 1, types: { string: 1 } }],
          },
        ],
      },
      undefined,
      [{ db: 'shop', coll: 'a', field: 'b.c' }],
    )
    mountApp(CollectionTab, { props: { connectionId: 'c1', db: 'shop', coll: 'a.b', tabId: 't-ab' } })
    await flushPromises()
    await flushPromises()
    useCollectionViewsStore().stateFor('t-ab').section = 'personalData'
    await flushPromises()
    await pick('data-rule-field', 'c')
    expect(document.querySelector('[data-rule-error]')).toBeNull()
    expect(rows()).toEqual(['c'])
  })

  it('says a field is hidden here already by a wider rule, and adds it all the same (nit 14)', async () => {
    await collectionTab()
    tab('Personal data').click()
    await flushPromises()
    await pick('data-rule-field', 'ssn')
    expect(document.querySelector('[data-rule-covered]')!.textContent).toContain('*.*.ssn')
    expect(rows()).toEqual(['email', 'ssn'])
  })

  it('says no more that a wider rule hides a field once that rule is removed again', async () => {
    await collectionTab()
    tab('Personal data').click()
    await flushPromises()
    await pick('data-rule-field', 'ssn')
    expect(document.querySelector('[data-rule-covered]')).not.toBeNull()
    document.querySelector<HTMLButtonElement>('button[aria-label="Remove ssn"]')!.click()
    await flushPromises()
    expect(document.querySelector('[data-rule-covered]')).toBeNull()
  })

  it('says so when the collection has no rule of its own, though wider ones reach it (nit 14)', async () => {
    api({}, undefined, [{ db: '*', coll: '*', field: 'ssn' }])
    mountApp(CollectionTab, { props: { connectionId: 'c1', db: 'shop', coll: 'orders', tabId: 't-orders' } })
    await flushPromises()
    await flushPromises()
    tab('Personal data').click()
    await flushPromises()
    expect(document.body.textContent).toContain('No field of this collection is listed yet.')
  })

  it('says, in local mode, that the values are hidden from you, with no switch (user request 2026-10-24)', async () => {
    useSessionStore().status = { mode: 'local', setupRequired: false, authenticated: true } as never
    api()
    mountApp(CollectionTab, { props: { connectionId: 'c1', db: 'shop', coll: 'orders', tabId: 't-orders' } })
    await flushPromises()
    await flushPromises()
    tab('Personal data').click()
    await flushPromises()
    expect(document.body.textContent).toContain('In local mode they are hidden from you')
    expect(document.querySelector('[data-hide-from-me]')).toBeNull()
  })

  it('offers an administrator of a team to hide the values from themselves, here too (user request 2026-10-24)', async () => {
    api({ 'GET connections/c1/personal-fields': () => [200, { rules: RULES, hiddenFromMe: false }] })
    mountApp(CollectionTab, { props: { connectionId: 'c1', db: 'shop', coll: 'orders', tabId: 't-orders' } })
    await flushPromises()
    await flushPromises()
    tab('Personal data').click()
    await flushPromises()
    expect(document.querySelector('[data-hide-from-me]')!.textContent).toContain('Hide them from me too')
  })

  it("is no tab on a collection named * (a rule's wildcard, M5)", async () => {
    api({
      'GET connections/c1/databases/shop/collections': () => [
        200,
        [{ name: '*', type: 'collection', options: {}, readOnly: false }],
      ],
    })
    mountApp(CollectionTab, { props: { connectionId: 'c1', db: 'shop', coll: '*', tabId: 't-star' } })
    await flushPromises()
    await flushPromises()
    expect(sectionNames()).toContain('Documents')
    expect(sectionNames()).not.toContain('Personal data')
  })

  it('shows the rules another tab saved meanwhile, and makes its own change on those', async () => {
    const { queryClient } = mountApp(CollectionTab, {
      props: { connectionId: 'c1', db: 'shop', coll: 'orders', tabId: 't-orders' },
    })
    const { saved, change } = api()
    await flushPromises()
    await flushPromises()
    tab('Personal data').click()
    await flushPromises()
    // Another tab saved a rule: this one shows it.
    const other = [...RULES, { db: 'shop', coll: 'orders', field: 'phone' }]
    change(other)
    queryClient.setQueryData(['connections', 'c1', 'personal-fields'], { rules: other })
    await flushPromises()
    expect(rows()).toEqual(['email', 'phone'])
    await pick('data-rule-field', 'card')
    expect(saved()).toEqual([...other, { db: 'shop', coll: 'orders', field: 'card' }])
  })
})
