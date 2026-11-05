// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Document, Filter, MongoClient, UpdateFilter } from 'mongodb'
import {
  BulkExecuteSchema,
  BulkRequestSchema,
  CollectionNameSchema,
  toWire,
  type BulkRequest,
} from '@mongo-manager/shared'
import { AppError, Errors } from '../../errors'
import { parseInput } from '../../validate'
import { requireConnection } from '../../connections/access'
import { readToken, signToken } from '../../data/preview-token'
import { clientFor, withMongo } from '../../data/mongo-errors'
import { fromClient } from '../../data/ejson-io'
import { trackOperation } from '../../data/operations'
import { gateFor } from '../../masking/restricted'
import { guardBulkUpdate, guardFilterFor, guardOrder, type GateDeps } from '../../masking/gate'
import { toView } from '../../jobs/visibility'
import { holdReadSlot } from '../../data/page'
import { previewSamples } from '../../data/bulk-preview'
import type { NsMasker } from '../../masking/match'
import { CollParams, assertNoServerJs, assertTargetAllowed } from './params'
import { assertWriteTargetFree } from '../../masking/modes'

const DuplicateBody = z.object({ to: CollectionNameSchema })
export const PREVIEW_TTL_MS = 10 * 60_000

interface PreviewClaims {
  /** connection id */
  c: string
  /** namespace */
  n: string
  /** SHA-256 of the canonical request (operation, filter, update) */
  r: string
  /** matched count at preview time */
  m: number
  /** every document matched → typed confirmation required */
  a: boolean
  /** issued at (ms) */
  t: number
}

const requestDigest = (request: BulkRequest) =>
  createHash('sha256')
    .update(toWire({ operation: request.operation, filter: request.filter, update: request.update ?? null }))
    .digest('hex')

const signPreview = (claims: PreviewClaims): string => signToken(claims)
const readPreview = (token: string): PreviewClaims | null => {
  const claims = readToken<PreviewClaims & { k?: unknown }>(token)
  // Another kind of preview (an aggregation write) is not a bulk preview.
  return claims && claims.k === undefined ? claims : null
}

/** A bulk operation through the write gate: an update's targets, or a delete's filter (phase 3c §5.2). */
async function guardedBulk(
  db: string,
  coll: string,
  filter: Document,
  update: UpdateFilter<Document> | Document[] | undefined,
  gate: GateDeps,
): Promise<{
  filter: Filter<Document>
  update: UpdateFilter<Document> | Document[] | undefined
  /** W2 review (C1): the gate's view-aware output, what the preview's samples are masked with. */
  output: NsMasker
  /** Twins whose before and after would pair in storage order (twelfth review, N-1). */
  repeats: boolean
}> {
  if (update === undefined) {
    const guarded = await guardFilterFor(db, coll, filter, gate)
    return { filter: guarded.filter, update, output: guarded.output, repeats: false }
  }
  const guarded = await guardBulkUpdate(db, coll, filter, update as Document | Document[], gate)
  return {
    filter: guarded.filter,
    update: guarded.update as UpdateFilter<Document> | Document[],
    output: guarded.output,
    repeats: guarded.repeats,
  }
}

/**
 * W2 review (C1): MongoDB writes no view, so neither preview nor run a bulk operation on one —
 * whatever a view's preview showed would be read through it.
 */
async function refuseView(client: MongoClient, db: string, coll: string): Promise<void> {
  const [info] = await withMongo(() =>
    // Final review of explain masking (M-3): by name only, of the collections the connection's user
    // may read, as an import's.
    client.db(db).listCollections({ name: coll }, { nameOnly: true, authorizedCollections: true }).toArray(),
  )
  if ((info as { type?: string } | undefined)?.type === 'view')
    throw Errors.validation('A view cannot be updated or deleted in bulk: change the collection it reads')
}

export async function bulkRoutes(app: FastifyInstance): Promise<void> {
  const base = '/connections/:id/databases/:db/collections/:coll'

  const decode = (request: FastifyRequest, body: BulkRequest) => {
    const filter = fromClient<Filter<Document>>(body.filter, 'filter')
    const update =
      body.update === undefined
        ? undefined
        : fromClient<UpdateFilter<Document> | Document[]>(body.update, 'update')
    assertNoServerJs(request, filter, update)
    return { filter, update }
  }

  app.post(
    `${base}/bulk/preview`,
    { preHandler: requireConnection('documents:read'), config: { masking: 'guarded' } },
    async (request, reply) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const body = parseInput(BulkRequestSchema, request.body)
      const { filter, update } = decode(request, body)
      // Security audit 2026-10-16 (Important 2): a count of any filter (30 s) — a read slot.
      holdReadSlot(request, reply, request.server.ctx.documents.slots)
      const client = await clientFor(request)
      await refuseView(client, db, coll)
      // Phase 3c §3.1, §5.2: a restricted user's count is a probe too, and an update is checked here
      // already, so a refusal comes before the confirmation.
      const gate = gateFor(request, client)
      const guarded = gate
        ? await withMongo(() => guardedBulk(db, coll, filter, update, gate))
        : { filter, update, output: null }
      const counted = guarded.filter
      const comment = trackOperation(request, reply, client)
      const collection = client.db(db).collection(coll)
      const [matched, total] = await withMongo(() =>
        Promise.all([
          collection.countDocuments(counted, { maxTimeMS: 30_000, comment }),
          collection.estimatedDocumentCount({ maxTimeMS: 30_000, comment }),
        ]),
      )
      // W2.3: a few of the matched documents before and after (the gate's update for a restricted
      // user), masked as any read is: with the gate's output (review C1), not the namespace's rules.
      // Twelfth review of explain masking (I4): a restricted user's samples come in the gate's
      // order, never in a hidden _id's; of what the count counts, the update's conditions included
      // (thirteenth review, I1).
      const inOrder = gate
        ? [{ $match: counted }, ...(await withMongo(() => guardOrder(db, coll, gate)))]
        : undefined
      const samples = await previewSamples(collection, counted, guarded.update, {
        comment,
        output: guarded.output,
        restricted: gate !== null,
        ...(inOrder ? { matched: inOrder } : {}),
        ...('repeats' in guarded && guarded.repeats ? { repeats: true } : {}),
      })
      // "Every document" is decided by the result, not by the filter's shape ({ $expr: true } is empty in effect).
      const all = Object.keys(filter).length === 0 || (matched > 0 && matched >= total)
      const filterHash = signPreview({
        c: request.connection!.id,
        n: `${db}.${coll}`,
        r: requestDigest(body),
        m: matched,
        a: all,
        t: request.server.ctx.now(),
      })
      return { matched, total, requiresConfirmation: all, filterHash, samples }
    },
  )

  app.post(
    `${base}/bulk/execute`,
    {
      preHandler: requireConnection('documents:write'),
      config: { masking: 'guarded', audit: 'documents.bulk' },
    },
    async (request) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const body = parseInput(BulkExecuteSchema, request.body)
      request.auditInfo = { details: { operation: body.operation, filter: body.filter } }
      const claims = readPreview(body.filterHash)
      // Reasons let the UI explain the refusal in the user's language.
      const stale = (message: string, details: Record<string, unknown>) =>
        new AppError('CONFLICT', message, 409, details)
      if (!claims)
        throw stale('This preview is not valid; preview the operation again', { reason: 'preview_invalid' })
      if (
        claims.c !== request.connection!.id ||
        claims.n !== `${db}.${coll}` ||
        claims.r !== requestDigest(body)
      ) {
        throw stale('The filter or update changed since the preview; preview again before running it', {
          reason: 'preview_changed',
        })
      }
      if (request.server.ctx.now() - claims.t > PREVIEW_TTL_MS)
        throw stale('The preview expired; preview the operation again', { reason: 'preview_expired' })
      if (claims.a && body.confirm !== coll) {
        throw Errors.validation(
          'This affects every document in the collection: type the collection name to confirm',
        )
      }
      const decoded = decode(request, body)
      const client = await clientFor(request)
      await refuseView(client, db, coll)
      const gate = gateFor(request, client)
      // Phase 3c §5.2: the same guarded filter the preview counted with.
      const { filter, update } = gate
        ? await withMongo(() => guardedBulk(db, coll, decoded.filter, decoded.update, gate))
        : decoded
      const collection = client.db(db).collection(coll)
      const now = await withMongo(() => collection.countDocuments(filter, { maxTimeMS: 30_000 }))
      if (now !== claims.m) {
        throw stale(`The number of matching documents changed from ${claims.m} to ${now}; preview again`, {
          reason: 'count_changed',
          from: claims.m,
          to: now,
        })
      }
      if (body.operation === 'delete') {
        const result = await withMongo(() => collection.deleteMany(filter))
        return { deleted: result.deletedCount }
      }
      const result = await withMongo(() => collection.updateMany(filter, update as UpdateFilter<Document>))
      return { matched: result.matchedCount, modified: result.modifiedCount }
    },
  )

  app.post(
    `${base}/duplicate`,
    {
      preHandler: requireConnection('databases:write'),
      config: { masking: 'denied-when-ruled', audit: 'collections.duplicate' },
    },
    async (request, reply) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const { to } = parseInput(DuplicateBody, request.body)
      assertTargetAllowed(request, db, to)
      assertWriteTargetFree(request, db, to)
      // Answers at once (202): a copy of a large collection never meets a request timeout (phase 1h).
      // A taken name is refused here too, so the dialog can say so at the field.
      const client = await clientFor(request)
      const taken = await withMongo(() =>
        client.db(db).listCollections({ name: to }, { nameOnly: true }).toArray(),
      )
      if (taken.length > 0) throw Errors.conflict('A collection or view with that name already exists')
      const principal = request.principal!
      const job = request.server.ctx.jobs.start(
        request.server.ctx.jobKinds['collection.duplicate'],
        {
          userId: principal.kind === 'user' ? principal.userId : null,
          connectionId: request.connection!.id,
          db,
          coll,
          target: to,
        },
        { to },
      )
      request.auditInfo = { details: { to, job: job.id } }
      return reply.status(202).send({ job: toView(request.server.ctx, principal, job) })
    },
  )
}
