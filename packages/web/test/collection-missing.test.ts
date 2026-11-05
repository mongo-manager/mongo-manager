// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import CollectionTab from '../src/workspace/tabs/CollectionTab.vue'
import { useTabsStore } from '../src/stores/tabs'
import { useWorkspaceDialogs } from '../src/stores/workspaceDialogs'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const CONN = {
  id: 'c1',
  name: 'Prod',
  aiPolicy: 'any',
  permissions: ['documents:read', 'documents:write', 'databases:write'],
  settings: { hosts: [] },
}
const LIST = 'GET connections/c1/databases/shop/collections'
const props = (coll: string) => ({ props: { connectionId: 'c1', db: 'shop', coll, tabId: `t-${coll}` } })

describe('a collection that is not there (user, 2026-10-09: "olmayan bir collection adı girdim, varmış gibi davrandı")', () => {
  it('says so, offers its database and to close the tab, and never shows an empty, writable collection', async () => {
    const { calls } = mockApi({
      'GET connections': () => [200, [CONN]],
      [LIST]: () => [200, [{ name: 'orders', type: 'collection', options: {} }]],
    })
    mountApp(CollectionTab, props('ordersssss'))
    await flushPromises()
    await flushPromises()
    const missing = document.querySelector('[data-collection-missing]')!
    expect(missing.textContent).toContain('No collection “ordersssss” in shop')
    // Nothing is read from (or written to) what is not there: no documents, no stats, no Insert.
    expect(calls.some((c) => c.path.endsWith('/documents') || c.path.includes('/find'))).toBe(false)
    expect(calls.some((c) => c.path.endsWith('/stats'))).toBe(false)
    expect(document.body.textContent).not.toContain('Insert')
    expect(document.querySelector('[role="tablist"]')).toBeNull()
    // Its list was read again before saying so (a collection made a moment ago is no stale miss).
    expect(calls.filter((c) => c.path === LIST.slice(4)).length).toBeGreaterThanOrEqual(2)
    const tabs = useTabsStore()
    tabs.open({
      kind: 'collection',
      title: 'shop.ordersssss',
      params: { connectionId: 'c1', db: 'shop', coll: 'ordersssss' },
    })
    button('Open the database shop').click()
    expect(tabs.active).toMatchObject({ kind: 'database', params: { connectionId: 'c1', db: 'shop' } })
  })

  it('offers to create it to one who may', async () => {
    mockApi({ 'GET connections': () => [200, [CONN]], [LIST]: () => [200, []] })
    mountApp(CollectionTab, props('fresh'))
    await flushPromises()
    await flushPromises()
    button('Create “fresh”').click()
    expect(useWorkspaceDialogs().current).toEqual({
      kind: 'createCollection',
      connectionId: 'c1',
      db: 'shop',
      name: 'fresh',
    })
  })

  it('opens a collection made a moment ago, which the list read before did not have', async () => {
    let reads = 0
    mockApi({
      'GET connections': () => [200, [CONN]],
      [LIST]: () => [200, ++reads === 1 ? [] : [{ name: 'fresh', type: 'collection', options: {} }]],
    })
    mountApp(CollectionTab, props('fresh'))
    await flushPromises()
    await flushPromises()
    expect(document.querySelector('[data-collection-missing]')).toBeNull()
    expect(document.querySelector('[role="tablist"]')).not.toBeNull()
  })

  it('says when the connection is gone (deleted, or no longer the user’s)', async () => {
    mockApi({ 'GET connections': () => [200, []] })
    mountApp(CollectionTab, props('orders'))
    await flushPromises()
    await flushPromises()
    expect(document.querySelector('[data-collection-missing]')!.textContent).toContain(
      'This connection is not there',
    )
    expect(document.querySelector('[role="tablist"]')).toBeNull()
  })

  it('keeps no one waiting on a slow list, and says the collection is missing once the list says so', async () => {
    let reads = 0
    mockApi({
      'GET connections': () => [200, [CONN]],
      [LIST]: async () => {
        if (++reads === 1) await new Promise((r) => setTimeout(r, 1800))
        return [200, []]
      },
    })
    mountApp(CollectionTab, props('slow'))
    await flushPromises()
    expect(document.querySelector('[role="status"]')).not.toBeNull()
    // After a moment the tab opens read-only, as it did…
    await vi.waitFor(() => expect(document.querySelector('[role="tablist"]')).not.toBeNull(), {
      timeout: 3000,
    })
    expect(document.body.textContent).not.toContain('Insert')
    // …and says the collection is missing once the list has come (and was read again).
    await vi.waitFor(() => expect(document.querySelector('[data-collection-missing]')).not.toBeNull(), {
      timeout: 3000,
    })
  })

  it('opens a system collection (not in the plain list) as before', async () => {
    mockApi({ 'GET connections': () => [200, [CONN]], [LIST]: () => [200, []] })
    mountApp(CollectionTab, props('system.profile'))
    await flushPromises()
    await flushPromises()
    expect(document.querySelector('[data-collection-missing]')).toBeNull()
  })

  it('says nothing is missing when the list cannot be read', async () => {
    mockApi({
      'GET connections': () => [200, [CONN]],
      [LIST]: () => [500, { code: 'INTERNAL', message: 'x' }],
    })
    mountApp(CollectionTab, props('orders'))
    await flushPromises()
    await flushPromises()
    expect(document.querySelector('[data-collection-missing]')).toBeNull()
  })
})
