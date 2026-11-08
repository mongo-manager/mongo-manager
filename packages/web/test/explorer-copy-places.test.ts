// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { SchemaAnalyser } from '@mongo-manager/shared'
import TreeDatabase from '../src/workspace/tree/TreeDatabase.vue'
import DatabaseTab from '../src/workspace/tabs/DatabaseTab.vue'
import ConnectionTab from '../src/workspace/tabs/ConnectionTab.vue'
import SchemaView from '../src/schema/SchemaView.vue'
import { treeKey, useTreeStore } from '../src/stores/tree'
import { useToastStore } from '../src/stores/toasts'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'

// W1 (completion §2): "Copy name" on databases, collections and fields, said by a toast.
const connection = {
  id: 'c1',
  name: 'Prod',
  group: null,
  color: null,
  favorite: false,
  readOnly: false,
  settings: {},
  uri: 'mongodb://h/shop',
  createdAt: 0,
  updatedAt: 0,
  lastUsedAt: null,
  // A reader: copying a name needs no right beyond seeing it.
  access: 'viewer',
  permissions: ['databases:read', 'documents:read'],
  export: false,
  shell: false,
}
let writeText: ReturnType<typeof vi.fn>
beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  i18n.global.locale.value = 'en'
  writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function api() {
  return mockApi({
    'GET connections': () => [200, [connection]],
    'GET connections/c1/databases': () => [
      200,
      { databases: [{ name: 'shop', sizeOnDisk: 1, empty: false }], totalSize: 1 },
    ],
    'GET connections/c1/databases/sales/collections': () => [
      200,
      [{ name: 'orders.2024', type: 'collection', options: {}, readOnly: false }],
    ],
    'GET connections/c1/databases/sales/stats': () => [200, { dataSize: 1 }],
  })
}
async function pick(trigger: string, item: string): Promise<HTMLElement | undefined> {
  const opener = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find(
    (b) => b.getAttribute('aria-label') === trigger,
  )!
  opener.click()
  await flushPromises()
  const entry = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (m) => m.textContent?.trim() === item,
  )
  entry?.click()
  await flushPromises()
  return entry
}
const lastToast = () => useToastStore().toasts.at(-1)?.message

describe('Copy name', () => {
  it('is on a database and a collection in the tree', async () => {
    api()
    useTreeStore().toggle(treeKey('d', 'c1', 'sales'))
    mountApp(TreeDatabase, { props: { connection, db: 'sales', level: 2 } })
    await flushPromises()
    expect(await pick('Actions for sales', 'Copy name')).toBeTruthy()
    expect(writeText).toHaveBeenLastCalledWith('sales')
    expect(lastToast()).toBe('Copied “sales”.')
    expect(await pick('Actions for orders.2024', 'Copy name')).toBeTruthy()
    expect(writeText).toHaveBeenLastCalledWith('orders.2024')
  })

  it('is in a database page’s header and its collections’ rows, and on a connection’s databases', async () => {
    api()
    mountApp(DatabaseTab, { props: { connectionId: 'c1', db: 'sales' } })
    await flushPromises()
    expect(await pick('More actions for sales', 'Copy name')).toBeTruthy()
    expect(writeText).toHaveBeenLastCalledWith('sales')
    const rowMenu = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find((b) =>
      b.getAttribute('aria-label')?.includes('orders.2024'),
    )!
    expect(await pick(rowMenu.getAttribute('aria-label')!, 'Copy name')).toBeTruthy()
    expect(writeText).toHaveBeenLastCalledWith('orders.2024')
    document.body.innerHTML = ''
    mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    await flushPromises()
    const dbMenu = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find((b) =>
      b.getAttribute('aria-label')?.includes('shop'),
    )!
    expect(await pick(dbMenu.getAttribute('aria-label')!, 'Copy name')).toBeTruthy()
    expect(writeText).toHaveBeenLastCalledWith('shop')
  })

  it('is on a field of the schema, as a query names it', async () => {
    const a = new SchemaAnalyser()
    a.add({ items: [{ sku: 'a' }], name: 'x' })
    mockApi({
      'POST connections/c1/databases/shop/collections/orders/schema': () => [200, a.result()],
    })
    mountApp(SchemaView, { props: { target: { connectionId: 'c1', db: 'shop', coll: 'orders' } } })
    await flushPromises()
    button('Analyse').click()
    await flushPromises()
    const copy = document.querySelector<HTMLButtonElement>(
      '[data-field="items[].sku"] button[data-copy-name]',
    )!
    expect(copy.getAttribute('aria-label')).toBe('Copy the name items.sku')
    copy.click()
    await flushPromises()
    expect(writeText).toHaveBeenLastCalledWith('items.sku')
  })
})
