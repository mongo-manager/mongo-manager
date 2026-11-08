// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import type { Document } from 'mongodb'
import { AppError } from '../src/errors'
import { compileRules } from '../src/masking/match'
import { newCtx, type GateDeps } from '../src/masking/gate/context'
import { guardStages, sourceShape } from '../src/masking/gate/pipeline'
import { typeGuard } from '../src/masking/gate/guard'

const masker = compileRules([
  { db: 'crm', coll: 'users', field: 'email' },
  { db: 'crm', coll: 'users', field: 'customer.phone' },
])
const views: Record<string, { viewOn: string; pipeline: Document[] }> = {
  'crm.users_v': { viewOn: 'users', pipeline: [{ $project: { email: 1, name: 1 } }] },
  'crm.by_email': { viewOn: 'users', pipeline: [{ $group: { _id: '$email' } }] },
  'crm.v_of_v': { viewOn: 'users_v', pipeline: [{ $match: { name: 'a' } }] },
  'crm.sorted': { viewOn: 'users', pipeline: [{ $sort: { customer: 1 } }] },
}
const deps: GateDeps = {
  masker,
  view: async (db, coll) => views[`${db}.${coll}`] ?? null,
  indexes: async () => [],
}
async function guard(coll: string, stages: Document[]) {
  const gc = newCtx(deps, 'crm')
  const shape = await sourceShape('crm', coll, gc)
  const out = await guardStages(stages, shape, gc)
  return { ...out, output: shape.output() }
}
async function reason(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    return ((e as AppError).details as { reason?: unknown }).reason
  }
  return 'allowed'
}

describe('pipelines (phase 3c §3.4-3.6)', () => {
  it('re-roots a moved subtree and refuses a later match on it', async () => {
    const { output } = await guard('users', [{ $project: { x: '$customer' } }])
    expect(output.matches(['x', 'phone'])).toBe(true)
    expect(
      await reason(guard('users', [{ $project: { x: '$customer' } }, { $match: { 'x.phone': '1' } }])),
    ).toBe('personal_field')
  })

  it('refuses grouping, joining and unwinding on a personal field', async () => {
    expect(await reason(guard('users', [{ $group: { _id: '$email' } }]))).toBe('personal_field')
    expect(
      await reason(
        guard('users', [{ $lookup: { from: 'orders', localField: 'email', foreignField: 'e', as: 'o' } }]),
      ),
    ).toBe('personal_field')
    expect(await reason(guard('users', [{ $unwind: '$email' }]))).toBe('personal_field')
  })

  it('rewrites a sort that may hold personal data, and maps stages back to the user stages', async () => {
    const { stages, ends } = await guard('users', [{ $sort: { customer: 1, name: -1 } }, { $limit: 5 }])
    const temp = Object.keys((stages[0] as { $addFields: Document }).$addFields)[0]!
    expect(temp).toMatch(/^__mm_s0_/)
    expect(stages).toEqual([
      { $addFields: { [temp]: typeGuard('$customer') } },
      { $sort: { [temp]: 1, name: -1 } },
      { $unset: [temp] },
      { $limit: 5 },
    ])
    expect(ends).toEqual([3, 4])
  })

  it('guards a join key that may hold personal data and nests the foreign rules under as', async () => {
    const { stages, output } = await guard('orders', [
      { $lookup: { from: 'users', localField: 'buyer', foreignField: 'customer', as: 'u' } },
    ])
    const temp = Object.keys((stages[0] as { $addFields: Document }).$addFields)[0]!
    expect(temp).toMatch(/^__mm_l0_/)
    expect(stages[0]).toEqual({ $addFields: { [temp]: typeGuard('$buyer') } })
    expect(stages[1]).toMatchObject({ $lookup: { localField: temp, foreignField: 'customer', as: 'u' } })
    expect(stages[2]).toEqual({ $unset: [temp] })
    expect(output.matches(['u', 'email'])).toBe(true)
  })

  it('checks views strictly, through views of views and joins (review focus 2)', async () => {
    expect((await guard('users_v', [])).output.matches(['email'])).toBe(true)
    expect(await reason(guard('by_email', []))).toBe('personal_field')
    expect((await guard('v_of_v', [])).output.matches(['email'])).toBe(true)
    expect(await reason(guard('sorted', []))).toBe('masking_unsupported')
    expect(await reason(guard('orders', [{ $lookup: { from: 'by_email', pipeline: [], as: 'x' } }]))).toBe(
      'personal_field',
    )
  })

  it('refuses unmodelled stages, and writes out of a ruled namespace', async () => {
    // W5: $redact and the window stages are modelled now (gate-window-stages.test.ts); a $redact
    // reading each level's fields where rules apply is still refused.
    for (const stage of [
      { $redact: { $cond: [{ $eq: ['$x', 1] }, '$$KEEP', '$$PRUNE'] } },
      { $search: {} },
      { $unknown: {} },
    ])
      expect(await reason(guard('users', [stage]))).toBe('masking_unsupported')
    expect(await reason(guard('users', [{ $out: 'copy' }]))).toBe('masking_unsupported')
    expect(await reason(guard('notes', [{ $out: 'copy' }]))).toBe('allowed')
  })

  it('merges facet outputs under their keys, and guards group keys', async () => {
    const { output, stages } = await guard('users', [{ $facet: { a: [{ $project: { c: '$customer' } }] } }])
    expect(output.matches(['a', 'c', 'phone'])).toBe(true)
    expect(stages).toHaveLength(1)
    expect((await guard('users', [{ $group: { _id: '$customer', n: { $sum: 1 } } }])).stages[0]).toEqual({
      $group: { _id: typeGuard('$customer'), n: { $sum: 1 } },
    })
  })

  it('stops at ten levels of views', async () => {
    const deep: GateDeps = { ...deps, view: async (_db, coll) => ({ viewOn: `${coll}x`, pipeline: [] }) }
    expect(await reason(sourceShape('crm', 'v', newCtx(deep, 'crm')))).toBe('masking_unsupported')
  })
})
