// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { Accent, PluginClient, PluginContext } from '../../kit/src/client'
import { AskError } from '../../kit/src/client'
import { lookupStages } from '../src/infer'
import { mount } from '../src/view'

const flush = async (times = 4) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0))
}
const hex = (c: string) => c.repeat(24)
const oid = (c: string) => ({ $oid: hex(c) })

type Params = Record<string, unknown>
type Handler = (params: Params) => unknown

/** A plugin client answering from `handlers`; `greet` plays the app's greeting. */
function fakeClient(place: PluginContext['place'], handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; params: Params }> = []
  let ready: (() => void) | null = null
  const contexts: Array<(l: string, t: 'light' | 'dark', a: Accent) => void> = []
  const client: PluginClient = {
    contribution: { kind: 'collectionTab', id: 'references' },
    ask: async <T>(method: string, params?: unknown) => {
      calls.push({ method, params: (params ?? {}) as Params })
      if (method === 'context.get')
        return {
          plugin: { id: 'references', version: '1' },
          contribution: { kind: 'collectionTab', id: 'references' },
          locale: 'en',
          theme: 'light',
          accent: 'ocean',
          place,
          settings: {},
        } as T
      const handler = handlers[method]
      if (!handler) throw new Error(`unexpected ${method}`)
      return (await handler((params ?? {}) as Params)) as T
    },
    onReady: (fn) => (ready = fn),
    onContext: (fn) => contexts.push(fn),
    onCells: () => {},
  }
  return { client, calls, greet: () => ready!(), contexts }
}

const PLACE = { connectionId: 'c', connectionName: 'Shop', db: 'shop', coll: 'orders', documentId: null }
const ORDERS = [
  { _id: oid('e'), customerId: oid('1'), items: [{ productId: oid('a') }, { productId: oid('b') }] },
  { _id: oid('f'), customerId: oid('2'), items: [{ productId: oid('a') }] },
]
const DB: Record<string, Array<Record<string, unknown>>> = {
  customers: [{ _id: oid('1'), name: 'Ada' }],
  products: [
    { _id: oid('a'), title: 'Pen' },
    { _id: oid('b'), title: 'Ink' },
  ],
  audit: [],
  orders: ORDERS,
}
const LIST = [
  { name: 'orders', type: 'collection' },
  { name: 'audit', type: 'collection' },
  { name: 'customers', type: 'collection' },
  { name: 'products', type: 'collection' },
  { name: 'recent', type: 'view' },
]

/** The documents of `db[coll]` whose _id the filter's $in names. */
const findIn = (db: typeof DB) => (p: Params) => {
  const wanted = ((p.filter as { _id: { $in: Array<{ $oid: string }> } })._id.$in ?? []).map((x) => x.$oid)
  return {
    documents: (db[p.coll as string] ?? []).filter((d) => wanted.includes((d._id as { $oid: string }).$oid)),
  }
}
const shop = (overrides: Record<string, Handler> = {}) => ({
  'documents.aggregate': () => ({ documents: ORDERS }),
  'collections.list': () => LIST,
  'documents.findIn': findIn(DB),
  'ui.useAggregation': () => true,
  'ui.useQuery': () => true,
  ...overrides,
})

const app = () => document.getElementById('app')!
const card = (path: string) => document.querySelector<HTMLElement>(`[data-relation="${path}"]`)
const buttonIn = (el: ParentNode, name: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)
const status = () => document.getElementById('status')!.textContent ?? ''

beforeEach(() => {
  document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
  document.documentElement.className = ''
})

describe('references tab, redesigned (plugin tabs redesign §2.6)', () => {
  it('says what it is about, for this collection', async () => {
    const { client, greet } = fakeClient(PLACE, shop())
    mount(app(), client)
    greet()
    await flush()
    expect(document.querySelector('h1')!.textContent).toBe('References')
    expect(document.querySelector('.mm-head-desc')!.textContent).toContain('orders')
    expect(document.documentElement.dataset.accent).toBe('ocean')
  })

  it('finds the references on open, one card per relation with the share found', async () => {
    const { client, greet } = fakeClient(PLACE, shop())
    mount(app(), client)
    greet()
    await flush()
    const customer = card('customerId')!
    expect(customer.textContent).toContain('customers')
    expect(customer.textContent).toContain('50%')
    expect(customer.textContent).toContain('1 of 2 sampled ids found')
    expect(customer.textContent).toContain('Ada')
    expect(customer.querySelector('[role="meter"]')!.getAttribute('aria-valuenow')).toBe('50')
    const product = card('items.productId')!
    expect(product.textContent).toContain('products')
    expect(product.textContent).toContain('100%')
    expect(product.textContent).toContain('Pen')
    expect(product.textContent).toContain('Ink')
    expect(status()).toContain('2 relations')
  })

  it('reads only the found documents’ names, and shows three of them at most', async () => {
    const many = ['1', '2', '3', '4'].map((c) => ({ _id: oid('e'), customerId: oid(c) }))
    const db = {
      ...DB,
      customers: ['1', '2', '3', '4'].map((c, i) => ({
        _id: oid(c),
        name: ['Ada', 'Grace', 'Alan', 'Edsger'][i],
      })),
    }
    const { client, greet, calls } = fakeClient(
      PLACE,
      shop({ 'documents.aggregate': () => ({ documents: many }), 'documents.findIn': findIn(db) }),
    )
    mount(app(), client)
    greet()
    await flush()
    const names = [...card('customerId')!.querySelectorAll('.ref-names .mm-chip')].map((c) => c.textContent)
    expect(names).toEqual(['Ada', 'Grace', 'Alan'])
    const projection = calls.find((c) => c.method === 'documents.findIn')!.params.projection
    expect(Object.keys(projection as object).sort()).toEqual(
      [
        '_id',
        'name',
        'title',
        'label',
        'displayName',
        'fullName',
        'username',
        'email',
        'code',
        'slug',
      ].sort(),
    )
  })

  it('shows grey rows while it looks, and says how far it is', async () => {
    let answer!: (v: unknown) => void
    const { client, greet } = fakeClient(
      PLACE,
      shop({ 'documents.findIn': () => new Promise((r) => (answer = r)) }),
    )
    mount(app(), client)
    greet()
    await flush()
    expect(document.querySelector('.mm-skeleton')).not.toBeNull()
    expect(status()).toMatch(/Looking in 1 of 4 collections/)
    const find = document.getElementById('find') as HTMLButtonElement
    expect(find.disabled).toBe(true)
    answer({ documents: [] })
  })

  it('opens a relation with $lookup in Aggregations', async () => {
    const { client, greet, calls } = fakeClient(PLACE, shop())
    mount(app(), client)
    greet()
    await flush()
    buttonIn(card('customerId')!, 'Open with $lookup')!.click()
    await flush()
    const use = calls.find((c) => c.method === 'ui.useAggregation')!
    expect(use.params).toEqual({ stages: lookupStages('customerId', 'customers') })
  })

  it('shows the documents whose sampled reference is not found, only where one is missing', async () => {
    const { client, greet, calls } = fakeClient(PLACE, shop())
    mount(app(), client)
    greet()
    await flush()
    buttonIn(card('customerId')!, 'Show orphans')!.click()
    await flush()
    const use = calls.find((c) => c.method === 'ui.useQuery')!
    expect(use.params).toEqual({ filter: { customerId: { $in: [{ $oid: hex('2') }] } } })
    expect(buttonIn(card('items.productId')!, 'Show orphans')).toBeUndefined()
  })

  it('says why a hand-off failed, in the summary', async () => {
    const { client, greet } = fakeClient(
      PLACE,
      shop({
        'ui.useQuery': () => {
          throw new AskError('no_activation', 'x')
        },
      }),
    )
    mount(app(), client)
    greet()
    await flush()
    buttonIn(card('customerId')!, 'Show orphans')!.click()
    await flush()
    expect(app().textContent).toContain('Click the button again')
  })

  it('looks again when asked', async () => {
    const { client, greet, calls } = fakeClient(PLACE, shop())
    mount(app(), client)
    greet()
    await flush()
    const samples = () => calls.filter((c) => c.method === 'documents.aggregate').length
    expect(samples()).toBe(1)
    const find = document.getElementById('find') as HTMLButtonElement
    expect(find.textContent).toBe('Find references')
    find.click()
    await flush()
    expect(samples()).toBe(2)
    expect(card('customerId')).not.toBeNull()
  })

  it('says nothing refers anywhere, and what it looked at, when no field holds an ObjectId', async () => {
    const { client, greet, calls } = fakeClient(
      PLACE,
      shop({ 'documents.aggregate': () => ({ documents: [{ _id: oid('e'), city: 'Izmir' }] }) }),
    )
    mount(app(), client)
    greet()
    await flush()
    const empty = document.querySelector('.mm-empty')!
    expect(empty.textContent).toContain('No references found')
    expect(empty.textContent).toContain('1 sampled document')
    expect(calls.some((c) => c.method === 'documents.findIn')).toBe(false)
  })

  it('names the fields whose ids no collection holds', async () => {
    const { client, greet } = fakeClient(PLACE, shop({ 'documents.findIn': () => ({ documents: [] }) }))
    mount(app(), client)
    greet()
    await flush()
    expect(document.querySelector('[data-relation]')).toBeNull()
    const empty = document.querySelector('.mm-empty')!
    expect(empty.textContent).toContain('No references found')
    expect(empty.textContent).toContain('customerId')
    expect(empty.textContent).toContain('items.productId')
  })

  it('lists, beside the relations, the fields no collection holds the ids of', async () => {
    const lost = [{ ...ORDERS[0], ownerId: oid('9') }, ORDERS[1]]
    const { client, greet } = fakeClient(PLACE, shop({ 'documents.aggregate': () => ({ documents: lost }) }))
    mount(app(), client)
    greet()
    await flush()
    expect(card('customerId')).not.toBeNull()
    expect(document.getElementById('unmatched')!.textContent).toContain('ownerId')
  })

  it('keeps what it found when the app stops it early, and says so', async () => {
    let n = 0
    const { client, greet } = fakeClient(
      PLACE,
      shop({
        'documents.findIn': (p) => {
          if (++n > 1) throw new AskError('too_many', 'x')
          return findIn(DB)(p)
        },
      }),
    )
    mount(app(), client)
    greet()
    await flush()
    expect(card('customerId')!.textContent).toContain('customers')
    expect(app().textContent).toContain('Stopped early')
    expect(app().textContent).toContain('Too many requests')
  })

  it('says the search failed when the sample cannot be read', async () => {
    const { client, greet } = fakeClient(
      PLACE,
      shop({
        'documents.aggregate': () => {
          throw new AskError('not_permitted', 'x')
        },
      }),
    )
    mount(app(), client)
    greet()
    await flush()
    const empty = document.querySelector('.mm-empty-danger')!
    expect(empty.textContent).toContain('not allowed')
    expect((document.getElementById('find') as HTMLButtonElement).disabled).toBe(false)
  })

  it('reads nothing without a collection', async () => {
    const { client, greet, calls } = fakeClient(null, shop())
    mount(app(), client)
    greet()
    await flush()
    expect(calls.map((c) => c.method)).toEqual(['context.get'])
    expect(app().textContent).toContain('Open a collection')
    expect((document.getElementById('find') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows names from the database as text, never as markup', async () => {
    const db = { ...DB, customers: [{ _id: oid('1'), name: '<img src=x onerror=alert(1)>' }] }
    const { client, greet } = fakeClient(PLACE, shop({ 'documents.findIn': findIn(db) }))
    mount(app(), client)
    greet()
    await flush()
    expect(card('customerId')!.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(app().querySelector('img')).toBeNull()
  })

  it('speaks Turkish when the app does, without reading again', async () => {
    const { client, greet, contexts, calls } = fakeClient(PLACE, shop())
    mount(app(), client)
    greet()
    await flush()
    const reads = calls.length
    for (const fn of contexts) fn('tr', 'dark', 'rose')
    expect(document.querySelector('h1')!.textContent).toBe('Referanslar')
    expect(document.getElementById('find')!.textContent).toBe('Referansları bul')
    expect(card('customerId')!.textContent).toContain('%50')
    expect(buttonIn(card('customerId')!, '$lookup ile aç')).toBeDefined()
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.dataset.accent).toBe('rose')
    expect(calls.length).toBe(reads)
  })
})
