// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { KEYWORDS } from './parser'

/**
 * Colours (user request 2026-10-10: "colour the SQL"): a text cut into pieces of a kind, which
 * together are exactly the text — the editor draws them under its own transparent text, so a
 * piece of another length would move the caret. Never throws; an open text or comment runs to the
 * end; a very long text is one plain piece.
 */
export type PieceKind =
  'plain' | 'keyword' | 'function' | 'string' | 'name' | 'number' | 'comment' | 'operator' | 'key'
export interface Piece {
  kind: PieceKind
  text: string
}

const MAX = 200_000
const AGGREGATES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'])
const OPERATORS = ['<>', '!=', '<=', '>=', '=', '<', '>', '(', ')', ',', '*', ';', '-', '+']

/** Adds a piece, a plain one joined to the plain one before it. */
function add(pieces: Piece[], kind: PieceKind, text: string): void {
  if (!text) return
  const last = pieces[pieces.length - 1]
  if (kind === 'plain' && last?.kind === 'plain') last.text += text
  else pieces.push({ kind, text })
}

/** Where a quoted text starting at `i` ends (after its closing quote), doubled quotes inside; the end when open. */
function quoted(text: string, i: number, quote: string, backslash: boolean): number {
  let j = i + 1
  while (j < text.length) {
    if (backslash && text[j] === '\\') {
      j += 2
      continue
    }
    if (text[j] === quote) {
      if (!backslash && text[j + 1] === quote) {
        j += 2
        continue
      }
      return j + 1
    }
    j++
  }
  return text.length
}

export function highlightSql(sql: string): Piece[] {
  if (sql.length > MAX) return [{ kind: 'plain', text: sql }]
  const pieces: Piece[] = []
  let i = 0
  while (i < sql.length) {
    const c = sql[i]!
    const rest = sql.slice(i)
    const space = /^\s+/.exec(rest)
    if (space) {
      add(pieces, 'plain', space[0])
      i += space[0].length
      continue
    }
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? sql.length : end
      add(pieces, 'comment', sql.slice(i, stop))
      i = stop
      continue
    }
    if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2)
      const stop = end === -1 ? sql.length : end + 2
      add(pieces, 'comment', sql.slice(i, stop))
      i = stop
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const stop = quoted(sql, i, c, false)
      add(pieces, c === "'" ? 'string' : 'name', sql.slice(i, stop))
      i = stop
      continue
    }
    const number = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(rest)
    if (number) {
      add(pieces, 'number', number[0])
      i += number[0].length
      continue
    }
    const word = /^[\p{L}_][\p{L}\p{N}_$.]*/u.exec(rest)
    if (word) {
      const upper = word[0].toUpperCase()
      const call = /^\s*\(/.test(sql.slice(i + word[0].length))
      add(
        pieces,
        KEYWORDS.has(upper) ? 'keyword' : AGGREGATES.has(upper) && call ? 'function' : 'plain',
        word[0],
      )
      i += word[0].length
      continue
    }
    const operator = OPERATORS.find((o) => rest.startsWith(o))
    add(pieces, operator ? 'operator' : 'plain', operator ?? c)
    i += operator?.length ?? 1
  }
  return pieces
}

/** Words the driver languages' code is built with. */
const CODE_KEYWORDS = new Set(
  'import from const let var new return await async using namespace package func def class public static void var val fun use require true false null None True False nil undefined'.split(
    ' ',
  ),
)

/** The MongoDB shell's and the drivers' code: strings, numbers, $operators, keys, comments. */
export function highlightCode(code: string): Piece[] {
  if (code.length > MAX) return [{ kind: 'plain', text: code }]
  const pieces: Piece[] = []
  let i = 0
  while (i < code.length) {
    const c = code[i]!
    const rest = code.slice(i)
    if (rest.startsWith('//') || c === '#') {
      const end = code.indexOf('\n', i)
      const stop = end === -1 ? code.length : end
      add(pieces, 'comment', code.slice(i, stop))
      i = stop
      continue
    }
    if (rest.startsWith('/*')) {
      const end = code.indexOf('*/', i + 2)
      const stop = end === -1 ? code.length : end + 2
      add(pieces, 'comment', code.slice(i, stop))
      i = stop
      continue
    }
    if (c === '"' || c === "'") {
      const stop = quoted(code, i, c, true)
      add(pieces, 'string', code.slice(i, stop))
      i = stop
      continue
    }
    const before = code[i - 1] ?? ''
    const number = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(rest)
    if (number && !/[\p{L}\p{N}_$]/u.test(before)) {
      add(pieces, 'number', number[0])
      i += number[0].length
      continue
    }
    const word = /^\$?[\p{L}_][\p{L}\p{N}_]*/u.exec(rest)
    if (word && !/[\p{L}\p{N}_$]/u.test(before)) {
      const after = code.slice(i + word[0].length)
      const kind: PieceKind = word[0].startsWith('$')
        ? 'operator'
        : /^\s*:(?!:)/.test(after)
          ? 'key'
          : CODE_KEYWORDS.has(word[0])
            ? 'keyword'
            : 'plain'
      add(pieces, kind, word[0])
      i += word[0].length
      continue
    }
    add(pieces, 'plain', c)
    i++
  }
  return pieces
}
