// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  MongoBulkWriteError,
  MongoClient,
  MongoNetworkError,
  MongoServerError,
  Timestamp,
  type Document,
} from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { driverWrapped } from './support/driver-wrap'
import { serverError } from '../src/data/mongo-errors'
import { makeApp, type TestApp } from './helpers'
import {
  LiveSyncWorker,
  REJECTED_FULL,
  WORKER_TIMING,
  type CheckResult,
  type WorkerDeps,
} from '../src/livesync/worker'
import { tsText, type NewLiveSync } from '../src/livesync/repo'
import { idKey } from '../src/livesync/apply'
import { ConnectionError } from '../src/connections/errors'
import type { StreamLike } from '../src/changestreams/feed'
import { slow } from './support/slowness'

let mongo: MongoMemoryServer
let client: MongoClient
beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  client = await new MongoClient(mongo.getUri()).connect()
}, slow(120_000))
afterAll(async () => {
  await client?.close()
  await mongo?.stop()
})
const apps: TestApp[] = []
const workers: LiveSyncWorker[] = []
afterEach(async () => {
  for (const w of workers.splice(0)) await w.stop()
  for (const t of apps.splice(0)) await t.close()
})

let tick = 0
/** A change event of the source database `src` with its token, cluster time and wall time. */
function ev(op: string, coll: string, id: unknown, doc?: Document, extra: Document = {}): Document {
  const clusterTime = new Timestamp({ t: 1000, i: ++tick })
  return {
    _id: { _data: `tok-${clusterTime.i}` },
    operationType: op,
    ns: { db: 'src', coll },
    clusterTime,
    wallTime: new Date(),
    documentKey: { _id: id },
    // A data change carries the document as it is now (as with fullDocument: 'updateLookup').
    ...(['insert', 'update', 'replace'].includes(op) ? { fullDocument: { _id: id, ...doc } } : {}),
    ...extra,
  }
}

/** A resume token carrying a cluster time, as MongoDB's `_data` starts with it ("82" + t + i). */
const hwmToken = (t: number, i: number) => ({
  _data: `82${t.toString(16).padStart(8, '0')}${i.toString(16).padStart(8, '0')}2B0229296E04`,
})

/**
 * A stream over `events`, then idle; `fail` throws once before the event at that index; `hwm` is
 * the high-water mark token an idle stream reports (its postBatchResumeToken).
 */
function stream(events: Document[], fail?: { at: number; error: unknown }, hwm?: { t: number; i: number }) {
  let i = 0
  let closed = false
  return {
    async tryNext() {
      if (fail && i === fail.at) {
        const e = fail.error
        fail = undefined
        throw e
      }
      return i < events.length ? events[i++]! : null
    },
    get resumeToken() {
      if (hwm && i >= events.length) return hwmToken(hwm.t, hwm.i)
      return i > 0 ? events[i - 1]!._id : null
    },
    async close() {
      closed = true
    },
    closed: () => closed,
  } satisfies StreamLike & { closed(): boolean }
}

async function until(test: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms
  while (!(await test())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function setup(over: Partial<NewLiveSync> = {}, deps: Partial<WorkerDeps> = {}) {
  const t = await makeApp()
  apps.push(t)
  const repo = t.app.ctx.liveSync.repo
  const db = `t${randomUUID().slice(0, 8)}`
  const record = repo.create({
    owner: 'u1',
    name: 'src.orders ⇄ orders',
    source: { connectionId: 'a', db: 'src', coll: 'orders', collections: null },
    target: { connectionId: 'b', db, coll: 'orders' },
    options: {
      startMode: 'from_now',
      errorPolicy: 'pause',
      followNew: false,
      anonymous: false,
      masked: false,
      pairs: [['orders', 'orders']],
    },
    stamps: {
      versions: { source: 0, target: 0 },
      settings: { source: 'x', target: 'y' },
      deployments: {
        source: { kind: 'replicaSet' as const, setName: 'a', hosts: ['a:1'] },
        target: { kind: 'replicaSet' as const, setName: 'b', hosts: ['b:1'] },
      },
    },
    state: 'catching_up',
    startAt: '1000.0',
    copyJobId: null,
    ...over,
  })
  const streams: Array<StreamLike | Error> = []
  const opened: unknown[] = []
  const states: string[] = []
  const d: WorkerDeps = {
    id: record.id,
    repo,
    check: () => ({ ok: true, maskFor: () => null }),
    copyState: () => 'done',
    open: async (from) => {
      opened.push(from)
      const next = streams.shift() ?? stream([])
      if (next instanceof Error) throw next
      return next
    },
    source: async () => client,
    target: async () => client,
    errorText: (_side, e) => `code ${String((e as { code?: unknown }).code)}`,
    onChange: (r) => states.push(r.state),
    allowServerJs: false,
    timing: {
      ...WORKER_TIMING,
      pollMs: 10,
      idleMs: 10,
      retryMinMs: 10,
      retryMaxMs: 40,
      logEveryMs: 0,
      targetCheckMs: 50,
    },
    now: Date.now,
    ...deps,
  }
  const run = () => {
    const w = new LiveSyncWorker(d)
    workers.push(w)
    void w.start()
    return w
  }
  const get = () => repo.get(record.id)!
  return {
    t,
    repo,
    db,
    record,
    streams,
    opened,
    states,
    d,
    run,
    get,
    coll: client.db(db).collection('orders'),
  }
}

describe('the worker applies changes (phase 3e-2 spec §1.4)', () => {
  it('applies inserts, updates and deletes, saves its place and goes live', async () => {
    const s = await setup()
    await s.coll.insertOne({ _id: 'gone' as never, n: 0 })
    const events = [
      ev('insert', 'orders', 'a', { n: 1 }),
      ev('update', 'orders', 'a', { n: 2 }),
      ev('delete', 'orders', 'gone'),
    ]
    s.streams.push(stream(events))
    s.run()
    await until(() => s.get().state === 'live')
    expect(await s.coll.find().toArray()).toEqual([{ _id: 'a', n: 2 }])
    expect(s.get().counters).toMatchObject({ inserted: 1, replaced: 1, deleted: 1, batches: 1, lagMs: 0 })
    expect(s.get().placeTime).toBe(tsText(events[2]!.clusterTime))
    expect(s.repo.place(s.record.id)!.token).toEqual(events[2]!._id)
    expect(s.opened).toEqual([{ startAt: '1000.0' }])
  })

  it('applies the same batch twice to the same result (a restart replays at most the last batch)', async () => {
    const s = await setup()
    await s.coll.insertOne({ _id: 'gone' as never, n: 0 })
    const events = [
      ev('insert', 'orders', 'a', { n: 1 }),
      ev('update', 'orders', 'a', { n: 2 }),
      ev('delete', 'orders', 'gone'),
      ev('insert', 'orders', 'b'),
    ]
    s.streams.push(stream(events))
    const first = s.run()
    await until(() => s.get().state === 'live')
    const once = await s.coll.find({}, { sort: { _id: 1 } }).toArray()
    await first.stop()
    s.repo.savePlace(s.record.id, { token: { _data: 'before' }, time: '1000.0' }, s.get().counters)
    s.streams.push(stream(events))
    s.run()
    await until(() => s.opened.length === 2 && s.get().counters.batches === 2)
    expect(await s.coll.find({}, { sort: { _id: 1 } }).toArray()).toEqual(once)
  })

  it('resumes after its sealed place', async () => {
    const s = await setup()
    s.repo.savePlace(s.record.id, { token: { _data: 'tok-saved' }, time: '1000.9' }, s.get().counters)
    s.run()
    await until(() => s.opened.length === 1)
    expect(s.opened).toEqual([{ token: { _data: 'tok-saved' } }])
  })

  it('opens no stream once it is stopped (a stop while it looks at its targets)', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let asked = 0
    const s = await setup({}, { target: async () => (++asked, await gate, client) })
    const w = s.run()
    await until(() => asked > 0)
    const stopped = w.stop()
    release()
    await stopped
    expect(s.opened).toEqual([])
  })

  it('masks what it writes for a masked sync', async () => {
    const s = await setup({}, { check: () => ({ ok: true, maskFor: () => [['email']] }) })
    s.streams.push(stream([ev('insert', 'orders', 1, { email: 'a@x', n: 1 })]))
    s.run()
    await until(() => s.get().state === 'live')
    expect(await s.coll.findOne({ _id: 1 as never })).toEqual({ _id: 1, email: '***', n: 1 })
  })

  it('keeps every batch within 1,000 changes', async () => {
    const s = await setup()
    s.streams.push(stream(Array.from({ length: 2500 }, (_, i) => ev('insert', 'orders', i, { i }))))
    s.run()
    // "Live" can come after the first batch (the changes are fresh): wait for all of them.
    await until(() => s.get().counters.inserted === 2500, 30_000)
    expect(await s.coll.countDocuments()).toBe(2500)
    expect(s.get().counters.batches).toBe(3)
  }, 60_000)

  it('keeps every batch within 8 MiB', async () => {
    const s = await setup()
    const big = 'x'.repeat(3 * 1024 * 1024)
    s.streams.push(stream(Array.from({ length: 5 }, (_, i) => ev('insert', 'orders', i, { big }))))
    s.run()
    await until(() => s.get().counters.inserted === 5, 30_000)
    expect(await s.coll.countDocuments()).toBe(5)
    expect(s.get().counters.batches).toBe(2)
  }, 60_000)
})

describe('the worker and the initial copy (plan rulings 1, 2)', () => {
  it('waits for its copy, then reads the changes from T0', async () => {
    let polls = 0
    const s = await setup(
      { state: 'copying', copyJobId: 'job' },
      { copyState: () => (++polls < 3 ? 'running' : 'done') },
    )
    s.run()
    await until(() => s.get().state === 'live')
    expect(polls).toBeGreaterThanOrEqual(3)
    expect(s.opened).toEqual([{ startAt: '1000.0' }])
    expect(s.get().copiedAt).toEqual(expect.any(Number))
  })

  it('says a copy that failed, or that a restart interrupted', async () => {
    for (const [state, reason] of [
      ['failed', 'copy_failed'],
      ['cancelled', 'copy_failed'],
      ['interrupted', 'copy_interrupted'],
      ['unknown', 'copy_interrupted'],
    ] as const) {
      const s = await setup({ state: 'copying', copyJobId: 'job' }, { copyState: () => state })
      s.run()
      await until(() => s.get().state === 'attention')
      expect(s.get().reason).toBe(reason)
      expect(s.opened).toEqual([])
    }
  })
})

describe('the worker checks and stops (phase 3e-2 spec §3.1, §1.7)', () => {
  it('reads the owner’s rights before every batch, and stops before the next one', async () => {
    let checks = 0
    const check = (): CheckResult =>
      ++checks === 1
        ? { ok: true, maskFor: () => null }
        : { ok: false, state: 'attention', reason: 'owner_access' }
    const s = await setup({}, { check })
    s.streams.push(stream(Array.from({ length: 1500 }, (_, i) => ev('insert', 'orders', i))))
    s.run()
    await until(() => s.get().state === 'attention')
    expect(s.get().reason).toBe('owner_access')
    expect(await s.coll.countDocuments()).toBe(1000)
  })

  it('pauses on a document the target refuses, and skips it once when told', async () => {
    const s = await setup()
    await s.coll.createIndex({ email: 1 }, { unique: true })
    await s.coll.insertOne({ _id: 9 as never, email: 'taken' })
    const refused = ev('insert', 'orders', 1, { email: 'taken' })
    s.streams.push(stream([refused]))
    s.run()
    await until(() => s.get().state === 'attention')
    const r = s.get()
    expect(r.reason).toBe('write_error')
    expect(r.detail).toContain(idKey(1))
    expect(r.detail).toContain('11000')
    expect(r.skip).toEqual({ id: idKey(1), at: tsText(refused.clusterTime), armed: false, ns: 'src.orders' })
    expect(s.repo.place(s.record.id)).toBeNull()
    // "Skip this document", then resume: the same changes come again, and one more.
    s.repo.update(s.record.id, { skip: { ...r.skip!, armed: true } })
    s.repo.setState(s.record.id, 'catching_up')
    s.streams.push(stream([refused, ev('insert', 'orders', 2, { email: 'free' })]))
    s.run()
    await until(() => s.get().state === 'live')
    expect(await s.coll.find({}, { sort: { _id: 1 } }).toArray()).toEqual([
      { _id: 2, email: 'free' },
      { _id: 9, email: 'taken' },
    ])
    expect(s.get()).toMatchObject({ skip: null, counters: { skipped: 1 } })
  })

  it('records a refused document and carries on under "skip and record"', async () => {
    const s = await setup({
      options: {
        startMode: 'from_now',
        errorPolicy: 'skip',
        followNew: false,
        anonymous: false,
        masked: false,
        pairs: [['orders', 'orders']],
      },
    })
    await s.coll.createIndex({ email: 1 }, { unique: true })
    await s.coll.insertOne({ _id: 9 as never, email: 'taken' })
    s.streams.push(
      stream([ev('insert', 'orders', 1, { email: 'taken' }), ev('insert', 'orders', 2, { email: 'free' })]),
    )
    s.run()
    await until(() => s.get().state === 'live')
    expect(s.get().counters.skipped).toBe(1)
    expect(await s.coll.countDocuments()).toBe(2)
    expect(s.repo.events(s.record.id).filter((e) => e.kind === 'skipped')).toEqual([
      expect.objectContaining({ detail: expect.stringContaining(idKey(1)) }),
    ])
  })

  it('keeps the refused documents, as written, for the rejected-records file (W4.6)', async () => {
    const kept: Document[] = []
    const room = true
    const s = await setup(
      {
        options: {
          startMode: 'from_now',
          errorPolicy: 'skip',
          followNew: false,
          anonymous: false,
          masked: false,
          pairs: [['orders', 'orders']],
        },
      },
      {
        reject: async (_r, docs) => {
          if (!room) return 0
          kept.push(...docs)
          return docs.length
        },
      },
    )
    await s.coll.createIndex({ email: 1 }, { unique: true })
    await s.coll.insertOne({ _id: 9 as never, email: 'taken' })
    s.streams.push(
      stream([
        ev('insert', 'orders', 1, { email: 'taken' }),
        ev('insert', 'orders', 2, { email: 'free' }),
        ev('insert', 'orders', 3, { email: 'taken' }),
      ]),
    )
    s.run()
    await until(() => s.get().state === 'live')
    expect(kept).toEqual([
      { _id: 1, email: 'taken' },
      { _id: 3, email: 'taken' },
    ])
    expect(room).toBe(true)
  })

  it('keeps its lag in the history, once a bucket unless it grows (W4.6)', async () => {
    const s = await setup()
    const sampled: number[] = []
    const real = s.repo.sampleLag.bind(s.repo)
    s.repo.sampleLag = (id, at, lag) => {
      sampled.push(lag)
      real(id, at, lag)
    }
    s.streams.push(stream([ev('insert', 'orders', 1), ev('insert', 'orders', 2)]))
    s.run()
    await until(() => s.get().state === 'live')
    await new Promise((r) => setTimeout(r, 200))
    expect(s.repo.lagHistory(s.record.id, 0).length).toBeGreaterThan(0)
    // Idle rounds every 10 ms over 200 ms: a few writes in all, not one a round.
    expect(sampled.length).toBeLessThan(5)
  })

  it('still skips and logs a refused document when the owner’s space is full, and says so once', async () => {
    const s = await setup(
      {
        options: {
          startMode: 'from_now',
          errorPolicy: 'skip',
          followNew: false,
          anonymous: false,
          masked: false,
          pairs: [['orders', 'orders']],
        },
      },
      { reject: async () => 0 },
    )
    await s.coll.createIndex({ email: 1 }, { unique: true })
    await s.coll.insertOne({ _id: 9 as never, email: 'taken' })
    s.streams.push(
      stream([ev('insert', 'orders', 1, { email: 'taken' }), ev('insert', 'orders', 3, { email: 'taken' })]),
    )
    s.run()
    await until(() => s.get().state === 'live')
    expect(s.get().counters.skipped).toBe(2)
    const events = s.repo.events(s.record.id)
    expect(events.filter((e) => e.kind === 'skipped')).toHaveLength(2)
    expect(events.filter((e) => e.detail === REJECTED_FULL)).toHaveLength(1)
  })

  it('retries a side it cannot reach with a growing delay, then carries on', async () => {
    const s = await setup()
    s.streams.push(
      new MongoNetworkError('down'),
      new MongoNetworkError('down'),
      stream([ev('insert', 'orders', 1)]),
    )
    const w = s.run()
    await until(() => s.states.includes('retrying'))
    expect(w.retryAt).toEqual(expect.any(Number))
    await until(() => s.get().state === 'live')
    expect(w.retryAt).toBeNull()
    expect(await s.coll.countDocuments()).toBe(1)
    expect(s.opened).toHaveLength(3)
  })

  it('retries when a connection cannot be opened at all (the manager’s own error)', async () => {
    const s = await setup()
    s.streams.push(new ConnectionError('network', 'cannot reach'), stream([ev('insert', 'orders', 1)]))
    s.run()
    await until(() => s.states.includes('retrying'))
    await until(() => s.get().state === 'live')
    expect(await s.coll.countDocuments()).toBe(1)
  })

  it('retries a write the target could not take, and never moves past it (no change lost)', async () => {
    // Port 1 refuses: the driver reports the bulk write as failed with no per-document error.
    const dead = new MongoClient('mongodb://127.0.0.1:1/?directConnection=true&serverSelectionTimeoutMS=300')
    let calls = 0
    const s = await setup({}, { target: async () => (++calls <= 2 ? dead : client) })
    try {
      const kept = ev('insert', 'orders', 'kept')
      // A retry reopens the stream from the place: the same change comes again.
      s.streams.push(stream([kept]), stream([kept]))
      s.run()
      await until(() => s.states.includes('retrying'))
      expect(s.repo.place(s.record.id)).toBeNull()
      await until(async () => (await s.coll.countDocuments({ _id: 'kept' as never })) === 1)
      await until(() => s.get().counters.inserted === 1)
    } finally {
      await dead.close()
    }
  })

  it('fails when the source’s history no longer reaches its place', async () => {
    const s = await setup()
    s.streams.push(
      stream([ev('insert', 'orders', 1)], {
        at: 0,
        error: new MongoServerError({ code: 286, errmsg: 'lost' }),
      }),
    )
    s.run()
    await until(() => s.get().state === 'failed')
    expect(s.get().reason).toBe('history_lost')
  })

  it('fails on a fault of its own instead of retrying forever', async () => {
    const s = await setup()
    s.streams.push(
      new TypeError('a bug') as Error,
      new TypeError('a bug') as Error,
      new TypeError('a bug') as Error,
    )
    s.run()
    await until(() => s.get().state === 'failed')
    expect(s.get().reason).toBe('internal')
  })

  it('stops at once when asked, closing its stream', async () => {
    const s = await setup()
    const idle = stream([])
    s.streams.push(idle)
    const w = s.run()
    await until(() => s.opened.length === 1)
    const started = Date.now()
    await w.stop()
    expect(Date.now() - started).toBeLessThan(1000)
    expect(idle.closed()).toBe(true)
  })
})

describe('the worker and schema changes (phase 3e-2 spec §1.4, plan rulings 12, 13)', () => {
  it('builds the indexes the source builds, and drops the ones it drops', async () => {
    const s = await setup()
    const index = { v: 2, key: { n: 1 }, name: 'n_1' }
    s.streams.push(
      stream([
        ev('insert', 'orders', 1, { n: 1 }),
        ev('createIndexes', 'orders', null, undefined, { operationDescription: { indexes: [index] } }),
      ]),
    )
    s.run()
    // The collection appears with the first write: until then there are no indexes to list.
    await until(async () => (await s.coll.indexes().catch(() => [])).some((i) => i.name === 'n_1'))
    const later = await setup({ target: s.record.target })
    later.streams.push(
      stream([ev('dropIndexes', 'orders', null, undefined, { operationDescription: { indexes: [index] } })]),
    )
    later.run()
    await until(async () => !(await s.coll.indexes()).some((i) => i.name === 'n_1'))
  })

  it('stops for a person on new options, and on a dropped source, never dropping the target', async () => {
    for (const [op, reason] of [
      ['modify', 'schema_changed'],
      ['drop', 'source_gone'],
      ['rename', 'source_gone'],
    ] as const) {
      const s = await setup()
      s.streams.push(stream([ev('insert', 'orders', 1), ev(op, 'orders', null)]))
      s.run()
      await until(() => s.get().state === 'attention')
      expect(s.get()).toMatchObject({ reason, detail: 'src.orders' })
      expect(await s.coll.countDocuments()).toBe(1)
    }
  })

  // CI 2026-10-22 (Windows): a schema change is a batch of its own, and the sync is live after it,
  // its next batch still to write; a slow target, as a loaded runner's was, shows it each time.
  it('follows a new collection with the source’s options, and leaves views alone', async () => {
    const src = `s${randomUUID().slice(0, 8)}`
    const s = await setup(
      {
        source: { connectionId: 'a', db: src, coll: null, collections: null },
        target: { connectionId: 'b', db: `t${randomUUID().slice(0, 8)}`, coll: null },
        options: {
          startMode: 'from_now',
          errorPolicy: 'pause',
          followNew: true,
          anonymous: false,
          masked: false,
          pairs: [],
        },
      },
      {
        target: async () => {
          await new Promise((r) => setTimeout(r, 300))
          return client
        },
      },
    )
    await client.db(src).createCollection('fresh', { validator: { n: { $type: 'int' } } })
    await client.db(src).createCollection('seen', { viewOn: 'fresh', pipeline: [] })
    const at = (e: Document) => ({ ...e, ns: { db: src, coll: e.ns.coll } })
    s.streams.push(
      stream([
        at(ev('create', 'fresh', null)),
        at(ev('insert', 'fresh', 1, { n: 1 })),
        at(ev('create', 'seen', null)),
      ]),
    )
    s.run()
    // Caught up: every change read and written, the view's too, and the stream idle.
    await until(() => s.get().state === 'live' && s.get().counters.caughtUpAt !== null)
    const [info] = await client
      .db(s.record.target.db)
      .listCollections({ name: 'fresh' }, { nameOnly: false })
      .toArray()
    expect(info?.options).toMatchObject({ validator: { n: { $type: 'int' } } })
    expect(await client.db(s.record.target.db).collection('fresh').countDocuments()).toBe(1)
    expect(await client.db(s.record.target.db).listCollections({ name: 'seen' }).toArray()).toEqual([])
    expect(s.get().options.pairs).toEqual([['fresh', 'fresh']])
  })

  // Security audit 2026-10-16 (Important 4): where its checks withhold file contents, the worker writes
  // no GridFS change, even of a bucket it carries.
  it('writes no file contents where its checks withhold them', async () => {
    const s = await setup(
      {
        options: {
          startMode: 'from_now',
          errorPolicy: 'pause',
          followNew: false,
          anonymous: true,
          masked: true,
          pairs: [
            ['orders', 'orders'],
            ['fs.chunks', 'fs.chunks'],
          ],
        },
      },
      {
        check: () => ({
          ok: true,
          maskFor: () => null,
          withholdFiles: (_db, coll) => coll.startsWith('fs.'),
        }),
      },
    )
    s.streams.push(stream([ev('insert', 'fs.chunks', 1, { data: 'secret' }), ev('insert', 'orders', 2)]))
    s.run()
    await until(async () => (await s.coll.countDocuments()) === 1)
    expect(await client.db(s.record.target.db).collection('fs.chunks').countDocuments()).toBe(0)
    // Independent review (minor): the activity log says so — once the batch is written, which the
    // count above can see first (CI 2026-10-18: it failed on MongoDB 6.0, alone too).
    const withheld =
      'src.fs.chunks: GridFS file contents are withheld: they cannot be masked, nor checked against the target rules'
    await until(() => s.repo.events(s.record.id).some((e) => e.detail === withheld))
    // Second review (minor): once per collection and sync — not a line a batch crowding the log out,
    // nor again after a restart.
    const worker = workers.at(-1)!
    await worker.stop()
    s.streams.push(stream([ev('insert', 'fs.chunks', 3, { data: 'more' }), ev('insert', 'orders', 4)]))
    s.run()
    await until(async () => (await s.coll.countDocuments()) === 2)
    const notes = s.repo
      .events(s.record.id)
      .filter(
        (e) =>
          e.detail ===
          'src.fs.chunks: GridFS file contents are withheld: they cannot be masked, nor checked against the target rules',
      )
    expect(notes).toHaveLength(1)
  })

  // Security audit 2026-10-16 (Important 3): a masked sync's followed collection is created without a
  // validator that names a value masking would change, and the activity log says so.
  it('creates a followed collection without a validator holding a masked value', async () => {
    const src = `s${randomUUID().slice(0, 8)}`
    const s = await setup(
      {
        source: { connectionId: 'a', db: src, coll: null, collections: null },
        target: { connectionId: 'b', db: `t${randomUUID().slice(0, 8)}`, coll: null },
        options: {
          startMode: 'from_now',
          errorPolicy: 'pause',
          followNew: true,
          anonymous: true,
          masked: true,
          pairs: [],
        },
      },
      { check: () => ({ ok: true, maskFor: (_db, coll) => (coll === 'fresh' ? [['email']] : null) }) },
    )
    await client.db(src).createCollection('fresh', { validator: { email: { $ne: 'ceo@corp.example' } } })
    await client.db(src).createCollection('plain', { validator: { n: { $type: 'int' } } })
    const at = (e: Document) => ({ ...e, ns: { db: src, coll: e.ns.coll } })
    s.streams.push(stream([at(ev('create', 'fresh', null)), at(ev('create', 'plain', null))]))
    s.run()
    await until(() => s.get().options.pairs.length === 2)
    const infos = await client.db(s.record.target.db).listCollections({}, { nameOnly: false }).toArray()
    const options = (name: string) => infos.find((i) => i.name === name)?.options
    expect(options('fresh')).toBeDefined()
    expect(JSON.stringify(options('fresh'))).not.toContain('ceo@corp.example')
    expect(options('plain')).toMatchObject({ validator: { n: { $type: 'int' } } })
    const log = s.repo.events(s.record.id).map((e) => e.detail ?? '')
    expect(log.some((d) => /fresh.*validator/.test(d))).toBe(true)
  })
})

describe('the worker finishes (phase 3e-2 spec §1.6, plan ruling 14)', () => {
  it('applies every change up to T1 and nothing after it', async () => {
    const events = [
      ev('insert', 'orders', 1),
      ev('insert', 'orders', 2),
      ev('insert', 'orders', 3),
      ev('insert', 'orders', 4),
    ]
    const t1 = tsText(events[2]!.clusterTime)
    const s = await setup({ state: 'cutting_over' })
    s.repo.update(s.record.id, { finish: { t1, at: Date.now(), verify: false } })
    s.streams.push(stream(events))
    s.run()
    await until(() => s.get().state === 'completed')
    expect((await s.coll.find({}, { sort: { _id: 1 } }).toArray()).map((d) => d._id)).toEqual([1, 2, 3])
    expect(s.get().finishedAt).toEqual(expect.any(Number))
  })

  it('finishes once the stream’s high-water mark passes T1, and not before', async () => {
    const s = await setup({ state: 'cutting_over' })
    s.repo.update(s.record.id, { finish: { t1: '1000.900000', at: Date.now(), verify: false } })
    s.streams.push(stream([ev('insert', 'orders', 1)], undefined, { t: 1000, i: 900_000 }))
    s.run()
    // Up to T1 exactly is not past it: the sync waits.
    await new Promise((r) => setTimeout(r, 300))
    expect(s.get().state).toBe('cutting_over')
    await s.d.repo.setState(s.record.id, 'cutting_over')
    const later = await setup({ state: 'cutting_over' })
    later.repo.update(later.record.id, { finish: { t1: '1000.900000', at: Date.now(), verify: false } })
    later.streams.push(stream([ev('insert', 'orders', 1)], undefined, { t: 1000, i: 900_001 }))
    later.run()
    await until(() => later.get().state === 'completed')
    expect(await later.coll.countDocuments()).toBe(1)
  })

  it('I4: applies every change at T1 even when they fill more than one batch (a transaction)', async () => {
    const s = await setup({ state: 'cutting_over' })
    const at = new Timestamp({ t: 1000, i: 777_777 })
    const same = Array.from({ length: 1500 }, (_, i) => ({ ...ev('insert', 'orders', i), clusterTime: at }))
    s.repo.update(s.record.id, { finish: { t1: '1000.777777', at: Date.now(), verify: false } })
    s.streams.push(stream(same, undefined, { t: 1000, i: 777_778 }))
    s.run()
    await until(() => s.get().state === 'completed', 30_000)
    expect(await s.coll.countDocuments()).toBe(1500)
  }, 60_000)

  it('verifies at the end when asked', async () => {
    const verified: string[] = []
    const s = await setup({ state: 'cutting_over' }, { verify: async (r) => void verified.push(r.id) })
    s.repo.update(s.record.id, { finish: { t1: '1000.0', at: Date.now(), verify: true } })
    s.streams.push(stream([], undefined, { t: 1000, i: 1 }))
    s.run()
    await until(() => s.get().state === 'completed')
    expect(verified).toEqual([s.record.id])
  })
})

describe('the worker’s edges (phase 3e-2)', () => {
  it('does nothing for a sync that is not running, and stops a copying one its checks refuse', async () => {
    const paused = await setup({ state: 'paused' })
    await paused.run().start()
    expect(paused.opened).toEqual([])
    const copying = await setup(
      { state: 'copying', copyJobId: 'job' },
      {
        copyState: () => 'running',
        check: () => ({ ok: false, state: 'attention', reason: 'owner_access' }),
      },
    )
    copying.run()
    await until(() => copying.get().state === 'attention')
    expect(copying.get().reason).toBe('owner_access')
  })

  it('fails a sync with neither a place nor a start (a fault of ours)', async () => {
    const s = await setup({ startAt: null })
    s.run()
    await until(() => s.get().state === 'failed')
    expect(s.get().reason).toBe('internal')
  })

  it('stops when masking would hide _id, and ignores other databases', async () => {
    const s = await setup({}, { check: () => ({ ok: true, maskFor: () => [['_id']] }) })
    const elsewhere = { ...ev('insert', 'orders', 'x'), ns: { db: 'other', coll: 'orders' } }
    s.streams.push(stream([elsewhere, ev('insert', 'orders', 1)]))
    s.run()
    await until(() => s.get().state === 'attention')
    expect(s.get()).toMatchObject({ reason: 'rules_changed' })
    expect(await s.coll.countDocuments()).toBe(0)
  })

  it('waits for a person when the target cannot build an index, and passes indexes or collections already there', async () => {
    const s = await setup()
    await s.coll.createIndex({ n: 1 }, { name: 'clash' })
    s.streams.push(
      stream([
        ev('dropIndexes', 'orders', null, undefined, {
          operationDescription: { indexes: [{ name: 'never_there', key: { z: 1 } }] },
        }),
        ev('create', 'orders', null),
        ev('createIndexes', 'orders', null, undefined, {
          operationDescription: { indexes: [{ key: { m: 1 }, name: 'clash' }] },
        }),
      ]),
    )
    s.run()
    await until(() => s.get().state === 'attention')
    expect(s.get()).toMatchObject({ reason: 'schema_changed' })
    // IndexOptionsConflict (85) or IndexKeySpecsConflict (86): a person decides.
    expect(s.get().detail).toMatch(/code 8[56]$/)
  })

  it('does not follow a new time series collection, and says so in the log', async () => {
    const src = `s${randomUUID().slice(0, 8)}`
    const s = await setup({
      source: { connectionId: 'a', db: src, coll: null, collections: null },
      target: { connectionId: 'b', db: `t${randomUUID().slice(0, 8)}`, coll: null },
      options: {
        startMode: 'from_now',
        errorPolicy: 'pause',
        followNew: true,
        anonymous: false,
        masked: false,
        pairs: [],
      },
    })
    await client.db(src).createCollection('series', { timeseries: { timeField: 't' } })
    s.streams.push(stream([{ ...ev('create', 'series', null), ns: { db: src, coll: 'series' } }]))
    s.run()
    await until(() => (s.get().options.ignored ?? []).includes('series'))
    expect(
      s.repo.events(s.record.id).some((e) => e.kind === 'schema' && e.detail?.includes('time series')),
    ).toBe(true)
  })

  it('keeps finishing while changes before T1 are still coming', async () => {
    // Each batch's outcome as the worker reports it: polling for "one batch done" could miss it when
    // both batches land within one poll (the test then waited forever on a finished sync).
    const seen: Array<[string, number]> = []
    const s = await setup(
      { state: 'cutting_over' },
      { onChange: (r) => seen.push([r.state, r.counters.batches]) },
    )
    s.repo.update(s.record.id, { finish: { t1: '9999.0', at: Date.now(), verify: false } })
    s.streams.push(
      stream(
        Array.from({ length: 1500 }, (_, i) => ev('insert', 'orders', i)),
        undefined,
        { t: 10_000, i: 1 },
      ),
    )
    s.run()
    await until(() => s.get().state === 'completed', 30_000)
    // After the first 1,000 it was still finishing: the changes before T1 had not all come.
    expect(seen).toContainEqual(['cutting_over', 1])
    expect(s.get().counters.batches).toBe(2)
    expect(await s.coll.countDocuments()).toBe(1500)
  }, 60_000)
})

describe('final review fixes in the worker (phase 3e-2)', () => {
  it('I8: waits for a person on an error that cannot fix itself, naming it', async () => {
    for (const [code, word] of [
      [10334, 'event_too_large'],
      [13, 'unauthorized'],
    ] as const) {
      const s = await setup()
      s.streams.push(
        stream([ev('insert', 'orders', 1)], { at: 0, error: new MongoServerError({ code, errmsg: 'x' }) }),
      )
      s.run()
      await until(() => s.get().state === 'attention')
      expect(s.get()).toMatchObject({ reason: 'stream_error', detail: word })
    }
  })

  it('I9: fails when its target collection was dropped behind it, and says so', async () => {
    const s = await setup()
    s.streams.push(stream([ev('insert', 'orders', 1)]))
    s.run()
    await until(async () => (await s.coll.countDocuments()) === 1)
    await until(() => Object.keys(s.get().stamps.targets ?? {}).length === 1)
    await s.coll.drop()
    await until(() => s.get().state === 'failed')
    expect(s.get().reason).toBe('target_gone')
  })

  it('m1: guards _id masking by the source collection’s rules, not the target’s name', async () => {
    const s = await setup(
      {
        target: { connectionId: 'b', db: `t${randomUUID().slice(0, 8)}`, coll: 'renamed' },
        options: {
          startMode: 'from_now',
          errorPolicy: 'pause',
          followNew: false,
          anonymous: false,
          masked: false,
          pairs: [['orders', 'renamed']],
        },
      },
      { check: () => ({ ok: true, maskFor: (_db, coll) => (coll === 'orders' ? [['_id']] : null) }) },
    )
    s.streams.push(stream([ev('insert', 'orders', 1)]))
    s.run()
    await until(() => s.get().state === 'attention')
    expect(s.get()).toMatchObject({ reason: 'rules_changed', detail: 'src.orders' })
  })

  it('m2: logs a skipped document by its _id and code, never MongoDB’s words', async () => {
    const s = await setup(
      {
        options: {
          startMode: 'from_now',
          errorPolicy: 'skip',
          followNew: false,
          anonymous: false,
          masked: false,
          pairs: [['orders', 'orders']],
        },
      },
      { errorText: () => 'E11000 duplicate key error dup key: { email: "a@x" } (code 11000)' },
    )
    await s.coll.createIndex({ email: 1 }, { unique: true })
    await s.coll.insertOne({ _id: 9 as never, email: 'taken' })
    s.streams.push(stream([ev('insert', 'orders', 1, { email: 'taken' })]))
    s.run()
    await until(() => s.get().counters.skipped === 1)
    const [skipped] = s.repo.events(s.record.id).filter((e) => e.kind === 'skipped')
    expect(skipped!.detail).toBe(`${idKey(1)} · code 11000`)
  })

  // Second independent review (nit 5): a bulk error built from the driver's wrapper refuses no
  // document by index, yet MongoDB refused it: said (write_error), not retried as a lost connection.
  it("pauses on a batch refused under the driver's wrapper, not retrying it", async () => {
    // A bulk error with no document refused by index: MongoDB's refusal under the wrapper, or the
    // connection failing — with nothing of MongoDB's under it, or a code of its own (third
    // independent review, Minor 2; final review, nit 2: each pinned).
    for (const [failure, ends] of [
      [() => new MongoBulkWriteError(driverWrapped(), {} as never), 'attention'],
      [() => new MongoBulkWriteError(new MongoNetworkError('socket closed'), {} as never), 'retrying'],
      [
        () => new MongoBulkWriteError(new MongoServerError({ message: 'x', code: 91 }), {} as never),
        'retrying',
      ],
    ] as const) {
      let calls = 0
      const wrapped = {
        db: (name: string) => {
          const db = client.db(name)
          return new Proxy(db, {
            get(t, key) {
              if (key === 'collection')
                return (coll: string) =>
                  new Proxy(t.collection(coll), {
                    get(c, k) {
                      if (k === 'bulkWrite')
                        return () => {
                          calls++
                          return Promise.reject(failure())
                        }
                      const v = Reflect.get(c, k)
                      return typeof v === 'function' ? v.bind(c) : v
                    },
                  })
              const v = Reflect.get(t, key)
              return typeof v === 'function' ? v.bind(t) : v
            },
          })
        },
      } as unknown as MongoClient
      const seen: unknown[] = []
      const s = await setup(
        {},
        {
          target: async () => wrapped,
          errorText: (_side, e) => {
            seen.push(e)
            return 'said'
          },
        },
      )
      s.streams.push(stream([ev('insert', 'orders', 1)]))
      s.run()
      await until(() => s.states.includes(ends))
      if (ends === 'attention') {
        expect(s.get()).toMatchObject({ reason: 'write_error', detail: 'said' })
        expect(calls).toBe(1)
        // What MongoDB refused is said with its own error, and the place has not moved past it.
        expect(serverError(seen[0])).toMatchObject({ code: 20, message: 'refused here' })
        expect(s.repo.place(s.record.id)).toBeNull()
      } else expect(s.states).not.toContain('attention')
    }
  })

  it('m4: an idle sync does not save its place over and over', async () => {
    const s = await setup()
    let saves = 0
    const save = s.repo.savePlace.bind(s.repo)
    s.repo.savePlace = (...args: Parameters<typeof save>) => {
      saves++
      return save(...args)
    }
    s.streams.push(stream([ev('insert', 'orders', 1)]))
    s.run()
    await until(() => s.get().state === 'live')
    await new Promise((r) => setTimeout(r, 400))
    expect(saves).toBeLessThanOrEqual(2)
  })

  it('m5: writes to the target with a majority write concern', async () => {
    const concerns: unknown[] = []
    const wrapped = {
      db: (name: string) => {
        const db = client.db(name)
        return new Proxy(db, {
          get(t, key) {
            if (key === 'collection')
              return (coll: string) =>
                new Proxy(t.collection(coll), {
                  get(c, k) {
                    if (k === 'bulkWrite')
                      return (ops: never, o: { writeConcern?: unknown }) => {
                        concerns.push(o?.writeConcern)
                        return c.bulkWrite(ops, o as never)
                      }
                    const v = Reflect.get(c, k)
                    return typeof v === 'function' ? v.bind(c) : v
                  },
                })
            const v = Reflect.get(t, key)
            return typeof v === 'function' ? v.bind(t) : v
          },
        })
      },
    } as unknown as MongoClient
    const s = await setup({}, { target: async () => wrapped })
    s.streams.push(stream([ev('insert', 'orders', 1)]))
    s.run()
    await until(() => concerns.length > 0)
    expect(concerns[0]).toEqual({ w: 'majority' })
  })

  it('m8: retries a passing fault of ours before it gives up', async () => {
    const s = await setup()
    s.streams.push(new TypeError('busy') as Error, stream([ev('insert', 'orders', 1)]))
    s.run()
    await until(() => s.get().state === 'live')
    expect(await s.coll.countDocuments()).toBe(1)
  })
})
