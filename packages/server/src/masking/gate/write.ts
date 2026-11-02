import type { Document } from 'mongodb'
import { toWire } from '@mongo-manager/shared'
import { MASK } from '../document'
import { newCtx, type GateCtx, type GateDeps } from './context'
import { guardStages, sourceShape } from './pipeline'
import { orderFor } from './order'
import type { Shape } from './shape'
import type { NsMasker } from '../match'
import { fieldOf, fieldsOf, holdsDocument, isDbRef, isDocument, isOperatorDoc, setField } from './values'
import { IndexListingFailed, notSupported, personalField, personalWrite } from './refusal'
import { filterPaths, guardFilter } from './filter'
import { guardValue, refOf } from './expression'

const split = (s: string) => s.split('.')
const INDEX = /^\d+$/
/** "$", "$[]" and "$[id]": every element (or a matched one) of an array. */
const EVERY_ELEMENT = /^\$(\[\w*\])?$/
/** A wildcard index key ("$**", "a.$**") names what is below its prefix. */
const WILDCARD = /(^|\.)\$\*\*$/
const keyPath = (field: string) => split(field.replace(WILDCARD, '')).filter((s) => s !== '')

/** Phase 3c §5: the concrete places (with array positions) that hold a personal value. */
export function personalLocations(value: unknown, shape: Shape, prefix: string[] = []): string[][] {
  if (prefix.length > 0 && shape.personal(prefix)) return [prefix]
  if (Array.isArray(value))
    return value.flatMap((v, i) => personalLocations(v, shape, [...prefix, String(i)]))
  if (!isDocument(value)) return []
  return Object.entries(fieldsOf(value)).flatMap(([k, v]) => personalLocations(v, shape, [...prefix, k]))
}

/**
 * Every value at a path. A numeric segment indexes an array; "$", "$[]" and "$[id]" stand for its
 * elements (final review C1); other segments go through arrays.
 */
export function valuesAt(value: unknown, path: readonly string[]): unknown[] {
  if (path.length === 0) return [value]
  const [head, ...rest] = path
  if (Array.isArray(value)) {
    if (INDEX.test(head!)) return valuesAt(value[Number(head)], rest)
    if (EVERY_ELEMENT.test(head!)) return value.flatMap((v) => valuesAt(v, rest))
    return value.flatMap((v) => valuesAt(v, path))
  }
  const field = isDocument(value) ? fieldOf(value, head!) : undefined
  return field ? valuesAt(field.value, rest) : []
}

/**
 * The path, or a path above it, is personal: writing there changes a personal value. `personal`
 * answers for the fields above in one pass (security review 2026-10-13, I1: a prefix at a time made a
 * path of thousands of segments hold the server for minutes).
 */
export function touchesPersonal(path: readonly string[], shape: Shape): boolean {
  return shape.personal(path)
}

/**
 * Copies containers only; BSON values (ObjectId, Int32…) stay the same instance (final review I3). A
 * DBRef is a container of its fields, which `put` may set: it is copied (phase 3d-1 review I2).
 */
const copy = (v: unknown): unknown =>
  isDbRef(v)
    ? Object.assign(Object.create(Object.getPrototypeOf(v) as object) as object, v, {
        fields: copy(v.fields),
      })
    : typeof (v as { _bsontype?: unknown } | null)?._bsontype === 'string'
      ? v
      : Array.isArray(v)
        ? v.map(copy)
        : isDocument(v)
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)]))
          : v

/** Writes `value` at a concrete path that exists (array positions are numeric segments). */
function put(target: unknown, path: readonly string[], value: unknown): void {
  let node = target as Document
  for (const segment of path.slice(0, -1)) node = fieldOf(node, segment)!.value as Document
  setField(node, path.at(-1)!, value)
}

const targetShape = (db: string, coll: string, deps: GateDeps): Promise<Shape> =>
  sourceShape(db, coll, newCtx(deps, db))

/**
 * The key paths of unique indexes over personal data (a key or the partial filter): changing such a
 * key makes a duplicate-key error answer whether two documents share the hidden value (final
 * review I2).
 */
async function guardedUniqueKeys(
  db: string,
  coll: string,
  shape: Shape,
  deps: GateDeps,
): Promise<string[][]> {
  if (!shape.any) return []
  const indexes = await indexesOrRefuse(db, coll, shape, deps, 'Changing documents')
  const out: string[][] = []
  for (const index of indexes) {
    if (index.unique !== true) continue
    const keys = Object.keys((index.key ?? {}) as Document).map(keyPath)
    const filtered = filterPaths(index.partialFilterExpression)
    const risky =
      keys.some((p) => shape.personal(p) || shape.mayHold(p)) ||
      filtered.some((p) => shape.personal(p) || shape.mayHold(p))
    // Final review of the agent's gate (M-B): what the partial filter reads too: a change there moves
    // a document under the index exactly as its hidden value says.
    if (risky) out.push(...keys, ...filtered)
  }
  return out
}

/** An error of MongoDB's or of its driver, by name (two copies of the driver are installed). */
const isMongoFailure = (e: unknown): boolean => e instanceof Error && /^Mongo/.test(e.name)
/**
 * Not authorized: the user may not list the indexes, a right said as such (13, Unauthorized; Atlas's
 * 8000, "not allowed"; next round, nit).
 */
const denied = (e: unknown): boolean => {
  const { code, codeName } = e as { code?: unknown; codeName?: unknown }
  return code === 13 || code === 8000 || codeName === 'Unauthorized'
}

/**
 * Final review of the agent's gate (M-D): a plain collection always lists its _id index; none listed
 * means they could not be read (the lookup answers [] on a failure): the write is refused, not let
 * through as though no unique index were there.
 */
async function indexesOrRefuse(
  db: string,
  coll: string,
  shape: Shape,
  deps: GateDeps,
  what: string,
): Promise<Document[]> {
  const indexes = await deps.indexes(db, coll)
  if (indexes.length > 0) return indexes
  // A listing that failed (M-4: whatever the kind read before, a new collection's included). A
  // server's own failure (a step-down, a lost connection, a time limit) is said as itself: the job's,
  // not a right the user lacks (next review, M-2).
  if (deps.indexesUnread?.(db, coll) === true) {
    const failure = deps.indexesFailure?.(db, coll)
    // Any of the server's own failures, whatever its code (next round, M-B; by name: two copies of
    // the driver are installed, nit).
    if (isMongoFailure(failure) && !denied(failure)) throw new IndexListingFailed(failure)
    throw notSupported(`${what} where the collection's indexes cannot be read`, shape.ns, { indexes: true })
  }
  // A plain collection that lists none: dropped meanwhile, or unreadable.
  if (deps.kind && (await deps.kind(db, coll)) === 'collection')
    throw notSupported(
      `${what} where the collection's indexes cannot be read (or it was dropped)`,
      shape.ns,
      {
        indexes: true,
      },
    )
  return indexes
}

const bare = (path: readonly string[]) => path.filter((s) => !INDEX.test(s) && !EVERY_ELEMENT.test(s))
/** One path is the other or lies below it. */
function overlaps(a: readonly string[], b: readonly string[]): boolean {
  const [x, y] = [bare(a), bare(b)]
  const n = Math.min(x.length, y.length)
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return false
  return true
}
const uniqueRefusal = (key: string, ns: string) =>
  notSupported(`Changing ${key}, part of a unique index over personal data,`, ns, { unique: true })
const insertRefusal = (key: string, ns: string) =>
  notSupported(`Inserting a value at ${key}, part of a unique index over personal data,`, ns, {
    unique: true,
  })

/** Phase 3c §5.1: a new document may hold no personal value. */
export async function guardInsert(db: string, coll: string, docs: Document[], deps: GateDeps): Promise<void> {
  const shape = await targetShape(db, coll, deps)
  for (const doc of docs) {
    const [first] = personalLocations(doc, shape)
    if (first) throw personalWrite(first.join('.'), shape.ns)
  }
  // Final reviews of the agent's gate (M-C, M-2): nor under a unique index a duplicate key would
  // answer for, wherever a restricted user's documents are inserted (the editor, an import, a copy,
  // a restore).
  await guardInsertUnique(db, coll, docs, deps, shape)
}

/**
 * Final reviews of the agent's gate (M-2, M-1, M-4): a document holding a value at a personal key of
 * a unique index answers, by a duplicate-key error, whether a stored document holds that value. The
 * _id index is unique though MongoDB lists it without the flag; a unique index whose partial filter
 * reads personal data answers for any document (its own key may be null), so none is inserted under
 * it. A key that holds nothing hidden is not checked (a compound one's other keys).
 */
export async function guardInsertUnique(
  db: string,
  coll: string,
  docs: Document[],
  deps: GateDeps,
  /** The target's shape, where the caller read it already (guardInsert). */
  known?: Shape,
): Promise<void> {
  const shape = known ?? (await targetShape(db, coll, deps))
  if (!shape.any || docs.length === 0) return
  const risky = (p: string[]) => shape.personal(p) || shape.mayHold(p)
  for (const index of await indexesOrRefuse(db, coll, shape, deps, 'Inserting')) {
    if (index.unique !== true && index.name !== '_id_') continue
    if (filterPaths(index.partialFilterExpression).some(risky))
      throw notSupported('Inserting under a unique index whose filter reads personal data', shape.ns, {
        unique: true,
      })
    const keys = Object.keys((index.key ?? {}) as Document)
      .map(keyPath)
      .filter(risky)
    // A path that may only hold a hidden value below it collides by a hidden value there alone (a
    // compound _id with none is not refused; review of the agent's gate, M-1).
    for (const doc of docs)
      for (const p of keys) {
        const values = valuesAt(doc, p)
        const hidden = shape.personal(p)
          ? values.length > 0
          : values.some((v) => personalLocations(v, shape, p).length > 0)
        if (hidden) throw insertRefusal(p.join('.'), shape.ns)
      }
  }
}

/** Phase 3c §5.1: $set/$unset of one pinned document; `current` is its stored version. */
export async function guardDocumentUpdate(
  db: string,
  coll: string,
  current: Document,
  set: Document,
  unset: readonly string[],
  deps: GateDeps,
): Promise<void> {
  const shape = await targetShape(db, coll, deps)
  const unique = await guardedUniqueKeys(db, coll, shape, deps)
  const check = (key: string, value: unknown, setting: boolean) => {
    const path = split(key)
    if (touchesPersonal(path, shape)) throw personalWrite(key, shape.ns)
    if (setting) {
      const [brought] = personalLocations(value, shape, path)
      if (brought) throw personalWrite(brought.join('.'), shape.ns)
    }
    // Replacing or removing a sub-document that may hold personal values would remove them.
    if (shape.mayHold(path) && valuesAt(current, path).some(holdsDocument)) throw personalWrite(key, shape.ns)
    if (unique.some((p) => overlaps(p, path))) throw uniqueRefusal(key, shape.ns)
  }
  for (const [key, value] of Object.entries(set)) check(key, value, true)
  for (const key of unset) check(key, undefined, false)
}

/**
 * Phase 3c §5.1: a replacement as a restricted user sends it (personal values as "***"), with the
 * stored values put back in their stored types. Every stored personal value must be "***" at the
 * same place, and no other personal place may be filled.
 */
export async function restoreReplacement(
  db: string,
  coll: string,
  current: Document,
  submitted: Document,
  deps: GateDeps,
): Promise<Document> {
  const shape = await targetShape(db, coll, deps)
  // A personal _id cannot be named by a restricted user (§2); a scalar one under a ** rule can (M1).
  if (shape.personal(['_id']) || (shape.mayHold(['_id']) && holdsDocument(current._id)))
    throw personalWrite('_id', shape.ns)
  const key = (p: readonly string[]) => JSON.stringify(p)
  const stored = new Map(personalLocations(current, shape).map((p) => [key(p), p]))
  const sent = personalLocations(submitted, shape)
  for (const p of sent)
    if (!stored.has(key(p)) || valuesAt(submitted, p)[0] !== MASK) throw personalWrite(p.join('.'), shape.ns)
  const sentKeys = new Set(sent.map(key))
  for (const [k, p] of stored) if (!sentKeys.has(k)) throw personalWrite(p.join('.'), shape.ns)
  const out = copy(submitted) as Document
  for (const p of stored.values()) put(out, p, valuesAt(current, p)[0])
  for (const p of await guardedUniqueKeys(db, coll, shape, deps))
    if (toWire(valuesAt(current, p)) !== toWire(valuesAt(out, p))) throw uniqueRefusal(p.join('.'), shape.ns)
  return out
}

/** Phase 3c §5.3: a view over data with rules would show it where no rule covers it. */
export async function guardViewSource(
  db: string,
  viewOn: string,
  pipeline: Document[],
  deps: GateDeps,
): Promise<void> {
  const gc = newCtx(deps, db)
  const shape = await sourceShape(db, viewOn, gc)
  await guardStages(pipeline, shape, gc)
  if (gc.ruled.value || shape.any) throw notSupported('A view over personal data', `${db}.${viewOn}`)
}

/**
 * Phase 3c §5.4: index builds a restricted user may start. On a key that may hold personal data, a
 * unique build answers whether two documents share a value, a TTL deletes documents by their hidden
 * value (final review I1), and a 2d/2dsphere/hashed/text build fails by the value's type (M4).
 */
export async function guardIndexBuild(
  db: string,
  coll: string,
  key: Record<string, unknown>,
  options: { unique?: boolean; expireAfterSeconds?: number; partialFilterExpression?: Document },
  deps: GateDeps,
): Promise<void> {
  const gc = newCtx(deps, db)
  const shape = await sourceShape(db, coll, gc)
  for (const [field, kind] of Object.entries(key)) {
    const path = keyPath(field)
    if (!(shape.personal(path) || shape.mayHold(path))) continue
    const ordered = kind === 1 || kind === -1
    if (options.unique || options.expireAfterSeconds !== undefined || !ordered)
      throw personalWrite(field, shape.ns)
  }
  if (options.partialFilterExpression) {
    const guarded = guardFilter(options.partialFilterExpression, shape, gc)
    // A rewritten filter would be stored as the user wrote it (final review M3).
    if (JSON.stringify(guarded) !== JSON.stringify(options.partialFilterExpression))
      throw notSupported('This partial filter', shape.ns)
  }
}

const holdsKey = (value: unknown, name: string): boolean =>
  Array.isArray(value)
    ? value.some((v) => holdsKey(v, name))
    : isDocument(value) && Object.entries(fieldsOf(value)).some(([k, v]) => k === name || holdsKey(v, name))

/**
 * Phase 3c §5.4: a validator a restricted user may set. Where rules apply it may not compute
 * ($expr): a computed predicate over a hidden value makes every later write an oracle (final
 * review C4). It goes through the filter gate, and is stored as checked.
 */
export async function guardValidator(
  db: string,
  coll: string,
  validator: Document,
  deps: GateDeps,
): Promise<void> {
  const gc = newCtx(deps, db)
  const shape = await sourceShape(db, coll, gc)
  if (shape.any && holdsKey(validator, '$expr')) throw notSupported('$expr in a validator', shape.ns)
  const guarded = guardFilter(validator, shape, gc)
  // Re-review of C3 (minor 1): the gate rebuilds $let, $map and the like in its own key order (it never
  // reorders a literal): compared whatever the order of their keys.
  if (JSON.stringify(keySorted(guarded)) !== JSON.stringify(keySorted(validator)))
    throw notSupported('This validator', shape.ns)
}

/** A value with every object's keys in order (arrays as they are). */
export function keySorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(keySorted)
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype)
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, keySorted((v as Record<string, unknown>)[k])]),
    )
  return v
}

/** A target that may hold personal data is only written where it holds no sub-document (§5.2). */
export const NOT_A_DOCUMENT = { $not: { $type: ['object', 'array'] } }
/** Operators that put their operand at the target. */
const SETTERS = new Set(['$set', '$setOnInsert'])
/** Operators that add their operand (or its $each) to an array. */
const APPENDERS = new Set(['$push', '$addToSet'])
/** Modifiers of $push/$addToSet that only add: $slice and $sort could drop or reorder (final review C2). */
const ADDING_MODIFIERS = new Set(['$each', '$position'])
/** Operators that change the stored value in place, or compare their operand with it. */
const IN_PLACE = new Set(['$inc', '$mul', '$min', '$max', '$currentDate'])
/** Operators that remove array elements: they could remove a personal value. */
const REMOVERS = new Set(['$pop', '$pull', '$pullAll'])
/** Operators that compare a document operand with what is stored: a probe. */
const COMPARING = new Set(['$min', '$max', '$addToSet'])

/**
 * Phase 3c §5.2: a bulk update (operators or a pipeline) as a restricted user may run it. The filter
 * goes through the query gate; targets that may hold personal data get a condition that skips the
 * documents where they hold a sub-document, so nothing personal is overwritten.
 */
export async function guardBulkUpdate(
  db: string,
  coll: string,
  filter: Document,
  update: Document | Document[],
  deps: GateDeps,
): Promise<{ filter: Document; update: Document | Document[]; output: NsMasker; repeats: boolean }> {
  const gc = newCtx(deps, db)
  const shape = await sourceShape(db, coll, gc)
  const guardedFilter = guardFilter(filter, shape, gc)
  // Twelfth review of explain masking (N-1): a preview pairs each document's before with its after
  // by _id; equal _ids in a storage order a hidden value rules would pair by that order.
  const order = await orderFor(db, coll, shape, gc)
  // Not where `by` is 'refused' alone: a collection clustered by _id holds each once (thirteenth
  // review, N-5), and a view is never updated.
  const repeats = !order.naturalSafe && !order.idUnique
  const unique = await guardedUniqueKeys(db, coll, shape, deps)
  const conditions = new Map<string, Document>()
  const target = (key: string, condition = true): string[] => {
    const path = split(key)
    if (touchesPersonal(path, shape)) throw personalWrite(key, shape.ns)
    if (unique.some((p) => overlaps(p, path))) throw uniqueRefusal(key, shape.ns)
    if (condition && shape.mayHold(path)) {
      // A filter cannot follow "$" or "$[]": such a target over elements that may hold personal
      // data is refused instead (final review C1).
      if (path.some((s) => EVERY_ELEMENT.test(s))) throw personalWrite(key, shape.ns)
      conditions.set(key, { [key]: NOT_A_DOCUMENT })
    }
    return path
  }
  let guardedUpdate: Document | Document[]
  if (Array.isArray(update)) guardedUpdate = update.map((stage) => pipelineStage(stage, shape, gc, target))
  else {
    for (const [op, spec] of Object.entries(update)) {
      if (!isDocument(spec)) throw notSupported(op, shape.ns)
      for (const [key, value] of Object.entries(spec)) {
        if (REMOVERS.has(op)) {
          const path = split(key)
          if (touchesPersonal(path, shape) || shape.mayHold(path)) throw personalWrite(key, shape.ns)
          // Final review of the agent's gate (M-1): emptying an array changes a unique key as a $push does.
          if (unique.some((p) => overlaps(p, path))) throw uniqueRefusal(key, shape.ns)
        } else if (op === '$rename') {
          target(key)
          // The renamed field's contents are unknown here: they must not land where a rule applies (M2).
          const to = String(value)
          if (shape.mayHold(split(to))) throw personalWrite(to, shape.ns)
          target(to)
        } else if (op === '$unset') target(key)
        else if (SETTERS.has(op) || APPENDERS.has(op) || IN_PLACE.has(op)) {
          // Appending never replaces what is stored: no condition for it.
          const path = target(key, !APPENDERS.has(op))
          const modifiers = APPENDERS.has(op) && isOperatorDoc(value) ? Object.keys(value) : []
          if (shape.mayHold(path) && modifiers.some((m) => !ADDING_MODIFIERS.has(m)))
            throw personalWrite(key, shape.ns)
          const items = modifiers.length && Array.isArray(value.$each) ? (value.$each as unknown[]) : [value]
          for (const item of items) {
            const [brought] = personalLocations(item, shape, path)
            if (brought) throw personalWrite(brought.join('.'), shape.ns)
            if (COMPARING.has(op) && shape.mayHold(path) && holdsDocument(item))
              throw personalWrite(key, shape.ns)
          }
        } else throw notSupported(op, shape.ns)
      }
    }
    guardedUpdate = update
  }
  return {
    filter: conditions.size ? { $and: [guardedFilter, ...conditions.values()] } : guardedFilter,
    update: guardedUpdate,
    // W2 review (C1): what a read of these documents is masked with (a bulk preview's samples).
    output: shape.output(),
    repeats,
  }
}

/** One stage of an update pipeline: $set/$addFields and $unset only, where rules apply (§5.2). */
function pipelineStage(
  stage: Document,
  shape: Shape,
  gc: GateCtx,
  target: (key: string) => string[],
): Document {
  if (!isDocument(stage) || Object.keys(stage).length !== 1) throw notSupported('This update', shape.ns)
  const op = Object.keys(stage)[0]!
  const arg = stage[op]
  if (op === '$unset') {
    for (const key of Array.isArray(arg) ? arg : [arg]) target(String(key))
    return stage
  }
  if (op === '$set' || op === '$addFields') return { [op]: pipelineOutputs(arg, [], shape, gc, target) }
  // $project, $replaceRoot and $replaceWith rebuild the document: personal values could be dropped.
  if (shape.any) throw personalWrite(op, shape.ns)
  return stage
}

/**
 * $set/$addFields merge an object literal into an embedded document, so each leaf is its own
 * target; an empty literal replaces what is there, so it is a target itself (final review C3).
 */
function pipelineOutputs(
  spec: unknown,
  prefix: string[],
  shape: Shape,
  gc: GateCtx,
  target: (key: string) => string[],
): Document {
  if (!isDocument(spec)) throw notSupported('$set', shape.ns)
  const out: Document = {}
  for (const [key, value] of Object.entries(spec)) {
    const path = [...prefix, ...split(key)]
    const literal = isDocument(value) && !isOperatorDoc(value)
    if (!literal || Object.keys(value).length === 0) target(path.join('.'))
    const ref = refOf(value, gc, shape.ns)
    if (Array.isArray(ref)) {
      if (ref.length > 0 && shape.personal(ref)) throw personalField(ref.join('.'), shape.ns)
      // Stored, a moved subtree would sit where no rule covers it; a value moved into a place that
      // may hold personal data could put a known value there (final review M2).
      if (shape.mayHold(ref) || shape.mayHold(path)) throw personalWrite(path.join('.'), shape.ns)
      out[key] = value
    } else if (literal) out[key] = pipelineOutputs(value, path, shape, gc, target)
    else out[key] = guardValue(value, shape, gc)
  }
  return out
}

/**
 * Final review of the agent's gate (next round, M-C): a collection about to be made for a restricted
 * write whose indexes cannot be read is refused before it is made (none is left behind).
 */
export async function guardIndexesReadable(db: string, coll: string, deps: GateDeps): Promise<void> {
  const shape = await targetShape(db, coll, deps)
  if (shape.any) await indexesOrRefuse(db, coll, shape, deps, 'Writing')
}
