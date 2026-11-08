// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MongoClient, ObjectId } from 'mongodb'
import { ConnectionSettingsSchema, type DataModel } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { restrictedApp } from './support/restricted'
import { H, makeApp } from './helpers'

/** Review of W6b (2026-10-16): the data model for narrow MongoDB users, system databases and its cost. */
let open: TestMongo
let secured: TestMongo
beforeAll(async () => {
  ;[open, secured] = await Promise.all([
    startMongo(),
    startMongo({ auth: { user: 'root', password: 'root-pass' } }),
  ])
})
afterAll(async () => {
  await open?.stop()
  await secured?.stop()
})
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of closers.splice(0)) await c()
})

describe('the data model, after review', () => {
  it('draws the collections a MongoDB user limited to one collection may list (I1)', async () => {
    const root = await MongoClient.connect(
      `mongodb://root:root-pass@127.0.0.1:${secured.port}/?authSource=admin`,
    )
    const db = `m${randomUUID().slice(0, 8)}`
    const users = [new ObjectId(), new ObjectId()]
    await root
      .db(db)
      .collection('visible')
      .insertMany(users.map((_id) => ({ _id, userId: _id })))
    await root.db(db).collection('hidden').insertOne({ a: 1 })
    // Re-review minor 1: a view the user may read stays a view (never sampled, never a target).
    await root.db(db).createCollection('visibleView', { viewOn: 'visible', pipeline: [] })
    const role = `onlyVisible${randomUUID().slice(0, 6)}`
    const user = `narrow${randomUUID().slice(0, 6)}`
    await root.db('admin').command({
      createRole: role,
      privileges: [
        { resource: { db, collection: 'visible' }, actions: ['find'] },
        { resource: { db, collection: 'visibleView' }, actions: ['find'] },
      ],
      roles: [],
    })
    await root.db('admin').command({ createUser: user, pwd: 'narrow-pass', roles: [{ role, db: 'admin' }] })
    await root.close()
    const t = await makeApp()
    closers.push(() => t.close())
    const conn = t.app.ctx.connections.create(
      {
        name: 'Narrow',
        favorite: false,
        readOnly: false,
        settings: ConnectionSettingsSchema.parse({
          hosts: [{ host: '127.0.0.1', port: secured.port }],
          auth: { mechanism: 'DEFAULT', username: user, password: 'narrow-pass', authSource: 'admin' },
        }),
      },
      null,
    )
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/connections/${conn.id}/databases/${db}/model?sampleSize=20`,
      headers: H,
    })
    expect(res.statusCode).toBe(200)
    const model = res.json() as DataModel
    expect(model.collections.map((c) => [c.name, c.type])).toEqual([
      ['visible', 'collection'],
      ['visibleView', 'view'],
    ])
    expect(model.collections[0]!.fields.map((f) => f.path)).toEqual(['_id', 'userId'])
    expect(model.collections[1]).toMatchObject({ sampled: 0, fields: [] })
    expect(model.references.some((r) => r.to === 'visibleView' || r.from === 'visibleView')).toBe(false)
  })

  it('refuses a non-admin the local database (403), as every database route does', async () => {
    const { as, t } = await restrictedApp(open, [])
    closers.push(t.close)
    for (const db of ['local'])
      expect((await as('viewer')('GET', `/databases/${db}/model`)).statusCode, db).toBe(403)
  })

  it('samples fewer documents each when the collections times the sample would pass the cap (13)', async () => {
    const client = await MongoClient.connect(`mongodb://127.0.0.1:${open.port}`)
    const db = `m${randomUUID().slice(0, 8)}`
    for (const name of ['a', 'b', 'c', 'd'])
      await client
        .db(db)
        .collection(name)
        .insertMany(Array.from({ length: 300 }, (_, i) => ({ i })))
    await client.close()
    const r = await restrictedApp(open, [], { modelMaxDocs: 400 } as never)
    closers.push(r.t.close)
    const model = (await r.as('viewer')('GET', `/databases/${db}/model?sampleSize=1000`)).json() as DataModel
    expect(model.sampleSize).toBe(100)
    expect(model.capped).toBe(true)
    expect(model.collections.map((c) => c.sampled)).toEqual([100, 100, 100, 100])
    // Within the cap, the size asked for.
    const small = (await r.as('viewer')('GET', `/databases/${db}/model?sampleSize=50`)).json() as DataModel
    expect(small.sampleSize).toBe(50)
    expect(small.capped).toBeUndefined()
  })
})
