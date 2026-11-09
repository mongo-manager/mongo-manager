// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { OperationsQuerySchema, SlowQueriesQuerySchema } from '../src/api/server-dashboard'

describe('slow-query filters (phase 3b §3.2)', () => {
  it('refuses a collection without its database (final review M7)', () => {
    expect(SlowQueriesQuerySchema.safeParse({ coll: 'users' }).success).toBe(false)
    expect(SlowQueriesQuerySchema.safeParse({ db: 'crm', coll: 'users' }).success).toBe(true)
  })
})

describe('operations filters (phase 3b §4)', () => {
  it('parses query-string values', () => {
    expect(
      OperationsQuerySchema.parse({ ns: 'shop.orders', op: 'query,update', minSecs: '2', idle: 'true' }),
    ).toEqual({
      ns: 'shop.orders',
      op: ['query', 'update'],
      minSecs: 2,
      idle: true,
    })
  })

  it('refuses unknown kinds, NUL, over-long text and out-of-range numbers', () => {
    for (const bad of [
      { op: 'eval' },
      { ns: `a${String.fromCharCode(0)}b` },
      { ns: 'x'.repeat(256) },
      { minSecs: '-1' },
      { minSecs: '99999999' },
      { idle: 'yes' },
      { unknown: '1' },
    ])
      expect(OperationsQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
  })
})
