import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness } from './support/data'
import { contextFor, wantsFor } from '../src/ai/context'

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
  for (const c of closers.splice(0)) await c()
})
const LOCAL = { kind: 'local', userId: 'local', username: 'owner', role: 'admin', csrfToken: 'x' } as const

describe('a context built from parts (phase 4a-2 spec §1.3)', () => {
  it('carries indexes and the validator only when wanted, never a plan', async () => {
    const h = await dataHarness(mongo)
    closers.push(h.t.close)
    const db = `cw${randomUUID().slice(0, 8)}`
    await client.db(db).createCollection('orders', { validator: { $jsonSchema: { required: ['qty'] } } })
    await client
      .db(db)
      .collection('orders')
      .createIndex({ qty: 1 }, { partialFilterExpression: { qty: { $gt: 9 } } })
    await client.db(db).collection('orders').insertOne({ qty: 10 })
    const base = {
      ctx: h.t.app.ctx,
      principal: LOCAL,
      connectionId: h.connectionId,
      client: await h.client(),
      db,
      coll: 'orders',
      comment: 'mm-ai-test',
      signal: new AbortController().signal,
    }
    const bare = await contextFor(base, { plan: false, indexes: false, validator: false })
    expect(bare).toMatchObject({ indexes: null, validator: null, plan: null, current: null })
    const all = await contextFor(
      { ...base, current: { filter: { qty: { $numberInt: '3' } } } },
      { plan: false, indexes: true, validator: true },
    )
    expect(all.plan).toBeNull()
    expect(all.indexes).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'qty_1', keys: { qty: 1 }, partial: true })]),
    )
    expect(JSON.stringify(all.indexes)).not.toContain('$gt')
    expect(all.validator).toContain('required')
    expect(all.current).toContain('qty')
    expect(wantsFor('optimise')).toEqual({ plan: true, indexes: false, validator: false, related: false })
    expect(wantsFor('validation')).toEqual({ plan: false, indexes: false, validator: true, related: false })
    // UI redesign R1 review: related collections' schemas go with a query or a pipeline only.
    expect(wantsFor('query').related).toBe(true)
    expect(wantsFor('pipeline').related).toBe(true)
    expect(wantsFor('describe').related).toBe(false)
  })
})
