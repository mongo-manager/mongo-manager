import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { EJSON } from 'bson'
import {
  Double,
  Int32,
  Long,
  MongoClient,
  type ChangeStreamOptions,
  type Document,
  type ResumeToken,
} from 'mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { makeApp, type TestApp } from './helpers'
import { LiveSyncWorker, WORKER_TIMING, type WorkerDeps } from '../src/livesync/worker'
import { TwoWayPair, lostKey, type ConflictNote, type Side } from '../src/livesync/twoway'
import { tsFrom, tsText, type LiveSyncRecord } from '../src/livesync/repo'
import type { StreamLike } from '../src/changestreams/feed'
import { idKey } from '../src/livesync/apply'
import { READ_OPTIONS } from '../src/data/ejson-io'
import { slow } from './support/slowness'

/**
 * W4 review C2, I6: a two-way pair's two workers on one replica set (two databases stand for the two
 * sides), with the app host's clock far off the cluster's and one direction's stream held back.
 */
let rs: MongoMemoryReplSet
let client: MongoClient
beforeAll(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  client = await new MongoClient(rs.getUri()).connect()
}, slow(180_000))
afterAll(async () => {
  await client?.close()
  await rs?.stop()
})
const apps: TestApp[] = []
const workers: LiveSyncWorker[] = []
afterEach(async () => {
  for (const w of workers.splice(0)) await w.stop()
  for (const t of apps.splice(0)) await t.close()
})

async function until(test: () => boolean | Promise<boolean>, ms = 30_000) {
  const end = Date.now() + ms
  while (!(await test())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Two sides seeded alike, and a two-way pair between them; `skewMs`: the app host's clock ahead. */
async function pair(
  skewMs: number,
  differ: Document[] = [],
  extra: { maxPending?: number; oplogStart?: () => Promise<string | null>; docs?: Document[] } = {},
) {
  const docs = extra.docs ?? [{ _id: 1, v: 'P' }]
  const t = await makeApp()
  apps.push(t)
  const repo = t.app.ctx.liveSync.repo
  const dbs = { forward: `a${randomUUID().slice(0, 8)}`, reverse: `b${randomUUID().slice(0, 8)}` }
  for (const [side, db] of Object.entries(dbs)) {
    await client.db(db).createCollection('orders', { changeStreamPreAndPostImages: { enabled: true } })
    const own = side === 'reverse' && differ.length ? differ : docs
    await client
      .db(db)
      .collection('orders')
      .insertMany(own.map((d) => ({ ...d })) as never)
  }
  const time = (await client.db(dbs.forward).command({ ping: 1 })).operationTime
  const startAt = `${tsText(time)}`.replace(/\.(\d+)$/, (_m, i: string) => `.${Number(i) + 1}`)
  const make = (side: Side, partner: string) => {
    const [from, to] = side === 'forward' ? [dbs.forward, dbs.reverse] : [dbs.reverse, dbs.forward]
    return repo.create({
      owner: 'u1',
      name: `${from} ⇄ ${to}`,
      source: { connectionId: side === 'forward' ? 'a' : 'b', db: from, coll: 'orders', collections: null },
      target: { connectionId: side === 'forward' ? 'b' : 'a', db: to, coll: 'orders' },
      options: {
        startMode: 'from_now',
        errorPolicy: 'pause',
        followNew: false,
        anonymous: false,
        masked: false,
        pairs: [['orders', 'orders']],
        twoWay: { side, partner, echo: [], lost: {} },
      },
      stamps: {
        versions: { source: 0, target: 0 },
        settings: { source: 'x', target: 'y' },
        deployments: {
          source: { kind: 'replicaSet' as const, setName: 'rs', hosts: ['h:1'] },
          target: { kind: 'replicaSet' as const, setName: 'rs', hosts: ['h:1'] },
        },
      },
      state: 'catching_up',
      startAt,
      copyJobId: null,
    })
  }
  const forward = make('forward', 'pending')
  const reverse = make('reverse', forward.id)
  repo.update(forward.id, {
    options: { ...forward.options, twoWay: { ...forward.options.twoWay!, partner: reverse.id } },
  })
  const shared = new TwoWayPair()
  const notes: ConflictNote[] = []
  /** The reverse direction's stream, held back: it answers "nothing new" without reading. */
  const gate = { held: false }
  /** The forward direction's rounds, held (its target never answers) while set. */
  const hold: { forward: Promise<void> | null } = { forward: null }
  const deps = (r: LiveSyncRecord): WorkerDeps => ({
    id: r.id,
    repo,
    check: () => ({ ok: true, maskFor: () => null }),
    copyState: () => 'done',
    open: async (from) => {
      const options: ChangeStreamOptions = {
        ...READ_OPTIONS,
        fullDocument: 'whenAvailable',
        fullDocumentBeforeChange: 'whenAvailable',
        showExpandedEvents: true,
        ...('token' in from
          ? { resumeAfter: from.token as ResumeToken }
          : { startAtOperationTime: tsFrom(from.startAt) }),
      }
      const s = client.db(r.source.db).collection('orders').watch([], options) as unknown as StreamLike
      if (r.options.twoWay!.side === 'forward') return s
      return {
        tryNext: () => (gate.held ? Promise.resolve(null) : s.tryNext()),
        get resumeToken() {
          return s.resumeToken
        },
        close: () => s.close(),
      }
    },
    source: async () => client,
    target: async () => {
      if (r.options.twoWay!.side === 'forward') while (hold.forward) await hold.forward
      return client
    },
    errorText: (_side, e) => `code ${String((e as { code?: unknown }).code)}`,
    twoWay: {
      side: r.options.twoWay!.side,
      pair: shared,
      onSession: (hex, txn) => void shared.echo.set(hex, txn),
      lost: (whose, id, at) => {
        const rec = repo.get(whose === 'forward' ? forward.id : reverse.id)!
        const tw = rec.options.twoWay!
        repo.update(rec.id, {
          options: { ...rec.options, twoWay: { ...tw, lost: { ...tw.lost, [lostKey(id)]: at } } },
        })
      },
      conflicts: (_rec, n) => void notes.push(...n),
      ...(r.options.twoWay!.side === 'forward'
        ? { maxPending: extra.maxPending, oplogStart: extra.oplogStart }
        : {}),
    },
    onChange: () => undefined,
    allowServerJs: false,
    timing: {
      ...WORKER_TIMING,
      pollMs: 20,
      idleMs: 20,
      retryMinMs: 20,
      retryMaxMs: 80,
      logEveryMs: 0,
      targetCheckMs: 200,
    },
    // The app host's clock, far ahead of the cluster's.
    now: () => Date.now() + skewMs,
  })
  const run = (r: LiveSyncRecord) => {
    const w = new LiveSyncWorker(deps(repo.get(r.id)!))
    workers.push(w)
    void w.start()
    return w
  }
  const coll = (side: Side) => client.db(dbs[side]).collection('orders')
  const doc = async (side: Side, id: unknown) => (await coll(side).findOne({ _id: id } as Document))?.v
  return { repo, forward, reverse, gate, hold, notes, run, coll, doc, shared }
}

describe('a two-way pair under clock skew (W4 review C2)', () => {
  it(
    'waits for the other stream to read past the mismatch, whatever the host clock says, and converges',
    { timeout: 120_000 },
    async () => {
      const p = await pair(60_000)
      p.run(p.forward)
      p.run(p.reverse)
      await until(
        () => p.repo.get(p.forward.id)!.state === 'live' && p.repo.get(p.reverse.id)!.state === 'live',
      )
      // The way back reads nothing for now (as if its majority commit lagged behind).
      p.gate.held = true
      await sleep(1500)
      await p.coll('reverse').updateOne({ _id: 1 } as Document, { $set: { v: 'C' } })
      await sleep(50)
      await p.coll('forward').updateOne({ _id: 1 } as Document, { $set: { v: 'PA' } })
      // The forward direction found B changed; however far ahead its clock, it does not decide alone.
      await sleep(2500)
      expect(await p.doc('reverse', 1)).toBe('C')
      expect(await p.doc('forward', 1)).toBe('PA')
      // The way back reads B's change: a conflict, the later writer (A) winning on both sides.
      p.gate.held = false
      await until(async () => (await p.doc('reverse', 1)) === 'PA' && (await p.doc('forward', 1)) === 'PA')
      await sleep(1500)
      expect([await p.doc('forward', 1), await p.doc('reverse', 1)]).toEqual(['PA', 'PA'])
      expect(p.notes.map((n) => [n.kind, n.winner])).toEqual([['both', 'forward']])
    },
  )

  it(
    'applies a change the other side merely differed on, once the other stream read past it',
    { timeout: 120_000 },
    async () => {
      // B differs from A before the pair starts (no change of B to come).
      const p = await pair(-60_000, [{ _id: 1, v: 'old' }])
      p.run(p.forward)
      p.run(p.reverse)
      await until(
        () => p.repo.get(p.forward.id)!.state === 'live' && p.repo.get(p.reverse.id)!.state === 'live',
      )
      await p.coll('forward').updateOne({ _id: 1 } as Document, { $set: { v: 'new' } })
      // The host clock a minute behind: still applied, once B's stream has passed the mismatch.
      await until(async () => (await p.doc('reverse', 1)) === 'new')
      // The write is a majority one, read here locally: the conflict may be listed just after.
      await until(() => p.notes.length > 0)
      expect(p.notes.map((n) => n.kind)).toEqual(['differed'])
    },
  )
})

describe('a change the other side refuses (W4 review I6)', () => {
  it(
    'names it, so its owner can skip it; the pair then goes on and remembers it as lost',
    { timeout: 120_000 },
    async () => {
      const p = await pair(0)
      // B refuses a value A accepts.
      await client.db(p.repo.get(p.forward.id)!.target.db).command({
        collMod: 'orders',
        validator: { v: { $ne: 'bad' } },
      })
      p.run(p.forward)
      p.run(p.reverse)
      await until(() => p.repo.get(p.forward.id)!.state === 'live')
      await p.coll('forward').updateOne({ _id: 1 } as Document, { $set: { v: 'bad' } })
      await until(() => p.repo.get(p.forward.id)!.state === 'attention')
      const stopped = p.repo.get(p.forward.id)!
      expect(stopped.reason).toBe('write_error')
      expect(stopped.skip).toMatchObject({ id: idKey(1), armed: false })
      expect(stopped.detail).toBe(`${idKey(1)} · code 121`)
      // Its owner skips it (as runner.skip does): the pair goes on; the next change is carried.
      p.repo.update(stopped.id, { skip: { ...stopped.skip!, armed: true } })
      p.repo.setState(stopped.id, 'catching_up', null, null, null)
      await workers.shift()!.stop()
      p.run(p.forward)
      await p.coll('forward').insertOne({ _id: 2, v: 'next' } as Document)
      await until(async () => (await p.doc('reverse', 2)) === 'next')
      // The change can land before the worker marks the side live again (seen under a full run).
      await until(() => p.repo.get(p.forward.id)!.state === 'live')
      const after = p.repo.get(p.forward.id)!
      expect(after.state).toBe('live')
      expect(after.counters.skipped).toBe(1)
      expect(after.skip).toBeNull()
      expect(Object.keys(after.options.twoWay!.lost)).toHaveLength(1)
      expect(await p.doc('reverse', 1)).toBe('P')
    },
  )
})

// W4 re-review I2: a change the other side merely differed on is written only where the other side
// still holds what it held when the mismatch was read.
describe('a waiting change whose other side changed again (W4 re-review I2)', () => {
  it(
    'is not forced over the newer change: the two are settled as a conflict, and the sides agree',
    { timeout: 120_000 },
    async () => {
      // B differs from A before the pair starts.
      const p = await pair(0, [{ _id: 1, v: 'old' }])
      p.run(p.forward)
      p.run(p.reverse)
      await until(
        () => p.repo.get(p.forward.id)!.state === 'live' && p.repo.get(p.reverse.id)!.state === 'live',
      )
      await p.coll('forward').updateOne({ _id: 1 } as Document, { $set: { v: 'PA' } })
      // The forward direction found B differing: it waits.
      await until(() => [...p.shared.pending.values()].some((x) => x.side === 'forward'))
      const waiting = [...p.shared.pending.values()].find((x) => x.side === 'forward')!
      let release!: () => void
      p.hold.forward = new Promise<void>((r) => (release = r))
      // The way back reads past the moment of the mismatch (another write moves the cluster's time).
      await client.db('elsewhere').collection('tick').insertOne({ at: 1 })
      await until(() => p.shared.read.reverse >= waiting.seen && p.shared.read.reverse !== '0.0')
      // Then B changes again, and the way back does not read it yet.
      p.gate.held = true
      await sleep(1500)
      await p.coll('reverse').updateOne({ _id: 1 } as Document, { $set: { v: 'D' } })
      // The forward direction's round: its change is due, but B no longer holds what it held.
      p.hold.forward = null
      release()
      await sleep(1500)
      expect(await p.doc('reverse', 1)).toBe('D')
      // The way back reads B's change: a conflict, the later writer (B) winning on both sides.
      p.gate.held = false
      await until(async () => (await p.doc('forward', 1)) === 'D' && (await p.doc('reverse', 1)) === 'D')
      await sleep(1500)
      expect([await p.doc('forward', 1), await p.doc('reverse', 1)]).toEqual(['D', 'D'])
      expect(p.notes.map((n) => [n.kind, n.winner])).toEqual([['both', 'reverse']])
    },
  )
})

// W4 re-review (minor): what waits for the other side is bounded, and never outlives the oplog.
describe('a direction whose other side lags (W4 re-review minor)', () => {
  it('stops for a person past too many waiting changes', { timeout: 120_000 }, async () => {
    const p = await pair(0, [{ _id: 1, v: 'x' }], { maxPending: 0 })
    p.run(p.forward)
    p.run(p.reverse)
    await until(() => p.repo.get(p.forward.id)!.state === 'live')
    p.gate.held = true
    await p.coll('forward').updateOne({ _id: 1 } as Document, { $set: { v: 'PA' } })
    await until(() => p.repo.get(p.forward.id)!.state === 'attention')
    expect(p.repo.get(p.forward.id)).toMatchObject({ reason: 'two_way_backlog' })
  })

  it('stops for a person before the oplog rolls past its place', { timeout: 120_000 }, async () => {
    let start: string | null = null
    const p = await pair(0, [{ _id: 1, v: 'x' }], { oplogStart: async () => start })
    p.run(p.forward)
    p.run(p.reverse)
    await until(() => p.repo.get(p.forward.id)!.state === 'live')
    p.gate.held = true
    await p.coll('forward').updateOne({ _id: 1 } as Document, { $set: { v: 'PA' } })
    await until(() => [...p.shared.pending.values()].some((x) => x.side === 'forward'))
    // The oplog now starts after the place the forward direction holds.
    start = `${Math.floor(Date.now() / 1000) + 3600}.1`
    await until(() => p.repo.get(p.forward.id)!.state === 'attention', 30_000)
    expect(p.repo.get(p.forward.id)).toMatchObject({ reason: 'two_way_backlog', detail: 'oplog' })
  })
})

// W4 re-review 2 (I1): number-like field names come first in a JavaScript object, at any depth; a
// comparison made by MongoDB in field order would never match such a document.
describe('documents with number-like field names (W4 re-review 2)', () => {
  const doc = { _id: 1, v: 'P', name: 'a', '2': 'x', n: { '2024': 1, b: 2 } }

  it('carries a change of such a document over', { timeout: 120_000 }, async () => {
    const p = await pair(0, [], { docs: [doc] })
    p.run(p.forward)
    p.run(p.reverse)
    await until(
      () => p.repo.get(p.forward.id)!.state === 'live' && p.repo.get(p.reverse.id)!.state === 'live',
    )
    await p.coll('forward').updateOne({ _id: 1 } as Document, { $set: { v: 'PA' } })
    await until(async () => (await p.doc('reverse', 1)) === 'PA')
    expect(p.notes).toEqual([])
    expect(p.shared.pending.size).toBe(0)
  })

  it('writes over such a document the other side merely differed on', { timeout: 120_000 }, async () => {
    const p = await pair(0, [{ ...doc, v: 'old' }], { docs: [doc] })
    p.run(p.forward)
    p.run(p.reverse)
    await until(
      () => p.repo.get(p.forward.id)!.state === 'live' && p.repo.get(p.reverse.id)!.state === 'live',
    )
    await p.coll('forward').updateOne({ _id: 1 } as Document, { $set: { v: 'new' } })
    await until(async () => (await p.doc('reverse', 1)) === 'new')
    await until(() => p.notes.length > 0)
    expect(p.notes.map((n) => n.kind)).toEqual(['differed'])
  })
})

describe('values with their types (W4 final review)', () => {
  // Compared with their types (canonical Extended JSON).
  const raw = async (p: Awaited<ReturnType<typeof pair>>, side: 'forward' | 'reverse') =>
    EJSON.stringify(
      (await p.coll(side).findOne({ _id: 1 } as Document, { promoteValues: false, promoteLongs: false }))!,
      {
        relaxed: false,
      },
    )

  it(
    'carries a document over with its values’ types kept, a large Long exact',
    { timeout: 120_000 },
    async () => {
      const doc = {
        _id: 1,
        big: Long.fromString('9007199254740993'),
        d: new Double(1),
        i: new Int32(1),
        n: 1,
      }
      const p = await pair(0, [], { docs: [doc] })
      p.run(p.forward)
      p.run(p.reverse)
      await until(
        () => p.repo.get(p.forward.id)!.state === 'live' && p.repo.get(p.reverse.id)!.state === 'live',
      )
      await p.coll('forward').updateOne({ _id: 1 } as Document, { $set: { n: 2 } })
      await until(async () => (await raw(p, 'reverse')).includes('"n":{"$numberInt":"2"}'))
      const there = await raw(p, 'reverse')
      expect(there).toContain('"big":{"$numberLong":"9007199254740993"}')
      expect(there).toContain('"d":{"$numberDouble":"1.0"}')
      expect(await raw(p, 'forward')).toBe(there)
      expect(p.notes).toEqual([])
    },
  )

  it(
    'sees a change of type as a change: a Double that holds an integer is not the Int32',
    { timeout: 120_000 },
    async () => {
      // B differs from A before the pair starts by the type alone.
      const p = await pair(0, [{ _id: 1, v: new Double(1) }], { docs: [{ _id: 1, v: new Int32(1) }] })
      p.run(p.forward)
      p.run(p.reverse)
      await until(
        () => p.repo.get(p.forward.id)!.state === 'live' && p.repo.get(p.reverse.id)!.state === 'live',
      )
      await p.coll('forward').updateOne({ _id: 1 } as Document, { $set: { v: 2 } })
      // A's change found B holding something else than A's pre-image: written once B's stream moved
      // past (listed as such), never as if B held A's pre-image.
      await until(() => p.notes.length > 0, 60_000)
      expect(p.notes.map((n) => n.kind)).toEqual(['differed'])
      expect(await raw(p, 'reverse')).toBe(await raw(p, 'forward'))
    },
  )
})
