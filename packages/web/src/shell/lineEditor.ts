// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { isIncomplete } from '@mongo-manager/shared/browser'
import { cellWidth } from './cellWidth'
import { revealInvisible } from './writeSafe'

/**
 * Phase 3a-1 spec §10: the shell's line editor, pure so it can be unit-tested. It holds the line
 * being typed — of many lines too (user report 2026-10-12: code is typed and pasted in the terminal
 * now) — and its cursor, walks history, and reverse-searches (Ctrl+R). Enter runs the code, or starts
 * a "..." line while it may go on (`isIncomplete`, as mongosh's reader says); Shift+Enter always
 * starts one, Ctrl+Enter always runs.
 */
export { isIncomplete }

/**
 * The most the line takes: the bytes it fills in the message that carries it (UTF-8, escaped as
 * JSON), the socket taking 64 KiB a message (review 2026-10-12, I7: a longer line closed the socket).
 */
export const MAX_LINE_BYTES = 63 * 1024
const encoder = new TextEncoder()
/** Whether code fits in the line (and so in the message that runs it). */
export const lineFits = (code: string): boolean =>
  code.length <= MAX_LINE_BYTES && encoder.encode(JSON.stringify(code)).length <= MAX_LINE_BYTES

/** Columns between tab stops, as the terminal sets them. */
const TAB = 8

export interface EditorState {
  /** The full multi-line buffer being edited. */
  buffer: string
  /** Cursor offset within the buffer. */
  cursor: number
  /** What to do after handling a key. */
  action?: 'run' | 'cancel' | 'clear'
  /** The command to run when action is 'run'. */
  submit?: string
}

/**
 * A paste as the line takes it (user report 2026-10-12: "\x0d gibi terimler geliyor"). A paste comes
 * with its line ends as CR (a terminal's Enter); they are newlines in the line, and the blank lines a
 * copy starts or ends with are left out. Nothing pasted runs: Enter runs it, once it has been read. One
 * pass, however long (review 2026-10-12, I4).
 */
export function pasted(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let first = 0
  let last = lines.length - 1
  while (first <= last && !lines[first]!.trim()) first++
  while (last >= first && !lines[last]!.trim()) last--
  return lines.slice(first, last + 1).join('\n')
}

/** Whether a UTF-16 offset falls between the two halves of a surrogate pair. */
const insidePair = (text: string, at: number) =>
  at > 0 && at < text.length && /[\ud800-\udbff]/.test(text[at - 1]!) && /[\udc00-\udfff]/.test(text[at]!)

/**
 * The cells a character takes after `column` cells, as the line shows it: a tab runs to the next stop,
 * a character that shows nothing takes its escape's (second review 2026-10-12, minor 17).
 */
function cells(ch: string, column: number): number {
  if (ch === '\t') return TAB - (column % TAB)
  const shown = revealInvisible(ch)
  return shown === ch ? cellWidth(ch.codePointAt(0)!) : shown.length
}

const SPACE = /\s/
/** A character of a word for moving and deleting by word, as readline has it (letters, digits, _ and $). */
const WORD = /[\p{L}\p{N}_$]/u
/** The longest text searched for (a paste of megabytes is no search). */
const MAX_QUERY = 256

export interface LineEditorOptions {
  history: string[]
}

export class LineEditor {
  buffer = ''
  cursor = 0
  private history: string[]
  private historyIndex: number
  private draft = ''
  /**
   * Reverse search (Ctrl+R): what is searched for, and the history entry found (-1: none yet). The
   * line as it was before is kept in `draft`, and comes back if the search is left with Escape.
   */
  private search: { query: string; found: number } | null = null
  /** The column, in cells, Up and Down keep to from where the moving started (null: the cursor's own). */
  private goal: number | null = null
  /** History lowercased once, for the search (second review 2026-10-12, minor 24). */
  private lowered: string[]
  /**
   * The cells before the first line (the prompt) and before each line after it ("... "): a column is
   * where the terminal shows it (second review 2026-10-12, minor 18).
   */
  indents = { first: 0, rest: 0 }

  constructor(options: LineEditorOptions = { history: [] }) {
    // Newest last; index points past the end (the live draft).
    this.history = [...options.history]
    this.lowered = this.history.map((h) => h.toLowerCase())
    this.historyIndex = this.history.length
  }

  /**
   * A new history (loaded, cleared, a new shell): a search in the old one ends, the line as it is
   * (second review 2026-10-12, I5: an index into the old one made the next key throw).
   */
  setHistory(history: string[]): void {
    this.history = [...history]
    this.lowered = this.history.map((h) => h.toLowerCase())
    this.historyIndex = this.history.length
    this.search = null
  }

  /**
   * Handle typed or pasted text, at the cursor. Taken whole or not at all: a paste cut at the line's
   * limit could run part of what was copied (the line is then as it was).
   */
  input(text: string): EditorState {
    return this.replaceRange(this.cursor, this.cursor, text)
  }

  /** Phase 3a-2: replace part of the line (a completion), leaving the cursor after the new text. */
  replaceRange(from: number, to: number, text: string): EditorState {
    const start = Math.max(0, Math.min(from, this.buffer.length))
    const end = Math.max(start, Math.min(to, this.buffer.length))
    const next = this.buffer.slice(0, start) + text + this.buffer.slice(end)
    if (!text || !lineFits(next)) return this.state()
    this.buffer = next
    this.cursor = start + text.length
    this.search = null
    this.goal = null
    return this.state()
  }

  /** Where the line holding `at` starts (after the newline before it). */
  private lineStart(at: number): number {
    return at === 0 ? 0 : this.buffer.lastIndexOf('\n', at - 1) + 1
  }

  /** Where the line holding `at` ends (at its newline, or the buffer's end). */
  private lineEnd(at: number): number {
    const nl = this.buffer.indexOf('\n', at)
    return nl === -1 ? this.buffer.length : nl
  }

  /** The offset one character (a code point, never half a pair) before or after the cursor. */
  private step(direction: -1 | 1, from = this.cursor): number {
    const to = from + direction
    return insidePair(this.buffer, to) ? to + direction : to
  }

  /** The cells before a line's text: the prompt before the first, "... " before the others. */
  private indent(start: number): number {
    return start === 0 ? this.indents.first : this.indents.rest
  }

  /** The screen column of an offset on its line (wide characters two, a mark none). */
  private column(start: number, at: number): number {
    let column = this.indent(start)
    for (const ch of this.buffer.slice(start, at)) column += cells(ch, column)
    return column
  }

  /** The offset on a line nearest a screen column without passing it (never inside a character). */
  private offsetAt(start: number, column: number): number {
    const end = this.lineEnd(start)
    let at = start
    let used = this.indent(start)
    for (const ch of this.buffer.slice(start, end)) {
      const width = cells(ch, used)
      if (used + width > column) break
      used += width
      at += ch.length
    }
    return at
  }

  /**
   * Up or down a line of the line being typed, at the column (in cells, as the terminal shows it) the
   * moving started from; from its first line up, or its last down, history is walked instead.
   */
  private vertical(direction: -1 | 1): void {
    const start = this.lineStart(this.cursor)
    const end = this.lineEnd(this.cursor)
    if (direction === -1 ? start === 0 : end === this.buffer.length) {
      this.goal = null
      return this.recall(direction)
    }
    this.goal ??= this.column(start, this.cursor)
    this.cursor = this.offsetAt(direction === -1 ? this.lineStart(start - 1) : end + 1, this.goal)
  }

  /**
   * The start of the word before the cursor, or the end of the one after: what is no word skipped
   * first, then the word. `spaces`: words end only at spaces (Ctrl+W, readline's unix-word-rubout);
   * otherwise at anything not a letter, a digit, `_` or `$` (Alt+B, Alt+F, Alt+D).
   */
  private wordEdge(direction: -1 | 1, spaces = false, from = this.cursor): number {
    let at = from
    const inWord = (i: number) => {
      const ch = this.buffer[direction === -1 ? i - 1 : i]!
      return spaces ? !SPACE.test(ch) : WORD.test(ch)
    }
    const inside = (i: number) => (direction === -1 ? i > 0 : i < this.buffer.length)
    while (inside(at) && !inWord(at)) at += direction
    while (inside(at) && inWord(at)) at += direction
    return insidePair(this.buffer, at) ? at + direction : at
  }

  /** Named keys from xterm's onKey (domEvent). Returns the state, with `action` when a command runs. */
  key(name: string, shift = false): EditorState {
    if (this.search) {
      const handled = this.searchKey(name)
      if (handled) return handled
    }
    // The column asked for lasts while the cursor only goes up and down.
    if (name !== 'ArrowUp' && name !== 'ArrowDown') this.goal = null
    switch (name) {
      case 'Enter':
        return this.onEnter(shift)
      case 'Ctrl+Enter':
        return this.run()
      case 'Backspace':
        if (this.cursor > 0) this.remove(this.step(-1), this.cursor)
        break
      case 'Delete':
        if (this.cursor < this.buffer.length) this.remove(this.cursor, this.step(1))
        break
      case 'ArrowLeft':
        if (this.cursor > 0) this.cursor = this.step(-1)
        break
      case 'ArrowRight':
        if (this.cursor < this.buffer.length) this.cursor = this.step(1)
        break
      case 'Ctrl+ArrowLeft':
      case 'Alt+B':
        this.cursor = this.wordEdge(-1)
        break
      case 'Ctrl+ArrowRight':
      case 'Alt+F':
        this.cursor = this.wordEdge(1)
        break
      case 'Alt+D':
      case 'Ctrl+Delete':
        this.remove(this.cursor, this.wordEdge(1))
        break
      case 'Ctrl+Backspace':
        this.remove(this.wordEdge(-1), this.cursor)
        break
      case 'Home':
      case 'Ctrl+A':
        this.cursor = this.lineStart(this.cursor)
        break
      case 'End':
      case 'Ctrl+E':
        this.cursor = this.lineEnd(this.cursor)
        break
      case 'ArrowUp':
        this.vertical(-1)
        break
      case 'ArrowDown':
        this.vertical(1)
        break
      case 'Ctrl+U':
        this.remove(this.lineStart(this.cursor), this.cursor)
        break
      case 'Ctrl+K':
        this.remove(this.cursor, this.lineEnd(this.cursor))
        break
      case 'Ctrl+W':
        // The word before the cursor, never past its line's start.
        this.remove(Math.max(this.lineStart(this.cursor), this.wordEdge(-1, true)), this.cursor)
        break
      case 'Ctrl+C':
        this.reset()
        return { ...this.state(), action: 'cancel' }
      case 'Ctrl+L':
        return { ...this.state(), action: 'clear' }
      case 'Ctrl+R':
        this.draft = this.buffer
        this.search = { query: '', found: -1 }
        break
    }
    return this.state()
  }

  private remove(from: number, to: number): void {
    if (to <= from) return
    this.buffer = this.buffer.slice(0, from) + this.buffer.slice(to)
    this.cursor = from
  }

  /**
   * A key while searching (as bash's Ctrl+R): Ctrl+R finds an older match, Backspace shortens what is
   * searched for, Escape leaves with the line as it was; any other key takes the entry found, and
   * then acts on it (Enter takes it without running it). Null: the key is then handled as usual.
   */
  private searchKey(name: string): EditorState | null {
    const search = this.search!
    switch (name) {
      case 'Ctrl+R':
        this.find(search.found >= 0 ? search.found - 1 : this.history.length - 1)
        return this.state()
      case 'Backspace': {
        search.query = [...search.query].slice(0, -1).join('')
        if (search.query) this.find(this.history.length - 1)
        else {
          search.found = -1
          this.buffer = this.draft
          this.cursor = this.buffer.length
        }
        return this.state()
      }
      case 'Escape':
        this.search = null
        this.buffer = this.draft
        this.cursor = this.buffer.length
        return this.state()
      default:
        this.search = null
        if (search.found >= 0) this.historyIndex = search.found
        return name === 'Enter' ? this.state() : null
    }
  }

  /** Type into the reverse search (after Ctrl+R): the newest entry holding what is searched for. */
  searchInput(text: string): EditorState {
    if (!this.search) return this.input(text)
    this.search.query = [...(this.search.query + text)].slice(0, MAX_QUERY).join('')
    this.find(this.search.found >= 0 ? this.search.found : this.history.length - 1)
    return this.state()
  }

  get searching(): boolean {
    return this.search !== null
  }

  get searchQuery(): string {
    return this.search?.query ?? ''
  }

  /** The newest entry at or before `from` holding the query; none found, the line stays. */
  private find(from: number): void {
    if (!this.search) return
    const q = this.search.query.toLowerCase()
    for (let i = Math.min(from, this.history.length - 1); i >= 0; i--) {
      if (this.lowered[i]!.includes(q)) {
        this.search.found = i
        this.buffer = this.history[i]!
        this.cursor = this.buffer.length
        return
      }
    }
  }

  private onEnter(shift: boolean): EditorState {
    if (shift || isIncomplete(this.buffer)) return this.input('\n')
    return this.run()
  }

  /** Runs the line as it is (Ctrl+Enter, or Enter on code that is complete). */
  private run(): EditorState {
    const submit = this.buffer
    const state: EditorState = { buffer: this.buffer, cursor: this.cursor, action: 'run', submit }
    if (submit.trim()) {
      this.history.push(submit)
      this.lowered.push(submit.toLowerCase())
    }
    this.reset()
    return state
  }

  private recall(direction: -1 | 1): void {
    if (direction === -1) {
      // Before the oldest there is nothing: the line and its cursor stay.
      if (this.historyIndex === 0) return
      if (this.historyIndex === this.history.length) this.draft = this.buffer
      this.historyIndex--
    } else {
      // Past the newest there is nothing: what is typed stays.
      if (this.historyIndex === this.history.length) return
      this.historyIndex++
    }
    this.buffer = this.historyIndex === this.history.length ? this.draft : this.history[this.historyIndex]!
    this.cursor = this.buffer.length
  }

  private reset(): void {
    this.buffer = ''
    this.cursor = 0
    this.draft = ''
    this.historyIndex = this.history.length
    this.search = null
  }

  private state(): EditorState {
    return { buffer: this.buffer, cursor: this.cursor }
  }
}
