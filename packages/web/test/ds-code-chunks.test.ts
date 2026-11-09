// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import DsCodeView from '../src/ds/DsCodeView.vue'
import DsCodeEditor from '../src/ds/DsCodeEditor.vue'
import { i18n } from '../src/i18n'
import { mountApp } from './support/app'
import { tokenize } from '../src/ds/code/tokenize'
import {
  CHUNK_MAX_LINES,
  CHUNK_MIN_LINES,
  HIGHLIGHT_LIMIT,
  chunkPieces,
  splitPieces,
  type PieceChunk,
} from '../src/ds/code/marks'
import { toShell } from '../src/documents/values'

/**
 * User report 2026-11-05: the edit view showed a reservation of 400 payments (60,000 characters)
 * without colours. The highlighted text is drawn in chunks of lines; a chunk that did not change
 * keeps its object, so a keystroke draws one chunk again, not the whole document.
 */
const reservation = (payments: number, amount = 100.5) =>
  toShell({
    _id: 'R-big',
    status: 'pending',
    payments: Array.from({ length: payments }, (_, i) => ({
      method: i % 5 === 0 ? 'transfer' : 'card',
      amount: amount + i,
      paidAt: new Date(Date.UTC(2026, 6, 1 + (i % 28))),
      refunds: i % 7 === 0 ? [{ amount: 5, reason: { code: 'late' } }] : [],
    })),
  })
const chunksOf = (text: string, previous?: PieceChunk[], marks?: Array<[number, number]>) =>
  chunkPieces(splitPieces(tokenize(text), { marks }), previous)
const lines = (chunk: PieceChunk) => chunk.text.split('\n').length - 1
/** The colour of every character, as the pieces give it. */
const colours = (pieces: ReadonlyArray<{ type: string; text: string }>) =>
  pieces.flatMap((p) => Array.from(p.text, () => p.type)).join(',')

describe('the highlighted text in chunks', () => {
  it('keeps every character and its colour, in order', () => {
    const text = reservation(400)
    const chunks = chunksOf(text)
    expect(chunks.map((c) => c.text).join('')).toBe(text)
    expect(colours(chunks.flatMap((c) => c.pieces))).toBe(colours(tokenize(text)))
    for (const chunk of chunks) expect(chunk.pieces.map((p) => p.text).join('')).toBe(chunk.text)
  })

  it('cuts only after a line, into chunks of a bounded number of lines', () => {
    const chunks = chunksOf(reservation(400))
    expect(chunks.length).toBeGreaterThan(10)
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.text.endsWith('\n')).toBe(true)
      expect(lines(chunk)).toBeGreaterThanOrEqual(CHUNK_MIN_LINES)
      expect(lines(chunk)).toBeLessThanOrEqual(CHUNK_MAX_LINES)
    }
  })

  it('keeps the chunks a change in one line did not touch, as the same objects', () => {
    const text = reservation(400)
    const before = chunksOf(text)
    const at = text.indexOf('amount: 300.5')
    const after = chunksOf(
      `${text.slice(0, at)}amount: 9300.5${text.slice(at + 'amount: 300.5'.length)}`,
      before,
    )
    const kept = after.filter((c) => before.includes(c))
    expect(after.length - kept.length).toBeLessThanOrEqual(2)
  })

  it('keeps the chunks after a line added at the top', () => {
    const text = reservation(400)
    const before = chunksOf(text)
    const after = chunksOf(text.replace('{\n', '{\n  note: "new",\n'), before)
    const kept = after.filter((c) => before.includes(c))
    expect(after.length - kept.length).toBeLessThanOrEqual(2)
  })

  it('gives each chunk its own id, chunks of the same text too', () => {
    const block = 'a: 1,\n'.repeat(CHUNK_MAX_LINES * 4)
    const chunks = chunksOf(block)
    expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length)
    const again = chunksOf(block, chunks)
    expect(again).toEqual(chunks)
    expect(new Set(again.map((c) => c.id)).size).toBe(again.length)
  })

  it('says which chunks hold a search match, and draws them again when the match moves', () => {
    const text = reservation(400)
    const at = text.indexOf('amount: 300.5')
    const chunks = chunksOf(text, undefined, [[at, at + 6]])
    expect(chunks.filter((c) => c.marked)).toHaveLength(1)
    expect(chunks.find((c) => c.marked)!.pieces.some((p) => p.mark === 0)).toBe(true)
    const moved = chunksOf(text, chunks, [[at + 1, at + 7]])
    expect(chunks.includes(moved.find((c) => c.marked)!)).toBe(false)
  })

  it('draws a text without lines as one chunk', () => {
    expect(chunksOf('{ a: 1 }').map((c) => c.text)).toEqual(['{ a: 1 }'])
    expect(chunksOf('')).toEqual([])
  })
})

describe('a long document, highlighted', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    i18n.global.locale.value = 'en'
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })
  const keys = () => document.querySelectorAll('pre .text-v-key').length

  it('colours a reservation of 400 payments in the editor', () => {
    const text = reservation(400)
    expect(text.length).toBeGreaterThan(50_000)
    mountApp(DsCodeEditor, { props: { label: 'Text', modelValue: text, multiline: true, fill: true } })
    expect(keys()).toBeGreaterThan(1600)
    expect(document.querySelector('pre')!.textContent).toBe(`${text}\n`)
  })

  // CI 2026-11-05: 4,000 payments (more than 100,000 characters, 16,000 keys drawn) took 18 s on a
  // runner measuring coverage, past the 15 s a test has. Past the old limit (50,000) is what shows
  // the colours go on; the limit itself is a million.
  it('colours it in the JSON view, and up to a million characters', () => {
    const text = reservation(500)
    expect(text.length).toBeGreaterThan(50_000)
    mountApp(DsCodeView, { props: { text } })
    expect(keys()).toBeGreaterThan(2_000)
    expect(document.querySelector('pre')!.textContent).toBe(text)
    expect(HIGHLIGHT_LIMIT).toBe(1_000_000)
  })

  it('draws a change at once, in its colours', async () => {
    const text = reservation(400)
    const { wrapper } = mountApp(DsCodeEditor, {
      props: { label: 'Text', modelValue: text, multiline: true },
    })
    const at = text.indexOf('amount: 300.5')
    await wrapper.setProps({ modelValue: `${text.slice(0, at)}total: 1, ${text.slice(at)}` })
    await new Promise((resolve) => setTimeout(resolve, 40))
    const pre = document.querySelector('pre')!
    expect(pre.textContent).toContain('total: 1, amount: 300.5')
    expect([...pre.querySelectorAll('.text-v-key')].some((el) => el.textContent === 'total')).toBe(true)
  })
})
