// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Document } from 'mongodb'
import type { WatchEvent, WatchUpdate } from '@mongo-manager/shared'
import { toClient } from '../data/ejson-io'
import { isDrillScratch, isRestrictedNamespace } from '../connections/access'
import { maskChangeEvent } from '../masking/change-event'
import { maskLiterals } from '../masking/document'
import type { Masker } from '../masking/match'
import { bucketRuled, isFileContents } from '../masking/gridfs'

/** Spec §1.3: a part of an event larger than this (serialised, after masking) is left out. */
export const ELIDE_BYTES = 256 * 1024

export interface EventContext {
  seq: number
  /** The viewer's masker, or null when nothing is hidden from them. */
  masker: Masker | null
  /** The viewer administers the connection (credential collections are theirs to see). */
  admin: boolean
  elideBytes?: number
}

type Ns = { db?: unknown; coll?: unknown }
type Description = {
  updatedFields?: Document
  removedFields?: unknown[]
  truncatedArrays?: Array<{ field: unknown; newSize: unknown }>
}

const name = (v: unknown) => (typeof v === 'string' ? v : '')
const seconds = (ts: unknown) => {
  const t = (ts as { t?: unknown } | null | undefined)?.t
  return typeof t === 'number' ? t : 0
}
const credential = (ns: Ns | undefined) =>
  ns !== undefined && typeof ns.coll === 'string' && isRestrictedNamespace(name(ns.db), ns.coll, false)

const sizeOf = (v: unknown) => Buffer.byteLength(JSON.stringify(v))

/**
 * Spec §1.3, final review C1/I6: every part that can be large — the documents, the key, the update
 * description, an expanded event's description — is left out above the limit, and named in
 * `elided` beside the event (never inside a document, whose own fields could pose as a marker).
 */
function bound(event: WatchEvent, limit: number): WatchEvent {
  const out: WatchEvent = { ...event }
  const elided: NonNullable<WatchEvent['elided']> = {}
  for (const part of ['fullDocument', 'before', 'documentKey', 'description'] as const) {
    if (out[part] === undefined) continue
    const bytes = sizeOf(out[part])
    if (bytes <= limit) continue
    delete out[part]
    elided[part] = bytes
  }
  if (out.update) {
    const bytes = sizeOf(out.update)
    if (bytes > limit) {
      out.update = { updated: {}, removed: [], truncated: [] }
      elided.update = bytes
    }
  }
  if (Object.keys(elided).length > 0) out.elided = elided
  out.bytes = 0
  out.bytes = sizeOf(out)
  return out
}

function updateOf(d: Description | undefined): WatchUpdate | undefined {
  if (!d) return undefined
  return {
    updated: Object.fromEntries(Object.entries(d.updatedFields ?? {}).map(([k, v]) => [k, toClient(v)])),
    removed: (d.removedFields ?? []).map(String),
    truncated: (d.truncatedArrays ?? []).map((t) => ({ field: String(t.field), newSize: Number(t.newSize) })),
  }
}

/**
 * Spec §1.5: a raw change event (read with READ_OPTIONS) as the web sees it, or null when this
 * viewer may not see it (plan ruling 8). Resume token, session, transaction number and collection
 * UUID never leave the server.
 */
export function toWatchEvent(raw: Document, c: EventContext): WatchEvent | null {
  const ns = raw.ns as Ns | undefined
  const to = raw.to as Ns | undefined
  if (!c.admin && (credential(ns) || credential(to))) return null
  // W4 review C1: a restore drill writing its scratch database is no one's to watch.
  if (isDrillScratch(name(ns?.db)) || isDrillScratch(name(to?.db))) return null
  // Security review 2026-10-13 round 2 (I1): GridFS file contents where personal fields are hidden.
  // User report 2026-10-27: where a rule reaches the bucket.
  if (typeof ns?.coll === 'string' && isFileContents(ns.coll) && bucketRuled(c.masker, name(ns.db), ns.coll))
    return null
  const db = name(ns?.db)
  const coll = typeof ns?.coll === 'string' ? ns.coll : undefined
  const update = updateOf(raw.updateDescription as Description | undefined)
  let event: WatchEvent = {
    seq: c.seq,
    op: String(raw.operationType),
    ns: coll === undefined ? { db } : { db, coll },
    ...(to && typeof to.coll === 'string' ? { to: { db: name(to.db), coll: to.coll } } : {}),
    ...(raw.documentKey !== undefined ? { documentKey: toClient(raw.documentKey) } : {}),
    ...(raw.fullDocument != null ? { fullDocument: toClient(raw.fullDocument) } : {}),
    ...(raw.fullDocumentBeforeChange != null ? { before: toClient(raw.fullDocumentBeforeChange) } : {}),
    ...(update ? { update } : {}),
    ...(raw.operationDescription !== undefined ? { description: toClient(raw.operationDescription) } : {}),
    clusterTime: seconds(raw.clusterTime),
    ...(raw.wallTime instanceof Date ? { wallTime: raw.wallTime.getTime() } : {}),
    masked: false,
    bytes: 0,
  }
  if (c.masker) {
    // An event without a collection (dropDatabase) carries no documents.
    event = maskChangeEvent(event, c.masker.forNs(db, coll ?? '*'))
    if (event.description !== undefined && c.masker.anyInDb(db))
      // Plan ruling 3: index specs and options can hold values (partial filters): masked whole.
      event = { ...event, description: maskLiterals(event.description), masked: true }
  }
  return bound(event, c.elideBytes ?? ELIDE_BYTES)
}
