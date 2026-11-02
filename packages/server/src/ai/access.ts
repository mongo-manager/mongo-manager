import { permissionsFor } from '@mongo-manager/shared'
import type { Principal, ServerContext } from '../http/context'
import { effectiveRole, hidesFromSelf, isRestricted } from '../connections/access'
import type { ChatOwner } from './chats'
import type { TurnAccess } from './history'

/** Plan ruling 1: a chat's owner. */
export const chatOwner = (p: Principal): ChatOwner => (p.kind === 'local' ? null : p.userId)

/** Plan ruling 8: ai:use on the caller's role, or on any connection's grant. */
export function mayUseAi(ctx: ServerContext, principal: Principal): boolean {
  if (permissionsFor(principal.role).has('ai:use')) return true
  return ctx.connections.list().some((c) => {
    const role = effectiveRole(ctx, principal, c.id)
    return !!role && permissionsFor(role).has('ai:use')
  })
}

/**
 * The rules' version a turn travels under, for this caller. Hiding of one's own choice is part of
 * it — the local user's (review 2026-10-13, I3), a team member's "hide from me" (2026-10-24): a
 * turn sent while the values were shown never travels once they are hidden, nor a masked one once
 * shown.
 */
export function aiRulesVersion(ctx: ServerContext, principal: Principal, connectionId: string): number {
  const version = ctx.personalFields.get(connectionId).version
  const ownChoice =
    principal.kind === 'local'
      ? isRestricted(ctx, principal, connectionId)
      : hidesFromSelf(ctx, principal, connectionId)
  return ownChoice ? -version - 1 : version
}

/**
 * A turn's source at its rules' version, for its record. Rules that cannot be read (another key,
 * tampered) give a version no later turn matches, so the turn is never sent on — and the turn ends
 * and is stored all the same: thrown here, it hung (second review of the connection names, M-1).
 */
export function sourceVersion(ctx: ServerContext, principal: Principal, connectionId: string): number {
  try {
    return aiRulesVersion(ctx, principal, connectionId)
  } catch {
    return Number.MIN_SAFE_INTEGER
  }
}

/** Spec §2.2: whether an earlier turn's connection may still travel — read now, once per connection. */
export function turnAccess(
  ctx: ServerContext,
  principal: Principal,
): (connectionId: string) => TurnAccess | null {
  const seen = new Map<string, TurnAccess | null>()
  return (id) => {
    if (seen.has(id)) return seen.get(id)!
    const c = ctx.connections.get(id)
    const role = c ? effectiveRole(ctx, principal, c.id) : null
    const may = role ? permissionsFor(role) : null
    let access: TurnAccess | null = null
    if (c && may && may.has('ai:use') && may.has('documents:read') && c.aiPolicy !== 'off')
      try {
        access = { policy: c.aiPolicy, rulesVersion: aiRulesVersion(ctx, principal, c.id) }
      } catch {
        // Rules that do not open: the turn does not travel; the chat goes on and opens (third review, I-1).
        access = null
      }
    seen.set(id, access)
    return access
  }
}
