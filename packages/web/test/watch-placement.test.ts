// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { PERMISSIONS } from '@mongo-manager/shared'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import { createAppRouter } from '../src/router'
import { i18n } from '../src/i18n'
import { useTabsStore, type TabInput } from '../src/stores/tabs'
import { commandTitle, useCommandsStore } from '../src/stores/commands'
import { resetWatchFeeds } from '../src/watch/feeds'
import { mockApi, mountApp } from './support/app'
import { fakeSocket } from './support/watch'

const live = vi.hoisted(() => ({ socket: null as unknown }))
vi.mock('../src/jobs/live', async (original) => ({
  ...(await original<typeof import('../src/jobs/live')>()),
  realtimeSocket: () => live.socket,
  useJobsLive: () => undefined,
}))

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  resetWatchFeeds()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const DB = 'connections/c1/databases/shop'

function api(permissions: readonly string[] = PERMISSIONS, type = 'collection') {
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
    'GET connections': () => [
      200,
      [
        {
          id: 'c1',
          name: 'Prod',
          group: null,
          color: null,
          favorite: false,
          readOnly: false,
          settings: {},
          uri: '',
          createdAt: 0,
          updatedAt: 0,
          lastUsedAt: null,
          access: 'admin',
          permissions: [...permissions],
        },
      ],
    ],
    // A connection's sections are shown once it is connected (its databases read).
    'GET connections/c1/databases': () => [
      200,
      { databases: [{ name: 'shop', sizeOnDisk: 1, empty: false }], totalSize: 1 },
    ],
    [`GET ${DB}/collections`]: () => [
      200,
      [{ name: 'orders', type, options: {}, readOnly: type === 'view' }],
    ],
    [`POST ${DB}/collections/orders/find`]: () => [200, { documents: [], hasMore: false }],
    [`POST ${DB}/collections/orders/count`]: () => [200, { count: 0, exact: true }],
  })
}

const sections = (label: string) =>
  [...document.querySelectorAll<HTMLElement>(`[role="tablist"][aria-label="${label}"] [role="tab"]`)].map(
    (t) => t.textContent?.trim(),
  )
const tab = (label: string, name: string) =>
  [...document.querySelectorAll<HTMLElement>(`[role="tablist"][aria-label="${label}"] [role="tab"]`)].find(
    (t) => t.textContent?.trim() === name,
  )!

async function workspace(open: TabInput, label: string | null) {
  const s = fakeSocket()
  live.socket = s.socket
  const router = createAppRouter(createMemoryHistory())
  await router.push('/')
  const tabs = useTabsStore()
  tabs.bindUser('local')
  tabs.open(open)
  mountApp(WorkspaceView, { plugins: [router] })
  if (label)
    // The tab views are async components: the first one loads slowly in a cold test run.
    await vi.waitFor(
      () => expect(document.querySelector(`[role="tablist"][aria-label="${label}"]`)).not.toBeNull(),
      { timeout: 10_000 },
    )
  await flushPromises()
  return { s, tabs }
}

const COLLECTION: TabInput = {
  kind: 'collection',
  title: 'shop.orders',
  params: { connectionId: 'c1', db: 'shop', coll: 'orders' },
}
const DATABASE: TabInput = { kind: 'database', title: 'shop', params: { connectionId: 'c1', db: 'shop' } }

describe('where Watch lives (phase 3e-1 spec §4.1)', () => {
  it('is a collection section after Overview', async () => {
    api()
    const w = await workspace(COLLECTION, 'Collection sections')
    expect(sections('Collection sections').slice(-4)).toEqual(['Overview', 'Watch', 'Personal data', 'Backups'])
    // UI review: the workspace column never grows past the window (many tabs scroll in their bar).
    expect(document.querySelector('main')!.classList.contains('min-w-0')).toBe(true)
    tab('Collection sections', 'Watch').click()
    await vi.waitFor(() =>
      expect(w.s.lastSub()).toMatchObject({ scope: 'collection', db: 'shop', coll: 'orders' }),
    )
  })

  // Final review M5: a view's tab offers Watch too: it says why a view cannot be watched.
  it('is a section of a view too', async () => {
    api(PERMISSIONS, 'view')
    await workspace(COLLECTION, 'Collection sections')
    expect(sections('Collection sections')).toContain('Watch')
  })

  it('is a database section, and a connection section after Performance', async () => {
    api()
    const w = await workspace(DATABASE, 'Database sections')
    // W6.4: the Model section comes between them; user request 2026-10-24: Backups and Personal data after.
    expect(sections('Database sections')).toEqual(['Overview', 'Model', 'Watch', 'Backups', 'Personal data'])
    tab('Database sections', 'Watch').click()
    await vi.waitFor(() => expect(w.s.lastSub()).toMatchObject({ scope: 'database', db: 'shop' }))
    w.tabs.open({ kind: 'connection', title: 'Prod', params: { connectionId: 'c1' } })
    await vi.waitFor(
      // W3's sections (Users & roles, Alerts) come after Watch.
      () => expect(sections('Connection sections').slice(0, 3)).toEqual(['Overview', 'Performance', 'Watch']),
      { timeout: 10_000 },
    )
  })

  it('is not offered without documents:read', async () => {
    api(PERMISSIONS.filter((p) => p !== 'documents:read'))
    await workspace(DATABASE, null)
    await vi.waitFor(() => expect(document.body.textContent).toContain('shop'))
    // The database's other sections stay (Backups, Personal data); Watch and Model are not offered.
    expect(sections('Database sections')).toEqual(['Overview', 'Backups', 'Personal data'])
  })

  it('opens from the palette on the active tab, and stops when its tab closes', async () => {
    api()
    const w = await workspace(DATABASE, 'Database sections')
    const command = useCommandsStore().commands.find((c) => c.id === 'watch.open')!
    expect(commandTitle(command)).toBe('Watch changes…')
    await command.run()
    await vi.waitFor(() =>
      expect(
        document
          .querySelector('[role="tablist"][aria-label="Database sections"] [aria-selected="true"]')
          ?.textContent?.trim(),
      ).toBe('Watch'),
    )
    await vi.waitFor(() => expect(w.s.lastSub()).toMatchObject({ scope: 'database' }))
    const { id } = w.s.lastSub()
    w.tabs.close(w.tabs.active!.id)
    await flushPromises()
    // The tab closed: its feed is pruned at once, not after the 5 s grace.
    await vi.waitFor(() => expect(w.s.sent).toContainEqual({ ch: 'watch', type: 'unsub', id }))
  })
})
