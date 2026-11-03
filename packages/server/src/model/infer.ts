import {
  DATA_MODEL_LIMITS,
  REFERENCE_SOURCES,
  type FieldStats,
  type ModelCollectionType,
  type ModelField,
  type ModelReference,
  type ReferenceSource,
  type SchemaAnalysis,
  type SchemaType,
} from '@mongo-manager/shared'

/**
 * completion W6.4: what a data model is inferred from — field names, sampled field types, the
 * sampled ObjectId values (checked, never returned) and the $lookup stages of saved pipelines and
 * views. Pure but for the values check, which the caller does (bounded, through the masking gate).
 */

/** A reference field's suffix: userId, user_id, orderID; plural for an array (authorIds, tag_ids). */
const SUFFIX = /^(.+?)(_ids|_id|Ids|IDs|Id|ID)$/

/** The collection a field's name refers to, and whether it holds several; null for any other name. */
export function referenceBase(key: string): { base: string; many: boolean } | null {
  const m = SUFFIX.exec(key)
  if (!m) return null
  const base = m[1]!.replace(/[_-]+$/, '')
  if (!/[A-Za-z]/.test(base)) return null
  return { base, many: /s$/i.test(m[2]!) }
}

const normal = (s: string) => s.toLowerCase().replace(/[\s_.-]/g, '')
const IRREGULAR: Record<string, string> = { person: 'people', child: 'children', man: 'men', woman: 'women' }

/** The collections a base names: itself, its plural (s, es, ies, a few irregular ones), any case. */
export function collectionsNamed(base: string, names: readonly string[]): string[] {
  const b = normal(base)
  if (!b) return []
  const forms = new Set([b, `${b}s`, `${b}es`])
  if (b.endsWith('y')) forms.add(`${b.slice(0, -1)}ies`)
  if (IRREGULAR[b]) forms.add(IRREGULAR[b])
  return names.filter((n) => forms.has(normal(n)))
}

const segments = (f: FieldStats) => f.keys.filter((k): k is string => k !== null)
/** The types seen, most common first. */
const typesOf = (f: FieldStats): SchemaType[] =>
  (Object.entries(f.types) as Array<[SchemaType, number]>).sort((a, b) => b[1] - a[1]).map(([t]) => t)
/** A field an id-like name or ObjectId values make a possible reference. */
const idLike = (f: FieldStats) => {
  const last = f.keys.at(-1)
  return (typeof last === 'string' && referenceBase(last) !== null) || (f.types.objectId ?? 0) > 0
}

/**
 * The fields a collection's box lists: the top level and one level below, deeper id-like fields
 * (to four levels), `_id` first; an array's element types go on the array; a field hidden from the
 * user by its name only. The rest are counted.
 */
export function modelFields(analysis: SchemaAnalysis): { fields: ModelField[]; moreFields: number } {
  const sampled = Math.max(1, analysis.sampled)
  const elements = new Map<string, SchemaType[]>()
  for (const f of analysis.fields)
    if (f.keys.at(-1) === null) elements.set(JSON.stringify(f.keys.slice(0, -1)), typesOf(f))
  const listed: ModelField[] = []
  let total = 0
  for (const f of analysis.fields) {
    if (f.keys.at(-1) === null) continue
    total++
    const depth = segments(f).length
    if (depth > DATA_MODEL_LIMITS.idDepth) continue
    if (depth > DATA_MODEL_LIMITS.depth && !idLike(f) && !f.masked) continue
    const share = Math.min(1, Math.round((f.count / sampled) * 1000) / 1000)
    if (f.masked) {
      listed.push({ path: f.path, types: [], share, masked: true })
      continue
    }
    const items = elements.get(JSON.stringify(f.keys))
    listed.push({ path: f.path, types: typesOf(f), share, ...(items ? { items } : {}) })
  }
  listed.sort((a, b) => Number(b.path === '_id') - Number(a.path === '_id'))
  const fields = listed.slice(0, DATA_MODEL_LIMITS.fields)
  return { fields, moreFields: total - fields.length }
}

/** A join a pipeline makes: from a collection's field to another collection's field. */
export interface Lookup {
  from: string
  field: string
  to: string
  toField: string
}

const MAX_WALK = 5_000
const MAX_NESTING = 20
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const fieldName = (v: unknown) => (typeof v === 'string' && v !== '' && !v.startsWith('$') ? v : null)

/**
 * The $lookup and $graphLookup joins of a pipeline run on `coll` of `db`: a nested pipeline joins
 * from its own collection; a join to another database is left out. Bounded in size and depth.
 */
export function lookupsIn(stages: unknown, coll: string, db: string): Lookup[] {
  const out: Lookup[] = []
  let seen = 0
  const target = (from: unknown): string | null => {
    if (typeof from === 'string' && from !== '') return from
    if (isObj(from) && from.db === db && typeof from.coll === 'string' && from.coll !== '') return from.coll
    return null
  }
  const walk = (pipeline: unknown, on: string, depth: number): void => {
    if (!Array.isArray(pipeline) || depth > MAX_NESTING) return
    for (const stage of pipeline) {
      if (++seen > MAX_WALK || !isObj(stage)) continue
      const lookup = stage.$lookup
      if (isObj(lookup)) {
        const to = target(lookup.from)
        const field = fieldName(lookup.localField)
        const toField = fieldName(lookup.foreignField)
        if (to && field && toField) out.push({ from: on, field, to, toField })
        if (to) walk(lookup.pipeline, to, depth + 1)
      }
      const graph = stage.$graphLookup
      if (isObj(graph)) {
        const to = target(graph.from)
        const start = typeof graph.startWith === 'string' ? graph.startWith : null
        const field = start?.startsWith('$') && !start.startsWith('$$') ? start.slice(1) : null
        const toField = fieldName(graph.connectToField)
        if (to && field && toField) out.push({ from: on, field, to, toField })
      }
      if (isObj(stage.$facet)) for (const sub of Object.values(stage.$facet)) walk(sub, on, depth + 1)
      const union = stage.$unionWith
      if (isObj(union)) {
        const to = target(union.coll)
        if (to) walk(union.pipeline, to, depth + 1)
      }
    }
  }
  walk(stages, coll, 0)
  return out
}

export interface SampledCollection {
  name: string
  type: ModelCollectionType
  /** Null for a view or a collection that could not be sampled. */
  analysis: SchemaAnalysis | null
}

/**
 * The references between collections: by the field's name (userId → users), by its sampled ObjectId
 * values found as another collection's _ids (`check` answers how many of them were found), and by
 * the joins of saved pipelines and views. A view is never a target; a masked field is never checked
 * (its values were never read), only named. At most `budget` checks in all.
 */
export async function inferReferences(input: {
  collections: readonly SampledCollection[]
  lookups: readonly Lookup[]
  check: (target: string, hexValues: string[]) => Promise<number | null>
  budget: number
}): Promise<ModelReference[]> {
  const found = new Map<string, ModelReference>()
  const add = (ref: Omit<ModelReference, 'sources'>, source: ReferenceSource) => {
    const key = JSON.stringify([ref.from, ref.field, ref.to, ref.toField])
    const known = found.get(key)
    if (!known) return void found.set(key, { ...ref, sources: [source] })
    if (!known.sources.includes(source))
      known.sources = REFERENCE_SOURCES.filter((s) => s === source || known.sources.includes(s))
    if (ref.overlap) known.overlap = ref.overlap
    known.many ||= ref.many
  }
  const names = input.collections.map((c) => c.name)
  const targets = input.collections.filter((c) => c.type !== 'view').map((c) => c.name)
  let budget = input.budget
  for (const c of input.collections) {
    if (!c.analysis) continue
    for (const f of c.analysis.fields) {
      const keys = f.keys
      const element = keys.at(-1) === null
      const own = (element ? keys.slice(0, -1) : keys).filter((k): k is string => k !== null)
      if (own.length === 0 || (own.length === 1 && own[0] === '_id' && !element)) continue
      if (own.length > DATA_MODEL_LIMITS.idDepth) continue
      const field = element ? f.path.replace(/\[\]$/, '') : f.path
      const many = keys.includes(null) || (f.types.array ?? 0) > 0
      const name = referenceBase(own.at(-1)!)
      const named = name ? collectionsNamed(name.base, targets) : []
      for (const to of named)
        add({ from: c.name, field, to, toField: '_id', many: many || name!.many }, 'name')
      // Values: only ObjectIds this user was shown (a masked field has none), never a view's.
      const values = f.masked
        ? []
        : (f.top ?? [])
            .filter((v) => v.type === 'objectId' && /^[0-9a-f]{24}$/.test(v.value))
            .map((v) => v.value)
            .slice(0, 10)
      if (values.length === 0) continue
      const order = named.length > 0 ? named : targets
      for (const to of order) {
        if (budget <= 0) break
        budget--
        const hits = await input.check(to, values)
        if (hits && hits > 0) {
          add(
            {
              from: c.name,
              field,
              to,
              toField: '_id',
              many,
              overlap: { checked: values.length, found: hits },
            },
            'values',
          )
          if (named.length === 0) break
        }
      }
    }
  }
  for (const l of input.lookups)
    if (names.includes(l.from) && targets.includes(l.to)) add({ ...l, many: false }, 'lookup')
  return [...found.values()]
}
