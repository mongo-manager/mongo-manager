import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { MongoClient } from 'mongodb'
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server'
import type { LiveSyncPlan, LiveSyncState, LiveSyncView } from '@mongo-manager/shared'
import { liveSyncHarness, syncBody, until, type Conn, type LiveSyncHarness } from './support/livesync'
import { slow } from './support/slowness'

let a: MongoMemoryReplSet
let b: MongoMemoryReplSet
let ma: MongoClient
let mb: MongoClient
beforeAll(async () => {
  ;[a, b] = await Promise.all([
    MongoMemoryReplSet.create({ replSet: { count: 1 } }),
    MongoMemoryReplSet.create({ replSet: { count: 1 } }),
  ])
  ma = await new MongoClient(a.getUri()).connect()
  mb = await new MongoClient(b.getUri()).connect()
}, slow(180_000))
afterAll(async () => {
  await ma?.close()
  await mb?.close()
  await Promise.all([a?.stop(), b?.stop()])
})
const harnesses: LiveSyncHarness[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close()
})
const name = (p: string) => `${p}${randomUUID().slice(0, 8)}`
const timing = {
  liveSync: { timing: { pollMs: 50, idleMs: 50, retryMinMs: 50, retryMaxMs: 400 }, pushMs: 100 },
}

async function harness(solo?: string) {
  const h = await liveSyncHarness(a.getUri(), b.getUri(), solo, {}, timing as never)
  harnesses.push(h)
  return { h, admin: h.user() }
}
async function start(
  h: LiveSyncHarness,
  u: ReturnType<LiveSyncHarness['user']>,
  from: Conn,
  to: Conn,
  ns: Parameters<typeof syncBody>[3],
  extra: Record<string, unknown> = {},
) {
  // A collection sync needs its source collection (Task 5 ruling).
  if (ns.coll)
    await ma
      .db(ns.db)
      .createCollection(ns.coll)
      .catch(() => undefined)
  const body = syncBody(h.ids, from, to, ns, extra)
  const plan = (
    await u.call('POST', `/api/connections/${h.ids[from]}/live-syncs/plan`, body)
  ).json() as LiveSyncPlan
  expect(plan.refusals).toEqual([])
  const r = await u.call('POST', `/api/connections/${h.ids[from]}/live-syncs`, {
    ...body,
    planHash: plan.planHash,
  })
  expect(r.statusCode).toBe(201)
  return (r.json() as LiveSyncView).id
}
/** Both sides' documents in _id order, for an exact comparison. */
async function both(sourceDb: string, coll: string, targetDb = sourceDb, targetColl = coll) {
  const read = (c: MongoClient, db: string, n: string) =>
    c
      .db(db)
      .collection(n)
      .find({}, { sort: { _id: 1 } })
      .toArray()
  return { source: await read(ma, sourceDb, coll), target: await read(mb, targetDb, targetColl) }
}
async function equal(sourceDb: string, coll: string, targetDb = sourceDb, targetColl = coll) {
  const { source, target } = await both(sourceDb, coll, targetDb, targetColl)
  return JSON.stringify(source) === JSON.stringify(target)
}

describe('no gap between the copy and the changes (Review Focus 1, spec §1.3)', () => {
  it('converges after inserts, updates and deletes made during the copy, of copied and uncopied documents', async () => {
    const { h, admin } = await harness()
    const coll = name('g')
    const docs = Array.from({ length: 200_000 }, (_, i) => ({ _id: i, n: 0, pad: 'x'.repeat(100) }))
    await ma
      .db('live')
      .collection(coll)
      .insertMany(docs as never[])
    const id = await start(h, admin, 'A', 'B', { db: 'live', coll })
    const src = ma.db('live').collection<{ _id: number | string; [k: string]: unknown }>(coll)
    // While the copy runs: both ends of the _id range (copied early and copied late) change — in one
    // round trip, so the writes meet the copy even on a loaded machine.
    expect(h.ctx.liveSync.repo.get(id)!.state).toBe('copying')
    await src.bulkWrite(
      [
        ...Array.from({ length: 200 }, (_, i) => [
          { updateOne: { filter: { _id: i }, update: { $set: { n: 1 } } } },
          { updateOne: { filter: { _id: 199_999 - i }, update: { $set: { n: 2 } } } },
        ]).flat(),
        ...[5, 6, 199_990, 199_991].map((d) => ({ deleteOne: { filter: { _id: d } } })),
        { insertOne: { document: { _id: 500_000, n: 3 } } },
        { insertOne: { document: { _id: -1, n: 4 } } },
      ],
      { ordered: true },
    )
    // The test means something only if these writes met the copy.
    expect(h.ctx.liveSync.repo.get(id)!.state).toBe('copying')
    await until(() => h.ctx.liveSync.repo.get(id)!.state === 'live', 120_000)
    await until(() => equal('live', coll), 30_000)
    expect(await mb.db('live').collection(coll).countDocuments()).toBe(200_000 - 4 + 2)
  }, 240_000)
})

describe('restarts (Review Focus 2, spec §1.4)', () => {
  it('resumes after a restart from its sealed place, with the changes made while the server was down', async () => {
    const { h, admin } = await harness()
    const coll = name('r')
    const id = await start(h, admin, 'A', 'B', { db: 'live', coll }, { startMode: 'from_now' })
    const src = ma.db('live').collection<{ _id: number | string; [k: string]: unknown }>(coll)
    await until(() => h.ctx.liveSync.repo.get(id)!.state === 'live')
    await src.insertMany(Array.from({ length: 50 }, (_, i) => ({ _id: i })))
    await until(() => h.ctx.liveSync.repo.get(id)!.counters.inserted === 50)
    await h.restart({}, async () => {
      await src.insertMany(Array.from({ length: 50 }, (_, i) => ({ _id: 50 + i })))
      await src.updateOne({ _id: 0 }, { $set: { changed: true } })
      await src.deleteOne({ _id: 1 })
    })
    await until(() => equal('live', coll), 30_000)
    // The counters are saved after the batch's write: under load the data can show first.
    await until(() => {
      const c = h.ctx.liveSync.repo.get(id)!.counters
      return c.inserted >= 100 && c.deleted >= 1
    }, 30_000)
    const after = h.ctx.liveSync.repo.get(id)!
    expect(after.state).toBe('live')
    expect(after.counters).toMatchObject({ inserted: 100, deleted: 1 })
    expect(after.counters.replaced).toBeGreaterThanOrEqual(1)
    // S7: the place is sealed in SQLite.
    const raw = h.ctx.store.db.prepare('SELECT place FROM live_syncs WHERE id = ?').get(id) as {
      place: string
    }
    expect(raw.place).not.toContain('_data')
  }, 90_000)
})

describe('a burst on the source (Review Focus 4, spec §1.4)', () => {
  it('catches up within its batch bounds, says how far behind it is, and ends equal', async () => {
    const { h, admin } = await harness()
    const coll = name('b')
    const id = await start(h, admin, 'A', 'B', { db: 'live', coll }, { startMode: 'from_now' })
    await until(() => h.ctx.liveSync.repo.get(id)!.state === 'live')
    const seen = new Set<LiveSyncState>()
    let maxLag = 0
    const stop = h.ctx.liveSync.onChange((r) => {
      if (r.id !== id) return
      seen.add(r.state)
      maxLag = Math.max(maxLag, r.counters.lagMs)
    })
    const src = ma.db('live').collection<{ _id: number | string; [k: string]: unknown }>(coll)
    await src.insertMany(Array.from({ length: 20_000 }, (_, i) => ({ _id: i, n: 0 })))
    await src.updateMany({}, { $set: { n: 1 } })
    await until(() => h.ctx.liveSync.repo.get(id)!.counters.replaced >= 20_000, 120_000)
    await until(() => equal('live', coll), 30_000)
    // The last full batch may still say "catching up": the next idle pull says live.
    await until(() => h.ctx.liveSync.repo.get(id)!.state === 'live', 30_000)
    stop()
    const r = h.ctx.liveSync.repo.get(id)!
    // 40,000 changes in batches of at most 1,000 (collapsing by _id may merge some).
    expect(r.counters.batches).toBeGreaterThanOrEqual(20)
    expect(r.counters.inserted + r.counters.replaced).toBeLessThanOrEqual(40_000)
    expect(maxLag).toBeGreaterThan(0)
    expect(r.state).toBe('live')
    expect(seen.has('live')).toBe(true)
  }, 240_000)
})

describe('a database sync (spec §1.1, §1.4)', () => {
  it('follows new collections, builds and drops indexes, and stops for a dropped collection', async () => {
    const { h, admin } = await harness()
    const db = name('d')
    const targetDb = name('t')
    await ma
      .db(db)
      .collection('first')
      .insertOne({ _id: 1 } as never)
    const id = await start(h, admin, 'A', 'B', { db, targetDb })
    await until(() => h.ctx.liveSync.repo.get(id)!.state === 'live', 30_000)
    expect(h.ctx.liveSync.repo.get(id)!.options).toMatchObject({
      followNew: true,
      pairs: [['first', 'first']],
    })

    await ma.db(db).createCollection('later', { validator: { n: { $type: 'int' } } })
    await ma
      .db(db)
      .collection('later')
      .insertOne({ _id: 1, n: 1 } as never)
    await ma.db(db).collection('first').createIndex({ k: 1 }, { name: 'k_1' })
    await until(async () => (await mb.db(targetDb).collection('later').countDocuments()) === 1)
    const [later] = await mb.db(targetDb).listCollections({ name: 'later' }, { nameOnly: false }).toArray()
    expect(later?.options).toMatchObject({ validator: { n: { $type: 'int' } } })
    await until(async () =>
      (await mb.db(targetDb).collection('first').indexes()).some((i) => i.name === 'k_1'),
    )
    await ma.db(db).collection('first').dropIndex('k_1')
    await until(
      async () => !(await mb.db(targetDb).collection('first').indexes()).some((i) => i.name === 'k_1'),
    )

    await ma.db(db).collection('first').drop()
    await until(() => h.ctx.liveSync.repo.get(id)!.state === 'attention')
    expect(h.ctx.liveSync.repo.get(id)!).toMatchObject({ reason: 'source_gone', detail: `${db}.first` })
    // S4: a source drop never drops the target.
    expect(await mb.db(targetDb).collection('first').countDocuments()).toBe(1)
  }, 90_000)

  // Final reviews of explain masking (Minor 1, M-1, M-3): a new collection whose target name holds a
  // time series or a view, or a new capped one, takes none of the sync's writes: left out and said;
  // the rest goes on.
  it('leaves out a new collection whose target is a time series or a view, and a new capped one', async () => {
    const { h, admin } = await harness()
    const db = name('d')
    const targetDb = name('t')
    await ma
      .db(db)
      .collection('first')
      .insertOne({ _id: 1 } as never)
    await mb.db(targetDb).createCollection('later', { timeseries: { timeField: 't' } })
    await mb.db(targetDb).createCollection('base')
    await mb.db(targetDb).createCollection('shown', { viewOn: 'base', pipeline: [] })
    const id = await start(h, admin, 'A', 'B', { db, targetDb })
    await until(() => h.ctx.liveSync.repo.get(id)!.state === 'live', 30_000)
    await ma
      .db(db)
      .collection('later')
      .insertOne({ _id: 1, n: 1 } as never)
    await ma
      .db(db)
      .collection('shown')
      .insertOne({ _id: 1 } as never)
    await ma.db(db).createCollection('cap', { capped: true, size: 1 << 20 })
    const left = () => h.ctx.liveSync.repo.get(id)!.options.ignored ?? []
    await until(() => ['later', 'shown', 'cap'].every((c) => left().includes(c)), 30_000)
    expect(left().filter((c) => c === 'later')).toHaveLength(1)
    const said = h.ctx.liveSync.repo
      .events(id)
      .filter((e) => e.kind === 'schema')
      .map((e) => e.detail)
    expect(said).toEqual(
      expect.arrayContaining([
        expect.stringContaining('The target is a time series'),
        expect.stringContaining('The target is a view'),
        expect.stringContaining('A capped collection'),
      ]),
    )
    expect(await mb.db(targetDb).collection('later').countDocuments()).toBe(0)
    expect(await mb.db(targetDb).listCollections({ name: 'cap' }).toArray()).toEqual([])
    // The rest goes on.
    await ma
      .db(db)
      .collection('first')
      .insertOne({ _id: 2 } as never)
    await until(async () => (await mb.db(targetDb).collection('first').countDocuments()) === 2, 30_000)
  }, 90_000)

  it('I3: stops when an aggregation replaces a synced collection with $out', async () => {
    const { h, admin } = await harness()
    const db = name('o')
    await ma
      .db(db)
      .collection('one')
      .insertOne({ _id: 1 } as never)
    await ma
      .db(db)
      .collection('two')
      .insertMany([{ _id: 1 }, { _id: 2 }] as never[])
    const body = {
      ...syncBody(h.ids, 'A', 'B', { db }),
      source: { connectionId: h.ids.A, db, collections: ['one'] },
    }
    const plan = (
      await admin.call('POST', `/api/connections/${h.ids.A}/live-syncs/plan`, body)
    ).json() as LiveSyncPlan
    const view = (
      await admin.call('POST', `/api/connections/${h.ids.A}/live-syncs`, { ...body, planHash: plan.planHash })
    ).json() as LiveSyncView
    await until(() => h.ctx.liveSync.repo.get(view.id)!.state === 'live', 30_000)
    await ma
      .db(db)
      .collection('two')
      .aggregate([{ $out: 'one' }])
      .toArray()
    await until(() => h.ctx.liveSync.repo.get(view.id)!.state === 'attention', 30_000)
    expect(h.ctx.liveSync.repo.get(view.id)!).toMatchObject({ reason: 'source_gone', detail: `${db}.one` })
  }, 60_000)

  it('syncs only the chosen collections, and follows no new ones', async () => {
    const { h, admin } = await harness()
    const db = name('c')
    await ma
      .db(db)
      .collection('one')
      .insertOne({ _id: 1 } as never)
    await ma
      .db(db)
      .collection('two')
      .insertOne({ _id: 1 } as never)
    const body = {
      ...syncBody(h.ids, 'A', 'B', { db }),
      source: { connectionId: h.ids.A, db, collections: ['one'] },
    }
    const plan = (
      await admin.call('POST', `/api/connections/${h.ids.A}/live-syncs/plan`, body)
    ).json() as LiveSyncPlan
    const view = (
      await admin.call('POST', `/api/connections/${h.ids.A}/live-syncs`, { ...body, planHash: plan.planHash })
    ).json() as LiveSyncView
    await until(() => h.ctx.liveSync.repo.get(view.id)!.state === 'live', 30_000)
    await ma
      .db(db)
      .collection('two')
      .insertOne({ _id: 2 } as never)
    await ma
      .db(db)
      .collection('three')
      .insertOne({ _id: 1 } as never)
    await ma
      .db(db)
      .collection('one')
      .insertOne({ _id: 2 } as never)
    await until(async () => (await mb.db(db).collection('one').countDocuments()) === 2)
    expect((await mb.db(db).listCollections().toArray()).map((c) => c.name).sort()).toEqual(['one'])
    expect(view.followNew).toBe(false)
  }, 60_000)
})

/**
 * A TCP proxy in front of a server: `down()` refuses and cuts every connection, `up()` listens again
 * on the same port — an outage the test controls exactly (stopping mongod is not prompt everywhere).
 */
function tcpProxy(target: number) {
  const sockets = new Set<Socket>()
  let server: Server | null = null
  let port = 0
  const up = () =>
    new Promise<number>((resolve, reject) => {
      server = createServer((client) => {
        const upstream = connect(target, '127.0.0.1')
        for (const s of [client, upstream]) {
          sockets.add(s)
          s.on('error', () => s.destroy())
          s.on('close', () => {
            sockets.delete(s)
            client.destroy()
            upstream.destroy()
          })
        }
        client.pipe(upstream).pipe(client)
      })
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        port = (server!.address() as AddressInfo).port
        resolve(port)
      })
    })
  const down = async () => {
    const closing = new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    for (const s of sockets) s.destroy()
    await closing
    server = null
  }
  return { up, down }
}

describe('a side that goes away (spec §1.7)', () => {
  it('retries while the target is down and carries on when it is back', async () => {
    const solo = await MongoMemoryServer.create()
    const proxy = tcpProxy(solo.instanceInfo!.port)
    try {
      const port = await proxy.up()
      const { h, admin } = await harness(
        `mongodb://127.0.0.1:${port}/?directConnection=true&serverSelectionTimeoutMS=2000`,
      )
      const coll = name('s')
      const id = await start(h, admin, 'A', 'S', { db: 'live', coll }, { startMode: 'from_now' })
      await until(() => h.ctx.liveSync.repo.get(id)!.state === 'live')
      await proxy.down()
      await ma
        .db('live')
        .collection(coll)
        .insertOne({ _id: 'while-down' } as never)
      await until(() => h.ctx.liveSync.repo.get(id)!.state === 'retrying', 60_000)
      const listed = (await admin.get(`/api/live-syncs/${id}`)).json() as LiveSyncView
      expect(listed.retryAt).toEqual(expect.any(Number))
      await proxy.up()
      await until(() => h.ctx.liveSync.repo.get(id)!.state === 'live', 60_000)
      const check = await new MongoClient(solo.getUri()).connect()
      try {
        await until(async () => (await check.db('live').collection(coll).countDocuments()) === 1, 30_000)
      } finally {
        await check.close()
      }
    } finally {
      await proxy.down()
      await solo.stop()
    }
  }, 180_000)
})
