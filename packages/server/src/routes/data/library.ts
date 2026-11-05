// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  LibraryPinSchema,
  LibraryQuerySchema,
  deserializeValue,
  formatShell,
  permissionsFor,
  type LibraryItem,
} from '@mongo-manager/shared'
import { Errors } from '../../errors'
import { parseInput } from '../../validate'
import {
  ADMIN_ONLY_DATABASES,
  CREDENTIAL_COLLECTIONS,
  isAdminOnlyNamespace,
  mayUseShell,
  requireConnection,
} from '../../connections/access'
import { viewAwareMaskerFor } from '../../masking/restricted'
import type { Masker } from '../../masking/match'
import { maskFindDef, maskPipelineDef } from '../../masking/definitions'
import type { ByteBudget } from '../../queries/budget'
import type { SealedItemRow } from '../../queries/sealed-items'
import { pinsOf, setPin, type PinRef } from '../../queries/pins'
import { ownerOf, seesOwnerless } from './owners'

/**
 * Phase 2c spec §2.2 and final review 2c (I2b): the bounds of one search. It opens at most
 * `history` history rows and `saved` favourites and pipelines each (2 000 + 2 × 1 500), and at most
 * `openBytes` of sealed text in all; it answers at most `responseBytes` of items. Past any of
 * them, `truncated` says so.
 */
export interface LibraryLimits {
  history: number
  saved: number
  openBytes: number
  responseBytes: number
}
export const LIBRARY_LIMITS: Readonly<LibraryLimits> = {
  history: 2000,
  saved: 1500,
  openBytes: 8 * 1024 * 1024,
  responseBytes: 4 * 1024 * 1024,
}
const PREVIEW = 200

const IdParams = z.object({ id: z.string().max(64), entryId: z.string().uuid() })

function shellOf(body: unknown): string {
  // Query parameters: a find's defaults are not the query; its {{parameters}} are shown as typed.
  const { params: _defaults, ...query } = (body ?? {}) as Record<string, unknown>
  try {
    return formatShell(deserializeValue(Array.isArray(body) ? body : query), { indent: 0, params: true })
  } catch {
    return JSON.stringify(body)
  }
}

/** A history aggregation is kept as { stages }; the library gives stages, as for a saved pipeline. */
function historyBody(kind: 'find' | 'aggregate', body: unknown): unknown {
  if (kind === 'find') return body
  const stages = (body as { stages?: unknown } | null)?.stages
  return Array.isArray(stages) ? stages : []
}

/** A candidate before its preview is made: `text` is the canonical EJSON the search matches. */
type Candidate = Omit<LibraryItem, 'preview'> & { text: string }

/** Pipelines are listed to those who may run them, as their own routes require (Minor 10). */
function mayRunPipelines(request: FastifyRequest): boolean {
  const { ctx } = request.server
  const readOnly = ctx.config.readOnly || request.connection!.readOnly
  return permissionsFor(request.connectionRole!, { readOnly }).has('aggregation:run')
}

/** W1 (completion §2): the preferences' owner of a user's pins (local mode's single user is "local"). */
const pinOwner = (request: FastifyRequest): string => ownerOf(request) ?? 'local'

/**
 * W1: whether the caller may see a saved query, as the library lists it — on this connection, theirs,
 * shared, or ownerless to those who see such; never an admin-only namespace to a non-admin; a pipeline
 * only to those who may run pipelines.
 */
function visibleSaved(request: FastifyRequest, type: PinRef['type'], row: SealedItemRow | null): boolean {
  if (!row || row.connectionId !== request.connection!.id) return false
  if (!(row.ownerId === ownerOf(request) || row.shared || (row.ownerId === null && seesOwnerless(request))))
    return false
  if (request.connectionRole !== 'admin' && isAdminOnlyNamespace(row.db, row.coll)) return false
  return type !== 'pipeline' || mayRunPipelines(request)
}

/** Phase 2c: one search over the favourites, saved pipelines and history a user may see. */
export async function libraryRoutes(app: FastifyInstance): Promise<void> {
  const BASE = '/connections/:id/library'

  app.get(
    BASE,
    { preHandler: requireConnection('documents:read'), config: { masking: 'guarded' } },
    async (request) => {
      const query = parseInput(LibraryQuerySchema, request.query ?? {})
      const { ctx } = request.server
      const limits = ctx.library.limits
      const owner = ownerOf(request)
      const connectionId = request.connection!.id
      // What a direct read would refuse is not even opened (final review 2c, Minor 8): the admin-only
      // namespaces, the local database included (security audit 2026-10-16, isAdminOnlyNamespace).
      const admin = request.connectionRole === 'admin'
      const budget: ByteBudget = { left: limits.openBytes, exhausted: false }
      const scope = {
        ...(query.db ? { db: query.db } : {}),
        ...(query.coll ? { coll: query.coll } : {}),
        excludeColls: admin ? [] : [...CREDENTIAL_COLLECTIONS],
        excludeDbs: admin ? [] : [...ADMIN_ONLY_DATABASES],
        budget,
      }
      let truncated = false
      const candidates: Candidate[] = []
      // W1: the saved queries this user pinned, listed first.
      const pins = new Set(
        pinsOf(ctx.preferences, pinOwner(request), connectionId).map((p) => `${p.type}:${p.id}`),
      )

      const saved = (type: 'favourite' | 'pipeline', rows: SealedItemRow[], masker: Masker | null) => {
        if (rows.length > limits.saved) truncated = true
        for (const row of rows.slice(0, limits.saved)) {
          // Phase 3c §4.6: someone else's literals at personal paths are hidden from a restricted
          // user, and the search matches what they see (a hidden value is not findable by search).
          const hidden = row.ownerId === owner ? null : masker
          const stored = JSON.parse(row.text) as unknown
          const body = !hidden
            ? stored
            : type === 'pipeline'
              ? maskPipelineDef(stored, row.db, row.coll, hidden)
              : maskFindDef(stored as Record<string, unknown>, row.db, row.coll, hidden)
          candidates.push({
            type,
            id: row.id,
            db: row.db,
            coll: row.coll,
            name: row.name,
            tags: row.tags,
            kind: type === 'pipeline' ? 'aggregate' : 'find',
            body,
            at: new Date(row.updatedAt).toISOString(),
            shared: row.shared,
            mine: row.ownerId === owner,
            // W5 review: what local mode saved, which a connection admin may change.
            ...(row.ownerId === null && owner !== null ? { ownerless: true } : {}),
            ...(pins.has(`${type}:${row.id}`) ? { pinned: true } : {}),
            text: hidden ? JSON.stringify(body) : row.text,
          })
        }
      }
      // Newest first, so a search that stops early keeps the newest (final review 2c, Minor 9).
      const list = {
        ownerId: owner,
        connectionId,
        ...scope,
        ownerless: seesOwnerless(request),
        order: 'recent' as const,
        limit: limits.saved + 1,
      }
      const favourites = !query.type || query.type === 'favourite' ? ctx.favourites.list(list) : []
      const pipelines =
        (!query.type || query.type === 'pipeline') && mayRunPipelines(request)
          ? ctx.savedPipelines.list(list)
          : []
      // Final review I3: others' items on a view are masked by the view's source rules.
      const masker = await viewAwareMaskerFor(
        request,
        [...favourites, ...pipelines]
          .slice(0, 2 * limits.saved)
          .filter((r) => r.ownerId !== owner)
          .map((r) => [r.db, r.coll] as const),
      )
      saved('favourite', favourites, masker)
      saved('pipeline', pipelines, masker)
      // Phase 3a-2: snippets belong to the connection, not a namespace, and only to those who may use
      // the shell there (spec §3.5).
      if ((!query.type || query.type === 'snippet') && mayUseShell(ctx, request.principal!, connectionId)) {
        const rows = ctx.snippets.list({
          ownerId: owner,
          connectionId,
          ownerless: seesOwnerless(request),
          order: 'recent',
          limit: limits.saved + 1,
          budget,
        })
        if (rows.length > limits.saved) truncated = true
        for (const row of rows.slice(0, limits.saved)) {
          candidates.push({
            type: 'snippet',
            id: row.id,
            db: '',
            coll: '',
            name: row.name,
            tags: row.tags,
            kind: 'shell',
            body: row.body,
            at: new Date(row.updatedAt).toISOString(),
            shared: row.shared,
            mine: row.ownerId === owner,
            // W5 review: what local mode saved, which a connection admin may change.
            ...(row.ownerId === null && owner !== null ? { ownerless: true } : {}),
            text: row.body.code,
          })
        }
      }
      if (!query.type || query.type === 'history') {
        const entries = ctx.history.list({ owner, connectionId, ...scope, limit: limits.history + 1 })
        if (entries.length > limits.history) truncated = true
        for (const e of entries.slice(0, limits.history)) {
          const body = historyBody(e.kind, e.body)
          candidates.push({
            type: 'history',
            id: e.id,
            db: e.db,
            coll: e.coll,
            tags: [],
            kind: e.kind,
            body,
            at: new Date(e.usedAt).toISOString(),
            shared: false,
            mine: true,
            count: e.count,
            text: JSON.stringify(body),
          })
        }
      }
      if (budget.exhausted) truncated = true

      const q = query.q?.trim().toLowerCase()
      const matching = candidates.filter(
        (i) =>
          !q ||
          (i.name ?? '').toLowerCase().includes(q) ||
          i.tags.some((tag) => tag.includes(q)) ||
          `${i.db}.${i.coll}`.toLowerCase().includes(q) ||
          i.text.toLowerCase().includes(q),
      )
      // Every tag of what matches, so a chosen tag keeps the others on offer (final review 2c, Minor 15).
      const tags = [...new Set(matching.flatMap((i) => i.tags))].sort()
      const found = matching
        .filter((i) => query.tags.every((tag) => i.tags.includes(tag)))
        // W1: pinned first, then newest first.
        .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.at.localeCompare(a.at))
      if (found.length > query.limit) truncated = true
      // Previews are made only for what is sent, and what is sent is bounded (final review 2c, I2b).
      const items: LibraryItem[] = []
      let bytes = 0
      for (const { text: _text, ...candidate } of found.slice(0, query.limit)) {
        // A snippet's preview is its code; anything else is shown as shell text.
        const shell =
          candidate.kind === 'shell' ? (candidate.body as { code: string }).code : shellOf(candidate.body)
        const item: LibraryItem = { ...candidate, preview: shell.slice(0, PREVIEW) }
        bytes += JSON.stringify(item).length
        if (bytes > limits.responseBytes) {
          truncated = true
          break
        }
        items.push(item)
      }
      return { items, truncated, tags }
    },
  )

  /**
   * W1 (completion §2): pin or unpin a saved query for the caller. Only what they may see is pinned
   * (anything else is "not found", whether it exists or not); unpinning only changes their own list.
   */
  app.put(
    `${BASE}/pins`,
    { preHandler: requireConnection('documents:read'), config: { masking: 'names-only' } },
    async (request) => {
      const pin = parseInput(LibraryPinSchema, request.body ?? {})
      const { ctx } = request.server
      const repo = (type: PinRef['type']) => (type === 'favourite' ? ctx.favourites : ctx.savedPipelines)
      if (pin.pinned && !visibleSaved(request, pin.type, repo(pin.type).get(pin.id)))
        throw Errors.notFound('Saved query not found')
      setPin(ctx.preferences, pinOwner(request), request.connection!.id, pin, (ref) =>
        visibleSaved(request, ref.type, repo(ref.type).get(ref.id)),
      )
      return { pinned: pin.pinned }
    },
  )

  app.delete(
    `${BASE}/history`,
    { preHandler: requireConnection('documents:read'), config: { masking: 'names-only' } },
    async (request, reply) => {
      request.server.ctx.history.clear(ownerOf(request), request.connection!.id)
      return reply.status(204).send()
    },
  )

  app.delete(
    `${BASE}/history/:entryId`,
    { preHandler: requireConnection('documents:read'), config: { masking: 'names-only' } },
    async (request, reply) => {
      const { entryId } = parseInput(IdParams, request.params)
      if (!request.server.ctx.history.remove(ownerOf(request), entryId))
        throw Errors.notFound('History entry not found')
      return reply.status(204).send()
    },
  )
}
