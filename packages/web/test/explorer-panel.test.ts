// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DocumentsView from '../src/documents/DocumentsView.vue'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { useToastStore } from '../src/stores/toasts'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { settled } from './support/dom'

// W1 (completion §2): the query panel saves the query in use and runs it again, itself.
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const T = { connectionId: 'c1', db: 'shop', coll: 'orders' }
const PREFIX = 'connections/c1/databases/shop/collections/orders'
const items = [{ document: { _id: { $numberInt: '1' }, status: 'paid' }, hash: '1'.repeat(64) }]
const panel = () => document.querySelector<HTMLElement>('[data-query-panel]')!

describe('query panel', () => {
  it('saves the query in use (not the text being typed) as a favourite, and runs it again', async () => {
    const { calls } = mockApi({
      [`POST ${PREFIX}/find`]: () => [200, { documents: items, hasMore: false }],
      [`POST ${PREFIX}/count`]: () => [200, { count: 1, exact: true }],
      [`POST ${PREFIX}/favourites`]: (body) => [
        201,
        { id: 'f1', mine: true, owner: null, updatedAt: '2026-10-16T00:00:00Z', ...(body as object) },
      ],
    })
    const state = useCollectionViewsStore().stateFor('tab-p')
    state.query = {
      filter: { status: 'paid' },
      sort: { _id: { $numberInt: '-1' } },
      skip: 5,
      limit: 20,
    }
    // Being typed, not run: not what the panel saves.
    state.draft = { ...state.draft, filter: '{ status: "open" ' }
    mountApp(DocumentsView, { props: { target: T, tabId: 'tab-p', canWrite: false, isView: false } })
    await flushPromises()
    const before = calls.filter((c) => c.path.endsWith('/find')).length
    const run = [...panel().querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Run')!
    expect(run.title).toBe('Run this query again')
    run.click()
    await flushPromises()
    expect(calls.filter((c) => c.path.endsWith('/find')).length).toBe(before + 1)
    expect(calls.filter((c) => c.path.endsWith('/find')).at(-1)!.body).toMatchObject({
      filter: { status: 'paid' },
    })

    panel()
      .querySelector<HTMLButtonElement>('button[aria-label="Save the query in use as a favourite"]')!
      .click()
    await flushPromises()
    await settled()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    const name = dialog.querySelector<HTMLInputElement>('input')!
    name.value = 'Paid, newest'
    name.dispatchEvent(new Event('input'))
    await flushPromises()
    dialog.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await flushPromises()
    const saved = calls.find((c) => c.method === 'POST' && c.path.endsWith('/favourites'))!
    expect(saved.body).toMatchObject({
      name: 'Paid, newest',
      query: { filter: { status: 'paid' }, sort: { _id: { $numberInt: '-1' } } },
    })
    // Skip and limit are page settings, not part of a favourite (phase 2c).
    expect((saved.body as { query: object }).query).not.toHaveProperty('skip')
    expect(useToastStore().toasts.at(-1)!.message).toContain('Paid, newest')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  // W1 review (minor 12): on a phone the actions go under the query, which keeps the whole width.
  it('puts its actions under the query on a narrow screen', async () => {
    mockApi({
      [`POST ${PREFIX}/find`]: () => [200, { documents: items, hasMore: false }],
      [`POST ${PREFIX}/count`]: () => [200, { count: 1, exact: true }],
    })
    useCollectionViewsStore().stateFor('tab-n').query = { filter: { status: 'paid' }, skip: 0, limit: 20 }
    mountApp(DocumentsView, { props: { target: T, tabId: 'tab-n', canWrite: false, isView: false } })
    await flushPromises()
    const row = panel().querySelector<HTMLElement>('[data-query-panel-row]')!
    expect(row.className).toContain('max-sm:flex-col')
    expect(panel().querySelector('[data-query-panel-actions]')!.className).toContain('flex-wrap')
  })
})
