// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import type { Document } from 'mongodb'
import { AppError } from '../src/errors'
import { compileRules } from '../src/masking/match'
import type { GateDeps } from '../src/masking/gate/context'
import { guardBulkUpdate, NOT_A_DOCUMENT } from '../src/masking/gate/write'

/** Phase 3c §5.2: bulk operator updates and update pipelines by a restricted user. */
const masker = compileRules([
  { db: 'crm', coll: 'users', field: 'email' },
  { db: 'crm', coll: 'users', field: 'customer.phone' },
  { db: 'crm', coll: 'users', field: 'items.cardNo' },
])
const deps: GateDeps = { masker, view: async () => null, indexes: async () => [] }
async function reason(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    if (!(e instanceof AppError)) throw e
    return (e.details as { reason?: unknown }).reason
  }
  return 'allowed'
}

describe('the write gate, bulk and pipeline updates (phase 3c §5.2)', () => {
  const bulk = (update: Document | Document[], filter: Document = { name: 'Ali' }) =>
    guardBulkUpdate('crm', 'users', filter, update, deps)

  it('refuses operators that change, remove or bring personal values (review focus 2, 3)', async () => {
    for (const update of [
      { $set: { email: 'x' } },
      { $unset: { 'customer.phone': '' } },
      { $inc: { 'items.0.cardNo': 1 } },
      { $set: { 'items.$[].cardNo': 'x' } },
      { $rename: { email: 'notes' } },
      { $rename: { name: 'email' } },
      { $set: { customer: { phone: 'x' } } },
      { $push: { items: { $each: [{ cardNo: 'x' }] } } },
      { $addToSet: { items: { cardNo: 'x' } } },
      { $max: { customer: { city: 'z' } } },
      { $pop: { items: 1 } },
      { $pull: { items: { cardNo: 'x' } } },
      { $pullAll: { items: [{ qty: 1 }] } },
    ])
      expect(await reason(bulk(update)), JSON.stringify(update)).toBe('personal_write')
    expect(await reason(bulk({ $where: 1 } as Document))).toBe('masking_unsupported')
    expect(await reason(bulk({ $bit: { n: { and: 1 } } }))).toBe('masking_unsupported')
  })

  it('leaves documents whose target holds a sub-document alone (review focus 5)', async () => {
    const { filter } = await bulk({ $set: { customer: 'gone' }, $inc: { n: 1 } })
    expect(filter).toEqual({ $and: [{ name: 'Ali' }, { customer: NOT_A_DOCUMENT }] })
    const plain = await bulk({ $set: { name: 'Bea' }, $push: { tags: 'x' } })
    expect(plain.filter).toEqual({ name: 'Ali' })
    const appended = await bulk({ $push: { items: { qty: 3 } } })
    expect(appended.filter).toEqual({ name: 'Ali' })
  })

  it('refuses a filter that uses a personal field', async () => {
    expect(await reason(bulk({ $set: { name: 'x' } }, { email: 'a@x' }))).toBe('personal_field')
  })

  it('checks update pipelines: no personal reference, no move of what may hold it, no rebuild', async () => {
    expect(await reason(bulk([{ $set: { x: '$email' } }]))).toBe('personal_field')
    expect(await reason(bulk([{ $set: { x: '$customer' } }]))).toBe('personal_write')
    expect(await reason(bulk([{ $set: { 'customer.phone': 'x' } }]))).toBe('personal_write')
    expect(await reason(bulk([{ $set: { c: { phone: '$name' }, customer: { phone: 1 } } }]))).toBe(
      'personal_write',
    )
    expect(await reason(bulk([{ $unset: 'email' }]))).toBe('personal_write')
    expect(await reason(bulk([{ $replaceWith: { name: '$name' } }]))).toBe('personal_write')
    expect(await reason(bulk([{ $project: { name: 1 } }]))).toBe('personal_write')
    const ok = await bulk([{ $set: { n: { $size: '$items' }, label: { $concat: ['$name', '!'] } } }])
    expect(JSON.stringify(ok.update)).toContain('$switch')
    const conditioned = await bulk([{ $set: { customer: 'x' } }])
    expect(conditioned.filter).toEqual({ $and: [{ name: 'Ali' }, { customer: NOT_A_DOCUMENT }] })
  })
})
