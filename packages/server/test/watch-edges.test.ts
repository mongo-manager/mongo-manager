import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Timestamp, type Document, type MongoClient } from 'mongodb'
import { ConnectionSettingsSchema, WatchOptionsSchema } from '@mongo-manager/shared'
import { makeApp, type TestApp } from './helpers'
import {
  Feed,
  SENT_LOG,
  type FeedTiming,
  type StreamLike,
  type WatchMessage,
} from '../src/changestreams/feed'
import { WatchRefusal } from '../src/changestreams/target'
import type { Subscriber, WatchRequest } from '../src/changestreams/manager'

/**
 * Phase 3e-1 final review (gate): the edges of a feed's and the manager's life — the connection
 * ending during a start, a takeover while another socket is still starting, cursors that fail to
 * close, the sent log's bound.
 */
const apps: TestApp[] = []
/** CI 2026-10-22: a feed a failed test left reading ran on into the tests after it. */
const feeds: Feed[] = []
afterEach(async () => {
  for (const f of feeds.splice(0)) await f.end('closed', true)
  for (const t of apps.splice(0)) await t.close()
})
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not reached')
    await wait(5)
  }
}
const insert = (n: number): Document => ({
  operationType: 'insert',
  clusterTime: new Timestamp({ t: 1, i: n }),
  ns: { db: 'shop', coll: 'orders' },
  documentKey: { _id: n },
})

/**
 * `immediate`: a read gives way to the event loop without a timer, whose 15 ms ticks on Windows set
 * the pace of a read a millisecond long (CI 2026-10-22). Idle, it waits a tick as any read does,
 * so it does not spin (second review of the open's stop, nit 8).
 */
function fakeStream(o: { failClose?: boolean; failFirst?: boolean; immediate?: boolean } = {}) {
  const queue: Document[] = []
  let token = 0
  let reads = 0
  const s = {
    closed: false,
    push: (...d: Document[]) => queue.push(...d),
    get resumeToken() {
      return { t: token }
    },
    async tryNext() {
      if (s.closed) throw Object.assign(new Error('closed'), { name: 'MongoAPIError' })
      reads++
      if (reads === 1 && o.failFirst) throw Object.assign(new Error('first'), { code: 13 })
      await (o.immediate && queue.length > 0 ? new Promise((r) => setImmediate(r)) : wait(1))
      const d = queue.shift()
      if (d) token++
      return d ?? null
    },
    async close() {
      s.closed = true
      if (o.failClose) throw new Error('close failed')
    },
  }
  return s
}

const FAST: FeedTiming = {
  flushMs: 10,
  maxBatch: 100,
  maxPerSecond: 100_000,
  outbox: 200,
  waitMs: 2,
  elideBytes: 256 * 1024,
  outboxBytes: 8 * 1024 * 1024,
  batchBytes: 2 * 1024 * 1024,
}

function feedOf(
  opens: Array<{
    failClose?: boolean
    failFirst?: boolean
    immediate?: boolean
    openFails?: boolean
    openMs?: number
  }>,
) {
  const streams: Array<ReturnType<typeof fakeStream>> = []
  const sent: WatchMessage[] = []
  const ended: string[] = []
  let n = 0
  const feed = new Feed({
    id: 'f',
    open: async () => {
      const o = opens[Math.min(n++, opens.length - 1)] ?? {}
      if (o.openMs) await wait(o.openMs)
      if (o.openFails) throw Object.assign(new Error('unreachable'), { name: 'MongoNetworkError' })
      const s = fakeStream(o)
      streams.push(s)
      return s as unknown as StreamLike
    },
    access: () => ({ ok: true, masker: null, admin: true }),
    send: (m) => sent.push(m),
    writable: () => true,
    now: () => Date.now(),
    timing: { ...FAST, maxBatch: 1 },
    onEnd: (reason) => ended.push(reason),
  })
  feeds.push(feed)
  return { feed, streams, sent, ended }
}

describe('a feed’s edges', () => {
  it('closes a cursor that opened after the feed ended, even when closing fails', async () => {
    const f = feedOf([{ openMs: 40, failClose: true }])
    const starting = f.feed.start()
    await wait(5)
    await f.feed.end('closed', true)
    await starting
    expect(f.streams[0]!.closed).toBe(true)
    f.feed.pause()
    await f.feed.resume('here')
    await f.feed.end('closed')
    expect(f.ended).toEqual(['closed'])
    expect(f.sent).toEqual([])
  })

  it('ends with the reason when a resume from now cannot open or read', async () => {
    const opens = feedOf([{ failClose: true }, { openFails: true }])
    await opens.feed.start()
    opens.feed.pause()
    await opens.feed.resume('now')
    expect(opens.ended).toEqual(['connection'])
    const reads = feedOf([{}, { failFirst: true, failClose: true }])
    await reads.feed.start()
    reads.feed.pause()
    await reads.feed.resume('now')
    expect(reads.ended).toEqual(['unauthorized'])
    expect(reads.streams.every((s) => s.closed)).toBe(true)
  })

  it('keeps no cursor when the feed ends after a resume from now read its first batch', async () => {
    const f = feedOf([{}, { openMs: 20 }])
    await f.feed.start()
    f.feed.pause()
    const resuming = f.feed.resume('now')
    await wait(30)
    await f.feed.end('closed', true)
    await resuming
    expect(f.streams.every((s) => s.closed)).toBe(true)
  })

  it('delivers and ends on an invalidate its first read found', async () => {
    const f = feedOf([{}])
    const first = fakeStream()
    first.push({ operationType: 'invalidate', clusterTime: new Timestamp({ t: 1, i: 1 }) })
    const feed = new Feed({
      id: 'g',
      open: async () => first as unknown as StreamLike,
      access: () => ({ ok: true, masker: null, admin: true }),
      send: (m) => f.sent.push(m),
      writable: () => true,
      now: () => Date.now(),
      timing: FAST,
      onEnd: (reason) => f.ended.push(reason),
    })
    feeds.push(feed)
    await feed.start()
    await until(() => f.ended.length === 1)
    expect(f.ended).toEqual(['invalidate'])
    expect(f.sent.flatMap((m) => (m.type === 'events' ? m.payload.events.map((e) => e.op) : []))).toEqual([
      'invalidate',
    ])
  })

  it('remembers at most its bound of sent batches', async () => {
    // 1,005 one-event batches, read without a timer: at a timer's pace they took 15 s on Windows,
    // and over the bound below on a loaded runner (CI 2026-10-22). Slow under a loaded full-suite
    // run all the same (phase 3e-2 gate), so a wide bound.
    const f = feedOf([{ immediate: true }])
    await f.feed.start()
    for (let i = 1; i <= SENT_LOG + 5; i++) f.streams[0]!.push(insert(i))
    await until(() => f.sent.filter((m) => m.type === 'events').length === SENT_LOG + 5, 60_000)
    const { log, seq } = await f.feed.detach()
    expect(log).toHaveLength(SENT_LOG)
    expect(log.at(-1)!.seq).toBe(seq)
  }, 90_000)
})

async function setup(o: { inspectMs?: number } = {}) {
  const opened: Array<ReturnType<typeof fakeStream>> = []
  const t = await makeApp(
    { auth: true },
    {
      watch: {
        timing: { flushMs: 10, waitMs: 5 },
        limits: { graceMs: 500 },
        client: async () => ({}) as MongoClient,
        inspect: async () => {
          if (o.inspectMs) await wait(o.inspectMs)
          return { preImages: false, exists: true }
        },
        openStream: () => {
          const s = fakeStream()
          opened.push(s)
          return s as unknown as StreamLike
        },
      },
    },
  )
  apps.push(t)
  const { ctx } = t.app
  const connectionId = ctx.connections.create(
    {
      name: 'C',
      favorite: false,
      readOnly: false,
      settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port: 1 }] }),
    },
    null,
  ).id
  const user = (masked = false) => {
    const u = ctx.users.create({ username: `u-${Math.random()}`, passwordHash: 'x', role: 'viewer' })
    ctx.grants.set(connectionId, u.id, 'viewer')
    if (masked) ctx.grants.setMasked(connectionId, u.id, true)
    const { session } = ctx.sessions.create(u.id, {})
    return {
      id: u.id,
      principal: {
        kind: 'user' as const,
        userId: u.id,
        username: u.username,
        role: 'viewer' as const,
        csrfToken: session.csrfToken,
        sessionId: 's',
        sessionIdHash: 'h',
      },
    }
  }
  const subscriber = (u: ReturnType<typeof user>) => {
    const sent: WatchMessage[] = []
    const endedIds: string[] = []
    const sub: Subscriber & { sent: WatchMessage[]; endedIds: string[] } = {
      sent,
      endedIds,
      ip: null,
      principal: () => u.principal,
      send: (m) => sent.push(m),
      writable: () => true,
      ended: (id) => endedIds.push(id),
    }
    return sub
  }
  const request = (over: Partial<WatchRequest> = {}): WatchRequest => ({
    id: randomUUID(),
    target: { connectionId, scope: 'collection', db: 'shop', coll: 'orders' },
    filter: {},
    options: WatchOptionsSchema.parse({}),
    ...over,
  })
  return { t, ctx, connectionId, user, subscriber, request, opened, watch: ctx.watch }
}

describe('the watch manager’s edges', () => {
  it('refuses a start in flight in the connection’s words when the connection is edited', async () => {
    const s = await setup({ inspectMs: 50 })
    const u = s.user()
    const starting = s.watch.start(u.id, s.request(), s.subscriber(u))
    await wait(10)
    await s.watch.closeFor(s.connectionId, 'connection')
    await expect(starting).rejects.toMatchObject({ reason: 'connection' })
    expect(s.watch.count()).toBe(0)
  })

  it('lets a second socket take over an id another socket is still starting', async () => {
    const s = await setup({ inspectMs: 40 })
    const u = s.user()
    const a = s.subscriber(u)
    const b = s.subscriber(u)
    const req = s.request()
    const first = s.watch.start(u.id, req, a)
    await wait(5)
    await s.watch.start(u.id, req, b)
    await first
    expect(a.endedIds).toEqual([req.id])
    expect(a.sent).toEqual([])
    expect(b.sent[0]).toMatchObject({ type: 'started' })
    expect(s.watch.count()).toBe(1)
    await s.watch.resume(u.id, req.id, 'here', a)
    await s.watch.stop(u.id, req.id, b)
  })

  it('keeps a feed whose filter stays allowed when its viewer’s masking changes', async () => {
    const s = await setup()
    const u = s.user(true)
    const sub = s.subscriber(u)
    const req = s.request({ filter: { 'fullDocument.n': { $gt: 0 } } })
    await s.watch.start(u.id, req, sub)
    s.ctx.personalFields.set(s.connectionId, [{ db: 'shop', coll: 'orders', field: 'email' }])
    s.opened[0]!.push(insert(1))
    await until(() => sub.sent.some((m) => m.type === 'events'))
    expect(sub.sent.some((m) => m.type === 'ended')).toBe(false)
    await s.watch.stop(u.id, req.id, sub)
  })

  it('says a restricted user may filter a database feed only on the change itself', async () => {
    const s = await setup()
    s.ctx.personalFields.set(s.connectionId, [{ db: 'shop', coll: 'orders', field: 'email' }])
    const u = s.user(true)
    const refused = await s.watch
      .start(
        u.id,
        s.request({
          target: { connectionId: s.connectionId, scope: 'database', db: 'shop' },
          filter: { 'fullDocument.n': 1 },
        }),
        s.subscriber(u),
      )
      .catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(WatchRefusal)
    expect(refused).toMatchObject({ reason: 'masking_filter', detail: 'scope' })
  })

  // Security review 2026-10-13 round 2 (I1): no feed of a bucket's chunks for such a user.
  // User report 2026-10-27: where a rule reaches the bucket; a rule elsewhere leaves it free.
  it('refuses a restricted user a feed of GridFS file contents where a rule reaches the bucket', async () => {
    const s = await setup()
    s.ctx.personalFields.set(s.connectionId, [{ db: 'shop', coll: 'fs.files', field: 'metadata.owner' }])
    const u = s.user(true)
    const chunks = () =>
      s.watch
        .start(
          u.id,
          s.request({
            target: { connectionId: s.connectionId, scope: 'collection', db: 'shop', coll: 'fs.chunks' },
          }),
          s.subscriber(u),
        )
        .catch((e: unknown) => e)
    expect(await chunks()).toBeInstanceOf(WatchRefusal)
    s.ctx.personalFields.set(s.connectionId, [{ db: 'shop', coll: 'orders', field: 'email' }])
    expect(await chunks()).not.toBeInstanceOf(WatchRefusal)
  })

  it('cancels starts in flight when the server closes', async () => {
    const s = await setup({ inspectMs: 50 })
    const u = s.user()
    const starting = s.watch.start(u.id, s.request(), s.subscriber(u))
    await wait(10)
    await s.watch.closeAll()
    await starting
    expect(s.watch.count()).toBe(0)
    expect(s.opened).toHaveLength(0)
  })
})
