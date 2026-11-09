// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { startTestWorker, type TestWorker } from './support/shell-worker'
import { slow } from './support/slowness'

/**
 * Phase 3a-2 spec §3.2: the real worker completes code inside its sandbox (--permission, no code
 * generation, network locked to the proxy). Completion type-analyses the code; it never runs it.
 */
let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
}, slow(120_000))
afterAll(async () => {
  await mongo?.stop()
})

const workers: TestWorker[] = []
afterEach(() => {
  for (const w of workers.splice(0)) w.close()
})

async function readyWorker(): Promise<TestWorker> {
  const { worker } = await startTestWorker({
    uri: `mongodb://${mongo.host}:${mongo.port}/?directConnection=true`,
    db: 'shop',
  })
  workers.push(worker)
  await worker.next('ready', 20_000)
  return worker
}

async function complete(worker: TestWorker, id: number, code: string): Promise<string[]> {
  worker.send({ type: 'complete', id, code })
  const reply = (await worker.next('completions', 30_000)) as { id: number; items: string[] }
  expect(reply.id).toBe(id)
  return reply.items
}

describe('completion in the sandboxed worker (phase 3a-2)', () => {
  it('completes shell methods under the permission model (A6)', async () => {
    const worker = await readyWorker()
    const items = await complete(worker, 1, 'db.getCollectionN')
    expect(items).toContain('db.getCollectionNames')
    // The worker is still healthy afterwards.
    const r = await worker.evaluate('1 + 1')
    expect(r.ok).toBe(true)
  }, 60_000)

  it('never runs the code it completes (A5)', async () => {
    const worker = await readyWorker()
    // The completion really happened (items came back), so an empty timed-out answer cannot pass.
    const items = await complete(worker, 2, 'db.cmark.insertOne({x:1}); db.getCollectionN')
    expect(items.some((i) => i.endsWith('db.getCollectionNames'))).toBe(true)
    // Give any stray write time to land before counting (final review M10).
    await new Promise((r) => setTimeout(r, 500))
    const client = new MongoClient(`mongodb://${mongo.host}:${mongo.port}/?directConnection=true`)
    try {
      expect(await client.db('shop').collection('cmark').countDocuments()).toBe(0)
    } finally {
      await client.close()
    }
  }, 60_000)

  it('runs a command only after a pending completion has finished (final review I2)', async () => {
    const worker = await readyWorker()
    const order: string[] = []
    worker.child.on('message', (m: { type: string }) => order.push(m.type))
    worker.send({ type: 'complete', id: 5, code: 'db.getCollectionN' })
    worker.send({ type: 'eval', id: 6, code: '1 + 1' })
    await worker.next('done', 30_000)
    expect(order.indexOf('completions')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('completions')).toBeLessThan(order.indexOf('result'))
  }, 60_000)

  it('answers nothing while a command runs, and the command still finishes (review focus 1)', async () => {
    const worker = await readyWorker()
    worker.send({ type: 'eval', id: 3, code: 'sleep(500); 1' })
    const items = await complete(worker, 4, 'db.')
    expect(items).toEqual([])
    const done = (await worker.next('done', 10_000)) as { id: number }
    expect(done.id).toBe(3)
  }, 60_000)
})
