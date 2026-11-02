import { once } from 'node:events'
import { PassThrough, Readable, type Writable } from 'node:stream'
import { Errors } from '../../errors'
import { decodeText } from '../text'
import {
  MAX_FIELDS,
  MAX_RECORD_CHARS,
  MAX_SHARED_STRINGS,
  MAX_SHARED_TEXT,
  MAX_SHEETS,
  MAX_XML_PART,
  XLSX_MAX_CELL,
  XLSX_MAX_ROWS,
} from '../limits'
import { ZipWriter, type InflateBudget, type ZipReader } from './zip'
import { localName, unescapeOoxml, xmlEscape, xmlEvents, type XmlEvent } from './xml'
import type { Cell, OutCell, RecordFailure, TableRow, TableSource } from './types'

const bad = (what: string, reason = 'xlsx') =>
  Errors.badFile(`The workbook cannot be read: ${what}`, { reason })
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const STRICT = 'http://purl.oclc.org/ooxml/spreadsheetml/main'
const DAY = 86_400_000

/** An encrypted workbook or a legacy .xls: an OLE compound file. */
export const isOleFile = (head: Uint8Array): boolean =>
  [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((b, i) => head[i] === b)

async function* partEvents(zip: ZipReader, path: string, budget: InflateBudget): AsyncGenerator<XmlEvent> {
  yield* xmlEvents(decodeText(zip.read(path, budget)))
}

async function smallPart(zip: ZipReader, path: string, budget: InflateBudget): Promise<XmlEvent[]> {
  const bytes = await zip.readAll(path, budget, MAX_XML_PART)
  const out: XmlEvent[] = []
  for await (const e of xmlEvents(decodeText(Readable.from([bytes])))) out.push(e)
  return out
}

/** A relationship target inside the package; anything else (external, "..", a URL) is refused. */
function resolveTarget(base: string, target: string, mode: string | undefined): string {
  if (mode === 'External' || /^[a-z][a-z0-9+.-]*:/i.test(target)) throw bad('an external part')
  const segments = (target.startsWith('/') ? target.slice(1) : `${base}/${target}`).split('/')
  const out: string[] = []
  for (const s of segments) {
    if (s === '' || s === '.') continue
    if (s === '..') {
      if (!out.length) throw bad('a part outside the package')
      out.pop()
    } else out.push(s)
  }
  return out.join('/')
}

export interface Workbook {
  sheets: Array<{ name: string; path: string }>
  date1904: boolean
  sharedStrings: string | null
  styles: string | null
}

/** Spec §5.1: the workbook's sheets and parts; macro-enabled and strict OOXML workbooks are refused. */
export async function openWorkbook(zip: ZipReader, budget: InflateBudget): Promise<Workbook> {
  if (zip.has('xl/vbaProject.bin')) throw bad('macro-enabled workbooks are refused', 'xlsx_macro')
  if (!zip.has('xl/workbook.xml')) throw bad('no workbook part')
  const wb = await smallPart(zip, 'xl/workbook.xml', budget)
  const root = wb.find((e) => e.type === 'open')
  // The root's declared namespaces, matched whole (a set, never a substring of an address).
  const namespaces = new Set(root?.type === 'open' ? Object.values(root.attrs) : [])
  if (namespaces.has(STRICT))
    throw bad('Strict Open XML workbooks are not supported; save as a regular .xlsx', 'xlsx_strict')
  if (!namespaces.has(MAIN)) throw bad('not a SpreadsheetML workbook')
  const declared: Array<{ name: string; rid: string }> = []
  let date1904 = false
  for (const e of wb) {
    if (e.type !== 'open') continue
    const n = localName(e.name)
    if (n === 'workbookPr') date1904 = e.attrs.date1904 === '1' || e.attrs.date1904 === 'true'
    if (n === 'sheet') {
      const rid = Object.entries(e.attrs).find(([k]) => localName(k) === 'id')?.[1]
      if (!e.attrs.name || !rid) throw bad('a sheet without a name or relationship')
      declared.push({ name: e.attrs.name, rid })
      if (declared.length > MAX_SHEETS) throw bad('too many sheets')
    }
  }
  const rels = new Map<string, { type: string; path: string }>()
  if (zip.has('xl/_rels/workbook.xml.rels'))
    for (const e of await smallPart(zip, 'xl/_rels/workbook.xml.rels', budget))
      if (e.type === 'open' && localName(e.name) === 'Relationship' && e.attrs.Id && e.attrs.Target)
        rels.set(e.attrs.Id, {
          type: (e.attrs.Type ?? '').split('/').at(-1) ?? '',
          path: resolveTarget('xl', e.attrs.Target, e.attrs.TargetMode),
        })
  const sheets = declared.map((s) => {
    const rel = rels.get(s.rid)
    if (!rel || rel.type !== 'worksheet' || !zip.has(rel.path))
      throw bad(`the sheet "${s.name.slice(0, 50)}" has no part`)
    return { name: s.name, path: rel.path }
  })
  const find = (type: string) =>
    [...rels.values()].find((r) => r.type === type && zip.has(r.path))?.path ?? null
  return { sheets, date1904, sharedStrings: find('sharedStrings'), styles: find('styles') }
}

/** Spec §7 T6: the shared-string table, bounded in count and text; phonetic runs are skipped. */
async function sharedStrings(zip: ZipReader, path: string | null, budget: InflateBudget): Promise<string[]> {
  if (!path) return []
  const out: string[] = []
  let total = 0
  let inSi = false
  let inT = false
  let phonetic = 0
  let current = ''
  for await (const e of partEvents(zip, path, budget)) {
    if (e.type === 'open') {
      const n = localName(e.name)
      if (n === 'si') {
        inSi = true
        current = ''
      } else if (n === 'rPh') phonetic++
      else if (n === 't' && inSi && !phonetic) inT = !e.empty
    } else if (e.type === 'close') {
      const n = localName(e.name)
      if (n === 'si') {
        inSi = false
        out.push(unescapeOoxml(current))
        if (out.length > MAX_SHARED_STRINGS) throw bad('too many shared strings')
      } else if (n === 'rPh') phonetic--
      else if (n === 't') inT = false
    } else if (inT) {
      current += e.text
      total += e.text.length
      if (total > MAX_SHARED_TEXT) throw bad('too much shared text')
    }
  }
  return out
}

/**
 * The built-in formats that show a time of day only: h:mm AM/PM, h:mm:ss AM/PM, h:mm, h:mm:ss, mm:ss,
 * and the East Asian ones (review of the data fixes, M1). 46 is [h]:mm:ss, a duration; 47 is mmss.0.
 */
const BUILTIN_TIMES = new Map<number, TimeStyle>([
  [18, { kind: 'time', decimals: 0 }],
  [19, { kind: 'time', decimals: 0 }],
  [20, { kind: 'time', decimals: 0 }],
  [21, { kind: 'time', decimals: 0 }],
  [32, { kind: 'time', decimals: 0 }],
  [33, { kind: 'time', decimals: 0 }],
  [45, { kind: 'time', decimals: 0 }],
  [46, { kind: 'elapsed', decimals: 0 }],
  [47, { kind: 'time', decimals: 1 }],
  [55, { kind: 'time', decimals: 0 }],
  [56, { kind: 'time', decimals: 0 }],
])
const BUILTIN_DATES = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54,
  55, 56, 57, 58,
])

/** A format's letters outside quotes, escapes and [..] sections (one pass, never backtracking). */
function bareFormat(code: string): string {
  let bare = ''
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!
    if (c === '"' || c === '[') {
      const end = code.indexOf(c === '"' ? '"' : ']', i + 1)
      i = end < 0 ? code.length : end
    } else if (c === '\\') i++
    else bare += c
  }
  return bare.replace(/General/gi, '').replace(/E[+-]/gi, '')
}

/** A number format shows a date or time when, outside quotes, escapes and [..], it has y, m, d, h or s. */
export function isDateFormat(code: string): boolean {
  // Excel's own limit; a longer code is not a format a person wrote (final review C2).
  if (code.length > 255) return false
  return /[ydhsm]/i.test(bareFormat(code))
}

/**
 * Data review 2026-10-13 (low): a format with hours or seconds and no year or day shows a time of
 * day (or a duration, [h]:mm) — never a date. "mmm" alone is a month.
 */
export function isTimeFormat(code: string): boolean {
  if (!isDateFormat(code) && !isElapsedFormat(code)) return false
  const bare = bareFormat(code)
  return isElapsedFormat(code) || (!/[yd]/i.test(bare) && /[hs]/i.test(bare))
}

/** [h]:mm, [mm]:ss, [s]: a duration, counted past a day (review of the data fixes, I2). */
export function isElapsedFormat(code: string): boolean {
  return code.length <= 255 && /\[(?:h+|m+|s+)\]/i.test(code)
}

/** How many digits of a second a time format shows (ss.00: 2). */
const decimalsOf = (code: string) => /s+\.(0+)/i.exec(bareFormat(code))?.[1]?.length ?? 0

/** A time of day (a value under a day; a date and time past it), or a duration (elapsed). */
type TimeStyle = { kind: 'time' | 'elapsed'; decimals: number }
type StyleKind = { kind: 'date' } | TimeStyle | null

/** Per cell style (cellXfs index): whether it shows a date, a time on its own, or neither. */
async function dateStyles(zip: ZipReader, path: string | null, budget: InflateBudget): Promise<StyleKind[]> {
  if (!path) return []
  const custom = new Map<number, string>()
  const xfs: StyleKind[] = []
  let inCellXfs = false
  for (const e of await smallPart(zip, path, budget)) {
    if (e.type === 'open') {
      const n = localName(e.name)
      if (n === 'numFmt') custom.set(Number(e.attrs.numFmtId), e.attrs.formatCode ?? '')
      else if (n === 'cellXfs') inCellXfs = true
      else if (n === 'xf' && inCellXfs) {
        const id = Number(e.attrs.numFmtId ?? 0)
        const code = custom.get(id)
        let kind: StyleKind = null
        if (code !== undefined)
          kind = isElapsedFormat(code)
            ? { kind: 'elapsed', decimals: decimalsOf(code) }
            : isTimeFormat(code)
              ? { kind: 'time', decimals: decimalsOf(code) }
              : isDateFormat(code)
                ? { kind: 'date' }
                : null
        else if (BUILTIN_TIMES.has(id)) kind = BUILTIN_TIMES.get(id)!
        else if (BUILTIN_DATES.has(id)) kind = { kind: 'date' }
        xfs.push(kind)
      }
    } else if (e.type === 'close' && localName(e.name) === 'cellXfs') inCellXfs = false
  }
  return xfs
}

/**
 * A time shown on its own, as "HH:MM:SS" text: a fraction of a day, or more for a duration ([h]:mm
 * shows 30:00:00 for a day and a quarter). Null for what is not a time.
 */
export function excelTime(serial: number, decimals = 0): string | null {
  if (!Number.isFinite(serial) || serial < 0 || serial > 1_000_000) return null
  const scale = 10 ** Math.min(decimals, 3)
  const total = Math.round(serial * 86_400 * scale)
  const seconds = Math.floor(total / scale)
  const two = (n: number) => String(n).padStart(2, '0')
  const part = decimals ? `.${String(total % scale).padStart(Math.min(decimals, 3), '0')}` : ''
  return `${two(Math.floor(seconds / 3600))}:${two(Math.floor(seconds / 60) % 60)}:${two(seconds % 60)}${part}`
}

/** Spec §5.1: Excel serials in the 1900 system (with its phantom 29 Feb 1900) and the 1904 system. */
export function excelDate(serial: number, date1904: boolean): Date | null {
  if (!Number.isFinite(serial) || serial < 0) return null
  if (date1904) return new Date(Date.UTC(1904, 0, 1) + Math.round(serial * DAY))
  if (serial >= 60 && serial < 61) return null
  if (serial < 60) return new Date(Date.UTC(1899, 11, 31) + Math.round(serial * DAY))
  return new Date(Date.UTC(1899, 11, 30) + Math.round(serial * DAY))
}

function column(ref: string): number {
  const m = /^([A-Z]{1,3})\d+$/.exec(ref)
  if (!m) throw bad('a malformed cell reference')
  let n = 0
  for (const c of m[1]!) n = n * 26 + (c.charCodeAt(0) - 64)
  if (n - 1 >= MAX_FIELDS) throw bad('a row with more than 10 000 columns')
  return n - 1
}

/** One sheet as a table (spec §5.1): the header row names the fields when asked. */
export async function xlsxTable(
  zip: ZipReader,
  sheet: string | undefined,
  header: boolean,
  budget: InflateBudget,
): Promise<TableSource & { sheets: string[]; sheet: string }> {
  const wb = await openWorkbook(zip, budget)
  if (!wb.sheets.length) throw bad('the workbook has no sheets')
  const chosen = sheet === undefined ? wb.sheets[0]! : wb.sheets.find((s) => s.name === sheet)
  if (!chosen) throw bad(`there is no sheet "${(sheet ?? '').slice(0, 50)}"`)
  const shared = await sharedStrings(zip, wb.sharedStrings, budget)
  const dates = await dateStyles(zip, wb.styles, budget)

  async function* rows(): AsyncGenerator<TableRow | RecordFailure> {
    let rowNo = 0
    let cells: Cell[] = []
    // Review of the data fixes (I5): each cell's text as written, for the rejected-records file.
    let written: Cell[] = []
    let failure: string | null = null
    let inRow = false
    let col = -1
    let type = 'n'
    let style = 0
    let value = ''
    let inV = false
    let inIs = false
    let inT = false
    // Characters in the row: one shared string may be used in every cell (final review I7).
    let chars = 0
    for await (const e of partEvents(zip, chosen!.path, budget)) {
      if (e.type === 'open') {
        const n = localName(e.name)
        if (n === 'row') {
          const r = e.attrs.r ? Number(e.attrs.r) : rowNo + 1
          if (!Number.isInteger(r) || r <= rowNo || r > XLSX_MAX_ROWS) throw bad('rows out of order')
          rowNo = r
          cells = []
          written = []
          failure = null
          col = -1
          chars = 0
          inRow = true
        } else if (n === 'c' && inRow) {
          const at = e.attrs.r ? column(e.attrs.r) : col + 1
          if (at < cells.length || at >= MAX_FIELDS) throw bad('cells out of order')
          col = at
          type = e.attrs.t ?? 'n'
          style = Number(e.attrs.s ?? 0)
          value = ''
          if (e.empty) {
            cells.push(...new Array<Cell>(col - cells.length + 1).fill(null))
            while (written.length < cells.length) written.push(null)
          }
        } else if (n === 'v') inV = !e.empty
        else if (n === 'is') inIs = true
        else if (n === 't' && inIs) inT = !e.empty
      } else if (e.type === 'text') {
        if (inV || inT) {
          value += e.text
          if (value.length > XLSX_MAX_CELL * 2) throw bad('a cell value is too long')
        }
      } else {
        const n = localName(e.name)
        if (n === 'v') inV = false
        else if (n === 't') inT = false
        else if (n === 'is') inIs = false
        else if (n === 'c' && inRow && cells.length <= col) {
          while (cells.length < col) cells.push(null)
          let cell: Cell = null
          const where = `the cell in column ${col + 1}`
          if (type === 's') {
            const i = Number(value)
            if (!Number.isInteger(i) || i < 0 || i >= shared.length)
              throw bad('a shared string index out of range')
            cell = shared[i]!
          } else if (type === 'b') cell = value === '1' || value === 'true'
          else if (type === 'e') failure ??= `${where} holds the error ${value.slice(0, 20)}`
          else if (type === 'str' || type === 'inlineStr') cell = unescapeOoxml(value)
          else if (type === 'd') {
            // Written without an offset, a date and time is read as written — as serials are (UTC),
            // never in the server's own zone (data review 2026-10-13).
            // A space between date and time too (review of the data fixes, M2).
            const iso = value.replace(/^(\d{4}-\d{2}-\d{2}) (?=\d{2}:\d{2})/, '$1T')
            const local = /T\d{2}:\d{2}/.test(iso) && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso)
            const d = new Date(local ? `${iso}Z` : iso)
            if (Number.isNaN(d.getTime())) failure ??= `${where} holds an invalid date`
            else cell = d
          } else if (value !== '') {
            const num = Number(value)
            if (!Number.isFinite(num)) failure ??= `${where} holds an invalid number`
            else {
              const shown = dates[style]
              // A time of day under a day; past it, the cell holds a date and time — read as one, never
              // as thousands of hours (review of the data fixes, I1). A duration is counted on.
              if (shown && shown.kind !== 'date' && (shown.kind === 'elapsed' || num < 1)) {
                const t = excelTime(num, shown.decimals)
                if (t === null) failure ??= `${where} holds an invalid time`
                else cell = t
              } else if (shown) {
                const d = excelDate(num, wb.date1904)
                if (!d) failure ??= `${where} holds an invalid date`
                else cell = d
              } else cell = num
            }
          }
          chars += typeof cell === 'string' ? cell.length : 24
          if (chars > MAX_RECORD_CHARS)
            throw Errors.badFile(`Record ${rowNo} is larger than the limit`, {
              reason: 'record_size',
              record: rowNo,
            })
          cells.push(cell)
          while (written.length < col) written.push(null)
          written.push(
            type === 's' || type === 'str' || type === 'inlineStr' ? cell : value === '' ? null : value,
          )
        } else if (n === 'row' && inRow) {
          inRow = false
          if (failure) yield { n: rowNo, error: failure, cells: written }
          else if (cells.some((c) => c !== null)) yield { n: rowNo, cells }
        }
      }
    }
  }

  const it = rows()[Symbol.asyncIterator]()
  let names: string[] = []
  if (header) {
    const first = await it.next()
    if (!first.done) {
      if ('error' in first.value) throw bad(`the header row: ${first.value.error}`)
      names = first.value.cells.map((c, i) =>
        c === null || String(c).trim() === ''
          ? `field${i + 1}`
          : c instanceof Date
            ? c.toISOString()
            : String(c),
      )
      if (new Set(names).size !== names.length)
        throw Errors.badFile('The header names a field twice', { reason: 'duplicate_header' })
    }
  }
  async function* rest(): AsyncGenerator<TableRow | RecordFailure> {
    for (;;) {
      const next = await it.next()
      if (next.done) return
      yield next.value
    }
  }
  return {
    kind: 'table',
    header: names,
    hasHeader: header,
    rows: rest(),
    sheets: wb.sheets.map((s) => s.name),
    sheet: chosen.name,
  }
}

const colName = (i: number): string => {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const STATIC: Record<string, string> = {
  '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
  '_rels/.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  'xl/workbook.xml': `${XML}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="Export" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
  'xl/styles.xml': `${XML}<styleSheet xmlns="${MAIN}"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
}

const inline = (ref: string, text: string) =>
  `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`

/** Spec §5.4: one sheet, values only (never formulas); long cells cut and counted. */
export class XlsxWriter {
  private readonly zip: ZipWriter
  private readonly sheet = new PassThrough()
  private adding?: Promise<void>
  private rows = 0
  private cutCells = 0

  constructor(out: Writable) {
    this.zip = new ZipWriter(out)
  }

  async start(): Promise<void> {
    for (const [name, xml] of Object.entries(STATIC)) await this.zip.add(name, xml)
    this.adding = this.zip.add('xl/worksheets/sheet1.xml', this.sheet)
    // A failure while writing the sheet stops the writer's own writes too (the drain wait rejects).
    this.adding.catch((e: unknown) => this.sheet.destroy(e as Error))
    await this.put(`${XML}<worksheet xmlns="${MAIN}"><sheetData>`)
  }

  private async put(text: string): Promise<void> {
    if (!this.sheet.write(text)) await once(this.sheet, 'drain')
  }

  async row(cells: OutCell[]): Promise<void> {
    const r = ++this.rows
    let xml = `<row r="${r}">`
    cells.forEach((cell, i) => {
      const ref = `${colName(i)}${r}`
      switch (cell.t) {
        case 'empty':
          return
        case 'num':
          xml += Number.isFinite(cell.v) ? `<c r="${ref}"><v>${cell.v}</v></c>` : inline(ref, String(cell.v))
          return
        case 'bool':
          xml += `<c r="${ref}" t="b"><v>${cell.v ? 1 : 0}</v></c>`
          return
        case 'date': {
          const serial = (cell.v.getTime() - Date.UTC(1899, 11, 30)) / DAY
          xml +=
            serial >= 61 && Number.isFinite(serial)
              ? `<c r="${ref}" s="1"><v>${serial}</v></c>`
              : inline(ref, Number.isNaN(cell.v.getTime()) ? '' : cell.v.toISOString())
          return
        }
        default: {
          let text = cell.v
          if (text.length > XLSX_MAX_CELL) {
            text = text.slice(0, XLSX_MAX_CELL)
            this.cutCells++
          }
          xml += inline(ref, text)
        }
      }
    })
    await this.put(`${xml}</row>`)
  }

  async finish(): Promise<{ cutCells: number; rows: number }> {
    await this.put('</sheetData></worksheet>')
    this.sheet.end()
    await this.adding
    await this.zip.finish()
    return { cutCells: this.cutCells, rows: this.rows }
  }
}
