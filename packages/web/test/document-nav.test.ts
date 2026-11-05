// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { encodeValue, decodeDocument } from '../src/documents/values'
import { rowIdKey, toRows, type DocumentRow, type Row } from '../src/documents/rows'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { loadFull, useDocumentNav } from '../src/documents/page/useDocumentNav'
import { documentDiff } from '@mongo-manager/shared/browser'
import { mockApi } from './support/app'

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// Document page design §6.3: prev and next walk the query's results, over its pages, and keep
// walking when a saved document no longer matches the query.
const LIMIT = 5
const page = (n: number): Row[] =>
  toRows(
    Array.from({ length: LIMIT }, (_, i) => ({
      document: encodeValue({ _id: n * LIMIT + i + 1, status: 'pending' }),
      hash: 'h'.repeat(64),
    })),
    n * LIMIT,
  )
const idOf = (n: number) => JSON.stringify({ $numberInt: String(n) })

function setup(opts: { total?: number; hasMore?: boolean; leave?: boolean } = {}) {
  const state = useCollectionViewsStore().stateFor('t')
  state.query = { ...state.query, limit: LIMIT, skip: 0 }
  const rows = ref<Row[]>(page(0))
  const skip = ref(0)
  const total = ref<number | undefined>(opts.total)
  const hasMore = ref(opts.hasMore ?? false)
  // A page change loads its rows, as the find query does.
  const load = () => {
    skip.value = state.page * LIMIT
    rows.value = page(state.page)
  }
  const open = (id: string) => {
    state.inspector.mode = { kind: 'document', id, tab: 'tree' }
  }
  const nav = useDocumentNav({
    state,
    rows,
    skip,
    total,
    hasMore,
    identify: (row: DocumentRow) => rowIdKey(row),
    openId: computed(() => (state.inspector.mode?.kind === 'document' ? state.inspector.mode.id : null)),
    mayLeave: async () => opts.leave ?? true,
    open,
  })
  open(idOf(3))
  nav.begin()
  return { state, rows, nav, load, total, hasMore }
}

const openId = () => {
  const mode = useCollectionViewsStore().stateFor('t').inspector.mode
  return mode?.kind === 'document' ? mode.id : null
}

describe('walking the results from a document', () => {
  it('says where in the results the document is', () => {
    const { nav } = setup({ total: 12 })
    expect(nav.position.value).toBe(3)
    expect(nav.total.value).toBe(12)
  })

  it('goes on into the next page at the end of one, and back', async () => {
    const { nav, load, state } = setup({ total: 12, hasMore: true })
    await nav.next()
    await nav.next()
    expect(openId()).toBe(idOf(5))
    const going = nav.next()
    await nextTick()
    expect(state.page).toBe(1)
    load()
    await going
    expect(openId()).toBe(idOf(6))
    expect(nav.position.value).toBe(6)
    await nav.prev()
    expect(openId()).toBe(idOf(5))
  })

  it('goes back into the previous page at the start of one', async () => {
    const { nav, load, state } = setup({ total: 12, hasMore: true })
    state.page = 1
    load()
    state.inspector.mode = { kind: 'document', id: idOf(6), tab: 'tree' }
    nav.begin()
    const going = nav.prev()
    await nextTick()
    expect(state.page).toBe(0)
    load()
    await going
    expect(openId()).toBe(idOf(5))
    expect(nav.position.value).toBe(5)
  })

  it('keeps walking when the open document left the results', async () => {
    const { nav, rows } = setup({ total: 12 })
    rows.value = page(0).filter((r) => rowIdKey(r) !== idOf(3))
    expect(nav.stale.value).toBe(true)
    await nav.next()
    expect(openId()).toBe(idOf(4))
  })

  it('stays when the edits are not let go', async () => {
    const { nav } = setup({ total: 12, leave: false })
    await nav.next()
    expect(openId()).toBe(idOf(3))
  })

  it('has no end to say when the count is not known', () => {
    const { nav } = setup()
    expect(nav.total.value).toBeUndefined()
    expect(nav.canNext.value).toBe(true)
    expect(nav.canPrev.value).toBe(true)
  })

  it('cannot go past the last result, or before the first', () => {
    const { nav, state } = setup({ total: 5 })
    state.inspector.mode = { kind: 'document', id: idOf(5), tab: 'tree' }
    expect(nav.canNext.value).toBe(false)
    state.inspector.mode = { kind: 'document', id: idOf(1), tab: 'tree' }
    expect(nav.canPrev.value).toBe(false)
  })
})

// Design §6.4a: a projected row is part of the document; the page edits the whole one.
describe('the whole document behind a projected row', () => {
  it('is loaded, and a replace built from it keeps what the projection left out', async () => {
    const whole = { _id: { $numberInt: '1' }, status: 'pending', secretNote: 'kept' }
    mockApi({
      'POST connections/c1/databases/shop/collections/orders/documents/get': () => [
        200,
        { document: whole, hash: 'b'.repeat(64) },
      ],
    })
    const [projected] = toRows(
      [{ document: { _id: { $numberInt: '1' }, status: 'pending' }, hash: 'a'.repeat(64) }],
      0,
    )
    const full = await loadFull({ connectionId: 'c1', db: 'shop', coll: 'orders' }, projected as DocumentRow)
    expect('error' in full).toBe(false)
    const row = full as DocumentRow
    expect(row.hash).toBe('b'.repeat(64))
    expect(row.value.secretNote).toBe('kept')
    const edited = { ...row.value, status: 'paid' }
    const diff = documentDiff(row.value, edited)
    expect(diff.kind).toBe('update')
    expect(diff.kind === 'update' && diff.unset).toEqual([])
    expect(decodeDocument(whole).secretNote).toBe('kept')
  })

  it('says why when it cannot be loaded', async () => {
    mockApi({})
    const [projected] = toRows([{ document: { _id: { $numberInt: '1' } }, hash: 'a'.repeat(64) }], 0)
    const full = await loadFull({ connectionId: 'c1', db: 'shop', coll: 'orders' }, projected as DocumentRow)
    expect('error' in full).toBe(true)
  })
})
