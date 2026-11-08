// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { Errors } from '../errors'
import type { Principal, ServerContext } from '../http/context'
import { BACKUP_KINDS } from '../jobs/visibility'
import { MAX_BACKUP_JOBS } from './limits'

/** Spec §7.6 (3d-3a): at most MAX_BACKUP_JOBS running backup jobs per user (plan ruling 13: here, not in a route). */
export function assertBackupRoom(
  ctx: ServerContext,
  principal: Principal,
  /** Phase 3d-3b final review B3: a dump queueing its own send, while it still counts as running. */
  exceptJob?: string,
): void {
  const userId = principal.kind === 'user' ? principal.userId : null
  const running = ctx.jobs.list({ state: 'running' }).filter(
    (j) =>
      BACKUP_KINDS.has(j.kind) &&
      j.userId === userId &&
      j.id !== exceptJob &&
      // Phase 3d-3c spec §3.2: scheduled runs do not count against the owner's interactive limit.
      !ctx.backup.jobNotes.get(j.id)?.schedule,
  ).length
  if (running >= MAX_BACKUP_JOBS)
    throw Errors.conflict(`You already have ${MAX_BACKUP_JOBS} backups or restores running`, {
      reason: 'backup_busy',
    })
}
