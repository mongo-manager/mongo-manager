import { permissionsFor, type JobView, type Permission } from '@mongo-manager/shared'
import { effectiveRole, isAdminOnlyNamespace, isRestricted } from '../connections/access'
import type { Principal, ServerContext } from '../http/context'
import { maskerForPrincipal } from '../masking/request'
import type { JobRecord } from './types'

/** What cancelling a job of each kind needs on its connection: the same as starting it. */
const CANCEL_PERMISSION: Record<JobRecord['kind'], Permission> = {
  'index.create': 'indexes:write',
  'collection.duplicate': 'databases:write',
  'data.import': 'documents:write',
  'data.importSql': 'documents:write',
  'data.export': 'documents:read',
  // Plan ruling 4 (phase 3d-2): the owner (or an app admin) holding read access to the source.
  'data.copy': 'documents:read',
  'data.compare': 'documents:read',
  'data.sync': 'documents:read',
  // Phase 3d-3a: as starting them — reading the source of a dump, writing the target of a restore.
  'backup.dump': 'documents:read',
  'backup.restore': 'documents:write',
  // Phase 3d-3b: as starting them — reading the backup's source, writing for a restore.
  'backup.send': 'documents:read',
  'backup.fetch': 'documents:write',
  // W4.4: a drill writes into its scratch database.
  'backup.drill': 'documents:write',
}

/** Phase 3d-1/3d-2: kinds that work on their owner's files or move data between connections. */
export const TRANSFER_KINDS: ReadonlySet<JobRecord['kind']> = new Set([
  'data.import',
  'data.importSql',
  'data.export',
  'data.copy',
  'data.compare',
  'data.sync',
])

/** Phase 3d-3a: backup jobs are their owner's only, like transfers (they count apart). */
export const BACKUP_KINDS: ReadonlySet<JobRecord['kind']> = new Set([
  'backup.dump',
  'backup.restore',
  'backup.send',
  'backup.fetch',
  'backup.drill',
])

const owns = (principal: Principal, job: JobRecord) =>
  principal.kind === 'local' || (job.userId !== null && job.userId === principal.userId)

/**
 * Phase 1h spec §4: a job is visible to an admin, and, while they may read its connection, to its
 * owner and to anyone who may read the collection it works on (they see its indexes anyway). A failure message can quote document
 * values, which is why reading the collection is the bar. Checked afresh on every call, so a grant
 * revoked mid-job hides it at once.
 */
export function canSee(ctx: ServerContext, principal: Principal, job: JobRecord): boolean {
  if (principal.kind === 'local' || principal.role === 'admin') return true
  if (!ctx.connections.get(job.connectionId)) return false
  // Even the owner loses sight of a job once they may no longer read its connection (final review
  // I1): its error text can quote document values.
  const role = effectiveRole(ctx, principal, job.connectionId)
  if (!role || !permissionsFor(role).has('documents:read')) return false
  // Phase 3d-2 final review I2: a job on two connections needs read access to both.
  if (job.targetConnectionId) {
    const other = ctx.connections.get(job.targetConnectionId)
      ? effectiveRole(ctx, principal, job.targetConnectionId)
      : null
    if (!other || !permissionsFor(other).has('documents:read')) return false
  }
  if (owns(principal, job)) return true
  // A transfer is named after its owner's file and works on their own files: nobody else's
  // business, whatever they may read (phase 3d-1 final review M6).
  if (TRANSFER_KINDS.has(job.kind) || BACKUP_KINDS.has(job.kind)) return false
  return role === 'admin' || !isAdminOnlyNamespace(job.db, job.coll)
}

/** The owner or an admin, holding what starting the job needs now, read-only mode included. */
export function canCancel(ctx: ServerContext, principal: Principal, job: JobRecord): boolean {
  if (job.state !== 'running' || !canSee(ctx, principal, job)) return false
  if (!owns(principal, job) && principal.role !== 'admin') return false
  const connection = ctx.connections.get(job.connectionId)
  const role = connection ? effectiveRole(ctx, principal, job.connectionId) : null
  if (!connection || !role) return false
  const readOnly = ctx.config.readOnly || connection.readOnly
  return permissionsFor(role, { readOnly }).has(CANCEL_PERMISSION[job.kind])
}

export function cancelPermission(job: JobRecord): Permission {
  return CANCEL_PERMISSION[job.kind]
}

/** Phase 3c §4.7: what a restricted viewer sees instead of a job's error (MongoDB's text). */
export const HIDDEN_JOB_ERROR =
  "The job failed; MongoDB's message is hidden because it can quote personal data."

/** The job as this principal sees it: without its owner's id or its staging collection. */
export function toView(ctx: ServerContext, principal: Principal, job: JobRecord): JobView {
  const { userId: _owner, staging: _staging, stagingConnectionId: _sc, stagingDb: _sd, ...shown } = job
  const hidden =
    job.error !== null &&
    (isRestricted(ctx, principal, job.connectionId) ||
      (job.targetConnectionId !== null && isRestricted(ctx, principal, job.targetConnectionId)))
  // Phase 3d-3b final review B11, B12, B29: what a send or fetch says besides its state.
  const transfer = job.state === 'running' ? ctx.backup?.transfers.get(job.id) : undefined
  const waiting = transfer?.waiting?.size
    ? [...transfer.waiting].map((id) => ctx.backup.destinations.get(id)?.name ?? '')
    : null
  const notes = ctx.backup?.jobNotes.get(job.id)
  // Thirteenth review of explain masking (I2): a build counts keys, and over a multikey index on a
  // hidden array the count tells how many values documents hold.
  const counts =
    job.kind === 'index.create' &&
    job.progress !== null &&
    maskerForPrincipal(ctx, principal, job.connectionId)?.forNs(job.db, job.coll).any === true
  return {
    ...shown,
    ...(counts ? { progress: null } : {}),
    ...(hidden ? { error: HIDDEN_JOB_ERROR } : {}),
    mine: owns(principal, job),
    cancellable: canCancel(ctx, principal, job),
    ...(waiting ? { waitingFor: waiting } : {}),
    ...(notes?.localKept ? { localKept: true } : {}),
    ...(notes?.verified !== undefined ? { verified: notes.verified } : {}),
    // Short names review 12: the destination's id is for a schedule's run to find it by; the view
    // shows what it always did.
    ...(notes?.failures?.length
      ? { failures: notes.failures.map(({ destination, reason }) => ({ destination, reason })) }
      : {}),
    ...(notes?.schedule ? { scheduleName: notes.schedule.name } : {}),
  }
}
