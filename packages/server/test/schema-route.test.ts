import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Collection, MongoClient } from 'mongodb'
import { ConnectionSettingsSchema, type Role, type SchemaAnalysis } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { H, makeApp, type TestApp } from './helpers'

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
const apps: TestApp[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const t of apps.splice(0)) await t.close()
})

async function setup() {
  const t = await makeApp({ auth: true })
  apps.push(t)
  const { ctx } = t.app
  const connectionId = ctx.connections.create(
    {
      name: 'M',
      favorite: false,
      readOnly: false,
      settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port: mongo.port }] }),
    },
    null,
  ).id
  const as = (role: Role) => {
    const user = ctx.users.create({ username: `u-${role}-${Math.random()}`, passwordHash: 'x', role })
    const { sessionId, session } = ctx.sessions.create(user.id, {})
    return (method: 'GET' | 'POST', path: string, payload?: object) =>
      t.app.inject({
        method,
        url: `/api/connections/${connectionId}/${path}`,
        headers: { ...H, 'x-csrf-token': session.csrfToken },
        cookies: { mm_sid: sessionId },
        ...(payload ? { payload } : {}),
      })
  }
  const db = `d${randomUUID().slice(0, 8)}`
  return { t, as, db }
}

describe('schema analysis route (phase 1i spec §5)', () => {
  it('analyses a sample for anyone who may read the collection, keeping BSON number types', async () => {
    const { as, db } = await setup()
    await client
      .db(db)
      .collection('orders')
      .insertMany(Array.from({ length: 300 }, (_, i) => ({ name: `n${i % 7}`, qty: i, price: i + 0.5 })))
    const res = await as('viewer')('POST', `databases/${db}/collections/orders/schema`, { sampleSize: 100 })
    expect(res.statusCode).toBe(200)
    const a = res.json() as SchemaAnalysis
    expect(a.sampled).toBe(100)
    const types = Object.fromEntries(a.fields.map((f) => [f.path, f.types]))
    expect(types).toMatchObject({
      _id: { objectId: 100 },
      name: { string: 100 },
      qty: { int: 100 },
      price: { double: 100 },
    })
  })

  it('refuses sample sizes out of range, and credential collections for non-admins', async () => {
    const { as, db } = await setup()
    const editor = as('editor')
    for (const sampleSize of [50, 20_000, 1.5])
      expect(
        (await editor('POST', `databases/${db}/collections/orders/schema`, { sampleSize })).statusCode,
      ).toBe(400)
    expect((await editor('POST', 'databases/admin/collections/system.users/schema', {})).statusCode).toBe(403)
  })

  it('analyses 10 000 documents of 60 fields within the limits (Review Focus 5)', async () => {
    const { as, db } = await setup()
    const docs = Array.from({ length: 10_000 }, (_, i) =>
      Object.fromEntries(Array.from({ length: 60 }, (_, f) => [`f${f}`, (i * f) % 97])),
    )
    await client.db(db).collection('wide').insertMany(docs)
    const started = Date.now()
    const res = await as('editor')('POST', `databases/${db}/collections/wide/schema`, { sampleSize: 10_000 })
    expect(res.statusCode).toBe(200)
    const a = res.json() as SchemaAnalysis
    expect([a.sampled, a.fields.length, a.truncated]).toEqual([10_000, 61, false])
    expect(Date.now() - started).toBeLessThan(20_000)
  }, 60_000)

  it('tags its aggregate, with a time limit and without disk use, so a closed request can stop it', async () => {
    const { as, db } = await setup()
    await client.db(db).collection('orders').insertOne({ a: 1 })
    const spy = vi.spyOn(Collection.prototype, 'aggregate')
    await as('editor')('POST', `databases/${db}/collections/orders/schema`, {})
    const [pipeline, options] = spy.mock.calls.at(-1)!
    expect(pipeline).toEqual([{ $sample: { size: 1000 } }])
    expect(options).toMatchObject({ maxTimeMS: 60_000, allowDiskUse: false, promoteValues: false })
    expect(String((options as { comment?: unknown }).comment)).toMatch(/^mm:/)
  })

  // W1 review (minor 8): the composer's suggestions ask for a short sample with a short time limit;
  // a longer one than the analysis's own is refused.
  it('takes a shorter time limit, never a longer one', async () => {
    const { as, db } = await setup()
    await client.db(db).collection('orders').insertOne({ a: 1 })
    const spy = vi.spyOn(Collection.prototype, 'aggregate')
    const res = await as('viewer')('POST', `databases/${db}/collections/orders/schema`, {
      sampleSize: 100,
      maxTimeMS: 3_000,
    })
    expect(res.statusCode).toBe(200)
    expect(spy.mock.calls.at(-1)![1]).toMatchObject({ maxTimeMS: 3_000 })
    for (const maxTimeMS of [120_000, 10, 1.5])
      expect(
        (await as('viewer')('POST', `databases/${db}/collections/orders/schema`, { maxTimeMS })).statusCode,
      ).toBe(400)
  })
})

describe('collection stats (phase 1i spec §7)', () => {
  it('include the size of each index', async () => {
    const { as, db } = await setup()
    await client
      .db(db)
      .collection('orders')
      .insertMany([{ n: 1 }, { n: 2 }])
    await client.db(db).collection('orders').createIndex({ n: 1 })
    const stats = (await as('viewer')('GET', `databases/${db}/collections/orders/stats`)).json()
    expect(Object.keys(stats.indexSizes).sort()).toEqual(['_id_', 'n_1'])
    expect(stats.indexSizes.n_1).toBeGreaterThan(0)
  })
})
