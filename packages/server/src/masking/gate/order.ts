import type { Document } from 'mongodb'
import { FIRST_STAGES } from '../../aggregation/first-stages'
import { MAX_VIEW_DEPTH, rulesFor, type GateCtx } from './context'
import { typeGuard } from './guard'
import { notSupported, orderRefused } from './refusal'
import { Shape } from './shape'
import { isDocument, isNumberLike, isOperatorDoc } from './values'

/**
 * Ninth and twelfth reviews of explain masking: where rules apply, a restricted user's documents
 * never come in the order of an index that holds what is hidden. The planner may read such an
 * index after the user's own keys ({ tenant: 1, email: 1 } for a filter on tenant), and the
 * documents would come in the hidden values' order. Where an index could, ties are broken by _id;
 * where _id cannot break them (it is hidden, or a view drops it), the documents are read in their
 * natural order (a find) or a random one (a pipeline). Where no index could, nothing changes.
 * A random order, not a salted hash: the monitoring lists show a restricted user the commands
 * run, a salt with them, and a known salt would let a hidden value be guessed from the order.
 */
export interface Order {
  /**
   * none: nothing could order by what is hidden. id: ties broken by _id. natural: _id is hidden, the
   * natural order tells nothing (a find reads in it, a pipeline at random). refused: _id is hidden
   * and the natural order follows what is hidden too (a find has no order to read in).
   */
  readonly by: 'none' | 'id' | 'natural' | 'refused'
  /** _id may be a document holding what is hidden. */
  readonly checked: boolean
  /**
   * Thirteenth review (I2, I3): the natural order tells nothing. Not so for a collection clustered
   * by an _id that is or may hold what is hidden, nor for a time series whose time or meta field
   * is: they are stored, and read, in that order.
   */
  readonly naturalSafe: boolean
  /**
   * Thirteenth and fourteenth reviews (I4, I-C): where equal distances come in a hidden order: the
   * geo fields whose index holds a hidden key besides its location; 'any' where the natural order
   * itself follows what is hidden, or the indexes are unknown.
   */
  readonly geoTies: 'any' | readonly string[]
  /** Fourteenth review (Minor 4): a time series' _id is no total order; its ties fall to storage. */
  readonly idUnique: boolean
  /**
   * Fourteenth review of explain masking (I-1): a view's collation that is not simple makes distinct
   * _ids equal ('Bob', 'bob'; a collection's own keeps them unique, a view's does not), then in the
   * order MongoDB sorted them from.
   */
  readonly folds: boolean
}

export const NO_ORDER: Order = {
  by: 'none',
  checked: false,
  naturalSafe: true,
  geoTies: [],
  idUnique: true,
  folds: false,
}

/** A collation that compares some values as equal that differ (any but the simple one). */
export const folding = (collation: Document | undefined): boolean =>
  collation !== undefined && collation.locale !== 'simple'
/** MongoDB sorts by 32 keys at most. */
const MAX_SORT_KEYS = 32
/** A wildcard index key ("$**", "a.$**") names what is below its prefix. */
export const WILDCARD = /(^|\.)\$\*\*$/
const touchesId = (key: string) => key === '_id' || key.startsWith('_id.')
const opOf = (stage: unknown) => (isDocument(stage) ? Object.keys(stage)[0] : undefined)

/** Stages that must come first or that order by themselves: the order is theirs. */
const OWN_ORDER = new Set([
  ...FIRST_STAGES,
  '$changeStream',
  '$changeStreamSplitLargeEvent',
  '$sample',
  '$currentOp',
  '$listLocalSessions',
  '$listSessions',
  '$querySettings',
])

/**
 * Whether a view's stage leaves each document an _id of its own: the stored one, or a group's key.
 * Anything not known to is taken not to.
 */
function keepsId(stage: unknown): boolean {
  const op = opOf(stage)
  const arg = op === undefined ? undefined : (stage as Document)[op]
  switch (op) {
    // The stored _id kept; or one document a group, with the group's key as its _id; or one in all.
    case '$match':
    case '$sort':
    case '$limit':
    case '$skip':
    case '$sample':
    case '$redact':
    case '$unionWith':
    case '$group':
    case '$bucket':
    case '$bucketAuto':
    case '$sortByCount':
    case '$count':
    case '$facet':
      return true
    case '$addFields':
    case '$set':
      return isDocument(arg) && !Object.keys(arg).some(touchesId)
    case '$project':
      return (
        isDocument(arg) &&
        Object.entries(arg).every(
          ([k, v]) => !touchesId(k) || (k === '_id' && isNumberLike(v) && Number(v) !== 0),
        )
      )
    case '$unset': {
      const list: unknown[] = typeof arg === 'string' ? [arg] : Array.isArray(arg) ? arg : []
      return list.length > 0 && list.every((k) => typeof k === 'string' && !touchesId(k))
    }
    case '$unwind':
      return typeof arg === 'string' || (isDocument(arg) && !touchesId(String(arg.includeArrayIndex ?? '')))
    case '$lookup':
    case '$graphLookup':
      return isDocument(arg) && typeof arg.as === 'string' && !touchesId(arg.as)
    case '$setWindowFields':
    case '$fill':
      return isDocument(arg) && isDocument(arg.output) && !Object.keys(arg.output).some(touchesId)
    default:
      return false
  }
}

interface Stored {
  coll: string
  view: boolean
  keepsId: boolean
  /** A view on the way starts with a stage that orders by itself ($geoNear, $sample, ...). */
  ownOrder: boolean
}

/** The stored collection a namespace reads, and whether every view on the way keeps _id. */
async function stored(db: string, coll: string, gc: GateCtx): Promise<Stored> {
  let name = coll
  let keeps = true
  let own = false
  for (let depth = 0; depth <= MAX_VIEW_DEPTH; depth++) {
    const def = await gc.deps.view(db, name)
    if (!def) return { coll: name, view: depth > 0, keepsId: keeps, ownOrder: own }
    keeps &&= def.pipeline.every(keepsId)
    own ||= OWN_ORDER.has(opOf(def.pipeline[0]) ?? '')
    name = def.viewOn
  }
  // Deeper chains are refused before any order is asked for.
  return { coll: name, view: true, keepsId: false, ownOrder: false }
}

const GEO = new Set(['2dsphere', '2d', 'geoHaystack'])

/** The path an index key names, a wildcard's prefix for a wildcard ([] for the whole document). */
const keyPath = (field: string) =>
  field
    .replace(WILDCARD, '')
    .split('.')
    .filter((s) => s !== '')

/** A key path that is, or may hold, what is hidden: what is below the whole document holds every rule. */
const keyHides = (field: string, shape: Shape) => {
  const p = keyPath(field)
  return shape.personal(p) || shape.mayHold(p)
}

/** Whether the planner could read the stored collection through an index holding what is hidden. */
function indexMayOrder(indexes: readonly Document[], shape: Shape, view: boolean): boolean {
  // Every collection lists _id's index: none listed means they could not be read, and may hold
  // anything (a time series that truly lists none is then sorted by _id: thirteenth review, M3).
  if (indexes.length === 0) return true
  return indexes.some((index) => {
    // _id's index serves no query here (a hidden _id is refused); a hidden index serves none.
    if (index.name === '_id_' || index.hidden === true) return false
    // A view's rules name its own fields, not the stored ones: any other index may hold them.
    if (view) return true
    const key: Document = isDocument(index.key) ? index.key : {}
    return Object.entries(key).some(([field, kind]) => kind === 'text' || keyHides(field, shape))
  })
}

/** The geo fields whose index holds what is hidden besides its location; 'any' where unknown. */
function geoIndexHides(indexes: readonly Document[], shape: Shape, view: boolean): 'any' | string[] {
  if (indexes.length === 0 || view) return 'any'
  return indexes.flatMap((index) => {
    const key = Object.entries(isDocument(index.key) ? index.key : {})
    const geo = key.filter(([, kind]) => GEO.has(String(kind))).map(([field]) => field)
    const hides = key.some(([field, kind]) => !GEO.has(String(kind)) && keyHides(field, shape))
    return geo.length > 0 && hides ? geo : []
  })
}

/**
 * How the documents of db.coll, whose shape is `shape` as read, are to be ordered. `always`: in an
 * order that hides nothing whatever the indexes are when it runs (a job's reads, review M2).
 */
export async function orderFor(
  db: string,
  coll: string,
  shape: Shape,
  gc: GateCtx,
  always = false,
): Promise<Order> {
  if (!shape.any) return NO_ORDER
  const source = await stored(db, coll, gc)
  if (source.ownOrder) return NO_ORDER
  const indexes = await gc.deps.indexes(db, source.coll)
  const storage = (await gc.deps.storage?.(db, source.coll)) ?? null
  // What the stored collection's rules hide, by its own names (a view's rules name its fields).
  const base = new Shape(`${db}.${source.coll}`, rulesFor(gc.deps.masker, db, source.coll))
  const storedHides = (p: string[]) =>
    base.personal(p) || base.mayHold(p) || (!source.view && (shape.personal(p) || shape.mayHold(p)))
  // The listing of the collection says it is clustered where its indexes cannot be read (M3).
  const clustered = storage?.clustered === true || indexes.some((i) => i.clustered === true)
  const series = storage?.timeseries
  // A view's own rules may name the series' fields by its own names (fourteenth review, I-D): a
  // view over a time series is taken to be ordered by what it hides.
  const seriesHides =
    series !== undefined &&
    (source.view ||
      [series.timeField, series.metaField].some((f) => f !== undefined && storedHides(keyPath(f))))
  const naturalSafe =
    !(clustered && (storedHides(['_id']) || shape.personal(['_id']) || shape.mayHold(['_id']))) &&
    !seriesHides
  if (naturalSafe && !always && !indexMayOrder(indexes, shape, source.view)) return NO_ORDER
  // Where the natural order follows what is hidden, so do a geo query's equal distances (I-C).
  // A pipeline's order needed whatever the indexes (a view to store, a pipeline job) takes a geo index
  // built later into account.
  // (A find's $near is judged by today's geo indexes: it is read once, as it runs.)
  const geoTies = naturalSafe && !gc.always ? geoIndexHides(indexes, shape, source.view) : 'any'
  const idUnique = series === undefined
  // A view's collation makes its _ids equal; the operation's makes another namespace's equal where
  // it is not that namespace's own, which keeps its _ids unique (seventeenth review, I-1).
  const viewCollation = source.view ? (await gc.deps.view(db, coll))?.collation : undefined
  const own = source.view ? viewCollation : storage?.collation
  const folds =
    (source.view && folding(viewCollation)) ||
    (folding(gc.collation) && JSON.stringify(gc.collation) !== JSON.stringify(own))
  const idHidden = shape.personal(['_id']) || !source.keepsId || (clustered && base.personal(['_id']))
  const checked = !idHidden && (shape.mayHold(['_id']) || base.mayHold(['_id']))
  const by = idHidden ? (naturalSafe ? 'natural' : 'refused') : 'id'
  return { by, checked, naturalSafe, geoTies, idUnique, folds }
}

/**
 * Final reviews of explain masking (M-4): whether a time series to be created with these options
 * would be stored by what rules hide (its time or meta field), before it exists.
 */
export function seriesStoredByHidden(
  masker: GateCtx['deps']['masker'],
  db: string,
  coll: string,
  series: { timeField?: unknown; metaField?: unknown },
): boolean {
  const base = new Shape(`${db}.${coll}`, rulesFor(masker, db, coll))
  return [series.timeField, series.metaField].some(
    (f) => typeof f === 'string' && (base.personal(keyPath(f)) || base.mayHold(keyPath(f))),
  )
}

/**
 * The fields of a $near or $nearSphere query: MongoDB answers it in distance order (review I6).
 * Only where the value is an operator document: `{ a: { x: 1, $near: ... } }` is a literal
 * (thirteenth review, M2).
 */
const nearFields = (filter: unknown): string[] =>
  isDocument(filter)
    ? Object.entries(filter).flatMap(([k, v]) => {
        if (k === '$and') return Array.isArray(v) ? v.flatMap(nearFields) : []
        const geo = !k.startsWith('$') && isOperatorDoc(v) && ('$near' in v || '$nearSphere' in v)
        return geo ? [k] : []
      })
    : []

/** Whether equal distances on these geo fields would come in a hidden order. */
const tiesHidden = (order: Order, fields: readonly string[]) =>
  order.geoTies === 'any' || fields.some((f) => order.geoTies.includes(f))

/**
 * The sort and hint a find reads with, and whether a page with a document _id is refused
 * (`checkId`: where it may hold what is hidden and orders the page).
 */
export function findOrder(
  order: Order,
  query: { sort?: Document; filter: Document; hinted: boolean; collated?: boolean },
  opts: { always: boolean; ns: string },
): { sort?: Document; hint?: Document; checkId: boolean; checkRepeats?: boolean } {
  const sort = query.sort
  const own = { ...(sort ? { sort } : {}), checkId: false }
  // A time series' _id may repeat, equal ones then in hidden storage order: its reads ask MongoDB
  // whether one does (fifteenth and eighteenth reviews). So do a read's under a collation that is not
  // simple: it makes distinct _ids equal ('Bob', 'bob'), then in the order of whatever MongoDB sorted
  // them from (a hidden index's; thirteenth review of explain masking, I-2).
  const checkRepeats = (!order.idUnique && !order.naturalSafe) || order.folds || query.collated === true
  const refuse = (what: string): never => {
    throw orderRefused(what, opts.ns)
  }
  if (order.by === 'none') return own
  if (order.by === 'refused') refuse('Reading in an order that tells nothing of a hidden _id here')
  const near = nearFields(query.filter)
  if (near.length > 0)
    return tiesHidden(order, near) ? refuse('A $near query on a geo index holding hidden data') : own
  const natural = { ...own, hint: { $natural: 1 } }
  if (sort && '$natural' in sort) {
    // MongoDB takes $natural alone (fourteenth review, nit): a malformed sort, not an order refused.
    if (Object.keys(sort).length > 1) throw notSupported('A $natural sort with other keys', opts.ns)
    return order.naturalSafe ? own : refuse('Reading in natural order here, which follows hidden data')
  }
  const byId = () => {
    if (sort && '_id' in sort) return { ...own, checkId: order.checked, checkRepeats }
    if (Object.keys(sort ?? {}).length >= MAX_SORT_KEYS)
      return order.naturalSafe ? natural : refuse('A sort of 32 keys here')
    // A page with a document _id is refused where it may hold a hidden value (checked).
    return { sort: { ...sort, _id: 1 }, checkId: order.checked, checkRepeats }
  }
  // A hint of the user's own, the gate checked: its index's ties follow the natural order (here
  // `by` is 'id': 'refused' is answered above, and 'natural' is safe).
  if (query.hinted) return order.naturalSafe ? own : byId()
  if (order.by === 'natural') return natural
  // A job's read, of everything or past document _ids that may hold a hidden value, is in natural
  // order where that is safe; a page is sorted by _id, so an index still serves its filter
  // (fourteenth review, I-E).
  const all = Object.keys(query.filter).length === 0 && !sort
  if (order.naturalSafe && opts.always && (order.checked || all)) return natural
  return byId()
}

/** What puts documents in `order`: the fields set for it, the keys it sorts by, the fields then dropped. */
function orderParts(order: Order, gc: GateCtx): { set: Document; keys: Document; drop: string[] } | null {
  if (order.by === 'none') return null
  const r = `__mm_r_${gc.nonce}`
  if (order.by === 'id' && !order.checked)
    // A time series' _id may repeat: its ties at random, not in storage order (fourteenth review,
    // Minor 4); so may a folding view's (fourteenth review of explain masking, I-1).
    return order.idUnique && !order.folds
      ? { set: {}, keys: { _id: 1 }, drop: [] }
      : { set: { [r]: { $rand: {} } }, keys: { _id: 1, [r]: 1 }, drop: [r] }
  if (order.by !== 'id') return { set: { [r]: { $rand: {} } }, keys: { [r]: 1 }, drop: [r] }
  // An _id that is a document ties with every other one: those come in a random order.
  const o = `__mm_o_${gc.nonce}`
  return { set: { [o]: typeGuard('$_id'), [r]: { $rand: {} } }, keys: { [o]: 1, [r]: 1 }, drop: [o, r] }
}

const sortWith = (parts: { set: Document; drop: string[] }, sort: Document): Document[] => [
  ...(Object.keys(parts.set).length ? [{ $addFields: parts.set }] : []),
  { $sort: sort },
  ...(parts.drop.length ? [{ $unset: parts.drop }] : []),
]

/**
 * The guarded stages with the documents put in `order` before anything but the leading $match
 * stages reads them: a leading $sort gets the order's keys after its own, in one sort (review M5);
 * otherwise the order's stages go there. A leading $geoNear keeps its distance order, its ties put
 * in the order's where they would come in a hidden one (thirteenth review, I4). An inserted stage
 * belongs to the stage before it, so each user stage's end moves past it.
 */
export function ordered(
  stages: Document[],
  guarded: { stages: Document[]; ends: number[] },
  order: Order,
  gc: GateCtx,
): { stages: Document[]; ends: number[] } {
  const parts = orderParts(order, gc)
  if (!parts) return guarded
  const out = [...guarded.stages]
  const insert = (at: number, added: Document[]) => {
    out.splice(at, 0, ...added)
    return { stages: out, ends: guarded.ends.map((e) => (e >= at ? e + added.length : e)) }
  }
  const first = opOf(stages[0]) ?? ''
  if (first === '$geoNear') {
    const spec = stages[0]!.$geoNear as Document | undefined
    const distance = spec?.distanceField
    // The gate refuses a $geoNear without its key where rules apply (fifteenth review, nit).
    if (typeof distance !== 'string' || typeof spec?.key !== 'string' || !tiesHidden(order, [spec.key]))
      return guarded
    // A distance written over _id leaves no _id to break its ties: they go at random.
    const tie = touchesId(distance) ? orderParts({ ...order, by: 'natural' }, gc)! : parts
    return insert(guarded.ends[0]!, sortWith(tie, { [distance]: 1, ...tie.keys }))
  }
  if (OWN_ORDER.has(first)) return guarded
  let i = 0
  while (opOf(stages[i]) === '$match') i++
  const at = i === 0 ? 0 : guarded.ends[i - 1]!
  if (opOf(stages[i]) === '$sort')
    for (let j = at; j < guarded.ends[i]!; j++) {
      if (opOf(out[j]) !== '$sort') continue
      // The guarded copies the user's sort reads come before it, and go after it.
      const sort = out[j]!.$sort as Document
      // Not where a collation makes _ids equal: they tie (fifteenth review of explain masking, I-1).
      if (order.by === 'id' && !order.checked && order.idUnique && !order.folds && '_id' in sort)
        return guarded
      // A key the user's sort has keeps its direction (fifteenth review, I-2).
      const extra = Object.fromEntries(Object.entries(parts.keys).filter(([k]) => !(k in sort)))
      if (Object.keys(sort).length + Object.keys(extra).length > MAX_SORT_KEYS) break
      const replaced = sortWith(parts, { ...sort, ...extra })
      out.splice(j, 1, ...replaced)
      return { stages: out, ends: guarded.ends.map((e) => (e > j ? e + replaced.length - 1 : e)) }
    }
  return insert(at, sortWith(parts, parts.keys))
}

/** The namespace a join reads, as `foreign` resolves it; null for `$documents`. */
export const joinedNs = (from: unknown, db: string): [string, string] | null =>
  typeof from === 'string'
    ? [db, from]
    : isDocument(from) && typeof from.db === 'string' && typeof from.coll === 'string'
      ? [from.db, from.coll]
      : null
