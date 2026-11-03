import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server'
import { WatchOptionsSchema, type WatchEvent } from '@mongo-manager/shared'
import { H, type TestApp } from './helpers'
import { watchApp } from './support/watch'
import { slow, SERVER_START_MS } from './support/slowness'

let set: MongoMemoryReplSet
let mc: MongoClient
beforeAll(async () => {
  set = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  mc = await new MongoClient(set.getUri()).connect()
}, slow(180_000))
afterAll(async () => {
  await mc?.close()
  await set?.stop()
})
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const name = (prefix: string) => `${prefix}${randomUUID().slice(0, 8)}`
const n = (e: WatchEvent | undefined) =>
  (e?.fullDocument as { n?: { $numberInt: string } } | undefined)?.n?.$numberInt

type App = Awaited<ReturnType<typeof watchApp>>
type Socket = Awaited<ReturnType<App['socket']>>

async function collect(c: Socket, id: string, count: number, ms = 15_000): Promise<WatchEvent[]> {
  const end = Date.now() + ms
  while (c.events(id).length < count) {
    if (Date.now() > end) throw new Error(`only ${c.events(id).length} of ${count} events`)
    await wait(25)
  }
  return c.events(id)
}

async function setup(uri = set.getUri(), opts: { config?: object; deps?: object } = {}) {
  const w = await watchApp(uri, opts)
  apps.push(w.t)
  const u = w.user()
  const c = await w.socket(u)
  const start = async (target: object, options: object = {}, filter: object = {}) => {
    const id = randomUUID()
    c.send({ ch: 'watch', type: 'sub', id, connectionId: w.connectionId, ...target, filter, options })
    const started = await c.next('started', (m) => m.payload.id === id)
    return {
      id,
      started: started.payload as { preImages: boolean | null; resumed: boolean; exists: boolean | null },
    }
  }
  return { w, u, c, start }
}

describe('watching a replica set (phase 3e-1 spec §5)', () => {
  it('watches a database and a whole deployment, naming each event’s namespace', async () => {
    const { c, start } = await setup()
    const db = name('d')
    const other = name('o')
    const inDb = await start({ scope: 'database', db })
    const all = await start({ scope: 'deployment' })
    expect(inDb.started.preImages).toBeNull()
    await mc.db(db).collection('a').insertOne({ n: 1 })
    await mc.db(db).collection('b').insertOne({ n: 2 })
    await mc.db(other).collection('c').insertOne({ n: 3 })
    expect((await collect(c, inDb.id, 2)).map((e) => e.ns)).toEqual([
      { db, coll: 'a' },
      { db, coll: 'b' },
    ])
    await collect(c, all.id, 3)
    expect(
      c
        .events(all.id)
        .filter((e) => e.ns.db === db || e.ns.db === other)
        .map((e) => e.ns),
    ).toEqual([
      { db, coll: 'a' },
      { db, coll: 'b' },
      { db: other, coll: 'c' },
    ])
  })

  it('keeps only the chosen operation types and what the filter matches', async () => {
    const { c, start } = await setup()
    const coll = mc.db('live').collection(name('k'))
    await coll.insertOne({ seed: true })
    const target = { scope: 'collection', db: 'live', coll: coll.collectionName }
    const inserts = await start(target, { ops: ['insert'] })
    const big = await start(target, {}, { 'fullDocument.n': { $gte: 2 } })
    await coll.insertOne({ n: 1 })
    await coll.insertOne({ n: 2 })
    await coll.deleteMany({})
    expect((await collect(c, inserts.id, 2)).map((e) => e.op)).toEqual(['insert', 'insert'])
    expect((await collect(c, big.id, 1)).map(n)).toEqual(['2'])
    await wait(400)
    expect(c.events(inserts.id)).toHaveLength(2)
    expect(c.events(big.id)).toHaveLength(1)
  })

  it('adds the whole document after updates, and the before-image where pre-images are on', async () => {
    const { c, start } = await setup()
    const db = mc.db('live')
    const plain = name('p')
    const withPre = name('w')
    await db.collection(plain).insertOne({ _id: 1 as never, n: 1 })
    await db.createCollection(withPre, { changeStreamPreAndPostImages: { enabled: true } })
    await db.collection(withPre).insertOne({ _id: 1 as never, n: 1 })
    const a = await start({ scope: 'collection', db: 'live', coll: plain }, { fullDocument: true })
    const b = await start({ scope: 'collection', db: 'live', coll: withPre })
    expect(a.started.preImages).toBe(false)
    expect(b.started.preImages).toBe(true)
    await db.collection(plain).updateOne({ _id: 1 as never }, { $set: { n: 2 } })
    await db.collection(withPre).updateOne({ _id: 1 as never }, { $set: { n: 2 } })
    const [up] = await collect(c, a.id, 1)
    expect(up).toMatchObject({
      op: 'update',
      documentKey: { _id: { $numberInt: '1' } },
      fullDocument: { n: { $numberInt: '2' } },
      update: { updated: { n: { $numberInt: '2' } }, removed: [], truncated: [] },
    })
    expect(up!.before).toBeUndefined()
    const [pre] = await collect(c, b.id, 1)
    expect(pre).toMatchObject({ before: { n: { $numberInt: '1' } } })
    expect(pre!.fullDocument).toBeUndefined()
  })

  // Final review M4: a collection that does not exist yet can be watched, and the feed says so.
  it('says whether the watched collection exists yet', async () => {
    const { start } = await setup()
    const missing = await start({ scope: 'collection', db: 'live', coll: name('none') })
    expect(missing.started).toMatchObject({ exists: false })
    const coll = mc.db('live').collection(name('there'))
    await coll.insertOne({ a: 1 })
    expect(
      (await start({ scope: 'collection', db: 'live', coll: coll.collectionName })).started,
    ).toMatchObject({
      exists: true,
    })
    expect((await start({ scope: 'database', db: 'live' })).started).toMatchObject({ exists: null })
  })

  it('shows schema changes only when asked', async () => {
    const { c, start } = await setup()
    const coll = mc.db('live').collection(name('s'))
    await coll.insertOne({ a: 1 })
    const target = { scope: 'collection', db: 'live', coll: coll.collectionName }
    const plain = await start(target)
    const schema = await start(target, { ops: ['insert', 'createIndexes'], schemaChanges: true })
    await coll.createIndex({ a: 1 })
    await coll.insertOne({ a: 2 })
    const events = await collect(c, schema.id, 2)
    expect(events.map((e) => e.op)).toEqual(['createIndexes', 'insert'])
    expect(events[0]!.description).toMatchObject({ indexes: [{ name: 'a_1' }] })
    expect((await collect(c, plain.id, 1)).map((e) => e.op)).toEqual(['insert'])
  })

  it('elides a document above 256 KiB and still names its key', async () => {
    const { c, start } = await setup()
    const coll = mc.db('live').collection(name('e'))
    await coll.insertOne({ seed: true })
    const feed = await start({ scope: 'collection', db: 'live', coll: coll.collectionName })
    await coll.insertOne({ _id: 'big' as never, blob: 'x'.repeat(300 * 1024) })
    const [event] = await collect(c, feed.id, 1)
    expect(event).toMatchObject({ documentKey: { _id: 'big' }, elided: { fullDocument: expect.any(Number) } })
    expect(event!.fullDocument).toBeUndefined()
  })

  // Review Focus 2.
  it('ends with invalidate when the collection is dropped or renamed, and starts again', async () => {
    const { w, c, start } = await setup()
    const n1 = name('x')
    const coll = mc.db('live').collection(n1)
    await coll.insertOne({ n: 1 })
    const target = { scope: 'collection', db: 'live', coll: n1 }
    const first = await start(target)
    await coll.drop()
    expect((await c.next('ended', (m) => m.payload.id === first.id)).payload).toEqual({
      id: first.id,
      reason: 'invalidate',
    })
    expect(c.events(first.id).at(-1)).toMatchObject({ op: 'invalidate' })
    await coll.insertOne({ n: 2 })
    const again = await start(target)
    await coll.insertOne({ n: 3 })
    expect(n((await collect(c, again.id, 1))[0])).toBe('3')
    await coll.rename(name('renamed'))
    expect((await c.next('ended', (m) => m.payload.id === again.id)).payload.reason).toBe('invalidate')
    await wait(50)
    expect(w.ctx.watch.count()).toBe(0)
  })

  it(
    'refuses a standalone server and a view, in words',
    async () => {
      const solo = await MongoMemoryServer.create()
      try {
        const s = await setup(solo.getUri())
        const id = randomUUID()
        s.c.send({ ch: 'watch', type: 'sub', id, connectionId: s.w.connectionId, scope: 'deployment' })
        expect((await s.c.next('error', (m) => m.payload.id === id)).payload).toEqual({
          id,
          reason: 'not_replica_set',
        })
        expect(s.w.ctx.watch.count()).toBe(0)
      } finally {
        for (const t of apps.splice(0)) await t.close()
        await solo.stop()
      }
      const s = await setup()
      const view = name('v')
      await mc.db('live').createCollection(view, { viewOn: 'base', pipeline: [] })
      const id = randomUUID()
      s.c.send({
        ch: 'watch',
        type: 'sub',
        id,
        connectionId: s.w.connectionId,
        scope: 'collection',
        db: 'live',
        coll: view,
      })
      expect((await s.c.next('error', (m) => m.payload.id === id)).payload).toEqual({ id, reason: 'view' })
    },
    SERVER_START_MS,
  )

  it('pauses in place: catching up delivers what happened meanwhile, from now skips it', async () => {
    const { c, start } = await setup()
    const coll = mc.db('live').collection(name('q'))
    await coll.insertOne({ seed: true })
    const feed = await start({ scope: 'collection', db: 'live', coll: coll.collectionName })
    c.send({ ch: 'watch', type: 'pause', id: feed.id })
    await c.next('paused')
    await coll.insertMany([{ n: 1 }, { n: 2 }])
    await wait(400)
    expect(c.events(feed.id)).toEqual([])
    c.send({ ch: 'watch', type: 'resume', id: feed.id, from: 'here' })
    expect((await c.next('resumed')).payload).toEqual({ id: feed.id, from: 'here' })
    expect((await collect(c, feed.id, 2)).map((e) => e.seq)).toEqual([1, 2])
    c.send({ ch: 'watch', type: 'pause', id: feed.id })
    await c.next('paused')
    await coll.insertOne({ n: 3 })
    c.send({ ch: 'watch', type: 'resume', id: feed.id, from: 'now' })
    await c.next('resumed')
    await coll.insertOne({ n: 4 })
    expect((await collect(c, feed.id, 3)).map(n)).toEqual(['1', '2', '4'])
  })

  // Review Focus 1.
  it('stays bounded under a burst and says how far behind it is', async () => {
    const s = await setup(set.getUri(), {
      deps: {
        watch: { timing: { flushMs: 20, waitMs: 10, maxPerSecond: 100_000, maxBatch: 100, outbox: 200 } },
      },
    })
    const coll = mc.db('live').collection(name('b'))
    await coll.insertOne({ seed: true })
    let reading = false
    const sub = s.w.subscriber(s.u, () => reading)
    const id = randomUUID()
    await s.w.ctx.watch.start(
      s.u.id,
      {
        id,
        target: {
          connectionId: s.w.connectionId,
          scope: 'collection',
          db: 'live',
          coll: coll.collectionName,
        },
        filter: {},
        options: WatchOptionsSchema.parse({ ops: ['insert'] }),
      },
      sub,
    )
    await coll.insertMany(Array.from({ length: 5000 }, (_, i) => ({ n: i })))
    let most = 0
    for (let i = 0; i < 40; i++) {
      most = Math.max(most, s.w.ctx.watch.pending(s.u.id, id))
      await wait(25)
    }
    // A subscriber that stopped reading never makes the server hold more than one outbox.
    expect(most).toBeLessThanOrEqual(200)
    reading = true
    const events = () => sub.sent.flatMap((m) => (m.type === 'events' ? m.payload.events : []))
    const end = Date.now() + 60_000
    while (events().length < 5000 && Date.now() < end) await wait(50)
    expect(events().map((e) => e.seq)).toEqual(Array.from({ length: 5000 }, (_, i) => i + 1))
    const lags = sub.sent.flatMap((m) => (m.type === 'events' ? [m.payload.lagMs] : []))
    expect(Math.max(...lags)).toBeGreaterThan(0)
    await s.w.ctx.watch.stop(s.u.id, id, sub)
  }, 90_000)

  // Review Focus 3.
  it('ends when the connection is edited or deleted, and releases its hold', async () => {
    const s = await setup()
    const admin = s.w.user('admin')
    const coll = mc.db('live').collection(name('h'))
    await coll.insertOne({ seed: true })
    const target = { scope: 'collection', db: 'live', coll: coll.collectionName }
    const holds = () =>
      (s.w.ctx.manager as unknown as { holds: Map<string, number> }).holds.get(s.w.connectionId) ?? 0
    const as = { ...H, cookie: `mm_sid=${admin.sessionId}`, 'x-csrf-token': admin.csrf }
    const first = await start(s, target)
    expect(holds()).toBe(1)
    const url = `/api/connections/${s.w.connectionId}`
    const { settings } = (await s.w.t.app.inject({ method: 'GET', url, headers: as })).json()
    // An edit of its settings (a new name alone changes nothing it was made of: manager-opening.test.ts).
    const edited = await s.w.t.app.inject({
      method: 'PATCH',
      url,
      headers: as,
      payload: { settings: { ...settings, appName: 'edited' } },
    })
    expect(edited.statusCode, edited.body).toBe(200)
    expect((await s.c.next('ended', (m) => m.payload.id === first)).payload.reason).toBe('connection')
    expect(holds()).toBe(0)
    const second = await start(s, target)
    const removed = await s.w.t.app.inject({
      method: 'DELETE',
      url: `/api/connections/${s.w.connectionId}`,
      headers: as,
    })
    expect(removed.statusCode, removed.body).toBe(204)
    expect((await s.c.next('ended', (m) => m.payload.id === second)).payload.reason).toBe('access')
    expect(holds()).toBe(0)
    expect(s.w.ctx.watch.count()).toBe(0)
  })

  // Review Focus 4.
  it('masks every event by its own namespace at the database scope', async () => {
    const s = await setup()
    const db = name('m')
    const masked = s.w.user('viewer', { masked: true })
    s.w.ctx.personalFields.set(s.w.connectionId, [
      { db, coll: '*', field: 'email' },
      { db, coll: 'orders', field: 'items.card' },
    ])
    const c = await s.w.socket(masked)
    const id = randomUUID()
    c.send({
      ch: 'watch',
      type: 'sub',
      id,
      connectionId: s.w.connectionId,
      scope: 'database',
      db,
      options: { fullDocument: true },
    })
    await c.next('started')
    await mc
      .db(db)
      .collection('orders')
      .insertOne({ _id: 1 as never, email: 'a@x', items: [{ card: '4111', sku: 'A' }] })
    await mc
      .db(db)
      .collection('orders')
      .updateOne({ _id: 1 as never }, { $set: { 'items.0.card': '4222', email: 'b@x', note: 'ok' } })
    await mc
      .db(db)
      .collection('people')
      .insertOne({ _id: 2 as never, email: 'c@x', items: [{ card: 'visible' }] })
    const events = await collect(c, id, 3)
    expect(events[0]).toMatchObject({
      masked: true,
      fullDocument: { email: '***', items: [{ card: '***', sku: 'A' }] },
    })
    expect(events[1]!.update!.updated).toEqual({ 'items.0.card': '***', email: '***', note: 'ok' })
    expect(events[1]).toMatchObject({ fullDocument: { email: '***', items: [{ card: '***' }] } })
    expect(events[2]).toMatchObject({
      ns: { coll: 'people' },
      fullDocument: { email: '***', items: [{ card: 'visible' }] },
    })
    expect(JSON.stringify(events)).not.toMatch(/a@x|b@x|c@x|4111|4222/)
  })
})

async function start(s: Awaited<ReturnType<typeof setup>>, target: object): Promise<string> {
  return (await s.start(target)).id
}
