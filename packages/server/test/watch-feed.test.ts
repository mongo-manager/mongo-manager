import { describe, expect, it } from 'vitest'
import { Timestamp, type Document } from 'mongodb'
import {
  Feed,
  reasonOf,
  type FeedAccess,
  type FeedTiming,
  type StreamLike,
  type WatchMessage,
} from '../src/changestreams/feed'
import { compileRules } from '../src/masking/match'

const FAST: FeedTiming = {
  flushMs: 10,
  maxBatch: 100,
  maxPerSecond: 200,
  outbox: 200,
  waitMs: 5,
  elideBytes: 256 * 1024,
  outboxBytes: 8 * 1024 * 1024,
  batchBytes: 2 * 1024 * 1024,
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not reached')
    await wait(5)
  }
}
const insert = (n: number): Document => ({
  operationType: 'insert',
  clusterTime: new Timestamp({ t: 1_790_000_000, i: n }),
  wallTime: new Date(Date.now() - 50),
  ns: { db: 'shop', coll: 'orders' },
  documentKey: { _id: n },
  fullDocument: { _id: n },
})

/**
 * A change stream fed by the test: events are pulled one by one; null when none is waiting.
 * `immediate`: a read gives way to the event loop without a timer, whose 15 ms ticks on Windows
 * set the pace of a read a millisecond long (review of the open's stop, minor 8). Idle, it waits
 * a tick as any read does, so it does not spin (second review, nit 8).
 */
function fakeStream(o: { blockMs?: number; failFirst?: Error; immediate?: boolean } = {}) {
  const queue: Array<Document | Error> = []
  let reads = 0
  let token = 0
  let pulled = 0
  const s = {
    closed: false,
    get pulled() {
      return pulled
    },
    push: (...items: Array<Document | Error>) => queue.push(...items),
    get resumeToken() {
      return { t: token }
    },
    async tryNext() {
      if (s.closed) throw Object.assign(new Error('closed'), { name: 'MongoAPIError' })
      reads++
      if (reads === 1 && o.failFirst) throw o.failFirst
      await (o.immediate && queue.length > 0 ? new Promise((r) => setImmediate(r)) : wait(1))
      // As MongoDB's getMore: with nothing waiting, the read waits up to maxAwaitTimeMS.
      if (queue.length === 0 && o.blockMs) await wait(o.blockMs)
      const next = queue.shift()
      if (next instanceof Error) throw next
      if (next) {
        pulled++
        token++
        return next
      }
      return null
    },
    async close() {
      s.closed = true
    },
  }
  return s
}

function setup(
  opts: {
    timing?: Partial<FeedTiming>
    writable?: () => boolean
    stream?: { blockMs?: number; failFirst?: Error; immediate?: boolean }
    openMs?: number
    startSeq?: number
    paused?: boolean
  } = {},
) {
  const streams: Array<ReturnType<typeof fakeStream>> = []
  const opened: unknown[] = []
  const sent: WatchMessage[] = []
  const ended: Array<{ reason: string; events: number }> = []
  let access: FeedAccess = { ok: true, masker: null, admin: false }
  const feed = new Feed({
    id: 'f1',
    open: async (after) => {
      opened.push(after)
      if (opts.openMs) await wait(opts.openMs)
      const s = fakeStream(opts.stream)
      streams.push(s)
      return s as unknown as StreamLike
    },
    access: () => access,
    send: (m) => sent.push(m),
    writable: opts.writable ?? (() => true),
    now: () => Date.now(),
    timing: { ...FAST, ...opts.timing },
    onEnd: (reason, events) => ended.push({ reason, events }),
    startSeq: opts.startSeq,
    paused: opts.paused,
  })
  const events = () =>
    sent.flatMap((m) => (m.type === 'events' ? m.payload.events : [])).map((e) => e.documentKey)
  return {
    feed,
    streams,
    opened,
    sent,
    ended,
    events,
    stream: () => streams.at(-1)!,
    setAccess: (a: FeedAccess) => (access = a),
  }
}

describe('a feed (phase 3e-1 spec §1.2, §1.3)', () => {
  it('sends events in batches, numbered, with how far behind they are', async () => {
    const f = setup()
    await f.feed.start()
    f.stream().push(insert(1), insert(2), insert(3))
    await until(() => f.events().length === 3)
    const batches = f.sent.filter((m) => m.type === 'events')
    // However the events fall into batches, they are numbered in order and say how far behind they are.
    expect(batches.flatMap((m) => (m.type === 'events' ? m.payload.events.map((e) => e.seq) : []))).toEqual([
      1, 2, 3,
    ])
    for (const m of batches) {
      expect(m.payload).toMatchObject({ id: 'f1' })
      expect((m.payload as { lagMs: number }).lagMs).toBeGreaterThanOrEqual(0)
    }
    expect(f.feed.count).toBe(3)
    await f.feed.end('closed', true)
  })

  it('pulls nothing while the socket cannot take more, and keeps its outbox bounded', async () => {
    let writable = false
    // 50 reads at a timer's pace took about a second on Windows, half of the wait below.
    const f = setup({
      writable: () => writable,
      timing: { outbox: 5, maxBatch: 5 },
      stream: { immediate: true },
    })
    await f.feed.start()
    for (let i = 1; i <= 50; i++) f.stream().push(insert(i))
    await wait(100)
    expect(f.stream().pulled).toBe(0)
    expect(f.sent).toEqual([])
    writable = true
    await until(() => f.events().length === 50)
    await f.feed.end('closed', true)
  })

  // Final review I6: the outbox and each batch are bounded in bytes, not only in events.
  it('stops pulling at the outbox byte budget', async () => {
    const f = setup({ timing: { flushMs: 10_000, outboxBytes: 3_000, batchBytes: 1_000_000 } })
    await f.feed.start()
    const doc = (n: number) => ({ ...insert(n), fullDocument: { _id: n, pad: 'x'.repeat(1_000) } })
    for (let i = 1; i <= 10; i++) f.stream().push(doc(i))
    await wait(100)
    // About 1 KB each: the third crosses the 3 KB budget, and pulling stops until a batch leaves.
    expect(f.stream().pulled).toBe(3)
    expect(f.feed.pending).toBe(3)
    await f.feed.end('closed', true)
  })

  it('keeps each batch within its byte budget', async () => {
    // The old feed sent all ten in one 10 KB batch at the interval; now bytes cut batches early.
    const f = setup({ timing: { flushMs: 300, batchBytes: 2_500 } })
    await f.feed.start()
    const doc = (n: number) => ({ ...insert(n), fullDocument: { _id: n, pad: 'x'.repeat(1_000) } })
    for (let i = 1; i <= 10; i++) f.stream().push(doc(i))
    await until(() => f.events().length === 10)
    const batches = f.sent.flatMap((m) => (m.type === 'events' ? [m.payload.events] : []))
    for (const b of batches) expect(b.reduce((n, e) => n + e.bytes, 0)).toBeLessThanOrEqual(2_500)
    expect(batches.flat().map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    await f.feed.end('closed', true)
  })

  it('sends at most the per-second rate', async () => {
    const f = setup({ timing: { maxPerSecond: 3, maxBatch: 3 } })
    await f.feed.start()
    for (let i = 1; i <= 10; i++) f.stream().push(insert(i))
    await wait(400)
    expect(f.events().length).toBe(3)
    await f.feed.end('closed', true)
  })

  it('stops pulling when paused; resumes here, or from now without what was pending', async () => {
    const f = setup()
    await f.feed.start()
    f.feed.pause()
    expect(f.sent.at(-1)).toEqual({ ch: 'watch', type: 'paused', payload: { id: 'f1' } })
    f.stream().push(insert(1))
    await wait(60)
    // A read already in flight may land in the outbox; nothing leaves while paused.
    expect(f.events()).toEqual([])
    await f.feed.resume('here')
    await until(() => f.events().length === 1)
    f.feed.pause()
    f.stream().push(insert(2))
    await f.feed.resume('now')
    expect(f.opened).toEqual([null, null])
    expect(f.streams[0]!.closed).toBe(true)
    expect(f.sent.at(-1)).toEqual({ ch: 'watch', type: 'resumed', payload: { id: 'f1', from: 'now' } })
    f.stream().push(insert(3))
    await until(() => f.events().length === 2)
    expect(f.events()).toEqual([{ _id: { $numberInt: '1' } }, { _id: { $numberInt: '3' } }])
    await f.feed.end('closed', true)
  })

  it('delivers an invalidate, then ends with that reason', async () => {
    const f = setup()
    await f.feed.start()
    f.stream().push(insert(1), { operationType: 'invalidate', clusterTime: new Timestamp({ t: 1, i: 1 }) })
    await until(() => f.ended.length === 1)
    expect(
      f.sent
        .filter((m) => m.type === 'events')
        .flatMap((m) => m.payload.events)
        .at(-1),
    ).toMatchObject({ op: 'invalidate' })
    expect(f.sent.at(-1)).toEqual({ ch: 'watch', type: 'ended', payload: { id: 'f1', reason: 'invalidate' } })
    expect(f.ended).toEqual([{ reason: 'invalidate', events: 2 }])
    expect(f.stream().closed).toBe(true)
  })

  it('ends with access the moment access goes, sending nothing more, also when idle (W2)', async () => {
    const f = setup({ timing: { flushMs: 10_000, maxBatch: 100 } })
    await f.feed.start()
    f.stream().push(insert(1))
    await until(() => f.stream().pulled === 1)
    f.setAccess({ ok: false, reason: 'access' })
    f.stream().push(insert(2))
    await until(() => f.ended.length === 1)
    expect(f.events()).toEqual([])
    expect(f.sent.at(-1)).toEqual({ ch: 'watch', type: 'ended', payload: { id: 'f1', reason: 'access' } })
    const idle = setup()
    await idle.feed.start()
    idle.setAccess({ ok: false, reason: 'turned_off' })
    await until(() => idle.ended.length === 1)
    expect(idle.ended[0]!.reason).toBe('turned_off')
  })

  it('says why MongoDB ended it', async () => {
    expect(reasonOf(Object.assign(new Error('x'), { code: 286 }))).toBe('history_lost')
    expect(reasonOf(Object.assign(new Error('x'), { code: 280 }))).toBe('history_lost')
    expect(reasonOf(Object.assign(new Error('x'), { codeName: 'BSONObjectTooLarge' }))).toBe(
      'event_too_large',
    )
    expect(reasonOf(Object.assign(new Error('x'), { code: 13 }))).toBe('unauthorized')
    expect(reasonOf(Object.assign(new Error('x'), { code: 40573 }))).toBe('not_replica_set')
    expect(reasonOf(Object.assign(new Error('x'), { name: 'MongoNetworkError' }))).toBe('connection')
    expect(reasonOf(new Error('x'))).toBe('internal')
    const f = setup()
    await f.feed.start()
    f.stream().push(Object.assign(new Error('lost'), { code: 286 }))
    await until(() => f.ended.length === 1)
    expect(f.sent.at(-1)).toMatchObject({ type: 'ended', payload: { reason: 'history_lost' } })
  })

  it('detaches with the token of the last event sent, not of one only pulled', async () => {
    const f = setup({ timing: { flushMs: 10_000, maxBatch: 2 } })
    await f.feed.start()
    f.stream().push(insert(1), insert(2), insert(3))
    await until(() => f.stream().pulled === 3)
    await wait(20)
    expect(f.events()).toHaveLength(2)
    expect((await f.feed.detach()).token).toEqual({ t: 2 })
    expect(f.stream().closed).toBe(true)
    expect(f.ended).toEqual([])
  })

  it('masks each batch with the rules as they are when it leaves (W3: a rules change re-masks)', async () => {
    const f = setup({ timing: { flushMs: 10_000, maxBatch: 2 } })
    await f.feed.start()
    f.stream().push({ ...insert(1), fullDocument: { _id: 1, email: 'a@x' } })
    await until(() => f.stream().pulled === 1)
    f.setAccess({
      ok: true,
      admin: false,
      masker: compileRules([{ db: 'shop', coll: 'orders', field: 'email' }]),
    })
    f.stream().push(insert(2))
    await until(() => f.events().length === 2)
    const first = f.sent.flatMap((m) => (m.type === 'events' ? m.payload.events : []))[0]!
    expect(first).toMatchObject({ fullDocument: { email: '***' }, masked: true })
    await f.feed.end('closed', true)
  })

  // Final review I4: no cursor outlives its feed, whatever the order of resume and end.
  it('closes the new cursor when the feed ends while a resume from now opens it', async () => {
    const f = setup({ openMs: 50 })
    await f.feed.start()
    f.feed.pause()
    const resuming = f.feed.resume('now')
    await wait(10)
    await f.feed.end('closed', true)
    await resuming
    expect(f.streams.every((s) => s.closed)).toBe(true)
    expect(f.sent.some((m) => m.type === 'resumed')).toBe(false)
  })

  it('takes resumes one at a time: two from now leave one cursor open', async () => {
    const f = setup({ openMs: 20 })
    await f.feed.start()
    f.feed.pause()
    await Promise.all([f.feed.resume('now'), f.feed.resume('now')])
    expect(f.streams.filter((s) => !s.closed)).toHaveLength(1)
    await f.feed.end('closed', true)
    expect(f.streams.every((s) => s.closed)).toBe(true)
  })

  // Final review M1: a batch leaves on time even while a pull waits for MongoDB.
  it('sends on its interval while a pull is waiting', async () => {
    const f = setup({ timing: { flushMs: 50 }, stream: { blockMs: 1_000 } })
    await f.feed.start()
    f.stream().push(insert(1), insert(2))
    await until(() => f.events().length === 2, 400)
    await f.feed.end('closed', true)
  })

  // Final review M11: no "paused" after "ended".
  it('says nothing about a pause when the pause found its access gone', async () => {
    const f = setup({ timing: { flushMs: 10_000 } })
    await f.feed.start()
    f.stream().push(insert(1))
    await until(() => f.stream().pulled === 1)
    f.setAccess({ ok: false, reason: 'access' })
    f.feed.pause()
    await until(() => f.ended.length === 1)
    const types = f.sent.map((m) => m.type)
    expect(types).toContain('ended')
    expect(types).not.toContain('paused')
  })

  // Final review M12: a first read that fails leaves no cursor behind.
  it('closes its cursor when the first read fails', async () => {
    const f = setup({ stream: { failFirst: Object.assign(new Error('nope'), { code: 13 }) } })
    await expect(f.feed.start()).rejects.toThrow('nope')
    expect(f.stream().closed).toBe(true)
  })

  // Final review I5: numbering continues across a resume; the batches sent are remembered.
  it('numbers from where a resume left off and remembers each batch sent with its token', async () => {
    const f = setup({ startSeq: 7, timing: { maxBatch: 1 } })
    await f.feed.start({ t: 0 })
    f.stream().push(insert(1), insert(2))
    await until(() => f.events().length === 2)
    const seqs = f.sent.flatMap((m) => (m.type === 'events' ? m.payload.events.map((e) => e.seq) : []))
    expect(seqs).toEqual([8, 9])
    const { log, seq } = await f.feed.detach()
    expect(seq).toBe(9)
    expect(log.map((l) => l.seq)).toEqual([7, 8, 9])
    expect(log.find((l) => l.seq === 8)!.token).toEqual({ t: 1 })
  })

  // Final review M10: a feed that was paused before its socket went starts paused.
  it('starts paused when asked, sending nothing until resumed', async () => {
    const f = setup({ paused: true })
    await f.feed.start()
    f.stream().push(insert(1))
    await wait(80)
    expect(f.events()).toEqual([])
    await f.feed.resume('here')
    await until(() => f.events().length === 1)
    await f.feed.end('closed', true)
  })
})
