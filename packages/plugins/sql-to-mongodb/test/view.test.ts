// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { Accent, PluginClient, PluginContext } from '../../kit/src/client'
import { AskError } from '../../kit/src/client'
import { mount } from '../src/view'

const flush = () => new Promise((r) => setTimeout(r, 0))
const settle = async () => {
  for (let i = 0; i < 4; i++) await flush()
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Params = Record<string, unknown>
type Handler = (params: Params) => unknown

/** A plugin client answering from `handlers`; `greet` plays the app's greeting. */
function fakeClient(
  place: PluginContext['place'],
  handlers: Record<string, Handler>,
  kind = place ? 'collectionTab' : 'sidebarPanel',
) {
  const calls: Array<{ method: string; params: Params }> = []
  let ready: (() => void) | null = null
  const contexts: Array<(l: string, t: 'light' | 'dark', a: Accent) => void> = []
  const client: PluginClient = {
    contribution: { kind, id: 'sql' },
    ask: async <T>(method: string, params?: unknown) => {
      calls.push({ method, params: params as Params })
      if (method === 'context.get')
        return {
          plugin: { id: 'sql-to-mongodb', version: '1' },
          contribution: { kind, id: 'sql' },
          locale: 'en',
          theme: 'light',
          accent: 'violet',
          place,
          settings: {},
        } as T
      const handler = handlers[method]
      if (!handler) throw new AskError('not_permitted', `no ${method}`)
      return (await handler(params as Params)) as T
    },
    onReady: (fn) => (ready = fn),
    onContext: (fn) => contexts.push(fn),
    onCells: () => {},
  }
  return { client, calls, greet: () => ready!(), contexts }
}

const PLACE = { connectionId: 'c', connectionName: 'Shop', db: 'shop', coll: 'users', documentId: null }
const USERS = [
  { _id: { $oid: '65a1b2c3d4e5f60718293a01' }, name: 'Ada', age: { $numberInt: '36' }, city: 'Izmir' },
  { _id: { $oid: '65a1b2c3d4e5f60718293a02' }, name: '<img src=x onerror=alert(1)>', age: 41 },
]
const app = () => document.getElementById('app')!
const sql = () => document.getElementById('sql') as HTMLTextAreaElement
const runButton = () => document.getElementById('run') as HTMLButtonElement | null
const results = () => document.getElementById('results')!
const reads = (calls: Array<{ method: string; params: Params }>) =>
  calls.filter((c) => c.method.startsWith('documents.'))
const type = (value: string) => {
  sql().value = value
  sql().dispatchEvent(new Event('input'))
}
const ctrlEnter = (target: EventTarget, meta = false) =>
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: !meta,
      metaKey: meta,
      bubbles: true,
      cancelable: true,
    }),
  )

async function opened(place: PluginContext['place'] = PLACE, handlers: Record<string, Handler> = {}) {
  const fake = fakeClient(place, handlers)
  mount(app(), fake.client)
  fake.greet()
  await settle()
  return fake
}

beforeEach(() => {
  document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
})

describe('SQL to MongoDB, redesigned (plugin tabs redesign §2.2)', () => {
  it('starts with a SELECT of the open collection, translated', async () => {
    await opened()
    expect(sql().value).toBe('SELECT * FROM users LIMIT 20')
    expect(document.getElementById('code')!.textContent).toBe('db.getCollection("users").find({}).limit(20)')
    expect(document.getElementById('kind')!.textContent).toBe('find')
    expect(document.querySelector('h1')!.textContent).toBe('SQL to MongoDB')
    expect(document.querySelector('.mm-head-desc')!.textContent).toContain('users')
  })

  it('never puts its first SELECT before what was typed while the app was answering', async () => {
    // e2e 2026-10-10: the editor read "SELECT * FROM people LIMIT 20SELECT name, age…".
    const fake = fakeClient(PLACE, {})
    mount(app(), fake.client)
    sql().focus()
    sql().value = 'SELECT name FROM users'
    sql().dispatchEvent(new InputEvent('input', { inputType: 'insertText' }))
    fake.greet()
    await settle()
    expect(sql().value).toBe('SELECT name FROM users')
    expect(document.getElementById('code')!.textContent).toContain('name: 1')
  })

  it('leaves an empty editor the user is in empty', async () => {
    const fake = fakeClient(PLACE, {})
    mount(app(), fake.client)
    sql().focus()
    fake.greet()
    await settle()
    expect(sql().value).toBe('')
  })

  it('runs a find in this collection and shows its rows as text', async () => {
    const { calls } = await opened(PLACE, { 'documents.find': () => ({ documents: USERS, hasMore: false }) })
    type('SELECT name, age FROM users WHERE age > 30 ORDER BY name LIMIT 20')
    runButton()!.click()
    await settle()
    expect(reads(calls)).toEqual([
      {
        method: 'documents.find',
        params: {
          filter: { age: { $gt: { $numberInt: '30' } } },
          projection: { name: { $numberInt: '1' }, age: { $numberInt: '1' }, _id: { $numberInt: '0' } },
          sort: { name: { $numberInt: '1' } },
          limit: 20,
        },
      },
    ])
    const headers = [...results().querySelectorAll('th')].map((th) => th.textContent)
    expect(headers).toEqual(['#', '_id', 'name', 'age', 'city', ''])
    const rows = results().querySelectorAll('tbody tr')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.querySelector('[data-kind="number"]')!.textContent).toBe('36')
    expect(results().querySelector('img')).toBeNull()
    expect(rows[1]!.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(document.getElementById('status')!.textContent).toMatch(/^2 rows · \d+ ms$/)
  })

  it('opens a row’s document from a find', async () => {
    const { calls } = await opened(PLACE, {
      'documents.find': () => ({ documents: USERS, hasMore: false }),
      'ui.openDocument': () => true,
    })
    runButton()!.click()
    await settle()
    results().querySelector<HTMLButtonElement>('tbody tr button')!.click()
    await settle()
    expect(calls.at(-1)).toEqual({ method: 'ui.openDocument', params: { id: USERS[0]!._id } })
  })

  it('runs a pipeline as documents.aggregate, at most 50 rows, read-only stages only', async () => {
    const { calls } = await opened(PLACE, {
      // A group's row is not a document of the collection, whatever its _id: nothing to open.
      'documents.aggregate': () => ({ documents: [{ _id: 1, city: 'Izmir', n: 2 }], truncated: false }),
    })
    type('SELECT city, COUNT(*) AS n FROM users GROUP BY city')
    runButton()!.click()
    await settle()
    expect(reads(calls)).toEqual([
      {
        method: 'documents.aggregate',
        params: {
          pipeline: [
            { $group: { _id: { city: '$city' }, n: { $sum: { $numberInt: '1' } } } },
            { $project: { _id: { $numberInt: '0' }, city: '$_id.city', n: '$n' } },
          ],
          limit: 50,
        },
      },
    ])
    expect(document.getElementById('kind')!.textContent).toBe('aggregation pipeline')
    expect(results().querySelectorAll('tbody tr')).toHaveLength(1)
    expect(results().querySelector('tbody tr button')).toBeNull()
  })

  it('says when more rows match than it shows', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ _id: i, n: i }))
    await opened(PLACE, { 'documents.find': () => ({ documents: many, hasMore: true }) })
    type('SELECT * FROM users')
    runButton()!.click()
    await settle()
    expect(results().querySelectorAll('tbody tr')).toHaveLength(50)
    expect(document.getElementById('status')!.textContent).toContain('First 50 rows')
  })

  it('does not say more match when the query itself asked for fewer than 50', async () => {
    await opened(PLACE, { 'documents.find': () => ({ documents: USERS, hasMore: true }) })
    runButton()!.click()
    await settle()
    expect(document.getElementById('status')!.textContent).toMatch(/^2 rows · \d+ ms$/)
  })

  it('refuses a query of another collection, saying which it belongs to', async () => {
    const { calls } = await opened(PLACE, { 'documents.find': () => ({ documents: USERS }) })
    type('SELECT * FROM customers WHERE city = "Izmir"')
    runButton()!.click()
    await settle()
    expect(reads(calls)).toEqual([])
    const note = results().querySelector('.mm-callout-warning')!
    expect(note.textContent).toContain('customers')
    expect(note.textContent).toContain('users')
  })

  it('runs a JOIN here and shows the joined fields as columns (user request 2026-10-10)', async () => {
    const { calls } = await opened(PLACE, {
      'documents.aggregate': () => ({
        documents: [{ name: 'Ada', o: { orderNo: 'ORD-1', total: { $numberDecimal: '234.20' } } }],
      }),
    })
    type('SELECT u.name, o.orderNo, o.total FROM users u JOIN orders o ON u._id = o.userId')
    runButton()!.click()
    await settle()
    expect(reads(calls)).toHaveLength(1)
    expect(reads(calls)[0]!.method).toBe('documents.aggregate')
    expect((reads(calls)[0]!.params.pipeline as Array<Record<string, unknown>>)[0]).toEqual({
      $lookup: { from: 'orders', localField: '_id', foreignField: 'userId', as: 'o' },
    })
    const heads = [...results().querySelectorAll('th')].map((t) => t.textContent)
    expect(heads).toEqual(['#', 'u.name', 'o.orderNo', 'o.total'])
    expect(results().textContent).toContain('ORD-1')
    expect(results().textContent).toContain('234.20')
    expect(results().textContent).not.toContain('Open the pipeline in Aggregations')
    // Where a joined column comes from, on its heading (user request 2026-10-10).
    const total = [...results().querySelectorAll('th')].find((t) => t.textContent!.startsWith('o.total'))!
    expect(total.querySelector('[data-note]')!.getAttribute('data-note')).toBe('orders.total')
    // The open collection's columns too, as the SELECT writes them (user request 2026-10-10).
    const name = [...results().querySelectorAll('th')].find((t) => t.textContent!.startsWith('u.name'))!
    expect(name.querySelector('[data-note]')!.getAttribute('data-note')).toBe('users.name')
  })

  it('shows why a run failed', async () => {
    await opened(PLACE, {
      'documents.find': () => {
        throw new AskError('not_permitted', 'no')
      },
    })
    runButton()!.click()
    await settle()
    expect(results().querySelector('.mm-callout-danger')!.textContent).toContain(
      'The plugin is not allowed to do this.',
    )
  })

  it('runs on Ctrl+Enter and Cmd+Enter from the editor', async () => {
    const { calls } = await opened(PLACE, { 'documents.find': () => ({ documents: USERS, hasMore: false }) })
    ctrlEnter(sql())
    await settle()
    expect(reads(calls)).toHaveLength(1)
    ctrlEnter(sql(), true)
    await settle()
    expect(reads(calls)).toHaveLength(2)
  })

  it('runs what was typed, not waiting for the translation to catch up', async () => {
    const { calls } = await opened(PLACE, { 'documents.find': () => ({ documents: [], hasMore: false }) })
    type("SELECT * FROM users WHERE city = 'Izmir'")
    ctrlEnter(sql())
    await settle()
    expect(reads(calls)[0]!.params.filter).toEqual({ city: 'Izmir' })
    expect(results().textContent).toContain('No rows')
  })

  it('marks the result as out of date once the query changes', async () => {
    await opened(PLACE, { 'documents.find': () => ({ documents: USERS, hasMore: false }) })
    runButton()!.click()
    await settle()
    const stale = document.getElementById('stale')!
    expect(stale.hidden).toBe(true)
    type('SELECT name FROM users')
    expect(stale.hidden).toBe(false)
  })

  it('clears a run’s results back to the empty state (user request 2026-10-10)', async () => {
    await opened(PLACE, { 'documents.find': () => ({ documents: USERS, hasMore: false }) })
    const clear = () => document.getElementById('clear-results') as HTMLButtonElement
    const status = document.getElementById('status')!
    const stale = document.getElementById('stale')!
    // Nothing to clear before a run.
    expect(clear().hidden).toBe(true)
    runButton()!.click()
    await settle()
    expect(clear().hidden).toBe(false)
    expect(clear().textContent).toContain('Clear')
    expect(clear().querySelector('svg')).not.toBeNull()
    // The editor emptied: the rows stay, and so does the way to clear them.
    type('   ')
    expect(results().querySelectorAll('tbody tr')).toHaveLength(2)
    expect(stale.hidden).toBe(false)
    expect(clear().hidden).toBe(false)
    clear().click()
    expect(results().querySelector('tbody tr')).toBeNull()
    expect(results().textContent).toContain('Run the query to see what it returns')
    expect(status.textContent).toBe('')
    expect(stale.hidden).toBe(true)
    expect(clear().hidden).toBe(true)
  })

  it('clears a failed run too, and names Clear in the user’s language', async () => {
    const fake = await opened(PLACE, {
      'documents.find': () => {
        throw new AskError('not_permitted', 'no')
      },
    })
    const clear = () => document.getElementById('clear-results') as HTMLButtonElement
    runButton()!.click()
    await settle()
    expect(results().querySelector('.mm-callout-danger')).not.toBeNull()
    fake.contexts[0]!('tr', 'light', 'violet')
    expect(clear().hidden).toBe(false)
    expect(clear().textContent).toContain('Temizle')
    clear().click()
    expect(results().querySelector('.mm-callout-danger')).toBeNull()
    expect(results().textContent).toContain('Ne döndürdüğünü görmek için sorguyu çalıştırın')
    expect(clear().hidden).toBe(true)
  })

  it('has nothing to run in an empty editor', async () => {
    const { calls } = await opened(PLACE, { 'documents.find': () => ({ documents: USERS, hasMore: false }) })
    expect(runButton()!.disabled).toBe(false)
    type('  \n ')
    // At once, not after the translation's pause.
    expect(runButton()!.disabled).toBe(true)
    ctrlEnter(sql())
    await wait(220)
    expect(runButton()!.disabled).toBe(true)
    expect(reads(calls)).toEqual([])
    type('SELECT * FROM users')
    await wait(220)
    expect(runButton()!.disabled).toBe(false)
  })

  it('translates only in the sidebar with no collection: no Run, a hint instead', async () => {
    const { calls } = await opened(null)
    expect(runButton() === null || runButton()!.hidden).toBe(true)
    expect(app().textContent).toContain('Open a collection to run the query')
    ctrlEnter(sql())
    await settle()
    expect(reads(calls)).toEqual([])
    expect(document.getElementById('code')!.textContent).toContain('db.getCollection("users")')
  })

  it('fills the editor from Examples, in the collection’s own fields', async () => {
    const { calls } = await opened(PLACE, {
      'documents.find': () => ({ documents: USERS, hasMore: false }),
    })
    const examples = document.getElementById('examples') as HTMLButtonElement
    examples.click()
    await settle()
    // One sample serves the examples and the suggestions.
    expect(reads(calls)).toEqual([{ method: 'documents.find', params: { filter: {}, limit: 100 } }])
    expect(examples.getAttribute('aria-expanded')).toBe('true')
    const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    expect(items.map((i) => i.querySelector('.sq-menu-label')!.textContent)).toEqual([
      'Filter, sort and limit',
      'Count by group',
      'Total and average by group',
      'Text pattern (LIKE)',
      'One of a list (IN)',
      'Join another collection',
    ])
    items[1]!.click()
    expect(sql().value).toBe('SELECT name, COUNT(*) AS n\nFROM users\nGROUP BY name\nORDER BY n DESC')
    expect(document.getElementById('code')!.textContent).toContain('$group')
    expect(document.getElementById('examples-menu')!.hidden).toBe(true)
    // The sample is read once.
    examples.click()
    await settle()
    expect(reads(calls)).toHaveLength(1)
  })

  it('closes Examples on Escape', async () => {
    await opened(PLACE, { 'documents.find': () => ({ documents: [] }) })
    ;(document.getElementById('examples') as HTMLButtonElement).click()
    await settle()
    const menu = document.getElementById('examples-menu')!
    expect(menu.hidden).toBe(false)
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(menu.hidden).toBe(true)
  })

  it('says where the SQL is wrong, by line and column, and marks it', async () => {
    await opened()
    type('SELECT *\nFROM users\nWHERE a = = 1')
    await wait(1300)
    const error = document.querySelector('#error .mm-callout-danger')!
    expect(error.textContent).toContain('A value is expected here')
    expect(error.textContent).toContain('Line 3, column 11')
    expect(error.querySelector('mark')!.textContent).toBe('=')
    expect(sql().getAttribute('aria-invalid')).toBe('true')
    expect(runButton()!.disabled).toBe(true)
    ;[...error.querySelectorAll('button')].find((b) => b.textContent === 'Show in the editor')!.click()
    expect(sql().selectionStart).toBe(30)
    expect(sql().selectionEnd).toBe(31)
    type('SELECT * FROM users')
    await wait(220)
    expect(document.querySelector('#error .mm-callout-danger')).toBeNull()
    expect(sql().getAttribute('aria-invalid')).toBe('false')
  })

  it('waits for a pause before saying the SQL is wrong, keeping the last code meanwhile', async () => {
    await opened()
    const before = document.getElementById('code')!.textContent
    type('SELECT * FROM users WHERE st')
    await wait(400)
    // Still being typed: no error yet, the last good code stays.
    expect(document.querySelector('#error .mm-callout-danger')).toBeNull()
    expect(sql().getAttribute('aria-invalid')).toBe('false')
    expect(document.getElementById('code')!.textContent).toBe(before)
    await wait(900)
    expect(document.querySelector('#error .mm-callout-danger')).not.toBeNull()
    expect(document.getElementById('code')!.textContent).toBe('')
  })

  it('keeps the error back while suggestions are open', async () => {
    await opened(PLACE, { 'documents.find': () => ({ documents: USERS, hasMore: false }) })
    sql().focus()
    await settle()
    sql().value = 'SELECT * FROM users WHERE ag'
    sql().setSelectionRange(sql().value.length, sql().value.length)
    sql().dispatchEvent(new InputEvent('input', { inputType: 'insertText' }))
    expect(document.getElementById('sql-complete')!.hidden).toBe(false)
    await wait(1300)
    expect(document.querySelector('#error .mm-callout-danger')).toBeNull()
    sql().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await wait(1000)
    expect(document.querySelector('#error .mm-callout-danger')).not.toBeNull()
  })

  it('says at once why a query cannot run when Run is pressed', async () => {
    await opened()
    type('SELECT * FROM users WHERE st')
    ctrlEnter(sql())
    await settle()
    expect(document.querySelector('#error .mm-callout-danger')).not.toBeNull()
  })

  it('keeps the query and its rows when the code language changes', async () => {
    await opened(PLACE, { 'documents.find': () => ({ documents: USERS, hasMore: false }) })
    runButton()!.click()
    await settle()
    ;[...document.querySelectorAll<HTMLButtonElement>('#languages button')]
      .find((b) => b.textContent === 'Python')!
      .click()
    expect(document.getElementById('code')!.textContent).toContain('pymongo')
    expect(sql().value).toBe('SELECT * FROM users LIMIT 20')
    expect(results().querySelectorAll('tbody tr')).toHaveLength(2)
  })

  it('puts a find in Documents and copies the code, as before', async () => {
    const { calls } = await opened(PLACE, { 'ui.useQuery': () => true, 'ui.copy': () => true })
    type("SELECT name FROM users WHERE city = 'Izmir' ORDER BY name")
    await wait(220)
    ;(document.getElementById('use') as HTMLButtonElement).click()
    await settle()
    expect(calls.at(-1)).toEqual({
      method: 'ui.useQuery',
      params: {
        filter: { city: 'Izmir' },
        projection: { name: { $numberInt: '1' }, _id: { $numberInt: '0' } },
        sort: { name: { $numberInt: '1' } },
      },
    })
    expect(document.getElementById('note')!.textContent).toBe('Done: see the collection.')
    ;(document.getElementById('copy') as HTMLButtonElement).click()
    await settle()
    expect(calls.at(-1)).toEqual({
      method: 'ui.copy',
      params: { text: document.getElementById('code')!.textContent },
    })
  })

  it('follows the app’s language and accent, keeping what is shown', async () => {
    const { contexts } = await opened(PLACE, {
      'documents.find': () => ({ documents: USERS, hasMore: false }),
    })
    expect(document.documentElement.dataset.accent).toBe('violet')
    runButton()!.click()
    await settle()
    contexts[0]!('tr', 'dark', 'rose')
    expect(document.documentElement.dataset.accent).toBe('rose')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.querySelector('h1')!.textContent).toBe('SQL → MongoDB')
    expect(runButton()!.textContent).toContain('Çalıştır')
    expect(document.getElementById('status')!.textContent).toMatch(/^2 satır/)
  })
})

describe('suggestions while typing (user request 2026-10-10)', () => {
  const ORDERS = [
    { _id: { $oid: '65a1b2c3d4e5f60718293a01' }, status: 'shipped', city: 'Ankara', total: 5 },
    { _id: { $oid: '65a1b2c3d4e5f60718293a02' }, status: 'paid', city: '<b>Izmir</b>', total: 7 },
  ]
  const ORDERS_PLACE = { ...PLACE, coll: 'orders' }
  const list = () => document.getElementById('sql-complete')!
  const options = () => [...list().querySelectorAll<HTMLElement>('[role="option"]')]
  const labelsShown = () => options().map((o) => o.querySelector('.sq-option-label')!.textContent)
  /** Types `value` with the caret at its end, as a keystroke does. */
  const typeAt = (value: string, inputType = 'insertText') => {
    sql().value = value
    sql().setSelectionRange(value.length, value.length)
    sql().dispatchEvent(new InputEvent('input', { inputType }))
  }
  const key = (k: string, more: KeyboardEventInit = {}) =>
    sql().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...more }))
  async function editing(place: PluginContext['place'] = ORDERS_PLACE) {
    const fake = await opened(place, { 'documents.find': () => ({ documents: ORDERS, hasMore: false }) })
    sql().focus()
    await settle()
    return fake
  }

  it('reads a sample once the editor has the focus, never before', async () => {
    const fake = fakeClient(ORDERS_PLACE, { 'documents.find': () => ({ documents: ORDERS, hasMore: false }) })
    mount(app(), fake.client)
    fake.greet()
    await settle()
    expect(reads(fake.calls)).toEqual([])
    sql().focus()
    await settle()
    sql().blur()
    sql().focus()
    await settle()
    expect(reads(fake.calls)).toEqual([{ method: 'documents.find', params: { filter: {}, limit: 100 } }])
  })

  it('offers WHERE as it is typed, and takes it with Enter', async () => {
    await editing()
    typeAt('SELECT * FROM orders Wh')
    expect(list().hidden).toBe(false)
    expect(labelsShown()).toEqual(['WHERE'])
    expect(sql().getAttribute('aria-expanded')).toBe('true')
    key('Enter')
    expect(sql().value).toBe('SELECT * FROM orders WHERE ')
    // …then the collection's fields, at once.
    expect(labelsShown()).toEqual(expect.arrayContaining(['status', 'city', 'total']))
  })

  it('finds status for "st" from the collection, and its values after "="', async () => {
    await editing()
    typeAt('SELECT * FROM orders WHERE st')
    expect(labelsShown()[0]).toBe('status')
    key('Tab')
    expect(sql().value).toBe('SELECT * FROM orders WHERE status ')
    typeAt('SELECT * FROM orders WHERE status = ')
    expect(labelsShown()).toEqual(["'shipped'", "'paid'"])
    key('ArrowDown')
    expect(sql().getAttribute('aria-activedescendant')).toBe(options()[1]!.id)
    key('Enter')
    expect(sql().value).toBe("SELECT * FROM orders WHERE status = 'paid' ")
  })

  it('shows a value as text, never as markup', async () => {
    await editing()
    typeAt('SELECT * FROM orders WHERE city = ')
    expect(list().querySelector('b')).toBeNull()
    expect(labelsShown()).toContain("'<b>Izmir</b>'")
  })

  it('lets Enter make a new line where the list opened by itself', async () => {
    await editing()
    typeAt('SELECT * FROM orders WHERE ')
    expect(list().hidden).toBe(false)
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    sql().dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(false)
    expect(list().hidden).toBe(true)
    expect(sql().value).toBe('SELECT * FROM orders WHERE ')
  })

  it('lets Tab move on where the list opened by itself; takes an item typed or chosen', async () => {
    await editing()
    typeAt('SELECT * FROM orders WHERE ')
    expect(list().hidden).toBe(false)
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    sql().dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(false)
    expect(list().hidden).toBe(true)
    expect(sql().value).toBe('SELECT * FROM orders WHERE ')
    // Chosen with the arrows: Tab takes it.
    typeAt('SELECT * FROM orders WHERE ')
    key('ArrowDown')
    const chosenTab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    sql().dispatchEvent(chosenTab)
    expect(chosenTab.defaultPrevented).toBe(true)
    expect(sql().value).not.toBe('SELECT * FROM orders WHERE ')
    // Typed: Tab takes the first.
    typeAt('SELECT * FROM orders WHERE st')
    key('Tab')
    expect(sql().value).toBe('SELECT * FROM orders WHERE status ')
  })

  it('is a combobox to a screen reader, its list the suggestions', async () => {
    await editing()
    expect(sql().getAttribute('role')).toBe('combobox')
    expect(sql().getAttribute('aria-multiline')).toBe('true')
    expect(sql().getAttribute('aria-controls')).toBe('sql-complete')
    expect(sql().getAttribute('aria-autocomplete')).toBe('list')
  })

  it('closes on Escape without leaving the page, and opens again on Ctrl+Space', async () => {
    await editing()
    typeAt('SELECT * FROM orders WHERE st')
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    let reached = false
    document.addEventListener('keydown', () => (reached = true), { once: true })
    sql().dispatchEvent(escape)
    expect(list().hidden).toBe(true)
    expect(reached).toBe(false)
    key(' ', { ctrlKey: true })
    await settle()
    expect(labelsShown()[0]).toBe('status')
  })

  it('takes an item clicked, keeping the focus in the editor', async () => {
    await editing()
    typeAt('SELECT * FROM orders WHERE ci')
    const city = options().find((o) => o.textContent!.startsWith('city'))!
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    city.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    expect(sql().value).toBe('SELECT * FROM orders WHERE city ')
  })

  it('does not open while deleting, nor offer keywords before a letter is typed', async () => {
    await editing()
    typeAt('SELECT * FROM orders WHERE st', 'deleteContentBackward')
    expect(list().hidden).toBe(true)
    typeAt("SELECT * FROM orders WHERE status = 'paid' ")
    expect(list().hidden).toBe(true)
    typeAt("SELECT * FROM orders WHERE status = 'paid' a")
    expect(labelsShown()).toContain('AND')
  })

  it('offers keywords only where no collection is open, reading nothing', async () => {
    const fake = await opened(null)
    sql().focus()
    await settle()
    typeAt('SELECT name FROM users WH')
    expect(labelsShown()).toEqual(['WHERE'])
    expect(reads(fake.calls)).toEqual([])
  })

  it('names the kind of each suggestion in the user’s language', async () => {
    const fake = await editing()
    fake.contexts[0]!('tr', 'light', 'emerald')
    sql().focus()
    typeAt('SELECT * FROM orders WHERE st')
    expect(options()[0]!.querySelector('.sq-option-kind')!.textContent).toBe('alan')
    expect(list().getAttribute('aria-label')).toBe('Öneriler')
    typeAt('SELECT * FROM orders Wh')
    expect(options()[0]!.querySelector('.sq-option-kind')!.textContent).toBe('anahtar sözcük')
  })
})

describe('formatting the SQL (user request 2026-10-10)', () => {
  const formatButton = () => document.getElementById('format') as HTMLButtonElement
  const code = () => document.getElementById('code')!.textContent

  it('formats the editor from its button, meaning the same', async () => {
    await opened()
    type("select name, age from users where age > 30 and city = 'Izmir' order by name")
    await wait(200)
    const before = code()
    formatButton().click()
    expect(sql().value).toBe(
      [
        'SELECT',
        '  name,',
        '  age',
        'FROM users',
        'WHERE age > 30',
        "  AND city = 'Izmir'",
        'ORDER BY name',
      ].join('\n'),
    )
    await wait(200)
    expect(code()).toBe(before)
    expect(document.getElementById('sql-complete')!.hidden).toBe(true)
  })

  it('formats on Shift+Alt+F in the editor', async () => {
    await opened()
    type('select * from users where a = 1 or b = 2')
    sql().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Ï',
        code: 'KeyF',
        shiftKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    expect(sql().value).toBe(['SELECT *', 'FROM users', 'WHERE a = 1', '  OR b = 2'].join('\n'))
  })

  it('leaves SQL it cannot read as it is, saying why', async () => {
    await opened()
    type("select * from users where a = 'open")
    formatButton().click()
    expect(sql().value).toBe("select * from users where a = 'open")
    expect(document.querySelector('#error .mm-callout-danger')).not.toBeNull()
  })

  it('names its button in the user’s language', async () => {
    const fake = await opened()
    expect(formatButton().textContent).toContain('Format')
    fake.contexts[0]!('tr', 'light', 'emerald')
    expect(formatButton().textContent).toContain('Biçimlendir')
    expect(formatButton().title).toContain('Shift+Alt+F')
  })
})

describe('the SQL joins review (2026-10-10)', () => {
  it('does not call the results out of date after a Format that kept the query (M7)', async () => {
    await opened(PLACE, { 'documents.find': () => ({ documents: USERS, hasMore: false }) })
    type('select name, age from users where age > 30')
    runButton()!.click()
    await settle()
    ;(document.getElementById('format') as HTMLButtonElement).click()
    expect(document.getElementById('stale')!.hidden).toBe(true)
    type('select name from users')
    expect(document.getElementById('stale')!.hidden).toBe(false)
  })

  it('formats on Shift+Alt+F by the letter too, on keyboards where F lies elsewhere (M9)', async () => {
    await opened()
    type('select * from users where a = 1')
    sql().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'F',
        code: 'KeyA',
        shiftKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    expect(sql().value).toContain('\nFROM users')
  })

  it('keeps Open for a document whose _id is an object (I3)', async () => {
    await opened(PLACE, {
      'documents.find': () => ({
        documents: [{ _id: { a: 1, b: 2 }, name: 'Ada', address: { city: 'Izmir' } }],
      }),
    })
    type('SELECT * FROM users')
    runButton()!.click()
    await settle()
    const heads = [...results().querySelectorAll('th')].map((t) => t.textContent)
    expect(heads).toEqual(['#', '_id', 'name', 'address', ''])
    expect([...results().querySelectorAll('button')].map((b) => b.textContent)).toContain('Open')
  })
})

describe('the SQL in colours (user request 2026-10-10)', () => {
  const shade = () => document.querySelector('.sq-shade')!
  /** The coloured copy says exactly what the editor holds (a space ends an empty last line). */
  const same = () => expect(shade().textContent!.replace(/ $/, '')).toBe(sql().value.replace(/ $/, ''))

  it('draws the editor’s SQL in colours, under its own text, and keeps up with it', async () => {
    await opened()
    expect(shade().getAttribute('aria-hidden')).toBe('true')
    same()
    type("select name from users where city = 'Izmir' -- note")
    same()
    expect(shade().querySelector('.hl-keyword')!.textContent).toBe('select')
    expect(shade().querySelector('.hl-string')!.textContent).toBe("'Izmir'")
    expect(shade().querySelector('.hl-comment')!.textContent).toBe('-- note')
    ;(document.getElementById('format') as HTMLButtonElement).click()
    same()
  })

  it('keeps up when a suggestion is taken', async () => {
    await opened(PLACE, { 'documents.find': () => ({ documents: USERS, hasMore: false }) })
    sql().focus()
    await settle()
    sql().value = 'SELECT * FROM users WHERE ci'
    sql().setSelectionRange(sql().value.length, sql().value.length)
    sql().dispatchEvent(new InputEvent('input', { inputType: 'insertText' }))
    sql().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(sql().value).toBe('SELECT * FROM users WHERE city ')
    same()
  })

  it('shows what was typed as text, never as markup', async () => {
    await opened()
    type("select '<img src=x onerror=alert(1)>' from users")
    expect(shade().querySelector('img')).toBeNull()
    same()
  })

  it('colours the MongoDB code too, its text unchanged', async () => {
    await opened()
    type("select name from users where city = 'Izmir'")
    await wait(200)
    const code = document.getElementById('code')!
    expect(code.textContent).toBe(
      'db.getCollection("users").find(\n  { city: "Izmir" },\n  { name: 1, _id: 0 }\n)',
    )
    expect(code.querySelector('.hl-string')!.textContent).toBe('"users"')
    expect(code.querySelector('.hl-key')!.textContent).toBe('city')
  })
})

describe('a join’s headings, reviewed (2026-10-10)', () => {
  it('opens a nested field of the open collection into its own headed column', async () => {
    await opened(PLACE, {
      'documents.aggregate': () => ({ documents: [{ shipping: { city: 'Izmir' }, c: { name: 'Ada' } }] }),
    })
    type('SELECT u.shipping.city, c.name FROM users u JOIN customers c ON u.cid = c._id')
    runButton()!.click()
    await settle()
    const heads = [...results().querySelectorAll('th')].map((t) => t.textContent)
    expect(heads).toEqual(['#', 'u.shipping.city', 'c.name'])
    expect(results().querySelector('tbody')!.textContent).toContain('Izmir')
  })
})

// User request 2026-10-11: SQL files are imported and exported on the app's own SQL ↔ MongoDB page;
// a collection's SQL tab only translates and runs SELECTs.
describe('SQL files are not the tab’s', () => {
  it('offers no import or export on a collection', async () => {
    await opened(PLACE)
    expect(document.getElementById('import-sql')).toBeNull()
    expect(document.getElementById('export-sql')).toBeNull()
  })
})
