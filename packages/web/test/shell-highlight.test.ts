import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { highlight } from '../src/shell/highlight'
import { drawLine, leaveLine } from '../src/shell/lineRender'
import { writeSafe } from '../src/shell/writeSafe'

const ESC = String.fromCharCode(27)
const CSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')

/** Each token as the terminal shows it: its text and its palette colour (-1: the default). */
async function colours(text: string, cols = 160): Promise<Array<[string, number]>> {
  const term = new Terminal({ cols, rows: 6, allowProposedApi: true })
  await new Promise<void>((resolve) => term.write(text, resolve))
  const line = term.buffer.active.getLine(0)!
  const runs: Array<[string, number]> = []
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x)!
    const ch = cell.getChars()
    if (!ch) continue
    const colour = cell.isFgDefault() ? -1 : cell.getFgColor()
    const last = runs.at(-1)
    if (last && last[1] === colour) last[0] += ch
    else runs.push([ch, colour])
  }
  return runs.map(([t, c]) => [t.trim(), c] as [string, number]).filter(([t]) => t)
}

// User request 2026-10-12: "kodları renklendir" — the shell's code and results in colour.
describe('highlighting the shell’s code', () => {
  it('colours keywords, strings, numbers, literals, builtins, calls, operators and comments', async () => {
    const runs = await colours(
      highlight(`const n = db.orders.countDocuments({ status: "paid", total: { $gt: 10 } }) // count`),
    )
    expect(runs).toEqual([
      ['const', 5],
      ['n =', -1],
      ['db', 6],
      ['.orders.', -1],
      ['countDocuments', 4],
      ['({ status:', -1],
      ['"paid"', 2],
      [', total: {', -1],
      ['$gt', 13],
      [':', -1],
      ['10', 3],
      ['} })', -1],
      ['// count', 8],
    ])
  })

  it('colours a result as mongosh does', async () => {
    const runs = await colours(
      highlight(`{ _id: ObjectId('65a1'), ok: true, n: NumberDecimal('1.5'), note: null }`),
    )
    expect(runs).toEqual([
      ['{ _id:', -1],
      ['ObjectId', 6],
      ['(', -1],
      ["'65a1'", 2],
      ['), ok:', -1],
      ['true', 3],
      [', n:', -1],
      ['NumberDecimal', 6],
      ['(', -1],
      ["'1.5'", 2],
      ['), note:', -1],
      ['null', 3],
      ['}', -1],
    ])
  })

  it('leaves the text as it was, adding only the app’s own colours', () => {
    const hostile = writeSafe(`"a${ESC}]52;c;x${String.fromCharCode(7)}" + 1`)
    const coloured = highlight(hostile)
    expect(coloured.replace(CSI, '')).toBe(hostile)
    // Every escape is one of ours: a colour, then the default again.
    for (const seq of coloured.match(new RegExp(`${ESC}[^m]*m`, 'g')) ?? [])
      expect(seq).toMatch(new RegExp(`^${ESC}\\[(3[0-9]|9[0-7])m$`))
    expect(coloured.split(ESC).length - 1).toBe((coloured.match(CSI) ?? []).length)
  })

  it('keeps a string open at the end of a line coloured, and a very long text plain', () => {
    expect(highlight('print("unfinished')).toContain(`${ESC}[32m"unfinished`)
    // A quote never closed ends with its line: what follows is code again.
    expect(highlight('"open\r\n1')).toBe(`${ESC}[32m"open${ESC}[39m\r\n${ESC}[33m1${ESC}[39m`)
    const long = 'db 1 '.repeat(64 * 1024)
    expect(highlight(long)).toBe(long)
  })

  it('never colours a name’s digits, nor a keyword or a builtin used as a property', () => {
    expect(highlight('a1 + b2')).toBe('a1 + b2')
    expect(highlight('x.delete')).toBe('x.delete')
    expect(highlight('x.db')).toBe('x.db')
    expect(highlight('x.delete()')).toBe(`x.${ESC}[34mdelete${ESC}[39m()`)
  })
})

describe('drawing a highlighted line', () => {
  it('keeps the colours on both sides of the cursor, inside a string too', async () => {
    const { out } = drawLine({ cursorRow: 0, lastRow: 0 }, '> ', 'print("ab', 'cd")', 40, 10, highlight)
    expect(await colours(out, 40)).toEqual([
      ['>', -1],
      ['print', 6],
      ['(', -1],
      ['"abcd"', 2],
      [')', -1],
    ])
    const term = new Terminal({ cols: 40, rows: 6, allowProposedApi: true })
    await new Promise<void>((resolve) => term.write(out, resolve))
    // The cursor between "ab" and "cd": 2 (prompt) + 'print("ab'.
    expect(term.buffer.active.cursorX).toBe(2 + 'print("ab'.length)
    const left = leaveLine({ cursorRow: 0, lastRow: 0 }, '> ', 'db.a', 40, '', highlight)
    expect(left).toContain(`${ESC}[36mdb`)
  })

  // Review 2026-10-12 (M3–M6): what is not code is not coloured as code.
  it('leaves a document’s keys alone, whatever they are called', () => {
    expect(highlight('{ default: true, new: 1, it: 3, Date: 2, print: "x" }')).toBe(
      `{ default: ${ESC}[33mtrue${ESC}[39m, new: ${ESC}[33m1${ESC}[39m, it: ${ESC}[33m3${ESC}[39m, Date: ${ESC}[33m2${ESC}[39m, print: ${ESC}[32m"x"${ESC}[39m }`,
    )
  })

  it('reads a name in any script as one name', () => {
    expect(highlight('eşit + işin + ğin + é1')).toBe('eşit + işin + ğin + é1')
    expect(highlight('y. in')).toBe('y. in')
  })

  it('colours a regular expression as one, never as a comment or a string', () => {
    const re = (s: string) => `${ESC}[31m${s}${ESC}[39m`
    expect(highlight('/https?:\\/\\//')).toBe(re('/https?:\\/\\//'))
    expect(highlight('{ re: /a\\/*b/, next: 1 }')).toBe(
      `{ re: ${re('/a\\/*b/')}, next: ${ESC}[33m1${ESC}[39m }`,
    )
    expect(highlight("x.find({ n: /it's/i })")).toBe(`x.${ESC}[34mfind${ESC}[39m({ n: ${re("/it's/i")} })`)
    expect(highlight('/[/]x/g')).toBe(re('/[/]x/g'))
    // A division is no regular expression.
    expect(highlight('a / b / c')).toBe('a / b / c')
  })

  it('reads a name right after a number as no word of its own', () => {
    expect(highlight('2in')).toBe(`${ESC}[33m2${ESC}[39min`)
  })

  it('keeps a template literal open across a brace in a string inside ${}', () => {
    // An opening brace in a string inside ${} never keeps the template open past its end.
    expect(highlight('`${ "{" } x` + 1')).toBe(`${ESC}[32m\`\${ "{" } x\`${ESC}[39m + ${ESC}[33m1${ESC}[39m`)
  })

  it('keeps a template literal open across a backtick inside ${}', () => {
    const coloured = highlight('`a ${ "`" } b` + 1')
    expect(coloured).toBe(`${ESC}[32m\`a \${ "\`" } b\`${ESC}[39m + ${ESC}[33m1${ESC}[39m`)
  })
})
