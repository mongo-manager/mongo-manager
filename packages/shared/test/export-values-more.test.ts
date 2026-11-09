// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { BSONSymbol, Code, DBRef, ObjectId } from 'bson'
import { toValue } from '../src/aggregation/export/values'

/** Phase 3e-1 gate: the export value model's DBRef, Code and Symbol cases (left uncovered before). */
describe('export values of rarer BSON types', () => {
  const oid = new ObjectId('65a1b2c3d4e5f60718293a4b')

  it('writes a DBRef as its $ref, $id and, when given, $db', () => {
    expect(toValue(new DBRef('orders', oid))).toEqual({
      k: 'doc',
      entries: [
        ['$ref', { k: 'string', v: 'orders' }],
        ['$id', toValue(oid, 1)],
      ],
    })
    const withDb = toValue(new DBRef('orders', oid, 'shop')) as { entries: Array<[string, unknown]> }
    expect(withDb.entries.at(-1)).toEqual(['$db', { k: 'string', v: 'shop' }])
  })

  it('writes code and symbols as their text', () => {
    expect(toValue(new Code('function () { return 1 }'))).toEqual({
      k: 'string',
      v: 'function () { return 1 }',
    })
    expect(toValue(new BSONSymbol('sym'))).toEqual({ k: 'string', v: 'sym' })
  })
})
