// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Document } from 'mongodb'
import {
  AggregateCountRequestSchema,
  PreviewRequestSchema,
  RunRequestSchema,
  WritePreviewRequestSchema,
  WriteRequestSchema,
  stageOperator,
  toWire,
  type WritePreview,
} from '@mongo-manager/shared'
import { AppError, Errors } from '../../errors'
import { parseInput } from '../../validate'
import { requireConnection } from '../../connections/access'
import { clientFor, withMongo } from '../../data/mongo-errors'
import { fromClient } from '../../data/ejson-io'
import { trackOperation } from '../../data/operations'
import { presenterFor } from '../../masking/present'
import { gateFor, viewKey } from '../../masking/restricted'
import { guardAggregate, guardOrder } from '../../masking/gate'
import { forRestricted } from '../../masking/errors'
import { readToken, signToken } from '../../data/preview-token'
import { inspectPipeline } from '../../aggregation/inspect'
import { runPreview } from '../../aggregation/preview'
import { collectionScope, connectionScope } from '../../aggregation/cache'
import { openRun } from '../../aggregation/run'
import { CollParams } from './params'
import { rememberPipeline } from './recent'
import { holdReadSlot, holdUntilDone, readerKey } from '../../data/page'

const NS = '/connections/:id/databases/:db/collections/:coll'
/** A write preview is valid this long, as a bulk preview is. */
export const WRITE_PREVIEW_TTL_MS = 10 * 60_000

interface WriteClaims {
  /** kind: an aggregation write, never a bulk preview */
  k: 'aggregate'
  /** connection id */
  c: string
  /** source namespace */
  n: string
  /** SHA-256 of the stages' canonical EJSON */
  r: string
  /** the user who previewed */
  u: string
  /** issued at (ms) */
  t: number
}

const digest = (stages: unknown[]) => createHash('sha256').update(toWire(stages)).digest('hex')
const userKey = readerKey

/** Decodes and inspects the stages of any aggregation request. */
function pipelineOf(request: FastifyRequest, raw: unknown[], db: string) {
  const stages = fromClient<Document[]>(raw, 'stages')
  return { stages, ...inspectPipeline(request, stages, db) }
}

/** Whether the collection exists, and its estimated size. */
async function targetState(request: FastifyRequest, target: { db: string; coll: string }) {
  const client = await clientFor(request)
  const database = client.db(target.db)
  const found = await withMongo(() =>
    database.listCollections({ name: target.coll }, { nameOnly: true }).toArray(),
  )
  if (found.length === 0) return { exists: false, estimatedCount: null }
  const estimatedCount = await withMongo(() =>
    database.collection(target.coll).estimatedDocumentCount({ maxTimeMS: 10_000 }),
  )
  return { exists: true, estimatedCount }
}

/** Phase 2a: the aggregation builder's routes (spec §3.2). */
export async function aggregateRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    `${NS}/aggregate/preview`,
    { preHandler: requireConnection('aggregation:run'), config: { masking: 'guarded' } },
    async (request, reply) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const body = parseInput(PreviewRequestSchema, request.body ?? {})
      const { stages } = pipelineOf(request, body.stages, db)
      const { ctx } = request.server
      const release = ctx.aggregation.previewSlots.acquire(userKey(request))
      if (!release) throw Errors.rateLimited(1_000)
      let gone = false
      // Independent review (I2): the slot goes when the preview is done (finally), not at the close.
      reply.raw.once('close', () => {
        gone = true
      })
      try {
        const client = await clientFor(request)
        // Phase 3c §3.4: a restricted user's stages go through the gate. A write stage never runs in
        // a preview, so only the stages before it are checked here.
        const gate = gateFor(request, client)
        const writeAt = stages.findIndex((s) => ['$out', '$merge'].includes(stageOperator(s) ?? ''))
        const guarded = gate
          ? await withMongo(() =>
              guardAggregate(db, coll, writeAt === -1 ? stages : stages.slice(0, writeAt), gate),
            )
          : null
        const comment = trackOperation(request, reply, client)
        const principal = request.principal
        const { cache } = ctx.aggregation
        const connectionId = request.connection!.id
        const answer = await runPreview({
          collection: client.db(db).collection(coll),
          stages,
          sample: body.sample,
          perStage: body.perStage,
          maxTimeMS: body.maxTimeMS,
          from: body.from,
          comment,
          cache,
          scope: {
            userId: principal?.kind === 'user' ? principal.userId : null,
            connectionId,
            db,
            coll,
            epoch: `${cache.epoch(connectionScope(connectionId))}:${cache.epoch(collectionScope(connectionId, db, coll))}`,
            view: viewKey(request),
          },
          gone: () => gone,
          present: presenterFor(request, guarded?.output ?? null, { ns: `${db}.${coll}`, stored: false })
            .item,
          ...(guarded
            ? {
                guarded: { stages: guarded.stages, ends: guarded.ends },
                describe: forRestricted,
                ordered: await withMongo(() => guardOrder(db, coll, gate!)),
              }
            : {}),
        })
        // Phase 3c §7: which output paths are hidden, so the web can mark them (final review M4).
        return guarded ? { ...answer, masked: guarded.output.patterns.map((p) => [...p]) } : answer
      } finally {
        release()
      }
    },
  )

  app.post(
    `${NS}/aggregate/run`,
    { preHandler: requireConnection('aggregation:run'), config: { masking: 'guarded' } },
    async (request, reply) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const body = parseInput(RunRequestSchema, request.body ?? {})
      const { stages, write } = pipelineOf(request, body.stages, db)
      if (write) throw Errors.validation(`${write.stage} writes: preview the write and confirm it instead`)
      const { ctx } = request.server
      const release = ctx.aggregation.slots.acquire(userKey(request))
      if (!release) throw Errors.rateLimited(5_000)
      // Registered before any await: a client gone while connecting or waiting for the first
      // document still frees its slot and its cursor (final review 2a, C1).
      let run: Awaited<ReturnType<typeof openRun>> | null = null
      let gone = false
      // Independent review (I2): the slot goes once the response is over and the handler is done.
      holdUntilDone(request, reply, release)
      reply.raw.once('close', () => {
        gone = true
        void run?.close()
      })
      try {
        const client = await clientFor(request)
        const gate = gateFor(request, client)
        const guarded = gate ? await withMongo(() => guardAggregate(db, coll, stages, gate)) : null
        const comment = trackOperation(request, reply, client)
        run = await openRun({
          collection: client.db(db).collection(coll),
          stages: guarded?.stages ?? stages,
          limit: body.limit,
          // Twelfth review (M5): the gate's own sort may not fit in memory where the user's did.
          allowDiskUse: body.allowDiskUse || guarded?.ordered === true,
          maxTimeMS: body.maxTimeMS,
          batchSize: body.batchSize,
          comment,
          maxBytes: ctx.aggregation.maxRunBytes,
          present: presenterFor(request, guarded?.output ?? null, { ns: `${db}.${coll}`, stored: false })
            .item,
          ...(guarded ? { describe: forRestricted } : {}),
        })
        if (gone || reply.raw.destroyed) {
          await run.close()
          return reply
        }
        if (body.remember) rememberPipeline(request, body.stages)
        return reply
          .header('content-type', 'application/x-ndjson; charset=utf-8')
          .header('cache-control', 'no-store')
          .send(run.stream)
      } catch (e) {
        release()
        throw e
      }
    },
  )

  app.post(
    `${NS}/aggregate/count`,
    { preHandler: requireConnection('aggregation:run'), config: { masking: 'guarded' } },
    async (request, reply) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const body = parseInput(AggregateCountRequestSchema, request.body ?? {})
      const { stages, write } = pipelineOf(request, body.stages, db)
      if (write) throw Errors.validation(`${write.stage} writes: a write pipeline is not counted`)
      // Security audit 2026-10-16 (Important 2): any pipeline, allowDiskUse, up to 300 s — one of the
      // user's run slots, as a run, held until the answer is sent.
      holdReadSlot(request, reply, request.server.ctx.aggregation.slots)
      const client = await clientFor(request)
      const gate = gateFor(request, client)
      // Final review of explain masking (I-2): a count of what follows a $skip, a $limit, a $group's
      // $first… depends on the order documents come in: counted in the run's order, never a hidden
      // one; only a pipeline of filters alone is counted unordered.
      const filtersOnly = stages.every((s) => stageOperator(s) === '$match')
      const counted = gate
        ? (await withMongo(() => guardAggregate(db, coll, stages, gate, filtersOnly ? { order: false } : {})))
            .stages
        : stages
      const comment = trackOperation(request, reply, client)
      const [result] = await withMongo(() =>
        client
          .db(db)
          .collection(coll)
          .aggregate([...counted, { $count: 'n' }], {
            allowDiskUse: true,
            maxTimeMS: body.maxTimeMS,
            comment,
          })
          .toArray(),
      )
      rememberPipeline(request, body.stages)
      return { count: Number(result?.n ?? 0) }
    },
  )

  app.post(
    `${NS}/aggregate/write-preview`,
    { preHandler: requireConnection('documents:write'), config: { masking: 'guarded' } },
    async (request): Promise<WritePreview> => {
      const { db, coll } = parseInput(CollParams, request.params)
      const body = parseInput(WritePreviewRequestSchema, request.body ?? {})
      const { stages, write } = pipelineOf(request, body.stages, db)
      if (!write) throw Errors.validation('This pipeline does not write: run it instead')
      // Phase 3c final review C4: a write moves data; for a restricted user it goes through the gate,
      // which refuses reading a ruled namespace and writing into one.
      const writeGate = gateFor(request, await clientFor(request))
      if (writeGate) await withMongo(() => guardAggregate(db, coll, stages, writeGate, { order: false }))
      const state = await targetState(request, write)
      const claims: WriteClaims = {
        k: 'aggregate',
        c: request.connection!.id,
        n: `${db}.${coll}`,
        r: digest(stages),
        u: userKey(request),
        t: request.server.ctx.now(),
      }
      return {
        target: { db: write.db, coll: write.coll },
        stage: write.stage,
        ...state,
        token: signToken(claims),
        confirmRequired: write.stage === '$out' && state.exists,
      }
    },
  )

  app.post(
    `${NS}/aggregate/write`,
    {
      preHandler: requireConnection('documents:write'),
      config: { masking: 'guarded', audit: 'aggregation.write' },
    },
    async (request) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const body = parseInput(WriteRequestSchema, request.body ?? {})
      const { stages, write } = pipelineOf(request, body.stages, db)
      if (!write) throw Errors.validation('This pipeline does not write: run it instead')
      // Phase 3c final review C4: a write moves data; for a restricted user it goes through the gate,
      // which refuses reading a ruled namespace and writing into one.
      const writeGate = gateFor(request, await clientFor(request))
      const guardedWrite = writeGate
        ? await withMongo(() => guardAggregate(db, coll, stages, writeGate, { order: false }))
        : null
      request.auditInfo = { details: { target: `${write.db}.${write.coll}`, stage: write.stage } }
      if (!body.token) throw Errors.validation('Preview the write before running it')
      // Reasons let the UI explain the refusal in the user's language, as for bulk operations.
      const stale = (message: string, reason: string) => new AppError('CONFLICT', message, 409, { reason })
      const claims = readToken<WriteClaims>(body.token)
      if (!claims || claims.k !== 'aggregate')
        throw stale('This preview is not valid; preview the write again', 'preview_invalid')
      if (
        claims.c !== request.connection!.id ||
        claims.n !== `${db}.${coll}` ||
        claims.r !== digest(stages) ||
        claims.u !== userKey(request)
      )
        throw stale('The pipeline changed since the preview; preview the write again', 'preview_changed')
      if (request.server.ctx.now() - claims.t > WRITE_PREVIEW_TTL_MS)
        throw stale('The preview expired; preview the write again', 'preview_expired')
      // Checked now, not at preview time: a collection created since would be replaced unasked.
      if (write.stage === '$out' && body.confirm !== write.coll && (await targetState(request, write)).exists)
        throw Errors.validation('$out replaces this collection: type its name to confirm')
      const client = await clientFor(request)
      // Not tied to the request: a closed tab must not stop a confirmed write half way ($merge is
      // not atomic; final review 2a, I7). The comment still names it in $currentOp.
      const comment = `mm-write:${request.id}`
      await withMongo(() =>
        client
          .db(db)
          .collection(coll)
          .aggregate(guardedWrite?.stages ?? stages, {
            allowDiskUse: body.allowDiskUse,
            maxTimeMS: body.maxTimeMS,
            comment,
          })
          .toArray(),
      )
      // Previews of the target now show stale data (final review 2a, Minor 9).
      request.server.ctx.aggregation.cache.bump(collectionScope(request.connection!.id, write.db, write.coll))
      rememberPipeline(request, body.stages)
      return { ok: true, target: { db: write.db, coll: write.coll } }
    },
  )
}
