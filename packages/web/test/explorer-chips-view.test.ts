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

// W1 (completion §2): filter chips above the results, suggestion chips under the composer.
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
const items = [
  { document: { _id: { $numberInt: '1' }, status: 'paid', qty: { $numberInt: '5' } }, hash: '1'.repeat(64) },
]
const finds = (calls: Array<{ path: string; body: unknown }>) => calls.filter((c) => c.path.endsWith('/find'))
const chips = () => [...document.querySelectorAll<HTMLElement>('[data-filter-chips] [data-chip]')]

describe('filter chips', () => {
  it('show one chip per condition run, and removing one rewrites the filter and runs it', async () => {
    const { calls } = mockApi({
      [`POST ${PREFIX}/find`]: () => [200, { documents: items, hasMore: false }],
      [`POST ${PREFIX}/count`]: () => [200, { count: 1, exact: true }],
    })
    const state = useCollectionViewsStore().stateFor('tab-c')
    state.draft = { ...state.draft, filter: '{ status: "paid", qty: { $lt: 30 } }' }
    state.query = {
      filter: { status: 'paid', qty: { $lt: { $numberInt: '30' } } },
      skip: 0,
      limit: 20,
    }
    mountApp(DocumentsView, { props: { target: T, tabId: 'tab-c', canWrite: true, isView: false } })
    await flushPromises()
    expect(chips().map((c) => c.getAttribute('aria-label'))).toEqual(['status = "paid"', 'qty < 30'])
    expect(document.querySelector('[data-filter-chips]')!.getAttribute('aria-label')).toBe(
      'Conditions of the filter in use',
    )
    const remove = chips()[0]!.querySelector<HTMLButtonElement>('button')!
    expect(remove.getAttribute('aria-label')).toBe('Remove the condition status = "paid"')
    remove.click()
    await flushPromises()
    expect(state.query.filter).toEqual({ qty: { $lt: { $numberInt: '30' } } })
    expect(state.draft.filter).toBe('{ qty: { $lt: 30 } }')
    expect(finds(calls).at(-1)!.body).toMatchObject({ filter: { qty: { $lt: { $numberInt: '30' } } } })
    // Delete on the focused chip removes it too, and the filter empties.
    chips()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    await flushPromises()
    expect(state.query.filter).toEqual({})
    expect(state.draft.filter).toBe('')
    expect(document.querySelector('[data-filter-chips]')).toBeNull()
  })
})

// W1 review (important 1, minor 7, minor 10): the text being written is the user's.
describe('removing a chip, and the text in the bar', () => {
  function mount(tab: string, draft: string, query: Record<string, unknown>) {
    const api = mockApi({
      [`POST ${PREFIX}/find`]: () => [200, { documents: items, hasMore: false }],
      [`POST ${PREFIX}/count`]: () => [200, { count: 1, exact: true }],
    })
    const state = useCollectionViewsStore().stateFor(tab)
    state.draft = { ...state.draft, filter: draft }
    state.query = { filter: query, skip: 0, limit: 20 }
    mountApp(DocumentsView, { props: { target: T, tabId: tab, canWrite: true, isView: false } })
    return { ...api, state }
  }
  const removeFirst = async () => {
    chips()[0]!.querySelector<HTMLButtonElement>('button')!.click()
    await flushPromises()
  }

  it('leaves edits not yet run as they are, says so, and runs the filter without the chip', async () => {
    const { state, calls } = mount('tab-e', '{ status: "open", qty: 1 } // mine', {
      status: 'paid',
      qty: { $numberInt: '1' },
    })
    await flushPromises()
    await removeFirst()
    expect(state.draft.filter).toBe('{ status: "open", qty: 1 } // mine')
    expect(finds(calls).at(-1)!.body).toMatchObject({ filter: { qty: { $numberInt: '1' } } })
    expect(useToastStore().toasts.at(-1)!.message).toBe(
      'Condition removed: status = "paid". The filter you were editing was left as it is.',
    )
  })

  it('rewrites a text that is the filter run, and Undo puts back the text and the query', async () => {
    const { state, calls } = mount('tab-u', '{status:"paid",qty:1}', {
      status: 'paid',
      qty: { $numberInt: '1' },
    })
    await flushPromises()
    await removeFirst()
    expect(state.draft.filter).toBe('{ qty: 1 }')
    const toast = useToastStore().toasts.at(-1)!
    expect(toast.message).toBe('Condition removed: status = "paid".')
    toast.actions!.find((a) => a.label === 'Undo')!.run()
    await flushPromises()
    expect(state.draft.filter).toBe('{status:"paid",qty:1}')
    expect(state.query.filter).toEqual({ status: 'paid', qty: { $numberInt: '1' } })
    expect(finds(calls).at(-1)!.body).toMatchObject({ filter: { status: 'paid' } })
  })

  it('takes a text search’s score out of the sort and the projection with its chip', async () => {
    const { state } = mount('tab-t', '', { $text: { $search: 'tea' }, qty: { $numberInt: '1' } })
    state.query = {
      ...state.query,
      sort: { score: { $meta: 'textScore' }, qty: { $numberInt: '1' } },
      projection: { score: { $meta: 'textScore' }, qty: { $numberInt: '1' } },
    }
    await flushPromises()
    await removeFirst()
    expect(state.query.filter).toEqual({ qty: { $numberInt: '1' } })
    expect(state.query.sort).toEqual({ qty: { $numberInt: '1' } })
    expect(state.query.projection).toEqual({ qty: { $numberInt: '1' } })
  })

  it('moves the focus to the bar when the last chip goes', async () => {
    mount('tab-f', '{ qty: 1 }', { qty: { $numberInt: '1' } })
    await flushPromises()
    chips()[0]!.focus()
    chips()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    await flushPromises()
    expect(document.activeElement?.closest('form[role="search"]')).not.toBeNull()
  })
})

describe('suggestion chips', () => {
  it('offer conditions from a small schema sample, never a hidden field, and add one to the filter', async () => {
    const { calls } = mockApi({
      'GET connections/c1/personal-fields/applied': () => [200, { rules: [], patterns: [['email']] }],
      [`POST ${PREFIX}/schema`]: () => [
        200,
        {
          sampled: 100,
          truncated: false,
          fields: [
            {
              path: 'status',
              keys: ['status'],
              count: 100,
              types: { string: 100 },
              top: [{ value: 'paid', count: 70, type: 'string' }],
            },
            {
              path: 'email',
              keys: ['email'],
              count: 100,
              types: { string: 100 },
              top: [{ value: 'a@b.c', count: 9, type: 'string' }],
            },
          ],
        },
      ],
      'GET connections/c1/library': () => [
        200,
        {
          items: [{ type: 'history', kind: 'find', body: { filter: { region: 'eu', email: 'x@y.z' } } }],
          truncated: false,
          tags: [],
        },
      ],
      [`POST ${PREFIX}/find`]: () => [200, { documents: items, hasMore: false }],
      [`POST ${PREFIX}/count`]: () => [200, { count: 1, exact: true }],
    })
    // W1 review (minor 8): nothing is sampled until the browser is idle (or the bar is used).
    let idle: (() => void) | undefined
    vi.stubGlobal('requestIdleCallback', (cb: () => void) => ((idle = cb), 1))
    vi.stubGlobal('cancelIdleCallback', () => undefined)
    const state = useCollectionViewsStore().stateFor('tab-s')
    mountApp(DocumentsView, { props: { target: T, tabId: 'tab-s', canWrite: true, isView: false } })
    await flushPromises()
    expect(calls.some((c) => c.path.endsWith('/schema'))).toBe(false)
    idle!()
    await flushPromises()
    // A small sample with a short time limit.
    expect(calls.find((c) => c.path.endsWith('/schema'))!.body).toEqual({ sampleSize: 100, maxTimeMS: 5000 })
    // Recent conditions first (minor 13), never a hidden field's.
    const offered = [...document.querySelectorAll<HTMLButtonElement>('[data-suggestions] button[data-chip]')]
    expect(offered.map((b) => b.textContent?.trim())).toEqual(['region = "eu"', 'status = "paid"'])
    // User report 2026-11-07: a chip cut short is whole in its title.
    expect(offered[0]!.title).toBe('region = "eu" · Used recently')
    expect(offered[1]!.title).toBe('status = "paid"')
    // W1 review (minor 12): they wrap on a narrow screen rather than scroll out of sight.
    expect(document.querySelector('[data-suggestions]')!.className).toContain('flex-wrap')
    offered.shift()
    expect(offered[0]!.getAttribute('aria-label')).toBe('Add status = "paid" to the filter')
    offered[0]!.click()
    await flushPromises()
    expect(state.draft.filter).toBe('{ status: "paid" }')
    expect(finds(calls).at(-1)!.body).toMatchObject({ filter: { status: 'paid' } })
    // A field already filtered is not offered again.
    expect(
      [...document.querySelectorAll('[data-suggestions] button[data-chip]')].map((b) =>
        b.textContent?.trim(),
      ),
    ).toEqual(['region = "eu"'])
  })

  it('are not offered on a view (its pipeline would run), and wait for the bar when it is used first', async () => {
    const { calls } = mockApi({
      [`POST ${PREFIX}/find`]: () => [200, { documents: items, hasMore: false }],
      [`POST ${PREFIX}/count`]: () => [200, { count: 1, exact: true }],
    })
    vi.stubGlobal('requestIdleCallback', () => 1)
    vi.stubGlobal('cancelIdleCallback', () => undefined)
    mountApp(DocumentsView, { props: { target: T, tabId: 'tab-v', canWrite: false, isView: true } })
    await flushPromises()
    document.querySelector<HTMLElement>('form[role="search"] textarea')!.focus()
    await flushPromises()
    expect(calls.some((c) => c.path.endsWith('/schema'))).toBe(false)
    document.body.innerHTML = ''
    mountApp(DocumentsView, { props: { target: T, tabId: 'tab-b', canWrite: true, isView: false } })
    await flushPromises()
    expect(calls.some((c) => c.path.endsWith('/schema'))).toBe(false)
    document.querySelector<HTMLElement>('form[role="search"] textarea')!.focus()
    await flushPromises()
    expect(calls.some((c) => c.path.endsWith('/schema'))).toBe(true)
  })
})
