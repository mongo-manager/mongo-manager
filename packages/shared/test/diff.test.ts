// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Double, Int32, Long, ObjectId } from 'bson'
import { documentDiff, type DocumentDiff } from '../src/diff'
import { bsonTypeOf, toWire } from '../src/ejson'

/** What MongoDB does with $set/$unset on dotted paths (test helper). */
function apply(doc: Record<string, unknown>, diff: DocumentDiff): Record<string, unknown> {
  if (diff.kind !== 'update') return doc
  const out = structuredClone(doc) as Record<string, unknown>
  const walk = (path: string, create: boolean) => {
    const parts = path.split('.')
    let node = out
    for (const p of parts.slice(0, -1)) {
      if (bsonTypeOf(node[p]) !== 'object') {
        if (!create) return null
        node[p] = {}
      }
      node = node[p] as Record<string, unknown>
    }
    return { node, key: parts.at(-1)! }
  }
  // MongoDB 5+ appends new fields in lexicographic order; existing ones keep their place.
  for (const [path, value] of Object.entries(diff.set).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const at = walk(path, true)!
    at.node[at.key] = value
  }
  for (const path of diff.unset) {
    const at = walk(path, false)
    if (at) delete at.node[at.key]
  }
  return out
}

describe('documentDiff (spec §4.2: field-level $set/$unset)', () => {
  it('sets changed and new fields and unsets removed ones', () => {
    const d = documentDiff(
      { _id: 1, a: 'x', b: new Int32(5), gone: true },
      { _id: 1, a: 'y', b: new Int32(5), added: [1, 2] },
    )
    expect(d.kind).toBe('update')
    if (d.kind !== 'update') return
    expect(Object.keys(d.set)).toEqual(['a', 'added'])
    expect(d.unset).toEqual(['gone'])
    expect(d.changes.map((c) => c.path)).toEqual(['a', 'gone', 'added'])
  })

  it('recurses into nested objects and replaces arrays whole', () => {
    const d = documentDiff(
      { addr: { city: 'A', zip: '1', old: 1 }, tags: ['a', 'b'] },
      { addr: { city: 'B', zip: '1' }, tags: ['a', 'c'] },
    )
    expect(d).toMatchObject({ kind: 'update', unset: ['addr.old'] })
    if (d.kind !== 'update') return
    expect(d.set).toEqual({ 'addr.city': 'B', tags: ['a', 'c'] })
  })

  it('treats a type change as a change: Int32(5) is not Double(5)', () => {
    const d = documentDiff({ n: new Int32(5) }, { n: new Double(5) })
    expect(d.kind).toBe('update')
    if (d.kind === 'update') expect(d.set.n).toBeInstanceOf(Double)
  })

  it('compares dates, ids and longs by value', () => {
    const id = ObjectId.createFromHexString('65f0a1b2c3d4e5f601234567')
    const same = {
      at: new Date('2024-01-01T00:00:00Z'),
      ref: id,
      big: Long.fromString('9007199254740993'),
    }
    const copy = {
      at: new Date('2024-01-01T00:00:00Z'),
      ref: ObjectId.createFromHexString('65f0a1b2c3d4e5f601234567'),
      big: Long.fromString('9007199254740993'),
    }
    expect(documentDiff(same, copy)).toEqual({ kind: 'none' })
  })

  it('ignores _id (the editor refuses id changes itself)', () => {
    expect(documentDiff({ _id: 1, a: 1 }, { _id: 2, a: 1 })).toEqual({ kind: 'none' })
  })

  it('asks for a replace when a changed field name cannot be a path', () => {
    for (const name of ['a.b', '$x', '', 'nul\0']) {
      const d = documentDiff({ keep: 1 }, { keep: 1, [name]: 1 })
      expect(d, JSON.stringify(name)).toMatchObject({ kind: 'replace', reason: 'field-name' })
    }
    // A change inside an object whose own name cannot be a path segment.
    expect(documentDiff({ 'a.b': { x: 1 } }, { 'a.b': { x: 2 } })).toMatchObject({
      kind: 'replace',
      reason: 'field-name',
    })
    // An unchanged odd name elsewhere does not matter.
    expect(documentDiff({ 'a.b': 1, x: 1 }, { 'a.b': 1, x: 2 }).kind).toBe('update')
  })

  it('reports a pure key-order change instead of dropping it', () => {
    expect(documentDiff({ a: 1, b: 2 }, { b: 2, a: 1 })).toMatchObject({ kind: 'replace', reason: 'order' })
  })

  it('asks for a replace beyond the server limit of 1000 paths', () => {
    const many = Object.fromEntries(
      Array.from({ length: 1001 }, (_, i) => [`f${String(i).padStart(4, '0')}`, i]),
    )
    expect(documentDiff({}, many)).toMatchObject({ kind: 'replace', reason: 'too-many' })
  })

  it('applying the diff always gives the edited document (property)', () => {
    const key = fc.stringMatching(/^[a-z]{1,3}$/)
    const leaf = fc.oneof(
      fc.integer().map((n) => new Int32(n | 0)),
      fc.double({ noNaN: true }).map((n) => new Double(n)),
      fc.string({ maxLength: 4 }),
      fc.boolean(),
      fc.constant(null),
      fc.array(fc.integer(), { maxLength: 3 }),
    )
    const doc = fc.letrec((tie) => ({
      value: fc.oneof({ depthSize: 'small' }, leaf, tie('object')),
      object: fc.dictionary(key, tie('value'), { maxKeys: 4 }),
    })).object as fc.Arbitrary<Record<string, unknown>>
    fc.assert(
      fc.property(doc, doc, (before, after) => {
        const d = documentDiff(before, after)
        if (d.kind === 'replace') return d.reason === 'order'
        // Field order included: whatever the update produces is exactly the edited document.
        expect(toWire(apply(before, d))).toBe(toWire(after))
        return true
      }),
      { numRuns: 400 },
    )
  })
})

describe('documentDiff: final review 1g-1', () => {
  it('never drops a change to a field named __proto__: it needs a replace (C3)', () => {
    const before = JSON.parse('{"a":1,"__proto__":"x"}') as Record<string, unknown>
    const after = JSON.parse('{"a":2,"__proto__":"y"}') as Record<string, unknown>
    expect(documentDiff(before, after)).toMatchObject({ kind: 'replace', reason: 'field-name' })
  })

  it('reports fields added before existing ones as an order change (I1)', () => {
    expect(documentDiff({ a: 1, b: 2 }, { a: 1, c: 3, b: 2 })).toMatchObject({
      kind: 'replace',
      reason: 'order',
    })
    // MongoDB 5+ adds new fields in lexicographic order: other orders cannot be kept by $set.
    expect(documentDiff({ a: 1 }, { a: 1, z: 1, b: 1 })).toMatchObject({ kind: 'replace', reason: 'order' })
    expect(documentDiff({ a: 1 }, { a: 1, b: 1, z: 1 }).kind).toBe('update')
    expect(documentDiff({ n: { a: 1 } }, { n: { x: 1, a: 1 } })).toMatchObject({
      kind: 'replace',
      reason: 'order',
    })
    // Numeric-looking names are ordered differently by MongoDB and by JS objects: replace.
    expect(documentDiff({ a: 1 }, { a: 1, '10': 1 })).toMatchObject({ kind: 'replace', reason: 'order' })
  })

  it('asks for a replace when a path would exceed the server limit of 1024 characters (I4)', () => {
    const k = 'k'.repeat(600)
    expect(documentDiff({ [k]: { [k]: 1 } }, { [k]: { [k]: 2 } })).toMatchObject({
      kind: 'replace',
      reason: 'path-length',
    })
  })

  it('compares key order element by element, not as joined text (Minor 4)', () => {
    expect(documentDiff({ a: 1, 'a\0a': 1 }, { 'a\0a': 1, a: 1 })).toMatchObject({ kind: 'replace' })
  })
})
