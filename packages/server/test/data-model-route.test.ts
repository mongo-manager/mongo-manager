// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Binary, Db, Decimal128, Long, MongoClient, MongoServerError, ObjectId } from 'mongodb'
import type { DataModel } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { restrictedApp } from './support/restricted'

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
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of closers.splice(0)) await c()
})

/** A shop: users, orders referring to them (by name and value), products joined by a saved pipeline. */
async function shop() {
  const db = `m${randomUUID().slice(0, 8)}`
  const users = [new ObjectId(), new ObjectId(), new ObjectId()]
  await client
    .db(db)
    .collection('users')
    .insertMany(users.map((_id, i) => ({ _id, email: `secret-${i}@example.com`, profile: { city: 'X' } })))
  const products = [new ObjectId(), new ObjectId()]
  await client
    .db(db)
    .collection('products')
    .insertMany(products.map((_id, i) => ({ _id, title: `p${i}` })))
  await client
    .db(db)
    .collection('orders')
    .insertMany(
      Array.from({ length: 30 }, (_, i) => ({
        userId: users[i % 3],
        buyer: users[(i + 1) % 3],
        sku: products[i % 2],
        total: i,
        card: `4111-secret-${i}`,
      })),
    )
  await client
    .db(db)
    .createCollection('bigOrders', { viewOn: 'orders', pipeline: [{ $match: { total: { $gt: 10 } } }] })
  return { db, users }
}

async function app(rules: Array<{ db: string; coll: string; field: string }> = []) {
  const r = await restrictedApp(mongo, rules)
  closers.push(r.t.close)
  return r
}

describe('the data model route (completion W6.4)', () => {
  it('draws the collections, their fields and the references found by name, values and $lookup', async () => {
    const { db } = await shop()
    const { ctx, connectionId, as } = await app()
    const viewer = as('viewer')
    ctx.savedPipelines.create({
      ownerId: viewer.id,
      connectionId,
      db,
      coll: 'orders',
      name: 'with products',
      tags: [],
      text: JSON.stringify([
        { $lookup: { from: 'products', localField: 'sku', foreignField: '_id', as: 'p' } },
      ]),
      shared: false,
    })
    const res = await viewer('GET', `/databases/${db}/model?sampleSize=50`)
    expect(res.statusCode).toBe(200)
    const model = res.json() as DataModel
    expect(model.collections.map((c) => [c.name, c.type])).toEqual([
      ['bigOrders', 'view'],
      ['orders', 'collection'],
      ['products', 'collection'],
      ['users', 'collection'],
    ])
    expect(model.collections.find((c) => c.name === 'bigOrders')).toMatchObject({
      viewOn: 'orders',
      sampled: 0,
    })
    const orders = model.collections.find((c) => c.name === 'orders')!
    expect(orders.sampled).toBe(30)
    expect(orders.fields.map((f) => f.path)).toEqual(['_id', 'buyer', 'card', 'sku', 'total', 'userId'])
    const ref = (field: string) => model.references.find((r) => r.from === 'orders' && r.field === field)
    expect(ref('userId')).toMatchObject({ to: 'users', toField: '_id', sources: ['name', 'values'] })
    expect(ref('buyer')).toMatchObject({ to: 'users', sources: ['values'] })
    expect(ref('sku')).toMatchObject({ to: 'products', sources: ['values', 'lookup'] })
    // Names, types and counts only: never a value.
    expect(res.payload).not.toMatch(/secret|example\.com/)
    expect(res.payload).not.toMatch(/[0-9a-f]{24}/)
  })

  // Review of the agent's gate (M-1): a gate's failed catalog listing says why by its cause.
  it('says a collection whose catalog entry MongoDB denied is not permitted', async () => {
    const { db } = await shop()
    const masked = await app([{ db: '*', coll: 'users', field: 'email' }])
    const listCollections = Db.prototype.listCollections
    let code = 13
    vi.spyOn(Db.prototype, 'listCollections').mockImplementation(function (this: Db, ...args: unknown[]) {
      const filter = args[0] as { name?: unknown } | undefined
      if (this.databaseName === db && filter?.name === 'orders')
        return {
          toArray: () => Promise.reject(new MongoServerError({ message: 'listing failed', code })),
        } as never
      return listCollections.apply(this, args as never)
    } as typeof listCollections)
    try {
      // A right (13, Atlas's 8000), a time limit (262; next round, nit).
      for (const [failure, refused] of [
        [13, 'not_permitted'],
        [8000, 'not_permitted'],
        [262, 'timeout'],
      ] as const) {
        code = failure
        const res = await masked.as('viewer', true)('GET', `/databases/${db}/model?sampleSize=50`)
        expect(res.statusCode, res.body).toBe(200)
        const orders = (res.json() as DataModel).collections.find((c) => c.name === 'orders')
        expect(orders?.refused).toBe(refused)
      }
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('shows a masked field by name only, and never checks or returns its values', async () => {
    const { db } = await shop()
    const { as } = await app([])
    const masked = await app([
      { db: '*', coll: 'orders', field: 'userId' },
      { db: '*', coll: 'users', field: 'email' },
    ])
    const res = await masked.as('viewer', true)('GET', `/databases/${db}/model?sampleSize=50`)
    expect(res.statusCode).toBe(200)
    const model = res.json() as DataModel
    const orders = model.collections.find((c) => c.name === 'orders')!
    expect(orders.fields.find((f) => f.path === 'userId')).toEqual({
      path: 'userId',
      types: [],
      share: 1,
      masked: true,
    })
    expect(
      model.collections.find((c) => c.name === 'users')!.fields.find((f) => f.path === 'email'),
    ).toMatchObject({
      masked: true,
      types: [],
    })
    // Inferred by its name alone: its values were never read.
    expect(model.references.find((r) => r.field === 'userId')).toMatchObject({
      to: 'users',
      sources: ['name'],
    })
    expect(model.references.find((r) => r.field === 'userId')).not.toHaveProperty('overlap')
    expect(res.payload).not.toMatch(/secret|example\.com|[0-9a-f]{24}/)
    // The same database for someone who may see it all: values checked.
    const open = (await as('viewer')('GET', `/databases/${db}/model?sampleSize=50`)).json() as DataModel
    expect(open.references.find((r) => r.field === 'userId')!.sources).toEqual(['name', 'values'])
  })

  it('never looks up _ids that are personal in the target (the gate refuses the check)', async () => {
    const { db } = await shop()
    const masked = await app([{ db: '*', coll: 'users', field: '_id' }])
    const res = await masked.as('viewer', true)('GET', `/databases/${db}/model?sampleSize=50`)
    expect(res.statusCode).toBe(200)
    const model = res.json() as DataModel
    // buyer names nothing: only its values could tie it to users, and they were not looked up there.
    expect(model.references.find((r) => r.field === 'buyer' && r.to === 'users')).toBeUndefined()
    expect(model.references.find((r) => r.field === 'userId')).toMatchObject({
      to: 'users',
      sources: ['name'],
    })
  })

  it('leaves credential and system collections out for non-admins, and refuses bad input', async () => {
    const { db } = await shop()
    await client
      .db(db)
      .createCollection('system.js')
      .catch(() => undefined)
    const { as } = await app()
    const viewer = as('viewer')
    const names = ((await viewer('GET', `/databases/${db}/model`)).json() as DataModel).collections.map(
      (c) => c.name,
    )
    expect(names).not.toContain('system.js')
    const admin = (await viewer('GET', '/databases/admin/model')).json() as DataModel | { code: string }
    expect(JSON.stringify(admin)).not.toContain('system.users')
    for (const q of ['sampleSize=5', 'sampleSize=5000', 'sampleSize=x', 'other=1'])
      expect((await viewer('GET', `/databases/${db}/model?${q}`)).statusCode, q).toBe(400)
    expect((await viewer('GET', '/databases/bad$name/model')).statusCode).toBe(400)
  })

  it('reads only the saved pipelines this user may see', async () => {
    const { db } = await shop()
    const { ctx, connectionId, as } = await app()
    const owner = as('editor')
    const other = as('viewer')
    ctx.savedPipelines.create({
      ownerId: owner.id,
      connectionId,
      db,
      coll: 'orders',
      name: 'mine only',
      tags: [],
      text: JSON.stringify([
        { $lookup: { from: 'users', localField: 'total', foreignField: 'age', as: 'x' } },
      ]),
      shared: false,
    })
    const theirs = (await other('GET', `/databases/${db}/model`)).json() as DataModel
    expect(theirs.references.some((r) => r.field === 'total')).toBe(false)
    const mine = (await owner('GET', `/databases/${db}/model`)).json() as DataModel
    expect(mine.references.find((r) => r.field === 'total')).toMatchObject({
      to: 'users',
      toField: 'age',
      sources: ['lookup'],
    })
  })

  // Plugins wave 3 (spec §4): each collection's indexes, by their keys' names only.
  it('says each collection’s indexes by their keys, and which are unique — never a partial filter', async () => {
    const { db } = await shop()
    await client.db(db).collection('orders').createIndex({ userId: 1, total: -1 })
    await client.db(db).collection('users').createIndex({ email: 1 }, { unique: true })
    await client
      .db(db)
      .collection('products')
      .createIndex({ title: 1 }, { partialFilterExpression: { title: 'p-secret' } })
    const { as } = await app()
    const model = (await as('viewer')('GET', `/databases/${db}/model?sampleSize=50`)).json() as DataModel
    const of = (name: string) => model.collections.find((c) => c.name === name)!
    expect(of('orders').indexes).toEqual([{ keys: ['_id'], unique: true }, { keys: ['userId', 'total'] }])
    expect(of('users').indexes).toEqual([
      { keys: ['_id'], unique: true },
      { keys: ['email'], unique: true },
    ])
    expect(of('products').indexes).toEqual([{ keys: ['_id'], unique: true }, { keys: ['title'] }])
    // A view has none of its own.
    expect(of('bigOrders').indexes).toBeUndefined()
    expect(JSON.stringify(model)).not.toContain('p-secret')
  })

  // Wave 3 review: a text index names the fields it searches (its weights), never _fts and _ftsx.
  it('says the fields a text index searches, and its other keys', async () => {
    const { db } = await shop()
    await client.db(db).collection('products').createIndex({ sku: 1, title: 'text', blurb: 'text' })
    const { as } = await app()
    const model = (await as('viewer')('GET', `/databases/${db}/model?sampleSize=50`)).json() as DataModel
    const products = model.collections.find((c) => c.name === 'products')!
    expect(products.indexes!.at(-1)!.keys.sort()).toEqual(['blurb', 'sku', 'title'])
  })

  // Wave 3 second review: a wildcard index with a projection covers only the fields it names; one
  // that leaves fields out, and a wildcard text index, mark nothing rather than too much.
  it('says what a wildcard index covers, never more', async () => {
    const { db } = await shop()
    const users = client.db(db).collection('users')
    await users.createIndex({ '$**': 1 }, { wildcardProjection: { profile: 1 }, name: 'some' })
    const orders = client.db(db).collection('orders')
    await orders.createIndex({ '$**': 1 }, { wildcardProjection: { card: 0 }, name: 'most' })
    await client.db(db).collection('products').createIndex({ '$**': 'text' })
    await client
      .db(db)
      .collection('bigOrders_src')
      .createIndex({ '$**': 1 }, { wildcardProjection: { items: { sku: 1 } }, name: 'nested' })
    const { as } = await app()
    const model = (await as('viewer')('GET', `/databases/${db}/model?sampleSize=50`)).json() as DataModel
    const of = (name: string) => model.collections.find((c) => c.name === name)!.indexes!
    expect(of('users').at(-1)!.keys).toEqual(['profile', 'profile.$**'])
    expect(of('orders').at(-1)!.keys).toEqual([])
    expect(of('products').at(-1)!.keys).toEqual([])
    // A nested projection names the field below: items.sku, not all of items.
    expect(of('bigOrders_src').at(-1)!.keys).toEqual(['items.sku', 'items.sku.$**'])
  })

  // Wave 3 review (e2e screen 2026-10-26): an avatar of bytes was drawn as a string.
  it('names each BSON type as it is: binary, dates, decimals and longs', async () => {
    const db = `m${randomUUID().slice(0, 8)}`
    await client
      .db(db)
      .collection('files')
      .insertOne({
        avatar: new Binary(Buffer.from('89504e470d0a1a0a', 'hex')),
        at: new Date(0),
        price: Decimal128.fromString('1.5'),
        big: Long.fromNumber(2 ** 40),
      })
    const { as } = await app()
    const model = (await as('viewer')('GET', `/databases/${db}/model?sampleSize=50`)).json() as DataModel
    const types = Object.fromEntries(model.collections[0]!.fields.map((f) => [f.path, f.types]))
    expect(types).toMatchObject({ avatar: ['binData'], at: ['date'], price: ['decimal'], big: ['long'] })
  })
})
