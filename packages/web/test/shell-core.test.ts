// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { revealInvisible, writeSafe } from '../src/shell/writeSafe'
import { LineEditor, isIncomplete } from '../src/shell/lineEditor'
import { formatResult } from '../src/shell/formatResult'

describe('writeSafe (phase 3a-1 §10.1)', () => {
  it('renders control and bidi bytes as visible escapes', () => {
    expect(writeSafe('\x1b[31mred')).toBe('\\x1b[31mred')
    expect(writeSafe('\x1b]52;c;SGVsbG8=\x07')).toContain('\\x1b')
    expect(writeSafe('\x1b]52;c;SGVsbG8=\x07')).toContain('\\x07')
    expect(writeSafe('\x9b')).toBe('\\x9b')
    expect(writeSafe('\u202E')).toBe('\\u202e')
    expect(writeSafe('\x00\x01\x1f')).toBe('\\x00\\x01\\x1f')
  })

  it('turns a newline into CRLF and keeps tabs', () => {
    expect(writeSafe('a\nb')).toBe('a\r\nb')
    expect(writeSafe('a\tb')).toBe('a\tb')
  })

  it('passes emoji, combining marks and long lines, and escapes a lone surrogate (Review Focus 4)', () => {
    expect(writeSafe('café 🎉 é')).toBe('café 🎉 é')
    const long = 'x'.repeat(100_000)
    expect(writeSafe(long)).toBe(long)
    expect(writeSafe('😉')).toBe('😉') // a valid pair is kept
    expect(writeSafe('\ud800')).toBe('\\ud800') // a lone surrogate is escaped
  })
})

// Review 2026-10-12 (M4): a shared snippet could hide a zero-width character in a name ("users\u200b").
describe('revealInvisible', () => {
  it('shows the characters that show nothing as escapes, and keeps the rest', () => {
    expect(revealInvisible('users\u200b')).toBe('users\\u200b')
    for (const code of [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0x2064, 0xfeff, 0x061c, 0x00ad])
      expect(revealInvisible(`a${String.fromCharCode(code)}b`)).toBe(
        `a\\u${code.toString(16).padStart(4, '0')}b`,
      )
    expect(revealInvisible('café 😉 漢字 \t x')).toBe('café 😉 漢字 \t x')
    // Second review 2026-10-12 (minor 17): tag characters (ASCII smuggling), variation selectors,
    // Hangul fillers and the rest Unicode counts as showing nothing.
    const tag = String.fromCodePoint(0xe0041)
    expect(revealInvisible(`users${tag}`)).toBe('users\\u{e0041}')
    for (const code of [0xfe0f, 0x180e, 0x034f, 0x206a, 0x115f, 0x3164, 0xffa0])
      expect(revealInvisible(`a${String.fromCodePoint(code)}`), code.toString(16)).toBe(
        `a\\u${code.toString(16).padStart(4, '0')}`,
      )
  })
})

describe('isIncomplete (phase 3a-1 §10)', () => {
  it('continues while a bracket, quote, template or block comment is open', () => {
    expect(isIncomplete('db.x.find({')).toBe(true)
    expect(isIncomplete("db.x.find('ab")).toBe(true)
    expect(isIncomplete('`multi')).toBe(true)
    expect(isIncomplete('/* open')).toBe(true)
    expect(isIncomplete('db.x.find({ a: 1 })')).toBe(false)
    expect(isIncomplete('// a comment')).toBe(false)
    expect(isIncomplete("db.x.find({ a: '}' })")).toBe(false)
  })
})

describe('LineEditor (phase 3a-1 §10)', () => {
  it('inserts, moves and deletes', () => {
    const e = new LineEditor()
    e.input('hello')
    e.key('ArrowLeft')
    e.key('ArrowLeft')
    e.input('X')
    expect(e.buffer).toBe('helXlo')
    e.key('Home')
    e.key('Delete')
    expect(e.buffer).toBe('elXlo')
    e.key('End')
    e.key('Backspace')
    expect(e.buffer).toBe('elXl')
    e.key('Ctrl+U')
    expect(e.buffer).toBe('')
  })

  it('runs a complete command and continues an incomplete one', () => {
    const e = new LineEditor()
    e.input('db.x.find({')
    const cont = e.key('Enter')
    expect(cont.action).toBeUndefined()
    expect(e.buffer).toBe('db.x.find({\n')
    e.input(' a: 1 })')
    const run = e.key('Enter')
    expect(run.action).toBe('run')
    expect(run.submit).toBe('db.x.find({\n a: 1 })')
    expect(e.buffer).toBe('')
  })

  it('walks history with the arrows', () => {
    const e = new LineEditor({ history: ['use shop', 'db.a.find()'] })
    e.key('ArrowUp')
    expect(e.buffer).toBe('db.a.find()')
    e.key('ArrowUp')
    expect(e.buffer).toBe('use shop')
    e.key('ArrowDown')
    expect(e.buffer).toBe('db.a.find()')
  })

  it('reverse-searches history with Ctrl+R', () => {
    const e = new LineEditor({ history: ['use shop', 'db.orders.find()', 'db.items.find()'] })
    e.key('Ctrl+R')
    expect(e.searching).toBe(true)
    e.searchInput('orders')
    expect(e.buffer).toBe('db.orders.find()')
    e.searchInput('x')
    // No match for "ordersx": the buffer stays on the last match.
    expect(e.buffer).toBe('db.orders.find()')
  })

  it('cancels with Ctrl+C and clears with Ctrl+L', () => {
    const e = new LineEditor()
    e.input('half typed')
    expect(e.key('Ctrl+C').action).toBe('cancel')
    expect(e.buffer).toBe('')
    expect(e.key('Ctrl+L').action).toBe('clear')
  })

  it('refuses a paste over 1 MiB', () => {
    const e = new LineEditor()
    e.input('x'.repeat(2 * 1024 * 1024))
    expect(e.buffer).toBe('')
  })
})

describe('formatResult (phase 3a-1 §6)', () => {
  it('formats documents, prints and errors', () => {
    expect(formatResult({ type: 'print', text: 'hello' })).toBe('hello')
    expect(formatResult({ type: 'error', message: 'boom' })).toBe('boom')
    expect(formatResult({ type: 'result', value: { a: { $numberInt: '1' } } })).toContain('a: 1')
    expect(formatResult({ type: 'reset', message: 'reset' })).toBe('reset')
  })

  // Found 2026-10-12: `use shop` showed "switched to db shop" in quotes; mongosh writes a string as is.
  it('writes a string result as it is, as mongosh does; a string inside a value stays quoted', () => {
    expect(formatResult({ type: 'result', value: 'switched to db shop' })).toBe('switched to db shop')
    expect(formatResult({ type: 'result', value: { s: 'x' } })).toContain('"x"')
  })

  it('asks for "it" after a cursor batch with more, as mongosh does (phase 3a-2)', () => {
    const batch = [{ a: { $numberInt: '1' } }]
    expect(formatResult({ type: 'result', value: batch, hasMore: true })).toMatch(/Type "it" for more$/)
    expect(formatResult({ type: 'result', value: batch, hasMore: false })).not.toContain('Type "it"')
  })
})
