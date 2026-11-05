// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import net from 'node:net'
import type { ConnectionSettings } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { forkShellWorker, type TestWorker } from './support/shell-worker'
import { ShellProxy } from '../src/shell/proxy/proxy'
import { supportedMechanism } from '../src/shell/proxy/upstream'
import { encodeFrame, OP_MSG } from '../src/shell/proxy/wire'
import { slow } from './support/slowness'

let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
}, slow(120_000))
afterAll(async () => {
  await mongo?.stop()
})

const settings = (): ConnectionSettings =>
  ({
    scheme: 'mongodb',
    hosts: [{ host: mongo.host, port: mongo.port }],
    auth: { mechanism: 'none' },
    tls: { enabled: false },
  }) as unknown as ConnectionSettings

const proxies: ShellProxy[] = []
const workers: TestWorker[] = []
afterEach(() => {
  for (const w of workers.splice(0)) w.close()
  for (const p of proxies.splice(0)) void p.close()
})

async function proxyFor(
  overrides: Partial<ConstructorParameters<typeof ShellProxy>[0]> = {},
): Promise<{ proxy: ShellProxy; port: number; token: string }> {
  const proxy = new ShellProxy({
    settings: settings(),
    sessionId: 's1',
    appName: 'mm-shell:s1',
    allowHost: (h, p) => h === mongo.host && p === mongo.port,
    tls: null,
    ...overrides,
  })
  proxies.push(proxy)
  const { port, token } = await proxy.listen()
  return { proxy, port, token }
}

/** A raw client that writes the preamble the worker would, to test the proxy without a worker. */
function rawPreamble(port: number, token: string, target: string): Promise<net.Socket> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const t = Buffer.from(target, 'utf8')
      const head = Buffer.alloc(34)
      Buffer.from(token, 'hex').copy(head, 0)
      head.writeUInt16BE(t.length, 32)
      socket.write(Buffer.concat([head, t]))
      resolve(socket)
    })
  })
}

describe('shell proxy: relay to MongoDB (phase 3a-1 §5)', () => {
  it(
    'relays a worker to MongoDB with no auth, rewriting its hello',
    async () => {
      const { port, token } = await proxyFor()
      const worker = forkShellWorker()
      workers.push(worker)
      worker.send({
        type: 'init',
        proxyPort: port,
        token,
        uri: `mongodb://${mongo.host}:${mongo.port}/?directConnection=true`,
        db: 'shop',
        appName: 'mm-shell:s1',
        syncTimeoutMs: 5_000,
      })
      await worker.next('ready', slow(20_000))
      const r = await worker.evaluate('db.proxycoll.insertOne({a:1}); db.proxycoll.countDocuments()')
      expect(r.ok).toBe(true)
    },
    slow(30_000),
  )

  it(
    "tags the worker's operations with the proxy appName for killOp",
    async () => {
      // $currentOp lists other users' operations: a connection admin's (security review 2026-10-13).
      const { port, token } = await proxyFor({ admin: true })
      const worker = forkShellWorker()
      workers.push(worker)
      worker.send({
        type: 'init',
        proxyPort: port,
        token,
        uri: `mongodb://${mongo.host}:${mongo.port}/?directConnection=true`,
        db: 'admin',
        appName: 'mm-shell:s1',
        syncTimeoutMs: 5_000,
      })
      await worker.next('ready', slow(20_000))
      const r = await worker.evaluate(
        'db.getSiblingDB("admin").aggregate([{$currentOp:{localOps:true}}]).toArray().map(o=>o.appName).filter(Boolean)',
      )
      expect(r.ok && JSON.stringify(r.value)).toContain('mm-shell:s1')
    },
    slow(30_000),
  )

  it(
    'relays a socket handed in via acceptHandle (the Node ≥25 path)',
    async () => {
      const { proxy, token } = await proxyFor()
      // Emulate the parent handing an accepted loopback socket to the proxy.
      const pair = net.createServer((serverSide) => proxy.acceptHandle(serverSide))
      await new Promise<void>((r) => pair.listen(0, '127.0.0.1', () => r()))
      const pairPort = (pair.address() as net.AddressInfo).port
      const client = await new Promise<net.Socket>((resolve) => {
        const c = net.connect(pairPort, '127.0.0.1', () => resolve(c))
      })
      const target = Buffer.from(`${mongo.host}:${mongo.port}`, 'utf8')
      const head = Buffer.alloc(34)
      Buffer.from(token, 'hex').copy(head, 0)
      head.writeUInt16BE(target.length, 32)
      client.write(Buffer.concat([head, target]))
      // A byte flows back once the upstream hello is relayed (the connection is live).
      const alive = await new Promise<boolean>((resolve) => {
        client.once('data', () => resolve(true))
        // Nudge the server with a hello via OP_MSG would need the driver; instead assert the socket
        // stays open (a rejected preamble would close it immediately).
        setTimeout(() => resolve(!client.destroyed), 500)
      })
      expect(alive).toBe(true)
      client.destroy()
      pair.close()
    },
    slow(20_000),
  )

  it(
    'drops the connection instead of crashing on a corrupt worker frame (review I3)',
    async () => {
      // A crafted/escaped worker could send a frame with a valid OP_MSG header but a body that is not
      // a valid OP_MSG. Parsing it throws; that throw must never escape the socket data handler (an
      // uncaught exception would take the whole server down). The proxy must just drop the connection.
      const { port, token } = await proxyFor()
      const socket = await rawPreamble(port, token, `${mongo.host}:${mongo.port}`)
      const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()))
      // Let relay authenticate upstream and start relaying (so the frame arrives via the data handler).
      await new Promise((r) => setTimeout(r, 800))
      const bad = encodeFrame({
        requestID: 9,
        responseTo: 0,
        opCode: OP_MSG,
        body: Buffer.from([0, 0, 0, 0, 0xff]),
      })
      socket.write(bad)
      await Promise.race([
        closed,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('proxy did not drop the connection')), 5000),
        ),
      ])
      // Reaching here means the process is still alive and the socket was dropped, not crashed.
      expect(socket.destroyed).toBe(true)
    },
    slow(20_000),
  )

  it(
    'enforces read-only in the proxy: a worker insert is refused, a find works',
    async () => {
      const { port, token } = await proxyFor({ readOnly: true })
      const worker = forkShellWorker()
      workers.push(worker)
      worker.send({
        type: 'init',
        proxyPort: port,
        token,
        uri: `mongodb://${mongo.host}:${mongo.port}/?directConnection=true`,
        db: 'shop',
        appName: 'mm-shell:ro',
        syncTimeoutMs: 5_000,
      })
      await worker.next('ready', slow(20_000))
      const write = await worker.evaluate('db.ro.insertOne({a:1})')
      expect(write.ok).toBe(false)
      expect(write.ok === false && write.message).toMatch(/Refused by Mongo Manager/)
      const read = await worker.evaluate('db.ro.find().toArray().length')
      expect(read.ok).toBe(true)
    },
    slow(30_000),
  )

  it(
    'reports a query origin lazily, and not at all for an over-sized frame (final review M9)',
    async () => {
      const seen: Array<() => unknown> = []
      const { port, token } = await proxyFor({ onQuery: (origin) => seen.push(origin) })
      const worker = forkShellWorker()
      workers.push(worker)
      worker.send({
        type: 'init',
        proxyPort: port,
        token,
        uri: `mongodb://${mongo.host}:${mongo.port}/shop?directConnection=true`,
        db: 'shop',
        appName: 'mm-shell:origin',
        syncTimeoutMs: 5_000,
      })
      await worker.next('ready', slow(20_000))
      // mongosh may run queries of its own; only those on collection "o" are this test's.
      const onO = () =>
        seen.map((origin) => origin() as { kind: string; coll: string } | null).filter((o) => o?.coll === 'o')
      expect((await worker.evaluate('db.o.find({ a: 1 }).toArray().length')).ok).toBe(true)
      expect(onO()).toEqual([expect.objectContaining({ kind: 'find', filter: { a: { $numberInt: '1' } } })])
      expect((await worker.evaluate('db.o.find({ x: "a".repeat(400 * 1024) }).toArray().length')).ok).toBe(
        true,
      )
      expect(onO()).toHaveLength(1)
    },
    slow(30_000),
  )

  it('closes a connection with a wrong token, opening no upstream', async () => {
    let upstreamOpened = false
    const { port } = await proxyFor({ allowHost: () => ((upstreamOpened = true), true) })
    const socket = await rawPreamble(port, 'aa'.repeat(32), `${mongo.host}:${mongo.port}`)
    await new Promise((r) => socket.once('close', r))
    expect(upstreamOpened).toBe(false)
  })

  it('closes a connection to a host outside the allow-list, opening no upstream', async () => {
    const { port, token } = await proxyFor({ allowHost: () => false })
    const socket = await rawPreamble(port, token, 'evil.example.com:27017')
    await new Promise((r) => socket.once('close', r))
    expect(socket.destroyed).toBe(true)
  })

  it('refuses more than the connection cap', async () => {
    const { port, token } = await proxyFor({ maxConnections: 2, allowHost: () => false })
    const a = await rawPreamble(port, token, `${mongo.host}:${mongo.port}`)
    const b = await rawPreamble(port, token, `${mongo.host}:${mongo.port}`)
    // A third connection is dropped immediately by the cap (before any preamble).
    const c = net.connect(port, '127.0.0.1')
    await new Promise((r) => c.once('close', r))
    expect(c.destroyed).toBe(true)
    a.destroy()
    b.destroy()
  })
})

describe('supported auth mechanisms (phase 3a-1 §5.2)', () => {
  it('accepts SCRAM, X509 and PLAIN but not GSSAPI, AWS or OIDC', () => {
    const withMech = (mechanism: string) =>
      ({ auth: { mechanism, username: 'u' } }) as unknown as ConnectionSettings
    expect(supportedMechanism(withMech('SCRAM-SHA-256'))).toBe(true)
    expect(supportedMechanism(withMech('MONGODB-X509'))).toBe(true)
    expect(supportedMechanism(withMech('PLAIN'))).toBe(true)
    expect(supportedMechanism(withMech('GSSAPI'))).toBe(false)
    expect(supportedMechanism(withMech('MONGODB-AWS'))).toBe(false)
    expect(supportedMechanism(withMech('MONGODB-OIDC'))).toBe(false)
  })
})
