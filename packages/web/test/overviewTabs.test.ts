import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { PERMISSIONS } from '@mongo-manager/shared'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import { createAppRouter } from '../src/router'
import { i18n } from '../src/i18n'
import { useTabsStore } from '../src/stores/tabs'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const main = () => document.querySelector('main')!

describe('overview tabs', () => {
  it('walks from a connection to a database to a collection', async () => {
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
            color: 'red',
            favorite: false,
            readOnly: false,
            settings: {},
            uri: 'mongodb://db1:27017',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: null,
            access: 'admin',
            permissions: [...PERMISSIONS],
          },
        ],
      ],
      'GET connections/c1/databases': () => [
        200,
        {
          databases: [
            { name: 'shop', sizeOnDisk: 1536, empty: false },
            { name: 'tmp', sizeOnDisk: 0, empty: true },
          ],
          totalSize: 1536,
        },
      ],
      'GET connections/c1/databases/shop/stats': () => [
        200,
        {
          collections: 2,
          views: 1,
          objects: 1234567,
          dataSize: 2048,
          storageSize: 4096,
          indexes: 3,
          indexSize: 1024,
        },
      ],
      'GET connections/c1/databases/shop/collections': () => [
        200,
        [
          { name: 'orders', type: 'collection', options: {}, readOnly: false },
          { name: 'daily', type: 'view', options: {}, readOnly: false },
        ],
      ],
      'POST connections/c1/databases/shop/collections/orders/find': () => [
        200,
        { documents: [], hasMore: false },
      ],
      'POST connections/c1/databases/shop/collections/orders/count': () => [200, { count: 0, exact: true }],
      'GET connections/c1/databases/shop/collections/orders/stats': () => [
        200,
        {
          count: 42,
          size: 5 * 1024 ** 3,
          storageSize: 1024,
          avgObjSize: 120,
          totalIndexSize: 2048,
          nindexes: 2,
          capped: false,
        },
      ],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    const tabs = useTabsStore()
    // Tabs belong to a user; bind first, as the workspace does before anything opens tabs.
    tabs.bindUser('local')
    tabs.open({ kind: 'connection', title: 'Prod', params: { connectionId: 'c1' } })
    mountApp(WorkspaceView, { plugins: [router] })
    // The connection tab is loaded lazily: under a full run the first load can take over 1 s.
    await vi.waitFor(() => expect(main().textContent).toContain('mongodb://db1:27017'), { timeout: 5000 })
    await flushPromises()
    expect(main().textContent).toContain('Total size: 1.5 KB')
    expect(main().textContent).toContain('Empty')
    button('shop').click()
    await vi.waitFor(() => expect(main().textContent).toContain('1,234,567'))
    await flushPromises()
    expect(main().textContent).toContain('Data size')
    expect(main().textContent).toContain('2 KB')
    expect(main().querySelector('table')!.textContent).toContain('view')
    button('orders').click()
    // The collection tab opens on its documents; the stats live in the Overview section.
    // Loaded lazily too (as the connection tab above): its first load can take over 1 s.
    await vi.waitFor(
      () =>
        expect(document.querySelector('[role="tablist"][aria-label="Collection sections"]')).not.toBeNull(),
      { timeout: 5000 },
    )
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((b) => b.textContent?.trim() === 'Overview')!
      .click()
    await vi.waitFor(() => expect(main().textContent).toContain('5 GB'))
    expect(tabs.active?.title).toBe('shop.orders')
    expect(main().textContent).toContain('No')
  })

  it('says a size is hidden where personal data is hidden from you (ninth review of explain masking)', async () => {
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
            color: 'red',
            favorite: false,
            readOnly: false,
            settings: {},
            uri: 'mongodb://db1:27017',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: null,
            access: 'admin',
            permissions: [...PERMISSIONS],
          },
        ],
      ],
      'GET connections/c1/databases': () => [
        200,
        {
          databases: [
            { name: 'shop', sizeOnDisk: null, empty: false },
            { name: 'tmp', sizeOnDisk: 0, empty: true },
          ],
          totalSize: null,
        },
      ],
      'GET connections/c1/databases/shop/stats': () => [
        200,
        {
          collections: 2,
          views: 1,
          objects: 1234567,
          dataSize: null,
          storageSize: null,
          indexes: 3,
          indexSize: null,
          sizesHidden: true,
        },
      ],
      'GET connections/c1/databases/shop/collections': () => [
        200,
        [
          { name: 'orders', type: 'collection', options: {}, readOnly: false },
          { name: 'daily', type: 'view', options: {}, readOnly: false },
        ],
      ],
      'POST connections/c1/databases/shop/collections/orders/find': () => [
        200,
        { documents: [], hasMore: false },
      ],
      'POST connections/c1/databases/shop/collections/orders/count': () => [200, { count: 0, exact: true }],
      'GET connections/c1/databases/shop/collections/orders/stats': () => [
        200,
        {
          count: 42,
          size: null,
          storageSize: null,
          avgObjSize: null,
          totalIndexSize: null,
          nindexes: 2,
          capped: false,
          indexSizes: {},
          sizesHidden: true,
        },
      ],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    const tabs = useTabsStore()
    // Tabs belong to a user; bind first, as the workspace does before anything opens tabs.
    tabs.bindUser('local')
    tabs.open({ kind: 'connection', title: 'Prod', params: { connectionId: 'c1' } })
    mountApp(WorkspaceView, { plugins: [router] })
    // The connection tab is loaded lazily: under a full run the first load can take over 1 s.
    await vi.waitFor(() => expect(main().textContent).toContain('mongodb://db1:27017'), { timeout: 5000 })
    await flushPromises()
    // No total: it would tell what the hidden database adds.
    expect(main().textContent).not.toContain('Total size')
    expect(main().textContent).toContain('Hidden')
    expect(main().textContent).toContain('Empty')
    button('shop').click()
    await vi.waitFor(() => expect(main().textContent).toContain('1,234,567'))
    await flushPromises()
    expect(main().textContent).toContain('Data size')
    expect(main().textContent).toContain('Hidden')
    expect(main().textContent).not.toContain('NaN')
    expect(main().querySelector('table')!.textContent).toContain('view')
    button('orders').click()
    // The collection tab opens on its documents; the stats live in the Overview section.
    // Loaded lazily too (as the connection tab above): its first load can take over 1 s.
    await vi.waitFor(
      () =>
        expect(document.querySelector('[role="tablist"][aria-label="Collection sections"]')).not.toBeNull(),
      { timeout: 5000 },
    )
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((b) => b.textContent?.trim() === 'Overview')!
      .click()
    await vi.waitFor(() => expect(main().textContent).toContain('Average document'))
    expect(main().textContent).toContain('Hidden')
    // Said once, in words, where the size charts would be.
    expect(main().textContent).toContain('Sizes are hidden: rules hide personal data here from you')
    expect(main().textContent).not.toContain('Data and indexes')
    expect(main().textContent).not.toContain('NaN')
    expect(tabs.active?.title).toBe('shop.orders')
    expect(main().textContent).toContain('No')
    // 2026-10-26: as on the database's page, an administrator is taken to the collection's rules.
    main().querySelector<HTMLButtonElement>('[data-sizes-hidden] button')!.click()
    await flushPromises()
    expect(
      document
        .querySelector('[role="tablist"][aria-label="Collection sections"] [aria-selected="true"]')!
        .textContent!.trim(),
    ).toBe('Personal data')
    expect(document.activeElement).toBe(
      document.querySelector('[role="tablist"][aria-label="Collection sections"] [aria-selected="true"]'),
    )
  })
})
