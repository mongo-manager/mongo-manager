// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { request as httpRequest } from 'node:http'
import { Collection, Db, MongoClient, type Document } from 'mongodb'
import { ConnectionSettingsSchema, type Role } from '@mongo-manager/shared'
import { MonitorHub } from '../src/monitor/hub'
import { sampleFrom, type RawStatus } from '../src/monitor/sampler'
import { isOwnOperation } from '../src/routes/data/server'
import { startMongo, type TestMongo } from './support/mongo'
import { H, makeApp, type TestApp } from './helpers'
import { UNREPORTED } from './support/samples'

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
const apps: TestApp[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const t of apps.splice(0)) await t.close()
})

async function setup() {
  const t = await makeApp({ auth: true })
  apps.push(t)
  const { ctx } = t.app
  const connectionId = ctx.connections.create(
    {
      name: 'M',
      favorite: false,
      readOnly: false,
      settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port: mongo.port }] }),
    },
    null,
  ).id
  const user = (role: Role) => {
    const record = ctx.users.create({ username: `u-${role}-${Math.random()}`, passwordHash: 'x', role })
    return ctx.sessions.create(record.id, {})
  }
  const as = (role: Role) => {
    const { sessionId, session } = user(role)
    return (method: 'GET' | 'POST', path: string, payload?: object) =>
      t.app.inject({
        method,
        url: `/api/connections/${connectionId}/${path}`,
        headers: { ...H, 'x-csrf-token': session.csrfToken },
        cookies: { mm_sid: sessionId },
        ...(payload ? { payload } : {}),
      })
  }
  return { t, ctx, connectionId, user, as }
}

const raw = (over: Partial<RawStatus> = {}): RawStatus => ({
  at: 0,
  uptime: 100_000,
  process: 'db1:10',
  ops: { insert: 0, query: 0, update: 0, delete: 0, getmore: 0, command: 0 },
  bytesIn: 0,
  bytesOut: 0,
  connections: { current: 1, available: 9 },
  memory: { residentMb: 1, virtualMb: 1 },
  cache: null,
  queues: { readers: 0, writers: 0 },
  version: null,
  ...UNREPORTED,
  ...over,
})

describe('final review 1i: schema analysis stops with its request (Important 2)', () => {
  it('stops pulling documents when the client goes away, and closes the cursor', async () => {
    const { t, connectionId, user } = await setup()
    let pulled = 0
    let closed = false
    vi.spyOn(Collection.prototype, 'aggregate').mockImplementation((() => {
      async function* slow() {
        try {
          for (let i = 0; i < 5_000; i++) {
            await new Promise((r) => setTimeout(r, 2))
            pulled++
            yield { i }
          }
        } finally {
          closed = true
        }
      }
      return slow()
    }) as never)
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' })
    const { sessionId, session } = user('editor')
    const url = new URL(`/api/connections/${connectionId}/databases/d/collections/c/schema`, address)
    const req = httpRequest(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: H.host,
        origin: H.origin,
        'x-csrf-token': session.csrfToken,
        cookie: `mm_sid=${sessionId}`,
      },
    })
    req.on('error', () => undefined)
    req.end(JSON.stringify({ sampleSize: 10_000 }))
    // Leave once the analysis is under way, however long a loaded machine takes to get there.
    for (let i = 0; i < 500 && pulled === 0; i++) await new Promise((r) => setTimeout(r, 10))
    req.destroy()
    await new Promise((r) => setTimeout(r, 300))
    const seen = pulled
    await new Promise((r) => setTimeout(r, 300))
    expect(closed).toBe(true)
    expect(pulled).toBe(seen)
    expect(pulled).toBeLessThan(5_000)
  })
})

describe('final review 1i: server routes', () => {
  it('maps a failed top command like every other MongoDB error (Important 5)', async () => {
    const { as } = await setup()
    const original = Db.prototype.command
    vi.spyOn(Db.prototype, 'command').mockImplementation(function (this: Db, cmd: Document, ...rest) {
      if ('top' in cmd)
        return Promise.reject(Object.assign(new Error('connection reset'), { name: 'MongoNetworkError' }))
      return original.call(this, cmd, ...(rest as []))
    } as typeof original)
    const res = await as('editor')('GET', 'server/top')
    expect([res.statusCode, res.json().code]).toEqual([502, 'MONGO_ERROR'])
  })

  it('says when MongoDB refuses serverStatus to the polling route (Minor 5)', async () => {
    const { as } = await setup()
    const original = Db.prototype.command
    vi.spyOn(Db.prototype, 'command').mockImplementation(function (this: Db, cmd: Document, ...rest) {
      if ('serverStatus' in cmd)
        return Promise.reject(Object.assign(new Error('not authorized'), { code: 13 }))
      return original.call(this, cmd, ...(rest as []))
    } as typeof original)
    const res = await as('editor')('GET', 'server/status')
    expect([res.statusCode, res.json().details]).toEqual([403, { reason: 'mongo_not_permitted' }])
  })

  // User report 2026-10-10: a find on a mistyped name (orderss) put a collection that never existed in
  // the busiest list — MongoDB's top counts every namespace asked about.
  it('lists in top only collections that exist, not names that were only queried', async () => {
    const { as } = await setup()
    await client.db('topreal').dropDatabase()
    await client.db('topreal').collection('kept').insertOne({ a: 1 })
    await client.db('topreal').collection('kept').find({}).toArray()
    await client.db('topreal').collection('ghostss').find({}).toArray()
    const res = await as('editor')('GET', 'server/top')
    const names = res.json().collections.map((c: { ns: string }) => c.ns)
    expect(names).toContain('topreal.kept')
    expect(names).not.toContain('topreal.ghostss')
  })

  it('leaves system collections out of top (Minor 8)', async () => {
    const { as } = await setup()
    await client.db('shop').collection('orders').insertOne({ seeded: true })
    const original = Db.prototype.command
    const time = (n: number) => ({ time: n, count: 1 })
    vi.spyOn(Db.prototype, 'command').mockImplementation(function (this: Db, cmd: Document, ...rest) {
      if ('top' in cmd)
        return Promise.resolve({
          totals: {
            note: 'all times in microseconds',
            'shop.orders': { total: time(5000), readLock: time(4000), writeLock: time(1000) },
            'shop.system.profile': { total: time(9000), readLock: time(0), writeLock: time(0) },
            'shop.system.buckets.m': { total: time(9000), readLock: time(0), writeLock: time(0) },
          },
        })
      return original.call(this, cmd, ...(rest as []))
    } as typeof original)
    const res = await as('editor')('GET', 'server/top')
    expect(res.json().collections.map((c: { ns: string }) => c.ns)).toEqual(['shop.orders'])
  })

  it('asks MongoDB for the slowest operations only, sorted and limited, without client details (Minor 6)', async () => {
    const { as } = await setup()
    const spy = vi.spyOn(Db.prototype, 'aggregate')
    await as('editor')('GET', 'server/operations')
    const [pipeline, options] = spy.mock.calls.find(([p]) => JSON.stringify(p).includes('$currentOp'))!
    const stages = pipeline as Document[]
    expect(stages).toContainEqual({ $sort: { microsecs_running: -1 } })
    expect(stages).toContainEqual({ $limit: 51 })
    const project = stages.find((s) => s.$project)!.$project as Record<string, unknown>
    expect(project).not.toHaveProperty('client')
    expect(options).toMatchObject({ comment: 'mm-monitor:ops' })
  })

  it('knows its own operations by any comment a getMore carries (Minor 7)', () => {
    expect(isOwnOperation({ command: { comment: 'mm-job:1' } })).toBe(true)
    expect(
      isOwnOperation({ command: { getMore: 1 }, cursor: { originatingCommand: { comment: 'mm:req-1' } } }),
    ).toBe(true)
    expect(isOwnOperation({ command: { getMore: 1 }, originatingCommand: { comment: 'mm-monitor' } })).toBe(
      true,
    )
    expect(isOwnOperation({ command: { find: 'x', comment: 'user' } })).toBe(false)
    expect(isOwnOperation({ command: { find: 'x' } })).toBe(false)
  })
})

describe('final review 1i: samples and the sampler', () => {
  it('starts again when the server behind the connection changes, and marks rate-less samples (Minors 3, 4)', () => {
    const a = raw({ at: 0, ops: { insert: 10, query: 0, update: 0, delete: 0, getmore: 0, command: 0 } })
    const b = raw({
      at: 2_000,
      uptime: 900_000,
      process: 'db2:77',
      ops: { insert: 99_999, query: 0, update: 0, delete: 0, getmore: 0, command: 0 },
    })
    expect(sampleFrom(a, b)).toMatchObject({ restarted: true, baseline: true, ops: { insert: 0 } })
    expect(sampleFrom(null, a).baseline).toBe(true)
    expect(sampleFrom(a, raw({ at: 2_000, uptime: 102_000 })).baseline).toBe(false)
  })

  it('backs off after MongoDB refuses serverStatus, instead of asking every 2 s (Minor 1)', async () => {
    let calls = 0
    const refusing = {
      db: () => ({
        command: async () => (calls++, Promise.reject(Object.assign(new Error('no'), { code: 13 }))),
      }),
    } as unknown as MongoClient
    const hub = new MonitorHub({ client: async () => refusing, hold: () => () => undefined, intervalMs: 20 })
    const off = hub.subscribe('c1', () => undefined)
    await new Promise((r) => setTimeout(r, 200))
    off()
    hub.close()
    expect(calls).toBe(1)
  })

  it('does not ask again at once when a watch is dropped and taken up again (Minor 2)', async () => {
    let calls = 0
    const counting = {
      db: () => ({ command: async () => (calls++, { uptimeMillis: 1, connections: { current: 1 } }) }),
    } as unknown as MongoClient
    const hub = new MonitorHub({
      client: async () => counting,
      hold: () => () => undefined,
      intervalMs: 1_000,
    })
    for (let i = 0; i < 10; i++) hub.subscribe('c1', () => undefined)()
    await new Promise((r) => setTimeout(r, 50))
    hub.close()
    expect(calls).toBe(1)
  })

  it('forgets status baselines that are too old to use (Minor 19)', async () => {
    let now = 0
    const status = { db: () => ({ command: async () => ({ uptimeMillis: 1 }) }) } as unknown as MongoClient
    const hub = new MonitorHub({ client: async () => status, hold: () => () => undefined, now: () => now })
    await hub.status('c1')
    now = 31_000
    await hub.status('c2')
    expect(hub.statusBaselines()).toBe(1)
    hub.close()
  })
})
