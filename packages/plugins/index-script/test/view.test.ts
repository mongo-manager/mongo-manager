// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { Accent, PluginClient, PluginContext } from '../../kit/src/client'
import { AskError } from '../../kit/src/client'
import { mount } from '../src/view'

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}
type Params = { coll?: string; text?: string; type?: string; name?: string }
type Handler = (params: Params) => unknown

function fakeClient(place: PluginContext['place'], handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; params: Params }> = []
  let ready: (() => void) | null = null
  const contexts: Array<(l: string, t: 'light' | 'dark', a: Accent) => void> = []
  const client: PluginClient = {
    contribution: { kind: 'collectionTab', id: 'script' },
    ask: async <T>(method: string, params?: unknown) => {
      calls.push({ method, params: params as Params })
      if (method === 'context.get')
        return {
          plugin: { id: 'index-script', version: '1' },
          contribution: { kind: 'collectionTab', id: 'script' },
          locale: 'en',
          theme: 'light',
          accent: 'violet',
          place,
          settings: {},
        } as T
      return (await handlers[method]!(params as Params)) as T
    },
    onReady: (fn) => (ready = fn),
    onContext: (fn) => contexts.push(fn),
    onCells: () => {},
  }
  return { client, calls, greet: () => ready!(), contexts }
}

const int = (n: number) => ({ $numberInt: String(n) })
const PLACE = { connectionId: 'c', connectionName: 'Shop', db: 'shop', coll: 'orders', documentId: null }
const ID = { name: '_id_', key: { _id: int(1) }, options: {}, usage: null }
const INDEXES: Record<string, unknown[]> = {
  orders: [ID, { name: 'customerId_1', key: { customerId: int(1) }, options: { unique: true }, usage: null }],
  users: [ID, { name: 'email_1', key: { email: int(1) }, options: {}, usage: null }],
  empty: [ID],
}
const app = () => document.getElementById('app')!
const script = () => document.getElementById('script')!.textContent!
const pick = async (group: string, label: string) => {
  ;[...document.querySelectorAll<HTMLButtonElement>(`#${group} button`)]
    .find((b) => b.textContent === label)!
    .click()
  await flush()
}

beforeEach(() => {
  document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
})

describe('the Index script tab', () => {
  it('writes the collection’s indexes in mongosh on opening, the _id index left out', async () => {
    const { client, greet } = fakeClient(PLACE, { 'indexes.list': (p) => INDEXES[p?.coll ?? 'orders'] })
    mount(app(), client)
    greet()
    await flush()
    expect(script()).toBe(
      'db.getCollection("orders").createIndex({ customerId: 1 }, { name: "customerId_1", unique: true })\n',
    )
    expect(document.getElementById('status')!.textContent).toBe('1 index in 1 collection')
    expect(app().textContent).toContain(
      'The default _id index (or a clustered one) is made with its collection',
    )
  })

  it('writes the whole database’s, views left out, and says which could not be read', async () => {
    const { client, greet, calls } = fakeClient(PLACE, {
      'indexes.list': (p) => {
        if (p?.coll === 'secret') throw new AskError('failed', 'MongoDB denied this operation')
        return INDEXES[p?.coll ?? 'orders']
      },
      'collections.list': () => [
        { name: 'orders', type: 'collection' },
        { name: 'users', type: 'collection' },
        { name: 'recent', type: 'view' },
        { name: 'secret', type: 'collection' },
      ],
    })
    mount(app(), client)
    greet()
    await flush()
    await pick('scope', 'The whole database')
    expect(calls.filter((c) => c.method === 'indexes.list').map((c) => c.params?.coll)).toEqual([
      undefined,
      'orders',
      'users',
      'secret',
    ])
    expect(script()).toContain('db.getCollection("users").createIndex({ email: 1 }, { name: "email_1" })')
    expect(document.getElementById('status')!.textContent).toBe('2 indexes in 2 collections')
    expect(document.getElementById('notes')!.textContent).toContain(
      'Could not be read: secret (MongoDB denied this operation)',
    )
    // The script says so at its top, never passing for the whole database (review I2).
    expect(script().split('\n')[0]).toBe('// Not in this script: the indexes of "secret" could not be read')
    expect((document.getElementById('copy') as HTMLButtonElement).disabled).toBe(false)
    // JSON has no place to say it: it is not copied or saved.
    await pick('format', 'JSON')
    expect((document.getElementById('copy') as HTMLButtonElement).disabled).toBe(true)
    expect((document.getElementById('download') as HTMLButtonElement).disabled).toBe(true)
    expect(document.getElementById('notes')!.textContent).toContain('JSON cannot say what is missing')
  })

  it('stops on the minute’s limit of reads and says why, offering no script', async () => {
    const { client, greet, calls } = fakeClient(PLACE, {
      'indexes.list': (p) => {
        if (p?.coll === 'c2') throw new AskError('too_many', 'At most 120 definitions a minute')
        return INDEXES.orders
      },
      'collections.list': () => ['c1', 'c2', 'c3', 'c4'].map((name) => ({ name, type: 'collection' })),
    })
    mount(app(), client)
    greet()
    await flush()
    await pick('scope', 'The whole database')
    expect(calls.filter((c) => c.method === 'indexes.list').map((c) => c.params?.coll)).toEqual([
      undefined,
      'c1',
      'c2',
    ])
    expect(document.getElementById('results')!.textContent).toContain(
      'Stopped before the whole database was read',
    )
    expect(document.getElementById('results')!.textContent).toContain('Try again in a minute')
    expect((document.getElementById('copy') as HTMLButtonElement).disabled).toBe(true)
  })

  it('says the app’s words when one collection’s read is past the minute’s limit', async () => {
    const { client, greet } = fakeClient(PLACE, {
      'indexes.list': () => {
        throw new AskError('too_many', 'At most 120 definitions a minute')
      },
    })
    mount(app(), client)
    greet()
    await flush()
    expect(document.getElementById('results')!.textContent).toContain('The indexes could not be read')
    expect(document.getElementById('results')!.textContent).not.toContain('whole database')
  })

  it('says in Turkish how many keys may be in another order', async () => {
    const odd = [
      ID,
      { name: 'a_1_2_1', key: { a: int(1), '2': int(1) }, options: {} },
      { name: 'b_1_3_1', key: { b: int(1), '3': int(1) }, options: {} },
    ]
    const { client, greet, contexts } = fakeClient(PLACE, { 'indexes.list': () => odd })
    mount(app(), client)
    greet()
    await flush()
    for (const fn of contexts) fn('tr', 'light', 'violet')
    expect(document.getElementById('notes')!.textContent).toContain(
      '2 indeksin anahtarları alanlarını başka bir sırayla listeliyor olabilir',
    )
  })

  it('warns of a key whose fields may be in another order', async () => {
    const odd = [ID, { name: 'a_1_2_1', key: { a: int(1), '2': int(1) }, options: {} }]
    const { client, greet } = fakeClient(PLACE, { 'indexes.list': () => odd })
    mount(app(), client)
    greet()
    await flush()
    expect(document.getElementById('notes')!.textContent).toContain(
      'An index’s key may list its fields in another order',
    )
    expect(document.getElementById('notes')!.textContent).toContain('orders.a_1_2_1')
  })

  it('writes it for Node.js, Python and as JSON, and copies and saves what it shows', async () => {
    const { client, greet, calls } = fakeClient(PLACE, {
      'indexes.list': () => INDEXES.orders,
      'ui.copy': () => true,
      'ui.download': () => true,
    })
    mount(app(), client)
    greet()
    await flush()
    await pick('format', 'Python')
    expect(script()).toContain(
      'db["orders"].create_index([("customerId", 1)], name="customerId_1", unique=True)',
    )
    document.getElementById('copy')!.click()
    await pick('format', 'JSON')
    document.getElementById('download')!.click()
    await flush()
    expect(calls.find((c) => c.method === 'ui.copy')!.params.text).toContain('create_index')
    const saved = calls.find((c) => c.method === 'ui.download')!.params
    expect([saved.type, saved.name]).toEqual(['json', 'shop.orders-indexes-json'])
    expect(JSON.parse(saved.text!)).toEqual([
      { collection: 'orders', key: { customerId: int(1) }, options: { name: 'customerId_1', unique: true } },
    ])
    await pick('format', 'Node.js')
    expect(script()).toContain(
      'await db.collection("orders").createIndex({ customerId: 1 }, { name: "customerId_1", unique: true })',
    )
  })

  it('says when there is nothing to write, on a view too, and when the indexes could not be read', async () => {
    const { client, greet } = fakeClient({ ...PLACE, coll: 'empty' }, { 'indexes.list': () => INDEXES.empty })
    mount(app(), client)
    greet()
    await flush()
    expect(app().textContent).toContain('No index to write')
    expect((document.getElementById('copy') as HTMLButtonElement).disabled).toBe(true)
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    const view = fakeClient({ ...PLACE, view: true } as PluginContext['place'], { 'indexes.list': () => [] })
    mount(app(), view.client)
    view.greet()
    await flush()
    expect(app().textContent).toContain('A view has no indexes of its own')
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    const failing = fakeClient(PLACE, {
      'indexes.list': () => {
        throw new AskError('failed', 'MongoDB is not available')
      },
    })
    mount(app(), failing.client)
    failing.greet()
    await flush()
    expect(app().textContent).toContain('The indexes could not be read')
  })

  it('reads 100 collections of a database at most, and says so', async () => {
    const { client, greet, calls } = fakeClient(PLACE, {
      'indexes.list': () => INDEXES.users,
      'collections.list': () =>
        Array.from({ length: 101 }, (_, i) => ({ name: `c${i}`, type: 'collection' })),
    })
    mount(app(), client)
    greet()
    await flush()
    await pick('scope', 'The whole database')
    expect(calls.filter((c) => c.method === 'indexes.list' && c.params?.coll)).toHaveLength(100)
    expect(document.getElementById('notes')!.textContent).toContain('The first 100 collections are read')
  })

  it('shows the indexes last asked for, never those of an earlier read that answers late', async () => {
    let late!: (v: unknown) => void
    let first = true
    const { client, greet } = fakeClient(PLACE, {
      'indexes.list': (p) => {
        if (first) {
          first = false
          return new Promise((r) => (late = r))
        }
        return INDEXES[p?.coll ?? 'orders']
      },
      'collections.list': () => [{ name: 'users', type: 'collection' }],
    })
    mount(app(), client)
    greet()
    await flush()
    await pick('scope', 'The whole database')
    late(INDEXES.orders)
    await flush()
    expect(script()).toContain('"users"')
    expect(script()).not.toContain('"orders"')
  })

  it('marks an index holding a value hidden from the user', async () => {
    const masked = [
      ID,
      { name: 'vip', key: { email: int(1) }, options: { partialFilterExpression: { email: '***' } } },
    ]
    const { client, greet } = fakeClient(PLACE, { 'indexes.list': () => masked })
    mount(app(), client)
    greet()
    await flush()
    expect(document.getElementById('notes')!.textContent).toContain('An index holds values hidden from you')
    expect(script()).toContain('// "vip" holds values hidden from you')
  })

  it('says it in Turkish, and says why a copy failed', async () => {
    const { client, greet, contexts } = fakeClient(PLACE, {
      'indexes.list': () => INDEXES.orders,
      'ui.copy': () => {
        throw new AskError('failed', 'Only right after the user clicks')
      },
    })
    mount(app(), client)
    greet()
    await flush()
    for (const fn of contexts) fn('tr', 'light', 'violet')
    expect(document.getElementById('status')!.textContent).toBe('1 koleksiyonda 1 indeks')
    document.getElementById('copy')!.click()
    await flush()
    expect(document.getElementById('notes')!.textContent).toContain('Only right after the user clicks')
  })
})
