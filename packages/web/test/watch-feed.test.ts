// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WatchOptionsSchema } from '@mongo-manager/shared/browser'
import {
  RELEASE_GRACE_MS,
  acquireWatchFeed,
  createWatchFeed,
  pruneWatchFeeds,
  releaseWatchFeed,
  resetWatchFeeds,
  watchKey,
  watchKeyOfTab,
} from '../src/watch/feeds'
import { event, fakeSocket } from './support/watch'

const live = vi.hoisted(() => ({ socket: null as unknown }))
vi.mock('../src/jobs/live', () => ({ realtimeSocket: () => live.socket }))

const target = { connectionId: 'c1', scope: 'collection' as const, db: 'shop', coll: 'orders' }
afterEach(() => {
  resetWatchFeeds()
  vi.useRealTimers()
})

describe('the Watch feed in the web (phase 3e-1 spec §4)', () => {
  it('subscribes with its target, filter and options, and keeps events newest first, counted by type', () => {
    const s = fakeSocket()
    const feed = createWatchFeed(target, s.socket)
    feed.start()
    const sub = s.lastSub()
    expect(sub).toMatchObject({
      ch: 'watch',
      type: 'sub',
      connectionId: 'c1',
      scope: 'collection',
      db: 'shop',
      coll: 'orders',
      filter: {},
    })
    expect(sub.options).toEqual(WatchOptionsSchema.parse({}))
    expect(feed.status.value).toBe('starting')
    s.deliver({ type: 'started', payload: { id: sub.id, preImages: false, resumed: false } })
    expect(feed.status.value).toBe('live')
    expect(feed.preImages.value).toBe(false)
    s.deliver({
      type: 'events',
      payload: { id: sub.id, events: [event(1), event(2, { op: 'update' })], lagMs: 40 },
    })
    expect(feed.events.value.map((e) => e.seq)).toEqual([2, 1])
    expect(feed.counts.value).toEqual({ insert: 1, update: 1 })
    expect(feed.total.value).toBe(2)
    expect(feed.lagMs.value).toBe(40)
    // Another feed's messages are not this one's.
    s.deliver({ type: 'events', payload: { id: 'other', events: [event(9)], lagMs: 0 } })
    expect(feed.events.value).toHaveLength(2)
  })

  // Review Focus 1 (web).
  it('keeps the latest 2000 events and counts the rest', () => {
    const s = fakeSocket()
    const feed = createWatchFeed(target, s.socket)
    feed.start()
    const { id } = s.lastSub()
    for (let b = 0; b < 25; b++)
      s.deliver({
        type: 'events',
        payload: { id, events: Array.from({ length: 100 }, (_, i) => event(b * 100 + i + 1)), lagMs: 0 },
      })
    expect(feed.events.value).toHaveLength(2000)
    expect(feed.events.value[0]!.seq).toBe(2500)
    expect(feed.dropped.value).toBe(500)
    expect(feed.total.value).toBe(2500)
    expect(new Set(feed.events.value.map((e) => e.key)).size).toBe(2000)
  })

  // Final review I6: the web's memory is bounded in bytes too.
  it('keeps no more than its byte bound, dropping the oldest', () => {
    const s = fakeSocket()
    const feed = createWatchFeed(target, s.socket)
    feed.start()
    const { id } = s.lastSub()
    const big = 20 * 1024 * 1024
    s.deliver({
      type: 'events',
      payload: { id, events: [1, 2, 3, 4].map((n) => event(n, { bytes: big })), lagMs: 0 },
    })
    expect(feed.events.value.map((e) => e.seq)).toEqual([4, 3, 2])
    expect(feed.dropped.value).toBe(1)
  })

  // Final review I5, M10: a reconnect resumes after the last event received, paused if it was.
  it('re-subscribes with the last event received and its pause, and says how the resume went', () => {
    const s = fakeSocket()
    const feed = createWatchFeed(target, s.socket)
    feed.start()
    const { id } = s.lastSub()
    expect(s.lastSub()).toMatchObject({ after: 0, paused: false })
    s.deliver({
      type: 'started',
      payload: { id, preImages: null, resumed: false, gap: false, paused: false, exists: true },
    })
    s.deliver({ type: 'events', payload: { id, events: [event(1), event(2)], lagMs: 0 } })
    feed.pause()
    expect(s.sent.at(-1)).toEqual({ ch: 'watch', type: 'pause', id })
    s.deliver({ type: 'paused', payload: { id } })
    expect(feed.status.value).toBe('paused')
    s.drop()
    expect(feed.status.value).toBe('reconnecting')
    s.reopen()
    expect(s.lastSub()).toMatchObject({ id, after: 2, paused: true })
    s.deliver({
      type: 'started',
      payload: { id, preImages: null, resumed: true, gap: false, paused: true, exists: true },
    })
    expect(feed.status.value).toBe('paused')
    expect(feed.notice.value).toBe('resumed')
    // The server started it paused: no second pause.
    expect(s.sent.at(-1)).toMatchObject({ type: 'sub' })
    feed.resume('now')
    expect(s.sent.at(-1)).toEqual({ ch: 'watch', type: 'resume', id, from: 'now' })
    s.deliver({ type: 'resumed', payload: { id, from: 'now' } })
    expect(feed.status.value).toBe('live')
    expect(feed.notice.value).toBe('from_now')
    s.drop()
    s.reopen()
    expect(s.lastSub()).toMatchObject({ paused: false })
    s.deliver({
      type: 'started',
      payload: { id, preImages: null, resumed: false, gap: false, paused: false, exists: true },
    })
    expect(feed.notice.value).toBe('restarted')
    s.drop()
    s.reopen()
    s.deliver({
      type: 'started',
      payload: { id, preImages: null, resumed: true, gap: true, paused: false, exists: true },
    })
    expect(feed.notice.value).toBe('resumed_gap')
  })

  // Final review M4.
  it('knows whether its collection exists yet', () => {
    const s = fakeSocket()
    const feed = createWatchFeed(target, s.socket)
    feed.start()
    const { id } = s.lastSub()
    s.deliver({
      type: 'started',
      payload: { id, preImages: null, resumed: false, gap: false, paused: false, exists: false },
    })
    expect(feed.exists.value).toBe(false)
    s.deliver({ type: 'events', payload: { id, events: [event(1)], lagMs: 0 } })
    expect(feed.exists.value).toBe(true)
  })

  it('starts again from now with a new id when its filters change, and says so', () => {
    const s = fakeSocket()
    const feed = createWatchFeed(target, s.socket)
    feed.start()
    const first = s.lastSub().id
    feed.configure({ 'fullDocument.n': { $gt: 1 } }, WatchOptionsSchema.parse({ ops: ['insert'] }))
    expect(s.sent).toContainEqual({ ch: 'watch', type: 'unsub', id: first })
    const next = s.lastSub()
    expect(next.id).not.toBe(first)
    expect(next).toMatchObject({ filter: { 'fullDocument.n': { $gt: 1 } }, options: { ops: ['insert'] } })
    expect(feed.notice.value).toBe('filter_changed')
  })

  it('ends or is refused with a reason, and lets go of its channel', () => {
    const s = fakeSocket()
    const feed = createWatchFeed(target, s.socket)
    feed.start()
    const { id } = s.lastSub()
    s.deliver({ type: 'error', payload: { id, reason: 'masking_filter', detail: 'fullDocument.email' } })
    expect(feed.status.value).toBe('refused')
    expect(feed.reason.value).toBe('masking_filter')
    expect(feed.detail.value).toBe('fullDocument.email')
    s.deliver({ type: 'events', payload: { id, events: [event(1)], lagMs: 0 } })
    expect(feed.events.value).toEqual([])
    feed.start()
    const again = s.lastSub().id
    s.deliver({ type: 'ended', payload: { id: again, reason: 'invalidate' } })
    expect(feed.status.value).toBe('ended')
    expect(feed.reason.value).toBe('invalidate')
  })

  it('is unavailable without the real-time socket (plan ruling 6)', () => {
    expect(
      (() => {
        const f = createWatchFeed(target, null)
        f.start()
        return f.status.value
      })(),
    ).toBe('unavailable')
    const s = fakeSocket('polling')
    const feed = createWatchFeed(target, s.socket)
    feed.start()
    expect(feed.status.value).toBe('unavailable')
  })

  it('keeps a feed for 5 s after its view goes, a paused one until its tab closes', () => {
    vi.useFakeTimers()
    const s = fakeSocket()
    live.socket = s.socket
    const feed = acquireWatchFeed(target)
    expect(acquireWatchFeed(target)).toBe(feed)
    releaseWatchFeed(feed)
    releaseWatchFeed(feed)
    vi.advanceTimersByTime(RELEASE_GRACE_MS - 1)
    expect(acquireWatchFeed(target)).toBe(feed)
    releaseWatchFeed(feed)
    vi.advanceTimersByTime(RELEASE_GRACE_MS)
    expect(s.sent.at(-1)).toMatchObject({ type: 'unsub' })
    expect(acquireWatchFeed(target)).not.toBe(feed)
    // Paused: kept past the grace, until the tab is gone.
    const db = { connectionId: 'c1', scope: 'database' as const, db: 'shop' }
    const paused = acquireWatchFeed(db)
    const { id } = s.lastSub()
    s.deliver({ type: 'started', payload: { id, preImages: null, resumed: false } })
    paused.pause()
    s.deliver({ type: 'paused', payload: { id } })
    releaseWatchFeed(paused)
    vi.advanceTimersByTime(RELEASE_GRACE_MS * 3)
    expect(acquireWatchFeed(db)).toBe(paused)
    releaseWatchFeed(paused)
    pruneWatchFeeds(new Set([watchKey(target)]))
    expect(s.sent.at(-1)).toEqual({ ch: 'watch', type: 'unsub', id })
  })

  it('names the feed of each kind of tab', () => {
    expect(
      watchKeyOfTab({ kind: 'collection', params: { connectionId: 'c1', db: 'shop', coll: 'orders' } }),
    ).toBe(watchKey(target))
    expect(watchKeyOfTab({ kind: 'database', params: { connectionId: 'c1', db: 'shop' } })).toBe(
      watchKey({ connectionId: 'c1', scope: 'database', db: 'shop' }),
    )
    expect(watchKeyOfTab({ kind: 'connection', params: { connectionId: 'c1' } })).toBe(
      watchKey({ connectionId: 'c1', scope: 'deployment' }),
    )
    expect(watchKeyOfTab({ kind: 'shell', params: { connectionId: 'c1', db: 'shop' } })).toBeNull()
  })
})
