// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createHmac } from 'node:crypto'
import type { Document } from 'mongodb'
import {
  DATA_OPS,
  MAX_WATCH_FILTER_BYTES,
  MAX_WATCH_FILTER_DEPTH,
  findServerJs,
  type WatchOptions,
  type WatchTarget,
} from '@mongo-manager/shared'
import { Errors } from '../errors'
import { CREDENTIAL_COLLECTIONS } from '../connections/access'
import { fromClient } from '../data/ejson-io'
import { filterPaths } from '../masking/gate/filter'
import { notSupported, personalField } from '../masking/gate/refusal'
import type { Masker } from '../masking/match'

export interface PipelineInput {
  target: WatchTarget
  filter: Record<string, unknown>
  options: WatchOptions
  /** The viewer administers the connection. */
  admin: boolean
  /** The viewer's masker, or null when nothing is hidden from them. */
  masker: Masker | null
}

/** The event fields that hold document values, and how many path segments name the field itself. */
const DOCUMENT_ROOTS: Array<{ root: string[]; skip: number }> = [
  { root: ['fullDocument'], skip: 1 },
  { root: ['fullDocumentBeforeChange'], skip: 1 },
  { root: ['documentKey'], skip: 1 },
  { root: ['updateDescription', 'updatedFields'], skip: 2 },
]
const DOCUMENT_TOPS = new Set([
  'fullDocument',
  'fullDocumentBeforeChange',
  'documentKey',
  'updateDescription',
])

/** The event fields of schema changes, which can hold values (validators, partial index filters). */
const SCHEMA_TOPS = new Set(['operationDescription', 'stateBeforeChange'])

/** A refused filter: our words for the log, and a code (`size`, `depth`, `server_js`) the web words itself. */
const refuse = (message: string, problem: 'size' | 'depth' | 'server_js') =>
  Errors.validation(message, { reason: 'filter', problem })

function depthOf(v: unknown, depth = 0): number {
  if (depth > MAX_WATCH_FILTER_DEPTH) return depth
  if (v === null || typeof v !== 'object') return depth
  let max = depth
  for (const item of Object.values(v as Record<string, unknown>))
    max = Math.max(max, depthOf(item, depth + 1))
  return max
}

/**
 * Plan ruling 2: what a restricted user may filter on. Final review I7: the manager runs it again
 * when a running feed's viewer becomes restricted or the rules change.
 */
export function checkRestrictedFilter(
  filter: Record<string, unknown>,
  target: WatchTarget,
  masker: Masker,
): void {
  const ns = `${target.db ?? '*'}.${target.coll ?? '*'}`
  // $expr (anywhere, also inside $and/$or/$nor), $jsonSchema and $text can reach any field.
  const text = JSON.stringify(filter)
  if (['"$expr"', '"$jsonSchema"', '"$text"'].some((op) => text.includes(op)))
    throw notSupported('$expr in a change filter', ns)
  for (const path of filterPaths(filter)) {
    // Security review 2026-10-13 (low): a schema event's description (validators, partial index
    // filters) is masked whole for this viewer; a filter must not test what it hides.
    if (SCHEMA_TOPS.has(path[0]!)) throw notSupported(`Filtering by ${path.join('.')}`, ns)
    if (!DOCUMENT_TOPS.has(path[0]!)) continue
    if (target.scope !== 'collection') throw notSupported('Filtering a database feed by document fields', ns)
    const hit = DOCUMENT_ROOTS.find(({ root }) => root.every((seg, i) => path[i] === seg))
    // The whole document, or the update description without a field: cannot be checked by path.
    if (!hit || path.length <= hit.skip) throw notSupported(`Filtering by ${path.join('.')}`, ns)
    const field = path.slice(hit.skip)
    const rules = masker.forNs(target.db!, target.coll!)
    if (rules.matches(field) || rules.under(field)) throw personalField(path.join('.'), ns)
  }
}

/**
 * Spec §1.4: the stream's pipeline, always built here — never a user-supplied stage list. The
 * credential guard (plan ruling 8), the chosen operation types (invalidate always), then the
 * user's `$match`, checked for size, depth, server-side JavaScript and, for a restricted user,
 * personal paths.
 */
export function buildPipeline(i: PipelineInput): Document[] {
  const stages: Document[] = []
  if (!i.admin) {
    const hidden = [...CREDENTIAL_COLLECTIONS]
    stages.push({ $match: { 'ns.coll': { $nin: hidden }, 'to.coll': { $nin: hidden } } })
  }
  const ops = i.options.schemaChanges
    ? i.options.ops
    : i.options.ops.filter((op) => (DATA_OPS as readonly string[]).includes(op))
  stages.push({ $match: { operationType: { $in: [...ops, 'invalidate'] } } })
  if (Object.keys(i.filter).length === 0) return stages
  if (Buffer.byteLength(JSON.stringify(i.filter)) > MAX_WATCH_FILTER_BYTES)
    throw refuse(`A change filter may be at most ${MAX_WATCH_FILTER_BYTES / 1024} KiB`, 'size')
  if (depthOf(i.filter) > MAX_WATCH_FILTER_DEPTH)
    throw refuse(`A change filter may nest at most ${MAX_WATCH_FILTER_DEPTH} levels`, 'depth')
  const js = findServerJs(i.filter)
  if (js)
    throw refuse(
      `${js} runs JavaScript on the MongoDB server and is not available in a change filter`,
      'server_js',
    )
  if (i.masker) checkRestrictedFilter(i.filter, i.target, i.masker)
  stages.push({ $match: fromClient<Document>(i.filter, 'filter') })
  return stages
}

/**
 * Spec §2.4: the audit names a filter by its hash, never by its values. Final review M7: a keyed hash
 * (HMAC with a key derived from the server's secret), so a reader of the audit cannot try guesses
 * of a short filter's values against it.
 */
export function filterHash(filter: Record<string, unknown>, key: Buffer): string | null {
  if (Object.keys(filter).length === 0) return null
  return createHmac('sha256', key).update(JSON.stringify(filter)).digest('hex')
}
