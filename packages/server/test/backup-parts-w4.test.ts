// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import type { JobParts } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { waitJob } from './support/jobs'
import { fixture } from './support/mongo-tools'
import { slow } from './support/slowness'

/**
 * W4 item 4 (completion design §2 W4.4, 3d-3a spec U8): a dump's and a restore's progress per
 * namespace, with the phase, while the job runs.
 */
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
  await ca.db('w4b').dropDatabase()
  await cb.db('w4r').dropDatabase()
  await ca
    .db('w4b')
    .collection('orders')
    .insertMany(Array.from({ length: 50 }, (_, i) => ({ _id: i as never, n: i })))
  await ca
    .db('w4b')
    .collection('users')
    .insertMany([{ name: 'a' }, { name: 'b' }])
})

type H = Awaited<ReturnType<typeof backupHarness>>
function watchParts(h: H): { seen: JobParts[]; off: () => void } {
  const seen: JobParts[] = []
  const off = h.t.app.ctx.jobs.onChange((j) => {
    if (j.parts) seen.push(JSON.parse(JSON.stringify(j.parts)) as JobParts)
  })
  return { seen, off }
}

describe('backup progress per namespace (W4.4)', () => {
  it('a dump reports each namespace with its documents, and every one done at the end', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user({ role: 'admin' })
      const { seen, off } = watchParts(h)
      const body = { scope: { kind: 'database', db: 'w4b' }, format: 'gzip' }
      const plan = (await u.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
      const res = await u.call('POST', `/api/connections/${h.ids.A}/backup`, {
        ...body,
        planHash: plan.planHash,
      })
      expect(res.statusCode, res.body).toBe(202)
      const job = await waitJob(h.t, res.json().job.id, 60_000)
      off()
      expect(job.state, job.error ?? '').toBe('done')
      const last = seen.at(-1)!
      expect(last.count).toBe(2)
      expect(last.finished).toBe(2)
      const orders = last.items.find((i) => i.name === 'w4b.orders')!
      expect(orders).toMatchObject({ state: 'done', done: 50 })
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('a restore reports each target namespace, and the phases after the documents', async () => {
    const h = await backupHarness(a, b)
    try {
      const u = h.user({ role: 'admin' })
      const file = Buffer.from(fixture('shop.archive'))
      const id = (
        await u.call('POST', '/api/backups/uploads', { name: 'x.archive', size: file.length })
      ).json().uploadId as string
      await u.raw('PUT', `/api/backups/uploads/${id}?offset=0`, file)
      const { seen, off } = watchParts(h)
      const body = {
        source: { kind: 'upload', uploadId: id },
        mapping: [
          { from: { db: 'shop', coll: 'orders' }, to: { db: 'w4r', coll: 'orders' } },
          { from: { db: 'shop', coll: 'empty' }, to: { db: 'w4r', coll: 'empty' } },
        ],
        confirmTtl: true,
      }
      const plan = await u.call('POST', `/api/connections/${h.ids.B}/restore/plan`, body)
      expect(plan.statusCode, plan.body).toBe(200)
      const res = await u.call('POST', `/api/connections/${h.ids.B}/restore`, {
        ...body,
        planHash: plan.json().planHash,
      })
      expect(res.statusCode, res.body).toBe(202)
      const job = await waitJob(h.t, res.json().job.id, 60_000)
      off()
      expect(job.state, job.error ?? '').toBe('done')
      const last = seen.at(-1)!
      expect(last.items.map((i) => i.name).sort()).toEqual(['w4r.empty', 'w4r.orders'])
      expect(last.items.every((i) => i.state === 'done')).toBe(true)
      expect(last.items.find((i) => i.name === 'w4r.orders')!.done).toBeGreaterThan(0)
    } finally {
      await h.t.close()
    }
  }, 90_000)
})
