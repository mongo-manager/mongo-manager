import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import type { AiAgentStep, AiChatLine } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness } from './support/data'
import { restrictedApp } from './support/restricted'
import { startFakeAi, type FakeCall } from './support/fake-ai'
import { agentReply, agentTurn, conversationOf, namedConnection } from './support/agent'
import { replicaTold } from '../src/ai/agent/execute'
import { H } from './helpers'

/**
 * The AI database manager (design 2026-10-25, B3): the server's health read from the chat — its status,
 * replica set, busiest collections, slow queries, index advice and running operations — by numbers,
 * names and kinds only (never a command's text, a value, nor a host), and a running operation stopped on
 * a card that takes its id typed, under server:operations.
 */
let mongo: TestMongo
let client: MongoClient
beforeAll(async () => {
  mongo = await startMongo()
  client = new MongoClient(`mongodb://127.0.0.1:${mongo.port}`)
  await client.connect()
})
afterAll(async () => {
  await client?.close()
  await mongo?.stop()
})
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const c of closers.splice(0).reverse()) await c()
})

const steps = (out: AiChatLine[]) =>
  out.flatMap((l) => (l.type === 'step' && l.step.state !== 'running' ? [l.step] : []))
/** A value the provider must never see. */
const SECRET = 'value-never-told-4711'

async function server() {
  const fake = await startFakeAi()
  closers.push(fake.close)
  const h = await dataHarness(mongo)
  closers.push(h.t.close)
  const inject = (method: 'GET' | 'POST' | 'PUT', path: string, payload?: object) =>
    h.t.app.inject({ method, url: `/api/${path}`, headers: h.headers, ...(payload ? { payload } : {}) })
  expect(
    (
      await inject('POST', 'ai/providers', {
        name: 'Fake',
        kind: 'openai',
        baseUrl: `${fake.url}/v1`,
        model: 'm',
      })
    ).statusCode,
  ).toBeLessThan(300)
  await inject('PUT', 'me/ai-agent', { on: true })
  const db = `b3${randomUUID().slice(0, 8)}`
  await client
    .db(db)
    .collection('orders')
    .insertMany(Array.from({ length: 30 }, (_, i) => ({ n: i, status: i % 2 ? 'paid' : SECRET })))
  const once = (calls: FakeCall[], text = 'ok') =>
    fake.reply(agentReply((c) => (c.results.length === 0 ? { calls } : { text })))
  const turn = async (message: string) =>
    (await inject('POST', 'ai/agent', { message })).payload
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as AiChatLine)
  /** What the provider was told by the last tool, as it was sent. */
  const told = () => {
    const r = conversationOf(fake.requests.at(-1)!.body).results.at(-1)!
    return r
  }
  const toldJson = () => {
    const r = told()
    return JSON.parse(r.slice(r.indexOf('{'), r.lastIndexOf('}') + 1)) as Record<string, unknown>
  }
  const card = async (calls: FakeCall[]) => {
    once(calls)
    const stream = await agentTurn(h.t.app, h.headers, { message: 'stop it' })
    const awaiting = (await stream.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')) as {
      step: AiAgentStep
    }
    const run = (stream.lines.find((l) => l.type === 'chat') as { run: string }).run
    const decide = async (decision: 'confirm' | 'decline', extra: object = {}) => {
      const res = await inject('POST', `ai/agent/runs/${run}/decide`, {
        call: awaiting.step.id,
        decision,
        ...extra,
      })
      await stream.ended
      return { res, ended: steps(stream.lines).at(-1)! }
    }
    return { step: awaiting.step, decide }
  }
  return { h, fake, db, inject, once, turn, told, toldJson, card }
}

/** A query that runs for a few seconds: server-side JavaScript sleeping per document. */
function slowRead(db: string, comment?: string, coll = 'orders', sleepMs = 200) {
  return client
    .db(db)
    .collection(coll)
    .find({ $where: `sleep(${sleepMs}) || true`, status: SECRET }, comment ? { comment } : {})
    .toArray()
    .then(
      () => 'finished' as const,
      () => 'stopped' as const,
    )
}

describe('the server read by the agent (B3)', () => {
  it('tells the server’s status by numbers: version, uptime, connections, operations, memory', async () => {
    const { once, turn, toldJson } = await server()
    once([{ name: 'server_status', args: { connection: 'Test' } }])
    const [step] = steps(await turn('how is the server?'))
    expect(step).toMatchObject({ tool: 'server_status', state: 'done', sent: 'stats' })
    const status = toldJson()
    expect(status).toMatchObject({
      version: expect.any(String),
      uptimeHours: expect.any(Number),
      connections: { current: expect.any(Number), available: expect.any(Number) },
      memory: { residentMb: expect.any(Number) },
    })
    // Its host and process are never told.
    expect(JSON.stringify(status)).not.toMatch(/127\.0\.0\.1|localhost|process/)
  })

  it('tells a standalone server as such, and a replica set’s members by number, never their hosts', async () => {
    const { once, turn, toldJson } = await server()
    once([{ name: 'replica_set', args: { connection: 'Test' } }])
    const [step] = steps(await turn('replica set?'))
    expect(step).toMatchObject({ tool: 'replica_set', state: 'done' })
    expect(toldJson()).toMatchObject({ mode: 'standalone' })
    const told = replicaTold({
      mode: 'replicaSet',
      set: 'rs0',
      date: null,
      primary: 'db-1.internal.example:27017',
      majorityLagSeconds: 0,
      oplogWindowHours: 24,
      oplog: null,
      lastElection: null,
      members: [
        {
          name: 'db-1.internal.example:27017',
          state: 'PRIMARY',
          healthy: true,
          self: true,
          uptimeSeconds: 100,
          lagSeconds: null,
          pingMs: null,
          lastHeartbeat: null,
          lastHeartbeatMessage: null,
          syncSource: null,
          priority: 1,
          hidden: false,
          votes: 1,
          arbiter: false,
        },
        {
          name: 'db-2.internal.example:27017',
          state: 'SECONDARY',
          healthy: false,
          self: false,
          uptimeSeconds: 0,
          lagSeconds: 12,
          pingMs: 4,
          lastHeartbeat: null,
          lastHeartbeatMessage: 'Couldn’t get a connection to db-2.internal.example:27017',
          syncSource: 'db-1.internal.example:27017',
          priority: 0,
          hidden: true,
          votes: 0,
          arbiter: false,
        },
      ],
    })
    expect(told).toMatchObject({
      mode: 'replicaSet',
      set: 'rs0',
      primary: 1,
      members: [
        { member: 1, state: 'PRIMARY', healthy: true, self: true },
        {
          member: 2,
          state: 'SECONDARY',
          healthy: false,
          lagSeconds: 12,
          heartbeatFailing: true,
          syncsFrom: 1,
        },
      ],
    })
    expect(JSON.stringify(told)).not.toContain('internal.example')
  })

  it('tells the busiest collections by time and count', async () => {
    const { db, once, turn, toldJson } = await server()
    await client
      .db(db)
      .collection('orders')
      .find({ n: { $gt: 3 } })
      .toArray()
    once([{ name: 'server_top', args: { connection: 'Test' } }])
    const [step] = steps(await turn('which collections are busy?'))
    expect(step).toMatchObject({ tool: 'server_top', state: 'done' })
    const top = toldJson().collections as Array<Record<string, unknown>>
    expect(top.find((c) => c.database === db && c.collection === 'orders')).toMatchObject({
      totalMs: expect.any(Number),
      count: expect.any(Number),
    })
  })

  it('tells slow queries and index advice by shape — no command, no value', async () => {
    const { db, once, turn, told, toldJson } = await server()
    await client.db(db).command({ profile: 2, slowms: 0 })
    try {
      await client.db(db).collection('orders').find({ status: SECRET }).sort({ n: -1 }).toArray()
      once([{ name: 'slow_queries', args: { connection: 'Test', database: db } }])
      const [slow] = steps(await turn('slow queries?'))
      expect(slow).toMatchObject({ tool: 'slow_queries', state: 'done', sent: 'stats' })
      const entries = toldJson().queries as Array<Record<string, unknown>>
      expect(entries.find((e) => e.collection === 'orders')).toMatchObject({
        database: db,
        op: expect.any(String),
        durationMs: expect.any(Number),
      })
      expect(told()).not.toContain(SECRET)
      expect(told()).not.toMatch(/"command":|"origin":/)
      // Review of B3 (I3): keys examined tell how many values a document holds there: never told.
      expect(told()).not.toContain('keysExamined')
      once([{ name: 'index_advice', args: { connection: 'Test', database: db } }])
      const [advice] = steps(await turn('which indexes?'))
      expect(advice).toMatchObject({ tool: 'index_advice', state: 'done', sent: 'indexes' })
      const suggestion = (toldJson().suggestions as Array<Record<string, unknown>>).find(
        (s) => s.collection === 'orders',
      )
      expect(suggestion).toMatchObject({ keys: expect.arrayContaining([['status', 1]]) })
      expect(told()).not.toContain(SECRET)
    } finally {
      await client.db(db).command({ profile: 0 })
    }
  })

  it('tells the operations running, never their command; stops one on a card with its id typed', async () => {
    const { db, once, turn, told, toldJson, card } = await server()
    // Running until stopped (CI 2026-11-01): at 200 ms a document it ended on a slow runner before the
    // card asked for it, and MongoDB gave its opid to its own work, which is never stopped.
    const running = slowRead(db, undefined, 'orders', 1000)
    try {
      let op: Record<string, unknown> | undefined
      for (let i = 0; i < 40 && !op; i++) {
        once([{ name: 'current_operations', args: { connection: 'Test', database: db } }])
        const [step] = steps(await turn('what is running?'))
        expect(step).toMatchObject({ tool: 'current_operations', state: 'done' })
        op = (toldJson().operations as Array<Record<string, unknown>>).find((o) => o.collection === 'orders')
        if (!op) await new Promise((r) => setTimeout(r, 100))
      }
      expect(op).toMatchObject({ opid: expect.any(String), op: 'query', secsRunning: expect.any(Number) })
      // Third review of B3 (M3): when it started and where are the kill's checks, never told.
      expect(Object.keys(op!)).not.toEqual(expect.arrayContaining(['member']))
      expect(Object.keys(op!)).not.toEqual(expect.arrayContaining(['startedAt']))
      expect(told()).not.toContain(SECRET)
      expect(told()).not.toMatch(/sleep|\$where|"command":/)
      const asked = await card([
        { name: 'kill_operation', args: { connection: 'Test', opid: Number(op!.opid) } },
      ])
      expect(asked.step.proposal).toMatchObject({
        typed: op!.opid,
        destructive: true,
        preview: { operation: 'query', namespace: `${db}.orders` },
      })
      const { ended } = await asked.decide('confirm', { confirm: op!.opid })
      expect(ended).toMatchObject({ state: 'done', summary: { killed: op!.opid } })
      expect(await running).toBe('stopped')
    } finally {
      await running
    }
  }, 60_000)

  it('refuses to stop what is not running, or MongoDB’s own work', async () => {
    const { once, turn } = await server()
    once([{ name: 'kill_operation', args: { connection: 'Test', opid: '987654321' } }])
    expect(steps(await turn('stop'))[0]).toMatchObject({ state: 'refused', reason: 'operation_unknown' })
  })
})

describe('stopping an operation, reviewed (B3)', () => {
  async function listedOp(s: Awaited<ReturnType<typeof server>>, db: string, coll = 'orders') {
    for (let i = 0; i < 40; i++) {
      s.once([{ name: 'current_operations', args: { connection: 'Test', database: db } }])
      await s.turn('what is running?')
      const op = (s.toldJson().operations as Array<Record<string, unknown>>).find(
        (o) => o.collection === coll,
      )
      if (op) return op
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error('the slow read was not listed')
  }

  // I1: the card's operation finished before the click: said as such, nothing else stopped.
  it('stops nothing when the operation finished before the click', async () => {
    const s = await server()
    const running = slowRead(s.db)
    const op = await listedOp(s, s.db)
    const asked = await s.card([{ name: 'kill_operation', args: { connection: 'Test', opid: op.opid } }])
    await client.db('admin').command({ killOp: 1, op: Number(op.opid) })
    expect(await running).toBe('stopped')
    const { ended } = await asked.decide('confirm', { confirm: op.opid })
    expect(ended).toMatchObject({ state: 'error', reason: 'operation_finished' })
  }, 60_000)

  // I2, M2: a read-only connection, or one with the agent's changes off, is refused before any card.
  it('never offers a kill on a read-only connection, nor where the agent’s changes are off', async () => {
    const s = await server()
    namedConnection(s.h.t.app, mongo.port, 'RO', { readOnly: true })
    namedConnection(s.h.t.app, mongo.port, 'Quiet', { aiAgentWrites: false })
    s.once([{ name: 'kill_operation', args: { connection: 'RO', opid: '1' } }])
    expect(steps(await s.turn('stop'))[0]).toMatchObject({ state: 'refused', reason: 'read_only' })
    s.once([{ name: 'kill_operation', args: { connection: 'Quiet', opid: '1' } }])
    expect(steps(await s.turn('stop'))[0]).toMatchObject({ state: 'refused', reason: 'agent_writes_off' })
  })

  // M1: Mongo Manager's own work is said as such, and its stop is refused before any card.
  it('says which operations are Mongo Manager’s own, and never offers to stop one', async () => {
    const s = await server()
    const running = slowRead(s.db, 'mm:agent-test')
    try {
      const op = await listedOp(s, s.db)
      expect(op).toMatchObject({ appOwn: true })
      s.once([{ name: 'kill_operation', args: { connection: 'Test', opid: op.opid } }])
      expect(steps(await s.turn('stop'))[0]).toMatchObject({ state: 'refused', reason: 'operation_own' })
    } finally {
      await running
    }
  }, 60_000)

  // M7: never one on MongoDB's own databases.
  it('never offers to stop an operation on MongoDB’s own databases', async () => {
    const s = await server()
    await client
      .db('local')
      .collection('b3x')
      .insertMany(Array.from({ length: 30 }, (_, i) => ({ n: i, status: SECRET })))
    const running = slowRead('local', undefined, 'b3x')
    try {
      const op = await listedOp(s, 'local', 'b3x')
      s.once([{ name: 'kill_operation', args: { connection: 'Test', opid: op.opid } }])
      expect(steps(await s.turn('stop'))[0]).toMatchObject({ state: 'refused', reason: 'system_namespace' })
    } finally {
      await running
      await client.db('local').collection('b3x').drop()
    }
  }, 60_000)

  // M5: what could not be read is said by its code.
  it('says why slow queries could not be read from the profiler', async () => {
    const s = await server()
    s.once([{ name: 'slow_queries', args: { connection: 'Test' } }])
    await s.turn('slow queries anywhere?')
    expect(s.toldJson()).toMatchObject({ notRead: { profile: 'no_db' } })
  })
})

describe('server:operations (B3)', () => {
  it('lets an editor read the server but never offers them a card to stop an operation', async () => {
    const db = `b3e${randomUUID().slice(0, 8)}`
    await client
      .db(db)
      .collection('orders')
      .insertMany(Array.from({ length: 30 }, (_, i) => ({ n: i, status: SECRET })))
    const { t, ctx, as } = await restrictedApp(mongo, [], {
      ai: { privateNetworks: ['127.0.0.1/32'] },
    } as never)
    closers.push(t.close)
    const fake = await startFakeAi()
    closers.push(fake.close)
    ctx.ai.providers.create(
      {
        name: 'F',
        kind: 'openai',
        baseUrl: `${fake.url}/v1`,
        model: 'm',
        maxTokens: 512,
        enabled: true,
        isDefault: true,
      },
      null,
    )
    const s = ctx.sessions.create(as('editor').id, {})
    const editor = (method: 'POST' | 'PUT', url: string, payload: object) =>
      t.app.inject({
        method,
        url,
        headers: { ...H, 'x-csrf-token': s.session.csrfToken },
        cookies: { mm_sid: s.sessionId },
        payload,
      })
    await editor('PUT', '/api/me/ai-agent', { on: true })
    await client
      .db('local')
      .collection('b3e')
      .insertMany(Array.from({ length: 30 }, (_, i) => ({ n: i, status: SECRET })))
    const hidden = slowRead('local', undefined, 'b3e')
    const running = slowRead(db)
    // Third review of B3 (M7): both running before the editor's turn.
    for (let i = 0; i < 40; i++) {
      const listed = (await as('admin')('GET', '/server/operations')).json() as {
        operations: Array<{ ns: string }>
      }
      if (
        listed.operations.some((o) => o.ns === 'local.b3e') &&
        listed.operations.some((o) => o.ns === `${db}.orders`)
      )
        break
      await new Promise((r) => setTimeout(r, 100))
    }
    try {
      fake.reply(
        agentReply((c) =>
          c.results.length === 0
            ? { calls: [{ name: 'current_operations', args: { connection: 'M' } }] }
            : c.results.length === 1
              ? (() => {
                  const r = conversationOf(fake.requests.at(-1)!.body).results.at(-1)!
                  const ops = (JSON.parse(r.slice(r.indexOf('{'), r.lastIndexOf('}') + 1)).operations ??
                    []) as Array<{ opid: string }>
                  return {
                    calls: [{ name: 'kill_operation', args: { connection: 'M', opid: ops[0]?.opid ?? '1' } }],
                  }
                })()
              : { text: 'ok' },
        ),
      )
      const out = (await editor('POST', '/api/ai/agent', { message: 'stop the slow one' })).payload
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as AiChatLine)
      const [read, kill] = steps(out)
      expect(read).toMatchObject({ tool: 'current_operations', state: 'done' })
      // Review of B3 (M6): the local database is administrators' only — never told to an editor.
      const first = conversationOf(fake.requests[1]!.body).results[0]!
      expect(first).not.toContain('"local"')
      expect(first).toContain(db)
      expect(kill).toMatchObject({ tool: 'kill_operation', state: 'refused', reason: 'forbidden' })
    } finally {
      await running
      await hidden
      await client.db('local').collection('b3e').drop()
    }
  }, 60_000)
})
