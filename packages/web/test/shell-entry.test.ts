// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { PERMISSIONS } from '@mongo-manager/shared'
import TreeConnection from '../src/workspace/tree/TreeConnection.vue'
import TreeDatabase from '../src/workspace/tree/TreeDatabase.vue'
import ConnectionTab from '../src/workspace/tabs/ConnectionTab.vue'
import DatabaseTab from '../src/workspace/tabs/DatabaseTab.vue'
import { shellDatabaseOf } from '../src/workspace/openTabs'
import { useWorkspaceCommands } from '../src/workspace/commands'
import { paletteFits, paletteIcon } from '../src/workspace/paletteGroups'
import { SquareTerminal } from 'lucide-vue-next'
import { useCommandsStore } from '../src/stores/commands'
import { useTabsStore } from '../src/stores/tabs'
import { useToastStore } from '../src/stores/toasts'
import { treeKey, useTreeStore } from '../src/stores/tree'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'

// User request 2026-10-11: the shell is found where people look — the connection's page beside
// Overview, Performance and Watch, a right click in the tree, and Ctrl+K from anywhere.
const connection = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  name: 'Prod',
  group: null,
  color: null,
  favorite: false,
  readOnly: false,
  settings: {},
  uri: 'mongodb://app:***@db1.example.org:27017,db2.example.org/shop?authSource=admin',
  createdAt: 0,
  updatedAt: 0,
  lastUsedAt: null,
  access: 'admin',
  permissions: [...PERMISSIONS],
  export: true,
  shell: true,
  ...over,
})
function api(list = [connection()]) {
  return mockApi({
    'GET connections': () => [200, list],
    'GET connections/c1/databases': () => [
      200,
      { databases: [{ name: 'shop', sizeOnDisk: 1, empty: false }], totalSize: 1 },
    ],
    'GET connections/c1/databases/sales/collections': () => [
      200,
      [{ name: 'orders', type: 'collection', options: {}, readOnly: false }],
    ],
  })
}
const shellTab = () => {
  const active = useTabsStore().tabs.find((t) => t.id === useTabsStore().activeId)
  return active?.kind === 'shell' ? active.params : null
}
async function pick(trigger: string, item: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find(
    (b) => b.getAttribute('aria-label') === trigger,
  )!
  button.click()
  await flushPromises()
  const entry = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (m) => m.textContent?.trim() === item,
  )
  entry?.click()
  await flushPromises()
  return entry
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  document.body.innerHTML = ''
})

describe('the database a connection’s shell starts on', () => {
  it('is the one its address names, else test, as mongosh', () => {
    expect(shellDatabaseOf('mongodb://u:***@h1,h2/shop?authSource=admin')).toBe('shop')
    expect(shellDatabaseOf('mongodb+srv://cluster.example.net/')).toBe('test')
    expect(shellDatabaseOf('mongodb://h:27017')).toBe('test')
    expect(shellDatabaseOf('mongodb://h/sales%2Darchive')).toBe('sales-archive')
    // Not a database name a shell can use: test.
    expect(shellDatabaseOf('mongodb://h/a.b')).toBe('test')
    expect(shellDatabaseOf('not an address')).toBe('test')
  })
})

describe('opening the shell from the tree', () => {
  it('offers it on a connection, on its database, only to those who may', async () => {
    api()
    // Once connected (its databases read), as Compass: the shell needs the server.
    useTreeStore().toggle(treeKey('c', 'c1'))
    mountApp(TreeConnection, { props: { connection: connection(), level: 1 } })
    await flushPromises()
    expect(await pick('Actions for Prod', 'Open shell')).toBeTruthy()
    expect(shellTab()).toEqual({ connectionId: 'c1', db: 'shop' })
    document.body.innerHTML = ''
    mountApp(TreeConnection, { props: { connection: connection({ shell: false }), level: 1 } })
    await flushPromises()
    expect(await pick('Actions for Prod', 'Open shell')).toBeUndefined()
  })

  it('offers it on a database and on a collection, on that database', async () => {
    api()
    useTreeStore().toggle(treeKey('d', 'c1', 'sales'))
    mountApp(TreeDatabase, { props: { connection: connection(), db: 'sales', level: 2 } })
    await flushPromises()
    expect(await pick('Actions for sales', 'Open shell')).toBeTruthy()
    expect(shellTab()).toEqual({ connectionId: 'c1', db: 'sales' })
    expect(await pick('Actions for orders', 'Open shell')).toBeTruthy()
    expect(shellTab()).toEqual({ connectionId: 'c1', db: 'sales' })
  })
})

describe('opening the shell from a connection’s or database’s page', () => {
  it('sits beside Overview, Performance and Watch, opening the connection’s shell', async () => {
    api()
    mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    await flushPromises()
    // UI redesign R3: the shell sits in the page header, beside the sections' tabs.
    const bar = document.querySelector('header')!
    expect(bar.querySelector('[role="tablist"]')).not.toBeNull()
    const open = bar.querySelector<HTMLButtonElement>('button[data-open-shell]')!
    expect(open.textContent?.trim()).toBe('Shell')
    open.click()
    await flushPromises()
    expect(shellTab()).toEqual({ connectionId: 'c1', db: 'shop' })
  })

  it('is not there for one who may not open a shell', async () => {
    api([connection({ shell: false })])
    mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    await flushPromises()
    expect(document.querySelector('button[data-open-shell]')).toBeNull()
  })

  it('opens on the database from its page', async () => {
    api()
    mountApp(DatabaseTab, { props: { connectionId: 'c1', db: 'sales' } })
    await flushPromises()
    document.querySelector<HTMLButtonElement>('button[data-open-shell]')!.click()
    await flushPromises()
    expect(shellTab()).toEqual({ connectionId: 'c1', db: 'sales' })
  })
})

describe('opening the shell with Ctrl+K', () => {
  const Commands = defineComponent({
    setup() {
      useWorkspaceCommands()
      return () => h('div')
    },
  })
  const command = (id: string) => useCommandsStore().commands.find((c) => c.id === id)

  it('lists a shell for each connection one may open it on, from anywhere', async () => {
    api([connection(), connection({ id: 'c2', name: 'Archive', shell: false })])
    mountApp(Commands)
    await flushPromises()
    const prod = command('shell.open:c1')!
    expect(typeof prod.title === 'function' ? prod.title() : prod.title).toBe('Open a shell on Prod')
    expect(command('shell.open:c2')).toBeUndefined()
    await prod.run()
    expect(shellTab()).toEqual({ connectionId: 'c1', db: 'shop' })
  })

  it('opens here from a connection’s tab, and says why not where it may not', async () => {
    api([connection(), connection({ id: 'c2', name: 'Archive', shell: false })])
    mountApp(Commands)
    await flushPromises()
    const tabs = useTabsStore()
    tabs.open({ kind: 'connection', title: 'Prod', params: { connectionId: 'c1' } })
    const active = tabs.tabs.find((t) => t.id === tabs.activeId)!
    expect(paletteFits(command('shell.open')!, active)).toBe(true)
    expect(paletteIcon(command('shell.open:c1')!)).toBe(SquareTerminal)
    await command('shell.open')!.run()
    expect(shellTab()).toEqual({ connectionId: 'c1', db: 'shop' })
    tabs.open({ kind: 'connection', title: 'Archive', params: { connectionId: 'c2' } })
    await command('shell.open')!.run()
    expect(useToastStore().toasts.at(-1)?.message).toBe('You may not open a shell on Archive.')
  })
})
