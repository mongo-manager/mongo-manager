import type { FastifyInstance } from 'fastify'
import {
  DATA_MODEL_LIMITS,
  DataModelQuerySchema,
  permissionsFor,
  type DataModel,
} from '@mongo-manager/shared'
import { parseInput } from '../../validate'
import { requireConnection } from '../../connections/access'
import { clientFor, withMongo } from '../../data/mongo-errors'
import { trackOperation } from '../../data/operations'
import { holdReadSlot } from '../../data/page'
import { gateFor } from '../../masking/restricted'
import { buildModel } from '../../model/build'
import { DbParams } from './params'
import { ownerOf, seesOwnerless } from './owners'

/** The whole model, MongoDB and this process together. */
const MODEL_MS = 60_000

/**
 * completion W6.4: a database's data model (the database page's Model section). Who may read
 * documents may read it, as the schema analysis; a restricted user's personal fields keep their
 * names only and their values are never read for references. Not stored.
 */
export async function modelRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/connections/:id/databases/:db/model',
    { preHandler: requireConnection('documents:read'), config: { masking: 'guarded' } },
    async (request, reply): Promise<DataModel> => {
      const { db } = parseInput(DbParams, request.params)
      const { sampleSize } = parseInput(DataModelQuerySchema, request.query ?? {})
      // Up to 50 samples and 60 small counts: one read slot for the whole of it.
      holdReadSlot(request, reply, request.server.ctx.documents.slots)
      const client = await clientFor(request)
      const gate = gateFor(request, client)
      const comment = trackOperation(request, reply, client)
      let gone = false
      reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) gone = true
      })
      // The $lookup stages of the saved pipelines this user may open (names only are read).
      const role = request.connectionRole!
      const pipelines = permissionsFor(role).has('aggregation:run')
        ? request.server.ctx.savedPipelines
            .list({
              ownerId: ownerOf(request),
              connectionId: request.connection!.id,
              db,
              ownerless: seesOwnerless(request),
              limit: DATA_MODEL_LIMITS.pipelines,
            })
            .flatMap((row) => {
              try {
                return [{ coll: row.coll, stages: JSON.parse(row.text) as unknown }]
              } catch {
                return []
              }
            })
        : []
      return withMongo(() =>
        buildModel({
          client,
          db,
          sampleSize,
          maxDocs: request.server.ctx.config.modelMaxDocs,
          admin: role === 'admin',
          gate,
          pipelines,
          comment,
          gone: () => gone || !!request.raw.socket?.destroyed,
          deadline: Date.now() + MODEL_MS,
        }),
      )
    },
  )
}
