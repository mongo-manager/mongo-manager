import {
  BSON,
  MongoBulkWriteError,
  MongoError,
  type ClientSession,
  type Document,
  type IndexDescription,
  type MongoClient,
} from 'mongodb'
import {
  applyOne,
  before,
  changesOf,
  conflictNote,
  force,
  forceIf,
  lostKey,
  otherSide,
  type ConflictNote,
  type Outcome,
  type Pending,
  type Place,
  type Side,
  type TwoWayChange,
  type TwoWayPair,
} from './twoway'

/** W4.6: a two-way batch's result: what it wrote, conflicts settled, the place to hold (none: undefined). */
interface TwoWayResult {
  counts: { inserted: number; replaced: number; deleted: number }
  /** W4 review I6: refused changes its owner chose to skip. */
  skipped: number
  conflicts: number
  hold: Place | null | undefined
}
import {
  LIVE_SYNC_LIMITS,
  RUNNING_STATES,
  type LiveSyncCounters,
  type LiveSyncEvent,
  type LiveSyncReason,
  type LiveSyncState,
} from '@mongo-manager/shared'
import { reasonOf, type StreamLike } from '../changestreams/feed'
import { ConnectionError } from '../connections/errors'
import { isEncryptionNamespace } from '../connections/access'
import { createOptions } from '../transfer/collection-spec'
import { serverLevel, type ServerLevel } from '../backup/series'
import { maskerOfPatterns, VALIDATOR_LEFT_OUT, withoutMaskedValidator } from '../transfer/masked-definitions'
import { nsMaskerFrom, type Pattern } from '../masking/match'
import { idKey, planBatch, SCHEMA_SKIP, valueAt, type BatchPlan, type SchemaStep } from './apply'
import { maskWith } from '../transfer/copy-job'
import { READ_OPTIONS, fromClient } from '../data/ejson-io'
import { LAG_BUCKET_MS, tokenTime, tsCompare, tsText, type LiveSyncRecord, type LiveSyncRepo } from './repo'
import { serverError } from '../data/mongo-errors'

export type CopyState = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted' | 'unknown'

export type CheckResult =
  | {
      ok: true
      maskFor(db: string, coll: string): Pattern[] | null
      /**
       * Security audit 2026-10-16 (Important 4): a masked sync writes no change of a GridFS bucket a
       * rule reaches (user report 2026-10-27: by the source namespace's database and collection).
       */
      withholdFiles?: (db: string, coll: string) => boolean
    }
  | { ok: false; state: 'attention' | 'stopped'; reason: LiveSyncReason; detail?: string }

export interface WorkerTiming {
  /** How often a copying sync looks at its copy job. */
  pollMs: number
  /** How long an idle stream waits before it asks again. */
  idleMs: number
  retryMinMs: number
  retryMaxMs: number
  /** Batch summaries reach the activity log at most this often (spec §2.2: once a minute). */
  logEveryMs: number
  /** Final review I9: how often the target collections are looked at (dropped behind the sync?). */
  targetCheckMs: number
}
/** Spec §1.7, §2.2. */
export const WORKER_TIMING: WorkerTiming = {
  pollMs: 1000,
  idleMs: 250,
  retryMinMs: 1000,
  retryMaxMs: 300_000,
  logEveryMs: 60_000,
  targetCheckMs: 30_000,
}

export interface WorkerDeps {
  id: string
  repo: LiveSyncRepo
  /** Spec §3.1: the owner's rights, the connections, the rules, read-only, the switch — before every batch. */
  check(record: LiveSyncRecord): CheckResult
  /** The initial copy job's state; null when the job is gone. */
  copyState(jobId: string): CopyState | null
  /** The source's change stream, after a resume token or from a cluster time. */
  open(from: { token: unknown } | { startAt: string }): Promise<StreamLike>
  source(): Promise<MongoClient>
  target(): Promise<MongoClient>
  /** Spec §3.3: an error as its owner may read it (its code alone when restricted on that side). */
  errorText(side: 'source' | 'target', e: unknown): string
  /** Spec §1.6 step 3 (Task 6). */
  verify?(record: LiveSyncRecord, signal: AbortSignal): Promise<void>
  /**
   * W4.6: the documents a "skip and record" sync's target refused, as written, for the sync's
   * rejected-records file; answers how many were kept (fewer when the owner's space is full).
   */
  reject?(record: LiveSyncRecord, docs: Document[]): Promise<number>
  /**
   * W4.6: a two-way sync's direction — which side it is, the pair's shared state, and the runner's
   * hooks: a session whose writes are marked, a change of the other side that lost, conflicts settled.
   */
  twoWay?: {
    side: Side
    pair: TwoWayPair
    /** The session's id (hex) and its transaction number when taken (its writes have higher ones). */
    onSession(hex: string, txn: number): void
    lost(side: Side, id: unknown, at: number): void
    conflicts(record: LiveSyncRecord, notes: ConflictNote[]): void
    /** Tests only: how many changes of this side may wait at most (TWO_WAY_PENDING_MAX). */
    maxPending?: number
    /** Tests only: the oldest cluster time ("t.i") the source's oplog still holds. */
    oplogStart?: () => Promise<string | null>
  }
  /** Every saved change (the runner audits, pushes and counts). */
  onChange(record: LiveSyncRecord, event: LiveSyncEvent | null): void
  allowServerJs: boolean
  timing: WorkerTiming
  now(): number
}

const RUNNING = new Set<LiveSyncState>(RUNNING_STATES)
const CONNECTION = /^Mongo(Network|ServerSelection|TopologyClosed|NotConnected|ClientClosed)/
const transient = (e: unknown) =>
  CONNECTION.test(String((e as { name?: unknown }).name ?? '')) ||
  (e instanceof MongoError && e.hasErrorLabel('RetryableWriteError'))
const ID_TEXT = 200
/**
 * W4 re-review (minor): a two-way direction holds at most this many changes waiting for the other
 * side; past it, it stops for a person (two_way_backlog) rather than grow without bound.
 */
export const TWO_WAY_PENDING_MAX = 10_000
/** W4 re-review (minor): stop when the oplog keeps less than this much before the held place. */
const HISTORY_MARGIN_S = 60
/** W4.6: the activity log's words when the owner's space cannot hold more rejected records. */
export const REJECTED_FULL = 'rejected_file_full'

/**
 * Where a source namespace goes, or null when this sync does not carry it. `withholdFiles`: the
 * checks withhold this namespace's file contents (a masked sync, a bucket a rule reaches:
 * CheckResult.withholdFiles).
 */
export function targetOf(
  r: LiveSyncRecord,
  db: string,
  coll: string,
  withholdFiles?: (db: string, coll: string) => boolean,
): { db: string; coll: string } | null {
  if (db !== r.source.db) return null
  const pair = r.options.pairs.find(([s]) => s === coll)
  if (pair) return { db: r.target.db, coll: pair[1] }
  const followed =
    r.options.followNew &&
    r.source.coll === null &&
    !(r.options.ignored ?? []).includes(coll) &&
    !coll.startsWith('system.') &&
    !isEncryptionNamespace(db, coll) &&
    // Final review m12: an aggregation's $out writes here first, then renames over its target.
    !coll.startsWith('tmp.') &&
    // Security audit 2026-10-16 (Important 4): file contents cannot be masked; a masked sync's plan
    // refuses a bucket (gridfs_masked) where rules exist, as one restricted on the target, so one
    // that appears later is not followed either — with the plan's own conditions (checks.ts).
    !(withholdFiles?.(db, coll) ?? false)
  return followed ? { db: r.target.db, coll } : null
}

/**
 * Phase 3e-2 spec §1.2–§1.7: one live sync. It waits for its initial copy, reads the source's
 * changes from T0 or its place, checks its owner before every batch, writes each batch, saves its
 * place once the target took it, and moves between catching up, live, retrying and the stops.
 */
export class LiveSyncWorker {
  /**
   * A collection the sync leaves out, from the record as it is now (other options kept), named once
   * (final review of explain masking, M-2, N-1).
   */
  private ignore(coll: string): void {
    const now = this.record()
    if (!now) return
    const ignored = [...new Set([...(now.options.ignored ?? []), coll])]
    this.d.repo.update(now.id, { options: { ...now.options, ignored } })
  }

  private readonly abort = new AbortController()
  private stream: StreamLike | null = null
  /** Events pulled and not yet applied (a schema event waits for the writes before it). */
  private carry: Document[] = []
  private delay = 0
  private lastLog = 0
  private lastTargetCheck = 0
  /** W4 review (minor): when a two-way direction last read its source's pre-image setting. */
  private lastImagesCheck = 0
  /** W4 re-review (minor): when a two-way direction last looked at its source's oplog. */
  private lastHistoryCheck = 0
  /** Final review m4: the place last saved, so an idle sync does not save it every second. */
  private saved = ''
  /** Final review m8: faults of ours in a row; a passing one is retried, a third fails the sync. */
  private faults = 0
  private loop: Promise<void> | null = null
  /** Target namespace → its shard key fields (null: not sharded), read once. */
  private readonly shardKeys = new Map<string, string[] | null>()
  /** Review of db45c424: the target's feature level, read once (planBatch). */
  private targetLevel: ServerLevel | null = null
  retryAt: number | null = null
  /** What this worker logged as left out already (second review: once per sync). */
  private readonly noted = new Set<string>()
  /** W4.6: the lag bucket last written, and the largest lag written in it. */
  private lagBucket = -1
  private lagMax = -1
  /** W4.6: a two-way direction's session: its writes carry its id, the other direction skips them. */
  private session: ClientSession | null = null
  private sessionClient: MongoClient | null = null

  constructor(private readonly d: WorkerDeps) {}

  start(): Promise<void> {
    this.loop ??= this.run().catch((e: unknown) => {
      if (!this.stopped)
        this.set('failed', 'internal', String((e as Error)?.message ?? e).slice(0, 200), 'error')
    })
    return this.loop
  }

  async stop(): Promise<void> {
    this.abort.abort()
    await this.closeStream()
    await this.loop
  }

  private get stopped(): boolean {
    return this.abort.signal.aborted
  }

  private record(): LiveSyncRecord | undefined {
    return this.d.repo.get(this.d.id)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.stopped) return resolve()
      const timer = setTimeout(resolve, ms)
      this.abort.signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
    })
  }

  private async closeStream(): Promise<void> {
    const s = this.stream
    this.stream = null
    this.carry = []
    await s?.close().catch(() => {})
  }

  private set(
    state: LiveSyncState,
    reason: LiveSyncReason | null = null,
    detail: string | null = null,
    kind: LiveSyncEvent['kind'] = 'state',
  ): LiveSyncRecord {
    const r = this.d.repo.setState(this.d.id, state, reason, detail, null)
    const event: LiveSyncEvent = {
      at: this.d.now(),
      kind,
      state,
      ...(reason ? { reason } : {}),
      ...(detail ? { detail: detail.slice(0, 500) } : {}),
    }
    this.d.repo.log(this.d.id, event)
    this.d.onChange(r, event)
    return r
  }

  private async run(): Promise<void> {
    try {
      const first = this.record()
      if (!first || !RUNNING.has(first.state)) return
      if (first.state === 'copying' && !(await this.waitForCopy())) return
      while (!this.stopped) {
        const r = this.record()
        if (!r || !RUNNING.has(r.state)) return
        const check = this.d.check(r)
        if (!check.ok) {
          this.set(check.state, check.reason, check.detail ?? null)
          return
        }
        try {
          if (!(await this.targetsHere(r))) return
          if (!(await this.imagesOn(r))) return
          if (!(await this.historyHeld(r))) return
          const stream = await this.openStream(r)
          const pulledAt = this.d.now()
          const { events, idle } = await this.pull(stream)
          if (this.stopped) return
          if (await this.step(r, stream, events, idle, pulledAt, check.maskFor, check.withholdFiles)) return
          if (idle && this.carry.length === 0) await this.sleep(this.d.timing.idleMs)
        } catch (e) {
          if (this.stopped) return
          if (!(await this.onError(r, e))) return
        }
      }
    } finally {
      await this.closeStream()
    }
  }

  /** Plan ruling 1: a copying sync waits for its copy job; a failed or interrupted copy needs a person. */
  private async waitForCopy(): Promise<boolean> {
    while (!this.stopped) {
      const r = this.record()
      if (!r || r.state !== 'copying') return !!r && RUNNING.has(r.state)
      const check = this.d.check(r)
      if (!check.ok) {
        this.set(check.state, check.reason, check.detail ?? null)
        return false
      }
      const state = r.copyJobId ? this.d.copyState(r.copyJobId) : 'done'
      if (state === 'done') {
        this.d.repo.update(r.id, { copiedAt: this.d.now() })
        this.set('catching_up')
        return true
      }
      if (state === 'failed' || state === 'cancelled') {
        this.set('attention', 'copy_failed', state, 'error')
        return false
      }
      if (state !== 'running') {
        this.set('attention', 'copy_interrupted', null, 'error')
        return false
      }
      await this.sleep(this.d.timing.pollMs)
    }
    return false
  }

  private async openStream(r: LiveSyncRecord): Promise<StreamLike> {
    if (this.stream) return this.stream
    const place = this.d.repo.place(r.id)
    const from = place ? { token: place.token } : r.startAt ? { startAt: r.startAt } : null
    if (!from) throw new Error('A live sync has neither a place nor a start')
    this.carry = []
    this.stream = await this.d.open(from)
    return this.stream
  }

  /** Spec §1.4: at most 1,000 changes or 8 MiB, pulled only once the previous batch was written. */
  private async pull(stream: StreamLike): Promise<{ events: Document[]; idle: boolean }> {
    const events = this.carry
    this.carry = []
    let bytes = events.reduce((n, e) => n + BSON.calculateObjectSize(e), 0)
    while (events.length < LIVE_SYNC_LIMITS.batchChanges && bytes < LIVE_SYNC_LIMITS.batchBytes) {
      if (this.stopped) break
      const e = await stream.tryNext()
      if (!e) return { events, idle: true }
      events.push(e)
      bytes += BSON.calculateObjectSize(e)
    }
    return { events, idle: false }
  }

  /** One batch: writes, then a schema step, then the place, the counters and the state. True: it ended. */
  private async step(
    r: LiveSyncRecord,
    stream: StreamLike,
    events: Document[],
    idle: boolean,
    pulledAt: number,
    maskFor: (db: string, coll: string) => Pattern[] | null,
    withholdFiles?: (db: string, coll: string) => boolean,
  ): Promise<boolean> {
    let batch = events
    let pastT1 = false
    if (r.state === 'cutting_over' && r.finish) {
      const t1 = r.finish.t1
      const i = events.findIndex((e) => e.clusterTime && tsCompare(tsText(e.clusterTime), t1) > 0)
      if (i >= 0) {
        batch = events.slice(0, i)
        pastT1 = true
      }
    }
    const skip = r.skip?.armed
      ? { id: r.skip.id, at: r.skip.at, ...(r.skip.ns ? { ns: r.skip.ns } : {}) }
      : null
    await this.loadShardKeys(r, batch)
    // Review of db45c424: read once; an upgrade meanwhile only leaves a later index version out.
    this.targetLevel ??= await serverLevel(await this.d.target())
    const plan = planBatch(batch, {
      sourceDb: r.source.db,
      targetOf: (db, coll) => targetOf(r, db, coll, withholdFiles),
      maskFor,
      withholdFiles,
      skip,
      shardKeyOf: (ns) => this.shardKeys.get(`${ns.db}.${ns.coll}`) ?? null,
      targetLevel: this.targetLevel,
    })
    this.carry = batch.slice(plan.consumed)
    if (plan.stop) {
      // Plan ruling 12: a person may pass this `modify` (apply the options, or ignore them).
      if (plan.stop.reason === 'schema_changed' && plan.stop.at)
        this.d.repo.update(r.id, {
          skip: {
            id: SCHEMA_SKIP,
            at: plan.stop.at,
            armed: false,
            ns: plan.stop.detail.slice(r.source.db.length + 1),
          },
        })
      this.set('attention', plan.stop.reason, plan.stop.detail, 'schema')
      return true
    }
    // Final review m1: the source collection's rules decide; _id itself or anything under it.
    for (const { source } of plan.writes) {
      const mask = maskFor(source.db, source.coll)
      const masker = mask ? nsMaskerFrom(mask) : null
      if (masker && (masker.matches(['_id']) || masker.under(['_id']))) {
        this.set('attention', 'rules_changed', `${source.db}.${source.coll}`)
        return true
      }
    }
    // W4.6: a two-way direction writes its changes conditionally, settles conflicts, holds its place.
    let twoWay: TwoWayResult | null = null
    let refused = 0
    if (r.options.twoWay && this.d.twoWay) {
      twoWay = await this.twoWayStep(
        r,
        batch.slice(0, plan.consumed),
        idle && this.carry.length === 0,
        stream,
      )
      if (twoWay === null) return true
      plan.counts = { ...twoWay.counts, skipped: twoWay.skipped }
    } else {
      if (r.options.filter) await this.narrow(r, plan, maskFor)
      const left = await this.write(r, plan)
      if (left === null) return true
      refused = left
    }
    // Independent review of the security pass (minor): what the batch left out, as validators are —
    // once per sync (second review: not a line per batch crowding the capped log, nor again after a
    // restart: one already in the log is not written twice).
    for (const detail of plan.notes) {
      if (this.noted.has(detail)) continue
      this.noted.add(detail)
      if (!this.d.repo.events(r.id).some((e) => e.detail === detail))
        this.d.repo.log(r.id, { at: this.d.now(), kind: 'schema', detail })
    }
    if (plan.schema && !(await this.schema(r, plan.schema, maskFor))) return true

    const now = this.d.now()
    const caughtUp = idle && this.carry.length === 0 && !pastT1
    const counters: LiveSyncCounters = { ...r.counters }
    const last = plan.consumed > 0 ? batch[plan.consumed - 1] : null
    if (last) {
      counters.inserted += plan.counts.inserted
      counters.replaced += plan.counts.replaced
      counters.deleted += plan.counts.deleted
      counters.skipped += plan.counts.skipped + refused
      counters.batches += 1
      if (plan.lastWall !== null) counters.lastEventAt = plan.lastWall
    }
    if (twoWay?.conflicts) counters.conflicts = (counters.conflicts ?? 0) + twoWay.conflicts
    // Plan ruling 9: lag is now minus the last applied change's wall time; nothing waiting is 0.
    counters.lagMs = caughtUp
      ? 0
      : plan.lastWall !== null
        ? Math.max(0, now - plan.lastWall)
        : r.counters.lagMs
    if (caughtUp) counters.caughtUpAt = pulledAt
    this.sampleLag(counters.lagMs, now)
    // The stream's own token after an idle pull also moves past changes this sync does not carry.
    // W4.6: a two-way direction with a change waiting to be settled keeps its place before it.
    const held = twoWay ? twoWay.hold : undefined
    const token =
      held !== undefined
        ? held?.token
        : caughtUp && stream.resumeToken
          ? stream.resumeToken
          : (last?._id as unknown)
    const placeTime = held ? held.time : (plan.lastTime ?? r.placeTime ?? r.startAt ?? '0.0')
    // Final review m4: nothing new (an idle round) saves nothing.
    const mark = JSON.stringify([
      token ?? null,
      counters.inserted,
      counters.replaced,
      counters.deleted,
      counters.skipped,
      counters.conflicts ?? 0,
      counters.lagMs,
    ])
    const changed = mark !== this.saved
    if (changed) {
      this.saved = mark
      if (token !== undefined && token !== null)
        this.d.repo.savePlace(r.id, { token, time: placeTime }, counters)
      else this.d.repo.update(r.id, { counters })
    }
    if (r.skip && plan.lastTime && tsCompare(plan.lastTime, r.skip.at) >= 0)
      this.d.repo.update(r.id, { skip: null })

    if (last && now - this.lastLog >= this.d.timing.logEveryMs) {
      this.lastLog = now
      this.d.repo.log(r.id, { at: now, kind: 'batch', counts: { ...counters } })
    }

    this.faults = 0
    if (r.state === 'cutting_over' && r.finish) {
      // Spec §1.6, final review I4: done when a change after T1 shows up, or the stream's own
      // high-water mark (an idle pull's postBatchResumeToken) is past T1. Changes AT T1 (a
      // transaction, a batched delete) may fill several batches: reaching T1 is not enough.
      const hwm = caughtUp ? tokenTime(stream.resumeToken) : null
      if ((pastT1 && this.carry.length === 0) || (hwm !== null && tsCompare(hwm, r.finish.t1) > 0))
        return this.finish()
      if (changed) this.d.onChange(this.record()!, null)
      return false
    }
    this.delay = 0
    this.retryAt = null
    // A finish may have moved it meanwhile (the runner does not stop the worker for one): the next
    // round reads the new state instead of writing over it.
    if (this.record()?.state !== r.state) return false
    const next: LiveSyncState = counters.lagMs < LIVE_SYNC_LIMITS.liveMs ? 'live' : 'catching_up'
    if (next !== r.state) this.set(next)
    else if (changed) this.d.onChange(this.record()!, null)
    return false
  }

  /**
   * W4.6: a filtered sync. The source evaluates its filter on the batch's documents as they are now
   * (one read per collection): a match is written as it is now (masked when the sync masks), and a
   * document that no longer matches — or is gone — is removed from the target. A change event alone
   * cannot say that a document left the filter; the source's own answer can.
   */
  private async narrow(
    r: LiveSyncRecord,
    plan: BatchPlan,
    maskFor: (db: string, coll: string) => Pattern[] | null,
  ): Promise<void> {
    const filter = fromClient<Document>(r.options.filter!, 'filter')
    const source = await this.d.source()
    for (const w of plan.writes) {
      const ids = w.ops.flatMap((op) => ('replaceOne' in op ? [(op.replaceOne.filter as Document)._id] : []))
      if (!ids.length) continue
      const docs = await source
        .db(w.source.db)
        .collection(w.source.coll)
        .find({ $and: [filter, { _id: { $in: ids } }] } as Document, {
          ...READ_OPTIONS,
          readPreference: 'primary',
          comment: `mm-live-sync:${r.id}`,
        })
        .toArray()
      const found = new Map(docs.map((d) => [idKey(d._id), d]))
      const mask = maskFor(w.source.db, w.source.coll)
      const keys = (this.shardKeys.get(`${w.target.db}.${w.target.coll}`) ?? []).filter((k) => k !== '_id')
      w.ops = w.ops.map((op) => {
        if (!('replaceOne' in op)) return op
        const id = (op.replaceOne.filter as Document)._id
        const doc = found.get(idKey(id))
        if (!doc) {
          // Not counted as a change of the target: it only leaves (or never entered) the filter.
          if (plan.counts.replaced > 0) plan.counts.replaced--
          else if (plan.counts.inserted > 0) plan.counts.inserted--
          return { deleteOne: { filter: { _id: id } as Document } }
        }
        const replacement = mask ? maskWith(doc, mask) : doc
        const by: Document = { _id: id }
        // Seventeenth review of explain masking (nit): a stored sub-document is a value, never an operator.
        for (const k of keys) by[k] = { $eq: valueAt(replacement, k) }
        return { replaceOne: { filter: by, replacement, upsert: true } }
      })
    }
  }

  /** W4.6: this direction's session (its writes' mark), started on first use and kept while it runs. */
  private async twoWaySession(target: MongoClient): Promise<ClientSession> {
    // A session is never ended: an ended one's id goes back to the driver's pool, and another
    // operation carrying it would be taken for an echo. A new client (reconnected) gets a new one.
    if (this.session && this.sessionClient === target) return this.session
    this.sessionClient = target
    const session = target.startSession()
    const id = (session.id?.id as { toString(enc: string): string } | undefined)?.toString('hex')
    if (!id) throw new Error('The target gave the session no id')
    // W4 review (minor): a pooled session id may have carried other writes before this direction took
    // it; only its transactions from now on (higher numbers) are this direction's echoes.
    const txn = Number(
      (session as unknown as { serverSession?: { txnNumber?: number } }).serverSession?.txnNumber ?? 0,
    )
    this.session = session
    this.d.twoWay!.onSession(id, Number.isSafeInteger(txn) ? txn : 0)
    return session
  }

  /**
   * W4.6: one batch of a two-way direction (see twoway.ts). Decided first (no write), written in one
   * snapshot transaction of the marked session, then the shared state moves: a mismatch waits, a
   * settled conflict is listed, a change that lost is remembered. Answers the counts, the conflicts
   * settled and the place to hold (undefined: none), or null when the sync stopped.
   *
   * W4 review C2: a mismatch waits until the other direction's stream has read through the cluster
   * time the mismatch was read at (that cluster's own clock, never the app host's); the read is a
   * snapshot of majority-committed data, so what it saw is what the stream will deliver.
   * W4 review I6: a change the target refuses is named (its _id and time) so its owner can skip it.
   */
  private async twoWayStep(
    r: LiveSyncRecord,
    taken: Document[],
    caughtUp: boolean,
    stream: StreamLike,
  ): Promise<TwoWayResult | null> {
    const tw = this.d.twoWay!
    const { pair, side } = tw
    const other = otherSide(side)
    const [target, source] = await Promise.all([this.d.target(), this.d.source()])
    const coll = target.db(r.target.db).collection(r.target.coll!)
    const place = this.d.repo.place(r.id)
    const start: Place | null = place ? { token: place.token, time: place.time } : null
    const { changes } = changesOf(taken, pair.echo, start)
    // A post-image no longer kept: the document as the source holds it now (its delete follows if gone).
    for (const c of changes)
      if (c.op !== 'delete' && !c.post)
        c.post = await source
          .db(r.source.db)
          .collection(r.source.coll!)
          .findOne({ _id: c.id } as Document, { readPreference: 'primary', ...READ_OPTIONS })
    const lost = r.options.twoWay?.lost ?? {}
    const skip = r.skip?.armed && r.skip.id !== SCHEMA_SKIP ? r.skip : null
    const skipped = (c: TwoWayChange) => !!skip && skip.id === c.key && tsCompare(c.time, skip.at) <= 0
    type Action =
      | { kind: 'apply' | 'skip' | 'queue' | 'refused'; c: TwoWayChange }
      | { kind: 'win'; c: TwoWayChange; loser: Pending }
      | { kind: 'lose'; c: TwoWayChange; winner: Pending }
    const actions: Action[] = []
    for (const c of changes) {
      const p = pair.pending.get(c.key)
      if (skipped(c)) actions.push({ kind: 'refused', c })
      else if (lost[lostKey(c.id)] === c.at || (c.op !== 'delete' && !c.post))
        actions.push({ kind: 'skip', c })
      else if (p && p.side === other)
        actions.push(
          c.at > p.at || (c.at === p.at && side === 'forward')
            ? { kind: 'win', c, loser: p }
            : { kind: 'lose', c, winner: p },
        )
      else if (p) actions.push({ kind: 'queue', c })
      else actions.push({ kind: 'apply', c })
    }
    // The refused change its owner skips: dropped (with what of it waits), remembered as lost.
    for (const a of actions)
      if (a.kind === 'refused') {
        const p = pair.pending.get(a.c.key)
        if (p?.side === side) pair.pending.delete(a.c.key)
        tw.lost(side, a.c.id, a.c.at)
      }
    // A later change of this side to a document already waiting replaces what waits.
    for (const a of actions)
      if (a.kind === 'queue') {
        const p = pair.pending.get(a.c.key)!
        p.at = a.c.at
        p.post = a.c.post
        p.time = a.c.time
      }
    // This side's waiting changes that are due: the other side lost to them, or its stream read
    // through the moment they were found differing.
    const due = [...pair.pending.values()].filter(
      (p) => p.side === side && (p.state === 'won' || tsCompare(pair.read[other], p.seen) >= 0),
    )
    const outcomes = new Map<TwoWayChange, Outcome>()
    // W4 re-review I2: a write over the other side is made only where it still holds what it held when
    // last read; otherwise what it holds now is kept, and the change waits again.
    type Forced = { ok: true } | { ok: false; holds: Document | null }
    const forced = new Map<Pending | TwoWayChange, Forced>()
    const forceOver = async (id: unknown, post: Document | null, expected: Document | null | undefined) =>
      expected === undefined
        ? (await force(coll, id, post, session), { ok: true as const })
        : forceIf(coll, id, post, expected, session)
    const session = await this.twoWaySession(target)
    let current: { key: string; time: string } | null = null
    let seen = '0.0'
    try {
      if (actions.some((a) => a.kind === 'apply' || a.kind === 'win') || due.length) {
        await session.withTransaction(
          async () => {
            outcomes.clear()
            forced.clear()
            for (const a of actions) {
              current = { key: a.c.key, time: a.c.time }
              if (a.kind === 'apply') outcomes.set(a.c, await applyOne(coll, a.c, session))
              // The change that lost was the other side's: that side holds its result.
              else if (a.kind === 'win') forced.set(a.c, await forceOver(a.c.id, a.c.post, a.loser.post))
            }
            for (const p of due) {
              current = { key: p.key, time: p.time }
              forced.set(p, await forceOver(p.id, p.post, p.expected))
            }
            current = null
          },
          { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
        )
        const t = session.operationTime
        if (t) seen = tsText(t as never)
      }
    } catch (e) {
      // Stopped meanwhile (paused with its partner, say): what broke is the stop, not the target.
      if (transient(e) || this.stopped) throw e
      // Spec §1.7 (two-way: pause and ask only): the transaction took nothing; the place stays. The
      // change it stopped on is named, so its owner may skip it (I6).
      const at = current as { key: string; time: string } | null
      if (at)
        this.d.repo.update(r.id, {
          skip: { id: at.key, at: at.time, armed: false, ns: `${r.source.db}.${r.source.coll}` },
        })
      const text = this.d.errorText('target', e)
      this.set('attention', 'write_error', at ? `${at.key.slice(0, ID_TEXT)} · ${text}` : text, 'error')
      return null
    }
    const counts = { inserted: 0, replaced: 0, deleted: 0 }
    const count = (op: TwoWayChange['op']) =>
      op === 'insert' ? counts.inserted++ : op === 'delete' ? counts.deleted++ : counts.replaced++
    const notes: ConflictNote[] = []
    const waitAgain = (c: TwoWayChange, holds: Document | null): Pending => ({
      side,
      at: c.at,
      time: c.time,
      seen,
      expected: holds,
      post: c.post,
      id: c.id,
      state: 'waiting',
      key: c.key,
      held: c.before,
    })
    for (const a of actions) {
      if (a.kind === 'win') {
        tw.lost(other, a.loser.id, a.loser.at)
        const f = forced.get(a.c)
        if (f && !f.ok) {
          // The other side changed again since the change that lost: this one waits for that one.
          pair.pending.set(a.c.key, waitAgain(a.c, f.holds))
          continue
        }
        pair.pending.delete(a.c.key)
        count(a.c.op)
        notes.push(conflictNote(a.c.id, side, a.c.at, a.loser.at, 'both'))
      } else if (a.kind === 'lose') {
        a.winner.state = 'won'
        // The winner is written over this side's change (what this side holds now).
        a.winner.expected = a.c.post
        notes.push(conflictNote(a.c.id, other, a.winner.at, a.c.at, 'both'))
        tw.lost(side, a.c.id, a.c.at)
      } else if (a.kind === 'apply') {
        const o = outcomes.get(a.c)
        if (o?.kind === 'applied') count(a.c.op)
        else if (o?.kind === 'mismatch') {
          const mine: Pending = waitAgain(a.c, o.holds)
          // The other direction found the same document changed at the same moment: settle it
          // now rather than let one entry replace the other. A winner of this side is written at
          // its next round (won); a loser's change is dropped and remembered.
          const theirs = pair.pending.get(a.c.key)
          if (theirs && theirs.side === other) {
            if (a.c.at > theirs.at || (a.c.at === theirs.at && side === 'forward')) {
              mine.state = 'won'
              pair.pending.set(a.c.key, mine)
              notes.push(conflictNote(a.c.id, side, a.c.at, theirs.at, 'both'))
              tw.lost(other, theirs.id, theirs.at)
            } else {
              theirs.state = 'won'
              theirs.expected = a.c.post
              notes.push(conflictNote(a.c.id, other, theirs.at, a.c.at, 'both'))
              tw.lost(side, a.c.id, a.c.at)
            }
          } else pair.pending.set(a.c.key, mine)
        }
      }
    }
    for (const p of due) {
      const f = forced.get(p)
      if (f && !f.ok) {
        // The other side changed again since it was read: its change is still to come through its
        // stream (a conflict then), so this one waits again from now, over what it holds now.
        p.state = 'waiting'
        p.seen = seen
        p.expected = f.holds
        continue
      }
      pair.pending.delete(p.key)
      count(p.post === null ? 'delete' : 'replace')
      if (p.state === 'waiting') notes.push(conflictNote(p.id, side, p.at, 0, 'differed'))
    }
    if (notes.length) tw.conflicts(r, notes)
    // How far this side's stream has read, in its source's cluster time: all of it when idle (the
    // stream's own high-water mark), else through the change before the last one taken (a
    // transaction's later events, at the same time, may still come).
    const lastTime = taken.length ? taken[taken.length - 1]!.clusterTime : undefined
    const reached = caughtUp
      ? tokenTime(stream.resumeToken)
      : lastTime
        ? before(tsText(lastTime as never))
        : null
    if (reached && tsCompare(reached, pair.read[side]) > 0) pair.read[side] = reached
    // The place: before the earliest change of this side still waiting (a restart reads it again).
    const waiting = [...pair.pending.values()].filter((p) => p.side === side)
    const earliest = waiting.reduce<Pending | null>(
      (m, p) => (!m || tsCompare(p.held?.time ?? '0.0', m.held?.time ?? '0.0') < 0 ? p : m),
      null,
    )
    // W4 re-review (minor): the other side lags too far behind: a person decides.
    if (waiting.length > (tw.maxPending ?? TWO_WAY_PENDING_MAX)) {
      this.set('attention', 'two_way_backlog', String(waiting.length), 'error')
      return null
    }
    return {
      counts,
      skipped: actions.filter((a) => a.kind === 'refused').length,
      conflicts: notes.length,
      hold: earliest ? earliest.held : undefined,
    }
  }

  /** W4.6: the lag history — written once per 10 s bucket, and again only when the lag grows in it. */
  private sampleLag(lagMs: number, now: number): void {
    const bucket = Math.floor(now / LAG_BUCKET_MS)
    if (bucket !== this.lagBucket) {
      this.lagBucket = bucket
      this.lagMax = -1
    }
    if (lagMs <= this.lagMax) return
    this.lagMax = lagMs
    this.d.repo.sampleLag(this.d.id, now, lagMs)
  }

  /**
   * Final review I9: every target collection the sync has written is still the one it wrote (its
   * UUID): a dropped or replaced target would be recreated by upserts, holding only later changes.
   * False: the sync failed (target_gone).
   */
  private async targetsHere(r: LiveSyncRecord): Promise<boolean> {
    const now = this.d.now()
    if (r.state === 'copying' || now - this.lastTargetCheck < this.d.timing.targetCheckMs) return true
    this.lastTargetCheck = now
    const names = r.target.coll ? [r.target.coll] : r.options.pairs.map(([, t]) => t)
    if (!names.length) return true
    const target = await this.d.target()
    const infos = await target
      .db(r.target.db)
      .listCollections({ name: { $in: names } }, { nameOnly: false })
      .toArray()
    const seen = { ...(r.stamps.targets ?? {}) }
    let learned = false
    for (const name of names) {
      const key = `${r.target.db}.${name}`
      const info = infos.find((i) => i.name === name) as
        { info?: { uuid?: { toString(enc: string): string } } } | undefined
      const uuid = info?.info?.uuid?.toString('hex') ?? null
      if (seen[key] && seen[key] !== uuid) {
        this.set('failed', 'target_gone', key, 'error')
        return false
      }
      if (uuid && !seen[key]) {
        seen[key] = uuid
        learned = true
      }
    }
    if (learned) this.d.repo.update(r.id, { stamps: { ...r.stamps, targets: seen } })
    return true
  }

  /**
   * W4 review (minor): a two-way direction reads each change's pre-image to write it only where the
   * other side still holds it; without them every change would overwrite the other side unchecked.
   * Its source's setting is read when it starts and as often as the targets are looked at; turned
   * off, it waits for a person (pre_images_off) — and its partner with it.
   */
  private async imagesOn(r: LiveSyncRecord): Promise<boolean> {
    if (!r.options.twoWay || !r.source.coll) return true
    const now = this.d.now()
    if (this.lastImagesCheck !== 0 && now - this.lastImagesCheck < this.d.timing.targetCheckMs) return true
    this.lastImagesCheck = now
    const source = await this.d.source()
    const [info] = await source
      .db(r.source.db)
      .listCollections({ name: r.source.coll }, { nameOnly: false })
      .toArray()
    const on = (info?.options as { changeStreamPreAndPostImages?: { enabled?: unknown } } | undefined)
      ?.changeStreamPreAndPostImages?.enabled
    if (on === true) return true
    this.set('attention', 'pre_images_off', `${r.source.db}.${r.source.coll}`, 'error')
    return false
  }

  /**
   * W4 re-review (minor): a two-way direction holding a place for a waiting change must not let its
   * source's oplog roll past it (a restart could not read it again). Looked at as often as the
   * targets; within a minute of the oldest entry, it stops for a person (two_way_backlog).
   */
  private async historyHeld(r: LiveSyncRecord): Promise<boolean> {
    const tw = this.d.twoWay
    if (!r.options.twoWay || !tw) return true
    const now = this.d.now()
    if (this.lastHistoryCheck !== 0 && now - this.lastHistoryCheck < this.d.timing.targetCheckMs) return true
    this.lastHistoryCheck = now
    const held = [...tw.pair.pending.values()]
      .filter((p) => p.side === tw.side && p.held)
      .map((p) => p.held!.time)
      .sort(tsCompare)[0]
    if (!held) return true
    const start = await (tw.oplogStart ?? (() => this.oplogStart()))().catch(() => null)
    if (start === null) return true
    const [t] = start.split('.').map(Number) as [number]
    if (tsCompare(held, `${t + HISTORY_MARGIN_S}.0`) > 0) return true
    this.set('attention', 'two_way_backlog', 'oplog', 'error')
    return false
  }

  /** The oldest entry of the source's oplog — null while it is not nearly full (nothing rolls off yet). */
  private async oplogStart(): Promise<string | null> {
    const source = await this.d.source()
    const oplog = source.db('local').collection('oplog.rs')
    const [stats] = await oplog.aggregate<Document>([{ $collStats: { storageStats: {} } }]).toArray()
    const storage = (stats?.storageStats ?? {}) as { size?: unknown; maxSize?: unknown }
    const size = Number(storage.size)
    const max = Number(storage.maxSize)
    if (!(size > 0) || !(max > 0) || size < max * 0.9) return null
    const [first] = await oplog.find({}, { sort: { $natural: 1 }, limit: 1, projection: { ts: 1 } }).toArray()
    return first?.ts ? tsText(first.ts as never) : null
  }

  /** Spec §1.4: a sharded target's shard key, read once per target namespace from `config.collections`. */
  private async loadShardKeys(r: LiveSyncRecord, events: Document[]): Promise<void> {
    const wanted = new Set<string>()
    for (const e of events) {
      const ns = e.ns as { db?: unknown; coll?: unknown } | undefined
      if (typeof ns?.db !== 'string' || typeof ns.coll !== 'string') continue
      const t = targetOf(r, ns.db, ns.coll)
      if (t && !this.shardKeys.has(`${t.db}.${t.coll}`)) wanted.add(`${t.db}.${t.coll}`)
    }
    if (!wanted.size) return
    const target = await this.d.target()
    const rows = await target
      .db('config')
      .collection('collections')
      .find({ _id: { $in: [...wanted] } } as Document, { projection: { key: 1 } })
      .toArray()
      .catch(() => [] as Document[])
    for (const ns of wanted) {
      const key = rows.find((row) => row._id === ns)?.key as Document | undefined
      this.shardKeys.set(ns, key ? Object.keys(key) : null)
    }
  }

  /**
   * Spec §1.7: unordered writes per target collection. A refused document pauses the sync with its
   * `_id` and code (plan ruling 11), or is recorded and skipped, up to 1,000 per sync. Returns how
   * many were skipped, or null when the sync stopped.
   */
  private async write(r: LiveSyncRecord, plan: BatchPlan): Promise<number | null> {
    if (plan.writes.length === 0) return 0
    const target = await this.d.target()
    let skipped = 0
    for (const w of plan.writes) {
      const coll = target.db(w.target.db).collection(w.target.coll)
      // Final review m5: acknowledged by a majority before the place moves past it.
      const options = { ordered: false, writeConcern: { w: 'majority' as const } }
      try {
        if (w.pre.length) await coll.bulkWrite(w.pre, options)
        await coll.bulkWrite(w.ops, options)
      } catch (e) {
        if (transient(e)) throw e
        if (!(e instanceof MongoBulkWriteError) || e.writeConcernError) {
          this.set('attention', 'write_error', this.d.errorText('target', e), 'error')
          return null
        }
        const errors = (Array.isArray(e.writeErrors) ? e.writeErrors : [e.writeErrors]).filter(Boolean)
        // A bulk error with no refused document is the connection failing (the driver wraps it):
        // retried from the place, never counted as written (nothing may be lost) — unless MongoDB
        // refused it, under the driver's wrapper: said, not retried, the place kept (second
        // independent review, nit 5); its owner fixes the target or leaves the pair out, as for a
        // refused write concern.
        if (errors.length === 0) {
          if (serverError(e) === e) throw e
          this.set('attention', 'write_error', this.d.errorText('target', e), 'error')
          return null
        }
        const refusedDocs: Document[] = []
        for (const we of errors) {
          const id = w.ids[we.index] ?? ''
          const at = w.ats[we.index] ?? ''
          const detail = `${id.slice(0, ID_TEXT)} · ${this.d.errorText('target', we)}`
          if (r.options.errorPolicy === 'pause' || r.counters.skipped + skipped >= LIVE_SYNC_LIMITS.skipped) {
            const ns = `${w.source.db}.${w.source.coll}`
            this.d.repo.update(r.id, { skip: { id, at, armed: false, ns } })
            this.set('attention', 'write_error', detail, 'error')
            return null
          }
          skipped++
          // Plan ruling 7, final review m2: the _id and the code — never MongoDB's words (they quote values).
          this.d.repo.log(r.id, {
            at: this.d.now(),
            kind: 'skipped',
            detail: `${id.slice(0, ID_TEXT)} · code ${String(we.code)}`,
          })
          // W4.6: the document as the sync wrote it (masked when the sync masks), for the file.
          const op = w.ops[we.index] as { replaceOne?: { replacement?: Document } } | undefined
          if (op?.replaceOne?.replacement) refusedDocs.push(op.replaceOne.replacement)
        }
        if (refusedDocs.length && this.d.reject) {
          const kept = await this.d.reject(r, refusedDocs).catch(() => 0)
          // Once per sync: the space ran out (later documents are still skipped and logged).
          if (kept < refusedDocs.length && !this.noted.has(REJECTED_FULL)) {
            this.noted.add(REJECTED_FULL)
            this.d.repo.log(r.id, { at: this.d.now(), kind: 'error', detail: REJECTED_FULL })
          }
        }
      }
    }
    return skipped
  }

  /** Spec §1.4, plan ruling 13: indexes follow; a followed new collection is created. False: it stopped. */
  private async schema(
    r: LiveSyncRecord,
    step: SchemaStep,
    maskFor: (db: string, coll: string) => Pattern[] | null,
  ): Promise<boolean> {
    const target = await this.d.target()
    const ns = step.target
    try {
      if (step.kind === 'createIndexes') {
        if (step.indexes.length)
          await target
            .db(ns.db)
            .collection(ns.coll)
            .createIndexes(step.indexes as IndexDescription[])
      } else if (step.kind === 'dropIndexes') {
        for (const name of step.names)
          await target
            .db(ns.db)
            .collection(ns.coll)
            .dropIndex(name)
            .catch((e: unknown) => {
              if ((e as { code?: unknown }).code !== 27) throw e
            })
      } else {
        const source = await this.d.source()
        const [info] = await source
          .db(step.source.db)
          .listCollections({ name: step.source.coll }, { nameOnly: false })
          .toArray()
        // Gone again (its drop follows), or a view (views follow only with the initial copy).
        if (!info || info.type === 'view') return true
        const create = info.options?.timeseries
          ? { skip: 'A time series collection has no change stream' }
          : info.options?.capped
            ? {
                skip: 'A capped collection drops its oldest documents when full: its copy would not stay whole',
              }
            : createOptions(
                { name: info.name, type: info.type ?? 'collection', options: info.options ?? {} },
                { options: true, validator: true },
                this.d.allowServerJs,
              )
        if ('skip' in create) {
          this.ignore(step.source.coll)
          this.d.repo.log(r.id, {
            at: this.d.now(),
            kind: 'schema',
            detail: `${step.source.db}.${step.source.coll}: ${create.skip}`,
          })
          return true
        }
        // Security audit 2026-10-16 (Important 3): a masked sync leaves out a validator that names a
        // value masking would change, as its initial copy does, and says so.
        const mask = maskFor(step.source.db, step.source.coll)
        const kept = mask
          ? withoutMaskedValidator(create.options, step.source.db, step.source.coll, maskerOfPatterns(mask))
          : { options: create.options, left: false }
        let there = false
        await target
          .db(ns.db)
          .createCollection(ns.coll, kept.options)
          .catch((e: unknown) => {
            if ((e as { code?: unknown }).code !== 48) throw e
            there = true
          })
        // Final review of explain masking (Minor 1): one already there that takes none of the sync's
        // writes (a view; a time series, whose single documents MongoDB never changes; a capped one,
        // which drops its oldest documents when full) is left out and said, as a new time series source is.
        if (there) {
          const [found] = await target
            .db(ns.db)
            .listCollections({ name: ns.coll }, { nameOnly: false })
            .toArray()
          const why =
            found?.type === 'view'
              ? 'The target is a view'
              : found?.type === 'timeseries'
                ? 'The target is a time series: a sync changes no single document of one'
                : (found?.options as { capped?: unknown } | undefined)?.capped
                  ? 'The target is capped: it drops its oldest documents when full'
                  : null
          if (why) {
            this.ignore(step.source.coll)
            this.d.repo.log(r.id, {
              at: this.d.now(),
              kind: 'schema',
              detail: `${step.source.db}.${step.source.coll}: ${why}`,
            })
            return true
          }
        }
        if (kept.left)
          this.d.repo.log(r.id, {
            at: this.d.now(),
            kind: 'schema',
            detail: `${step.source.db}.${step.source.coll}: ${VALIDATOR_LEFT_OUT}`,
          })
        const fresh = this.record()!
        if (!fresh.options.pairs.some(([s]) => s === step.source.coll))
          this.d.repo.update(r.id, {
            options: { ...fresh.options, pairs: [...fresh.options.pairs, [step.source.coll, ns.coll]] },
          })
        this.d.repo.log(r.id, {
          at: this.d.now(),
          kind: 'schema',
          detail: `${step.source.db}.${step.source.coll}`,
        })
      }
      return true
    } catch (e) {
      if (transient(e)) throw e
      this.set(
        'attention',
        'schema_changed',
        `${ns.db}.${ns.coll}: ${this.d.errorText('target', e)}`,
        'schema',
      )
      return false
    }
  }

  /** Spec §1.6 steps 3–4: verify when asked, then completed. */
  private async finish(): Promise<boolean> {
    const r = this.record()!
    if (r.finish?.verify && this.d.verify) await this.d.verify(r, this.abort.signal).catch(() => {})
    if (this.stopped) return true
    this.retryAt = null
    this.set('completed')
    return true
  }

  /** Spec §1.7: a lost history fails it; a side out of reach is retried (1 s … 5 min); a fault of ours fails it. */
  private async onError(r: LiveSyncRecord, e: unknown): Promise<boolean> {
    await this.closeStream()
    const reason = e instanceof ConnectionError ? 'connection' : reasonOf(e)
    if (reason === 'history_lost') {
      this.set('failed', 'history_lost', null, 'error')
      return false
    }
    // Final review I8: errors waiting cannot fix wait for a person, named.
    const code = Number((e as { code?: unknown }).code)
    const final =
      reason === 'event_too_large' || reason === 'unauthorized' || reason === 'not_replica_set'
        ? reason
        : code === 166
          ? 'view'
          : null
    if (final && e instanceof MongoError) {
      this.set('attention', 'stream_error', final, 'error')
      return false
    }
    // The connection manager's own errors (a server it cannot open) are retried like the driver's;
    // a fault of ours is retried twice (it may pass, final review m8), then fails the sync.
    if (!(e instanceof MongoError) && !(e instanceof ConnectionError) && ++this.faults >= 3) {
      this.set('failed', 'internal', null, 'error')
      return false
    }
    this.delay = Math.min(this.d.timing.retryMaxMs, this.delay ? this.delay * 2 : this.d.timing.retryMinMs)
    this.retryAt = this.d.now() + this.delay
    const state = this.record()?.state
    if (state !== 'retrying' && state !== 'cutting_over') this.set('retrying', null, reason, 'error')
    else this.d.onChange(this.record()!, null)
    await this.sleep(this.delay)
    return !this.stopped
  }
}
