// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref } from 'vue'
import { useDocuments } from '../src/documents/useDocuments'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { rulesChanged } from '../src/masking/rulesEpoch'
import { mockApi, mountApp } from './support/app'

/**
 * 2026-10-26 (a known minor of the personal-data scrub): a view on its way to its next page keeps
 * the page it had as a placeholder — held by its watcher, not the cache, so no refresh reached it.
 * The rules changed meanwhile (offline, until the network is back), it showed values read before
 * them. A page read before the rules changed is no longer kept for the next.
 */
beforeEach(() => setActivePinia(createPinia()))
afterEach(() => {
  document.body.innerHTML = ''
})

const doc = (n: number) => ({
  document: { _id: { $numberInt: String(n) }, email: `p${n}@example.com` },
  hash: 'h'.repeat(64),
})

describe('a page kept while the next one comes', () => {
  async function mounted() {
    let second: (v: [number, unknown]) => void = () => {}
    mockApi({
      'POST connections/c1/databases/shop/collections/people/find': (body) =>
        (body as { skip: number }).skip === 0
          ? [200, { documents: [doc(1)], hasMore: true }]
          : new Promise((resolve) => (second = resolve)),
      'POST connections/c1/databases/shop/collections/people/count': () => [200, { count: 2, exact: true }],
    })
    const state = useCollectionViewsStore().stateFor('c1/shop/people')
    state.query.limit = 1
    let rows: () => number = () => 0
    const View = defineComponent({
      setup() {
        const docs = useDocuments(ref({ connectionId: 'c1', db: 'shop', coll: 'people' }), state)
        rows = () => docs.rows.value.length
        return () =>
          h('div', { 'data-rows': docs.rows.value.length }, JSON.stringify(docs.find.data.value ?? null))
      },
    })
    mountApp(View)
    await flushPromises()
    return { state, rows: () => rows(), answer: (v: [number, unknown]) => second(v) }
  }

  it('is kept until it comes, as before', async () => {
    const view = await mounted()
    expect(view.rows()).toBe(1)
    view.state.page = 1
    await flushPromises()
    expect(document.body.textContent).toContain('p1@example.com')
  })

  it('is let go when the rules change before the next page comes', async () => {
    const view = await mounted()
    view.state.page = 1
    await flushPromises()
    rulesChanged()
    await flushPromises()
    expect(document.body.textContent).not.toContain('p1@example.com')
    view.answer([200, { documents: [doc(2)], hasMore: false }])
    await flushPromises()
    expect(document.body.textContent).toContain('p2@example.com')
  })
})
