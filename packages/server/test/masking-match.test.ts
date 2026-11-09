// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { compileRules } from '../src/masking'

const m = compileRules([
  { db: 'crm', coll: 'users', field: 'email' },
  { db: 'crm', coll: 'users', field: 'address.city' },
  { db: '*', coll: '*', field: '**.phone' },
  { db: 'shop', coll: 'orders', field: 'items.*.cardNo' },
])

describe('rule matching (phase 3b §2.3)', () => {
  it('matches names, one-level * and any-depth **', () => {
    const users = m.forNs('crm', 'users')
    expect(users.any).toBe(true)
    expect(users.matches(['email'])).toBe(true)
    expect(users.matches(['address', 'city'])).toBe(true)
    expect(users.matches(['address'])).toBe(false)
    expect(users.under(['address'])).toBe(true)
    expect(users.matches(['phone'])).toBe(true)
    expect(users.matches(['a', 'b', 'phone'])).toBe(true)
    expect(m.forNs('shop', 'orders').matches(['items', 'x', 'cardNo'])).toBe(true)
    expect(m.forNs('shop', 'orders').matches(['items', 'cardNo'])).toBe(false)
  })

  it('stays fast for many ** against a deep path (no exponential matching)', () => {
    const field = Array.from({ length: 30 }, () => '**.a').join('.') + '.z'
    const hostile = compileRules([{ db: '*', coll: '*', field }]).forNs('d', 'c')
    const deep = Array.from({ length: 100 }, () => 'a')
    const started = performance.now()
    expect(hostile.matches(deep)).toBe(false)
    expect(hostile.under(deep)).toBe(true)
    expect(performance.now() - started).toBeLessThan(200)
  })

  it('applies only to the namespaces a rule names', () => {
    const other = m.forNs('crm', 'invoices')
    expect(other.matches(['email'])).toBe(false)
    expect(other.matches(['phone'])).toBe(true) // the *.* rule
    expect(compileRules([{ db: 'crm', coll: 'users', field: 'email' }]).forNs('crm', 'x').any).toBe(false)
  })
})
