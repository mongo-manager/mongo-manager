// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Double, Int32, ObjectId } from 'bson'
import { MongoClient } from 'mongodb'
import { ConnectionSettingsSchema, serializeValue, findServerJs } from '@mongo-manager/shared'
import { H, makeApp } from './helpers'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, type DataHarness } from './support/data'

let mongo: TestMongo
let secured: TestMongo
beforeAll(async () => {
  ;[mongo, secured] = await Promise.all([
    startMongo({ args: ['--setParameter', 'enableTestCommands=1'] }),
    startMongo({ auth: { user: 'root', password: 'root-pass' } }),
  ])
})
afterAll(async () => {
  await Promise.all([mongo?.stop(), secured?.stop()])
})
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})
async function harness(): Promise<DataHarness> {
  const h = await dataHarness(mongo)
  cleanups.push(() => h.t.close())
  return h
}
const S = serializeValue
const newDb = () => `d${randomUUID().slice(0, 8)}`

async function seeded() {
  const h = await harness()
  const db = newDb()
  const coll = (await h.client()).db(db).collection('items')
  await coll.insertMany([
    { _id: 'a', v: 1 },
    { _id: 'b', v: 2 },
    { _id: 'c', v: 3 },
  ] as never)
  return { h, db, coll, base: `/databases/${db}/collections/items` }
}

describe('critical: _id is always matched exactly', () => {
  it('rejects operator objects and treats regexes literally', async () => {
    const { h, base, coll } = await seeded()
    for (const [route, extra] of [
      ['get', {}],
      ['update', { set: { hacked: true }, hash: 'x' }],
      ['replace', { document: {}, hash: 'x' }],
      ['delete', {}],
    ] as const) {
      const res = await h.call('POST', `${base}/documents/${route}`, { _id: { $gt: 'a' }, ...extra })
      expect(res.statusCode, route).toBe(400)
    }
    expect(
      (
        await h.call('POST', `${base}/documents/get`, {
          _id: { $regularExpression: { pattern: '.', options: '' } },
        })
      ).statusCode,
    ).toBe(404)
    expect(await coll.countDocuments({ hacked: true })).toBe(0)
    expect(await coll.countDocuments()).toBe(3)
  })
})

describe('important: index wildcard and system namespaces', () => {
  it('never treats "*" as "drop every index"', async () => {
    const { h, base, coll } = await seeded()
    await coll.createIndexes([{ key: { v: 1 } }, { key: { w: 1 } }])
    expect((await h.call('DELETE', `${base}/indexes/*`)).statusCode).toBe(400)
    expect((await coll.listIndexes().toArray()).length).toBe(3)
  })

  it('restricts system namespaces to connection admins', async () => {
    const t = await makeApp({ auth: true })
    cleanups.push(() => t.close())
    const conn = t.app.ctx.connections.create(
      {
        name: 'M',
        favorite: false,
        readOnly: false,
        settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port: mongo.port }] }),
      },
      null,
    )
    const as = (role: 'editor' | 'viewer' | 'admin') => {
      const user = t.app.ctx.users.create({ username: `ns-${role}`, passwordHash: 'x', role })
      const { sessionId, session } = t.app.ctx.sessions.create(user.id, {})
      return (method: 'GET' | 'POST', path: string, payload?: object) =>
        t.app.inject({
          method,
          url: `/api/connections/${conn.id}${path}`,
          headers: { ...H, 'x-csrf-token': session.csrfToken },
          cookies: { mm_sid: sessionId },
          ...(payload ? { payload } : {}),
        })
    }
    const editor = as('editor')
    const viewer = as('viewer')
    const admin = as('admin')
    const db = newDb()
    expect(
      (
        await editor('POST', '/databases/admin/collections/system.users/documents', {
          documents: [{ user: 'x' }],
        })
      ).statusCode,
    ).toBe(403)
    expect(
      (await editor('POST', '/databases/local/collections/anything/documents', { documents: [{}] }))
        .statusCode,
    ).toBe(403)
    expect(
      (await editor('POST', `/databases/${db}/collections`, { kind: 'collection', name: 'system.js' }))
        .statusCode,
    ).toBe(403)
    expect((await editor('POST', '/databases', { name: 'config', collection: 'x' })).statusCode).toBe(403)
    expect((await viewer('POST', '/databases/admin/collections/system.users/find', {})).statusCode).toBe(403)
    expect(
      (await editor('POST', `/databases/${db}/collections`, { kind: 'collection', name: 'plain' }))
        .statusCode,
    ).toBe(201)
    expect(
      (await editor('POST', `/databases/${db}/collections/plain/duplicate`, { to: 'system.js' })).statusCode,
    ).toBe(403)
    expect(
      (await editor('POST', `/databases/${db}/collections/plain/rename`, { to: 'system.js' })).statusCode,
    ).toBe(403)
    expect((await admin('POST', '/databases/admin/collections/system.users/find', {})).statusCode).toBe(200)
  })
})

describe('important: bulk operations need a fresh, server-issued preview', () => {
  it('rejects forged, expired and outdated previews', async () => {
    const { h, base, coll } = await seeded()
    const request = { filter: { v: { $gte: { $numberInt: '2' } } }, operation: 'delete' }
    const forged = await h.call('POST', `${base}/bulk/execute`, { ...request, filterHash: 'a'.repeat(64) })
    expect(forged.statusCode).toBe(409)
    expect(forged.json().details).toEqual({ reason: 'preview_invalid' })
    const preview = (await h.call('POST', `${base}/bulk/preview`, request)).json()
    expect(preview).toMatchObject({ matched: 2, total: 3, requiresConfirmation: false })
    await coll.insertOne({ _id: 'd', v: 9 } as never)
    const moved = await h.call('POST', `${base}/bulk/execute`, { ...request, filterHash: preview.filterHash })
    expect(moved.statusCode).toBe(409)
    expect(moved.json().message).toMatch(/2.*3/)
    expect(moved.json().details).toEqual({ reason: 'count_changed', from: 2, to: 3 })
    const fresh = (await h.call('POST', `${base}/bulk/preview`, request)).json()
    h.t.clock.now += 11 * 60_000
    const expired = await h.call('POST', `${base}/bulk/execute`, { ...request, filterHash: fresh.filterHash })
    expect(expired.statusCode).toBe(409)
    expect(expired.json().details).toEqual({ reason: 'preview_expired' })
    expect(await coll.countDocuments()).toBe(4)
  })

  it('asks for the collection name whenever the filter matches every document', async () => {
    const { h, base } = await seeded()
    for (const filter of [{ _id: { $exists: true } }, { $expr: true }]) {
      const request = { filter, operation: 'update', update: { $set: { all: true } } }
      const preview = (await h.call('POST', `${base}/bulk/preview`, request)).json()
      expect(preview.requiresConfirmation).toBe(true)
      expect(
        (await h.call('POST', `${base}/bulk/execute`, { ...request, filterHash: preview.filterHash }))
          .statusCode,
      ).toBe(400)
      expect(
        (
          await h.call('POST', `${base}/bulk/execute`, {
            ...request,
            filterHash: preview.filterHash,
            confirm: 'items',
          })
        ).statusCode,
      ).toBe(200)
    }
  })
})

describe('important: edits carry the loaded version and are type-exact', () => {
  it('requires the hash of the loaded document for field updates and replaces', async () => {
    const { h, base, coll } = await seeded()
    expect((await h.call('POST', `${base}/documents/update`, { _id: 'a', set: { v: 5 } })).statusCode).toBe(
      400,
    )
    const loaded = (await h.call('POST', `${base}/documents/get`, { _id: 'a' })).json()
    expect(loaded.hash).toMatch(/^[0-9a-f]{64}$/)
    const ok = await h.call('POST', `${base}/documents/update`, {
      _id: 'a',
      set: { v: 5 },
      hash: loaded.hash,
    })
    expect(ok.json()).toEqual({ modified: 1 })
    const stale = await h.call('POST', `${base}/documents/update`, {
      _id: 'a',
      set: { v: 6 },
      hash: loaded.hash,
    })
    expect(stale.json().code).toBe('DOCUMENT_CHANGED')

    const b = (await h.call('POST', `${base}/documents/get`, { _id: 'b' })).json()
    await coll.updateOne({ _id: 'b' } as never, { $set: { v: new Double(2) } })
    const typeChanged = await h.call('POST', `${base}/documents/replace`, {
      _id: 'b',
      document: { v: 7 },
      hash: b.hash,
    })
    expect(typeChanged.json().code).toBe('DOCUMENT_CHANGED')
    const listed = (await h.call('POST', `${base}/find`, { filter: { _id: 'c' } })).json().documents[0]
    expect(
      (
        await h.call('POST', `${base}/documents/replace`, {
          _id: 'c',
          document: { v: S(new Int32(8)) },
          hash: listed.hash,
        })
      ).json(),
    ).toEqual({
      modified: 1,
    })
  })
})

describe('important: audit shows which documents changed', () => {
  it('records _id for single-document writes and inserted ids', async () => {
    const { h, base } = await seeded()
    const loaded = (await h.call('POST', `${base}/documents/get`, { _id: 'a' })).json()
    await h.call('POST', `${base}/documents/update`, { _id: 'a', set: { v: 5 }, hash: loaded.hash })
    await h.call('POST', `${base}/documents/delete`, { _id: 'b' })
    const inserted = (
      await h.call('POST', `${base}/documents`, {
        documents: [{ _id: S(new ObjectId('65f0a1b2c3d4e5f601234567')) }],
      })
    ).json()
    expect(inserted.insertedIds).toHaveLength(1)
    const audit = h.t.app.ctx.audit
    expect(audit.list({ action: 'documents.update' })[0]?.details).toMatchObject({ _id: 'a' })
    expect(audit.list({ action: 'documents.delete' })[0]?.details).toMatchObject({ _id: 'b' })
    expect(audit.list({ action: 'documents.insert' })[0]?.details).toMatchObject({
      count: 1,
      ids: [{ $oid: '65f0a1b2c3d4e5f601234567' }],
    })
  })
})

describe('minor fixes', () => {
  it('reports a lower bound when an exact count times out', async () => {
    const { h, base } = await seeded()
    const admin = (await h.client()).db('admin')
    await admin.command({ configureFailPoint: 'maxTimeAlwaysTimeOut', mode: { times: 1 } })
    try {
      expect(
        (
          await h.call('POST', `${base}/count`, {
            filter: { v: { $gt: { $numberInt: '0' } } },
            maxTimeMS: 200,
          })
        ).json(),
      ).toEqual({
        count: null,
        exact: false,
        atLeast: 3,
      })
    } finally {
      await admin.command({ configureFailPoint: 'maxTimeAlwaysTimeOut', mode: 'off' })
    }
  })

  it('fails closed on absurdly deep nesting', () => {
    let deep: unknown = { a: 1 }
    for (let i = 0; i < 250; i++) deep = { x: deep }
    expect(findServerJs(deep)).not.toBeNull()
  })

  it('never leaks host names from network errors', async () => {
    const { toAppError } = await import('../src/data/mongo-errors')
    const err = Object.assign(new Error('connection 3 to 10.1.2.3:27017 closed'), {
      name: 'MongoNetworkError',
    })
    const mapped = toAppError(err) as { statusCode: number; message: string }
    expect(mapped.statusCode).toBe(502)
    expect(mapped.message).not.toContain('10.1.2.3')
  })

  it('lists collections for users who may only read specific collections', async () => {
    const rootClient = await MongoClient.connect(
      `mongodb://root:root-pass@127.0.0.1:${secured.port}/?authSource=admin`,
    )
    const db = newDb()
    await rootClient.db(db).collection('visible').insertOne({ a: 1 })
    await rootClient.db(db).collection('hidden').insertOne({ a: 1 })
    await rootClient.db('admin').command({
      createRole: 'onlyVisible',
      privileges: [{ resource: { db, collection: 'visible' }, actions: ['find'] }],
      roles: [],
    })
    await rootClient
      .db('admin')
      .command({ createUser: 'narrow', pwd: 'narrow-pass', roles: [{ role: 'onlyVisible', db: 'admin' }] })
    await rootClient.close()
    const t = await makeApp()
    cleanups.push(() => t.close())
    const conn = t.app.ctx.connections.create(
      {
        name: 'Narrow',
        favorite: false,
        readOnly: false,
        settings: ConnectionSettingsSchema.parse({
          hosts: [{ host: '127.0.0.1', port: secured.port }],
          auth: { mechanism: 'DEFAULT', username: 'narrow', password: 'narrow-pass', authSource: 'admin' },
        }),
      },
      null,
    )
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/connections/${conn.id}/databases/${db}/collections`,
      headers: H,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().map((c: { name: string }) => c.name)).toEqual(['visible'])
  })
})
