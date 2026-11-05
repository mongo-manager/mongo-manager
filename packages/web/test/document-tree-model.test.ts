// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import {
  TREE_PAGE,
  closedState,
  dottedPath,
  flattenTree,
  openAll,
  pathKey,
  revealPaths,
  type TreeLine,
} from '@/documents/page/treeModel'

// Document page design §6.4: one flat list of lines for the tree, so a search can open the way to a
// match and the keyboard can walk it.
const doc = {
  guest: { name: 'Ada Lin' },
  payments: [{ amount: 350 }, { amount: 120 }],
  status: 'paid',
}
const names = (lines: TreeLine[]) =>
  lines.map((l) => ('more' in l ? `more:${l.remaining}` : l.path.join('.')))

describe('the tree of a document', () => {
  it('lists the first level, its containers closed', () => {
    const lines = flattenTree(doc, closedState())
    expect(names(lines)).toEqual(['guest', 'payments', 'status'])
    const payments = lines[1]!
    expect(payments).toMatchObject({ container: true, open: false, size: 2, depth: 0, type: 'array' })
  })

  it('lists an opened container’s entries under it', () => {
    const state = { open: new Set([pathKey(['payments'])]), shown: new Map() }
    expect(names(flattenTree(doc, state))).toEqual([
      'guest',
      'payments',
      'payments.0',
      'payments.1',
      'status',
    ])
    expect(flattenTree(doc, state)[2]).toMatchObject({ name: '0', depth: 1 })
  })

  it('lists a long array a page at a time', () => {
    const long = { items: Array.from({ length: 250 }, (_, i) => i) }
    const state = { open: new Set([pathKey(['items'])]), shown: new Map() }
    const lines = flattenTree(long, state)
    expect(lines).toHaveLength(1 + TREE_PAGE + 1)
    expect(lines.at(-1)).toMatchObject({ more: true, remaining: 100, path: ['items'], depth: 1 })
  })

  it('opens the way to a path, past the first page', () => {
    const long = { items: Array.from({ length: 250 }, () => ({ a: 1 })) }
    const state = revealPaths(long, closedState(), [['items', '230', 'a']])
    expect([...state.open].sort()).toEqual([pathKey(['items']), pathKey(['items', '230'])].sort())
    expect(state.shown.get(pathKey(['items']))).toBe(300)
    expect(names(flattenTree(long, state))).toContain('items.230.a')
  })

  it('opens everything, up to a bound', () => {
    expect(openAll(doc).has(pathKey(['payments', '1']))).toBe(true)
    const wide = { a: Array.from({ length: 50 }, () => ({ b: [1, 2] })) }
    expect(openAll(wide, 20).size).toBeLessThan(51)
  })

  it('tells a key holding a dot from a nested key, and copies a path as MongoDB writes it', () => {
    expect(pathKey(['a.b'])).not.toBe(pathKey(['a', 'b']))
    expect(dottedPath(['payments', '2', 'amount'])).toBe('payments.2.amount')
  })

  // Final review I7, minor: each line knows its parent's kind and its place among its siblings.
  it('says each line’s parent kind and its place among its siblings', () => {
    const state = { open: new Set([pathKey(['payments']), pathKey(['guest'])]), shown: new Map() }
    const lines = flattenTree(doc, state).filter(
      (l): l is Extract<TreeLine, { name: string }> => !('more' in l),
    )
    const byPath = Object.fromEntries(lines.map((l) => [l.path.join('.'), l]))
    expect(byPath['payments.1']).toMatchObject({ parentType: 'array', index: 2, setSize: 2 })
    expect(byPath['guest.name']).toMatchObject({ parentType: 'object', index: 1, setSize: 1 })
    expect(byPath['status']).toMatchObject({ parentType: 'object', index: 3, setSize: 3 })
  })
})
