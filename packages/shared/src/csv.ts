// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Phase 3a-2 spec §3.4 (A10): shell results as CSV. RFC 4180 quoting with CRLF rows. A cell a
 * spreadsheet would run as a formula (starting with = + - @, TAB or CR) is prefixed with ', header
 * cells included, since field names come from the database. Input is canonical EJSON.
 */

export const MAX_CSV_COLUMNS = 500
const BOM = String.fromCharCode(0xfeff)

const NUMERIC_WRAPPERS = ['$numberInt', '$numberDouble', '$numberLong', '$numberDecimal'] as const
const FORMULA_START = /^[=+\-@\t\r]/
const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** An EJSON value wrapper ({$oid}, {$date}, {$numberInt}, …): a leaf, not a sub-document. */
const isWrapper = (v: Record<string, unknown>): boolean => {
  const keys = Object.keys(v)
  return keys.length > 0 && keys.every((k) => k.startsWith('$'))
}

/** Dotted paths to leaves; arrays and EJSON wrappers are leaves. */
export function flattenDocument(doc: Record<string, unknown>): Record<string, unknown> {
  // No prototype: a field named __proto__ is a column like any other (final review M1).
  const out = Object.create(null) as Record<string, unknown>
  const walk = (value: Record<string, unknown>, prefix: string): void => {
    for (const [key, v] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (isPlainObject(v) && !isWrapper(v) && Object.keys(v).length > 0) walk(v, path)
      else out[path] = v
    }
  }
  walk(doc, '')
  return out
}

/** A value as text, and whether it is a number (numbers are never formula-guarded). */
function text(value: unknown): { text: string; numeric: boolean } {
  if (value === null || value === undefined) return { text: '', numeric: false }
  if (typeof value === 'string') return { text: value, numeric: false }
  if (typeof value === 'number' || typeof value === 'bigint') return { text: String(value), numeric: true }
  if (typeof value === 'boolean') return { text: String(value), numeric: false }
  if (isPlainObject(value)) {
    for (const key of NUMERIC_WRAPPERS) {
      const n = value[key]
      // Only a real decimal number skips the formula guard: a document may hold a $-prefixed field
      // (MongoDB 5.0+), so a "wrapper" with other text is guarded like any string.
      if (typeof n === 'string' && Object.keys(value).length === 1)
        return { text: n, numeric: /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(n) }
    }
    if (typeof value.$oid === 'string' && Object.keys(value).length === 1)
      return { text: value.$oid, numeric: false }
    const date = value.$date
    if (date !== undefined && Object.keys(value).length === 1) {
      const ms = isPlainObject(date) && typeof date.$numberLong === 'string' ? Number(date.$numberLong) : date
      const d = new Date(ms as string | number)
      if (!Number.isNaN(d.getTime())) return { text: d.toISOString(), numeric: false }
    }
  }
  return { text: JSON.stringify(value), numeric: false }
}

export function csvCell(value: unknown): string {
  const { text: raw, numeric } = text(value)
  const guarded = !numeric && FORMULA_START.test(raw) ? `'${raw}` : raw
  return NEEDS_QUOTES.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

function build(documents: readonly Record<string, unknown>[]): { csv: string; droppedColumns: number } {
  const rows = documents.map(flattenDocument)
  const columns: string[] = []
  const seen = new Set<string>()
  let droppedColumns = 0
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue
      seen.add(key)
      if (columns.length < MAX_CSV_COLUMNS) columns.push(key)
      else droppedColumns++
    }
  }
  const lines = [columns.map(csvCell).join(',')]
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','))
  return { csv: `${lines.join('\r\n')}\r\n`, droppedColumns }
}

export function toCsv(documents: readonly Record<string, unknown>[]): string {
  return build(documents).csv
}

/**
 * A CSV file to save: a UTF-8 byte order mark first, so a spreadsheet reads non-ASCII text right, and
 * how many columns beyond the cap were left out, so the person can be told (final review M2).
 */
export function csvFile(documents: readonly Record<string, unknown>[]): {
  text: string
  droppedColumns: number
} {
  const { csv, droppedColumns } = build(documents)
  return { text: `${BOM}${csv}`, droppedColumns }
}
