import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { QueryOrigin } from '@mongo-manager/shared'
import { i18n } from '../src/i18n'
import type { ShellResult } from '../src/shell/results'
import { mountApp } from './support/app'
import { settled } from './support/dom'

const { openMock, downloadMock } = vi.hoisted(() => ({
  openMock: vi.fn(async () => true),
  downloadMock: vi.fn(),
}))
vi.mock('../src/library/openItem', () => ({ openLibraryItem: openMock }))
vi.mock('../src/download', () => ({ downloadText: downloadMock, downloadJson: vi.fn() }))

import ResultPane from '../src/shell/ResultPane.vue'

/** Phase 3a-2 spec §2: the result pane — views, More, open in the collection view, export. */
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
/** Panes mounted by a test, unmounted after it (an open popover's listeners go with them). */
const mounted: Array<{ unmount(): void }> = []
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

const docs = [
  { _id: { $oid: '0123456789abcdef01234561' }, name: 'Ada' },
  { _id: { $oid: '0123456789abcdef01234562' }, name: 'Bob' },
]
const origin: QueryOrigin = { kind: 'find', db: 'shop', coll: 'orders', filter: {} }
const result = (over: Partial<ShellResult> = {}): ShellResult => ({
  id: 1,
  resultType: 'Cursor',
  value: docs,
  hasMore: false,
  documents: docs,
  ...over,
})
const mountPane = (results: ShellResult[]) => {
  const { wrapper } = mountApp(ResultPane, { props: { connectionId: 'c1', db: 'shop', results } })
  mounted.push(wrapper)
  return wrapper
}

describe('ResultPane', () => {
  it('switches between table, tree and text', async () => {
    const wrapper = mountPane([result()])
    expect(wrapper.find('[data-result-table]').exists()).toBe(true)
    await wrapper.find('[data-view="tree"]').trigger('click')
    expect(wrapper.find('[data-result-tree]').exists()).toBe(true)
    await wrapper.find('[data-view="text"]').trigger('click')
    expect(wrapper.find('[data-result-text]').text()).toContain('"Ada"')
  })

  it('offers More only when the cursor has more', async () => {
    expect(mountPane([result()]).find('[data-result-more]').exists()).toBe(false)
    document.body.innerHTML = ''
    const wrapper = mountPane([result({ hasMore: true })])
    await wrapper.find('[data-result-more]').trigger('click')
    expect(wrapper.emitted('more')).toHaveLength(1)
  })

  it('opens a result in the collection view only when it came from a query (review focus 5)', async () => {
    expect(mountPane([result()]).find('[data-result-open]').exists()).toBe(false)
    document.body.innerHTML = ''
    const wrapper = mountPane([result({ origin })])
    await wrapper.find('[data-result-open]').trigger('click')
    await flushPromises()
    expect(openMock).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ kind: 'find', db: 'shop', coll: 'orders', body: { filter: {} } }),
      expect.anything(),
    )
  })

  // W5: the collection view starts where the shell's query did, with its page size.
  it('opens a find in the collection view with its skip and limit', async () => {
    const wrapper = mountPane([result({ origin: { ...origin, skip: 40, limit: 7 } })])
    await wrapper.find('[data-result-open]').trigger('click')
    await flushPromises()
    expect(openMock).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ kind: 'find' }),
      expect.objectContaining({ paging: { skip: 40, limit: 7 } }),
    )
  })

  it('exports the documents as canonical EJSON', async () => {
    const wrapper = mountPane([result({ origin })])
    await wrapper.find('[data-result-export-json]').trigger('click')
    const [text, filename] = downloadMock.mock.calls[0] as [string, string]
    expect(JSON.parse(text)).toEqual(docs)
    expect(filename).toMatch(/^orders-.*\.json$/)
  })

  it('exports CSV with the formula guard', async () => {
    const hostile = [{ f: '=HYPERLINK("x")' }]
    const wrapper = mountPane([result({ value: hostile, documents: hostile })])
    await wrapper.find('[data-result-export-csv]').trigger('click')
    const [text, filename] = downloadMock.mock.calls[0] as [string, string]
    expect(text).toContain(`"'=HYPERLINK(""x"")"`)
    expect(filename).toMatch(/\.csv$/)
  })

  it('adds a byte order mark and says when columns were left out (final review M2)', async () => {
    const wide: Record<string, unknown> = {}
    for (let i = 0; i < 510; i++) wide[`f${i}`] = i
    const wrapper = mountPane([result({ value: [wide], documents: [wide] })])
    await wrapper.find('[data-result-export-csv]').trigger('click')
    const [text] = downloadMock.mock.calls[0] as [string, string]
    expect(text.startsWith('\uFEFF')).toBe(true)
    const { useToastStore } = await import('../src/stores/toasts')
    expect(
      useToastStore()
        .toasts.map((t) => t.message)
        .join(' '),
    ).toContain('10')
  })

  it('offers More only on the newest result, the cursor "it" continues (final review M3)', async () => {
    const wrapper = mountPane([result({ id: 2, hasMore: false }), result({ id: 1, hasMore: true })])
    expect(wrapper.find('[data-result-more]').exists()).toBe(false)
    await wrapper.find('[data-result-history] button').trigger('click')
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-result-pick="1"]')!.click()
    await flushPromises()
    expect(wrapper.find('[data-result-more]').exists()).toBe(false)
  })

  it('shows a non-document result as text, with export off', async () => {
    const wrapper = mountPane([result({ resultType: null, value: { $numberInt: '3' }, documents: null })])
    expect(wrapper.find('[data-result-text]').text()).toContain('3')
    expect(wrapper.find('[data-result-export-json]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-result-export-csv]').attributes('disabled')).toBeDefined()
  })

  it('says when a result was too large to show', () => {
    const wrapper = mountPane([result({ value: undefined, documents: null, truncated: true })])
    expect(wrapper.text()).toContain('too large')
  })

  // User report 2026-10-12: the results as a row of chips above the views "kötü duruyor". One button in
  // the pane's header names the result shown by its command; its list holds the last ones.
  it('lets an earlier result be picked from the history, newest first, each named by its command', async () => {
    const wrapper = mountPane([
      result({
        id: 3,
        value: [{ name: 'orders' }],
        documents: [{ name: 'orders' }],
        resultType: 'ShowCollectionsResult',
        command: 'show collections',
      }),
      result({ id: 2, value: 'second', documents: null, resultType: null, command: 'db.getName()' }),
      result({ command: 'db.orders.find({ status: "paid" })' }),
    ])
    expect(wrapper.find('[data-result-chips]').exists()).toBe(false)
    const trigger = () => wrapper.find('[data-result-history] button')
    expect(trigger().text()).toContain('show collections')
    expect(trigger().attributes('aria-label')).toBe('Result history: #3 show collections')
    await trigger().trigger('click')
    await flushPromises()
    const items = () => [...document.querySelectorAll<HTMLButtonElement>('[data-result-pick]')]
    expect(items().map((i) => i.dataset.resultPick)).toEqual(['3', '2', '1'])
    expect(items().map((i) => i.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
    expect(items()[0]!.textContent).toContain('#3 · Collections · 1 document')
    expect(items()[1]!.textContent).toContain('db.getName()')
    expect(items()[1]!.textContent).toContain('#2 · value')
    expect(items()[2]!.textContent).toContain('db.orders.find({ status: "paid" })')
    expect(items()[2]!.textContent).toContain('#1 · Query · 2 documents')
    items()[2]!.click()
    await flushPromises()
    expect(document.querySelector('[data-result-pick]')).toBeNull()
    expect(trigger().text()).toContain('db.orders.find')
    expect(wrapper.find('[data-result-table]').exists()).toBe(true)
  })

  it('opens the history on the result shown and moves through it with the keys', async () => {
    const wrapper = mountPane([
      result({ id: 3, command: 'a' }),
      result({ id: 2, command: 'b' }),
      result({ command: 'c' }),
    ])
    await wrapper.find('[data-result-history] button').trigger('click')
    await flushPromises()
    await settled()
    const item = (id: number) => document.querySelector<HTMLButtonElement>(`[data-result-pick="${id}"]`)!
    expect(document.activeElement).toBe(item(3))
    item(3).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await flushPromises()
    expect(item(2).getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(item(2))
    item(2).dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    await flushPromises()
    expect(item(1).getAttribute('aria-checked')).toBe('true')
    item(1).dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    await flushPromises()
    expect(item(3).getAttribute('aria-checked')).toBe('true')
    // Round the list, as the views beside it.
    item(3).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    await flushPromises()
    expect(item(1).getAttribute('aria-checked')).toBe('true')
  })

  it('names a result with no command by its kind, a kind it does not know as written', async () => {
    const wrapper = mountPane([
      result({ id: 2, resultType: 'InsertOneResult', value: { acknowledged: true }, documents: null }),
      result({ resultType: 'SomeNewThingResult', value: 1, documents: null }),
    ])
    expect(wrapper.find('[data-result-history] button').text()).toContain('Insert')
    await wrapper.find('[data-result-history] button').trigger('click')
    await flushPromises()
    expect(document.querySelectorAll('[data-result-pick]')[1]!.textContent).toContain('Some New Thing')
  })

  // Review 2026-10-11 (minor 10): the views are a radio group the arrows move through.
  it('moves between the views with the arrows, skipping those a result has not', async () => {
    const wrapper = mountPane([result()])
    const radio = (v: string) => wrapper.find(`[data-view="${v}"]`)
    expect(radio('table').attributes('tabindex')).toBe('0')
    expect(radio('tree').attributes('tabindex')).toBe('-1')
    await wrapper.find('[role="radiogroup"]').trigger('keydown', { key: 'ArrowRight' })
    expect(radio('tree').attributes('aria-checked')).toBe('true')
    await wrapper.find('[role="radiogroup"]').trigger('keydown', { key: 'ArrowLeft' })
    await wrapper.find('[role="radiogroup"]').trigger('keydown', { key: 'ArrowLeft' })
    expect(radio('text').attributes('aria-checked')).toBe('true')
    const plain = mountPane([result({ resultType: null, value: 1, documents: null })])
    await plain.find('[role="radiogroup"]').trigger('keydown', { key: 'ArrowRight' })
    expect(plain.find('[data-view="text"]').attributes('aria-checked')).toBe('true')
  })

  // User report 2026-10-12: "incele butonu koymuşsun ama işlevsiz çalışmıyor".
  it('inspects a document from the table or the tree, read-only, and lets it go with its result', async () => {
    const wrapper = mountPane([result()])
    const inspect = async () => {
      const menu = [
        ...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Actions for document"]'),
      ][0]!
      menu.click()
      await flushPromises()
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (i) => i.textContent?.trim() === 'Inspect',
      )!
      item.click()
      await flushPromises()
      await vi.waitFor(() => expect(document.querySelector('[data-inspector]')).toBeTruthy())
    }
    await inspect()
    const inspector = document.querySelector('[data-inspector]')!
    expect(inspector.textContent).toContain('Ada')
    // Read-only: Fields and JSON, never Edit.
    expect([...inspector.querySelectorAll('[role="tab"]')].map((t) => t.textContent?.trim())).toEqual([
      'Fields',
      'JSON',
    ])
    // Beside a narrow pane it floats over the page; across the whole width it sits beside the rows.
    expect(inspector.classList.contains('fixed')).toBe(true)
    await wrapper.setProps({ wide: true })
    await flushPromises()
    const inline = document.querySelector('[data-inspector]')!
    expect(inline.classList.contains('fixed')).toBe(false)
    expect(inline.parentElement!.hasAttribute('data-result-body')).toBe(true)
    // A new result shown: the inspector goes with the old one.
    await wrapper.setProps({ results: [result({ id: 2 }), result()] })
    await flushPromises()
    expect(document.querySelector('[data-inspector]')).toBeNull()
    await wrapper.find('[data-view="tree"]').trigger('click')
    await inspect()
    expect(document.querySelector('[data-inspector]')!.textContent).toContain('Ada')
  })

  // User report 2026-10-12: "tablo görünümde filtrele butonun da çalışmıyor", in a show collections
  // result too.
  it('filters the result by a cell’s value, says so, and exports what is shown', async () => {
    const wrapper = mountPane([result()])
    const filterBy = (field: string, value: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Filter by"]')]
        .find((b) => b.getAttribute('aria-label') === `Filter by ${field} = ${value}`)!
        .click()
    filterBy('name', '"Ada"')
    await flushPromises()
    const chips = () =>
      [...document.querySelectorAll('[data-result-filter]')].map((c) => c.textContent?.trim())
    expect(chips()).toEqual([expect.stringContaining('name')])
    expect(chips()[0]).toContain('"Ada"')
    expect(wrapper.find('[data-result-filters]').text()).toContain('1 of 2')
    await wrapper.find('[data-view="text"]').trigger('click')
    expect(wrapper.find('[data-result-text]').text()).toContain('Ada')
    expect(wrapper.find('[data-result-text]').text()).not.toContain('Bob')
    await wrapper.find('[data-result-export-json]').trigger('click')
    expect(JSON.parse(downloadMock.mock.calls.at(-1)![0] as string)).toEqual([docs[0]])
    // Taken off: every row again.
    await wrapper.find('[data-result-filter] button').trigger('click')
    expect(wrapper.find('[data-result-filters]').exists()).toBe(false)
    expect(wrapper.find('[data-result-text]').text()).toContain('Bob')
  })

  it('filters a result without _id, as show collections gives, and lets the filters go with it', async () => {
    const collections = [
      { name: 'orders', type: 'collection' },
      { name: 'recent', type: 'view' },
      { name: 'people', type: 'collection' },
    ]
    const wrapper = mountPane([
      result({ resultType: 'ShowCollectionsResult', value: collections, documents: collections }),
    ])
    const button = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Filter by"]')].find(
      (b) => b.getAttribute('aria-label') === 'Filter by type = "collection"',
    )!
    button.click()
    await flushPromises()
    expect(wrapper.find('[data-result-filters]').text()).toContain('2 of 3')
    await wrapper.find('[data-view="text"]').trigger('click')
    expect(wrapper.find('[data-result-text]').text()).not.toContain('recent')
    // Another result: its own rows, no filter carried over.
    await wrapper.setProps({ results: [result({ id: 2 })] })
    expect(wrapper.find('[data-result-filters]').exists()).toBe(false)
  })

  // User report 2026-10-12: "sağ taraftaki sonuçlar kullanımın kullanışsız" — a narrow pane.
  it('asks for the whole width and back', async () => {
    const wrapper = mountPane([result()])
    const toggle = () => wrapper.find('[data-result-wide]')
    const name = toggle().attributes('aria-label')
    expect(toggle().classes()).toContain('max-lg:hidden')
    expect(toggle().attributes('aria-pressed')).toBe('false')
    await toggle().trigger('click')
    expect(wrapper.emitted('wide')).toEqual([[true]])
    await wrapper.setProps({ wide: true })
    // Review 2026-10-12 (M14): one name, the state said by pressed alone.
    expect(toggle().attributes('aria-label')).toBe(name)
    expect(toggle().attributes('aria-pressed')).toBe('true')
    await wrapper.find('[data-result-wide]').trigger('click')
    expect(wrapper.emitted('wide')).toEqual([[true], [false]])
  })

  // Review 2026-10-12 (M15): taking a chip off left the focus nowhere; the count went unsaid.
  it('keeps the focus on the filters as chips are taken off, and says the count', async () => {
    const wrapper = mountPane([result()])
    const filterBy = (field: string, value: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Filter by"]')]
        .find((b) => b.getAttribute('aria-label') === `Filter by ${field} = ${value}`)!
        .click()
    filterBy('name', '"Ada"')
    await flushPromises()
    filterBy('_id', 'ObjectId("0123456789abcdef01234561")')
    await flushPromises()
    expect(wrapper.find('[data-result-filters] [aria-live="polite"]').text()).toContain('1 of 2')
    const removes = () => [...document.querySelectorAll<HTMLButtonElement>('[data-result-filter] button')]
    removes()[0]!.click()
    await flushPromises()
    expect(document.activeElement).toBe(removes()[0])
    removes()[0]!.click()
    await flushPromises()
    expect(document.activeElement).toBe(document.querySelector('[data-view="table"]'))
  })

  it('names a filter on a long value briefly', async () => {
    const long = [{ _id: { $oid: '0123456789abcdef01234561' }, note: 'x'.repeat(500) }]
    mountPane([result({ value: long, documents: long })])
    ;[...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Filter by note"]')][0]!.click()
    await flushPromises()
    const label = document.querySelector('[data-result-filter] button')!.getAttribute('aria-label')!
    expect(label.length).toBeLessThan(120)
    expect(label).toContain('…')
  })

  // Review 2026-10-12 (M17): closing the inspector left the focus on nothing.
  it('gives the focus back to the row it was opened from when the inspector closes', async () => {
    mountPane([result()])
    const menu = document.querySelector<HTMLButtonElement>('button[aria-label^="Actions for document"]')!
    menu.click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((i) => i.textContent?.trim() === 'Inspect')!
      .click()
    await flushPromises()
    await vi.waitFor(() => expect(document.querySelector('[data-inspector]')).toBeTruthy())
    document
      .querySelector<HTMLButtonElement>('[data-inspector] button[aria-label="Close the inspector"]')!
      .click()
    await flushPromises()
    expect(document.querySelector('[data-inspector]')).toBeNull()
    expect(document.activeElement?.getAttribute('aria-label')).toBe(menu.getAttribute('aria-label'))
  })

  // Review 2026-10-12 (I3): rows without an _id (show collections) or with one twice ($unwind) all
  // opened the first row in the inspector.
  it('inspects the row asked for, with or without an _id of its own, and steps through them', async () => {
    const inspectRow = async (n: number) => {
      ;[...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Actions for document"]')][
        n
      ]!.click()
      await flushPromises()
      ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((i) => i.textContent?.trim() === 'Inspect')!
        .click()
      await flushPromises()
      await vi.waitFor(() => expect(document.querySelector('[data-inspector]')).toBeTruthy())
      return document.querySelector('[data-inspector]')!
    }
    const collections = [
      { name: 'orders', type: 'collection' },
      { name: 'recent', type: 'view' },
      { name: 'people', type: 'collection' },
    ]
    const wrapper = mountPane([result({ value: collections, documents: collections })])
    expect((await inspectRow(2)).textContent).toContain('people')
    expect(document.querySelector('[data-inspector]')!.textContent).not.toContain('orders')
    // Up: the row before it.
    document
      .querySelector<HTMLButtonElement>('[data-inspector] button[aria-label="Previous document (↑)"]')!
      .click()
    await flushPromises()
    expect(document.querySelector('[data-inspector]')!.textContent).toContain('recent')
    wrapper.unmount()
    document.body.innerHTML = ''
    const unwound = [
      { _id: { $oid: '0123456789abcdef01234561' }, item: 'first' },
      { _id: { $oid: '0123456789abcdef01234561' }, item: 'second' },
    ]
    mountPane([result({ value: unwound, documents: unwound })])
    expect((await inspectRow(1)).textContent).toContain('second')
  })

  // Review 2026-10-12 (I1, M5, M6): a result is named briefly, by its first line of code, its secrets
  // masked; the whole of it (a few lines, cut) in the tooltip.
  it('names a result briefly by its first line of code, its secrets masked', async () => {
    const long = `db.x.insertMany([${'{ a: 1 }, '.repeat(9000)}])`
    const wrapper = mountPane([
      result({ id: 3, command: "// make the user\ndb.createUser({ user: 'a', pwd: 's3cret', roles: [] })" }),
      result({ id: 2, command: long }),
      result({ command: 'db.a.find()' }),
    ])
    const trigger = wrapper.find('[data-result-history] button')
    expect(trigger.text()).toContain("db.createUser({ user: 'a', pwd: '***'")
    expect(trigger.text()).not.toContain('s3cret')
    expect(trigger.attributes('aria-label')!.length).toBeLessThan(140)
    expect(trigger.attributes('aria-label')).not.toContain('s3cret')
    // The command's first lines, cut, as its tooltip.
    expect(wrapper.find('[data-result-history] [data-result-full]').attributes('title')).toContain(
      '// make the user',
    )
    await trigger.trigger('click')
    await flushPromises()
    // The panel's own name is short.
    expect(document.querySelector('[role="dialog"]')!.getAttribute('aria-label')).toBe('Result history')
    const rows = [...document.querySelectorAll<HTMLElement>('[data-result-pick]')]
    expect(rows[1]!.textContent!.length).toBeLessThan(200)
    expect(rows[1]!.textContent).toContain('…')
    expect(document.body.textContent).not.toContain('s3cret')
  })

  // Review 2026-10-12 (M3): "it" (More) and the other common kinds in words.
  it('names the kinds mongosh gives in words', async () => {
    mountPane([
      result({ id: 3, resultType: 'CursorIterationResult', command: 'it' }),
      result({ id: 2, resultType: 'Help', documents: null, value: 'x' }),
      result({ resultType: 'Database', documents: null, value: 'shop' }),
    ])
    document.querySelector<HTMLButtonElement>('[data-result-history] button')!.click()
    await flushPromises()
    const rows = [...document.querySelectorAll<HTMLElement>('[data-result-pick]')].map((r) => r.textContent)
    expect(rows[0]).toContain('More results')
    expect(rows[1]).toContain('Help')
    expect(rows[2]).toContain('Database')
  })

  // Review 2026-10-12 (M4): results of one number twice (after a reload) are two results.
  it('keeps two results of one number apart, each opened as itself', async () => {
    const wrapper = mountPane([
      result({ id: 3, seq: 5, command: 'newer', value: 'n', documents: null, resultType: null }),
      result({ id: 3, seq: 4, command: 'older', value: 'o', documents: null, resultType: null }),
    ])
    await wrapper.find('[data-result-history] button').trigger('click')
    await flushPromises()
    const rows = [...document.querySelectorAll<HTMLButtonElement>('[data-result-pick]')]
    expect(rows.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false'])
    rows[1]!.click()
    await flushPromises()
    expect(wrapper.find('[data-result-text]').text()).toContain('"o"')
  })

  // Review 2026-10-12 (M7, M8): the arrows wrap, as in the views beside; Alt with an arrow is the browser's.
  it('wraps the arrows around the list, leaving Alt and an arrow to the browser', async () => {
    mountPane([result({ id: 2, command: 'a' }), result({ command: 'b' })])
    document.querySelector<HTMLButtonElement>('[data-result-history] button')!.click()
    await flushPromises()
    await settled()
    const item = (id: number) => document.querySelector<HTMLButtonElement>(`[data-result-pick="${id}"]`)!
    const alt = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      altKey: true,
      bubbles: true,
      cancelable: true,
    })
    item(2).dispatchEvent(alt)
    expect(alt.defaultPrevented).toBe(false)
    expect(item(2).getAttribute('aria-checked')).toBe('true')
    item(2).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    await flushPromises()
    expect(item(1).getAttribute('aria-checked')).toBe('true')
    item(1).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await flushPromises()
    expect(item(2).getAttribute('aria-checked')).toBe('true')
  })
})
