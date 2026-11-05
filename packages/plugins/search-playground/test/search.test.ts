// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import {
  MAX_DIMENSIONS,
  filterOf,
  highlightParts,
  searchPipeline,
  textPaths,
  vectorOf,
  vectorPipeline,
  vectorPaths,
  valueAt,
  type SearchIndex,
} from '../src/search'

/** Plugins wave 4 (spec §5): the pipelines the playground runs, and what it reads of the answers. */
const TEXT_INDEX: SearchIndex = {
  name: 'default',
  type: 'search',
  status: 'READY',
  queryable: true,
  dynamic: false,
  fields: [
    { path: 'title', type: 'string' },
    { path: 'year', type: 'number' },
    { path: 'plot', type: 'autocomplete' },
    { path: 'cast.name', type: 'string' },
  ],
}
const VECTOR_INDEX: SearchIndex = {
  name: 'vec',
  type: 'vectorSearch',
  status: 'READY',
  queryable: true,
  dynamic: false,
  fields: [
    { path: 'embedding', type: 'vector', numDimensions: 3, similarity: 'cosine' },
    { path: 'year', type: 'filter' },
  ],
}

describe('a full-text search', () => {
  it('reads one field, or all the index maps, with fuzzy matching and highlights when asked', () => {
    expect(
      searchPipeline({
        index: 'default',
        query: 'ring',
        path: 'title',
        fuzzy: 1,
        highlight: true,
        limit: 10,
      }),
    ).toEqual([
      {
        $search: {
          index: 'default',
          text: { query: 'ring', path: 'title', fuzzy: { maxEdits: 1 } },
          highlight: { path: 'title' },
        },
      },
      { $limit: 10 },
      { $set: { _score: { $meta: 'searchScore' }, _highlights: { $meta: 'searchHighlights' } } },
    ])
    expect(
      searchPipeline({ index: 'default', query: 'x', path: '*', fuzzy: 0, highlight: false, limit: 5 }),
    ).toEqual([
      { $search: { index: 'default', text: { query: 'x', path: { wildcard: '*' } } } },
      { $limit: 5 },
      { $set: { _score: { $meta: 'searchScore' } } },
    ])
  })

  it('offers the text fields an index maps, all of them for a dynamic one', () => {
    expect(textPaths(TEXT_INDEX)).toEqual(['cast.name', 'title'])
    expect(textPaths({ ...TEXT_INDEX, dynamic: true })).toEqual(['*', 'cast.name', 'title'])
    expect(textPaths(VECTOR_INDEX)).toEqual([])
  })

  it('reads highlights as text and hits, never as markup', () => {
    expect(
      highlightParts([
        {
          path: 'title',
          score: 1.2,
          texts: [
            { value: 'The ', type: 'text' },
            { value: '<b>Ring', type: 'hit' },
          ],
        },
        { path: 'x', texts: 'not a list' },
        'junk',
      ]),
    ).toEqual([
      {
        path: 'title',
        parts: [
          { text: 'The ', hit: false },
          { text: '<b>Ring', hit: true },
        ],
      },
    ])
  })
})

describe('a vector search', () => {
  it('compares a vector with the index’s, with candidates, a limit and a filter', () => {
    expect(
      vectorPipeline({
        index: 'vec',
        path: 'embedding',
        vector: [0.1, 0.2, 0.3],
        numCandidates: 100,
        limit: 10,
        filter: { year: { $gte: 2000 } },
      }),
    ).toEqual([
      {
        $vectorSearch: {
          index: 'vec',
          path: 'embedding',
          queryVector: [0.1, 0.2, 0.3],
          numCandidates: 100,
          limit: 10,
          filter: { year: { $gte: 2000 } },
        },
      },
      { $set: { _score: { $meta: 'vectorSearchScore' } } },
    ])
    expect(
      vectorPipeline({
        index: 'vec',
        path: 'embedding',
        vector: [1],
        numCandidates: 10,
        limit: 1,
        filter: null,
      })[0],
    ).toEqual({
      $vectorSearch: { index: 'vec', path: 'embedding', queryVector: [1], numCandidates: 10, limit: 1 },
    })
  })

  it('offers the vector fields of an index', () => {
    expect(vectorPaths(VECTOR_INDEX)).toEqual([{ path: 'embedding', numDimensions: 3 }])
    expect(vectorPaths(TEXT_INDEX)).toEqual([])
  })

  it('takes a vector of numbers as pasted or as a document holds it, and nothing else', () => {
    expect(vectorOf([0.5, { $numberDouble: '0.25' }, { $numberInt: '1' }, { $numberLong: '2' }])).toEqual([
      0.5, 0.25, 1, 2,
    ])
    expect(vectorOf('[0.5, -1e-3]')).toEqual([0.5, -0.001])
    expect(vectorOf('0.5, 1')).toEqual([0.5, 1])
    for (const bad of [
      [],
      ['a'],
      [{ $numberDouble: 'NaN' }],
      '[1, "x"]',
      'nope',
      { $binary: { base64: 'AA==', subType: '09' } },
      null,
    ])
      expect(vectorOf(bad)).toBeNull()
    expect(vectorOf(Array(MAX_DIMENSIONS + 1).fill(0))).toBeNull()
  })

  // Final review Minor 15: a BSON vector (binary subtype 9), as Atlas recommends storing them.
  it('reads a BSON vector of float32 or int8 values, not a packed bit one', () => {
    const bytes = (dtype: number, body: number[]) => btoa(String.fromCharCode(dtype, 0, ...body))
    const f32 = new Uint8Array(new Float32Array([0.5, 1, -2]).buffer)
    expect(vectorOf({ $binary: { base64: bytes(0x27, [...f32]), subType: '09' } })).toEqual([0.5, 1, -2])
    expect(vectorOf({ $binary: { base64: bytes(0x03, [1, 255, 127]), subType: '09' } })).toEqual([1, -1, 127])
    expect(vectorOf({ $binary: { base64: bytes(0x10, [255]), subType: '09' } })).toBeNull()
    expect(vectorOf({ $binary: { base64: bytes(0x27, [1, 2, 3]), subType: '09' } })).toBeNull()
    expect(vectorOf({ $binary: { base64: bytes(0x27, [...f32]), subType: '00' } })).toBeNull()
  })

  it('finds a value at a path in a document', () => {
    expect(valueAt({ a: { b: [1, 2] } }, 'a.b')).toEqual([1, 2])
    expect(valueAt({ a: 1 }, 'a.b')).toBeUndefined()
    expect(valueAt({ __proto__: { x: 1 } } as never, 'x')).toBeUndefined()
  })
})

describe('a filter as typed', () => {
  it('is a JSON object, or nothing', () => {
    expect(filterOf('')).toEqual({ ok: true, filter: null })
    expect(filterOf(' { "year": { "$gte": 2000 } } ')).toEqual({ ok: true, filter: { year: { $gte: 2000 } } })
    expect(filterOf('[1]')).toEqual({ ok: false })
    expect(filterOf('{ nope')).toEqual({ ok: false })
  })
})
