// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { deserializeValue } from '@mongo-manager/shared/browser'
import { valueChanges } from '../src/documents/valueChanges'

describe('valueChanges (the review says which values changed, by path)', () => {
  it('names a value changed deep in an array of documents', () => {
    const before = { payments: [{ amount: 1 }, { amount: 110, method: 'card' }] }
    const after = { payments: [{ amount: 1 }, { amount: 999, method: 'card' }] }
    expect(valueChanges('payments', before.payments, after.payments)).toEqual({
      changes: [{ path: 'payments.1.amount', kind: 'changed', before: '110', after: '999' }],
      more: 0,
    })
  })

  it('names fields added and removed, and items added at the end of an array', () => {
    expect(valueChanges('a', { x: 1, y: 2 }, { x: 1, z: 3 }).changes).toEqual([
      { path: 'a.y', kind: 'removed', before: '2' },
      { path: 'a.z', kind: 'added', after: '3' },
    ])
    expect(valueChanges('list', [1, 2], [1, 2, 3]).changes).toEqual([
      { path: 'list.2', kind: 'added', after: '3' },
    ])
  })

  it('compares a BSON value whole, by how it is written', () => {
    const oid = (hex: string) => deserializeValue({ $oid: hex })
    const id = oid('65a1b2c3d4e5f6a7b8c9d0e1')
    expect(valueChanges('ref', { id }, { id: oid('65a1b2c3d4e5f6a7b8c9d0e1') }).changes).toEqual([])
    expect(valueChanges('ref', { id }, { id: oid('65a1b2c3d4e5f6a7b8c9d0e2') }).changes).toHaveLength(1)
  })

  it('names paths from the document itself when given no field', () => {
    expect(valueChanges('', { a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 } }).changes).toEqual([
      { path: 'b.c', kind: 'changed', before: '2', after: '3' },
    ])
  })

  it('keeps a few and counts the rest', () => {
    const before = Array.from({ length: 12 }, (_, i) => i)
    const after = before.map((n) => n + 100)
    const result = valueChanges('n', before, after, 5)
    expect(result.changes).toHaveLength(5)
    expect(result.more).toBe(7)
  })

  it('cuts a long value short', () => {
    const [change] = valueChanges('note', { t: 'a'.repeat(300) }, { t: 'b'.repeat(300) }).changes
    expect(change!.before!.length).toBeLessThanOrEqual(61)
    expect(change!.before!.endsWith('…')).toBe(true)
  })
})
