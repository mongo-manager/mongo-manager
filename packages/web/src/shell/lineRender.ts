// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { cellWidth } from './cellWidth'

/**
 * The line being typed in the shell, drawn again after each key (user report 2026-10-12: "Terminalde
 * yazı yazarken ekran titreşiyor"). It used to clear only the cursor's row and write the whole line
 * there: a line longer than the terminal was written again under itself on every key, and the cursor
 * never showed where the arrows had moved it.
 *
 * Now each draw is one write: back to the line's first row, clear to the end of the screen, the prompt
 * and the text, then the cursor where it stands — the rows counted as the terminal counts them (its
 * cell widths, tab stops, the wrap after the last column, a wide character that does not fit moved
 * on). A line exactly filling its last row is wrapped softly (as the terminal wraps), so a resize
 * reflows it.
 *
 * User report 2026-10-12 ("terminale direk yapıştıramıyorum"): the terminal is where code of many lines
 * is typed and pasted. Each line after the first opens with mongosh's "... "; a line taller than the
 * screen shows the rows around the cursor (the rows above the screen cannot be drawn again), a row
 * saying how many lines are left out above and below, and is written whole when it is left.
 */
export interface LineState {
  /** The cursor's row, counted from the line's first row drawn. */
  cursorRow: number
  /** The line's last row drawn, counted the same way. */
  lastRow: number
  /** A line taller than the screen: the first of its rows shown, counted in all its rows. */
  top?: number
}

export interface DrawOptions {
  /** Written at the start of each of the text's lines after the first (mongosh's "... "). */
  continuation?: string
  /** The row standing for lines left out of a tall line, above or below (plain text, cut to fit). */
  more?: (lines: number, above: boolean) => string
}

const ESC = String.fromCharCode(27)
/** The app's colours (SGR) take no cell. */
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')
const TAB = 8
/** What a left-out part shows when nothing else is said. */
const ELLIPSIS = '…'

interface Position {
  row: number
  /** The column; equal to the width when the next character wraps (the terminal's pending wrap). */
  col: number
}

/** Where the cursor stands after the text, from a position. */
function advance(from: Position, text: string, cols: number): Position {
  let { row, col } = from
  for (const ch of text.replace(SGR, '')) {
    if (ch === '\r') col = 0
    else if (ch === '\n') row++
    else if (ch === '\t') col = Math.min(cols - 1, (Math.floor(col / TAB) + 1) * TAB)
    else {
      const width = cellWidth(ch.codePointAt(0)!)
      if (width === 0) continue
      // A full row, or a wide character in its last cell: on the next row.
      if (col >= cols || col + width > cols) {
        row++
        col = 0
      }
      col += width
    }
  }
  return { row, col }
}

/** One colour (SGR) at a position; anything else an ESC starts is a character (review M2). */
const COLOUR_AT = new RegExp(`${ESC}\\[[0-9;]*m`, 'y')
const RESET = `${ESC}[39m`
/** A colour that ends the one open. */
const ends = (seq: string) => seq === RESET || seq === `${ESC}[0m`

/** The code points a coloured text shows (its colours count none). */
function shown(coloured: string): number {
  let seen = 0
  let i = 0
  while (i < coloured.length) {
    COLOUR_AT.lastIndex = i
    const seq = COLOUR_AT.exec(coloured)
    if (seq) i += seq[0].length
    else {
      i += coloured.codePointAt(i)! > 0xffff ? 2 : 1
      seen++
    }
  }
  return seen
}

/**
 * The code points [from, to) of a coloured text (its colours count none), the colour open at `from`
 * opened again before them and closed after them: each part can be written on its own.
 */
function sliceColoured(coloured: string, from: number, to: number): string {
  let seen = 0
  let open = ''
  let out = ''
  let i = 0
  while (i < coloured.length && seen < to) {
    COLOUR_AT.lastIndex = i
    const seq = COLOUR_AT.exec(coloured)
    if (seq) {
      open = ends(seq[0]) ? '' : seq[0]
      if (seen >= from) out += seq[0]
      i += seq[0].length
      continue
    }
    const width = coloured.codePointAt(i)! > 0xffff ? 2 : 1
    if (seen === from && open && !out) out = open
    if (seen >= from) out += coloured.slice(i, i + width)
    i += width
    seen++
  }
  return open && out ? `${out}${RESET}` : out
}

/**
 * The continuation after each of a text's newlines; a colour open across one (a template, a comment)
 * is closed before it and opened again after, so "..." keeps its own.
 */
function continued(text: string, continuation: string): string {
  if (!continuation) return text
  let out = ''
  let open = ''
  let i = 0
  while (i < text.length) {
    COLOUR_AT.lastIndex = i
    const seq = COLOUR_AT.exec(text)
    if (seq) {
      open = ends(seq[0]) ? '' : seq[0]
      out += seq[0]
      i += seq[0].length
      continue
    }
    const newline = text.startsWith('\r\n', i) ? '\r\n' : text[i] === '\n' ? '\n' : ''
    if (newline) {
      out += open ? `${RESET}${newline}${continuation}${open}` : `${newline}${continuation}`
      i += newline.length
      continue
    }
    out += text[i]
    i++
  }
  return out
}

/**
 * The rows a written text takes, as the terminal wraps it: where each starts and ends in the text, and
 * the colour open where it starts.
 */
function rowsOf(text: string, cols: number): { starts: number[]; ends: number[]; opens: string[] } {
  const starts = [0]
  const stops: number[] = []
  const opens = ['']
  let col = 0
  let open = ''
  let i = 0
  while (i < text.length) {
    COLOUR_AT.lastIndex = i
    const seq = COLOUR_AT.exec(text)
    if (seq) {
      open = ends(seq[0]) ? '' : seq[0]
      i += seq[0].length
      continue
    }
    const code = text.codePointAt(i)!
    const size = code > 0xffff ? 2 : 1
    if (text[i] === '\r') col = 0
    else if (text[i] === '\n') {
      stops.push(text[i - 1] === '\r' ? i - 1 : i)
      starts.push(i + 1)
      opens.push(open)
      col = 0
    } else if (text[i] === '\t') col = Math.min(cols - 1, (Math.floor(col / TAB) + 1) * TAB)
    else {
      const width = cellWidth(code)
      if (width > 0) {
        if (col >= cols || col + width > cols) {
          stops.push(i)
          starts.push(i)
          opens.push(open)
          col = 0
        }
        col += width
      }
    }
    i += size
  }
  stops.push(text.length)
  return { starts, ends: stops, opens }
}

/** A row's text cut to fit in fewer cells than the row has (never wrapping), shown dim. */
function fitted(text: string, cols: number): string {
  let used = 0
  let out = ''
  for (const ch of text.replace(SGR, '')) {
    const width = cellWidth(ch.codePointAt(0)!)
    if (ch < ' ' || used + width > cols - 1) break
    used += width
    out += ch
  }
  return `${ESC}[90m${out}${RESET}`
}

/** The newlines in a text. */
const newlines = (text: string) => text.split('\n').length - 1

/** The way back to the line's first column, then the screen below it cleared. */
const toStart = (state: LineState) => `${state.cursorRow > 0 ? `${ESC}[${state.cursorRow}A` : ''}\r${ESC}[J`

/**
 * Draws the prompt and the text again, the cursor between `before` and `after` (both already made
 * safe; the prompt coloured: they are written as given). `rows`: the screen's height.
 */
export function drawLine(
  previous: LineState,
  prompt: string,
  before: string,
  after: string,
  columns: number,
  rows = Number.POSITIVE_INFINITY,
  /** Colours for the line's text, as a whole (a string across the cursor stays one). */
  colour?: (text: string) => string,
  options: DrawOptions = {},
): { out: string; state: LineState } {
  const cols = columns > 0 ? columns : Number.MAX_SAFE_INTEGER
  // Never taller than the screen less a row: the rows above it could not be drawn again.
  const maxRows = Math.max(1, (rows > 0 ? rows : Number.POSITIVE_INFINITY) - 1)
  // The whole line coloured first: a part shown from inside a string keeps the string's colour.
  const text = before + after
  const split = [...before].length
  const whole = [...text].length
  // Colours that change what is shown (one never closed, say) are dropped: the text drawn plain.
  const painted = colour ? colour(text) : null
  const coloured = painted !== null && shown(painted) === whole ? painted : null
  const part = (a: number, b: number) =>
    coloured === null ? [...text].slice(a, b).join('') : sliceColoured(coloured, a, b)
  const continuation = options.continuation ?? ''
  const head = prompt + continued(part(0, split), continuation)
  const full = head + continued(part(split, whole), continuation)
  const end = advance({ row: 0, col: 0 }, full, cols)
  let target = advance({ row: 0, col: 0 }, head, cols)
  // At the end of a full row the next character goes on the next: a blank there wraps the line
  // softly (as typing would), and the cursor shows on it.
  let blank = false
  if (target.col >= cols) {
    target = { row: target.row + 1, col: 0 }
    blank = target.row > end.row
  }
  const lastRow = Math.max(end.row, target.row)
  let out = toStart(previous)
  if (lastRow < maxRows) {
    out += full + (blank ? ' ' : '')
    if (target.row < lastRow) out += `${ESC}[${lastRow - target.row}A`
    out += `${ESC}[${target.col + 1}G`
    return { out, state: { cursorRow: target.row, lastRow } }
  }
  // Taller than the screen: the rows around the cursor, the same ones while it stays among them; a
  // row above and one below say what is left out — one row saying both on a screen of three rows
  // (review 2026-10-12, minor 16), none on smaller.
  const marks = maxRows >= 3 ? 2 : maxRows - 1
  const size = maxRows - marks
  const kept = previous.top
  let top =
    kept === undefined || target.row >= kept + size
      ? target.row - size + 1
      : target.row < kept
        ? target.row
        : kept
  top = Math.max(0, Math.min(top, lastRow - size + 1))
  const bottom = top + size - 1
  const { starts, ends: stops, opens } = rowsOf(full, cols)
  let piece = ''
  if (top <= end.row) {
    const from = starts[top]!
    const to = bottom >= end.row ? full.length : stops[bottom]!
    piece = opens[top]! + full.slice(from, to)
    if (piece.includes(ESC)) piece += RESET
    if (blank && bottom === lastRow) piece += ' '
  }
  const label = (above: boolean) => {
    const lines = above
      ? newlines(full.slice(0, starts[top] ?? full.length))
      : newlines(full.slice(stops[bottom] ?? full.length))
    return options.more?.(lines, above) ?? ELLIPSIS
  }
  const hiddenAbove = top > 0
  const hiddenBelow = bottom < lastRow
  const one = marks === 1 && (hiddenAbove || hiddenBelow)
  const above = one || (marks === 2 && hiddenAbove)
  const below = marks === 2 && hiddenBelow
  if (above) {
    const text = one
      ? [hiddenAbove ? label(true) : '', hiddenBelow ? label(false) : ''].filter(Boolean).join('  ')
      : label(true)
    out += `${fitted(text, cols)}\r\n`
  }
  out += piece
  if (below) out += `\r\n${fitted(label(false), cols)}`
  const shownLast = (above ? 1 : 0) + (bottom - top) + (below ? 1 : 0)
  const cursorRow = (above ? 1 : 0) + target.row - top
  if (cursorRow < shownLast) out += `${ESC}[${shownLast - cursorRow}A`
  out += `${ESC}[${target.col + 1}G`
  return { out, state: { cursorRow, lastRow: shownLast, top } }
}

/**
 * Leaves the line, wherever its cursor is: written again whole (a line taller than the screen too),
 * `tail` at its end (as ^C), then a new line.
 */
export function leaveLine(
  state: LineState,
  prompt: string,
  text: string,
  columns: number,
  tail = '',
  colour?: (text: string) => string,
  options: DrawOptions = {},
): string {
  const { out } = drawLine(state, prompt, text, '', columns, Number.POSITIVE_INFINITY, colour, options)
  return `${out}${tail}\r\n`
}

/**
 * The line after the terminal was resized (and reflowed it): its cursor's row as the terminal reports
 * it, counted from the line's first row (kept by a marker); its last row as drawn at the new width.
 */
export function lineAfterResize(
  cursorRow: number,
  prompt: string,
  before: string,
  after: string,
  columns: number,
  rows = Number.POSITIVE_INFINITY,
  options: DrawOptions = {},
  /** A tall line's first row shown before: the same rows shown again. */
  top?: number,
): LineState {
  const drawn = drawLine(
    { cursorRow: 0, lastRow: 0, ...(top !== undefined ? { top } : {}) },
    prompt,
    before,
    after,
    columns,
    rows,
    undefined,
    options,
  )
  const row = Math.max(0, cursorRow)
  return {
    cursorRow: row,
    lastRow: Math.max(drawn.state.lastRow, row),
    ...(drawn.state.top !== undefined ? { top: drawn.state.top } : {}),
  }
}

/** Back to the line's first column with the screen below cleared: something else is written there. */
export function clearLine(state: LineState): string {
  return toStart(state)
}
