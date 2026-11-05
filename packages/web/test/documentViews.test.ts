// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import DocumentJsonList from '../src/documents/DocumentJsonList.vue'
import DocumentTree from '../src/documents/DocumentTree.vue'
import DocumentsView from '../src/documents/DocumentsView.vue'
import { toRows } from '../src/documents/rows'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'

beforeEach(() => {
  // No layout here: render JSON items at once (LazyCodeView waits for an IntersectionObserver otherwise).
  vi.stubGlobal('IntersectionObserver', undefined)
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const ROWS = toRows(
  [
    {
      document: {
        _id: { $oid: '65a1b2c3d4e5f6a7b8c9d0e1' },
        price: { $numberDouble: '5.0' },
        address: { city: 'Ankara', zip: '06000' },
        tags: Array.from({ length: 250 }, (_, i) => `t${i}`),
      },
      hash: 'a'.repeat(64),
    },
  ],
  0,
)

describe('JSON view', () => {
  it('shows each document as shell text with its exact types', () => {
    mountApp(DocumentJsonList, { props: { rows: ROWS, canWrite: true } })
    const text = document.body.textContent!
    expect(text).toContain('ObjectId("65a1b2c3d4e5f6a7b8c9d0e1")')
    expect(text).toContain('"price": Double(5)')
  })
})

describe('tree view', () => {
  it('expands containers on demand and pages long arrays', async () => {
    mountApp(DocumentTree, { props: { rows: ROWS, canWrite: false } })
    expect(document.body.textContent).toContain('2 fields')
    expect(document.body.textContent).not.toContain('Ankara')
    ;(document.querySelector('button[aria-label="Expand address"]') as HTMLButtonElement).click()
    await nextTick()
    expect(document.body.textContent).toContain('Ankara')
    ;(document.querySelector('button[aria-label="Expand tags"]') as HTMLButtonElement).click()
    await nextTick()
    expect(document.body.textContent).toContain('t99')
    expect(document.body.textContent).not.toContain('t100')
    button('Show 100 more').click()
    await nextTick()
    expect(document.body.textContent).toContain('t199')
    expect(document.body.textContent).toContain('Show 50 more')
  })
})

describe('view switching', () => {
  it('switches between table, JSON and tree from the toolbar', async () => {
    mockApi({
      'POST connections/c1/databases/shop/collections/orders/find': () => [
        200,
        { documents: [{ document: { _id: 1, a: { b: 1 } }, hash: 'b'.repeat(64) }], hasMore: false },
      ],
      'POST connections/c1/databases/shop/collections/orders/count': () => [200, { count: 1, exact: true }],
    })
    const state = useCollectionViewsStore().stateFor('t')
    mountApp(DocumentsView, {
      props: {
        target: { connectionId: 'c1', db: 'shop', coll: 'orders' },
        tabId: 't',
        canWrite: false,
        isView: false,
      },
    })
    await flushPromises()
    expect(document.querySelector('table')).not.toBeNull()
    const view = (name: string) =>
      document.querySelector<HTMLButtonElement>(`[role="radio"][aria-label="${name}"]`)!.click()
    view('JSON')
    await flushPromises()
    expect(state.mode).toBe('json')
    expect(document.querySelector('table')).toBeNull()
    expect(document.body.textContent).toContain('"a": {')
    view('Cards')
    await flushPromises()
    expect(document.querySelector('button[aria-label="Expand a"]')).not.toBeNull()
  })
})
