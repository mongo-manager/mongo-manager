// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BSON, EJSON } from 'bson'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { restrictedApp } from './support/restricted'
import type { TestApp } from './helpers'
import { slow } from './support/slowness'
import { readMeasured, sizePipeline } from '../../plugins/document-size/src/size'

/**
 * The Document size plugin's pipeline on a real MongoDB (review 2026-10-29, I6): its sizes are the
 * BSON sizes to the byte, an object field is measured only where it is one, and for a user personal
 * data is hidden from the masking gate lets no size out — they would tell the hidden values' length.
 */
const S = 'S3NT1N3L-A-LONG-HIDDEN-VALUE'
let mongo: TestMongo
let client: MongoClient
beforeAll(async () => {
  mongo = await startMongo()
  client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
}, slow(120_000))
afterAll(async () => {
  await client?.close()
  await mongo?.stop()
})
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

const run = async (coll: string, pipeline: unknown[]) => {
  const [answer] = await client
    .db('sizes')
    .collection(coll)
    .aggregate(EJSON.deserialize(pipeline as never) as never)
    .toArray()
  return readMeasured(EJSON.serialize(answer, { relaxed: false }))
}

describe('the document size pipeline', () => {
  it('measures each document and field as BSON counts it, keys with a dot or a $ too', async () => {
    const docs = [
      { _id: 1, name: 'Ada', tags: ['a', 'b', 'c'], address: { city: 'Izmir' }, blob: 'x'.repeat(5000) },
      { _id: 2, name: 'Bea', tags: [] },
      { _id: 3, longFieldNameThatIsRepeated: 1, 'odd.key': 2 },
    ]
    const c = client.db('sizes').collection('docs')
    await c.deleteMany({})
    await c.insertMany(docs as never)
    const m = await run('docs', sizePipeline([], null))
    const sizes = docs.map((d) => BSON.calculateObjectSize(d))
    expect(m.documents).toBe(3)
    expect(m.total).toBe(sizes.reduce((a, b) => a + b, 0))
    expect(m.max).toBe(Math.max(...sizes))
    const field = (name: string) => m.fields.find((f) => f.name === name)!
    expect(field('blob').total).toBe(BSON.calculateObjectSize({ blob: 'x'.repeat(5000) }) - 5)
    expect(field('odd.key').total).toBe(BSON.calculateObjectSize({ 'odd.key': 2 }) - 5)
    expect(field('tags')).toMatchObject({ docs: 2, elements: 1.5, types: ['array'] })
    // Each document's fields make it, less its own 5 bytes.
    expect(m.fields.reduce((sum, f) => sum + f.total, 0)).toBe(m.total - 5 * 3)
    // Every name and its type byte, counted on the server.
    const names = docs.flatMap((d) => Object.keys(d)).reduce((sum, k) => sum + Buffer.byteLength(k) + 2, 0)
    expect(m.names).toBe(names)
  })

  it('measures an object field only where it is one: an array of objects there is none', async () => {
    const c = client.db('sizes').collection('mixed')
    await c.deleteMany({})
    await c.insertMany([
      { _id: 1, address: { city: 'Izmir', street: 'Kordon' } },
      { _id: 2, address: [{ city: 'Ankara' }, { city: 'Bursa' }] },
      { _id: 3, address: 'none' },
    ] as never)
    for (const sample of [null, 1000]) {
      const m = await run('mixed', sizePipeline(['address'], sample))
      expect(m.documents).toBe(1)
      expect(m.total).toBe(BSON.calculateObjectSize({ city: 'Izmir', street: 'Kordon' }))
      expect(m.fields.map((f) => f.name).sort()).toEqual(['city', 'street'])
    }
    // The sample drawn after measuring gives the same.
    expect((await run('mixed', sizePipeline(['address'], 1000, true))).documents).toBe(1)
  })
})

describe('for a user personal data is hidden from', () => {
  it('lets no size out, of the documents or of an object holding a hidden field', async () => {
    const c = client.db('crm').collection('users')
    await c.deleteMany({})
    await c.insertMany([
      { email: `${S}@x`, name: 'Ali', customer: { phone: `${S}-p`, city: 'Izmir' } },
      { email: 'b@x', name: 'Bea', customer: { phone: '1', city: 'Ankara' } },
    ])
    const r = await restrictedApp(mongo, [
      { db: 'crm', coll: 'users', field: 'email' },
      { db: 'crm', coll: 'users', field: 'customer.phone' },
    ])
    apps.push(r.t)
    const masked = r.as('editor', true)
    const admin = r.as('admin')
    for (const stages of [
      sizePipeline([], null),
      sizePipeline(['customer'], 1000),
      sizePipeline([], 1000, true),
    ]) {
      const res = await masked('POST', '/databases/crm/collections/users/aggregate/run', { stages, limit: 1 })
      // Refused, or measured to nothing (the hidden object reads as ***, so no document holds one):
      // never a size.
      expect([200, 400], JSON.stringify(stages[0])).toContain(res.statusCode)
      expect(res.body).not.toContain('"total"')
      expect(res.body).not.toContain('"size"')
      expect(res.body).not.toContain(S)
      // The same pipeline answers for one who may see the values: the refusal is the gate's.
      const seen = await admin('POST', '/databases/crm/collections/users/aggregate/run', { stages, limit: 1 })
      expect(seen.statusCode).toBe(200)
      expect(seen.body).toContain('"total"')
    }
  })
})
