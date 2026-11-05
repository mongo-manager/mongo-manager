// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { serialize, type Document } from 'bson'
import { deserializeValue, documentDiff, serializeValue, type CompareDiffSample } from '@mongo-manager/shared'
import { Errors } from '../errors'
import { toClient } from '../data/ejson-io'
import { compareIds } from './bson-order'
import { clip, PREVIEW_TEXT } from './clip'

/** At most this many changed paths in one "different" sample (spec §8.4). */
export const MAX_SAMPLE_PATHS = 1000

export type JoinEvent =
  | { kind: 'onlySource'; source: Document }
  | { kind: 'onlyTarget'; target: Document }
  | { kind: 'same' | 'different'; source: Document; target: Document }

/**
 * Each stream must come in strictly increasing _id order, or the join would report wrong groups.
 * Nineteenth review of explain masking (I2): a document goes on only once the next _id is known to
 * be greater, so of two equal ones (a time series') neither is compared, reported or written in its
 * storage order before the stream is refused.
 */
export async function* ordered(
  docs: AsyncIterable<Document>,
  side: 'source' | 'target',
): AsyncGenerator<Document> {
  let last: { id: unknown } | null = null
  let held: Document | null = null
  for await (const doc of docs) {
    // Tenth review of explain masking (I1): MongoDB sorts an array _id (a time series may hold one)
    // by its least element, so it ties with others in their storage order; this join ranks arrays
    // apart. It is refused before anything is held.
    if (Array.isArray(doc._id))
      throw Errors.conflict(`The ${side} holds an array _id; it cannot be compared document by document`, {
        reason: 'id_array',
      })
    const order = last ? compareIds(last.id, doc._id) : -1
    // Final review M10: a time series or sharded collection can hold one _id twice.
    if (order === 0)
      throw Errors.conflict(
        `The ${side} holds duplicate _id values; it cannot be compared document by document`,
        {
          reason: 'id_duplicate',
        },
      )
    if (order > 0)
      throw Errors.conflict(`The ${side} returned _id values out of order; it cannot be compared`, {
        reason: 'id_order',
      })
    last = { id: doc._id }
    if (held) yield held
    held = doc
  }
  if (held) yield held
}

/**
 * Phase 3d-2 spec §6: two _id-ordered streams as "only in source", "only in target", "same" and
 * "different". Memory holds two documents of each side at a time (the one held until the next is
 * known greater), plus the drivers' batches.
 */
export async function* mergeJoin(
  source: AsyncIterable<Document>,
  target: AsyncIterable<Document>,
  same: (s: Document, t: Document) => boolean,
): AsyncGenerator<JoinEvent> {
  const s = ordered(source, 'source')[Symbol.asyncIterator]()
  const t = ordered(target, 'target')[Symbol.asyncIterator]()
  try {
    let a = await s.next()
    let b = await t.next()
    while (!a.done || !b.done) {
      const c = a.done ? 1 : b.done ? -1 : compareIds(a.value._id, b.value._id)
      if (c < 0) {
        yield { kind: 'onlySource', source: a.value as Document }
        a = await s.next()
      } else if (c > 0) {
        yield { kind: 'onlyTarget', target: b.value as Document }
        b = await t.next()
      } else {
        const x = a.value as Document
        const y = b.value as Document
        yield { kind: same(x, y) ? 'same' : 'different', source: x, target: y }
        ;[a, b] = await Promise.all([s.next(), t.next()])
      }
    }
  } finally {
    await Promise.all([s.return(undefined), t.return(undefined)])
  }
}

const isDoc = (v: unknown): v is Document => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  if (typeof (v as { _bsontype?: unknown })._bsontype === 'string') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/** A copy without the given paths (sub-documents walked; array elements that are documents too). */
export function stripPaths(doc: Document, paths: readonly string[][]): Document {
  if (paths.length === 0) return doc
  const out: Document = {}
  for (const [k, v] of Object.entries(doc)) {
    const here = paths.filter((p) => p[0] === k)
    if (here.some((p) => p.length === 1)) continue
    const rest = here.map((p) => p.slice(1))
    const value =
      rest.length === 0
        ? v
        : isDoc(v)
          ? stripPaths(v, rest)
          : Array.isArray(v)
            ? v.map((x) => (isDoc(x) ? stripPaths(x, rest) : x))
            : v
    Object.defineProperty(out, k, { value, enumerable: true, writable: true, configurable: true })
  }
  return out
}

/** Equal BSON bytes after the ignored paths are removed: field order and types count, as in MongoDB. */
export function sameDocument(a: Document, b: Document, ignore: readonly string[][]): boolean {
  const x = serialize(stripPaths(a, ignore))
  const y = serialize(stripPaths(b, ignore))
  return x.length === y.length && Buffer.compare(Buffer.from(x), Buffer.from(y)) === 0
}

/** Final review I3: at most this many characters in one sample, ids, paths and values together. */
export const SAMPLE_CHARS = 20_000

/** A "different" sample: the changes from the target (before) to the source (after), cut. */
export function diffSample(
  source: Document,
  target: Document,
  ignore: readonly string[][],
): CompareDiffSample {
  const before = deserializeValue<Record<string, unknown>>(toClient(stripPaths(target, ignore)))
  const after = deserializeValue<Record<string, unknown>>(toClient(stripPaths(source, ignore)))
  const diff = documentDiff(before, after)
  const changes = diff.kind === 'none' ? [] : diff.changes
  // One budget for the whole sample: values cut at 200 characters, and no more changes once it is spent.
  const budget = { left: SAMPLE_CHARS }
  const id = clip(serializeValue(source._id), budget)
  const shown: CompareDiffSample['changes'] = []
  for (const c of changes.slice(0, MAX_SAMPLE_PATHS)) {
    if (budget.left <= 0) break
    const path = c.path.length > PREVIEW_TEXT ? `${c.path.slice(0, PREVIEW_TEXT)}…` : c.path
    budget.left -= path.length
    shown.push({
      path,
      ...('before' in c ? { before: clip(serializeValue(c.before), budget) } : {}),
      ...('after' in c ? { after: clip(serializeValue(c.after), budget) } : {}),
    })
  }
  return {
    id,
    changes: shown,
    more: shown.length < changes.length,
    ...(changes.length === 0 ? { orderOnly: true } : {}),
  }
}
