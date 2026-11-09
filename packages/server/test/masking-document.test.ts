// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { compileRules, maskDocument, MASK } from '../src/masking'

const ns = compileRules([
  { db: 'crm', coll: 'users', field: 'email' },
  { db: 'crm', coll: 'users', field: 'address.city' },
  { db: 'crm', coll: 'users', field: '**.phone' },
  { db: 'crm', coll: 'users', field: '__proto__' },
]).forNs('crm', 'users')

describe('maskDocument (phase 3b §2.3)', () => {
  it('replaces personal values whole, keeping keys, through arrays and wrappers', () => {
    const doc = {
      _id: { $oid: '0123456789abcdef01234567' },
      email: 'ada@example.com',
      address: { city: 'Ankara', zip: '06000' },
      contacts: [{ phone: '555' }, { phone: { $numberLong: '5' } }],
      nested: { deep: { phone: ['1', '2'] } },
    }
    expect(maskDocument(doc, ns)).toEqual({
      _id: { $oid: '0123456789abcdef01234567' },
      email: MASK,
      address: { city: MASK, zip: '06000' },
      contacts: [{ phone: MASK }, { phone: MASK }],
      nested: { deep: { phone: MASK } },
    })
  })

  it('handles hostile keys as data and never mutates the input (review focus 5)', () => {
    const doc = JSON.parse('{"__proto__":{"polluted":1},"constructor":"c","a.b":"dotted","$x":"d"}') as object
    const copy = structuredClone(doc)
    const out = maskDocument(doc, ns) as Record<string, unknown>
    expect(Object.keys(out)).toEqual(['__proto__', 'constructor', 'a.b', '$x'])
    expect(out['__proto__']).toBe(MASK)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(doc).toEqual(copy)
  })

  it('leaves a namespace without rules untouched', () => {
    const plain = compileRules([]).forNs('crm', 'users')
    const doc = { email: 'x' }
    expect(maskDocument(doc, plain)).toEqual(doc)
  })
})
