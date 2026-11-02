import type { FastifyRequest } from 'fastify'
import type { Principal, ServerContext } from '../http/context'
import { effectiveRole } from '../connections/access'

/**
 * W4.6: what the plan's and the copy's code read of a request — who asks, on which connection, with
 * which role — for work a person asked for earlier or on another connection: a scheduled start (as
 * its owner, when its time comes) and a two-way sync's other direction (planned from the target).
 * The connection holds it takes are released by the caller (`releases`).
 */
export function requestAs(
  ctx: ServerContext,
  principal: Principal,
  connectionId: string,
  releases: Array<() => void>,
): FastifyRequest | null {
  const connection = ctx.connections.get(connectionId)
  if (!connection) return null
  return {
    server: { ctx },
    principal,
    connection,
    connectionRole: effectiveRole(ctx, principal, connection.id),
    ip: null,
    releases,
  } as unknown as FastifyRequest
}
