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
  showMore,
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
    expect(state.window?.get(pathKey(['items']))).toEqual({ from: 200, to: 300 })
    expect(names(flattenTree(long, state))).toContain('items.230.a')
  })

  // Review 2026-11-07 (performance): a match at the end of 5,000 items listed all 5,000 lines.
  describe('a match far down a long container', () => {
    const long = { items: Array.from({ length: 5_000 }, (_, i) => i) }
    const items = pathKey(['items'])

    it('lists the first page, a gap, and the page around the match — nothing between', () => {
      const lines = flattenTree(long, revealPaths(long, closedState(), [['items', '4321']]))
      const shown = names(lines)
      expect(shown).toHaveLength(1 + TREE_PAGE + 1 + TREE_PAGE + 1)
      expect(shown.slice(0, 3)).toEqual(['items', 'items.0', 'items.1'])
      expect(lines[TREE_PAGE + 1]).toMatchObject({ more: true, place: 'gap', remaining: TREE_PAGE })
      expect(shown).toContain('items.4321')
      expect(shown.slice(TREE_PAGE + 2, TREE_PAGE + 3)).toEqual(['items.4300'])
      expect(lines.at(-1)).toMatchObject({ more: true, place: 'end', remaining: TREE_PAGE })
      const match = lines.find((l) => !('more' in l) && l.path.join('.') === 'items.4321')
      expect(match).toMatchObject({ index: 4322, setSize: 5_000 })
    })

    it('moves the page to the next match instead of listing more and more', () => {
      const first = revealPaths(long, closedState(), [['items', '2000']])
      const next = revealPaths(long, first, [['items', '4999']])
      const shown = names(flattenTree(long, next))
      expect(shown).toContain('items.4999')
      expect(shown).not.toContain('items.2000')
      expect(shown.length).toBeLessThan(1 + TREE_PAGE * 2 + 3)
      // A match on a page already listed leaves the pages as they are.
      expect(revealPaths(long, next, [['items', '4950']])).toEqual(next)
      expect(revealPaths(long, next, [['items', '5']]).window).toEqual(next.window)
    })

    it('shows more at the gap or at the end, the gap closing when it is shown whole', () => {
      let state = revealPaths(long, closedState(), [['items', '250']])
      expect(names(flattenTree(long, state))).toContain('more:100')
      state = showMore(state, ['items'], 'gap')
      const shown = names(flattenTree(long, state))
      expect(shown.filter((n) => n.startsWith('more'))).toEqual(['more:100'])
      expect(shown.slice(1, 301)).toEqual(Array.from({ length: 300 }, (_, i) => `items.${i}`))
      state = showMore(state, ['items'], 'end')
      expect(names(flattenTree(long, state))).toContain('items.399')
      expect(state.shown.get(items) ?? 0).toBeLessThanOrEqual(400)
    })
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
