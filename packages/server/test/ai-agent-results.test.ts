// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import type { AiChatLine } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness } from './support/data'
import { startFakeAi, type FakeCall } from './support/fake-ai'
import { agentReply } from './support/agent'

/**
 * The AI database manager (design 2026-10-25, B5): a find or an aggregation step carries the read it
 * made, so the panel shows its documents from the person's own read — to the person's browser only:
 * never kept with the turn, never told to the provider.
 */
let mongo: TestMongo
let client: MongoClient
beforeAll(async () => {
  mongo = await startMongo()
  client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
})
afterAll(async () => {
  await client?.close()
  await mongo?.stop()
})
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c()
})

const steps = (out: AiChatLine[]) =>
  out.flatMap((l) => (l.type === 'step' && l.step.state !== 'running' ? [l.step] : []))

async function agent() {
  const fake = await startFakeAi()
  closers.push(fake.close)
  const h = await dataHarness(mongo)
  closers.push(h.t.close)
  const inject = (method: 'GET' | 'POST' | 'PUT', path: string, payload?: object) =>
    h.t.app.inject({ method, url: `/api/${path}`, headers: h.headers, ...(payload ? { payload } : {}) })
  expect(
    (
      await inject('POST', 'ai/providers', {
        name: 'Fake',
        kind: 'openai',
        baseUrl: `${fake.url}/v1`,
        model: 'm',
      })
    ).statusCode,
  ).toBeLessThan(300)
  await inject('PUT', 'me/ai-agent', { on: true })
  const db = `b5${randomUUID().slice(0, 8)}`
  await client
    .db(db)
    .collection('orders')
    .insertMany([
      { n: 1, status: 'shipping', email: 'a@b5-unseen.test' },
      { n: 2, status: 'shipping', email: 'b@b5-unseen.test' },
      { n: 3, status: 'new', email: 'c@b5-unseen.test' },
    ])
  const once = (calls: FakeCall[], text = 'ok') =>
    fake.reply(agentReply((c) => (c.results.length === 0 ? { calls } : { text })))
  const turn = async (message: string) =>
    (await inject('POST', 'ai/agent', { message })).payload
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as AiChatLine)
  const kept = async () => {
    const { items } = (await inject('GET', 'ai/history')).json() as { items: Array<{ id: string }> }
    return (await inject('GET', `ai/history/${items[0]!.id}`)).json() as {
      content: { steps?: Array<Record<string, unknown>> }
    }
  }
  return { db, fake, once, turn, kept }
}

describe('a read step’s results in the panel (B5)', () => {
  it('carries a find’s read to the browser, never to the history or the provider', async () => {
    const { db, fake, once, turn, kept } = await agent()
    once([
      {
        name: 'find_documents',
        args: {
          connection: 'Test',
          database: db,
          collection: 'orders',
          filter: '{"status":"shipping"}',
          projection: '{"n":0}',
          sort: '{"n":-1}',
          limit: 5,
        },
      },
    ])
    const [step] = steps(await turn('shipping orders'))
    expect(step).toMatchObject({
      tool: 'find_documents',
      state: 'done',
      sent: 'counts',
      results: {
        kind: 'find',
        filter: { status: 'shipping' },
        projection: { n: { $numberInt: '0' } },
        sort: { n: { $numberInt: '-1' } },
        limit: 5,
      },
    })
    // The stored turn keeps names and counts only.
    expect(Object.keys((await kept()).content.steps![0]!)).not.toContain('results')
    // What the provider was told is the count, not the documents.
    expect(JSON.stringify(fake.requests.map((r) => r.body))).not.toContain('b5-unseen')
  })

  it('carries an aggregation’s pipeline as it ran', async () => {
    const { db, once, turn } = await agent()
    once([
      {
        name: 'run_aggregation',
        args: {
          connection: 'Test',
          database: db,
          collection: 'orders',
          pipeline: '[{"$match":{"status":"shipping"}},{"$project":{"n":1}}]',
          limit: 3,
        },
      },
    ])
    const [step] = steps(await turn('aggregate'))
    expect(step).toMatchObject({
      tool: 'run_aggregation',
      state: 'done',
      results: {
        kind: 'aggregate',
        stages: [{ $match: { status: 'shipping' } }, { $project: { n: { $numberInt: '1' } } }],
        limit: 3,
      },
    })
  })

  it('carries nothing for a read that was refused', async () => {
    const { db, once, turn } = await agent()
    once([
      {
        name: 'find_documents',
        args: { connection: 'Test', database: db, collection: 'orders', filter: '{"$where":"1"}' },
      },
    ])
    const [step] = steps(await turn('look'))
    expect(step!.state).toBe('refused')
    expect(step).not.toHaveProperty('results')
  })
})
