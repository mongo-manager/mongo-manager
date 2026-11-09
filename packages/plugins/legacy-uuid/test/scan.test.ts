// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { scanUuids, wellFormed } from '../src/scan'
import { parseUuid, stored } from '../src/uuid'

// Version 4 UUIDs (random), as each driver stored them.
const A = parseUuid('3b241101-e2bb-4255-8caf-4136c566a962')!
const B = parseUuid('9f4c2a7e-1d3b-4f6a-b0c8-2e5d7a9b1c3f')!
const java = (u: Uint8Array) => stored(u, 'java')
const csharp = (u: Uint8Array) => stored(u, 'csharp')
const standard = (u: Uint8Array) => stored(u, 'standard')
/** Twenty version 4 UUIDs from a fixed seed: enough that a wrong order is ruled out. */
const MANY = Array.from({ length: 20 }, (_, n) => {
  let x = 2463534242 + n * 7919
  const b = Uint8Array.from({ length: 16 }, () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return (x >>> 0) & 0xff
  })
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  return b
})

describe('the UUID fields of a sample', () => {
  it('finds legacy and standard UUIDs, nested and in arrays, the most found first', () => {
    const docs = [
      {
        _id: { $oid: '65a1b2c3d4e5f60718293a4b' },
        customerId: java(A),
        items: [{ ref: standard(B) }, { ref: standard(A) }],
      },
      { customerId: java(B), when: { $date: { $numberLong: '0' } }, note: 'x' },
      { other: { $binary: { base64: 'AAAA', subType: '00' } } },
    ]
    const fields = scanUuids(docs)
    expect(fields.map((f) => [f.path, f.legacy, f.standard])).toEqual([
      ['customerId', 2, 0],
      ['items.ref', 0, 2],
    ])
    expect(fields[0]!.examples).toHaveLength(2)
  })

  it('names the driver whose order reads every legacy value as a well-formed UUID', () => {
    expect(scanUuids(MANY.map((u) => ({ a: java(u) })))[0]!.likely).toEqual(['java'])
    expect(scanUuids(MANY.map((u) => ({ a: csharp(u) })))[0]!.likely).toEqual(['csharp'])
    expect(scanUuids(MANY.map((u) => ({ a: stored(u, 'python') })))[0]!.likely).toEqual(['python'])
    // A few values may fit more than one order: all of them are named.
    expect(scanUuids([{ a: csharp(A) }, { a: csharp(B) }])[0]!.likely).toContain('csharp')
    // Values of two drivers in one field: no order reads them all.
    expect(scanUuids([{ a: java(A) }, { a: csharp(B) }])[0]!.likely).toEqual([])
    // The nil and max UUIDs (Guid.Empty is common in C# data) are the same in every order: left out.
    const nil = { $binary: { base64: 'AAAAAAAAAAAAAAAAAAAAAA==', subType: '03' } }
    const max = { $binary: { base64: '/////////////////////w==', subType: '03' } }
    expect(scanUuids([...MANY.map((u) => ({ a: csharp(u) })), { a: nil }, { a: max }])[0]!.likely).toEqual([
      'csharp',
    ])
    expect(scanUuids([{ a: nil }, { a: nil }])[0]).toMatchObject({ legacy: 2, likely: [] })
    // Standard UUIDs need no guess.
    expect(scanUuids([{ a: standard(A) }])[0]!.likely).toEqual([])
  })

  it('lists the fields with the most UUIDs first, by name between equals', () => {
    const docs = [{ b: java(A) }, { a: java(A), c: java(B) }, { a: java(B), c: java(A) }, { a: java(A) }]
    expect(scanUuids(docs).map((f) => f.path)).toEqual(['a', 'c', 'b'])
  })

  it('keeps three examples, and stops at a depth far beyond any document', () => {
    expect(scanUuids(Array.from({ length: 5 }, () => ({ a: java(A) })))[0]!.examples).toHaveLength(3)
    let deep: unknown = { u: java(A) }
    for (let i = 0; i < 40; i++) deep = { d: deep }
    expect(scanUuids([deep])).toEqual([])
  })

  it('tells a well-formed UUID by its version and variant', () => {
    expect(wellFormed(A)).toBe(true)
    expect(wellFormed(parseUuid('3b241101-e2bb-0255-8caf-4136c566a962')!)).toBe(false)
    expect(wellFormed(parseUuid('3b241101-e2bb-4255-0caf-4136c566a962')!)).toBe(false)
  })
})
