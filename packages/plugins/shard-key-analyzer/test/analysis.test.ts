// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import {
  MAX_FIELDS,
  candidateFields,
  createIndexText,
  keyProblem,
  keyText,
  verdictsOf,
  type Analysis,
} from '../src/analysis'
import { shapeOf } from '../../kit/src/shape'

/** Plugins wave 4 (spec §4): candidate shard keys and what analyzeShardKey says of them. */
type Available = Extract<Analysis, { available: true }>
const result = (o: Partial<Available> = {}): Available => ({
  available: true,
  numDocsTotal: 100_000,
  numDocsSampled: 10_000,
  numDistinctValues: 50_000,
  avgDocSizeBytes: 200,
  isUnique: false,
  mostCommonValues: [{ value: 'a', frequency: 20 }],
  monotonicity: 'not monotonic',
  ...o,
})

describe('the fields a key may hold', () => {
  it('are the sampled fields but those hidden, in arrays, objects or arrays themselves', () => {
    const shape = shapeOf(
      [
        {
          _id: { $oid: '65a1b2c3d4e5f60718293a01' },
          city: 'Izmir',
          ssn: '***',
          tags: ['a'],
          items: [{ q: 1 }],
        },
        { _id: { $oid: '65a1b2c3d4e5f60718293a02' }, city: 'Ankara', ssn: '***', address: { zip: '35000' } },
      ],
      [['ssn']],
    )
    expect(candidateFields(shape)).toEqual(['_id', 'address.zip', 'city'])
  })

  // Final review Minor 13: JavaScript moves a key named as an integer first — never offered.
  it('leaves out a field named as an integer', () => {
    expect(candidateFields(shapeOf([{ _id: 1, '0': 'x', '12': 'y', a1: 'z' }], []))).toEqual(['_id', 'a1'])
  })
})

describe('a candidate key', () => {
  it('is one to five fields, each once, one hashed at most, none hidden', () => {
    const offered = ['a', 'b', 'c', 'd', 'e', 'f']
    expect(keyProblem([], offered)).toBe('empty')
    expect(keyProblem([{ field: 'a', hashed: false }], offered)).toBeNull()
    expect(keyProblem([{ field: 'zzz', hashed: false }], offered)).toBe('unknown')
    expect(
      keyProblem(
        [
          { field: 'a', hashed: false },
          { field: 'a', hashed: true },
        ],
        offered,
      ),
    ).toBe('twice')
    expect(
      keyProblem(
        [
          { field: 'a', hashed: true },
          { field: 'b', hashed: true },
        ],
        offered,
      ),
    ).toBe('hashed')
    const six = offered.map((field) => ({ field, hashed: false }))
    expect(keyProblem(six.slice(0, MAX_FIELDS), offered)).toBeNull()
    expect(keyProblem(six, offered)).toBe('tooMany')
  })

  it('is written as MongoDB takes it, and its index as the shell creates it', () => {
    const key = [
      { field: 'city', hashed: false },
      { field: 'user.id', hashed: true },
    ]
    expect(keyText(key)).toBe('{ city: 1, "user.id": "hashed" }')
    expect(createIndexText('orders', key)).toBe(
      'db.getCollection("orders").createIndex({ city: 1, "user.id": "hashed" })',
    )
    expect(createIndexText('we"ird', [{ field: 'a', hashed: false }])).toBe(
      'db.getCollection("we\\"ird").createIndex({ a: 1 })',
    )
  })
})

describe('what the analysis says', () => {
  it('a key of many values, none common, not monotonic, is good', () => {
    expect(verdictsOf(result(), false)).toEqual({
      cardinality: 'good',
      frequency: 'good',
      monotonicity: 'good',
      overall: 'good',
    })
  })

  it('few values, a common one or a growing key are each a problem; the worst decides', () => {
    expect(verdictsOf(result({ numDistinctValues: 50 }), false)).toMatchObject({
      cardinality: 'poor',
      overall: 'poor',
    })
    expect(verdictsOf(result({ numDistinctValues: 500 }), false)).toMatchObject({
      cardinality: 'fair',
      overall: 'fair',
    })
    // 25% of the sampled documents hold one value.
    expect(verdictsOf(result({ mostCommonValues: [{ value: 'x', frequency: 2500 }] }), false)).toMatchObject({
      frequency: 'poor',
    })
    expect(verdictsOf(result({ mostCommonValues: [{ value: 'x', frequency: 1000 }] }), false)).toMatchObject({
      frequency: 'fair',
    })
    expect(verdictsOf(result({ monotonicity: 'monotonic' }), false)).toMatchObject({
      monotonicity: 'poor',
      overall: 'poor',
    })
  })

  it('a unique key has the most values; a hashed key spreads a growing one', () => {
    expect(verdictsOf(result({ numDistinctValues: 3, isUnique: true }), false).cardinality).toBe('good')
    expect(verdictsOf(result({ monotonicity: 'monotonic' }), true).monotonicity).toBe('good')
  })

  it('what is not known is not judged', () => {
    expect(
      verdictsOf(
        result({
          numDistinctValues: null,
          mostCommonValues: [],
          numDocsSampled: null,
          monotonicity: 'unknown',
        }),
        false,
      ),
    ).toEqual({ cardinality: 'unknown', frequency: 'unknown', monotonicity: 'unknown', overall: 'unknown' })
  })
})
