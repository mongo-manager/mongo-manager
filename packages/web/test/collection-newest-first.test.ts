// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import CollectionTab from '../src/workspace/tabs/CollectionTab.vue'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { usePreferencesStore } from '../src/stores/preferences'
import { i18n } from '../src/i18n'
import { mockApi, mountApp, type ApiCall } from './support/app'

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
const FIND = (coll: string) => `POST connections/c1/databases/shop/collections/${coll}/find`
const NEWEST = { _id: { $numberInt: '-1' } }

async function open(coll: string, type: string) {
  const { calls } = mockApi({
    'GET connections': () => [200, [CONN]],
    [LIST]: () => [200, [{ name: coll, type, options: {} }]],
    [FIND(coll)]: () => [200, { documents: [], hasMore: false }],
  })
  mountApp(CollectionTab, { props: { connectionId: 'c1', db: 'shop', coll, tabId: `t-${coll}` } })
  await flushPromises()
  await flushPromises()
  return calls
}
const finds = (calls: ApiCall[], coll: string) =>
  calls.filter((c) => c.method === 'POST' && c.path === FIND(coll).slice(5))

// User request 2026-11-02: "collection açtığımda hep en güncel olanı görmem lazım ilk sırada" — a
// collection opens newest first: its _id descending (an ObjectId carries its creation time, and _id
// has an index), said in the query's sort where it can be changed or cleared.
describe('a collection opens with its newest documents first', () => {
  it('asks for _id descending, from the first read, and says so in the sort', async () => {
    const calls = await open('orders', 'collection')
    const sent = finds(calls, 'orders')
    expect(sent.length).toBeGreaterThan(0)
    for (const call of sent) expect((call.body as { sort?: unknown }).sort).toEqual(NEWEST)
    expect(useCollectionViewsStore().stateFor('t-orders').draft.sort).toBe('{ _id: -1 }')
  })

  it.each([
    ['a view', 'view'],
    ['a time series', 'timeseries'],
  ])('leaves %s in its own order (no index on _id to sort by)', async (_, type) => {
    const calls = await open('feed', type)
    for (const call of finds(calls, 'feed')) expect((call.body as { sort?: unknown }).sort).toBeUndefined()
    expect(useCollectionViewsStore().stateFor('t-feed').draft.sort).toBe('')
  })

  it('leaves the order as stored when the preference says so', async () => {
    usePreferencesStore().setNewestFirst(false)
    const calls = await open('orders', 'collection')
    for (const call of finds(calls, 'orders')) expect((call.body as { sort?: unknown }).sort).toBeUndefined()
  })

  it('never puts the sort back once cleared, nor over a query the tab came with', async () => {
    const views = useCollectionViewsStore()
    const state = views.stateFor('t-orders')
    state.query = { filter: { _id: { $numberInt: '7' } }, skip: 0, limit: 20 }
    state.draft = { ...state.draft, filter: '{ _id: 7 }' }
    const calls = await open('orders', 'collection')
    for (const call of finds(calls, 'orders')) expect((call.body as { sort?: unknown }).sort).toBeUndefined()
  })

  it('opens newest first from a list already read (no wait, cached)', async () => {
    const first = await open('orders', 'collection')
    expect(finds(first, 'orders').length).toBeGreaterThan(0)
    document.body.innerHTML = ''
    // The same query client: the list is there at once when the next tab opens.
    mountApp(CollectionTab, { props: { connectionId: 'c1', db: 'shop', coll: 'orders', tabId: 't-again' } })
    await flushPromises()
    expect(useCollectionViewsStore().stateFor('t-again').draft.sort).toBe('{ _id: -1 }')
  })

  it('opens no query panel for it, and Reset goes back to it', async () => {
    const calls = await open('orders', 'collection')
    // Only the opening sort: no query written, so no panel saying one is.
    expect(document.querySelector('[data-query-panel]')).toBeNull()
    const state = useCollectionViewsStore().stateFor('t-orders')
    state.draft = { ...state.draft, sort: '{ total: 1 }' }
    state.query = { ...state.query, sort: { total: { $numberInt: '1' } } }
    await flushPromises()
    expect(document.querySelector('[data-query-panel]')).not.toBeNull()
    document.querySelector<HTMLButtonElement>('button[title="Reset"]')!.click()
    await flushPromises()
    expect(state.draft.sort).toBe('{ _id: -1 }')
    expect((finds(calls, 'orders').at(-1)!.body as { sort?: unknown }).sort).toEqual(NEWEST)
  })

  // e2e 2026-11-02: every collection opened with its Options open, for the opening sort alone.
  it('keeps Options closed for it, the sort still counted there', async () => {
    await open('orders', 'collection')
    const options = document.querySelector<HTMLButtonElement>('button[aria-expanded][data-count]')!
    expect(options.getAttribute('aria-expanded')).toBe('false')
    expect(options.getAttribute('aria-label')).toBe('Options, 1 set')
  })

  it('is remembered as a preference, newest first by default', () => {
    expect(usePreferencesStore().newestFirst).toBe(true)
    usePreferencesStore().setNewestFirst(false)
    setActivePinia(createPinia())
    expect(usePreferencesStore().newestFirst).toBe(false)
  })
})
