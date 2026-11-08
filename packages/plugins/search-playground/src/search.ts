// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Plugins wave 4 (spec §5): the pipelines the search playground runs on the collection's search
 * indexes — a full-text `$search` with its score and highlights, a `$vectorSearch` with its score —
 * and what it reads of the answers. The app runs them as the user, read-only, the search stage first.
 */
export interface SearchField {
  path: string
  type: string
  numDimensions?: number
  similarity?: string
}
export interface SearchIndex {
  name: string
  type: 'search' | 'vectorSearch'
  status: string
  queryable: boolean
  dynamic: boolean
  fields: SearchField[]
}
export type SearchIndexList =
  | { supported: true; indexes: SearchIndex[] }
  | { supported: false; reason: 'not_enabled' | 'unsupported'; indexes: [] }

type Stage = Record<string, unknown>

/** MongoDB's limit on a vector's dimensions. */
export const MAX_DIMENSIONS = 8192
export const MAX_LIMIT = 100
/** A path that reads every field the index maps. */
export const ALL = '*'

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** The text fields a full-text search may read; every one for a dynamic index. */
export function textPaths(index: SearchIndex): string[] {
  if (index.type !== 'search') return []
  const paths = index.fields
    .filter((f) => f.type === 'string')
    .map((f) => f.path)
    .sort(byName)
  return index.dynamic ? [ALL, ...paths] : paths
}

/** The vector fields of a vector search index. */
export function vectorPaths(index: SearchIndex): Array<{ path: string; numDimensions: number | null }> {
  if (index.type !== 'vectorSearch') return []
  return index.fields
    .filter((f) => f.type === 'vector')
    .map((f) => ({ path: f.path, numDimensions: f.numDimensions ?? null }))
}

export function searchPipeline(o: {
  index: string
  query: string
  /** A field, several, or ALL (every field a dynamic index maps). */
  path: string | string[]
  fuzzy: 0 | 1 | 2
  highlight: boolean
  limit: number
}): Stage[] {
  const path =
    o.path === ALL ? { wildcard: '*' } : Array.isArray(o.path) && o.path.length === 1 ? o.path[0]! : o.path
  const text: Stage = { query: o.query, path, ...(o.fuzzy ? { fuzzy: { maxEdits: o.fuzzy } } : {}) }
  const search: Stage = { index: o.index, text, ...(o.highlight ? { highlight: { path } } : {}) }
  const meta: Stage = { _score: { $meta: 'searchScore' } }
  if (o.highlight) meta._highlights = { $meta: 'searchHighlights' }
  return [{ $search: search }, { $limit: o.limit }, { $set: meta }]
}

export function vectorPipeline(o: {
  index: string
  path: string
  vector: number[]
  numCandidates: number
  limit: number
  filter: Record<string, unknown> | null
}): Stage[] {
  return [
    {
      $vectorSearch: {
        index: o.index,
        path: o.path,
        queryVector: o.vector,
        numCandidates: o.numCandidates,
        limit: o.limit,
        ...(o.filter ? { filter: o.filter } : {}),
      },
    },
    { $set: { _score: { $meta: 'vectorSearchScore' } } },
  ]
}

const NUMBER_KEYS = ['$numberDouble', '$numberInt', '$numberLong', '$numberDecimal']
/** A number as canonical Extended JSON has it, or null. */
function numberOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const keys = Object.keys(v)
  if (keys.length !== 1 || !NUMBER_KEYS.includes(keys[0]!)) return null
  const raw = (v as Record<string, unknown>)[keys[0]!]
  if (typeof raw !== 'string' || !/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(raw.trim())) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * A vector: a list of numbers as a document holds it (canonical Extended JSON) or as pasted — JSON
 * or numbers split by commas or spaces. A BSON vector (binary) is not read: null.
 */
export function vectorOf(value: unknown): number[] | null {
  const bson = bsonVector(value)
  if (bson !== undefined) return bson
  let list: unknown = value
  if (typeof value === 'string') {
    const text = value.trim()
    if (text.startsWith('[')) {
      try {
        list = JSON.parse(text)
      } catch {
        return null
      }
    } else
      list = text
        ? text
            .split(/[\s,]+/)
            .filter(Boolean)
            .map((s) => (/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s) ? Number(s) : NaN))
        : []
  }
  if (!Array.isArray(list) || !list.length || list.length > MAX_DIMENSIONS) return null
  const out: number[] = []
  for (const item of list) {
    const n = numberOf(item)
    if (n === null) return null
    out.push(n)
  }
  return out
}

/**
 * Final review Minor 15: a BSON vector (binary subtype 9: a dtype byte, a padding byte, the values),
 * as Atlas recommends storing embeddings — float32 or int8 read; a packed bit vector is not (null).
 * Undefined for a value that is no BSON vector.
 */
function bsonVector(value: unknown): number[] | null | undefined {
  if (!value || typeof value !== 'object' || !('$binary' in value)) return undefined
  const binary = (value as { $binary: unknown }).$binary
  if (!binary || typeof binary !== 'object') return null
  const { base64, subType } = binary as { base64?: unknown; subType?: unknown }
  if (typeof base64 !== 'string' || String(subType).padStart(2, '0') !== '09') return null
  let raw: string
  try {
    raw = atob(base64)
  } catch {
    return null
  }
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0))
  if (bytes.length < 3 || bytes[1] !== 0) return null
  const body = bytes.slice(2)
  let out: number[]
  if (bytes[0] === 0x27) {
    if (body.length % 4) return null
    out = [...new Float32Array(body.buffer, body.byteOffset, body.length / 4)]
  } else if (bytes[0] === 0x03) out = [...new Int8Array(body.buffer, body.byteOffset, body.length)]
  else return null
  return out.length && out.length <= MAX_DIMENSIONS && out.every(Number.isFinite) ? out : null
}

/** The value at a dotted path of a document (own keys only), or undefined. */
export function valueAt(doc: unknown, path: string): unknown {
  let at: unknown = doc
  for (const key of path.split('.')) {
    if (!at || typeof at !== 'object' || Array.isArray(at) || !Object.hasOwn(at, key)) return undefined
    at = (at as Record<string, unknown>)[key]
  }
  return at
}

/** A filter as typed: a JSON object, or nothing at all. */
export function filterOf(text: string): { ok: true; filter: Record<string, unknown> | null } | { ok: false } {
  if (!text.trim()) return { ok: true, filter: null }
  try {
    const v: unknown = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v)
      ? { ok: true, filter: v as Record<string, unknown> }
      : { ok: false }
  } catch {
    return { ok: false }
  }
}

/** Highlights as MongoDB gives them, read as text and hits (shown as text, never as markup). */
export function highlightParts(
  value: unknown,
): Array<{ path: string; parts: Array<{ text: string; hit: boolean }> }> {
  if (!Array.isArray(value)) return []
  const out: Array<{ path: string; parts: Array<{ text: string; hit: boolean }> }> = []
  for (const h of value.slice(0, 20)) {
    if (!h || typeof h !== 'object') continue
    const { path, texts } = h as Record<string, unknown>
    if (typeof path !== 'string' || !Array.isArray(texts)) continue
    const parts = texts
      .filter(
        (t): t is { value: string; type: unknown } =>
          !!t && typeof t === 'object' && typeof (t as { value?: unknown }).value === 'string',
      )
      .map((t) => ({ text: t.value, hit: t.type === 'hit' }))
    if (parts.length) out.push({ path, parts })
  }
  return out
}

/** A score as canonical Extended JSON gives it, or null. */
export const scoreOf = (v: unknown): number | null => numberOf(v)
