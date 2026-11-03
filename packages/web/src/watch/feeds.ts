import { ref, watch, type Ref, type WatchStopHandle } from 'vue'
import {
  MAX_WATCH_EVENTS,
  MAX_WATCH_KEPT_BYTES,
  WatchOptionsSchema,
  type WatchEvent,
  type WatchOptions,
  type WatchReason,
  type WatchTarget,
} from '@mongo-manager/shared/browser'
import { realtimeSocket } from '@/jobs/live'
import type { ChannelMessage, JobsSocket } from '@/jobs/socket'
import { randomId } from '@/uuid'

/** An event as the list keeps it: `key` is unique in its feed, the newest the highest. */
export type FeedEvent = WatchEvent & { key: number }
export type FeedStatus = 'starting' | 'live' | 'paused' | 'reconnecting' | 'ended' | 'refused' | 'unavailable'
export type FeedNotice =
  | 'resumed'
  | 'resumed_gap'
  | 'restarted'
  | 'filter_changed'
  | 'from_now'
  // W4.7: the recording's file is full (the feed goes on).
  | 'recording_full'

export interface WatchFeed {
  readonly key: string
  readonly target: WatchTarget
  /** Newest first, at most MAX_WATCH_EVENTS. */
  events: Ref<FeedEvent[]>
  /** Received but no longer kept. */
  dropped: Ref<number>
  /** Received since the last clear, by operation type. */
  counts: Ref<Record<string, number>>
  total: Ref<number>
  status: Ref<FeedStatus>
  reason: Ref<WatchReason | null>
  detail: Ref<string | null>
  lagMs: Ref<number>
  preImages: Ref<boolean | null>
  /** W4.7: the feed records its events to a file. */
  recording: Ref<boolean>
  /** Final review M4: the collection exists yet (collection scope; null elsewhere or not known). */
  exists: Ref<boolean | null>
  notice: Ref<FeedNotice | null>
  filter: Ref<Record<string, unknown>>
  options: Ref<WatchOptions>
  /** Events per second over the last 10 s. */
  rate: Ref<number>
  start(): void
  pause(): void
  resume(from: 'here' | 'now'): void
  clear(): void
  configure(filter: Record<string, unknown>, options: WatchOptions): void
  stop(): void
}

const RATE_WINDOW_MS = 10_000

export const watchKey = (t: WatchTarget): string =>
  JSON.stringify([t.connectionId, t.scope, t.db ?? '', t.coll ?? ''])

/** The feed a workspace tab shows: a collection, a database or the whole connection. */
export function watchKeyOfTab(tab: { kind: string; params: Record<string, string> }): string | null {
  const { connectionId, db, coll } = tab.params
  if (!connectionId) return null
  if (tab.kind === 'collection' && db && coll)
    return watchKey({ connectionId, scope: 'collection', db, coll })
  if (tab.kind === 'database' && db) return watchKey({ connectionId, scope: 'database', db })
  if (tab.kind === 'connection') return watchKey({ connectionId, scope: 'deployment' })
  return null
}

/**
 * Phase 3e-1 spec §4: one feed on the app's real-time socket. The subscription is re-sent after
 * every reconnect with the same id and parameters, so the server resumes it where it was; a
 * change of filters starts a new one from now.
 */
export function createWatchFeed(
  target: WatchTarget,
  socket: JobsSocket | null,
  now: () => number = Date.now,
): WatchFeed {
  const events = ref<FeedEvent[]>([])
  const dropped = ref(0)
  const counts = ref<Record<string, number>>({})
  const total = ref(0)
  const status = ref<FeedStatus>('starting')
  const reason = ref<WatchReason | null>(null)
  const detail = ref<string | null>(null)
  const lagMs = ref(0)
  const preImages = ref<boolean | null>(null)
  const recording = ref(false)
  const exists = ref<boolean | null>(null)
  const notice = ref<FeedNotice | null>(null)
  const filter = ref<Record<string, unknown>>({})
  const options = ref<WatchOptions>(WatchOptionsSchema.parse({}))
  const rate = ref(0)
  let id: string | null = null
  let off: (() => void) | null = null
  let stopState: WatchStopHandle | null = null
  /**
   * The subscription the socket re-sends after every reconnect. Final review I5, M10: it carries the
   * last event received and whether the feed is paused, so the server resumes right after that event,
   * paused if it was (the socket re-reads this object each time it sends it).
   */
  let sub: Record<string, unknown> & { ch: string } = { ch: 'watch' }
  let away = false
  let lastKey = 0
  const stamps: Array<{ at: number; n: number }> = []

  function tick(n: number): void {
    const at = now()
    stamps.push({ at, n })
    while (stamps.length > 0 && stamps[0]!.at < at - RATE_WINDOW_MS) stamps.shift()
    rate.value = stamps.reduce((sum, s) => sum + s.n, 0) / (RATE_WINDOW_MS / 1000)
  }

  function receive(m: ChannelMessage): void {
    const p = m.payload
    if (m.type === 'started') {
      preImages.value = typeof p.preImages === 'boolean' ? p.preImages : null
      recording.value = p.recording === true
      exists.value = typeof p.exists === 'boolean' ? p.exists : null
      if (away) notice.value = p.resumed === true ? (p.gap === true ? 'resumed_gap' : 'resumed') : 'restarted'
      away = false
      status.value = p.paused === true ? 'paused' : 'live'
    } else if (m.type === 'events') {
      const batch = Array.isArray(p.events) ? (p.events as WatchEvent[]) : []
      if (batch.length === 0) return
      sub.after = batch.at(-1)!.seq
      exists.value = exists.value === false ? true : exists.value
      const added = batch.map((e) => ({ ...e, key: ++lastKey })).reverse()
      const kept = added.concat(events.value)
      // At most MAX_WATCH_EVENTS, and at most MAX_WATCH_KEPT_BYTES (final review I6): oldest go first.
      let keep = Math.min(kept.length, MAX_WATCH_EVENTS)
      let bytes = 0
      for (let i = 0; i < keep; i++) {
        bytes += kept[i]!.bytes ?? 0
        if (bytes > MAX_WATCH_KEPT_BYTES && i > 0) keep = i
      }
      dropped.value += kept.length - keep
      events.value = kept.slice(0, keep)
      const next = { ...counts.value }
      for (const e of batch) next[e.op] = (next[e.op] ?? 0) + 1
      counts.value = next
      total.value += batch.length
      lagMs.value = Number(p.lagMs) || 0
      tick(batch.length)
    } else if (m.type === 'recording') {
      recording.value = false
      notice.value = 'recording_full'
    } else if (m.type === 'paused') status.value = 'paused'
    else if (m.type === 'resumed') {
      status.value = 'live'
      if (p.from === 'now') notice.value = 'from_now'
    } else if (m.type === 'error' || m.type === 'ended') {
      reason.value = (p.reason as WatchReason) ?? 'internal'
      detail.value = typeof p.detail === 'string' ? p.detail : null
      status.value = m.type === 'error' ? 'refused' : 'ended'
      detach()
    }
  }

  function detach(): void {
    const stop = off
    off = null
    id = null
    stop?.()
    stopState?.()
    stopState = null
  }

  function start(): void {
    detach()
    reason.value = null
    detail.value = null
    away = false
    if (!socket || socket.state.value === 'polling') {
      status.value = 'unavailable'
      return
    }
    const current = randomId()
    id = current
    status.value = 'starting'
    sub = {
      ch: 'watch',
      type: 'sub',
      id: current,
      connectionId: target.connectionId,
      scope: target.scope,
      ...(target.db !== undefined ? { db: target.db } : {}),
      ...(target.coll !== undefined ? { coll: target.coll } : {}),
      filter: filter.value,
      options: options.value,
      after: 0,
      paused: false,
    }
    off = socket.watch(
      `watch:${current}`,
      sub,
      { ch: 'watch', type: 'unsub', id: current },
      (m) => m.payload.id === current,
      receive,
    )
    // Sync: the feed's state follows the socket's at once, before the socket re-sends anything.
    stopState = watch(
      socket.state,
      (state) => {
        if (id !== current) return
        if (state === 'polling') status.value = 'unavailable'
        else if (state !== 'open' && ['starting', 'live', 'paused'].includes(status.value)) {
          away = true
          status.value = 'reconnecting'
        }
      },
      { flush: 'sync' },
    )
  }

  return {
    key: watchKey(target),
    target,
    events,
    dropped,
    counts,
    total,
    status,
    reason,
    detail,
    lagMs,
    preImages,
    recording,
    exists,
    notice,
    filter,
    options,
    rate,
    start,
    pause() {
      if (!id) return
      sub.paused = true
      socket?.send({ ch: 'watch', type: 'pause', id })
    },
    resume(from) {
      if (!id) return
      sub.paused = false
      socket?.send({ ch: 'watch', type: 'resume', id, from })
    },
    clear() {
      events.value = []
      dropped.value = 0
      counts.value = {}
      total.value = 0
      stamps.length = 0
      rate.value = 0
    },
    configure(nextFilter, nextOptions) {
      filter.value = nextFilter
      options.value = nextOptions
      start()
      notice.value = 'filter_changed'
    },
    stop() {
      detach()
      status.value = 'ended'
      reason.value = 'closed'
    },
  }
}

/** Spec §4.1: switching sections and back within this long keeps the feed running. */
export const RELEASE_GRACE_MS = 5_000

const registry = new Map<string, { feed: WatchFeed; users: number; timer?: ReturnType<typeof setTimeout> }>()

/** The feed of a target, shared by the views that show it; started when first asked for. */
export function acquireWatchFeed(target: WatchTarget): WatchFeed {
  const key = watchKey(target)
  const entry = registry.get(key)
  if (entry) {
    clearTimeout(entry.timer)
    entry.timer = undefined
    entry.users++
    return entry.feed
  }
  const feed = createWatchFeed(target, realtimeSocket())
  feed.start()
  registry.set(key, { feed, users: 1 })
  return feed
}

/** A view let go: after the grace the feed stops, unless it is paused (kept until its tab closes). */
export function releaseWatchFeed(feed: WatchFeed): void {
  const entry = registry.get(feed.key)
  if (!entry || entry.feed !== feed) return
  entry.users = Math.max(0, entry.users - 1)
  if (entry.users > 0 || feed.status.value === 'paused') return
  clearTimeout(entry.timer)
  entry.timer = setTimeout(() => {
    if (registry.get(feed.key) !== entry || entry.users > 0) return
    registry.delete(feed.key)
    feed.stop()
  }, RELEASE_GRACE_MS)
}

/**
 * Tabs closed: their feeds stop at once, paused or not, even while the closing tab's view still
 * holds them (it is about to go; no other tab shows the same target).
 */
export function pruneWatchFeeds(liveKeys: ReadonlySet<string>): void {
  for (const [key, entry] of registry)
    if (!liveKeys.has(key)) {
      clearTimeout(entry.timer)
      registry.delete(key)
      entry.feed.stop()
    }
}

/** Sign-out: nothing of the previous user's feeds stays. */
export function resetWatchFeeds(): void {
  for (const entry of registry.values()) {
    clearTimeout(entry.timer)
    entry.feed.stop()
  }
  registry.clear()
}
