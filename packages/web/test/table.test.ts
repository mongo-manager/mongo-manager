import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DocumentsView from '../src/documents/DocumentsView.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { arrangeColumns } from '../src/documents/rows'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { useToastStore } from '../src/stores/toasts'
import { i18n } from '../src/i18n'
import { mockApi, mountApp, type Handler } from './support/app'
import { button, byLabel } from './support/dom'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

const PREFIX = 'connections/c1/databases/shop/collections/orders'
const HASH = 'a'.repeat(64)

async function view(
  documents: Record<string, unknown>[],
  extra: Record<string, Handler> = {},
  canWrite = true,
) {
  const api = mockApi({
    [`POST ${PREFIX}/find`]: () => [
      200,
      { documents: documents.map((document) => ({ document, hash: HASH })), hasMore: false },
    ],
    [`POST ${PREFIX}/count`]: () => [200, { count: documents.length, exact: true }],
    ...extra,
  })
  useCollectionViewsStore().stateFor('t')
  mountApp(DocumentsView, {
    props: {
      target: { connectionId: 'c1', db: 'shop', coll: 'orders' },
      tabId: 't',
      canWrite,
      isView: false,
    },
  })
  mountApp(DialogHost)
  await flushPromises()
  return api
}

const headers = () =>
  [...document.querySelectorAll('thead th[data-column]')].map((th) => th.getAttribute('data-column'))

describe('arranging columns (phase 1g-1, Review Focus 5)', () => {
  it('applies the saved order and hidden fields, adds new fields last, and caps without dropping', () => {
    expect(arrangeColumns(['_id', 'a', 'b', 'c'], { order: ['c', 'gone', 'a'], hidden: ['b'] }, 100)).toEqual(
      {
        shown: ['c', 'a', '_id'],
        overflow: 0,
      },
    )
    const many = Array.from({ length: 150 }, (_, i) => `f${i}`)
    expect(arrangeColumns(many, { order: [], hidden: [] }, 100)).toMatchObject({ overflow: 50 })
  })
})

describe('the columns menu', () => {
  it('hides, shows and reorders columns by keyboard-reachable controls', async () => {
    await view([{ _id: 1, a: 1, b: 2, c: 3 }])
    expect(headers()).toEqual(['_id', 'a', 'b', 'c'])
    button('Columns').click()
    await flushPromises()
    byLabel<HTMLInputElement>('b').click()
    await flushPromises()
    expect(headers()).toEqual(['_id', 'a', 'c'])
    // The menu lists hidden columns too: c moves above the hidden b, then above a.
    const up = () => (document.querySelector('button[aria-label="Move c up"]') as HTMLButtonElement).click()
    up()
    await flushPromises()
    expect(headers()).toEqual(['_id', 'a', 'c'])
    up()
    await flushPromises()
    expect(headers()).toEqual(['_id', 'c', 'a'])
    button('Show all').click()
    button('Reset order').click()
    await flushPromises()
    expect(headers()).toEqual(['_id', 'a', 'b', 'c'])
  })

  it('never drops columns silently: it says how many are not shown', async () => {
    const wide = Object.fromEntries([['_id', 1], ...Array.from({ length: 130 }, (_, i) => [`f${i}`, i])])
    await view([wide])
    expect(headers()).toHaveLength(100)
    expect(document.body.textContent).toContain('31 more columns are not shown')
  })
})

describe('nested values in the table (phase 1g-1)', () => {
  it('open in a popover with the tree view, and close with Escape back to their button', async () => {
    await view([{ _id: 1, addr: { city: 'Izmir', zip: '35000' }, tags: ['a', 'b'] }])
    const rowsBefore = document.querySelectorAll('tbody tr[data-row]').length
    const open = document.querySelector('button[aria-label="Show addr of document 1"]') as HTMLButtonElement
    expect(open.textContent).toContain('2 fields')
    open.click()
    await flushPromises()
    const panel = document.querySelector('[role="dialog"][aria-label="Show addr of document 1"]')!
    expect(panel.textContent).toContain('city')
    expect(panel.textContent).toContain('Izmir')
    // The table keeps its rows and their height: the popover floats outside it.
    expect(document.querySelectorAll('tbody tr[data-row]').length).toBe(rowsBefore)
    expect(document.querySelector('tbody')!.contains(panel)).toBe(false)
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(document.querySelector('[role="dialog"][aria-label="Show addr of document 1"]')).toBeNull()
    expect(document.activeElement).toBe(open)
    expect(document.querySelector('button[aria-label="Show tags of document 1"]')!.textContent).toContain(
      '2 items',
    )
  })
})

describe('inline cell editing keeps the type (phase 1g-1, Review Focus 2)', () => {
  const DOC = { _id: { $numberInt: '1' }, qty: { $numberInt: '5' }, name: 'Ada', addr: { city: 'X' } }
  const cell = (field: string) => document.querySelector(`td[data-field="${field}"]`) as HTMLTableCellElement
  const input = () => document.querySelector('td input[data-test="inline-editor"]') as HTMLInputElement | null
  const dbl = (el: Element) => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  const key = (el: Element, k: string) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))

  it('saves an Int32 cell as Int32 with $set and the row hash', async () => {
    const { calls } = await view([DOC], {
      [`POST ${PREFIX}/documents/update`]: () => [200, { modified: 1 }],
    })
    dbl(cell('qty'))
    await flushPromises()
    expect(input()!.value).toBe('5')
    input()!.value = '6'
    input()!.dispatchEvent(new Event('input'))
    key(input()!, 'Enter')
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/documents/update'))!.body).toEqual({
      _id: { $numberInt: '1' },
      set: { qty: { $numberInt: '6' } },
      unset: [],
      hash: HASH,
    })
    expect(input()).toBeNull()
    expect(useToastStore().toasts.at(-1)?.message).toBe('Field saved.')
  })

  it('refuses a value outside the type in place, and Escape cancels', async () => {
    const { calls } = await view([DOC])
    key(cell('qty'), 'Enter')
    await flushPromises()
    input()!.value = '2147483648'
    input()!.dispatchEvent(new Event('input'))
    key(input()!, 'Enter')
    await flushPromises()
    expect(document.body.textContent).toContain('Enter a whole number from -2147483648 to 2147483647.')
    expect(input()!.getAttribute('aria-invalid')).toBe('true')
    key(input()!, 'Escape')
    await flushPromises()
    expect(input()).toBeNull()
    expect(document.activeElement).toBe(cell('qty'))
    expect(calls.some((c) => c.path.endsWith('/documents/update'))).toBe(false)
  })

  it('does not edit _id, nested values or anything when read-only', async () => {
    await view([DOC])
    dbl(cell('_id'))
    await flushPromises()
    expect(input()).toBeNull()
    expect(cell('addr').getAttribute('tabindex')).toBeNull()
    expect(cell('qty').getAttribute('tabindex')).toBe('0')
  })

  it('offers no inline editing without write access', async () => {
    await view([DOC], {}, false)
    expect(cell('qty').getAttribute('tabindex')).toBeNull()
    dbl(cell('qty'))
    await flushPromises()
    expect(input()).toBeNull()
  })

  it('reports a concurrent change and reloads the page', async () => {
    const { calls } = await view([DOC], {
      [`POST ${PREFIX}/documents/update`]: () => [409, { code: 'DOCUMENT_CHANGED', message: 'x' }],
    })
    const finds = () => calls.filter((c) => c.path.endsWith('/find')).length
    const before = finds()
    dbl(cell('name'))
    await flushPromises()
    input()!.value = 'Bob'
    input()!.dispatchEvent(new Event('input'))
    key(input()!, 'Enter')
    await flushPromises()
    expect(useToastStore().toasts.at(-1)?.message).toContain('Someone changed this document')
    expect(finds()).toBeGreaterThan(before)
  })
})

describe('inline editing: final review 1g-1', () => {
  const cell = (field: string) =>
    document.querySelector(`td[data-field="${CSS.escape(field)}"]`) as HTMLTableCellElement
  const input = () => document.querySelector('td input[data-test="inline-editor"]') as HTMLInputElement | null
  const dbl = (el: Element) => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }))

  it('never edits a field whose name is not a path, which would write another field (C1)', async () => {
    const { calls } = await view([{ _id: 1, 'a.b': 1, a: { b: 5 }, $odd: 2 }])
    for (const field of ['a.b', '$odd']) {
      expect(cell(field).getAttribute('tabindex'), field).toBeNull()
      dbl(cell(field))
      await flushPromises()
      expect(input(), field).toBeNull()
    }
    expect(calls.some((c) => c.path.endsWith('/documents/update'))).toBe(false)
  })

  it('leaves multi-line text to the document editor, since a text box drops line breaks (C2)', async () => {
    await view([{ _id: 1, note: 'line1\nline2', one: 'x' }])
    expect(cell('note').getAttribute('tabindex')).toBeNull()
    expect(cell('one').getAttribute('tabindex')).toBe('0')
  })

  it('is off while a projection is applied, and says so (I2)', async () => {
    useCollectionViewsStore().stateFor('t').query = {
      filter: {},
      projection: { qty: { $numberInt: '1' } },
      skip: 0,
      limit: 20,
    }
    await view([{ _id: 1, qty: 5 }])
    expect(cell('qty').getAttribute('tabindex')).toBeNull()
    expect(document.body.textContent).toContain('Inline editing is off while a projection is applied.')
  })

  it('closes without writing when nothing changed, and ignores Enter while composing (Minor 2, 3)', async () => {
    const { calls } = await view([{ _id: 1, name: 'Ada' }])
    dbl(cell('name'))
    await flushPromises()
    key(input()!, 'Enter', { isComposing: true })
    await flushPromises()
    expect(input()).not.toBeNull()
    key(input()!, 'Enter')
    await flushPromises()
    expect(input()).toBeNull()
    expect(calls.some((c) => c.path.endsWith('/documents/update'))).toBe(false)
  })

  it('keeps the sign of -0 (Minor 1) and puts focus on the saved cell of the reloaded row (Minor 13)', async () => {
    let n = 0
    const { calls } = await view([{ _id: 1, d: { $numberDouble: '-0.0' } }], {
      [`POST ${PREFIX}/documents/update`]: () => [200, { modified: 1 }],
      [`POST ${PREFIX}/find`]: () => [
        200,
        {
          documents: [
            {
              document: { _id: 1, d: { $numberDouble: ++n === 1 ? '-0.0' : '2.0' } },
              hash: String(n).repeat(64),
            },
          ],
          hasMore: false,
        },
      ],
    })
    dbl(cell('d'))
    await flushPromises()
    expect(input()!.value).toBe('-0')
    input()!.value = '2'
    input()!.dispatchEvent(new Event('input'))
    key(input()!, 'Enter')
    await flushPromises()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/documents/update'))!.body).toMatchObject({
      set: { d: { $numberDouble: '2.0' } },
    })
    await vi.waitFor(() => expect(document.activeElement).toBe(cell('d')))
    expect(cell('d').textContent).toContain('2')
  })
})

describe('table polish: final review 1g-1', () => {
  it('collects every column, however many (Minor 6)', async () => {
    const { columnsOf, toRows } = await import('../src/documents/rows')
    const wide = Object.fromEntries(Array.from({ length: 6000 }, (_, i) => [`f${i}`, i]))
    expect(columnsOf(toRows([{ document: wide, hash: HASH }], 0))).toHaveLength(6000)
  })

  it('keeps focus on a move button when a column reaches the end (Minor 10)', async () => {
    await view([{ _id: 1, a: 1, b: 2 }])
    button('Columns').click()
    await flushPromises()
    const down = document.querySelector('button[aria-label="Move a down"]') as HTMLButtonElement
    down.focus()
    down.click()
    await flushPromises()
    expect(headers()).toEqual(['_id', 'b', 'a'])
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Move a up')
    ;(document.activeElement as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    await flushPromises()
    expect(document.querySelector('button[aria-label="Move a up"]')).toBeNull()
  })

  it('popovers close on scroll, when focus leaves them, and when another opens (Minor 9)', async () => {
    await view([{ _id: 1, addr: { city: 'X' }, tags: ['a'] }])
    const addr = document.querySelector('button[aria-label="Show addr of document 1"]') as HTMLButtonElement
    const tags = document.querySelector('button[aria-label="Show tags of document 1"]') as HTMLButtonElement
    const panels = () => document.querySelectorAll('[role="dialog"][aria-label^="Show "]').length
    addr.click()
    await flushPromises()
    tags.click()
    await flushPromises()
    expect(panels()).toBe(1)
    window.dispatchEvent(new Event('scroll'))
    await flushPromises()
    expect(panels()).toBe(0)
    addr.click()
    await flushPromises()
    const panel = document.querySelector('[role="dialog"][aria-label="Show addr of document 1"]')!
    panel.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }))
    await flushPromises()
    expect(panels()).toBe(0)
  })

  it('a popover opened near the corner stays inside the window (Minor 9)', async () => {
    await view([{ _id: 1, addr: { city: 'X' } }])
    const addr = document.querySelector('button[aria-label="Show addr of document 1"]') as HTMLButtonElement
    vi.spyOn(addr, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(window.innerWidth - 10, window.innerHeight - 10, 8, 8),
    )
    addr.click()
    await flushPromises()
    const panel = document.querySelector(
      '[role="dialog"][aria-label="Show addr of document 1"]',
    ) as HTMLElement
    expect(parseFloat(panel.style.left)).toBeLessThanOrEqual(window.innerWidth - 8)
    expect(parseFloat(panel.style.top)).toBeLessThanOrEqual(window.innerHeight - 8)
  })
})
