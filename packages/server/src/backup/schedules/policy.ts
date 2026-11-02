import { permissionsFor, type PauseReason, type ScheduleDump } from '@mongo-manager/shared'
import type { Principal, ServerContext } from '../../http/context'
import { effectiveRole, isRestricted, mayExport } from '../../connections/access'
import type { ScheduleRecord } from './repo'

/** Spec §0 "Who": administrators see every schedule and may pause, resume, run or delete it. */
export const isAdministrator = (p: Principal): boolean => p.kind === 'local' || p.role === 'admin'

/** Spec §0: who may back up a connection may schedule it — documents:read, jobs:run and export (as the dump route). */
export function mayBackUp(ctx: ServerContext, principal: Principal, connectionId: string): boolean {
  const role = ctx.connections.get(connectionId) ? effectiveRole(ctx, principal, connectionId) : null
  if (!role) return false
  const can = permissionsFor(role)
  return can.has('documents:read') && can.has('jobs:run') && mayExport(ctx, principal, connectionId)
}

/**
 * Spec §3.3, D9: why a plain file may not be this schedule's format now, or null. An encrypted-only
 * destination takes .mmbak only; an unmasked plain backup of a scope with personal-field rules never
 * leaves the server. Checked at save from the rules' own names (no MongoDB needed), and again at every
 * run by the dump plan.
 */
export function plainProblem(
  ctx: ServerContext,
  principal: Principal,
  connectionId: string,
  dump: ScheduleDump,
  destinationIds: string[],
): 'encrypted_only' | 'personal_plain' | null {
  if (destinationIds.some((id) => ctx.backup.destinations.get(id)?.policy.encryptedOnly))
    return 'encrypted_only'
  // A restricted owner's dump is masked; an anonymous one masks every ruled field.
  if (dump.anonymous || isRestricted(ctx, principal, connectionId)) return null
  const scope = dump.scope
  const inDb = (db: string) =>
    scope.kind === 'server'
      ? db === '*' || !scope.databases || scope.databases.includes(db)
      : db === '*' || db === scope.db
  const inColl = (coll: string) =>
    coll === '*' ||
    scope.kind === 'server' ||
    (scope.kind === 'collection'
      ? coll === scope.coll
      : !scope.collections || scope.collections.includes(coll))
  return ctx.personalFields.get(connectionId).rules.some((r) => inDb(r.db) && inColl(r.coll))
    ? 'personal_plain'
    : null
}

/** Spec §1.5 step 2: the owner as the account stands now (its role read fresh), or null when gone or disabled. */
export function ownerPrincipal(ctx: ServerContext, owner: string): Principal | null {
  if (owner === 'local')
    return ctx.config.auth
      ? null
      : { kind: 'local', userId: 'local', username: 'owner', role: 'admin', csrfToken: '', unattended: true }
  const user = ctx.users.findById(owner)
  if (!user || user.disabled) return null
  return {
    kind: 'user',
    userId: user.id,
    username: user.username,
    role: user.role,
    csrfToken: '',
    sessionId: '',
    sessionIdHash: '',
    // User request 2026-10-24: their "hide from me" is how they view data, not what this work writes.
    unattended: true,
  }
}

export type RunCheck =
  | { ok: true; principal: Principal; key: { keyId: string; key: Buffer; fingerprint: string } | null }
  | { ok: false; pause: PauseReason }

/**
 * Spec §1.5 step 2, D5, D9: everything a run needs, checked as the owner now and before any data is
 * read. A failure here is permanent: the schedule pauses with its reason.
 */
export function runChecks(ctx: ServerContext, s: ScheduleRecord): RunCheck {
  const principal = ownerPrincipal(ctx, s.owner)
  if (!principal) return { ok: false, pause: 'owner_disabled' }
  if (!mayBackUp(ctx, principal, s.connectionId)) return { ok: false, pause: 'connection_access' }
  for (const id of s.destinations) {
    if (!ctx.backup.destinations.get(id)) return { ok: false, pause: 'destination_gone' }
    if (!ctx.backup.destinations.levelOf(id, principal)) return { ok: false, pause: 'destination_access' }
  }
  if (s.format !== 'mmbak') {
    const plain = plainProblem(ctx, principal, s.connectionId, s.dump, s.destinations)
    return plain ? { ok: false, pause: plain } : { ok: true, principal, key: null }
  }
  const record = s.keyId ? ctx.backup.keys.get(s.owner, s.keyId) : undefined
  const key = record?.state === 'active' ? ctx.backup.keys.open(s.owner, record.id) : null
  if (!record || !key) return { ok: false, pause: 'key_inactive' }
  return { ok: true, principal, key: { keyId: record.id, key, fingerprint: record.fingerprint } }
}
