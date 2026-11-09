// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { KnownSignIns, LoginThrottle } from '../src/auth/throttle'

describe('LoginThrottle', () => {
  it('allows 5 free failures, then doubles the delay from 1 s up to 15 min', () => {
    const clock = { now: 0 }
    const t = new LoginThrottle(() => clock.now)
    for (let i = 0; i < 5; i++) {
      expect(t.retryAfterMs('k')).toBe(0)
      t.recordFailure('k')
    }
    expect(t.retryAfterMs('k')).toBe(0)
    t.recordFailure('k')
    expect(t.retryAfterMs('k')).toBe(1000)
    clock.now += 1000
    t.recordFailure('k')
    expect(t.retryAfterMs('k')).toBe(2000)
    for (let i = 0; i < 20; i++) t.recordFailure('k')
    expect(t.retryAfterMs('k')).toBe(15 * 60_000)
  })

  it('keeps keys independent and resets on success', () => {
    const t = new LoginThrottle(() => 0)
    for (let i = 0; i < 6; i++) t.recordFailure('a')
    expect(t.retryAfterMs('a')).toBeGreaterThan(0)
    expect(t.retryAfterMs('b')).toBe(0)
    t.reset('a')
    expect(t.retryAfterMs('a')).toBe(0)
  })

  // Security review 2026-10-13 (L1) and its review.
  it('gives keys of a prefix their own number of free attempts', () => {
    const t = new LoginThrottle(() => 0, { freeByPrefix: { 'account:': 50 } })
    for (let i = 0; i < 6; i++) t.recordFailure('account:a')
    expect(t.retryAfterMs('account:a')).toBe(0)
    for (let i = 0; i < 45; i++) t.recordFailure('account:a')
    expect(t.retryAfterMs('account:a')).toBeGreaterThan(0)
    for (let i = 0; i < 6; i++) t.recordFailure('user:a')
    expect(t.retryAfterMs('user:a')).toBeGreaterThan(0)
  })

  it('takes back the lock a forgiven failure set', () => {
    const clock = { now: 0 }
    const t = new LoginThrottle(() => clock.now)
    for (let i = 0; i < 9; i++) t.recordFailure('k')
    clock.now += 60 * 60_000
    const before = t.recordFailure('k')
    expect(t.retryAfterMs('k')).toBeGreaterThan(0)
    t.forgive('k', before)
    expect(t.retryAfterMs('k')).toBe(0)
  })

  it('forgets failures older than a day', () => {
    const clock = { now: 0 }
    const t = new LoginThrottle(() => clock.now)
    for (let i = 0; i < 5; i++) t.recordFailure('k')
    clock.now += 24 * 3600_000 + 1
    t.recordFailure('k')
    expect(t.retryAfterMs('k')).toBe(0)
  })

  it('bounds memory by evicting the oldest keys', () => {
    const t = new LoginThrottle(() => 0, { maxKeys: 3 })
    for (const k of ['a', 'b', 'c', 'd']) for (let i = 0; i < 6; i++) t.recordFailure(k)
    expect(t.retryAfterMs('a')).toBe(0)
    expect(t.retryAfterMs('d')).toBeGreaterThan(0)
  })
})

// Security review 2026-10-13 (L1) and its review (minor 3).
describe('KnownSignIns', () => {
  it('knows an address for 30 days', () => {
    const clock = { now: 0 }
    const k = new KnownSignIns(() => clock.now)
    k.add('ada', 'ip:10.0.0.1')
    expect(k.has('ada', 'ip:10.0.0.1')).toBe(true)
    expect(k.has('bob', 'ip:10.0.0.1')).toBe(false)
    clock.now += 30 * 24 * 3600_000 + 1
    expect(k.has('ada', 'ip:10.0.0.1')).toBe(false)
  })

  it('never lets one account push another’s addresses out', () => {
    const k = new KnownSignIns(() => 0, 30 * 24 * 3600_000, 100, 20)
    k.add('victim', 'ip:10.0.0.1')
    for (let i = 0; i < 10_000; i++) k.add('insider', `ip:2001:db8:${i.toString(16)}::`)
    expect(k.has('victim', 'ip:10.0.0.1')).toBe(true)
    expect(k.has('insider', 'ip:2001:db8:0::')).toBe(false)
    expect(k.has('insider', 'ip:2001:db8:270f::')).toBe(true)
  })
})
