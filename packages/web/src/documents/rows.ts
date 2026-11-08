// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { markRaw } from 'vue'
import type { DocumentCaution, DocumentItem } from '@/api/documents'
import { decodeDocument, isDocument, toShell, typeOf } from './values'

export interface DocumentRow {
  key: string
  kind: 'document'
  /** Canonical EJSON as received: the source of truth for ids in write requests. */
  raw: Record<string, unknown>
  hash: string
  /** Decoded BSON values, never made reactive (BSON classes and big pages stay cheap). */
  value: Record<string, unknown>
  /** A field the app would not write back as stored (data review 2026-10-13, M3). */
  caution?: DocumentCaution
}
export interface UnsupportedRow {
  key: string
  kind: 'unsupported'
  rawId: unknown
  reason: string
}
export type Row = DocumentRow | UnsupportedRow
/** Phase 4b §3: `plugin:<pluginId>:<actionId>` is a plugin's document action. */
export type RowAction = 'inspect' | 'edit' | 'clone' | 'copy' | 'delete' | `plugin:${string}`
export type EditorMode =
  { kind: 'edit'; row: DocumentRow } | { kind: 'clone'; row: DocumentRow } | { kind: 'insert' }
/**
 * UI redesign R1 revision 2 §4.5: what the inspector shows. A document is followed by its _id (its key
 * changes with every save), a clone by the document it copies.
 */
export type InspectorMode =
  | { kind: 'document'; id: string; tab: 'tree' | 'json' | 'edit' }
  | { kind: 'clone'; row: DocumentRow }
  | { kind: 'insert' }

/**
 * Reviewer B I1: the editor's unsaved text, kept with the tab (another section or tab unmounts the
 * view) until it is saved or let go. `base` and `hash` are the version opened: the diff and the
 * conflict check stay against it.
 */
export interface EditDraft {
  key: string
  text: string
  initial: string
  hash: string
  base: Record<string, unknown>
  dropped: string[]
}
/** Which editor a draft belongs to: a document's, a clone of one, or a new document. */
export function editorKey(mode: EditorMode): string {
  return mode.kind === 'insert' ? 'insert' : `${mode.kind}:${rowIdKey(mode.row)}`
}
/** Reviewer B I2: an inspector mode's identity (a clone of another document is another editor). */
export function inspectorKey(mode: InspectorMode): string {
  return mode.kind === 'document'
    ? `document:${mode.id}:${mode.tab}`
    : mode.kind === 'clone'
      ? `clone:${rowIdKey(mode.row)}`
      : 'insert'
}

/** Reviewer B I3: whether a row has an _id (a projection or a pipeline may leave it out). */
export const hasId = (row: Row): boolean =>
  row.kind === 'document' ? Object.hasOwn(row.raw, '_id') : row.rawId !== undefined && row.rawId !== null

/**
 * A row's identity across pages and saves: its canonical EJSON _id — or, without one, its place in
 * the results (such a row is never selected, edited or deleted: nothing would name it to the server).
 */
export const rowIdKey = (row: Row): string =>
  hasId(row)
    ? JSON.stringify(row.kind === 'document' ? row.raw._id : row.rawId)!
    : `#${row.key.split(':')[0]}`

export function toRows(items: DocumentItem[], offset: number): Row[] {
  return items.map((item, i): Row =>
    'document' in item
      ? {
          key: `${offset + i}:${item.hash}`,
          kind: 'document',
          raw: markRaw(item.document),
          hash: item.hash,
          value: markRaw(decodeDocument(item.document)),
          ...(item.caution ? { caution: item.caution } : {}),
        }
      : {
          key: `${offset + i}:unsupported`,
          kind: 'unsupported',
          rawId: item.unsupported._id,
          reason: item.unsupported.reason,
        },
  )
}

/** Table columns: _id first, then top-level fields in the order they first appear. */
export function columnsOf(rows: Row[], max = Infinity): string[] {
  const columns = new Set<string>()
  if (rows.some((r) => r.kind === 'document' && '_id' in r.value)) columns.add('_id')
  for (const row of rows) {
    if (row.kind !== 'document') continue
    for (const key of Object.keys(row.value)) {
      if (columns.size >= max) return [...columns]
      columns.add(key)
    }
  }
  return [...columns]
}

/** Dotted field paths (up to three levels) seen on the page, for completion. */
export function fieldPaths(rows: Row[], max = 300): string[] {
  const paths = new Set<string>()
  const walk = (value: Record<string, unknown>, prefix: string, depth: number) => {
    for (const [key, child] of Object.entries(value)) {
      if (paths.size >= max) return
      const path = prefix ? `${prefix}.${key}` : key
      paths.add(path)
      if (depth < 3 && isDocument(child)) walk(child, path, depth + 1)
    }
  }
  for (const row of rows) if (row.kind === 'document') walk(row.value, '', 1)
  return [...paths]
}

/** Columns rendered at once; the rest are reachable through the columns menu. */
export const MAX_COLUMNS = 100

/** What the user chose per collection tab: an order (fields not in it come last) and hidden fields. */
export interface ColumnPrefs {
  order: string[]
  hidden: string[]
  /** W1 (completion §2): widths the user dragged, in pixels; absent columns size themselves. */
  widths?: Record<string, number>
}

/** W1: a column's width, within what a header can hold and a screen can show. */
export const COLUMN_WIDTH = { min: 64, max: 960, default: 192 } as const

/** Every column in the user's order, hidden ones included (for the columns menu). */
export function orderColumns(all: string[], prefs: ColumnPrefs): string[] {
  const present = new Set(all)
  const known = new Set(prefs.order)
  return [...prefs.order.filter((c) => present.has(c)), ...all.filter((c) => !known.has(c))]
}

/** The columns to render and how many visible ones did not fit: nothing is dropped silently. */
export function arrangeColumns(
  all: string[],
  prefs: ColumnPrefs,
  limit = MAX_COLUMNS,
): { shown: string[]; overflow: number } {
  const hidden = new Set(prefs.hidden)
  const visible = orderColumns(all, prefs).filter((c) => !hidden.has(c))
  return { shown: visible.slice(0, limit), overflow: Math.max(0, visible.length - limit) }
}

/** Values worth suggesting: short scalars (long texts and binary data are not). */
const MAX_VALUE_TEXT = 120

/**
 * UI redesign R1 review: the values a field holds on the page, as shell literals, most common first
 * (array items count one by one), for the filter's value suggestions.
 */
export function fieldValues(rows: Row[], path: string, max = 30): string[] {
  const counts = new Map<string, number>()
  const steps = path.split('.')
  const visit = (value: unknown, at: number): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, at)
      return
    }
    if (at < steps.length) {
      if (isDocument(value)) visit(value[steps[at]!], at + 1)
      return
    }
    const type = typeOf(value)
    if (type === 'object' || type === 'binary' || type === 'undefined' || type === 'code') return
    const text = toShell(value, 0)
    if (text.length <= MAX_VALUE_TEXT) counts.set(text, (counts.get(text) ?? 0) + 1)
  }
  for (const row of rows) if (row.kind === 'document') visit(row.value, 0)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([text]) => text)
}

/** The builder's value kinds, by BSON type. */
const KIND_OF: Partial<Record<string, 'string' | 'number' | 'boolean' | 'date' | 'objectId'>> = {
  string: 'string',
  int32: 'number',
  double: 'number',
  long: 'number',
  decimal128: 'number',
  boolean: 'boolean',
  date: 'date',
  objectId: 'objectId',
}

/** The kind of value a field holds on the page, the most common one (arrays count by their items). */
export function fieldType(
  rows: Row[],
  path: string,
): 'string' | 'number' | 'boolean' | 'date' | 'objectId' | undefined {
  const counts = new Map<string, number>()
  const steps = path.split('.')
  const visit = (value: unknown, at: number): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, at)
      return
    }
    if (at < steps.length) {
      if (isDocument(value)) visit(value[steps[at]!], at + 1)
      return
    }
    const kind = KIND_OF[typeOf(value)]
    if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  for (const row of rows) if (row.kind === 'document') visit(row.value, 0)
  let best: string | undefined
  for (const [kind, count] of counts) if (!best || count > counts.get(best)!) best = kind
  return best as ReturnType<typeof fieldType>
}
