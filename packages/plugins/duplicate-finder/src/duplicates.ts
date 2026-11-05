// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Plugins wave 1: documents that share values. A pipeline that groups the documents of the current
 * query by chosen fields and keeps the values found more than once, the largest groups first; and
 * the filter that shows one group's documents. Everything is canonical Extended JSON, for the app.
 */
export type Doc = Record<string, unknown>
export interface Options {
  ignoreCase: boolean
  skipMissing: boolean
}

/** The groups listed; the pipeline keeps one more, which only tells that there are more. */
export const MAX_GROUPS = 200
export const MAX_FIELDS = 5
/** The documents of a group listed under it; Show puts all of them in Documents. */
export const MAX_IDS = 20
const int = (n: number) => ({ $numberInt: String(n) })

export type FieldProblem = 'bad' | 'twice' | 'tooMany'
/** Why a field cannot be added to those picked, or null. */
export function fieldProblem(field: string, picked: string[]): FieldProblem | null {
  // A field never starts with "$" (an operator) nor holds odd characters.
  if (!/^[^$\s.][^\s]*$/.test(field) || field.includes('..') || field.endsWith('.')) return 'bad'
  if (picked.includes(field)) return 'twice'
  if (picked.length >= MAX_FIELDS) return 'tooMany'
  return null
}

/** Fields typed at once ("city, status"). */
export const splitFields = (text: string): string[] =>
  text
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)

/** A group's count as a number, whichever way the server wrote it. */
export function countOf(v: unknown): number {
  if (typeof v === 'number') return v
  if (v && typeof v === 'object') {
    const o = v as Doc
    for (const k of ['$numberInt', '$numberLong', '$numberDouble'])
      if (typeof o[k] === 'string') return Number(o[k])
  }
  return 0
}

/**
 * What a group's listed documents carry: the _id and the fields (their own spelling, where the case
 * was ignored). A path under one already read is left out: the server refuses "a" beside "a.b".
 */
export function idsProjection(fields: string[]): Doc {
  const paths = ['_id']
  for (const f of [...fields].sort((a, b) => a.length - b.length))
    if (!paths.some((p) => p === f || f.startsWith(`${p}.`))) paths.push(f)
  return Object.fromEntries(['_id', ...fields].filter((f) => paths.includes(f)).map((f) => [f, 1]))
}

/** A value by its dotted path; through an array, each element's (as a $group reads it). */
export function valueAt(doc: unknown, path: string): unknown {
  let cur: unknown = doc
  for (const key of path.split('.')) {
    if (Array.isArray(cur)) {
      const found = cur.map((x) => valueAt(x, key)).filter((x) => x !== undefined)
      cur = found
      continue
    }
    if (!cur || typeof cur !== 'object' || !(key in cur)) return undefined
    cur = (cur as Doc)[key]
  }
  return cur
}
/**
 * The keys of the group's _id for the fields, in their order: no dots, never the same for two
 * ("a.b" and "a_b" stay apart: wave 1 review I4).
 */
export function keysOf(fields: string[]): string[] {
  const taken = new Set<string>()
  return fields.map((f) => {
    const base = f.replace(/\./g, '_')
    let key = base
    for (let n = 2; taken.has(key); n++) key = `${base}_${n}`
    taken.add(key)
    return key
  })
}

/** A field's value as the groups compare it: strings in lower case when the case is ignored. */
const valueOf = (f: string, ignoreCase: boolean): unknown =>
  ignoreCase ? { $cond: [{ $eq: [{ $type: `$${f}` }, 'string'] }, { $toLower: `$${f}` }, `$${f}`] } : `$${f}`

export function duplicatePipeline(fields: string[], options: Options, filter: Doc): Doc[] {
  const conditions = [
    ...(Object.keys(filter).length ? [filter] : []),
    ...(options.skipMissing ? fields.map((f) => ({ [f]: { $exists: true, $ne: null } })) : []),
  ]
  const keys = keysOf(fields)
  return [
    ...(conditions.length === 1
      ? [{ $match: conditions[0] }]
      : conditions.length
        ? [{ $match: { $and: conditions } }]
        : []),
    {
      $group: {
        _id: Object.fromEntries(fields.map((f, i) => [keys[i], valueOf(f, options.ignoreCase)])),
        count: { $sum: int(1) },
      },
    },
    { $match: { count: { $gt: int(1) } } },
    { $sort: { count: -1, _id: 1 } },
    { $limit: int(MAX_GROUPS + 1) },
  ]
}

/**
 * The documents of one group (wave 1 review Minor 6): a missing value as missing, null as null,
 * any other value as a value (never an operator); a string whose case was ignored compared the way
 * the groups were made.
 */
export function groupFilter(fields: string[], key: Doc, ignoreCase: boolean, filter: Doc): Doc {
  const own: Doc = {}
  const caseless: Doc[] = []
  const keys = keysOf(fields)
  fields.forEach((f, i) => {
    const v = key[keys[i]!]
    if (v === undefined) own[f] = { $exists: false }
    else if (v === null) own[f] = { $type: 'null' }
    else if (ignoreCase && typeof v === 'string') caseless.push({ $eq: [valueOf(f, true), { $literal: v }] })
    else own[f] = { $eq: v }
  })
  if (caseless.length) own.$expr = caseless.length === 1 ? caseless[0] : { $and: caseless }
  return Object.keys(filter).length ? { $and: [filter, own] } : own
}

/** The fields of sampled documents (canonical EJSON), the most common first; nested ones by path. */
export function suggestFields(documents: Doc[], limit = 30): string[] {
  const counts = new Map<string, number>()
  const isWrapper = (v: Doc) => {
    const keys = Object.keys(v)
    return keys.length > 0 && keys.every((k) => k.startsWith('$'))
  }
  const walk = (doc: Doc, prefix: string, depth: number) => {
    for (const [k, v] of Object.entries(doc)) {
      if (k === '_id' && !prefix) continue
      const path = prefix ? `${prefix}.${k}` : k
      if (v && typeof v === 'object' && !Array.isArray(v) && !isWrapper(v as Doc) && depth < 2)
        walk(v as Doc, path, depth + 1)
      else counts.set(path, (counts.get(path) ?? 0) + 1)
    }
  }
  for (const d of documents) walk(d, '', 0)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([k]) => k)
}
