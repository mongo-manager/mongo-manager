import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient, ObjectId } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { restrictedApp } from './support/restricted'
import type { TestApp } from './helpers'
import { slow } from './support/slowness'

/** Phase 3c §3, §4.2: documents, counts and bulk previews through the query gate. */
const S = 'S3NT1N3L'
const RULES = [
  { db: 'crm', coll: 'users', field: 'email' },
  { db: 'crm', coll: 'users', field: 'customer.phone' },
  { db: 'crm', coll: 'users', field: 'items.cardNo' },
]
const NS = '/databases/crm/collections/users'
let mongo: TestMongo
let id: ObjectId
beforeAll(async () => {
  mongo = await startMongo()
  const client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
  const users = client.db('crm').collection('users')
  id = new ObjectId()
  await users.insertMany([
    {
      _id: id,
      email: `${S}@x`,
      name: 'Ali',
      customer: { phone: `${S}-p`, city: 'Izmir' },
      items: [{ cardNo: `${S}-c`, qty: 1 }],
    },
    { email: 'b@x', name: 'Bea', customer: 'none', items: [] },
  ])
  await users.createIndex({ email: 1 })
  await client.close()
}, slow(120_000))
afterAll(async () => {
  await mongo?.stop()
})
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})
async function setup() {
  const r = await restrictedApp(mongo, RULES)
  apps.push(r.t)
  return r
}

describe('documents through the gate (phase 3c §3, §4.2)', () => {
  it('masks personal values for a restricted user only', async () => {
    const { as } = await setup()
    const hidden = await as('editor', true)('POST', `${NS}/find`, { filter: {}, limit: 10 })
    expect(hidden.statusCode).toBe(200)
    expect(hidden.body).not.toContain(S)
    const first = hidden.json().documents[0].document
    expect(first).toMatchObject({
      email: '***',
      name: 'Ali',
      customer: { phone: '***', city: 'Izmir' },
      items: [{ cardNo: '***' }],
    })
    const full = await as('editor')('POST', `${NS}/find`, { filter: {}, limit: 10 })
    expect(full.body).toContain(S)
  })

  it.each([
    [{ filter: { email: { $regex: '^S' } } }],
    [{ filter: { 'items.0.cardNo': 'x' } }],
    [{ filter: {}, sort: { email: 1 } }],
    [{ filter: {}, hint: 'email_1' }],
  ])('refuses %j with personal_field', async (body) => {
    const { as } = await setup()
    const res = await as('viewer', true)('POST', `${NS}/find`, { limit: 5, ...body })
    expect(res.statusCode).toBe(403)
    expect(res.json().details).toMatchObject({ reason: 'personal_field' })
  })

  it('refuses a page ordered by a sub-document, allows a clean sort and decoded EJSON operands', async () => {
    const { as } = await setup()
    const user = as('viewer', true)
    expect(
      (await user('POST', `${NS}/find`, { filter: {}, sort: { customer: 1 }, limit: 5 })).statusCode,
    ).toBe(403)
    expect((await user('POST', `${NS}/find`, { filter: {}, sort: { name: 1 }, limit: 5 })).statusCode).toBe(
      200,
    )
    const byId = await user('POST', `${NS}/find`, {
      filter: { customer: { $oid: id.toHexString() } },
      limit: 5,
    })
    expect(byId.statusCode).toBe(200)
  })

  it('never returns index keys, whatever find options the body carries', async () => {
    const { as } = await setup()
    const res = await as('viewer', true)('POST', `${NS}/find`, {
      filter: {},
      limit: 5,
      returnKey: true,
      showRecordId: true,
      min: { email: 'a' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain(S)
    expect(res.json().documents[0].document).toHaveProperty('name')
  })

  it('counts only filters without personal fields, and masks a single document', async () => {
    const { as } = await setup()
    const user = as('viewer', true)
    expect((await user('POST', `${NS}/count`, { filter: { email: 'b@x' } })).statusCode).toBe(403)
    expect((await user('POST', `${NS}/count`, { filter: { name: 'Bea' } })).json()).toMatchObject({
      count: 1,
    })
    const one = await user('POST', `${NS}/documents/get`, { _id: { $oid: id.toHexString() } })
    expect(one.statusCode).toBe(200)
    expect(one.body).not.toContain(S)
    expect(one.json().document.email).toBe('***')
  })

  it('previews a bulk filter only without personal fields', async () => {
    const { as } = await setup()
    const res = await as('editor', true)('POST', `${NS}/bulk/preview`, {
      operation: 'delete',
      filter: { email: 'b@x' },
    })
    expect(res.statusCode).toBe(403)
    const ok = await as('editor', true)('POST', `${NS}/bulk/preview`, {
      operation: 'delete',
      filter: { name: 'Bea' },
    })
    expect(ok.json()).toMatchObject({ matched: 1 })
  })
})
