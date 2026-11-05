// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { createHistory } from '@/documents/page/history'

// Document page design §6.6: the tree and the text share one undo history.
describe('one undo history for the tree and the text', () => {
  it('takes typing close together as one step', () => {
    const h = createHistory('a')
    h.push('ab', 0)
    h.push('abc', 100)
    h.push('abcd', 200)
    expect(h.undo()).toBe('a')
    expect(h.canUndo).toBe(false)
    expect(h.redo()).toBe('abcd')
  })

  it('starts a new step after a pause in typing', () => {
    const h = createHistory('a')
    h.push('ab', 0)
    h.push('abc', 1_000)
    expect(h.undo()).toBe('ab')
  })

  it('takes a tree edit as a step of its own', () => {
    const h = createHistory('a')
    h.push('ab', 0)
    h.pushStep('ab!')
    h.push('ab!c', 10)
    expect(h.undo()).toBe('ab!')
    expect(h.undo()).toBe('ab')
    expect(h.undo()).toBe('a')
    expect(h.undo()).toBeNull()
  })

  it('forgets what was undone once something new is done', () => {
    const h = createHistory('a')
    h.pushStep('b')
    h.undo()
    h.pushStep('c')
    expect(h.canRedo).toBe(false)
    expect(h.redo()).toBeNull()
  })

  it('keeps at most 200 steps', () => {
    const h = createHistory('0')
    for (let i = 1; i <= 201; i++) h.pushStep(String(i))
    let last: string | null = null
    for (let s = h.undo(); s !== null; s = h.undo()) last = s
    expect(last).toBe('1')
  })

  it('takes the same text again as no step', () => {
    const h = createHistory('a')
    h.pushStep('a')
    expect(h.canUndo).toBe(false)
  })

  // Final review I2: a large document's steps are capped by their size too, not only their number.
  it('keeps the steps within a size, dropping the oldest', () => {
    const h = createHistory('a'.repeat(10), 500, 35)
    h.pushStep('b'.repeat(10))
    h.pushStep('c'.repeat(10))
    h.pushStep('d'.repeat(10))
    expect(h.undo()).toBe('c'.repeat(10))
    expect(h.undo()).toBe('b'.repeat(10))
    expect(h.undo()).toBeNull()
  })
})
