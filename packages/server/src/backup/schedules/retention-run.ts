import { retain, type RetentionItem } from '@mongo-manager/shared'
import type { ServerContext } from '../../http/context'
import type { ScheduleRecord } from './repo'
import { nameOfKey } from '../destinations/layout'
import { removeRemoteCopy } from '../destinations/remove'
import { ownerPrincipal } from './policy'

/** Spec §1.4: each destination of a schedule is a location, and this server when it keeps copies. */
export const SERVER_LOCATION = 'server'
export interface Location {
  id: string
  name: string | null
}

export function locationsOf(ctx: ServerContext, s: ScheduleRecord): Location[] {
  return [
    ...s.destinations.map((id) => ({ id, name: ctx.backup.destinations.get(id)?.name ?? null })),
    ...(s.keepOnServer ? [{ id: SERVER_LOCATION, name: null }] : []),
  ]
}

/**
 * Spec §1.4 "which backups count", D6: the schedule's own complete and verified backups at that
 * location, with their dump's start (plan ruling 17). Manual sends and other schedules never appear.
 */
export function candidatesAt(ctx: ServerContext, s: ScheduleRecord, location: string): RetentionItem[] {
  if (location === SERVER_LOCATION)
    return ctx.backup.store.bySchedule(s.id).map((r) => ({ id: r.id, at: r.meta?.startedAt ?? r.createdAt }))
  return ctx.backup.copies
    .forSchedule(s.id, location)
    .map((c) => ({ id: c.id, at: c.meta?.startedAt ?? c.createdAt }))
}

/** Spec §1.4 "changing a policy": how many backups the policy would remove now, per location. */
export function previewRemovals(
  ctx: ServerContext,
  s: ScheduleRecord,
): Array<{ location: string; name: string | null; count: number }> {
  return locationsOf(ctx, s).map((l) => ({
    location: l.id,
    name: l.name,
    count: retain(candidatesAt(ctx, s, l.id), s.retention, s.timeZone, ctx.now()).remove.length,
  }))
}

/** Spec §1.4 safety rules: at most this many removals per location and run; the rest wait. */
export const MAX_REMOVALS_PER_RUN = 100

/**
 * Spec §1.4, D6: after a run whose copy at `location` completed (`newest`), the schedule's own
 * complete copies there that no tier keeps are removed — never `newest`, at most 100, each audited.
 * A removal that fails leaves its record for the next run.
 */
export async function applyRetention(
  ctx: ServerContext,
  s: ScheduleRecord,
  location: Location,
  newest: string,
): Promise<{ removed: number; failed: number; waiting: number }> {
  const items = candidatesAt(ctx, s, location.id)
  if (!items.some((i) => i.id === newest)) return { removed: 0, failed: 0, waiting: 0 }
  const doomed = retain(items, s.retention, s.timeZone, ctx.now()).remove.filter((id) => id !== newest)
  // Final review minor 18: the owner's right to the destination as it stands now, read fresh — a
  // grant revoked during the run removes nothing there with the server's stored credentials.
  if (location.id !== SERVER_LOCATION) {
    const principal = ownerPrincipal(ctx, s.owner)
    if (!principal || !ctx.backup.destinations.levelOf(location.id, principal))
      return { removed: 0, failed: 0, waiting: doomed.length }
  }
  const now = doomed.slice(0, MAX_REMOVALS_PER_RUN)
  let removed = 0
  let failed = 0
  let busy = 0
  for (const id of now) {
    let name: string
    try {
      if (location.id === SERVER_LOCATION) {
        const row = ctx.backup.store.byId(id)
        if (!row || row.scheduleId !== s.id) continue
        // A backup a send is reading stays for the next run (final review minor 19: it waits).
        if ([...ctx.backup.transfers.values()].some((t) => t.backupId === id)) {
          busy++
          continue
        }
        name = row.name
        ctx.backup.store.delete(row.owner, row.id)
      } else {
        const copy = ctx.backup.copies.get(id)
        if (
          !copy ||
          copy.scheduleId !== s.id ||
          copy.destinationId !== location.id ||
          copy.state !== 'complete'
        )
          continue
        name = nameOfKey(copy.remoteKey)
        await removeRemoteCopy(ctx, copy, AbortSignal.timeout(60_000))
      }
    } catch {
      failed++
      continue
    }
    removed++
    // Spec §3.5: per removed copy — the schedule, the location, the file's name (plan ruling 16).
    ctx.audit.append({
      action: 'backup.retention.delete',
      outcome: 'success',
      userId: s.owner === 'local' ? null : s.owner,
      username: null,
      ip: null,
      connectionId: s.connectionId,
      namespace: null,
      details: {
        schedule: s.id,
        scheduleName: s.name,
        destination: location.id,
        destinationName: location.name,
        name,
      },
    })
  }
  return { removed, failed, waiting: doomed.length - now.length + busy }
}
