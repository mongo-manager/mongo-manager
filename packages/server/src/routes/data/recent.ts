import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireConnection } from '../../connections/access'
import type { RecentQuery } from '../../queries/recent'
import { parseInput } from '../../validate'
import { CollParams } from './params'
import { ownerOf } from './owners'

/** Called after a successful find; a failure to remember is logged, never returned. */
export function rememberQuery(request: FastifyRequest, query: RecentQuery): void {
  const empty =
    Object.keys(query.filter).length === 0 &&
    !query.projection &&
    !query.sort &&
    !query.collation &&
    query.hint === undefined
  if (empty) return
  const { db, coll } = parseInput(CollParams, request.params)
  try {
    request.server.ctx.history.record(ownerOf(request), request.connection!.id, db, coll, 'find', query)
  } catch (e) {
    request.log.warn({ err: e }, 'could not remember the query')
  }
}

/** The query bar shows this many recent finds of the collection. */
const RECENT_SHOWN = 20

/** Called after an aggregation ran (a run, a count or a confirmed write); never fails the request. */
export function rememberPipeline(request: FastifyRequest, stages: unknown[]): void {
  // An empty pipeline is nothing to find again (final review 2c, Minor 11).
  if (stages.length === 0) return
  const { db, coll } = parseInput(CollParams, request.params)
  try {
    request.server.ctx.history.record(ownerOf(request), request.connection!.id, db, coll, 'aggregate', {
      stages,
    })
  } catch (e) {
    request.log.warn({ err: e }, 'could not remember the pipeline')
  }
}

export async function recentQueryRoutes(app: FastifyInstance): Promise<void> {
  const base = '/connections/:id/databases/:db/collections/:coll/recent-queries'

  app.get(
    base,
    { preHandler: requireConnection('documents:read'), config: { masking: 'names-only' } },
    async (request) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const entries = app.ctx.history.list({
        owner: ownerOf(request),
        connectionId: request.connection!.id,
        db,
        coll,
        kind: 'find',
        limit: RECENT_SHOWN,
      })
      return { queries: entries.map((e) => ({ query: e.body as RecentQuery, usedAt: e.usedAt })) }
    },
  )

  app.delete(
    base,
    { preHandler: requireConnection('documents:read'), config: { masking: 'names-only' } },
    async (request, reply) => {
      const { db, coll } = parseInput(CollParams, request.params)
      app.ctx.history.clear(ownerOf(request), request.connection!.id, { db, coll, kind: 'find' })
      return reply.status(204).send()
    },
  )
}
