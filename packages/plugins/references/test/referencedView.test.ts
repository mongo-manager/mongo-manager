// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { Accent, PluginClient, PluginContext } from '../../kit/src/client'
import { AskError } from '../../kit/src/client'
import { mountReferenced } from '../src/referencedView'

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}
type Params = { coll?: string; filter?: Record<string, unknown> }
type Handler = (params: Params) => unknown

function fakeClient(place: PluginContext['place'], handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; params: Params }> = []
  let ready: (() => void) | null = null
  const contexts: Array<(l: string, t: 'light' | 'dark', a: Accent) => void> = []
  const client: PluginClient = {
    contribution: { kind: 'documentAction', id: 'referenced-by' },
    ask: async <T>(method: string, params?: unknown) => {
      calls.push({ method, params: params as Params })
      if (method === 'context.get')
        return {
          plugin: { id: 'references', version: '1' },
          contribution: { kind: 'documentAction', id: 'referenced-by' },
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

const ID = { $oid: '65a1b2c3d4e5f60718293a4b' }
const PLACE = { connectionId: 'c', connectionName: 'Shop', db: 'shop', coll: 'customers', documentId: ID }
const MODEL = {
  collections: [],
  references: [
    { from: 'orders', field: 'customerId', to: 'customers', toField: '_id' },
    { from: 'invoices', field: 'billTo', to: 'customers', toField: '_id' },
  ],
}
const app = () => document.getElementById('app')!
const cards = () => [...document.querySelectorAll<HTMLElement>('[data-from]')]

beforeEach(() => {
  document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
})

describe('Referenced by', () => {
  it('lists, by name, the documents of each field that refers to this one, and shows them in their collection', async () => {
    const { client, greet, calls } = fakeClient(PLACE, {
      'database.model': () => MODEL,
      'documents.findIn': (p) =>
        p.coll === 'orders'
          ? {
              documents: [
                { _id: { $oid: '65a1b2c3d4e5f60718293a50' }, name: 'Order 1' },
                { _id: { $numberInt: '7' } },
              ],
            }
          : { documents: [] },
      'ui.useQueryIn': () => true,
    })
    mountReferenced(app(), client)
    greet()
    await flush()
    expect(cards().map((c) => [c.dataset.from, c.dataset.path])).toEqual([['orders', 'customerId']])
    expect(cards()[0]!.textContent).toContain('2 documents')
    expect([...cards()[0]!.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Order 1',
      'unnamed 7',
    ])
    expect(document.getElementById('status')!.textContent).toBe('1 field refers to it')
    cards()[0]!.querySelector<HTMLButtonElement>('[data-show]')!.click()
    await flush()
    expect(calls.find((c) => c.method === 'ui.useQueryIn')!.params).toEqual({
      coll: 'orders',
      filter: { customerId: ID },
    })
  })

  it('says there are more when a field holds more than it lists', async () => {
    const { client, greet } = fakeClient(PLACE, {
      'database.model': () => MODEL,
      'documents.findIn': (p) =>
        p.coll === 'orders'
          ? { documents: Array.from({ length: 21 }, (_, i) => ({ _id: i, name: `o${i}` })) }
          : { documents: [] },
    })
    mountReferenced(app(), client)
    greet()
    await flush()
    expect(cards()[0]!.textContent).toContain('20+ documents')
    expect(cards()[0]!.querySelectorAll('li')).toHaveLength(20)
  })

  it('says when nothing refers to it, and when no field refers to its collection', async () => {
    const { client, greet } = fakeClient(PLACE, {
      'database.model': () => MODEL,
      'documents.findIn': () => ({ documents: [] }),
    })
    mountReferenced(app(), client)
    greet()
    await flush()
    expect(app().textContent).toContain('Nothing refers to this document')
    expect(app().textContent).toContain('None of the 2 fields that refer to this collection holds its id.')
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    const none = fakeClient(PLACE, { 'database.model': () => ({ references: [] }) })
    mountReferenced(app(), none.client)
    none.greet()
    await flush()
    expect(app().textContent).toContain('finds no field that refers to this collection')
  })

  it('says which field could not be read, and lists the others', async () => {
    const { client, greet } = fakeClient(PLACE, {
      'database.model': () => MODEL,
      'documents.findIn': (p) => {
        if (p.coll === 'invoices') throw new AskError('failed', 'MongoDB denied this operation')
        return { documents: [{ _id: 1, name: 'Order 1' }] }
      },
    })
    mountReferenced(app(), client)
    greet()
    await flush()
    expect(document.getElementById('notes')!.textContent).toContain('invoices.billTo could not be read')
    expect(cards()).toHaveLength(1)
  })

  // Review 2026-10-28: past the minute's reads, every field left "could not be read".
  it('stops at the minute’s limit of reads, says how many fields were not asked, and claims nothing', async () => {
    const { client, greet, calls } = fakeClient(PLACE, {
      'database.model': () => MODEL,
      'documents.findIn': () => {
        throw new AskError('too_many', 'At most 60 reads a minute')
      },
    })
    mountReferenced(app(), client)
    greet()
    await flush()
    expect(calls.filter((c) => c.method === 'documents.findIn')).toHaveLength(1)
    expect(document.getElementById('notes')!.textContent).toContain(
      '2 fields were not asked: the app reads only so many a minute. Open it again in a minute.',
    )
    expect(document.getElementById('notes')!.textContent).not.toContain('could not be read')
    expect(app().textContent).not.toContain('Nothing refers to this document')
    expect(app().textContent).toContain('None of the fields that refer to this collection could be asked')
    // One asked (nothing there), the next past the limit: nothing found in the one it could ask.
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    let asks = 0
    const some = fakeClient(PLACE, {
      'database.model': () => MODEL,
      'documents.findIn': () => {
        if (asks++ > 0) throw new AskError('too_many', 'At most 60 reads a minute')
        return { documents: [] }
      },
    })
    mountReferenced(app(), some.client)
    some.greet()
    await flush()
    expect(app().textContent).toContain('Nothing found in the fields it could ask')
    expect(document.getElementById('notes')!.textContent).toContain('1 field was not asked')
  })

  it('says when the model could not be read, and when Documents could not be opened', async () => {
    const { client, greet } = fakeClient(PLACE, {
      'database.model': () => {
        throw new AskError('failed', 'The operation exceeded its time limit')
      },
    })
    mountReferenced(app(), client)
    greet()
    await flush()
    expect(app().textContent).toContain('It could not be looked for')
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    const second = fakeClient(PLACE, {
      'database.model': () => MODEL,
      'documents.findIn': () => ({ documents: [{ _id: 1, name: 'x' }] }),
      'ui.useQueryIn': () => {
        throw new AskError('failed', 'At most 10 a minute')
      },
    })
    mountReferenced(app(), second.client)
    second.greet()
    await flush()
    cards()[0]!.querySelector<HTMLButtonElement>('[data-show]')!.click()
    await flush()
    expect(document.getElementById('notes')!.textContent).toContain('At most 10 a minute')
  })

  it('needs a document, and says it in Turkish', async () => {
    const { client, greet, calls } = fakeClient({ ...PLACE, documentId: null }, {})
    mountReferenced(app(), client)
    greet()
    await flush()
    expect(app().textContent).toContain('Open a document to see what refers to it.')
    expect(calls.some((c) => c.method === 'database.model')).toBe(false)
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    const tr = fakeClient(PLACE, {
      'database.model': () => MODEL,
      'documents.findIn': (p) =>
        p.coll === 'orders' ? { documents: [{ _id: 1, name: 'x' }] } : { documents: [] },
    })
    mountReferenced(app(), tr.client)
    tr.greet()
    await flush()
    for (const fn of tr.contexts) fn('tr', 'light', 'violet')
    expect(document.getElementById('status')!.textContent).toBe('1 alan ona başvuruyor')
    expect(cards()[0]!.textContent).toContain('orders içinde göster')
  })
})
