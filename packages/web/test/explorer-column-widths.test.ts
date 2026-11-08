// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_COLLECTIONS, MAX_COLUMNS, loadWidths, saveWidths } from '../src/documents/columnWidths'

// W1 review (important 3): column widths kept per collection and user, bounded, never trusted blindly.
const ns = (coll: string) => ({ connectionId: 'c1', db: 'shop', coll })
afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('kept column widths', () => {
  it('are per user and per collection', () => {
    saveWidths('u1', ns('orders'), { name: 300 })
    expect(loadWidths('u1', ns('orders'))).toEqual({ name: 300 })
    expect(loadWidths('u2', ns('orders'))).toEqual({})
    expect(loadWidths('u1', ns('items'))).toEqual({})
    expect(loadWidths(null, ns('orders'))).toEqual({})
  })

  it('keep the collections used last and so many columns each', () => {
    for (let i = 0; i < MAX_COLLECTIONS + 5; i++) saveWidths('u1', ns(`c${i}`), { a: 100 })
    expect(loadWidths('u1', ns('c0'))).toEqual({})
    expect(loadWidths('u1', ns(`c${MAX_COLLECTIONS + 4}`))).toEqual({ a: 100 })
    const many = Object.fromEntries(Array.from({ length: MAX_COLUMNS + 20 }, (_, i) => [`f${i}`, 100]))
    saveWidths('u1', ns('wide'), many)
    expect(Object.keys(loadWidths('u1', ns('wide')))).toHaveLength(MAX_COLUMNS)
  })

  it('read what is stored as nothing when it is not widths, and survive blocked storage', () => {
    localStorage.setItem(
      'mm:column-widths:u1',
      JSON.stringify([{ ns: ['c1', 'shop', 'orders'], widths: { a: 'x', b: 1e9, c: -5, d: 200 } }, 7]),
    )
    expect(loadWidths('u1', ns('orders'))).toEqual({ d: 200 })
    localStorage.setItem('mm:column-widths:u1', '{not json')
    expect(loadWidths('u1', ns('orders'))).toEqual({})
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => saveWidths('u1', ns('orders'), { a: 100 })).not.toThrow()
  })
})
