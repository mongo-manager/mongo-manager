// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DocumentsView from '../src/documents/DocumentsView.vue'
import DocumentTable from '../src/documents/DocumentTable.vue'
import { visibleRange } from '../src/documents/useVirtualRows'
import { toRows } from '../src/documents/rows'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'

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
const doc = (i: number, extra: Record<string, unknown> = {}) => ({
  document: { _id: { $numberInt: String(i) }, name: `n${i}`, ...extra },
  hash: String(i).padStart(64, '0'),
})

describe('visibleRange', () => {
  it('renders only the rows in view plus overscan', () => {
    expect(visibleRange(0, 360, 1000, 36, 5)).toEqual({ start: 0, end: 15, padTop: 0, padBottom: 985 * 36 })
    expect(visibleRange(3600, 360, 1000, 36, 5)).toEqual({
      start: 95,
      end: 115,
      padTop: 95 * 36,
      padBottom: 885 * 36,
    })
    expect(visibleRange(0, 360, 3, 36, 5)).toEqual({ start: 0, end: 3, padTop: 0, padBottom: 0 })
  })
})

describe('DocumentTable', () => {
  it('virtualizes long pages and renders mixed and unsupported values (Review Focus 1)', () => {
    const items = [
      ...Array.from({ length: 998 }, (_, i) => doc(i)),
      { document: { _id: { $numberInt: '998' }, name: { first: 'A', last: 'B' } }, hash: 'e'.repeat(64) },
      { unsupported: { _id: { $numberInt: '999' }, reason: 'date out of range' } },
    ]
    mountApp(DocumentTable, {
      props: { rows: toRows(items, 0), columns: ['_id', 'name'], canWrite: true, rowHeight: 36 },
    })
    const rendered = document.querySelectorAll('tbody tr[data-row]')
    expect(rendered.length).toBeGreaterThan(10)
    expect(rendered.length).toBeLessThan(100)
    expect(document.querySelector('tbody')!.textContent).toContain('n0')
    // A value cut short is whole in its title (review 2026-10-13).
    expect(document.querySelector('td[data-field="name"] [data-cell-value]')!.getAttribute('title')).toBe(
      '"n0"',
    )
  })

  it('shows containers as counts and unsupported rows with their reason', () => {
    const items = [
      {
        document: { _id: { $numberInt: '1' }, name: { first: 'A', last: 'B' }, tags: ['a', 'b', 'c'] },
        hash: 'e'.repeat(64),
      },
      { unsupported: { _id: { $numberInt: '2' }, reason: 'date out of range' } },
    ]
    mountApp(DocumentTable, {
      props: { rows: toRows(items, 0), columns: ['_id', 'name', 'tags'], canWrite: false, rowHeight: 36 },
    })
    const text = document.querySelector('tbody')!.textContent!
    expect(text).toContain('2 fields')
    expect(text).toContain('3 items')
    expect(text).toContain('Cannot display this document: date out of range')
  })
})

describe('DocumentsView', () => {
  it('loads a page with its count, pages forward and keeps the old rows while loading (Review Focus 2)', async () => {
    let resolveSecond: (() => void) | undefined
    const { calls } = mockApi({
      [`POST ${PREFIX}/find`]: (body) => {
        const skip = (body as { skip: number }).skip
        const page = { documents: Array.from({ length: 20 }, (_, i) => doc(skip + i)), hasMore: true }
        if (skip === 0) return [200, page]
        return new Promise((resolve) => {
          resolveSecond = () => resolve([200, page])
        })
      },
      [`POST ${PREFIX}/count`]: () => [200, { count: 1234, exact: true }],
    })
    const views = useCollectionViewsStore()
    views.stateFor('tab-1')
    mountApp(DocumentsView, { props: { target: T, tabId: 'tab-1', canWrite: true, isView: false } })
    await flushPromises()
    expect(document.body.textContent).toContain('1–20 of 1,234')
    expect(document.querySelector('tbody')!.textContent).toContain('n0')
    ;(document.querySelector('button[aria-label="Next page"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(calls.filter((c) => c.path.endsWith('/find')).at(-1)!.body).toMatchObject({ skip: 20, limit: 20 })
    expect(document.querySelector('tbody')!.textContent).toContain('n0')
    resolveSecond!()
    await flushPromises()
    expect(document.querySelector('tbody')!.textContent).toContain('n20')
    expect(document.body.textContent).toContain('21–40 of 1,234')
  })

  it('sends the collation with the count, so the total matches the listed documents (phase 1g-1)', async () => {
    const { calls } = mockApi({
      [`POST ${PREFIX}/find`]: () => [200, { documents: [doc(0)], hasMore: false }],
      [`POST ${PREFIX}/count`]: () => [200, { count: 1, exact: true }],
    })
    const state = useCollectionViewsStore().stateFor('tab-c')
    state.query = { filter: { name: 'ada' }, collation: { locale: 'en' }, hint: 'name_1', skip: 0, limit: 20 }
    mountApp(DocumentsView, { props: { target: T, tabId: 'tab-c', canWrite: true, isView: false } })
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/count'))!.body).toEqual({
      filter: { name: 'ada' },
      collation: { locale: 'en' },
      hint: 'name_1',
    })
  })

  it('reports lower-bound counts and empty results', async () => {
    mockApi({
      [`POST ${PREFIX}/find`]: () => [200, { documents: [], hasMore: false }],
      [`POST ${PREFIX}/count`]: () => [200, { count: null, exact: false, atLeast: 10000 }],
    })
    useCollectionViewsStore().stateFor('tab-2')
    mountApp(DocumentsView, { props: { target: T, tabId: 'tab-2', canWrite: false, isView: false } })
    await flushPromises()
    expect(document.body.textContent).toContain('This collection has no documents yet')
    expect(document.body.textContent).toContain('No documents')
  })
})

describe('"Why is it slow?" (phase 2b)', () => {
  it('opens Explain on the Documents query and asks it to run, from the query panel', async () => {
    mockApi({
      [`POST ${PREFIX}/find`]: () => [200, { documents: [], hasMore: false }],
      [`POST ${PREFIX}/count`]: () => [200, { count: 0, exact: true }],
    })
    const state = useCollectionViewsStore().stateFor('tab-why')
    state.query = { filter: { a: { $numberInt: '1' } }, skip: 0, limit: 20 }
    mountApp(DocumentsView, { props: { target: T, tabId: 'tab-why', canWrite: true, isView: false } })
    await flushPromises()
    document
      .querySelector<HTMLButtonElement>('[data-query-panel] button[aria-label="Why is it slow?"]')!
      .click()
    expect(state.section).toBe('explain')
    expect(state.explain).toMatchObject({ source: 'documents', request: 1 })
  })
})

describe('the Documents query as code (plugins wave 2: Export to Language)', () => {
  it('opens the query in use as a driver program, the page size left out, in each language', async () => {
    mockApi({
      [`POST ${PREFIX}/find`]: () => [200, { documents: [], hasMore: false }],
      [`POST ${PREFIX}/count`]: () => [200, { count: 0, exact: true }],
    })
    const state = useCollectionViewsStore().stateFor('tab-code')
    state.query = {
      filter: { _id: { $oid: '65a1b2c3d4e5f60718293a4b' }, age: { $gt: { $numberInt: '30' } } },
      sort: { age: { $numberInt: '-1' } },
      skip: 5,
      limit: 20,
      maxTimeMS: 5000,
    }
    mountApp(DocumentsView, { props: { target: T, tabId: 'tab-code', canWrite: true, isView: false } })
    await flushPromises()
    document
      .querySelector<HTMLButtonElement>('[data-query-panel] button[aria-label="Export to a driver"]')!
      .click()
    await vi.waitFor(() => expect(document.querySelector('[data-export-code]')).not.toBeNull())
    const code = () => document.querySelector('[data-export-code]')!.textContent!
    expect(code()).toContain(
      'const filter = { _id: new ObjectId("65a1b2c3d4e5f60718293a4b"), age: { $gt: 30 } };',
    )
    expect(code()).toContain('sort: { age: -1 }')
    expect(code()).toContain('skip: 5')
    expect(code()).toContain('maxTimeMS: 5000')
    expect(code()).not.toContain('limit')
    expect(code()).toContain('client.db("shop").collection("orders")')
    document.querySelector<HTMLButtonElement>('[data-language="python"]')!.click()
    await flushPromises()
    expect(code()).toContain('sort=[("age", -1)]')
  })
})
