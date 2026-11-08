// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Collection, DBRef, MongoClient, ObjectId, type Document } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { restrictedApp } from './support/restricted'
import type { TestApp } from './helpers'
import { slow } from './support/slowness'

/** Phase 3c-2 final review: the write holes, round-tripped through a real server. */
const S = 'S3NT1N3L'
const RULES = [
  { db: 'crm', coll: 'users', field: 'email' },
  { db: 'crm', coll: 'users', field: 'customer.phone' },
  { db: 'crm', coll: 'users', field: 'items.cardNo' },
]
const NS = '/databases/crm/collections/users'
const ref = new DBRef('orders', new ObjectId())
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
beforeEach(async () => {
  const crm = client.db('crm')
  await crm.dropDatabase()
  await crm.collection('users').insertMany([
    {
      _id: 1 as never,
      email: `${S}@x`,
      name: 'Ali',
      customer: { phone: `${S}-p`, city: 'Izmir' },
      items: [
        { cardNo: `${S}-1`, qty: 1 },
        { cardNo: `${S}-2`, qty: 2 },
      ],
      ref,
    },
    { _id: 2 as never, email: `${S}@y`, name: 'Bea', customer: 'none', items: [] },
  ])
})
const apps: TestApp[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const t of apps.splice(0)) await t.close()
})
async function setup() {
  const r = await restrictedApp(mongo, RULES)
  apps.push(r.t)
  return r
}
const stored = (id: number) =>
  client
    .db('crm')
    .collection('users')
    .findOne({ _id: id as never }) as Promise<Document>
type Caller = ReturnType<Awaited<ReturnType<typeof setup>>['as']>
const pinOf = async (user: Caller, id = 1) =>
  (
    (await user('POST', `${NS}/find`, { filter: { _id: id }, limit: 1 })).json() as {
      documents: Array<{ hash: string; document: Document }>
    }
  ).documents[0]!
const runBulk = async (user: Caller, body: Document) => {
  const preview = await user('POST', `${NS}/bulk/preview`, body)
  if (preview.statusCode !== 200) return preview
  return user('POST', `${NS}/bulk/execute`, {
    ...body,
    filterHash: preview.json().filterHash,
    confirm: 'users',
  })
}

describe('final review, writes through a real server (phase 3c-2)', () => {
  it('C1: "$[]" targets cannot overwrite elements holding personal values', async () => {
    const { as } = await setup()
    const user = as('editor', true)
    const pin = await pinOf(user)
    const single = await user('POST', `${NS}/documents/update`, {
      _id: 1,
      set: { 'items.$[]': 5 },
      unset: [],
      hash: pin.hash,
    })
    expect(single.statusCode).toBe(403)
    const bulk = await runBulk(user, {
      operation: 'update',
      filter: {},
      update: { $set: { 'items.$[]': 7 } },
    })
    expect(bulk.statusCode).toBe(403)
    expect((await stored(1)).items[1].cardNo).toBe(`${S}-2`)
  })

  it('C2: $push modifiers cannot empty or reorder an array holding personal values', async () => {
    const { as } = await setup()
    const user = as('editor', true)
    for (const update of [
      { $push: { items: { $each: [], $slice: 0 } } },
      { $push: { items: { $each: [], $sort: { cardNo: -1 } } } },
    ])
      expect((await runBulk(user, { operation: 'update', filter: {}, update })).statusCode).toBe(403)
    expect((await stored(1)).items.map((i: Document) => i.cardNo)).toEqual([`${S}-1`, `${S}-2`])
  })

  it('C3: an empty literal in an update pipeline never replaces a sub-document holding personal data', async () => {
    const { as } = await setup()
    const user = as('editor', true)
    const res = await runBulk(user, { operation: 'update', filter: {}, update: [{ $set: { customer: {} } }] })
    expect((await stored(1)).customer.phone).toBe(`${S}-p`)
    // CI 2026-10-18: MongoDB before 7.0 refuses an empty literal in $set itself ("an empty object is
    // not a valid value"), so nothing is written there; 7.0 on writes it where no personal data is.
    const { version } = await client.db('admin').command({ buildInfo: 1 })
    if (Number(String(version).split('.')[0]) < 7) {
      expect(res.statusCode, res.body).toBe(400)
      expect(res.json().details.code).toBe(40180)
      expect((await stored(2)).customer).toBe('none')
    } else {
      expect(res.statusCode, res.body).toBe(200)
      expect((await stored(2)).customer).toEqual({})
    }
  })

  it('C4: a validator that computes over a ruled collection is refused', async () => {
    const { as } = await setup()
    const user = as('editor', true)
    const state = (await user('GET', `${NS}/validation`)).json()
    const res = await user('PUT', `${NS}/validation`, {
      validator: { $expr: { $ne: [{ $getField: { field: 'phone', input: '$customer' } }, `${S}-p`] } },
      validationLevel: 'strict',
      validationAction: 'error',
      expected: state.version,
    })
    expect(res.statusCode).toBe(403)
    const [info] = await client.db('crm').listCollections({ name: 'users' }, { nameOnly: false }).toArray()
    const options = ((info as { options?: Document } | undefined)?.options ?? {}) as Document
    expect(options.validator).toBeUndefined()
  })

  it('I2: an existing unique index over personal data does not become an equality probe', async () => {
    await client.db('crm').collection('users').createIndex({ email: 1, name: 1 }, { unique: true })
    const { as } = await setup()
    const user = as('editor', true)
    const pin = await pinOf(user)
    const res = await user('POST', `${NS}/documents/update`, {
      _id: 1,
      set: { name: 'Bea' },
      unset: [],
      hash: pin.hash,
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().details).toMatchObject({ reason: 'masking_unsupported' })
  })

  it('I3: a restricted replace keeps a DBRef a DBRef', async () => {
    const { as } = await setup()
    const user = as('editor', true)
    const pin = await pinOf(user)
    const res = await user('POST', `${NS}/documents/replace`, {
      _id: 1,
      document: { ...pin.document, name: 'Ali 2' },
      hash: pin.hash,
    })
    expect(res.statusCode).toBe(200)
    const doc = await stored(1)
    expect(doc.ref).toBeInstanceOf(DBRef)
    expect(doc.email).toBe(`${S}@x`)
  })

  it('M5: pinned writes compare with the simple collation', async () => {
    const { as } = await setup()
    const user = as('editor', true)
    const updateOne = vi.spyOn(Collection.prototype, 'updateOne')
    const replaceOne = vi.spyOn(Collection.prototype, 'replaceOne')
    let pin = await pinOf(user)
    await user('POST', `${NS}/documents/update`, {
      _id: 1,
      set: { name: 'Ali 3' },
      unset: [],
      hash: pin.hash,
    })
    pin = await pinOf(user)
    await user('POST', `${NS}/documents/replace`, { _id: 1, document: pin.document, hash: pin.hash })
    expect(updateOne.mock.calls.at(-1)![2]).toMatchObject({ collation: { locale: 'simple' } })
    expect(replaceOne.mock.calls.at(-1)![2]).toMatchObject({ collation: { locale: 'simple' } })
  })
})
