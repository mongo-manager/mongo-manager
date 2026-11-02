import type { Document } from 'mongodb'
import type { NsMasker } from '../match'
import { newCtx, type GateCtx, type GateDeps } from './context'
import type { Shape } from './shape'
import { guardStages, sourceShape } from './pipeline'
import { guardFilter } from './filter'
import { guardValue, refOf } from './expression'
import { fieldOf, holdsDocument, isDbRef, isDocument, isNumberLike, isOperatorDoc } from './values'
import { notSupported, personalField } from './refusal'
import { folding, NO_ORDER, WILDCARD, findOrder, orderFor, ordered } from './order'

export interface FindQuery {
  filter: Document
  projection?: Document
  sort?: Document
  hint?: string | Document
  /** The read's collation: one that is not simple can make distinct _ids equal (thirteenth review, I-2). */
  collation?: Document
}

export interface GuardedFind {
  filter: Document
  projection?: Document
  sort?: Document
  hint?: string | Document
  output: NsMasker
  /** The source is a view: its documents are computed, not stored (final review C3). */
  fromView: boolean
  /** A page with a document _id is refused by `finish` (fourteenth review, Minor 5). */
  checksId: boolean
  /**
   * A time series whose storage follows a hidden value, its _id able to repeat: each read's _ids are
   * taken before `finish` and asked about with `refuseRepeats` after it (seventeenth to nineteenth
   * reviews).
   */
  repeats: boolean
  /** Where `finish` refused a page for a document _id: the read again, in natural order. */
  natural?: { sort?: Document; hint: Document; finish(docs: Document[]): Document[] }
  /** Refuses a page ordered by a sub-document at a sort path, then drops the paths added for that check. */
  finish(docs: Document[]): Document[]
  /** The sort keys `finish` checks (they may hold what is hidden; final review of explain masking, P-1). */
  checked: readonly string[]
}

const split = (s: string) => s.split('.')
const META_OK = new Set(['textScore', 'searchScore'])

/** Every value at a path, through arrays. */
function valuesAt(value: unknown, path: readonly string[]): unknown[] {
  if (path.length === 0) return [value]
  if (Array.isArray(value)) return value.flatMap((v) => valuesAt(v, path))
  if (!isDocument(value)) return []
  const [head, ...rest] = path
  const field = fieldOf(value, head!)
  return field ? valuesAt(field.value, rest) : []
}

function removePath(value: unknown, path: readonly string[]): void {
  if (Array.isArray(value)) return value.forEach((v) => removePath(v, path))
  if (!isDocument(value) || path.length === 0) return
  const [head, ...rest] = path
  if (rest.length > 0) removePath(fieldOf(value, head!)?.value, rest)
  else if (isDbRef(value)) delete value.fields[head!]
  else delete value[head!]
}

/** An index key as MongoDB compares it: 1, NumberLong(1) and 1.0 are one direction (review M4). */
const keyOf = (key: unknown) =>
  JSON.stringify(
    Object.entries(isDocument(key) ? key : {}).map(([f, v]) => [f, isNumberLike(v) ? Number(v) : v]),
  )

/**
 * Phase 3c §3.7: a hint that would force the order, or the count, of a personal value is refused.
 * The hint to send comes back: a name resolved to its index's key where `resolve` (a job's read:
 * an index made again under that name before it runs is not hinted; thirteenth review, M6).
 */
async function checkHint(
  db: string,
  coll: string,
  hint: string | Document | undefined,
  shape: Shape,
  gc: GateCtx,
  resolve = false,
): Promise<string | Document | undefined> {
  if (hint === undefined) return undefined
  if (isDocument(hint) && Object.keys(hint).length === 1 && '$natural' in hint) return hint
  // Thirteenth review (C1): an empty hint is no hint to MongoDB, and { $hint: name } names an
  // index the checks below would not find: where rules apply, neither leaves the gate's order or
  // checks behind; nor a value that is no name or key document (fourteenth review, Minor 7). A
  // wildcard key ("$**") holds what every rule hides, and is refused below.
  if (shape.any) {
    if (typeof hint !== 'string' && (!isDocument(hint) || isDbRef(hint)))
      throw notSupported('This hint', shape.ns)
    const keys = typeof hint === 'string' ? [hint] : Object.keys(hint)
    if (keys.length === 0 || (typeof hint !== 'string' && keys.some((k) => k.startsWith('$') && k !== '$**')))
      throw notSupported('This hint', shape.ns)
  }
  // Twelfth review (I1): a view lists no indexes; its stored collection's are named by fields its
  // rules do not name. Only _id's may be hinted there, and is checked as _id.
  if (shape.any && (await gc.deps.view(db, coll))) {
    const key = typeof hint === 'string' ? (hint === '_id_' ? { _id: 1 } : null) : hint
    if (!key || Object.keys(key).some((k) => k !== '_id')) throw notSupported('A hint on a view', shape.ns)
    if (shape.personal(['_id']) || shape.mayHold(['_id'])) throw personalField('_id', shape.ns)
    return hint
  }
  const indexes = await gc.deps.indexes(db, coll)
  // Every index the hint may name: one by its name, any with its key (fourteenth review, nit).
  const named =
    typeof hint === 'string'
      ? indexes.filter((i) => i.name === hint)
      : indexes.filter((i) => keyOf(i.key) === keyOf(hint))
  // Where rules apply, a name or a key no listed index has is not taken on trust (thirteenth
  // review, M3; fifteenth, Minor 3): an index made between the listing and the find is not read.
  if (named.length === 0 && shape.any) throw notSupported('A hint naming no listed index', shape.ns)
  const keys = named.length > 0 ? named.map((i) => i.key as Document) : [isDocument(hint) ? hint : {}]
  // A text index reads the fields its weights name (review M4).
  const weights = named.flatMap((i) => (isDocument(i.weights) ? Object.keys(i.weights) : []))
  for (const field of [...keys.flatMap((k) => Object.keys(k)), ...weights]) {
    const p = split(field.replace(WILDCARD, '')).filter((s) => s !== '')
    if (shape.personal(p) || shape.mayHold(p)) throw personalField(field, shape.ns)
  }
  // A partial index holds the documents its filter keeps: a filter the gate would refuse counts
  // what is hidden; what it allows, the index may keep (fifteenth review, nit).
  for (const i of named)
    if (isDocument(i.partialFilterExpression)) guardFilter(i.partialFilterExpression, shape, gc)
  const index = named[0]
  const sameKey = index !== undefined && indexes.filter((i) => keyOf(i.key) === keyOf(index.key)).length === 1
  return resolve && typeof hint === 'string' && sameKey ? (index.key as Document) : hint
}

function guardProjection(projection: Document, shape: Shape, gc: GateCtx): Document {
  const out: Document = {}
  for (const [key, value] of Object.entries(projection)) {
    if (isNumberLike(value)) out[key] = value
    else if (isOperatorDoc(value) && '$elemMatch' in value) {
      guardFilter({ [key]: value }, shape, gc)
      out[key] = value
    } else if (isOperatorDoc(value) && '$slice' in value && isSliceCount(value.$slice)) out[key] = value
    else if (isOperatorDoc(value) && '$meta' in value) {
      if (!META_OK.has(String(value.$meta))) throw notSupported(`$meta ${String(value.$meta)}`, shape.ns)
      out[key] = value
    } else {
      const ref = refOf(value, gc, shape.ns)
      if (Array.isArray(ref)) {
        if (ref.length > 0 && shape.personal(ref)) throw personalField(ref.join('.'), shape.ns)
        shape.moved(ref, split(key))
        out[key] = value
      } else out[key] = guardValue(value, shape, gc)
    }
  }
  return out
}

/** A projection flag that includes (1, true) rather than excludes (0, false). */
const includes = (v: unknown) => !(isNumberLike(v) && !Number(v))
/** The classic $slice projection (a count, or [skip, count]); anything else is an expression (C2). */
const isSliceCount = (v: unknown): boolean =>
  isNumberLike(v) || (Array.isArray(v) && v.length === 2 && v.every(isNumberLike))

/**
 * Phase 3c §3.7: a find as a restricted user may run it. A sort on a path that may hold personal
 * data keeps its index; the page is checked afterwards. MongoDB orders values by type, and all
 * sub-documents sit in one block of that order (after strings, before ObjectIds, booleans and dates):
 * a page of scalar sort values was not chosen by how the sub-documents compare among themselves.
 */
export async function guardFind(
  db: string,
  coll: string,
  query: FindQuery,
  deps: GateDeps,
  /**
   * `always`: a job's read, ordered whatever the indexes are when it runs (review M2). false: only
   * its filter, projection or output are used, never its documents' order (thirteenth review, M5).
   */
  options: { order?: 'always' | false } = {},
): Promise<GuardedFind> {
  const gc = newCtx(deps, db)
  const shape = await sourceShape(db, coll, gc)
  const filter = guardFilter(query.filter, shape, gc)
  const projection = query.projection ? guardProjection(query.projection, shape, gc) : undefined
  const always = options.order === 'always'
  const hint = await checkHint(db, coll, query.hint, shape, gc, always)
  // Ninth, twelfth and thirteenth reviews: the order a page comes in tells nothing hidden.
  const order = options.order === false ? NO_ORDER : await orderFor(db, coll, shape, gc, always)
  const read = findOrder(
    order,
    {
      ...(query.sort ? { sort: query.sort } : {}),
      filter: query.filter,
      hinted: hint !== undefined,
      collated: folding(query.collation),
    },
    { always, ns: shape.ns },
  )
  const checked: string[] = []
  if (query.sort)
    for (const [key, dir] of Object.entries(query.sort)) {
      if (isDocument(dir)) continue
      if (shape.personal(split(key))) throw personalField(key, shape.ns)
      if (shape.mayHold(split(key))) checked.push(key)
    }
  // Where only _id can order and it may be a document holding personal data, it is checked as any
  // such key is (a collection clustered by it; elsewhere the natural order is read instead).
  if (read.checkId && !checked.includes('_id')) checked.push('_id')
  // MongoDB sorts by the stored value before it projects: a computed projection of a checked key
  // (or of a path above or below it) would show one value while the page is ordered by another
  // (final review I1).
  for (const key of checked)
    for (const [k, v] of Object.entries(query.projection ?? {}))
      if ((k === key || k.startsWith(`${key}.`) || key.startsWith(`${k}.`)) && !isNumberLike(v))
        throw notSupported(
          `${key === '_id' && !(query.sort && '_id' in query.sort) ? 'The _id order this page needs' : `Sorting by ${key}`} while projecting ${k}`,
          shape.ns,
        )
  const added: string[] = []
  // Each key a page's documents are checked at, then the paths added for that check dropped.
  const finishOf =
    (keys: readonly string[]) =>
    (docs: Document[]): Document[] => {
      for (const doc of docs)
        for (const key of keys)
          if (valuesAt(doc, split(key)).some(holdsDocument)) throw personalField(key, shape.ns)
      for (const doc of docs) for (const key of added) removePath(doc, split(key))
      return docs
    }
  // Where a time series' _ids are checked for repeats, the _id is read whatever the projection; a
  // computed one, or a part of it, would not be the stored one (seventeenth review, I1-c).
  if (read.checkRepeats && projection) {
    if (Object.keys(projection).some((k) => k.startsWith('_id.')))
      throw notSupported('A part of _id here', shape.ns)
    if ('_id' in projection) {
      if (!isNumberLike(projection._id)) throw notSupported('A computed _id here', shape.ns)
      if (!Number(projection._id)) {
        delete projection._id
        added.push('_id')
      }
    }
  }
  if (projection && checked.length > 0) {
    const inclusion = Object.entries(projection).some(([k, v]) => k !== '_id' && includes(v))
    for (const key of checked) {
      // Included unless excluded by name: an excluded _id is read for the check, then dropped.
      if (key === '_id') {
        if ('_id' in projection && isNumberLike(projection._id) && !Number(projection._id)) {
          delete projection._id
          added.push(key)
        }
        continue
      }
      const collides = Object.keys(projection).some(
        (k) => k !== key && (k.startsWith(`${key}.`) || key.startsWith(`${k}.`)),
      )
      if (collides) throw notSupported(`Sorting by ${key} with this projection`, shape.ns)
      if (inclusion && !(key in projection)) {
        projection[key] = 1
        added.push(key)
      } else if (!inclusion && key in projection) {
        delete projection[key]
        added.push(key)
      }
    }
  }
  return {
    filter,
    ...(projection ? { projection } : {}),
    ...(read.sort ? { sort: read.sort } : {}),
    ...(hint !== undefined ? { hint } : read.hint ? { hint: read.hint } : {}),
    output: shape.output(),
    fromView: (await deps.view(db, coll)) !== null,
    checksId: checked.includes('_id'),
    checked,
    repeats: read.checkRepeats === true,
    // Fifteenth review (Minor 5): a page refused for a document _id, read again in natural order
    // where that tells nothing (the refusal says only that such an _id exists: the page shows it).
    // Not where the user's own sort names _id: MongoDB sorts by it whatever the hint (sixteenth
    // review, C1).
    ...(read.checkId && order.naturalSafe && !(query.sort && '_id' in query.sort)
      ? {
          natural: {
            ...(query.sort ? { sort: query.sort } : {}),
            hint: { $natural: 1 },
            finish: finishOf(checked.filter((k) => k !== '_id')),
          },
        }
      : {}),
    finish: finishOf(checked),
  }
}

/**
 * The stages that put a restricted user's matched documents in an order that tells nothing hidden,
 * to follow a guarded $match (thirteenth review, I1: a bulk preview samples what its count counts).
 */
export async function guardOrder(db: string, coll: string, deps: GateDeps): Promise<Document[]> {
  const gc = newCtx(deps, db)
  const shape = await sourceShape(db, coll, gc)
  const order = await orderFor(db, coll, shape, gc)
  return ordered([{ $match: {} }], { stages: [{ $match: {} }], ends: [1] }, order, gc).stages.slice(1)
}

export async function guardCount(
  db: string,
  coll: string,
  filter: Document,
  hint: string | Document | undefined,
  deps: GateDeps,
): Promise<{ filter: Document; output: NsMasker; fromView: boolean; repeats: boolean; idRepeats: boolean }> {
  const gc = newCtx(deps, db)
  const shape = await sourceShape(db, coll, gc)
  const guarded = guardFilter(filter, shape, gc)
  await checkHint(db, coll, hint, shape, gc)
  // A single read by _id of a time series whose _id may repeat gives the storage-first of equal ones
  // (seventeenth review, I1-e).
  const order = await orderFor(db, coll, shape, gc)
  // Or where a view over one rebuilds it (eighteenth review, Minor 5).
  const repeats =
    order.by !== 'none' &&
    ((!order.naturalSafe && (order.by === 'refused' || !order.idUnique)) || order.folds)
  // Final reviews of explain masking (M-3): an _id itself repeats only where it is no unique key (a
  // time series); a clustered collection with a hidden _id holds each once. A view over a series is
  // taken to (what it rebuilds is not known here).
  const idRepeats = order.by !== 'none' && !order.naturalSafe && !order.idUnique
  return {
    filter: guarded,
    output: shape.output(),
    fromView: (await deps.view(db, coll)) !== null,
    repeats,
    idRepeats,
  }
}

/** A filter alone (a single document by _id, a bulk preview, a validator under test). */
export const guardFilterFor = (db: string, coll: string, filter: Document, deps: GateDeps) =>
  guardCount(db, coll, filter, undefined, deps)

export async function guardAggregate(
  db: string,
  coll: string,
  stages: Document[],
  deps: GateDeps,
  /** false: only counted or checked (review I5); 'always': a job's read (review M2). */
  options: { order?: false | 'always' } = {},
): Promise<{ stages: Document[]; ends: number[]; output: NsMasker; ordered: boolean }> {
  const gc = newCtx(deps, db)
  // Fifteenth and sixteenth reviews of explain masking (I-2): a view's collation, or a collection's
  // own, is its joins' too (measured on 8.2: $lookup and $unionWith read under it).
  const outer = (await deps.view(db, coll))?.collation ?? (await deps.storage?.(db, coll))?.collation
  if (outer) gc.collation = outer
  // Twelfth review (I5): documents only counted or checked are read in any order.
  if (options.order === false) gc.unordered = true
  if (options.order === 'always') gc.always = true
  const shape = await sourceShape(db, coll, gc)
  const order = gc.unordered ? NO_ORDER : await orderFor(db, coll, shape, gc, gc.always === true)
  const guarded = await guardStages(stages, shape, gc)
  const out = ordered(stages, guarded, order, gc)
  // `ordered`: the gate sorts what the user did not ask sorted (a run then may spill to disk).
  return { ...out, output: shape.output(), ordered: out !== guarded }
}
