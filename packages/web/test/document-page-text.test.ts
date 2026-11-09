// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DocumentsView from '../src/documents/DocumentsView.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { typeInto } from './support/dom'

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

// Review 2026-11-07: the search and "edit in text" over the document page's JSON and edit views.
const PREFIX = 'connections/c1/databases/hotel/collections/reservations'
const DOC = {
  _id: { $numberInt: '1' },
  city: 'İİİ İstanbul merkez',
  payments: [
    { method: 'card', receipt: { $binary: { base64: 'AAE=', subType: '00' } } },
    { method: 'transfer', receipt: { $binary: { base64: 'AgM=', subType: '00' } }, note: 'see receipt: x' },
  ],
  status: 'pending',
}

async function open() {
  mockApi({
    [`POST ${PREFIX}/find`]: () => [
      200,
      { documents: [{ document: DOC, hash: '0'.repeat(64) }], hasMore: false },
    ],
    [`POST ${PREFIX}/count`]: () => [200, { count: 1, exact: true }],
  })
  mountApp(DocumentsView, {
    props: {
      target: { connectionId: 'c1', db: 'hotel', coll: 'reservations' },
      tabId: 't',
      canWrite: true,
      isView: false,
      canExport: true,
    },
  })
  mountApp(DialogHost)
  await flushPromises()
  document.querySelector('tbody tr[data-row]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  await vi.waitFor(() => expect(page()).not.toBeNull())
  await flushPromises()
}
const page = () => document.querySelector<HTMLElement>('[data-document-page]')
const tab = async (name: string) => {
  ;[...page()!.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find((t) => t.textContent?.trim() === name)!
    .click()
  await flushPromises()
}
const searchBox = () => page()!.querySelector<HTMLInputElement>('input[type="search"]')!
const counter = () => page()!.querySelector('[data-match-count]')!.textContent!.trim()
const editor = () => page()!.querySelector<HTMLTextAreaElement>('[data-document-content] textarea')!
const selected = () => {
  const el = editor()
  return el.value.slice(el.selectionStart, el.selectionEnd)
}
async function search(text: string) {
  await typeInto(searchBox(), text)
  await new Promise((r) => setTimeout(r, 200))
  await flushPromises()
}
const scope = async (value: 'both' | 'keys' | 'values') => {
  useCollectionViewsStore().stateFor('t').inspector.search.scope = value
  await flushPromises()
}

describe('the search in the JSON and edit views', () => {
  it('looks only in keys, or only in values, as the scope says', async () => {
    await open()
    await tab('JSON')
    await search('receipt')
    expect(counter()).toBe('1 of 3')
    await scope('keys')
    expect(counter()).toBe('1 of 2')
    await scope('values')
    expect(counter()).toBe('1 of 1')
    await tab('Edit')
    expect(counter()).toBe('1 of 1')
    await scope('keys')
    expect(counter()).toBe('1 of 2')
  })

  // Review 2026-11-07: "Edit in text" on payments.1.receipt selected payments.0's, from its quote.
  it('opens a value the tree does not edit in the text, that very value selected', async () => {
    await open()
    await tab('Tree')
    const line = (path: string) =>
      page()!.querySelector<HTMLElement>(`[role="treeitem"][data-path="${path}"]`)!
    const press = async (path: string, key: string) => {
      line(path).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      await flushPromises()
    }
    await press('payments', 'ArrowRight')
    await press('payments.1', 'ArrowRight')
    await press('payments.1.receipt', 'Enter')
    await flushPromises()
    expect(selected()).toBe('BinData(0, "AgM=")')
  })

  it('selects the very word found in the edit view, whatever dotted İ comes before it', async () => {
    await open()
    await tab('Edit')
    await search('merkez')
    expect(selected()).toBe('merkez')
    await search('istanbul')
    expect(selected()).toBe('İstanbul')
  })
})
