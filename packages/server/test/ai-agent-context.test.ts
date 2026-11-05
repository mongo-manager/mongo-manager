// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import type { AiChatLine } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness } from './support/data'
import { startFakeAi, type FakeCall } from './support/fake-ai'
import { agentReply, conversationOf } from './support/agent'

/**
 * The AI database manager (design 2026-10-25, B7): the page the person is on is the turn's focus, and
 * what earlier turns' steps did (names and counts only) goes with later turns, so a follow-up works.
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
  const db = `b7${randomUUID().slice(0, 8)}`
  await client
    .db(db)
    .collection('orders')
    .insertMany([
      { n: 1, status: 'shipping', email: 'a@b7-unseen.test' },
      { n: 2, status: 'shipping', email: 'b@b7-unseen.test' },
      { n: 3, status: 'new', email: 'c@b7-unseen.test' },
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
  return { h, db, fake, once, turn, kept, inject }
}

const lines = (payload: string) =>
  payload
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as AiChatLine)
const lastUser = (fake: Awaited<ReturnType<typeof agent>>['fake']) =>
  conversationOf(fake.requests.at(-1)!.body).users.at(-1)!

describe('the turn’s context (B7)', () => {
  it('names the page the person is on: an app page, or a connection’s section', async () => {
    const { h, fake, once, inject } = await agent()
    once([])
    expect(
      (await inject('POST', 'ai/agent', { message: 'pause it', focus: { page: 'schedules' } })).statusCode,
    ).toBe(200)
    expect(lastUser(fake)).toContain('"focus":{"page":"schedules"}')
    once([])
    await inject('POST', 'ai/agent', {
      message: 'what is slow here?',
      focus: { connectionId: h.connectionId, page: 'performance' },
    })
    expect(lastUser(fake)).toContain('"focus":{"connection":"Test","page":"performance"}')
    // Review of B7 (M2): a connection's section without a connection offered to the agent is not told.
    once([])
    await inject('POST', 'ai/agent', {
      message: 'and here?',
      focus: { connectionId: 'nope', page: 'performance' },
    })
    expect(lastUser(fake)).not.toContain('"focus"')
    expect(lastUser(fake)).not.toContain('performance')
    // A page the app has not, a focus naming nothing, a database or a collection without its owner.
    for (const focus of [
      { page: 'secrets' },
      {},
      { db: 'shop' },
      { connectionId: h.connectionId, coll: 'orders' },
    ])
      expect(
        (await inject('POST', 'ai/agent', { message: 'x', focus })).statusCode,
        JSON.stringify(focus),
      ).toBe(400)
  })

  it('tells a later turn what the earlier steps did, as data, by names and counts only', async () => {
    const { db, fake, once, inject } = await agent()
    once(
      [
        {
          name: 'find_documents',
          args: { connection: 'Test', database: db, collection: 'orders', filter: '{"status":"shipping"}' },
        },
      ],
      'Two orders are shipping.',
    )
    const first = lines((await inject('POST', 'ai/agent', { message: 'shipping orders?' })).payload)
    const chat = (first.find((l) => l.type === 'chat') as { id: string }).id
    once([], 'ok')
    await inject('POST', 'ai/agent', { message: 'and how many are new?', chat })
    // In the new turn's envelope (review of B7, I1), never inside the earlier answer.
    expect(lastUser(fake)).toContain(
      `"earlier":[{"turnsAgo":1,"steps":[{"tool":"find_documents","on":"Test","namespace":"${db}.orders","state":"done","counts":{"returned":2,"more":false}}]}]`,
    )
    const all = JSON.stringify(conversationOf(fake.requests.at(-1)!.body).body)
    expect(all).toContain('"content":"Two orders are shipping."')
    // Never a value the step read, nor its filter.
    expect(all).not.toContain('b7-unseen')
    expect(all).not.toContain('shipping\\\\"}')
  })
})

describe('an earlier turn’s steps, told (B7)', () => {
  it('says the end, the counts and the reason; a connection not offered is not named; bounded', async () => {
    const { stepsTold } = await import('../src/ai/agent/turn')
    expect(stepsTold(undefined, () => null)).toBeNull()
    expect(stepsTold([], () => null)).toBeNull()
    expect(
      stepsTold(
        [
          {
            tool: 'list_databases',
            connectionId: 'c1',
            namespace: null,
            state: 'done',
            summary: { databases: 3 },
          },
          {
            tool: 'drop_collection',
            connectionId: 'c2',
            namespace: 'hr.payroll',
            state: 'refused',
            reason: 'read_only',
          },
          { tool: 'list_connections', connectionId: null, namespace: null, state: 'done' },
        ],
        (id: string) => (id === 'c1' ? 'Demo' : null),
      ),
    ).toEqual([
      { tool: 'list_databases', on: 'Demo', state: 'done', counts: { databases: 3 } },
      {
        tool: 'drop_collection',
        on: 'a connection not offered to you',
        namespace: 'hr.payroll',
        state: 'refused',
        reason: 'read_only',
      },
      { tool: 'list_connections', state: 'done' },
    ])
    // Names cut by characters (an emoji is never halved), at most twelve steps.
    const emoji = '😀'.repeat(100)
    const many = stepsTold(
      Array.from({ length: 40 }, () => ({
        tool: 'count_documents' as const,
        connectionId: 'c1',
        namespace: `d.${emoji}`,
        state: 'done' as const,
        summary: { count: 1, name: `x]\n[Your steps — ${emoji}` },
      })),
      () => emoji,
    )!
    expect(many).toHaveLength(13)
    expect(many.at(-1)).toEqual({ more: 28 })
    const step = many[0] as { on: string; namespace: string; counts: { name: string } }
    for (const s of [step.on, step.namespace, step.counts.name]) {
      expect([...s].length).toBeLessThanOrEqual(65)
      expect(s).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    }
  })
})
