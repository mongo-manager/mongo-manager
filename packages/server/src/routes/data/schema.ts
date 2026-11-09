// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { SchemaAnalyser, deserializeValue, serializeValue } from '@mongo-manager/shared'
import { parseInput } from '../../validate'
import { AppError } from '../../errors'
import { requireConnection } from '../../connections/access'
import { clientFor, withMongo } from '../../data/mongo-errors'
import { trackOperation } from '../../data/operations'
import { gateFor } from '../../masking/restricted'
import { guardAggregate } from '../../masking/gate'
import { maskDocument } from '../../masking/document'
import { maskAnalysis } from '../../masking/schema'
import { holdReadSlot } from '../../data/page'
import { CollParams } from './params'

/** The whole analysis, MongoDB and this process together (spec §5). */
const ANALYSIS_MS = 60_000

/** The analysis's own time limit; W1 review (minor 8): the composer's suggestions ask for less. */
const SCHEMA_MAX_MS = 60_000
const SchemaBody = z.strictObject({
  sampleSize: z.number().int().min(100).max(10_000).default(1_000),
  maxTimeMS: z.number().int().min(1_000).max(SCHEMA_MAX_MS).default(SCHEMA_MAX_MS),
})

/**
 * Phase 1i spec §5: a sampled schema analysis. The documents stream through the analyser and are
 * never kept; the result is not stored. Number types stay as BSON has them (promoteValues off),
 * so Int32, Double and Long are told apart.
 */
export async function schemaRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/connections/:id/databases/:db/collections/:coll/schema',
    { preHandler: requireConnection('documents:read'), config: { masking: 'guarded' } },
    async (request, reply) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const { sampleSize, maxTimeMS } = parseInput(SchemaBody, request.body ?? {})
      // Security audit 2026-10-16 (Important 2): up to 10,000 sampled documents — a read slot.
      holdReadSlot(request, reply, request.server.ctx.documents.slots)
      const client = await clientFor(request)
      // Phase 3c §4.4: for a restricted user each document is masked before it is analysed.
      const gate = gateFor(request, client)
      const output = gate
        ? (
            await withMongo(() =>
              guardAggregate(db, coll, [{ $sample: { size: sampleSize } }], gate, { order: false }),
            )
          ).output
        : null
      const comment = trackOperation(request, reply, client)
      const analyser = new SchemaAnalyser()
      // A closed request stops the analysis too, not only the running aggregate (final review 1i,
      // Important 2): breaking out of the loop closes the cursor (killCursors).
      let gone = false
      reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) gone = true
      })
      const deadline = Date.now() + ANALYSIS_MS
      await withMongo(async () => {
        const cursor = client
          .db(db)
          .collection(coll)
          .aggregate([{ $sample: { size: sampleSize } }], {
            maxTimeMS,
            allowDiskUse: false,
            promoteValues: false,
            comment,
          })
        for await (const doc of cursor) {
          // The socket itself too: a client gone before the listener was attached sent no event here.
          if (gone || request.raw.socket?.destroyed) break
          // maxTimeMS counts MongoDB's time only; the analysis itself is bounded here.
          if (Date.now() > deadline)
            throw new AppError('MONGO_ERROR', 'The analysis took too long; try a smaller sample', 504)
          analyser.add(
            output?.any
              ? (deserializeValue(maskDocument(serializeValue(doc), output)) as Record<string, unknown>)
              : doc,
          )
        }
      })
      return output ? maskAnalysis(analyser.result(), output) : analyser.result()
    },
  )
}
