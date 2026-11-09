// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { PERMISSIONS } from '@mongo-manager/shared'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { createAppRouter } from '../src/router'
import { i18n } from '../src/i18n'
import { useTabsStore } from '../src/stores/tabs'
import { mockApi, mountApp, type Handler } from './support/app'
import { button, typeInto } from './support/dom'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const conn = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
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
  ...extra,
})

async function workspace(handlers: Record<string, Handler>, path = '/') {
  const api = mockApi({
    'GET auth/status': () => [200, { mode: 'local', setupRequired: false, authenticated: true }],
    'GET auth/me': () => [
      200,
      {
        mode: 'local',
        user: { id: 'local', username: 'owner', role: 'admin' },
        permissions: [...PERMISSIONS],
        csrfToken: 'c',
        readOnly: false,
        twoFactor: {},
      },
    ],
    'GET connections': () => [
      200,
      [
        conn('c1', 'Prod', { group: 'Team' }),
        conn('c2', 'Local', { permissions: ['connections:read', 'databases:read', 'documents:read'] }),
        conn('c3', 'Archive', { group: 'Team', favorite: true }),
      ],
    ],
    ...handlers,
  })
  const router = createAppRouter(createMemoryHistory())
  await router.push(path)
  const { queryClient } = mountApp(WorkspaceView, { plugins: [router] })
  mountApp(DialogHost)
  await flushPromises()
  return { ...api, router, queryClient }
}

const items = () => [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')]
const labels = () => items().map((i) => i.getAttribute('aria-label'))
const item = (label: string) => items().find((i) => i.getAttribute('aria-label') === label)!
const row = (label: string) => item(label).querySelector<HTMLElement>(':scope > div')!
const key = async (target: HTMLElement, k: string, init: KeyboardEventInit = {}) => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }))
  await flushPromises()
}
const openMenu = async (name: string) => {
  ;(document.querySelector(`button[aria-label="Actions for ${name}"]`) as HTMLButtonElement).click()
  await flushPromises()
}
const menuItems = () => [...document.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent?.trim())
const pick = async (label: string) => {
  ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((m) => m.textContent?.trim() === label)!
    .click()
  await flushPromises()
}

const DATABASES = {
  databases: [
    { name: 'a/b', sizeOnDisk: 1, empty: false },
    { name: 'shop', sizeOnDisk: 2, empty: false },
  ],
  totalSize: 3,
}
const COLLECTIONS = [
  { name: '<img src=x>', type: 'collection', options: {}, readOnly: false },
  { name: 'daily', type: 'view', options: {}, readOnly: false },
]

describe('connection tree', () => {
  it('groups, sorts and navigates with the keyboard, loading children lazily', async () => {
    const { calls } = await workspace({
      'GET connections/c1/databases': () => [200, DATABASES],
      'GET connections/c1/databases/shop/collections': () => [200, COLLECTIONS],
    })
    expect(document.querySelector('[role="tree"]')).not.toBeNull()
    expect(labels()).toEqual(['Team', 'Archive', 'Prod', 'Local'])
    expect(item('Prod').getAttribute('aria-level')).toBe('2')
    expect(items().filter((i) => i.tabIndex === 0)).toHaveLength(1)
    expect(calls.some((c) => c.path.includes('/databases'))).toBe(false)

    item('Team').focus()
    await key(item('Team'), 'ArrowDown')
    await key(document.activeElement as HTMLElement, 'ArrowDown')
    expect(document.activeElement).toBe(item('Prod'))
    await key(item('Prod'), 'ArrowRight')
    expect(item('Prod').getAttribute('aria-expanded')).toBe('true')
    expect(labels()).toEqual(['Team', 'Archive', 'Prod', 'a/b', 'shop', 'Local'])
    await key(item('Prod'), 'ArrowRight')
    expect(document.activeElement).toBe(item('a/b'))
    await key(item('a/b'), 'ArrowDown')
    await key(item('shop'), 'Enter')
    expect(useTabsStore().active?.params).toEqual({ connectionId: 'c1', db: 'shop' })
    expect(labels()).toContain('<img src=x>')
    // Rendered as text: no element was created from the name (attribute values serialise '<' unescaped).
    expect(document.querySelector('[role="tree"] img')).toBeNull()
    await key(item('shop'), 'ArrowLeft')
    expect(item('shop').getAttribute('aria-expanded')).toBe('false')
    await key(item('shop'), 'ArrowLeft')
    expect(document.activeElement).toBe(item('Prod'))
    await key(item('Prod'), 'End')
    expect(document.activeElement).toBe(item('Local'))
  })

  it('shows a readable error with Retry when a server cannot be reached (Review Focus 3)', async () => {
    let up = false
    await workspace({
      'GET connections/c2/databases': () =>
        up
          ? [200, { databases: [], totalSize: 0 }]
          : [502, { code: 'MONGO_ERROR', message: 'x', details: { kind: 'network' } }],
    })
    row('Local').click()
    await flushPromises()
    expect(item('Local').querySelector('[role="alert"]')!.textContent).toContain(
      'Cannot reach the MongoDB server.',
    )
    up = true
    button('Retry').click()
    await flushPromises()
    expect(item('Local').textContent).toContain('No databases.')
  })

  it('offers only the actions the caller may perform (Review Focus 5)', async () => {
    await workspace({
      'GET connections/c1/databases': () => [200, DATABASES],
      'GET connections/c2/databases': () => [200, DATABASES],
    })
    // Connected (its databases read): what needs the server is offered too (user report 2026-10-23).
    row('Prod').click()
    await flushPromises()
    await openMenu('Prod')
    expect(menuItems()).toEqual([
      'Open',
      // UI redesign R1 revision 2 §3.6.
      'Pin',
      'Edit',
      'Duplicate',
      'Test connection',
      'Add to favorites',
      'New database',
      'Refresh',
      // Phase 3d-3a: documents:write and jobs:run allow a restore; without export, no backup.
      'Restore…',
      'Delete',
    ])
    await key(document.activeElement as HTMLElement, 'Escape')
    row('Local').click()
    await flushPromises()
    await openMenu('Local')
    expect(menuItems()).not.toContain('New database')
  })

  it('deletes a connection after confirmation and closes its tabs', async () => {
    const { calls } = await workspace({ 'DELETE connections/c1': () => [204] })
    row('Prod').click()
    expect(useTabsStore().active?.title).toBe('Prod')
    await openMenu('Prod')
    await pick('Delete')
    expect(document.querySelector('[role="dialog"] h2')!.textContent).toBe('Delete connection')
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE' && c.path === 'connections/c1')).toBe(true)
    expect(useTabsStore().tabs.map((t) => t.kind)).toEqual(['welcome'])
  })

  it('drops a database only after its name is typed (Review Focus 4)', async () => {
    const { calls } = await workspace({
      'GET connections/c1/databases': () => [200, DATABASES],
      'DELETE connections/c1/databases/a%2Fb': () => [204],
    })
    row('Prod').click()
    await flushPromises()
    await openMenu('a/b')
    await pick('Drop')
    const confirm = document.querySelector('[data-test="confirm"]') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    await typeInto(document.querySelector('[data-test="require-text"] input') as HTMLInputElement, 'a/b')
    confirm.click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'DELETE')).toMatchObject({
      path: 'connections/c1/databases/a%2Fb',
      body: { confirm: 'a/b' },
    })
  })

  // Review of the web fixes (minor 3): a dropped database's GridFS lists stayed in the cache.
  it('forgets the GridFS lists of a database it dropped', async () => {
    const { queryClient } = await workspace({
      'GET connections/c1/databases': () => [200, DATABASES],
      'DELETE connections/c1/databases/a%2Fb': () => [204],
    })
    queryClient.setQueryData(['gridfs', 'c1', 'a/b', 'buckets'], [{ name: 'fs' }])
    row('Prod').click()
    await flushPromises()
    await openMenu('a/b')
    await pick('Drop')
    await typeInto(document.querySelector('[data-test="require-text"] input') as HTMLInputElement, 'a/b')
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(queryClient.getQueryData(['gridfs', 'c1', 'a/b', 'buckets'])).toBeUndefined()
  })

  it('toggles a favorite', async () => {
    const { calls } = await workspace({
      'PATCH connections/c1': () => [200, conn('c1', 'Prod', { favorite: true })],
    })
    await openMenu('Prod')
    await pick('Add to favorites')
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ favorite: true })
  })

  it('filters connections by name or group', async () => {
    await workspace({})
    const filter = document.querySelector('input[type="search"]') as HTMLInputElement
    await typeInto(filter, 'loc')
    expect(labels()).toEqual(['Local'])
    await typeInto(filter, 'zzz')
    expect(document.body.textContent).toContain('No connection matches.')
  })
})

describe('the tree shows where the open tab is (user, 2026-10-08: "sayfayı yeniledim … bağlantılar kapalı")', () => {
  const handlers = {
    'GET connections/c1/databases': () => [200, DATABASES] as ReturnType<Handler>,
    'GET connections/c1/databases/shop/collections': () => [200, COLLECTIONS] as ReturnType<Handler>,
    'GET connections/c1/databases/shop/collections/daily/stats': () =>
      [404, { code: 'NOT_FOUND', message: 'x' }] as ReturnType<Handler>,
  }

  it('opens the connection and database of a tab shown on load, and marks its collection', async () => {
    await workspace(handlers, '/c/c1/db/shop/coll/daily')
    await vi.waitFor(() => expect(labels()).toContain('daily'))
    expect(item('Team').getAttribute('aria-expanded')).toBe('true')
    expect(item('Prod').getAttribute('aria-expanded')).toBe('true')
    expect(item('shop').getAttribute('aria-expanded')).toBe('true')
    expect(item('daily').getAttribute('aria-current')).toBe('page')
  })

  it('leaves a branch the user closed while the same tab stays open, and opens the next tab’s', async () => {
    const { router } = await workspace(handlers, '/c/c1/db/shop/coll/daily')
    await vi.waitFor(() => expect(labels()).toContain('daily'))
    await key(item('Prod'), 'ArrowLeft')
    expect(item('Prod').getAttribute('aria-expanded')).toBe('false')
    await flushPromises()
    expect(item('Prod').getAttribute('aria-expanded')).toBe('false')
    await router.push('/c/c1/db/shop')
    await flushPromises()
    await vi.waitFor(() => expect(item('Prod').getAttribute('aria-expanded')).toBe('true'))
    expect(item('shop').getAttribute('aria-current')).toBe('page')
    // Back to Home and to the collection again: its place is opened again.
    await key(item('Prod'), 'ArrowLeft')
    await router.push('/')
    await flushPromises()
    await router.push('/c/c1/db/shop/coll/daily')
    await flushPromises()
    await vi.waitFor(() => expect(item('Prod').getAttribute('aria-expanded')).toBe('true'))
  })
})

describe('Overview after a reload (user, 2026-10-08: "ana sayfa tabı siliniyor, sıradaki taba geçiyor")', () => {
  it('shows Overview again, beside the other tabs, without moving to another one', async () => {
    localStorage.setItem(
      'mm:tabs',
      JSON.stringify({
        tabs: [
          { id: 'welcome', kind: 'welcome', title: '', params: {} },
          {
            id: 'collection:coll=daily&connectionId=c1&db=shop',
            kind: 'collection',
            title: 'shop.daily',
            params: { connectionId: 'c1', db: 'shop', coll: 'daily' },
          },
        ],
        activeId: 'welcome',
        owner: 'local',
      }),
    )
    const { router } = await workspace({})
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/')
    expect(useTabsStore().active?.kind).toBe('welcome')
    expect(useTabsStore().tabs.map((t) => t.kind)).toEqual(['welcome', 'collection'])
  })
})

describe('system databases are never offered a backup or a restore (menu sweep, 2026-10-08)', () => {
  it('offers Back up and Restore here on a user database only, and Back up collection likewise', async () => {
    mockApi({
      'GET auth/status': () => [200, { mode: 'local', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [
        200,
        {
          mode: 'local',
          user: { id: 'local', username: 'owner', role: 'admin' },
          permissions: [...PERMISSIONS],
          csrfToken: 'c',
          readOnly: false,
          twoFactor: {},
        },
      ],
      'GET connections': () => [200, [conn('c1', 'Prod', { export: true })]],
      'GET connections/c1/databases': () => [
        200,
        {
          databases: [
            { name: 'admin', sizeOnDisk: 1, empty: false },
            { name: 'shop', sizeOnDisk: 2, empty: false },
          ],
          totalSize: 3,
        },
      ],
      'GET connections/c1/databases/admin/collections': () => [
        200,
        [{ name: 'system.version', type: 'collection', options: {}, readOnly: false }],
      ],
      'GET connections/c1/databases/shop/collections': () => [
        200,
        [{ name: 'orders', type: 'collection', options: {}, readOnly: false }],
      ],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    mountApp(WorkspaceView, { plugins: [router] })
    await flushPromises()
    await key(item('Prod'), 'ArrowRight')
    await openMenu('shop')
    expect(menuItems()).toEqual(expect.arrayContaining(['Back up database…', 'Restore here…']))
    await key(document.activeElement as HTMLElement, 'Escape')
    await openMenu('admin')
    expect(menuItems()).not.toContain('Back up database…')
    expect(menuItems()).not.toContain('Restore here…')
    await key(document.activeElement as HTMLElement, 'Escape')
    await key(item('admin'), 'ArrowRight')
    await openMenu('system.version')
    expect(menuItems()).not.toContain('Back up collection…')
    expect(menuItems()).not.toContain('Restore here…')
    await key(document.activeElement as HTMLElement, 'Escape')
    // W4.4: a user collection offers a restore into itself.
    await key(item('shop'), 'ArrowRight')
    await openMenu('orders')
    expect(menuItems()).toEqual(expect.arrayContaining(['Back up collection…', 'Restore here…']))
  })
})

describe('a view in the tree (menu sweep, 2026-10-08)', () => {
  it('offers no Rename for a view, and does for a collection', async () => {
    await workspace({
      'GET connections/c1/databases': () => [200, DATABASES],
      'GET connections/c1/databases/shop/collections': () => [
        200,
        [
          { name: 'orders', type: 'collection', options: {}, readOnly: false },
          { name: 'daily', type: 'view', options: { viewOn: 'orders', pipeline: [] }, readOnly: true },
        ],
      ],
    })
    await key(item('Prod'), 'ArrowRight')
    await key(item('shop'), 'ArrowRight')
    await openMenu('daily')
    expect(menuItems()).not.toContain('Rename')
    await key(document.activeElement as HTMLElement, 'Escape')
    await openMenu('orders')
    expect(menuItems()).toContain('Rename')
  })
})
