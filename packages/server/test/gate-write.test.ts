// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { Int32, type Document } from 'mongodb'
import { AppError } from '../src/errors'
import { compileRules } from '../src/masking/match'
import type { GateDeps } from '../src/masking/gate/context'
import { Shape } from '../src/masking/gate/shape'
import {
  guardDocumentUpdate,
  guardInsert,
  personalLocations,
  restoreReplacement,
} from '../src/masking/gate/write'

/** Phase 3c §5.1: single-document writes by a restricted user. */
const masker = compileRules([
  { db: 'crm', coll: 'users', field: 'email' },
  { db: 'crm', coll: 'users', field: 'customer.phone' },
  { db: 'crm', coll: 'users', field: 'items.cardNo' },
])
const deps: GateDeps = { masker, view: async () => null, indexes: async () => [] }
const shape = () => new Shape('crm.users', masker.forNs('crm', 'users').patterns)
async function reason(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    if (!(e instanceof AppError)) throw e
    return (e.details as { reason?: unknown }).reason
  }
  return 'allowed'
}
const stored: Document = {
  _id: 1,
  email: 'a@x',
  name: 'Ali',
  customer: { phone: new Int32(5551234), city: 'Izmir' },
  items: [
    { cardNo: 'c1', qty: 1 },
    { cardNo: 'c2', qty: 2 },
  ],
}

describe('the write gate, single documents (phase 3c §5.1)', () => {
  it('finds personal values with their array positions', () => {
    expect(personalLocations(stored, shape())).toEqual([
      ['email'],
      ['customer', 'phone'],
      ['items', '0', 'cardNo'],
      ['items', '1', 'cardNo'],
    ])
  })

  it('refuses inserting any personal value, allows the rest', async () => {
    expect(await reason(guardInsert('crm', 'users', [{ name: 'x' }], deps))).toBe('allowed')
    expect(await reason(guardInsert('crm', 'users', [{ name: 'x' }, { email: 'e' }], deps))).toBe(
      'personal_write',
    )
    expect(await reason(guardInsert('crm', 'users', [{ items: [{ cardNo: 'x' }] }], deps))).toBe(
      'personal_write',
    )
  })

  it('refuses updates that change, remove or bring personal values (review focus 2, 3)', async () => {
    const update = (set: Document, unset: string[] = []) =>
      guardDocumentUpdate('crm', 'users', stored, set, unset, deps)
    expect(await reason(update({ name: 'Bea', 'customer.city': 'Ankara', 'items.0.qty': 3 }))).toBe('allowed')
    expect(await reason(update({ email: 'b@x' }))).toBe('personal_write')
    expect(await reason(update({ 'items.1.cardNo': 'x' }))).toBe('personal_write')
    expect(await reason(update({ 'items.$[].cardNo': 'x' }))).toBe('personal_write')
    expect(await reason(update({ 'email.x': 1 }))).toBe('personal_write')
    expect(await reason(update({ customer: { city: 'x' } }))).toBe('personal_write')
    expect(await reason(update({ items: [] }))).toBe('personal_write')
    expect(await reason(update({}, ['customer']))).toBe('personal_write')
    expect(await reason(update({}, ['email']))).toBe('personal_write')
    expect(await reason(update({}, ['name']))).toBe('allowed')
    const plain = { ...stored, customer: 'none' }
    expect(
      await reason(guardDocumentUpdate('crm', 'users', plain, { customer: { city: 'x' } }, [], deps)),
    ).toBe('allowed')
    expect(
      await reason(guardDocumentUpdate('crm', 'users', plain, { customer: { phone: 'x' } }, [], deps)),
    ).toBe('personal_write')
  })

  it('puts the stored personal values back into a replacement, with their types (review focus 1, 4)', async () => {
    const submitted: Document = {
      email: '***',
      name: 'Ali Veli',
      customer: { phone: '***', city: 'Ankara' },
      items: [
        { cardNo: '***', qty: 5 },
        { cardNo: '***', qty: 2 },
      ],
    }
    const out = await restoreReplacement('crm', 'users', stored, submitted, deps)
    expect(out).toEqual({
      email: 'a@x',
      name: 'Ali Veli',
      customer: { phone: new Int32(5551234), city: 'Ankara' },
      items: [
        { cardNo: 'c1', qty: 5 },
        { cardNo: 'c2', qty: 2 },
      ],
    })
    expect((out.customer as Document).phone).toBeInstanceOf(Int32)
    expect(submitted.email).toBe('***')
  })

  it('refuses a replacement that changes, drops, moves or adds a personal value', async () => {
    const base: Document = {
      email: '***',
      name: 'Ali',
      customer: { phone: '***', city: 'Izmir' },
      items: [
        { cardNo: '***', qty: 1 },
        { cardNo: '***', qty: 2 },
      ],
    }
    const replace = (doc: Document) => restoreReplacement('crm', 'users', stored, doc, deps)
    expect(await reason(replace({ ...base, email: 'b@x' }))).toBe('personal_write')
    const { email: _e, ...noEmail } = base
    expect(await reason(replace(noEmail))).toBe('personal_write')
    expect(await reason(replace({ ...base, items: [(base.items as Document[])[0]] }))).toBe('personal_write')
    expect(await reason(replace({ ...base, customer: '***' }))).toBe('personal_write')
    expect(await reason(replace({ ...base, other: { email: '***' } }))).toBe('allowed')
    const fresh = { ...stored, customer: 'none' }
    expect(
      await reason(restoreReplacement('crm', 'users', fresh, { ...base, customer: { phone: '***' } }, deps)),
    ).toBe('personal_write')
  })

  it('refuses replacing a document whose _id is personal', async () => {
    const idRules = compileRules([{ db: 'crm', coll: 'ids', field: '_id' }])
    const idDeps: GateDeps = { masker: idRules, view: async () => null, indexes: async () => [] }
    expect(await reason(restoreReplacement('crm', 'ids', { _id: 'a@x', n: 1 }, { n: 2 }, idDeps))).toBe(
      'personal_write',
    )
  })
})
