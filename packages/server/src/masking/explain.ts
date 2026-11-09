// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { MASK } from './document'
import { isDocument } from './gate/values'
import type { GateDeps } from './gate/context'

/** Keys of an explain answer that hold values a query or a definition wrote. */
const VALUE_KEYS = new Set([
  'parsedQuery',
  'filter',
  'indexBounds',
  'command',
  'originalCommand',
  'pipeline',
  'let',
  'query',
  'restrictSearchWithMatch',
  'startWith',
  'near',
  // A projection's spec: its literals too (seventh review, M1/M2).
  'transformBy',
  // A clustered scan's bounds: _id values, numbers too (ninth review, M9).
  'minRecord',
  'maxRecord',
])

/**
 * Sixth review: the strings an explain answer keeps are names, never values. Every other string is
 * hidden, however MongoDB writes it (an SBE plan's slots, stages, expressions and index key strings
 * included): what is not known to be a name is not shown.
 */
const NAME_KEYS = new Set([
  'stage',
  'indexName',
  'indexesUsed',
  'direction',
  'scanDirection',
  'namespace',
  'foreignCollection',
  'localField',
  'foreignField',
  'asField',
  'scanFieldNames',
  'projectFields',
  'fieldBehavior',
  'strategy',
  'shardName',
  'mergeShardId',
  'mergeType',
  'type',
  'queryFramework',
  'explainVersion',
  'version',
  'gitVersion',
  'planCacheKey',
  'planCacheShapeHash',
  'queryHash',
  'queryShapeHash',
])

/** An index's key pattern and multikey paths, whole names, where a plan node names its index. */
const INDEX_TREES = new Set(['keyPattern', 'multiKeyPaths'])

/** The names a join stage is read by (the advice asks for the joined collection's indexes). */
const JOIN_NAMES = new Map<string, ReadonlySet<string>>([
  ['$lookup', new Set(['from', 'localField', 'foreignField', 'as'])],
  ['$graphLookup', new Set(['from', 'connectFromField', 'connectToField', 'as', 'depthField'])],
  ['$unionWith', new Set(['coll'])],
])

/**
 * Keys whose whole value is MongoDB's own text, which can quote a value anywhere in it: hidden
 * whole at any depth. A partial run's reason (fourth review); an SBE plan's slots and stages (fifth).
 */
const OPAQUE_KEYS = new Set(['errorMessage', 'slotBasedPlan'])

/** Where the servers are: hidden as error messages hide them. */
const LOCATION_KEYS = new Set(['host', 'port', 'connectionString'])

/**
 * Figures that measure data, in whatever shape (one per accumulator too): each tells the length of
 * what was read, sorted, grouped or spilled, and so does whether a run went to disk (final review
 * M1; sixth and seventh reviews). A memory limit is hidden with them: harmless. ("mem" alone would
 * match executionTi*meM*illis.)
 */
const SIZE_KEY = /bytes|size|memory|memusage|memlimit|spill|disk/i

/** Deeper than any real plan: what lies below is hidden, and the walk never runs out of stack. */
const MAX_DEPTH = 1000

/** A figure: a number (of the driver's types, a decimal aside) or a flag. */
const isFigure = (v: unknown) =>
  typeof v === 'number' ||
  typeof v === 'boolean' ||
  typeof v === 'bigint' ||
  (typeof v === 'object' &&
    v !== null &&
    ['Int32', 'Long', 'Double'].includes(String((v as { _bsontype?: unknown })._bsontype)))

/** A field reference ("$a.b", "$$ROOT.c"): what a value position keeps, as it names a field. */
const FIELD_REF = /^\$\$?[A-Za-z_][\w.]*$/

/** Where only literals are written (a filter, its bounds, a view's $match): no string is kept. */
const LITERAL_KEYS = new Set([
  'filter',
  'parsedQuery',
  'indexBounds',
  'query',
  '$match',
  'restrictSearchWithMatch',
  // $literal and $const hold literals wherever they are (ninth review, M8).
  '$literal',
  '$const',
])

/** An object's entries, a "__proto__" key aside (JSON.parse makes one: it would set the prototype). */
const entries = (v: object) => Object.entries(v).filter(([k]) => k !== '__proto__')

/** Every leaf hidden, the keys kept. */
function blank(v: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return MASK
  if (Array.isArray(v)) return v.map((x) => blank(x, depth + 1))
  if (isDocument(v)) return Object.fromEntries(entries(v).map(([k, x]) => [k, blank(x, depth + 1)]))
  return v === null || v === undefined ? v : MASK
}

/**
 * Every value hidden, keys and field references kept (none where only literals are). A "$cursor"
 * here is a value too: a view's literal can look like one (ninth review, M7).
 */
function hide(v: unknown, key: string | undefined, depth: number, literal = false): unknown {
  if (v === null || v === undefined) return v
  if (depth > MAX_DEPTH) return MASK
  if (key !== undefined && OPAQUE_KEYS.has(key)) return MASK
  const literals = literal || (key !== undefined && LITERAL_KEYS.has(key))
  if (typeof v === 'string') return !literals && FIELD_REF.test(v) ? v : MASK
  if (typeof v !== 'object') return MASK
  if (Array.isArray(v)) return v.map((x) => hide(x, key, depth + 1, literals))
  if (!isDocument(v)) return MASK
  const out: Record<string, unknown> = {}
  for (const [k, value] of entries(v)) out[k] = hide(value, k, depth + 1, literals)
  return out
}

/** A join stage's names kept (a collection's, as a string or as { db, coll }); the rest hidden. */
function join(stage: string, v: unknown, depth: number): unknown {
  if (!isDocument(v)) return hide(v, stage, depth)
  const names = JOIN_NAMES.get(stage)!
  const out: Record<string, unknown> = {}
  for (const [k, value] of entries(v)) {
    const named =
      names.has(k) &&
      (typeof value === 'string' ||
        (isDocument(value) && Object.values(value).every((x) => typeof x === 'string')))
    out[k] = named ? value : hide(value, k, depth + 1)
  }
  return out
}

function mask(raw: unknown, key: string | undefined, depth: number): unknown {
  if (depth > MAX_DEPTH) return MASK
  if (Array.isArray(raw)) return raw.map((x) => mask(x, key, depth + 1))
  if (typeof raw === 'string') return key !== undefined && NAME_KEYS.has(key) ? raw : MASK
  if (raw === null || raw === undefined || isFigure(raw)) return raw
  if (!isDocument(raw)) return MASK
  // A key pattern names fields where a plan node names its index; the server's settings are the
  // server's where it says who it is.
  const indexed = 'stage' in raw || 'indexName' in raw
  const server = 'serverInfo' in raw
  const out: Record<string, unknown> = {}
  for (const [k, v] of entries(raw)) {
    if (INDEX_TREES.has(k) && indexed) out[k] = v
    else if (k === 'serverParameters' && server) out[k] = v
    else if (SIZE_KEY.test(k)) out[k] = blank(v, depth + 1)
    else if (OPAQUE_KEYS.has(k) || LOCATION_KEYS.has(k)) out[k] = MASK
    else if (JOIN_NAMES.has(k)) out[k] = join(k, v, depth + 1)
    else if (VALUE_KEYS.has(k) || (k.startsWith('$') && k !== '$cursor')) out[k] = hide(v, k, depth + 1)
    else out[k] = mask(v, k, depth + 1)
  }
  return out
}

/**
 * Phase 3c §4.3: an explain answer for a restricted user. The plan's shape, stage names, index
 * names and key patterns, and its counts stay; a value a query or a definition wrote, a text not
 * known to be a name, a BSON value that is no figure, a figure that measures data, and where the
 * servers are become "***" (the user's own literals too: over-masking is harmless). A plan that
 * reads an index holding personal data is not masked but refused (personalPlan).
 */
export function maskExplain(raw: unknown): unknown {
  return mask(raw, undefined, 0)
}

/** A time-series collection's plan reads its buckets: their rules are the collection's. */
const BUCKETS = 'system.buckets.'

/** "db.coll", or a collection of the request's database. */
const qualified = (db: string, name: string) => (name.includes('.') ? name : `${db}.${name}`)

/** Why a plan is not explained to a restricted user, and the collection it is about. */
export interface PlanRefusal {
  ns: string
  /** An index holding personal data; more collections than are followed; an index not found. */
  why: 'index' | 'too_many' | 'unplaced'
}

/** "db.coll" as a user knows it: a time-series collection's buckets are the collection. */
const shown = (ns: string) => ns.replace(`.${BUCKETS}`, '.')

/**
 * Eighth review: whether, and why, a plan is not explained to a restricted user, or null. A plan
 * reading an index that holds a path personal there tells, through more counts than can be named
 * (keys, works, an SBE scan's own nReturned, a dedup), how many values a document holds at that
 * path, and through its multikey paths that one holds an array.
 *
 * The namespaces are the request's, each one MongoDB's answer names, and each one a join reads, at
 * any depth (a join's pipeline, a $facet, a view's pipeline; a join's `from` is a collection of the
 * database it is read in, a dot in its name or not); a view is followed to its source. Nothing else
 * the user wrote (the echoed command, a filter, a stage's spec) is read for a namespace. An index is
 * known by its key pattern or by its name, looked up as the gate looks indexes up. A field is
 * personal where a rule matches it; a wildcard index (`$**`, `$_path`) also where a rule is below
 * the path it scans. In doubt it is refused: a name found nowhere while any rule applies, a
 * collection with rules that exists and lists no index, a view with rules of its own (its plan names
 * its source's paths), a time-series collection with rules (its keys are its buckets'), a text index,
 * and a plan reading more collections than are followed.
 */
export async function planRefusal(
  answer: unknown,
  deps: GateDeps,
  db: string,
  coll: string,
): Promise<PlanRefusal | null> {
  // Tenth review (M5): where no rule applies, nothing is looked up; a key vault's built-in rules
  // apply with none (eleventh review, M1).
  if (!deps.masker.anyRules && !deps.masker.anyInDb(db)) return null
  const namespaces = new Set([`${db}.${coll}`])
  // Each index's own key fields: a wildcard one is judged by its own paths (eleventh review, M5).
  const patterns: string[][] = []
  const names = new Set<string>()
  const target = (stage: string, v: unknown, into: Set<string>, inDb: string): string => {
    const name = isDocument(v) ? (stage === '$unionWith' ? v.coll : v.from) : v
    if (typeof name === 'string') into.add(`${inDb}.${name}`)
    else if (isDocument(name) && typeof name.db === 'string' && typeof name.coll === 'string') {
      into.add(`${name.db}.${name.coll}`)
      // A nested join's own target is read in the joined database (eleventh review, nit).
      return name.db
    }
    return inDb
  }
  // Tenth review (I1): the joins in a join's own pipeline, a $facet's, and a view's, at any depth.
  const joinsIn = (stages: unknown, into: Set<string>, inDb: string, depth: number) => {
    if (depth > MAX_DEPTH || !Array.isArray(stages)) return
    for (const step of stages) {
      if (!isDocument(step)) continue
      for (const [k, spec] of entries(step)) {
        if (JOIN_NAMES.has(k)) {
          const joinedDb = target(k, spec, into, inDb)
          if (isDocument(spec)) joinsIn(spec.pipeline, into, joinedDb, depth + 1)
        } else if (k === '$facet' && isDocument(spec))
          for (const branch of Object.values(spec)) joinsIn(branch, into, inDb, depth + 1)
      }
    }
  }
  const walk = (v: unknown, depth: number) => {
    if (depth > MAX_DEPTH) return
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1))
    if (!isDocument(v)) return
    for (const [k, x] of entries(v)) {
      // What the user wrote: a stage's spec, the command, a filter. Only the joins in it are read,
      // and a $unionWith's own sub-plans.
      if (k.startsWith('$') && k !== '$cursor') {
        joinsIn([{ [k]: x }], namespaces, db, depth + 1)
        if (k === '$unionWith' && isDocument(x) && Array.isArray(x.pipeline))
          for (const step of x.pipeline)
            if (isDocument(step) && '$cursor' in step) walk(step.$cursor, depth + 1)
        continue
      }
      if (VALUE_KEYS.has(k)) continue
      if ((k === 'namespace' || k === 'foreignCollection') && typeof x === 'string')
        namespaces.add(qualified(db, x))
      if ((k === 'keyPattern' || k === 'indexKeyPattern') && isDocument(x)) patterns.push(Object.keys(x))
      // An IDHACK writes its key pattern as text: '{ _id: 1 }', a name quoted or not.
      if ((k === 'keyPattern' || k === 'indexKeyPattern') && typeof x === 'string')
        patterns.push([...x.matchAll(/"?([^\s{},:"]+)"?\s*:/g)].map((found) => found[1]!))
      if (k === 'indexName' && typeof x === 'string') names.add(x)
      if (k === 'indexesUsed' && Array.isArray(x)) for (const n of x) if (typeof n === 'string') names.add(n)
      walk(x, depth + 1)
    }
  }
  walk(answer, 0)
  if (patterns.length === 0 && names.size === 0) return null
  const found = new Set<string>()
  const ruled: string[] = []
  const queue = [...namespaces]
  const seen = new Set<string>()
  while (queue.length) {
    const ns = queue.shift()!
    if (seen.has(ns)) continue
    // Tenth review (I2): a plan reading more namespaces than are followed is refused, not passed.
    if (seen.size >= MAX_NAMESPACES) return { ns: shown(ns), why: 'too_many' }
    seen.add(ns)
    const dot = ns.indexOf('.')
    if (dot <= 0) continue
    const nsDb = ns.slice(0, dot)
    let nsColl = ns.slice(dot + 1)
    const bucketed = nsColl.startsWith(BUCKETS)
    if (bucketed) nsColl = nsColl.slice(BUCKETS.length)
    const rules = deps.masker.forNs(nsDb, nsColl)
    const here = `${nsDb}.${nsColl}`
    const refused = { ns: here, why: 'index' } as const
    const view = await deps.view(nsDb, nsColl)
    if (view) {
      // A view's rules name its own fields, its plan its source's: with rules, in doubt.
      if (rules.any) return refused
      queue.push(`${nsDb}.${view.viewOn}`)
      const joined = new Set<string>()
      joinsIn(view.pipeline, joined, nsDb, 0)
      queue.push(...joined)
      continue
    }
    const kind = deps.kind ? await deps.kind(nsDb, nsColl) : undefined
    const indexes = await deps.indexes(nsDb, nsColl)
    const keys = [...patterns]
    for (const index of indexes)
      if (typeof index.name === 'string' && names.has(index.name)) {
        found.add(index.name)
        if (isDocument(index.key)) keys.push(Object.keys(index.key))
      }
    if (!rules.any) continue
    ruled.push(here)
    // A time-series collection's keys are its buckets' (meta.*, control.*): in doubt.
    if (bucketed || kind === 'timeseries') return refused
    // A collection with rules that exists and lists no index: a name of the plan may be its.
    if (kind !== 'missing' && names.size > 0 && indexes.length === 0) return { ns: here, why: 'unplaced' }
    for (const pattern of keys) {
      const wildcardIndex = pattern.includes('$_path')
      for (const field of pattern) {
        if (field === '$_path') continue
        const wildcard = wildcardIndex || field.endsWith('$**')
        const path = field
          .replace(/\$\*\*$/, '')
          .split('.')
          .filter((s) => s !== '')
        const [first] = path
        if (path.length === 0 || first === '_fts' || first === '_ftsx') return refused
        // Where the gate cannot tell a collection's kind, a time-series one by its keys' names.
        if (kind === undefined && (first === 'meta' || first === 'control')) return refused
        if (rules.matches(path) || (wildcard && rules.under(path))) return refused
      }
    }
  }
  // An index the plan names, found in none of the namespaces read: rules apply somewhere, in doubt.
  if ([...names].some((n) => !found.has(n))) return { ns: ruled[0] ?? `${db}.${coll}`, why: 'unplaced' }
  return null
}

/** The collection a plan's refusal is about, whatever the reason, or null (the AI context's check). */
export const personalPlan = async (
  answer: unknown,
  deps: GateDeps,
  db: string,
  coll: string,
): Promise<string | null> => (await planRefusal(answer, deps, db, coll))?.ns ?? null

/** The namespaces a plan's check follows at most (views on views included). */
const MAX_NAMESPACES = 50
