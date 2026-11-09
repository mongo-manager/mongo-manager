// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { AppError } from '../src/errors'
import {
  CsvParser,
  columnIndex,
  csvLine,
  csvRows,
  csvField,
  csvTable,
  sniffDelimiter,
  startsLikeFormula,
} from '../src/transfer/formats/csv'
import { csvCell } from '../src/routes/audit'
import { fuzz } from './support/fuzz'

const chunks = (...parts: string[]) => Readable.from(parts)
async function rows(text: string | string[], delimiter: ',' | ';' = ',') {
  const out: string[][] = []
  for await (const r of csvRows(chunks(...(Array.isArray(text) ? text : [text])), delimiter))
    out.push(r.cells)
  return out
}
async function reason(p: Promise<unknown>) {
  try {
    await p
  } catch (e) {
    return e instanceof AppError ? (e.details as { reason?: string }).reason : String(e)
  }
  return 'ok'
}

describe('CSV reading (spec §5.1)', () => {
  it('reads RFC 4180: quotes, doubled quotes, delimiters and line breaks inside quotes', async () => {
    expect(await rows('a,b\r\n"x, y","say ""hi"""\n"multi\nline",2\r3,4')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['multi\nline', '2'],
      ['3', '4'],
    ])
  })

  it('handles chunk boundaries anywhere, including inside "" and CRLF', async () => {
    const text = 'a,"b""c"\r\n1,2\r\n'
    for (let cut = 1; cut < text.length; cut++)
      expect(await rows([text.slice(0, cut), text.slice(cut)])).toEqual([
        ['a', 'b"c'],
        ['1', '2'],
      ])
  })

  it('skips blank lines but keeps an empty quoted field', async () => {
    expect(await rows('a\n\n""\n')).toEqual([['a'], ['']])
  })

  it('reads a quote inside an unquoted field as text', async () => {
    expect(await rows('5" pipe,x\n')).toEqual([['5" pipe', 'x']])
  })

  it('refuses an unclosed quote, too many fields and an oversized record (T5)', async () => {
    expect(await reason(rows('a,"b\n'))).toBe('unclosed_quote')
    const p = new CsvParser(',', { maxFields: 3 })
    expect(() => p.feed('1,2,3,4\n')).toThrow(AppError)
    const q = new CsvParser(',', { maxChars: 10 })
    expect(() => q.feed('"' + 'x'.repeat(20))).toThrow(AppError)
  })

  it('sniffs the delimiter, Turkish Excel style included (Review Focus 1)', () => {
    expect(sniffDelimiter('ad;tutar;tarih\nAli;1,5;01.02.2024\nVeli;2,75;03.04.2024\n')).toBe(';')
    expect(sniffDelimiter('a,b,c\n1,2,3\n')).toBe(',')
    expect(sniffDelimiter('a\tb\n1\t2\n')).toBe('\t')
    expect(sniffDelimiter('a|b\n1|2\n')).toBe('|')
    expect(sniffDelimiter('single\ncolumn\n')).toBe(',')
    expect(sniffDelimiter('"a,b";c\n"1,2";3\n')).toBe(';')
  })

  it('builds a table: header names, generated names, duplicate headers refused', async () => {
    const t = await csvTable(chunks('id,name\n1,Ali\n'), { delimiter: ',', header: true })
    expect(t.header).toEqual(['id', 'name'])
    const out = []
    for await (const r of t.rows) out.push(r)
    expect(out).toEqual([{ n: 1, cells: ['1', 'Ali'] }])
    const u = await csvTable(chunks('1,Ali\n'), { delimiter: ',', header: false })
    expect(columnIndex(u, 'field2')).toBe(1)
    expect(columnIndex(u, 'name')).toBe(-1)
    expect(columnIndex(t, 'field2')).toBe(-1)
    expect(await reason(csvTable(chunks('a,a\n1,2\n'), { delimiter: ',', header: true }))).toBe(
      'duplicate_header',
    )
  })

  it('refuses a row holding text that was not valid in the file encoding, and goes on (T11)', async () => {
    const t = await csvTable(chunks('a,b\nI\udfffk,1\nok,2\n'), { delimiter: ',', header: true })
    const out = []
    for await (const r of t.rows) out.push(r)
    expect(out).toEqual([
      // Its cells, made well-formed, are for the rejected-records file only (data review 2026-10-13).
      { n: 1, error: expect.stringContaining('not valid text'), cells: ['I�k', '1'] },
      { n: 2, cells: ['ok', '2'] },
    ])
    expect(await reason(csvTable(chunks('a\udfff,b\n'), { delimiter: ',', header: true }))).toBe('encoding')
  })

  // Data review 2026-10-13 (M6): a row wider or narrower than the header (an unquoted comma in a
  // field) shifted every value after it; it is a row error.
  it('refuses a row whose width is not the header’s, and goes on', async () => {
    const t = await csvTable(chunks(['a,b,c', '1,2,3', '1,2', '1,2,3,4', '7,8,9', ''].join('\n')), {
      delimiter: ',',
      header: true,
    })
    const out = []
    for await (const r of t.rows) out.push(r)
    expect(out).toEqual([
      { n: 1, cells: ['1', '2', '3'] },
      { n: 2, error: 'The record has 2 fields; the header has 3', cells: ['1', '2'] },
      { n: 3, error: 'The record has 4 fields; the header has 3', cells: ['1', '2', '3', '4'] },
      { n: 4, cells: ['7', '8', '9'] },
    ])
    const u = await csvTable(chunks(['1,2', '3', '4,5', ''].join('\n')), { delimiter: ',', header: false })
    const plain = []
    for await (const r of u.rows) plain.push(r)
    expect(plain[1]).toEqual({ n: 2, error: 'The record has 1 field; the first one has 2', cells: ['3'] })
    // Review of the fix (Minor 7): a line of spaces only is no record, never a row error.
    const blank = await csvTable(chunks(['a,b', '1,2', '   ', '3,4', ''].join('\n')), {
      delimiter: ',',
      header: true,
    })
    const kept = []
    for await (const r of blank.rows) kept.push(r)
    expect(kept).toEqual([
      { n: 1, cells: ['1', '2'] },
      { n: 3, cells: ['3', '4'] },
    ])
  })

  it('survives fuzzing (spec §7)', async () => {
    const base = Buffer.from('id,name,note\n1,"Ali","a ""q"" b"\n2,Veli,"x\ny"\n')
    await fuzz(3101, 500, base, async (input) => {
      const t = await csvTable(Readable.from([input.toString('latin1')]), { delimiter: ',', header: true })
      for await (const _ of t.rows);
    })
  })
})

describe('CSV writing (spec §5.4, T13)', () => {
  it('quotes, guards formulas and keeps numbers unguarded', () => {
    expect(
      csvLine(
        [
          { t: 'text', v: '=1+1' },
          { t: 'text', v: 'a;b' },
          { t: 'num', v: -5 },
          { t: 'digits', v: '-9007199254740993' },
          { t: 'empty' },
          { t: 'bool', v: true },
          { t: 'date', v: new Date('2024-01-02T03:04:05Z') },
          { t: 'text', v: '@cmd' },
          { t: 'text', v: 'line\nbreak' },
        ],
        ';',
        '\r\n',
      ),
    ).toBe(`'=1+1;"a;b";-5;-9007199254740993;;true;2024-01-02T03:04:05.000Z;'@cmd;"line\nbreak"\r\n`)
  })

  // Security audit 2026-10-16 (minor): spreadsheets skip leading spaces before a formula; the guard
  // is the audit export's one, shared.
  it('guards a formula after leading spaces or a line break, as the audit export does', () => {
    for (const v of [' =1+1', ' =HYPERLINK("x")', '  +cmd', '\n=1', ' @x', '　-1+1'])
      expect(csvField({ t: 'text', v }, ',').replace(/^"/, '')).toMatch(/^'/)
    expect(csvField({ t: 'text', v: ' plain' }, ',')).toBe('" plain"')
    for (const v of [' =1', '\n@x', '=a', 'b']) expect(startsLikeFormula(v)).toBe(csvCell(v).startsWith(`"'`))
  })
})
