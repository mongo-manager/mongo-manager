import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { H, makeApp, type TestApp } from './helpers'
import { SET_START_MS, slow } from './support/slowness'

/**
 * Fourth review of B3 (critical): on a replica set an operation is stoppable where a kill reaches it —
 * told by reading the operations where the kill does, never by comparing a set's configured names with
 * the names $currentOp reports (they differ in Docker, Kubernetes and the test's own set).
 */
let set: MongoMemoryReplSet
let client: MongoClient
beforeAll(async () => {
  set = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  client = await new MongoClient(set.getUri()).connect()
}, slow(SET_START_MS))
afterAll(async () => {
  await client?.close()
  await set?.stop()
})
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

type Op = { opid: string; op: string; ns: string; killable?: false; startedAt?: number; member?: string }

async function setup(readPreference?: 'secondaryPreferred') {
  const t = await makeApp({ auth: true })
  apps.push(t)
  const { ctx } = t.app
  const uri = new URL(set.getUri())
  const connectionId = ctx.connections.create(
    {
      name: 'RS',
      favorite: false,
      readOnly: false,
      settings: ConnectionSettingsSchema.parse({
        hosts: [{ host: uri.hostname, port: Number(uri.port) }],
        replicaSet: uri.searchParams.get('replicaSet') ?? undefined,
        ...(readPreference ? { readPreference } : {}),
      }),
    },
    null,
  ).id
  const user = ctx.users.create({ username: `admin-${Math.random()}`, passwordHash: 'x', role: 'admin' })
  const { sessionId, session } = ctx.sessions.create(user.id, {})
  return (method: 'GET' | 'POST', path: string, payload?: object) =>
    t.app.inject({
      method,
      url: `/api/connections/${connectionId}/server/${path}`,
      headers: { ...H, 'x-csrf-token': session.csrfToken },
      cookies: { mm_sid: sessionId },
      ...(payload ? { payload } : {}),
    })
}

describe('stopping an operation on a replica set (fourth review of B3)', () => {
  for (const preference of [undefined, 'secondaryPreferred'] as const) {
    it(
      `lists its running operation as stoppable and stops it (${preference ?? 'primary'})`,
      async () => {
        const call = await setup(preference)
        const coll = client.db('shop').collection(`slow${Math.random().toString(36).slice(2, 8)}`)
        await coll.insertOne({ n: 1 })
        const running = coll
          .find({ $where: 'sleep(10000) || true' })
          .toArray()
          .catch((e: Error) => e)
        let op: Op | undefined
        for (let i = 0; i < 60 && !op; i++) {
          const listed = (await call('GET', 'operations')).json() as { operations: Op[] }
          op = listed.operations.find((o) => o.ns === coll.namespace)
          if (!op) await new Promise((r) => setTimeout(r, 100))
        }
        expect(op).toBeDefined()
        expect(op!.killable).toBeUndefined()
        const res = await call('POST', `operations/${op!.opid}/kill`, {
          ns: op!.ns,
          op: op!.op,
          ...(op!.startedAt !== undefined ? { startedAt: op!.startedAt } : {}),
          ...(op!.member ? { member: op!.member } : {}),
        })
        expect(res.statusCode, res.body).toBe(200)
        expect(await running).toBeInstanceOf(Error)
      },
      slow(60_000),
    )
  }
})

// Fifth review of B3 (M4): an operation a secondary runs, read through a connection that reads there,
// is listed but never offered to stop — and a kill asked for it stops nothing.
describe('an operation a secondary runs (fifth review of B3)', () => {
  let pair: MongoMemoryReplSet
  let reader: MongoClient
  beforeAll(async () => {
    pair = await MongoMemoryReplSet.create({ replSet: { count: 2 } })
    reader = await new MongoClient(pair.getUri(), { readPreference: 'secondary' }).connect()
  }, slow(SET_START_MS))
  afterAll(async () => {
    await reader?.close()
    await pair?.stop()
  })

  it(
    'lists it, not stoppable, and refuses its kill',
    async () => {
      const t = await makeApp({ auth: true })
      apps.push(t)
      const { ctx } = t.app
      // Several hosts: no URL reads them, so the URI is read by hand.
      const [, hostList, query] = /^mongodb:\/\/([^/]+)\/?\??(.*)$/.exec(pair.getUri())!
      const uri = { searchParams: new URLSearchParams(query) }
      const hosts = hostList!.split(',').map((h) => {
        const [host, port] = h.split(':')
        return { host: host!, port: Number(port) }
      })
      const connectionId = ctx.connections.create(
        {
          name: 'RS2',
          favorite: false,
          readOnly: false,
          settings: ConnectionSettingsSchema.parse({
            hosts,
            replicaSet: uri.searchParams.get('replicaSet') ?? undefined,
            readPreference: 'secondary',
          }),
        },
        null,
      ).id
      const user = ctx.users.create({ username: `admin-${Math.random()}`, passwordHash: 'x', role: 'admin' })
      const { sessionId, session } = ctx.sessions.create(user.id, {})
      const call = (method: 'GET' | 'POST', path: string, payload?: object) =>
        t.app.inject({
          method,
          url: `/api/connections/${connectionId}/server/${path}`,
          headers: { ...H, 'x-csrf-token': session.csrfToken },
          cookies: { mm_sid: sessionId },
          ...(payload ? { payload } : {}),
        })
      const writer = await new MongoClient(pair.getUri()).connect()
      try {
        const coll = writer.db('shop').collection(`sec${Math.random().toString(36).slice(2, 8)}`)
        await coll.insertOne({ n: 1 }, { writeConcern: { w: 2 } })
        const running = reader
          .db('shop')
          .collection(coll.collectionName)
          .find({ $where: 'sleep(10000) || true' })
          .toArray()
          .catch((e: Error) => e)
        let op: Op | undefined
        for (let i = 0; i < 60 && !op; i++) {
          const listed = (await call('GET', 'operations')).json() as { operations: Op[] }
          op = listed.operations.find((o) => o.ns === coll.namespace)
          if (!op) await new Promise((r) => setTimeout(r, 100))
        }
        expect(op).toMatchObject({ killable: false })
        const res = await call('POST', `operations/${op!.opid}/kill`, {
          ns: op!.ns,
          op: op!.op,
          ...(op!.startedAt !== undefined ? { startedAt: op!.startedAt } : {}),
          ...(op!.member ? { member: op!.member } : {}),
        })
        // Sixth review of B3 (minor 1): read on the primary, the secondary's operation is not there.
        expect([res.statusCode, res.json().details?.reason], res.body).toEqual([404, 'operation_finished'])
        expect(await running).not.toBeInstanceOf(Error)
      } finally {
        await writer.close()
      }
    },
    slow(60_000),
  )
})
