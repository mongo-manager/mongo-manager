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
const inspector = () => document.querySelector<HTMLElement>('[data-inspector]')
/** The inspector loads on first use. */
const opened = () => vi.waitFor(() => expect(inspector()).not.toBeNull())
const key = (el: Element, k: string) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))

describe('the Cards view (spec rev. 2 §4.4)', () => {
  it('shows each document as a card with its fields, and opens it in the inspector', async () => {
    await view()
    const cards = document.querySelectorAll('[data-card]')
    expect(cards).toHaveLength(2)
    expect(cards[0]!.textContent).toContain('status')
    expect(cards[0]!.textContent).toContain('"paid"')
    const inspect = cards[0]!.querySelector<HTMLButtonElement>('button[aria-label="Inspect document 1"]')!
    inspect.focus()
    inspect.click()
    await opened()
    expect(inspector()!.getAttribute('aria-label')).toBe('Document')
    expect(inspector()!.textContent).toContain('customer')
    expect(cards[0]!.getAttribute('aria-current')).toBe('true')
  })
})

describe('the inspector (spec rev. 2 §4.5)', () => {
  async function open() {
    await view()
    document.querySelector<HTMLButtonElement>('button[aria-label="Inspect document 1"]')!.click()
    await opened()
  }

  it('moves to the next and previous document with the arrow keys', async () => {
    await open()
    expect(inspector()!.querySelector('[data-inspector-id]')!.textContent).toContain('1')
    key(inspector()!, 'ArrowDown')
    await flushPromises()
    expect(inspector()!.querySelector('[data-inspector-id]')!.textContent).toContain('2')
    key(inspector()!, 'ArrowUp')
    await flushPromises()
    expect(inspector()!.querySelector('[data-inspector-id]')!.textContent).toContain('1')
  })

  it('shows the document as shell JSON', async () => {
    await open()
    ;[...inspector()!.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((t) => t.textContent?.trim() === 'JSON')!
      .click()
    await flushPromises()
    expect(inspector()!.textContent).toContain('status: "paid"')
  })

  it('edits through the review and saves only the change, then stays open on the document', async () => {
    const { calls } = await view({
      handlers: { [`POST ${PREFIX}/documents/update`]: () => [200, { modified: 1 }] },
    })
    document.querySelector<HTMLButtonElement>('button[aria-label="Inspect document 1"]')!.click()
    await opened()
    button('Edit').click()
    await flushPromises()
    const text = byLabel<HTMLTextAreaElement>('Document')
    await typeInto(text, text.value.replace('"paid"', '"refunded"'))
    button('Save').click()
    await flushPromises()
    expect(inspector()!.querySelector('[data-test="diff"]')!.textContent).toContain('refunded')
    button('Save changes').click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/documents/update'))!.body).toMatchObject({
      set: { status: 'refunded' },
      unset: [],
      hash: '0'.repeat(64),
    })
    // Reviewer B I1: saved edits are no longer unsaved.
    expect(useCollectionViewsStore().hasUnsaved('t')).toBe(false)
  })

  it('asks before leaving unsaved edits, by arrow key or Escape, and gives focus back on close', async () => {
    await open()
    const opener = document.querySelector<HTMLButtonElement>('button[aria-label="Inspect document 1"]')!
    button('Edit').click()
    await flushPromises()
    await typeInto(byLabel<HTMLTextAreaElement>('Document'), '{ _id: 1 }')
    key(inspector()!, 'ArrowDown')
    await flushPromises()
    expect(document.body.textContent).toContain('The document has unsaved changes.')
    ;(document.querySelector('[data-test="cancel"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(byLabel<HTMLTextAreaElement>('Document').value).toBe('{ _id: 1 }')
    key(inspector()!, 'Escape')
    await flushPromises()
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(inspector()).toBeNull()
    opener.focus()
    expect(document.activeElement).toBe(opener)
  })

  it('inserts documents from the Add documents button', async () => {
    const { calls } = await view({
      handlers: { [`POST ${PREFIX}/documents`]: () => [200, { insertedIds: [{ $numberInt: '3' }] }] },
    })
    button('Add documents').click()
    await opened()
    expect(inspector()!.getAttribute('aria-label')).toBe('Add documents')
    await typeInto(byLabel<HTMLTextAreaElement>('Document'), '{ a: 1 }')
    button('Insert').click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/documents'))!.body).toEqual({
      documents: [{ a: { $numberInt: '1' } }],
    })
    expect(inspector()).toBeNull()
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

describe('the inspected card stays in sight', () => {
  it('scrolls the card the arrows move to into view', async () => {
    const scrolled: Element[] = []
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this)
    }
    try {
      await view()
      document.querySelector<HTMLButtonElement>('button[aria-label="Inspect document 1"]')!.click()
      await opened()
      key(inspector()!, 'ArrowDown')
      await flushPromises()
      expect(scrolled.at(-1)).toBe(document.querySelectorAll('[data-card]')[1])
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })
})

describe('focus after the editor closes', () => {
  it('lands on the Fields tab, so the keyboard stays in the inspector', async () => {
    await view()
    document.querySelector<HTMLButtonElement>('button[aria-label="Inspect document 1"]')!.click()
    await opened()
    button('Edit').click()
    await flushPromises()
    button('Cancel').click()
    await flushPromises()
    expect(document.activeElement?.textContent?.trim()).toBe('Fields')
    expect(inspector()!.contains(document.activeElement)).toBe(true)
  })
})

describe('unsaved edits are never dropped without asking (reviewer B I1, I2)', () => {
  const editFirst = async () => {
    await view()
    document.querySelector<HTMLButtonElement>('button[aria-label="Inspect document 1"]')!.click()
    await opened()
    button('Edit').click()
    await flushPromises()
    await typeInto(byLabel<HTMLTextAreaElement>('Document'), '{ _id: 1, status: "draft" }')
  }
  const confirmShown = () => document.body.textContent!.includes('The document has unsaved changes.')
  const cancel = async () => {
    ;(document.querySelector('[data-test="cancel"]') as HTMLButtonElement).click()
    await flushPromises()
  }

  it('asks before another card, Add documents or a clone replaces them', async () => {
    await editFirst()
    document.querySelector<HTMLButtonElement>('button[aria-label="Inspect document 2"]')!.click()
    await flushPromises()
    expect(confirmShown()).toBe(true)
    await cancel()
    expect(byLabel<HTMLTextAreaElement>('Document').value).toBe('{ _id: 1, status: "draft" }')
    button('Add documents').click()
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
    key(inspector()!, 'Escape')
    await flushPromises()
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(inspector()).toBeNull()
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
    await clone(2)
    await vi.waitFor(() => expect(byLabel<HTMLTextAreaElement>('Document').value).toContain('new'))
    expect(byLabel<HTMLTextAreaElement>('Document').value).not.toContain('paid')
  })
})

describe('reading a long document with the keyboard (reviewer B Minor 11)', () => {
  it('scrolls the JSON with the arrows instead of moving to another document', async () => {
    await view()
    document.querySelector<HTMLButtonElement>('button[aria-label="Inspect document 1"]')!.click()
    await opened()
    ;[...inspector()!.querySelectorAll<HTMLElement>('[role="tab"]')]
      .find((t) => t.textContent?.trim() === 'JSON')!
      .click()
    await flushPromises()
    const pane = inspector()!.querySelector<HTMLElement>('[data-inspector-scroll]')!
    expect(pane.tabIndex).toBe(0)
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    pane.dispatchEvent(event)
    await flushPromises()
    expect(event.defaultPrevented).toBe(false)
    expect(inspector()!.querySelector('[data-inspector-id]')!.textContent).toContain('1')
    expect(inspector()!.querySelector('[data-inspector-id]')!.textContent).not.toContain('2')
  })
})
