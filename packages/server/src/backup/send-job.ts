// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { Readable } from 'node:stream'
import type { CopyView } from '@mongo-manager/shared'
import { AppError, Errors } from '../errors'
import type { JobKind, JobRecord } from '../jobs/types'
import type { JobNotes, Principal, ServerContext, TransferEntry } from '../http/context'
import { scrubText } from '../net/egress'
import { safeEqual } from '../http/security'
import { VERSION } from '../version'
import { mapLimited } from './concurrency'
import { MANIFEST_LIMIT, buildManifest, manifestKeyOf, remoteKeyFor } from './destinations/layout'
import { adapterFor, layoutPrefix, registryDeps } from './destinations/registry'
import type { CopyRecord, DestinationRecord } from './destinations/repo'
import { DestinationError, toDestinationError, type PutResult } from './destinations/types'
import type { BackupFileRow, BackupMeta } from './store'
import { ownerOf } from '../transfer/files'
import { assertBackupRoom } from './room'

export interface SendJobParams {
  owner: string
  userId: string | null
  backupId: string
  destinationIds: string[]
  deleteLocal: boolean
  /**
   * Final review I3: the schedule whose own send this is; its new copies are that schedule's (retention
   * candidates). A send by hand, even of a scheduled backup, marks nothing (spec §1.4).
   */
  scheduleId?: string | null
}

/** Final review B9: what a send or fetch says when MM_BACKUP_MAX_JOB_HOURS ended it. */
export const SEND_TOO_LONG = 'The send ran longer than allowed'
/** Short names reviews 10 and 11: the local backup file, read before any destination is asked. */
export const UNREADABLE = 'The backup file could not be read on this server'

async function digest(
  path: string,
  algo: 'md5' | 'sha256',
  signal: AbortSignal,
  stream?: Readable,
): Promise<string> {
  const h = createHash(algo)
  const source = stream ?? createReadStream(path, { signal })
  // Final review B13: a provider's stream that does not stop by itself is ended when the job stops.
  const stop = () => source.destroy(signal.reason instanceof Error ? signal.reason : new Error('Cancelled'))
  if (signal.aborted) stop()
  else signal.addEventListener('abort', stop, { once: true })
  try {
    for await (const c of source) h.update(c as Buffer)
  } finally {
    signal.removeEventListener('abort', stop)
  }
  signal.throwIfAborted()
  return h.digest('hex')
}

/** Spec §4.3: what a destination accepts (D9). */
export function assertSendable(record: DestinationRecord, meta: BackupMeta): void {
  if (meta.format === 'mmbak') return
  if (record.policy.encryptedOnly)
    throw Errors.conflict(`${record.name} accepts encrypted backups only`, {
      reason: 'destination_encrypted_only',
    })
  // Plan ruling 4: an old backup without the flag counts as personal.
  if (!meta.masked && !meta.anonymous && (meta.personal ?? true))
    throw Errors.conflict('An unencrypted backup with personal data cannot leave the server', {
      reason: 'destination_personal_plain',
    })
}

/**
 * Final review B6: a plain unmasked backup's "no personal data" holds only for the rules it was made
 * under. Once the connection's rules moved (or nothing says which ones it was made under), it
 * counts as personal: fail closed.
 */
export function sendableMeta(ctx: ServerContext, connectionId: string | null, meta: BackupMeta): BackupMeta {
  if (meta.format === 'mmbak' || meta.masked || meta.anonymous) return meta
  const current = connectionId ? ctx.personalFields.get(connectionId).version : null
  if (typeof meta.rulesVersion !== 'number' || current !== meta.rulesVersion)
    return { ...meta, personal: true }
  return meta
}

export function toCopyView(ctx: ServerContext, c: CopyRecord): CopyView {
  return {
    id: c.id,
    destinationId: c.destinationId,
    destinationName: ctx.backup.destinations.get(c.destinationId)?.name ?? '',
    state: c.state,
    sent: c.sent,
    size: c.size,
    error: c.error,
    reason: c.reason ?? null,
    completedAt: c.completedAt,
  }
}

/** Final review B12, B29: a note on a send or fetch job, kept for the last 1000 jobs. */
export function noteJob(ctx: ServerContext, jobId: string, notes: JobNotes): void {
  const all = ctx.backup.jobNotes
  all.set(jobId, { ...all.get(jobId), ...notes })
  while (all.size > 1000) all.delete(all.keys().next().value!)
}

/**
 * Final review B4: the principal as the account stands now (a send queued long after its dump
 * started must not use a role, or an account, that is gone).
 */
export function currentPrincipal(ctx: ServerContext, principal: Principal): Principal {
  if (principal.kind !== 'user') return principal
  const user = ctx.users.findById(principal.userId)
  if (!user || user.disabled) throw Errors.gone('The account that started this backup can no longer send it')
  return { ...principal, role: user.role }
}

/** The checks every start of a send repeats (route, retry, dump): levels, policies, room. */
export function startSend(
  ctx: ServerContext,
  principal: Principal,
  row: BackupFileRow,
  destinationIds: string[],
  deleteLocal: boolean,
  /** Final review B3: the dump that queues its own send does not count against the caller's room. */
  options: { exceptJob?: string; scheduled?: { id: string; name: string } } = {},
): JobRecord {
  const ids = [...new Set(destinationIds)]
  const meta = sendableMeta(ctx, row.connectionId, row.meta!)
  for (const id of ids) {
    if (!ctx.backup.destinations.levelOf(id, principal)) throw Errors.notFound('Destination not found')
    assertSendable(ctx.backup.destinations.get(id)!, meta)
  }
  // Final review B8: two jobs on one copy row would share (and break) its resume state.
  for (const t of ctx.backup.transfers.values())
    if (t.kind === 'send' && t.backupId === row.id && t.destinationIds.some((d) => ids.includes(d)))
      throw Errors.conflict('This backup is already being sent to that destination', {
        reason: 'copy_sending',
      })
  // Phase 3d-3c: a scheduled send is held by the scheduler's own limit, not the owner's room.
  if (!options.scheduled) assertBackupRoom(ctx, principal, options.exceptJob)
  ctx.backup.store.keepUntil(row.id, ctx.now() + ctx.backup.limits.maxJobMs)
  const scope = row.meta!.scope
  const job = ctx.jobs.start(
    ctx.jobKinds['backup.send'],
    {
      userId: principal.kind === 'user' ? principal.userId : null,
      connectionId: row.connectionId!,
      db: scope.kind === 'server' ? '*' : scope.db,
      coll: scope.kind === 'collection' ? scope.coll : '*',
      target: row.name,
    },
    {
      owner: ownerOf(principal),
      userId: principal.kind === 'user' ? principal.userId : null,
      backupId: row.id,
      destinationIds: ids,
      deleteLocal,
      scheduleId: options.scheduled?.id ?? null,
    },
    options.scheduled ? { scheduled: true } : {},
  )
  if (options.scheduled) noteJob(ctx, job.id, { schedule: options.scheduled })
  return job
}

/** A failure in words the job row may show: ours as written, a destination's scrubbed. */
const messageOf = (e: unknown) =>
  e instanceof AppError ? e.message : scrubText(toDestinationError(e).message)
/** Final review B32: the same failure as a reason code (destinations.reason.*). */
const reasonOf = (e: unknown): string | null =>
  e instanceof AppError
    ? ((e.details as { reason?: string } | undefined)?.reason ?? null)
    : toDestinationError(e).reason

/** Phase 3d-3b spec §4.2: upload, verify, manifest last, per destination; at most two at once. */
export function sendKind(deps: { ctx: () => ServerContext }): JobKind<SendJobParams> {
  return {
    name: 'backup.send',
    async run(job, p) {
      const ctx = deps.ctx()
      const { store, copies, destinations, slots, transfers, limits } = ctx.backup
      // Final review B9: the job time limit holds for sends too.
      const deadline = AbortSignal.timeout(limits.maxJobMs)
      const signal = AbortSignal.any([job.signal, deadline])
      const stops = new Map<string, AbortController>()
      const stopped = new Map<string, { why: string; reason: string }>()
      const entry: TransferEntry = {
        kind: 'send',
        userId: p.userId,
        destinationIds: p.destinationIds,
        backupId: p.backupId,
        waiting: new Set(),
        stop: (destinationId, why, reason) => {
          stopped.set(destinationId, { why, reason })
          stops.get(destinationId)?.abort(new Error(why))
        },
      }
      transfers.set(job.id, entry)
      // Final review B9: the sweeper never takes the backup from under a running send.
      const release = store.hold(p.backupId)
      try {
        const row = store.byId(p.backupId)
        if (!row || !row.complete || !row.meta || !row.sha256)
          throw Errors.conflict('The backup is no longer on the server', { reason: 'backup_gone' })
        const meta = row.meta
        entry.plain = meta.format !== 'mmbak'
        const path = store.pathOf(row)
        // Short names review 10 (M-5): read whole before any destination is asked, so a local file
        // that cannot be read is said as this server's, not as a destination's failure. Review 11
        // (M-1, M-2): a deadline is the send's time, a backup deleted meanwhile is gone, and a file
        // that cannot be read fails every destination with `body` — through the same failures as
        // any other (the job's notes, a copy's failure, the local copy kept for a retry).
        let unreadable = false
        const md5 = await digest(path, 'md5', signal).catch((e: unknown) => {
          // Review 12 (M-3): a send stopped here keeps the only local copy, as one stopped later.
          if (signal.aborted && p.deleteLocal) {
            store.keepUntil(row.id, ctx.now() + LOCAL_KEPT_MS)
            noteJob(ctx, job.id, { localKept: true })
          }
          if (deadline.aborted) throw Errors.conflict(SEND_TOO_LONG, { reason: 'job_time' })
          if (signal.aborted) throw e
          if (!store.byId(p.backupId) || (e as NodeJS.ErrnoException).code === 'ENOENT')
            throw Errors.conflict('The backup is no longer on the server', { reason: 'backup_gone' })
          unreadable = true
          return ''
        })
        const file = { path, size: row.size, sha256: row.sha256, md5 }
        const sent = new Map<string, number>()
        const total = row.size * p.destinationIds.length
        const report = () =>
          job.progress(
            [...sent.values()].reduce((s, n) => s + n, 0),
            total,
          )
        const failures: Array<{
          destination: string
          destinationId: string
          message: string
          reason: string | null
        }> = []
        await mapLimited(p.destinationIds, 2, async (destinationId) => {
          const record = destinations.get(destinationId)
          const name = record?.name ?? 'A deleted destination'
          const own = new AbortController()
          stops.set(destinationId, own)
          const dsignal = AbortSignal.any([signal, own.signal])
          let copy = copies.forBackupOn(row.id, destinationId)
          try {
            if (!record) throw new DestinationError('destination_deleted', 'The destination was deleted')
            // Final review B6, B21: the policy as it stands now, not as it stood at the start.
            assertSendable(record, sendableMeta(ctx, row.connectionId, meta))
            const adapter = adapterFor(record, destinations.secrets(destinationId), registryDeps(ctx))
            if (copy?.state === 'complete') {
              // Final review B7: a complete copy counts only while its object is still there, whole.
              const there = await adapter.stat(copy.remoteKey, dsignal)
              if (there && there.size === copy.size) {
                sent.set(destinationId, row.size)
                return report()
              }
            }
            // Review 12 (I-1, M-1): only now — a deleted destination, a policy refusal and a copy that
            // is complete and still there are said as themselves, and a complete copy never fails
            // for a local file it does not need. A copy there already is restarted first, so its
            // attempt is this one (M-2: kept for a retry from now, not from its last attempt).
            if (unreadable) {
              if (copy) copies.restart(copy.id, p.deleteLocal)
              throw Errors.conflict(UNREADABLE, { reason: 'body' })
            }
            const resumed = copy !== undefined
            const key =
              copy?.remoteKey ?? remoteKeyFor(layoutPrefix(record), meta.format, row.id, row.createdAt)
            copy ??= copies.create({
              destinationId,
              backupId: row.id,
              remoteKey: key,
              owner: p.owner,
              connectionId: row.connectionId,
              meta,
              format: meta.format,
              size: row.size,
              sha256: row.sha256!,
              md5,
              deleteLocal: p.deleteLocal,
              scheduleId: p.scheduleId ?? null,
            })
            copies.restart(copy.id, p.deleteLocal)
            copies.setMd5(copy.id, md5)
            const id = copy.id
            // Spec §4.2: "Waiting for the destination" until one of its transfer slots is free.
            const free = await slots.acquire(destinationId, dsignal, () => {
              entry.waiting!.add(destinationId)
              report()
            })
            if (entry.waiting!.delete(destinationId)) report()
            try {
              // An object an earlier attempt left at the key (its manifest failed, or a restart came
              // during its read-back) is verified like a fresh upload, and read back (final review B2).
              // Looked for first on a retry, and wherever no read-back follows anyway: a destination
              // may take a file of the right size already in place as the upload (the adapters' A5).
              let preexisting = false
              if (resumed || !adapter.readBack) {
                const before = await adapter.stat(key, dsignal)
                if (before && before.size === row.size) preexisting = true
                // Our own leftover of another size goes; a new copy's key is left to the put.
                else if (before && resumed) await adapter.remove(key, dsignal)
              }
              let written = 0
              let result: PutResult = {}
              if (!preexisting)
                try {
                  result = await adapter.put(
                    key,
                    file,
                    copies.resume(id),
                    {
                      progress: (n) => {
                        sent.set(destinationId, n)
                        report()
                        if (ctx.now() - written >= 1000) {
                          written = ctx.now()
                          copies.setSent(id, n)
                        }
                      },
                      saveResume: (s) => copies.setResume(id, s),
                    },
                    dsignal,
                  )
                } catch (e) {
                  if (dsignal.aborted || toDestinationError(e).reason !== 'conflict') throw e
                  const there = await adapter.stat(key, dsignal)
                  if (!there || there.size !== row.size) throw e
                  preexisting = true
                }
              // An object that fails verification is removed (best effort): it must not stay listed
              // as a backup, nor block the retry that writes the same key again.
              const unverified = async (why: string): Promise<DestinationError> => {
                await adapter.remove(key, signal).catch(() => undefined)
                copies.setResume(id, null)
                return new DestinationError('verify', why)
              }
              const st = await adapter.stat(key, dsignal)
              if (!st || st.size !== row.size)
                throw await unverified('The uploaded size does not match the backup')
              const sha = result.checksums?.sha256 ?? st.sha256
              const md = result.checksums?.md5 ?? st.md5
              if ((sha && !safeEqual(sha, row.sha256!)) || (!sha && md && !safeEqual(md, md5)))
                throw await unverified('The destination holds a different file than the one sent')
              // A found object is read back unless the provider vouches for its SHA-256 itself.
              if (
                (adapter.readBack || (preexisting && !sha)) &&
                !safeEqual(
                  await digest(path, 'sha256', dsignal, await adapter.get(key, 0, dsignal)),
                  row.sha256!,
                )
              )
                throw await unverified('The file read back differs from the backup')
              // Final review B13: a send stopped meanwhile writes no manifest and completes nothing.
              dsignal.throwIfAborted()
              // D12: the manifest is written last, after the object is complete and verified.
              await adapter.putSmall(
                manifestKeyOf(key),
                buildManifest({
                  id: row.id,
                  format: meta.format,
                  size: row.size,
                  sha256: row.sha256!,
                  createdAt: row.createdAt,
                  tool: { name: 'mongo-manager', version: VERSION },
                }),
                dsignal,
              )
              dsignal.throwIfAborted()
              copies.complete(id, result.ref ?? st.ref ?? null)
              sent.set(destinationId, row.size)
              report()
            } finally {
              free()
            }
          } catch (e) {
            const stop = stopped.get(destinationId)
            // Short names review 14 (M1): one the user cancelled is said as cancelled.
            const [message, reason] = stop
              ? [stop.why, stop.reason]
              : deadline.aborted
                ? [SEND_TOO_LONG, 'job_time']
                : job.signal.aborted
                  ? ['The send was cancelled', 'cancelled']
                  : [messageOf(e), reasonOf(e)]
            // Review 12 (I-1): a complete copy is never failed by a later send's trouble.
            if (copy && copies.get(copy.id)?.state !== 'complete') copies.fail(copy.id, message, reason)
            const d = toDestinationError(e)
            if (d.reason === 'reconnect' && record) {
              // Short names review 8 (M-6): an earlier test's folder refusal is not this one's.
              const { why: _why, name: _name, ...status } = record.status
              destinations.setStatus(record.id, {
                ...status,
                state: 'reconnect',
                checkedAt: ctx.now(),
                reason: 'reconnect',
              })
            }
            failures.push({ destination: name, destinationId, message, reason })
          } finally {
            stops.delete(destinationId)
            if (entry.waiting!.delete(destinationId)) report()
          }
        })
        if (failures.length) {
          // Backup review M12: a local copy meant to go after the send was the only copy, and its
          // normal time to live (a day) deleted it while a destination still had nothing. It is kept
          // for as long as the send can be retried.
          if (p.deleteLocal) store.keepUntil(row.id, ctx.now() + LOCAL_KEPT_MS)
          // Spec §4.2: when the local copy could not go, the job says it was kept (final review B12).
          // Final review B33: the same failures, as codes the web says in the reader's language.
          noteJob(ctx, job.id, {
            failures: failures.map(({ destination, destinationId, reason }) => ({
              destination,
              destinationId,
              reason,
            })),
            ...(p.deleteLocal ? { localKept: true } : {}),
          })
          const list = `Not sent — ${failures.map((f) => `${f.destination}: ${f.message}`).join('; ')}`
          throw Errors.conflict(
            p.deleteLocal ? `${list.replace(/\.$/, '')}. The local copy was kept for 7 days.` : list,
            {
              reason: 'send_failed',
            },
          )
        }
        // Final review B13: a cancelled send never deletes the local copy.
        signal.throwIfAborted()
        if (p.deleteLocal) {
          // Spec §4.2: the local copy goes only when every destination it was sent to under "delete
          // the local copy" (this send's, and a retried one's earlier ones: B14) completed.
          const group = copies
            .byBackup(row.id)
            .filter((c) => p.destinationIds.includes(c.destinationId) || c.deleteLocal)
          if (group.every((c) => c.state === 'complete')) store.delete(p.owner, row.id)
          else {
            // Review I6: an earlier destination of it has nothing yet: kept as long as that can be retried.
            store.keepUntil(row.id, ctx.now() + LOCAL_KEPT_MS)
            noteJob(ctx, job.id, { localKept: true })
          }
        }
      } finally {
        release()
        transfers.delete(job.id)
      }
    },
    cancel: async () => true,
    recover: () => {
      settleInterruptedCopies(deps.ctx())
      return 'interrupted'
    },
  }
}

/** Backup review M12: a failed send's only copy stays as long as stale sends are kept for a retry. */
const LOCAL_KEPT_MS = 7 * 86_400_000

/**
 * Final review B1: a copy left "sending" by a send that no longer runs (a restart cut it off) is
 * failed, its resume state kept, so Retry continues it and Discard removes it.
 */
export function settleInterruptedCopies(ctx: ServerContext): void {
  const running = [...ctx.backup.transfers.values()]
  const covered = (c: CopyRecord) =>
    running.some(
      (t) =>
        t.destinationIds.includes(c.destinationId) && (t.backupId === undefined || t.backupId === c.backupId),
    )
  for (const c of ctx.backup.copies.inState('sending'))
    if (!covered(c)) {
      ctx.backup.copies.fail(c.id, 'The send was interrupted (the server restarted)', 'interrupted')
      // Backup review I6: a restart is the likeliest way a send fails: under "delete the local copy"
      // the local copy was the only one, and stays as long as the send can be retried.
      if (c.deleteLocal && c.backupId) ctx.backup.store.keepUntil(c.backupId, ctx.now() + LOCAL_KEPT_MS)
    }
}

/** Spec §4.2: provider-side uploads abandoned for 7 days are aborted, and their copies forgotten. */
export async function sweepStaleCopies(ctx: ServerContext): Promise<void> {
  const before = ctx.now() - 7 * 86_400_000
  // Final review B25: running transfers are looked at afresh for every copy, before and after awaits.
  const busy = (c: CopyRecord) =>
    [...ctx.backup.transfers.values()].some((t) => t.destinationIds.includes(c.destinationId))
  for (const c of ctx.backup.copies.stale(before)) {
    if (busy(c)) continue
    const record = ctx.backup.destinations.get(c.destinationId)
    const resume = ctx.backup.copies.resume(c.id)
    if (record)
      try {
        const adapter = adapterFor(record, ctx.backup.destinations.secrets(record.id), registryDeps(ctx))
        const signal = AbortSignal.timeout(15_000)
        if (resume) await adapter.abandon(resume, signal).catch(() => undefined)
        // An object left without its manifest is no backup anyone can trust: it goes too. One with
        // a manifest was verified and stays (it lists, and restores, like a foreign backup).
        const manifest = await adapter
          .getSmall(manifestKeyOf(c.remoteKey), MANIFEST_LIMIT, signal)
          .catch(() => undefined)
        if (manifest === null && !busy(c)) await adapter.remove(c.remoteKey, signal).catch(() => undefined)
      } catch {
        // The provider's own expiry applies.
      }
    const now = ctx.backup.copies.get(c.id)
    if (!now || now.state === 'complete' || busy(c) || (now.attemptAt ?? now.createdAt) >= before) continue
    ctx.backup.copies.remove(c.id)
  }
}
