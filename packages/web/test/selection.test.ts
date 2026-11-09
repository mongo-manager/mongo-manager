// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DocumentsView from '../src/documents/DocumentsView.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { useToastStore } from '../src/stores/toasts'
import { i18n } from '../src/i18n'
import { mockApi, mountApp, type Handler } from './support/app'
import { button } from './support/dom'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const PREFIX = 'connections/c1/databases/shop/collections/orders'
const DOCS = [
  { _id: { $numberInt: '1' }, status: 'paid', total: { $numberDouble: '5.5' } },
  { _id: { $numberInt: '2' }, status: 'new', total: { $numberDouble: '7.5' } },
  { _id: { $numberInt: '3' }, status: 'paid', total: { $numberDouble: '9.5' } },
]
async function view(handlers: Record<string, Handler> = {}, mode: 'table' | 'cards' | 'json' = 'table') {
  const api = mockApi({
    [`POST ${PREFIX}/find`]: () => [
      200,
      { documents: DOCS.map((d, i) => ({ document: d, hash: String(i).repeat(64) })), hasMore: false },
    ],
    [`POST ${PREFIX}/count`]: () => [200, { count: 3, exact: true }],
    ...handlers,
  })
  useCollectionViewsStore().stateFor('t').mode = mode
  mountApp(DocumentsView, {
    props: {
      target: { connectionId: 'c1', db: 'shop', coll: 'orders' },
      tabId: 't',
      canWrite: true,
      isView: false,
      canExport: true,
    },
  })
  mountApp(DialogHost)
  await flushPromises()
  return api
}
const check = (label: string) => {
  const box = document.querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label="${label}"]`)!
  box.click()
}
const bar = () => document.querySelector<HTMLElement>('[data-selection-bar]')

describe('selecting documents (UI redesign R1 checkpoint 3)', () => {
  it('selects rows and says how many, in every view', async () => {
    await view()
    expect(bar()).toBeNull()
    check('Select document 1')
    check('Select document 3')
    await flushPromises()
    expect(bar()!.textContent).toContain('2 selected')
    button('Clear selection').click()
    await flushPromises()
    expect(bar()).toBeNull()
    check('Select all on this page')
    await flushPromises()
    expect(bar()!.textContent).toContain('3 selected')
  })

  it('offers selection in the Cards and JSON views too', async () => {
    await view({}, 'cards')
    check('Select document 2')
    await flushPromises()
    expect(bar()!.textContent).toContain('1 selected')
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    await view({}, 'json')
    check('Select document 2')
    await flushPromises()
    expect(bar()!.textContent).toContain('1 selected')
  })

  it('copies the selected documents as shell JSON', async () => {
    const write = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: write } })
    await view()
    check('Select document 2')
    await flushPromises()
    button('Copy').click()
    await flushPromises()
    expect(write).toHaveBeenCalledWith(expect.stringContaining('status: "new"'))
    expect(String((write.mock.calls[0] as unknown[])[0])).not.toContain('"paid"')
  })

  it('deletes exactly the selected documents, after asking', async () => {
    const { calls } = await view({
      [`POST ${PREFIX}/bulk/preview`]: () => [
        200,
        { matched: 2, total: 3, requiresConfirmation: false, filterHash: 'h1' },
      ],
      [`POST ${PREFIX}/bulk/execute`]: () => [200, { deleted: 2 }],
    })
    check('Select document 1')
    check('Select document 3')
    await flushPromises()
    button('Delete…').click()
    await flushPromises()
    expect(document.body.textContent).toContain('Delete 2 documents?')
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    const preview = calls.find((c) => c.path.endsWith('/bulk/preview'))!.body
    expect(preview).toEqual({
      operation: 'delete',
      filter: { _id: { $in: [{ $numberInt: '1' }, { $numberInt: '3' }] } },
    })
    expect(calls.some((c) => c.path.endsWith('/bulk/execute'))).toBe(true)
    expect(bar()).toBeNull()
  })

  it('forgets the selection when the page or the query changes', async () => {
    await view()
    check('Select document 1')
    await flushPromises()
    useCollectionViewsStore().stateFor('t').query = { filter: { status: 'paid' }, skip: 0, limit: 20 }
    await flushPromises()
    expect(bar()).toBeNull()
  })
})

describe('deleting the selection, final review', () => {
  it('names the documents still there, when some went meanwhile (reviewer B Minor 13)', async () => {
    const { calls } = await view({
      [`POST ${PREFIX}/bulk/preview`]: () => [
        200,
        { matched: 1, total: 3, requiresConfirmation: false, filterHash: 'h1' },
      ],
      [`POST ${PREFIX}/bulk/execute`]: () => [200, { deleted: 1 }],
    })
    check('Select document 1')
    check('Select document 3')
    await flushPromises()
    button('Delete…').click()
    await flushPromises()
    expect(document.body.textContent).toContain('Delete 1 document?')
    expect(document.body.textContent).toContain('1 of the 2 selected documents is still there')
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/bulk/execute'))!.body).toMatchObject({ filterHash: 'h1' })
  })

  it('asks for the collection name when the selection is every document (reviewer B Minor 14)', async () => {
    const { calls } = await view({
      [`POST ${PREFIX}/bulk/preview`]: () => [
        200,
        { matched: 3, total: 3, requiresConfirmation: true, filterHash: 'h2' },
      ],
      [`POST ${PREFIX}/bulk/execute`]: () => [200, { deleted: 3 }],
    })
    check('Select all on this page')
    await flushPromises()
    button('Delete…').click()
    await flushPromises()
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    const input = document.querySelector<HTMLInputElement>('[data-test="require-text"] input')!
    expect(input).not.toBeNull()
    input.value = 'orders'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/bulk/execute'))!.body).toMatchObject({
      filterHash: 'h2',
      confirm: 'orders',
    })
  })

  it('deletes nothing when none of the selection is there any more', async () => {
    const { calls } = await view({
      [`POST ${PREFIX}/bulk/preview`]: () => [
        200,
        { matched: 0, total: 1, requiresConfirmation: false, filterHash: 'h3' },
      ],
    })
    check('Select document 1')
    await flushPromises()
    button('Delete…').click()
    await flushPromises()
    expect(document.querySelector('[data-test="confirm"]')).toBeNull()
    expect(calls.some((c) => c.path.endsWith('/bulk/execute'))).toBe(false)
    expect(useToastStore().toasts.at(-1)?.message).toContain('None of the selected documents is there')
  })
})

describe('the table (UI redesign R1 checkpoint 3)', () => {
  it('names each column’s kind of value in its header', async () => {
    await view()
    const header = (name: string) =>
      [...document.querySelectorAll<HTMLElement>('thead th')].find((th) => th.textContent?.includes(name))!
    expect(header('status').textContent).toContain('string')
    expect(header('total').textContent).toContain('double')
  })

  it('filters by a value from its cell, and runs the filter', async () => {
    await view()
    const state = useCollectionViewsStore().stateFor('t')
    ;[...document.querySelectorAll<HTMLButtonElement>('tr[data-row] td[data-field="status"] button')]
      .find((b) => b.getAttribute('aria-label') === 'Filter by status = "paid"')!
      .click()
    await flushPromises()
    expect(state.draft.filter).toBe('{ status: "paid" }')
    expect(state.query.filter).toEqual({ status: 'paid' })
  })

  it('adds to the filter there is, and leaves a filter being written alone (reviewer B Minor 5)', async () => {
    await view()
    const state = useCollectionViewsStore().stateFor('t')
    const filterBy = () =>
      [...document.querySelectorAll<HTMLButtonElement>('tr[data-row] td[data-field="status"] button')]
        .find((b) => b.getAttribute('aria-label') === 'Filter by status = "paid"')!
        .click()
    state.draft.filter = '{ total: { $gt: 5 } }'
    filterBy()
    await flushPromises()
    expect(state.query.filter).toEqual({ total: { $gt: { $numberInt: '5' } }, status: 'paid' })
    state.draft.filter = '{ status: "paid", total: { $gt: '
    const before = state.query
    filterBy()
    await flushPromises()
    expect(state.draft.filter).toBe('{ status: "paid", total: { $gt: ')
    expect(state.query).toBe(before)
    expect(useToastStore().toasts.at(-1)).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('has an error'),
    })
  })
})

describe('filtering by a hidden value (abuse case)', () => {
  it('offers no filter on a value the server hides', async () => {
    mockApi({
      'GET connections/c1/personal-fields/applied': () => [200, { rules: [], patterns: [['email']] }],
      [`POST ${PREFIX}/find`]: () => [
        200,
        {
          documents: [
            { document: { _id: { $numberInt: '1' }, email: '***', name: 'Ali' }, hash: 'a'.repeat(64) },
          ],
          hasMore: false,
        },
      ],
      [`POST ${PREFIX}/count`]: () => [200, { count: 1, exact: true }],
    })
    useCollectionViewsStore().stateFor('t').mode = 'table'
    mountApp(DocumentsView, {
      props: {
        target: { connectionId: 'c1', db: 'shop', coll: 'orders' },
        tabId: 't',
        canWrite: false,
        isView: false,
      },
    })
    await flushPromises()
    expect(document.querySelector('td[data-field="email"] button')).toBeNull()
    expect(document.querySelector('td[data-field="name"] button')).not.toBeNull()
  })
})

describe('documents without an _id (reviewer B I3)', () => {
  const NO_ID = [
    { status: 'paid', total: { $numberDouble: '5.5' } },
    { status: 'new', total: { $numberDouble: '7.5' } },
  ]
  async function noIds(mode: 'table' | 'cards' = 'table') {
    const api = mockApi({
      [`POST ${PREFIX}/find`]: () => [
        200,
        { documents: NO_ID.map((d, i) => ({ document: d, hash: String(i).repeat(64) })), hasMore: false },
      ],
      [`POST ${PREFIX}/count`]: () => [200, { count: 2, exact: true }],
    })
    useCollectionViewsStore().stateFor('t').mode = mode
    mountApp(DocumentsView, {
      props: {
        target: { connectionId: 'c1', db: 'shop', coll: 'orders' },
        tabId: 't',
        canWrite: true,
        isView: false,
        canExport: true,
      },
    })
    mountApp(DialogHost)
    await flushPromises()
    return api
  }

  it('cannot be selected, and says why', async () => {
    await noIds()
    const boxes = [...document.querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]')]
    expect(boxes).toHaveLength(2)
    for (const box of boxes) {
      expect(box.disabled).toBe(true)
      expect(box.title).toContain('_id')
    }
    check('Select all on this page')
    await flushPromises()
    expect(bar()).toBeNull()
  })

  it('opens the document clicked, not the first one, and offers no edit or delete', async () => {
    await noIds('cards')
    // Without an _id to open it by, the card's menu opens it (user report 2026-11-05: no Open button).
    expect(document.querySelector('button[aria-label="Open document #2"]')).toBeNull()
    document.querySelector<HTMLButtonElement>('button[aria-label="Actions for document #2"]')!.click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.trim() === 'Open')!
      .click()
    await vi.waitFor(() => expect(document.querySelector('[data-document-page]')).not.toBeNull())
    expect(document.querySelector('[data-document-page]')!.textContent).toContain('new')
    expect(document.querySelector('[data-document-page]')!.textContent).not.toContain('paid')
    expect(
      [...document.querySelectorAll('[data-document-page] [role="tab"]')].map((t) => t.textContent?.trim()),
    ).not.toContain('Edit')
    button('Back to results').click()
    await vi.waitFor(() =>
      expect(document.querySelector('button[aria-label="Actions for document #1"]')).not.toBeNull(),
    )
    document.querySelector<HTMLButtonElement>('button[aria-label="Actions for document #1"]')!.click()
    await flushPromises()
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent?.trim())
    expect(items).toEqual(expect.arrayContaining(['Copy', 'Clone']))
    expect(items).not.toContain('Edit')
    expect(items).not.toContain('Delete')
  })
})

describe('the selection is announced (reviewer B Minor 11)', () => {
  it('says the first count through a region already in the page', async () => {
    await view()
    const status = document.querySelector('[data-selection-status]')!
    expect(status.getAttribute('role')).toBe('status')
    expect(status.textContent?.trim()).toBe('')
    check('Select document 1')
    await flushPromises()
    expect(document.querySelector('[data-selection-status]')).toBe(status)
    expect(status.textContent).toContain('1 selected')
    expect(bar()!.querySelector('[aria-live]')).toBeNull()
  })
})
