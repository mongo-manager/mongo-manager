import type { FastifyRequest } from 'fastify'
import { isRestricted } from '../connections/access'
import type { Principal, ServerContext } from '../http/context'
import { compileRules, type Masker } from './match'

/** Compiled rules per connection, reused until the rules change (their version moves). */
const compiled = new Map<string, { version: number; scratch: number; masker: Masker }>()
const MAX_COMPILED = 500

/** The masker for a principal on a connection, or null when nothing is hidden from them (phase 3d-2). */
export function maskerForPrincipal(
  ctx: ServerContext,
  principal: Principal,
  connectionId: string,
): Masker | null {
  if (!isRestricted(ctx, principal, connectionId)) return null
  const { rules, version, scratch } = ctx.personalFields.get(connectionId)
  const hit = compiled.get(connectionId)
  // W4 re-review C1: a drill's scratch rules leave the version alone: their generation counts too.
  if (hit && hit.version === version && hit.scratch === scratch) return hit.masker
  const masker = compileRules(rules)
  if (compiled.size >= MAX_COMPILED) compiled.clear()
  compiled.set(connectionId, { version, scratch, masker })
  return masker
}

/**
 * Phase 3b spec §2.4: the masker for this caller on this connection, or null when nothing is
 * hidden from them. Call it after requireConnection.
 */
export function maskerFor(request: FastifyRequest): Masker | null {
  return maskerForPrincipal(request.server.ctx, request.principal!, request.connection!.id)
}
