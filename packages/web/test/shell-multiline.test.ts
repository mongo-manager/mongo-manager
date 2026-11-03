import { describe, expect, it } from 'vitest'
import { LineEditor, MAX_LINE_BYTES, lineFits, pasted } from '../src/shell/lineEditor'

/**
 * User report 2026-10-12 ("terminale direk yapıştıramıyorum… \x0d gibi terimler geliyor"): xterm hands
 * a paste over with its line ends as CR; they were kept, and shown as \x0d. The terminal is now the
 * only place code is typed: a paste of many lines is edited there, line by line, and run whole.
 */
describe('a paste (user report 2026-10-12)', () => {
  it('turns CR and CRLF line ends into newlines', () => {
    expect(pasted('use shop\rdb.orders.find()')).toBe('use shop\ndb.orders.find()')
    expect(pasted('a\r\nb\r\nc')).toBe('a\nb\nc')
    expect(pasted('a\nb')).toBe('a\nb')
  })

  it('leaves out the blank lines a copy ends with, never the last line’s own text', () => {
    expect(pasted('db.x.find()\r\r')).toBe('db.x.find()')
    expect(pasted('db.x.find()\n  \n')).toBe('db.x.find()')
    expect(pasted("x = 'a  '")).toBe("x = 'a  '")
    expect(pasted('a  \nb')).toBe('a  \nb')
  })

  // A paste cut at the line's limit could run a part of what was copied: it is taken whole or not at all.
  it('is refused whole when the line would pass its limit, never cut', () => {
    const e = new LineEditor()
    e.input('db.x.find()')
    e.input(`db.x.deleteMany({ a: '${'x'.repeat(70 * 1024)}' })`)
    expect(e.buffer).toBe('db.x.find()')
    // The limit is the bytes the line fills in its message: UTF-8, escaped as JSON (the quotes too).
    const room = MAX_LINE_BYTES - 2 - 'db.x.find()'.length
    e.input('y'.repeat(room + 1))
    expect(e.buffer).toBe('db.x.find()')
    e.input('y'.repeat(room))
    expect(e.buffer.length).toBe(MAX_LINE_BYTES - 2)
    // A character of two bytes, or one JSON escapes, counts as it is sent.
    expect(lineFits('ş'.repeat(MAX_LINE_BYTES / 2))).toBe(false)
    expect(lineFits('\n'.repeat(MAX_LINE_BYTES / 2))).toBe(false)
    expect(lineFits('ş'.repeat(MAX_LINE_BYTES / 2 - 1))).toBe(true)
  })

  it('goes into the line whole, never run: Enter runs it', () => {
    const e = new LineEditor()
    const state = e.input(pasted('db.orders.aggregate([\r  { $match: {} },\r])'))
    expect(state.action).toBeUndefined()
    expect(e.buffer).toBe('db.orders.aggregate([\n  { $match: {} },\n])')
    expect(e.key('Enter').submit).toBe('db.orders.aggregate([\n  { $match: {} },\n])')
  })
})

describe('a line of many lines', () => {
  const editor = (text: string, cursor = text.length) => {
    const e = new LineEditor({ history: ['older'] })
    e.input(text)
    e.cursor = cursor
    return e
  }

  it('moves up and down between its lines, keeping the column it started from', () => {
    const e = editor('abcdef\nxy\nlonger line')
    e.key('ArrowUp')
    expect(e.cursor).toBe('abcdef\nxy'.length) // column 11 cut to the line's end
    e.key('ArrowUp')
    expect(e.cursor).toBe('abcdef'.length) // column 11 still asked for
    e.key('ArrowDown')
    expect(e.cursor).toBe('abcdef\nxy'.length)
    e.key('ArrowDown')
    expect(e.cursor).toBe('abcdef\nxy\nlonger line'.length)
    expect(e.buffer).toBe('abcdef\nxy\nlonger line')
  })

  it('takes the column anew after typing, a completion or a history entry', () => {
    const typed = editor('abcdef\nxy\nlonger line')
    typed.key('ArrowUp')
    typed.input('Z')
    typed.key('ArrowUp')
    expect(typed.cursor).toBe(3)
    const completed = editor('abcdef\nxy\nlonger line')
    completed.key('ArrowUp')
    completed.replaceRange(9, 9, 'Z')
    completed.key('ArrowUp')
    expect(completed.cursor).toBe(3)
    const recalled = new LineEditor({ history: ['one\ntwo-long'] })
    recalled.input('abcdefgh\nx')
    recalled.key('ArrowUp') // to the first line, column 1
    recalled.key('ArrowUp') // the history entry, its cursor at its end (column 8)
    expect(recalled.buffer).toBe('one\ntwo-long')
    recalled.key('ArrowUp')
    expect(recalled.cursor).toBe(3)
  })

  it('takes the column anew once the cursor moved along its line', () => {
    const e = editor('abcdef\nxy\nlonger line')
    e.key('ArrowUp')
    e.key('ArrowLeft')
    e.key('ArrowUp')
    expect(e.cursor).toBe(1)
  })

  it('walks history only from its first line (up) or its last (down)', () => {
    const e = editor('one\ntwo', 1)
    e.key('ArrowUp')
    expect(e.buffer).toBe('older')
    e.key('ArrowDown')
    expect(e.buffer).toBe('one\ntwo')
    const f = editor('one\ntwo', 1)
    f.key('ArrowDown')
    expect(f.buffer).toBe('one\ntwo')
    expect(f.cursor).toBe('one\n'.length + 1)
    // Past the newest there is nothing: what is typed stays (it was wiped).
    f.key('ArrowDown')
    expect(f.buffer).toBe('one\ntwo')
  })

  it('keeps a typed line when Down is pressed with no history walked', () => {
    const e = new LineEditor({ history: ['older'] })
    e.input('half typed')
    e.key('ArrowDown')
    expect(e.buffer).toBe('half typed')
  })

  it('moves over an empty line', () => {
    const e = editor('ab\n\ncd')
    e.key('ArrowUp')
    expect(e.cursor).toBe(3)
    e.key('ArrowUp')
    expect(e.cursor).toBe(2)
    const f = editor('\nab', 3)
    f.key('ArrowUp')
    expect(f.cursor).toBe(0)
  })

  it('has Home, End, Ctrl+A, Ctrl+E, Ctrl+U and Ctrl+K act on the cursor’s line', () => {
    const e = editor('first\nsecond\nthird', 'first\nsec'.length)
    e.key('Home')
    expect(e.cursor).toBe('first\n'.length)
    e.key('End')
    expect(e.cursor).toBe('first\nsecond'.length)
    e.key('Ctrl+A')
    expect(e.cursor).toBe('first\n'.length)
    e.key('Ctrl+E')
    expect(e.cursor).toBe('first\nsecond'.length)
    e.cursor = 'first\nsec'.length
    e.key('Ctrl+U')
    expect(e.buffer).toBe('first\nond\nthird')
    expect(e.cursor).toBe('first\n'.length)
    e.key('Ctrl+K')
    expect(e.buffer).toBe('first\n\nthird')
  })

  it('has Home on the first line go to its start', () => {
    const e = editor('abc', 2)
    e.key('Home')
    expect(e.cursor).toBe(0)
  })
})

describe('a character outside the BMP (two UTF-16 units)', () => {
  it('is stepped over, deleted and kept whole by the arrows, Backspace and Delete', () => {
    const e = new LineEditor()
    e.input('a😉b')
    e.key('ArrowLeft')
    e.key('ArrowLeft')
    expect(e.cursor).toBe(1)
    e.key('ArrowRight')
    expect(e.cursor).toBe(3)
    e.key('Backspace')
    expect(e.buffer).toBe('ab')
    e.input('😉')
    e.key('ArrowLeft')
    e.key('Delete')
    expect(e.buffer).toBe('ab')
  })

  it('never leaves the cursor inside one when moving between lines', () => {
    const e = new LineEditor()
    e.input('ab😉😉\nabcd')
    e.key('ArrowLeft')
    e.key('ArrowUp') // column 3: after the first emoji (one cell, as the terminal shows it)
    expect(e.cursor).toBe(4)
  })
})

// Review 2026-10-12 (M12): Up and Down kept a column of UTF-16 units: across CJK or tabs the cursor
// landed on another column than the one it left.
describe('moving between lines by what the terminal shows', () => {
  it('keeps the column in cells: two for CJK, a tab to its stop', () => {
    const wide = new LineEditor()
    wide.input('漢字ab\nabcd')
    wide.key('ArrowUp') // column 4 of "abcd": after 漢字
    expect(wide.cursor).toBe(2)
    wide.key('ArrowDown')
    expect(wide.cursor).toBe('漢字ab\nabcd'.length)
    const odd = new LineEditor()
    odd.input('漢字ab\nabc')
    odd.key('ArrowUp') // column 3 falls inside 字: before it
    expect(odd.cursor).toBe(1)
    // From a line of CJK: its cells, not its units, are the column taken down.
    const from = new LineEditor()
    from.input('漢字x\nabcdefgh')
    from.cursor = 2 // after 漢字: column 4
    from.key('ArrowDown')
    expect(from.cursor).toBe('漢字x\nabcd'.length)
    const tab = new LineEditor()
    tab.input('\tx\n12345678y')
    tab.key('ArrowUp') // column 9: after the tab (8 cells) and x
    expect(tab.cursor).toBe(2)
  })
})

describe('keys of the line', () => {
  // Review 2026-10-12 (I2): code the reader takes for open had no way to run without the editor.
  it('runs the line as it is with Ctrl+Enter, open or not', () => {
    const e = new LineEditor()
    e.input('db.x.find({')
    expect(e.key('Ctrl+Enter')).toMatchObject({ action: 'run', submit: 'db.x.find({' })
    expect(e.buffer).toBe('')
  })

  it('goes on after what cannot end a statement, and runs a regular expression with // in it', () => {
    const e = new LineEditor()
    e.input('db.orders.')
    expect(e.key('Enter').action).toBeUndefined()
    expect(e.buffer).toBe('db.orders.\n')
    const r = new LineEditor()
    r.input('db.links.find({ url: /^https?:\\/\\// })')
    expect(r.key('Enter').action).toBe('run')
  })

  it('moves and deletes by word: Alt+B, Alt+F, Ctrl+Left, Ctrl+Right, Alt+D', () => {
    const e = new LineEditor()
    e.input('db.orders find  more')
    e.key('Alt+B')
    expect(e.cursor).toBe('db.orders find  '.length)
    e.key('Ctrl+ArrowLeft')
    expect(e.cursor).toBe('db.orders '.length)
    e.key('Alt+F')
    expect(e.cursor).toBe('db.orders find'.length)
    e.key('Ctrl+ArrowLeft')
    e.key('Alt+D')
    expect(e.buffer).toBe('db.orders   more')
    e.key('Ctrl+ArrowRight')
    expect(e.cursor).toBe('db.orders   more'.length)
  })

  // Review 2026-10-12 (M14): Ctrl+W crossed a line break while Ctrl+U and Ctrl+K kept to their line.
  it('deletes the word before the cursor with Ctrl+W, never past its line', () => {
    const e = new LineEditor()
    e.input('abc def\n')
    e.key('Ctrl+W')
    expect(e.buffer).toBe('abc def\n')
    e.input('x  ')
    e.key('Ctrl+W')
    expect(e.buffer).toBe('abc def\n')
    e.key('Backspace')
    e.key('Ctrl+W')
    expect(e.buffer).toBe('abc ')
  })

  // Review 2026-10-12 (M13): Up on the oldest entry moved the cursor to the end.
  it('does nothing with Up on the oldest entry, or with no history', () => {
    const e = new LineEditor({ history: ['only one'] })
    e.key('ArrowUp')
    e.key('Home')
    e.key('ArrowUp')
    expect([e.buffer, e.cursor]).toEqual(['only one', 0])
    const none = new LineEditor()
    none.input('typed')
    none.key('Home')
    none.key('ArrowUp')
    expect([none.buffer, none.cursor]).toEqual(['typed', 0])
  })
})

// Review 2026-10-12 (M15): Backspace edited the entry found while the search prompt stayed, and Up
// or Down after a search walked from where the search began.
describe('reverse search (Ctrl+R), as bash has it', () => {
  const history = ['use shop', 'db.orders.find()', 'db.items.find()', 'db.orders.count()']
  it('finds older matches with Ctrl+R again, and shortens the search with Backspace', () => {
    const e = new LineEditor({ history })
    e.key('Ctrl+R')
    e.searchInput('orders')
    expect(e.buffer).toBe('db.orders.count()')
    e.key('Ctrl+R')
    expect(e.buffer).toBe('db.orders.find()')
    e.key('Backspace')
    expect(e.searchQuery).toBe('order')
    expect(e.buffer).toBe('db.orders.count()')
    expect(e.searching).toBe(true)
  })

  it('leaves with Escape, the line as it was', () => {
    const e = new LineEditor({ history })
    e.input('half')
    e.key('Ctrl+R')
    e.searchInput('items')
    expect(e.buffer).toBe('db.items.find()')
    e.key('Escape')
    expect([e.searching, e.buffer]).toEqual([false, 'half'])
  })

  it('takes the entry found with any other key, which then acts on it; Up and Down go on from it', () => {
    const e = new LineEditor({ history })
    e.key('Ctrl+R')
    e.searchInput('items')
    e.key('Home')
    expect([e.searching, e.buffer, e.cursor]).toEqual([false, 'db.items.find()', 0])
    e.key('ArrowUp')
    expect(e.buffer).toBe('db.orders.find()')
    e.key('ArrowDown')
    e.key('ArrowDown')
    expect(e.buffer).toBe('db.orders.count()')
    // Enter takes the entry found without running it.
    const f = new LineEditor({ history })
    f.key('Ctrl+R')
    f.searchInput('use')
    expect(f.key('Enter').action).toBeUndefined()
    expect([f.searching, f.buffer]).toEqual([false, 'use shop'])
  })
})

describe('a paste, its edges', () => {
  it('leaves out the blank lines it starts with too, keeping the first line’s indent', () => {
    expect(pasted('\r\n\r\n  db.x.find()\r\n')).toBe('  db.x.find()')
    expect(pasted('   \n\t\n')).toBe('')
  })

  // Review 2026-10-12 (I4): a regular expression made a paste of many blank lines take seconds.
  it('reads a paste of many blank lines in one pass', () => {
    const start = performance.now()
    expect(pasted(`x${'\r\n'.repeat(200_000)}`)).toBe('x')
    expect(performance.now() - start).toBeLessThan(500)
  })
})

// Second review 2026-10-12.
describe('the line editor, second review', () => {
  // I5: history set again while searching left an index into the old list; the next key threw.
  it('leaves the search when its history is set again, every key still working', () => {
    const e = new LineEditor({ history: ['db.a.find()', 'db.b.find()'] })
    e.key('Ctrl+R')
    e.searchInput('d')
    e.setHistory([])
    expect(e.searching).toBe(false)
    expect(() => {
      e.key('ArrowRight')
      e.key('ArrowUp')
      e.key('ArrowDown')
    }).not.toThrow()
    expect(typeof e.buffer).toBe('string')
  })

  // Minor 18: the column counted from the line's start, not where the terminal shows it (the prompt
  // before the first line, "... " before the others).
  it('keeps the column where the terminal shows it, the prompt and "..." counted', () => {
    const e = new LineEditor()
    e.indents = { first: 6, rest: 4 } // "shop> " and "... "
    e.input('abcdef\nxyz')
    e.cursor = 'abcdef\n'.length + 2 // on screen: 4 + 2 = column 6
    e.key('ArrowUp') // column 6 of "shop> abcdef": its first character
    expect(e.cursor).toBe(0)
    e.key('ArrowDown') // back to column 6: "... xy|z"
    expect(e.cursor).toBe('abcdef\n'.length + 2)
  })

  it('counts a character that shows nothing as the escape the line shows for it', () => {
    const zero = String.fromCharCode(0x200b)
    const e = new LineEditor()
    e.input(`a${zero}b\nabcdefgh`)
    e.cursor = `a${zero}b\n`.length + 7 // column 7: after "a", the escape (6) — before "b"
    e.key('ArrowUp')
    expect(e.cursor).toBe(2)
  })

  // Minor 19: a word ended only at a space; Alt+B in `db.orders.find(` jumped to `db`.
  it('moves by word as readline does, punctuation between words', () => {
    const e = new LineEditor()
    e.input('db.orders.find(')
    e.key('Alt+B')
    expect(e.cursor).toBe('db.orders.'.length)
    e.key('Alt+B')
    expect(e.cursor).toBe('db.'.length)
    e.key('Alt+F')
    expect(e.cursor).toBe('db.orders'.length)
  })

  it('deletes a word back with Ctrl+Backspace and forward with Ctrl+Delete', () => {
    const e = new LineEditor()
    e.input('db.orders.find')
    e.key('Ctrl+Backspace')
    expect(e.buffer).toBe('db.orders.')
    e.key('Home')
    e.key('Ctrl+Delete')
    expect(e.buffer).toBe('.orders.')
  })

  // Minor 24: a paste of megabytes became what was searched for.
  it('keeps what is searched for short', () => {
    const e = new LineEditor({ history: ['x'] })
    e.key('Ctrl+R')
    e.searchInput('y'.repeat(10_000))
    expect(e.searchQuery.length).toBeLessThanOrEqual(256)
  })
})
