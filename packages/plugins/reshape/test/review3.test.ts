// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { shapeOf } from '../../kit/src/shape'
import { hiddenGuard, problemOf } from '../src/reshape'

/**
 * Plugins wave 3, third review (Important 2): a field the sample met only as a value is held back
 * only when a rule names a field below it by its very name — never through `*` or `**`, or a common
 * `*.ssn` rule would leave no top-level field to reshape.
 */
describe('a rule below a field the sample met as a value (third review)', () => {
  const docs = [{ profile: 'n/a', name: 'Ada', status: 'active', contact: { ssn: '***', city: 'Izmir' } }]

  it('never holds back a value-only field for a rule that names it through *', () => {
    const star = [['*', 'ssn']]
    const g = hiddenGuard(star, shapeOf(docs, star))
    for (const from of ['name', 'status', 'profile'])
      expect(problemOf({ kind: 'rename', from, to: `${from}2` }, g)).toBeNull()
    // The object that does hold the hidden field is still refused, as is the field itself.
    expect(problemOf({ kind: 'rename', from: 'contact', to: 'c' }, g)).toBe('hidden')
    expect(problemOf({ kind: 'rename', from: 'contact.ssn', to: 'x' }, g)).toBe('hidden')
  })

  it('holds back a value-only field a rule names a field below by its own name', () => {
    const named = [['profile', 'ssn']]
    const g = hiddenGuard(named, shapeOf(docs, named))
    expect(problemOf({ kind: 'rename', from: 'profile', to: 'p' }, g)).toBe('hidden')
    expect(problemOf({ kind: 'rename', from: 'name', to: 'n' }, g)).toBeNull()
    // Named deeper, through a * further down: still its own name first.
    const deeper = [['profile', '*', 'ssn']]
    const d = hiddenGuard(deeper, shapeOf(docs, deeper))
    expect(problemOf({ kind: 'rename', from: 'profile', to: 'p' }, d)).toBe('hidden')
    expect(problemOf({ kind: 'rename', from: 'status', to: 's' }, d)).toBeNull()
  })
})
