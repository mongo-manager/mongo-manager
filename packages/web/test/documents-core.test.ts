// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isReactive, reactive } from 'vue'
import { documentsApi } from '../src/api/documents'
import { decodeDocument, idLabel, isDocument, summarize, toShell } from '../src/documents/values'
import { columnsOf, fieldPaths, toRows } from '../src/documents/rows'
import { buildQuery, emptyDraft } from '../src/documents/queryBuild'
import { mockApi } from './support/app'

afterEach(() => vi.unstubAllGlobals())

const T = { connectionId: 'c1', db: 'a b', coll: 'x/y' }

describe('documentsApi', () => {
  it('encodes the namespace and index names, and sends the preview token back', async () => {
    const { calls } = mockApi({
      'POST connections/c1/databases/a b/collections/x%2Fy/find': () => [
        200,
        { documents: [], hasMore: false },
      ],
      'DELETE connections/c1/databases/a b/collections/x%2Fy/indexes/a_1 x': () => [204],
      'POST connections/c1/databases/a b/collections/x%2Fy/bulk/execute': () => [200, { deleted: 1 }],
      'POST connections/c1/databases/a b/collections/x%2Fy/documents/replace': () => [200, { modified: 1 }],
    })
    await documentsApi.find(T, { filter: {}, skip: 0, limit: 20 })
    await documentsApi.dropIndex(T, 'a_1 x')
    await documentsApi.bulkExecute(T, { filter: {}, operation: 'delete' }, 'tok', 'x/y')
    await documentsApi.replace(T, { $oid: '65a1b2c3d4e5f6a7b8c9d0e1' }, { a: 1 }, 'h'.repeat(64))
    expect(calls.map((c) => [c.method, c.path.split('x%2Fy/')[1], c.body])).toEqual([
      ['POST', 'find', { filter: {}, skip: 0, limit: 20 }],
      ['DELETE', 'indexes/a_1 x', undefined],
      ['POST', 'bulk/execute', { filter: {}, operation: 'delete', filterHash: 'tok', confirm: 'x/y' }],
      [
        'POST',
        'documents/replace',
        { _id: { $oid: '65a1b2c3d4e5f6a7b8c9d0e1' }, document: { a: 1 }, hash: 'h'.repeat(64) },
      ],
    ])
  })
})

const EJSON = {
  _id: { $oid: '65a1b2c3d4e5f6a7b8c9d0e1' },
  n: { $numberInt: '5' },
  d: { $numberDouble: '5.0' },
  l: { $numberLong: '9007199254740993' },
  at: { $date: { $numberLong: '1767225600000' } },
  s: 'text',
  arr: [{ $numberInt: '1' }, { $numberInt: '2' }],
  o: { a: true, b: null },
}

describe('values (Review Focus 1)', () => {
  it('summarizes every BSON type for a one-line cell', () => {
    const v = decodeDocument(EJSON)
    expect(summarize(v._id)).toEqual({ kind: 'scalar', text: '65a1b2c3d4e5f6a7b8c9d0e1' })
    expect(summarize(v.n)).toEqual({ kind: 'scalar', text: '5' })
    expect(summarize(v.d)).toEqual({ kind: 'scalar', text: '5' })
    expect(summarize(v.l)).toEqual({ kind: 'scalar', text: '9007199254740993' })
    expect(summarize(v.at)).toEqual({ kind: 'scalar', text: '2026-01-01T00:00:00.000Z' })
    expect(summarize(v.arr)).toEqual({ kind: 'array', count: 2 })
    expect(summarize(v.o)).toEqual({ kind: 'object', count: 2 })
    expect(summarize('x'.repeat(500))).toEqual({ kind: 'scalar', text: `${'x'.repeat(200)}…` })
    expect(summarize(null)).toEqual({ kind: 'scalar', text: 'null' })
  })

  it('keeps types in shell text and identifies documents', () => {
    const v = decodeDocument(EJSON)
    expect(toShell(v, 0)).toContain('d: Double(5)')
    expect(idLabel(v._id)).toBe('65a1b2c3d4e5f6a7b8c9d0e1')
    expect([isDocument(v.o), isDocument(v.arr), isDocument(v.at), isDocument(v._id)]).toEqual([
      true,
      false,
      false,
      false,
    ])
  })
})

describe('rows', () => {
  it('decodes documents once, keeps them raw, and passes unsupported ones through', () => {
    const rows = toRows(
      [
        { document: EJSON, hash: 'a'.repeat(64) },
        { unsupported: { _id: { $oid: '65a1b2c3d4e5f6a7b8c9d0e2' }, reason: 'bad date' } },
        { document: { _id: 7, s: { nested: 1 }, extra: 1 }, hash: 'b'.repeat(64) },
      ],
      40,
    )
    expect(rows.map((r) => r.kind)).toEqual(['document', 'unsupported', 'document'])
    expect(rows[0]!.key).toBe('40:' + 'a'.repeat(64))
    const holder = reactive({ rows })
    expect(isReactive((holder.rows[0] as { value: object }).value)).toBe(false)
    expect(columnsOf(rows)).toEqual(['_id', 'n', 'd', 'l', 'at', 's', 'arr', 'o', 'extra'])
    expect(columnsOf(rows, 3)).toEqual(['_id', 'n', 'd'])
    expect(fieldPaths(rows)).toEqual(expect.arrayContaining(['o.a', 's.nested', 'arr']))
  })
})

describe('buildQuery', () => {
  it('turns shell text into canonical EJSON and omits empty options', () => {
    const result = buildQuery({
      ...emptyDraft(),
      filter: "{ _id: ObjectId('65a1b2c3d4e5f6a7b8c9d0e1'), n: { $gt: 5 } }",
      sort: '{ n: -1 }',
    })
    expect(result).toEqual({
      ok: true,
      query: {
        filter: { _id: { $oid: '65a1b2c3d4e5f6a7b8c9d0e1' }, n: { $gt: { $numberInt: '5' } } },
        sort: { n: { $numberInt: '-1' } },
        skip: 0,
        limit: 20,
      },
      // Query parameters (2026-10-28): none here, so no template either.
      params: [],
    })
    expect(buildQuery(emptyDraft())).toEqual({ ok: true, query: { filter: {}, skip: 0, limit: 20 }, params: [] })
  })

  it('reports which field is wrong and where', () => {
    const bad = buildQuery({ ...emptyDraft(), projection: '{ a: }' })
    expect(bad).toMatchObject({ ok: false, field: 'projection', line: 1, column: 6 })
    expect(buildQuery({ ...emptyDraft(), skip: '-3' })).toMatchObject({ ok: false, field: 'skip' })
    expect(buildQuery({ ...emptyDraft(), filter: '[1]' })).toMatchObject({ ok: false, field: 'filter' })
  })
})
