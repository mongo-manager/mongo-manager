// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import { AI_AGENT_LIMITS, type AiChatLine } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { slow } from './support/slowness'
import { dataHarness } from './support/data'
import { startFakeAi, type FakeCall } from './support/fake-ai'
import { agentReply, conversationOf } from './support/agent'

/**
 * The AI database manager (design 2026-10-25, C6): a read over a large collection is explained first,
 * and one that would scan the whole collection is said on its step before it runs — and to the model
 * with its end, so it can offer an index. A look at the first documents, or a small collection, never.
 */
let mongo: TestMongo
let client: MongoClient
const db = `c6${randomUUID().slice(0, 8)}`
beforeAll(async () => {
  mongo = await startMongo()
  client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
  const big = client.db(db).collection('big')
  const n = AI_AGENT_LIMITS.largeCollection + 10
  for (let i = 0; i < n; i += 20_000)
    await big.insertMany(
      Array.from({ length: Math.min(20_000, n - i) }, (_, k) => ({ n: i + k, tag: (i + k) % 7 })),
    )
  await big.createIndex({ tag: 1 })
  await client
    .db(db)
    .collection('small')
    .insertMany([{ n: 1 }, { n: 2 }])
  await client
    .db(db)
    .createCollection('bigView', { viewOn: 'big', pipeline: [{ $match: { n: { $gte: 0 } } }] })
}, slow(120_000))
afterAll(async () => {
  await client?.db(db).dropDatabase()
  await client?.close()
  await mongo?.stop()
})
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c()
})

async function agent() {
  const fake = await startFakeAi()
  closers.push(fake.close)
  const h = await dataHarness(mongo)
  closers.push(h.t.close)
  const inject = (method: 'POST' | 'PUT', path: string, payload?: object) =>
    h.t.app.inject({ method, url: `/api/${path}`, headers: h.headers, ...(payload ? { payload } : {}) })
  await inject('POST', 'ai/providers', {
    name: 'Fake',
    kind: 'openai',
    baseUrl: `${fake.url}/v1`,
    model: 'm',
  })
  await inject('PUT', 'me/ai-agent', { on: true })
  const ask = async (call: FakeCall) => {
    fake.reply(agentReply((c) => (c.results.length === 0 ? { calls: [call] } : { text: 'ok' })))
    const lines = (await inject('POST', 'ai/agent', { message: 'go' })).payload
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as AiChatLine)
    const r = conversationOf(fake.requests.at(-1)!.body).results.at(-1)!
    const told = JSON.parse(r.slice(r.indexOf('{'), r.lastIndexOf('}') + 1)) as Record<string, unknown>
    const steps = lines.flatMap((l) => (l.type === 'step' ? [l.step] : []))
    return { told, running: steps.filter((s) => s.state === 'running'), end: steps.at(-1)! }
  }
  return { ask }
}
const at = (collection: string, extra: object) => ({ connection: 'Test', database: db, collection, ...extra })

describe('a read over a large collection, explained first (C6)', () => {
  it('says a find no index serves reads the whole collection, before it runs and with its end', async () => {
    const { ask } = await agent()
    const { told, running, end } = await ask({
      name: 'find_documents',
      args: at('big', { filter: '{"n":{"$gt":5}}' }),
    })
    expect(
      running.some(
        (s) =>
          typeof s.summary?.scanning === 'number' && s.summary.scanning >= AI_AGENT_LIMITS.largeCollection,
      ),
    ).toBe(true)
    // Review of C6 (I2): under its limit it may stop at its first matches — said as "may".
    expect(end).toMatchObject({ state: 'done', summary: { scanned: expect.any(Number), scanMay: true } })
    expect(told).toMatchObject({ collectionScan: { documents: expect.any(Number), whole: false } })
    // An order no index serves reads every document before the first: said as whole.
    const sorted = await ask({ name: 'find_documents', args: at('big', { filter: '{}', sort: '{"n":-1}' }) })
    expect(sorted.end.summary).toMatchObject({ scanned: expect.any(Number) })
    expect(sorted.end.summary).not.toHaveProperty('scanMay')
    expect(sorted.told).toMatchObject({ collectionScan: { whole: true } })
  })

  it('says it of a count with a filter, a pipeline, and a field’s distinct values', async () => {
    const { ask } = await agent()
    for (const call of [
      { name: 'count_documents', args: at('big', { filter: '{"n":{"$lt":10}}' }) },
      {
        name: 'run_aggregation',
        args: at('big', { pipeline: '[{"$group":{"_id":"$tag","n":{"$sum":1}}}]' }),
      },
      { name: 'distinct_values', args: at('big', { field: 'n' }) },
      // Review of C6 (minor 3): a sample large enough is a scan and a sort.
      {
        name: 'run_aggregation',
        args: at('big', { pipeline: '[{"$sample":{"size":50000}},{"$sort":{"n":1}}]' }),
      },
    ]) {
      const { end, told } = await ask(call)
      expect(end.summary, call.name).toMatchObject({ scanned: expect.any(Number) })
      expect(told, call.name).toMatchObject({ collectionScan: { whole: true } })
    }
  })

  it('says nothing where an index serves it, of a look at the first documents, a pipeline cut short, or a small collection', async () => {
    const { ask } = await agent()
    for (const call of [
      { name: 'find_documents', args: at('big', { filter: '{"tag":3}' }) },
      { name: 'find_documents', args: at('big', {}) },
      { name: 'count_documents', args: at('big', { filter: '{}' }) },
      { name: 'run_aggregation', args: at('big', { pipeline: '[{"$limit":5},{"$match":{"n":{"$gt":1}}}]' }) },
      { name: 'find_documents', args: at('small', { filter: '{"n":{"$gt":0}}' }) },
    ]) {
      const { running, end, told } = await ask(call)
      expect(
        running.some((s) => s.summary?.scanning !== undefined),
        JSON.stringify(call),
      ).toBe(false)
      expect(end.summary ?? {}, JSON.stringify(call)).not.toHaveProperty('scanned')
      expect(told, JSON.stringify(call)).not.toHaveProperty('collectionScan')
    }
  })
})

// Re-review of C6.
describe('a read over a large collection, explained first: the re-review of C6', () => {
  it('says nothing of a view (its count would run its pipeline), nor of a pipeline that never filters', async () => {
    const { ask } = await agent()
    for (const call of [
      { name: 'find_documents', args: at('bigView', { filter: '{"n":{"$gt":5}}' }) },
      { name: 'run_aggregation', args: at('big', { pipeline: '[{"$project":{"n":1}}]' }) },
      { name: 'run_aggregation', args: at('big', { pipeline: '[{"$limit":3},{"$group":{"_id":"$tag"}}]' }) },
    ]) {
      const { end, told } = await ask(call)
      expect(end.summary ?? {}, JSON.stringify(call)).not.toHaveProperty('scanned')
      expect(told, JSON.stringify(call)).not.toHaveProperty('collectionScan')
    }
  })

  it('says a group after a limit may read far, a sample alone reads it whole', async () => {
    const { ask } = await agent()
    const limited = await ask({
      name: 'run_aggregation',
      args: at('big', { pipeline: '[{"$match":{"n":{"$gt":5}}},{"$limit":5},{"$group":{"_id":"$tag"}}]' }),
    })
    expect(limited.told).toMatchObject({ collectionScan: { whole: false } })
    const sampled = await ask({
      name: 'run_aggregation',
      args: at('big', { pipeline: '[{"$sample":{"size":50000}}]' }),
    })
    expect(sampled.told).toMatchObject({ collectionScan: { whole: true } })
  })

  it('still says the scan of a read that failed after it began', async () => {
    const { ask } = await agent()
    const { end, told } = await ask({
      name: 'run_aggregation',
      args: at('big', {
        pipeline: '[{"$match":{"n":{"$gt":5}}},{"$project":{"x":{"$divide":[1,{"$subtract":["$n","$n"]}]}}}]',
      }),
    })
    expect(end.state).not.toBe('done')
    expect(end.summary).toMatchObject({ scanned: expect.any(Number) })
    expect(told).toHaveProperty('collectionScan')
  })
})
