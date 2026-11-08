// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import {
  baseName,
  candidates,
  inferRelations,
  labelOf,
  lookupStages,
  nameOf,
  objectIdFields,
  orderCollections,
  orphanFilter,
} from '../src/infer'

const oid = (c: string) => ({ $oid: c.repeat(24) })

describe('what a field name says it refers to (references)', () => {
  it('takes the id ending off a field name', () => {
    expect(baseName('customerId')).toBe('customer')
    expect(baseName('customer_id')).toBe('customer')
    expect(baseName('authorIds')).toBe('author')
    expect(baseName('owner_ids')).toBe('owner')
    expect(baseName('ownerID')).toBe('owner')
    expect(baseName('order.itemId')).toBe('item')
    expect(baseName('parent')).toBe('parent')
    expect(baseName('id')).toBe('id')
  })

  it('finds the collections named like it, singular or plural, any case or separator', () => {
    const colls = ['customers', 'Category', 'categories', 'order_items', 'people', 'boxes', 'orders']
    expect(candidates('customerId', colls)).toEqual(['customers'])
    expect(candidates('categoryId', colls)).toEqual(['Category', 'categories'])
    expect(candidates('orderItemId', colls)).toEqual(['order_items'])
    expect(candidates('boxId', colls)).toEqual(['boxes'])
    expect(candidates('ownerId', colls)).toEqual([])
  })
})

describe('the fields holding references (references)', () => {
  it('lists the fields holding ObjectIds, not the documents’ own _id, with their values', () => {
    const fields = objectIdFields([
      { _id: oid('a'), customerId: oid('1'), tags: [oid('2'), oid('3')], address: { cityId: oid('4') } },
      { _id: oid('b'), customerId: oid('5'), note: 'x' },
      { _id: oid('c'), customerId: oid('1') },
    ])
    expect(fields).toEqual([
      { path: 'customerId', ids: ['1'.repeat(24), '5'.repeat(24)] },
      { path: 'tags', ids: ['2'.repeat(24), '3'.repeat(24)] },
      { path: 'address.cityId', ids: ['4'.repeat(24)] },
    ])
  })

  it('looks first in the collections named like a field, never in views or system collections', () => {
    const order = orderCollections(
      [
        { name: 'audit', type: 'collection' },
        { name: 'customers', type: 'collection' },
        { name: 'recent', type: 'view' },
        { name: 'system.views', type: 'collection' },
        { name: 'cities', type: 'collection' },
      ],
      ['customerId', 'address.cityId'],
    )
    expect(order).toEqual(['customers', 'cities', 'audit'])
  })

  it('maps each field to the collection holding most of its values', () => {
    const fields = [
      { path: 'customerId', ids: ['1'.repeat(24), '5'.repeat(24)] },
      { path: 'tags', ids: ['2'.repeat(24), '3'.repeat(24)] },
      { path: 'lost', ids: ['9'.repeat(24)] },
    ]
    const found = [
      { coll: 'customers', ids: new Set(['1'.repeat(24), '5'.repeat(24)]) },
      { coll: 'tags', ids: new Set(['2'.repeat(24)]) },
      { coll: 'labels', ids: new Set(['2'.repeat(24), '3'.repeat(24)]) },
    ]
    expect(inferRelations(fields, found)).toEqual({
      relations: [
        { path: 'customerId', coll: 'customers', share: 1 },
        { path: 'tags', coll: 'labels', share: 1 },
      ],
      unmatched: ['lost'],
    })
  })
})

describe('what a referenced document is called (references)', () => {
  it('uses its first naming field, else its _id', () => {
    expect(labelOf({ _id: oid('1'), email: 'a@b.c', name: 'Ada' })).toBe('Ada')
    expect(labelOf({ _id: oid('1'), title: '  ', code: 'X-1' })).toBe('X-1')
    expect(labelOf({ _id: oid('1') })).toBe('1'.repeat(24))
    expect(labelOf({ _id: 7, name: 'x'.repeat(80) })).toBe(`${'x'.repeat(59)}…`)
  })

  it('names a document only from a naming field, never from its _id', () => {
    expect(nameOf({ _id: oid('1'), email: 'a@b.c', name: 'Ada' })).toBe('Ada')
    expect(nameOf({ _id: oid('1') })).toBeNull()
    expect(nameOf({ _id: oid('1'), name: '   ', title: 7 })).toBeNull()
  })

  it('hands the user a $lookup joining the referenced documents', () => {
    expect(lookupStages('address.cityId', 'cities')).toEqual([
      {
        $lookup: {
          from: 'cities',
          localField: 'address.cityId',
          foreignField: '_id',
          as: 'address_cityId_ref',
        },
      },
    ])
  })
})

describe('the documents whose reference is not found (references)', () => {
  it('filters this collection on the sampled ids the target does not hold', () => {
    expect(orphanFilter('items.productId', ['2'.repeat(24), '3'.repeat(24)])).toEqual({
      'items.productId': { $in: [{ $oid: '2'.repeat(24) }, { $oid: '3'.repeat(24) }] },
    })
  })

  it('builds no filter for nothing missing, or for a path that would read as an operator', () => {
    expect(orphanFilter('customerId', [])).toBeNull()
    expect(orphanFilter('$where', ['1'.repeat(24)])).toBeNull()
    expect(orphanFilter('a.$b', ['1'.repeat(24)])).toBeNull()
    expect(orphanFilter('a..b', ['1'.repeat(24)])).toBeNull()
    expect(orphanFilter('', ['1'.repeat(24)])).toBeNull()
    expect(orphanFilter('customerId', ['not-an-id'])).toBeNull()
  })
})
