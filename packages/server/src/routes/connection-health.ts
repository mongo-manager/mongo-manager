import type { FastifyInstance } from 'fastify'
import { permissionsFor, type ConnectionHealth } from '@mongo-manager/shared'
import { requireAuth } from '../http/guards'
import { effectiveRole, requireConnection } from '../connections/access'
import type { Principal } from '../http/context'

/** The list answers for this many connections at most (a page of cards). */
const MAX_LISTED = 200

/**
 * W3.4: live health on the connection cards and the Overview. Anyone who may see a connection may
 * see its health (a connection test tells them as much); the count of alerts firing only where they
 * may watch its server (server:monitor).
 */
export async function connectionHealthRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app
  const firing = (p: Principal, id: string): number => {
    const role = effectiveRole(ctx, p, id)
    return role && permissionsFor(role).has('server:monitor') && ctx.alerts.enabled
      ? ctx.alerts.repo.firingCount(id)
      : 0
  }

  app.get(
    '/connections/health',
    { preHandler: requireAuth },
    async (request): Promise<ConnectionHealth[]> => {
      const principal = request.principal!
      const visible = ctx.connections
        .list()
        .filter((c) => effectiveRole(ctx, principal, c.id) !== null)
        .slice(0, MAX_LISTED)
      return Promise.all(
        visible.map(async (c) => ({
          connectionId: c.id,
          ...(await ctx.health.get(c.id, false)),
          alertsFiring: firing(principal, c.id),
        })),
      )
    },
  )

  app.get(
    '/connections/:id/health',
    { preHandler: requireConnection('connections:read'), config: { masking: 'names-only' } },
    async (request): Promise<ConnectionHealth> => {
      const id = request.connection!.id
      return {
        connectionId: id,
        ...(await ctx.health.get(id, true)),
        alertsFiring: firing(request.principal!, id),
      }
    },
  )
}
