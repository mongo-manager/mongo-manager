// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DocumentTable from '../src/documents/DocumentTable.vue'
import DocumentsView from '../src/documents/DocumentsView.vue'
import { toRows } from '../src/documents/rows'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { useToastStore } from '../src/stores/toasts'
import { useSessionStore } from '../src/stores/session'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'

// W1 (completion §2): the table's headers sort, resize and copy the column's name.
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
  { document: { _id: { $numberInt: '1' }, name: 'a', qty: { $numberInt: '5' } }, hash: '1'.repeat(64) },
  { document: { _id: { $numberInt: '2' }, name: 'b', qty: { $numberInt: '7' } }, hash: '2'.repeat(64) },
]
/** A frame later: column widths are written once a frame. */
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))
const head = (column: string) => document.querySelector<HTMLElement>(`th[data-column="${column}"]`)!
const sortButton = (column: string) => head(column).querySelector<HTMLButtonElement>('button[data-sort]')!

function table(props: Record<string, unknown> = {}) {
  return mountApp(DocumentTable, {
    props: {
      rows: toRows(items, 0),
      columns: ['_id', 'name', 'qty'],
      canWrite: false,
      rowHeight: 36,
      target: T,
      inlineEdit: false,
      ...props,
    },
  })
}

// W1 review (minor 9, minor 10): why a column does not sort is said rightly, and the hint is read.
describe('DocumentTable header hints', () => {
  it('say a name that is no field path cannot sort, and give the sort hint to screen readers', () => {
    mountApp(DocumentTable, {
      props: {
        rows: toRows([{ document: { _id: { $numberInt: '1' }, 'a.b': 1 }, hash: '1'.repeat(64) }], 0),
        columns: ['_id', 'a.b'],
        canWrite: false,
        rowHeight: 36,
        target: T,
        inlineEdit: false,
      },
    })
    const dotted = sortButton('a.b')
    expect(dotted.getAttribute('aria-disabled')).toBe('true')
    expect(dotted.title).toBe('This column’s name is not a field path, so it cannot be sorted.')
    const id = sortButton('_id')
    const hint = document.getElementById(id.getAttribute('aria-describedby')!)
    expect(hint?.textContent).toBe('Click to sort; Shift+click adds this column to the sort.')
    expect(document.getElementById(dotted.getAttribute('aria-describedby')!)?.textContent).toBe(
      'This column’s name is not a field path, so it cannot be sorted.',
    )
  })
})

describe('DocumentTable headers', () => {
  it('sort by a click (Shift adds the column) and say the sort with aria-sort', async () => {
    const { wrapper } = table({ sort: { qty: { $numberInt: '-1' }, name: { $numberInt: '1' } } })
    expect(head('qty').getAttribute('aria-sort')).toBe('descending')
    // aria-sort is on one header only; the second sort column says its place in words.
    expect(head('name').getAttribute('aria-sort')).toBeNull()
    expect(head('name').textContent).toContain('sort 2')
    expect(head('_id').getAttribute('aria-sort')).toBeNull()
    sortButton('name').click()
    sortButton('qty').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    expect(wrapper.emitted('sort')).toEqual([
      ['name', false],
      ['qty', true],
    ])
  })

  it('resize a column by keyboard and drag, and use the width it was given', async () => {
    const { wrapper } = table({ widths: { name: 200 } })
    expect(head('name').style.width).toBe('200px')
    expect(document.querySelector<HTMLElement>('td[data-field="name"]')!.style.maxWidth).toBe('200px')
    const handle = head('name').querySelector<HTMLElement>('[role="separator"]')!
    expect(handle.getAttribute('aria-label')).toBe('Width of column name')
    expect(handle.getAttribute('aria-valuenow')).toBe('200')
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(wrapper.emitted('resize')).toEqual([
      ['name', 216],
      ['name', null],
    ])
  })

  it('copy a column’s name from its menu', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { wrapper } = table()
    head('qty').querySelector<HTMLButtonElement>('button[aria-label="Options for column qty"]')!.click()
    await flushPromises()
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (el) => el.textContent?.trim() === 'Copy name',
    )!
    item.click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('qty')
    expect(useToastStore().toasts.at(-1)!.message).toBe('Copied “qty”.')
    // The menu also sorts and hides.
    head('qty').querySelector<HTMLButtonElement>('button[aria-label="Options for column qty"]')!.click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((el) => el.textContent?.trim() === 'Sort descending')!
      .click()
    expect(wrapper.emitted('sort')).toEqual([['qty', false, -1]])
  })
})

describe('DocumentsView sorting', () => {
  it('runs the sort a header asks for and writes it into the query’s sort (the composer shows it)', async () => {
    const { calls } = mockApi({
      [`POST ${PREFIX}/find`]: () => [200, { documents: items, hasMore: false }],
      [`POST ${PREFIX}/count`]: () => [200, { count: 2, exact: true }],
    })
    const state = useCollectionViewsStore().stateFor('tab-s')
    mountApp(DocumentsView, { props: { target: T, tabId: 'tab-s', canWrite: true, isView: false } })
    await flushPromises()
    sortButton('qty').click()
    await flushPromises()
    expect(calls.filter((c) => c.path.endsWith('/find')).at(-1)!.body).toMatchObject({
      sort: { qty: { $numberInt: '1' } },
      skip: 0,
    })
    expect(state.draft.sort).toBe('{ qty: 1 }')
    // Shown by the Options count and the query panel; the Options panel is not opened for it.
    const options = document.querySelector<HTMLButtonElement>('button[title="Options"]')!
    expect(options.getAttribute('aria-expanded')).toBe('false')
    expect(options.dataset.count).toBe('1')
    expect(document.querySelector('[data-query-panel] [data-query-part="sort"]')!.textContent).toContain(
      '{ qty: 1 }',
    )
    expect(head('qty').getAttribute('aria-sort')).toBe('ascending')
    sortButton('qty').click()
    await flushPromises()
    expect(state.draft.sort).toBe('{ qty: -1 }')
    sortButton('qty').click()
    await flushPromises()
    expect(state.draft.sort).toBe('')
    expect(state.query.sort).toBeUndefined()
    expect(calls.filter((c) => c.path.endsWith('/find')).at(-1)!.body).not.toHaveProperty('sort')
  })

  it('never sorts by a column whose values are hidden from the user (phase 3c)', async () => {
    const { calls } = mockApi({
      'GET connections/c1/personal-fields/applied': () => [200, { rules: [], patterns: [['qty']] }],
      [`POST ${PREFIX}/find`]: () => [200, { documents: items, hasMore: false }],
      [`POST ${PREFIX}/count`]: () => [200, { count: 2, exact: true }],
    })
    const state = useCollectionViewsStore().stateFor('tab-m')
    const { wrapper } = mountApp(DocumentsView, {
      props: { target: T, tabId: 'tab-m', canWrite: true, isView: false },
    })
    await flushPromises()
    const button = sortButton('qty')
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.title).toContain('hidden from you')
    button.click()
    await flushPromises()
    expect(state.query.sort).toBeUndefined()
    // Abuse case: a sort asked for anyway (from the menu, or a stale header) is refused here too.
    wrapper.findComponent(DocumentTable).vm.$emit('sort', 'qty', false, 1)
    await flushPromises()
    expect(state.query.sort).toBeUndefined()
    expect(state.draft.sort).toBe('')
    expect(calls.filter((c) => c.path.endsWith('/find'))).toHaveLength(1)
  })

  // W1 review (important 2): the bar shows what runs — a header sort runs the bar's query with it, as a
  // chip or a cell's "Filter by" does; a filter still being written is never run half-done.
  it('runs the bar’s filter with a header’s sort, and refuses one being written', async () => {
    const { calls } = mockApi({
      [`POST ${PREFIX}/find`]: () => [200, { documents: items, hasMore: false }],
      [`POST ${PREFIX}/count`]: () => [200, { count: 2, exact: true }],
    })
    const state = useCollectionViewsStore().stateFor('tab-d')
    mountApp(DocumentsView, { props: { target: T, tabId: 'tab-d', canWrite: true, isView: false } })
    await flushPromises()
    state.draft.filter = '{ name: "a" }'
    sortButton('qty').click()
    await flushPromises()
    expect(calls.filter((c) => c.path.endsWith('/find')).at(-1)!.body).toMatchObject({
      filter: { name: 'a' },
      sort: { qty: { $numberInt: '1' } },
    })
    expect(state.query.filter).toEqual({ name: 'a' })
    const sent = calls.filter((c) => c.path.endsWith('/find')).length
    state.draft.filter = '{ name: '
    sortButton('qty').click()
    await flushPromises()
    expect(calls.filter((c) => c.path.endsWith('/find'))).toHaveLength(sent)
    expect(state.draft.sort).toBe('{ qty: 1 }')
    expect(useToastStore().toasts.at(-1)).toMatchObject({ kind: 'error' })
  })

  // W1 review (important 3, minor 13): widths are kept per collection for the user (in this browser),
  // written once a frame while a column is dragged.
  it('remembers a column’s width per collection, in another tab too, written once a frame', async () => {
    localStorage.clear()
    useSessionStore().me = { user: { id: 'u1' } } as never
    mockApi({
      [`POST ${PREFIX}/find`]: () => [200, { documents: items, hasMore: false }],
      [`POST ${PREFIX}/count`]: () => [200, { count: 2, exact: true }],
    })
    const state = useCollectionViewsStore().stateFor('tab-w')
    const { wrapper } = mountApp(DocumentsView, {
      props: { target: T, tabId: 'tab-w', canWrite: true, isView: false },
    })
    await flushPromises()
    const handle = head('name').querySelector<HTMLElement>('[role="separator"]')!
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    // Nothing written until the frame.
    expect(state.columns.widths ?? {}).toEqual({})
    await frame()
    expect(state.columns.widths).toEqual({ name: 960 })
    expect(JSON.parse(localStorage.getItem('mm:column-widths:u1')!)).toEqual([
      { ns: ['c1', 'shop', 'orders'], widths: { name: 960 } },
    ])
    wrapper.unmount()
    // Another tab of the same collection finds the width.
    const again = useCollectionViewsStore().stateFor('tab-w2')
    mountApp(DocumentsView, { props: { target: T, tabId: 'tab-w2', canWrite: true, isView: false } })
    await flushPromises()
    expect(again.columns.widths).toEqual({ name: 960 })
    expect(head('name').style.width).toBe('960px')
    head('name')
      .querySelector<HTMLElement>('[role="separator"]')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await frame()
    expect(again.columns.widths).toEqual({})
    expect(JSON.parse(localStorage.getItem('mm:column-widths:u1')!)).toEqual([])
  })
})
