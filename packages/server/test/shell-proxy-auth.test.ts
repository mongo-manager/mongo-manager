// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import type { ConnectionSettings } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { forkShellWorker, type TestWorker } from './support/shell-worker'
import { ShellProxy } from '../src/shell/proxy/proxy'
import { SERVER_START_MS, slow } from './support/slowness'

/** Create a user with the given SCRAM mechanisms, connecting as root through the real driver. */
async function createUser(mongo: TestMongo, user: string, pwd: string, mechanisms: string[]): Promise<void> {
  const client = new MongoClient(
    `mongodb://admin:secret-pw@${mongo.host}:${mongo.port}/?authSource=admin&directConnection=true`,
  )
  try {
    await client
      .db('admin')
      .command({ createUser: user, pwd, roles: [{ role: 'readWriteAnyDatabase', db: 'admin' }], mechanisms })
  } finally {
    await client.close()
  }
}

/**
 * Phase 3a-1 spec §5.2: the proxy authenticates upstream so the worker, which holds no credential,
 * runs as the connection's user. Proven against a real authenticated MongoDB.
 */
const mongos: TestMongo[] = []
const proxies: ShellProxy[] = []
const workers: TestWorker[] = []
afterEach(async () => {
  for (const w of workers.splice(0)) w.close()
  for (const p of proxies.splice(0)) await p.close()
  for (const m of mongos.splice(0)) await m.stop()
})

async function run(settings: ConnectionSettings, mongo: TestMongo, code: string) {
  const proxy = new ShellProxy({
    settings,
    sessionId: 's',
    appName: 'mm-shell:auth',
    allowHost: (h, p) => h === mongo.host && p === mongo.port,
    tls: null,
  })
  proxies.push(proxy)
  const { port, token } = await proxy.listen()
  const worker = forkShellWorker()
  workers.push(worker)
  worker.send({
    type: 'init',
    proxyPort: port,
    token,
    uri: `mongodb://${mongo.host}:${mongo.port}/?directConnection=true&serverSelectionTimeoutMS=4000`,
    db: 'admin',
    appName: 'mm-shell:auth',
    syncTimeoutMs: 5_000,
  })
  await worker.next('ready', 20_000)
  return worker.evaluate(code)
}

const scramSettings = (mongo: TestMongo, mechanism: string): ConnectionSettings =>
  ({
    scheme: 'mongodb',
    hosts: [{ host: mongo.host, port: mongo.port }],
    auth: { mechanism, username: 'admin', password: 'secret-pw', authSource: 'admin' },
    tls: { enabled: false },
  }) as unknown as ConnectionSettings

describe('SCRAM upstream auth (phase 3a-1 §5.2)', () => {
  it(
    'authenticates with SCRAM-SHA-256 so the worker runs as the user',
    async () => {
      const mongo = await startMongo({ auth: { user: 'admin', password: 'secret-pw' } })
      mongos.push(mongo)
      const r = await run(
        scramSettings(mongo, 'SCRAM-SHA-256'),
        mongo,
        'db.runCommand({connectionStatus:1}).authInfo.authenticatedUsers.length',
      )
      expect(r.ok, r.ok ? '' : (r as { message: string }).message).toBe(true)
      expect(
        r.ok && Number((r.value as { $numberInt?: string })?.$numberInt ?? r.value),
      ).toBeGreaterThanOrEqual(1)
    },
    SERVER_START_MS,
  )

  it(
    'authenticates with SCRAM-SHA-1',
    async () => {
      const mongo = await startMongo({ auth: { user: 'admin', password: 'secret-pw' } })
      mongos.push(mongo)
      // The default root user carries only SHA-256 credentials; make one with SHA-1 too.
      await createUser(mongo, 'sha1user', 'sha1-pw', ['SCRAM-SHA-1'])
      const settings = {
        scheme: 'mongodb',
        hosts: [{ host: mongo.host, port: mongo.port }],
        auth: { mechanism: 'SCRAM-SHA-1', username: 'sha1user', password: 'sha1-pw', authSource: 'admin' },
        tls: { enabled: false },
      } as unknown as ConnectionSettings
      const r = await run(settings, mongo, 'db.runCommand({connectionStatus:1}).ok')
      expect(r.ok, r.ok ? '' : (r as { message: string }).message).toBe(true)
    },
    SERVER_START_MS,
  )

  it(
    'fails cleanly with a wrong password (the worker never gets the credential either way)',
    async () => {
      const mongo = await startMongo({ auth: { user: 'admin', password: 'secret-pw' } })
      mongos.push(mongo)
      const bad = {
        ...scramSettings(mongo, 'SCRAM-SHA-256'),
        auth: { mechanism: 'SCRAM-SHA-256', username: 'admin', password: 'wrong', authSource: 'admin' },
      } as unknown as ConnectionSettings
      const proxy = new ShellProxy({
        settings: bad,
        sessionId: 's',
        appName: 'mm-shell:auth',
        allowHost: () => true,
        tls: null,
      })
      proxies.push(proxy)
      const { port, token } = await proxy.listen()
      const worker = forkShellWorker()
      workers.push(worker)
      worker.send({
        type: 'init',
        proxyPort: port,
        token,
        uri: `mongodb://${mongo.host}:${mongo.port}/?directConnection=true&serverSelectionTimeoutMS=4000`,
        db: 'admin',
        appName: 'mm-shell:auth',
        syncTimeoutMs: 5_000,
      })
      // The upstream auth fails, so the proxy drops the connection and the worker reports a connect error.
      const first = await Promise.race([
        worker.next('ready', 20_000).then(() => 'ready' as const),
        worker.next('error', 20_000).then(() => 'error' as const),
      ])
      expect(first).toBe('error')
    },
    SERVER_START_MS,
  )
})

import net from 'node:net'
import { FrameSplitter, encodeFrame, encodeOpMsg, parseOpMsg, OP_MSG } from '../src/shell/proxy/wire'
import { openUpstream } from '../src/shell/proxy/upstream'

/**
 * A mock MongoDB that speaks just enough wire protocol to answer the handshake and capture the auth
 * command. It proves the proxy's MONGODB-X509 and PLAIN messages are well-formed without a live
 * X.509 / LDAP server (spec §5.2; the plan accepts this for PLAIN, and a real X.509 mongod is not
 * available in the test environment — see the ledger ruling).
 */
function mockMongo(
  onCommand: (cmd: Record<string, unknown>) => Record<string, unknown>,
): Promise<{ port: number; close: () => void }> {
  const server = net.createServer((socket) => {
    const splitter = new FrameSplitter()
    socket.on('data', (chunk: Buffer) => {
      for (const frame of splitter.push(chunk)) {
        if (frame.opCode !== OP_MSG) continue
        const { command } = parseOpMsg(frame.body)
        const reply = onCommand(command)
        const body = encodeOpMsg({ flags: 0, command: { ok: 1, ...reply }, sequences: [] })
        socket.write(encodeFrame({ requestID: 1, responseTo: frame.requestID, opCode: OP_MSG, body }))
      }
    })
    socket.on('error', () => socket.destroy())
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() }),
    ),
  )
}

describe('X509 and PLAIN upstream messages (phase 3a-1 §5.2)', () => {
  it(
    'sends a well-formed MONGODB-X509 authenticate command',
    async () => {
      let authCmd: Record<string, unknown> | null = null
      const mock = await mockMongo((cmd) => {
        if ('authenticate' in cmd) authCmd = cmd
        return { maxWireVersion: 21, isWritablePrimary: true }
      })
      const settings = {
        scheme: 'mongodb',
        hosts: [{ host: '127.0.0.1', port: mock.port }],
        auth: { mechanism: 'MONGODB-X509', username: 'CN=mm-client' },
        tls: { enabled: false },
      } as unknown as ConnectionSettings
      const up = await openUpstream(settings, '127.0.0.1', mock.port, { tls: null, appName: 'mm-shell:x509' })
      up.socket.destroy()
      mock.close()
      expect(authCmd).toMatchObject({
        authenticate: 1,
        mechanism: 'MONGODB-X509',
        user: 'CN=mm-client',
        $db: '$external',
      })
    },
    slow(20_000),
  )

  it(
    'sends a well-formed PLAIN saslStart payload',
    async () => {
      let start: Record<string, unknown> | null = null
      const mock = await mockMongo((cmd) => {
        if ('saslStart' in cmd) start = cmd
        return { maxWireVersion: 21, isWritablePrimary: true }
      })
      const settings = {
        scheme: 'mongodb',
        hosts: [{ host: '127.0.0.1', port: mock.port }],
        auth: { mechanism: 'PLAIN', username: 'ldapuser', password: 'ldappw', authSource: '$external' },
        tls: { enabled: false },
      } as unknown as ConnectionSettings
      const up = await openUpstream(settings, '127.0.0.1', mock.port, {
        tls: null,
        appName: 'mm-shell:plain',
      })
      up.socket.destroy()
      mock.close()
      expect(start).toMatchObject({ saslStart: 1, mechanism: 'PLAIN', $db: '$external' })
      const payload = (start as unknown as { payload: { buffer: Buffer } }).payload.buffer
      expect(Buffer.from(payload).toString('utf8')).toBe('\0ldapuser\0ldappw')
    },
    slow(20_000),
  )
})

/**
 * Phase 3a-1 spec §5.2, abuse cases: a hostile or broken upstream must never leave the proxy in a
 * half-authenticated state or hang — every malformed handshake or auth reply ends in a clean throw,
 * so the proxy drops the connection and the worker gets a connect error (never elevated access).
 */
describe('openUpstream rejects malformed or hostile handshakes (phase 3a-1 §5.2)', () => {
  const closers: Array<() => void> = []
  afterEach(() => {
    for (const c of closers.splice(0)) c()
  })
  const settings = (auth: Record<string, unknown>, port: number): ConnectionSettings =>
    ({
      scheme: 'mongodb',
      hosts: [{ host: '127.0.0.1', port }],
      auth,
      tls: { enabled: false },
    }) as unknown as ConnectionSettings

  const open = (
    auth: Record<string, unknown>,
    replies: (cmd: Record<string, unknown>) => Record<string, unknown>,
  ) =>
    (async () => {
      const mock = await mockMongo(replies)
      closers.push(mock.close)
      await openUpstream(settings(auth, mock.port), '127.0.0.1', mock.port, {
        tls: null,
        appName: 'mm-shell:t',
      })
    })()

  it('throws when the handshake itself fails (no ismaster/isWritablePrimary)', async () => {
    await expect(open({ mechanism: 'none' }, () => ({ ok: 0, errmsg: 'nope' }))).rejects.toThrow(
      /handshake failed/,
    )
  })

  it('throws when a SCRAM saslStart is rejected, after choosing SHA-1 for a SHA-1-only server', async () => {
    await expect(
      open({ mechanism: 'DEFAULT', username: 'u', password: 'p', authSource: 'admin' }, (cmd) =>
        'hello' in cmd
          ? { maxWireVersion: 21, isWritablePrimary: true, saslSupportedMechs: ['SCRAM-SHA-1'] }
          : { ok: 0, errmsg: 'auth denied' },
      ),
    ).rejects.toThrow(/saslStart failed/)
  })

  it('throws when a SCRAM saslStart reply carries no payload', async () => {
    await expect(
      open({ mechanism: 'SCRAM-SHA-256', username: 'u', password: 'p', authSource: 'admin' }, (cmd) =>
        'hello' in cmd ? { maxWireVersion: 21, isWritablePrimary: true } : { ok: 1, conversationId: 1 },
      ),
    ).rejects.toThrow(/no payload/)
  })

  it('throws when MONGODB-X509 authentication is refused', async () => {
    await expect(
      open({ mechanism: 'MONGODB-X509', username: 'CN=x' }, (cmd) =>
        'hello' in cmd ? { maxWireVersion: 21, isWritablePrimary: true } : { ok: 0, errmsg: 'bad cert' },
      ),
    ).rejects.toThrow(/X509 auth failed/)
  })

  it('throws when PLAIN authentication is refused', async () => {
    await expect(
      open({ mechanism: 'PLAIN', username: 'u', password: 'p', authSource: '$external' }, (cmd) =>
        'hello' in cmd ? { maxWireVersion: 21, isWritablePrimary: true } : { ok: 0, errmsg: 'ldap no' },
      ),
    ).rejects.toThrow(/PLAIN auth failed/)
  })
})

/**
 * Security audit 2026-10-16 (Important 3), spec §5.4: the proxy kills the session's operations with
 * the connection's own credentials — a user with no cluster privilege (no inprog, no killop) can,
 * for operations of their own.
 */
describe('killing a session’s operations as the connection’s user', () => {
  it('lists and kills only the session’s own operations, with no cluster privilege', async () => {
    const mongo = await startMongo({ auth: { user: 'admin', password: 'secret-pw' } })
    mongos.push(mongo)
    const root = new MongoClient(
      `mongodb://admin:secret-pw@${mongo.host}:${mongo.port}/?authSource=admin&directConnection=true`,
    )
    try {
      await root
        .db('shop')
        .command({ createUser: 'editor', pwd: 'editor-pw', roles: [{ role: 'readWrite', db: 'shop' }] })
      await root
        .db('shop')
        .collection('slow')
        .insertMany(Array.from({ length: 300 }, (_, i) => ({ i })))
      const settings = {
        scheme: 'mongodb',
        hosts: [{ host: mongo.host, port: mongo.port }],
        auth: { mechanism: 'SCRAM-SHA-256', username: 'editor', password: 'editor-pw', authSource: 'shop' },
        tls: { enabled: false },
      } as unknown as ConnectionSettings
      const proxy = new ShellProxy({
        settings,
        sessionId: 'k',
        appName: 'mm-shell:kill-test',
        allowHost: (h, p) => h === mongo.host && p === mongo.port,
        tls: null,
        // A slow scan needs server JavaScript; the policy is not what this test is about.
        allowServerJs: true,
      })
      proxies.push(proxy)
      const { port, token } = await proxy.listen()
      const worker = forkShellWorker()
      workers.push(worker)
      worker.send({
        type: 'init',
        proxyPort: port,
        token,
        uri: `mongodb://${mongo.host}:${mongo.port}/shop?directConnection=true&serverSelectionTimeoutMS=4000`,
        db: 'shop',
        appName: 'mm-shell:kill-test',
        syncTimeoutMs: 60_000,
      })
      await worker.next('ready', 20_000)
      // About 30 s of work on the server.
      worker.send({ type: 'eval', id: 7, code: "db.slow.find({ $where: 'sleep(100) || true' }).toArray()" })
      const ops = async () =>
        (
          (await root.db('admin').command({ currentOp: 1, appName: 'mm-shell:kill-test' })).inprog as Array<
            Record<string, unknown>
          >
        ).filter((op) => op.ns === 'shop.slow')
      await expect.poll(ops, { timeout: 15_000, interval: 200 }).toHaveLength(1)
      expect(await proxy.killOps()).toBe(1)
      await expect.poll(ops, { timeout: 5000, interval: 200 }).toHaveLength(0)
      // The shell hears that its operation was interrupted. MongoDB 9.0 says it in its JavaScript
      // engine's words ("wasm epoch interrupt: kill pending").
      const error = (await worker.next('error', 10_000)) as { message: string }
      expect(error.message).toMatch(/interrupt|kill/i)
    } finally {
      await root.close()
    }
  }, 120_000)
})
