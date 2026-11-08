// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { WebSocket } from '@fastify/websocket'
import { ConnectionSettingsSchema, type Role } from '@mongo-manager/shared'
import { MonitorHub, readStatus, STATUS, STATUS_WITHOUT_METRICS } from '../src/monitor/hub'
import { rawFrom, sampleFrom, type RawStatus } from '../src/monitor/sampler'
import { startMongo, type TestMongo } from './support/mongo'
import { H, makeApp, type TestApp } from './helpers'

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

const raw = (over: Partial<RawStatus> = {}): RawStatus => ({
  at: 0,
  uptime: 100,
  process: 'db1:1',
  ops: { insert: 0, query: 0, update: 0, delete: 0, getmore: 0, command: 0 },
  bytesIn: 0,
  bytesOut: 0,
  connections: { current: 3, available: 97 },
  memory: { residentMb: 50, virtualMb: 500 },
  cache: { usedBytes: 10, dirtyBytes: 1, maxBytes: 100 },
  queues: { readers: 0, writers: 0 },
  version: '8.0.4',
  scanned: null,
  latency: null,
  cursors: null,
  transactions: null,
  asserts: null,
  ...over,
})

describe('server samples (phase 1i spec §3)', () => {
  it('turns counters into rates per second', () => {
    const prev = raw({ at: 0 })
    const next = raw({
      at: 2_000,
      uptime: 102,
      ops: { insert: 20, query: 4, update: 0, delete: 2, getmore: 0, command: 10 },
      bytesIn: 4_000,
      bytesOut: 1_000,
    })
    expect(sampleFrom(prev, next)).toEqual({
      t: 2_000,
      ops: { insert: 10, query: 2, update: 0, delete: 1, getmore: 0, command: 5 },
      network: { inPerSec: 2_000, outPerSec: 500 },
      connections: { current: 3, available: 97 },
      memory: { residentMb: 50, virtualMb: 500 },
      cache: { usedBytes: 10, dirtyBytes: 1, maxBytes: 100 },
      queues: { readers: 0, writers: 0 },
      restarted: false,
      baseline: false,
      uptimeSec: 0,
      version: '8.0.4',
      targeting: { keysPerReturned: null, docsPerReturned: null },
      latency: { readsMs: null, writesMs: null, commandsMs: null },
      cursors: null,
      transactions: { committedPerSec: null, abortedPerSec: null },
      errors: { regularPerSec: null, userPerSec: null, msgPerSec: null, cursorTimeoutsPerSec: null },
    })
  })

  it('says how long the server has been up and its version, and nothing of its host (user review 2026-10-09)', () => {
    const s = sampleFrom(null, raw({ uptime: 90_500 }))
    expect(s.uptimeSec).toBe(90)
    expect(s.version).toBe('8.0.4')
    expect(JSON.stringify(s)).not.toContain('db1')
    const status = { uptimeMillis: 5_000, version: '7.0.12', host: 'secret-host:27017', pid: 1 }
    expect(sampleFrom(null, rawFrom(status, 0))).toMatchObject({ uptimeSec: 5, version: '7.0.12' })
    expect(sampleFrom(null, rawFrom({ uptime: 3 }, 0)).version).toBeNull()
    expect(sampleFrom(null, rawFrom({ version: 'x'.repeat(200) }, 0)).version).toHaveLength(40)
  })

  it('starts from zero, and after a server restart starts again instead of going negative (Review Focus 2)', () => {
    expect(sampleFrom(null, raw({ at: 5 })).ops.insert).toBe(0)
    const before = raw({
      at: 0,
      uptime: 5_000,
      ops: { insert: 900, query: 0, update: 0, delete: 0, getmore: 0, command: 0 },
    })
    const after = raw({
      at: 2_000,
      uptime: 3,
      ops: { insert: 5, query: 0, update: 0, delete: 0, getmore: 0, command: 0 },
    })
    const s = sampleFrom(before, after)
    expect(s.restarted).toBe(true)
    expect(Object.values(s.ops).every((v) => v === 0)).toBe(true)
    expect([s.network.inPerSec, s.network.outPerSec]).toEqual([0, 0])
  })

  it('reads a real serverStatus', async () => {
    const t = await makeApp()
    apps.push(t)
    const { MongoClient } = await import('mongodb')
    const client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
    try {
      const r = rawFrom(await client.db('admin').command({ serverStatus: 1 }), 1)
      expect(r.uptime).toBeGreaterThan(0)
      expect(r.connections.current).toBeGreaterThan(0)
      expect(r.memory.residentMb).toBeGreaterThan(0)
      expect(r.cache?.maxBytes).toBeGreaterThan(0)
      expect(r.version).toMatch(/^\d+\.\d+/)
    } finally {
      await client.close()
    }
  })
})

// Widgets wave 2 (2026-10-27): how well queries use indexes, how long operations take, cursors,
// transactions and errors — from the same serverStatus.
describe('server samples: the wave 2 metrics', () => {
  const counters = (n: number): Partial<RawStatus> => ({
    scanned: { keys: 100 * n, docs: 400 * n, returned: 10 * n },
    latency: {
      reads: { micros: 2_000 * n, ops: 4 * n },
      writes: { micros: 9_000 * n, ops: 3 * n },
      commands: { micros: 500 * n, ops: 5 * n },
    },
    cursors: { open: 7, noTimeout: 1, timedOut: 2 * n },
    transactions: { committed: 6 * n, aborted: 2 * n },
    asserts: { regular: 0, user: 4 * n, msg: 2 * n },
  })

  it('divides what was scanned by what was returned, operation time by operations, and rates the rest', () => {
    const prev = raw({ at: 0, ...counters(1) })
    const next = raw({ at: 2_000, uptime: 102, ...counters(3) })
    const s = sampleFrom(prev, next)
    // 200 keys and 800 documents for 20 returned.
    expect(s.targeting).toEqual({ keysPerReturned: 10, docsPerReturned: 40 })
    // 4 000 µs over 8 reads, 18 000 µs over 6 writes, 1 000 µs over 10 commands.
    expect(s.latency).toEqual({ readsMs: 0.5, writesMs: 3, commandsMs: 0.1 })
    expect(s.cursors).toEqual({ open: 7, noTimeout: 1 })
    expect(s.transactions).toEqual({ committedPerSec: 6, abortedPerSec: 2 })
    expect(s.errors).toEqual({ regularPerSec: 0, userPerSec: 4, msgPerSec: 2, cursorTimeoutsPerSec: 2 })
  })

  it('measures none of them on a baseline, nor with nothing to divide by, nor when the server does not say', () => {
    const first = sampleFrom(null, raw(counters(1)))
    expect(first.targeting).toEqual({ keysPerReturned: null, docsPerReturned: null })
    expect(first.latency).toEqual({ readsMs: null, writesMs: null, commandsMs: null })
    expect(first.transactions).toEqual({ committedPerSec: null, abortedPerSec: null })
    expect(Object.values(first.errors).every((v) => v === null)).toBe(true)
    // Gauges are what they are, baseline or not.
    expect(first.cursors).toEqual({ open: 7, noTimeout: 1 })
    // Nothing returned, no operation: no ratio, no latency (never 0, never Infinity).
    const idle = sampleFrom(raw({ at: 0, ...counters(1) }), raw({ at: 1_000, uptime: 101, ...counters(1) }))
    expect(idle.targeting).toEqual({ keysPerReturned: null, docsPerReturned: null })
    expect(idle.latency).toEqual({ readsMs: null, writesMs: null, commandsMs: null })
    expect(idle.transactions).toEqual({ committedPerSec: 0, abortedPerSec: 0 })
    // An older server without these sections.
    const old = sampleFrom(rawFrom({ uptime: 1 }, 0), rawFrom({ uptime: 2 }, 1_000))
    expect(old.targeting).toEqual({ keysPerReturned: null, docsPerReturned: null })
    expect(old.latency).toEqual({ readsMs: null, writesMs: null, commandsMs: null })
    expect(old.cursors).toBeNull()
    expect(old.transactions).toEqual({ committedPerSec: null, abortedPerSec: null })
    expect(Object.values(old.errors).every((v) => v === null)).toBe(true)
  })

  it('measures none of them across a restart, nor from a reading that lacked the section', () => {
    // Counters start again at a restart; ones past the old values must not read as growth.
    const restarted = sampleFrom(
      raw({ at: 0, uptime: 9_000, ...counters(1) }),
      raw({ at: 2_000, uptime: 1_000, ...counters(5) }),
    )
    expect(restarted.restarted).toBe(true)
    expect(restarted.targeting).toEqual({ keysPerReturned: null, docsPerReturned: null })
    expect(restarted.latency).toEqual({ readsMs: null, writesMs: null, commandsMs: null })
    expect(restarted.transactions).toEqual({ committedPerSec: null, abortedPerSec: null })
    // The earlier reading went without the section (the fallback read): nothing to compare with.
    const after = sampleFrom(raw({ at: 0, uptime: 100 }), raw({ at: 2_000, uptime: 102, ...counters(5) }))
    expect(after.transactions).toEqual({ committedPerSec: null, abortedPerSec: null })
    expect(Object.values(after.errors).every((v) => v === null)).toBe(true)
  })

  it('reads the sections from serverStatus as MongoDB names them', () => {
    const status = (n: number) => ({
      uptime: n,
      metrics: {
        queryExecutor: { scanned: 50 * n, scannedObjects: 100 * n },
        document: { returned: 10 * n },
        cursor: { open: { total: 3, noTimeout: 0 }, timedOut: n },
      },
      opLatencies: {
        reads: { latency: 1_000 * n, ops: n },
        writes: { latency: 0, ops: 0 },
        commands: { latency: 300 * n, ops: 3 * n },
      },
      transactions: { totalCommitted: n, totalAborted: 0 },
      asserts: { regular: 0, warning: 0, msg: 0, user: n, rollovers: 0 },
    })
    const s = sampleFrom(rawFrom(status(1), 0), rawFrom(status(2), 1_000))
    expect(s.targeting).toEqual({ keysPerReturned: 5, docsPerReturned: 10 })
    expect(s.latency).toEqual({ readsMs: 1, writesMs: null, commandsMs: 0.1 })
    expect(s.cursors).toEqual({ open: 3, noTimeout: 0 })
    expect(s.transactions).toEqual({ committedPerSec: 1, abortedPerSec: 0 })
    expect(s.errors).toEqual({ regularPerSec: 0, userPerSec: 1, msgPerSec: 0, cursorTimeoutsPerSec: 1 })
  })

  it('asks a real server for them, without the heavy parts of its metrics', async () => {
    const { MongoClient } = await import('mongodb')
    const client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
    try {
      const status = await client.db('admin').command(STATUS)
      const metrics = status.metrics as Record<string, unknown>
      expect(metrics.queryExecutor).toBeDefined()
      expect(metrics.document).toBeDefined()
      expect(metrics.commands).toBeUndefined()
      expect(metrics.aggStageCounters).toBeUndefined()
      const r = rawFrom(status, 1)
      expect(r.scanned).not.toBeNull()
      expect(r.latency).not.toBeNull()
      expect(r.cursors).not.toBeNull()
      expect(r.asserts).not.toBeNull()
    } finally {
      await client.close()
    }
  })
})

describe('reading serverStatus for the charts', () => {
  const clientAnswering = (answer: (cmd: Record<string, unknown>) => unknown) => {
    const asked: Array<Record<string, unknown>> = []
    const client = {
      db: () => ({
        command: async (cmd: Record<string, unknown>) => {
          asked.push(cmd)
          return answer(cmd)
        },
      }),
    } as unknown as import('mongodb').MongoClient
    return { client, asked }
  }

  it('asks again without the metrics section a server that refuses its parts left out', async () => {
    const { client, asked } = clientAnswering((cmd) => {
      if (typeof cmd.metrics === 'object') throw Object.assign(new Error('bad'), { code: 9 })
      return { uptime: 1 }
    })
    expect(await readStatus(client, {})).toEqual({ uptime: 1 })
    expect(asked).toEqual([STATUS, STATUS_WITHOUT_METRICS])
  })

  // Review of wave 2 (M6): a server that refused once is asked without the section from then on.
  it('remembers a server that refuses the parts left out, asking it once a reading', async () => {
    const { client, asked } = clientAnswering((cmd) => {
      if (typeof cmd.metrics === 'object') throw Object.assign(new Error('bad'), { code: 9 })
      return { uptime: 1 }
    })
    await readStatus(client, {})
    await readStatus(client, {})
    expect(asked).toEqual([STATUS, STATUS_WITHOUT_METRICS, STATUS_WITHOUT_METRICS])
  })

  it('asks once, and says any other refusal as it is', async () => {
    const { client, asked } = clientAnswering(() => {
      throw Object.assign(new Error('no'), { code: 13 })
    })
    await expect(readStatus(client, {})).rejects.toMatchObject({ code: 13 })
    expect(asked).toHaveLength(1)
  })
})

describe('the monitor hub (Review Focus 3)', () => {
  it('samples while someone watches, and stops and lets the connection go when the last one leaves', async () => {
    const { MongoClient } = await import('mongodb')
    const client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
    let holds = 0
    const hub = new MonitorHub({
      client: async () => client,
      hold: () => {
        holds++
        return () => holds--
      },
      intervalMs: 40,
    })
    try {
      const a: unknown[] = []
      const b: unknown[] = []
      const offA = hub.subscribe('c1', (e) => a.push(e))
      const offB = hub.subscribe('c1', (e) => b.push(e))
      expect([hub.count('c1'), holds]).toEqual([2, 1])
      await new Promise((r) => setTimeout(r, 200))
      expect(a.length).toBeGreaterThanOrEqual(2)
      expect(a[0]).toMatchObject({ sample: { connections: expect.any(Object) } })
      offA()
      expect(holds).toBe(1)
      offB()
      expect([hub.count('c1'), holds]).toEqual([0, 0])
      const seen = b.length
      await new Promise((r) => setTimeout(r, 150))
      expect(b.length).toBe(seen)
    } finally {
      hub.close()
      await client.close()
    }
  })

  it('reports a server that refuses serverStatus as not permitted', async () => {
    const refusing = {
      db: () => ({
        command: async () => Promise.reject(Object.assign(new Error('not authorized'), { code: 13 })),
      }),
    } as unknown as import('mongodb').MongoClient
    const hub = new MonitorHub({ client: async () => refusing, hold: () => () => undefined, intervalMs: 20 })
    const events: unknown[] = []
    const off = hub.subscribe('c1', (e) => events.push(e))
    await new Promise((r) => setTimeout(r, 60))
    off()
    hub.close()
    expect(events[0]).toEqual({ error: 'NOT_PERMITTED' })
  })
})

type Message = { ch?: string; type: string; payload?: Record<string, unknown> }

async function setup(overrides: object = {}) {
  const t = await makeApp({ auth: true, ...overrides }, { monitor: { intervalMs: 50 } })
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
  const user = (role: Role) => {
    const record = ctx.users.create({ username: `u-${role}-${Math.random()}`, passwordHash: 'x', role })
    const { sessionId, session } = ctx.sessions.create(record.id, {})
    return { id: record.id, sessionId, csrf: session.csrfToken }
  }
  const socket = async (u: ReturnType<typeof user>) => {
    const messages: Message[] = []
    let closed = false
    const ws: WebSocket = await t.app.injectWS(
      '/ws',
      {
        headers: { ...H, cookie: `mm_sid=${u.sessionId}` },
        socket: { encrypted: false, remoteAddress: '127.0.0.1' },
      } as never,
      {
        onInit: (s) => {
          s.on('ping', () => s.pong())
          s.on('message', (d) => messages.push(JSON.parse(String(d))))
          s.on('close', () => (closed = true))
        },
      },
    )
    const send = (m: unknown) => ws.send(JSON.stringify(m))
    send({ type: 'hello', csrf: u.csrf })
    const wait = async (pred: (m: Message) => boolean, ms = 3_000) => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        const found = messages.find(pred)
        if (found) return found
        await new Promise((r) => setTimeout(r, 20))
      }
      throw new Error(`no such message in ${JSON.stringify(messages.slice(-3))}`)
    }
    await wait((m) => m.type === 'ready')
    return { ws, messages, send, wait, isClosed: () => closed }
  }
  const call = (u: ReturnType<typeof user>, url: string) =>
    t.app.inject({ method: 'GET', url, headers: H, cookies: { mm_sid: u.sessionId } })
  return { t, ctx, connectionId, user, socket, call }
}

describe('the monitor channel and the status route (phase 1i spec §3)', () => {
  it('streams samples to an editor, refuses a viewer, and allows three watches per socket', async () => {
    const { ctx, connectionId, user, socket } = await setup()
    const more = [1, 2, 3].map(
      (i) =>
        ctx.connections.create(
          {
            name: `M${i}`,
            favorite: false,
            readOnly: false,
            settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port: mongo.port }] }),
          },
          null,
        ).id,
    )
    const editor = await socket(user('editor'))
    editor.send({ ch: 'monitor', type: 'sub', connectionId })
    const sample = await editor.wait((m) => m.type === 'sample')
    expect(sample.payload).toMatchObject({ connectionId, connections: expect.any(Object), restarted: false })
    for (const id of more) editor.send({ ch: 'monitor', type: 'sub', connectionId: id })
    await editor.wait((m) => m.type === 'error' && m.payload?.code === 'TOO_MANY')
    const viewer = await socket(user('viewer'))
    viewer.send({ ch: 'monitor', type: 'sub', connectionId })
    expect((await viewer.wait((m) => m.type === 'error')).payload).toEqual({
      connectionId,
      code: 'FORBIDDEN',
    })
    expect(viewer.messages.some((m) => m.type === 'sample')).toBe(false)
  })

  it('stops the samples when access is lost, and forgets the watch when the socket closes', async () => {
    const { t, ctx, connectionId, user, socket } = await setup()
    const u = user('editor')
    const c = await socket(u)
    c.send({ ch: 'monitor', type: 'sub', connectionId })
    await c.wait((m) => m.type === 'sample')
    ctx.grants.set(connectionId, u.id, 'none')
    await c.wait((m) => m.type === 'error' && m.payload?.code === 'FORBIDDEN')
    await new Promise((r) => setTimeout(r, 100))
    const count = c.messages.length
    await new Promise((r) => setTimeout(r, 200))
    expect(c.messages.length).toBe(count)
    expect(ctx.monitor.count(connectionId)).toBe(0)
    ctx.grants.set(connectionId, u.id, 'editor')
    const before = c.messages.length
    c.send({ ch: 'monitor', type: 'sub', connectionId })
    await c.wait((m) => m.type === 'sample' && c.messages.indexOf(m) >= before)
    expect(ctx.monitor.count(connectionId)).toBe(1)
    // injectWS never tells the server that its client closed; end the server side as a dropped network would.
    for (const s of t.app.websocketServer.clients) s.terminate()
    for (let i = 0; i < 50 && ctx.monitor.count(connectionId) > 0; i++)
      await new Promise((r) => setTimeout(r, 20))
    expect(ctx.monitor.count(connectionId)).toBe(0)
  })

  it('answers the status route for the polling fallback, for server:monitor only', async () => {
    const { connectionId, user, call } = await setup()
    const url = `/api/connections/${connectionId}/server/status`
    const ok = await call(user('editor'), url)
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ connections: expect.any(Object), ops: expect.any(Object) })
    expect((await call(user('viewer'), url)).statusCode).toBe(403)
  })
})
