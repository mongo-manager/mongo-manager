import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MongoClient, type Document } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { restrictedApp } from './support/restricted'
import type { TestApp } from './helpers'
import { slow } from './support/slowness'

/** Phase 3c §5.2-5.4: bulk writes, views, indexes and validators for a restricted editor. */
const S = 'S3NT1N3L'
const RULES = [
  { db: 'crm', coll: 'users', field: 'email' },
  { db: 'crm', coll: 'users', field: 'customer.phone' },
]
const NS = '/databases/crm/collections/users'
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
    { _id: 1 as never, email: `${S}@x`, name: 'Ali', customer: { phone: `${S}-p`, city: 'Izmir' } },
    { _id: 2 as never, email: 'b@x', name: 'Bea', customer: 'none' },
  ])
  await crm.collection('notes').insertOne({ text: 'n' })
  await crm.command({
    collMod: 'users',
    validator: { $jsonSchema: { properties: { email: { bsonType: 'string', pattern: S } } } },
    validationLevel: 'off',
  })
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
const stored = (id: number) =>
  client
    .db('crm')
    .collection('users')
    .findOne({ _id: id as never }) as Promise<Document>

describe('writes beyond single documents (phase 3c §5.2-5.4)', () => {
  it('runs a bulk update without touching personal values, and skips documents it would overwrite (review focus 5)', async () => {
    const { as } = await setup()
    const user = as('editor', true)
    const body = { operation: 'update', filter: {}, update: { $set: { customer: 'cleared' } } }
    const preview = await user('POST', `${NS}/bulk/preview`, body)
    expect(preview.statusCode).toBe(200)
    const run = await user('POST', `${NS}/bulk/execute`, {
      ...body,
      filterHash: preview.json().filterHash,
      confirm: 'users',
    })
    expect(run.statusCode).toBe(200)
    expect(run.json()).toMatchObject({ matched: 1, modified: 1 })
    expect((await stored(1)).customer.phone).toBe(`${S}-p`)
    expect((await stored(2)).customer).toBe('cleared')
    const personal = await user('POST', `${NS}/bulk/preview`, {
      operation: 'update',
      filter: {},
      update: { $set: { email: 'x' } },
    })
    expect(personal.statusCode).toBe(403)
    expect(personal.json().details).toMatchObject({ reason: 'personal_write' })
  })

  it('deletes in bulk only by filters without personal fields', async () => {
    const { as } = await setup()
    const user = as('editor', true)
    expect(
      (await user('POST', `${NS}/bulk/preview`, { operation: 'delete', filter: { email: 'b@x' } }))
        .statusCode,
    ).toBe(403)
    const body = { operation: 'delete', filter: { name: 'Bea' } }
    const preview = (await user('POST', `${NS}/bulk/preview`, body)).json()
    const run = await user('POST', `${NS}/bulk/execute`, { ...body, filterHash: preview.filterHash })
    expect(run.json()).toMatchObject({ deleted: 1 })
  })

  it('creates collections in a ruled database, but no view over ruled data', async () => {
    const { as } = await setup()
    const user = as('editor', true)
    const create = (body: Document) => user('POST', '/databases/crm/collections', body)
    expect((await create({ kind: 'collection', name: 'fresh' })).statusCode).toBe(201)
    expect((await create({ kind: 'view', name: 'v', viewOn: 'users', pipeline: [] })).statusCode).toBe(403)
    expect((await create({ kind: 'view', name: 'w', viewOn: 'notes', pipeline: [] })).statusCode).toBe(201)
    expect(
      (
        await create({
          kind: 'view',
          name: 'x',
          viewOn: 'notes',
          pipeline: [{ $lookup: { from: 'users', pipeline: [], as: 'u' } }],
        })
      ).statusCode,
    ).toBe(403)
  })

  it('builds indexes, but no unique one over personal data, and no partial filter on it', async () => {
    const { as } = await setup()
    const user = as('editor', true)
    expect((await user('POST', `${NS}/indexes`, { key: { email: 1 } })).statusCode).toBe(202)
    expect(
      (await user('POST', `${NS}/indexes`, { key: { email: 1 }, options: { unique: true, name: 'u1' } }))
        .statusCode,
    ).toBe(403)
    expect(
      (await user('POST', `${NS}/indexes`, { key: { customer: 1 }, options: { unique: true, name: 'u2' } }))
        .statusCode,
    ).toBe(403)
    expect(
      (
        await user('POST', `${NS}/indexes`, {
          key: { name: 1 },
          options: { partialFilterExpression: { email: { $exists: true } }, name: 'p1' },
        })
      ).statusCode,
    ).toBe(403)
    expect(
      (await user('POST', `${NS}/indexes`, { key: { name: 1 }, options: { unique: true, name: 'n1' } }))
        .statusCode,
    ).toBe(202)
  })

  it('sets a validator without personal fields, and shows the previous one masked', async () => {
    const { as } = await setup()
    const user = as('editor', true)
    const state = (await user('GET', `${NS}/validation`)).json()
    const refused = await user('PUT', `${NS}/validation`, {
      validator: { email: { $exists: true } },
      validationLevel: 'off',
      validationAction: 'warn',
      expected: state.version,
    })
    expect(refused.statusCode).toBe(403)
    const ok = await user('PUT', `${NS}/validation`, {
      validator: { name: { $type: 'string' } },
      validationLevel: 'off',
      validationAction: 'warn',
      expected: state.version,
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.body).not.toContain(S)
  })

  it('still refuses duplicating or renaming a ruled collection', async () => {
    const { as } = await setup()
    const user = as('editor', true)
    expect((await user('POST', `${NS}/duplicate`, { to: 'copy' })).statusCode).toBe(403)
    expect((await user('POST', `${NS}/rename`, { to: 'renamed' })).statusCode).toBe(403)
  })
})
