import { createHash } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { toWire } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { restrictedApp } from './support/restricted'
import type { TestApp } from './helpers'
import { slow } from './support/slowness'

/** Phase 3c §4.4-4.5: schema analysis and definitions someone wrote (validator, partial index, view). */
const S = 'S3NT1N3L'
const RULES = [
  { db: 'crm', coll: 'users', field: 'email' },
  { db: 'crm', coll: 'users', field: 'customer.phone' },
]
const USERS = '/databases/crm/collections/users'
let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
  const client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
  const crm = client.db('crm')
  await crm.collection('users').insertMany([
    { email: `${S}@x`, name: 'Ali', customer: { phone: `${S}-p`, city: 'Izmir' } },
    { email: 'b@x', name: 'Bea', customer: { phone: '1', city: 'Ankara' } },
  ])
  await crm.command({
    collMod: 'users',
    validator: {
      $jsonSchema: {
        properties: { email: { bsonType: 'string', pattern: S }, name: { enum: ['Ali', 'Bea'] } },
      },
    },
    validationLevel: 'off',
  })
  await crm
    .collection('users')
    .createIndex({ name: 1 }, { name: 'name_partial', partialFilterExpression: { email: `${S}@x` } })
  await crm.createCollection('pinned', { viewOn: 'users', pipeline: [{ $match: { email: `${S}@x` } }] })
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

describe('definitions and schema (phase 3c §4.4-4.5)', () => {
  it('masks validator, partial filter and view pipeline values at personal paths', async () => {
    const { as } = await setup()
    const user = as('viewer', true)
    const validation = await user('GET', `${USERS}/validation`)
    expect(validation.statusCode).toBe(200)
    expect(validation.body).not.toContain(S)
    expect(validation.body).toContain('Ali')
    const indexes = await user('GET', `${USERS}/indexes`)
    expect(indexes.statusCode).toBe(200)
    expect(indexes.body).not.toContain(S)
    const colls = await user('GET', '/databases/crm/collections')
    expect(colls.statusCode).toBe(200)
    expect(colls.body).not.toContain(S)
    // An admin still reads them whole.
    expect((await as('admin')('GET', `${USERS}/validation`)).body).toContain(S)
  })

  it('keeps the rules version unconfirmable (HMAC, not SHA-256)', async () => {
    const { as } = await setup()
    const hidden = (await as('viewer', true)('GET', `${USERS}/validation`)).json()
    const full = (await as('admin')('GET', `${USERS}/validation`)).json()
    expect(hidden.version).toBe(full.version)
    const plain = createHash('sha256')
      .update(
        toWire({
          validator: full.validator,
          validationLevel: full.validationLevel,
          validationAction: full.validationAction,
        }),
      )
      .digest('hex')
    expect(full.version).not.toBe(plain)
  })

  it('tests a validator only without personal fields, and masks the failing samples', async () => {
    const { as } = await setup()
    const user = as('viewer', true)
    const bad = await user('POST', `${USERS}/validation/test`, { validator: { email: { $exists: true } } })
    expect(bad.statusCode).toBe(403)
    const ok = await user('POST', `${USERS}/validation/test`, { validator: { name: 'nobody' } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().sample.length).toBeGreaterThan(0)
    expect(ok.body).not.toContain(S)
  })

  it('reports personal paths as masked in a schema analysis', async () => {
    const { as } = await setup()
    const res = await as('viewer', true)('POST', `${USERS}/schema`, { sampleSize: 100 })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain(S)
    const fields = res.json().fields as Array<{ path: string; masked?: boolean; top?: unknown }>
    const email = fields.find((f) => f.path === 'email')
    expect(email).toMatchObject({ masked: true })
    expect(email).not.toHaveProperty('top')
    expect(fields.find((f) => f.path === 'customer.phone')).toMatchObject({ masked: true })
    expect(fields.find((f) => f.path === 'name')?.top).toBeDefined()
    expect(fields.find((f) => f.path === 'customer.city')?.top).toBeDefined()
  })
})
