// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import type { AiChatLine } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, teamAdminHarness } from './support/data'
import { startFakeAi, type FakeCall } from './support/fake-ai'
import { agentReply, conversationOf } from './support/agent'

/**
 * The AI database manager (design 2026-10-25, C2): a field's distinct values — told to the provider
 * only under the person's consent for that message and only as the personal-data rules let them go;
 * otherwise how many there are. Read through the person's own aggregation (their rights and gate).
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

async function agent(samples: boolean) {
  const fake = await startFakeAi()
  closers.push(fake.close)
  const h = await dataHarness(mongo)
  closers.push(h.t.close)
  const inject = (method: 'GET' | 'POST' | 'PUT', path: string, payload?: object) =>
    h.t.app.inject({ method, url: `/api/${path}`, headers: h.headers, ...(payload ? { payload } : {}) })
  await inject('POST', 'ai/providers', {
    name: 'F',
    kind: 'openai',
    baseUrl: `${fake.url}/v1`,
    model: 'm',
    samples,
  })
  await inject('PUT', 'me/ai-agent', { on: true })
  const db = `c2${randomUUID().slice(0, 8)}`
  await client
    .db(db)
    .collection('orders')
    .insertMany([
      { status: 'shipping', tags: ['a', 'b'], email: 'x1@c2-unseen.test' },
      { status: 'shipping', tags: ['a'], email: 'x2@c2-unseen.test' },
      { status: 'new', tags: [], email: 'x3@c2-unseen.test' },
    ])
  const once = (calls: FakeCall[]) =>
    fake.reply(agentReply((c) => (c.results.length === 0 ? { calls } : { text: 'ok' })))
  const turn = async (body: object) =>
    (await inject('POST', 'ai/agent', body)).payload
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as AiChatLine)
  const told = () => {
    const r = conversationOf(fake.requests.at(-1)!.body).results.at(-1)!
    return JSON.parse(r.slice(r.indexOf('{'), r.lastIndexOf('}') + 1)) as Record<string, unknown>
  }
  const sent = () => JSON.stringify(fake.requests.map((r) => r.body))
  return { h, db, once, turn, told, sent }
}

describe('a field’s distinct values (C2)', () => {
  it('tells the values, most frequent first, under the consent for this message', async () => {
    const { db, once, turn, told } = await agent(true)
    once([
      {
        name: 'distinct_values',
        args: { connection: 'Test', database: db, collection: 'orders', field: 'status' },
      },
    ])
    const [step] = steps(await turn({ message: 'which statuses?', documents: true }))
    expect(step).toMatchObject({
      tool: 'distinct_values',
      state: 'done',
      sent: 'documents',
      summary: { distinct: 2 },
    })
    expect(told()).toMatchObject({
      distinct: 2,
      values: [
        { value: 'shipping', count: 2 },
        { value: 'new', count: 1 },
      ],
    })
    // An array's elements, each a value (as MongoDB's distinct counts them).
    once([
      {
        name: 'distinct_values',
        args: { connection: 'Test', database: db, collection: 'orders', field: 'tags' },
      },
    ])
    await turn({ message: 'which tags?', documents: true })
    expect(told()).toMatchObject({
      distinct: 2,
      values: [
        { value: 'a', count: 2 },
        { value: 'b', count: 1 },
      ],
    })
  })

  it('tells only how many without the consent, or where the provider may not receive values', async () => {
    const { db, once, turn, told, sent } = await agent(true)
    once([
      {
        name: 'distinct_values',
        args: { connection: 'Test', database: db, collection: 'orders', field: 'email' },
      },
    ])
    const [step] = steps(await turn({ message: 'which emails?' }))
    expect(step).toMatchObject({ state: 'done', sent: 'counts', summary: { distinct: 3 } })
    expect(told()).toMatchObject({ distinct: 3 })
    expect(told()).not.toHaveProperty('values')
    expect(sent()).not.toContain('c2-unseen')
  })

  it('never tells a personal field’s values, consent or not', async () => {
    const { h, db, once, turn, sent } = await agent(true)
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'orders', field: 'email' }])
    once([
      {
        name: 'distinct_values',
        args: { connection: 'Test', database: db, collection: 'orders', field: 'email' },
      },
    ])
    const [step] = steps(await turn({ message: 'which emails?', documents: true }))
    // Grouped by a personal field, the gate refuses the read itself (its values would be keys).
    expect(step).toMatchObject({ state: 'refused', reason: 'personal_field' })
    expect(sent()).not.toContain('c2-unseen')
  })

  it('refuses a field that is no path, and a filter with server JavaScript', async () => {
    const { db, once, turn } = await agent(true)
    // Re-review of C2 (M2): an array position too.
    for (const field of ['$status', '', 'a..b', 'x'.repeat(300), 'tags.0']) {
      once([
        { name: 'distinct_values', args: { connection: 'Test', database: db, collection: 'orders', field } },
      ])
      expect(steps(await turn({ message: 'x' }))[0], field).toMatchObject({
        state: 'refused',
        reason: 'invalid_arguments',
      })
    }
    once([
      {
        name: 'distinct_values',
        args: {
          connection: 'Test',
          database: db,
          collection: 'orders',
          field: 'status',
          filter: '{"$where":"1"}',
        },
      },
    ])
    expect(steps(await turn({ message: 'x' }))[0]).toMatchObject({ state: 'refused', reason: 'server_js' })
  })
})

// Review of C2: the agent's own personal-data check for everyone; arrays of subdocuments; null.
describe('a field’s distinct values: the review of C2', () => {
  it('refuses a personal field, or a filter on one, for someone nothing is hidden from (C1)', async () => {
    const fake = await startFakeAi()
    closers.push(fake.close)
    const h = await teamAdminHarness(mongo, { ai: { privateNetworks: ['127.0.0.1/32'] } } as never)
    closers.push(h.t.close)
    const inject = (method: 'POST' | 'PUT', path: string, payload?: object) =>
      h.t.app.inject({ method, url: `/api/${path}`, headers: h.headers, ...(payload ? { payload } : {}) })
    await inject('POST', 'ai/providers', {
      name: 'F',
      kind: 'openai',
      baseUrl: `${fake.url}/v1`,
      model: 'm',
      samples: true,
    })
    await inject('PUT', 'me/ai-agent', { on: true })
    const db = `c2t${randomUUID().slice(0, 6)}`
    await client
      .db(db)
      .collection('people')
      .insertMany([
        { email: 'x1@c2-team.test', status: 'a' },
        { email: 'x2@c2-team.test', status: 'b' },
      ])
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'people', field: 'email' }])
    const ask = async (args: object) => {
      fake.reply(
        agentReply((c) =>
          c.results.length === 0
            ? {
                calls: [
                  {
                    name: 'distinct_values',
                    args: { connection: 'Test', database: db, collection: 'people', ...args },
                  },
                ],
              }
            : { text: 'ok' },
        ),
      )
      const out = (await inject('POST', 'ai/agent', { message: 'x', documents: true })).payload
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as AiChatLine)
      return steps(out)[0]!
    }
    expect(await ask({ field: 'email' })).toMatchObject({ state: 'refused', reason: 'personal_field' })
    expect(await ask({ field: 'status', filter: '{"email":{"$regex":"^x1"}}' })).toMatchObject({
      state: 'refused',
      reason: 'personal_field',
    })
    const all = JSON.stringify(fake.requests.map((r) => r.body))
    expect(all).not.toContain('"distinct"')
    expect(all).not.toContain('c2-team')
  })

  // Re-review of C3 (minor 3): a path through a sub-document that holds a personal field is walked as
  // written, with no note that the answer was changed.
  it('walks an array beside a personal field with no note that the answer changed', async () => {
    const { h, db, once, turn, told } = await agent(true)
    await client
      .db(db)
      .collection('carts')
      .insertMany([
        {
          items: [
            { sku: 'a', price: 1 },
            { sku: 'b', price: 2 },
          ],
        },
        { items: [{ sku: 'a', price: 3 }] },
      ])
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'carts', field: 'items.price' }])
    once([
      {
        name: 'distinct_values',
        args: { connection: 'Test', database: db, collection: 'carts', field: 'items.sku' },
      },
    ])
    await turn({ message: 'skus?', documents: true })
    expect(told()).toMatchObject({ distinct: 2 })
    expect(told()).not.toHaveProperty('rewritten')
  })

  it('counts a field through an array of subdocuments, and an explicit null, as MongoDB does', async () => {
    const { db, once, turn, told } = await agent(true)
    await client
      .db(db)
      .collection('carts')
      .insertMany([
        { items: [{ sku: 'a' }, { sku: 'b' }], note: null },
        { items: [{ sku: 'a' }], note: 'x' },
        { items: [] },
      ])
    once([
      {
        name: 'distinct_values',
        args: { connection: 'Test', database: db, collection: 'carts', field: 'items.sku' },
      },
    ])
    await turn({ message: 'skus?', documents: true })
    expect(told()).toMatchObject({
      distinct: 2,
      values: [
        { value: 'a', count: 2 },
        { value: 'b', count: 1 },
      ],
    })
    once([
      {
        name: 'distinct_values',
        args: { connection: 'Test', database: db, collection: 'carts', field: 'note' },
      },
    ])
    await turn({ message: 'notes?', documents: true })
    expect(told()).toMatchObject({ distinct: 2 })
    expect((told().values as Array<{ value: unknown }>).map((v) => v.value).sort()).toEqual(
      [null, 'x'].sort(),
    )
    // Arrays at two levels of the path.
    await client
      .db(db)
      .collection('shops')
      .insertMany([{ orders: [{ items: [{ sku: 'a' }, { sku: 'c' }] }, { items: [{ sku: 'a' }] }] }])
    once([
      {
        name: 'distinct_values',
        args: { connection: 'Test', database: db, collection: 'shops', field: 'orders.items.sku' },
      },
    ])
    await turn({ message: 'deep skus?', documents: true })
    expect(told()).toMatchObject({
      distinct: 2,
      values: [
        { value: 'a', count: 2 },
        { value: 'c', count: 1 },
      ],
    })
    // Re-review of C2 (M3): MongoDB does not walk an array of arrays above the field.
    await client
      .db(db)
      .collection('nested')
      .insertOne({ a: [[{ b: 1 }]] })
    once([
      {
        name: 'distinct_values',
        args: { connection: 'Test', database: db, collection: 'nested', field: 'a.b' },
      },
    ])
    await turn({ message: 'nested?', documents: true })
    expect(told()).toMatchObject({ distinct: 0 })
    // None at all: counts, nothing sent as documents.
    once([
      {
        name: 'distinct_values',
        args: { connection: 'Test', database: db, collection: 'carts', field: 'nowhere' },
      },
    ])
    const [none] = steps(await turn({ message: 'nothing?', documents: true }))
    expect(none).toMatchObject({ sent: 'counts', summary: { distinct: 0 } })
  })
})
