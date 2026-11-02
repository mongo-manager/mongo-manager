import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { WatchOptionsSchema } from '@mongo-manager/shared'
import type { TestApp } from './helpers'
import { watchApp } from './support/watch'
import { slow } from './support/slowness'

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

async function app(opts: { config?: object; deps?: object } = {}) {
  const w = await watchApp(set.getUri(), opts)
  apps.push(w.t)
  return w
}
type App = Awaited<ReturnType<typeof app>>
type Socket = Awaited<ReturnType<App['socket']>>
function sub(w: App, c: Socket, target: object, extra: object = {}) {
  const id = randomUUID()
  c.send({ ch: 'watch', type: 'sub', id, connectionId: w.connectionId, ...target, ...extra })
  return id
}
const answer = (c: Socket, id: string) =>
  Promise.race([c.next('started', (m) => m.payload.id === id), c.next('error', (m) => m.payload.id === id)])
const audit = (w: App, action: string) =>
  w.ctx.store.db
    .prepare('SELECT details, outcome FROM audit_log WHERE action = ? ORDER BY rowid')
    .all(action) as Array<{
    details: string
    outcome: string
  }>

describe('Watch abuse cases (phase 3e-1 spec §3)', () => {
  it('W1: no feed without documents:read; an unknown connection answers the same; a view is refused', async () => {
    const w = await app()
    const none = await w.socket(w.user('viewer', { grant: 'none' }))
    const coll = { scope: 'collection', db: 'live', coll: 'w1' }
    const a = sub(w, none, coll)
    expect((await answer(none, a)).payload).toEqual({ id: a, reason: 'access' })
    const id = randomUUID()
    none.send({ ch: 'watch', type: 'sub', id, connectionId: 'no-such-connection', scope: 'deployment' })
    expect((await answer(none, id)).payload).toEqual({ id, reason: 'access' })
    const viewer = await w.socket(w.user())
    const creds = sub(w, viewer, { scope: 'collection', db: 'admin', coll: 'system.users' })
    expect((await answer(viewer, creds)).payload).toEqual({ id: creds, reason: 'access' })
    expect(w.ctx.watch.count()).toBe(0)
  })

  it('W2: losing the grant, the account or the session ends the feed and sends nothing more', async () => {
    const w = await app()
    const coll = mc.db('live').collection(name('w2'))
    await coll.insertOne({ seed: true })
    const target = { scope: 'collection', db: 'live', coll: coll.collectionName }
    // The grant.
    const u1 = w.user('viewer', { grant: 'viewer' })
    const c1 = await w.socket(u1)
    const f1 = sub(w, c1, target)
    await answer(c1, f1)
    w.ctx.grants.set(w.connectionId, u1.id, 'none')
    await coll.insertOne({ secret: 1 })
    expect((await c1.next('ended', (m) => m.payload.id === f1)).payload.reason).toBe('access')
    expect(c1.events(f1)).toEqual([])
    // The account.
    const u2 = w.user()
    const c2 = await w.socket(u2)
    const f2 = sub(w, c2, target)
    await answer(c2, f2)
    w.ctx.users.setDisabled(u2.id, true)
    await coll.insertOne({ secret: 2 })
    expect((await c2.next('ended', (m) => m.payload.id === f2)).payload.reason).toBe('access')
    expect(c2.events(f2)).toEqual([])
    // The session: the socket closes (4401) and the feed goes with it.
    const u3 = w.user()
    const c3 = await w.socket(u3)
    const f3 = sub(w, c3, target)
    await answer(c3, f3)
    w.ctx.sessions.revoke(u3.sessionId)
    expect(await c3.closed).toBe(4401)
    await wait(100)
    expect(w.ctx.watch.count()).toBe(0)
  })

  it('W2/W3: a user made restricted mid-feed gets the next batch masked', async () => {
    const w = await app()
    const coll = mc.db('live').collection(name('w3m'))
    await coll.insertOne({ seed: true })
    w.ctx.personalFields.set(w.connectionId, [{ db: 'live', coll: coll.collectionName, field: 'email' }])
    const u = w.user('viewer', { grant: 'viewer' })
    const c = await w.socket(u)
    const id = sub(w, c, { scope: 'collection', db: 'live', coll: coll.collectionName })
    await answer(c, id)
    await coll.insertOne({ email: 'seen@x' })
    while (c.events(id).length < 1) await wait(25)
    w.ctx.grants.setMasked(w.connectionId, u.id, true)
    await coll.insertOne({ email: 'hidden@x' })
    while (c.events(id).length < 2) await wait(25)
    expect(c.events(id)[1]).toMatchObject({ masked: true, fullDocument: { email: '***' } })
  })

  it('W3: a filter on a personal path is refused and audited without its value; MongoDB’s words stay hidden', async () => {
    const w = await app()
    w.ctx.personalFields.set(w.connectionId, [{ db: 'live', coll: 'w3', field: 'email' }])
    const c = await w.socket(w.user('viewer', { masked: true }))
    const target = { scope: 'collection', db: 'live', coll: 'w3' }
    const a = sub(w, c, target, { filter: { 'fullDocument.email': 'victim@x' } })
    expect((await answer(c, a)).payload).toEqual({
      id: a,
      reason: 'masking_filter',
      detail: 'fullDocument.email',
    })
    const rows = audit(w, 'masking.refused')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.details).not.toContain('victim@x')
    // An operator MongoDB rejects: the feed answers in its own words, never MongoDB's.
    const admin = await w.socket(w.user('admin'))
    const b = sub(w, admin, target, { filter: { $foo: 1 } })
    const reply = (await answer(admin, b)).payload
    expect(reply).toEqual({ id: b, reason: 'internal' })
  })

  // Final review C1: a document's own "elided" field never switches masking off.
  it('W3: a masked user sees a document with an elided: true field masked, also after a masked editor sets it', async () => {
    const w = await app()
    const coll = mc.db('live').collection(name('w3e'))
    await coll.insertOne({ _id: 1 as never, email: 'first@x' })
    w.ctx.personalFields.set(w.connectionId, [{ db: 'live', coll: coll.collectionName, field: 'email' }])
    const c = await w.socket(w.user('editor', { masked: true }))
    const id = sub(
      w,
      c,
      { scope: 'collection', db: 'live', coll: coll.collectionName },
      { options: { fullDocument: true } },
    )
    await answer(c, id)
    await coll.insertOne({ _id: 2 as never, elided: true, bytes: 1, email: 'second@x' })
    await coll.updateOne({ _id: 1 as never }, { $set: { elided: true } })
    while (c.events(id).length < 2) await wait(25)
    for (const e of c.events(id)) expect(e.fullDocument).toMatchObject({ elided: true, email: '***' })
    expect(JSON.stringify(c.messages)).not.toMatch(/first@x|second@x/)
  })

  it('W4: server-side JavaScript is refused in a filter, whatever the server allows elsewhere', async () => {
    const w = await app({ config: { allowServerJs: true } })
    const c = await w.socket(w.user('admin'))
    const target = { scope: 'collection', db: 'live', coll: 'w4' }
    for (const filter of [
      { $where: 'sleep(10000) || true' },
      { $expr: { $function: { body: 'function(){return true}', args: [], lang: 'js' } } },
      { $and: [{ $expr: { $accumulator: {} } }] },
    ]) {
      const id = sub(w, c, target, { filter })
      expect((await answer(c, id)).payload).toMatchObject({ id, reason: 'filter' })
    }
    expect(w.ctx.watch.count()).toBe(0)
  })

  it('W5: bounds per socket, per user and per server, on the filter, and on the grace', async () => {
    const w = await app({ config: { watch: { enabled: true, maxFeeds: 7 } } })
    // The filter's size and depth (checked after the limits, so first, while there is room).
    const admin = await w.socket(w.user('admin'))
    const huge = sub(w, admin, { scope: 'deployment' }, { filter: { a: 'x'.repeat(12 * 1024) } })
    // About 12.3 KiB with the rest of the message: under the socket's 16 KiB, over the filter's 12 KiB.
    expect((await answer(admin, huge)).payload).toMatchObject({ reason: 'filter' })
    let deep: Record<string, unknown> = { v: 1 }
    for (let i = 0; i < 25; i++) deep = { $and: [deep] }
    const nested = sub(w, admin, { scope: 'deployment' }, { filter: deep })
    expect((await answer(admin, nested)).payload).toMatchObject({ reason: 'filter' })
    expect(w.ctx.watch.count()).toBe(0)
    // Three a socket, five a user, seven on this server.
    const u = w.user()
    const a = await w.socket(u)
    const b = await w.socket(u)
    for (let i = 0; i < 3; i++)
      expect((await answer(a, sub(w, a, { scope: 'deployment' }))).type).toBe('started')
    const fourth = sub(w, a, { scope: 'deployment' })
    expect((await answer(a, fourth)).payload).toMatchObject({ reason: 'limit', detail: 'socket' })
    for (let i = 0; i < 2; i++)
      expect((await answer(b, sub(w, b, { scope: 'deployment' }))).type).toBe('started')
    const sixth = sub(w, b, { scope: 'deployment' })
    expect((await answer(b, sixth)).payload).toMatchObject({ reason: 'limit', detail: 'user' })
    const other = await w.socket(w.user())
    for (let i = 0; i < 2; i++) await answer(other, sub(w, other, { scope: 'deployment' }))
    const over = sub(w, other, { scope: 'deployment' })
    expect((await answer(other, over)).payload).toMatchObject({ reason: 'limit', detail: 'server' })
    // The grace keeps at most the user's limit of tokens.
    a.close()
    b.close()
    await Promise.all([a.closed, b.closed])
    // The server parks a socket's streams once it has seen the close (later under load than 100 ms).
    await vi.waitFor(() => expect(w.ctx.watch.parked(u.id)).toBe(5), { timeout: 5000 })
    const c = await w.socket(u)
    const fresh = sub(w, c, { scope: 'deployment' })
    await answer(c, fresh)
    c.close()
    await c.closed
    await wait(100)
    expect(w.ctx.watch.parked(u.id)).toBe(5)
  })

  it('W6: no resume token, session or UUID ever leaves; another user’s feed id resumes nothing', async () => {
    const w = await app()
    const coll = mc.db('live').collection(name('w6'))
    await coll.insertOne({ seed: true })
    const u = w.user('admin')
    const c = await w.socket(u)
    const target = { scope: 'collection', db: 'live', coll: coll.collectionName }
    const id = sub(w, c, target)
    await answer(c, id)
    const session = mc.startSession()
    await session.withTransaction(async () => {
      await coll.insertOne({ n: 1 }, { session })
      await coll.updateOne({ n: 1 }, { $set: { n: 2 } }, { session })
    })
    await session.endSession()
    while (c.events(id).length < 2) await wait(25)
    const wire = JSON.stringify(c.messages)
    for (const secret of [
      '_data',
      'lsid',
      'txnNumber',
      'collectionUUID',
      'resumeToken',
      'postBatchResumeToken',
    ])
      expect(wire).not.toContain(secret)
    c.close()
    await c.closed
    await wait(100)
    // Another user, the same id and parameters: from now, not from the first user's place.
    const thief = await w.socket(w.user('admin'))
    thief.send({ ch: 'watch', type: 'sub', id, connectionId: w.connectionId, ...target })
    expect((await thief.next('started')).payload).toMatchObject({ resumed: false })
    await wait(300)
    expect(thief.events(id)).toEqual([])
  })

  // Review Focus 5.
  it('W7: feeds stay their owner’s and their parameters’ across a reconnect', async () => {
    const w = await app()
    const coll = mc.db('live').collection(name('w7'))
    await coll.insertOne({ seed: true })
    const u = w.user()
    const first = await w.socket(u)
    const target = {
      connectionId: w.connectionId,
      scope: 'collection',
      db: 'live',
      coll: coll.collectionName,
    }
    const low = {
      ch: 'watch',
      type: 'sub',
      id: randomUUID(),
      ...target,
      filter: { 'fullDocument.n': { $lt: 10 } },
    }
    const high = {
      ch: 'watch',
      type: 'sub',
      id: randomUUID(),
      ...target,
      filter: { 'fullDocument.n': { $gte: 10 } },
    }
    first.send(low)
    first.send(high)
    await first.next('started', (m) => m.payload.id === low.id)
    await first.next('started', (m) => m.payload.id === high.id)
    await coll.insertMany([{ n: 1 }, { n: 11 }])
    while (first.events(low.id).length < 1 || first.events(high.id).length < 1) await wait(25)
    first.close()
    await first.closed
    await wait(100)
    await coll.insertMany([{ n: 2 }, { n: 12 }])
    const second = await w.socket(u)
    second.send(low)
    // The same id with other parameters starts from now.
    second.send({ ...high, filter: { 'fullDocument.n': { $gte: 100 } } })
    expect((await second.next('started', (m) => m.payload.id === low.id)).payload.resumed).toBe(true)
    expect((await second.next('started', (m) => m.payload.id === high.id)).payload.resumed).toBe(false)
    while (second.events(low.id).length < 1) await wait(25)
    await wait(300)
    const value = (e: { fullDocument?: unknown }) =>
      (e.fullDocument as { n: { $numberInt: string } }).n.$numberInt
    expect(second.events(low.id).map(value)).toEqual(['2'])
    expect(second.events(high.id)).toEqual([])
  })

  it('W8: every start and stop is audited, with the filter’s hash and never its values', async () => {
    const w = await app()
    const u = w.user()
    const c = await w.socket(u)
    const id = sub(w, c, { scope: 'deployment' }, { filter: { 'ns.coll': 'secret-name' } })
    await answer(c, id)
    c.send({ ch: 'watch', type: 'unsub', id })
    await wait(100)
    const other = sub(w, c, { scope: 'deployment' })
    await answer(c, other)
    c.close()
    await c.closed
    await wait(100)
    const starts = audit(w, 'watch.start')
    const stops = audit(w, 'watch.stop')
    expect(starts).toHaveLength(2)
    expect(stops.map((r) => JSON.parse(r.details).reason)).toEqual(['closed', 'disconnected'])
    expect(JSON.parse(starts[0]!.details).filter).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify([...starts, ...stops])).not.toContain('secret-name')
  })

  it('W5: a subscriber that stops reading never makes the server hold more than one outbox', async () => {
    const w = await app({ deps: { watch: { timing: { flushMs: 20, waitMs: 10, maxPerSecond: 100_000 } } } })
    const coll = mc.db('live').collection(name('w5o'))
    await coll.insertOne({ seed: true })
    const u = w.user()
    const id = randomUUID()
    const quiet = w.subscriber(u, () => false)
    await w.ctx.watch.start(
      u.id,
      {
        id,
        target: { connectionId: w.connectionId, scope: 'collection', db: 'live', coll: coll.collectionName },
        filter: {},
        options: WatchOptionsSchema.parse({}),
      },
      quiet,
    )
    await coll.insertMany(Array.from({ length: 1000 }, (_, i) => ({ n: i })))
    let most = 0
    for (let i = 0; i < 40; i++) {
      most = Math.max(most, w.ctx.watch.pending(u.id, id))
      await wait(25)
    }
    expect(most).toBeLessThanOrEqual(200)
    await w.ctx.watch.stop(u.id, id, quiet)
  })
})
