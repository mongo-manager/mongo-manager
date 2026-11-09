// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { derive, reroot } from '../src/masking/patterns'
import { compileRules, nsMaskerFrom } from '../src/masking/match'

describe('pattern re-rooting (phase 3c §3.4)', () => {
  it('re-roots a concrete rule under the moved path', () => {
    expect(reroot([['customer', 'email']], ['customer'], ['x'])).toEqual([['x', 'email']])
  })
  it('makes the target personal when the source is', () => {
    expect(reroot([['email']], ['email'], ['x'])).toEqual([['x']])
  })
  it('re-roots every rule under a moved root', () => {
    expect(reroot([['email'], ['a', 'b']], [], ['doc'])).toEqual([
      ['doc', 'email'],
      ['doc', 'a', 'b'],
    ])
  })
  it('drops rules that cannot match under the source', () => {
    expect(reroot([['email']], ['name'], ['x'])).toEqual([])
  })
  it('reads positional segments as array transparency', () => {
    expect(reroot([['items', 'cardNo']], ['items', '0'], ['first'])).toEqual([['first', 'cardNo']])
  })
  it('keeps a ** rule matching everywhere below the target', () => {
    const out = nsMaskerFrom(reroot([['**', 'phone']], ['a'], ['b']))
    expect(out.matches(['b', 'phone'])).toBe(true)
    expect(out.matches(['b', 'c', 'phone'])).toBe(true)
  })
  it('derives * as exactly one level', () => {
    expect(derive(['*', 'x'], ['a'])).toEqual([['x']])
    expect(derive(['*', 'x'], ['a', 'b'])).toEqual([])
  })
  it('exposes the patterns of a namespace and whether a database has rules', () => {
    const masker = compileRules([{ db: 'crm', coll: 'users', field: 'email' }])
    expect(masker.forNs('crm', 'users').patterns).toEqual([['email']])
    expect(masker.anyInDb('crm')).toBe(true)
    expect(masker.anyInDb('shop')).toBe(false)
  })
})
