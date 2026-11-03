import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { LibraryItem } from '@mongo-manager/shared'
import LibraryView from '../src/library/LibraryView.vue'
import QueriesModule from '../src/workspace/overview/QueriesModule.vue'
import { useLibraryStore } from '../src/library/store'
import { useToastStore } from '../src/stores/toasts'
import { useTabsStore } from '../src/stores/tabs'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'

// W1 (completion §2): saved queries pinned first on the Queries page and on Home.
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  useTabsStore().bindUser('local')
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const item = (over: Partial<LibraryItem>): LibraryItem => ({
  type: 'favourite',
  id: '00000000-0000-4000-8000-000000000001',
  db: 'shop',
  coll: 'orders',
  tags: [],
  kind: 'find',
  preview: '{ a: 1 }',
  body: { filter: {} },
  at: '2026-09-27T10:00:00.000Z',
  shared: false,
  mine: true,
  ...over,
})
const CONNECTION = {
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
  access: 'viewer',
  permissions: [],
}
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-library-item]')]

describe('pins on the Queries page', () => {
  it('pins a saved query (listed first, marked) and unpins it; history has no pin', async () => {
    let pinned = false
    const fav = item({ name: 'Big orders' })
    const other = item({ id: '00000000-0000-4000-8000-000000000002', name: 'Newer' })
    const history = item({ type: 'history', id: '00000000-0000-4000-8000-000000000003', name: undefined })
    const { calls } = mockApi({
      'GET connections': () => [200, [CONNECTION]],
      'GET connections/c1/library': () => [
        200,
        {
          items: pinned ? [{ ...fav, pinned: true }, other, history] : [other, fav, history],
          truncated: false,
        },
      ],
      'PUT connections/c1/library/pins': (body) => {
        pinned = (body as { pinned: boolean }).pinned
        return [200, { pinned }]
      },
    })
    useLibraryStore().connectionId = 'c1'
    const { queryClient } = mountApp(LibraryView)
    // Home's queries widget, as it was before the pin.
    const home = ['overview', 'library', 'c1', 'saved']
    queryClient.setQueryData(home, [])
    await flushPromises()
    expect(rows()[2]!.querySelector('button[aria-label^="Pin"]')).toBeNull()
    const pin = rows()[1]!.querySelector<HTMLButtonElement>('button[aria-label="Pin Big orders"]')!
    pin.click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      type: 'favourite',
      id: fav.id,
      pinned: true,
    })
    // W1 review (minor 13): Home's widget reads the pins again.
    expect(queryClient.getQueryState(home)!.isInvalidated).toBe(true)
    expect(rows()[0]!.textContent).toContain('Big orders')
    expect(rows()[0]!.textContent).toContain('Pinned')
    const unpin = rows()[0]!.querySelector<HTMLButtonElement>('button[aria-label="Unpin Big orders"]')!
    unpin.click()
    await flushPromises()
    expect(calls.filter((c) => c.method === 'PUT').at(-1)!.body).toMatchObject({ pinned: false })
    expect(rows()[0]!.textContent).toContain('Newer')
  })

  it('says when no more can be pinned', async () => {
    mockApi({
      'GET connections': () => [200, [CONNECTION]],
      'GET connections/c1/library': () => [200, { items: [item({ name: 'Big orders' })], truncated: false }],
      'PUT connections/c1/library/pins': () => [
        409,
        { code: 'CONFLICT', message: 'x', details: { reason: 'limit', max: 50 } },
      ],
    })
    useLibraryStore().connectionId = 'c1'
    mountApp(LibraryView)
    await flushPromises()
    rows()[0]!.querySelector<HTMLButtonElement>('button[aria-label="Pin Big orders"]')!.click()
    await flushPromises()
    expect(useToastStore().toasts.at(-1)!.message).toBe(
      'At most 50 queries can be pinned on a connection. Unpin one first.',
    )
  })
})

describe('pins on Home', () => {
  it('lists pinned saved queries first, marked as pinned', async () => {
    mockApi({
      'GET connections': () => [200, [CONNECTION]],
      'GET connections/c1/library': () => [
        200,
        {
          items: [item({ name: 'Pinned one', pinned: true }), item({ id: 'x2', name: 'Plain' })],
          truncated: false,
        },
      ],
    })
    mountApp(QueriesModule)
    await flushPromises()
    document.querySelector<HTMLElement>('[role="radio"][aria-label="Saved"]')!.click()
    await flushPromises()
    const listed = [...document.querySelectorAll('li')].map((li) => li.textContent?.trim() ?? '')
    expect(listed[0]).toContain('Pinned one')
    expect(document.querySelector('li [data-pinned]')!.getAttribute('aria-label')).toBe('Pinned')
  })
})
