import { permissionsFor, type BackupView, type CopyView } from '@mongo-manager/shared'
import { Errors } from '../errors'
import type { Principal, ServerContext } from '../http/context'
import { effectiveRole, isRestricted, mayExport } from '../connections/access'
import type { BackupFileRow } from './store'

export const toBackupView = (
  row: BackupFileRow,
  copies: CopyView[] = [],
  schedule: { id: string; name: string } | null = null,
): BackupView => ({
  id: row.id,
  name: row.name,
  jobId: row.jobId,
  connectionId: row.connectionId!,
  scope: row.meta!.scope,
  engine: row.meta!.engine,
  format: row.meta!.format,
  masked: row.meta!.masked,
  anonymous: row.meta!.anonymous,
  size: row.size,
  sha256: row.sha256 ?? '',
  namespaces: row.meta!.namespaces,
  startedAt: row.meta!.startedAt,
  finishedAt: row.meta!.finishedAt ?? row.createdAt,
  expiresAt: row.expiresAt,
  copies,
  schedule,
})

/**
 * Spec §7.3, B12: a kept backup is its owner's, and only while they can still read and export from
 * its connection and are not newly restricted there. A masked or anonymous one is also withdrawn
 * when the connection's personal-field rules change (it may hold values that are ruled now).
 */
export function assertBackupAccess(ctx: ServerContext, principal: Principal, row: BackupFileRow): void {
  if (row.kind !== 'backup' || !row.complete || !row.meta || !row.connectionId)
    throw Errors.notFound('Backup not found')
  const role = ctx.connections.get(row.connectionId) ? effectiveRole(ctx, principal, row.connectionId) : null
  if (!role || !permissionsFor(role).has('documents:read'))
    throw Errors.gone('You can no longer read the connection of this backup')
  if (!mayExport(ctx, principal, row.connectionId))
    throw Errors.gone('You can no longer export from this connection')
  const meta = row.meta
  if (
    (meta.masked || meta.anonymous) &&
    ctx.personalFields.get(row.connectionId).version !== meta.rulesVersion
  )
    throw Errors.gone('The personal-field rules changed since this backup; take it again')
  // A backup made unmasked must not reach a caller who may no longer see personal values.
  if (!meta.masked && isRestricted(ctx, principal, row.connectionId))
    throw Errors.gone('Personal fields are now hidden from you; this backup holds them')
}
