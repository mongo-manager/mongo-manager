import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import { AI_LIMITS, AiRequestSchema, serializeValue, type AiSent } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, type DataHarness } from './support/data'
import { buildContext, capContext, cutDocument } from '../src/ai/context'
import type { Principal } from '../src/http/context'

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
const harnesses: DataHarness[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.t.close()
})
const LOCAL: Principal = { kind: 'local', userId: 'local', username: 'owner', role: 'admin', csrfToken: '' }

async function setup(rules: Array<{ db: string; coll: string; field: string }> = []) {
  const h = await dataHarness(mongo)
  harnesses.push(h)
  const db = `ai${randomUUID().slice(0, 8)}`
  if (rules.length)
    h.t.app.ctx.personalFields.set(
      h.connectionId,
      rules.map((r) => ({ ...r, db: r.db === '$' ? db : r.db })),
    )
  const context = async (coll: string, request: unknown): Promise<AiSent> =>
    buildContext({
      ctx: h.t.app.ctx,
      principal: LOCAL,
      connectionId: h.connectionId,
      client: await h.client(),
      db,
      coll,
      request: AiRequestSchema.parse(request),
      comment: 'mm-ai-test',
      signal: new AbortController().signal,
    })
  return { h, db, context }
}

describe('the context sent to a provider (phase 4a-1 spec §1.3)', () => {
  it('summarises the schema without values, and lists personal paths without what is below them', async () => {
    const { db, context } = await setup([
      { db: '$', coll: 'people', field: 'email' },
      { db: '$', coll: 'people', field: 'address' },
    ])
    await client
      .db(db)
      .collection('people')
      .insertMany(
        Array.from({ length: 50 }, (_, i) => ({
          name: `n${i}`,
          email: `p${i}@example.com`,
          age: i,
          address: { city: 'Izmir', zip: '35000' },
          ...(i % 2 ? { vip: true } : {}),
        })),
      )
    const sent = await context('people', { action: 'describe' })
    const paths = Object.fromEntries(sent.schema!.fields.map((f) => [f.path, f]))
    expect(sent.schema).toMatchObject({ sampled: 50, count: 50, more: 0 })
    expect(paths.age).toEqual({ path: 'age', types: { int: 50 }, share: 1 })
    expect(paths.vip).toMatchObject({ share: 0.5 })
    expect(paths.email).toMatchObject({ personal: true, types: {} })
    expect(paths.address).toMatchObject({ personal: true })
    expect(paths['address.city']).toBeUndefined()
    const text = JSON.stringify(sent)
    for (const leak of ['example.com', 'Izmir', '35000', 'n1"', 'top', 'bins', 'min'])
      expect(text, leak).not.toContain(leak)
  })

  it('sends the current query and pipeline parsed and formatted, with personal literals masked', async () => {
    const { db, context } = await setup([{ db: '$', coll: 'orders', field: 'email' }])
    await client.db(db).collection('orders').insertOne({ email: 'a@x', qty: 3 })
    const query = await context('orders', {
      action: 'explain',
      current: serializeValue({ filter: { email: 'a@x', qty: { $gt: 5 } }, sort: { qty: -1 } }),
    })
    expect(query.current).toContain('***')
    expect(query.current).not.toContain('a@x')
    expect(query.current).toMatch(/\$gt: 5/)
    const pipeline = await context('orders', {
      action: 'explain',
      current: { pipeline: serializeValue([{ $match: { email: 'b@x' } }, { $group: { _id: '$qty' } }]) },
    })
    expect(pipeline.current).toMatch(/\$group/)
    expect(pipeline.current).not.toContain('b@x')
  })

  it('refuses a current query larger than 16 KiB', async () => {
    const { context } = await setup()
    await expect(
      context('orders', {
        action: 'explain',
        current: { filter: { a: 'x'.repeat(AI_LIMITS.currentBytes) } },
      }),
    ).rejects.toMatchObject({ details: { reason: 'too_large' } })
  })

  it('sends no plan that reads an index holding personal data (eighth review)', async () => {
    const { db, context } = await setup([{ db: '$', coll: 'people', field: 'phones' }])
    const c = client.db(db).collection('people')
    await c.insertMany([
      { name: 'a', phones: ['1', '2', '3'] },
      { name: 'b', phones: ['4'] },
    ])
    await c.createIndex({ name: 1, phones: 1 })
    const sent = await context('people', {
      action: 'optimise',
      current: serializeValue({ filter: { name: 'a' } }),
    })
    expect(sent.plan).toBeNull()
    await c.dropIndexes()
    await c.createIndex({ name: 1 })
    const plain = await context('people', {
      action: 'optimise',
      current: serializeValue({ filter: { name: 'a' } }),
    })
    expect(plain.plan).toMatchObject({ winning: { stage: expect.any(String) } })
  })

  it('sends no plan of a find the gate refuses, and still answers (fifteenth review, Minor 3, Minor 4)', async () => {
    const { db, context } = await setup([
      { db: '$', coll: 'keyed', field: '_id' },
      { db: '$', coll: 'wild', field: '**.phone' },
    ])
    await client.db(db).createCollection('keyed', { clusteredIndex: { key: { _id: 1 }, unique: true } })
    await client
      .db(db)
      .collection('keyed')
      .insertOne({ _id: 'a@x' as never, n: 1 })
    const keyed = await context('keyed', {
      action: 'optimise',
      current: serializeValue({ filter: { n: 1 } }),
    })
    expect(keyed.plan).toBeNull()
    await client.db(db).collection('wild').insertOne({ name: 'a' })
    await client.db(db).collection('wild').createIndex({ name: 1 })
    const wild = await context('wild', {
      action: 'optimise',
      current: serializeValue({ filter: { name: 'a' }, projection: { _id: { $toString: '$_id' } } }),
    })
    expect(wild.plan).toBeNull()
    // Nor of a pipeline the gate refuses (sixteenth review, M6).
    const sorted = await context('keyed', {
      action: 'optimise',
      current: serializeValue({ pipeline: [{ $sort: { _id: 1 } }] }),
    })
    expect(sorted.plan).toBeNull()
  })

  it('sends a plan without stage filters and indexes without partial filter values', async () => {
    const { db, context } = await setup()
    const c = client.db(db).collection('orders')
    await c.insertMany(Array.from({ length: 20 }, (_, i) => ({ qty: i, status: i % 2 ? 'paid' : 'new' })))
    await c.createIndex({ qty: 1 }, { partialFilterExpression: { status: 'paid' } })
    const sent = await context('orders', {
      action: 'optimise',
      current: serializeValue({ filter: { status: 'secret-literal' } }),
    })
    expect(sent.plan).toMatchObject({ winning: { stage: expect.any(String) }, advice: expect.any(Array) })
    expect(JSON.stringify(sent.plan)).not.toContain('secret-literal')
    expect(sent.indexes).toEqual(expect.arrayContaining([{ name: 'qty_1', keys: { qty: 1 }, partial: true }]))
    expect(JSON.stringify(sent.indexes)).not.toContain('paid')
  })

  it('does not explain a pipeline that writes', async () => {
    const { db, context } = await setup()
    await client.db(db).collection('orders').insertOne({ a: 1 })
    await expect(
      context('orders', { action: 'optimise', current: { pipeline: [{ $out: 'x' }] } }),
    ).rejects.toMatchObject({ details: { reason: 'write_pipeline' } })
  })

  it('sends the validator with personal literals masked', async () => {
    const { db, context } = await setup([{ db: '$', coll: 'v', field: 'email' }])
    await client.db(db).createCollection('v', {
      validator: {
        $jsonSchema: { properties: { email: { enum: ['boss@corp.example'] }, qty: { minimum: 0 } } },
      },
    })
    const sent = await context('v', { action: 'validation', prompt: 'require qty' })
    expect(sent.validator).toMatch(/minimum: 0/)
    expect(sent.validator).not.toContain('boss@corp.example')
  })

  it('masks samples by the rules for everyone, then the request’s list, then secrets', async () => {
    const { db, context } = await setup([{ db: '$', coll: 's', field: 'email' }])
    await client
      .db(db)
      .collection('s')
      .insertOne({ email: 'e@x', phone: 'phone-7731-secret', password: 'hunter2', note: 'kept' })
    const sent = await context('s', { action: 'describe', samples: { count: 1, mask: ['phone'] } })
    expect(sent.samples).toHaveLength(1)
    const sample = sent.samples[0]!
    for (const leak of ['e@x', 'phone-7731-secret', 'hunter2']) expect(sample, leak).not.toContain(leak)
    expect(sample).toContain('kept')
    expect(sent.samples.length).toBeLessThanOrEqual(1)
  })

  it('never reads MongoDB’s own collections', async () => {
    const { context } = await setup()
    await expect(context('system.users', { action: 'describe' })).rejects.toMatchObject({
      details: { reason: 'credential_collection' },
    })
    await expect(context('system.profile', { action: 'describe' })).rejects.toMatchObject({
      details: { reason: 'credential_collection' },
    })
  })

  it('follows a view to its source’s rules', async () => {
    const { db, context } = await setup([{ db: '$', coll: 'people', field: 'email' }])
    await client.db(db).collection('people').insertOne({ email: 'v@x', n: 1 })
    await client.db(db).createCollection('people_view', { viewOn: 'people', pipeline: [] })
    const sent = await context('people_view', { action: 'describe', samples: { count: 1 } })
    expect(JSON.stringify(sent)).not.toContain('v@x')
  })

  it('stays within its caps with huge, deep and wide documents and says what was left out', async () => {
    const { db, context } = await setup()
    const c = client.db(db).collection('big')
    let deep: Record<string, unknown> = { leaf: 1 }
    for (let i = 0; i < 90; i++) deep = { [`l${i}`]: deep }
    await c.insertOne({ huge: 'z'.repeat(2 * 1024 * 1024) })
    await c.insertOne({ deep })
    await c.insertMany(
      Array.from({ length: 100 }, (_, i) =>
        Object.fromEntries(Array.from({ length: 100 }, (_, j) => [`f${i}_${j}`, j])),
      ),
    )
    const started = Date.now()
    const sent = await context('big', { action: 'describe', samples: { count: 5 } })
    expect(Date.now() - started).toBeLessThan(20_000)
    expect(sent.schema!.fields.length).toBeLessThanOrEqual(AI_LIMITS.schemaPaths)
    expect(sent.schema!.more).toBeGreaterThan(0)
    for (const s of sent.samples) expect(Buffer.byteLength(s)).toBeLessThanOrEqual(AI_LIMITS.sampleBytes)
    expect(Buffer.byteLength(JSON.stringify(sent))).toBeLessThanOrEqual(AI_LIMITS.contextBytes)
  }, 60_000)
})

describe('caps (phase 4a-1 spec §1.3)', () => {
  it('cuts a document deepest first, then its keys, and marks the cut', () => {
    const doc = { a: { b: { c: { d: 'x'.repeat(5000) } } }, e: 1 }
    const text = cutDocument(doc, 200)
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(200)
    expect(text).toContain('…')
    expect(text).toContain('"e":1')
    const wide = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]))
    const cut = cutDocument(wide, 300)
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(300)
    expect(cut).toContain('"…":"…"')
  })

  it('drops schema paths first, then samples, and says so', () => {
    const sent: AiSent = {
      namespace: 'd.c',
      schema: {
        sampled: 1,
        count: 1,
        more: 0,
        fields: Array.from({ length: 300 }, (_, i) => ({
          path: `field_${i}_${'p'.repeat(100)}`,
          types: { int: 1 },
          share: 1,
        })),
      },
      current: null,
      plan: null,
      indexes: null,
      validator: null,
      samples: Array.from({ length: 5 }, () => 'x'.repeat(4000)),
      leftOut: [],
    }
    capContext(sent, 20 * 1024)
    expect(Buffer.byteLength(JSON.stringify(sent))).toBeLessThanOrEqual(20 * 1024)
    expect(sent.leftOut.some((l) => l.startsWith('schema_paths:'))).toBe(true)
    expect(sent.schema!.more).toBeGreaterThan(0)
  })
})

describe('the related collections are capped too (final review Minor 6)', () => {
  it('cuts a related collection’s long paths as it cuts the collection’s own', () => {
    const long = 'a'.repeat(400)
    const sent: AiSent = {
      namespace: 'shop.orders',
      schema: null,
      related: [
        {
          namespace: 'shop.customers',
          via: 'customerId',
          schema: { sampled: 1, fields: [{ path: long, types: { string: 1 }, share: 1 }], more: 0 },
        },
      ],
      current: null,
      plan: null,
      indexes: null,
      validator: null,
      samples: [],
      leftOut: [],
    } as never
    capContext(sent)
    expect(sent.related![0]!.schema.fields[0]!.path.length).toBeLessThanOrEqual(257)
  })
})
