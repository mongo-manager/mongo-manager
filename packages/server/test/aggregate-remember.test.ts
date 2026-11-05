// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness } from './support/data'

let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
})
afterAll(async () => {
  await mongo?.stop()
})
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c()
})

describe('a pipeline run for a plugin is not one of the user’s recent pipelines (wave 1 review M2)', () => {
  it('remembers a run unless asked not to', async () => {
    const h = await dataHarness(mongo)
    closers.push(h.t.close)
    const db = `ar${randomUUID().slice(0, 8)}`
    await (await h.client()).db(db).collection('c').insertOne({ a: 1 })
    const run = (body: object) => h.call('POST', `/databases/${db}/collections/c/aggregate/run`, body)
    const recent = () =>
      h.t.app.ctx.history
        .list({ owner: null, connectionId: h.connectionId, limit: 10 })
        .filter((e) => e.db === db)
    expect((await run({ stages: [{ $match: { a: 1 } }], remember: false })).statusCode).toBe(200)
    expect(recent()).toHaveLength(0)
    expect((await run({ stages: [{ $match: { a: 1 } }] })).statusCode).toBe(200)
    expect(recent()).toHaveLength(1)
  })
})
