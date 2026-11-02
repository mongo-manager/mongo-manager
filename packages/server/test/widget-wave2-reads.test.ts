import { hostname } from 'node:os'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { MongoClient } from 'mongodb'
import { ConnectionSettingsSchema, type Role } from '@mongo-manager/shared'
import { latencyOf, p95Ms } from '../src/monitor/collection-latency'
import { gatherFacts, warningText } from '../src/monitor/facts'
import { startMongo, type TestMongo } from './support/mongo'
import { H, makeApp, type TestApp } from './helpers'

/**
 * Widgets wave 2 (2026-10-27): a server's collections by latency (Atlas Namespace Insights), and its
 * facts and start-up warnings (mongosh's banner) — names and numbers only, never a host, an address
 * or a path.
 */
let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
})
afterAll(async () => {
  await mongo?.stop()
})
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

async function setup() {
  const t = await makeApp({ auth: true })
  apps.push(t)
  await t.app.ready()
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
  const as = (role: Role) => {
    const user = ctx.users.create({ username: `u-${role}-${Math.random()}`, passwordHash: 'x', role })
    const { sessionId } = ctx.sessions.create(user.id, {})
    return (path: string) =>
      t.app.inject({
        method: 'GET',
        url: `/api/connections/${connectionId}/server/${path}`,
        headers: H,
        cookies: { mm_sid: sessionId },
      })
  }
  return { as }
}

describe('a collection’s latency', () => {
  it('finds the bucket the 95th percentile falls in (its lower bound), none for no operations', () => {
    const histogram = [
      { micros: 1, count: 90 },
      { micros: 1024, count: 5 },
      { micros: 65_536, count: 5 },
    ]
    expect(p95Ms(histogram)).toBe(1.02)
    expect(p95Ms([{ micros: 2_000, count: 1 }])).toBe(2)
    // MongoDB lists them in order; the answer does not depend on it.
    expect(p95Ms([...histogram].reverse())).toBe(1.02)
    expect(p95Ms([])).toBeNull()
    expect(p95Ms(undefined)).toBeNull()
  })

  it('adds up what each shard reports, an average per operation, and none without operations', () => {
    const shard = (reads: number, latency: number) => ({
      latencyStats: {
        reads: { latency, ops: reads, histogram: [{ micros: 1_000, count: reads }] },
        writes: { latency: 0, ops: 0, histogram: [] },
        commands: { latency: 600, ops: 2, histogram: [{ micros: 256, count: 2 }] },
      },
    })
    expect(latencyOf([shard(2, 3_000), shard(2, 1_000)])).toEqual({
      reads: { ops: 4, avgMs: 1, p95Ms: 1 },
      writes: { ops: 0, avgMs: null, p95Ms: null },
      commands: { ops: 4, avgMs: 0.3, p95Ms: 0.26 },
    })
    expect(latencyOf([])).toBeNull()
    expect(latencyOf([{}])).toBeNull()
  })

  it('lists at most five busiest collections by latency, as Busiest collections lists fifteen', async () => {
    const { as } = await setup()
    const { MongoClient } = await import('mongodb')
    const client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
    try {
      for (let i = 0; i < 17; i++) {
        const c = client.db('wave2many').collection(`c${i}`)
        await c.insertOne({ i })
        await c.find({ i }).toArray()
      }
    } finally {
      await client.close()
    }
    expect((await as('editor')('collection-latency')).json().collections).toHaveLength(5)
    expect((await as('editor')('top')).json().collections).toHaveLength(15)
  })

  it('lists a server’s busiest collections with their latency, for server:monitor only', async () => {
    const { as } = await setup()
    const { MongoClient } = await import('mongodb')
    const client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
    try {
      const orders = client.db('wave2').collection('orders')
      // The test before made 17 busy collections: gone, they are not listed (only collections that
      // exist are), whatever top still counts for them.
      await client.db('wave2many').dropDatabase()
      await orders.insertMany(Array.from({ length: 2_000 }, (_, a) => ({ a })))
      // Clearly the busiest, whatever the tests before it read: scans of the whole collection.
      for (let i = 0; i < 40; i++) await orders.find({ b: i }).toArray()
    } finally {
      await client.close()
    }
    const res = await as('editor')('collection-latency')
    expect(res.statusCode).toBe(200)
    const found = (res.json().collections as Array<{ ns: string; reads: { ops: number } | null }>).find(
      (c) => c.ns === 'wave2.orders',
    )
    expect(found?.reads?.ops).toBeGreaterThanOrEqual(40)
    expect(res.json().collections.length).toBeLessThanOrEqual(5)
    expect((await as('viewer')('collection-latency')).statusCode).toBe(403)
  })
})

describe('a server’s facts and start-up warnings', () => {
  it('keeps a structured warning’s message, never its attributes', () => {
    const line = JSON.stringify({
      t: { $date: '2026-10-27T10:00:00.000Z' },
      s: 'W',
      c: 'CONTROL',
      id: 22120,
      msg: 'Access control is not enabled for the database',
      attr: { dbpath: '/var/lib/mongodb', host: 'db-1.internal.example' },
    })
    expect(warningText(line)).toBe('Access control is not enabled for the database')
  })

  it('hides what names a place in a warning: paths, addresses, hosts with a port, connection strings', () => {
    const said = warningText(
      '** WARNING: /var/lib/mongodb is on 10.20.30.40 and fe80::1:2 and db-1.internal.example:27017 ' +
        'see C:\\data\\db and mongodb://u:p@h/x or file:///etc/x, replica.db-2.example.org and ' +
        'https://monitor.example/x?token=1',
    )!
    for (const leak of [
      '/var/lib',
      '10.20.30.40',
      'fe80::1:2',
      'db-1.internal',
      '27017',
      'C:\\data',
      'u:p@h',
      '/etc/x',
      'db-2.example',
      'monitor.example',
      'token',
    ])
      expect(said, leak).not.toContain(leak)
    expect(said).toContain('WARNING')
    expect(warningText('   ')).toBeNull()
    expect(warningText('x'.repeat(500))!.length).toBeLessThanOrEqual(201)
  })

  // Review of wave 2 (M1): two-label names, underscored container names, UNC paths, a path after any
  // sign, a bracketed IPv6 address with its port.
  it('hides the places a review found slipping through', () => {
    const said = warningText(
      'members db1.corp and mongo.internal, container project_mongo_1, share \\\\fileserver\\dumps, ' +
        'home ~/mongo and <"/data/db"> and {/srv/x} and |/opt/y;/var/z, listening on [::1]:27017',
    )!
    for (const leak of [
      'db1.corp',
      'mongo.internal',
      'project_mongo_1',
      'fileserver',
      '/mongo',
      '/data/db',
      '/srv/x',
      '/opt/y',
      '/var/z',
      '::1',
      '27017',
    ])
      expect(said, leak).not.toContain(leak)
    expect(said).toContain('members')
  })

  // Review of wave 2 (M2): a structured line without a message is not shown at all, its attributes never.
  it('shows nothing of a structured line that has no message', () => {
    expect(warningText(JSON.stringify({ id: 1, attr: { path: 'x' } }))).toBeNull()
    expect(warningText(JSON.stringify({ msg: 42, attr: { ip: 'y' } }))).toBeNull()
    expect(warningText('[1, 2]')).toBe('[1, 2]')
  })

  // Review of wave 2 (M3): a server that cannot be read is an error (with Retry), not a page of unknowns.
  it('says MongoDB refused what it refused, and fails when the server could not be read at all', async () => {
    const answering = (fail: (name: string) => unknown) =>
      ({
        db: () => ({
          command: async (cmd: Record<string, unknown>) => {
            const name = Object.keys(cmd)[0]!
            const e = fail(name)
            if (e) throw e
            return name === 'getLog' ? { log: [] } : {}
          },
        }),
      }) as unknown as MongoClient
    const refused = Object.assign(new Error('not authorized'), { code: 13 })
    const facts = await gatherFacts(answering((n) => (n === 'hostInfo' ? refused : null)))
    expect(facts.refused).toEqual(['hostInfo'])
    // Every part refused: said as refused, not as a server that cannot be read.
    const none = await gatherFacts(answering(() => refused))
    expect(none.refused).toEqual(['buildInfo', 'hostInfo', 'fcv', 'warnings', 'status'])
    const down = Object.assign(new Error('connection closed'), { name: 'MongoNetworkError' })
    await expect(gatherFacts(answering(() => down))).rejects.toBeDefined()
    // Some parts read, one lost on the way: that part is not known, the rest shown.
    const partly = await gatherFacts(answering((n) => (n === 'buildInfo' ? down : null)))
    expect(partly.version).toBeNull()
  })

  it('says each fact, null where MongoDB refuses it, and never the host name', async () => {
    const answers: Record<string, unknown> = {
      buildInfo: { version: '8.0.4' },
      hostInfo: {
        system: { hostname: 'secret-host.example', numCores: 8, memSizeMB: 16_384 },
        os: { type: 'Linux', name: 'Ubuntu', version: '24.04' },
      },
      getParameter: { featureCompatibilityVersion: { version: '8.0' } },
      getLog: {
        log: [
          JSON.stringify({ msg: 'This server is bound to localhost', attr: { ip: '127.0.0.1' } }),
          // An older server's text line naming the host hostInfo gave (one dot: only its name hides it).
          '** WARNING: secret-host.example runs with a soft rlimit',
          ...Array.from({ length: 12 }, (_, i) => JSON.stringify({ msg: `warning ${i}` })),
        ],
      },
      serverStatus: { storageEngine: { name: 'wiredTiger' }, host: 'secret-host.example:27017' },
    }
    const client = {
      db: () => ({
        command: async (cmd: Record<string, unknown>) => {
          const name = Object.keys(cmd)[0]!
          if (name === 'getParameter') throw Object.assign(new Error('no'), { code: 13 })
          return answers[name]
        },
      }),
    } as unknown as MongoClient
    const facts = await gatherFacts(client)
    expect(facts).toEqual({
      version: '8.0.4',
      fcv: null,
      storageEngine: 'wiredTiger',
      cores: 8,
      memoryMb: 16_384,
      os: { type: 'Linux', name: 'Ubuntu' },
      warnings: [
        'This server is bound to localhost',
        '** WARNING: … runs with a soft rlimit',
        ...Array.from({ length: 8 }, (_, i) => `warning ${i}`),
      ],
      refused: ['fcv'],
    })
    expect(JSON.stringify(facts)).not.toContain('secret-host')
  })

  it('reads a real server’s facts, for server:monitor only, with no host in them', async () => {
    const { as } = await setup()
    const res = await as('editor')('facts')
    expect(res.statusCode).toBe(200)
    const facts = res.json()
    expect(facts.version).toMatch(/^\d+\.\d+/)
    expect(facts.cores).toBeGreaterThan(0)
    expect(facts.memoryMb).toBeGreaterThan(0)
    expect(facts.storageEngine).toBe('wiredTiger')
    const text = JSON.stringify(facts)
    expect(text).not.toContain(hostname())
    expect(text).not.toContain('127.0.0.1')
    expect(text).not.toContain(String(mongo.port))
    expect((await as('viewer')('facts')).statusCode).toBe(403)
  })
})
