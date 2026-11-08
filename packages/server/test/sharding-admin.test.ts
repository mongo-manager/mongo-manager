// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Document, MongoClient } from 'mongodb'
import { ConnectionSettingsSchema, type Role } from '@mongo-manager/shared'
import { H, makeApp, type TestApp } from './helpers'

/**
 * W3.2: sharding management on a mongos. The test binaries hold mongod only (no mongos), so the
 * routes run against a client scripted with recorded mongos answers (as sharding.test.ts). Threat
 * model: a user without databases:admin changing the cluster; values of the shard key leaving
 * MongoDB through the key picker's hints; MongoDB's refusal disguised; a read-only connection
 * changed; system namespaces sharded; an operator smuggled in as a shard key field.
 */
const apps: TestApp[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const t of apps.splice(0)) await t.close()
})

interface Asked {
  db: string
  command?: Document
  coll?: string
  op?: string
  arg?: unknown
  options?: unknown
}

type Answer = Document | Error | ((cmd: Document) => Document)
interface Script {
  hello?: Document
  commands?: Record<string, Answer>
  find?: Record<string, Document[] | Error>
  aggregate?: Record<string, Document[] | Error>
  indexes?: Record<string, Document[]>
  count?: number
  update?: Error
}

function scripted(script: Script) {
  const asked: Asked[] = []
  const pick = (v: Answer | undefined, cmd: Document): Document => {
    if (v instanceof Error) throw v
    if (typeof v === 'function') return v(cmd)
    return v ?? { ok: 1 }
  }
  const client = {
    db: (db: string) => ({
      databaseName: db,
      command: async (cmd: Document) => {
        asked.push({ db, command: cmd })
        const name = Object.keys(cmd)[0]!
        if (name === 'hello') return script.hello ?? { msg: 'isdbgrid' }
        return pick(script.commands?.[name], cmd)
      },
      collection: (coll: string) => ({
        find: (filter: unknown, options?: unknown) => {
          asked.push({ db, coll, op: 'find', arg: filter, options })
          const v = script.find?.[`${db}.${coll}`]
          return {
            toArray: async () => {
              if (v instanceof Error) throw v
              return v ?? []
            },
          }
        },
        aggregate: (pipeline: unknown) => {
          asked.push({ db, coll, op: 'aggregate', arg: pipeline })
          const v = script.aggregate?.[`${db}.${coll}`]
          return {
            toArray: async () => {
              if (v instanceof Error) throw v
              return v ?? []
            },
          }
        },
        listIndexes: () => ({
          toArray: async () => script.indexes?.[`${db}.${coll}`] ?? [{ key: { _id: 1 } }],
        }),
        estimatedDocumentCount: async () => script.count ?? 0,
        updateOne: async (filter: unknown, update: unknown, options: unknown) => {
          asked.push({ db, coll, op: 'updateOne', arg: { filter, update }, options })
          if (script.update) throw script.update
          return { acknowledged: true }
        },
      }),
    }),
  }
  return { client: client as unknown as MongoClient, asked }
}

const refusedErr = () => Object.assign(new Error('not authorized'), { name: 'MongoServerError', code: 13 })

async function setup(script: Script, opts: { readOnly?: boolean } = {}) {
  const t = await makeApp({ auth: true })
  apps.push(t)
  const { ctx } = t.app
  const connectionId = ctx.connections.create(
    {
      name: 'S',
      favorite: false,
      readOnly: opts.readOnly ?? false,
      settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port: 1 }] }),
    },
    null,
  ).id
  const fake = scripted(script)
  vi.spyOn(ctx.manager, 'getClient').mockResolvedValue(fake.client)
  const as = (role: Role) => {
    const user = ctx.users.create({ username: `u-${Math.random()}`, passwordHash: 'x', role })
    const s = ctx.sessions.create(user.id, {})
    return (method: 'GET' | 'POST' | 'PUT', path: string, payload?: unknown) =>
      t.app.inject({
        method,
        url: `/api/connections/${connectionId}/server/sharding${path}`,
        headers: { ...H, 'x-csrf-token': s.session.csrfToken },
        cookies: { mm_sid: s.sessionId },
        ...(payload !== undefined ? { payload: payload as object } : {}),
      })
  }
  const audit = () =>
    ctx.store.db.prepare('SELECT action, outcome, details FROM audit_log ORDER BY id').all() as Array<{
      action: string
      outcome: string
      details: string
    }>
  return { as, asked: fake.asked, audit }
}

const commands = (asked: Asked[]) => asked.filter((a) => a.command).map((a) => a.command!)

describe('shard a collection (W3.2)', () => {
  it('shards with a compound ranged key in the order given, enabling sharding on the database first', async () => {
    const { as, asked, audit } = await setup({
      commands: { enableSharding: { ok: 1 }, shardCollection: { collectionsharded: 'shop.orders', ok: 1 } },
    })
    const res = await as('admin')('POST', '/collections', {
      ns: 'shop.orders',
      key: [
        { field: 'customer.region', kind: 'ranged' },
        { field: 'orderedAt', kind: 'ranged' },
      ],
      unique: false,
      confirm: true,
    })
    expect(res.statusCode).toBe(200)
    const sent = commands(asked).find((c) => 'shardCollection' in c)!
    expect(sent.shardCollection).toBe('shop.orders')
    // The order of a compound key is the key: kept exactly.
    expect([...(sent.key as Map<string, unknown>).entries()]).toEqual([
      ['customer.region', 1],
      ['orderedAt', 1],
    ])
    expect(sent.unique).toBe(false)
    expect(commands(asked).find((c) => 'enableSharding' in c)).toEqual({ enableSharding: 'shop' })
    const row = audit().find((r) => r.action === 'sharding.collection.shard')!
    expect(JSON.parse(row.details)).toMatchObject({
      ns: 'shop.orders',
      key: ['customer.region:1', 'orderedAt:1'],
    })
  })

  it('presplits a hashed key, and refuses presplitting a ranged one', async () => {
    const { as, asked } = await setup({})
    const hashed = await as('admin')('POST', '/collections', {
      ns: 'shop.events',
      key: [{ field: 'deviceId', kind: 'hashed' }],
      numInitialChunks: 64,
      confirm: true,
    })
    expect(hashed.statusCode).toBe(200)
    const sent = commands(asked).find((c) => 'shardCollection' in c)!
    expect([...(sent.key as Map<string, unknown>).entries()]).toEqual([['deviceId', 'hashed']])
    expect(sent.numInitialChunks).toBe(64)
    const ranged = await as('admin')('POST', '/collections', {
      ns: 'shop.events',
      key: [{ field: 'deviceId', kind: 'ranged' }],
      numInitialChunks: 64,
      confirm: true,
    })
    expect(ranged.statusCode).toBe(400)
  })

  it('refuses system namespaces, operators as fields and an unconfirmed request', async () => {
    const { as, asked } = await setup({})
    const admin = as('admin')
    for (const ns of ['config.chunks', 'admin.things', 'local.oplog.rs', 'shop.system.profile']) {
      const res = await admin('POST', '/collections', {
        ns,
        key: [{ field: 'a', kind: 'ranged' }],
        confirm: true,
      })
      expect([res.statusCode, ns]).toEqual([403, ns])
    }
    const operator = await admin('POST', '/collections', {
      ns: 'shop.orders',
      key: [{ field: '$where', kind: 'ranged' }],
      confirm: true,
    })
    expect(operator.statusCode).toBe(400)
    const unconfirmed = await admin('POST', '/collections', {
      ns: 'shop.orders',
      key: [{ field: 'a', kind: 'ranged' }],
    })
    expect(unconfirmed.statusCode).toBe(400)
    expect(commands(asked).some((c) => 'shardCollection' in c)).toBe(false)
  })

  it('says MongoDB refused, and answers not_sharded away from a mongos', async () => {
    const refused = await setup({ commands: { shardCollection: refusedErr() } })
    const res = await refused.as('admin')('POST', '/collections', {
      ns: 'shop.orders',
      key: [{ field: 'a', kind: 'hashed' }],
      confirm: true,
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().details).toMatchObject({ reason: 'mongo_not_permitted', command: 'shardCollection' })
    const plain = await setup({ hello: { isWritablePrimary: true } })
    const notMongos = await plain.as('admin')('POST', '/collections', {
      ns: 'shop.orders',
      key: [{ field: 'a', kind: 'hashed' }],
      confirm: true,
    })
    expect([notMongos.statusCode, notMongos.json().details?.reason]).toEqual([409, 'not_sharded'])
  })
})

describe('shard key hints (W3.2)', () => {
  const facet = {
    total: [{ n: 1000 }],
    f0: [{ _id: null, distinct: 950, top: 3, present: 1000 }],
    f1: [{ _id: null, distinct: 4, top: 700, present: 990 }],
    t0: [{ _id: 'objectId', n: 1000 }],
    t1: [{ _id: 'string', n: 990 }],
    combined: [{ _id: null, distinct: 990, top: 2 }],
  }
  it('answers counts from a sample computed in MongoDB, never the values', async () => {
    const { as, asked } = await setup({
      aggregate: { 'shop.orders': [facet] },
      indexes: { 'shop.orders': [{ key: { _id: 1 } }, { key: { _id: 1, status: 1 } }] },
      count: 123_456,
    })
    const res = await as('admin')('GET', '/key-hints?ns=shop.orders&fields=_id,status')
    expect(res.statusCode).toBe(200)
    const hints = res.json()
    expect(hints).toMatchObject({
      ns: 'shop.orders',
      sampled: 1000,
      documents: 123_456,
      indexed: true,
      combined: { distinct: 990, topShare: 0.002 },
    })
    expect(hints.fields[0]).toMatchObject({ field: '_id', distinct: 950, monotonic: true })
    expect(hints.fields[1]).toMatchObject({ field: 'status', distinct: 4, topShare: 0.7, monotonic: false })
    // The pipeline groups and counts in MongoDB: no stage hands documents or values back.
    const pipeline = asked.find((a) => a.op === 'aggregate')!.arg as Document[]
    expect(pipeline[0]).toEqual({ $sample: { size: 1000 } })
    expect(Object.keys(pipeline.at(-1)!)).toEqual(['$facet'])
    expect(JSON.stringify(res.json())).not.toContain('"values"')
  })

  it('is for connection admins only', async () => {
    const { as } = await setup({ aggregate: { 'shop.orders': [facet] } })
    for (const role of ['editor', 'viewer'] as const)
      expect((await as(role)('GET', '/key-hints?ns=shop.orders&fields=_id')).statusCode).toBe(403)
  })
})

describe('zones and the balancer (W3.2)', () => {
  it('lists zones and their ranges, and adds a shard to a zone and a range to it', async () => {
    const { as, asked, audit } = await setup({
      commands: {
        listShards: {
          shards: [
            { _id: 'rs0', host: 'rs0/a:1', tags: ['EU'] },
            { _id: 'rs1', host: 'rs1/b:1' },
          ],
        },
      },
      find: {
        'config.tags': [{ ns: 'shop.orders', min: { region: 'EU' }, max: { region: 'EV' }, tag: 'EU' }],
      },
    })
    const admin = as('admin')
    const zones = await admin('GET', '/zones')
    expect(zones.statusCode).toBe(200)
    expect(zones.json()).toMatchObject({
      zones: ['EU'],
      shards: [
        { id: 'rs0', zones: ['EU'] },
        { id: 'rs1', zones: [] },
      ],
      ranges: [{ ns: 'shop.orders', zone: 'EU', min: '{"region":"EU"}', max: '{"region":"EV"}' }],
    })
    const add = await admin('POST', '/zones/shards', { shard: 'rs1', zone: 'US', action: 'add' })
    expect(add.statusCode).toBe(200)
    expect(commands(asked)).toContainEqual({ addShardToZone: 'rs1', zone: 'US' })
    const remove = await admin('POST', '/zones/shards', { shard: 'rs0', zone: 'EU', action: 'remove' })
    expect(remove.statusCode).toBe(200)
    expect(commands(asked)).toContainEqual({ removeShardFromZone: 'rs0', zone: 'EU' })
    const range = await admin('POST', '/zones/ranges', {
      ns: 'shop.orders',
      min: '{"region":"US"}',
      max: '{"region":{"$maxKey":1}}',
      zone: 'US',
    })
    expect(range.statusCode).toBe(200)
    const sent = commands(asked).find((c) => 'updateZoneKeyRange' in c)!
    expect(sent.updateZoneKeyRange).toBe('shop.orders')
    expect(sent.zone).toBe('US')
    expect((sent.max as Document).region._bsontype).toBe('MaxKey')
    const clear = await admin('POST', '/zones/ranges', {
      ns: 'shop.orders',
      min: '{"region":"US"}',
      max: '{"region":{"$maxKey":1}}',
      zone: null,
    })
    expect(clear.statusCode).toBe(200)
    expect(
      commands(asked)
        .filter((c) => 'updateZoneKeyRange' in c)
        .at(-1)!.zone,
    ).toBeNull()
    expect(audit().map((r) => r.action)).toEqual(
      expect.arrayContaining(['sharding.zone.shard', 'sharding.zone.range']),
    )
    // A bound that is not an object of fields, or carries an operator, never reaches MongoDB.
    for (const min of ['[1]', '"x"', '{"$where":"1"}', '{"a":{"$gt":1}}']) {
      const bad = await admin('POST', '/zones/ranges', { ns: 'shop.orders', min, max: '{"a":2}', zone: 'US' })
      expect([bad.statusCode, min]).toEqual([400, min])
    }
  })

  it('starts and stops the balancer and sets or clears its window', async () => {
    const { as, asked, audit } = await setup({})
    const admin = as('admin')
    expect((await admin('POST', '/balancer', { action: 'stop' })).statusCode).toBe(200)
    expect(commands(asked)).toContainEqual(expect.objectContaining({ balancerStop: 1 }))
    expect((await admin('POST', '/balancer', { action: 'start' })).statusCode).toBe(200)
    expect(commands(asked)).toContainEqual(expect.objectContaining({ balancerStart: 1 }))
    const set = await admin('PUT', '/balancer/window', { window: { start: '23:00', stop: '06:00' } })
    expect(set.statusCode).toBe(200)
    const update = asked.find((a) => a.op === 'updateOne')!
    expect(update).toMatchObject({
      db: 'config',
      coll: 'settings',
      arg: {
        filter: { _id: 'balancer' },
        update: { $set: { activeWindow: { start: '23:00', stop: '06:00' } } },
      },
      options: { upsert: true },
    })
    await admin('PUT', '/balancer/window', { window: null })
    expect(asked.filter((a) => a.op === 'updateOne').at(-1)!.arg).toMatchObject({
      update: { $unset: { activeWindow: '' } },
    })
    const bad = await admin('PUT', '/balancer/window', { window: { start: '25:00', stop: '06:00' } })
    expect(bad.statusCode).toBe(400)
    expect(
      audit()
        .filter((r) => r.action.startsWith('sharding.balancer'))
        .map((r) => r.outcome),
    ).toEqual(['success', 'success', 'success', 'success', 'failure'])
  })

  it('refuses every change to editors, viewers, and on a read-only connection', async () => {
    const team = await setup({})
    for (const role of ['editor', 'viewer'] as const) {
      const user = team.as(role)
      expect((await user('POST', '/balancer', { action: 'stop' })).statusCode).toBe(403)
      expect((await user('GET', '/zones')).statusCode).toBe(403)
    }
    expect(commands(team.asked).some((c) => 'balancerStop' in c)).toBe(false)
    const ro = await setup({}, { readOnly: true })
    const res = await ro.as('admin')('POST', '/balancer', { action: 'stop' })
    expect([res.statusCode, res.json().code]).toEqual([403, 'READ_ONLY'])
    const window = await ro.as('admin')('PUT', '/balancer/window', { window: null })
    expect(window.json().code).toBe('READ_ONLY')
    expect(ro.asked.some((a) => a.op === 'updateOne')).toBe(false)
  })
})
