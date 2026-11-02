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

describe('a find for a plugin is not one of the user’s recent queries (wave 2 review I1)', () => {
  it('remembers a find unless asked not to', async () => {
    const h = await dataHarness(mongo)
    closers.push(h.t.close)
    const db = `fr${randomUUID().slice(0, 8)}`
    await (await h.client()).db(db).collection('c').insertOne({ a: 1 })
    const run = (body: object) => h.call('POST', `/databases/${db}/collections/c/find`, body)
    const recent = () =>
      h.t.app.ctx.history
        .list({ owner: null, connectionId: h.connectionId, limit: 10 })
        .filter((e) => e.db === db)
    expect((await run({ filter: { a: 1 }, remember: false })).statusCode).toBe(200)
    expect(recent()).toHaveLength(0)
    expect((await run({ filter: { a: 1 } })).statusCode).toBe(200)
    expect(recent()).toHaveLength(1)
  })
})
