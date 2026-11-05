// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { z } from 'zod'
import { EjsonObjectSchema } from './data'
import { CollectionNameSchema, DatabaseNameSchema } from '../schemas'
import type { DrillReport, DumpReport, RestoreReport } from './backup'

/** Phase 3d-1 spec §5: the file formats read and written. */
export const TRANSFER_FORMATS = ['csv', 'json', 'ndjson', 'xlsx'] as const
export type TransferFormat = (typeof TRANSFER_FORMATS)[number]
/** User request 2026-10-10: SQL is written too (a dump is read by its own, multi-table import). */
export const EXPORT_FORMATS = [...TRANSFER_FORMATS, 'sql'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]
export const SQL_DIALECTS = ['postgres', 'mysql', 'sqlite'] as const
export type SqlDialect = (typeof SQL_DIALECTS)[number]

/** Spec §5.2–5.3: the target types of a mapped field ("keep" leaves the value as read). */
export const FIELD_TYPES = [
  'keep',
  'string',
  'int32',
  'int64',
  'double',
  'decimal128',
  'boolean',
  'date',
  'objectId',
  'json',
  'null',
] as const
export type FieldType = (typeof FIELD_TYPES)[number]

/** Phase 3d-2 spec §2: copy modes; "replace" builds the copy aside, then puts it in place. */
export const COPY_MODES = ['insert', 'upsert', 'merge', 'replace'] as const
export type CopyMode = (typeof COPY_MODES)[number]

const Delimiter = z.enum([',', ';', '\t', '|'])
/**
 * The text encodings a file is read in (completion W4.1): Unicode, and the single-byte encodings
 * Excel and older systems write in Western Europe and Turkey. "latin1" is ISO-8859-1 byte for byte.
 */
export const TEXT_ENCODINGS = [
  'utf8',
  'utf16le',
  'utf16be',
  'latin1',
  'windows1252',
  'windows1254',
  'iso88599',
] as const
export type TextEncodingName = (typeof TEXT_ENCODINGS)[number]
const Encoding = z.enum(TEXT_ENCODINGS)

export const DialectSchema = z.object({
  delimiter: Delimiter.optional(),
  header: z.boolean().optional(),
  sheet: z.string().min(1).max(255).optional(),
  encoding: Encoding.optional(),
})
export type Dialect = z.infer<typeof DialectSchema>

export const TransferPreviewRequestSchema = z.object({
  format: z.enum(TRANSFER_FORMATS).optional(),
  dialect: DialectSchema.default({}),
})

export interface PreviewField {
  source: string
  suggestedPath: string
  suggestedType: FieldType
  /** Up to five sample values as text, as the preview table shows them. */
  samples: string[]
  /** A name MongoDB accepts but that is unusual ($-prefixed, dotted, __proto__…): not imported by default. */
  unusual: boolean
}

export interface TransferPreviewResponse {
  format: TransferFormat
  gzip: boolean
  dialect: {
    delimiter: ',' | ';' | '\t' | '|'
    header: boolean
    sheet: string | null
    encoding: z.infer<typeof Encoding>
  }
  sheets: string[]
  fields: PreviewField[]
  /** The first records as read (canonical EJSON), at most 100. */
  records: Array<Record<string, unknown>>
  warnings: string[]
  /**
   * W4.1: the encoding the bytes look like when no encoding was chosen and they are not valid in the
   * one used. Only a suggestion: a guess is never applied by itself (a wrong one writes wrong letters).
   */
  suggestedEncoding?: TextEncodingName
}

/** A dot path; a segment may end with [n] (an array element). Unusual names are allowed per import. */
const TargetPath = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !p.includes('\0') && p.split('.').every((s) => s !== ''), 'Invalid field path')

/**
 * Sixteenth review of explain masking (P-1): a key names a field the target is matched by; a part
 * that starts with "$" would be an operator in that filter ($expr runs what a record holds).
 */
export const KeyPath = TargetPath.refine(
  (p) => !p.includes('[') && p.split('.').length <= 32 && p.split('.').every((s) => !s.startsWith('$')),
  'Invalid key field',
)

export const MappingEntrySchema = z.object({
  source: z.string().min(1).max(1024),
  path: TargetPath,
  type: z.enum(FIELD_TYPES).default('keep'),
  include: z.boolean().default(true),
  empty: z.enum(['skip', 'null', 'empty']).default('skip'),
  onError: z.enum(['error', 'null', 'string']).default('error'),
})
export type MappingEntry = z.infer<typeof MappingEntrySchema>

export const ConstantSchema = z.union([
  z.object({ path: TargetPath, now: z.literal(true) }),
  z.object({ path: TargetPath, type: z.enum(FIELD_TYPES).exclude(['keep']), value: z.string().max(4096) }),
])
export type Constant = z.infer<typeof ConstantSchema>

/**
 * W4.1: sample text converted by the import's rules, for the mapping step. The text is the caller's
 * own (the preview's samples); MongoDB is never read.
 */
export const ConvertSamplesRequestSchema = z.object({
  items: z
    .array(
      z.object({
        type: z.enum(FIELD_TYPES),
        values: z.array(z.string().max(4096)).max(5),
      }),
    )
    .max(500),
  allowUnusualKeys: z.boolean().default(false),
})
export type ConvertSamplesRequest = z.input<typeof ConvertSamplesRequestSchema>
/** What a converted sample is written as: the text shown, and its BSON type in the mapping's words. */
export type ConvertedSample =
  | {
      ok: true
      text: string
      kind: Exclude<FieldType, 'keep' | 'json'> | 'object' | 'array' | 'other'
    }
  | { ok: false; reason: string }
export interface ConvertSamplesResponse {
  items: ConvertedSample[][]
}

export const ImportRequestSchema = z.object({
  uploadId: z.string().uuid(),
  format: z.enum(TRANSFER_FORMATS),
  dialect: DialectSchema.default({}),
  /** Absent: every field as read (JSON family); required for CSV and xlsx. */
  mapping: z.array(MappingEntrySchema).max(10_000).optional(),
  constants: z.array(ConstantSchema).max(100).default([]),
  mode: z.enum(['insert', 'upsert', 'merge']),
  keys: z.array(KeyPath).min(1).max(32).default(['_id']),
  updateOnly: z.boolean().default(false),
  onError: z.enum(['stop', 'continue']).default('continue'),
  dryRun: z.boolean().default(false),
  allowUnusualKeys: z.boolean().default(false),
})
export type ImportRequest = z.infer<typeof ImportRequestSchema>

export const ExportSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('query'),
    filter: EjsonObjectSchema.default({}),
    projection: EjsonObjectSchema.optional(),
    sort: EjsonObjectSchema.optional(),
    collation: EjsonObjectSchema.optional(),
    hint: z.union([z.string().min(1).max(512), EjsonObjectSchema]).optional(),
    skip: z.number().int().min(0).max(1_000_000_000).default(0),
    limit: z.number().int().min(1).max(1_000_000_000).optional(),
  }),
  z.object({ kind: z.literal('collection') }),
  z.object({ kind: z.literal('pipeline'), stages: z.array(EjsonObjectSchema).max(100) }),
])
export type ExportSource = z.infer<typeof ExportSourceSchema>

const CsvOptionsSchema = z.object({
  delimiter: Delimiter.default(','),
  header: z.boolean().default(true),
  lineEnding: z.enum(['lf', 'crlf']).default('crlf'),
  bom: z.boolean().default(true),
  /**
   * Text starting with = + - @ gets a leading ' so a spreadsheet never runs it as a formula (spec
   * §7 T13). Off for a file meant for another program or a re-import, which would keep the '
   * (data review 2026-10-13, M8).
   */
  formulaGuard: z.boolean().default(true),
})
const JsonOptionsSchema = z.object({
  pretty: z.boolean().default(true),
  ejson: z.enum(['canonical', 'relaxed']).default('canonical'),
})
/** A SQL export: the dialect it is written for, its table (the collection's name by default). */
const SqlOptionsSchema = z.object({
  dialect: z.enum(SQL_DIALECTS).default('postgres'),
  table: z
    .string()
    .min(1)
    .max(128)
    .refine((t) => !t.includes('\0'), 'Invalid table name')
    .optional(),
  rowsPerInsert: z.number().int().min(1).max(1000).default(100),
  transaction: z.boolean().default(true),
  /**
   * MySQL: nested values in LONGTEXT (the same JSON text) instead of JSON, for older tools such as
   * phpMyAdmin before 4.7 (user request 2026-10-12).
   */
  jsonAsText: z.boolean().default(false),
})
/** LONGTEXT for nested values is MySQL's only: asked with another dialect, refused (review M11). */
const mysqlOnly = (o: { dialect: string; jsonAsText: boolean }) => o.dialect === 'mysql' || !o.jsonAsText
const mysqlOnlyError = { message: 'Nested values as LONGTEXT are for MySQL only', path: ['jsonAsText'] }

/**
 * W4.2: arrays in CSV and xlsx columns — one JSON cell (as before), one column per element up to
 * `max` ("tags.0", "tags.1"…), or the elements' texts joined with `separator`.
 */
export const ARRAY_COLUMN_MODES = ['json', 'index', 'join'] as const
export const ArrayColumnsSchema = z.object({
  mode: z.enum(ARRAY_COLUMN_MODES).default('json'),
  max: z.number().int().min(1).max(100).default(10),
  separator: z
    .string()
    .min(1)
    .max(16)
    .refine((s) => !s.includes('\0'), 'Invalid separator')
    .default('; '),
})
export type ArrayColumns = z.infer<typeof ArrayColumnsSchema>
/** At most this many columns in a CSV or xlsx export once arrays are expanded. */
export const MAX_EXPORT_COLUMNS = 1000

export const ExportRequestSchema = z.object({
  source: ExportSourceSchema,
  format: z.enum(EXPORT_FORMATS),
  /** Column order for CSV/xlsx (dot paths; numeric segments index arrays); a JSON-family export ignores it. */
  fields: z.array(z.string().min(1).max(1024)).max(500).optional(),
  arrays: ArrayColumnsSchema.default({ mode: 'json', max: 10, separator: '; ' }),
  gzip: z.boolean().default(false),
  csv: CsvOptionsSchema.default({
    delimiter: ',',
    header: true,
    lineEnding: 'crlf',
    bom: true,
    formulaGuard: true,
  }),
  json: JsonOptionsSchema.default({ pretty: true, ejson: 'canonical' }),
  sql: SqlOptionsSchema.refine(mysqlOnly, mysqlOnlyError).default({
    dialect: 'postgres',
    rowsPerInsert: 100,
    transaction: true,
    jsonAsText: false,
  }),
})
export type ExportRequest = z.infer<typeof ExportRequestSchema>

/** At most this many collections in one SQL export (of its one database). */
export const SQL_EXPORT_MAX_COLLECTIONS = 500

/**
 * User request 2026-10-11: the SQL ↔ MongoDB page — chosen collections of the address's database
 * (never a system one) into one SQL file, each collection a table named after it. One database at a
 * time (user request 2026-10-12: "tek veritabanı seçilecek şekilde yap").
 */
export const SqlExportRequestSchema = z.strictObject({
  collections: z
    .array(CollectionNameSchema.refine((c) => !c.startsWith('system.'), 'Not a system collection'))
    .min(1)
    .max(SQL_EXPORT_MAX_COLLECTIONS)
    .refine((list) => new Set(list).size === list.length, 'A collection is chosen twice'),
  sql: SqlOptionsSchema.omit({ table: true }).refine(mysqlOnly, mysqlOnlyError).default({
    dialect: 'postgres',
    rowsPerInsert: 100,
    transaction: true,
    jsonAsText: false,
  }),
  gzip: z.boolean().default(false),
})
export type SqlExportRequest = z.infer<typeof SqlExportRequestSchema>
/** What a client sends (defaults filled in by the server). */
export type SqlExportBody = z.input<typeof SqlExportRequestSchema>

/**
 * User request 2026-10-10: a SQL dump's tables imported into collections of a database, one pass
 * over the file. A table goes to one collection; like tables may share one. Never a system collection.
 */
export const SqlImportTableSchema = z.object({
  /** The table's key from the preview ("schema.name", or the name). */
  table: z.string().min(1).max(512),
  collection: CollectionNameSchema.refine((c) => !c.startsWith('system.'), 'Not a system collection'),
  include: z.boolean().default(true),
})
export const SqlImportRequestSchema = z
  .object({
    uploadId: z.string().uuid(),
    tables: z.array(SqlImportTableSchema).min(1).max(1000),
    /** A single-column primary key becomes _id. */
    primaryKeyAsId: z.boolean().default(true),
    mode: z.enum(['insert', 'upsert', 'merge']).default('insert'),
    onError: z.enum(['stop', 'continue']).default('continue'),
    dryRun: z.boolean().default(false),
  })
  .refine((r) => new Set(r.tables.map((t) => t.table)).size === r.tables.length, {
    message: 'A table is listed once',
    path: ['tables'],
  })
export type SqlImportRequest = z.infer<typeof SqlImportRequestSchema>

export interface SqlPreviewColumn {
  name: string
  type: string
  kind: string
}
export interface SqlPreviewTable {
  /** What an import names the table by: "schema.name", or the name. */
  key: string
  name: string
  /** Why every row of this table would fail (too many columns, a definition too large…). */
  error?: string
  /** How many columns the table has; `columns` lists the first of them only. */
  columnCount: number
  schema?: string
  columns: SqlPreviewColumn[]
  primaryKey: string[]
  rows: number
  /** The first rows as they would be imported (canonical EJSON). */
  samples: Array<Record<string, unknown>>
}
export interface SqlPreviewResponse {
  gzip: boolean
  dialect: string
  tables: SqlPreviewTable[]
  /** Statements read but not imported, by kind (DROP TABLE, CREATE INDEX, SET…). */
  skipped: Record<string, number>
  /** The dump holds more than could be listed. */
  truncated: boolean
  /** Why the dump could not be read to its end (it ends inside a text, a COPY never ends…). */
  error?: string
}

export interface SqlImportTableReport {
  table: string
  collection: string
  read: number
  inserted: number
  matched: number
  modified: number
  upserted: number
  skipped: number
  failed: number
  wouldMatch?: number
}
export interface SqlImportReport {
  kind: 'importSql'
  dryRun: boolean
  mode: 'insert' | 'upsert' | 'merge'
  tables: SqlImportTableReport[]
  skipped: Record<string, number>
  errors: Array<RowError & { table: string }>
  moreErrors: boolean
  rejectedFile: boolean
  rejectedDropped?: boolean
  stoppedAt?: { table: string; record: number }
  /** The dump itself could not be read to its end (an open text, a COPY never ended…). */
  dumpError?: string
  /** Data review 2026-10-13 (low): as ImportReport.unfinished, over all the tables. */
  unfinished?: { written: number; notWritten: number; uncertain?: number }
}

export interface UploadResponse {
  uploadId: string
  size: number
}

export interface RowError {
  /** 1-based record number in the source. */
  record: number
  field?: string
  reason: string
  /** MongoDB's error code, when MongoDB refused the write. */
  code?: number
}

export interface ImportReport {
  kind: 'import'
  dryRun: boolean
  mode: 'insert' | 'upsert' | 'merge'
  read: number
  inserted: number
  matched: number
  modified: number
  upserted: number
  skipped: number
  failed: number
  /** Dry run of upsert/merge: records whose keys match a stored document. */
  wouldMatch?: number
  fields: Array<{ source: string; converted: number; failed: number }>
  errors: RowError[]
  /** More errors than listed. */
  moreErrors: boolean
  rejectedFile: boolean
  /** The rejected-records file would have passed the owner's storage quota, so it was not kept. */
  rejectedDropped?: boolean
  stoppedAt?: number
  /**
   * Data review 2026-10-13 (low): a run that did not finish (stopped, failed or cancelled) — the
   * records it wrote, and those read but never written. Run again with Insert, the written ones are
   * written twice.
   */
  unfinished?: { written: number; notWritten: number; uncertain?: number }
}

export interface ExportReport {
  kind: 'export'
  written: number
  bytes: number
  /** CSV/xlsx: fields seen in documents but not among the columns (names only, at most 100). */
  omittedFields: string[]
  /** xlsx: cells cut at 32 767 characters. */
  cutCells: number
  expiresAt: number
  masked: boolean
  /**
   * A SQL export of several collections (review 2026-10-11): each one's table — renamed when two
   * would clash — what it wrote and what its table left out.
   */
  tables?: Array<{
    database: string
    collection: string
    table: string
    written: number
    omittedFields: string[]
    cutCells: number
  }>
}

export type TransferReport =
  | ImportReport
  | SqlImportReport
  | ExportReport
  | CopyReport
  | CompareReport
  | SyncReport
  | DumpReport
  | RestoreReport
  | DrillReport

const ConnectionRef = z.string().min(1).max(64)
const PlanHash = z.string().regex(/^[0-9a-f]{64}$/)

const CopyCommon = {
  mode: z.enum(COPY_MODES),
  keys: z.array(KeyPath).min(1).max(32).default(['_id']),
  updateOnly: z.boolean().default(false),
  onError: z.enum(['stop', 'continue']).default('continue'),
  dryRun: z.boolean().default(false),
  indexes: z.boolean().default(true),
  validator: z.boolean().default(true),
  options: z.boolean().default(true),
  anonymous: z.boolean().default(false),
  confirmPersonal: z.boolean().default(false),
  addRulesToTarget: z.boolean().default(false),
  confirmTtl: z.boolean().default(false),
  /** From the plan route; required by the start routes (spec §8.2). */
  planHash: PlanHash.optional(),
}

export const CollectionCopyRequestSchema = z.strictObject({
  source: ExportSourceSchema,
  target: z.strictObject({ connectionId: ConnectionRef, db: DatabaseNameSchema, coll: CollectionNameSchema }),
  ...CopyCommon,
})
export type CollectionCopyRequest = z.infer<typeof CollectionCopyRequestSchema>

export const DatabaseCopyRequestSchema = z.strictObject({
  target: z.strictObject({ connectionId: ConnectionRef, db: DatabaseNameSchema }),
  /** Absent: every collection of the source database (system.* excluded). */
  collections: z.array(CollectionNameSchema).min(1).max(1000).optional(),
  views: z.boolean().default(true),
  ...CopyCommon,
})
export type DatabaseCopyRequest = z.infer<typeof DatabaseCopyRequestSchema>

const Ignore = z.array(TargetPath).max(100).default([])

export const CompareRequestSchema = z.strictObject({
  target: z.strictObject({ connectionId: ConnectionRef, db: DatabaseNameSchema, coll: CollectionNameSchema }),
  filter: EjsonObjectSchema.default({}),
  ignore: Ignore,
})
export type CompareRequest = z.infer<typeof CompareRequestSchema>

export const DatabaseCompareRequestSchema = z.strictObject({
  target: z.strictObject({ connectionId: ConnectionRef, db: DatabaseNameSchema }),
  collections: z.array(CollectionNameSchema).min(1).max(1000).optional(),
  ignore: Ignore,
})
export type DatabaseCompareRequest = z.infer<typeof DatabaseCompareRequestSchema>

export const SyncRequestSchema = z.strictObject({
  compareJobId: z.string().uuid(),
  insert: z.boolean().default(true),
  replace: z.boolean().default(true),
  delete: z.boolean().default(false),
  /** With delete: the target collection's name (a database sync: the target database's). */
  confirm: z.string().max(255).optional(),
  /** The comparison found personal-field rules the target lacks: values will be visible there (§5.2). */
  confirmPersonal: z.boolean().default(false),
})
export type SyncRequest = z.infer<typeof SyncRequestSchema>

export type CopyPath = 'shortcut' | 'stream'
export type Deployment = 'same' | 'different' | 'unknown'

export interface CopyPlanCollection {
  source: string
  target: string
  exists: boolean
  /** Estimated documents in the target, when it exists. */
  count: number | null
  /**
   * W4.3: the source collection's estimated documents and data size (uncompressed BSON bytes), the
   * whole collection's even when a query or pipeline picks some; null when MongoDB does not tell.
   */
  sourceCount?: number | null
  sourceBytes?: number | null
  path: CopyPath
  sharded: boolean
  ttlIndexes: string[]
  /** The source's default collation keeps the _id index from serving the sort (compare only). */
  fullSort: boolean
  /** Why this collection will not be copied (an encrypted collection, a refused validator). */
  skipped?: string
  /**
   * Security audit 2026-10-16: a masked copy leaves out definitions that hold values masking would
   * change — the validator (the data is copied without it) and indexes with such a partial filter.
   */
  validatorLeftOut?: true
  indexesLeftOut?: string[]
  /**
   * W8: an encrypted source — Queryable Encryption (refused: encrypted_collection) or CSFLE (copied
   * as stored, its encrypted fields still ciphertext).
   */
  encrypted?: 'queryable' | 'ciphertext'
}

export interface CopyPlan {
  planHash: string
  collections: CopyPlanCollection[]
  views: string[]
  /** Security audit 2026-10-16: views a masked copy leaves out (their pipeline holds masked values). */
  viewsLeftOut?: string[]
  /** The caller is restricted on the source: the copy is masked whatever they ask. */
  masked: boolean
  /** Source rules for the copied namespaces with no equivalent on the target ("db.coll.field"). */
  missingRules: string[]
  /** The caller may add those rules to the target (connection admin there). */
  mayAddRules: boolean
  deployment: Deployment
  /** Refusals the start would answer with, as reason codes (e.g. "same_namespace"). */
  refusals: string[]
}

export interface CopyCollectionReport {
  source: string
  target: string
  path: CopyPath
  read: number
  inserted: number
  matched: number
  modified: number
  upserted: number
  skipped: number
  failed: number
  wouldMatch?: number
  errors: RowError[]
  moreErrors: boolean
  indexes: { built: string[]; skipped: Array<{ name: string; reason: string }> }
  /**
   * The target's user may not change a validator once the collection exists: it was set before the
   * load, so the documents it refuses were not copied (review of the data fixes, I2).
   */
  validatorBeforeLoad?: boolean
  /** The collection was not copied (or stopped), and why. */
  failure?: string
}

export interface CopyReport {
  kind: 'copy'
  dryRun: boolean
  mode: CopyMode
  collections: CopyCollectionReport[]
  views: Array<{ name: string; created: boolean; reason?: string }>
  masked: boolean
  anonymous: boolean
  rulesAdded: number
  rejectedFile: boolean
  rejectedDropped?: boolean
  stoppedAt?: { collection: string; record: number }
  /** The rules versions the copy ran under: its report and files are withdrawn when they move. */
  versions: { source: number; target: number }
  /** The sides the caller was restricted on when it ran: a new restriction withdraws the report. */
  restricted: { source: boolean; target: boolean }
}

/** A document present on one side only: its _id and the document, cut (canonical EJSON). */
export interface CompareSample {
  id: unknown
  doc: Record<string, unknown>
}

/** A document on both sides that differs: the field changes, values cut (canonical EJSON). */
export interface CompareDiffSample {
  id: unknown
  changes: Array<{ path: string; before?: unknown; after?: unknown }>
  more: boolean
  /** The documents hold the same fields and values; only their order differs. */
  orderOnly?: boolean
}

export interface CompareCollectionReport {
  source: string
  target: string
  onlySource: number
  onlyTarget: number
  different: number
  same: number
  samples: { onlySource: CompareSample[]; onlyTarget: CompareSample[]; different: CompareDiffSample[] }
  failure?: string
}

export interface CompareReport {
  kind: 'compare'
  source: { connectionId: string; db: string; coll: string | null }
  target: { connectionId: string; db: string; coll: string | null }
  filter: Record<string, unknown>
  ignore: string[]
  collections: CompareCollectionReport[]
  masked: boolean
  versions: { source: number; target: number }
  expiresAt: number
  /** Every collection was compared to its end (a failed or cancelled comparison cannot be synced). */
  complete: boolean
  /** Source rules the target lacks ("db.coll.field"): a sync writes those values unmasked there. */
  missingRules: string[]
  /** The sides the caller was restricted on when it ran: a new restriction withdraws the report. */
  restricted: { source: boolean; target: boolean }
}

export interface SyncCollectionReport {
  source: string
  target: string
  inserted: number
  replaced: number
  deleted: number
  changedMeanwhile: number
  /**
   * Data review 2026-10-13 (M10): target documents matching the filter whose source still exists
   * but no longer matches it — kept, never deleted.
   */
  outsideFilter?: number
  failed: number
  errors: RowError[]
  moreErrors: boolean
  deletionStopped?: boolean
  failure?: string
}

export interface SyncReport {
  kind: 'sync'
  compareJobId: string
  collections: SyncCollectionReport[]
  masked: boolean
  versions: { source: number; target: number }
  /** The sides the caller was restricted on when it ran: a new restriction withdraws the report. */
  restricted: { source: boolean; target: boolean }
}

export const PresetBodySchema = z.object({
  dialect: DialectSchema.optional(),
  mapping: z.array(MappingEntrySchema).max(10_000).optional(),
  constants: z.array(ConstantSchema).max(100).optional(),
  mode: z.enum(COPY_MODES).optional(),
  keys: z.array(KeyPath).max(32).optional(),
  format: z.enum(EXPORT_FORMATS).optional(),
  fields: z.array(z.string().min(1).max(1024)).max(500).optional(),
  arrays: ArrayColumnsSchema.partial().optional(),
  gzip: z.boolean().optional(),
  csv: CsvOptionsSchema.partial().optional(),
  json: JsonOptionsSchema.partial().optional(),
  sql: SqlOptionsSchema.partial().optional(),
  /** Export presets: the query as text, parsed by the safe parser when used. */
  filter: z
    .string()
    .max(64 * 1024)
    .optional(),
  /** Copy presets (phase 3d-2). */
  copy: z
    .object({
      indexes: z.boolean(),
      validator: z.boolean(),
      options: z.boolean(),
      anonymous: z.boolean(),
      views: z.boolean(),
      onError: z.enum(['stop', 'continue']),
      updateOnly: z.boolean(),
      ignore: z.array(TargetPath).max(100),
    })
    .partial()
    .optional(),
})

export const PresetSchema = z.object({
  kind: z.enum(['import', 'export', 'copy']),
  name: z.string().trim().min(1).max(120),
  namespace: z.string().max(512).nullable().default(null),
  body: PresetBodySchema,
})
export type PresetInput = z.infer<typeof PresetSchema>
export interface Preset extends PresetInput {
  id: string
  createdAt: number
  updatedAt: number
}
