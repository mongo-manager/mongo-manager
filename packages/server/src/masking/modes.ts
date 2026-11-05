// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyRequest } from 'fastify'
import { maskerFor } from './request'
import { notSupported } from './gate'
import { newCtx } from './gate/context'
import { sourceShape } from './gate/pipeline'
import { gateFor } from './restricted'
import { hostsKeyVault } from '../connections/access'
import { bucketRuled } from './gridfs'
import { clientFor, withMongo } from '../data/mongo-errors'

/**
 * Phase 3c §6: how a connection route treats personal data.
 * - guarded: the gate and the output masker are applied in the handler;
 * - names-only: no document value goes in or out;
 * - denied: refused to restricted users;
 * - denied-when-ruled: refused to restricted users where rules apply (writes, until phase 3c-2) — a
 *   collection, a GridFS bucket (user report 2026-10-27: its files and chunks), or a database.
 */
export type MaskingMode = 'guarded' | 'names-only' | 'denied' | 'denied-when-ruled'

/**
 * User report 2026-10-27 and its review (I1): whether a GridFS bucket's file contents are hidden from
 * the caller — judged as a collection's are, by what its `files` and `chunks` read: a bucket of views
 * over a bucket a rule reaches is that bucket. A view MongoDB will not show, an internal collection,
 * or a read that fails counts as locked (the safe side). The key vault's database is locked whole:
 * nothing there is checked for what a key's document holds (review nit).
 */
export async function bucketLocked(request: FastifyRequest, db: string, bucket: string): Promise<boolean> {
  if (!maskerFor(request)) return false
  if (hostsKeyVault(db)) return true
  const gate = gateFor(request, await clientFor(request))!
  for (const coll of [`${bucket}.files`, `${bucket}.chunks`]) {
    try {
      if ((await withMongo(() => sourceShape(db, coll, newCtx(gate, db)))).any) return true
    } catch {
      return true
    }
  }
  return false
}

/**
 * Review of the rule scope (M1): a collection a restricted caller writes into by a new name (a rename,
 * a duplicate) — as $out and $merge, never one with rules, nor a collection of a bucket a rule reaches.
 */
export function assertWriteTargetFree(request: FastifyRequest, db: string, to: string): void {
  const masker = maskerFor(request)
  if (!masker) return
  if (masker.forNs(db, to).any || bucketRuled(masker, db, to))
    throw notSupported('Writing where personal fields are hidden', `${db}.${to}`)
}

/** The preHandler that enforces 'denied' and 'denied-when-ruled', after the connection guard. */
export function maskingGate(mode: MaskingMode) {
  return async (request: FastifyRequest): Promise<void> => {
    if (mode !== 'denied' && mode !== 'denied-when-ruled') return
    if (!request.connection) return
    const masker = maskerFor(request)
    if (!masker) return
    const { db, coll, bucket } = request.params as { db?: unknown; coll?: unknown; bucket?: unknown }
    const ns =
      typeof db === 'string' ? (typeof coll === 'string' ? `${db}.${coll}` : db) : request.connection.id
    if (mode === 'denied') throw notSupported('This action', ns)
    let ruled: boolean
    if (typeof db === 'string' && typeof coll === 'string') {
      // A view reads its source: its rules count (final review C5). sourceShape refuses a closed
      // view and MongoDB's internal collections itself.
      const gate = gateFor(request, await clientFor(request))!
      ruled = (await withMongo(() => sourceShape(db, coll, newCtx(gate, db)))).any
    } else if (typeof db === 'string' && typeof bucket === 'string') {
      // Review of the rule scope (nit): named as what it is, reading or writing.
      if (await bucketLocked(request, db, bucket))
        throw notSupported('GridFS file contents', `${db}.${bucket}`)
      return
    } else ruled = typeof db === 'string' ? masker.anyInDb(db) : masker.anyRules
    if (ruled) throw notSupported('Changing data where personal fields are hidden', ns)
  }
}
