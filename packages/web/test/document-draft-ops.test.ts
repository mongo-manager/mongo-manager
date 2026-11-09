// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { documentDiff } from '@mongo-manager/shared/browser'
import { addField, addItem, removeAt, renameAt, setAt, type OpResult } from '@/documents/page/draftOps'

// Document page design §6.5: what the tree changes in place, as operations on the document being
// edited — never on the one opened, never on _id or a hidden value, never under a name MongoDB refuses.
const base = () => ({
  _id: 7,
  guest: { name: 'Ada Lin' },
  payments: [
    { method: 'card', amount: 350, card: '***' },
    { method: 'transfer', amount: 120 },
  ],
  status: 'pending',
})
const none = () => false
const masked = (path: readonly string[]) => path.join('.').startsWith('payments.0.card')
const doc = (r: OpResult) => {
  if (!r.ok) throw new Error(r.error)
  return r.doc
}
const error = (r: OpResult) => (r.ok ? null : r.error)

describe('editing a document in the tree', () => {
  it('sets a value and leaves the document it was given as it was', () => {
    const input = base()
    const out = doc(setAt(input, ['payments', '1', 'amount'], 999, none))
    expect((out.payments as Array<{ amount: number }>)[1]!.amount).toBe(999)
    expect(input.payments[1]!.amount).toBe(120)
    expect(out.guest).toBe(input.guest)
  })

  it('removes a field, and an array item by its place', () => {
    expect(Object.keys(doc(removeAt(base(), ['status'], none)))).toEqual(['_id', 'guest', 'payments'])
    expect(doc(removeAt(base(), ['payments', '0'], none)).payments).toEqual([
      { method: 'transfer', amount: 120 },
    ])
  })

  it('renames a key where it stands', () => {
    const out = doc(renameAt(base(), ['guest'], 'customer', none))
    expect(Object.keys(out)).toEqual(['_id', 'customer', 'payments', 'status'])
  })

  it('adds a field to an object and an item to an array', () => {
    expect(doc(addField(base(), ['guest'], 'phone', '+1', none)).guest).toEqual({
      name: 'Ada Lin',
      phone: '+1',
    })
    expect((doc(addItem(base(), ['payments'], { amount: 1 }, none)).payments as unknown[]).length).toBe(3)
    expect(error(addField(base(), ['payments'], 'x', 1, none))).toBe('notContainer')
    expect(error(addItem(base(), ['guest'], 1, none))).toBe('notContainer')
  })

  it('never touches _id', () => {
    expect(error(setAt(base(), ['_id'], 8, none))).toBe('id')
    expect(error(removeAt(base(), ['_id'], none))).toBe('id')
    expect(error(renameAt(base(), ['_id'], 'id', none))).toBe('id')
  })

  it('never touches a hidden value', () => {
    expect(error(setAt(base(), ['payments', '0', 'card'], 'x', masked))).toBe('masked')
    expect(error(removeAt(base(), ['payments', '0', 'card'], masked))).toBe('masked')
    expect(error(renameAt(base(), ['payments', '0', 'card'], 'c', masked))).toBe('masked')
  })

  it('refuses a name MongoDB refuses, or one already there', () => {
    expect(error(renameAt(base(), ['status'], '', none))).toBe('emptyKey')
    expect(error(renameAt(base(), ['status'], '$x', none))).toBe('dollarKey')
    expect(error(addField(base(), ['guest'], 'a.b', 1, none))).toBe('dotKey')
    expect(error(addField(base(), ['guest'], 'name', 1, none))).toBe('duplicateKey')
    expect(error(renameAt(base(), ['status'], 'guest', none))).toBe('duplicateKey')
  })

  // Review Focus 2: a value under a key holding a dot is written by replacing the document, never as
  // an update of the dotted path (which would name another field).
  it('changes a value under a dotted key as a replace', () => {
    const start = { _id: 1, 'a.b': 1, n: 1 }
    const diff = documentDiff(start, doc(setAt(start, ['a.b'], 2, none)))
    expect(diff.kind).toBe('replace')
  })

  // Final review I3: the real matcher ignores array indexes (a rule names payments.card). An item or
  // an object holding a hidden value is not taken out, renamed or replaced from the tree.
  it('never takes out, renames or replaces what holds a hidden value', () => {
    const rule = (path: readonly string[]) =>
      path.filter((p) => !/^\d+$/.test(p)).join('.') === 'payments.card'
    expect(error(removeAt(base(), ['payments', '0'], rule))).toBe('masked')
    expect(error(removeAt(base(), ['payments'], rule))).toBe('masked')
    expect(error(renameAt(base(), ['payments'], 'paid', rule))).toBe('masked')
    expect(error(setAt(base(), ['payments'], [], rule))).toBe('masked')
    // The item without one may go.
    expect(error(removeAt(base(), ['payments', '1'], rule))).toBeNull()
  })

  // Final review minor: a plain object cannot hold __proto__ as a key.
  it('refuses __proto__ as a name', () => {
    expect(error(addField(base(), ['guest'], '__proto__', 1, none))).toBe('reservedKey')
    expect(error(renameAt(base(), ['status'], '__proto__', none))).toBe('reservedKey')
  })
})

// Review 2026-11-07: a stored field named __proto__ is changed as a field, never as the prototype.
describe('a field named __proto__', () => {
  const stored = () => JSON.parse('{"_id": 1, "__proto__": {"x": "y"}, "a": "b"}') as Record<string, unknown>

  it('takes a new value as the field, keeping its place', () => {
    const out = doc(setAt(stored(), ['__proto__'], 'z', none))
    expect(Object.keys(out)).toEqual(['_id', '__proto__', 'a'])
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toBe('z')
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
  })

  it('changes a value inside it', () => {
    const out = doc(setAt(stored(), ['__proto__', 'x'], 'z', none))
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toEqual({ x: 'z' })
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
  })
})
