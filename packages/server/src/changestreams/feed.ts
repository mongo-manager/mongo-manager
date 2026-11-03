import { BSON, type Document } from 'mongodb'
import type { WatchEvent, WatchReason } from '@mongo-manager/shared'
import type { Masker } from '../masking/match'
import type { ServerMessage } from '../realtime/protocol'
import { ELIDE_BYTES, toWatchEvent } from './event'

/** The part of MongoDB's ChangeStream a feed uses (tests drive a fake one). */
export interface StreamLike {
  tryNext(): Promise<Document | null>
  readonly resumeToken: unknown
  close(): Promise<void>
}

export type FeedAccess =
  | { ok: true; masker: Masker | null; admin: boolean }
  | { ok: false; reason: 'access' | 'turned_off' }
  /** Final review I7: the feed's filter reads a field now hidden from its viewer. */
  | { ok: false; reason: 'masking_filter'; detail?: string }

/** Final review I5: where a resume picks up after the event numbered `seq` (a batch's last). */
export interface SentMark {
  seq: number
  token: unknown
}
/** How many sent batches a feed remembers for a reconnect to resume after. */
export const SENT_LOG = 1000

export type WatchMessage = Extract<ServerMessage, { ch: 'watch' }>

export interface FeedTiming {
  /** A batch goes out this long after the previous one at the latest … */
  flushMs: number
  /** … or as soon as it holds this many events. */
  maxBatch: number
  maxPerSecond: number
  /** Events pulled but not yet sent; the feed stops pulling at this many. */
  outbox: number
  /** How long a feed that may not pull waits before it looks again. */
  waitMs: number
  elideBytes: number
  /** Final review I6: the outbox stops pulling at this many bytes … */
  outboxBytes: number
  /** … and a batch carries at most this many (one larger event still goes alone). */
  batchBytes: number
}

/** Spec §1.3. */
export const FEED_TIMING: FeedTiming = {
  flushMs: 150,
  maxBatch: 100,
  maxPerSecond: 200,
  outbox: 200,
  waitMs: 100,
  elideBytes: ELIDE_BYTES,
  outboxBytes: 8 * 1024 * 1024,
  batchBytes: 2 * 1024 * 1024,
}
/** Spec §1.3: a socket with this much unsent is full; its feeds stop pulling. */
export const WRITABLE_BYTES = 1024 * 1024

export interface FeedDeps {
  id: string
  /** The stream, after `resumeAfter` (a resume token) or from now. */
  open(resumeAfter: unknown | null): Promise<StreamLike>
  /** The viewer's access as it is now (W2); read before anything of an event leaves. */
  access(): FeedAccess
  send(message: WatchMessage): void
  writable(): boolean
  now(): number
  timing: FeedTiming
  /** Once, when the feed ends for good (not when it detaches). */
  onEnd(reason: WatchReason, events: number): void
  /** Final review I5: events are numbered from `startSeq + 1` (a resume continues the numbering). */
  startSeq?: number
  /** W4.7: every batch sent, as its viewer got it (a recording, the alert hook). */
  onEvents?(events: WatchEvent[]): void
  /** Final review M10: the feed starts paused (it was paused before its socket went). */
  paused?: boolean
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Spec §2.3: a MongoDB failure as the reason the web shows (never MongoDB's own words). */
export function reasonOf(e: unknown): WatchReason {
  const err = (e ?? {}) as { code?: unknown; codeName?: unknown; name?: unknown }
  const code = Number(err.code)
  if (code === 286 || code === 280 || err.codeName === 'ChangeStreamHistoryLost') return 'history_lost'
  if (code === 10334 || err.codeName === 'BSONObjectTooLarge') return 'event_too_large'
  if (code === 13 || err.codeName === 'Unauthorized') return 'unauthorized'
  if (code === 40573) return 'not_replica_set'
  if (/^Mongo(Network|ServerSelection|TopologyClosed|NotConnected|ClientClosed)/.test(String(err.name ?? '')))
    return 'connection'
  return 'internal'
}

interface Pending {
  raw: Document
  /** The stream's token after this event: where a resume picks up once it was sent. */
  token: unknown
  /** The raw event's BSON size (final review I6: the outbox is bounded in bytes too). */
  size: number
}

/**
 * Phase 3e-1 spec §1.2–§1.3: one change stream for one subscriber. It pulls only while the
 * subscriber can take more (outbox, socket, rate), re-reads access before every event leaves, and
 * remembers the token of the last event sent — never of one only pulled — so a reconnect loses and
 * repeats nothing.
 */
export class Feed {
  private stream: StreamLike | null = null
  private outbox: Pending[] = []
  private outboxBytes = 0
  private token: unknown = null
  private seq: number
  private sent = 0
  private paused: boolean
  private stopped = false
  private lastFlush = 0
  private window = { start: 0, count: 0 }
  private log: SentMark[] = []
  private ticker: NodeJS.Timeout | undefined
  private resuming: Promise<void> | null = null

  constructor(private readonly deps: FeedDeps) {
    this.seq = deps.startSeq ?? 0
    this.paused = deps.paused ?? false
  }

  get resumeToken(): unknown {
    return this.token
  }

  get count(): number {
    return this.sent
  }

  get pending(): number {
    return this.outbox.length
  }

  async start(resumeAfter: unknown | null = null): Promise<void> {
    const stream = await this.deps.open(resumeAfter)
    // Ended while opening (unsubscribed, the connection went): the new cursor is closed, not kept.
    if (this.stopped) {
      await stream.close().catch(() => undefined)
      return
    }
    this.stream = stream
    this.token = resumeAfter
    try {
      await this.prime(stream)
    } catch (e) {
      // Final review M12: a first read that fails leaves no cursor behind.
      this.stream = null
      await stream.close().catch(() => undefined)
      throw e
    }
    this.mark()
    this.lastFlush = this.deps.now()
    // Final review M1: a batch leaves on time even while a pull waits on MongoDB.
    this.ticker = setInterval(() => this.flush(), this.deps.timing.flushMs)
    this.ticker.unref()
    void this.run()
  }

  /**
   * MongoDB opens a change stream's cursor on its first read, and the stream starts there: read once
   * before saying "started" (or "resumed"), so every change after that word is in the feed.
   */
  private async prime(stream: StreamLike): Promise<void> {
    const raw = await stream.tryNext()
    if (raw) this.take(raw, stream.resumeToken)
    else if (stream.resumeToken !== undefined && stream.resumeToken !== null && this.token === null)
      this.token = stream.resumeToken
  }

  /** Final review I5: the batches sent, by their last number, with where a resume picks up after them. */
  private mark(): void {
    const last = this.log.at(-1)
    if (last && last.seq === this.seq) last.token = this.token
    else this.log.push({ seq: this.seq, token: this.token })
    if (this.log.length > SENT_LOG) this.log.shift()
  }

  pause(): void {
    if (this.stopped) return
    this.paused = true
    this.flush(true)
    // Final review M11: the forced flush may have ended the feed (access gone): no "paused" after "ended".
    if (this.stopped) return
    this.deps.send({ ch: 'watch', type: 'paused', payload: { id: this.deps.id } })
  }

  /** Final review I4: one resume at a time; a feed that ends meanwhile keeps no new cursor. */
  async resume(from: 'here' | 'now'): Promise<void> {
    while (this.resuming) await this.resuming
    if (this.stopped) return
    this.resuming = this.doResume(from).finally(() => {
      this.resuming = null
    })
    await this.resuming
  }

  private async doResume(from: 'here' | 'now'): Promise<void> {
    if (from === 'now' && this.paused) {
      const old = this.stream
      this.stream = null
      this.drop()
      await old?.close().catch(() => undefined)
      if (this.stopped) return
      this.token = null
      let next: StreamLike
      try {
        next = await this.deps.open(null)
      } catch (e) {
        return this.end(reasonOf(e))
      }
      if (this.stopped) {
        await next.close().catch(() => undefined)
        return
      }
      try {
        await this.prime(next)
      } catch (e) {
        await next.close().catch(() => undefined)
        return this.end(reasonOf(e))
      }
      if (this.stopped) {
        await next.close().catch(() => undefined)
        return
      }
      this.stream = next
      this.mark()
    }
    this.paused = false
    this.deps.send({ ch: 'watch', type: 'resumed', payload: { id: this.deps.id, from } })
  }

  /** Ends for good. `quiet`: the subscriber asked (unsub, shutdown) and needs no word. */
  async end(reason: WatchReason, quiet = false, detail?: string): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    clearInterval(this.ticker)
    // W2: what was pulled under access that is now gone never leaves.
    this.drop()
    const stream = this.stream
    this.stream = null
    await stream?.close().catch(() => undefined)
    if (!quiet)
      this.deps.send({
        ch: 'watch',
        type: 'ended',
        payload: { id: this.deps.id, reason, ...(detail !== undefined ? { detail } : {}) },
      })
    this.deps.onEnd(reason, this.sent)
  }

  /**
   * The socket went away: stop pulling, close the cursor, hand back where a resume picks up — the
   * batches sent (I5) and the numbering.
   */
  async detach(): Promise<{ token: unknown; log: SentMark[]; seq: number }> {
    this.stopped = true
    clearInterval(this.ticker)
    this.drop()
    const stream = this.stream
    this.stream = null
    await stream?.close().catch(() => undefined)
    return { token: this.token, log: this.log, seq: this.seq }
  }

  private overRate(): boolean {
    const now = this.deps.now()
    if (now - this.window.start >= 1000) this.window = { start: now, count: 0 }
    return this.window.count >= this.deps.timing.maxPerSecond
  }

  private async run(): Promise<void> {
    const t = this.deps.timing
    while (!this.stopped) {
      // W2: access is read at least once per pull; `maxAwaitTimeMS` bounds an idle pull to a second.
      const access = this.deps.access()
      if (!access.ok) {
        await this.end(access.reason, false, 'detail' in access ? access.detail : undefined)
        return
      }
      // An invalidate read by prime() (the collection went between opening and the first read).
      if (this.outbox.at(-1)?.raw.operationType === 'invalidate') {
        this.flush(true)
        await this.end('invalidate')
        return
      }
      if (
        this.paused ||
        this.outbox.length >= t.outbox ||
        this.outboxBytes >= t.outboxBytes ||
        !this.deps.writable() ||
        this.overRate()
      ) {
        this.flush()
        await sleep(t.waitMs)
        continue
      }
      const current = this.stream
      if (!current) {
        await sleep(t.waitMs)
        continue
      }
      let raw: Document | null
      try {
        raw = await current.tryNext()
      } catch (e) {
        if (this.stopped || this.stream !== current) continue
        await this.end(reasonOf(e))
        return
      }
      // A resume from now replaced the stream meanwhile: what the old one gave is dropped.
      if (this.stopped || this.stream !== current) continue
      const token = current.resumeToken
      if (raw) {
        this.take(raw, token)
        if (raw.operationType === 'invalidate') {
          this.flush(true)
          await this.end('invalidate')
          return
        }
      } else if (this.outbox.length === 0 && token !== undefined && token !== null) {
        this.token = token
        this.mark()
      }
      this.flush()
    }
  }

  private take(raw: Document, token: unknown): void {
    const size = BSON.calculateObjectSize(raw)
    this.outbox.push({ raw, token, size })
    this.outboxBytes += size
  }

  private drop(): void {
    this.outbox = []
    this.outboxBytes = 0
  }

  private flush(force = false): void {
    if (this.outbox.length === 0 || this.stopped) return
    // Paused: nothing leaves (a read in flight when the pause came waits in the outbox).
    if (this.paused && !force) return
    const t = this.deps.timing
    const now = this.deps.now()
    const due =
      this.outbox.length >= t.maxBatch ||
      this.outboxBytes >= t.batchBytes ||
      now - this.lastFlush >= t.flushMs
    if (!force && !due) return
    if (!force && !this.deps.writable()) return
    // W2, W3: the whole batch is converted under access and masking rules as they are now.
    const access = this.deps.access()
    if (!access.ok) {
      void this.end(access.reason, false, 'detail' in access ? access.detail : undefined)
      return
    }
    if (now - this.window.start >= 1000) this.window = { start: now, count: 0 }
    // A forced flush (a pause, an invalidate) sends everything pulled, still in bounded batches.
    do {
      const limit = Math.min(t.maxBatch, force ? Infinity : Math.max(0, t.maxPerSecond - this.window.count))
      if (limit === 0) return
      const events: WatchEvent[] = []
      let taken = 0
      let bytes = 0
      let seq = this.seq
      for (const item of this.outbox) {
        if (taken >= limit) break
        const event = toWatchEvent(item.raw, {
          seq: seq + 1,
          masker: access.masker,
          admin: access.admin,
          elideBytes: t.elideBytes,
        })
        // Final review I6: a batch stays within its byte budget; one larger event goes alone.
        if (event && events.length > 0 && bytes + event.bytes > t.batchBytes) break
        taken++
        if (!event) continue
        seq++
        bytes += event.bytes
        events.push(event)
      }
      const items = this.outbox.splice(0, taken)
      for (const item of items) this.outboxBytes -= item.size
      this.seq = seq
      this.window.count += taken
      this.lastFlush = now
      this.token = items.at(-1)!.token
      this.mark()
      if (events.length === 0) continue
      this.sent += events.length
      const last = events.at(-1)!
      const at = last.wallTime ?? last.clusterTime * 1000
      this.deps.send({
        ch: 'watch',
        type: 'events',
        payload: { id: this.deps.id, events, lagMs: Math.max(0, now - at) },
      })
      this.deps.onEvents?.(events)
    } while (this.outbox.length > 0 && (force || this.outboxBytes >= t.batchBytes))
  }
}
