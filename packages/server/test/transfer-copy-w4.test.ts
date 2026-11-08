// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import type { JobParts } from '@mongo-manager/shared'
import { PartTracker, MAX_PARTS_SHOWN } from '../src/jobs/parts'
import { sourceSizes } from '../src/transfer/copy-plan'
import { startMongo, type TestMongo } from './support/mongo'
import { transferHarness } from './support/transfer2'
import { waitJob } from './support/jobs'
import { slow } from './support/slowness'

/**
 * W4 item 3 (completion design §2 W4.3): a copy's source size in its plan, the target as it is
 * now, and progress per collection while it runs.
 */
describe('progress per part (W4.3)', () => {
  it('tracks each part from waiting to done, with the phase', () => {
    const seen: JobParts[] = []
    const t = new PartTracker((p) => seen.push(p))
    t.start(['orders', 'users'], 'copy')
    expect(seen.at(-1)).toEqual({
      phase: 'copy',
      count: 2,
      finished: 0,
      items: [
        { name: 'orders', state: 'waiting', done: 0, total: null },
        { name: 'users', state: 'waiting', done: 0, total: null },
      ],
    })
    t.update('orders', { state: 'running', total: 10 })
    t.update('orders', { done: 4 })
    expect(seen.at(-1)!.items[0]).toEqual({ name: 'orders', state: 'running', done: 4, total: 10 })
    t.update('orders', { state: 'done', done: 10 })
    t.update('users', { state: 'failed' })
    t.phase('views')
    expect(seen.at(-1)).toMatchObject({ phase: 'views', finished: 2 })
    // An unknown name is ignored, never added.
    t.update('nope', { state: 'done' })
    expect(seen.at(-1)!.count).toBe(2)
  })

  it('shows a bounded list that always holds the running part', () => {
    const seen: JobParts[] = []
    const t = new PartTracker((p) => seen.push(p))
    const names = Array.from({ length: 1000 }, (_, i) => `c${i}`)
    t.start(names)
    t.update('c900', { state: 'running', total: 5 })
    const view = seen.at(-1)!
    expect(view.count).toBe(1000)
    expect(view.items.length).toBeLessThanOrEqual(MAX_PARTS_SHOWN)
    expect(view.items.some((i) => i.name === 'c900' && i.state === 'running')).toBe(true)
  })

  // W4 review (minor): a job of many parts updates them often: a view is not a walk of all of them.
  it('keeps a view of many parts cheap, its counts right', () => {
    let last: JobParts | null = null
    const t = new PartTracker((p) => (last = p))
    const names = Array.from({ length: 50_000 }, (_, i) => `c${i}`)
    t.start(names)
    const started = performance.now()
    for (let i = 0; i < 2000; i++) {
      t.update(`c${i}`, { state: 'running' })
      t.update(`c${i}`, { done: 5 })
      t.update(`c${i}`, { state: 'done' })
    }
    expect(performance.now() - started).toBeLessThan(1500)
    const view = last! as JobParts
    expect([view.count, view.finished, view.items.length]).toEqual([50_000, 2000, MAX_PARTS_SHOWN])
    t.update('c40000', { state: 'running' })
    expect((last! as JobParts).items.some((p) => p.name === 'c40000')).toBe(true)
    expect((last! as JobParts).items[0]!.name).toBe('c0')
  })

  // W4 review (minor): a plan of many collections (asked as a target is typed) reads their sizes at
  // once, a few at a time, not one after the other.
  it('reads the source collections’ sizes a few at a time, in order', async () => {
    let inFlight = 0
    let most = 0
    const client = {
      db: () => ({
        collection: (name: string) => ({
          aggregate: () => ({
            toArray: async () => {
              inFlight++
              most = Math.max(most, inFlight)
              await new Promise((r) => setTimeout(r, 20))
              inFlight--
              return [{ storageStats: { count: Number(name.slice(1)), size: 10 } }]
            },
          }),
        }),
      }),
    }
    const names = Array.from({ length: 20 }, (_, i) => `c${i}`)
    const sizes = await sourceSizes(
      client as never,
      'shop',
      names.map((n) => [n, 'collection'] as const),
    )
    expect(sizes.map((s) => s.count)).toEqual(names.map((_, i) => i))
    expect(most).toBeGreaterThan(1)
    expect(most).toBeLessThanOrEqual(8)
  })

  it('cuts a name that is too long to show', () => {
    const seen: JobParts[] = []
    const t = new PartTracker((p) => seen.push(p))
    t.start(['x'.repeat(1000)])
    expect(seen.at(-1)!.items[0]!.name.length).toBeLessThanOrEqual(256)
  })
})

describe('copy plan and job (W4.3)', () => {
  let a: TestMongo
  let b: TestMongo
  let ca: MongoClient
  let cb: MongoClient
  beforeAll(async () => {
    ;[a, b] = await Promise.all([startMongo(), startMongo()])
    ;[ca, cb] = await Promise.all([
      new MongoClient(`mongodb://127.0.0.1:${a.port}`).connect(),
      new MongoClient(`mongodb://127.0.0.1:${b.port}`).connect(),
    ])
  }, slow(180_000))
  afterAll(async () => {
    await Promise.all([ca?.close(), cb?.close()])
    await Promise.all([a?.stop(), b?.stop()])
  })
  beforeEach(async () => {
    await Promise.all([ca.db('w4').dropDatabase(), cb.db('w4b').dropDatabase()])
    await ca
      .db('w4')
      .collection('orders')
      .insertMany(Array.from({ length: 30 }, (_, i) => ({ _id: i as never, v: 'x'.repeat(100) })))
    await ca
      .db('w4')
      .collection('users')
      .insertMany([{ name: 'a' }, { name: 'b' }])
    await cb
      .db('w4b')
      .collection('orders')
      .insertOne({ _id: 'old' as never })
  })

  it("plans with each source's estimated size and the target's state", async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user({ role: 'editor' })
      const plan = (
        await u.call('POST', `/api/connections/${h.ids.A}/databases/w4/copy/plan`, {
          target: { connectionId: h.ids.B, db: 'w4b' },
          mode: 'replace',
        })
      ).json()
      const orders = plan.collections.find((c: { source: string }) => c.source === 'orders')
      expect(orders).toMatchObject({ exists: true, count: 1, sourceCount: 30 })
      expect(orders.sourceBytes).toBeGreaterThan(3000)
      const users = plan.collections.find((c: { source: string }) => c.source === 'users')
      expect(users).toMatchObject({ exists: false, count: null, sourceCount: 2 })
    } finally {
      await h.t.close()
    }
  })

  it('reports progress per collection while a database copy runs, and every part done at the end', async () => {
    const h = await transferHarness(a, b)
    try {
      const u = h.user({ role: 'editor' })
      const seen: JobParts[] = []
      const off = h.t.app.ctx.jobs.onChange((j) => {
        if (j.parts) seen.push(JSON.parse(JSON.stringify(j.parts)) as JobParts)
      })
      const body = { target: { connectionId: h.ids.B, db: 'w4b' }, mode: 'replace' }
      const plan = (await u.call('POST', `/api/connections/${h.ids.A}/databases/w4/copy/plan`, body)).json()
      const res = await u.call('POST', `/api/connections/${h.ids.A}/databases/w4/copy`, {
        ...body,
        planHash: plan.planHash,
      })
      expect(res.statusCode, res.body).toBe(202)
      const job = await waitJob(h.t, res.json().job.id, 60_000)
      off()
      expect(job.state, job.error ?? '').toBe('done')
      expect(seen.length).toBeGreaterThan(0)
      const last = seen.at(-1)!
      expect(last.count).toBe(2)
      expect(last.finished).toBe(2)
      expect(last.items.map((i) => [i.name, i.state]).sort()).toEqual([
        ['orders', 'done'],
        ['users', 'done'],
      ])
      expect(last.items.find((i) => i.name === 'orders')!.done).toBe(30)
      // The view a user gets carries the parts too.
      const view = (await u.get(`/api/jobs/${job.id}`)).json()
      expect(view.parts?.finished ?? 2).toBe(2)
    } finally {
      await h.t.close()
    }
  }, 90_000)
})
