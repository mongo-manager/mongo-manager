// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { hiddenMatch, mainType, shapeOf, typeOfEjson } from '../src/shape'

/**
 * Plugins wave 3 (spec §2): the shape of sampled documents (canonical Extended JSON), shared by the
 * test data, dictionary and reshape plugins — types and shares, never a hidden field's type, and
 * examples only where they are few, short and not hidden.
 */
describe('a value’s type, from canonical Extended JSON', () => {
  it('names every BSON type as the app does', () => {
    const cases: Array<[unknown, string]> = [
      [null, 'null'],
      [true, 'boolean'],
      ['x', 'string'],
      [[1], 'array'],
      [{ a: 1 }, 'object'],
      [{ $oid: '6ac625df13a09509ca0da14f' }, 'objectId'],
      [{ $date: { $numberLong: '1700000000000' } }, 'date'],
      [{ $date: '2026-10-26T00:00:00Z' }, 'date'],
      [{ $numberInt: '1' }, 'int32'],
      [{ $numberDouble: '1.5' }, 'double'],
      [{ $numberLong: '9' }, 'long'],
      [{ $numberDecimal: '1.10' }, 'decimal128'],
      [{ $binary: { base64: 'AA==', subType: '00' } }, 'binary'],
      [{ $binary: { base64: 'AAAAAAAAAAAAAAAAAAAAAA==', subType: '04' } }, 'uuid'],
      [{ $uuid: '00000000-0000-4000-8000-000000000000' }, 'uuid'],
      [{ $regularExpression: { pattern: 'a', options: '' } }, 'regex'],
      [{ $timestamp: { t: 1, i: 1 } }, 'timestamp'],
      [{ $minKey: 1 }, 'minKey'],
      [{ $maxKey: 1 }, 'maxKey'],
      [{ $code: 'x' }, 'javascript'],
      [1, 'double'],
    ]
    for (const [value, type] of cases) expect(typeOfEjson(value), JSON.stringify(value)).toBe(type)
  })
})

describe('whether a path is hidden', () => {
  it('matches as the app’s rules do: a name, * one key, ** any, a field above it, arrays transparent', () => {
    expect(hiddenMatch([['email']], ['email'])).toBe(true)
    expect(hiddenMatch([['email']], ['emails'])).toBe(false)
    expect(hiddenMatch([['contact']], ['contact', 'phone'])).toBe(true)
    expect(hiddenMatch([['contact', 'phone']], ['contact'])).toBe(false)
    expect(hiddenMatch([['*', 'phone']], ['home', 'phone'])).toBe(true)
    expect(hiddenMatch([['**', 'iban']], ['a', 'b', 'iban'])).toBe(true)
    expect(hiddenMatch([], ['email'])).toBe(false)
  })
})

describe('the shape of sampled documents', () => {
  const docs = [
    {
      _id: { $oid: '6ac625df13a09509ca0da14f' },
      name: 'Ada',
      status: 'active',
      total: { $numberDouble: '5.5' },
      email: '***',
      contact: { city: 'Izmir', phone: '***' },
      items: [{ qty: { $numberInt: '2' } }, { qty: { $numberInt: '3' } }],
    },
    {
      _id: { $oid: '6ac625df13a09509ca0da150' },
      name: 'Grace',
      status: 'inactive',
      total: { $numberInt: '7' },
      email: '***',
      contact: { city: 'Ankara', phone: '***' },
      tags: ['a'],
    },
  ]
  const hidden = [['email'], ['contact', 'phone']]
  const shape = shapeOf(docs, hidden)
  const field = (path: string) => shape.find((f) => f.path === path)!

  it('lists each path once, in the order first met, with its share and its types most common first', () => {
    expect(shape.map((f) => f.path)).toEqual([
      '_id',
      'name',
      'status',
      'total',
      'email',
      'contact',
      'contact.city',
      'contact.phone',
      'items',
      'items[].qty',
      'tags',
    ])
    expect(field('total')).toMatchObject({
      share: 1,
      types: [
        { type: 'double', count: 1 },
        { type: 'int32', count: 1 },
      ],
    })
    expect(field('items')).toMatchObject({ share: 0.5, types: [{ type: 'array', count: 1 }] })
    expect(field('items[].qty')).toMatchObject({
      share: 0.5,
      types: [{ type: 'int32', count: 2 }],
      segments: ['items', 'qty'],
    })
    expect(mainType(field('total'))).toBe('double')
  })

  it('never tells a hidden field’s type, nor takes its “***” for a string, nor gives its examples', () => {
    for (const path of ['email', 'contact.phone']) {
      expect(field(path)).toMatchObject({ hidden: true, types: [] })
      expect(field(path).examples).toBeUndefined()
    }
    expect(mainType(field('email'))).toBe('hidden')
    expect(field('contact.city').hidden).toBe(false)
  })

  it('gives examples only of a field whose values are few, short strings', () => {
    expect(field('status').examples).toEqual(['active', 'inactive'])
    expect(field('name').examples).toEqual(['Ada', 'Grace'])
    expect(field('total').examples).toBeUndefined()
    const many = shapeOf(
      Array.from({ length: 30 }, (_, i) => ({ code: `c${i}`, note: 'x'.repeat(41) })),
      [],
    )
    expect(many.find((f) => f.path === 'code')!.examples).toBeUndefined()
    expect(many.find((f) => f.path === 'note')!.examples).toBeUndefined()
  })

  it('goes four levels deep at most, and takes no documents as none', () => {
    const deep = shapeOf([{ a: { b: { c: { d: { e: 1 } } } } }], [])
    expect(deep.map((f) => f.path)).toEqual(['a', 'a.b', 'a.b.c', 'a.b.c.d'])
    expect(shapeOf([], [])).toEqual([])
  })
})
