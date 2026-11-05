// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Document } from 'mongodb'
import { AppError, Errors } from '../../errors'
import { Shape } from './shape'
import { MAX_VIEW_DEPTH, ROOT_SCOPE, rulesFor, type Binding, type GateCtx } from './context'
import { NO_ORDER, joinedNs, orderFor, ordered, type Order } from './order'
import { isDocument, isNumberLike, isOperatorDoc } from './values'
import { checkVarName, guardValue, refOf } from './expression'
import { guardFilter } from './filter'
import { typeGuard } from './guard'
import { MASKING_UNSUPPORTED, PERSONAL_FIELD, notSupported, personalField } from './refusal'
import { bucketRuled, isFileContents } from '../gridfs'

/** Stages that hold no value and move nothing. */
const KEPT = new Set(['$limit', '$skip', '$sample', '$count', '$unset'])
/** Accumulators that place their operand in the output unchanged. */
const MOVE_ACCUMULATORS = new Set(['$push', '$first', '$last'])
const TOP = new Set(['$top', '$bottom', '$topN', '$bottomN'])

export { rulesFor }

/**
 * Phase 3c §3.6: the shape of what reading db.coll gives. A view's pipeline runs inside MongoDB as
 * stored, so it is checked strictly (nothing can be guarded there); a refusal names the view.
 */
export async function sourceShape(db: string, coll: string, gc: GateCtx): Promise<Shape> {
  const ns = `${db}.${coll}`
  // MongoDB's own collections hold copies of documents in other shapes: time-series buckets, the
  // oplog, profiled commands, view definitions, chunk bounds (final review C6).
  if (gc.deps.masker.anyRules && (db === 'local' || db === 'config' || coll.startsWith('system.')))
    throw notSupported('MongoDB system collections', ns)
  // Security review 2026-10-13 (M2): a GridFS bucket's chunks are its files' contents, whose
  // download is denied where personal fields are hidden; read by a find, a pipeline or an export
  // they would rebuild the files. User report 2026-10-27: where a rule reaches the bucket.
  if (isFileContents(coll) && bucketRuled(gc.deps.masker, db, coll))
    throw notSupported('GridFS file contents', ns)
  const own = rulesFor(gc.deps.masker, db, coll)
  const view = await gc.deps.view(db, coll)
  if (!view) {
    const shape = new Shape(ns, own)
    if (shape.any) gc.ruled.value = true
    return shape
  }
  if (gc.depth >= MAX_VIEW_DEPTH) throw notSupported('A chain of views this deep', ns)
  const inner: GateCtx = { ...gc, strict: true, depth: gc.depth + 1, scope: ROOT_SCOPE }
  const base = await sourceShape(db, view.viewOn, inner)
  try {
    await guardStages(view.pipeline, base, inner)
  } catch (e) {
    const d =
      e instanceof AppError ? (e.details as { reason?: unknown; field?: unknown } | undefined) : undefined
    if (d?.reason === PERSONAL_FIELD) throw personalField(String(d.field), ns)
    if (d?.reason === MASKING_UNSUPPORTED) throw notSupported('This view', ns)
    throw e
  }
  const shape = new Shape(ns, [...base.list(), ...own])
  if (shape.any) gc.ruled.value = true
  return shape
}

/**
 * Phase 3c §3.4-3.5: the stages as a restricted user may run them, and where each user stage ends
 * among them (a rewritten $sort is three stages; the preview answers per user stage).
 */
export async function guardStages(
  stages: Document[],
  shape: Shape,
  gc: GateCtx,
): Promise<{ stages: Document[]; ends: number[] }> {
  const out: Document[] = []
  const ends: number[] = []
  const counter = { n: 0 }
  for (const stage of stages) {
    if (!isDocument(stage) || Object.keys(stage).length !== 1)
      throw Errors.validation('Each stage must be a document with one operator')
    const op = Object.keys(stage)[0]!
    out.push(...(await guardStage(op, stage[op], shape, gc, counter)))
    ends.push(out.length)
  }
  return { stages: out, ends }
}

const path = (s: string) => s.split('.')
const refused = (op: string, shape: Shape) => notSupported(op, shape.ns)

/** A pure reference as a move: its path, or null. Personal paths are refused here too. */
function moveOf(value: unknown, shape: Shape, gc: GateCtx): readonly string[] | null {
  const ref = refOf(value, gc, shape.ns)
  if (!Array.isArray(ref)) return null
  if (ref.length > 0 && shape.personal(ref)) throw personalField(ref.join('.'), shape.ns)
  return ref
}

/** $project / $addFields / $set / an object newRoot: moves re-rooted, the rest guarded. */
function outputs(spec: unknown, shape: Shape, gc: GateCtx, prefix: string[], project: boolean): Document {
  if (!isDocument(spec)) throw Errors.validation('A stage specification must be a document')
  const out: Document = {}
  for (const [key, value] of Object.entries(spec)) {
    const at = [...prefix, ...path(key)]
    if (project && isNumberLike(value)) {
      out[key] = value
      continue
    }
    const moved = moveOf(value, shape, gc)
    if (moved) {
      shape.moved(moved, at)
      out[key] = value
    } else if (isDocument(value) && !isOperatorDoc(value)) out[key] = outputs(value, shape, gc, at, project)
    else out[key] = guardValue(value, shape, gc)
  }
  return out
}

/** A move where the operand is a reference, a guarded value otherwise. */
function moveOrGuard(value: unknown, at: string[], shape: Shape, gc: GateCtx): unknown {
  const moved = moveOf(value, shape, gc)
  if (!moved) return guardValue(value, shape, gc)
  shape.moved(moved, at)
  return value
}

function accumulator(value: unknown, at: string[], shape: Shape, gc: GateCtx): Document {
  if (!isOperatorDoc(value) || Object.keys(value).length !== 1)
    throw Errors.validation('An accumulator must be one operator')
  const op = Object.keys(value)[0]!
  const arg = value[op]
  if (MOVE_ACCUMULATORS.has(op)) return { [op]: moveOrGuard(arg, at, shape, gc) }
  if (TOP.has(op) || op === '$firstN' || op === '$lastN') {
    if (!isDocument(arg)) throw refused(op, shape)
    const spec: Document = { ...arg }
    if (isDocument(arg.sortBy))
      for (const key of Object.keys(arg.sortBy)) {
        if (shape.personal(path(key))) throw personalField(key, shape.ns)
        if (shape.mayHold(path(key)))
          throw refused(`${op} sorted by a field that may hold personal data`, shape)
      }
    const field = TOP.has(op) ? 'output' : 'input'
    spec[field] = Array.isArray(arg[field])
      ? (arg[field] as unknown[]).map((item) => moveOrGuard(item, at, shape, gc))
      : moveOrGuard(arg[field], at, shape, gc)
    if ('n' in arg) spec.n = guardValue(arg.n, shape, gc)
    return { [op]: spec }
  }
  if (op === '$accumulator' || op === '$function') throw refused(op, shape)
  return { [op]: guardValue(arg, shape, gc) }
}

/** $group, or a bucket's output (no group key): the key is a value position, accumulators as above. */
function group(spec: unknown, shape: Shape, gc: GateCtx, idKey: string | null): Document {
  if (!isDocument(spec)) throw Errors.validation('A group specification must be a document')
  const out: Document = {}
  for (const [key, value] of Object.entries(spec)) {
    if (key === idKey) out[key] = guardValue(value, shape, gc)
    else out[key] = accumulator(value, [key], shape, gc)
  }
  return out
}

/**
 * Twelfth review of explain masking (I1): what a join reads comes in no hidden order either. A
 * stored view runs as it is (nothing is added to it); documents only checked (a write's, the data
 * model's, a count of filters alone) are left unordered.
 */
async function joinOrder(from: unknown, other: Shape, gc: GateCtx): Promise<Order> {
  const ns = joinedNs(from, gc.db)
  if (gc.strict || gc.unordered || !ns) return NO_ORDER
  return orderFor(ns[0], ns[1], other, gc, gc.always === true)
}

async function foreign(from: unknown, gc: GateCtx): Promise<Shape> {
  if (typeof from === 'string') return sourceShape(gc.db, from, { ...gc, depth: gc.depth + 1 })
  if (isDocument(from) && typeof from.db === 'string' && typeof from.coll === 'string')
    return sourceShape(from.db, from.coll, { ...gc, depth: gc.depth + 1 })
  return new Shape(`${gc.db}.$documents`)
}

async function guardStage(
  op: string,
  arg: unknown,
  shape: Shape,
  gc: GateCtx,
  counter: { n: number },
): Promise<Document[]> {
  if (KEPT.has(op)) return [{ [op]: arg }]
  switch (op) {
    case '$collStats':
      // Ninth review of explain masking: a collection's sizes, latencies and query counts tell the
      // length of what rules hide (polled while a document is written); where rules apply, only its
      // count is read.
      if (shape.any && (!isDocument(arg) || Object.keys(arg).some((k) => k !== 'count')))
        throw notSupported('$collStats beyond its count', shape.ns)
      // Twelfth review (Minor 3): nor where the server is, as $indexStats and explain answers.
      return shape.any ? [{ $collStats: arg }, { $unset: ['host'] }] : [{ $collStats: arg }]
    case '$match':
      return [{ $match: guardFilter(arg, shape, gc) }]
    case '$project':
      return [{ $project: outputs(arg, shape, gc, [], true) }]
    case '$addFields':
    case '$set':
      return [{ [op]: outputs(arg, shape, gc, [], false) }]
    case '$sort':
      return sortStages(arg, shape, gc, counter)
    case '$group':
      return [{ $group: group(arg, shape, gc, '_id') }]
    case '$bucket':
    case '$bucketAuto': {
      if (!isDocument(arg)) throw Errors.validation(`${op} takes a document`)
      const spec: Document = { ...arg, groupBy: guardValue(arg.groupBy, shape, gc) }
      if (isDocument(arg.output)) spec.output = group(arg.output, shape, gc, null)
      return [{ [op]: spec }]
    }
    case '$sortByCount':
      return [{ $sortByCount: guardValue(arg, shape, gc) }]
    case '$unwind':
      moveOf(typeof arg === 'string' ? arg : isDocument(arg) ? arg.path : undefined, shape, gc)
      return [{ $unwind: arg }]
    case '$replaceRoot':
    case '$replaceWith': {
      const root = op === '$replaceRoot' ? (isDocument(arg) ? arg.newRoot : undefined) : arg
      const kept =
        isDocument(root) && !isOperatorDoc(root)
          ? outputs(root, shape, gc, [], false)
          : moveOrGuard(root, [], shape, gc)
      return [op === '$replaceRoot' ? { $replaceRoot: { newRoot: kept } } : { $replaceWith: kept }]
    }
    case '$lookup':
      return lookup(arg, shape, gc, counter)
    case '$unionWith': {
      const spec = typeof arg === 'string' ? { coll: arg } : isDocument(arg) ? arg : null
      if (!spec) throw Errors.validation('$unionWith takes a collection name or a document')
      const other = spec.coll === undefined ? new Shape(`${gc.db}.$documents`) : await foreign(spec.coll, gc)
      const out: Document = { ...spec }
      const order = await joinOrder(spec.coll, other, gc)
      const sub = Array.isArray(spec.pipeline) ? (spec.pipeline as Document[]) : []
      const within = { ...gc, db: joinedNs(spec.coll, gc.db)?.[0] ?? gc.db, scope: ROOT_SCOPE }
      const guarded = ordered(sub, await guardStages(sub, other, within), order, gc)
      if (Array.isArray(spec.pipeline) || guarded.stages.length > 0) out.pipeline = guarded.stages
      shape.add(other.list())
      return [{ $unionWith: out }]
    }
    case '$graphLookup': {
      if (!isDocument(arg) || typeof arg.as !== 'string')
        throw Errors.validation('$graphLookup takes a document with as')
      const other = await foreign(arg.from, gc)
      for (const field of [arg.connectFromField, arg.connectToField]) {
        const p = path(String(field))
        if (other.personal(p)) throw personalField(String(field), other.ns)
        if (other.mayHold(p)) throw refused('$graphLookup on a field that may hold personal data', shape)
      }
      const out: Document = { ...arg, startWith: guardValue(arg.startWith, shape, gc) }
      if (arg.restrictSearchWithMatch !== undefined)
        out.restrictSearchWithMatch = guardFilter(arg.restrictSearchWithMatch, other.clone(), {
          ...gc,
          scope: ROOT_SCOPE,
        })
      shape.nest(path(arg.as), other.list())
      // Final reviews of explain masking (nit, M-1): what $graphLookup gathers comes in the order
      // MongoDB found and kept it (a map by the foreign _id, which may be hidden), whatever the indexes:
      // at random wherever rules apply there; a stored view's pipeline, or one only checked, is left
      // as it is.
      if (!other.any || gc.strict || gc.unordered) return [{ $graphLookup: out }]
      const e = `__mm_e_${gc.nonce}`
      const r = `__mm_r_${gc.nonce}`
      const shuffled = {
        $map: {
          input: {
            $sortArray: {
              input: { $map: { input: `$${arg.as}`, as: 'e', in: { [e]: '$$e', [r]: { $rand: {} } } } },
              sortBy: { [r]: 1 },
            },
          },
          as: 'x',
          in: `$$x.${e}`,
        },
      }
      return [{ $graphLookup: out }, { $set: { [arg.as]: shuffled } }]
    }
    case '$facet': {
      if (!isDocument(arg)) throw Errors.validation('$facet takes a document')
      const out: Document = {}
      const merged: Array<[string, Shape]> = []
      for (const [key, sub] of Object.entries(arg)) {
        if (!Array.isArray(sub)) throw Errors.validation('Each $facet output is a pipeline')
        const inner = shape.clone()
        out[key] = (await guardStages(sub as Document[], inner, gc)).stages
        merged.push([key, inner])
      }
      for (const [key, inner] of merged) shape.nest([key], inner.list())
      return [{ $facet: out }]
    }
    case '$geoNear': {
      if (!isDocument(arg)) throw Errors.validation('$geoNear takes a document')
      if (typeof arg.key === 'string') {
        if (shape.personal(path(arg.key)) || shape.mayHold(path(arg.key)))
          throw personalField(arg.key, shape.ns)
      } else if (shape.any) throw refused('$geoNear without key', shape)
      const out: Document = { ...arg }
      if (arg.query !== undefined) out.query = guardFilter(arg.query, shape, gc)
      return [{ $geoNear: out }]
    }
    case '$setWindowFields':
      return windowStages(arg, shape, gc, counter)
    case '$fill':
      return fillStages(arg, shape, gc, counter)
    case '$densify':
      return [{ $densify: densify(arg, shape) }]
    case '$redact':
      // Where no rule applies nothing can be reached; where one does, only $$ROOT paths (W5).
      return [{ $redact: guardValue(arg, shape, { ...gc, redact: shape.any ? 'root' : 'open' }) }]
    case '$documents':
      return [{ $documents: Array.isArray(arg) ? arg : guardValue(arg, shape, gc) }]
    case '$indexStats':
      // An index's partial filter is a definition someone wrote (final review I2, spec §4.5), and
      // where the server runs is hidden as error messages hide it (ninth review of explain masking).
      return [{ $indexStats: arg }, { $unset: ['spec.partialFilterExpression', 'host'] }]
    case '$out':
    case '$merge': {
      if (gc.ruled.value || shape.any) throw refused(op, shape)
      // Writing into a namespace with rules would replace or change its personal values (final
      // review C4): refused whatever the source.
      const target = writeTarget(op, arg, gc.db)
      // Nor into GridFS file contents, which this user may neither read nor write (round 2, I3).
      if (
        !target ||
        (isFileContents(target.coll) && bucketRuled(gc.deps.masker, target.db, target.coll)) ||
        rulesFor(gc.deps.masker, target.db, target.coll).length > 0
      )
        throw refused(op, shape)
      return [{ [op]: arg }]
    }
    default:
      throw refused(op, shape)
  }
}

/** Where $out or $merge writes; null when it cannot be told (refused). */
function writeTarget(op: string, arg: unknown, db: string): { db: string; coll: string } | null {
  const named = (v: unknown) =>
    typeof v === 'string'
      ? { db, coll: v }
      : isDocument(v) && typeof v.coll === 'string'
        ? { db: typeof v.db === 'string' ? v.db : db, coll: v.coll }
        : null
  if (op === '$out') return named(arg)
  return typeof arg === 'string' ? { db, coll: arg } : isDocument(arg) ? named(arg.into) : null
}

/**
 * A sort specification with every key that may hold personal data replaced by a guarded copy
 * (`guards`, added before the stage and removed after it). `meta` lets `{ $meta }` keys through, as
 * $sort allows; window stages take directions only.
 */
function guardedSort(
  arg: Document,
  shape: Shape,
  gc: GateCtx,
  counter: { n: number },
  tag: 's' | 'w',
  meta: boolean,
): { sort: Document; guards: Document } {
  const guards: Document = {}
  const sort: Document = {}
  for (const [key, dir] of Object.entries(arg)) {
    if (isDocument(dir)) {
      if (!meta) throw notSupported(`Sorting by ${key} this way`, shape.ns)
      sort[key] = dir
      continue
    }
    if (shape.personal(path(key))) throw personalField(key, shape.ns)
    if (!shape.mayHold(path(key))) {
      sort[key] = dir
      continue
    }
    if (gc.strict) throw notSupported('This view', shape.ns)
    const name = `__mm_${tag}${counter.n++}_${gc.nonce}`
    guards[name] = typeGuard(`$${key}`)
    sort[name] = dir
  }
  return { sort, guards }
}

/** The stage between the guarded copies it sorts by and their removal. */
function between(guards: Document, stage: Document): Document[] {
  const names = Object.keys(guards)
  return names.length === 0 ? [stage] : [{ $addFields: guards }, stage, { $unset: names }]
}

/** A key that may hold personal data is sorted by its guarded copy, then the copy is removed. */
function sortStages(arg: unknown, shape: Shape, gc: GateCtx, counter: { n: number }): Document[] {
  if (!isDocument(arg)) throw Errors.validation('$sort takes a document')
  const { sort, guards } = guardedSort(arg, shape, gc, counter, 's', true)
  return between(guards, { $sort: sort })
}

/** Only the keys MongoDB documents for the stage; anything else is refused, not passed on. */
function onlyKeys(op: string, arg: Document, allowed: readonly string[], shape: Shape): void {
  for (const key of Object.keys(arg)) if (!allowed.includes(key)) throw refused(`${op}.${key}`, shape)
}

/** A window or range bound: a number, a date, or one of MongoDB's words; never an expression. */
const isBound = (v: unknown, words: readonly string[]): boolean =>
  (typeof v === 'string' && words.includes(v)) ||
  (isNumberLike(v) && typeof v !== 'boolean') ||
  v instanceof Date

function checkWindow(window: unknown, shape: Shape): void {
  const bad = () => refused('This window', shape)
  if (!isDocument(window)) throw bad()
  for (const [key, value] of Object.entries(window)) {
    if (key === 'unit') {
      if (typeof value !== 'string') throw bad()
    } else if (key === 'documents' || key === 'range') {
      if (!Array.isArray(value) || value.length !== 2) throw bad()
      if (!value.every((b) => isBound(b, ['unbounded', 'current']))) throw bad()
    } else throw bad()
  }
}

/**
 * Partition fields are grouped by their raw values: on a field that may hold personal data, which
 * documents fall together would answer whether their hidden values are equal (the expression form
 * `partitionBy` is guarded instead, as a group key is).
 */
function partitionFields(op: string, fields: unknown, shape: Shape): void {
  if (fields === undefined) return
  if (!Array.isArray(fields) || !fields.every((f) => typeof f === 'string'))
    throw Errors.validation(`${op}.partitionByFields takes field names`)
  for (const field of fields as string[]) {
    if (shape.personal(path(field))) throw personalField(field, shape.ns)
    if (shape.mayHold(path(field)))
      throw refused(`${op} partitioned by a field that may hold personal data`, shape)
  }
}

/**
 * W5: $setWindowFields as a restricted user may run it. The partition is a value position
 * (guarded, as a group key), sort keys that may hold personal data are sorted by guarded copies,
 * and each output is an accumulator as in $group: one that moves a value re-roots its rules, the
 * others see guarded values only. Window bounds are constants. So a window function reads no
 * personal value, and orders and partitions by none.
 */
function windowStages(arg: unknown, shape: Shape, gc: GateCtx, counter: { n: number }): Document[] {
  if (!isDocument(arg) || !isDocument(arg.output))
    throw Errors.validation('$setWindowFields takes a document with output')
  onlyKeys('$setWindowFields', arg, ['partitionBy', 'sortBy', 'output'], shape)
  const spec: Document = {}
  if ('partitionBy' in arg) spec.partitionBy = guardValue(arg.partitionBy, shape, gc)
  let guards: Document = {}
  if ('sortBy' in arg) {
    if (!isDocument(arg.sortBy)) throw Errors.validation('$setWindowFields.sortBy takes a document')
    const sorted = guardedSort(arg.sortBy, shape, gc, counter, 'w', false)
    spec.sortBy = sorted.sort
    guards = sorted.guards
  }
  const output: Document = {}
  for (const [key, value] of Object.entries(arg.output)) {
    if (!isDocument(value)) throw Errors.validation('Each $setWindowFields output is a window operator')
    const { window, ...operator } = value
    if (window !== undefined) checkWindow(window, shape)
    const guarded = accumulator(operator, path(key), shape, gc)
    output[key] = window === undefined ? guarded : { ...guarded, window }
  }
  spec.output = output
  return between(guards, { $setWindowFields: spec })
}

const FILL_METHODS = new Set(['linear', 'locf'])

/**
 * W5: $fill. A masked path is never filled: linear and locf would compute it from its neighbours'
 * hidden values, and a filled value would show where it was missing. Fill values are value
 * positions; sort and partition as in $setWindowFields.
 */
function fillStages(arg: unknown, shape: Shape, gc: GateCtx, counter: { n: number }): Document[] {
  if (!isDocument(arg) || !isDocument(arg.output))
    throw Errors.validation('$fill takes a document with output')
  onlyKeys('$fill', arg, ['partitionBy', 'partitionByFields', 'sortBy', 'output'], shape)
  const spec: Document = {}
  if ('partitionBy' in arg) spec.partitionBy = guardValue(arg.partitionBy, shape, gc)
  if ('partitionByFields' in arg) {
    partitionFields('$fill', arg.partitionByFields, shape)
    spec.partitionByFields = arg.partitionByFields
  }
  let guards: Document = {}
  if ('sortBy' in arg) {
    if (!isDocument(arg.sortBy)) throw Errors.validation('$fill.sortBy takes a document')
    const sorted = guardedSort(arg.sortBy, shape, gc, counter, 'w', false)
    spec.sortBy = sorted.sort
    guards = sorted.guards
  }
  const output: Document = {}
  for (const [field, how] of Object.entries(arg.output)) {
    if (shape.personal(path(field))) throw personalField(field, shape.ns)
    if (!isDocument(how) || Object.keys(how).length !== 1)
      throw Errors.validation('Each $fill output takes a value or a method')
    if ('method' in how) {
      if (typeof how.method !== 'string' || !FILL_METHODS.has(how.method))
        throw Errors.validation('$fill methods are linear and locf')
      // locf and linear copy or interpolate values of the same path: its rules apply to them.
      output[field] = { method: how.method }
    } else if ('value' in how) output[field] = { value: guardValue(how.value, shape, gc) }
    else throw Errors.validation('Each $fill output takes a value or a method')
  }
  spec.output = output
  return between(guards, { $fill: spec })
}

/**
 * W5: $densify. The documents it adds carry steps between the field's values, so a masked field
 * is refused (the steps would trace its hidden values). On a field that may hold personal data
 * only numbers and dates take part (MongoDB refuses a document there), and those are not personal.
 */
function densify(arg: unknown, shape: Shape): Document {
  if (!isDocument(arg) || typeof arg.field !== 'string' || !isDocument(arg.range))
    throw Errors.validation('$densify takes a field and a range')
  onlyKeys('$densify', arg, ['field', 'partitionByFields', 'range'], shape)
  if (shape.personal(path(arg.field))) throw personalField(arg.field, shape.ns)
  partitionFields('$densify', arg.partitionByFields, shape)
  const range = arg.range
  onlyKeys('$densify.range', range, ['step', 'unit', 'bounds'], shape)
  const bad = () => refused('This $densify range', shape)
  if (!isBound(range.step, [])) throw bad()
  if ('unit' in range && typeof range.unit !== 'string') throw bad()
  const bounds = range.bounds
  const boundsOk =
    bounds === 'full' ||
    bounds === 'partition' ||
    (Array.isArray(bounds) && bounds.length === 2 && bounds.every((b) => isBound(b, [])))
  if (!boundsOk) throw bad()
  return arg
}

/**
 * $lookup: the foreign rules nest under `as`. A join key that may hold personal data on either side
 * is compared through a guarded local copy: a guarded value is a scalar or "***", so it never equals
 * a foreign sub-document, and a foreign scalar at a path that is not personal is not personal.
 */
async function lookup(arg: unknown, shape: Shape, gc: GateCtx, counter: { n: number }): Promise<Document[]> {
  if (!isDocument(arg) || typeof arg.as !== 'string')
    throw Errors.validation('$lookup takes a document with as')
  const other = await foreign(arg.from, gc)
  const out: Document = { ...arg }
  const before: Document[] = []
  const after: Document[] = []
  const bindings: Array<[string, Binding]> = []
  if (isDocument(arg.let)) {
    const lets: Document = {}
    for (const [name, value] of Object.entries(arg.let)) {
      checkVarName(name, shape.ns)
      lets[name] = guardValue(value, shape, gc)
      bindings.push([name, 'safe'])
    }
    out.let = lets
  }
  if (arg.localField !== undefined || arg.foreignField !== undefined) {
    const local = path(String(arg.localField))
    const remote = path(String(arg.foreignField))
    if (shape.personal(local)) throw personalField(String(arg.localField), shape.ns)
    if (other.personal(remote)) throw personalField(String(arg.foreignField), other.ns)
    if (shape.mayHold(local) || other.mayHold(remote)) {
      if (gc.strict) throw notSupported('This view', shape.ns)
      const name = `__mm_l${counter.n++}_${gc.nonce}`
      before.push({ $addFields: { [name]: typeGuard(`$${String(arg.localField)}`) } })
      out.localField = name
      after.push({ $unset: [name] })
    }
  }
  const joined = other.clone()
  const order = await joinOrder(arg.from, other, gc)
  const sub = Array.isArray(arg.pipeline) ? (arg.pipeline as Document[]) : []
  const guarded = ordered(
    sub,
    // Review of the GridFS rule scope (nit): a join's stages read names of the database it joins.
    await guardStages(sub, joined, {
      ...gc,
      db: joinedNs(arg.from, gc.db)?.[0] ?? gc.db,
      scope: { vars: new Map(bindings) },
    }),
    order,
    gc,
  )
  if (Array.isArray(arg.pipeline) || guarded.stages.length > 0) out.pipeline = guarded.stages
  shape.nest(path(arg.as), joined.list())
  return [...before, { $lookup: out }, ...after]
}
