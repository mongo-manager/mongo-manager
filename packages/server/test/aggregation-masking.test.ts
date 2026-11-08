// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { restrictedApp } from './support/restricted'
import type { TestApp } from './helpers'
import { slow } from './support/slowness'

/** Phase 3c §3.4, §4.2-4.3, §4.8: aggregation and explain through the query gate. */
const S = 'S3NT1N3L'
const RULES = [
  { db: 'crm', coll: 'users', field: 'email' },
  { db: 'crm', coll: 'users', field: 'customer.phone' },
]
const USERS = '/databases/crm/collections/users'
const ORDERS = '/databases/crm/collections/orders'
const SAMPLE = { mode: 'limit', size: 10 }
let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
  const client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
  const crm = client.db('crm')
  await crm.collection('users').insertMany([
    { email: `${S}@x`, name: 'Ali', customer: { phone: `${S}-p`, city: 'Izmir' } },
    { email: 'b@x', name: 'Bea', customer: 'none' },
  ])
  await crm.collection('orders').insertOne({ buyer: 'Ali', total: 5 })
  await crm.createCollection('users_v', {
    viewOn: 'users',
    pipeline: [{ $project: { email: 1, name: 1, customer: 1 } }],
  })
  await crm.createCollection('by_email', { viewOn: 'users', pipeline: [{ $group: { _id: '$email' } }] })
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

describe('aggregation through the gate (phase 3c §3.4, §4.2, §4.8)', () => {
  it('masks moved subtrees and joined documents in preview and run', async () => {
    const { as } = await setup()
    const user = as('editor', true)
    const moved = await user('POST', `${USERS}/aggregate/preview`, {
      stages: [{ $project: { x: '$customer' } }],
      sample: SAMPLE,
      perStage: 10,
    })
    expect(moved.statusCode).toBe(200)
    expect(moved.body).not.toContain(S)
    const joined = await user('POST', `${ORDERS}/aggregate/run`, {
      stages: [{ $lookup: { from: 'users', localField: 'buyer', foreignField: 'name', as: 'u' } }],
      limit: 10,
    })
    expect(joined.statusCode).toBe(200)
    expect(joined.body).not.toContain(S)
    expect(joined.body).toContain('"email":"***"')
  })

  it('refuses a group by a personal field and counts that use one', async () => {
    const { as } = await setup()
    const user = as('editor', true)
    const group = await user('POST', `${USERS}/aggregate/run`, {
      stages: [{ $group: { _id: '$email' } }],
      limit: 10,
    })
    expect(group.statusCode).toBe(403)
    expect(group.json().details).toMatchObject({ reason: 'personal_field', field: 'email' })
    const count = await user('POST', `${USERS}/aggregate/count`, { stages: [{ $match: { email: 'b@x' } }] })
    expect(count.statusCode).toBe(403)
  })

  it('keeps one preview result per user stage after a sort rewrite (review focus 3)', async () => {
    const { as } = await setup()
    const res = await as('editor', true)('POST', `${USERS}/aggregate/preview`, {
      stages: [{ $sort: { customer: 1 } }, { $limit: 1 }],
      sample: SAMPLE,
      perStage: 10,
    })
    expect(res.statusCode).toBe(200)
    const stages = res.json().stages as Array<{ count?: number }>
    expect(stages).toHaveLength(2)
    expect(stages[0]!.count).toBe(2)
    expect(stages[1]!.count).toBe(1)
    expect(res.body).not.toContain('__mm_s')
  })

  it('never serves a masked result from the full cache, or the other way round', async () => {
    const { as } = await setup()
    const body = { stages: [{ $match: {} }], sample: SAMPLE, perStage: 10 }
    expect((await as('editor')('POST', `${USERS}/aggregate/preview`, body)).body).toContain(S)
    expect((await as('editor', true)('POST', `${USERS}/aggregate/preview`, body)).body).not.toContain(S)
    expect((await as('editor')('POST', `${USERS}/aggregate/preview`, body)).body).toContain(S)
  })

  it('hides MongoDB error text from a restricted user, in runs and in stage previews', async () => {
    const { as } = await setup()
    const user = as('editor', true)
    const run = await user('POST', `${USERS}/aggregate/run`, {
      stages: [{ $project: { n: { $toInt: '$name' } } }],
      limit: 10,
    })
    expect(run.body).not.toContain('Ali')
    expect(run.json().details).toMatchObject({ hidden: true })
    const preview = await user('POST', `${USERS}/aggregate/preview`, {
      stages: [{ $project: { n: { $toInt: '$name' } } }],
      sample: SAMPLE,
      perStage: 10,
    })
    expect(preview.statusCode).toBe(200)
    expect(preview.body).not.toContain("'Ali'")
    expect(preview.body).toContain('hidden because it can quote personal data')
  })

  it('reads a view as its source, and closes a view that groups by a personal field (review focus 2)', async () => {
    const { as } = await setup()
    const user = as('viewer', true)
    const view = await user('POST', '/databases/crm/collections/users_v/find', { filter: {}, limit: 10 })
    expect(view.statusCode).toBe(200)
    expect(view.body).not.toContain(S)
    const byEmail = await user('POST', '/databases/crm/collections/by_email/find', { filter: {}, limit: 10 })
    expect(byEmail.statusCode, byEmail.body).toBe(403)
    const joined = await as('editor', true)('POST', `${ORDERS}/aggregate/run`, {
      stages: [{ $lookup: { from: 'by_email', pipeline: [], as: 'x' } }],
      limit: 10,
    })
    expect(joined.statusCode).toBe(403)
  })

  it('masks the values in an explain answer', async () => {
    const { as } = await setup()
    const res = await as('viewer', true)('POST', `${USERS}/explain`, {
      kind: 'find',
      filter: { name: 'Ali' },
      verbosity: 'queryPlanner',
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.stringify(res.json().raw)).not.toContain('Ali')
    const refused = await as('viewer', true)('POST', `${USERS}/explain`, {
      kind: 'find',
      filter: { email: 'x' },
      verbosity: 'queryPlanner',
    })
    expect(refused.statusCode).toBe(403)
  })
})
