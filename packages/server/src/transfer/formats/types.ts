// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Document } from 'mongodb'

export type Delimiter = ',' | ';' | '\t' | '|'
export type Cell = string | number | boolean | Date | null

export interface TableRow {
  n: number
  cells: Cell[]
}

/** A record that could not be read; the file goes on (a row error in the report). */
export interface RecordFailure {
  n: number
  error: string
  /** The record's text, when there is one, for the rejected-records file. */
  raw?: string
  /** A table row's cells, read but refused whole (a CSV row of another width), for that file. */
  cells?: string[]
}

export interface TableSource {
  kind: 'table'
  header: string[]
  hasHeader: boolean
  rows: AsyncIterable<TableRow | RecordFailure>
}

export interface DocRecord {
  n: number
  doc: Document
  /** The record's text as in the file, for the rejected-records file. */
  raw: string
}

export interface DocSource {
  kind: 'docs'
  records: AsyncIterable<DocRecord | RecordFailure>
}

export type Source = TableSource | DocSource

/** One exported cell (spec §5.4). `digits` is Long/Decimal128 text: never formula-guarded. */
export type OutCell =
  | { t: 'empty' }
  | { t: 'text'; v: string }
  | { t: 'num'; v: number }
  | { t: 'digits'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'date'; v: Date }

export const isFailure = (r: object): r is RecordFailure => 'error' in r
