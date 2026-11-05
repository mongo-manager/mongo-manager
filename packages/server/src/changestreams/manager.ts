// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createHash } from 'node:crypto'
import type { Document, MongoClient } from 'mongodb'
import {
  WATCH_ALERT_EVERY_MS,
  permissionsFor,
  type WatchEvent,
  type WatchOptions,
  type WatchReason,
  type WatchTarget,
} from '@mongo-manager/shared'
import type { Principal, ServerContext } from '../http/context'
import { AppError } from '../errors'
import { effectiveRole, isDrillScratch, isRestrictedNamespace, mayExport } from '../connections/access'
import type { AppEvents } from '../events/app-events'
import { LabelledRecording } from './recording'
import { READ_OPTIONS } from '../data/ejson-io'
import { maskerForPrincipal } from '../masking/request'
import { MASKING_UNSUPPORTED, PERSONAL_FIELD } from '../masking/gate/refusal'
import {
  FEED_TIMING,
  Feed,
  reasonOf,
  type FeedAccess,
  type FeedTiming,
  type SentMark,
  type StreamLike,
  type WatchMessage,
} from './feed'
import { buildPipeline, checkRestrictedFilter, filterHash } from './pipeline'
import { WatchRefusal, checkTarget, type TargetFacts } from './target'
import { bucketRuled, isFileContents } from '../masking/gridfs'

export interface WatchRequest {
  id: string
  target: WatchTarget
  filter: Record<string, unknown>
  options: WatchOptions
  /** Final review I5: the last event the browser received (a reconnect resumes right after it). */
  after?: number
  /** Final review M10: start paused (the feed was paused before its socket went). */
  paused?: boolean
}

/** The socket side of a feed (the hub's peer): one object per socket, compared by identity. */
export interface Subscriber {
  /** The socket's address, for the audit (final review M7). */
  ip: string | null
  /** The viewer as they are now; null once signed out, disabled or gone. */
  principal(): Principal | null
  send(message: WatchMessage): void
  writable(): boolean
  /** The feed ended for good, or another socket took it over: this socket forgets it. */
  ended(id: string): void
}

/**
 * Spec §2.2 (the server-wide bound is `config.watch.maxFeeds`; the per-socket one is the hub's).
 * Final review M8: starts (resumes from now included) are rate limited per user.
 */
export const WATCH_LIMITS = { perUser: 5, graceMs: 120_000, startsPerMinute: 60 }

export interface WatchDeps {
  ctx: () => ServerContext
  /** Tests open fake streams; the server opens MongoDB's. */
  openStream?: (
    client: MongoClient,
    target: WatchTarget,
    pipeline: Document[],
    options: Document,
  ) => StreamLike
  /** Tests skip the topology and view check. */
  inspect?: (client: MongoClient, target: WatchTarget) => Promise<TargetFacts>
  /** Tests hand in a client without a server. */
  client?: (connectionId: string) => Promise<MongoClient>
  timing?: Partial<FeedTiming>
  limits?: Partial<typeof WATCH_LIMITS>
}

/** A start in flight: it counts against the limits, and a stop, a takeover or the connection can cancel it. */
interface Starting {
  subscriber: Subscriber
  owner: string
  connectionId: string
  /** Why it was cancelled: `quiet` (its socket asked or left), or a reason its socket is told. */
  cancelled: WatchReason | 'quiet' | null
}

interface Live {
  feed: Feed
  owner: string
  params: string
  target: WatchTarget
  release: () => void
  subscriber: Subscriber
  principal: Principal
  /** W4.7: the feed's recording, finished when the feed ends or leaves its socket. */
  recorder: LabelledRecording | null
}

interface Parked {
  token: unknown
  /** Final review I5: the batches sent, so a reconnect resumes after the last one received. */
  log: SentMark[]
  params: string
  timer: NodeJS.Timeout
  connectionId: string
}

function openMongoStream(
  client: MongoClient,
  target: WatchTarget,
  pipeline: Document[],
  options: Document,
): StreamLike {
  const source =
    target.scope === 'deployment'
      ? client
      : target.scope === 'database'
        ? client.db(target.db!)
        : client.db(target.db!).collection(target.coll!)
  return source.watch(pipeline, options) as unknown as StreamLike
}

const paramsOf = (r: WatchRequest) =>
  createHash('sha256')
    .update(JSON.stringify([r.target, r.filter, r.options]))
    .digest('hex')

/**
 * W4.7: the alert hook of a feed asked to alert — `watch.matched` once at most every 10 s with how
 * many events passed its filter since (the operation of the last; never a value), and once more
 * with what is left when the feed ends.
 */
export function matchedAlert(input: {
  feedId: string
  owner: string
  connectionId: string
  namespace: string | null
  /** W4 review I4: the server's app events, and its clock. */
  events: AppEvents
  now: () => number
}): ((events: WatchEvent[]) => void) & { flush(): void } {
  let last = 0
  let count = 0
  let op = ''
  const raise = () => {
    if (count === 0) return
    input.events.emit('watch.matched', {
      severity: 'info',
      summary: `Watch on ${input.namespace ?? 'the deployment'}: ${count} change(s) matched its filter.`,
      connectionId: input.connectionId,
      namespace: input.namespace,
      ownerId: input.owner,
      details: { watch: input.feedId, operation: op, count },
    })
    count = 0
    last = input.now()
  }
  return Object.assign(
    (events: WatchEvent[]) => {
      count += events.length
      op = events.at(-1)?.op ?? op
      if (input.now() - last >= WATCH_ALERT_EVERY_MS) raise()
    },
    { flush: raise },
  )
}

/** A masking refusal of a filter as the code the web words (plan ruling 15). */
function maskingDetail(e: AppError, target: WatchTarget): string {
  const d = e.details as { reason?: string; field?: string } | undefined
  if (d?.reason === PERSONAL_FIELD && d.field) return d.field
  return target.scope === 'collection' ? 'shape' : 'scope'
}

/**
 * Phase 3e-1 spec §1.2, §2: every feed of the server, by owner and id (plan ruling 10), each held by
 * one socket (W7: only that socket may pause, resume, stop or detach it). A start is reserved before
 * its first wait, so the limits count it and a stop, a takeover or the connection's end can cancel
 * it (final review I1–I3). A detached feed's place is parked for the reconnect grace and never leaves
 * the server (W6).
 */
export class WatchManager {
  private readonly live = new Map<string, Live>()
  private readonly starting = new Map<string, Starting>()
  private readonly parkedFeeds = new Map<string, Parked>()
  private readonly starts = new Map<string, number[]>()
  private readonly timing: FeedTiming
  private readonly limits: typeof WATCH_LIMITS
  private auditKey: Buffer | null = null

  constructor(private readonly deps: WatchDeps) {
    this.timing = { ...FEED_TIMING, ...deps.timing }
    this.limits = { ...WATCH_LIMITS, ...deps.limits }
  }

  private get ctx(): ServerContext {
    return this.deps.ctx()
  }

  /** Feeds running or starting, of one owner or of the server. */
  count(owner?: string): number {
    const all = [...this.live.values(), ...this.starting.values()]
    return owner === undefined ? all.length : all.filter((f) => f.owner === owner).length
  }

  parked(owner?: string): number {
    return owner === undefined
      ? this.parkedFeeds.size
      : [...this.parkedFeeds.keys()].filter((k) => k.startsWith(`${owner}:`)).length
  }

  /** W1, W2: the viewer's access to the connection now. */
  private access(subscriber: Subscriber, connectionId: string): FeedAccess {
    const ctx = this.ctx
    if (!ctx.config.watch.enabled) return { ok: false, reason: 'turned_off' }
    const principal = subscriber.principal()
    if (!principal || !ctx.connections.get(connectionId)) return { ok: false, reason: 'access' }
    const role = effectiveRole(ctx, principal, connectionId)
    if (!role || !permissionsFor(role).has('documents:read')) return { ok: false, reason: 'access' }
    return { ok: true, admin: role === 'admin', masker: maskerForPrincipal(ctx, principal, connectionId) }
  }

  /** Final review M8: true once the owner started `startsPerMinute` feeds in the last minute. */
  private overRate(owner: string): boolean {
    const now = Date.now()
    const recent = (this.starts.get(owner) ?? []).filter((t) => t > now - 60_000)
    if (recent.length >= this.limits.startsPerMinute) {
      this.starts.set(owner, recent)
      return true
    }
    recent.push(now)
    if (!this.starts.has(owner) && this.starts.size >= 10_000) this.starts.clear()
    this.starts.set(owner, recent)
    return false
  }

  async start(owner: string, req: WatchRequest, subscriber: Subscriber): Promise<void> {
    const ctx = this.ctx
    const key = `${owner}:${req.id}`
    const { target } = req
    const access = this.access(subscriber, target.connectionId)
    if (!access.ok) throw new WatchRefusal(access.reason)
    // W1: credential collections are their administrators' only; the answer is the same as "no access".
    if (
      !access.admin &&
      target.scope === 'collection' &&
      isRestrictedNamespace(target.db!, target.coll, false)
    )
      throw new WatchRefusal('access')
    // W4 review C1: a restore drill's scratch database, for no one.
    if (isDrillScratch(target.db)) throw new WatchRefusal('access')
    // Security review 2026-10-13 round 2 (I1): GridFS file contents, whose download is denied there.
    // User report 2026-10-27: where a rule reaches the bucket.
    if (
      target.scope === 'collection' &&
      isFileContents(target.coll ?? '') &&
      bucketRuled(access.masker, target.db!, target.coll!)
    )
      throw new WatchRefusal('access')
    const principal = subscriber.principal()!
    // W4.7: recording is exporting: it needs the export right on the connection.
    if (req.options.record && !mayExport(ctx, principal, target.connectionId))
      throw new WatchRefusal('record_denied')
    // This id is starting or running already: the same socket again, or a reconnect racing its old
    // socket's close (I3). The new subscription takes it over; the old socket forgets the id now.
    const before = this.starting.get(key)
    if (before) {
      before.cancelled = 'quiet'
      this.starting.delete(key)
      if (before.subscriber !== subscriber) before.subscriber.ended(req.id)
    }
    const old = this.live.get(key)
    let retiring: Promise<void> = Promise.resolve()
    if (old) {
      this.live.delete(key)
      if (old.subscriber !== subscriber) old.subscriber.ended(req.id)
      retiring = this.retire(key, old, 'replaced')
    }
    const refuse = async (reason: WatchReason, detail?: string): Promise<never> => {
      await retiring
      throw new WatchRefusal(reason, detail)
    }
    if (this.overRate(owner)) return refuse('limit', 'rate')
    if (this.count(owner) >= this.limits.perUser) return refuse('limit', 'user')
    if (this.count() >= ctx.config.watch.maxFeeds) return refuse('limit', 'server')
    // I1: reserved before the first wait, so concurrent starts see it.
    const reserved: Starting = { subscriber, owner, connectionId: target.connectionId, cancelled: null }
    this.starting.set(key, reserved)
    const settle = () => {
      if (this.starting.get(key) === reserved) this.starting.delete(key)
    }
    let pipeline: Document[]
    try {
      pipeline = buildPipeline({
        target,
        filter: req.filter,
        options: req.options,
        admin: access.admin,
        masker: access.masker,
      })
    } catch (e) {
      settle()
      if (!(e instanceof AppError)) throw e
      const d = e.details as { reason?: string; problem?: string } | undefined
      if (d?.reason === 'filter') return refuse('filter', d.problem)
      if (d?.reason !== PERSONAL_FIELD && d?.reason !== MASKING_UNSUPPORTED)
        // Final review M2: not valid Extended JSON (the filter's own problem, never a masking one).
        return refuse('filter', 'ejson')
      ctx.maskingAudit.refusedBy({ principal, ip: subscriber.ip, connectionId: target.connectionId }, e)
      return refuse('masking_filter', maskingDetail(e, target))
    }
    const release = ctx.manager.hold(target.connectionId)
    // I2: a start cancelled while it waited stops here, telling its socket only when it must.
    const cancelled = async (): Promise<boolean> => {
      if (reserved.cancelled === null) return false
      release()
      settle()
      await retiring
      if (reserved.cancelled !== 'quiet') throw new WatchRefusal(reserved.cancelled)
      return true
    }
    let client: MongoClient
    let facts: TargetFacts
    try {
      client = await (this.deps.client ?? ((id) => ctx.manager.getClient(id)))(target.connectionId)
      if (await cancelled()) return
      facts = await (this.deps.inspect ?? checkTarget)(client, target)
    } catch (e) {
      release()
      settle()
      await retiring
      throw e instanceof WatchRefusal ? e : new WatchRefusal('connection')
    }
    await retiring
    if (await cancelled()) return
    // I5: a parked feed of this owner, id and parameters resumes right after the last event received.
    const params = paramsOf(req)
    const parked = this.parkedFeeds.get(key)
    this.unpark(key)
    let resumeAfter: unknown = null
    let startSeq = 0
    let gap = false
    if (parked && parked.params === params) {
      const last = parked.log.at(-1) ?? { seq: 0, token: parked.token }
      const at = req.after === undefined ? last : parked.log.find((m) => m.seq === req.after)
      const from = at ?? last
      gap = at === undefined
      resumeAfter = from.token
      startSeq = from.seq
    }
    if (resumeAfter === null || resumeAfter === undefined) {
      resumeAfter = null
      startSeq = 0
      gap = false
    }
    const options: Document = {
      ...READ_OPTIONS,
      maxAwaitTimeMS: 1000,
      ...(req.options.fullDocument ? { fullDocument: 'updateLookup' } : {}),
      ...(target.scope === 'collection' && req.options.before
        ? { fullDocumentBeforeChange: 'whenAvailable' }
        : {}),
      ...(req.options.schemaChanges ? { showExpandedEvents: true } : {}),
    }
    // W4.7: a recording of what this viewer is sent, and the alert hook.
    const ns = target.scope === 'deployment' ? null : target.coll ? `${target.db}.${target.coll}` : target.db!
    // W4 review I8: labelled as each batch is sent — a change of the viewer's masking (restricted
    // now, or no longer; new rules) ends the file and begins another under the new label.
    const recorder = req.options.record
      ? new LabelledRecording(ctx.transfer.files, {
          owner,
          connectionId: target.connectionId,
          feedId: req.id,
          namespace: ns,
          label: () => {
            const now = this.access(subscriber, target.connectionId)
            const masker = now.ok ? now.masker : access.masker
            return {
              masked: masker !== null,
              rulesVersion: masker ? ctx.personalFields.get(target.connectionId).version : null,
            }
          },
          now: () => Date.now(),
          onFull: () =>
            subscriber.send({ ch: 'watch', type: 'recording', payload: { id: req.id, state: 'full' } }),
        })
      : null
    const alert = req.options.alert
      ? matchedAlert({
          feedId: req.id,
          owner,
          connectionId: target.connectionId,
          namespace: ns,
          events: ctx.events,
          now: ctx.now,
        })
      : null
    const open = this.deps.openStream ?? openMongoStream
    const feed = new Feed({
      id: req.id,
      open: async (after) =>
        open(client, target, pipeline, after === null ? options : { ...options, resumeAfter: after }),
      access: this.feedAccess(subscriber, req),
      send: (m) => subscriber.send(m),
      writable: () => subscriber.writable(),
      // Pacing and lag run on the wall clock: MongoDB's wallTime is real time, and the app clock may be a test's fixed one.
      now: () => Date.now(),
      timing: this.timing,
      startSeq,
      paused: req.paused === true,
      onEvents: (events) => {
        recorder?.append(events)
        alert?.(events)
      },
      onEnd: (reason, events) => {
        void recorder?.finish()
        alert?.flush()
        // The hold is released however the feed ends (idempotent), even after a takeover.
        release()
        if (this.live.get(key)?.feed !== feed) return
        this.live.delete(key)
        subscriber.ended(req.id)
        this.audit('watch.stop', principal, subscriber.ip, target, { feed: req.id, reason, events })
      },
    })
    // Registered before it runs: a feed that ends at once (access gone) still finds itself in onEnd,
    // and a stop during its first read reaches it.
    this.live.set(key, { feed, owner, params, target, release, subscriber, principal, recorder })
    settle()
    try {
      await feed.start(resumeAfter)
    } catch (e) {
      if (this.live.get(key)?.feed === feed) this.live.delete(key)
      release()
      // The first read failed: MongoDB's reason in the feed's words (unauthorized, not a replica set …).
      throw e instanceof WatchRefusal ? e : new WatchRefusal(reasonOf(e))
    }
    // Stopped while it opened (its socket unsubscribed): nothing to announce.
    if (this.live.get(key)?.feed !== feed) return
    const resumed = resumeAfter !== null
    this.audit('watch.start', principal, subscriber.ip, target, {
      feed: req.id,
      scope: target.scope,
      ops: req.options.ops,
      filter: filterHash(req.filter, this.filterKey()),
      resumed,
      ...(gap ? { gap } : {}),
    })
    subscriber.send({
      ch: 'watch',
      type: 'started',
      payload: {
        id: req.id,
        preImages: facts.preImages,
        resumed,
        gap,
        paused: req.paused === true,
        exists: facts.exists ?? null,
        ...(recorder ? { recording: true } : {}),
      },
    })
  }

  /**
   * W2, final review I7: the viewer's access before each pull and batch, and the feed's filter
   * checked again whenever the viewer's masking changes (a viewer made restricted, new rules): a
   * filter reading a field now hidden ends the feed, audited once.
   */
  private feedAccess(subscriber: Subscriber, req: WatchRequest): () => FeedAccess {
    const { target, filter } = req
    let checked = this.access(subscriber, target.connectionId)
    let refused: FeedAccess | null = null
    return () => {
      if (refused) return refused
      const now = this.access(subscriber, target.connectionId)
      if (!now.ok || Object.keys(filter).length === 0) return now
      if (checked.ok && now.masker === checked.masker) return now
      if (now.masker) {
        try {
          checkRestrictedFilter(filter, target, now.masker)
        } catch (e) {
          if (!(e instanceof AppError)) throw e
          this.ctx.maskingAudit.refusedBy(
            { principal: subscriber.principal(), ip: subscriber.ip, connectionId: target.connectionId },
            e,
          )
          refused = { ok: false, reason: 'masking_filter', detail: maskingDetail(e, target) }
          return refused
        }
      }
      checked = now
      return now
    }
  }

  private filterKey(): Buffer {
    this.auditKey ??= this.ctx.secretBox.derive('watch-filter-audit')
    return this.auditKey
  }

  /** The feed of this owner and id, if this socket holds it (W7). */
  private held(owner: string, id: string, subscriber: Subscriber): Live | undefined {
    const live = this.live.get(`${owner}:${id}`)
    return live?.subscriber === subscriber ? live : undefined
  }

  /** A start of this socket still in flight is cancelled quietly (I2). */
  private cancelStart(owner: string, id: string, subscriber: Subscriber): void {
    const key = `${owner}:${id}`
    const pending = this.starting.get(key)
    if (!pending || pending.subscriber !== subscriber) return
    pending.cancelled = 'quiet'
    this.starting.delete(key)
  }

  async stop(owner: string, id: string, subscriber: Subscriber): Promise<void> {
    this.cancelStart(owner, id, subscriber)
    await this.held(owner, id, subscriber)?.feed.end('closed', true)
  }

  pause(owner: string, id: string, subscriber: Subscriber): void {
    this.held(owner, id, subscriber)?.feed.pause()
  }

  async resume(owner: string, id: string, from: 'here' | 'now', subscriber: Subscriber): Promise<void> {
    const live = this.held(owner, id, subscriber)
    if (!live) return
    // M8: a resume from now opens a stream like a start; over the rate it resumes where it was.
    await live.feed.resume(from === 'now' && this.overRate(owner) ? 'here' : from)
  }

  /** The socket closed: the cursor closes, the place waits `graceMs` for the same owner, id and parameters. */
  async detach(owner: string, id: string, subscriber: Subscriber): Promise<void> {
    this.cancelStart(owner, id, subscriber)
    const key = `${owner}:${id}`
    const live = this.held(owner, id, subscriber)
    if (!live) return
    this.live.delete(key)
    // M7: a socket closed because its viewer lost the session or account is audited as such.
    await this.retire(key, live, subscriber.principal() ? 'disconnected' : 'access')
  }

  /** A feed leaves its socket: its cursor closes, its hold goes, its place is parked (W8: audited). */
  private async retire(key: string, live: Live, reason: string): Promise<void> {
    const { token, log } = await live.feed.detach()
    // W4.7: a recording ends with its socket (a reconnect that records starts a new one).
    void live.recorder?.finish()
    live.release()
    this.audit('watch.stop', live.principal, live.subscriber.ip, live.target, {
      feed: key.slice(key.indexOf(':') + 1),
      reason,
      events: live.feed.count,
    })
    this.unpark(key)
    // W5: the grace keeps at most the user's feed limit of places; the oldest goes first.
    const mine = [...this.parkedFeeds.keys()].filter((k) => k.startsWith(`${live.owner}:`))
    if (mine.length >= this.limits.perUser) this.unpark(mine[0]!)
    const timer = setTimeout(() => this.parkedFeeds.delete(key), this.limits.graceMs)
    timer.unref()
    this.parkedFeeds.set(key, {
      token,
      log,
      params: live.params,
      timer,
      connectionId: live.target.connectionId,
    })
  }

  private unpark(key: string): void {
    const parked = this.parkedFeeds.get(key)
    if (!parked) return
    clearTimeout(parked.timer)
    this.parkedFeeds.delete(key)
  }

  /** Events pulled but not yet sent (flow control: never above the outbox bound). */
  pending(owner: string, id: string): number {
    return this.live.get(`${owner}:${id}`)?.feed.pending ?? 0
  }

  async closeAll(): Promise<void> {
    for (const pending of this.starting.values()) pending.cancelled = 'quiet'
    this.starting.clear()
    for (const parked of this.parkedFeeds.values()) clearTimeout(parked.timer)
    this.parkedFeeds.clear()
    await Promise.all([...this.live.values()].map((l) => l.feed.end('closed', true)))
  }

  /**
   * Spec Review Focus 3: the connection was edited (`connection`: another server may sit behind it
   * now) or deleted (`access`). Its feeds end in those words, starts in flight are refused in them,
   * and their parked places go.
   */
  async closeFor(connectionId: string, reason: 'connection' | 'access'): Promise<void> {
    for (const [key, pending] of this.starting)
      if (pending.connectionId === connectionId) {
        pending.cancelled = reason
        this.starting.delete(key)
      }
    for (const [key, parked] of this.parkedFeeds) if (parked.connectionId === connectionId) this.unpark(key)
    await Promise.all(
      [...this.live.values()]
        .filter((l) => l.target.connectionId === connectionId)
        .map((l) => l.feed.end(reason)),
    )
  }

  private audit(
    action: 'watch.start' | 'watch.stop',
    principal: Principal,
    ip: string | null,
    target: WatchTarget,
    details: Record<string, unknown>,
  ): void {
    this.ctx.audit.append({
      action,
      outcome: 'success',
      userId: principal.kind === 'user' ? principal.userId : null,
      username: principal.username,
      ip,
      connectionId: target.connectionId,
      namespace:
        target.db === undefined
          ? null
          : target.coll === undefined
            ? target.db
            : `${target.db}.${target.coll}`,
      details,
    })
  }
}
