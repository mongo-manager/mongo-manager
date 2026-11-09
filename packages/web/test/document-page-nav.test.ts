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
  document.body.innerHTML = ''
})

// Document page design §6.1–§6.3 (user request 2026-11-04): a document opens as the page in place of
// the results; prev and next walk them; leaving unsaved edits asks first. (The inspector's tests,
// spec rev. 2 §4.5 and reviewer B I1, I2, Minor 11, carried over to the page.)
const PREFIX = 'connections/c1/databases/shop/collections/orders'
const DOCS = [
  { _id: { $numberInt: '1' }, status: 'paid', total: { $numberDouble: '5.5' }, customer: { name: 'Ada' } },
  { _id: { $numberInt: '2' }, status: 'new', total: { $numberDouble: '7.0' } },
]

async function view(
  opts: { canWrite?: boolean; canExport?: boolean; handlers?: Record<string, Handler> } = {},
) {
  const api = mockApi({
    [`POST ${PREFIX}/find`]: () => [
      200,
      { documents: DOCS.map((d, i) => ({ document: d, hash: String(i).repeat(64) })), hasMore: false },
    ],
    [`POST ${PREFIX}/count`]: () => [200, { count: 2, exact: true }],
    ...opts.handlers,
  })
  useCollectionViewsStore().stateFor('t').mode = 'cards'
  mountApp(DocumentsView, {
    props: {
      target: { connectionId: 'c1', db: 'shop', coll: 'orders' },
      tabId: 't',
      canWrite: opts.canWrite ?? true,
      isView: false,
      canExport: opts.canExport ?? true,
    },
  })
  mountApp(DialogHost)
  await flushPromises()
  return api
}
const page = () => document.querySelector<HTMLElement>('[data-document-page]')
/** The page loads on first use. */
const opened = () => vi.waitFor(() => expect(page()).not.toBeNull())
const title = () => page()!.querySelector('h2')!.textContent!.trim()
const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }))
const tab = (name: string) =>
  [...page()!.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (t) => t.textContent?.trim() === name,
  )!

describe('the Cards view (spec rev. 2 §4.4)', () => {
  it('shows each document as a card with its fields, and opens it as the page', async () => {
    await view()
    const cards = document.querySelectorAll('[data-card]')
    expect(cards).toHaveLength(2)
    expect(cards[0]!.textContent).toContain('status')
    expect(cards[0]!.textContent).toContain('"paid"')
    cards[0]!.querySelector<HTMLButtonElement>('button[aria-label="Open document 1"]')!.click()
    await opened()
    expect(page()!.getAttribute('role')).toBeNull()
    expect(document.querySelector('[role="complementary"]')).toBeNull()
    expect(title()).toBe('Document 1')
    expect(page()!.textContent).toContain('customer')
    // In the results' place: the cards are not shown beside it.
    expect(document.querySelector('[data-card]')).toBeNull()
  })
})

describe('the document page (design §6.1–§6.3)', () => {
  async function open() {
    await view()
    document.querySelector<HTMLButtonElement>('button[aria-label="Open document 1"]')!.click()
    await opened()
  }

  it('moves to the next and previous document with Alt and the arrows, and says where it is', async () => {
    await open()
    expect(page()!.querySelector('[data-position]')!.textContent).toBe('1 of 2')
    key(page()!.querySelector('h2')!, 'ArrowDown', { altKey: true })
    await flushPromises()
    expect(title()).toBe('Document 2')
    expect(page()!.querySelector('[data-position]')!.textContent).toBe('2 of 2')
    key(page()!.querySelector('h2')!, 'ArrowUp', { altKey: true })
    await flushPromises()
    expect(title()).toBe('Document 1')
  })

  it('goes back to the results with Escape from its header, where the focus lands when it opens', async () => {
    await open()
    expect(document.activeElement).toBe(page()!.querySelector('h2'))
    key(page()!.querySelector('h2')!, 'Escape')
    await flushPromises()
    expect(page()).toBeNull()
  })

  it('takes the first Escape back from the review, not to the results', async () => {
    await open()
    tab('Edit').click()
    await flushPromises()
    const text = byLabel<HTMLTextAreaElement>('Document')
    await typeInto(text, text.value.replace('"paid"', '"held"'))
    button('Review and save').click()
    await flushPromises()
    key(page()!.querySelector('[data-test="diff"]')!, 'Escape')
    await flushPromises()
    expect(page()).not.toBeNull()
    expect(page()!.querySelector('[data-test="diff"]')).toBeNull()
  })

  it('shows the document as shell JSON', async () => {
    await open()
    tab('JSON').click()
    await flushPromises()
    expect(page()!.textContent).toContain('"status": "paid"')
  })

  it('edits through the review and saves only the change, then goes back to the results', async () => {
    const { calls } = await view({
      handlers: { [`POST ${PREFIX}/documents/update`]: () => [200, { modified: 1 }] },
    })
    document.querySelector<HTMLButtonElement>('button[aria-label="Open document 1"]')!.click()
    await opened()
    tab('Edit').click()
    await flushPromises()
    const text = byLabel<HTMLTextAreaElement>('Document')
    await typeInto(text, text.value.replace('"paid"', '"refunded"'))
    button('Review and save').click()
    await flushPromises()
    expect(page()!.querySelector('[data-test="diff"]')!.textContent).toContain('refunded')
    button('Save changes').click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/documents/update'))!.body).toMatchObject({
      set: { status: 'refunded' },
      unset: [],
      hash: '0'.repeat(64),
    })
    // Reviewer B I1: saved edits are no longer unsaved.
    expect(useCollectionViewsStore().hasUnsaved('t')).toBe(false)
    // User report 2026-11-07: a save goes back to the results (it stayed on the editor).
    await vi.waitFor(() => expect(page()).toBeNull())
  })

  it('asks before leaving unsaved edits, by Alt+arrow or Escape, and gives focus back on close', async () => {
    await view()
    const opener = document.querySelector<HTMLButtonElement>('button[aria-label="Open document 1"]')!
    opener.focus()
    opener.click()
    await opened()
    tab('Edit').click()
    await flushPromises()
    await typeInto(byLabel<HTMLTextAreaElement>('Document'), '{ _id: 1 }')
    key(page()!.querySelector('h2')!, 'ArrowDown', { altKey: true })
    await flushPromises()
    expect(document.body.textContent).toContain('The document has unsaved changes.')
    ;(document.querySelector('[data-test="cancel"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(byLabel<HTMLTextAreaElement>('Document').value).toBe('{ _id: 1 }')
    // The text field keeps its first Escape; the next one is the page's.
    key(byLabel<HTMLTextAreaElement>('Document'), 'Escape')
    key(byLabel<HTMLTextAreaElement>('Document'), 'Escape')
    await flushPromises()
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(page()).toBeNull()
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Open document 1'))
  })

  it('inserts documents from the Add documents button', async () => {
    const { calls } = await view({
      handlers: { [`POST ${PREFIX}/documents`]: () => [200, { insertedIds: [{ $numberInt: '3' }] }] },
    })
    button('Add documents').click()
    await opened()
    expect(title()).toBe('Add documents')
    // A new document has the text only: no tree, no prev or next.
    expect(page()!.querySelector('[role="tab"]')).toBeNull()
    expect(page()!.querySelector('[data-position]')).toBeNull()
    await typeInto(byLabel<HTMLTextAreaElement>('Document'), '{ a: 1 }')
    button('Insert').click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/documents'))!.body).toEqual({
      documents: [{ a: { $numberInt: '1' } }],
    })
    expect(page()).toBeNull()
    expect(useCollectionViewsStore().hasUnsaved('t')).toBe(false)
  })
})

describe('the results toolbar (spec rev. 2 §4.4)', () => {
  const moreItems = async () => {
    document.querySelector<HTMLButtonElement>('button[aria-label="More actions for these results"]')!.click()
    await flushPromises()
    return [...document.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent?.trim())
  }

  it('offers writes and transfers to those who may make them', async () => {
    await view()
    expect(await moreItems()).toEqual([
      'Export',
      'Import',
      'Copy to…',
      'Compare with…',
      'Update many',
      'Delete many',
    ])
    expect(button('Add documents')).toBeTruthy()
  })

  it('offers only reading to a reader', async () => {
    await view({ canWrite: false, canExport: false })
    expect(() => button('Add documents')).toThrow()
    expect(document.querySelector('button[aria-label="More actions for these results"]')).toBeNull()
    expect(
      [...document.querySelectorAll('[role="radio"]')].map(
        (r) => r.getAttribute('aria-label') ?? r.textContent?.trim(),
      ),
    ).toEqual(['Table', 'Cards', 'JSON', 'Chart'])
  })
})

describe('the document last open stays in sight', () => {
  it('scrolls the card prev and next moved to into view when back on the results', async () => {
    const scrolled: Element[] = []
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this)
    }
    try {
      await view()
      document.querySelector<HTMLButtonElement>('button[aria-label="Open document 1"]')!.click()
      await opened()
      key(page()!.querySelector('h2')!, 'ArrowDown', { altKey: true })
      await flushPromises()
      button('Back to results').click()
      await flushPromises()
      await vi.waitFor(() => expect(scrolled.at(-1)).toBe(document.querySelectorAll('[data-card]')[1]))
      expect(document.querySelectorAll('[data-card]')[1]!.getAttribute('aria-current')).toBe('true')
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })
})

describe('unsaved edits are never dropped without asking (reviewer B I1, I2)', () => {
  const editFirst = async () => {
    await view()
    document.querySelector<HTMLButtonElement>('button[aria-label="Open document 1"]')!.click()
    await opened()
    tab('Edit').click()
    await flushPromises()
    await typeInto(byLabel<HTMLTextAreaElement>('Document'), '{ _id: 1, status: "draft" }')
  }
  const confirmShown = () => document.body.textContent!.includes('The document has unsaved changes.')
  const cancel = async () => {
    ;(document.querySelector('[data-test="cancel"]') as HTMLButtonElement).click()
    await flushPromises()
  }

  it('asks before the next document or the results replace them', async () => {
    await editFirst()
    page()!.querySelector<HTMLButtonElement>('button[aria-label="Next document"]')!.click()
    await flushPromises()
    expect(confirmShown()).toBe(true)
    await cancel()
    expect(byLabel<HTMLTextAreaElement>('Document').value).toBe('{ _id: 1, status: "draft" }')
    button('Back to results').click()
    await flushPromises()
    expect(confirmShown()).toBe(true)
    await cancel()
    expect(byLabel<HTMLTextAreaElement>('Document').value).toBe('{ _id: 1, status: "draft" }')
  })

  it('keeps them, unsaved, while another section or tab is looked at', async () => {
    await editFirst()
    document.body.innerHTML = ''
    // The tab's view is unmounted (another section or tab) and shown again.
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
    await opened()
    await vi.waitFor(() =>
      expect(byLabel<HTMLTextAreaElement>('Document').value).toBe('{ _id: 1, status: "draft" }'),
    )
    expect(useCollectionViewsStore().hasUnsaved('t')).toBe(true)
  })

  it('forgets them once let go', async () => {
    await editFirst()
    button('Back to results').click()
    await flushPromises()
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(page()).toBeNull()
    expect(useCollectionViewsStore().hasUnsaved('t')).toBe(false)
  })

  it('opens a second clone with the second document’s fields (I2)', async () => {
    await view()
    const clone = async (n: number) => {
      document.querySelector<HTMLButtonElement>(`button[aria-label="Actions for document ${n}"]`)!.click()
      await flushPromises()
      ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((m) => m.textContent?.trim() === 'Clone')!
        .click()
      await flushPromises()
    }
    await clone(1)
    await opened()
    expect(byLabel<HTMLTextAreaElement>('Document').value).toContain('paid')
    button('Cancel').click()
    await flushPromises()
    await vi.waitFor(() => expect(page()).toBeNull())
    await clone(2)
    await vi.waitFor(() => expect(byLabel<HTMLTextAreaElement>('Document').value).toContain('new'))
    expect(byLabel<HTMLTextAreaElement>('Document').value).not.toContain('paid')
  })
})

describe('reading a long document with the keyboard (reviewer B Minor 11)', () => {
  it('leaves the arrows to the view instead of moving to another document', async () => {
    await view()
    document.querySelector<HTMLButtonElement>('button[aria-label="Open document 1"]')!.click()
    await opened()
    tab('JSON').click()
    await flushPromises()
    const pane = page()!.querySelector<HTMLElement>('[data-document-content]')!
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    pane.dispatchEvent(event)
    await flushPromises()
    expect(event.defaultPrevented).toBe(false)
    expect(title()).toBe('Document 1')
  })
})

// Review 2026-11-07: six documents, three to a page, under a filter on their status (a document set
// to another status leaves the results). The server keeps a version hash of each and refuses a save
// made on an older one, as the app's server does.
type Stored = Record<string, unknown> & { _id: { $numberInt: string }; status: string }
const six = (): Stored[] =>
  Array.from({ length: 6 }, (_, i) => ({
    _id: { $numberInt: String(i + 1) },
    status: 'pending',
    v: { $numberInt: String(i + 1) },
  }))
const hashOf = (d: unknown) => {
  let h = 7
  for (const c of JSON.stringify(d)) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h.toString(16).padStart(64, '0')
}
async function paged(
  docs: Stored[],
  opts: { handlers?: Record<string, Handler>; projection?: boolean } = {},
) {
  const matches = () => docs.filter((d) => d.status === 'pending')
  const byId = (body: unknown) =>
    docs.find((d) => d._id.$numberInt === (body as { _id: { $numberInt: string } })._id.$numberInt)
  const api = mockApi({
    [`POST ${PREFIX}/find`]: (body) => {
      const { skip, limit } = body as { skip: number; limit: number }
      const m = matches()
      return [
        200,
        {
          documents: m.slice(skip, skip + limit).map((d) => ({
            document: opts.projection ? { _id: d._id, status: d.status } : d,
            hash: hashOf(d),
          })),
          hasMore: skip + limit < m.length,
        },
      ]
    },
    [`POST ${PREFIX}/count`]: () => [200, { count: matches().length, exact: true }],
    [`POST ${PREFIX}/documents/get`]: (body) => {
      const d = byId(body)
      return d ? [200, { document: d, hash: hashOf(d) }] : [404, { code: 'NOT_FOUND', message: 'gone' }]
    },
    [`POST ${PREFIX}/documents/update`]: (body) => {
      const d = byId(body)
      const b = body as { set: Record<string, unknown>; unset: string[]; hash: string }
      if (!d) return [404, { code: 'NOT_FOUND', message: 'gone' }]
      if (b.hash !== hashOf(d)) return [409, { code: 'DOCUMENT_CHANGED', message: 'changed' }]
      Object.assign(d, b.set)
      for (const path of b.unset) delete d[path]
      return [200, { modified: 1 }]
    },
    ...opts.handlers,
  })
  const state = useCollectionViewsStore().stateFor('t')
  state.mode = 'cards'
  state.query = { ...state.query, limit: 3, ...(opts.projection ? { projection: { status: 1 } } : {}) }
  const mount = () => {
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
  }
  mount()
  await flushPromises()
  return {
    ...api,
    /** The tab's view unmounted (another section or tab) and shown again. */
    remount: async () => {
      document.body.innerHTML = ''
      mount()
      await flushPromises()
    },
  }
}
const openDoc = async (n: number) => {
  document.querySelector<HTMLButtonElement>(`button[aria-label="Open document ${n}"]`)!.click()
  await opened()
  await vi.waitFor(() => expect(title()).toBe(`Document ${n}`))
}
const position = () => page()!.querySelector('[data-position]')?.textContent
const alt = async (k: 'ArrowDown' | 'ArrowUp') => {
  key(page()!.querySelector('h2')!, k, { altKey: true })
  await flushPromises()
}
const confirmShown = () => document.body.textContent!.includes('The document has unsaved changes.')
const editor = () => byLabel<HTMLTextAreaElement>('Document')
const settle = async () => {
  await new Promise((r) => setTimeout(r, 200))
  await flushPromises()
}

describe('walking the results over their pages (review 2026-11-07)', () => {
  it('shows the document prev and next go to across a page boundary, where the position says', async () => {
    await paged(six())
    await openDoc(3)
    await alt('ArrowDown')
    await vi.waitFor(() => expect(title()).toBe('Document 4'))
    expect(position()).toBe('4 of 6')
    await alt('ArrowUp')
    await vi.waitFor(() => expect(title()).toBe('Document 3'))
    expect(position()).toBe('3 of 6')
    expect(page()!.querySelector('[data-stale]')).toBeNull()
    await alt('ArrowUp')
    await vi.waitFor(() => expect(title()).toBe('Document 2'))
    expect(position()).toBe('2 of 6')
    await alt('ArrowDown')
    await alt('ArrowDown')
    await vi.waitFor(() => expect(title()).toBe('Document 4'))
    expect(position()).toBe('4 of 6')
  })

  it('visits every document after one left the query', async () => {
    const docs = six()
    await paged(docs)
    await openDoc(1)
    // Another user moves document 2 out of the results.
    docs[1]!.status = 'paid'
    const seen: string[] = []
    for (let i = 0; i < 5; i++) {
      const before = title()
      await alt('ArrowDown')
      await vi.waitFor(() => expect(title()).not.toBe(before))
      seen.push(title())
    }
    expect(seen.filter((s) => s !== 'Document 2')).toEqual([
      'Document 3',
      'Document 4',
      'Document 5',
      'Document 6',
    ])
  })

  it('says at once when the next page cannot be loaded, stays where it was, and tries again', async () => {
    let fail = true
    const docs = six()
    await paged(docs, {
      handlers: {
        [`POST ${PREFIX}/find`]: (body) => {
          const { skip, limit } = body as { skip: number; limit: number }
          if (skip === 3 && fail) return [500, { code: 'MONGO_ERROR', message: 'The page broke.' }]
          return [
            200,
            {
              documents: docs.slice(skip, skip + limit).map((d) => ({ document: d, hash: hashOf(d) })),
              hasMore: skip + limit < docs.length,
            },
          ]
        },
      },
    })
    await openDoc(3)
    await alt('ArrowDown')
    await vi.waitFor(() =>
      expect(page()!.querySelector('[data-page-failed]')?.textContent).toContain('The page broke.'),
    )
    expect(title()).toBe('Document 3')
    expect(position()).toBe('3 of 6')
    expect(page()!.querySelector('[data-stale]')).toBeNull()
    fail = false
    page()!.querySelector<HTMLButtonElement>('[data-page-failed] button')!.click()
    await vi.waitFor(() => expect(title()).toBe('Document 4'))
    expect(position()).toBe('4 of 6')
    expect(page()!.querySelector('[data-page-failed]')).toBeNull()
  })
})

describe('edits on a document that left the results (review 2026-11-07)', () => {
  /**
   * Changes document 2 without saving while another user takes it out of the filter (a save of one's
   * own goes back to the results since 2026-11-07); the results read again no longer hold it.
   */
  async function editGone() {
    const docs = six()
    const api = await paged(docs)
    await openDoc(2)
    tab('Edit').click()
    await flushPromises()
    await typeInto(editor(), editor().value.replace('"v": 2', '"v": 99'))
    await settle()
    docs[1]!.status = 'paid'
    expect(useCollectionViewsStore().hasUnsaved('t')).toBe(true)
    return api
  }

  it('still shows them, with the document, after another section or tab', async () => {
    const { remount } = await editGone()
    await remount()
    await opened()
    await vi.waitFor(() => expect(editor().value).toContain('"v": 99'))
    expect(title()).toBe('Document 2')
    expect(page()!.querySelector('[data-stale]')).not.toBeNull()
  })

  it('asks before Back or the next document drop them', async () => {
    const { remount } = await editGone()
    await remount()
    await opened()
    await vi.waitFor(() => expect(editor().value).toContain('"v": 99'))
    button('Back to results').click()
    await flushPromises()
    expect(confirmShown()).toBe(true)
    ;(document.querySelector('[data-test="cancel"]') as HTMLButtonElement).click()
    await flushPromises()
    await alt('ArrowDown')
    expect(confirmShown()).toBe(true)
    ;(document.querySelector('[data-test="cancel"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(title()).toBe('Document 2')
    expect(editor().value).toContain('"v": 99')
    expect(useCollectionViewsStore().hasUnsaved('t')).toBe(true)
  })
})

describe('loading the current version after a conflict (review 2026-11-07)', () => {
  it('starts a new undo history: no undo brings the old version back to save over the new one', async () => {
    const docs = six()
    const { calls } = await paged(docs)
    await openDoc(1)
    tab('Edit').click()
    await flushPromises()
    await typeInto(editor(), editor().value.replace('"v": 1', '"v": 50'))
    // Meanwhile another user adds a field.
    docs[0]!.other = 'theirs'
    button('Review and save').click()
    await flushPromises()
    button('Save changes').click()
    await flushPromises()
    expect(page()!.textContent).toContain('Someone changed this document')
    button('Load the current version').click()
    await flushPromises()
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(editor().value).toContain('"theirs"'))
    key(editor(), 'z', { ctrlKey: true })
    await settle()
    key(editor(), 'z', { ctrlKey: true })
    await settle()
    expect(editor().value).toContain('"theirs"')
    expect(editor().value).toContain('"v": 1')
    expect(calls.filter((c) => c.path.endsWith('/documents/update'))).toHaveLength(1)
  })
})

describe('a change of layout only (review 2026-11-07)', () => {
  it('is no unsaved change: no footer, nothing kept, and Back does not ask', async () => {
    await paged(six())
    await openDoc(1)
    tab('Edit').click()
    await flushPromises()
    await typeInto(editor(), editor().value.replace(/^\{/, '{\n\n  ').replace(/\n}$/, '\n\n}'))
    await settle()
    expect(page()!.querySelector('[data-document-footer]')).toBeNull()
    expect(useCollectionViewsStore().hasUnsaved('t')).toBe(false)
    button('Back to results').click()
    await flushPromises()
    expect(confirmShown()).toBe(false)
    expect(page()).toBeNull()
  })

  it('still counts a real change made beside it', async () => {
    await paged(six())
    await openDoc(1)
    tab('Edit').click()
    await flushPromises()
    await typeInto(
      editor(),
      editor()
        .value.replace(/^\{/, '{\n\n  ')
        .replace(/"v": 1\b/, '"v": 2'),
    )
    await settle()
    expect(page()!.querySelector('[data-change-count]')!.textContent!.trim()).toBe('1 unsaved change')
    expect(useCollectionViewsStore().hasUnsaved('t')).toBe(true)
    button('Back to results').click()
    await flushPromises()
    expect(confirmShown()).toBe(true)
  })
})

describe('the whole document behind a projected row (review 2026-11-07)', () => {
  it('can be loaded again after a failed load', async () => {
    let fail = true
    const docs = six()
    await paged(docs, {
      projection: true,
      handlers: {
        [`POST ${PREFIX}/documents/get`]: () =>
          fail
            ? [500, { code: 'INTERNAL', message: 'The server broke.' }]
            : [200, { document: docs[0], hash: hashOf(docs[0]) }],
      },
    })
    await openDoc(1)
    await vi.waitFor(() => expect(page()!.textContent).toContain('The server broke.'))
    fail = false
    button('Retry').click()
    await vi.waitFor(() =>
      expect(page()!.querySelector('[data-projection-note]')?.textContent).toContain('whole document'),
    )
    expect(tab('Edit')).toBeTruthy()
  })
})
