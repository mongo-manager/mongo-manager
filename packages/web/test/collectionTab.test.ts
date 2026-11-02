import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { PERMISSIONS } from '@mongo-manager/shared'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import { createAppRouter } from '../src/router'
import { i18n } from '../src/i18n'
import { useTabsStore } from '../src/stores/tabs'
import { useDialogStore } from '../src/stores/dialogs'
import { mockApi, mountApp } from './support/app'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const DB = 'connections/c1/databases/shop'

async function openCollection(coll: string) {
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
          permissions: [...PERMISSIONS],
        },
      ],
    ],
    [`GET ${DB}/collections`]: () => [
      200,
      [
        { name: 'orders', type: 'collection', options: {}, readOnly: false },
        { name: 'fs.files', type: 'collection', options: {}, readOnly: false },
        {
          name: 'daily',
          type: 'view',
          options: { viewOn: 'orders', pipeline: [{ $match: { status: 'paid' } }] },
          readOnly: true,
        },
      ],
    ],
    [`POST ${DB}/collections/${coll}/find`]: () => [
      200,
      { documents: [{ document: { _id: 1, a: 1 }, hash: 'a'.repeat(64) }], hasMore: false },
    ],
    [`POST ${DB}/collections/${coll}/count`]: () => [200, { count: 1, exact: true }],
    [`DELETE ${DB}/collections/${coll}`]: () => [204, undefined],
    [`GET ${DB}/collections/${coll}/indexes`]: () => [
      200,
      [{ name: '_id_', key: { _id: 1 }, options: {}, usage: null }],
    ],
    [`GET ${DB}/collections/${coll}/stats`]: () => [
      200,
      { count: 1, size: 10, storageSize: 10, avgObjSize: 10, totalIndexSize: 10, nindexes: 1, capped: false },
    ],
  })
  const router = createAppRouter(createMemoryHistory())
  await router.push('/')
  const tabs = useTabsStore()
  tabs.bindUser('local')
  tabs.open({ kind: 'collection', title: `shop.${coll}`, params: { connectionId: 'c1', db: 'shop', coll } })
  const { queryClient } = mountApp(WorkspaceView, { plugins: [router] })
  await vi.waitFor(() =>
    expect(document.querySelector('[role="tablist"][aria-label="Collection sections"]')).not.toBeNull(),
  )
  await flushPromises()
  return { ...api, queryClient }
}

const sections = () => [
  ...document.querySelectorAll<HTMLElement>(
    '[role="tablist"][aria-label="Collection sections"] [role="tab"]',
  ),
]

describe('collection tab', () => {
  it('opens on the documents with a query bar and switches sections with the arrow keys', async () => {
    await openCollection('orders')
    expect(sections().map((s) => s.textContent?.trim())).toEqual([
      'Documents',
      'Aggregations',
      'Explain',
      'Schema',
      'Indexes 1',
      'Validation',
      'Overview',
      // Phase 3e-1.
      'Watch',
      // User request 2026-10-23.
      'Personal data',
      // User request 2026-10-30: the backups that hold the collection.
      'Backups',
    ])
    expect(document.querySelector('form[role="search"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Add documents')
    sections()[0]!.focus()
    sections()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await flushPromises()
    expect(document.activeElement).toBe(sections()[1])
    sections()[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await flushPromises()
    expect(document.activeElement).toBe(sections()[2])
    sections()[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await flushPromises()
    expect(document.activeElement).toBe(sections()[3])
    sections()[3]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await flushPromises()
    expect(document.activeElement).toBe(sections()[4])
    await vi.waitFor(() => expect(document.body.textContent).toContain('_id_'))
  })

  it('keeps views read-only and without an Indexes section', async () => {
    await openCollection('daily')
    expect(sections().map((s) => s.textContent?.trim())).toEqual([
      'Documents',
      'Aggregations',
      'Explain',
      'Schema',
      'Overview',
      // Phase 3e-1 final review M5: it says why a view cannot be watched, and offers its collection.
      'Watch',
    ])
    expect(document.body.textContent).toContain('Views are read-only.')
    expect(document.body.textContent).not.toContain('Add documents')
  })
})

describe('a view’s overview and actions (menu sweep, 2026-10-08)', () => {
  const section = async (name: string) => {
    sections()
      .find((s) => s.textContent?.trim() === name)!
      .click()
    await flushPromises()
  }

  it('says what the view is on and shows its definition, never a MongoDB error', async () => {
    const { calls } = await openCollection('daily')
    await section('Overview')
    const overview = document.querySelector<HTMLElement>('[data-view-overview]')!
    expect(overview.textContent).toContain('orders')
    expect(overview.textContent).toContain('$match')
    expect(overview.textContent).toContain('paid')
    await vi.waitFor(() => expect(overview.textContent).toContain('1 document'))
    expect(document.body.textContent).not.toContain('not a collection')
    // A view has no size and no indexes of its own: nothing asks for them.
    expect(calls.some((c) => /daily\/(stats|indexes)$/.test(c.path))).toBe(false)
    const labels = [...overview.querySelectorAll('button')].map((b) => b.textContent?.trim())
    expect(labels).toEqual(expect.arrayContaining(['Open orders', 'Duplicate as a collection']))
    expect(labels).not.toContain('Rename')
    // UI redesign R2–R5 decision 3 (review of K+R2, I5): dropping is in the header's menu, not a page button.
    expect(labels).not.toContain('Drop view')
    ;(document.querySelector('button[aria-label^="More actions for daily"]') as HTMLButtonElement).click()
    await flushPromises()
    expect([...document.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent?.trim())).toContain(
      'Drop',
    )
    ;(document.querySelector('button[aria-label^="More actions for daily"]') as HTMLButtonElement).click()
    await flushPromises()
    ;[...overview.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.trim() === 'Open orders')!
      .click()
    await flushPromises()
    expect(useTabsStore().active?.params).toMatchObject({ coll: 'orders' })
  })

  // Review 2026-10-13 (web): a dropped collection's pages and indexes stayed in the cache, shown again
  // for a new collection of the same name.
  it('forgets everything it read of a collection it dropped', async () => {
    const { queryClient } = await openCollection('orders')
    const cached = () =>
      queryClient
        .getQueryCache()
        .findAll({ queryKey: ['connections', 'c1', 'databases', 'shop', 'collections', 'orders'] })
    expect(cached().length).toBeGreaterThan(0)
    ;(document.querySelector('button[aria-label^="More actions for orders"]') as HTMLButtonElement).click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.trim() === 'Drop')!
      .click()
    await flushPromises()
    useDialogStore().current!.value = 'orders'
    useDialogStore().settle(true)
    await flushPromises()
    expect(cached()).toEqual([])
  })

  // Review of the web fixes (minor 3): a dropped bucket's files list stayed in the cache.
  it('forgets the GridFS lists of a bucket it dropped, and nothing of other databases', async () => {
    const { queryClient } = await openCollection('fs.files')
    queryClient.setQueryData(['gridfs', 'c1', 'shop', 'buckets'], [{ name: 'fs' }])
    queryClient.setQueryData(['gridfs', 'c1', 'other', 'buckets'], [{ name: 'fs' }])
    ;(document.querySelector('button[aria-label^="More actions for fs.files"]') as HTMLButtonElement).click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.trim() === 'Drop')!
      .click()
    await flushPromises()
    useDialogStore().current!.value = 'fs.files'
    useDialogStore().settle(true)
    await flushPromises()
    expect(queryClient.getQueryData(['gridfs', 'c1', 'shop', 'buckets'])).toBeUndefined()
    expect(queryClient.getQueryData(['gridfs', 'c1', 'other', 'buckets'])).toBeDefined()
  })

  it('offers no Rename for a view (MongoDB cannot rename one), and drops it as a view', async () => {
    await openCollection('daily')
    ;(document.querySelector('button[aria-label^="More actions for daily"]') as HTMLButtonElement).click()
    await flushPromises()
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent?.trim())
    expect(items).not.toContain('Rename')
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.trim() === 'Drop')!
      .click()
    await flushPromises()
    expect(useDialogStore().current?.title).toBe('Drop view')
    expect(useDialogStore().current?.message).toContain('Only the view goes; the collection it reads stays.')
  })
})
