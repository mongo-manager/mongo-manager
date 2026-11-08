// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { diffLines, foldUnchanged, inlineChange } from '../src/documents/lineDiff'

const kinds = (rows: { kind: string }[]) => rows.map((r) => r.kind).join(' ')

describe('diffLines (user request 2026-11-07: the review as a side-by-side diff)', () => {
  it('pairs a changed line with its new text, numbered on both sides', () => {
    const rows = diffLines(['{', '  a: 1,', '  b: 2', '}'], ['{', '  a: 1,', '  b: 3', '}'])
    expect(kinds(rows)).toBe('same same mod same')
    expect(rows[2]).toEqual({ kind: 'mod', left: 3, right: 3, before: '  b: 2', after: '  b: 3' })
  })

  it('shows lines added and removed with nothing beside them', () => {
    const rows = diffLines(['a', 'b', 'c'], ['a', 'c', 'd'])
    expect(kinds(rows)).toBe('same del same add')
    expect(rows[1]).toEqual({ kind: 'del', left: 2, text: 'b' })
    expect(rows[3]).toEqual({ kind: 'add', right: 3, text: 'd' })
  })

  it('pairs as many lines as both sides changed, and keeps the rest apart', () => {
    const rows = diffLines(['x', 'a', 'b', 'y'], ['x', 'A', 'B', 'C', 'y'])
    expect(kinds(rows)).toBe('same mod mod add same')
  })

  it('writes a field only added or only removed as all its lines', () => {
    expect(kinds(diffLines([], ['{', '}']))).toBe('add add')
    expect(kinds(diffLines(['1'], []))).toBe('del')
  })

  it('still answers for two long texts that share nothing, without comparing every pair', () => {
    const before = Array.from({ length: 3000 }, (_, i) => `before ${i}`)
    const after = Array.from({ length: 3000 }, (_, i) => `after ${i}`)
    const rows = diffLines(before, after)
    expect(rows).toHaveLength(3000)
    expect(rows.every((r) => r.kind === 'mod')).toBe(true)
  })
})

describe('foldUnchanged', () => {
  it('keeps three lines around a change and folds the rest', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`)
    const changed = lines.map((l, i) => (i === 10 ? 'changed' : l))
    const parts = foldUnchanged(diffLines(lines, changed))
    expect(parts.map((p) => (p.kind === 'fold' ? `fold${p.rows.length}` : p.kind)).join(' ')).toBe(
      'fold7 same same same mod same same same fold6',
    )
  })

  it('folds nothing shorter than what showing it would take', () => {
    const rows = diffLines(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], ['a', 'b', 'c', 'd', 'X', 'f', 'g', 'h'])
    expect(foldUnchanged(rows).some((p) => p.kind === 'fold')).toBe(false)
  })
})

describe('inlineChange', () => {
  it('marks the part of a line that changed', () => {
    expect(inlineChange('  price: 142,', '  price: 143,')).toEqual({
      before: ['  price: 14', '2', ','],
      after: ['  price: 14', '3', ','],
    })
  })

  it('marks nothing within lines that share too little', () => {
    expect(inlineChange('abc', 'xyz')).toBeNull()
  })
})
