import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MongoClient } from 'mongodb'
import { ConnectionSettingsSchema, type Role } from '@mongo-manager/shared'
import { H, makeApp, type TestApp } from './helpers'

/**
 * Phase 3b spec §5: the read-only sharding overview. The test binaries hold mongod only (no mongos),
 * so the route runs against a client scripted with recorded mongos answers (ledgered ruling).
 */
const apps: TestApp[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const t of apps.splice(0)) await t.close()
})

const NOW = Date.UTC(2026, 0, 1)
type Script = {
  hello?: object
  listShards?: object | Error
  balancerStatus?: object | Error
  find?: Record<string, object[] | Error>
  aggregate?: Record<string, object[] | Error>
}

/** A MongoClient answering from a script; it records the filters it was asked. */
function scripted(script: Script) {
  const asked: Array<{ ns: string; filter: unknown; options?: unknown }> = []
  const answer = <T>(v: T | Error | undefined, fallback: T): T => {
    if (v instanceof Error) throw v
    return v ?? fallback
  }
  const client = {
    db: (db: string) => ({
      command: async (cmd: Record<string, unknown>) => {
        const name = Object.keys(cmd)[0]!
        if (name === 'hello') return script.hello ?? { msg: 'isdbgrid' }
        return answer(script[name as 'listShards' | 'balancerStatus'] as object | Error | undefined, {
          ok: 1,
        })
      },
      collection: (coll: string) => ({
        find: (filter: unknown, options?: unknown) => {
          asked.push({ ns: `${db}.${coll}`, filter, options })
          return { toArray: async () => answer(script.find?.[`${db}.${coll}`], []) }
        },
        aggregate: (pipeline: unknown) => {
          asked.push({ ns: `${db}.${coll}`, filter: pipeline })
          return { toArray: async () => answer(script.aggregate?.[`${db}.${coll}`], []) }
        },
      }),
    }),
  }
  return { client: client as unknown as MongoClient, asked }
}

const cluster: Script = {
  listShards: {
    shards: [
      { _id: 'rs0', host: 'rs0/a:27017,b:27017', state: 1, tags: ['eu'] },
      { _id: 'rs1', host: 'rs1/mongodb://u:hunter2@c:27017', state: 1, draining: true },
    ],
  },
  balancerStatus: { mode: 'full', inBalancerRound: false, numBalancerRounds: 12 },
  find: {
    'config.settings': [{ _id: 'balancer', activeWindow: { start: '23:00', stop: '06:00' } }],
    'config.mongos': [
      { _id: 'm1:27017', mongoVersion: '7.0.1', up: 3600, ping: new Date(NOW - 5_000) },
      { _id: 'm2:27017', mongoVersion: '7.0.1', up: 10, ping: new Date(NOW - 120_000) },
    ],
    'config.collections': [
      { _id: 'crm.users', key: { email: 1 }, unique: false, uuid: 'u1' },
      { _id: 'shop.orders', key: { _id: 'hashed' }, unique: false, noBalance: true, uuid: 'u2' },
    ],
  },
  aggregate: {
    'config.chunks': [
      { _id: { uuid: 'u1', shard: 'rs0' }, n: 10, jumbo: 1 },
      { _id: { uuid: 'u1', shard: 'rs1' }, n: 4, jumbo: 0 },
      { _id: { uuid: 'u2', shard: 'rs0' }, n: 2, jumbo: 0 },
    ],
  },
}

async function setup(
  script: Script,
  rules: Array<{ db: string; coll: string; field: string }> = [{ db: 'crm', coll: 'users', field: 'email' }],
) {
  const t = await makeApp({ auth: true })
  t.clock.now = NOW
  apps.push(t)
  const { ctx } = t.app
  const connectionId = ctx.connections.create(
    {
      name: 'S',
      favorite: false,
      readOnly: false,
      settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port: 1 }] }),
    },
    null,
  ).id
  const fake = scripted(script)
  vi.spyOn(ctx.manager, 'getClient').mockResolvedValue(fake.client)
  ctx.personalFields.set(connectionId, rules)
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
  return { as, asked: fake.asked }
}

describe('sharding review fixes (final review C1, M4, M5, M6)', () => {
  const jumboWith = (ns: string, min: object, max: object): Script => ({
    ...cluster,
    find: {
      ...cluster.find,
      'config.collections': [{ _id: ns, key: {}, uuid: 'u9' }],
      'config.chunks': [{ shard: 'rs0', min, max }],
    },
    aggregate: { 'config.chunks': [{ shard: 'rs0', min, max }] },
  })

  it('masks bounds of a dotted and a compound shard key (C1)', async () => {
    const { as } = await setup(
      jumboWith(
        'crm.users',
        { 'profile.email': 'alice@x', tenant: 't1' },
        { 'profile.email': 'bob@x', tenant: 't2' },
      ),
      [{ db: 'crm', coll: 'users', field: 'profile.email' }],
    )
    const res = await as('editor', true)('sharding/detail?ns=crm.users')
    expect(res.body).not.toContain('alice@x')
    expect(res.json().jumbo[0]).toMatchObject({ min: { 'profile.email': '***', tenant: 't1' } })
  })

  it('masks the bounds of a sharded time-series collection by the rules of its view (C1)', async () => {
    const { as } = await setup(
      jumboWith('crm.system.buckets.events', { 'meta.email': 'alice@x' }, { 'meta.email': 'bob@x' }),
      [{ db: 'crm', coll: 'events', field: 'meta.email' }],
    )
    const res = await as('editor', true)('sharding/detail?ns=crm.system.buckets.events')
    expect(res.body).not.toContain('alice@x')
  })

  it('removes bare userinfo from hosts (M4)', async () => {
    const { as } = await setup({
      ...cluster,
      listShards: { shards: [{ _id: 'rs0', host: 'rs0/bob:hunter2@a:27017,b:27017' }] },
      find: { ...cluster.find, 'config.mongos': [{ _id: 'eve:pw@m1:27017', ping: new Date(NOW) }] },
    })
    const res = await as('editor')('sharding')
    expect(res.body).not.toContain('hunter2')
    expect(res.body).not.toContain('eve:pw')
    expect(res.json().shards[0].hosts).toBe('rs0/a:27017,b:27017')
  })

  it('keeps credential collections from non-admins (M5)', async () => {
    const { as } = await setup(cluster)
    expect((await as('editor')('sharding/detail?ns=admin.system.users')).statusCode).toBe(403)
    expect((await as('admin')('sharding/detail?ns=admin.system.users')).statusCode).toBe(200)
  })

  it('bounds hostile config documents (M6)', async () => {
    const { as } = await setup({
      ...cluster,
      listShards: {
        shards: Array.from({ length: 2000 }, (_, i) => ({
          _id: `s${i}`,
          host: 'h',
          tags: Array.from({ length: 5000 }, () => 't'),
        })),
      },
      find: {
        ...cluster.find,
        'config.collections': [
          {
            _id: 'a.b',
            key: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`.repeat(50), 1])),
            uuid: 'u1',
          },
          { _id: 'a.nouuid', key: { x: 1 } },
        ],
      },
    })
    const view = (await as('editor')('sharding')).json()
    expect(view.shards.length).toBeLessThanOrEqual(1000)
    expect(view.shards[0].tags.length).toBeLessThanOrEqual(50)
    expect(Object.keys(view.collections[0].key).length).toBeLessThanOrEqual(32)
    expect(Object.keys(view.collections[0].key).every((k: string) => k.length <= 256)).toBe(true)
    expect(view.collections.find((c: { ns: string }) => c.ns === 'a.nouuid').chunks).toEqual({})
  })
})

describe('sharding overview (phase 3b §5)', () => {
  it('shows shards, balancer, mongos and sharded collections with chunk spread', async () => {
    const { as } = await setup(cluster)
    const view = (await as('editor')('sharding')).json()
    expect(view.shards).toEqual([
      { id: 'rs0', hosts: 'rs0/a:27017,b:27017', draining: false, tags: ['eu'], collections: 2, chunks: 12 },
      expect.objectContaining({ id: 'rs1', draining: true, collections: 1, chunks: 4 }),
    ])
    expect(view.balancer).toEqual({
      mode: 'full',
      inRound: false,
      rounds: 12,
      window: { start: '23:00', stop: '06:00' },
    })
    expect(view.mongos.map((m: { host: string; stale: boolean }) => [m.host, m.stale])).toEqual([
      ['m1:27017', false],
      ['m2:27017', true],
    ])
    expect(view.collections[0]).toEqual({
      ns: 'crm.users',
      key: { email: 1 },
      unique: false,
      balancing: true,
      chunks: { rs0: 10, rs1: 4 },
      imbalance: 6,
      jumbo: 1,
    })
    expect(view.collections[1]).toMatchObject({
      ns: 'shop.orders',
      key: { _id: 'hashed' },
      balancing: false,
      imbalance: 2,
    })
    expect(view).toMatchObject({ more: false, refused: {} })
  })

  it('removes credentials from hosts (review focus 4)', async () => {
    const { as } = await setup(cluster)
    const res = await as('editor')('sharding')
    expect(res.body).not.toContain('hunter2')
  })

  it('filters collections by an escaped namespace prefix', async () => {
    const { as, asked } = await setup(cluster)
    await as('editor')('sharding?ns=' + encodeURIComponent('crm.*'))
    const filter = asked.find((a) => a.ns === 'config.collections')!.filter as { _id: { $regex: string } }
    expect(filter._id.$regex).toBe('^crm\\.\\*(\\.|$)')
    expect((await as('editor')('sharding?ns=a%00b')).statusCode).toBe(400)
  })

  it('reports a refused part and still answers the rest', async () => {
    const { as } = await setup({ ...cluster, listShards: Object.assign(new Error('no'), { code: 13 }) })
    const view = (await as('editor')('sharding')).json()
    expect(view.refused).toEqual({ shards: 'not_permitted' })
    expect(view.collections).toHaveLength(2)
  })

  it('answers not_sharded on a server that is not a mongos', async () => {
    const { as } = await setup({ ...cluster, hello: { isWritablePrimary: true } })
    const res = await as('editor')('sharding')
    expect(res.statusCode).toBe(409)
    expect(res.json().details).toEqual({ reason: 'not_sharded' })
    expect((await as('viewer')('sharding')).statusCode).toBe(403)
  })

  it('details one collection, and masks jumbo bounds for a restricted user (review focus 2)', async () => {
    const detail: Script = {
      ...cluster,
      find: {
        ...cluster.find,
        'config.collections': [{ _id: 'crm.users', key: { email: 1 }, uuid: 'u1' }],
        'config.chunks': [{ shard: 'rs0', min: { email: 'alice@x' }, max: { email: 'bob@x' } }],
      },
      aggregate: {
        'crm.users': [
          { shard: 'rs0', storageStats: { size: 1000, count: 10 } },
          { shard: 'rs1', storageStats: { size: 400, count: 4 } },
        ],
        'config.chunks': [{ shard: 'rs0', min: { email: 'alice@x' }, max: { email: 'bob@x' } }],
      },
    }
    const { as, asked } = await setup(detail)
    const open = (await as('editor')('sharding/detail?ns=crm.users')).json()
    expect(open.shards).toEqual([
      { shard: 'rs0', size: 1000, count: 10 },
      { shard: 'rs1', size: 400, count: 4 },
    ])
    expect(open.jumbo[0]).toMatchObject({ shard: 'rs0', min: { email: 'alice@x' } })
    const res = await as('editor', true)('sharding/detail?ns=crm.users')
    expect(res.body).not.toContain('alice@x')
    expect(res.json().jumbo[0]).toMatchObject({ min: { email: '***' }, max: { email: '***' } })
    // Where rules apply, the chunks listed are a random few, not the lowest of the hidden key, nor
    // in their _ids' order, which mostly follows it (twelfth and thirteenth reviews, M-4, M-1).
    const chunks = asked.filter((a) => a.ns === 'config.chunks')
    expect(chunks.map((a) => (a as { options?: unknown }).options)).toEqual([
      { limit: 20, projection: { shard: 1, min: 1, max: 1 } },
      undefined,
    ])
    expect(chunks[1]!.filter).toEqual([
      { $match: { uuid: 'u1', jumbo: true } },
      { $sample: { size: 20 } },
      { $project: { shard: 1, min: 1, max: 1 } },
    ])
    expect((await as('editor')('sharding/detail?ns=nodot')).statusCode).toBe(400)
  })
})
