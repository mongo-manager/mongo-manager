// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { PassThrough, type Readable } from 'node:stream'
import type { Dialect, TransferFormat, TransferPreviewResponse } from '@mongo-manager/shared'
import { AppError, Errors } from '../errors'
import type { TransferFile, TransferFiles } from './files'
import { INFLATE_RATIO, PREVIEW_READ, PREVIEW_SHOWN, SNIFF_BYTES, type TransferLimits } from './limits'
import {
  decodeText,
  guessEncoding,
  isUnicode,
  looseText,
  sniffEncoding,
  validIn,
  type TextEncoding,
} from './text'
import { boundedGunzip, countBytes, isGzip } from './gzip'
import { csvTable, sniffDelimiter } from './formats/csv'
import { docSource, isUnusualKey, jsonElements } from './formats/json'
import { ndjsonLines } from './formats/ndjson'
import { InflateBudget, ZipReader } from './formats/zip'
import { isOleFile, xlsxTable } from './formats/xlsx'
import { isFailure, type Delimiter, type Source } from './formats/types'
import { asText, convert, inferType } from './infer'
import { clipRecord, clipText, define, PREVIEW_KEY } from './clip'

const encrypted = () =>
  Errors.badFile('This is an encrypted workbook or an old .xls file; save it as .xlsx without a password', {
    reason: 'xlsx_encrypted',
  })
const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04

export interface Detected {
  format: TransferFormat
  gzip: boolean
  encoding: TextEncoding
  delimiter: Delimiter
  warnings: string[]
  /** W4.1: what the bytes look like, when no encoding was chosen and they are not text in the one used. */
  suggested?: TextEncoding
}

/** The first SNIFF_BYTES of a file, inflated when it is gzip. */
async function head(path: string, size: number, gzip: boolean, limits: TransferLimits): Promise<Buffer> {
  const parts: Buffer[] = []
  let n = 0
  const raw = createReadStream(path, gzip ? {} : { start: 0, end: SNIFF_BYTES - 1 })
  const inflate = gzip ? boundedGunzip(size, limits.maxUpload * INFLATE_RATIO) : null
  // Review of the stream errors (2026-10-20): .pipe() does not pass an error on; a failed read was
  // an uncaught error, ending the server, and the inflate waited for the rest for ever.
  if (inflate) raw.on('error', (e) => inflate.destroy(e))
  const stream: Readable = inflate ? raw.pipe(inflate) : raw
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      parts.push(chunk)
      n += chunk.length
      if (n >= SNIFF_BYTES) break
    }
  } catch (e) {
    // A head is enough to detect; damage further on is the reader's to report.
    if (!(e instanceof AppError) || n === 0) throw e
  } finally {
    stream.destroy()
    raw.destroy()
  }
  return Buffer.concat(parts).subarray(0, SNIFF_BYTES)
}

const ENCODING_NAMES: Record<TextEncoding, string> = {
  utf8: 'UTF-8',
  utf16le: 'UTF-16 LE',
  utf16be: 'UTF-16 BE',
  latin1: 'Latin-1 (ISO-8859-1)',
  windows1252: 'Windows-1252 (Western)',
  windows1254: 'Windows-1254 (Turkish)',
  iso88599: 'ISO-8859-9 (Turkish)',
}

/**
 * Spec §5.1 format detection: magic bytes, then the first non-blank character, else CSV. W4.1: the
 * text is read in the chosen encoding, else the byte order mark's (UTF-8 without one); when the bytes
 * are not text in it and none was chosen, the encoding they look like is suggested, never applied.
 */
export async function detect(
  path: string,
  size: number,
  limits: TransferLimits,
  chosen?: TextEncoding,
): Promise<Detected> {
  const raw = await head(path, size, false, limits)
  const gzip = isGzip(raw)
  const bytes = gzip ? await head(path, size, true, limits) : raw
  const warnings: string[] = []
  if (isOleFile(bytes)) throw encrypted()
  if (isZip(bytes)) return { format: 'xlsx', gzip, encoding: 'utf8', delimiter: ',', warnings }
  const sniffed = sniffEncoding(bytes)
  const encoding = chosen ?? sniffed.encoding
  const body = bytes.subarray(encoding === sniffed.encoding || !isUnicode(encoding) ? sniffed.bom : 0)
  // W4 review (minors): a single-byte encoding chosen for a file that looks like UTF-8 is said.
  if (chosen && !isUnicode(chosen)) {
    if (sniffed.bom)
      warnings.push(
        `The file starts with a ${ENCODING_NAMES[sniffed.encoding]} byte order mark: it was probably saved as ${ENCODING_NAMES[sniffed.encoding]}, not ${ENCODING_NAMES[chosen]}.`,
      )
    else if (body.some((b) => b >= 0x80) && validIn('utf8', body))
      warnings.push(
        `The file is valid UTF-8 text with letters outside ASCII: it was probably saved as UTF-8, not ${ENCODING_NAMES[chosen]}.`,
      )
  }
  let suggested: TextEncoding | undefined
  const guess = chosen || sniffed.bom ? undefined : guessEncoding(bytes)
  // UTF-16 without a byte order mark is valid UTF-8 (full of NULs), so it is suggested by its look.
  if (guess === 'utf16le' || guess === 'utf16be') suggested = guess
  if (suggested || !validIn(encoding, body)) {
    if (guess && guess !== encoding) suggested = guess
    warnings.push(
      suggested
        ? `The file is not ${ENCODING_NAMES[encoding]} text; it looks like ${ENCODING_NAMES[suggested]}. Choose that encoding, or rows with other characters will be refused.`
        : `The file is not ${ENCODING_NAMES[encoding]} text; rows with other characters will be refused. Choose the encoding it was saved in.`,
    )
  }
  // The format is sniffed in the encoding the text will likely be read in.
  const text = looseText(suggested ?? encoding, suggested ? bytes : body)
  const more = suggested ? { suggested } : {}
  const trimmed = text.trimStart()
  if (trimmed.startsWith('[')) return { format: 'json', gzip, encoding, delimiter: ',', warnings, ...more }
  if (trimmed.startsWith('{')) {
    const newline = trimmed.indexOf('\n')
    const first = newline < 0 ? trimmed : trimmed.slice(0, newline)
    let complete: boolean
    try {
      JSON.parse(first)
      complete = true
    } catch {
      complete = false
    }
    const ndjson =
      complete &&
      newline >= 0 &&
      trimmed
        .slice(newline + 1)
        .trimStart()
        .startsWith('{')
    return { format: ndjson ? 'ndjson' : 'json', gzip, encoding, delimiter: ',', warnings, ...more }
  }
  return { format: 'csv', gzip, encoding, delimiter: sniffDelimiter(text), warnings, ...more }
}

export interface Opened {
  source: Source
  /** Bytes of the stored file consumed so far: the import's progress. */
  consumed(): number
  /** The stored file's size now (a gzipped workbook is inflated when opened): the progress's whole. */
  size: number
  sheets: string[]
  sheet: string | null
  dialect: TransferPreviewResponse['dialect']
  gzip: boolean
  warnings: string[]
  /** W4.1: the encoding the text looks like, when none was chosen and it is not text in the one used. */
  suggested?: TextEncoding
  close(): Promise<void>
}

/** Opens an upload as records (spec §5.1); close() releases the file and any temporary copy. */
export async function openSource(
  file: TransferFile,
  files: TransferFiles,
  opts: { format: TransferFormat; dialect: Dialect; allowUnusual: boolean },
  limits: TransferLimits,
): Promise<Opened> {
  const path = files.pathOf(file)
  const detected = await detect(path, file.size, limits, opts.dialect.encoding)
  let consumed = 0
  const cleanups: Array<() => Promise<void> | void> = []
  const close = async () => {
    for (const c of cleanups.splice(0).reverse()) await c()
  }
  const header = opts.dialect.header ?? true
  try {
    if (opts.format === 'xlsx') {
      // A zip needs random access. Security audit 2026-10-16 (minor): a gzipped one is inflated once,
      // in place (bounded, counted against the owner's quota while it is written), not at every open.
      const stored = detected.gzip
        ? await files.inflateInPlace(file, () => boundedGunzip(file.size, limits.maxUpload * INFLATE_RATIO))
        : file
      const handle = await open(path, 'r')
      cleanups.push(() => handle.close())
      const zipSize = (await handle.stat()).size
      const magic = Buffer.alloc(8)
      await handle.read(magic, 0, 8, 0)
      if (isOleFile(magic)) throw encrypted()
      const zip = await ZipReader.open(handle, zipSize)
      // Security audit 2026-10-16 (minor): the parts expand at most 20 × what an upload may be, so a
      // gzipped workbook (up to 20 × its gzip already) is held to a plain workbook's bound: the two
      // ratios no longer multiply.
      const table = await xlsxTable(
        zip,
        opts.dialect.sheet,
        header,
        new InflateBudget(Math.min(zipSize, limits.maxUpload) * INFLATE_RATIO),
      )
      return {
        source: table,
        consumed: () => zip.bytesRead,
        size: zipSize,
        sheets: table.sheets,
        sheet: table.sheet,
        dialect: { delimiter: ',', header, sheet: table.sheet, encoding: 'utf8' },
        gzip: stored.gzip || detected.gzip,
        warnings: detected.warnings,
        close,
      }
    }
    // pipeline, not pipe: an error anywhere (a file gone, damaged gzip) reaches the reader at the end.
    const bytes = new PassThrough()
    pipeline([
      createReadStream(path),
      countBytes((n) => (consumed += n)),
      ...(detected.gzip ? [boundedGunzip(file.size, limits.maxUpload * INFLATE_RATIO)] : []),
      bytes,
    ]).catch(() => undefined)
    cleanups.push(() => void bytes.destroy())
    const encoding = opts.dialect.encoding ?? detected.encoding
    // Lenient: a record with bytes that are not text fails alone (spec §7 T11).
    const text = decodeText(bytes, opts.dialect.encoding, { lenient: true })
    const delimiter = opts.dialect.delimiter ?? detected.delimiter
    let source: Source
    if (opts.format === 'csv') source = await csvTable(text, { delimiter, header })
    else if (opts.format === 'json')
      source = docSource(jsonElements(text), { allowUnusual: opts.allowUnusual })
    else source = docSource(ndjsonLines(text), { allowUnusual: opts.allowUnusual })
    return {
      source,
      consumed: () => consumed,
      size: file.size,
      sheets: [],
      sheet: null,
      dialect: { delimiter, header, sheet: null, encoding },
      gzip: detected.gzip,
      warnings: detected.warnings,
      ...(detected.suggested ? { suggested: detected.suggested } : {}),
      close,
    }
  } catch (e) {
    await close()
    throw e
  }
}

/**
 * User request 2026-10-10 (SQL dumps): an upload's bytes, gzip or not, counted and bounded when
 * inflated; the dump reader decodes them (review I5).
 */
export async function openDump(
  file: TransferFile,
  files: TransferFiles,
  limits: TransferLimits,
): Promise<{
  bytes: AsyncIterable<Buffer>
  consumed: () => number
  gzip: boolean
  close: () => Promise<void>
}> {
  const path = files.pathOf(file)
  const detected = await detect(path, file.size, limits)
  // Review M16: a workbook (or any zip) read as text would only say "no tables".
  if (detected.format === 'xlsx')
    throw Errors.validation('This is a zip or Excel file, not a SQL dump', { reason: 'not_sql' })
  let consumed = 0
  const bytes = new PassThrough()
  pipeline([
    createReadStream(path),
    countBytes((n) => (consumed += n)),
    ...(detected.gzip ? [boundedGunzip(file.size, limits.maxUpload * INFLATE_RATIO)] : []),
    bytes,
  ]).catch(() => undefined)
  return {
    // Review I5: bytes, as they are: the dump reader decodes each text itself (UTF-8, or a BLOB's
    // own bytes), and a UTF-16 dump by its byte order mark.
    bytes,
    consumed: () => consumed,
    gzip: detected.gzip,
    close: async () => void bytes.destroy(),
  }
}

/** Final review C3: a preview reads at most this many cells (the clip helpers live in clip.ts). */
const PREVIEW_CELLS = 100_000

/** Spec §4.1: the first records, suggested fields and types — the user's own bytes only. */
export async function preview(
  file: TransferFile,
  files: TransferFiles,
  req: { format?: TransferFormat; dialect: Dialect },
  limits: TransferLimits,
): Promise<TransferPreviewResponse> {
  const format =
    req.format ?? (await detect(files.pathOf(file), file.size, limits, req.dialect.encoding)).format
  const opened = await openSource(file, files, { format, dialect: req.dialect, allowUnusual: true }, limits)
  const warnings = [...opened.warnings]
  const note = (n: number, error: string) => {
    if (warnings.length < 10) warnings.push(`Record ${n}: ${error}`)
  }
  try {
    const records: Array<Record<string, unknown>> = []
    const fields: TransferPreviewResponse['fields'] = []
    if (opened.source.kind === 'table') {
      const source = opened.source
      const columns: unknown[][] = source.header.map(() => [])
      let read = 0
      let cells = 0
      for await (const r of source.rows) {
        if (isFailure(r)) {
          note(r.n, r.error)
          continue
        }
        const width = source.hasHeader ? Math.min(r.cells.length, source.header.length) : r.cells.length
        // Cut text still tells the types apart: only its first INFER_CHARS characters are looked at.
        for (let i = 0; i < width; i++) {
          const cell = r.cells[i]
          ;(columns[i] ??= new Array<unknown>(read).fill(null)).push(
            typeof cell === 'string' ? clipText(cell) : cell,
          )
        }
        // Rows shorter than the widest keep their place in every column.
        for (let i = width; i < columns.length; i++) columns[i]!.push(null)
        cells += columns.length
        // A wide file is sampled on fewer rows.
        if (++read >= PREVIEW_READ || cells >= PREVIEW_CELLS) break
      }
      for (let i = 0; i < columns.length; i++) {
        const name = source.hasHeader ? source.header[i]! : `field${i + 1}`
        const values = columns[i] ?? []
        fields.push({
          source: name,
          suggestedPath: name,
          suggestedType: inferType(values),
          samples: values
            .filter((v) => v !== null && v !== '')
            .slice(0, 5)
            .map((v) => asText(v).slice(0, 200)),
          unusual: name.split('.').some((s) => isUnusualKey(s.replace(/\[\d+\]$/, ''))),
        })
      }
      for (let row = 0; row < Math.min(read, PREVIEW_SHOWN); row++) {
        const doc: Record<string, unknown> = {}
        fields.forEach((f, i) => {
          if (f.unusual) return
          const v = columns[i]?.[row]
          if (v === undefined || v === null || v === '') return
          const c = convert(v, f.suggestedType, { allowUnusual: false })
          define(doc, f.source, c.ok ? c.value : v)
        })
        records.push(clipRecord(doc))
      }
    } else {
      const seen = new Map<string, string[]>()
      let longNames = false
      let read = 0
      for await (const r of opened.source.records) {
        if (isFailure(r)) {
          note(r.n, r.error)
          continue
        }
        for (const [k, v] of Object.entries(r.doc)) {
          if (k.length > PREVIEW_KEY) {
            longNames = true
            continue
          }
          let list = seen.get(k)
          if (!list && seen.size < 1000) seen.set(k, (list = []))
          // Kept as cut text, so a sample never holds on to a record.
          if (list && list.length < 5) list.push(clipText(asText(v)))
        }
        if (records.length < PREVIEW_SHOWN) records.push(clipRecord(r.doc))
        if (++read >= PREVIEW_READ) break
      }
      for (const [k, samples] of seen)
        fields.push({ source: k, suggestedPath: k, suggestedType: 'keep', samples, unusual: isUnusualKey(k) })
      if (longNames)
        warnings.push(`Fields whose names are longer than ${PREVIEW_KEY} characters are not shown here`)
    }
    return {
      format,
      gzip: opened.gzip,
      dialect: opened.dialect,
      sheets: opened.sheets,
      fields,
      records,
      warnings,
      ...(opened.suggested ? { suggestedEncoding: opened.suggested } : {}),
    }
  } finally {
    await opened.close()
  }
}
