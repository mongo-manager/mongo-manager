// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import {
  MAX_PERSONAL_RULES,
  PersonalRuleSchema,
  PersonalRulesBodySchema,
  formatRule,
  ruleSegments,
} from '../src/masking/rules'

const ok = (r: object) => PersonalRuleSchema.safeParse(r).success

describe('personal-field rules (phase 3b §2.1)', () => {
  it('accepts names, * and ** where the spec allows them', () => {
    expect(ok({ db: 'crm', coll: 'users', field: 'email' })).toBe(true)
    expect(ok({ db: '*', coll: '*', field: '**.phone' })).toBe(true)
    expect(ok({ db: 'shop', coll: 'orders.archive', field: 'items.*.cardNo' })).toBe(true)
    expect(ok({ db: 'crm', coll: 'users', field: '__proto__' })).toBe(true)
  })

  it('refuses a path that ends in a wildcard, empty or $-segments, and bad names', () => {
    for (const bad of [
      { db: 'crm', coll: 'users', field: '*' },
      { db: 'crm', coll: 'users', field: 'a.**' },
      { db: 'crm', coll: 'users', field: 'a..b' },
      { db: 'crm', coll: 'users', field: '$where' },
      { db: 'crm', coll: 'users', field: 'a.$b' },
      { db: 'c/r', coll: 'users', field: 'x' },
      { db: 'crm', coll: 'a$b', field: 'x' },
      { db: 'crm', coll: 'users\u0000', field: 'x' },
      { db: 'crm', coll: 'users', field: 'x', extra: 1 },
    ])
      expect(ok(bad), JSON.stringify(bad)).toBe(false)
  })

  it('refuses a rule over 512 bytes', () => {
    expect(ok({ db: 'crm', coll: 'users', field: 'a'.repeat(600) })).toBe(false)
  })

  it('caps the list at 200 and refuses duplicates', () => {
    const many = Array.from({ length: MAX_PERSONAL_RULES + 1 }, (_, i) => ({
      db: 'd',
      coll: 'c',
      field: `f${i}`,
    }))
    expect(PersonalRulesBodySchema.safeParse({ rules: many }).success).toBe(false)
    const dup = { db: 'd', coll: 'c', field: 'x' }
    expect(PersonalRulesBodySchema.safeParse({ rules: [dup, { ...dup }] }).success).toBe(false)
  })

  it('splits and formats', () => {
    expect(ruleSegments('**.a.*.b')).toEqual(['**', 'a', '*', 'b'])
    expect(formatRule({ db: '*', coll: 'users', field: 'email' })).toBe('*.users.email')
  })
})
