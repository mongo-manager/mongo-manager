// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { canonical, columnSide, type Doc, type Model } from './translate'
import { parse } from './parser'

/**
 * Plugin tabs redesign §2.2: a translated query run read-only in the open collection, through the
 * bridge's bounded reads. At most ROWS rows; a query of another collection is not run here. A JOIN
 * runs as its pipeline (user request 2026-10-10): the plugin may read its database's other
 * collections, and the app applies the user's rights and masking to the joined one too.
 */
export const ROWS = 50

export type Plan =
  | {
      kind: 'run'
      method: 'documents.find' | 'documents.aggregate'
      params: Doc
      /** The rows asked for are more than ROWS (or not bounded): "more" means there are more. */
      capped: boolean
    }
  | { kind: 'other'; from: string }
  | { kind: 'none' }

/** The query as a pipeline (a find opened in Aggregations, or paged). */
export function asPipeline(m: Model): Doc[] {
  if (m.kind === 'aggregate') return m.pipeline
  return [
    ...(Object.keys(m.filter).length ? [{ $match: m.filter }] : []),
    ...(m.sort ? [{ $sort: m.sort }] : []),
    ...(m.skip !== undefined ? [{ $skip: m.skip }] : []),
    ...(m.limit !== undefined ? [{ $limit: m.limit }] : []),
    ...(m.projection ? [{ $project: m.projection }] : []),
  ]
}

export function planRun(model: Model, coll: string): Plan {
  if (model.collection !== coll) return { kind: 'other', from: model.collection }
  if (model.kind === 'aggregate') {
    // LIMIT 0 is no rows here too: the server refuses a $limit of 0.
    if (model.pipeline.some((s) => s.$limit === 0)) return { kind: 'none' }
    return {
      kind: 'run',
      method: 'documents.aggregate',
      params: { pipeline: canonical(model.pipeline), limit: ROWS },
      capped: true,
    }
  }
  // SQL's LIMIT 0 is no rows; the bridge (and MongoDB's find) read 0 as "no limit".
  if (model.limit === 0) return { kind: 'none' }
  const limit = Math.min(model.limit ?? ROWS, ROWS)
  const capped = model.limit === undefined || model.limit > ROWS
  // documents.find always starts at the first document: a page further on is a pipeline.
  if (model.skip !== undefined)
    return {
      kind: 'run',
      method: 'documents.aggregate',
      params: { pipeline: canonical(asPipeline(model)), limit },
      capped,
    }
  return {
    kind: 'run',
    method: 'documents.find',
    params: {
      filter: canonical(model.filter),
      ...(model.projection ? { projection: canonical(model.projection) } : {}),
      ...(model.sort ? { sort: canonical(model.sort) } : {}),
      limit,
    },
    capped,
  }
}

/** The rows' top-level keys, first seen first, `_id` before them; at most `max`. */
export function columnsOf(
  rows: Doc[],
  max = 30,
  /** The order the query names its columns in (review 2026-10-10: a join's came first). */
  order: string[] = [],
): { columns: string[]; hidden: number } {
  const seen = new Set<string>()
  for (const row of rows) if ('_id' in row) seen.add('_id')
  for (const row of rows) for (const key of Object.keys(row)) seen.add(key)
  const named = order.filter((key) => seen.has(key))
  // An _id the query did not name stays first, as before; then the named ones, then the rest.
  const id = seen.has('_id') && !named.includes('_id') ? ['_id'] : []
  const all = [...id, ...named, ...[...seen].filter((key) => !named.includes(key) && key !== '_id')]
  return { columns: all.slice(0, max), hidden: Math.max(0, all.length - max) }
}

/** The columns a query names, in its order: a find's projection, a pipeline's last $project. */
export function columnOrder(model: Model): string[] {
  const projection =
    model.kind === 'find'
      ? model.projection
      : ([...model.pipeline].reverse().find((s) => '$project' in s)?.$project as Doc | undefined)
  if (!projection) return []
  return Object.entries(projection)
    .filter(([key, value]) => !(key === '_id' && (value === 0 || value === false)))
    .map(([key]) => key)
}

/** A character offset as a line and a column, both from 1; a column counts characters, not halves. */
export function positionOf(sql: string, index: number): { line: number; column: number } {
  const before = sql.slice(0, index)
  const start = before.lastIndexOf('\n') + 1
  return { line: before.split('\n').length, column: [...before.slice(start)].length + 1 }
}

/** The line holding `index`, around it: what is before, the character itself (a space at the end), after. */
export function snippetOf(
  sql: string,
  index: number,
  around = 40,
): { before: string; at: string; after: string } {
  const start = sql.lastIndexOf('\n', index - 1) + 1
  const endAt = sql.indexOf('\n', index)
  const end = endAt === -1 ? sql.length : endAt
  const ch = index < end ? String.fromCodePoint(sql.codePointAt(index)!) : ''
  // Cut by characters: half of a pair would show as a broken one.
  const before = [...sql.slice(start, index)]
  const after = [...sql.slice(index + ch.length, end)]
  return {
    before: before.length > around ? `…${before.slice(-(around - 1)).join('')}` : before.join(''),
    at: ch || ' ',
    after: after.length > around ? `${after.slice(0, around - 1).join('')}…` : after.join(''),
  }
}

const isPlain = (v: unknown): v is Doc => !!v && typeof v === 'object' && !Array.isArray(v)
/** An Extended JSON value ({ $oid }, { $date }…): one cell, never opened. */
const isWrapper = (v: Doc) => {
  const keys = Object.keys(v)
  return keys.length > 0 && keys.every((k) => k.startsWith('$'))
}
/**
 * A row as the results table shows it: a joined document opened into a column per field, "c.name"
 * beside "orderNo" — only the joins' (`aliases`), never _id nor a document of the collection
 * itself (review I3: an object _id lost its Open). Values, arrays and Extended JSON stay one cell;
 * a field already there keeps its value, and no key reaches the result's prototype (review M4).
 */
export function flatRow(row: Doc, aliases: readonly string[], nested: readonly string[] = []): Doc {
  const out = Object.create(null) as Doc
  const put = (name: string, value: unknown) => {
    if (!Object.prototype.hasOwnProperty.call(out, name)) out[name] = value
  }
  const open = (value: Doc, prefix: string, depth: number) => {
    for (const [key, v] of Object.entries(value)) {
      const name = `${prefix}.${key}`
      if (isPlain(v) && !isWrapper(v) && Object.keys(v).length && depth < 3) open(v, name, depth + 1)
      else put(name, v)
    }
  }
  for (const [key, value] of Object.entries(row)) {
    if (
      (aliases.includes(key) || nested.includes(key)) &&
      key !== '_id' &&
      isPlain(value) &&
      !isWrapper(value) &&
      Object.keys(value).length
    )
      open(value, key, 1)
    else put(key, value)
  }
  return out
}

/** The names a query's joins put their documents under ("c" of JOIN customers c). */
export function joinAliases(model: Model): string[] {
  if (model.kind !== 'aggregate') return []
  return model.pipeline.flatMap((stage) => {
    const lookup = stage.$lookup as Doc | undefined
    return typeof lookup?.as === 'string' ? [lookup.as] : []
  })
}

/**
 * The collection field a joined column comes from ("c.email" → "customers.email"), or null for a
 * column of the open collection (user request 2026-10-10: the heading says where it comes from).
 */
export function columnSource(column: string, model: Model): string | null {
  if (model.kind !== 'aggregate') return null
  const dot = column.indexOf('.')
  if (dot <= 0) return null
  const alias = column.slice(0, dot)
  for (const stage of model.pipeline) {
    const lookup = stage.$lookup as Doc | undefined
    if (lookup?.as === alias && typeof lookup.from === 'string') return `${lookup.from}${column.slice(dot)}`
  }
  return null
}

export interface Head {
  label: string
  /** The collection field the column comes from, or null for a computed one. */
  note: string | null
}

/**
 * A join's column headings (user request 2026-10-10: "c.name has its prefix, total has not"): each
 * as the SELECT writes it — "o.orderNo", "c.name", an AS name — with the collection field it comes
 * from; the open collection's columns too. Null for a query without a join, or SQL that does not
 * read: their headings are the result's own keys.
 */
export function columnHeads(sql: string): ((key: string) => Head) | null {
  let q: ReturnType<typeof parse>
  try {
    q = parse(sql)
  } catch {
    return null
  }
  if (!q.join) return null
  const base = { name: q.from.name, alias: q.from.alias }
  const joined = { name: q.join.table.name, as: q.join.table.alias ?? q.join.table.name }
  const strip = (name: string, prefix: string) =>
    name.startsWith(`${prefix}.`) ? name.slice(prefix.length + 1) : null
  const named = new Map<string, Head>()
  if (q.columns !== '*')
    for (const item of q.columns) {
      if (item.expr.t !== 'col') continue
      const written = item.expr.name
      // As the translator reads it (review I1: a self-join's columns were read the other way).
      const { side, rest } = columnSide(q, written)
      const key = item.alias ?? (side === 'join' ? `${joined.as}.${rest}` : rest)
      named.set(key, {
        label: item.alias ?? written,
        note: `${side === 'join' ? joined.name : base.name}.${rest}`,
      })
    }
  return (key) => {
    const known = named.get(key)
    if (known) return known
    // A computed column of a listed SELECT (COUNT(*) AS n): no collection field.
    if (q.columns !== '*') return { label: key, note: null }
    const rest = strip(key, joined.as)
    if (rest !== null) return { label: key, note: `${joined.name}.${rest}` }
    return { label: base.alias ? `${base.alias}.${key}` : key, note: `${base.name}.${key}` }
  }
}

/**
 * The documents a query's last projection makes of dotted names of the open collection
 * ("o.shipping.city" → shipping): opened into their columns like a join's (review M2).
 */
export function nestedKeys(model: Model): string[] {
  const aliases = joinAliases(model)
  const tops = columnOrder(model)
    .filter((key) => key.includes('.'))
    .map((key) => key.slice(0, key.indexOf('.')))
    .filter((top) => top !== '_id' && !aliases.includes(top))
  return [...new Set(tops)]
}
