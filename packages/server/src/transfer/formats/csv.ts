// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { Errors } from '../../errors'
import { MAX_FIELDS, MAX_RECORD_CHARS } from '../limits'
import type { Delimiter, OutCell, RecordFailure, TableRow, TableSource } from './types'

/**
 * Phase 3d-1 spec §5.1: an RFC 4180 parser fed text chunk by chunk. Quoted fields may hold
 * delimiters, "" and line breaks; rows end with LF, CRLF or CR; blank lines are skipped; a quote
 * inside an unquoted field is text. A record is bounded in characters and fields (spec §7 T5), even
 * inside a quote that never closes.
 */
export class CsvParser {
  /**
   * The field so far, as slices of the chunks it came from: appending one character at a time would
   * build a rope of millions of nodes for a long field (final review C3).
   */
  private parts: string[] = []
  private row: string[] = []
  private quoted = false
  private afterQuote = false
  private started = false
  private rowQuoted = false
  private pendingCR = false
  private chars = 0
  private n = 0
  private readonly maxChars: number
  private readonly maxFields: number

  constructor(
    private readonly delimiter: Delimiter,
    limits: { maxChars?: number; maxFields?: number } = {},
  ) {
    this.maxChars = limits.maxChars ?? MAX_RECORD_CHARS
    this.maxFields = limits.maxFields ?? MAX_FIELDS
  }

  private pushField(): void {
    this.row.push(this.parts.length === 1 ? this.parts[0]! : this.parts.join(''))
    this.parts = []
    this.started = false
    if (this.row.length > this.maxFields)
      throw Errors.badFile(`Record ${this.n + 1} has more than ${this.maxFields} fields`, {
        reason: 'fields',
        record: this.n + 1,
      })
  }

  private endRow(out: string[][]): void {
    this.pushField()
    const blank = this.row.length === 1 && this.row[0] === '' && !this.rowQuoted
    if (!blank) {
      this.n++
      out.push(this.row)
    }
    this.row = []
    this.rowQuoted = false
    this.chars = 0
  }

  feed(chunk: string): string[][] {
    const out: string[][] = []
    // Start of the run of characters that belong to the current field, not yet in `parts`.
    let run = -1
    const flush = (at: number) => {
      if (run >= 0) {
        this.parts.push(chunk.slice(run, at))
        run = -1
      }
    }
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i]!
      if (this.pendingCR) {
        this.pendingCR = false
        if (c === '\n') continue
      }
      if (++this.chars > this.maxChars)
        throw Errors.badFile(`Record ${this.n + 1} is larger than the limit`, {
          reason: 'record_size',
          record: this.n + 1,
        })
      if (this.quoted) {
        if (this.afterQuote) {
          this.afterQuote = false
          if (c === '"') {
            this.parts.push('"')
            continue
          }
          this.quoted = false
        } else {
          if (c === '"') {
            flush(i)
            this.afterQuote = true
          } else if (run < 0) run = i
          continue
        }
      }
      if (c === this.delimiter) {
        flush(i)
        this.pushField()
      } else if (c === '\n' || c === '\r') {
        flush(i)
        if (c === '\r') this.pendingCR = true
        this.endRow(out)
      } else if (c === '"' && run < 0 && this.parts.length === 0 && !this.started) {
        this.quoted = true
        this.started = true
        this.rowQuoted = true
      } else if (run < 0) run = i
    }
    flush(chunk.length)
    return out
  }

  end(): string[][] {
    if (this.quoted && !this.afterQuote)
      throw Errors.badFile(`Record ${this.n + 1} has a quote that is never closed`, {
        reason: 'unclosed_quote',
        record: this.n + 1,
      })
    const out: string[][] = []
    if (this.parts.length > 0 || this.row.length > 0 || this.started) this.endRow(out)
    return out
  }
}

export async function* csvRows(
  text: AsyncIterable<string>,
  delimiter: Delimiter,
  limits?: { maxChars?: number; maxFields?: number },
): AsyncGenerator<{ n: number; cells: string[] }> {
  const parser = new CsvParser(delimiter, limits)
  let n = 0
  for await (const chunk of text) for (const cells of parser.feed(chunk)) yield { n: ++n, cells }
  for (const cells of parser.end()) yield { n: ++n, cells }
}

const CANDIDATES: readonly Delimiter[] = [',', ';', '\t', '|']

/**
 * The delimiter whose rows (of the first 20 complete ones) most often share one width above 1; ties go
 * to the order of CANDIDATES. Parsing, not counting characters, keeps quoted text out of the count.
 */
export function sniffDelimiter(sample: string): Delimiter {
  const end = Math.max(sample.lastIndexOf('\n'), sample.lastIndexOf('\r'))
  const complete = end > 0 ? sample.slice(0, end + 1) : sample
  let best: Delimiter = ','
  let bestScore = 0
  for (const d of CANDIDATES) {
    let widths: number[]
    try {
      widths = new CsvParser(d)
        .feed(complete)
        .slice(0, 20)
        .map((r) => r.length)
    } catch {
      continue
    }
    const counts = new Map<number, number>()
    for (const w of widths) counts.set(w, (counts.get(w) ?? 0) + 1)
    let mode = 0
    let times = 0
    for (const [w, n] of counts)
      if (n > times || (n === times && w > mode)) {
        mode = w
        times = n
      }
    const score = mode > 1 ? times * 1000 + mode : 0
    if (score > bestScore) {
      best = d
      bestScore = score
    }
  }
  return best
}

/** Generated names for a file without a header row: field1, field2, … */
const generated = (i: number) => `field${i + 1}`

export function columnIndex(source: Pick<TableSource, 'header' | 'hasHeader'>, name: string): number {
  const at = source.header.indexOf(name)
  if (at >= 0) return at
  if (source.hasHeader) return -1
  const m = /^field([1-9]\d{0,4})$/.exec(name)
  return m ? Number(m[1]) - 1 : -1
}

/** A table over CSV text: the header row (when asked) names the fields; duplicates are refused. */
export async function csvTable(
  text: AsyncIterable<string>,
  dialect: { delimiter: Delimiter; header: boolean },
): Promise<TableSource> {
  const it = csvRows(text, dialect.delimiter)[Symbol.asyncIterator]()
  let header: string[] = []
  if (dialect.header) {
    const first = await it.next()
    header = first.done ? [] : first.value.cells.map((h, i) => (h.trim() === '' ? generated(i) : h))
    const seen = new Set<string>()
    for (const h of header) {
      if (!h.isWellFormed())
        throw Errors.badFile('The header row is not valid text in the file encoding', { reason: 'encoding' })
      if (seen.has(h))
        throw Errors.badFile(`The header names "${h.slice(0, 100)}" twice`, { reason: 'duplicate_header' })
      seen.add(h)
    }
  }
  async function* rows(): AsyncGenerator<TableRow | RecordFailure> {
    let n = 0
    // Data review 2026-10-13 (M6): a row of another width (an unquoted comma in a field) would put
    // every value after it in the wrong field; it is refused. Without a header, the first row sets it.
    let width = dialect.header ? header.length : 0
    const fields = (k: number) => `${k} field${k === 1 ? '' : 's'}`
    for (;;) {
      const next = await it.next()
      if (next.done) return
      n++
      const cells = next.value.cells
      // A line of spaces only is no record (review of the fix, Minor 7) — where a row has more than
      // one field; in a one-column file it is an empty value.
      if (width !== 1 && cells.length === 1 && cells[0]!.trim() === '') continue
      if (!width) width = cells.length
      // Spec §7 T11: bytes that were not valid text fail this row only, never reach a document.
      if (cells.some((c) => !c.isWellFormed()))
        yield {
          n,
          error: 'The record holds bytes that are not valid text in the file encoding',
          // Data review 2026-10-13 (low): kept for the rejected-records file, the bad bytes shown as
          // U+FFFD, so the row can be found and fixed — never for a document.
          cells: cells.map((c) => c.toWellFormed()),
        }
      else if (cells.length !== width)
        yield {
          n,
          error: `The record has ${fields(cells.length)}; ${dialect.header ? 'the header has' : 'the first one has'} ${width}`,
          // Review of the data fixes (I4): kept for the rejected-records file, to be fixed there.
          cells,
        }
      else yield { n, cells }
    }
  }
  return { kind: 'table', header, hasHeader: dialect.header, rows: rows() }
}

/**
 * A cell a spreadsheet would run as a formula: one starting, after any spaces, with =, +, -, @, a tab
 * or a line break (spreadsheets skip the spaces). Security audit 2026-10-16 (minor): one guard for
 * the exports and the audit log's CSV, which had the spaces and the line feed this one missed.
 */
const FORMULA_START = /^\p{Zs}*[=+\-@\t\r\n]/u
export const startsLikeFormula = (text: string): boolean => FORMULA_START.test(text)

/** One CSV field: numbers and Long/Decimal digits as they are; text formula-guarded and quoted. */
export function csvField(cell: OutCell, delimiter: Delimiter, formulaGuard = true): string {
  let text: string
  let guard = false
  switch (cell.t) {
    case 'empty':
      return ''
    case 'num':
      text = String(cell.v)
      break
    case 'digits':
      text = cell.v
      break
    case 'bool':
      text = cell.v ? 'true' : 'false'
      break
    case 'date':
      text = Number.isNaN(cell.v.getTime()) ? '' : cell.v.toISOString()
      break
    case 'text':
      text = cell.v
      guard = true
      break
  }
  if (guard && formulaGuard && FORMULA_START.test(text)) text = `'${text}`
  const needs = text.includes(delimiter) || /["\r\n]/.test(text) || /^\s|\s$/.test(text)
  return needs ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * One CSV line. The formula guard is on for exports (spec §7 T13); the rejected-records file turns it
 * off, so the person gets back the very text they sent (final review M7).
 */
export function csvLine(
  cells: OutCell[],
  delimiter: Delimiter,
  eol: '\n' | '\r\n',
  opts: { guard?: boolean } = {},
): string {
  return `${cells.map((c) => csvField(c, delimiter, opts.guard ?? true)).join(delimiter)}${eol}`
}
