// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { PERMISSIONS } from '@mongo-manager/shared'
import ConnectionTab from '../src/workspace/tabs/ConnectionTab.vue'
import DatabaseTab from '../src/workspace/tabs/DatabaseTab.vue'
import { useSessionStore } from '../src/stores/session'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'

/**
 * Review of R3 (I-4, security first): the page header's "…" and each row's menu offer only what the
 * person may do — never a write, a drop or a backup the server would refuse — and stay reachable with
 * Tab even when all they can do is refresh.
 */
const READ_ONLY = ['documents:read', 'server:monitor'] as const
const connection = (permissions: readonly string[], over: Record<string, unknown> = {}) => ({
  id: 'c1',
  name: 'Prod',
  group: null,
  color: null,
  favorite: false,
  readOnly: false,
  settings: {},
  uri: 'mongodb://db1.example.org:27017/shop',
  createdAt: 0,
  updatedAt: 0,
  lastUsedAt: null,
  access: 'admin',
  permissions: [...permissions],
  export: true,
  shell: false,
  ...over,
})
function api(c: ReturnType<typeof connection>) {
  return mockApi({
    'GET connections': () => [200, [c]],
    'GET connections/c1/databases': () => [
      200,
      { databases: [{ name: 'shop', sizeOnDisk: 1, empty: false }], totalSize: 1 },
    ],
    'GET connections/c1/databases/shop/collections': () => [
      200,
      [
        { name: 'orders', type: 'collection', options: {}, readOnly: false },
        { name: 'daily', type: 'view', options: { viewOn: 'orders' }, readOnly: true },
      ],
    ],
    'GET connections/c1/databases/admin/collections': () => [200, []],
    'GET connections/c1/databases/shop/stats': () => [
      200,
      { collections: 1, views: 1, objects: 3, indexes: 1, dataSize: 1, storageSize: 1, indexSize: 1 },
    ],
    'GET connections/c1/databases/admin/stats': () => [
      200,
      { collections: 0, views: 0, objects: 0, indexes: 0, dataSize: 0, storageSize: 0, indexSize: 0 },
    ],
  })
}
const trigger = (prefix: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find((b) =>
    b.getAttribute('aria-label')!.startsWith(prefix),
  )
async function items(prefix: string): Promise<string[]> {
  const button = trigger(prefix)!
  button.click()
  await flushPromises()
  const list = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((m) =>
    m.textContent!.trim(),
  )
  button.click()
  await flushPromises()
  return list
}
const buttonTexts = () => [...document.querySelectorAll('button')].map((b) => b.textContent?.trim())

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  document.body.innerHTML = ''
})

describe('a database tab’s menus', () => {
  it('offer a reader only to open and refresh, and stay reachable with Tab', async () => {
    api(connection(READ_ONLY))
    mountApp(DatabaseTab, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    expect(buttonTexts()).not.toContain('New collection')
    expect(trigger('More actions for shop')!.tabIndex).toBe(0)
    expect(await items('More actions for shop')).toEqual(['Copy name', 'Refresh'])
    expect(await items('Actions for orders')).toEqual(['Open', 'Copy name'])
  })

  it('offer one who may change the database every action, a view no rename', async () => {
    api(connection(PERMISSIONS))
    mountApp(DatabaseTab, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    expect(buttonTexts()).toContain('New collection')
    expect(await items('More actions for shop')).toEqual([
      'Copy name',
      'Back up database…',
      'Refresh',
      'Drop database',
    ])
    expect(await items('Actions for orders')).toEqual(['Open', 'Copy name', 'Rename', 'Duplicate', 'Drop'])
    expect(await items('Actions for daily')).toEqual(['Open', 'Copy name', 'Duplicate', 'Drop'])
  })

  it('never offer to back up a system database, or without the right to export', async () => {
    api(connection(PERMISSIONS))
    mountApp(DatabaseTab, { props: { connectionId: 'c1', db: 'admin' } })
    await flushPromises()
    expect(await items('More actions for admin')).not.toContain('Back up database…')
    document.body.innerHTML = ''
    api(connection(PERMISSIONS, { export: false }))
    mountApp(DatabaseTab, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    expect(await items('More actions for shop')).not.toContain('Back up database…')
  })
})

describe('a connection tab’s menus', () => {
  it('offer a reader to test and refresh only, with no write and no drop', async () => {
    api(connection(READ_ONLY))
    mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    await flushPromises()
    expect(buttonTexts()).not.toContain('New database')
    expect(trigger('More actions for Prod')!.tabIndex).toBe(0)
    expect(await items('More actions for Prod')).toEqual(['Test connection', 'Refresh'])
    expect(await items('Actions for shop')).toEqual(['Open', 'Copy name'])
  })

  it('offer an admin of the connection to edit it, back it up and drop a database', async () => {
    api(connection(PERMISSIONS))
    useSessionStore().me = { permissions: ['connections:manage'] } as never
    mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    await flushPromises()
    expect(buttonTexts()).toContain('New database')
    expect(await items('More actions for Prod')).toEqual([
      'Test connection',
      'Edit',
      'Back up server…',
      'Refresh',
    ])
    expect(await items('Actions for shop')).toEqual([
      'Open',
      'Copy name',
      'Back up database…',
      'Drop database',
    ])
  })
})

// Review of R3 (minors 4, 5): the header counts what the card lists — collections and views apart —
// and the tab scrolls as a whole, not a column in its middle.
describe('a database tab’s header and scroller', () => {
  it('counts collections and views as its list does', async () => {
    api(connection(PERMISSIONS))
    mountApp(DatabaseTab, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    const facts = document.querySelector('header p')!.textContent!
    expect(facts).toContain('1 collection')
    expect(facts).toContain('1 view')
    const panel = document.querySelector<HTMLElement>('[role="tabpanel"], [id$="-panel"]')!
    expect(panel.className).toContain('overflow-auto')
  })
})

// Review of R3–R5, minor 3: a connection test is announced from start to end by one region that is
// there before it starts (one created with its first words may not be heard), and only once.
describe('a connection tab’s test', () => {
  it('announces the test and its result in a region that waits for them', async () => {
    let answer: (v: unknown) => void = () => undefined
    mockApi({
      'GET connections': () => [200, [connection(PERMISSIONS)]],
      'GET connections/c1/databases': () => [200, { databases: [], totalSize: 0 }],
      'POST connections/c1/test': () =>
        new Promise((resolve) => {
          answer = resolve
        }) as never,
    })
    mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    await flushPromises()
    const live = () => [...document.querySelectorAll('[role="status"]')]
    expect(live()).toHaveLength(1)
    const region = live()[0]!
    expect(region.textContent!.trim()).toBe('')
    trigger('More actions for Prod')!.click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.trim() === 'Test connection')!
      .click()
    await flushPromises()
    expect(region.textContent).toContain('Testing')
    answer([200, { ok: true, serverVersion: '8.0.4', topology: 'standalone', latencyMs: 3 }])
    await flushPromises()
    expect(live()).toEqual([region])
    expect(region.textContent).toContain('8.0.4')
  })
})

// Review of R3–R5, minor 11: the cases between — a system database, a connection that may not be
// exported, and one who may change documents but not databases.
describe('a connection tab’s row menus, the cases between', () => {
  const withAdmin = (c: ReturnType<typeof connection>) =>
    mockApi({
      'GET connections': () => [200, [c]],
      'GET connections/c1/databases': () => [
        200,
        {
          databases: [
            { name: 'admin', sizeOnDisk: 1, empty: false },
            { name: 'shop', sizeOnDisk: 1, empty: false },
          ],
          totalSize: 2,
        },
      ],
    })

  it('never offers to back up a system database', async () => {
    withAdmin(connection(PERMISSIONS))
    mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    await flushPromises()
    expect(await items('Actions for admin')).toEqual(['Open', 'Copy name', 'Drop database'])
    expect(await items('Actions for shop')).toEqual([
      'Open',
      'Copy name',
      'Back up database…',
      'Drop database',
    ])
  })

  it('never offers a backup where the connection may not be exported', async () => {
    withAdmin(connection(PERMISSIONS, { export: false }))
    mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    await flushPromises()
    expect(await items('Actions for shop')).toEqual(['Open', 'Copy name', 'Drop database'])
  })

  it('offers one who may change documents, not databases, no drop and no new database', async () => {
    withAdmin(connection(['documents:read', 'documents:write', 'jobs:run', 'data:export']))
    mountApp(ConnectionTab, { props: { connectionId: 'c1' } })
    await flushPromises()
    expect(buttonTexts()).not.toContain('New database')
    expect(await items('Actions for shop')).toEqual(['Open', 'Copy name', 'Back up database…'])
  })
})
