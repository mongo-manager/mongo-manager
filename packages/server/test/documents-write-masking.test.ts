// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Int32, MongoClient, type Document } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { restrictedApp } from './support/restricted'
import type { TestApp } from './helpers'
import { slow } from './support/slowness'

/** Phase 3c §5.1: a restricted editor's document writes. */
const S = 'S3NT1N3L'
const RULES = [
  { db: 'crm', coll: 'users', field: 'email' },
  { db: 'crm', coll: 'users', field: 'customer.phone' },
  { db: 'crm', coll: 'users', field: 'items.cardNo' },
  { db: 'crm', coll: 'byemail', field: '_id' },
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
  await crm.collection('users').deleteMany({})
  await crm.collection('users').insertOne({
    _id: 1 as never,
    email: `${S}@x`,
    name: 'Ali',
    customer: { phone: new Int32(5551234), city: 'Izmir' },
    items: [{ cardNo: `${S}-c`, qty: 1 }],
  })
  await crm.collection('byemail').deleteMany({})
  await crm.collection('byemail').insertOne({ _id: 'a@x' as never, n: 1 })
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
const stored = () =>
  client
    .db('crm')
    .collection('users')
    .findOne({ _id: 1 as never }, { promoteValues: false }) as Promise<Document>
type Caller = ReturnType<Awaited<ReturnType<typeof setup>>['as']>
const pinOf = async (user: Caller) =>
  (
    (await user('POST', `${NS}/find`, { filter: { _id: 1 }, limit: 1 })).json() as {
      documents: Array<{ hash: string; document: Document }>
    }
  ).documents[0]!

describe('document writes for a restricted editor (phase 3c §5.1)', () => {
  // Data review 2026-10-13 (M3): a hidden value the app would misread is kept as stored by a
  // replace, and nothing — no caution, no refusal — says what it holds.
  it('says nothing of a hidden value the app would misread, and keeps it as stored', async () => {
    const users = client.db('crm').collection('users')
    await users.replaceOne({ _id: 1 as never }, {
      email: { $numberInt: '5' },
      name: 'Ali',
      customer: { phone: { $undefined: true }, city: 'Izmir' },
    } as never)
    const { as } = await setup()
    const user = as('editor', true)
    const pin = await pinOf(user)
    expect(pin).not.toHaveProperty('caution')
    const res = await user('POST', `${NS}/documents/replace`, {
      _id: 1,
      hash: pin.hash,
      document: { ...pin.document, name: 'Bea' },
    })
    expect(res.statusCode).toBe(200)
    const after = await stored()
    expect(after.email).toEqual({ $numberInt: '5' })
    expect(after.customer).toEqual({ phone: { $undefined: true }, city: 'Izmir' })
    expect(after.name).toBe('Bea')
    const again = await pinOf(user)
    const refused = await user('POST', `${NS}/documents/update`, {
      _id: 1,
      set: { email: 'x' },
      unset: [],
      hash: again.hash,
    })
    expect(refused.statusCode).toBe(403)
    expect(JSON.stringify(refused.json())).not.toContain('not_round_trip')
  })

  it('updates other fields, refuses personal ones', async () => {
    const { as } = await setup()
    const user = as('editor', true)
    const pin = await pinOf(user)
    const ok = await user('POST', `${NS}/documents/update`, {
      _id: 1,
      set: { name: 'Bea', 'customer.city': 'Ankara' },
      unset: [],
      hash: pin.hash,
    })
    expect(ok.statusCode).toBe(200)
    const again = await pinOf(user)
    const refused = await user('POST', `${NS}/documents/update`, {
      _id: 1,
      set: { email: 'x' },
      unset: [],
      hash: again.hash,
    })
    expect(refused.statusCode).toBe(403)
    expect(refused.json().details).toMatchObject({ reason: 'personal_write', field: 'email' })
    expect((await stored()).email).toBe(`${S}@x`)
  })

  it('replaces with *** and keeps the stored personal values and their types (review focus 4)', async () => {
    const { as } = await setup()
    const user = as('editor', true)
    const pin = await pinOf(user)
    const res = await user('POST', `${NS}/documents/replace`, {
      _id: 1,
      document: { ...pin.document, name: 'Replaced' },
      hash: pin.hash,
    })
    expect(res.statusCode).toBe(200)
    const doc = await stored()
    expect(doc.email).toBe(`${S}@x`)
    expect(doc.customer.phone).toBeInstanceOf(Int32)
    expect(doc.items[0].cardNo).toBe(`${S}-c`)
    expect(doc.name).toBe('Replaced')
  })

  it('refuses a replace that drops a personal value, and inserts that bring one', async () => {
    const { as } = await setup()
    const user = as('editor', true)
    const pin = await pinOf(user)
    const { email: _e, ...without } = pin.document
    const dropped = await user('POST', `${NS}/documents/replace`, {
      _id: 1,
      document: without,
      hash: pin.hash,
    })
    expect(dropped.statusCode).toBe(403)
    expect((await stored()).email).toBe(`${S}@x`)
    expect(
      (await user('POST', `${NS}/documents`, { documents: [{ name: 'n', email: 'e' }] })).statusCode,
    ).toBe(403)
    expect((await user('POST', `${NS}/documents`, { documents: [{ name: 'n' }] })).statusCode).toBe(200)
  })

  it('deletes a document, but not by a personal _id', async () => {
    const { as } = await setup()
    const user = as('editor', true)
    const byPersonal = await user('POST', '/databases/crm/collections/byemail/documents/delete', {
      _id: 'a@x',
    })
    expect(byPersonal.statusCode).toBe(403)
    expect(await client.db('crm').collection('byemail').countDocuments()).toBe(1)
    expect((await user('POST', `${NS}/documents/delete`, { _id: 99 })).statusCode).toBe(404)
    expect((await user('POST', `${NS}/documents/delete`, { _id: 1 })).statusCode).toBe(204)
  })

  it('still lets an editor who sees everything change personal values', async () => {
    const { as } = await setup()
    const editor = as('editor')
    const pin = await pinOf(editor)
    const res = await editor('POST', `${NS}/documents/update`, {
      _id: 1,
      set: { email: 'new@x' },
      unset: [],
      hash: pin.hash,
    })
    expect(res.statusCode).toBe(200)
    expect((await stored()).email).toBe('new@x')
  })
})

// Final review of the validation details: a restricted editor told which rules a write did not
// meet — the field as the schema names it and the rule, never a value, nor the document's own keys.
describe("a restricted editor's write the validator refuses", () => {
  it('names the fields and rules, and nothing the document or the validator holds', async () => {
    const crm = client.db('crm')
    await crm.dropCollection('checked').catch(() => undefined)
    await crm.createCollection('checked', {
      validator: {
        $jsonSchema: {
          required: ['name'],
          additionalProperties: false,
          properties: { _id: {}, name: {}, age: { minimum: 18, description: `${S} rule text` } },
        },
      },
    })
    const { as } = await setup()
    const user = as('editor', true)
    const res = await user('POST', '/databases/crm/collections/checked/documents', {
      documents: [{ age: -7, [`${S}key`]: 1 }],
    })
    expect(res.statusCode, res.body).toBe(400)
    const details = res.json().details as { hidden: boolean; problems: Array<Record<string, unknown>> }
    expect(details.hidden).toBe(true)
    expect(details.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'age', rule: 'minimum' }),
        { path: 'name', rule: 'required' },
        { path: '', rule: 'additionalProperties' },
      ]),
    )
    expect(res.body).not.toContain(S)
    // The details only: the correlation id is random hex.
    expect(JSON.stringify(details)).not.toContain('-7')
    expect(JSON.stringify(details)).not.toContain('18')
  })
})
