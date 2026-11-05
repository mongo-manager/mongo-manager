// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Token } from './tokenize'

/** How a search match looks in code, and the one the search is at (document page design §6.7). */
export const SEARCH_MARK = 'rounded-[2px] bg-warning-soft'
export const SEARCH_CURRENT = 'rounded-[2px] bg-warning/40 outline-1 outline-warning'

/** A token, or a part of one: highlighted as a bracket, marked as a search match, or neither. */
export interface Piece extends Token {
  bracket: boolean
  /** The index of the search match this piece is in, or -1. */
  mark: number
  /** A long string shown by its start (DsCodeView): where it starts in the text, and its size. */
  fold?: { at: number; size: string }
}

/**
 * The tokens cut where a highlighted bracket or a search match starts or ends, so each piece keeps
 * its token's colour (phase 3a-2 brackets; document page design §6.7 matches). `whole` tokens are
 * never cut or marked: a hidden value stays one locked piece, its stand-in never shown (review I5).
 */
export function splitPieces(
  tokens: readonly Token[],
  cuts: {
    brackets?: readonly number[] | null
    marks?: ReadonlyArray<readonly [number, number]>
    whole?: (token: Token) => boolean
  },
): Piece[] {
  const brackets = new Set(cuts.brackets ?? [])
  const marks = cuts.marks ?? []
  const edges = new Set<number>()
  for (const b of brackets) edges.add(b).add(b + 1)
  for (const [from, to] of marks) edges.add(from).add(to)
  const sorted = [...edges].sort((a, b) => a - b)
  /** The match holding `offset`, by halving (matches are in order and do not overlap). */
  const markAt = (offset: number): number => {
    let lo = 0
    let hi = marks.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const [from, to] = marks[mid]!
      if (offset < from) hi = mid - 1
      else if (offset >= to) lo = mid + 1
      else return mid
    }
    return -1
  }
  const out: Piece[] = []
  let offset = 0
  let edge = 0
  for (const token of tokens) {
    const end = offset + token.text.length
    if (!sorted.length || cuts.whole?.(token)) {
      out.push({ ...token, bracket: false, mark: -1 })
      offset = end
      continue
    }
    while (edge < sorted.length && sorted[edge]! <= offset) edge++
    const starts = [offset]
    for (let i = edge; i < sorted.length && sorted[i]! < end; i++) starts.push(sorted[i]!)
    starts.forEach((start, i) => {
      const stop = starts[i + 1] ?? end
      out.push({
        type: token.type,
        text: token.text.slice(start - offset, stop - offset),
        bracket: stop - start === 1 && brackets.has(start),
        mark: markAt(start),
      })
    })
    offset = end
  }
  return out
}

/**
 * User report 2026-11-05: a document of 60,000 characters showed in the editor without colours, its
 * pieces too many to draw again at each keystroke. They are drawn in chunks of lines instead; a chunk
 * that did not change keeps its object (and id), so the view draws again only the chunks a change
 * touched (v-memo).
 */
export interface PieceChunk {
  id: number
  text: string
  pieces: Piece[]
  /** Whether a piece is a search match: the chunk is drawn again when the current match moves. */
  marked: boolean
}

/**
 * Past this many characters a text is shown plain (a document is at most 16 MB). Drawn in chunks, a
 * text this long still highlights at once (user report 2026-11-05: 50,000 was too few in the editor).
 */
export const HIGHLIGHT_LIMIT = 1_000_000
export const CHUNK_MIN_LINES = 24
export const CHUNK_MAX_LINES = 160
/** A line ends a chunk when its hash is a multiple of this: the cuts follow the text, not the line numbers. */
const CUT_EVERY = 8
const FNV_OFFSET = 2166136261
const FNV_PRIME = 16777619
let nextChunkId = 1

const samePieces = (a: readonly Piece[], b: readonly Piece[]): boolean =>
  a.length === b.length &&
  a.every(
    (p, i) =>
      p.text === b[i]!.text && p.type === b[i]!.type && p.mark === b[i]!.mark && p.bracket === b[i]!.bracket,
  )

/**
 * The pieces in chunks that end after a line, cut where a line's own text says (so a line added or
 * removed moves no cut after the next one), between CHUNK_MIN_LINES and CHUNK_MAX_LINES lines. A
 * chunk the same as one of `previous` is that one.
 */
export function chunkPieces(pieces: readonly Piece[], previous: readonly PieceChunk[] = []): PieceChunk[] {
  const before = new Map<string, PieceChunk[]>()
  for (const chunk of previous) {
    const same = before.get(chunk.text)
    if (same) same.push(chunk)
    else before.set(chunk.text, [chunk])
  }
  const out: PieceChunk[] = []
  let current: Piece[] = []
  let lines = 0
  let hash = FNV_OFFSET
  const close = (): void => {
    if (!current.length) return
    const text = current.map((p) => p.text).join('')
    const same = before.get(text)
    const at = same ? same.findIndex((c) => samePieces(c.pieces, current)) : -1
    out.push(
      at >= 0
        ? same!.splice(at, 1)[0]!
        : { id: nextChunkId++, text, pieces: current, marked: current.some((p) => p.mark >= 0) },
    )
    current = []
    lines = 0
  }
  for (const piece of pieces) {
    const text = piece.text
    let from = 0
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      if (code !== 10) {
        hash = Math.imul(hash ^ code, FNV_PRIME)
        continue
      }
      lines++
      const cut = lines >= CHUNK_MAX_LINES || (lines >= CHUNK_MIN_LINES && (hash >>> 0) % CUT_EVERY === 0)
      hash = FNV_OFFSET
      if (!cut) continue
      current.push(from === 0 && i === text.length - 1 ? piece : { ...piece, text: text.slice(from, i + 1) })
      from = i + 1
      close()
    }
    if (from < text.length) current.push(from === 0 ? piece : { ...piece, text: text.slice(from) })
  }
  close()
  return out
}
