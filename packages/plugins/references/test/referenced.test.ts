// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { MAX_FIELDS, PER_FIELD, findReferring, referrersOf, referringFilter } from '../src/referenced'

const ID = { $oid: '65a1b2c3d4e5f60718293a4b' }
const MODEL = {
  collections: [
    { name: 'customers', type: 'collection' },
    { name: 'orders', type: 'collection' },
    { name: 'invoices', type: 'collection' },
    { name: 'recent', type: 'view' },
  ],
  references: [
    { from: 'orders', field: 'customerId', to: 'customers', toField: '_id' },
    { from: 'orders', field: 'items[].customerId', to: 'customers', toField: '_id' },
    { from: 'invoices', field: 'billTo', to: 'customers', toField: '_id' },
    { from: 'invoices', field: 'billTo', to: 'customers', toField: '_id' },
    // Not this collection's _id, a view, another collection: none of these.
    { from: 'orders', field: 'email', to: 'customers', toField: 'email' },
    { from: 'recent', field: 'customerId', to: 'customers', toField: '_id' },
    { from: 'orders', field: 'productId', to: 'products', toField: '_id' },
  ],
}

describe('the fields referring to a collection', () => {
  it('are the model’s references to its _id, from collections, once each, arrays by their path', () => {
    expect(referrersOf(MODEL, 'customers')).toEqual([
      { from: 'invoices', path: 'billTo' },
      { from: 'orders', path: 'customerId' },
      { from: 'orders', path: 'items.customerId' },
    ])
    expect(referrersOf(MODEL, 'nobody')).toEqual([])
    expect(referrersOf(null, 'customers')).toEqual([])
    expect(referrersOf({ references: 'x' }, 'customers')).toEqual([])
  })

  it('are 20 at most', () => {
    const many = {
      references: Array.from({ length: MAX_FIELDS + 5 }, (_, i) => ({
        from: `c${String(i).padStart(2, '0')}`,
        field: 'ref',
        to: 'customers',
        toField: '_id',
      })),
    }
    expect(referrersOf(many, 'customers')).toHaveLength(MAX_FIELDS)
  })

  it('select a document holding the id, in an array too', () => {
    expect(referringFilter('items.customerId', ID)).toEqual({ 'items.customerId': ID })
  })
})

describe('the documents referring to one', () => {
  it('asks the model once, then each field once for its names, and lists those found', async () => {
    const asked: Array<[string, unknown]> = []
    const ask = async <T>(method: string, params?: unknown): Promise<T> => {
      asked.push([method, params])
      if (method === 'database.model') return MODEL as T
      const { coll, filter } = params as { coll: string; filter: Record<string, unknown> }
      if (coll === 'invoices') throw new Error('not permitted')
      if (filter.customerId)
        return {
          documents: Array.from({ length: PER_FIELD + 1 }, (_, i) => ({ _id: i, name: `o${i}` })),
        } as T
      return { documents: [] } as T
    }
    const found = await findReferring(ask, 'customers', ID)
    expect(asked[0]).toEqual(['database.model', undefined])
    expect(asked.slice(1).map(([, p]) => (p as { coll: string; filter: unknown }).filter)).toEqual([
      { billTo: ID },
      { customerId: ID },
      { 'items.customerId': ID },
    ])
    const first = asked[1]![1] as { projection: Record<string, number>; limit: number }
    expect(first.limit).toBe(PER_FIELD + 1)
    expect(first.projection).toMatchObject({ _id: 1, name: 1, title: 1 })
    expect(found.asked).toBe(3)
    expect(found.groups).toHaveLength(1)
    expect(found.groups[0]).toMatchObject({ from: 'orders', path: 'customerId', more: true })
    expect(found.groups[0]!.documents).toHaveLength(PER_FIELD)
    expect(found.failed.map((f) => f.from)).toEqual(['invoices'])
  })
})
