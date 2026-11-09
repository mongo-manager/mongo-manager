// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { permissionsFor, type RestoreSource } from '@mongo-manager/shared'
import { AppError, Errors } from '../errors'
import type { Principal, ServerContext } from '../http/context'
import { effectiveRole } from '../connections/access'
import { ownerOf } from '../transfer/files'
import type { BackupFileRow } from './store'
import { assertBackupAccess } from './access'

/** Plan ruling 4: uploads are for users who may write documents on at least one connection. */
export function canRestoreSomewhere(ctx: ServerContext, principal: Principal): boolean {
  return ctx.connections.list().some((c) => {
    const role = effectiveRole(ctx, principal, c.id)
    return role !== null && permissionsFor(role).has('documents:write')
  })
}

/** B9: the caller's own upload, or a kept backup they may still use; anything else is not found. */
export function resolveSource(
  ctx: ServerContext,
  principal: Principal,
  source: RestoreSource,
): BackupFileRow {
  const owner = ownerOf(principal)
  if (source.kind === 'upload') {
    const row = ctx.backup.store.get(owner, source.uploadId)
    if (!row || row.kind !== 'upload') throw Errors.notFound('Upload not found')
    return row
  }
  const row = ctx.backup.store.get(owner, source.backupId)
  if (!row) throw Errors.notFound('Backup not found')
  assertBackupAccess(ctx, principal, row)
  return row
}

/** Plan ruling 5, B13: ten attempts per file, then growing delays; a success forgets the failures. */
export async function withPasswordThrottle<T>(
  ctx: ServerContext,
  owner: string,
  row: BackupFileRow,
  fn: (onWrongPassword: () => void) => Promise<T>,
): Promise<T> {
  const key = `backup:${owner}:${row.id}`
  const wait = ctx.backup.attempts.retryAfterMs(key)
  if (wait > 0) throw Errors.rateLimited(wait)
  let wrong = false
  try {
    const out = await fn(() => {
      wrong = true
    })
    ctx.backup.attempts.reset(key)
    return out
  } catch (e) {
    const reason = e instanceof AppError ? (e.details as { reason?: string } | undefined)?.reason : undefined
    if (wrong || reason === 'backup_password') ctx.backup.attempts.recordFailure(key)
    throw e
  }
}
