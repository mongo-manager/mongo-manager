// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DocumentsView from '../src/documents/DocumentsView.vue'
import DocumentTable from '../src/documents/DocumentTable.vue'
import { toRows } from '../src/documents/rows'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { useCollectionViewsStore, type CollectionViewState } from '../src/stores/collectionViews'
import { i18n } from '../src/i18n'
import { mockApi, mountApp, type Handler } from './support/app'

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

// Document page design §6.10 (user request 2026-11-04): "the three dots holding inspect, edit and
// copy are very hard to see, I found them hard myself" — the row's actions where a first-time user
// looks for them.
const PREFIX = 'connections/c1/databases/hotel/collections/reservations'
const DOCS = [
  { _id: { $numberInt: '1' }, guest: 'Ada', status: 'pending' },
  { _id: { $numberInt: '2' }, guest: 'Lin', status: 'paid' },
]

async function view(
  opts: { canWrite?: boolean; mode?: CollectionViewState['mode']; handlers?: Record<string, Handler> } = {},
) {
  const api = mockApi({
    [`POST ${PREFIX}/find`]: () => [
      200,
      { documents: DOCS.map((d, i) => ({ document: d, hash: String(i).repeat(64) })), hasMore: false },
    ],
    [`POST ${PREFIX}/count`]: () => [200, { count: 2, exact: true }],
    ...opts.handlers,
  })
  useCollectionViewsStore().stateFor('t').mode = opts.mode ?? 'table'
  mountApp(DocumentsView, {
    props: {
      target: { connectionId: 'c1', db: 'hotel', coll: 'reservations' },
      tabId: 't',
      canWrite: opts.canWrite ?? true,
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
const rows = () => [...document.querySelectorAll<HTMLElement>('tbody tr[data-row]')]
const selectedTab = () => page()!.querySelector('[role="tab"][aria-selected="true"]')!.textContent!.trim()
const menuItems = () => [...document.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent?.trim())

// User report 2026-11-05: "the buttons on hover look bad; try another way — at the start, as SQL
// tools have them: Edit, Delete and the three dots; no Open, Edit opens it anyway; a right click
// opens the three dots' menu too."
const lead = (row: HTMLElement) => row.querySelector<HTMLElement>('[data-row-lead]')!
const names = (el: Element) => [...el.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))
const hidden = /(?:^|\s)opacity-0(?:\s|$)/

describe('the row’s actions in the table', () => {
  it('shows Edit, Delete and More with their words at the start of every row, always', async () => {
    await view()
    for (const [i, row] of rows().entries()) {
      const n = i + 1
      expect(names(lead(row))).toEqual([
        `Edit document ${n}`,
        `Delete document ${n}`,
        `Actions for document ${n}`,
      ])
      const words = [...lead(row).querySelectorAll('button')].slice(0, 2).map((b) => b.textContent!.trim())
      expect(words).toEqual(['Edit', 'Delete'])
      for (const b of lead(row).querySelectorAll('button')) expect(b.className).not.toMatch(hidden)
      expect(lead(row).className).not.toMatch(hidden)
      // At the start: right after the selection box, before the first field.
      const cell = lead(row).closest('td')!
      expect(cell.nextElementSibling!.getAttribute('data-field')).toBe('_id')
    }
    // No Open button, no bar at the row's end: the last cell is the filler that takes the spare width.
    expect(document.querySelector('button[data-row-open]')).toBeNull()
    expect(document.querySelector('[data-row-actions]')).toBeNull()
    expect(rows()[0]!.lastElementChild!.hasAttribute('data-row-filler')).toBe(true)
    expect(document.querySelector('thead tr')!.children).toHaveLength(rows()[0]!.children.length)
  })

  // User request 2026-11-05: "freeze the buttons at the start" — scrolled sideways, the selection box
  // and the row's actions stay at the left edge, opaque over the fields that pass under them, in the
  // row's own tint, with a line where the scrolling part begins.
  it('keeps the selection box and the row’s actions frozen at the left edge', async () => {
    await view()
    const sticky = (el: Element, left: string) => {
      expect(el.className).toMatch(/(?:^|\s)sticky(?:\s|$)/)
      expect(el.className).toContain(left)
      expect(el.className).toMatch(/(?:^|\s)z-\[?\d/)
    }
    const head = document.querySelector('thead tr')!.children
    sticky(head[0]!, 'left-0')
    sticky(head[1]!, 'left-8')
    expect(head[0]!.className).toContain('bg-subtle')
    expect(head[1]!.className).toContain('border-r')
    for (const row of rows()) {
      const box = row.querySelector('input[type="checkbox"]')!.closest('td')!
      const cell = lead(row).closest('td')!
      sticky(box, 'left-0')
      sticky(cell, 'left-8')
      expect(box.className).toContain('w-8')
      expect(cell.className).toContain('border-r')
      // Opaque: the surface under the row's tint, never the row's see-through colour alone.
      for (const frozen of [box, cell]) {
        expect(frozen.className).toContain('bg-surface')
        expect(frozen.className).toContain('from-(--row-tint)')
      }
    }
    // The row's tint is one value, which the row and its frozen cells both paint.
    expect(rows()[0]!.className).toContain('bg-(--row-tint)')
  })

  it('freezes the row’s actions at the very edge when there is no selection box', async () => {
    // A shell or pipeline result: the table without selection.
    mountApp(DocumentTable, {
      props: {
        rows: toRows(
          DOCS.map((d, i) => ({ document: d, hash: String(i).repeat(64) })),
          0,
        ),
        columns: ['_id', 'guest'],
        canWrite: true,
        rowHeight: 36,
        target: { connectionId: 'c1', db: 'hotel', coll: 'reservations' },
        inlineEdit: false,
      },
    })
    await flushPromises()
    const cell = lead(rows()[0]!).closest('td')!
    expect(rows()[0]!.querySelector('input[type="checkbox"]')).toBeNull()
    expect(document.querySelector('thead th')!.className).toContain('left-0')
    expect(cell.className).toMatch(/(?:^|\s)sticky(?:\s|$)/)
    expect(cell.className).toContain('left-0')
    expect(cell.className).not.toContain('left-8')
  })

  it('edits the document from Edit', async () => {
    await view()
    lead(rows()[0]!).querySelector<HTMLButtonElement>('button[aria-label="Edit document 1"]')!.click()
    await opened()
    expect(selectedTab()).toBe('Edit')
  })

  it('deletes the document from Delete, after asking', async () => {
    const { calls } = await view({
      handlers: { [`POST ${PREFIX}/documents/delete`]: () => [200, { deleted: 1 }] },
    })
    lead(rows()[1]!).querySelector<HTMLButtonElement>('button[aria-label="Delete document 2"]')!.click()
    await flushPromises()
    const deletes = () => calls.filter((c) => c.path.endsWith('/documents/delete'))
    expect(deletes()).toHaveLength(0)
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"], [role="dialog"]')!
    ;[...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Delete')!.click()
    await flushPromises()
    expect(deletes()).toHaveLength(1)
    expect(deletes()[0]!.body).toEqual({ _id: { $numberInt: '2' } })
  })

  it('opens the document from its _id', async () => {
    await view()
    rows()[1]!.querySelector<HTMLButtonElement>('td[data-field="_id"] button[data-open-id]')!.click()
    await opened()
    expect(page()!.querySelector('h2')!.textContent).toContain('2')
  })

  it('opens the three dots’ menu on a right click, with the cell’s own on a cell', async () => {
    await view()
    const row = rows()[0]!
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    row.querySelector('td[data-field="guest"]')!.dispatchEvent(event)
    await flushPromises()
    expect(event.defaultPrevented).toBe(true)
    expect(menuItems()).toEqual(
      expect.arrayContaining([
        'Copy the value of guest',
        'Filter by guest = "Ada"',
        'Open',
        'Edit',
        'Clone',
        'Copy',
        'Delete',
      ]),
    )
    // The menu is the one of the row's three dots.
    const trigger = lead(row).querySelector<HTMLButtonElement>('button[aria-label="Actions for document 1"]')!
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.trim() === 'Filter by guest = "Ada"')!
      .click()
    await flushPromises()
    expect(useCollectionViewsStore().stateFor('t').draft.filter).toContain('Ada')
  })

  it('opens the row’s menu with the context-menu key from a cell', async () => {
    await view()
    const cell = rows()[0]!.querySelector<HTMLElement>('td[data-field="status"]')!
    cell.focus()
    cell.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }),
    )
    await flushPromises()
    expect(menuItems()).toContain('Open')
  })

  it('offers only More to a reader', async () => {
    await view({ canWrite: false })
    expect(names(lead(rows()[0]!))).toEqual(['Actions for document 1'])
  })
})

describe('the actions of cards and lists', () => {
  it('shows Edit, Delete and More on every card, not only under the pointer', async () => {
    await view({ mode: 'cards' })
    const card = document.querySelector<HTMLElement>('[data-card]')!
    // No Open button: the card's _id opens the document, as in the table.
    expect([...card.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Open')).toBe(false)
    expect(card.querySelector('button[aria-label="Open document 1"]')!.hasAttribute('data-open-id')).toBe(
      true,
    )
    const edit = card.querySelector<HTMLButtonElement>('button[aria-label="Edit document 1"]')!
    const remove = card.querySelector<HTMLButtonElement>('button[aria-label="Delete document 1"]')!
    expect(edit.textContent!.trim()).toBe('Edit')
    expect(remove.textContent!.trim()).toBe('Delete')
    for (const b of [edit, remove]) expect(b.className).not.toMatch(hidden)
  })

  it('shows Edit and Delete on each document of the JSON list', async () => {
    await view({ mode: 'json' })
    expect(document.querySelector('button[aria-label="Edit document 1"]')!.textContent!.trim()).toBe('Edit')
    expect(document.querySelector('button[aria-label="Delete document 1"]')).not.toBeNull()
    expect([...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Open')).toBe(false)
    expect(document.querySelector('button[aria-label="Open document 1"]')!.hasAttribute('data-open-id')).toBe(
      true,
    )
  })
})

describe('the first-use hint', () => {
  it('says once where the row’s actions are, until it is put away', async () => {
    await view()
    const hint = () => document.querySelector('[data-open-hint]')
    expect(hint()!.textContent).toContain('Edit and Delete are at the start of each row')
    ;[...hint()!.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Got it')!.click()
    await flushPromises()
    expect(hint()).toBeNull()
    document.body.innerHTML = ''
    await view()
    expect(hint()).toBeNull()
  })
})

describe('right clicks the browser keeps (final review)', () => {
  it('leaves the browser its menu on selected text and in a text field', async () => {
    await view()
    const cell = rows()[0]!.querySelector<HTMLElement>('td[data-field="guest"]')!
    const range = document.createRange()
    range.selectNodeContents(cell)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    const onText = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    cell.dispatchEvent(onText)
    expect(onText.defaultPrevented).toBe(false)
    window.getSelection()!.removeAllRanges()
    const input = document.createElement('input')
    cell.appendChild(input)
    const inField = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    input.dispatchEvent(inField)
    expect(inField.defaultPrevented).toBe(false)
  })

  it('cuts a long value short in the filter item', async () => {
    mockApi({
      [`POST ${PREFIX}/find`]: () => [
        200,
        {
          documents: [
            { document: { _id: { $numberInt: '1' }, note: 'x'.repeat(200) }, hash: 'a'.repeat(64) },
          ],
          hasMore: false,
        },
      ],
      [`POST ${PREFIX}/count`]: () => [200, { count: 1, exact: true }],
    })
    useCollectionViewsStore().stateFor('t').mode = 'table'
    mountApp(DocumentsView, {
      props: {
        target: { connectionId: 'c1', db: 'hotel', coll: 'reservations' },
        tabId: 't',
        canWrite: true,
        isView: false,
        canExport: true,
      },
    })
    await flushPromises()
    rows()[0]!
      .querySelector('td[data-field="note"]')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await flushPromises()
    const filter = menuItems().find((m) => m?.startsWith('Filter by note'))!
    expect(filter.length).toBeLessThan(80)
    expect(filter).toContain('…')
  })
})
