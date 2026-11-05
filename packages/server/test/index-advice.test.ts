// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient, type Document } from 'mongodb'
import { ConnectionSettingsSchema, type Role } from '@mongo-manager/shared'
import { adviceFrom, collectionsToRead, sizesFrom, usageFrom } from '../src/monitor/index-advice'
import type { RawSlow } from '../src/monitor/slow-queries'
import { startMongo, type TestMongo } from './support/mongo'
import { H, makeApp, type TestApp } from './helpers'
import { slow } from './support/slowness'

/**
 * Phase 3b spec §6a: index suggestions from slow queries (ESR, not already served by an index) and
 * notes on indexes that may be unneeded. Field names only — never a value.
 */
const entry = (ns: string, command: Document, over: Partial<RawSlow> = {}): RawSlow => ({
  source: 'profile',
  ts: '2026-09-30T10:00:00.000Z',
  ns,
  db: ns.split('.')[0]!,
  op: 'query',
  durationMs: 100,
  planSummary: 'COLLSCAN',
  docsExamined: 5000,
  nreturned: 1,
  command,
  ...over,
})
const none = new Map<string, Array<{ name: string; key: Document; unique?: boolean }>>()

describe('adviceFrom (phase 3b §6a)', () => {
  it('suggests an ESR index for scans, grouped and ranked', () => {
    const find = { find: 'orders', filter: { status: 'x', total: { $gt: 5 } }, sort: { created: -1 } }
    const advice = adviceFrom(
      [
        entry('shop.orders', find),
        entry('shop.orders', find, { durationMs: 300 }),
        entry('shop.users', { find: 'users', filter: { email: 'a' } }, { durationMs: 10 }),
      ],
      none,
      new Map(),
    )
    expect(advice.suggestions[0]).toMatchObject({
      ns: 'shop.orders',
      key: [
        ['status', 1],
        ['created', -1],
        ['total', 1],
      ],
      count: 2,
      totalMs: 400,
      avgMs: 200,
      reason: { equality: ['status'], sort: ['created'], range: ['total'] },
    })
    expect(advice.suggestions[1]).toMatchObject({ ns: 'shop.users', key: [['email', 1]] })
  })

  it('reads the query of counts, aggregates, updates and deletes; skips fast and index-served ones', () => {
    const advice = adviceFrom(
      [
        entry('a.c', { count: 'c', query: { k: 1 } }),
        entry('a.d', { aggregate: 'd', pipeline: [{ $match: { k: { $in: [1, 2] } } }, { $sort: { s: 1 } }] }),
        entry('a.e', { q: { k: 1 }, u: { $set: { n: 1 } } }, { op: 'update' }),
        entry('a.f', { q: { k: 1 }, limit: 1 }, { op: 'remove' }),
        entry(
          'a.g',
          { find: 'g', filter: { k: 1 } },
          { planSummary: 'IXSCAN { k: 1 }', docsExamined: 1, nreturned: 1 },
        ),
      ],
      none,
      new Map(),
    )
    expect(advice.suggestions.map((s) => s.ns).sort()).toEqual(['a.c', 'a.d', 'a.e', 'a.f'])
    expect(advice.suggestions.find((s) => s.ns === 'a.d')!.key).toEqual([
      ['k', 1],
      ['s', 1],
    ])
  })

  it('drops a suggestion an existing index serves (review focus 5)', () => {
    const indexes = new Map([
      ['shop.orders', [{ name: 'status_1_created_1', key: { status: 1, created: 1 } }]],
    ])
    const advice = adviceFrom(
      [entry('shop.orders', { find: 'orders', filter: { status: 'x' }, sort: { created: -1 } })],
      indexes,
      new Map(),
    )
    expect(advice.suggestions).toEqual([])
  })

  it('notes unused and prefix indexes, never _id or unique ones (review focus 5)', () => {
    const indexes = new Map([
      [
        'shop.orders',
        [
          { name: '_id_', key: { _id: 1 } },
          { name: 'a_1', key: { a: 1 } },
          { name: 'a_1_b_1', key: { a: 1, b: 1 } },
          { name: 'u_1', key: { u: 1 }, unique: true },
          { name: 'c_1', key: { c: 1 } },
        ],
      ],
    ])
    const usage = new Map([
      [
        'shop.orders',
        new Map([
          ['_id_', 0],
          ['a_1', 5],
          ['a_1_b_1', 9],
          ['u_1', 0],
          ['c_1', 0],
        ]),
      ],
    ])
    const advice = adviceFrom([], indexes, usage)
    expect(advice.unneeded).toEqual([
      {
        ns: 'shop.orders',
        name: 'a_1',
        key: { a: 1 },
        reason: 'prefix',
        of: 'a_1_b_1',
        ops: 5,
        sizeBytes: null,
      },
      { ns: 'shop.orders', name: 'c_1', key: { c: 1 }, reason: 'unused', ops: 0, sizeBytes: null },
    ])
  })

  it('suggests nothing for system collections or our own operations', () => {
    const advice = adviceFrom(
      [
        entry('adv.system.profile', { find: 'system.profile', filter: {}, sort: { ts: -1 } }),
        entry('adv.orders', { find: 'orders', filter: { a: 1 }, comment: 'mm-monitor' }),
      ],
      none,
      new Map(),
    )
    expect(advice.suggestions).toEqual([])
  })

  it("keeps the user's queries run through the app (their comment is mm:<request>)", () => {
    const advice = adviceFrom(
      [entry('adv.orders', { find: 'orders', filter: { a: 1 }, comment: 'mm:req-42' })],
      none,
      new Map(),
    )
    expect(advice.suggestions).toHaveLength(1)
  })

  it('suggests only for namespaces whose indexes were read (final review I1)', () => {
    const scan = entry('shop.orders', { find: 'orders', filter: { status: 'x' } })
    expect(adviceFrom([scan], none, new Map(), new Set()).suggestions).toEqual([])
    expect(adviceFrom([scan], none, new Map(), new Set(['shop.orders'])).suggestions).toHaveLength(1)
  })

  it('never calls a TTL, hidden, system or partially covered index unneeded (final review I2)', () => {
    const indexes = new Map([
      [
        'shop.orders',
        [
          { name: 'createdAt_1', key: { createdAt: 1 }, expireAfterSeconds: 3600 },
          { name: 'createdAt_1_s_1', key: { createdAt: 1, s: 1 } },
          { name: 'a_1', key: { a: 1 } },
          { name: 'a_1_b_1', key: { a: 1, b: 1 }, partialFilterExpression: { b: { $exists: true } } },
          { name: 'h_1', key: { h: 1 }, hidden: true },
          { name: 'z_1', key: { z: 1 }, collation: { locale: 'tr' } },
          { name: 'z_1_y_1', key: { z: 1, y: 1 } },
        ],
      ],
      ['config.system.sessions', [{ name: 'lsidTTL', key: { lastUse: 1 } }]],
    ])
    const usage = new Map([
      [
        'shop.orders',
        new Map([
          ['createdAt_1', 0],
          ['a_1', 3],
          ['h_1', 0],
          ['z_1', 4],
        ]),
      ],
      ['config.system.sessions', new Map([['lsidTTL', 0]])],
    ])
    expect(adviceFrom([], indexes, usage).unneeded).toEqual([])
  })

  // Index advice gaps (2026-10-27, wave 4 #6): the same key served whole by another; special kinds of
  // index never serve a plain one; each note says the index's size and use.
  it('notes an index another of the same key serves whole, with its size and use', () => {
    const indexes = new Map([
      [
        'shop.people',
        [
          { name: 'email_1', key: { email: 1 } },
          {
            name: 'email_1_partial',
            key: { email: 1 },
            partialFilterExpression: { email: { $exists: true } },
          },
          { name: 'phone_1_sparse', key: { phone: 1 }, sparse: true },
          { name: 'phone_1', key: { phone: 1 } },
        ],
      ],
    ])
    const usage = new Map([
      [
        'shop.people',
        new Map([
          ['email_1', 9],
          ['email_1_partial', 2],
          ['phone_1', 1],
        ]),
      ],
    ])
    const sizes = new Map([
      [
        'shop.people',
        new Map([
          ['email_1_partial', 4096],
          ['phone_1_sparse', 8192],
        ]),
      ],
    ])
    expect(adviceFrom([], indexes, usage, undefined, sizes).unneeded).toEqual([
      {
        ns: 'shop.people',
        name: 'email_1_partial',
        key: { email: 1 },
        reason: 'duplicate',
        of: 'email_1',
        ops: 2,
        sizeBytes: 4096,
      },
      {
        ns: 'shop.people',
        name: 'phone_1_sparse',
        key: { phone: 1 },
        reason: 'duplicate',
        of: 'phone_1',
        ops: null,
        sizeBytes: 8192,
      },
    ])
    // Sizes hidden (a restricted user where rules are): unknown, never zero.
    expect(
      adviceFrom([], indexes, usage, undefined, new Map([['shop.people', null]])).unneeded[0]!.sizeBytes,
    ).toBeNull()
  })

  it('never calls an index a prefix of a text, geospatial or wildcard one; a hashed one serves it', () => {
    const indexes = new Map([
      [
        'shop.places',
        [
          { name: 'a_1', key: { a: 1 } },
          { name: 'a_1_text', key: { a: 1, _fts: 'text', _ftsx: 1 } },
          { name: 'b_1', key: { b: 1 } },
          { name: 'b_1_loc', key: { b: 1, loc: '2dsphere' } },
          { name: 'c_1', key: { c: 1 } },
          { name: 'c_1_wild', key: { c: 1, 'd.$**': 1 } },
          { name: 'e_1', key: { e: 1 } },
          { name: 'e_1_h', key: { e: 1, h: 'hashed' } },
        ],
      ],
    ])
    expect(adviceFrom([], indexes, new Map()).unneeded.map((u) => [u.name, u.reason, u.of])).toEqual([
      ['e_1', 'prefix', 'e_1_h'],
    ])
  })

  it('adds index sizes across shards', () => {
    const sizes = sizesFrom([
      { shard: 's0', storageStats: { indexSizes: { _id_: 100, a_1: 40 } } },
      { shard: 's1', storageStats: { indexSizes: { _id_: 50, a_1: 2 } } },
      { shard: 's2' },
    ])
    expect(Object.fromEntries(sizes)).toEqual({ _id_: 150, a_1: 42 })
  })

  it('adds index use across shards before calling an index unused (final review I3)', () => {
    const usage = usageFrom([
      { name: 'a_1', shard: 's0', accesses: { ops: 0 } },
      { name: 'a_1', shard: 's1', accesses: { ops: 7 } },
      { name: 'b_1', shard: 's0', accesses: { ops: 0 } },
      { name: 'b_1', shard: 's1', accesses: { ops: 0 } },
    ])
    expect(usage.get('a_1')).toBe(7)
    expect(usage.get('b_1')).toBe(0)
  })

  it('holds no values (review focus 2)', () => {
    const advice = adviceFrom(
      [
        entry('crm.users', {
          find: 'users',
          filter: { email: 'S3NT1N3L', age: { $gt: 987654 } },
          sort: { n: 1 },
        }),
      ],
      none,
      new Map(),
    )
    const json = JSON.stringify(advice)
    expect(json).not.toContain('S3NT1N3L')
    expect(json).not.toContain('987654')
  })

  // Final review I6: the collections slow queries touched first, then the others by name.
  it('reads the slow queries’ collections first, then the rest by name, up to the limit', () => {
    const names = ['a', 'b', 'c', 'd', 'zz']
    expect(collectionsToRead(names, ['zz', 'gone', 'b'], 3)).toEqual(['zz', 'b', 'a'])
    expect(collectionsToRead(names, [], 2)).toEqual(['a', 'b'])
  })

  it('cuts the unneeded at their limit and says how many more', () => {
    const indexes = new Map(
      Array.from({ length: 205 }, (_, i) => [
        `d.c${i}`,
        [
          { name: 'k_1', key: { k: 1 } },
          { name: 'k_1_m_1', key: { k: 1, m: 1 } },
        ],
      ]),
    )
    const advice = adviceFrom([], indexes, new Map())
    expect(advice.unneeded).toHaveLength(200)
    expect(advice.moreUnneeded).toBe(5)
  })

  it('caps suggestions at 20 and skips over-long keys', () => {
    const many = Array.from({ length: 30 }, (_, i) => entry(`d.c${i}`, { find: `c${i}`, filter: { k: 1 } }))
    const wide = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, 1]))
    const advice = adviceFrom([...many, entry('d.wide', { find: 'wide', filter: wide })], none, new Map())
    expect(advice.suggestions).toHaveLength(20)
    expect(advice.suggestions.some((s) => s.ns === 'd.wide')).toBe(false)
  })
})

let mongo: TestMongo
let client: MongoClient
beforeAll(async () => {
  mongo = await startMongo()
  client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
  const orders = client.db('adv').collection('orders')
  await orders.insertMany(
    Array.from({ length: 300 }, (_, i) => ({ status: i % 3 ? 'open' : 'x', created: i, email: `u${i}@x` })),
  )
  await client.db('adv').command({ profile: 2, slowms: 0 })
  await orders.find({ status: 'x' }).sort({ created: -1 }).toArray()
}, slow(120_000))
afterAll(async () => {
  await client?.db('adv').command({ profile: 0, slowms: 100 })
  await client?.close()
  await mongo?.stop()
})
const apps: TestApp[] = []
afterEach(async () => {
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
  ctx.personalFields.set(connectionId, [{ db: 'adv', coll: 'orders', field: 'status' }])
  const as = (role: Role, masked = false) => {
    const user = ctx.users.create({ username: `u-${Math.random()}`, passwordHash: 'x', role })
    ctx.grants.set(connectionId, user.id, role)
    if (masked) ctx.grants.setMasked(connectionId, user.id, true)
    const s = ctx.sessions.create(user.id, {})
    return (path: string) =>
      t.app.inject({
        method: 'GET',
        url: `/api/connections/${connectionId}/server/${path}`,
        headers: { ...H, 'x-csrf-token': s.session.csrfToken },
        cookies: { mm_sid: s.sessionId },
      })
  }
  return { as }
}

describe('index advice route (phase 3b §6a)', () => {
  it('suggests the index a slow find needs, the same for a restricted user, and forgets it once built', async () => {
    const { as } = await setup()
    const advice = (await as('editor')('index-advice?db=adv')).json()
    const suggestion = advice.suggestions.find((s: { ns: string }) => s.ns === 'adv.orders')
    expect(suggestion.key).toEqual([
      ['status', 1],
      ['created', -1],
    ])
    const restricted = await as('editor', true)('index-advice?db=adv')
    expect(restricted.body).not.toContain('"x"')
    expect(restricted.json().suggestions).toEqual(advice.suggestions)
    await client.db('adv').collection('orders').createIndex({ status: 1, created: -1 })
    const after = (await as('editor')('index-advice?db=adv')).json()
    expect(after.suggestions.some((s: { ns: string }) => s.ns === 'adv.orders')).toBe(false)
    await client.db('adv').collection('orders').dropIndex('status_1_created_-1')
  })

  // Index advice gaps (2026-10-27): every collection's redundant indexes, not only those of slow
  // queries; with their size, hidden from a restricted user where rules are.
  it('notes redundant indexes on every collection, sized, the size hidden where rules are', async () => {
    const { as } = await setup()
    const extra = client.db('adv').collection('quiet')
    await extra.insertOne({ k: 1, m: 2 })
    await extra.createIndex({ k: 1 })
    await extra.createIndex({ k: 1, m: 1 })
    const orders = client.db('adv').collection('orders')
    await orders.createIndex({ x: 1 })
    await orders.createIndex({ x: 1, y: 1 })
    try {
      const note = (
        advice: { unneeded: Array<{ ns: string; name: string; reason: string; sizeBytes: number | null }> },
        ns: string,
      ) => advice.unneeded.find((u) => u.ns === ns && u.reason === 'prefix')
      const editor = (await as('editor')('index-advice?db=adv')).json()
      expect(note(editor, 'adv.quiet')).toMatchObject({ name: 'k_1', sizeBytes: expect.any(Number) })
      expect(note(editor, 'adv.orders')).toMatchObject({ name: 'x_1', sizeBytes: expect.any(Number) })
      const restricted = (await as('editor', true)('index-advice?db=adv')).json()
      expect(note(restricted, 'adv.quiet')!.sizeBytes).toEqual(expect.any(Number))
      expect(note(restricted, 'adv.orders')!.sizeBytes).toBeNull()
    } finally {
      await extra.drop()
      await orders.dropIndex('x_1')
      await orders.dropIndex('x_1_y_1')
    }
  })

  // Final review I1: a database or a collection closed to the caller is never read for advice.
  it('never reads a drill’s scratch database, local for a non-admin, nor key material', async () => {
    const { as } = await setup()
    expect((await as('admin')('index-advice?db=mm_drill_0a1b')).statusCode).toBe(403)
    expect((await as('editor')('index-advice?db=mm_drill_0a1b')).statusCode).toBe(403)
    expect((await as('editor')('index-advice?db=local')).statusCode).toBe(403)
    expect((await as('admin')('index-advice?db=local')).statusCode).toBe(200)
    const meta = client.db('adv').collection('enxcol_.orders.esc')
    await meta.insertOne({ k: 1, m: 1 })
    await meta.createIndex({ k: 1 })
    await meta.createIndex({ k: 1, m: 1 })
    try {
      const listed = (who: Role) => async () =>
        ((await as(who)('index-advice?db=adv')).json() as { unneeded: Array<{ ns: string }> }).unneeded.some(
          (u) => u.ns === 'adv.enxcol_.orders.esc',
        )
      expect(await listed('editor')()).toBe(false)
      expect(await listed('admin')()).toBe(true)
    } finally {
      await meta.drop()
    }
  })

  // Final review I6: time series too.
  it('notes a time series collection’s redundant indexes', async () => {
    const { as } = await setup()
    await client.db('adv').createCollection('metrics', { timeseries: { timeField: 't', metaField: 'tag' } })
    const metrics = client.db('adv').collection('metrics')
    await metrics.insertOne({ t: new Date(), tag: 'a', v: 1 })
    await metrics.createIndex({ tag: 1 })
    await metrics.createIndex({ tag: 1, t: 1 })
    try {
      const advice = (await as('editor')('index-advice?db=adv')).json() as {
        unneeded: Array<{ ns: string; name: string }>
      }
      expect(advice.unneeded.some((u) => u.ns === 'adv.metrics' && u.name === 'tag_1')).toBe(true)
    } finally {
      await metrics.drop()
    }
  })

  // Final review Minor 17: a size hidden is told apart from one not known.
  it('says which sizes are hidden', async () => {
    const { as } = await setup()
    const orders = client.db('adv').collection('orders')
    await orders.createIndex({ x: 1 })
    await orders.createIndex({ x: 1, y: 1 })
    try {
      const pick = (a: { unneeded: Array<{ ns: string; name: string; sizeHidden?: true }> }) =>
        a.unneeded.find((u) => u.ns === 'adv.orders' && u.name === 'x_1')!
      expect(pick((await as('editor', true)('index-advice?db=adv')).json()).sizeHidden).toBe(true)
      expect(pick((await as('editor')('index-advice?db=adv')).json()).sizeHidden).toBeUndefined()
    } finally {
      await orders.dropIndex('x_1')
      await orders.dropIndex('x_1_y_1')
    }
  })

  it('needs a database and server:monitor', async () => {
    const { as } = await setup()
    expect((await as('editor')('index-advice')).statusCode).toBe(400)
    expect((await as('viewer')('index-advice?db=adv')).statusCode).toBe(403)
  })
})
