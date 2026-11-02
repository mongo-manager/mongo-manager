import type { ChangeStreamOptions, Document, ResumeToken } from 'mongodb'
import { requestAs } from './caller'
import {
  FINAL_STATES,
  LiveSyncRequestSchema,
  LIVE_SYNC_STATES,
  RUNNING_STATES,
  type LiveSyncAuditAction,
  type LiveSyncAuditedState,
  type LiveSyncEvent,
  type LiveSyncReason,
  type LiveSyncState,
  type LiveSyncVerify,
  type LiveSyncView,
} from '@mongo-manager/shared'
import { Errors } from '../errors'
import { asConnectionFailure, withMongo } from '../data/mongo-errors'
import { READ_OPTIONS } from '../data/ejson-io'
import type { Principal, ServerContext } from '../http/context'
import { effectiveRole } from '../connections/access'
import { ownerOf } from '../transfer/files'
import type { StreamLike } from '../changestreams/feed'
import { checkSync, errorTextFor } from './checks'
import { operationTime, planLiveSync, type PlannedSync, type SyncEdge } from './plan'
import { ownerPrincipal } from '../backup/schedules/policy'
import { startCopyJob } from '../transfer/copy-start'
import { assertTransferRoom } from '../routes/data/transfer'
import { createOptions } from '../transfer/collection-spec'
import { VALIDATOR_LEFT_OUT, maskerOfPatterns, withoutMaskedValidator } from '../transfer/masked-definitions'
import { SCHEMA_SKIP } from './apply'
import { verifySync } from './verify'
import { LiveSyncRejected } from './rejected'
import { tsCompare, tsFrom, type LiveSyncRecord, type LiveSyncRepo, type NewLiveSync } from './repo'
import { LiveSyncWorker, WORKER_TIMING, type CopyState, type WorkerDeps, type WorkerTiming } from './worker'
import { LOST_KEPT, LOST_KEPT_MS, TwoWayPair, echoMark, lostKey, readEchoMark } from './twoway'

/** W4.6: session ids a two-way direction remembers (its writes' echoes are skipped). */
/**
 * W4.6: the sessions a two-way direction remembers as its own (one per worker start). An older one
 * forgotten while the other direction still has its writes to read is harmless: written back, a
 * change finds its result already there (applyOne's "already") — W4 review (minor), revisited.
 */
const ECHO_KEPT = 16

export interface RunnerDeps {
  ctx: () => ServerContext
  repo: LiveSyncRepo
  timing?: Partial<WorkerTiming>
  /** A sync's changes reach listeners at most this often (plan ruling 15). */
  pushMs?: number
}

const RUNNING = new Set<LiveSyncState>(RUNNING_STATES)
const FINAL = new Set<LiveSyncState>(FINAL_STATES)
/** A plain resume clears these; the others have their own action (spec §1.4, §1.7, §3.2, S9). */
const RESUMABLE = new Set<LiveSyncReason>([
  'owner',
  'admin',
  'owner_access',
  'read_only',
  'turned_off',
  'write_error',
  // Final review I8: a person fixed what the stream refused (a right, a view): it tries again.
  'stream_error',
  // W4 review (minor): the setting turned back on, the images turned back on.
  'filter_refused',
  'pre_images_off',
  // W4 re-review (minor): the other side caught up (or a person chose to go on).
  'two_way_backlog',
])
const REVIEWED = new Set<LiveSyncReason>(['rules_changed', 'connection_changed'])
/**
 * Spec §1.4, final review I3, I8: what a database sync reads — its collections' changes, renames
 * ONTO them (an $out replaces a collection that way), a dropped database — without the update
 * descriptions it never uses (they can make an event too large).
 */
export function pipelineFor(r: Pick<LiveSyncRecord, 'source' | 'options'>): Document[] {
  const lean = { $project: { updateDescription: 0 } }
  if (r.source.coll || r.options.followNew) return [lean]
  const names = r.options.pairs.map(([s]) => s)
  return [
    {
      $match: {
        $or: [
          { 'ns.coll': { $in: names } },
          { 'to.coll': { $in: names } },
          { operationType: { $in: ['dropDatabase', 'invalidate'] } },
        ],
      },
    },
    lean,
  ]
}

type Listener = (r: LiveSyncRecord, gone: boolean) => void

/** W4.6: a verification as a view shows it — counts and ids, no document and no rules versions. */
export function withoutSamples(v: LiveSyncVerify): LiveSyncVerify {
  const { versions: _v, ...rest } = v
  return { ...rest, pairs: v.pairs.map(({ samples: _s, ...p }) => p) }
}

/**
 * A sync's worker, until its loop has ended: `done` then (never rejects). `stopping`: halted (its
 * caller writes the next state once it has ended). `again`: asked to start while it was ending by
 * itself; it starts once this one is gone.
 */
interface WorkerEntry {
  worker: LiveSyncWorker
  release: () => void
  done: Promise<void>
  stopping?: boolean
  again?: boolean
}

/** Phase 3e-2 spec §2.1: every live sync's worker — boot, control, connections, views and pushes. */
export class LiveSyncRunner {
  private readonly workers = new Map<string, WorkerEntry>()
  /**
   * Syncs a caller halts and then writes the state of (a pause, a stop, a changed or deleted
   * connection), counted while it does: a partner's halt that ends meanwhile leaves them to it
   * (second review of the CI fix, minor 5).
   */
  private readonly kept = new Map<string, number>()
  private readonly listeners = new Set<Listener>()
  private readonly pushes = new Map<string, { last: number; state: string; timer?: NodeJS.Timeout }>()
  private readonly verifying = new Map<string, AbortController>()
  private readonly verifyRuns = new Map<string, Promise<void>>()
  /** W4.6: scheduled syncs being started (the timer and a "Start now" never start one twice). */
  private readonly starting = new Set<string>()
  /** W4.6: two-way pairs' shared state (by the forward direction's id). */
  private readonly pairs = new Map<string, TwoWayPair>()
  private dueTimer: NodeJS.Timeout | null = null
  private closed = false

  constructor(private readonly d: RunnerDeps) {}

  get repo(): LiveSyncRepo {
    return this.d.repo
  }

  private get ctx(): ServerContext {
    return this.d.ctx()
  }

  /** W4.6: the syncs' rejected-records files. */
  get rejected(): LiveSyncRejected {
    return new LiveSyncRejected(this.ctx.transfer.files)
  }

  /** After the jobs were recovered: running syncs start again; syncs the switch stopped carry on. */
  boot(): void {
    const { ctx } = this
    for (const r of this.d.repo.list()) {
      // A verification the server's stop cut never finishes on its own.
      if (r.verify?.state === 'running')
        this.d.repo.update(r.id, {
          verify: { ...r.verify, state: 'failed', finishedAt: Date.now(), error: 'aborted' },
        })
      // W4 re-review (minor): a sync that is still there gives its rejected records their time again
      // (a restart alone does not: a deleted or ended sync's file runs out as it would have).
      if (!FINAL.has(r.state)) {
        const file = this.rejected.fileOf(r)
        if (file) ctx.transfer.files.touch(file.id, file.size)
      }
      if (RUNNING.has(r.state)) this.spawn(r.id)
      else if (ctx.config.liveSync.enabled && r.state === 'attention' && r.reason === 'turned_off')
        this.restart(r)
    }
    // W4.6: scheduled syncs start when their time comes (looked at every 15 s, and at once now).
    this.dueTimer = setInterval(() => void this.startDue(), 15_000)
    this.dueTimer.unref()
    void this.startDue()
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.dueTimer) clearInterval(this.dueTimer)
    for (const p of this.pushes.values()) clearTimeout(p.timer)
    for (const c of this.verifying.values()) c.abort()
    // Verifications end (as aborted) before the store closes: none may write after it.
    await Promise.all(this.verifyRuns.values())
    const ids = [...this.workers.keys()]
    await Promise.all(ids.map((id) => this.halt(id)))
    // Plan ruling 1: a copy dies with the server (its job may even be recorded as failed as the
    // client closes): the sync says a restart interrupted it.
    for (const id of ids) {
      const r = this.d.repo.get(id)
      if (r?.state !== 'copying') continue
      // A copy that already finished is not interrupted: the next start goes on from it.
      if (r.copyJobId && this.ctx.jobs.get(r.copyJobId)?.state === 'done') continue
      this.system(id, 'attention', 'copy_interrupted', null)
    }
  }

  /**
   * W3 review (I1): every listener hears a change, whatever another one does — a listener that
   * throws must not stop a deletion halfway, nor (from the push timer) end the process.
   */
  private tell(r: LiveSyncRecord, gone: boolean): void {
    for (const l of this.listeners) {
      try {
        l(r, gone)
      } catch {
        // The listener's own failure is its to report.
      }
    }
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  create({ reason, ...input }: NewLiveSync & { reason?: LiveSyncReason }): LiveSyncRecord {
    let r = this.d.repo.create(input)
    // W4.6: a scheduled sync waits, paused by the system, for its time.
    if (reason) r = this.d.repo.setState(r.id, r.state, reason, null, 'system')
    this.d.repo.log(r.id, { at: Date.now(), kind: 'state', state: r.state, ...(reason ? { reason } : {}) })
    this.push(r)
    this.spawn(r.id)
    return r
  }

  /** W4.6: the scheduled syncs whose time has come start (the timer calls it; tests pass a time). */
  async startDue(now = Date.now()): Promise<void> {
    if (this.closed) return
    for (const r of this.d.repo.list())
      if (r.state === 'paused' && r.reason === 'scheduled' && (r.options.scheduledAt ?? Infinity) <= now)
        await this.startScheduled(r, false).catch(() => undefined)
  }

  /**
   * W4.6: a scheduled sync's start, as its owner — planned again (rights, rules, loops, the target,
   * the masking, with what the owner confirmed at create), T0 read now, its copy started. A plan that
   * no longer holds waits for a person (attention, `scheduled_refused`, the reasons named).
   *
   * W4 review C3: first, everything checked before every batch (checkSync) — the owner's rights on
   * the source (documents:read, data:export) as on the target, the rules' versions (rules added
   * since the sync was scheduled are reviewed by its owner first), the connections' settings; the
   * plan below checks the target only. `asked`: its owner's "Start now" (a full transfer queue is
   * said); the timer leaves it waiting for the next tick instead.
   */
  private async startScheduled(r: LiveSyncRecord, asked: boolean): Promise<LiveSyncRecord> {
    if (this.starting.has(r.id)) return r
    this.starting.add(r.id)
    const releases: Array<() => void> = []
    try {
      const { ctx } = this
      const principal = ownerPrincipal(ctx, r.owner)
      if (!principal) return this.system(r.id, 'attention', 'owner_access', 'account')
      const check = checkSync(ctx, r)
      if (!check.ok) return this.system(r.id, check.state, check.reason, check.detail ?? null)
      if (r.options.startMode !== 'from_now')
        try {
          assertTransferRoom(ctx, principal)
        } catch (e) {
          if (asked) throw e
          return r
        }
      // The plan's and the copy's code read who asks and from where as a request carries them.
      const asOwner = requestAs(ctx, principal, r.source.connectionId, releases)
      if (!asOwner) return this.system(r.id, 'stopped', 'connection_deleted', null)
      const o = r.options
      const body = LiveSyncRequestSchema.parse({
        name: r.name,
        source: {
          connectionId: r.source.connectionId,
          db: r.source.db,
          ...(r.source.coll
            ? { coll: r.source.coll }
            : r.source.collections
              ? { collections: r.source.collections }
              : {}),
        },
        target: {
          connectionId: r.target.connectionId,
          db: r.target.db,
          ...(r.target.coll ? { coll: r.target.coll } : {}),
        },
        startMode: o.startMode,
        errorPolicy: o.errorPolicy,
        followNew: o.followNew,
        anonymous: o.anonymous,
        ...(o.filter ? { filter: o.filter } : {}),
        ...o.confirmed,
      })
      let planned: PlannedSync
      try {
        planned = await planLiveSync(asOwner, body, this.edges(r.id), r)
      } catch (e) {
        const reason = (e as { details?: { reason?: unknown } }).details?.reason
        return this.system(
          r.id,
          'attention',
          'scheduled_refused',
          typeof reason === 'string' ? reason : 'plan',
        )
      }
      if (planned.plan.refusals.length)
        return this.system(r.id, 'attention', 'scheduled_refused', planned.plan.refusals.join(','))
      const copying = body.startMode !== 'from_now'
      const t0 = tsFrom(await operationTime(planned.sourceClient))
      const startAt = copying ? `${Math.max(0, t0.t - 1)}.${t0.i}` : `${t0.t}.${t0.i + 1}`
      let jobId: string | null = null
      if (copying)
        try {
          jobId = startCopyJob(
            asOwner,
            planned.input,
            planned.prepared,
            [],
            {
              coll: body.source.coll ?? '*',
              target: body.target.coll
                ? `${body.target.db}.${body.target.coll}`
                : `${body.target.db} (live sync)`,
            },
            { primaryReads: true },
          ).id
        } catch (e) {
          const reason = (e as { details?: { reason?: unknown } }).details?.reason
          return this.system(
            r.id,
            'attention',
            'scheduled_refused',
            typeof reason === 'string' ? reason : 'copy',
          )
        }
      const { scheduledAt: _s, confirmed: _c, ...options } = planned.options
      this.d.repo.update(r.id, {
        startAt,
        copyJobId: jobId,
        options,
        stamps: planned.stamps,
      })
      const next = this.setState(r.id, copying ? 'copying' : 'catching_up', null)
      ctx.audit.append({
        action: 'livesync.start',
        outcome: 'success',
        userId: null,
        username: null,
        ip: null,
        connectionId: r.source.connectionId,
        namespace: r.source.coll ? `${r.source.db}.${r.source.coll}` : r.source.db,
        details: { sync: r.id, owner: r.owner, scheduledAt: r.options.scheduledAt ?? null, copyJob: jobId },
      })
      this.spawn(r.id)
      return next
    } finally {
      for (const release of releases) release()
      this.starting.delete(r.id)
    }
  }

  /** Spec §3.4: the syncs that are not final, as edges between deployments' namespaces. */
  edges(except?: string): SyncEdge[] {
    // W4.6: a two-way direction under review is not a loop with its own partner.
    const partner = except ? this.d.repo.get(except)?.options.twoWay?.partner : undefined
    return this.d.repo
      .list()
      .filter((r) => !FINAL.has(r.state) && r.id !== except && r.id !== partner)
      .map((r) => ({
        source: { deployment: r.stamps.deployments.source, db: r.source.db, coll: r.source.coll },
        target: { deployment: r.stamps.deployments.target, db: r.target.db, coll: r.target.coll },
      }))
  }

  retryAt(id: string): number | null {
    return this.workers.get(id)?.worker.retryAt ?? null
  }

  view(principal: Principal, r: LiveSyncRecord): LiveSyncView {
    const { ctx } = this
    // A connection the viewer cannot see now keeps its name to itself.
    const nameOf = (id: string) =>
      ctx.connections.get(id) && effectiveRole(ctx, principal, id) ? ctx.connections.get(id)!.name : ''
    return {
      id: r.id,
      name: r.name,
      mine: r.owner === ownerOf(principal),
      owner: r.owner === 'local' ? 'local' : (ctx.users.findById(r.owner)?.username ?? ''),
      source: { ...r.source, connectionName: nameOf(r.source.connectionId) },
      target: { ...r.target, connectionName: nameOf(r.target.connectionId) },
      startMode: r.options.startMode,
      errorPolicy: r.options.errorPolicy,
      followNew: r.options.followNew,
      anonymous: r.options.anonymous,
      masked: r.options.masked,
      filter: r.options.filter ?? null,
      twoWay: r.options.twoWay ? { partner: r.options.twoWay.partner, side: r.options.twoWay.side } : null,
      scheduledAt: r.state === 'paused' && r.reason === 'scheduled' ? (r.options.scheduledAt ?? null) : null,
      state: r.state,
      reason: r.reason,
      detail: r.detail,
      pausedBy: r.pausedBy,
      counters: r.counters,
      copyJobId: r.copyJobId,
      copiedAt: r.copiedAt,
      retryAt: r.state === 'retrying' || r.state === 'cutting_over' ? this.retryAt(r.id) : null,
      // W4.6: a verification's samples hold documents: never in a view (administrators see views
      // of syncs whose data they may not read); the owner reads them through their own route.
      verify: r.verify ? withoutSamples(r.verify) : null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      finishedAt: r.finishedAt,
    }
  }

  // ── control (the routes check who may act) ──────────────────────────────

  async pause(r: LiveSyncRecord, by: 'owner' | 'admin', name: string): Promise<LiveSyncRecord> {
    if (r.state === 'copying')
      throw Errors.conflict('A sync can be paused once its copy is done; stop it instead', {
        reason: 'copying',
      })
    if (!RUNNING.has(r.state)) throw Errors.conflict('This sync is not running', { reason: 'not_running' })
    return this.keeping([r.id, r.options.twoWay?.partner], async () => {
      await this.halt(r.id)
      // W4.6: a two-way sync pauses both ways.
      const partner = this.partnerOf(r)
      if (partner && RUNNING.has(partner.state)) {
        await this.halt(partner.id)
        this.setState(partner.id, 'paused', by, null, by === 'admin' ? `admin:${name}` : 'owner')
      }
      return this.setState(r.id, 'paused', by, null, by === 'admin' ? `admin:${name}` : 'owner')
    })
  }

  async resume(r: LiveSyncRecord, byAdministrator = true): Promise<LiveSyncRecord> {
    // W4.6: "Start now" for a scheduled sync (the route lets its owner alone ask).
    if (r.state === 'paused' && r.reason === 'scheduled') return this.startScheduled(r, true)
    // Final review I5: an administrator's pause is an administrator's to lift (as for schedules).
    if (r.state === 'paused' && r.reason === 'admin' && !byAdministrator)
      throw Errors.forbidden('An administrator paused this sync; ask one to resume it', {
        reason: 'paused_by_admin',
      })
    const resumable =
      r.state === 'paused' || (r.state === 'attention' && r.reason !== null && RESUMABLE.has(r.reason))
    if (!resumable) {
      if (r.state === 'attention' && r.reason !== null && REVIEWED.has(r.reason))
        throw Errors.conflict('Review the sync’s summary again before it resumes', {
          reason: 'review_required',
        })
      throw Errors.conflict('This sync cannot resume from here', { reason: 'not_resumable' })
    }
    // W4 review (minor): a scheduled sync stopped before it ever started has nothing to resume from
    // (no start point): it is started now, checked and planned as at its time.
    if (r.startAt === null && r.options.scheduledAt !== undefined) return this.startScheduled(r, true)
    // W4.6: a two-way sync resumes both ways (the other direction paused with it).
    const partner = this.partnerOf(r)
    // W4 re-review 2 (minor): after a backlog, the other side (the one that lagged) runs first; this
    // one waits, paused, until that one is live, so the backlog does not come straight back.
    if (r.state === 'attention' && r.reason === 'two_way_backlog' && partner && !FINAL.has(partner.state)) {
      if (!RUNNING.has(partner.state)) this.restart(partner)
      return this.setState(r.id, 'paused', 'partner_catching_up', null)
    }
    // W4 review I5: paused because the other direction stopped — it is that one that resumes (both go).
    if (r.reason === 'partner_stopped' && partner && !RUNNING.has(partner.state)) {
      await this.resume(partner, byAdministrator)
      return this.d.repo.get(r.id) ?? r
    }
    if (partner?.state === 'paused' && partner.reason === r.reason) this.restart(partner)
    return this.restart(r)
  }

  /** Spec §3.2, S9: the owner confirmed a new summary; the sync carries on under it. */
  async confirm(
    r: LiveSyncRecord,
    patch: Pick<LiveSyncRecord, 'stamps' | 'options'>,
    confirmed: { confirmPersonal: boolean } = { confirmPersonal: false },
  ): Promise<LiveSyncRecord> {
    if (!(r.state === 'attention' && r.reason !== null && REVIEWED.has(r.reason)))
      throw Errors.conflict('This sync has nothing to confirm', { reason: 'not_resumable' })
    // W4 review (minor): a scheduled sync that never started keeps its own options; what its owner
    // confirmed now (the rules added since) joins what they confirmed when scheduling it, and it
    // starts — checked and planned as at its time.
    if (r.startAt === null && r.options.scheduledAt !== undefined) {
      this.d.repo.update(r.id, {
        stamps: patch.stamps,
        options: {
          ...r.options,
          confirmed: {
            ...r.options.confirmed!,
            confirmPersonal: confirmed.confirmPersonal || r.options.confirmed!.confirmPersonal,
          },
        },
      })
      return this.startScheduled(this.d.repo.get(r.id)!, true)
    }
    this.d.repo.update(r.id, patch)
    return this.restart(this.d.repo.get(r.id)!)
  }

  async stop(r: LiveSyncRecord, reason: 'owner' | 'admin' | 'connection_deleted'): Promise<LiveSyncRecord> {
    if (FINAL.has(r.state)) throw Errors.conflict('This sync has ended already', { reason: 'final' })
    return this.keeping([r.id, r.options.twoWay?.partner], async () => {
      await this.halt(r.id)
      await this.cancelCopy(r)
      // W4.6: a two-way sync stops both ways; their shared state goes with them.
      const partner = this.partnerOf(r)
      if (partner && !FINAL.has(partner.state)) {
        await this.halt(partner.id)
        this.setState(partner.id, 'stopped', reason)
      }
      if (r.options.twoWay) this.pairs.delete(this.pairKey(r))
      return this.setState(r.id, 'stopped', reason)
    })
  }

  /** Plan ruling 11: the document a write error stopped on is skipped once, then the sync resumes. */
  skip(r: LiveSyncRecord): LiveSyncRecord {
    if (r.state !== 'attention' || r.reason !== 'write_error' || !r.skip)
      throw Errors.conflict('No document is waiting to be skipped', { reason: 'nothing_to_skip' })
    this.d.repo.update(r.id, { skip: { ...r.skip, armed: true } })
    this.d.repo.log(r.id, { at: Date.now(), kind: 'skipped', detail: r.skip.id.slice(0, 200) })
    return this.restart(this.d.repo.get(r.id)!)
  }

  remove(r: LiveSyncRecord): void {
    if (RUNNING.has(r.state)) throw Errors.conflict('Stop or pause the sync first', { reason: 'running' })
    // W4.6: a two-way sync goes both ways (neither direction runs on its own).
    const partner = this.partnerOf(r)
    if (partner && RUNNING.has(partner.state))
      throw Errors.conflict('Stop or pause the sync first', { reason: 'running' })
    for (const rec of partner ? [r, partner] : [r]) {
      this.d.repo.remove(rec.id)
      this.rejected.remove(rec)
      clearTimeout(this.pushes.get(rec.id)?.timer)
      this.pushes.delete(rec.id)
      this.tell(rec, true)
    }
    if (r.options.twoWay) this.pairs.delete(this.pairKey(r))
  }

  /** Plan ruling 6, S9: an edited connection is checked at once (the worker would at its next batch). */
  async connectionChanged(connectionId: string): Promise<void> {
    for (const r of this.touching(connectionId)) {
      if (!RUNNING.has(r.state)) continue
      const check = checkSync(this.ctx, r)
      if (check.ok) continue
      await this.keeping([r.id], async () => {
        await this.halt(r.id)
        this.system(r.id, check.state, check.reason, check.detail ?? null)
      })
    }
  }

  /** Plan ruling 6: a deleted connection stops its syncs (the target keeps what it has). */
  async connectionDeleted(connectionId: string): Promise<void> {
    for (const r of this.touching(connectionId)) {
      await this.keeping([r.id], async () => {
        await this.halt(r.id)
        await this.cancelCopy(r)
        // Final review m7: the worker may have stopped it on its own while it was halted.
        const now = this.d.repo.get(r.id)
        if (!now || FINAL.has(now.state)) return
        this.system(r.id, 'stopped', 'connection_deleted', null)
      })
    }
  }

  /** Final review m15: a deleted user's syncs stop and go (the targets keep their data). */
  async ownerDeleted(userId: string): Promise<void> {
    for (const r of this.d.repo.list(userId)) {
      await this.halt(r.id)
      await this.cancelCopy(r)
      this.d.repo.remove(r.id)
      this.rejected.remove(r)
      this.tell(r, true)
    }
  }

  /** At most this many verifications at once on the server (S6). */
  static readonly VERIFY_AT_ONCE = 2

  /** Spec §1.5: a verification beside the running sync; its report replaces the last one. */
  verify(r: LiveSyncRecord): LiveSyncRecord {
    if (r.state === 'copying' || r.state === 'cutting_over')
      throw Errors.conflict('Verify once the copy is done', { reason: 'not_ready' })
    if (this.verifying.has(r.id))
      throw Errors.conflict('A verification is running', { reason: 'verify_running' })
    if (this.verifying.size >= LiveSyncRunner.VERIFY_AT_ONCE)
      throw Errors.conflict('Other verifications are running; try again shortly', { reason: 'verify_busy' })
    const controller = new AbortController()
    this.verifying.set(r.id, controller)
    const run = this.runVerify(r, controller.signal, RUNNING.has(r.state))
      .catch(() => undefined)
      .finally(() => {
        this.verifying.delete(r.id)
        this.verifyRuns.delete(r.id)
      })
    this.verifyRuns.set(r.id, run)
    return this.d.repo.get(r.id)!
  }

  private async runVerify(r: LiveSyncRecord, signal: AbortSignal, settle: boolean): Promise<void> {
    const running = { state: 'running' as const, startedAt: Date.now(), finishedAt: null, pairs: [] }
    this.push(this.d.repo.update(r.id, { verify: running }))
    const answer = await verifySync(
      { ctx: this.ctx, settled: (time, since, s) => this.settled(r.id, time, since, s) },
      r,
      signal,
      settle,
    )
    // Cut by a stop (the server's or the sync's): said as such, whatever error the cut caused.
    const result = signal.aborted
      ? { ...answer, state: 'failed' as const, pairs: [], error: 'aborted' }
      : answer
    if (!this.d.repo.get(r.id)) return
    const saved = this.d.repo.update(r.id, { verify: result })
    const differ = result.pairs.reduce((n, p) => n + p.different + p.onlySource + p.onlyTarget, 0)
    this.d.repo.log(r.id, {
      at: Date.now(),
      kind: 'verify',
      detail: result.state === 'done' ? `${differ}` : (result.error ?? 'failed'),
    })
    this.push(saved)
  }

  /** Plan ruling 8: the sync applied everything up to `time`, or was idle after `since`; 60 s at most. */
  private async settled(id: string, time: string, since: number, signal: AbortSignal): Promise<boolean> {
    const end = Date.now() + 60_000
    while (!signal.aborted && Date.now() < end) {
      const r = this.d.repo.get(id)
      if (!r || !RUNNING.has(r.state)) return false
      if (r.placeTime && tsCompare(r.placeTime, time) >= 0) return true
      if ((r.counters.caughtUpAt ?? 0) > since) return true
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return false
  }

  /** Spec §1.6: T1 now; the worker applies everything up to it, verifies if asked, and completes. */
  async finish(r: LiveSyncRecord, verify: boolean): Promise<LiveSyncRecord> {
    // W4.6: a two-way sync has no "source to stop writing to": it is stopped, not cut over.
    if (r.options.twoWay)
      throw Errors.conflict('A two-way sync has no cutover; stop it instead', { reason: 'two_way_finish' })
    if (r.state !== 'live' && r.state !== 'catching_up')
      throw Errors.conflict('Finish a sync while it is live', { reason: 'not_live' })
    // Fifth review of the open's stop (minor 2): a side that cannot open is named, not a 500.
    const t1 = await operationTime(
      await this.ctx.manager.getClient(r.source.connectionId).catch(asConnectionFailure),
    )
    // The state may have moved while T1 was read.
    const now = this.d.repo.get(r.id)
    if (!now || (now.state !== 'live' && now.state !== 'catching_up'))
      throw Errors.conflict('Finish a sync while it is live', { reason: 'not_live' })
    this.d.repo.update(r.id, { finish: { t1, at: Date.now(), verify } })
    return this.setState(r.id, 'cutting_over', null)
  }

  /** Plan ruling 12: apply the source's validator and validation settings, or ignore them; then resume. */
  async applySchema(r: LiveSyncRecord, ignore: boolean): Promise<LiveSyncRecord> {
    if (r.state !== 'attention' || r.reason !== 'schema_changed' || r.skip?.id !== SCHEMA_SKIP || !r.skip.ns)
      throw Errors.conflict('No new options are waiting', { reason: 'nothing_to_apply' })
    if (!ignore) {
      const check = checkSync(this.ctx, r)
      if (!check.ok) return this.system(r.id, check.state, check.reason, check.detail ?? null)
      const source = await this.ctx.manager.getClient(r.source.connectionId).catch(asConnectionFailure)
      const [info] = await withMongo(() =>
        source.db(r.source.db).listCollections({ name: r.skip!.ns }, { nameOnly: false }).toArray(),
      )
      if (!info) throw Errors.conflict('The source collection is gone', { reason: 'source_gone' })
      const options = createOptions(
        { name: info.name, type: info.type ?? 'collection', options: info.options ?? {} },
        { options: false, validator: true },
        this.ctx.config.allowServerJs,
      )
      if ('skip' in options) throw Errors.conflict(options.skip, { reason: 'server_js' })
      // Independent review of the security pass (I3): a masked sync never writes a validator that
      // names a value masking would change (its copy left it out too). Ruling: such options can only
      // be ignored — applying them without the validator would silently drop the target's own.
      const mask = check.maskFor(r.source.db, r.skip.ns)
      if (
        mask &&
        withoutMaskedValidator(options.options, r.source.db, r.skip.ns, maskerOfPatterns(mask)).left
      )
        throw Errors.conflict(`${VALIDATOR_LEFT_OUT}: ignore the new options instead`, {
          reason: 'validator_masked',
        })
      const pair = r.options.pairs.find(([s]) => s === r.skip!.ns)
      const targetColl = r.target.coll ?? pair?.[1] ?? r.skip.ns
      const target = await this.ctx.manager.getClient(r.target.connectionId).catch(asConnectionFailure)
      await withMongo(() =>
        target.db(r.target.db).command({
          collMod: targetColl,
          validator: options.options.validator ?? {},
          validationLevel: options.options.validationLevel ?? 'strict',
          validationAction: options.options.validationAction ?? 'error',
        }),
      )
    }
    this.d.repo.update(r.id, { skip: { ...r.skip, armed: true } })
    this.d.repo.log(r.id, { at: Date.now(), kind: 'schema', detail: ignore ? 'ignored' : 'applied' })
    return this.restart(this.d.repo.get(r.id)!)
  }

  /** Spec §2.6: for /metrics — syncs by state, the largest lag of a running one, changes applied. */
  metrics(): { states: Record<LiveSyncState, number>; lagSeconds: number; changes: number } {
    // The changes of the syncs that exist (a gauge: it drops when one is deleted, final review m3).
    const states = Object.fromEntries(LIVE_SYNC_STATES.map((s) => [s, 0])) as Record<LiveSyncState, number>
    let lag = 0
    let changes = 0
    for (const r of this.d.repo.list()) {
      states[r.state]++
      if (RUNNING.has(r.state)) lag = Math.max(lag, r.counters.lagMs)
      changes += r.counters.inserted + r.counters.replaced + r.counters.deleted
    }
    return { states, lagSeconds: Math.round(lag / 1000), changes }
  }

  // ── internals ───────────────────────────────────────────────────────────

  private touching(connectionId: string): LiveSyncRecord[] {
    return this.d.repo
      .list()
      .filter(
        (r) =>
          !FINAL.has(r.state) &&
          (r.source.connectionId === connectionId || r.target.connectionId === connectionId),
      )
  }

  /** Back to work after a pause, a stop for a person or the switch: checked first, then a worker. */
  private restart(r: LiveSyncRecord): LiveSyncRecord {
    // Plan ruling 1: a copy that did not finish is never continued; "Start again" makes a new sync.
    if (r.copyJobId !== null && r.copiedAt === null) {
      const state = this.ctx.jobs.get(r.copyJobId)?.state
      if (state !== 'running') return this.system(r.id, 'attention', 'copy_interrupted', null)
    }
    const check = checkSync(this.ctx, r)
    if (!check.ok) return this.system(r.id, check.state, check.reason, check.detail ?? null)
    const next = this.setState(
      r.id,
      r.copyJobId !== null && r.copiedAt === null ? 'copying' : 'catching_up',
      null,
    )
    this.spawn(r.id)
    // W4 review I5: the other direction, paused because this one stopped, goes with it.
    const partner = this.partnerOf(r)
    if (partner?.state === 'paused' && partner.reason === 'partner_stopped') this.restart(partner)
    return next
  }

  /**
   * W4 review I5: a two-way direction that leaves the running states (a stop for a person, a failure)
   * pauses the other one: left running alone, it would hold every change of a document the stopped
   * side also changed, waiting for a stream that does not move — without bound, while its place (and
   * the oplog it needs) stays behind. Resuming either resumes both.
   */
  private followPartner(r: LiveSyncRecord): void {
    if (!r.options.twoWay) return
    // W4 re-review 2 (minor): the side that lagged is live again: the one waiting for it goes on.
    if (r.state === 'live') {
      const waiting = this.partnerOf(r)
      if (waiting?.state === 'paused' && waiting.reason === 'partner_catching_up') this.restart(waiting)
      return
    }
    // Waiting, by design, for its partner to catch up: the partner runs on.
    if (RUNNING.has(r.state) || r.reason === 'partner_catching_up') return
    const partner = this.partnerOf(r)
    if (!partner || !RUNNING.has(partner.state)) return
    void this.halt(partner.id).then(() => {
      // Second review of the CI fix (minor 5): another halt of it under way (a pause, a stop) writes
      // its state when it ends; this one must not start it again meanwhile.
      if (this.kept.has(partner.id)) return
      const now = this.d.repo.get(partner.id)
      if (!now || !RUNNING.has(now.state)) return
      // W4 final review: the stopped side resumed while its partner's worker was being stopped (its
      // resume still saw the partner running): the partner goes on too. Paused instead, it would in
      // turn pause the side that resumed, and both would wait, each for the other.
      const self = this.d.repo.get(r.id)
      if (self && RUNNING.has(self.state)) this.restart(now)
      else this.system(partner.id, 'paused', 'partner_stopped', null)
    })
  }

  private async cancelCopy(r: LiveSyncRecord): Promise<void> {
    if (r.copyJobId && this.ctx.jobs.get(r.copyJobId)?.state === 'running')
      await this.ctx.jobs.cancel(r.copyJobId).catch(() => undefined)
  }

  /**
   * Review of the CI fix 2026-10-20 (important): ends a sync's worker and waits until its loop has
   * ended, whoever asked first. It stays known meanwhile, so a start in that moment never runs a
   * second worker beside the first (both writing, both saving places); its caller writes the next
   * state once it has ended. Unbounded on purpose (second review, minor 4): a halt that returned
   * early would leave a sync no start could take back. A stream wait ends at once; a write under way
   * or an unreachable server is what can hold it.
   */
  private async halt(id: string): Promise<void> {
    const w = this.workers.get(id)
    if (!w) return
    if (!w.stopping) {
      w.stopping = true
      await w.worker.stop()
    }
    await w.done
  }

  /** Keeps `ids` while `fn` halts them and writes their state (see `kept`). */
  private async keeping<T>(ids: Array<string | undefined>, fn: () => Promise<T>): Promise<T> {
    const these = ids.filter((id): id is string => id !== undefined)
    for (const id of these) this.kept.set(id, (this.kept.get(id) ?? 0) + 1)
    try {
      return await fn()
    } finally {
      for (const id of these) {
        const n = this.kept.get(id)! - 1
        if (n > 0) this.kept.set(id, n)
        else this.kept.delete(id)
      }
    }
  }

  private setState(
    id: string,
    state: LiveSyncState,
    reason: LiveSyncReason | null,
    detail: string | null = null,
    pausedBy: string | null = null,
  ): LiveSyncRecord {
    const r = this.d.repo.setState(id, state, reason, detail, pausedBy)
    this.d.repo.log(id, { at: Date.now(), kind: 'state', state, ...(reason ? { reason } : {}) })
    this.push(r)
    this.followPartner(r)
    return r
  }

  /** A change no person asked for: logged, audited (spec §2.6) and pushed. */
  private system(
    id: string,
    state: LiveSyncAuditedState,
    reason: LiveSyncReason,
    detail: string | null,
  ): LiveSyncRecord {
    const r = this.setState(id, state, reason, detail)
    this.audit(r, state)
    return r
  }

  /** Audit action labels, final review: audited under its new state, one of those the log names. */
  private audit(r: LiveSyncRecord, state: LiveSyncAuditedState): void {
    // W4 review I4: a sync that stopped by itself reaches the alerts from its own record (W3's
    // AlertService.onLiveSync, through onChange) — not raised again here.
    const action: LiveSyncAuditAction = `livesync.${state}`
    this.ctx.audit.append({
      action,
      outcome: 'success',
      userId: null,
      username: null,
      ip: null,
      connectionId: r.source.connectionId,
      namespace: r.source.coll ? `${r.source.db}.${r.source.coll}` : r.source.db,
      details: {
        sync: r.id,
        owner: r.owner,
        target: r.target.connectionId,
        targetNamespace: r.target.coll ? `${r.target.db}.${r.target.coll}` : r.target.db,
        reason: r.reason,
        // Final review m2: MongoDB's words can quote values; the audit keeps the code alone.
        ...(r.reason === 'write_error' || r.reason === 'schema_changed'
          ? { code: /code (\d+)/.exec(r.detail ?? '')?.[1] ?? null }
          : { detail: r.detail }),
      },
    })
  }

  private spawn(id: string): void {
    if (this.closed) return
    // CI 2026-10-20: a worker that has just stopped the sync by itself (attention) is still closing
    // its stream; any restart in that moment (resume, skip, confirm, apply, a partner's) found it
    // there, started none, and the sync sat in catching_up with no worker once it was gone. It is
    // started again then, if the sync is still running. One being halted is not: its halt's caller
    // writes the next state.
    const running = this.workers.get(id)
    if (running) {
      if (!running.stopping) running.again = true
      return
    }
    const { ctx } = this
    const r = this.d.repo.get(id)
    if (!r || !RUNNING.has(r.state)) return
    const worker = new LiveSyncWorker({
      id,
      repo: this.d.repo,
      check: (rec) => checkSync(ctx, rec),
      copyState: (jobId) => (ctx.jobs.get(jobId)?.state ?? null) as CopyState | null,
      open: (from) => this.open(id, from),
      source: () => ctx.manager.getClient(r.source.connectionId),
      target: () => ctx.manager.getClient(r.target.connectionId),
      errorText: (side, e) => errorTextFor(ctx, this.d.repo.get(id) ?? r, side, e),
      reject: (rec, docs) => this.rejected.append(rec, docs),
      verify: (rec, signal) => this.runVerify(rec, signal, false),
      onChange: (rec, event) => this.changed(rec, event),
      ...(r.options.twoWay ? { twoWay: this.twoWayDeps(r) } : {}),
      allowServerJs: ctx.config.allowServerJs,
      timing: { ...WORKER_TIMING, ...this.d.timing },
      now: Date.now,
    })
    // Taken once the worker is made: a throw before would leave the connections held for ever (second
    // review of the CI fix, minor 3).
    const holds = [ctx.manager.hold(r.source.connectionId), ctx.manager.hold(r.target.connectionId)]
    const release = () => holds.forEach((h) => h())
    const entry: WorkerEntry = { worker, release, done: Promise.resolve() }
    entry.done = worker
      .start()
      .finally(() => {
        if (this.workers.get(id) === entry) this.workers.delete(id)
        release()
        if (!entry.again || entry.stopping) return
        // Its start reached a route before; here nothing would catch it (review of the CI fix, minor 1).
        try {
          this.spawn(id)
        } catch (e) {
          this.system(id, 'failed', 'internal', String((e as Error)?.message ?? e).slice(0, 200))
        }
      })
      // Second review (minor 2): a state that could not be written as it ended (its record gone) never
      // fails a halt's caller, nor the process as an unhandled rejection.
      .catch(() => undefined)
    this.workers.set(id, entry)
  }

  /** W4.6: a two-way pair's key (the forward direction's id) and the other direction's id. */
  private pairKey(r: LiveSyncRecord): string {
    return r.options.twoWay?.side === 'reverse' ? r.options.twoWay.partner : r.id
  }
  partnerOf(r: LiveSyncRecord): LiveSyncRecord | undefined {
    return r.options.twoWay?.partner ? this.d.repo.get(r.options.twoWay.partner) : undefined
  }

  /**
   * W4.6: what a two-way direction shares with its partner while it runs — one TwoWayPair per pair,
   * the echo ids of both directions (persisted, so a restart still knows the last ones), and the
   * hooks that persist lost changes and list conflicts.
   */
  private twoWayDeps(r: LiveSyncRecord): NonNullable<WorkerDeps['twoWay']> {
    const key = this.pairKey(r)
    let pair = this.pairs.get(key)
    if (!pair) {
      pair = new TwoWayPair()
      this.pairs.set(key, pair)
    }
    for (const rec of [r, this.partnerOf(r)])
      for (const mark of rec?.options.twoWay?.echo ?? []) {
        const [hex, txn] = readEchoMark(mark)
        pair.echo.set(hex, Math.min(txn, pair.echo.get(hex) ?? txn))
      }
    const withTwoWay = (id: string, f: (t: NonNullable<LiveSyncRecord['options']['twoWay']>) => void) => {
      const rec = this.d.repo.get(id)
      if (!rec?.options.twoWay) return
      const twoWay = {
        ...rec.options.twoWay,
        lost: { ...rec.options.twoWay.lost },
        echo: [...rec.options.twoWay.echo],
      }
      f(twoWay)
      this.d.repo.update(id, { options: { ...rec.options, twoWay } })
    }
    const side = r.options.twoWay!.side
    return {
      side,
      pair,
      onSession: (hex, txn) => {
        pair!.echo.set(hex, txn)
        withTwoWay(r.id, (t) => {
          t.echo = [...t.echo.filter((m) => readEchoMark(m)[0] !== hex), echoMark(hex, txn)].slice(-ECHO_KEPT)
        })
      },
      lost: (whose, id, at) => {
        const rec = whose === side ? r : this.partnerOf(this.d.repo.get(r.id) ?? r)
        if (!rec) return
        withTwoWay(rec.id, (t) => {
          const now = Date.now()
          t.lost[lostKey(id)] = at
          const kept = Object.entries(t.lost)
            .filter(([, when]) => now - when < LOST_KEPT_MS)
            .sort((a, b) => b[1] - a[1])
            .slice(0, LOST_KEPT)
          t.lost = Object.fromEntries(kept)
        })
      },
      conflicts: (rec, notes) => {
        for (const n of notes)
          this.d.repo.log(rec.id, {
            at: Date.now(),
            kind: 'conflict',
            detail: `${n.id} · ${n.kind} · ${n.winner}`,
          })
        this.ctx.events.emit('liveSync.conflicts', {
          severity: 'warning',
          summary: `Live sync ${rec.name}: ${notes.length} conflicting change(s) settled, the last writer winning.`,
          connectionId: rec.source.connectionId,
          namespace: rec.source.coll ? `${rec.source.db}.${rec.source.coll}` : rec.source.db,
          ownerId: rec.owner,
          details: { sync: rec.id, conflicts: notes.length, side: rec.options.twoWay?.side ?? null },
        })
      },
    }
  }

  /** Spec §1.3–§1.4: the source's changes, as current documents, with index and collection events. */
  private async open(id: string, from: { token: unknown } | { startAt: string }): Promise<StreamLike> {
    const r = this.d.repo.get(id)!
    const client = await this.ctx.manager.getClient(r.source.connectionId)
    const options: ChangeStreamOptions = {
      // W4 final review (I): the documents keep their values' types (1.0 stays a Double, a Long a
      // Long): written back as read, never as the JavaScript numbers the driver would make of them.
      ...READ_OPTIONS,
      // W4.6: a two-way direction reads each change's own pre- and post-image (a lookup could read
      // a document the other direction has just overwritten).
      ...(r.options.twoWay
        ? { fullDocument: 'whenAvailable', fullDocumentBeforeChange: 'whenAvailable' }
        : { fullDocument: 'updateLookup' }),
      showExpandedEvents: true,
      ...('token' in from
        ? { resumeAfter: from.token as ResumeToken }
        : { startAtOperationTime: tsFrom(from.startAt) }),
    }
    const db = client.db(r.source.db)
    const pipeline = pipelineFor(r)
    if (r.source.coll) return db.collection(r.source.coll).watch(pipeline, options) as unknown as StreamLike
    return db.watch(pipeline, options) as unknown as StreamLike
  }

  /** A worker's change: every automatic stop or end is audited (spec §2.6); a stopped copy job is cancelled. */
  private changed(r: LiveSyncRecord, event: LiveSyncEvent | null): void {
    if (
      event &&
      (r.state === 'attention' || r.state === 'failed' || r.state === 'stopped' || r.state === 'completed')
    ) {
      this.audit(r, r.state)
      if (r.state !== 'completed') void this.cancelCopy(r)
    }
    this.push(r)
    this.followPartner(r)
  }

  /** Plan ruling 15: at most one push a second per sync; a new state goes out at once. */
  private push(r: LiveSyncRecord): void {
    // Once closed nothing more is pushed: a timer would read the store after it closed.
    if (this.closed) return
    const ms = this.d.pushMs ?? 1000
    const p = this.pushes.get(r.id) ?? { last: 0, state: '' }
    this.pushes.set(r.id, p)
    const now = Date.now()
    if (p.state === r.state && now - p.last < ms) {
      p.timer ??= setTimeout(
        () => {
          p.timer = undefined
          if (this.closed) return
          const fresh = this.d.repo.get(r.id)
          if (fresh) this.emit(fresh, p)
        },
        ms - (now - p.last),
      )
      p.timer.unref?.()
      return
    }
    clearTimeout(p.timer)
    p.timer = undefined
    this.emit(r, p)
  }

  private emit(r: LiveSyncRecord, p: { last: number; state: string }): void {
    p.last = Date.now()
    p.state = r.state
    this.tell(r, false)
  }
}
