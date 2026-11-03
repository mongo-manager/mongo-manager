import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { drawLine, leaveLine, lineAfterResize, type LineState } from '../src/shell/lineRender'
import { cellWidth } from '../src/shell/cellWidth'

const ESC = String.fromCharCode(27)
const START: LineState = { cursorRow: 0, lastRow: 0 }

/** A real terminal (xterm's own parser and wrapping): what the screen shows, row by row. */
async function screen(cols: number, writes: string[], height = 12) {
  const term = new Terminal({ cols, rows: height, allowProposedApi: true })
  for (const w of writes) await new Promise<void>((resolve) => term.write(w, resolve))
  const buffer = term.buffer.active
  const rows: string[] = []
  for (let i = 0; i < buffer.length; i++) rows.push(buffer.getLine(i)!.translateToString(true))
  while (rows.length && rows.at(-1) === '') rows.pop()
  return { rows, cursor: [buffer.cursorY + buffer.viewportY, buffer.cursorX] as const, term }
}

/** Draws each state of a line in turn, as typing does, on one terminal. */
function typing(
  cols: number,
  prompt: string,
  states: Array<[before: string, after: string]>,
  height = Number.POSITIVE_INFINITY,
) {
  let state = START
  const writes: string[] = []
  for (const [before, after] of states) {
    const drawn = drawLine(state, prompt, before, after, cols, height)
    state = drawn.state
    writes.push(drawn.out)
  }
  return { writes, state }
}

// User report 2026-10-12: "Terminalde yazı yazarken ekran titreşiyor". A line longer than the
// terminal was written again under itself on every key: only its last row was cleared.
describe('drawing the line being typed', () => {
  it('keeps a line that wraps on its own rows, however many keys are typed', async () => {
    const line = 'db.orders.find({ status: "paid" })'
    const states = [...line].map((_, i) => [line.slice(0, i + 1), ''] as [string, string])
    const { writes } = typing(12, 'shop> ', states)
    const { rows, cursor } = await screen(12, writes)
    expect(rows).toEqual(['shop> db.ord', 'ers.find({ s', 'tatus: "paid', '" })'])
    expect(cursor).toEqual([3, 4])
  })

  it('shows the cursor where it stands, also on an earlier row of a wrapped line', async () => {
    const { writes } = typing(10, '> ', [
      ['abcdefghijklmn', ''],
      ['abc', 'defghijklmn'],
    ])
    const { rows, cursor } = await screen(10, writes)
    expect(rows).toEqual(['> abcdefgh', 'ijklmn'])
    expect(cursor).toEqual([0, 5])
    // Typed there, the rest moves on and the cursor follows.
    const next = drawLine(
      typing(10, '> ', [
        ['abcdefghijklmn', ''],
        ['abc', 'defghijklmn'],
      ]).state,
      '> ',
      'abcX',
      'defghijklmn',
      10,
    )
    const after = await screen(10, [...writes, next.out])
    expect(after.rows).toEqual(['> abcXdefg', 'hijklmn'])
    expect(after.cursor).toEqual([0, 6])
  })

  it('puts the cursor on the next row when the line fills its last row exactly', async () => {
    const { writes, state } = typing(8, '> ', [['abcdef', '']])
    const { rows, cursor } = await screen(8, writes)
    // A blank cell starts the next row: the line wraps there as the terminal wraps it (softly).
    expect(rows).toEqual(['> abcdef', ' '])
    expect(cursor).toEqual([1, 0])
    expect(state).toEqual({ cursorRow: 1, lastRow: 1 })
    // Shortened again, the row it took is cleared.
    const back = await screen(8, [...writes, drawLine(state, '> ', 'abc', '', 8).out])
    expect(back.rows).toEqual(['> abc'])
    expect(back.cursor).toEqual([0, 5])
  })

  it('clears the rows a longer line took when it gets shorter', async () => {
    const { writes } = typing(10, '> ', [
      ['abcdefghijklmnopqrstuvwxyz', ''],
      ['abc', ''],
    ])
    const { rows, cursor } = await screen(10, writes)
    expect(rows).toEqual(['> abc'])
    expect(cursor).toEqual([0, 5])
  })

  it('never touches the output above the line', async () => {
    const { writes } = typing(10, '> ', [
      ['abcdefghijklmn', ''],
      ['ab', ''],
    ])
    const { rows } = await screen(10, ['earlier\r\n', ...writes])
    expect(rows).toEqual(['earlier', '> ab'])
  })

  it('leaves the line from its end, the cursor anywhere on it', async () => {
    const { writes, state } = typing(10, '> ', [['abc', 'defghijklmn']])
    const { rows, cursor } = await screen(10, [
      ...writes,
      leaveLine(state, '> ', 'abcdefghijklmn', 10),
      'out',
    ])
    expect(rows).toEqual(['> abcdefgh', 'ijklmn', 'out'])
    expect(cursor).toEqual([2, 3])
    // With something written at its end first (^C).
    const stopped = await screen(10, [...writes, leaveLine(state, '> ', 'abcdefghijklmn', 10, '^C'), 'next'])
    expect(stopped.rows).toEqual(['> abcdefgh', 'ijklmn^C', 'next'])
  })

  it('counts the prompt’s colours as nothing and writes it all in one go', () => {
    const coloured = `${ESC}[38;2;1;2;3mshop>${ESC}[0m `
    const { out, state } = drawLine(START, coloured, 'abcd', '', 10)
    expect(state).toEqual({ cursorRow: 1, lastRow: 1 })
    expect(out.startsWith(`\r${ESC}[J`)).toBe(true)
    expect(drawLine(START, coloured, 'ab', '', 10).state).toEqual({ cursorRow: 0, lastRow: 0 })
  })

  // Review 2026-10-12 (I1): the terminal counts two cells for CJK, none for a combining mark.
  it('counts the cells the terminal gives each character: two for CJK, none for a combining mark', async () => {
    const wide = '漢字漢字漢字ab'
    const states = [...wide].map((_, i) => [[...wide].slice(0, i + 1).join(''), ''] as [string, string])
    const { rows, cursor } = await screen(10, typing(10, '> ', states).writes)
    expect(rows).toEqual(['> 漢字漢字', '漢字ab'])
    expect(cursor).toEqual([1, 6])
    // A combining accent adds no cell: nothing above the line is ever cleared.
    const accents = 'e\u0301'.repeat(8)
    const steps = [...accents].map((_, i) => [[...accents].slice(0, i + 1).join(''), ''] as [string, string])
    const marked = await screen(10, ['out1\r\nout2\r\n', ...typing(10, '> ', steps).writes])
    expect(marked.rows[0]).toBe('out1')
    expect(marked.rows[1]).toBe('out2')
    expect(marked.rows.slice(2).join('').normalize('NFC').trimEnd()).toBe(`> ${'é'.repeat(8)}`)
  })

  it('keeps a combining mark on a full row’s last character, never starting the next row', async () => {
    const { writes, state } = typing(6, '> ', [['abcd\u0301', '']])
    const { rows, cursor } = await screen(6, writes)
    expect(rows[0]!.normalize('NFC')).toBe('> abcd\u0301'.normalize('NFC'))
    expect(cursor).toEqual([1, 0])
    expect(state).toEqual({ cursorRow: 1, lastRow: 1 })
  })

  it('moves a wide character that does not fit the row’s last cell to the next row', async () => {
    const { writes } = typing(5, '> ', [['ab漢', '']])
    const { rows, cursor } = await screen(5, writes)
    expect(rows).toEqual(['> ab', '漢'])
    expect(cursor).toEqual([1, 2])
  })

  // Review 2026-10-12 (M11): a line taller than the screen was written again into the scrollback.
  it('shows a line taller than the screen as the rows around the cursor, never piling up', async () => {
    const long = 'x'.repeat(82)
    const { writes } = typing(
      10,
      '> ',
      [
        [long, ''],
        [long, ''],
        [long.slice(0, 40), long.slice(40)],
      ],
      5,
    )
    const { rows, cursor, term } = await screen(10, writes, 5)
    expect(term.buffer.active.length).toBeLessThanOrEqual(5)
    // A row saying more is above, the cursor's rows, a row saying more is below.
    expect(rows).toEqual(['…', 'x'.repeat(10), 'x'.repeat(10), '…'])
    expect(cursor).toEqual([1, 2])
    // Left at Enter, the whole line is written, once.
    const left = await screen(
      10,
      [
        ...writes,
        leaveLine(typing(10, '> ', [[long.slice(0, 40), long.slice(40)]], 5).state, '> ', long, 10),
      ],
      50,
    )
    expect(left.rows.join('').includes(`> ${long}`)).toBe(true)
  })

  // User report 2026-10-12 ("terminale direk yapıştıramıyorum"): code of many lines is typed and pasted
  // in the terminal now, each line after the first after mongosh's "... ".
  it('opens each line after the first with the continuation', async () => {
    const options = { continuation: '... ' }
    const end = drawLine(START, '> ', 'line1\r\nline2', '', 20, Infinity, undefined, options)
    const { rows, cursor } = await screen(20, [end.out])
    expect(rows).toEqual(['> line1', '... line2'])
    expect(cursor).toEqual([1, 9])
    expect(end.state).toEqual({ cursorRow: 1, lastRow: 1 })
    const inside = drawLine(end.state, '> ', 'li', 'ne1\r\nline2', 20, Infinity, undefined, options)
    const moved = await screen(20, [end.out, inside.out])
    expect(moved.rows).toEqual(['> line1', '... line2'])
    expect(moved.cursor).toEqual([0, 4])
    // Left, it is written whole with its continuations.
    const left = await screen(20, [
      end.out,
      leaveLine(end.state, '> ', 'line1\r\nline2', 20, '', undefined, options),
    ])
    expect(left.rows).toEqual(['> line1', '... line2'])
  })

  it('shows lines of a paste taller than the screen around the cursor, saying how many are left out', async () => {
    const options = {
      continuation: '... ',
      more: (n: number, above: boolean) => `${above ? '↑' : '↓'} ${n} more`,
    }
    const lines = Array.from({ length: 30 }, (_, i) => `l${i}`)
    const text = lines.join('\r\n')
    const atEnd = drawLine(START, '> ', text, '', 20, 10, undefined, options)
    const first = await screen(20, [atEnd.out], 10)
    expect(first.rows).toEqual(['↑ 23 more', ...lines.slice(23).map((l) => `... ${l}`)])
    expect(first.cursor).toEqual([7, 7])
    // Up to the first line: the rows from the top, the rest said below.
    const atStart = drawLine(atEnd.state, '> ', '', text, 20, 10, undefined, options)
    const second = await screen(20, [atEnd.out, atStart.out], 10)
    expect(second.rows).toEqual(['> l0', ...lines.slice(1, 7).map((l) => `... ${l}`), '↓ 23 more'])
    expect(second.cursor).toEqual([0, 2])
    expect(second.term.buffer.active.length).toBe(10)
    // Down a line, among the rows shown: they stay where they are.
    const down = drawLine(
      atStart.state,
      '> ',
      lines.slice(0, 3).join('\r\n'),
      `\r\n${lines.slice(3).join('\r\n')}`,
      20,
      10,
      undefined,
      options,
    )
    const third = await screen(20, [atEnd.out, atStart.out, down.out], 10)
    expect(third.rows).toEqual(second.rows)
    expect(third.cursor).toEqual([2, 6])
  })

  it('puts the cursor on a new row of a tall line that fills its last row exactly', async () => {
    const { out } = drawLine(START, '> ', 'x'.repeat(78), '', 10, 5)
    const { rows, cursor } = await screen(10, [out], 5)
    expect(rows).toEqual(['…', 'x'.repeat(10), ' '])
    expect(cursor).toEqual([2, 0])
  })

  // Review 2026-10-12 (minor 16): with two rows to draw in, nothing said lines were left out.
  it('says what is left out in one row on a terminal of three rows', async () => {
    const options = { more: (n: number, above: boolean) => `${above ? '↑' : '↓'}${n}` }
    const lines = Array.from({ length: 6 }, (_, i) => `l${i}`)
    const middle = drawLine(
      START,
      '> ',
      lines.slice(0, 3).join('\r\n'),
      `\r\n${lines.slice(3).join('\r\n')}`,
      20,
      3,
      undefined,
      options,
    )
    const { rows, cursor } = await screen(20, [middle.out], 3)
    expect(rows).toEqual(['↑2  ↓3', 'l2'])
    expect(cursor).toEqual([1, 2])
  })

  // Review 2026-10-12 (minor 17): after a resize the rows shown jumped to the line's end.
  it('keeps showing the same rows of a tall line after a resize', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `l${i}`)
    const atEnd = drawLine(START, '> ', lines.join('\r\n'), '', 20, 10)
    expect(atEnd.state.top).toBe(23)
    // Up to line 25, still among the rows shown: they stay.
    const before = lines.slice(0, 26).join('\r\n')
    const after = `\r\n${lines.slice(26).join('\r\n')}`
    const up = drawLine(atEnd.state, '> ', before, after, 20, 10)
    expect(up.state.top).toBe(23)
    const resized = lineAfterResize(up.state.cursorRow, '> ', before, after, 30, 10, {}, up.state.top)
    expect(resized.top).toBe(23)
    // Without them, the rows shown would end at the cursor's.
    expect(lineAfterResize(up.state.cursorRow, '> ', before, after, 30, 10).top).toBe(19)
  })

  it('cuts the row saying what is left out to the width, never wrapping it', async () => {
    const options = { more: () => 'a very long marker text here' }
    const { out } = drawLine(START, '> ', 'x'.repeat(82), '', 10, 5, undefined, options)
    const { rows } = await screen(10, [out], 5)
    expect(rows).toEqual(['a very lo', 'x'.repeat(10), 'x'.repeat(4)])
  })
  it('gives each character the cells the terminal gives it', async () => {
    const samples = [
      'a',
      'é',
      '\u0301',
      '漢',
      '한',
      'Ａ',
      '\u3000',
      '\u303f',
      '\u200d',
      '\ufeff',
      '🙂',
      '𠀀',
      '\u2026',
      'ß',
    ]
    for (const ch of samples) {
      const { term } = await screen(20, ['x', ch])
      expect([ch, cellWidth(ch.codePointAt(0)!)]).toEqual([ch, term.buffer.active.cursorX - 1])
    }
  })

  // Review 2026-10-12 (M12): after a resize the terminal reflows the line; where its cursor is, is
  // read from the terminal (the line's first row is kept by a marker), never guessed.
  it('draws the line again where it is after a resize, the cursor read from the terminal', async () => {
    for (const [from, to] of [
      [8, 12],
      [12, 8],
      [10, 5],
    ] as const) {
      const { writes, state } = typing(from, '> ', [['abcdefghij', '']])
      const { term } = await screen(from, writes)
      const start = term.registerMarker(-state.cursorRow)!
      term.resize(to, 12)
      const buffer = term.buffer.active
      const after = lineAfterResize(buffer.baseY + buffer.cursorY - start.line, '> ', 'abcdefghij', '', to)
      expect(after.cursorRow).toBe(buffer.baseY + buffer.cursorY - start.line)
      const redrawn = drawLine(after, '> ', 'abcdefghijk', '', to)
      await new Promise<void>((resolve) => term.write(redrawn.out, resolve))
      const rows: string[] = []
      for (let i = 0; i < buffer.length; i++) rows.push(buffer.getLine(i)!.translateToString(true))
      expect([from, to, rows.filter((r) => r.trim()).join('|')]).toEqual([
        from,
        to,
        to === 12 ? '> abcdefghij|k' : to === 8 ? '> abcdef|ghijk' : '> abc|defgh|ijk',
      ])
    }
  })

  // Review 2026-10-12 (M2): a colour with no end hung the tab.
  it('never hangs on a colour without its end, counting such a byte as a character', () => {
    const broken = () => `${ESC}[32abc`
    const { out } = drawLine({ cursorRow: 0, lastRow: 0 }, '> ', 'ab', 'c', 40, 10, broken)
    expect(out).toContain('abc')
  })

  // Review 2026-10-12 (M6): a line too tall for the screen, shown from inside a string, keeps the
  // string's colour on what is shown of it.
  it('colours the part of a tall line shown as the whole line is coloured', () => {
    const colour = (t: string) => t.replace(/"[^"]*"?/g, (m) => `${ESC}[32m${m}${ESC}[39m`)
    const text = `"${'x'.repeat(200)}"`
    const { out } = drawLine(
      { cursorRow: 0, lastRow: 0 },
      '> ',
      text.slice(0, 150),
      text.slice(150),
      10,
      5,
      colour,
    )
    // After the row saying more is above, the string's colour.
    expect(out).toMatch(new RegExp(`\\r\\n${ESC}\\[32mx`))
  })

  it('keeps "..." out of a colour open across a newline, and the colour on after it', () => {
    const colour = (t: string) => t.replace(/`[^`]*`/g, (m) => `${ESC}[32m${m}${ESC}[39m`)
    const { out } = drawLine(START, '> ', '`a\r\nb`', '', 20, Infinity, colour, { continuation: '... ' })
    expect(out).toContain(`\`a${ESC}[39m\r\n... ${ESC}[32mb\``)
  })
})
