// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { EJSON, type Document } from 'bson'
import type { AnyBulkWriteOperation } from 'mongodb'
import { maskWith } from '../transfer/copy-job'
import { indexPlan, uniqueOverMask } from '../transfer/collection-spec'
import { PARTIAL_LEFT_OUT, indexMasked, maskerOfPatterns } from '../transfer/masked-definitions'
import type { Pattern } from '../masking/match'
import type { ServerLevel } from '../backup/series'
import { tsCompare, tsText } from './repo'

type Ns = { db: string; coll: string }

export interface ApplyContext {
  /** The sync's source database (a dropDatabase there stops it). */
  sourceDb: string
  /** Where a source namespace goes, or null when the sync does not carry it. */
  targetOf(db: string, coll: string): Ns | null
  /** The paths written as "***" for a source namespace, or null (an unmasked sync). */
  maskFor(db: string, coll: string): Pattern[] | null
  /**
   * Plan ruling 11: one document to skip, by `_id`, cluster time and its source namespace ("db.coll";
   * final review I1: the same `_id` in another collection is another document).
   */
  skip: { id: string; at: string; ns?: string } | null
  /** Spec §1.4: a sharded target's shard key fields (an upsert must name them), or null. */
  shardKeyOf?(target: Ns): string[] | null
  /**
   * Security audit 2026-10-16 (Important 4): file contents cannot be masked; where they are withheld
   * (a masked sync with rules, or an owner restricted on the target where rules are), a GridFS
   * bucket's changes are never written, whatever carries them.
   */
  withholdFiles?: (db: string, coll: string) => boolean
  /**
   * Review of db45c424: the target's feature level, by which an index of a later version (8.3's
   * 2dsphere 4) is built at the target's own; null or left out: unknown.
   */
  targetLevel?: ServerLevel | null
}

/** A dotted path's value in a document, or null when it is missing (as MongoDB stores it in a shard key). */
export function valueAt(doc: Document, path: string): unknown {
  let v: unknown = doc
  for (const k of path.split('.')) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
    v = (v as Document)[k]
  }
  return v === undefined ? null : v
}

export type SchemaStep =
  | { kind: 'createIndexes'; target: Ns; indexes: Document[] }
  | { kind: 'dropIndexes'; target: Ns; names: string[] }
  | { kind: 'create'; source: Ns; target: Ns }

export interface BatchPlan {
  /**
   * `ids[i]` and `ats[i]`: the `_id` key and cluster time of the change behind `ops[i]`; `source`: the
   * source namespace; `pre`: on a sharded target, deletes of documents left under an old shard key
   * value, run before `ops` (final review m14).
   */
  writes: Array<{
    target: Ns
    source: Ns
    ops: AnyBulkWriteOperation[]
    ids: string[]
    ats: string[]
    pre: AnyBulkWriteOperation[]
  }>
  schema: SchemaStep | null
  /** `at`: the stopping event's cluster time (a schema marker passes it, plan ruling 12). */
  stop: { reason: 'schema_changed' | 'source_gone'; detail: string; at: string | null } | null
  /** Events taken from the front of the batch (the place moves past them once applied). */
  consumed: number
  counts: { inserted: number; replaced: number; deleted: number; skipped: number }
  /** Cluster time of the last event consumed ("t.i"). */
  lastTime: string | null
  lastWall: number | null
  skippedOnce: boolean
  /**
   * Independent review of the security pass (minor): what this batch left out, for the activity log
   * — GridFS changes withheld (once per collection) and replayed indexes left out, with why.
   */
  notes: string[]
}

export const GRIDFS_WITHHELD =
  'GridFS file contents are withheld: they cannot be masked, nor checked against the target rules'

/** A skip marker's id for a `modify` a person chose to pass (plan ruling 12). */
export const SCHEMA_SKIP = '$schema'

/** An `_id` as canonical EJSON text: 1, "1" and Int32(1) stay apart, as MongoDB keeps them. */
export const idKey = (id: unknown): string => EJSON.stringify(id, { relaxed: false })

const DATA = new Set(['insert', 'update', 'replace', 'delete'])
const SCHEMA = new Set(['createIndexes', 'dropIndexes', 'create'])
const GONE = new Set(['drop', 'rename', 'dropDatabase', 'invalidate'])

function nsOf(e: Document): Ns | null {
  const ns = e.ns as { db?: unknown; coll?: unknown } | undefined
  return typeof ns?.db === 'string' && typeof ns.coll === 'string' ? { db: ns.db, coll: ns.coll } : null
}

/**
 * Phase 3e-2 spec §1.4: change events, in order, as idempotent target writes. Each `_id` keeps only
 * its last change (an unordered bulkWrite is then safe); a schema event or a stop is taken alone,
 * so it is applied in order with the writes around it.
 */
export function planBatch(events: Document[], c: ApplyContext): BatchPlan {
  const out: BatchPlan = {
    writes: [],
    schema: null,
    stop: null,
    consumed: 0,
    counts: { inserted: 0, replaced: 0, deleted: 0, skipped: 0 },
    lastTime: null,
    lastWall: null,
    skippedOnce: false,
    notes: [],
  }
  const note = (text: string) => {
    if (!out.notes.includes(text)) out.notes.push(text)
  }
  // target ns → _id key → the last operation (Map keeps insertion order; re-set to move it last)
  const byNs = new Map<
    string,
    {
      target: Ns
      source: Ns
      ops: Map<string, { op: AnyBulkWriteOperation; at: string; pre: AnyBulkWriteOperation | null }>
    }
  >()
  const take = (e: Document) => {
    out.consumed++
    if (e.clusterTime) out.lastTime = tsText(e.clusterTime as never)
    if (e.wallTime instanceof Date) out.lastWall = e.wallTime.getTime()
  }
  for (const e of events) {
    const op = String(e.operationType)
    const ns = nsOf(e)
    const special = SCHEMA.has(op) || GONE.has(op) || op === 'modify'
    if (special && out.consumed > 0) break
    const at0 = e.clusterTime ? tsText(e.clusterTime as never) : null
    // Plan ruling 12: a `modify` a person chose to apply or ignore passes, once.
    if (op === 'modify' && c.skip?.id === SCHEMA_SKIP && at0 !== null && tsCompare(at0, c.skip.at) <= 0) {
      take(e)
      continue
    }
    // Final review I3: a rename ONTO a carried collection replaces its contents ($out does this).
    const to = (e.to ?? null) as { db?: unknown; coll?: unknown } | null
    const ontoCarried =
      op === 'rename' &&
      typeof to?.db === 'string' &&
      typeof to.coll === 'string' &&
      c.targetOf(to.db, to.coll) !== null
    // Final review m11: a dropped source database (its event names no collection).
    const dbGone = op === 'dropDatabase' && (e.ns as { db?: unknown } | undefined)?.db === c.sourceDb
    if (
      op === 'invalidate' ||
      dbGone ||
      ((GONE.has(op) || op === 'modify') && ns && c.targetOf(ns.db, ns.coll)) ||
      ontoCarried
    ) {
      out.stop = {
        reason: op === 'modify' ? 'schema_changed' : 'source_gone',
        detail: ontoCarried
          ? `${String(to!.db)}.${String(to!.coll)}`
          : ns
            ? `${ns.db}.${ns.coll}`
            : String((e.ns as { db?: unknown } | undefined)?.db ?? ''),
        at: at0,
      }
      return out
    }
    const withheld = !!ns && (c.withholdFiles?.(ns.db, ns.coll) ?? false)
    if (withheld && c.targetOf(ns.db, ns.coll)) note(`${ns.db}.${ns.coll}: ${GRIDFS_WITHHELD}`)
    const target = ns && !withheld ? c.targetOf(ns.db, ns.coll) : null
    if (!ns || !target) {
      take(e)
      if (special) return out
      continue
    }
    if (SCHEMA.has(op)) {
      take(e)
      const description = (e.operationDescription ?? {}) as { indexes?: Document[] }
      const mask = c.maskFor(ns.db, ns.coll)
      if (op === 'createIndexes') {
        const planned = indexPlan(
          description.indexes ?? [],
          (key, partial) => uniqueOverMask({ key, unique: true, partialFilterExpression: partial }, mask),
          c.targetLevel ?? null,
        )
        // Security audit 2026-10-16 (Important 3): nor one whose partial filter names a masked value.
        const masker = mask ? maskerOfPatterns(mask) : null
        const kept = masker
          ? planned.build.filter((ix) => !indexMasked(ix, ns.db, ns.coll, masker))
          : planned.build
        const left = [
          ...planned.skipped,
          ...planned.build
            .filter((ix) => !kept.includes(ix))
            .map((ix) => ({ name: String(ix.name), reason: PARTIAL_LEFT_OUT })),
        ]
        for (const { name, reason } of left) note(`${ns.db}.${ns.coll}: index ${name} left out: ${reason}`)
        out.schema = { kind: 'createIndexes', target, indexes: kept }
      } else if (op === 'dropIndexes')
        out.schema = {
          kind: 'dropIndexes',
          target,
          names: (description.indexes ?? []).map((i) => String(i.name)),
        }
      else out.schema = { kind: 'create', source: ns, target }
      return out
    }
    if (!DATA.has(op)) {
      take(e)
      continue
    }
    const id = (e.documentKey as { _id?: unknown } | undefined)?._id
    const key = idKey(id)
    const at = e.clusterTime ? tsText(e.clusterTime as never) : ''
    take(e)
    if (
      c.skip &&
      c.skip.id !== SCHEMA_SKIP &&
      c.skip.id === key &&
      c.skip.ns === `${ns.db}.${ns.coll}` &&
      tsCompare(at, c.skip.at) <= 0
    ) {
      out.counts.skipped++
      out.skippedOnce = true
      continue
    }
    const nsKey = `${target.db}.${target.coll}`
    const bucket = byNs.get(nsKey) ?? { target, source: ns, ops: new Map() }
    byNs.set(nsKey, bucket)
    let write: AnyBulkWriteOperation
    let pre: AnyBulkWriteOperation | null = null
    if (op === 'delete') {
      write = { deleteOne: { filter: { _id: id } as Document } }
      out.counts.deleted++
    } else {
      const full = e.fullDocument as Document | null | undefined
      if (!full) continue
      const mask = c.maskFor(ns.db, ns.coll)
      const replacement = mask ? maskWith(full, mask) : full
      const filter: Document = { _id: id }
      const keys = (c.shardKeyOf?.(target) ?? []).filter((k) => k !== '_id')
      // Seventeenth review of explain masking (nit): a stored sub-document is a value, never an operator.
      for (const k of keys) filter[k] = { $eq: valueAt(replacement, k) }
      write = { replaceOne: { filter, replacement, upsert: true } }
      // Final review m14: a changed shard key value moves the document; the old one goes first.
      if (keys.length)
        pre = {
          deleteOne: {
            filter: {
              _id: id,
              $or: keys.map((k) => ({ [k]: { $ne: valueAt(replacement, k) } })),
            } as Document,
          },
        }
      if (op === 'insert') out.counts.inserted++
      else out.counts.replaced++
    }
    bucket.ops.delete(key)
    bucket.ops.set(key, { op: write, at, pre })
  }
  for (const { target, source, ops } of byNs.values())
    if (ops.size)
      out.writes.push({
        target,
        source,
        ops: [...ops.values()].map((o) => o.op),
        ids: [...ops.keys()],
        ats: [...ops.values()].map((o) => o.at),
        pre: [...ops.values()].flatMap((o) => (o.pre ? [o.pre] : [])),
      })
  return out
}
