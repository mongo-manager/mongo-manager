import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { restrictedApp, type Method } from './support/restricted'
import type { TestApp } from './helpers'
import { slow } from './support/slowness'

/**
 * Phase 3c §9: the sentinel sweep. A sentinel sits in every personal field; a restricted user calls
 * every read route with ordinary and hostile bodies, and the sentinel must appear in no response
 * byte. The same sweep as an admin must find it, which proves the seed.
 */
const S = 'S3NT1N3L'
const RULES = [
  { db: 'crm', coll: 'users', field: 'email' },
  { db: 'crm', coll: 'users', field: 'customer.phone' },
  { db: 'crm', coll: 'users_dup', field: 'email' },
]
const NS = '/databases/crm/collections/users'
let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
  const client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
  const crm = client.db('crm')
  await crm.collection('users').insertMany([
    { email: `${S}@x`, name: 'Ali', customer: { phone: `${S}-p`, city: 'Izmir' } },
    { email: 'b@x', name: 'Bea', customer: { phone: '1', city: 'Ankara' } },
  ])
  await crm.collection('users').createIndex({ email: 1 }, { unique: true })
  await crm
    .collection('users')
    .createIndex({ name: 1 }, { name: 'name_partial', partialFilterExpression: { email: `${S}@x` } })
  await crm.command({
    collMod: 'users',
    validator: { $jsonSchema: { properties: { email: { bsonType: 'string', pattern: S } } } },
    validationLevel: 'off',
  })
  await crm.collection('orders').insertOne({ buyer: 'Ali', total: 5 })
  await crm.createCollection('users_v', {
    viewOn: 'users',
    pipeline: [{ $project: { email: 1, name: 1, customer: 1 } }],
  })
  await crm.collection('users_dup').insertOne({ email: `${S}@y`, name: S })
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
  // Shared items an admin wrote with the value in them.
  const admin = r.as('admin')
  await admin('POST', `${NS}/favourites`, {
    name: 'vip',
    tags: [],
    shared: true,
    query: { filter: { email: `${S}@x` } },
  })
  await admin('POST', `${NS}/pipelines`, {
    name: 'p',
    tags: [],
    shared: true,
    stages: [{ $match: { email: `${S}@x` } }],
  })
  return r
}

const SAMPLE = { mode: 'limit', size: 10 }
const SWEEP: Array<[Method, string, unknown?]> = [
  ['GET', '/databases/crm/collections'],
  ['GET', `${NS}/indexes`],
  ['GET', `${NS}/validation`],
  ['POST', `${NS}/find`, { filter: {}, limit: 50 }],
  ['POST', `${NS}/find`, { filter: {}, projection: { email: 1, customer: 1 }, limit: 50 }],
  ['POST', `${NS}/find`, { filter: { email: `${S}@x` }, limit: 5 }],
  ['POST', `${NS}/find`, { filter: {}, hint: 'name_partial', limit: 5 }],
  ['POST', `${NS}/find`, { filter: { $expr: { $eq: [{ $toInt: '$name' }, 1] } }, limit: 5 }],
  ['POST', `${NS}/count`, { filter: {} }],
  ['POST', `${NS}/documents/get`, { _id: 1 }],
  [
    'POST',
    `${NS}/aggregate/preview`,
    {
      stages: [{ $project: { c: '$customer', kv: { $objectToArray: '$$ROOT' } } }],
      sample: SAMPLE,
      perStage: 10,
    },
  ],
  ['POST', `${NS}/aggregate/run`, { stages: [{ $group: { _id: '$customer', n: { $sum: 1 } } }], limit: 10 }],
  [
    'POST',
    '/databases/crm/collections/orders/aggregate/run',
    {
      stages: [{ $lookup: { from: 'users', localField: 'buyer', foreignField: 'name', as: 'u' } }],
      limit: 10,
    },
  ],
  ['POST', `${NS}/aggregate/run`, { stages: [{ $project: { n: { $toInt: '$email' } } }], limit: 10 }],
  ['POST', `${NS}/aggregate/count`, { stages: [{ $match: { 'customer.city': 'Izmir' } }] }],
  ['POST', `${NS}/explain`, { kind: 'find', filter: { name: 'Ali' }, verbosity: 'executionStats' }],
  [
    'POST',
    `${NS}/explain`,
    { kind: 'aggregate', stages: [{ $match: { name: 'Ali' } }], verbosity: 'queryPlanner' },
  ],
  ['POST', `${NS}/schema`, { sampleSize: 100 }],
  ['POST', `${NS}/validation/test`, { validator: { name: { $exists: true } } }],
  ['POST', `${NS}/bulk/preview`, { operation: 'delete', filter: {} }],
  ['GET', `${NS}/favourites`],
  ['GET', `${NS}/pipelines`],
  ['GET', '/library'],
  ['GET', `/library?q=${S}`],
  ['POST', '/databases/crm/collections/users_v/find', { filter: {}, limit: 50 }],
  ['POST', `${NS}/documents`, { documents: [{ email: `${S}@x` }] }],
  ['GET', '/personal-fields/applied'],
  // Phase 3d-3a: a backup plan names paths, never values; a definition holding a value is left out.
  ['POST', '/backup/plan', { scope: { kind: 'database', db: 'crm' }, format: 'gzip' }],
  ['POST', '/backup/plan', { scope: { kind: 'collection', db: 'crm', coll: 'users_v' }, format: 'archive' }],
  ['GET', '/backup/tools'],
  [
    'POST',
    '/databases/crm/collections/users_dup/find',
    { filter: { $expr: { $eq: [{ $toInt: '$name' }, 1] } }, limit: 5 },
  ],
]

describe('the sentinel sweep (phase 3c §9)', () => {
  it('no response to a restricted user carries a personal value', async () => {
    const { as } = await setup()
    const user = as('editor', true)
    for (const [method, path, body] of SWEEP) {
      const res = await user(method, path, body)
      expect(res.body, `${method} ${path}`).not.toContain(S)
      expect(JSON.stringify(res.headers), `${method} ${path}`).not.toContain(S)
    }
  })

  it('the same sweep as an admin finds the value, which proves the seed', async () => {
    const { as } = await setup()
    const admin = as('admin')
    let seen = 0
    for (const [method, path, body] of SWEEP) if ((await admin(method, path, body)).body.includes(S)) seen++
    expect(seen).toBeGreaterThan(5)
  })

  it('no write by a restricted user shows or changes a personal value (phase 3c-2 §9)', async () => {
    const { as } = await setup()
    const user = as('editor', true)
    const pinned = async () =>
      (await user('POST', `${NS}/find`, { filter: { name: 'Ali' }, limit: 1 })).json().documents[0] as {
        document: Record<string, unknown>
        hash: string
      }
    const responses: Array<{ label: string; body: string; headers: unknown }> = []
    const send = async (label: string, method: Method, path: string, body?: unknown) => {
      const res = await user(method, path, body)
      responses.push({ label, body: res.body, headers: res.headers })
      return res
    }
    await send('insert', 'POST', `${NS}/documents`, { documents: [{ name: 'n' }] })
    let pin = await pinned()
    await send('update personal', 'POST', `${NS}/documents/update`, {
      _id: pin.document._id,
      set: { email: 'x' },
      unset: [],
      hash: pin.hash,
    })
    await send('update other', 'POST', `${NS}/documents/update`, {
      _id: pin.document._id,
      set: { 'customer.city': 'Ankara' },
      unset: [],
      hash: pin.hash,
    })
    pin = await pinned()
    await send('replace', 'POST', `${NS}/documents/replace`, {
      _id: pin.document._id,
      document: { ...pin.document, name: 'Ali' },
      hash: pin.hash,
    })
    const bulk = { operation: 'update', filter: { name: 'Ali' }, update: { $set: { tag: 'y' } } }
    const preview = await send('bulk preview', 'POST', `${NS}/bulk/preview`, bulk)
    await send('bulk execute', 'POST', `${NS}/bulk/execute`, {
      ...bulk,
      filterHash: preview.json().filterHash,
    })
    await send('bulk personal', 'POST', `${NS}/bulk/preview`, {
      operation: 'update',
      filter: {},
      update: { $set: { email: 'x' } },
    })
    // A request built to fail (§9): a duplicate key on a unique index over a field that is not
    // personal; the error must quote nothing personal.
    const admin = new MongoClient(`mongodb://127.0.0.1:${mongo.port}`)
    await admin.connect()
    await admin.db('crm').collection('users').createIndex({ name: 1 }, { unique: true, name: 'name_unique' })
    await admin.close()
    pin = await pinned()
    const duplicate = await send('duplicate key', 'POST', `${NS}/documents/update`, {
      _id: pin.document._id,
      set: { name: 'Bea' },
      unset: [],
      hash: pin.hash,
    })
    expect(duplicate.statusCode).toBe(409)
    await send('view', 'POST', '/databases/crm/collections', {
      kind: 'view',
      name: 'peek',
      viewOn: 'users',
      pipeline: [],
    })
    await send('unique index', 'POST', `${NS}/indexes`, {
      key: { email: 1 },
      options: { unique: true, name: 'e1' },
    })
    const state = (await user('GET', `${NS}/validation`)).json()
    await send('validator', 'PUT', `${NS}/validation`, {
      validator: { name: { $type: 'string' } },
      validationLevel: 'off',
      validationAction: 'warn',
      expected: state.version,
    })
    for (const r of responses) {
      expect(r.body, r.label).not.toContain(S)
      expect(JSON.stringify(r.headers), r.label).not.toContain(S)
    }
    // The stored personal values are untouched.
    const client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
    try {
      const doc = await client.db('crm').collection('users').findOne({ name: 'Ali' })
      expect(doc).toMatchObject({ email: `${S}@x`, customer: { phone: `${S}-p`, city: 'Ankara' }, tag: 'y' })
    } finally {
      await client.close()
    }
  })

  it('hides MongoDB text that quotes a value from a restricted user', async () => {
    const { as } = await setup()
    const failing = { filter: { $expr: { $eq: [{ $toInt: '$name' }, 1] } }, limit: 5 }
    const admin = await as('admin')('POST', '/databases/crm/collections/users_dup/find', failing)
    expect(admin.body).toContain(S)
    const user = await as('editor', true)('POST', '/databases/crm/collections/users_dup/find', failing)
    expect(user.body).not.toContain(S)
    expect(user.json().details).toMatchObject({ hidden: true })
  })
})
