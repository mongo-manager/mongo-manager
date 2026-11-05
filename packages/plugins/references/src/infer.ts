// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Plugins wave 2 (references, after Mingo's data relations and Compass's relationship inference):
 * the fields of a collection holding other documents' ObjectIds, the collections those ids are
 * found in, and what each referenced document is called. Canonical Extended JSON throughout.
 */
export type Doc = Record<string, unknown>

/** The fields that name a document, the first present wins. */
export const LABEL_FIELDS = [
  'name',
  'title',
  'label',
  'displayName',
  'fullName',
  'username',
  'email',
  'code',
  'slug',
] as const
/** What is read of a document named in a cell or a list: its _id and naming fields, never the whole of it. */
export const LABEL_PROJECTION: Record<string, number> = Object.fromEntries([
  ['_id', 1],
  ...LABEL_FIELDS.map((f) => [f, 1]),
])

/** A field's last part without its id ending: "customerId", "customer_ids" → "customer". */
export function baseName(path: string): string {
  const last = path.split('.').at(-1) ?? path
  const m = /^(.+?)(?:_ids?|Ids?|IDs?)$/.exec(last)
  return m ? m[1]! : last
}

const normal = (s: string) => s.toLowerCase().replace(/[_\-\s]/g, '')

/** The collections named like a field, singular or plural, in the order given. */
export function candidates(path: string, collections: string[]): string[] {
  const n = normal(baseName(path))
  const forms = new Set([n, `${n}s`, `${n}es`, ...(n.endsWith('y') ? [`${n.slice(0, -1)}ies`] : [])])
  return collections.filter((c) => forms.has(normal(c)))
}

const oidOf = (v: unknown): string | null => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  return Object.keys(o).length === 1 && typeof o.$oid === 'string' ? o.$oid.toLowerCase() : null
}
const isWrapper = (v: unknown) =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length > 0 &&
  Object.keys(v).every((k) => k.startsWith('$'))

/**
 * The fields of sampled documents holding ObjectIds (alone or in arrays), not the documents' own
 * _id, with up to `maxValues` of their values; those with the most values first.
 */
export function objectIdFields(
  documents: Doc[],
  maxFields = 8,
  maxValues = 20,
): Array<{ path: string; ids: string[] }> {
  const fields = new Map<string, Set<string>>()
  const note = (path: string, id: string) => {
    let ids = fields.get(path)
    if (!ids) fields.set(path, (ids = new Set()))
    if (ids.size < maxValues) ids.add(id)
  }
  const walk = (value: unknown, path: string, depth: number) => {
    if (depth > 6) return
    const id = oidOf(value)
    if (id) return path && path !== '_id' ? note(path, id) : undefined
    if (Array.isArray(value)) return value.forEach((item) => walk(item, path, depth + 1))
    if (value && typeof value === 'object' && !isWrapper(value))
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, depth + 1)
  }
  for (const d of documents) walk(d, '', 0)
  return [...fields.entries()]
    .map(([path, ids]) => ({ path, ids: [...ids] }))
    .sort((a, b) => b.ids.length - a.ids.length)
    .slice(0, maxFields)
}

/**
 * The collections to look in: those named like a field first, then the others; never views or
 * system collections; at most `max`.
 */
export function orderCollections(
  list: Array<{ name: string; type: string }>,
  paths: string[],
  max = 50,
): string[] {
  const eligible = list.filter((c) => c.type !== 'view' && !c.name.startsWith('system.')).map((c) => c.name)
  const named = new Set(paths.flatMap((p) => candidates(p, eligible)))
  return [...named, ...eligible.filter((c) => !named.has(c))].slice(0, max)
}

/** Each field mapped to the collection holding most of its values (the earlier one on a tie). */
export function inferRelations(
  fields: Array<{ path: string; ids: string[] }>,
  found: Array<{ coll: string; ids: Set<string> }>,
): { relations: Array<{ path: string; coll: string; share: number }>; unmatched: string[] } {
  const relations: Array<{ path: string; coll: string; share: number }> = []
  const unmatched: string[] = []
  for (const f of fields) {
    let best: { coll: string; matched: number } | null = null
    for (const c of found) {
      const matched = f.ids.filter((id) => c.ids.has(id)).length
      if (matched > 0 && (!best || matched > best.matched)) best = { coll: c.coll, matched }
    }
    if (best) relations.push({ path: f.path, coll: best.coll, share: best.matched / f.ids.length })
    else unmatched.push(f.path)
  }
  return { relations, unmatched }
}

const cut = (s: string) => (s.length > 60 ? `${s.slice(0, 59)}…` : s)

/** What a referenced document is called by its first naming field; null without one. */
export function nameOf(doc: Doc): string | null {
  for (const f of LABEL_FIELDS) {
    const v = doc[f]
    if (typeof v === 'string' && v.trim()) return cut(v.trim())
  }
  return null
}

/** What a referenced document is called: its first naming field, else its _id. */
export function labelOf(doc: Doc): string {
  const name = nameOf(doc)
  if (name !== null) return name
  const id = oidOf(doc._id)
  return cut(id ?? (typeof doc._id === 'string' ? doc._id : JSON.stringify(doc._id)))
}

/** The referenced documents joined in, for the user's Aggregations. */
export function lookupStages(path: string, coll: string): Doc[] {
  return [
    { $lookup: { from: coll, localField: path, foreignField: '_id', as: `${path.replace(/\./g, '_')}_ref` } },
  ]
}

const OID = /^[0-9a-f]{24}$/i

/**
 * The documents of this collection holding one of the sampled ids its target does not hold, for
 * the user's Documents filter; null when nothing is missing, or for a path a filter would read as
 * an operator (a part starting with "$") or as no field (an empty part).
 */
export function orphanFilter(path: string, missing: string[]): Doc | null {
  if (!missing.length || !missing.every((id) => OID.test(id))) return null
  if (path.split('.').some((part) => !part || part.startsWith('$'))) return null
  return { [path]: { $in: missing.map((id) => ({ $oid: id })) } }
}
