import { createHash } from 'node:crypto'
import {
  DATA_WRITE_PERMISSIONS,
  permissionsFor,
  type CopyMode,
  type Permission,
  type PersonalRule,
  type Role,
} from '@mongo-manager/shared'
import { Errors } from '../errors'
import {
  assertEncryptedWriteAllowed,
  assertNotDrillScratch,
  effectiveRole,
  isEncryptionNamespace,
  SYSTEM_DATABASES,
} from '../connections/access'
import type { Principal, ServerContext } from '../http/context'
import type { ConnectionRecord } from '../connections/repo'
import { compileRules } from '../masking/match'
import { bucketRuled, isFileContents } from '../masking/gridfs'

/**
 * Phase 3d-2 spec §4: the other connection of a copy comes from the request body, so it gets every
 * check requireConnection gives the path's connection: visible (404 otherwise, no existence leak),
 * the role's permissions, read-only mode.
 */
export function resolveSide(
  ctx: ServerContext,
  principal: Principal,
  connectionId: string,
  need: readonly Permission[],
): { connection: ConnectionRecord; role: Role } {
  const connection = connectionId.length <= 64 ? ctx.connections.get(connectionId) : undefined
  const role = connection ? effectiveRole(ctx, principal, connection.id) : null
  if (!connection || !role) throw Errors.notFound('Connection not found')
  const readOnly = ctx.config.readOnly || connection.readOnly
  const now = permissionsFor(role, { readOnly })
  for (const p of need)
    if (!now.has(p)) {
      if (readOnly && DATA_WRITE_PERMISSIONS.has(p) && permissionsFor(role).has(p)) throw Errors.readOnly()
      throw Errors.forbidden()
    }
  // Security review Minor 8: writing documents onto a connection with client-side encryption, as
  // the document routes refuse it to someone from whom personal data is hidden.
  if (need.includes('documents:write')) assertEncryptedWriteAllowed(ctx, principal, connection)
  return { connection, role }
}

/** A copy never writes into admin, local, config or system.* (spec §4), whatever the role. */
export function assertCopyTarget(db: string, coll?: string): void {
  // W4 re-review C1: nor a restore drill's scratch database (copy, compare and sync targets).
  assertNotDrillScratch(db)
  if (SYSTEM_DATABASES.has(db) || coll?.startsWith('system.'))
    throw Errors.forbidden('A copy cannot write into a system namespace', { reason: 'system_namespace' })
  // Security review C1: nor into client-side encryption's key vault or Queryable Encryption metadata.
  if (isEncryptionNamespace(db, coll))
    throw Errors.forbidden('A copy cannot write into the encryption keys or metadata', {
      reason: 'system_namespace',
    })
}

/** Security review C1: a copy or a comparison never reads the key vault or QE metadata. */
export function assertCopySource(db: string, coll: string): void {
  if (isEncryptionNamespace(db, coll))
    throw Errors.forbidden('A copy cannot read the encryption keys or metadata', {
      reason: 'system_namespace',
    })
}

/** What writing the target needs (spec §4). */
export function copyNeeds(o: {
  mode: CopyMode
  indexes: boolean
  createsCollections: boolean
  deletes?: boolean
  /** A database copy creates views (final review M8). */
  views?: boolean
}): Permission[] {
  const need: Permission[] = ['documents:write', 'jobs:run']
  if (o.indexes) need.push('indexes:write')
  if (o.createsCollections || o.mode === 'replace' || o.deletes || o.views) need.push('databases:write')
  return need
}

export const rulesOn = (rules: readonly PersonalRule[], db: string, coll: string): PersonalRule[] =>
  rules.filter((r) => (r.db === '*' || r.db === db) && (r.coll === '*' || r.coll === coll))

/**
 * Source rules for a copied namespace with no equivalent on the target (a target rule matching the
 * target namespace and the same field), rewritten to the target names (spec §5.2).
 */
export function missingRules(
  srcRules: readonly PersonalRule[],
  src: { db: string; coll: string },
  dstRules: readonly PersonalRule[],
  dst: { db: string; coll: string },
): PersonalRule[] {
  const have = new Set(rulesOn(dstRules, dst.db, dst.coll).map((r) => r.field))
  const out = new Map<string, PersonalRule>()
  for (const r of rulesOn(srcRules, src.db, src.coll))
    if (!have.has(r.field)) out.set(r.field, { db: dst.db, coll: dst.coll, field: r.field })
  // Review of the rule scope (M2): a ruled bucket's chunks are personal data whole — its contents.
  if (isFileContents(src.coll) && bucketRuled(compileRules(srcRules), src.db, src.coll) && !have.has('data'))
    out.set('data', { db: dst.db, coll: dst.coll, field: 'data' })
  return [...out.values()]
}

/** JSON with sorted keys: the same value always gives the same text. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (v !== null && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v) ?? 'null'
}

/** Plan ruling 8: what the user reviewed, as a hash the start must echo. */
export const planHash = (v: unknown): string => createHash('sha256').update(stableJson(v)).digest('hex')
