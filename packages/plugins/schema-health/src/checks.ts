// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Plugins wave 2 (schema health): what a sample of documents, their sizes and the collection's
 * indexes say about the schema — the anti-patterns MongoDB's documentation names — as findings with
 * a severity. The thresholds are this plugin's own defaults (Atlas does not publish its own); the
 * page lists them.
 */
export type Doc = Record<string, unknown>
export type Severity = 'high' | 'warning' | 'info'
export interface Finding {
  id: string
  severity: Severity
  path?: string
  values: Record<string, string | number>
}

export const LIMITS = {
  /** Document sizes (MongoDB's limit is 16 MB). */
  docWarn: 1024 * 1024,
  docHigh: 8 * 1024 * 1024,
  /** Elements of one array: an array that keeps growing. */
  arrayWarn: 1000,
  arrayHigh: 10_000,
  /** Levels of nesting (MongoDB's limit is 100). */
  depthWarn: 20,
  /** Fields in one document. */
  fieldsWarn: 200,
  /** Indexes on one collection (MongoDB's limit is 64). */
  indexesWarn: 20,
} as const

const int = (n: number) => ({ $numberInt: String(n) })

/** A number from canonical Extended JSON (or JSON), or null. */
export function numberOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const text = o.$numberInt ?? o.$numberLong ?? o.$numberDouble ?? o.$numberDecimal
  return typeof text === 'string' && Number.isFinite(Number(text)) ? Number(text) : null
}

const WRAPPERS: Record<string, string> = {
  $numberInt: 'number',
  $numberLong: 'number',
  $numberDouble: 'number',
  $numberDecimal: 'number',
  $date: 'date',
  $oid: 'objectId',
  $binary: 'binary',
  $timestamp: 'timestamp',
  $regularExpression: 'regex',
  $minKey: 'minKey',
  $maxKey: 'maxKey',
  $code: 'javascript',
  $symbol: 'symbol',
  $dbPointer: 'dbPointer',
  $undefined: 'undefined',
}

/** A canonical Extended JSON value's BSON type, as people name it. */
function typeOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'string') return 'string'
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'number') return 'number'
  if (typeof v !== 'object') return 'other'
  const keys = Object.keys(v)
  if (keys.length >= 1 && keys.every((k) => k.startsWith('$'))) {
    const t = WRAPPERS[keys[0]!]
    if (t) return t
  }
  return 'object'
}

const isWrapper = (v: unknown) => {
  const t = typeOf(v)
  return t !== 'object' && t !== 'array'
}

const MAX_WALK = 120

/** What a sample of documents holds: its arrays, the types of its fields, its depth and width. */
export interface Survey {
  /** The longest array seen at each path. */
  arrays: Map<string, number>
  /** At each path, how many sampled documents hold each type there (null aside). */
  types: Map<string, Map<string, number>>
  deepest: number
  widest: number
  /** Paths a query cannot name: a field name on the way has a dot, starts with $, or is empty. */
  unqueryable: Set<string>
}

export function surveySample(documents: Doc[]): Survey {
  const arrays = new Map<string, number>()
  const types = new Map<string, Map<string, number>>()
  const unqueryable = new Set<string>()
  let deepest = 0
  let widest = 0
  for (const doc of documents) {
    let fields = 0
    // A type counts once per document, however many array elements hold it.
    const here = new Map<string, Set<string>>()
    const walk = (value: unknown, path: string, depth: number, odd: boolean) => {
      if (depth > MAX_WALK) return
      if (Array.isArray(value)) {
        deepest = Math.max(deepest, depth)
        arrays.set(path, Math.max(arrays.get(path) ?? 0, value.length))
        for (const item of value)
          if (item && typeof item === 'object' && !isWrapper(item)) walk(item, path, depth + 1, odd)
        return
      }
      if (value && typeof value === 'object' && !isWrapper(value)) {
        for (const [k, v] of Object.entries(value)) {
          fields++
          const child = path ? `${path}.${k}` : k
          const oddChild = odd || k === '' || k.includes('.') || k.startsWith('$')
          if (oddChild) unqueryable.add(child)
          deepest = Math.max(deepest, depth + 1)
          const t = typeOf(v)
          if (t !== 'null') {
            let seen = here.get(child)
            if (!seen) here.set(child, (seen = new Set()))
            seen.add(t)
          }
          if (v && typeof v === 'object' && !isWrapper(v)) walk(v, child, depth + 1, oddChild)
        }
      }
    }
    walk(doc, '', 0, false)
    widest = Math.max(widest, fields)
    for (const [path, seen] of here) {
      let counts = types.get(path)
      if (!counts) types.set(path, (counts = new Map()))
      for (const t of seen) counts.set(t, (counts.get(t) ?? 0) + 1)
    }
  }
  return { arrays, types, deepest, widest, unqueryable }
}

/** The types a field holds in the sample, the most common first. */
export function typeShares(survey: Survey, path: string): Array<{ type: string; count: number }> {
  return [...(survey.types.get(path) ?? new Map<string, number>())]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
}

/**
 * Large arrays (by path, the largest seen), deep nesting, documents with very many fields, and
 * fields holding more than one type (null aside), in a sample of documents.
 */
export function sampleFindings(documents: Doc[]): Finding[] {
  return surveyFindings(surveySample(documents))
}

export function surveyFindings(survey: Survey): Finding[] {
  const { arrays, types, deepest, widest } = survey
  const out: Finding[] = []
  const large = [...arrays.entries()]
    .filter(([, length]) => length > LIMITS.arrayWarn)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
  for (const [path, length] of large)
    out.push({
      id: 'largeArray',
      severity: length > LIMITS.arrayHigh ? 'high' : 'warning',
      path,
      values: { length },
    })
  if (deepest > LIMITS.depthWarn)
    out.push({ id: 'deepNesting', severity: 'warning', values: { depth: deepest } })
  if (widest > LIMITS.fieldsWarn)
    out.push({ id: 'manyFields', severity: 'warning', values: { fields: widest } })
  const mixed = [...types.entries()]
    .filter(([, seen]) => seen.size > 1)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, 20)
  for (const [path, seen] of mixed)
    out.push({
      id: 'mixedTypes',
      severity: 'info',
      path,
      values: { types: [...seen.keys()].sort().join(', ') },
    })
  return out
}

/** The names the $type query operator knows for the types this file names. */
const TYPE_ALIASES: Record<string, string> = {
  number: 'number',
  string: 'string',
  bool: 'bool',
  date: 'date',
  objectId: 'objectId',
  binary: 'binData',
  timestamp: 'timestamp',
  regex: 'regex',
  minKey: 'minKey',
  maxKey: 'maxKey',
  javascript: 'javascript',
  symbol: 'symbol',
  dbPointer: 'dbPointer',
  undefined: 'undefined',
  object: 'object',
  array: 'array',
}

/**
 * A Documents filter selecting the documents a finding is about, or null where none would select
 * them exactly: the rarer types of a mixed field, arrays past the threshold, documents over the size.
 */
export function showFilter(finding: Finding, survey: Survey | null): Doc | null {
  if (finding.id === 'largeDocuments') {
    const limit = finding.severity === 'high' ? LIMITS.docHigh : LIMITS.docWarn
    return { $expr: { $gt: [{ $bsonSize: '$$ROOT' }, int(limit)] } }
  }
  const path = finding.path
  if (!survey || !path || survey.unqueryable.has(path)) return null
  if (finding.id === 'largeArray') return { [`${path}.${LIMITS.arrayWarn}`]: { $exists: true } }
  if (finding.id !== 'mixedTypes') return null
  const shares = typeShares(survey, path)
  if (shares.length < 2) return null
  const rarer = shares.slice(1).map((s) => s.type)
  // $type on an array matches its elements too: another type would pick arrays of it as well.
  if (shares.some((s) => s.type === 'array') && rarer.some((t) => t !== 'array')) return null
  const names = rarer.map((t) => TYPE_ALIASES[t])
  if (names.some((n) => n === undefined)) return null
  return { [path]: { $type: names.length === 1 ? names[0]! : (names as string[]).sort() } }
}

/** Every document's size, measured by the server, over a sample of the collection (MongoDB 4.4+). */
export function sizePipeline(sample: number): Doc[] {
  const over = (limit: number) => ({ $sum: { $cond: [{ $gt: ['$s', int(limit)] }, int(1), int(0)] } })
  return [
    { $sample: { size: int(sample) } },
    { $project: { _id: 0, s: { $bsonSize: '$$ROOT' } } },
    {
      $group: {
        _id: null,
        count: { $sum: int(1) },
        avg: { $avg: '$s' },
        max: { $max: '$s' },
        over1mb: over(LIMITS.docWarn),
        over8mb: over(LIMITS.docHigh),
      },
    },
  ]
}

/** Large documents, from the size summary (none when there is no summary). */
export function sizeFindings(summary: Doc | null): Finding[] {
  if (!summary) return []
  const max = numberOf(summary.max) ?? 0
  const high = numberOf(summary.over8mb) ?? 0
  const warn = numberOf(summary.over1mb) ?? 0
  if (high > 0) return [{ id: 'largeDocuments', severity: 'high', values: { count: high, max } }]
  if (warn > 0) return [{ id: 'largeDocuments', severity: 'warning', values: { count: warn, max } }]
  return []
}

export interface IndexInfo {
  name: string
  key: Record<string, unknown>
  options: Record<string, unknown>
  usage: { ops: number; since: string } | null
}

/** An index's key as ascending/descending directions, or null for a special one (text, 2dsphere…). */
function directions(key: Record<string, unknown>): Array<[string, number]> | null {
  const out: Array<[string, number]> = []
  for (const [field, v] of Object.entries(key)) {
    const d = numberOf(v)
    if (d !== 1 && d !== -1) return null
    out.push([field, d])
  }
  return out
}

/** What an index does beyond its keys, which another index's keys would not do. */
const special = (ix: IndexInfo) =>
  ['unique', 'partialFilterExpression', 'sparse', 'collation', 'expireAfterSeconds', 'hidden'].some(
    (o) => ix.options[o] !== undefined && ix.options[o] !== false,
  )

/** Too many indexes, unused ones (not _id), and ones whose keys begin another's. */
export function indexFindings(indexes: IndexInfo[]): Finding[] {
  const out: Finding[] = []
  if (indexes.length > LIMITS.indexesWarn)
    out.push({ id: 'manyIndexes', severity: 'warning', values: { count: indexes.length } })
  for (const ix of indexes)
    // A unique or TTL index works without queries: never "unused" (review M3).
    if (
      ix.name !== '_id_' &&
      ix.usage &&
      ix.usage.ops === 0 &&
      !ix.options.unique &&
      ix.options.expireAfterSeconds === undefined
    )
      out.push({ id: 'unusedIndex', severity: 'info', values: { index: ix.name, since: ix.usage.since } })
  for (const a of indexes) {
    if (a.name === '_id_' || special(a)) continue
    const ka = directions(a.key)
    if (!ka) continue
    const covered = indexes.find((b) => {
      // A hidden index, or one of another collation, cannot serve a's queries (review M4).
      if (b === a || b.options.partialFilterExpression !== undefined || b.options.sparse || b.options.hidden)
        return false
      if (JSON.stringify(b.options.collation ?? null) !== JSON.stringify(a.options.collation ?? null))
        return false
      const kb = directions(b.key)
      if (!kb || kb.length <= ka.length) return false
      const prefix = kb.slice(0, ka.length)
      if (prefix.some(([f], i) => f !== ka[i]![0])) return false
      // Read backwards, an index serves the opposite directions as well.
      const same = prefix.every(([, d], i) => d === ka[i]![1])
      const opposite = prefix.every(([, d], i) => d === -ka[i]![1])
      return same || opposite
    })
    if (covered)
      out.push({ id: 'redundantIndex', severity: 'info', values: { index: a.name, covered: covered.name } })
  }
  return out
}

const RANK: Record<Severity, number> = { high: 0, warning: 1, info: 2 }

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => RANK[a.severity] - RANK[b.severity])
}
