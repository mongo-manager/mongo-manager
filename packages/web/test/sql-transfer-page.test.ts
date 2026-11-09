// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { computed, defineComponent, h } from 'vue'
import { PERMISSIONS } from '@mongo-manager/shared'
import SqlTransferView from '../src/transfer/SqlTransferView.vue'
import SqlImportPanel from '../src/transfer/SqlImportPanel.vue'
import SqlExportPanel from '../src/transfer/SqlExportPanel.vue'
import { useTabWorkStore } from '../src/stores/tabWork'
import { useLeaveGuard, useTabClose } from '../src/workspace/unsaved'
import { openSqlTransferTab } from '../src/workspace/openTabs'
import { tabInputFromRoute, tabLocation } from '../src/workspace/tabRoutes'
import { useTabsStore } from '../src/stores/tabs'
import { useDialogStore } from '../src/stores/dialogs'
import { useWorkspaceDialogs } from '../src/stores/workspaceDialogs'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { createMemoryHistory } from 'vue-router'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import { createAppRouter } from '../src/router'
import { useSessionStore } from '../src/stores/session'
import { usePluginsStore } from '../src/plugins/store'
import { databasePlace, usePlacesStore } from '../src/stores/places'

// User requests 2026-10-11: SQL ↔ MongoDB, a page of the app's own — never a query; where it works
// always in sight and in its address; import into a database, export one database or the whole
// connection, each only where it may run.
const connection = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  group: null,
  color: null,
  favorite: false,
  readOnly: false,
  settings: {},
  uri: `mongodb://${id}`,
  createdAt: 0,
  updatedAt: 0,
  lastUsedAt: null,
  access: 'admin',
  permissions: [...PERMISSIONS],
  export: true,
  ...over,
})
const DBS = {
  c1: ['admin', 'shop', 'crm'],
  c2: ['archive'],
}
const coll = (name: string) => ({ name, type: 'collection', options: {}, readOnly: false })
function api(list = [connection('c1', 'Prod'), connection('c2', 'Archive')], over = {}) {
  return mockApi({
    'GET connections': () => [200, list],
    ...Object.fromEntries(
      Object.entries(DBS).map(([id, names]) => [
        `GET connections/${id}/databases`,
        () => [
          200,
          { databases: names.map((name) => ({ name, sizeOnDisk: 1, empty: false })), totalSize: 1 },
        ],
      ]),
    ),
    'GET connections/c1/databases/shop/collections': () => [200, [coll('orders')]],
    'GET connections/c1/databases/crm/collections': () => [200, [coll('leads')]],
    'GET connections/c2/databases/archive/collections': () => [200, []],
    ...over,
  })
}
/** Who is signed in: may they add connections, and does the server run read-only. */
function signedIn(over: { permissions?: string[]; readOnly?: boolean } = {}) {
  const session = useSessionStore()
  session.me = {
    mode: 'local',
    user: { id: 'local', username: 'owner', role: 'admin' },
    permissions: over.permissions ?? ['connections:manage'],
    csrfToken: 'c',
    readOnly: over.readOnly ?? false,
    twoFactor: {},
  } as never
}
/** The page as the workspace shows it: the active tab's params as its props. */
const Page = defineComponent({
  setup() {
    const tabs = useTabsStore()
    const tab = computed(() => tabs.tabs.find((t) => t.id === tabs.activeId)!)
    return () => h(SqlTransferView, { tabId: tab.value.id, ...tab.value.params })
  },
})
/** The SQL → MongoDB plugin, running: the page comes with it (user request 2026-11-02). */
const runSqlPlugin = () =>
  usePluginsStore().setRuntime([
    {
      id: 'sql-to-mongodb',
      version: '1.0.0',
      name: { en: 'SQL to MongoDB' },
      entry: 'index.html',
      permissions: [],
      contributes: { collectionTabs: [], documentActions: [], sidebarPanels: [], cellRenderers: [] },
      settings: {},
    } as never,
  ])
async function open(view: Parameters<typeof openSqlTransferTab>[1] = {}, plugin = true) {
  if (plugin) runSqlPlugin()
  openSqlTransferTab(useTabsStore(), view)
  const mounted = mountApp(Page)
  await flushPromises()
  await flushPromises()
  return mounted
}
const params = () => {
  const tabs = useTabsStore()
  return tabs.tabs.find((t) => t.id === tabs.activeId)!.params
}
const select = (attr: string) => document.querySelector<HTMLSelectElement>(`[${attr}] select`)!
const options = (attr: string) => [...select(attr).options].map((o) => o.value)
async function pick(attr: string, value: string) {
  const el = select(attr)
  el.value = value
  el.dispatchEvent(new Event('change'))
  await flushPromises()
  await flushPromises()
}
async function part(name: 'Import' | 'Export') {
  ;[...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find((b) => b.textContent?.startsWith(name))!
    .click()
  await flushPromises()
  await flushPromises()
}
async function typeName(value: string) {
  const name = document.querySelector<HTMLInputElement>('[data-sql-new-database]')!
  name.value = value
  name.dispatchEvent(new Event('input'))
  await flushPromises()
}
const text = () => document.body.textContent ?? ''
const inPart = (p: 'import' | 'export', css: string) =>
  document.querySelector<HTMLElement>(`[data-sql-part="${p}"] ${css}`)
beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('the SQL ↔ MongoDB page', () => {
  // User request 2026-11-02: a tab left open while the plugin was turned off says what to do.
  it('says it comes with the SQL → MongoDB plugin while that does not run', async () => {
    api()
    usePluginsStore().setRuntime([])
    await open({}, false)
    expect(document.querySelector('[data-sql-plugin-off]')?.textContent).toContain('SQL → MongoDB plugin')
    expect(document.querySelector('[data-sql-connection]')).toBeNull()
  })

  // Review of 1.0.1 (M1): a reload or a link, before the plugins are known, is loading — not off.
  it('is loading, not off, until the plugins that run are known', async () => {
    api()
    await open({}, false)
    expect(document.querySelector('[data-sql-plugin-off]')).toBeNull()
    expect(document.querySelector('[data-sql-transfer] [aria-busy="true"]')).not.toBeNull()
    runSqlPlugin()
    await flushPromises()
    expect(document.querySelector('[data-sql-transfer] [aria-busy="true"]')).toBeNull()
    expect(document.querySelector('[data-sql-connection]')).not.toBeNull()
  })

  it('works in the first connection’s first database not a system one, and says so in its address', async () => {
    api()
    await open()
    expect(select('data-sql-connection').value).toBe('c1')
    expect(select('data-sql-database').value).toBe('shop')
    expect(params()).toEqual({ part: 'import', connectionId: 'c1', db: 'shop' })
    expect(text()).toContain('become collections of shop')
    expect(document.querySelector('[data-sql-import]')).toBeTruthy()
    // The export part is built only once it is looked at.
    expect(document.querySelector('[data-sql-export]')).toBeNull()
  })

  it('opens where its address says, and changes it with the choice', async () => {
    api()
    await open({ part: 'export', connectionId: 'c1', db: 'crm' })
    expect(select('data-sql-database').value).toBe('crm')
    expect(document.querySelector('[data-sql-export]')).toBeTruthy()
    await pick('data-sql-connection', 'c2')
    expect(params()).toEqual({ part: 'export', connectionId: 'c2', db: 'archive' })
    expect(select('data-sql-database').value).toBe('archive')
    await part('Import')
    expect(params()).toEqual({ part: 'import', connectionId: 'c2', db: 'archive' })
  })

  it('keeps a collection it was opened for only until the place changes, and never for an import', async () => {
    api()
    await open({ part: 'export', connectionId: 'c1', db: 'shop', coll: 'orders' })
    expect(params()).toEqual({ part: 'export', connectionId: 'c1', db: 'shop', coll: 'orders' })
    await pick('data-sql-database', 'crm')
    expect(params()).toEqual({ part: 'export', connectionId: 'c1', db: 'crm' })
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    api()
    await open({ part: 'export', connectionId: 'c1', db: 'shop', coll: 'orders' })
    await part('Import')
    expect(params()).toEqual({ part: 'import', connectionId: 'c1', db: 'shop' })
  })

  // User request 2026-10-12: one database at a time, for an export as for an import.
  it('exports one database: never offers every database, and works in the one chosen', async () => {
    api()
    const { wrapper } = await open({ part: 'export', connectionId: 'c1', db: 'shop' })
    expect(options('data-sql-database')).toEqual(['shop', 'crm'])
    expect(wrapper.findComponent(SqlExportPanel).props('db')).toBe('shop')
    await pick('data-sql-database', 'crm')
    expect(params()).toEqual({ part: 'export', connectionId: 'c1', db: 'crm' })
    expect(wrapper.findComponent(SqlExportPanel).props('db')).toBe('crm')
    expect(text()).toContain('The chosen collections of crm become one SQL file')
    await part('Import')
    expect(options('data-sql-database')).not.toContain('*')
  })

  // Review 2026-10-12 (I1): from a system database's tab, an export opens on a database it may take.
  it('exports from the first database it may, the last place visited a system one', async () => {
    api()
    usePlacesStore().visit(databasePlace('c1', 'admin'))
    const { wrapper } = await open({ part: 'export', connectionId: 'c1' })
    expect(params()).toEqual({ part: 'export', connectionId: 'c1', db: 'shop' })
    expect(wrapper.findComponent(SqlExportPanel).props('db')).toBe('shop')
    expect(text()).not.toContain('No database to export')
    // An import may still be asked for there (and says why it cannot run).
    await part('Import')
    expect(select('data-sql-database').value).toBe('shop')
  })

  it('opens an old link asking for every database on one database', async () => {
    api()
    const { wrapper } = await open({ part: 'export', connectionId: 'c1', db: '*' })
    expect(params()).toEqual({ part: 'export', connectionId: 'c1', db: 'shop' })
    expect(wrapper.findComponent(SqlExportPanel).props('db')).toBe('shop')
  })

  it('says when a connection has no database to export', async () => {
    DBS.c2 = ['admin', 'local']
    try {
      api()
      await open({ part: 'export', connectionId: 'c2' })
      expect(inPart('export', '[data-sql-export]')).toBeNull()
      // Nor does the address name a system database for an export.
      expect(params()).toEqual({ part: 'export', connectionId: 'c2' })
      expect(text()).toContain('No database to export')
    } finally {
      DBS.c2 = ['archive']
    }
  })

  it('says why an import cannot run: no right, the server or the connection read-only', async () => {
    api([connection('c1', 'Prod', { permissions: PERMISSIONS.filter((p) => p !== 'jobs:run') })])
    await open({ part: 'import', connectionId: 'c1', db: 'shop' })
    expect(inPart('import', '[data-sql-blocked]')!.textContent).toContain('You may not import here')
    expect(document.querySelector('[data-sql-import]')).toBeNull()

    document.body.innerHTML = ''
    setActivePinia(createPinia())
    signedIn({ readOnly: true })
    api()
    await open({ part: 'import', connectionId: 'c1', db: 'shop' })
    expect(inPart('import', '[data-sql-blocked]')!.textContent).toContain('runs read-only')
    expect(document.querySelector('[data-sql-read-only]')!.textContent).toContain(
      'You can export, not import.',
    )

    document.body.innerHTML = ''
    setActivePinia(createPinia())
    api([connection('c1', 'Prod', { readOnly: true })])
    await open({ part: 'import', connectionId: 'c1', db: 'shop' })
    expect(inPart('import', '[data-sql-blocked]')!.textContent).toContain('This connection is read-only')
  })

  it('keeps the file being imported on a system database, saying it takes no import', async () => {
    api()
    const { wrapper } = await open({ part: 'import', connectionId: 'c1', db: 'admin' })
    expect(inPart('import', '[data-sql-blocked]')!.textContent).toContain('admin, local and config')
    // The panel stays (its upload kept), with nowhere to import into.
    expect(wrapper.findComponent(SqlImportPanel).props('db')).toBeNull()
  })

  it('says why an export cannot run without the export right, and what a read-only connection allows', async () => {
    api([connection('c1', 'Prod', { export: false, readOnly: true })])
    await open({ part: 'export', connectionId: 'c1', db: 'shop' })
    expect(inPart('export', '[data-sql-blocked]')!.textContent).toContain('You may not export')
    expect(document.querySelector('[data-sql-export]')).toBeNull()
    expect(document.querySelector('[data-sql-read-only]')!.textContent).toContain(
      'Nothing can be imported or exported here.',
    )
  })

  it('imports into a new database named, refusing a name MongoDB would not take or would confuse', async () => {
    api()
    const { wrapper } = await open({ part: 'import', connectionId: 'c1', db: 'shop' })
    const panel = () => wrapper.findComponent(SqlImportPanel)
    await pick('data-sql-database', '\u0000new')
    expect(text()).toContain('Give the new database a name.')
    await typeName('my.db')
    expect(text()).toContain('Not a database name MongoDB allows')
    expect(text()).toContain('become collections of the database you choose')
    expect(panel().props('db')).toBeNull()
    expect(document.querySelector('[data-sql-new-database]')!.getAttribute('aria-invalid')).toBe('true')
    await typeName('SHOP')
    expect(text()).toContain('MongoDB has shop already')
    expect(panel().props('db')).toBeNull()
    await typeName('staging')
    expect(panel().props('db')).toBe('staging')
    expect(text()).toContain('become collections of staging')
    // A new database is offered for an import only; looking at Export ends the typing.
    await part('Export')
    expect(options('data-sql-database')).not.toContain('\u0000new')
    expect(document.querySelector('[data-sql-new-database]')).toBeNull()
    expect(select('data-sql-database').value).toBe('shop')
  })

  it('keeps the file being imported when Export is looked at, and asks before another connection', async () => {
    api()
    const { wrapper } = await open({ part: 'import', connectionId: 'c1', db: 'shop' })
    const panel = wrapper.findComponent(SqlImportPanel)
    panel.vm.$emit('work', true)
    await part('Export')
    await part('Import')
    expect(wrapper.findComponent(SqlImportPanel).vm.$.uid).toBe(panel.vm.$.uid)
    const dialogs = useDialogStore()
    void pick('data-sql-connection', 'c2')
    await flushPromises()
    expect(dialogs.current?.title).toBe('Leave the file you prepared?')
    dialogs.settle(false)
    await flushPromises()
    expect(params().connectionId).toBe('c1')
    expect(select('data-sql-connection').value).toBe('c1')
    void pick('data-sql-connection', 'c2')
    await flushPromises()
    dialogs.settle(true)
    await flushPromises()
    await flushPromises()
    expect(params()).toEqual({ part: 'import', connectionId: 'c2', db: 'archive' })
  })

  // Review 2026-10-11 (second, I3): the tree, the palette, a plugin or Back ask as the choice does.
  it('asks before another connection however it is asked for, and goes back when declined', async () => {
    api()
    const { wrapper } = await open({ part: 'import', connectionId: 'c1', db: 'shop' })
    const panel = () => wrapper.findComponent(SqlImportPanel)
    const first = panel().vm.$.uid
    panel().vm.$emit('work', true)
    await flushPromises()
    const dialogs = useDialogStore()
    openSqlTransferTab(useTabsStore(), { part: 'export', connectionId: 'c2', db: 'archive' })
    await flushPromises()
    expect(dialogs.current?.title).toBe('Leave the file you prepared?')
    // Nothing is let go while it asks.
    expect(panel().vm.$.uid).toBe(first)
    expect(panel().props('connectionId')).toBe('c1')
    expect(panel().props('db')).toBeNull()
    dialogs.settle(false)
    await flushPromises()
    await flushPromises()
    expect(params()).toEqual({ part: 'import', connectionId: 'c1', db: 'shop' })
    expect(panel().vm.$.uid).toBe(first)
    expect(dialogs.current).toBeNull()
    openSqlTransferTab(useTabsStore(), { part: 'import', connectionId: 'c2', db: 'archive' })
    await flushPromises()
    dialogs.settle(true)
    await flushPromises()
    await flushPromises()
    expect(params()).toEqual({ part: 'import', connectionId: 'c2', db: 'archive' })
    expect(panel().vm.$.uid).not.toBe(first)
    expect(panel().props('connectionId')).toBe('c2')
  })

  it('keeps the database asked for while the connection’s list still loads', async () => {
    let answer!: () => void
    const loaded = new Promise<void>((r) => (answer = r))
    api(undefined, {
      'GET connections/c2/databases': async () => {
        await loaded
        return [200, { databases: [{ name: 'archive', sizeOnDisk: 1, empty: false }], totalSize: 1 }]
      },
    })
    const { wrapper } = await open({ part: 'import', connectionId: 'c1', db: 'shop' })
    openSqlTransferTab(useTabsStore(), { part: 'import', connectionId: 'c2', db: 'archive' })
    await flushPromises()
    expect(wrapper.findComponent(SqlImportPanel).props('db')).toBe('archive')
    expect(text()).toContain('become collections of archive')
    expect(params()).toEqual({ part: 'import', connectionId: 'c2', db: 'archive' })
    answer()
    await flushPromises()
    await flushPromises()
    expect(params()).toEqual({ part: 'import', connectionId: 'c2', db: 'archive' })
  })

  it('asks nothing when there is nothing to lose', async () => {
    api()
    await open({ part: 'import', connectionId: 'c1', db: 'shop' })
    openSqlTransferTab(useTabsStore(), { part: 'import', connectionId: 'c2', db: 'archive' })
    await flushPromises()
    await flushPromises()
    expect(useDialogStore().current).toBeNull()
    expect(params()).toEqual({ part: 'import', connectionId: 'c2', db: 'archive' })
  })

  // Review 2026-10-11 (second, I5, minor 4).
  it('ends a new name being typed when another place is asked for, and keeps the address meanwhile', async () => {
    api()
    const { wrapper } = await open({ part: 'import', connectionId: 'c1', db: 'shop' })
    await pick('data-sql-database', '\u0000new')
    await typeName('staging')
    expect(wrapper.findComponent(SqlImportPanel).props('db')).toBe('staging')
    // The address keeps the database it was on: Export works there.
    expect(params()).toEqual({ part: 'import', connectionId: 'c1', db: 'shop' })
    await part('Export')
    expect(params()).toEqual({ part: 'export', connectionId: 'c1', db: 'shop' })
    await part('Import')
    expect(wrapper.findComponent(SqlImportPanel).props('db')).toBe('staging')
    openSqlTransferTab(useTabsStore(), { part: 'import', connectionId: 'c1', db: 'crm' })
    await flushPromises()
    expect(document.querySelector('[data-sql-new-database]')).toBeNull()
    expect(select('data-sql-database').value).toBe('crm')
    expect(wrapper.findComponent(SqlImportPanel).props('db')).toBe('crm')
  })

  // Review 2026-10-11 (second, minor 5): the server refuses a system database in an export.
  it('never offers or exports a system database', async () => {
    api()
    await open({ part: 'export', connectionId: 'c1', db: 'admin' })
    expect(options('data-sql-database')).toEqual(['shop', 'crm'])
    expect(select('data-sql-database').value).toBe('shop')
    expect(params()).toEqual({ part: 'export', connectionId: 'c1', db: 'shop' })
    await part('Import')
    expect(options('data-sql-database')).toContain('admin')
  })

  // Review 2026-10-11 (second, I2): a look at Import loses not the export, and goes where Import was.
  it('keeps the export across a look at Import, on the database chosen there', async () => {
    api()
    const { wrapper } = await open({ part: 'export', connectionId: 'c1', db: 'crm' })
    const exporter = () => wrapper.findComponent(SqlExportPanel)
    const first = exporter().vm.$.uid
    await part('Import')
    expect(params()).toEqual({ part: 'import', connectionId: 'c1', db: 'crm' })
    await part('Export')
    expect(params()).toEqual({ part: 'export', connectionId: 'c1', db: 'crm' })
    expect(exporter().vm.$.uid).toBe(first)
    await part('Import')
    await pick('data-sql-database', 'shop')
    await part('Export')
    expect(params()).toEqual({ part: 'export', connectionId: 'c1', db: 'shop' })
    expect(exporter().vm.$.uid).toBe(first)
  })

  // Review 2026-10-11 (second, minor 10): closing the page with work to lose asks first.
  it('asks before its tab is closed with work to lose, and the browser before the page is left', async () => {
    api()
    const { wrapper } = await open({ part: 'import', connectionId: 'c1', db: 'shop' })
    const tabs = useTabsStore()
    const id = tabs.activeId
    const work = useTabWorkStore()
    expect(work.has(id)).toBe(false)
    wrapper.findComponent(SqlImportPanel).vm.$emit('work', true)
    await flushPromises()
    expect(work.has(id)).toBe(true)
    let close!: (id: string) => Promise<void>
    mountApp(
      defineComponent(() => {
        close = useTabClose()
        return () => h('div')
      }),
    )
    const closing = close(id)
    await flushPromises()
    const dialogs = useDialogStore()
    expect(dialogs.current?.title).toBe('Leave the file you prepared?')
    dialogs.settle(false)
    await closing
    expect(tabs.tabs.some((t) => t.id === id)).toBe(true)
    const event = new Event('beforeunload', { cancelable: true })
    mountApp(
      defineComponent(() => {
        useLeaveGuard()
        return () => h('div')
      }),
    )
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    const again = close(id)
    await flushPromises()
    dialogs.settle(true)
    await again
    expect(tabs.tabs.some((t) => t.id === id)).toBe(false)
  })

  it('offers to add a connection when there is none, only to whoever may', async () => {
    signedIn()
    api([])
    await open()
    expect(text()).toContain('No connection yet')
    ;[...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Add connection')!.click()
    expect(useWorkspaceDialogs().current).toEqual({ kind: 'connection' })

    document.body.innerHTML = ''
    setActivePinia(createPinia())
    signedIn({ permissions: [] })
    api([])
    await open()
    expect(text()).toContain('No connection yet')
    expect(
      [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Add connection'),
    ).toBe(false)
  })

  it('says when the connections cannot be listed, and tries again', async () => {
    let fail = true
    mockApi({
      'GET connections': () => (fail ? [500, { error: { code: 'INTERNAL', message: 'down' } }] : [200, []]),
    })
    await open()
    expect(document.querySelector('[data-sql-connections-error]')).toBeTruthy()
    expect(text()).not.toContain('No connection yet')
    fail = false
    ;[...document.querySelectorAll<HTMLButtonElement>('[data-sql-connections-error] button')][0]!.click()
    await flushPromises()
    await flushPromises()
    expect(text()).toContain('No connection yet')
  })
})

describe('the SQL page’s address', () => {
  const route = (params: Record<string, string>, name = 'sqlTransfer') => tabInputFromRoute({ name, params })

  it('reads its part, connection, database and collection, dropping what is not one', () => {
    expect(route({ part: 'export', connectionId: 'c1', db: 'shop', coll: 'orders' })).toEqual({
      kind: 'sqlTransfer',
      title: '',
      params: { part: 'export', connectionId: 'c1', db: 'shop', coll: 'orders' },
    })
    expect(route({})).toEqual({ kind: 'sqlTransfer', title: '', params: {} })
    expect(route({ part: 'run', connectionId: 'c1' })!.params).toEqual({})
    expect(route({ part: 'import', connectionId: 'c1', db: 'a/b' })!.params).toEqual({
      part: 'import',
      connectionId: 'c1',
    })
    expect(
      tabLocation({
        id: 'x',
        kind: 'sqlTransfer',
        title: '',
        params: { part: 'import', connectionId: 'c1', db: 'shop' },
      }),
    ).toEqual({ name: 'sqlTransfer', params: { part: 'import', connectionId: 'c1', db: 'shop' } })
  })

  it('takes one database, never every database (“*”), and a collection on an export only', () => {
    for (const part of ['import', 'export'])
      expect(route({ part, connectionId: 'c1', db: '*', coll: 'orders' })!.params).toEqual({
        part,
        connectionId: 'c1',
      })
    expect(route({ part: 'export', connectionId: 'c1', db: 'shop', coll: 'orders' })!.params).toEqual({
      part: 'export',
      connectionId: 'c1',
      db: 'shop',
      coll: 'orders',
    })
    expect(route({ part: 'import', connectionId: 'c1', db: 'shop', coll: 'orders' })!.params).toEqual({
      part: 'import',
      connectionId: 'c1',
      db: 'shop',
    })
    expect(
      tabLocation({
        id: 'x',
        kind: 'sqlTransfer',
        title: '',
        params: { part: 'import', connectionId: 'c1', db: 'shop', coll: 'orders' },
      }),
    ).toEqual({ name: 'sqlTransfer', params: { part: 'import', connectionId: 'c1', db: 'shop' } })
  })

  it('sends the SQL plugin’s old page, a link or a kept tab, to SQL ↔ MongoDB', () => {
    expect(
      route(
        { plugin: 'sql-to-mongodb', contribution: 'sql', connectionId: 'c1', db: 'shop', coll: 'orders' },
        'pluginPage',
      ),
    ).toEqual({ kind: 'sqlTransfer', title: '', params: { part: 'import', connectionId: 'c1', db: 'shop' } })
    expect(route({ plugin: 'sql-to-mongodb', contribution: 'sql' }, 'pluginPage')).toEqual({
      kind: 'sqlTransfer',
      title: '',
      params: {},
    })
    localStorage.setItem(
      'mm:tabs',
      JSON.stringify({
        tabs: [
          { id: 'welcome', kind: 'welcome', title: '', params: {} },
          {
            id: 'p1',
            kind: 'pluginPage',
            title: 'SQL',
            params: {
              plugin: 'sql-to-mongodb',
              contribution: 'sql',
              connectionId: 'c1',
              db: 'shop',
              coll: 'o',
            },
          },
          { id: 's1', kind: 'sqlTransfer', title: '', params: { part: 'export' } },
        ],
        activeId: 'p1',
        owner: null,
      }),
    )
    const tabs = useTabsStore()
    // The page's own id (review 2026-10-11, I4): opened again later, it is this one, never a second.
    expect(tabs.tabs.map((t) => t.kind)).toEqual(['welcome', 'sqlTransfer'])
    expect(tabs.tabs.filter((t) => t.kind === 'sqlTransfer')).toEqual([
      {
        id: 'sqlTransfer:',
        kind: 'sqlTransfer',
        title: '',
        params: { part: 'import', connectionId: 'c1', db: 'shop' },
      },
    ])
    expect(tabs.activeId).toBe('sqlTransfer:')
    openSqlTransferTab(tabs, { part: 'export', connectionId: 'c1', db: 'crm' })
    expect(tabs.tabs).toHaveLength(2)
    expect(params()).toEqual({ part: 'export', connectionId: 'c1', db: 'crm' })
  })

  it('opens the SQL plugin’s old page, asked for by name, as SQL ↔ MongoDB', () => {
    // Review 2026-10-11 (I7): an old plugin (1.3) still offers its page; it is this one now.
    const tabs = useTabsStore()
    tabs.open({
      kind: 'pluginPage',
      title: 'SQL',
      params: { plugin: 'sql-to-mongodb', contribution: 'sql', connectionId: 'c1', db: 'shop', coll: 'o' },
    })
    expect(tabs.tabs).toEqual([
      {
        id: 'sqlTransfer:',
        kind: 'sqlTransfer',
        title: '',
        params: { part: 'import', connectionId: 'c1', db: 'shop' },
      },
    ])
    openSqlTransferTab(tabs, { part: 'export', connectionId: 'c1', db: 'crm' })
    expect(tabs.tabs).toHaveLength(1)
  })

  // Review minor 5: a kept tab asking for every database opens on one, as a link does.
  it('drops every database (“*”) from a kept tab', () => {
    localStorage.setItem(
      'mm:tabs',
      JSON.stringify({
        tabs: [
          {
            id: 'sqlTransfer:',
            kind: 'sqlTransfer',
            title: '',
            params: { part: 'export', connectionId: 'c1', db: '*' },
          },
        ],
        activeId: 'sqlTransfer:',
        owner: null,
      }),
    )
    expect(useTabsStore().tabs[0]!.params).toEqual({ part: 'export', connectionId: 'c1' })
  })

  it('is one page, kept in the tab as views of it', () => {
    const tabs = useTabsStore()
    const a = openSqlTransferTab(tabs, { part: 'import', connectionId: 'c1', db: 'shop' })
    const b = openSqlTransferTab(tabs, { part: 'export', connectionId: 'c2', db: 'archive' })
    expect(a).toBe(b)
    expect(tabs.tabs.filter((t) => t.kind === 'sqlTransfer')).toHaveLength(1)
    expect(params()).toEqual({ part: 'export', connectionId: 'c2', db: 'archive' })
    // A view param that is not one is dropped — "*" too (one database at a time: 2026-10-12).
    tabs.setView(a, { part: 'run', db: 'a/b' })
    expect(params().part).toBeUndefined()
    expect(params().db).toBeUndefined()
    tabs.setView(a, { part: 'export', connectionId: 'c1', db: '*' })
    expect(params()).toEqual({ part: 'export', connectionId: 'c1' })
  })

  it('opened with nothing asked, shows the page where it was left', () => {
    const tabs = useTabsStore()
    const a = openSqlTransferTab(tabs, { part: 'export', connectionId: 'c1', db: 'crm' })
    tabs.activate(tabs.tabs[0]!.id)
    expect(openSqlTransferTab(tabs)).toBe(a)
    expect(tabs.activeId).toBe(a)
    expect(params()).toEqual({ part: 'export', connectionId: 'c1', db: 'crm' })
  })
})

// Found by the e2e (2026-10-11): the workspace must give the page its tab, or the place chosen never
// reaches the address.
describe('the SQL page in the workspace', () => {
  // User request 2026-11-02: the page comes with the SQL → MongoDB plugin, running here.
  const SQL_PLUGIN = {
    id: 'sql-to-mongodb',
    version: '1.0.0',
    name: { en: 'SQL to MongoDB' },
    entry: 'index.html',
    permissions: [],
    contributes: { collectionTabs: [], documentActions: [], sidebarPanels: [], cellRenderers: [] },
    settings: {},
  }
  async function workspace(plugins: unknown[] = [SQL_PLUGIN]) {
    mockApi({
      'GET plugins': () => [200, plugins],
      'GET auth/status': () => [200, { mode: 'local', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [
        200,
        {
          mode: 'local',
          user: { id: 'local', username: 'owner', role: 'admin' },
          permissions: ['connections:manage'],
          csrfToken: 'c',
          readOnly: false,
          twoFactor: {},
        },
      ],
      'GET connections': () => [200, [connection('c1', 'Prod')]],
      'GET connections/c1/databases': () => [
        200,
        { databases: [{ name: 'shop', sizeOnDisk: 1, empty: false }], totalSize: 1 },
      ],
      'GET connections/c1/databases/shop/collections': () => [200, []],
      'GET connections/c1/databases/shop/stats': () => [200, { collections: 0 }],
    })
    signedIn()
    useSessionStore().status = { mode: 'local', setupRequired: false, authenticated: true }
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    mountApp(WorkspaceView, { plugins: [router] })
    await flushPromises()
    return router
  }

  it('is offered only while the SQL → MongoDB plugin runs (user request 2026-11-02)', async () => {
    await workspace([])
    // The sidebar is there, its other entries too (review of 1.0.1, M3): only this one is not.
    expect(document.querySelector('nav')?.textContent).toContain('Queries')
    expect(document.querySelector('[data-sidebar-sql]')).toBeNull()
  })

  it('opens from the sidebar and writes where it works into the address', async () => {
    const router = await workspace()
    document.querySelector<HTMLButtonElement>('[data-sidebar-sql]')!.click()
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/sql/import/c1/shop'))
    expect(document.querySelector('[data-sql-transfer]')).toBeTruthy()
  })

  // Seen in the preview (2026-10-11): the location bar showed "Prod / *", and its switchers left the
  // page for a database tab; the page chooses where it works itself.
  it('names the page in the location bar, never a switcher that leaves it', async () => {
    const router = await workspace()
    document.querySelector<HTMLButtonElement>('[data-sidebar-sql]')!.click()
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/sql/import/c1/shop'))
    const tabs = useTabsStore()
    tabs.setView(tabs.activeId, { part: 'export', connectionId: 'c1', db: 'shop' })
    await flushPromises()
    const location = document.querySelector('nav[aria-label="Location"]')!
    expect(location.textContent).toContain('SQL ↔ MongoDB')
    expect(location.textContent).not.toContain('shop')
    expect(location.querySelector('[role="combobox"], button[aria-haspopup]')).toBeNull()
  })

  it('stays while another tab is shown, and the sidebar brings it back as it was', async () => {
    const router = await workspace()
    document.querySelector<HTMLButtonElement>('[data-sidebar-sql]')!.click()
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/sql/import/c1/shop'))
    const page = document.querySelector('[data-sql-transfer]')
    const tabs = useTabsStore()
    const sql = tabs.activeId
    tabs.setView(sql, { part: 'export', connectionId: 'c1', db: 'shop' })
    tabs.activate(tabs.tabs[0]!.id)
    await flushPromises()
    expect(document.querySelector('[data-sql-transfer]')).toBe(page)
    document.querySelector<HTMLButtonElement>('[data-sidebar-sql]')!.click()
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/sql/export/c1/shop'))
    expect(tabs.activeId).toBe(sql)
    expect(document.querySelector('[data-sql-transfer]')).toBe(page)
    // Shown once: kept, never drawn again as the active tab.
    expect(document.querySelectorAll('[data-sql-transfer]')).toHaveLength(1)
  })
})
