// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { ServerContext } from '../../http/context'
import { manifestKeyOf } from './layout'
import { adapterFor, registryDeps, type RegistryDeps } from './registry'
import type { CopyRecord } from './repo'
import { DestinationError } from './types'

/**
 * Phase 3d-3b spec §1.2 remote delete, reused by 3d-3c retention (plan ruling 16): the manifest
 * first (a backup without one is no longer listed as ours), then the object, then the row. Removing
 * what is already gone succeeds; a failure leaves the row for the next attempt.
 */
export async function removeRemoteCopy(
  ctx: ServerContext,
  copy: CopyRecord,
  signal: AbortSignal,
  deps: RegistryDeps = registryDeps(ctx),
): Promise<void> {
  const record = ctx.backup.destinations.get(copy.destinationId)
  if (!record) throw new DestinationError('destination_deleted', 'The destination was deleted')
  const adapter = adapterFor(record, ctx.backup.destinations.secrets(record.id), deps)
  await adapter.remove(manifestKeyOf(copy.remoteKey), signal)
  await adapter.remove(copy.remoteKey, signal)
  ctx.backup.copies.remove(copy.id)
}
