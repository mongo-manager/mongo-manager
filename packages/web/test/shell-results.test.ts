// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QueryOrigin } from '@mongo-manager/shared'
import {
  ResultBuffer,
  documentsOf,
  originPaging,
  originToLibraryItem,
  resultRows,
  type ShellResult,
} from '../src/shell/results'

/** Phase 3a-2 spec §2 and §3.3: shell results for the result pane. */
afterEach(() => vi.restoreAllMocks())

const doc = (i: number) => ({ _id: { $oid: `0123456789abcdef0123456${i}` }, n: { $numberInt: String(i) } })

describe('documentsOf', () => {
  it('takes a cursor batch or a single document', () => {
    expect(documentsOf([doc(1), doc(2)])).toEqual([doc(1), doc(2)])
    expect(documentsOf(doc(1))).toEqual([doc(1)])
    expect(documentsOf([])).toEqual([])
  })

  it('refuses what is not documents', () => {
    expect(documentsOf({ $numberInt: '3' })).toBeNull()
    expect(documentsOf('text')).toBeNull()
    expect(documentsOf(3)).toBeNull()
    expect(documentsOf(null)).toBeNull()
    expect(documentsOf([1, { a: 1 }])).toBeNull()
    expect(documentsOf([{ $date: { $numberLong: '0' } }])).toBeNull()
  })
})

describe('resultRows', () => {
  it('gives each document a unique key and decoded values', () => {
    const result: ShellResult = {
      id: 4,
      resultType: 'Cursor',
      value: [],
      hasMore: false,
      documents: [doc(1), doc(2)],
    }
    const rows = resultRows(result)
    expect(rows.map((r) => r.key)).toEqual(['4:0', '4:1'])
    expect(new Set(rows.map((r) => r.key)).size).toBe(2)
    expect(rows[0]!.raw).toEqual(doc(1))
    // Values keep their BSON types (an Int32 stays an Int32), as in the Documents view.
    expect(Number(rows[0]!.value.n)).toBe(1)
  })
})

describe('originToLibraryItem', () => {
  it('turns a find into a find item with its query parts', () => {
    const origin: QueryOrigin = {
      kind: 'find',
      db: 'shop',
      coll: 'orders',
      filter: { a: { $numberInt: '1' } },
      sort: { a: { $numberInt: '-1' } },
      limit: 3,
    }
    expect(originToLibraryItem(origin)).toMatchObject({
      kind: 'find',
      db: 'shop',
      coll: 'orders',
      body: { filter: { a: { $numberInt: '1' } }, sort: { a: { $numberInt: '-1' } } },
    })
  })

  // W5: skip and limit go along as paging for the collection view, as mongosh means them.
  it('gives a find’s skip and limit as paging', () => {
    const base = { kind: 'find' as const, db: 's', coll: 'o', filter: {} }
    expect(originPaging({ ...base, skip: 40, limit: 7 })).toEqual({ skip: 40, limit: 7 })
    // A negative limit is mongosh's single batch of that many; 0 is no limit at all.
    expect(originPaging({ ...base, limit: -5 })).toEqual({ limit: 5 })
    expect(originPaging({ ...base, limit: 0 })).toEqual({})
    // The collection view pages by at most 1000.
    expect(originPaging({ ...base, limit: 5000 })).toEqual({ limit: 1000 })
    expect(originPaging({ ...base, skip: 0 })).toEqual({})
    expect(originPaging({ ...base, skip: 2.5, limit: Number.NaN })).toEqual({})
    expect(originPaging({ kind: 'aggregate', db: 's', coll: 'o', pipeline: [] })).toEqual({})
  })

  it('turns an aggregate into a pipeline item', () => {
    const origin: QueryOrigin = { kind: 'aggregate', db: 'shop', coll: 'orders', pipeline: [{ $match: {} }] }
    expect(originToLibraryItem(origin)).toMatchObject({ kind: 'aggregate', body: [{ $match: {} }] })
  })
})

describe('ResultBuffer (A11)', () => {
  it('keeps the last 10, newest first, in memory only', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const open = globalThis.indexedDB ? vi.spyOn(globalThis.indexedDB, 'open') : null
    const buffer = new ResultBuffer()
    for (let i = 1; i <= 12; i++)
      buffer.push({ id: i, resultType: null, value: i, hasMore: false, documents: null })
    expect(buffer.items.map((r) => r.id)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3])
    expect(setItem).not.toHaveBeenCalled()
    if (open) expect(open).not.toHaveBeenCalled()
  })

  // Review 2026-10-12 (M4): numbers repeat after a reload; each result kept gets its own place.
  it('gives each result kept a place of its own, numbers repeated or not', () => {
    const buffer = new ResultBuffer()
    const r = (id: number) => ({ id, resultType: null, value: 1, hasMore: false, documents: null })
    buffer.push(r(3))
    buffer.push(r(1))
    buffer.push(r(3))
    expect(buffer.items.map((x) => [x.id, x.seq])).toEqual([
      [3, 3],
      [1, 2],
      [3, 1],
    ])
  })

  // Review 2026-10-12 (M4): Clear's Undo brings the results back behind newer ones, still 10 at most,
  // and their places stay their own.
  it('restores cleared results behind newer ones, keeping the last 10', () => {
    const buffer = new ResultBuffer()
    const r = (id: number) => ({ id, resultType: null, value: id, hasMore: false, documents: null })
    for (let i = 1; i <= 8; i++) buffer.push(r(i))
    const gone = buffer.clear()
    expect(buffer.items).toEqual([])
    expect(gone.map((x) => x.id)).toEqual([8, 7, 6, 5, 4, 3, 2, 1])
    buffer.push(r(20))
    buffer.push(r(21))
    buffer.push(r(22))
    buffer.restore(gone)
    expect(buffer.items.map((x) => x.id)).toEqual([22, 21, 20, 8, 7, 6, 5, 4, 3, 2])
    expect(new Set(buffer.items.map((x) => x.seq)).size).toBe(10)
  })
})
