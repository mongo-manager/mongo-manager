import { randomBytes } from 'node:crypto'
import { MongoServerError, type Collection, type Document } from 'mongodb'
import { bsonClassOf, serializeValue, toWire } from '@mongo-manager/shared'
import { maskDocument } from '../masking/document'
import type { NsMasker } from '../masking/match'
import { READ_OPTIONS } from './ejson-io'
import { refuseRepeats } from '../masking/repeats'
import { isOrderRefusal } from '../masking/gate'

/**
 * W2.3 (2026-10-16): a bulk update's preview on a few sampled documents, before and after. MongoDB
 * computes the "after" itself, in an aggregation that reads and never writes: a pipeline update's
 * stages as they are (they are aggregation stages), and an operator update translated to the
 * aggregation expressions that give the same result. Where the translation would not be exact —
 * positional paths, array indexes, modifiers, conditions, _id — there is no sample preview, and
 * the reason says so. A document the update would fail on (a path through an array or a scalar,
 * $inc on a string, a changed _id) is marked, never shown as changed.
 *
 * W2 review (minor 3): the documents as they are and as the update leaves them are two reads of the
 * same documents (by _id, in _id order), so no single answer holds both: a large document never makes
 * an answer over MongoDB's 16 MB.
 */

/** Documents shown before and after. */
export const SAMPLE_SIZE = 3
/**
 * The samples' EJSON in all: what does not fit is left out, and the answer says so (re-review minor
 * 5: a glance of a couple of megabytes, not an export).
 */
export const MAX_SAMPLE_BYTES = 2 * 1024 * 1024

export type Unavailable =
  'positional' | 'path' | 'modifier' | 'operator' | 'condition' | 'timestamp' | 'conflict' | 'stage' | 'id'

/** The stages a pipeline update may use (MongoDB's own list). */
const UPDATE_STAGES = new Set(['$addFields', '$set', '$project', '$unset', '$replaceRoot', '$replaceWith'])

const NUMERIC = ['int', 'long', 'double', 'decimal']

/** The samples a preview answers with: canonical EJSON, masked. */
export type PreviewSamples =
  | { documents: Array<{ before: unknown; after?: unknown; fails?: true }>; cut?: true }
  | { unavailable: Unavailable | 'error' | 'changed' | 'large' | 'repeats'; message?: string }

/** How long each sample read may take: the preview is a glance, not a job. */
const SAMPLE_MS = 10_000

/**
 * The first matched documents (the filter as counted, in _id order, or in the gate's order for a
 * restricted user: `matched`), and for an update what it would make of them. Reads only: the
 * aggregations hold no $out or $merge (the plan's stages are fixed here, a pipeline update's
 * checked against MongoDB's update stages).
 */
export async function previewSamples(
  collection: Collection,
  filter: Document,
  update: Document | Document[] | undefined,
  opts: {
    comment: string
    output: NsMasker | null
    restricted: boolean
    matched?: Document[]
    /** A time series whose _id may repeat: its twins would pair in storage order (eleventh review, I2). */
    repeats?: boolean
  },
): Promise<PreviewSamples> {
  const plan = update === undefined ? null : samplePlan(update)
  if (plan && 'unavailable' in plan) return plan
  const read = (stages: Document[]) =>
    collection
      .aggregate(stages, {
        ...READ_OPTIONS,
        maxTimeMS: SAMPLE_MS,
        allowDiskUse: false,
        comment: opts.comment,
      })
      .toArray()
  let before: Document[]
  let after: Document[] = []
  try {
    before = await read([
      ...(opts.matched ?? [{ $match: filter }, { $sort: { _id: 1 } }]),
      { $limit: SAMPLE_SIZE },
    ])
    // The second read in the first's order, whatever that was: each output pairs with its document.
    const ids = before.map((d) => d._id)
    if (opts.repeats && plan)
      try {
        await refuseRepeats(collection, ids, { comment: opts.comment, maxTimeMS: SAMPLE_MS })
      } catch (e) {
        // Said in the reader's language by its reason (thirteenth review, N-1).
        if (isOrderRefusal(e)) return { unavailable: 'repeats' }
        throw e
      }
    const at = `__mm_at_${randomBytes(6).toString('hex')}`
    if (plan && before.length > 0)
      after = await read([
        { $match: { _id: { $in: ids } } },
        { $set: { [at]: { $indexOfArray: [{ $literal: ids }, '$_id'] } } },
        { $sort: { [at]: 1 } },
        { $unset: at },
        ...plan.stages,
      ])
  } catch (e) {
    if (!(e instanceof MongoServerError)) throw e
    // MongoDB's own words can quote a value: not to someone from whom values are hidden.
    return { unavailable: 'error', ...(opts.restricted ? {} : { message: e.message.slice(0, 500) }) }
  }
  // A document changed or removed between the two reads: the pairs would not match.
  if (plan && after.length !== before.length) return { unavailable: 'changed' }
  const shown = (doc: unknown) => {
    const value = serializeValue(doc)
    return opts.output?.any ? maskDocument(value, opts.output) : value
  }
  const documents: Array<{ before: unknown; after?: unknown; fails?: true }> = []
  let bytes = 0
  let cut = false
  for (const [i, doc] of before.entries()) {
    let sample: { before: unknown; after?: unknown; fails?: true }
    try {
      if (!plan) sample = { before: shown(doc) }
      else {
        const result = plan.finish(doc, after[i]!)
        sample =
          result === null ? { before: shown(doc), fails: true } : { before: shown(doc), after: shown(result) }
      }
    } catch {
      // A document EJSON cannot carry (an out-of-range date) is left out of the glance.
      continue
    }
    bytes += JSON.stringify(sample).length
    if (bytes > MAX_SAMPLE_BYTES) {
      cut = true
      break
    }
    documents.push(sample)
  }
  if (documents.length === 0 && before.length > 0) return { unavailable: 'large' }
  return cut ? { documents, cut: true } : { documents }
}

export interface SamplePlan {
  /** Run on the sampled documents, by _id and in _id order: each output is what the update makes. */
  stages: Document[]
  /** The document as the update leaves it (from the stages' output), or null when it would fail. */
  finish(before: Document, after: Document): Document | null
}

class NotPreviewable extends Error {
  constructor(readonly reason: Unavailable) {
    super(reason)
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  !(v instanceof Date) &&
  bsonClassOf(v) === undefined

/**
 * A path's segments; refused when an aggregation would not address it as an update does.
 * anyId: _id may be named ($setOnInsert, which a bulk update never applies: re-review minor 4).
 */
function segments(path: string, anyId = false): string[] {
  const parts = path.split('.')
  if (parts.some((p) => p.startsWith('$'))) throw new NotPreviewable('positional')
  // An empty segment is refused by MongoDB; a numeric one is an array index to an update but a
  // field name to an aggregation.
  if (parts.some((p) => p === '' || /^\d+$/.test(p) || p.includes('\0'))) throw new NotPreviewable('path')
  // W2 review (I3): _id cannot change; MongoDB refuses any update of it.
  if (parts[0] === '_id' && !anyId) throw new NotPreviewable('id')
  return parts
}

/** The plan for an update: a pipeline update as its stages, an operator update translated. */
export function samplePlan(update: Document | Document[]): SamplePlan | { unavailable: Unavailable } {
  try {
    return Array.isArray(update) ? pipelinePlan(update) : operatorPlan(update)
  } catch (e) {
    if (e instanceof NotPreviewable) return { unavailable: e.reason }
    throw e
  }
}

const sameValue = (a: unknown, b: unknown) => toWire(a) === toWire(b)

/**
 * A pipeline update: its own stages. W2 review (I3): MongoDB keeps _id whatever the pipeline does
 * with it — removed ($unset, $project, $replaceWith), it is put back first; changed, the update fails.
 */
function pipelinePlan(stages: Document[]): SamplePlan {
  for (const stage of stages) {
    const [op] = Object.keys(stage)
    if (!op || !UPDATE_STAGES.has(op)) throw new NotPreviewable('stage')
  }
  return {
    stages,
    finish(before, after) {
      if (!Object.hasOwn(after, '_id')) return { _id: before._id, ...after }
      return sameValue(after._id, before._id) ? after : null
    },
  }
}

interface Built {
  /** Conditions under which MongoDB would apply the update to the document as the preview does. */
  ok: Document[]
  set: Record<string, unknown>
  /** Paths removed, in JavaScript: MongoDB's $unset leaves a path through an array or a scalar alone. */
  unset: string[]
  /** Every path written or read as a source, for the conflict check. */
  touched: string[]
  /**
   * Fields above a target an update may leave alone ($rename of a missing field, $pop and $pull on
   * one): an aggregation's dotted $set makes them as empty documents; MongoDB does not.
   */
  untouchedAbove: string[]
}

const lit = (v: unknown) => ({ $literal: v })
const typeOf = (ref: string) => ({ $type: ref })
const missing = (ref: string) => ({ $eq: [typeOf(ref), 'missing'] })
const typeIn = (ref: string, types: string[]) => ({ $in: [typeOf(ref), types] })

function isNumber(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v)
  const cls = bsonClassOf(v)
  return cls === 'Int32' || cls === 'Double' || cls === 'Long' || cls === 'Decimal128'
}
/** A value $pull can match by equality alone (a document or a regex would be a condition). */
function isScalar(v: unknown): boolean {
  if (v === null || typeof v === 'string' || typeof v === 'boolean' || isNumber(v)) return true
  if (v instanceof Date) return true
  const cls = bsonClassOf(v)
  return cls === 'ObjectId' || cls === 'Decimal128' || cls === 'Long' || cls === 'Timestamp'
}

/** The value at a path through documents only, or undefined. */
function at(doc: unknown, parts: string[]): unknown {
  let v: unknown = doc
  for (const p of parts) {
    if (!isPlain(v) || !Object.hasOwn(v, p)) return undefined
    v = v[p]
  }
  return v
}

/** $unset as MongoDB does it: the field goes when every field above it is a document; else nothing. */
function unsetPath(doc: Document, path: string): void {
  const parts = path.split('.')
  const parent = parts.length === 1 ? doc : at(doc, parts.slice(0, -1))
  if (isPlain(parent)) delete parent[parts.at(-1)!]
}

/** Field names in the order MongoDB adds them (5.0+): numeric names in number order, then text. */
function updateOrder(a: string, b: string): number {
  const na = /^\d+$/.test(a)
  const nb = /^\d+$/.test(b)
  if (na && nb) return Number(a) - Number(b)
  if (na !== nb) return na ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

function operatorPlan(update: Document): SamplePlan {
  const b: Built = { ok: [], set: {}, unset: [], touched: [], untouchedAbove: [] }
  const mayLeaveAlone = (path: string) => {
    const parts = path.split('.')
    for (let i = 1; i < parts.length; i++) b.untouchedAbove.push(parts.slice(0, i).join('.'))
  }
  /** `<path>` as a reference, with the condition that every field above it is a document or missing. */
  const target = (path: string): string => {
    const parts = segments(path)
    b.touched.push(path)
    for (let i = 1; i < parts.length; i++)
      b.ok.push(typeIn(`$${parts.slice(0, i).join('.')}`, ['object', 'missing']))
    return `$${path}`
  }
  const setAt = (path: string, value: unknown) => {
    b.set[path] = value
  }
  for (const [op, spec] of Object.entries(update)) {
    if (!isPlain(spec)) throw new NotPreviewable('operator')
    for (const [path, arg] of Object.entries(spec)) {
      switch (op) {
        case '$set':
          target(path)
          setAt(path, lit(arg))
          break
        case '$setOnInsert':
          // A bulk update never inserts: nothing happens — but MongoDB still refuses one whose path
          // another operator changes too (W2 review I3).
          segments(path, true)
          b.touched.push(path)
          break
        case '$unset':
          // W2 review (minor 1): under an array or a scalar MongoDB removes nothing, and fails not.
          segments(path)
          b.touched.push(path)
          b.unset.push(path)
          break
        case '$inc':
        case '$mul': {
          if (!isNumber(arg)) throw new NotPreviewable('operator')
          const ref = target(path)
          b.ok.push(typeIn(ref, [...NUMERIC, 'missing']))
          setAt(path, {
            $cond: [
              missing(ref),
              op === '$inc' ? lit(arg) : { $multiply: [lit(0), lit(arg)] },
              { [op === '$inc' ? '$add' : '$multiply']: [ref, lit(arg)] },
            ],
          })
          break
        }
        case '$min':
        case '$max': {
          const ref = target(path)
          const better = op === '$min' ? '$lt' : '$gt'
          setAt(path, {
            $cond: [missing(ref), lit(arg), { $cond: [{ [better]: [lit(arg), ref] }, lit(arg), ref] }],
          })
          break
        }
        case '$rename': {
          if (typeof arg !== 'string') throw new NotPreviewable('operator')
          const from = target(path)
          const to = target(arg)
          // A missing source renames nothing: the target stays as it is.
          setAt(arg, { $cond: [missing(from), to, from] })
          mayLeaveAlone(arg)
          b.unset.push(path)
          break
        }
        case '$currentDate': {
          const kind = isPlain(arg) ? arg.$type : arg === true ? 'date' : undefined
          if (kind === 'timestamp') throw new NotPreviewable('timestamp')
          if (kind !== 'date') throw new NotPreviewable('operator')
          target(path)
          setAt(path, '$$NOW')
          break
        }
        case '$push':
        case '$addToSet': {
          let items: unknown[]
          if (isPlain(arg) && Object.keys(arg).some((k) => k.startsWith('$'))) {
            if (Object.keys(arg).some((k) => k !== '$each') || !Array.isArray(arg.$each))
              throw new NotPreviewable('modifier')
            items = arg.$each
          } else items = [arg]
          const ref = target(path)
          b.ok.push(typeIn(ref, ['array', 'missing']))
          const base = { $cond: [missing(ref), [], ref] }
          setAt(
            path,
            op === '$push'
              ? { $concatArrays: [base, lit(items)] }
              : {
                  $reduce: {
                    input: lit(items),
                    initialValue: base,
                    in: {
                      $cond: [
                        { $in: ['$$this', '$$value'] },
                        '$$value',
                        { $concatArrays: ['$$value', ['$$this']] },
                      ],
                    },
                  },
                },
          )
          break
        }
        case '$pop': {
          const end = isNumber(arg) ? Number(arg) : NaN
          if (end !== 1 && end !== -1) throw new NotPreviewable('operator')
          const ref = target(path)
          b.ok.push(typeIn(ref, ['array', 'missing']))
          mayLeaveAlone(path)
          const rest = { $subtract: [{ $size: ref }, 1] }
          setAt(path, {
            $cond: [
              missing(ref),
              '$$REMOVE',
              { $cond: [{ $lte: [{ $size: ref }, 1] }, [], { $slice: [ref, end === 1 ? 0 : 1, rest] }] },
            ],
          })
          break
        }
        case '$pull': {
          if (!isScalar(arg)) throw new NotPreviewable('condition')
          const ref = target(path)
          b.ok.push(typeIn(ref, ['array', 'missing']))
          mayLeaveAlone(path)
          setAt(path, {
            $cond: [
              missing(ref),
              '$$REMOVE',
              { $filter: { input: ref, cond: { $ne: ['$$this', lit(arg)] } } },
            ],
          })
          break
        }
        default:
          throw new NotPreviewable('operator')
      }
    }
  }
  // MongoDB refuses an update whose paths overlap ("a" and "a.b"): so does the preview.
  const paths = [...new Set(b.touched)]
  for (const p of paths)
    for (const q of paths) if (p !== q && q.startsWith(`${p}.`)) throw new NotPreviewable('conflict')
  if (new Set(b.touched).size !== b.touched.length) throw new NotPreviewable('conflict')

  // The flag is computed on the document as it was, before any change; a document it fails is not
  // computed at all (an $add on a string would end the whole read).
  const flag = `ok_${randomBytes(6).toString('hex')}`
  // W2 review (minor 2): new fields land in the order MongoDB adds them.
  const sets = Object.entries(b.set).sort(([a], [c]) => updateOrder(a, c))
  const guarded = Object.fromEntries(
    sets.map(([path, value]) => [path, { $cond: [`$${flag}`, value, null] }]),
  )
  const untouchedAbove = [...new Set(b.untouchedAbove)].sort(
    (x, y) => y.split('.').length - x.split('.').length,
  )
  return {
    stages: [
      { $set: { [flag]: b.ok.length ? { $and: b.ok } : true } },
      ...(sets.length ? [{ $set: guarded }] : []),
    ],
    finish(before, after) {
      if (after[flag] !== true) return null
      const doc = { ...after }
      delete doc[flag]
      for (const path of b.unset) unsetPath(doc, path)
      // Empty documents the preview made where the document had nothing, removed again (deepest
      // first); one another target filled is kept.
      for (const p of untouchedAbove) {
        const parts = p.split('.')
        const value = at(doc, parts)
        if (at(before, parts) === undefined && isPlain(value) && Object.keys(value).length === 0)
          unsetPath(doc, p)
      }
      return doc
    },
  }
}
