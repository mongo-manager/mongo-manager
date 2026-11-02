import { once } from 'node:events'
import type { Writable } from 'node:stream'
import type { Document } from 'bson'
import { ejsonText } from './bson-kind'
import type { ExportRequest } from '@mongo-manager/shared'
import { Errors } from '../errors'
import { csvLine } from './formats/csv'
import { XlsxWriter } from './formats/xlsx'
import { sqlWriter } from './formats/sqlwrite'
import { calculateObjectSize } from 'bson'
import { MAX_EXPORT_COLUMNS } from '@mongo-manager/shared'
import { OmittedFields, columnsOf, expandArrays, rowFor } from './flatten'
import { MAX_FIELDS, XLSX_MAX_DATA_ROWS } from './limits'
import type { OutCell } from './formats/types'

export interface DocWriter {
  write(doc: Document): Promise<void>
  end(): Promise<{ cutCells: number; omittedFields: string[] }>
}

/** How many documents (and bytes of them) name the columns when none were chosen. */
const COLUMN_SAMPLE_DOCS = 1000
// A few times larger on the heap than as BSON, for each export running at once (review Minor 12).
const COLUMN_SAMPLE_BYTES = 8 * 1024 * 1024

const put = async (out: Writable, text: string): Promise<void> => {
  if (!out.write(text)) await once(out, 'drain')
}

/** Spec §5.4: one writer per format, with backpressure. */
export function docWriter(
  out: Writable,
  req: ExportRequest,
  opts: { xlsxMaxRows?: number; collection?: string } = {},
): DocWriter {
  // User request 2026-10-10: SQL for a relational database; its table is the collection's by default.
  if (req.format === 'sql')
    return sqlWriter(out, {
      dialect: req.sql.dialect,
      table: req.sql.table ?? opts.collection ?? 'export',
      rowsPerInsert: req.sql.rowsPerInsert,
      transaction: req.sql.transaction,
      jsonAsText: req.sql.jsonAsText,
      fields: req.fields ?? null,
    })
  if (req.format === 'json') {
    let n = 0
    const relaxed = req.json.ejson === 'relaxed'
    return {
      async write(doc) {
        const text = req.json.pretty
          ? ejsonText(doc, { relaxed }, 2).replace(/\n/g, '\n  ')
          : ejsonText(doc, { relaxed })
        await put(out, `${n++ ? ',' : '['}${req.json.pretty ? '\n  ' : ''}${text}`)
      },
      async end() {
        await put(out, n ? (req.json.pretty ? '\n]\n' : ']') : '[]')
        return { cutCells: 0, omittedFields: [] }
      },
    }
  }
  if (req.format === 'ndjson')
    return {
      write: (doc) => put(out, `${ejsonText(doc, { relaxed: false })}\n`),
      end: async () => ({ cutCells: 0, omittedFields: [] }),
    }
  let fields: string[] | null = req.fields ?? null
  // W4.2: one column per array element needs the sampled documents even when the columns were chosen.
  const expand = req.arrays.mode === 'index'
  const join = req.arrays.mode === 'join' ? req.arrays.separator : undefined
  let omitted: OmittedFields | null = null
  let rows = 0
  const maxRows = opts.xlsxMaxRows ?? XLSX_MAX_DATA_ROWS
  const xlsx = req.format === 'xlsx' ? new XlsxWriter(out) : null
  const eol = req.csv.lineEnding === 'lf' ? '\n' : '\r\n'
  // Without chosen columns, the documents sampled first name them (spec §5.4; data review M3).
  const sample: Document[] = []
  let sampleBytes = 0
  const begin = async () => {
    fields ??= columnsOf(sample, Math.min(500, MAX_FIELDS))
    if (expand) fields = expandArrays(fields, sample, req.arrays.max, MAX_EXPORT_COLUMNS)
    omitted = new OmittedFields(fields)
    const head = fields.map((v): OutCell => ({ t: 'text', v }))
    if (xlsx) {
      await xlsx.start()
      await xlsx.row(head)
    } else {
      if (req.csv.bom) await put(out, '\uFEFF')
      if (req.csv.header)
        await put(out, csvLine(head, req.csv.delimiter, eol, { guard: req.csv.formulaGuard }))
    }
  }
  const row = async (doc: Document) => {
    omitted!.see(doc)
    if (xlsx) {
      if (++rows > maxRows)
        throw Errors.validation(
          `More than ${maxRows} rows do not fit in a sheet; export CSV or NDJSON instead`,
          {
            reason: 'xlsx_rows',
          },
        )
      await xlsx.row(rowFor(doc, fields!, join))
    } else
      await put(
        out,
        csvLine(rowFor(doc, fields!, join), req.csv.delimiter, eol, { guard: req.csv.formulaGuard }),
      )
  }
  const flushSample = async () => {
    await begin()
    for (const doc of sample.splice(0)) await row(doc)
  }
  return {
    async write(doc) {
      if (!omitted && (fields === null || expand)) {
        sample.push(doc)
        sampleBytes += calculateObjectSize(doc)
        if (sample.length >= COLUMN_SAMPLE_DOCS || sampleBytes >= COLUMN_SAMPLE_BYTES) await flushSample()
        return
      }
      if (!omitted) await begin()
      await row(doc)
    },
    async end() {
      if (!omitted) await flushSample()
      const cutCells = xlsx ? (await xlsx.finish()).cutCells : 0
      return { cutCells, omittedFields: omitted!.names() }
    },
  }
}
