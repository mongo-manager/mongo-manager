import { describe, expect, it } from 'vitest'
import { serializeValue } from '@mongo-manager/shared/browser'
import { cycleSort, sortOf, sortState } from '../src/documents/sortModel'

// W1 (completion §2): the table's header sorts, written into the query's sort.
const canonical = (v: Record<string, unknown>) => serializeValue(v) as Record<string, unknown>

describe('sortOf', () => {
  it('reads a canonical sort as fields and directions, keeping others as they are', () => {
    expect(sortOf(canonical({ a: 1, b: -1 }))).toEqual([
      { field: 'a', dir: 1 },
      { field: 'b', dir: -1 },
    ])
    expect(sortOf(undefined)).toEqual([])
    // A $meta sort is not a direction: the header leaves it alone, but it is kept.
    expect(sortOf({ score: { $meta: 'textScore' } })).toEqual([{ field: 'score', dir: null }])
  })
})

describe('sortState', () => {
  it('says how a column is sorted and where it stands', () => {
    const sort = canonical({ a: -1, b: 1 })
    expect(sortState(sort, 'a')).toEqual({ dir: -1, position: 1, count: 2 })
    expect(sortState(sort, 'b')).toEqual({ dir: 1, position: 2, count: 2 })
    expect(sortState(sort, 'c')).toBeNull()
  })
})

describe('cycleSort', () => {
  it('goes ascending, descending, then no sort on the same column', () => {
    const asc = cycleSort(undefined, 'qty')
    expect(asc).toEqual({ qty: 1 })
    const desc = cycleSort(canonical(asc!), 'qty')
    expect(desc).toEqual({ qty: -1 })
    expect(cycleSort(canonical(desc!), 'qty')).toBeUndefined()
  })

  it('replaces another column’s sort with this one', () => {
    expect(cycleSort(canonical({ name: -1, qty: 1 }), 'qty')).toEqual({ qty: 1 })
  })

  it('adds, turns and removes one column of several when added to the sort (Shift)', () => {
    const two = cycleSort(canonical({ name: 1 }), 'qty', true)
    expect(two).toEqual({ name: 1, qty: 1 })
    expect(cycleSort(canonical(two!), 'qty', true)).toEqual({ name: 1, qty: -1 })
    expect(cycleSort(canonical({ name: 1, qty: -1 }), 'qty', true)).toEqual({ name: 1 })
    expect(cycleSort(canonical({ qty: -1 }), 'qty', true)).toBeUndefined()
  })

  it('keeps a $meta sort when another column is added', () => {
    expect(cycleSort({ score: { $meta: 'textScore' } }, 'qty', true)).toEqual({
      score: { $meta: 'textScore' },
      qty: 1,
    })
  })

  it('sets a direction asked for (the header menu)', () => {
    expect(cycleSort(canonical({ qty: 1 }), 'qty', false, -1)).toEqual({ qty: -1 })
    expect(cycleSort(canonical({ qty: 1 }), 'qty', false, null)).toBeUndefined()
    expect(cycleSort(undefined, 'qty', false, 1)).toEqual({ qty: 1 })
  })
})
