// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DocumentsView from '../src/documents/DocumentsView.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { i18n } from '../src/i18n'
import { mockApi, mountApp, type Handler } from './support/app'
import { button, byLabel, typeInto } from './support/dom'

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

// Document page design (user request 2026-11-04): an invented reservation, nested as real ones are.
const PREFIX = 'connections/c1/databases/hotel/collections/reservations'
const reservation = (id: number, method: string) => ({
  _id: { $numberInt: String(id) },
  guest: { name: `Guest ${id}`, contact: { email: `guest${id}@example.test` } },
  rooms: [{ number: '101', nights: [{ date: '2026-07-01', rate: { $numberInt: '120' } }] }],
  payments: [
    { method: 'card', amount: { $numberInt: '120' } },
    { method, amount: { $numberInt: '80' }, refunds: [{ amount: { $numberInt: '10' } }] },
  ],
  status: 'pending',
})
const DOCS = [reservation(1, 'transfer'), reservation(2, 'cash'), reservation(3, 'transfer')]

async function view(
  opts: { handlers?: Record<string, Handler>; projection?: boolean; docs?: typeof DOCS } = {},
) {
  const api = mockApi({
    [`POST ${PREFIX}/find`]: () => [
      200,
      {
        documents: (opts.docs ?? DOCS).map((d, i) => ({
          document: opts.projection ? { _id: d._id, status: d.status } : d,
          hash: String(i).repeat(64),
        })),
        hasMore: false,
      },
    ],
    [`POST ${PREFIX}/count`]: () => [200, { count: 3, exact: true }],
    ...opts.handlers,
  })
  const state = useCollectionViewsStore().stateFor('t')
  if (opts.projection) state.query = { ...state.query, projection: { status: 1 } }
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
  return api
}
const page = () => document.querySelector<HTMLElement>('[data-document-page]')
const opened = () => vi.waitFor(() => expect(page()).not.toBeNull())
const rowOf = (id: number) =>
  [...document.querySelectorAll<HTMLElement>('tbody tr[data-row]')].find(
    (r) => r.querySelector('td[data-field="_id"]')?.textContent?.trim() === String(id),
  )!
/** Opens a row's document (a double click opens it to edit), then shows its tree. */
async function openRow(id: number) {
  rowOf(id).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  await opened()
  await flushPromises()
  tab('Tree').click()
  await flushPromises()
}
const tab = (name: string) =>
  [...page()!.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (t) => t.textContent?.trim() === name,
  )!
const searchBox = () => page()!.querySelector<HTMLInputElement>('input[type="search"]')!
const counter = () => page()!.querySelector('[data-match-count]')!.textContent!.trim()
const keydown = (el: EventTarget, key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  el.dispatchEvent(event)
  return event
}
async function search(text: string) {
  await typeInto(searchBox(), text)
  await new Promise((r) => setTimeout(r, 200))
  await flushPromises()
}

describe('the document page', () => {
  it('opens in the results’ place, never beside or over them', async () => {
    await view()
    await openRow(1)
    expect(document.querySelector('[role="complementary"]')).toBeNull()
    expect(document.querySelector('tbody tr[data-row]')).toBeNull()
    expect(document.querySelector('[data-document-page]')!.closest('[class*="fixed"]')).toBeNull()
    expect(
      [...page()!.querySelectorAll('*')].some((el) => el.className.toString().split(/\s+/).includes('fixed')),
    ).toBe(false)
  })

  it('searches the document, in its keys and values, and counts the matches', async () => {
    await view()
    await openRow(1)
    await search('transfer')
    expect(counter()).toBe('1 of 1')
    const match = page()!.querySelector(
      '[role="treeitem"][data-path="payments.1.method"] mark[data-search-mark]',
    )
    expect(match!.textContent).toBe('transfer')
    expect(page()!.querySelector('[role="treeitem"][data-path="guest"]')!.hasAttribute('data-dimmed')).toBe(
      true,
    )
    await search('amount')
    expect(counter()).toBe('1 of 3')
    keydown(searchBox(), 'Enter')
    await flushPromises()
    expect(counter()).toBe('2 of 3')
    keydown(searchBox(), 'Enter', { shiftKey: true })
    await flushPromises()
    expect(counter()).toBe('1 of 3')
  })

  it('keeps the search and the view on the next document', async () => {
    await view()
    await openRow(1)
    tab('JSON').click()
    await flushPromises()
    await search('cash')
    expect(counter()).toBe('No matches')
    keydown(page()!.querySelector('h2')!, 'ArrowDown', { altKey: true })
    await flushPromises()
    await new Promise((r) => setTimeout(r, 200))
    await flushPromises()
    expect(page()!.querySelector('h2')!.textContent).toContain('2')
    expect(searchBox().value).toBe('cash')
    expect(tab('JSON').getAttribute('aria-selected')).toBe('true')
    expect(counter()).toBe('1 of 1')
  })

  it('takes Ctrl+F to its own search inside the page, and leaves it to the browser elsewhere', async () => {
    await view()
    await openRow(1)
    const inside = keydown(page()!.querySelector('h2')!, 'f', { ctrlKey: true })
    expect(inside.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(searchBox())
    const elsewhere = document.createElement('button')
    document.body.appendChild(elsewhere)
    elsewhere.focus()
    const outside = keydown(elsewhere, 'f', { ctrlKey: true })
    expect(outside.defaultPrevented).toBe(false)
  })

  it('edits in the tree and in the text as one draft, with one undo', async () => {
    await view()
    await openRow(1)
    const item = () => page()!.querySelector<HTMLElement>('[role="treeitem"][data-path="status"]')!
    keydown(item(), 'Enter')
    await flushPromises()
    const input = page()!.querySelector<HTMLInputElement>('[data-tree-editor] input')!
    input.value = 'paid'
    input.dispatchEvent(new Event('input'))
    keydown(input, 'Enter')
    await flushPromises()
    expect(page()!.querySelector('[data-change-count]')!.textContent).toContain('1 unsaved change')
    tab('Edit').click()
    await flushPromises()
    expect(byLabel<HTMLTextAreaElement>('Document').value).toContain('"status": "paid"')
    keydown(byLabel<HTMLTextAreaElement>('Document'), 'z', { ctrlKey: true })
    await flushPromises()
    expect(byLabel<HTMLTextAreaElement>('Document').value).toContain('"status": "pending"')
    keydown(byLabel<HTMLTextAreaElement>('Document'), 'z', { ctrlKey: true, shiftKey: true })
    await flushPromises()
    expect(byLabel<HTMLTextAreaElement>('Document').value).toContain('"status": "paid"')
  })

  it('keeps the tree away from a text that does not parse', async () => {
    await view()
    await openRow(1)
    tab('Edit').click()
    await flushPromises()
    await typeInto(byLabel<HTMLTextAreaElement>('Document'), '{ _id: 1, status: ')
    await new Promise((r) => setTimeout(r, 200))
    await flushPromises()
    tab('Tree').click()
    await flushPromises()
    expect(tab('Edit').getAttribute('aria-selected')).toBe('true')
    expect(page()!.querySelector('[data-parse-blocks]')).not.toBeNull()
  })

  it('saves the tree’s edit through the review, with the version opened', async () => {
    const { calls } = await view({
      handlers: { [`POST ${PREFIX}/documents/update`]: () => [200, { modified: 1 }] },
    })
    await openRow(1)
    const item = page()!.querySelector<HTMLElement>('[role="treeitem"][data-path="status"]')!
    keydown(item, 'Enter')
    await flushPromises()
    const input = page()!.querySelector<HTMLInputElement>('[data-tree-editor] input')!
    input.value = 'paid'
    input.dispatchEvent(new Event('input'))
    keydown(input, 'Enter')
    await flushPromises()
    button('Review and save').click()
    await flushPromises()
    button('Save changes').click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/documents/update'))!.body).toMatchObject({
      set: { status: 'paid' },
      unset: [],
      hash: '0'.repeat(64),
    })
  })

  // E2e 2026-11-04: the results come back with the saved version (a new hash) while the save still
  // ends; the page started on it must not take the saved text for unsaved edits.
  it('has no unsaved edits after a save, once the results show the saved version', async () => {
    let saved = false
    mockApi({
      [`POST ${PREFIX}/find`]: () => [
        200,
        {
          documents: DOCS.map((d, i) => ({
            document: saved && i === 0 ? { ...d, status: 'paid' } : d,
            hash: (saved && i === 0 ? 'n' : String(i)).repeat(64),
          })),
          hasMore: false,
        },
      ],
      [`POST ${PREFIX}/count`]: () => [200, { count: 3, exact: true }],
      [`POST ${PREFIX}/documents/update`]: () => {
        saved = true
        return [200, { modified: 1 }]
      },
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
    await openRow(1)
    const item = page()!.querySelector<HTMLElement>('[role="treeitem"][data-path="status"]')!
    keydown(item, 'Enter')
    await flushPromises()
    const input = page()!.querySelector<HTMLInputElement>('[data-tree-editor] input')!
    input.value = 'paid'
    input.dispatchEvent(new Event('input'))
    keydown(input, 'Enter')
    await flushPromises()
    button('Review and save').click()
    await flushPromises()
    button('Save changes').click()
    await flushPromises()
    await flushPromises()
    expect(useCollectionViewsStore().hasUnsaved('t')).toBe(false)
    expect(page()!.querySelector('[data-document-footer]')).toBeNull()
    keydown(page()!.querySelector('h2')!, 'ArrowDown', { altKey: true })
    await flushPromises()
    expect(document.body.textContent).not.toContain('The document has unsaved changes.')
    expect(page()!.querySelector('h2')!.textContent).toContain('2')
  })

  it('comes back to the results where they were, the document last open marked', async () => {
    await view()
    await openRow(1)
    keydown(page()!.querySelector('h2')!, 'ArrowDown', { altKey: true })
    await flushPromises()
    button('Back to results').click()
    await flushPromises()
    await vi.waitFor(() => expect(rowOf(2)?.hasAttribute('data-last-opened')).toBe(true))
    expect(rowOf(1).hasAttribute('data-last-opened')).toBe(false)
  })

  // Design §6.4a: a projected row is part of its document; the page edits the whole one.
  it('shows and edits the whole document behind a projected row, and says so', async () => {
    await view({
      projection: true,
      handlers: {
        [`POST ${PREFIX}/documents/get`]: () => [200, { document: DOCS[0], hash: 'f'.repeat(64) }],
      },
    })
    await openRow(1)
    await vi.waitFor(() =>
      expect(page()!.querySelector('[data-projection-note]')!.textContent).toContain('whole document'),
    )
    expect(page()!.querySelector('[role="treeitem"][data-path="payments"]')).not.toBeNull()
    expect(tab('Edit')).toBeTruthy()
  })
})

describe('the document page after the final review', () => {
  const wait = () => new Promise((r) => setTimeout(r, 200))
  const editor = () => byLabel<HTMLTextAreaElement>('Document')
  const statusText = () => page()!.querySelector('[role="treeitem"][data-path="status"]')!.textContent ?? ''

  // I1 (a): an undo right after typing is not undone again by the parse of the typed text.
  it('keeps an undo made right after typing', async () => {
    await view()
    await openRow(1)
    tab('Edit').click()
    await flushPromises()
    await typeInto(editor(), editor().value.replace('"pending"', '"typed"'))
    await flushPromises()
    keydown(editor(), 'z', { ctrlKey: true })
    await flushPromises()
    await wait()
    tab('Tree').click()
    await flushPromises()
    expect(statusText()).toContain('pending')
    expect(statusText()).not.toContain('typed')
  })

  // I1 (c): a text that does not parse blocks the tree at once, not 150 ms later.
  it('keeps the tree away from a text just made unparseable', async () => {
    await view()
    await openRow(1)
    tab('Edit').click()
    await flushPromises()
    await typeInto(editor(), '{ _id: 1, status: ')
    tab('Tree').click()
    await flushPromises()
    expect(tab('Edit').getAttribute('aria-selected')).toBe('true')
  })

  // I1 (b): a tree edit that changes nothing leaves the next typing parsed as usual.
  it('parses typing after a tree edit that changed nothing', async () => {
    await view()
    await openRow(1)
    const item = page()!.querySelector<HTMLElement>('[role="treeitem"][data-path="status"]')!
    keydown(item, 'Enter')
    await flushPromises()
    keydown(page()!.querySelector<HTMLInputElement>('[data-tree-editor] input')!, 'Enter')
    await flushPromises()
    tab('Edit').click()
    await flushPromises()
    const text = editor().value
    await typeInto(editor(), text + 'x')
    await wait()
    await typeInto(editor(), text)
    await wait()
    tab('Tree').click()
    await flushPromises()
    expect(tab('Tree').getAttribute('aria-selected')).toBe('true')
  })

  // I8: the JSON view scrolls to the match the search is at.
  it('scrolls the JSON to the current match', async () => {
    const scrolled: Element[] = []
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this)
    }
    try {
      await view()
      await openRow(1)
      tab('JSON').click()
      await flushPromises()
      await search('amount')
      keydown(searchBox(), 'Enter')
      await flushPromises()
      await flushPromises()
      const current = page()!.querySelector('[data-search-mark][data-current]')
      expect(current).not.toBeNull()
      expect(scrolled).toContain(current)
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })

  // Minor: no undo under the review — the text would change under the diff being confirmed.
  it('takes no undo while the review is shown', async () => {
    await view()
    await openRow(1)
    tab('Edit').click()
    await flushPromises()
    await typeInto(editor(), editor().value.replace('"pending"', '"held"'))
    await wait()
    button('Review and save').click()
    await flushPromises()
    keydown(page()!.querySelector('[data-test="diff"]')!, 'z', { ctrlKey: true })
    await flushPromises()
    expect(page()!.querySelector('[data-test="diff"]')!.textContent).toContain('held')
  })

  // Minor: with the focus nowhere after a click elsewhere, Ctrl+F is the browser's.
  it('leaves Ctrl+F to the browser after a click outside the page', async () => {
    await view()
    await openRow(1)
    const outside = document.createElement('p')
    document.body.appendChild(outside)
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    ;(document.activeElement as HTMLElement | null)?.blur()
    const event = keydown(document.body, 'f', { ctrlKey: true })
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('a projected row’s whole document after the final review', () => {
  // I4: the second save goes with the version the first one wrote, not a false conflict.
  it('saves a second time against the version the first save wrote', async () => {
    let gets = 0
    const { calls } = await view({
      projection: true,
      handlers: {
        [`POST ${PREFIX}/documents/get`]: () => {
          gets++
          return [
            200,
            {
              document: { ...DOCS[0], status: gets > 1 ? 'paid' : 'pending' },
              hash: String(gets).repeat(64),
            },
          ]
        },
        [`POST ${PREFIX}/documents/update`]: () => [200, { modified: 1 }],
      },
    })
    await openRow(1)
    await vi.waitFor(() =>
      expect(page()!.querySelector('[data-projection-note]')!.textContent).toContain('whole'),
    )
    const edit = async (value: string, field: string) => {
      const item = page()!.querySelector<HTMLElement>(`[role="treeitem"][data-path="${field}"]`)!
      keydown(item, 'Enter')
      await flushPromises()
      const input = page()!.querySelector<HTMLInputElement>('[data-tree-editor] input')!
      input.value = value
      input.dispatchEvent(new Event('input'))
      keydown(input, 'Enter')
      await flushPromises()
      button('Review and save').click()
      await flushPromises()
      button('Save changes').click()
      await flushPromises()
      await flushPromises()
    }
    await edit('paid', 'status')
    await vi.waitFor(() => expect(gets).toBe(2))
    await vi.waitFor(() =>
      expect(page()!.querySelector('[role="treeitem"][data-path="status"]')!.textContent).toContain('paid'),
    )
    await edit('held', 'status')
    const updates = calls.filter((c) => c.path.endsWith('/documents/update'))
    expect(updates).toHaveLength(2)
    expect((updates[0]!.body as { hash: string }).hash).toBe('1'.repeat(64))
    expect((updates[1]!.body as { hash: string }).hash).toBe('2'.repeat(64))
    expect((updates[1]!.body as { set: Record<string, unknown> }).set).toEqual({ status: 'held' })
  })

  // I5: Copy as JSON from the page copies the whole document shown, not the projected part.
  it('copies the whole document, not the projected part', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    await view({
      projection: true,
      handlers: {
        [`POST ${PREFIX}/documents/get`]: () => [200, { document: DOCS[0], hash: 'f'.repeat(64) }],
      },
    })
    await openRow(1)
    await vi.waitFor(() =>
      expect(page()!.querySelector('[data-projection-note]')!.textContent).toContain('whole'),
    )
    page()!.querySelector<HTMLButtonElement>('button[aria-label="More actions for this document"]')!.click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.trim() === 'Copy as JSON')!
      .click()
    await flushPromises()
    expect(writeText).toHaveBeenCalled()
    expect(writeText.mock.calls[0]![0]).toContain('payments')
  })
})

// User report 2026-11-05: the text of the document is put back in shape with one button or
// Alt+Shift+F; a text that does not parse stays as it is.
describe('formatting the text', () => {
  const area = () => byLabel<HTMLTextAreaElement>('Document')
  const formatButton = () =>
    [...page()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Format')

  it('writes the text again in shape, as one step of the undo', async () => {
    await view()
    await openRow(1)
    tab('Edit').click()
    await flushPromises()
    expect(formatButton()!.getAttribute('aria-keyshortcuts')).toBe('Alt+Shift+F')
    const shaped = area().value
    await typeInto(area(), shaped.replace(/\n\s*/g, ' '))
    await new Promise((r) => setTimeout(r, 200))
    await flushPromises()
    expect(area().value).not.toContain('\n')
    formatButton()!.click()
    await flushPromises()
    expect(area().value).toBe(shaped)
    keydown(area(), 'z', { ctrlKey: true })
    await flushPromises()
    expect(area().value).not.toContain('\n')
  })

  it('formats with Alt+Shift+F, and leaves a text that does not parse', async () => {
    await view()
    await openRow(1)
    tab('Edit').click()
    await flushPromises()
    const shaped = area().value
    await typeInto(area(), shaped.replace(/\n\s*/g, ' '))
    await new Promise((r) => setTimeout(r, 200))
    await flushPromises()
    keydown(area(), 'F', { altKey: true, shiftKey: true, code: 'KeyF' })
    await flushPromises()
    expect(area().value).toBe(shaped)
    await typeInto(area(), '{ _id: 1, status: ')
    await new Promise((r) => setTimeout(r, 200))
    await flushPromises()
    expect(formatButton()!.disabled).toBe(true)
    keydown(area(), 'F', { altKey: true, shiftKey: true, code: 'KeyF' })
    await flushPromises()
    expect(area().value).toBe('{ _id: 1, status: ')
  })
})

// User report 2026-11-05: an image as base64 filled the edit view with thousands of lines. A long
// string is a short stand-in in the text, and saved as it was.
describe('a long value in the edit view', () => {
  const photo = `data:image/png;base64,${'iVBORw0KGgo'.repeat(2000)}`
  const withPhoto = () => DOCS.map((d) => ({ ...d, photo }))
  const area = () => byLabel<HTMLTextAreaElement>('Document')
  async function edit(handlers: Record<string, Handler> = {}) {
    const api = await view({ docs: withPhoto(), handlers })
    await openRow(1)
    tab('Edit').click()
    await flushPromises()
    return api
  }

  it('shows the keys quoted and a long string as its size, never the string', async () => {
    await edit()
    expect(area().value).toContain('"status": "pending"')
    expect(area().value).toMatch(/"photo": "⟨22 KB · [0-9a-f]{16}⟩"/)
    expect(area().value).not.toContain('iVBORw0KGgo')
    expect(page()!.querySelector('[data-long-note]')!.textContent).toContain('10,000')
  })

  it('saves an edit beside it without the long value', async () => {
    const { calls } = await edit({
      [`POST ${PREFIX}/documents/update`]: () => [200, { modified: 1 }],
      [`POST ${PREFIX}/documents/replace`]: () => [200, { modified: 1 }],
    })
    await typeInto(area(), area().value.replace('"pending"', '"paid"'))
    await new Promise((r) => setTimeout(r, 200))
    await flushPromises()
    button('Review and save').click()
    await flushPromises()
    button('Save changes').click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/documents/update'))!.body).toMatchObject({
      set: { status: 'paid' },
      unset: [],
    })
  })

  it('replaces the document with the long value whole', async () => {
    const { calls } = await edit({ [`POST ${PREFIX}/documents/replace`]: () => [200, { modified: 1 }] })
    await typeInto(area(), area().value.replace('"pending"', '"paid"'))
    await new Promise((r) => setTimeout(r, 200))
    await flushPromises()
    button('Review and save').click()
    await flushPromises()
    byLabel('Replace the whole document instead').click()
    await flushPromises()
    button('Replace document').click()
    await flushPromises()
    const replaced = calls.find((c) => c.path.endsWith('/documents/replace'))!.body as {
      document: Record<string, unknown>
    }
    expect(replaced.document.photo).toBe(photo)
    expect(replaced.document.status).toBe('paid')
  })

  it('shows a match in a long value by the text around it, in the tree', async () => {
    await view({ docs: withPhoto() })
    await openRow(1)
    await search('0KGgoiVBORw0KGgoiVBOR')
    const line = page()!.querySelector<HTMLElement>('[role="treeitem"][data-path="photo"]')!
    expect(line.querySelector('mark[data-search-mark]')!.textContent).toBe('0KGgoiVBORw0KGgoiVBOR')
    expect(line.textContent!.length).toBeLessThan(600)
  })

  it('refuses a stand-in it does not know, and saves nothing', async () => {
    const { calls } = await edit({ [`POST ${PREFIX}/documents/update`]: () => [200, { modified: 1 }] })
    await typeInto(area(), area().value.replace(/⟨22 KB · [0-9a-f]{16}⟩/, '⟨22 KB · 0123456789abcdef⟩'))
    await new Promise((r) => setTimeout(r, 200))
    await flushPromises()
    expect(page()!.textContent).toContain('⟨22 KB · 0123456789abcdef⟩')
    button('Review and save').click()
    await flushPromises()
    expect(calls.some((c) => c.path.endsWith('/documents/update'))).toBe(false)
  })
})
