import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { AppError } from '../src/errors'
import { InflateBudget, ZipReader } from '../src/transfer/formats/zip'
import { XlsxWriter, excelDate, isDateFormat, isOleFile, xlsxTable } from '../src/transfer/formats/xlsx'
import { isFailure } from '../src/transfer/formats/types'
import { rawZip } from './support/hostile'
import { fuzz } from './support/fuzz'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mm-xlsx-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const W = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
function book(parts: Record<string, string>, opts: { sheets?: string[]; date1904?: boolean } = {}): Buffer {
  const sheets = opts.sheets ?? ['Data']
  const base: Record<string, string> = {
    '[Content_Types].xml': '<Types/>',
    'xl/workbook.xml': `<workbook xmlns="${W}" xmlns:r="${R}"><workbookPr${opts.date1904 ? ' date1904="1"' : ''}/><sheets>${sheets
      .map((s, i) => `<sheet name="${s}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships>${sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join(
        '',
      )}<Relationship Id="rS" Type="${R}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rT" Type="${R}/styles" Target="/xl/styles.xml"/></Relationships>`,
    'xl/sharedStrings.xml': `<sst xmlns="${W}"><si><t>name</t></si><si><t>when</t></si><si><r><t>Al</t></r><r><t>i</t></r><rPh><t>x</t></rPh></si></sst>`,
    'xl/styles.xml': `<styleSheet xmlns="${W}"><numFmts><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><cellStyleXfs><xf numFmtId="14"/></cellStyleXfs><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
    ...parts,
  }
  return rawZip(Object.entries(base).map(([name, data]) => ({ name, data: Buffer.from(data) })))
}
const SHEET = (rows: string) => `<worksheet xmlns="${W}"><sheetData>${rows}</sheetData></worksheet>`

let seq = 0
async function table(bytes: Buffer, sheet?: string, header = true) {
  const path = join(dir, `b${seq++}.xlsx`)
  writeFileSync(path, bytes)
  const handle = await open(path, 'r')
  try {
    const zip = await ZipReader.open(handle, bytes.length)
    const t = await xlsxTable(zip, sheet, header, new InflateBudget(bytes.length * 20 + 1e6))
    const rows = []
    for await (const r of t.rows)
      rows.push(isFailure(r) ? { n: r.n, error: r.error, ...(r.cells ? { cells: r.cells } : {}) } : r)
    return { header: t.header, sheets: t.sheets, rows }
  } finally {
    await handle.close()
  }
}
async function reason(p: Promise<unknown>) {
  try {
    await p
  } catch (e) {
    return e instanceof AppError ? (e.details as { reason?: string }).reason : String(e)
  }
  return 'ok'
}

describe('xlsx reading (spec §5.1)', () => {
  it('reads shared and inline strings, numbers, booleans, dates by style, cached formula values and gaps', async () => {
    const t = await table(
      book({
        'xl/worksheets/sheet1.xml': SHEET(
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
            '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>45292</v></c><c r="D2" t="b"><v>1</v></c></row>' +
            '<row r="4"><c r="A4" t="inlineStr"><is><t>Veli</t></is></c><c r="B4" s="2"><f>TODAY()</f><v>45293.5</v></c><c r="C4"><v>1.25</v></c></row>' +
            '<row r="5"><c r="A5" t="e"><v>#N/A</v></c></row>',
        ),
      }),
    )
    expect(t.header).toEqual(['name', 'when'])
    expect(t.rows).toEqual([
      { n: 2, cells: ['Ali', new Date('2024-01-01T00:00:00Z'), null, true] },
      { n: 4, cells: ['Veli', new Date('2024-01-02T12:00:00Z'), 1.25] },
      // Its cells as written, for the rejected-records file (review of the data fixes, I5).
      { n: 5, error: expect.stringContaining('#N/A'), cells: ['#N/A'] },
    ])
  })

  // Data review 2026-10-13 (low): a date written as text without an offset was read in the
  // server's own time zone, while serials are read as written (UTC); a cell showing only a time
  // became a date in 1899.
  it('reads a written date as written, and a time on its own as the time', async () => {
    // In a zone away from UTC, where reading it in the local zone shows.
    const zone = process.env.TZ
    process.env.TZ = 'Europe/Istanbul'
    try {
      const styles =
        `<styleSheet xmlns="${W}"><numFmts><numFmt numFmtId="165" formatCode="hh:mm"/>` +
        `<numFmt numFmtId="166" formatCode="[h]:mm:ss"/><numFmt numFmtId="167" formatCode="mmm yyyy"/></numFmts>` +
        `<cellXfs><xf numFmtId="0"/><xf numFmtId="165"/><xf numFmtId="166"/><xf numFmtId="21"/><xf numFmtId="167"/>` +
        `<xf numFmtId="20"/><xf numFmtId="47"/><xf numFmtId="46"/></cellXfs></styleSheet>`
      const t = await table(
        book({
          'xl/styles.xml': styles
            .replace('</numFmts>', '<numFmt numFmtId="168" formatCode="[h]:mm"/></numFmts>')
            .replace('</cellXfs>', '<xf numFmtId="168"/></cellXfs>'),
          'xl/worksheets/sheet1.xml': SHEET(
            '<row r="1"><c r="A1" t="d"><v>2026-03-29T01:30:00</v></c><c r="B1" t="d"><v>2026-03-29T01:30:00+02:00</v></c>' +
              '<c r="C1" t="d"><v>2026-03-29</v></c><c r="D1" t="d"><v>2026-03-29 01:30:00</v></c></row>' +
              '<row r="2"><c r="A2" s="1"><v>0.5</v></c><c r="B2" s="2"><v>1.25</v></c><c r="C2" s="3"><v>0.000011574</v></c>' +
              '<c r="D2" s="4"><v>45292</v></c></row>' +
              // Review of the data fixes: a date and time under a time-of-day format (I1); [h]:mm and
              // built-in 46 count past a day (I2); mmss.0 keeps a tenth of a second (M1).
              '<row r="3"><c r="A3" s="5"><v>45292.75</v></c><c r="B3" s="3"><v>45292.75</v></c>' +
              '<c r="C3" s="8"><v>1.25</v></c><c r="D3" s="7"><v>1.5</v></c><c r="E3" s="6"><v>0.0000123</v></c></row>',
          ),
        }),
        undefined,
        false,
      )
      expect(t.rows).toEqual([
        {
          n: 1,
          cells: [
            new Date('2026-03-29T01:30:00Z'),
            new Date('2026-03-28T23:30:00Z'),
            new Date('2026-03-29T00:00:00Z'),
            new Date('2026-03-29T01:30:00Z'),
          ],
        },
        { n: 2, cells: ['12:00:00', '30:00:00', '00:00:01', new Date('2024-01-01T00:00:00Z')] },
        {
          n: 3,
          cells: [
            new Date('2024-01-01T18:00:00Z'),
            new Date('2024-01-01T18:00:00Z'),
            '30:00:00',
            '36:00:00',
            '00:00:01.1',
          ],
        },
      ])
    } finally {
      if (zone === undefined) delete process.env.TZ
      else process.env.TZ = zone
    }
  })

  it('lists sheets and reads the chosen one; the 1904 date system', async () => {
    const t = await table(
      book(
        {
          'xl/worksheets/sheet1.xml': SHEET('<row r="1"><c r="A1"><v>1</v></c></row>'),
          'xl/worksheets/sheet2.xml': SHEET('<row r="1"><c r="A1" s="2"><v>0</v></c></row>'),
        },
        { sheets: ['One', 'Two'], date1904: true },
      ),
      'Two',
      false,
    )
    expect(t.sheets).toEqual(['One', 'Two'])
    expect(t.rows).toEqual([{ n: 1, cells: [new Date('1904-01-01T00:00:00Z')] }])
  })

  it('refuses macros, strict OOXML, bad shared-string indexes, external targets and paths out of the package', async () => {
    expect(
      await reason(table(book({ 'xl/vbaProject.bin': 'x', 'xl/worksheets/sheet1.xml': SHEET('') }))),
    ).toBe('xlsx_macro')
    expect(
      await reason(
        table(
          book({
            'xl/workbook.xml': '<workbook xmlns="http://purl.oclc.org/ooxml/spreadsheetml/main"/>',
            'xl/worksheets/sheet1.xml': SHEET(''),
          }),
        ),
      ),
    ).toBe('xlsx_strict')
    expect(
      await reason(
        table(book({ 'xl/worksheets/sheet1.xml': SHEET('<row r="1"><c r="A1" t="s"><v>99</v></c></row>') })),
      ),
    ).toBe('xlsx')
    expect(
      await reason(
        table(
          book({
            'xl/_rels/workbook.xml.rels': `<Relationships><Relationship Id="rId1" Type="${R}/worksheet" Target="../../etc/passwd"/></Relationships>`,
          }),
        ),
      ),
    ).toBe('xlsx')
    expect(
      await reason(
        table(
          book({
            'xl/_rels/workbook.xml.rels': `<Relationships><Relationship Id="rId1" Type="${R}/worksheet" Target="http://evil.example/x.xml" TargetMode="External"/></Relationships>`,
          }),
        ),
      ),
    ).toBe('xlsx')
    expect(await reason(table(book({ 'xl/worksheets/sheet1.xml': SHEET('') }), 'Missing'))).toBe('xlsx')
    expect(isOleFile(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe(true)
    expect(isOleFile(Buffer.from('PK'))).toBe(false)
  })

  it('detects date formats and converts serials', () => {
    expect(isDateFormat('dd/mm/yyyy')).toBe(true)
    expect(isDateFormat('h:mm:ss')).toBe(true)
    expect(isDateFormat('"Day" 0.00')).toBe(false)
    expect(isDateFormat('#,##0.00')).toBe(false)
    expect(isDateFormat('[Red]0.00')).toBe(false)
    expect(isDateFormat('0.00E+00')).toBe(false)
    expect(excelDate(1, false)).toEqual(new Date('1900-01-01T00:00:00Z'))
    expect(excelDate(61, false)).toEqual(new Date('1900-03-01T00:00:00Z'))
    expect(excelDate(60, false)).toBeNull()
    expect(excelDate(-1, false)).toBeNull()
  })

  it('survives fuzzing of a workbook', async () => {
    const base = book({
      'xl/worksheets/sheet1.xml': SHEET(
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>2</v></c></row>',
      ),
    })
    await fuzz(7101, 200, base, async (input) => {
      await table(input)
    })
  })

  it('refuses a row of more than 16 MiB of text, one shared string used many times (final review I7)', async () => {
    // Random text: it does not compress, so the test's inflate budget (20 × the file) holds it.
    const big = randomBytes(1536 * 1024).toString('base64')
    const cells = Array.from({ length: 9 }, (_, i) => `<c t="s"><v>${i === 0 ? 0 : 3}</v></c>`).join('')
    const bytes = book({
      'xl/sharedStrings.xml': `<sst xmlns="${W}"><si><t>name</t></si><si><t>a</t></si><si><t>b</t></si><si><t>${big}</t></si></sst>`,
      'xl/worksheets/sheet1.xml': SHEET(`<row r="1"><c t="s"><v>0</v></c></row><row r="2">${cells}</row>`),
    })
    expect(await reason(table(bytes, undefined, false))).toBe('record_size')
  })
})

describe('xlsx writing (spec §5.4, T13)', () => {
  it('writes values, never formulas, and reads its own output back', async () => {
    const path = join(dir, 'out.xlsx')
    const out = createWriteStream(path)
    const w = new XlsxWriter(out)
    await w.start()
    await w.row([
      { t: 'text', v: 'name' },
      { t: 'text', v: 'when' },
      { t: 'text', v: 'n' },
      { t: 'text', v: 'big' },
    ])
    await w.row([
      { t: 'text', v: '=HYPERLINK("http://evil")' },
      { t: 'date', v: new Date('2024-01-01T00:00:00Z') },
      { t: 'num', v: 1.5 },
      { t: 'digits', v: '9007199254740993' },
    ])
    await w.row([
      { t: 'text', v: 'x'.repeat(40_000) },
      { t: 'empty' },
      { t: 'bool', v: false },
      { t: 'text', v: 'a\u0001b_x0041_' },
    ])
    const done = await w.finish()
    await new Promise((r) => out.end(r))
    expect(done).toEqual({ cutCells: 1, rows: 3 })
    const bytes = readFileSync(path)
    const t = await table(bytes)
    expect(t.header).toEqual(['name', 'when', 'n', 'big'])
    expect(t.rows[0]).toEqual({
      n: 2,
      cells: ['=HYPERLINK("http://evil")', new Date('2024-01-01T00:00:00Z'), 1.5, '9007199254740993'],
    })
    expect((t.rows[1] as { cells: unknown[] }).cells).toEqual([
      'x'.repeat(32_767),
      null,
      false,
      'a\u0001b_x0041_',
    ])
  })
})
