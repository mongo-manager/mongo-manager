// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Double, Long, MongoClient, type Document } from 'mongodb'
import type { FastifyRequest } from 'fastify'
import { serializeValue } from '@mongo-manager/shared'
import { assertSourceAllowed } from '../src/routes/data/params'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, type DataHarness } from './support/data'
import { restrictedApp } from './support/restricted'
import type { TestApp } from './helpers'

/**
 * W2.2 and W2.4 (2026-10-16): a collection made with a default collation and change-stream
 * pre/post images, those images turned on or off later (collMod), and a view's pipeline edited in
 * place (collMod viewOn/pipeline) — each needs databases:write, names the collection it changes,
 * and is audited.
 */
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
const harnesses: DataHarness[] = []
const apps: TestApp[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.t.close()
  for (const t of apps.splice(0)) await t.close()
})
async function setup() {
  const h = await dataHarness(mongo)
  harnesses.push(h)
  const db = `d${randomUUID().slice(0, 8)}`
  return { h, db }
}
const optionsOf = async (db: string, name: string): Promise<Document> => {
  const [info] = await client.db(db).listCollections({ name }).toArray()
  return (info as { options?: Document } | undefined)?.options ?? {}
}

describe('create a collection with a collation and pre/post images', () => {
  it('sets the default collation and the change-stream images MongoDB is asked for', async () => {
    const { h, db } = await setup()
    const res = await h.call('POST', `/databases/${db}/collections`, {
      kind: 'collection',
      name: 'people',
      collation: { locale: 'tr', strength: 2, numericOrdering: true },
      changeStreamPreAndPostImages: true,
    })
    expect(res.statusCode).toBe(201)
    const options = await optionsOf(db, 'people')
    expect(options.collation).toMatchObject({ locale: 'tr', strength: 2, numericOrdering: true })
    expect(options.changeStreamPreAndPostImages).toEqual({ enabled: true })
    // A view takes a collation as well.
    const view = await h.call('POST', `/databases/${db}/collections`, {
      kind: 'view',
      name: 'v',
      viewOn: 'people',
      pipeline: [],
      collation: { locale: 'de' },
    })
    expect(view.statusCode).toBe(201)
    expect((await optionsOf(db, 'v')).collation).toMatchObject({ locale: 'de' })
  })

  it('refuses a collation it does not know, and pre/post images on a time series', async () => {
    const { h, db } = await setup()
    const bad = [
      { locale: 'tr', strength: 9 },
      { locale: 'tr', extra: true },
      { locale: '../../x' },
      { strength: 1 },
    ]
    for (const collation of bad) {
      const res = await h.call('POST', `/databases/${db}/collections`, {
        kind: 'collection',
        name: 'c',
        collation,
      })
      expect(res.statusCode, JSON.stringify(collation)).toBe(400)
    }
    const ts = await h.call('POST', `/databases/${db}/collections`, {
      kind: 'timeseries',
      name: 'ts',
      timeField: 't',
      changeStreamPreAndPostImages: true,
    })
    expect(ts.statusCode).toBe(400)
    // A new view's pipeline is refused server JavaScript, as an edited one is (reading the view
    // would run it).
    const js = await h.call('POST', `/databases/${db}/collections`, {
      kind: 'view',
      name: 'v',
      viewOn: 'x',
      pipeline: [
        { $addFields: { x: { $function: { body: 'function() { return 1 }', args: [], lang: 'js' } } } },
      ],
    })
    expect(js.statusCode).toBe(400)
    expect(await client.db(db).listCollections().toArray()).toEqual([])
  })
})

describe('turn pre/post images on or off', () => {
  it('changes them with the collection named, and audits it', async () => {
    const { h, db } = await setup()
    await client.db(db).createCollection('orders')
    const path = `/databases/${db}/collections/orders/options`
    const wrong = await h.call('PATCH', path, { changeStreamPreAndPostImages: true, confirm: 'other' })
    expect(wrong.statusCode).toBe(400)
    expect((await optionsOf(db, 'orders')).changeStreamPreAndPostImages).toBeUndefined()
    const on = await h.call('PATCH', path, { changeStreamPreAndPostImages: true, confirm: 'orders' })
    expect(on.statusCode).toBe(200)
    expect(on.json()).toEqual({ changeStreamPreAndPostImages: true })
    expect((await optionsOf(db, 'orders')).changeStreamPreAndPostImages).toEqual({ enabled: true })
    const off = await h.call('PATCH', path, { changeStreamPreAndPostImages: false, confirm: 'orders' })
    expect(off.statusCode).toBe(200)
    expect((await optionsOf(db, 'orders')).changeStreamPreAndPostImages?.enabled ?? false).toBe(false)
    const rows = h.t.app.ctx.audit
      .list({ action: 'collections.modify' })
      .filter((r) => r.outcome === 'success')
    expect(rows.map((r) => r.details)).toEqual([
      expect.objectContaining({ changeStreamPreAndPostImages: false }),
      expect.objectContaining({ changeStreamPreAndPostImages: true }),
    ])
  })

  it('refuses a view, a system collection and anything but the one option', async () => {
    const { h, db } = await setup()
    await client.db(db).createCollection('orders')
    await client.db(db).createCollection('v', { viewOn: 'orders', pipeline: [] })
    const view = await h.call('PATCH', `/databases/${db}/collections/v/options`, {
      changeStreamPreAndPostImages: true,
      confirm: 'v',
    })
    expect(view.statusCode).toBe(400)
    const system = await h.call('PATCH', `/databases/${db}/collections/system.views/options`, {
      changeStreamPreAndPostImages: true,
      confirm: 'system.views',
    })
    expect([400, 403]).toContain(system.statusCode)
    const extra = await h.call('PATCH', `/databases/${db}/collections/orders/options`, {
      changeStreamPreAndPostImages: true,
      confirm: 'orders',
      validator: { $where: 'sleep(1000)' },
    })
    expect(extra.statusCode).toBe(400)
  })
})

describe("edit a view's pipeline", () => {
  /** The definition as the page got it (canonical EJSON): what an edit says it started from. */
  const baseOf = async (db: string, name: string) => {
    const o = await optionsOf(db, name)
    return serializeValue({ viewOn: o.viewOn, pipeline: o.pipeline }) as object
  }
  async function withView() {
    const s = await setup()
    await client
      .db(s.db)
      .collection('orders')
      .insertMany([{ n: 1 }, { n: 2 }, { n: 3 }])
    await client
      .db(s.db)
      .createCollection('big', { viewOn: 'orders', pipeline: [{ $match: { n: { $gt: 1 } } }] })
    return { ...s, path: `/databases/${s.db}/collections/big/view` }
  }

  it('replaces the pipeline (and the source) with the view named, and audits it', async () => {
    const { h, db, path } = await withView()
    const base = await baseOf(db, 'big')
    const pipeline = [{ $match: { n: { $gt: { $numberInt: '2' } } } }]
    const wrong = await h.call('PUT', path, { viewOn: 'orders', pipeline, confirm: 'orders', base })
    expect(wrong.statusCode).toBe(400)
    const res = await h.call('PUT', path, { viewOn: 'orders', pipeline, confirm: 'big', base })
    expect(res.statusCode).toBe(200)
    expect(await client.db(db).collection('big').countDocuments()).toBe(1)
    expect((await optionsOf(db, 'big')).pipeline).toEqual([{ $match: { n: { $gt: 2 } } }])
    const [row] = h.t.app.ctx.audit.list({ action: 'collections.view.update' })
    expect(row).toMatchObject({ details: { viewOn: 'orders', previousViewOn: 'orders', stages: 1 } })
  })

  // W2 review (I1): an edit that started from another definition would undo a change made meanwhile.
  // Re-review (minor 3): the definition to edit keeps its types — a double 1.0 stays a double and a
  // small Long a Long, read for the edit and written back.
  it('reads a view to edit with its types, and writes them back as they were', async () => {
    const s = await setup()
    await client.db(s.db).collection('orders').insertOne({ d: 1, l: 5 })
    await client.db(s.db).createCollection('typed', {
      viewOn: 'orders',
      pipeline: [{ $match: { d: new Double(1), l: Long.fromNumber(5) } }],
    })
    const path = `/databases/${s.db}/collections/typed/view`
    const read = await s.h.call('GET', path)
    expect(read.statusCode).toBe(200)
    const definition = read.json() as { viewOn: string; pipeline: unknown[] }
    expect(definition).toEqual({
      viewOn: 'orders',
      pipeline: [{ $match: { d: { $numberDouble: '1.0' }, l: { $numberLong: '5' } } }],
    })
    const res = await s.h.call('PUT', path, { ...definition, confirm: 'typed', base: definition })
    expect(res.statusCode).toBe(200)
    const [info] = await client
      .db(s.db)
      .listCollections({ name: 'typed' }, { promoteValues: false })
      .toArray()
    const match = (info as unknown as { options: { pipeline: Array<{ $match: Record<string, unknown> }> } })
      .options.pipeline[0]!.$match
    expect((match.d as { _bsontype?: string })._bsontype).toBe('Double')
    expect((match.l as { _bsontype?: string })._bsontype).toBe('Long')
    // Only a view has a definition to edit.
    expect((await s.h.call('GET', `/databases/${s.db}/collections/orders/view`)).statusCode).toBe(400)
  })

  it('refuses an edit begun before the view changed, and keeps the change made meanwhile', async () => {
    const { h, db, path } = await withView()
    const base = await baseOf(db, 'big')
    // Someone else changes the view.
    await client.db(db).command({ collMod: 'big', viewOn: 'orders', pipeline: [{ $limit: 1 }] })
    const stale = await h.call('PUT', path, { viewOn: 'orders', pipeline: [], confirm: 'big', base })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().details).toMatchObject({ reason: 'view_changed' })
    expect((await optionsOf(db, 'big')).pipeline).toEqual([{ $limit: 1 }])
    // Started again from what is there now, it goes through.
    const fresh = await h.call('PUT', path, {
      viewOn: 'orders',
      pipeline: [],
      confirm: 'big',
      base: await baseOf(db, 'big'),
    })
    expect(fresh.statusCode).toBe(200)
    // The definition the edit started from is required.
    const none = await h.call('PUT', path, { viewOn: 'orders', pipeline: [], confirm: 'big' })
    expect(none.statusCode).toBe(400)
  })

  it('refuses a pipeline that writes, server JavaScript, and a collection that is no view', async () => {
    const { h, db, path } = await withView()
    const base = await baseOf(db, 'big')
    const out = await h.call('PUT', path, {
      viewOn: 'orders',
      pipeline: [{ $out: 'x' }],
      confirm: 'big',
      base,
    })
    expect(out.statusCode).toBe(400)
    const js = await h.call('PUT', path, {
      viewOn: 'orders',
      pipeline: [
        { $addFields: { x: { $function: { body: 'function() { return 1 }', args: [], lang: 'js' } } } },
      ],
      confirm: 'big',
      base,
    })
    expect(js.statusCode).toBe(400)
    const notView = await h.call('PUT', `/databases/${db}/collections/orders/view`, {
      viewOn: 'big',
      pipeline: [],
      confirm: 'orders',
      base: { viewOn: 'big', pipeline: [] },
    })
    expect(notView.statusCode).toBe(400)
    expect((await optionsOf(db, 'big')).pipeline).toEqual([{ $match: { n: { $gt: 1 } } }])
  })

  it('keeps a restricted user from pointing a view at personal data', async () => {
    const db = `r${randomUUID().slice(0, 8)}`
    await client.db(db).collection('users').insertOne({ email: 'x@y', name: 'A' })
    await client.db(db).collection('notes').insertOne({ text: 'hi' })
    await client.db(db).createCollection('v', { viewOn: 'notes', pipeline: [] })
    const r = await restrictedApp(mongo, [{ db, coll: 'users', field: 'email' }])
    apps.push(r.t)
    const user = r.as('editor', true)
    const base = await baseOf(db, 'v')
    const res = await user('PUT', `/databases/${db}/collections/v/view`, {
      viewOn: 'users',
      pipeline: [],
      confirm: 'v',
      base,
    })
    expect(res.statusCode).toBe(403)
    expect((await optionsOf(db, 'v')).viewOn).toBe('notes')
    // A view over data without rules is theirs to change.
    const fine = await user('PUT', `/databases/${db}/collections/v/view`, {
      viewOn: 'notes',
      pipeline: [{ $limit: 1 }],
      confirm: 'v',
      base,
    })
    expect(fine.statusCode).toBe(200)
  })

  it('keeps a view over a credential collection for connection admins, new or edited', async () => {
    const db = `c${randomUUID().slice(0, 8)}`
    await client.db(db).collection('notes').insertOne({ text: 'hi' })
    await client.db(db).createCollection('v', { viewOn: 'notes', pipeline: [] })
    const r = await restrictedApp(mongo, [])
    apps.push(r.t)
    const editor = r.as('editor')
    const base = await baseOf(db, 'v')
    const edited = await editor('PUT', `/databases/${db}/collections/v/view`, {
      viewOn: 'system.users',
      pipeline: [],
      confirm: 'v',
      base,
    })
    expect(edited.statusCode).toBe(403)
    const created = await editor('POST', `/databases/${db}/collections`, {
      kind: 'view',
      name: 'w',
      viewOn: 'system.roles',
      pipeline: [],
    })
    expect(created.statusCode).toBe(403)
    expect((await optionsOf(db, 'v')).viewOn).toBe('notes')
    // A connection admin may.
    expect(
      (
        await r.as('admin')('PUT', `/databases/${db}/collections/v/view`, {
          viewOn: 'system.users',
          pipeline: [],
          confirm: 'v',
          base,
        })
      ).statusCode,
    ).toBe(200)
  })

  // W2 review (minor 12): the same namespaces as every admin-only read, the local database included.
  it('treats the source of a view as every admin-only namespace is', () => {
    const request = (role: string) => ({ connectionRole: role }) as unknown as FastifyRequest
    expect(() => assertSourceAllowed(request('editor'), 'local', 'startup_log')).toThrow()
    expect(() => assertSourceAllowed(request('editor'), 'shop', 'system.users')).toThrow()
    expect(() => assertSourceAllowed(request('editor'), 'shop', 'orders')).not.toThrow()
    expect(() => assertSourceAllowed(request('admin'), 'local', 'startup_log')).not.toThrow()
  })

  it('refuses an edit of a definition the restricted user was shown masked', async () => {
    const db = `q${randomUUID().slice(0, 8)}`
    await client.db(db).collection('notes').insertOne({ text: 'hi' })
    await client.db(db).createCollection('v', { viewOn: 'notes', pipeline: [{ $match: { text: 'S3CR3T' } }] })
    // A rule on the view itself: its definition is shown with every literal masked.
    const r = await restrictedApp(mongo, [{ db, coll: 'v', field: 'x' }])
    apps.push(r.t)
    const user = r.as('editor', true)
    expect((await user('GET', `/databases/${db}/collections`)).body).not.toContain('S3CR3T')
    const res = await user('PUT', `/databases/${db}/collections/v/view`, {
      viewOn: 'notes',
      pipeline: [{ $match: { text: '***' } }],
      confirm: 'v',
      base: { viewOn: 'notes', pipeline: [{ $match: { text: '***' } }] },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().details).toMatchObject({ reason: 'masking_unsupported' })
    expect((await optionsOf(db, 'v')).pipeline).toEqual([{ $match: { text: 'S3CR3T' } }])
    // Someone who sees it whole may change it.
    const full = await r.as('editor')('PUT', `/databases/${db}/collections/v/view`, {
      viewOn: 'notes',
      pipeline: [],
      confirm: 'v',
      base: await baseOf(db, 'v'),
    })
    expect(full.statusCode).toBe(200)
  })
})
