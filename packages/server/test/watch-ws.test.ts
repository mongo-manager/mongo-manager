// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
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

describe('the watch channel (phase 3e-1 spec §1.2)', () => {
  it('streams a collection’s changes, numbered, and stops on unsub', async () => {
    const w = await watchApp(set.getUri())
    apps.push(w.t)
    const c = await w.socket(w.user())
    const coll = mc.db('ws').collection(`c${randomUUID().slice(0, 8)}`)
    await coll.insertOne({ seed: true })
    const id = randomUUID()
    c.send({
      ch: 'watch',
      type: 'sub',
      id,
      connectionId: w.connectionId,
      scope: 'collection',
      db: 'ws',
      coll: coll.collectionName,
    })
    expect((await c.next('started')).payload).toEqual({
      id,
      preImages: false,
      resumed: false,
      gap: false,
      paused: false,
      exists: true,
    })
    await coll.insertOne({ n: 1 })
    await coll.updateOne({ n: 1 }, { $set: { n: 2 } })
    await coll.deleteOne({ n: 2 })
    for (let i = 0; i < 50 && c.events(id).length < 3; i++) await wait(50)
    expect(c.events(id).map((e) => [e.seq, e.op])).toEqual([
      [1, 'insert'],
      [2, 'update'],
      [3, 'delete'],
    ])
    c.send({ ch: 'watch', type: 'unsub', id })
    await wait(100)
    expect(w.ctx.watch.count()).toBe(0)
  })

  it('refuses a fourth feed on one socket, and answers a refusal in words', async () => {
    const w = await watchApp(set.getUri())
    apps.push(w.t)
    const c = await w.socket(w.user())
    for (let i = 0; i < 3; i++) {
      const id = randomUUID()
      c.send({ ch: 'watch', type: 'sub', id, connectionId: w.connectionId, scope: 'deployment' })
      await c.next('started', (m) => m.payload.id === id)
    }
    const fourth = randomUUID()
    c.send({ ch: 'watch', type: 'sub', id: fourth, connectionId: w.connectionId, scope: 'deployment' })
    expect((await c.next('error', (m) => m.payload.id === fourth)).payload).toEqual({
      id: fourth,
      reason: 'limit',
      detail: 'socket',
    })
  })

  it('ignores pause, resume and unsub for a feed another socket owns (W7)', async () => {
    const w = await watchApp(set.getUri())
    apps.push(w.t)
    const u = w.user()
    const a = await w.socket(u)
    const b = await w.socket(u)
    const id = randomUUID()
    a.send({ ch: 'watch', type: 'sub', id, connectionId: w.connectionId, scope: 'deployment' })
    await a.next('started')
    b.send({ ch: 'watch', type: 'unsub', id })
    b.send({ ch: 'watch', type: 'pause', id })
    await wait(150)
    expect(w.ctx.watch.count()).toBe(1)
    expect(a.messages.some((m) => m.type === 'paused')).toBe(false)
  })

  it('resumes after a reconnect without missing or repeating an event (spec §1.2 step 7)', async () => {
    const w = await watchApp(set.getUri())
    apps.push(w.t)
    const u = w.user()
    const coll = mc.db('ws').collection(`r${randomUUID().slice(0, 8)}`)
    await coll.insertOne({ seed: true })
    const id = randomUUID()
    const sub = {
      ch: 'watch',
      type: 'sub',
      id,
      connectionId: w.connectionId,
      scope: 'collection',
      db: 'ws',
      coll: coll.collectionName,
    }
    const first = await w.socket(u)
    first.send(sub)
    await first.next('started')
    await coll.insertOne({ n: 1 })
    for (let i = 0; i < 50 && first.events(id).length < 1; i++) await wait(50)
    first.close()
    await first.closed
    await wait(100)
    // While no socket is there.
    await coll.insertMany([{ n: 2 }, { n: 3 }])
    const second = await w.socket(u)
    second.send(sub)
    expect((await second.next('started')).payload).toMatchObject({ resumed: true })
    await coll.insertOne({ n: 4 })
    for (let i = 0; i < 80 && second.events(id).length < 3; i++) await wait(50)
    const seen = [...first.events(id), ...second.events(id)].map(
      (e) => (e.fullDocument as { n: { $numberInt: string } }).n.$numberInt,
    )
    expect(seen).toEqual(['1', '2', '3', '4'])
  })

  // Final review I3: a reconnect takes the feed over; the old socket's late close leaves it running.
  it('keeps a feed a new socket took over when the old socket closes late', async () => {
    const w = await watchApp(set.getUri())
    apps.push(w.t)
    const u = w.user()
    const coll = mc.db('ws').collection(`t${randomUUID().slice(0, 8)}`)
    await coll.insertOne({ seed: true })
    const id = randomUUID()
    const sub = {
      ch: 'watch',
      type: 'sub',
      id,
      connectionId: w.connectionId,
      scope: 'collection',
      db: 'ws',
      coll: coll.collectionName,
    }
    const old = await w.socket(u)
    old.send(sub)
    await old.next('started')
    const fresh = await w.socket(u)
    fresh.send(sub)
    expect((await fresh.next('started')).payload).toMatchObject({ resumed: true })
    // The old socket still tries to act on the id, then closes.
    old.send({ ch: 'watch', type: 'pause', id })
    old.close()
    await old.closed
    await wait(200)
    await coll.insertOne({ n: 1 })
    for (let i = 0; i < 60 && fresh.events(id).length < 1; i++) await wait(50)
    expect(fresh.events(id)).toHaveLength(1)
    expect(fresh.messages.some((m) => m.type === 'paused')).toBe(false)
    expect(w.ctx.watch.count()).toBe(1)
  })
})
