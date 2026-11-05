// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { RunMark, ScheduleRunView, ScheduleView } from '@mongo-manager/shared'
import type { Principal, ServerContext } from '../../http/context'
import { ownerOf } from '../../transfer/files'
import { isRestricted } from '../../connections/access'
import { HIDDEN_JOB_ERROR } from '../../jobs/visibility'
import type { RunRecord, ScheduleRecord } from './repo'

const markOf = (r: RunRecord): RunMark['outcome'] => r.outcome ?? (r.startedAt ? 'running' : 'queued')

/** Spec §5: a schedule card — never a key, only its name and fingerprint. */
export function toScheduleView(ctx: ServerContext, principal: Principal, s: ScheduleRecord): ScheduleView {
  const key = s.keyId ? ctx.backup.keys.get(s.owner, s.keyId) : undefined
  const by = s.pausedBy ?? ''
  return {
    id: s.id,
    name: s.name,
    owner:
      s.owner === 'local'
        ? { id: 'local', username: 'owner' }
        : { id: s.owner, username: ctx.users.findById(s.owner)?.username ?? null },
    mine: ownerOf(principal) === s.owner,
    connectionId: s.connectionId,
    connectionName: ctx.connections.get(s.connectionId)?.name ?? null,
    dump: s.dump,
    format: s.format,
    key: key ? { id: key.id, name: key.name, fingerprint: key.fingerprint, state: key.state } : null,
    cadence: s.cadence,
    timeZone: s.timeZone,
    destinations: s.destinations.map((id) => {
      const d = ctx.backup.destinations.get(id)
      return { id, name: d?.name ?? null, coldStorage: d?.type === 's3' && d.config.preset === 'spacesCold' }
    }),
    keepOnServer: s.keepOnServer,
    retention: s.retention,
    drill: s.drill,
    state: s.state,
    pause:
      s.state === 'paused' && s.pauseReason
        ? {
            reason: s.pauseReason,
            by: by.startsWith('admin') ? 'admin' : by === 'owner' ? 'owner' : 'system',
            byName: by.startsWith('admin:') ? by.slice('admin:'.length) : null,
          }
        : null,
    nextRunAt: s.state === 'active' ? s.nextRunAt : null,
    // Spec §5: the last 14 runs, oldest first.
    lastRuns: ctx.backup.runs
      .last(s.id, 14)
      .reverse()
      .map((r) => ({ id: r.id, dueAt: r.dueAt, outcome: markOf(r), reason: r.reason })),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }
}

/**
 * A run as `reader` sees it. MongoDB's words (they can quote values) are judged when read, as a
 * job's are: an administrator reading another's runs while the values are hidden from them never
 * reads them (second review of the personal-data rework, 4); the run writes them hidden already
 * for an owner the values are hidden from.
 */
export function toRunView(
  ctx: ServerContext,
  reader: Principal,
  connectionId: string,
  r: RunRecord,
): ScheduleRunView {
  const message = r.details.message ?? null
  return {
    id: r.id,
    dueAt: r.dueAt,
    kind: r.kind,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    outcome: markOf(r),
    reason: r.reason,
    message: message !== null && isRestricted(ctx, reader, connectionId) ? HIDDEN_JOB_ERROR : message,
    backupId: r.backupId,
    dumpJobId: r.dumpJobId,
    sendJobId: r.sendJobId,
    size: r.details.size ?? null,
    copies: (r.details.copies ?? []).map((c) => ({
      ...c,
      name: ctx.backup.destinations.get(c.destinationId)?.name ?? c.name,
    })),
    removals: r.details.removals ?? [],
    missed: r.details.missed ?? null,
    missedMore: r.details.missedMore ?? false,
    keyFingerprint: r.details.keyFingerprint ?? null,
    drill: r.details.drill ?? null,
  }
}
