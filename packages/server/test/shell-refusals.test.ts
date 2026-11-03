import { afterEach, describe, expect, it, vi } from 'vitest'
import net from 'node:net'
import { MongoClient, MongoServerError } from 'mongodb'
import { ConnectionSettingsSchema, type ConnectionSettings } from '@mongo-manager/shared'
import { ShellProxy } from '../src/shell/proxy/proxy'
import { openUpstream } from '../src/shell/proxy/upstream'
import { ShellManager } from '../src/shell/manager'
import { EventEmitter } from 'node:events'
import { FrameSplitter, encodeFrame, encodeOpMsg, parseOpMsg, OP_MSG } from '../src/shell/proxy/wire'
import { ConnectionManager } from '../src/connections/manager'
import { ConnectionError } from '../src/connections/errors'
import { shellClient } from '../src/shell/plan-client'

/**
 * Fifth review of the unreachable fix (I1): the shell signed in again after a refusal: its plan
 * dropped a kept refusal and opened the session anyway, and its proxy signed in on every socket the
 * worker's driver opened (each retry of the server selection, each reconnect): a directory's lockout
 * threshold was crossed at once. A kept refusal opens no shell, and a session that was refused once
 * dials no more, saying so to the connection manager.
 */

type SignIn = (n: number) => Record<string, unknown>
const REFUSED: SignIn = () => ({
  ok: 0,
  code: 18,
  codeName: 'AuthenticationFailed',
  errmsg: 'Authentication failed.',
})

/** A MongoDB that answers the handshake, and each sign-in as `answer` says, counting them. */
function refusingMongo(
  answer: SignIn = REFUSED,
  hold = 0,
): Promise<{ port: number; signIns: () => number; close: () => void }> {
  let signIns = 0
  let connections = 0
  const server = net.createServer((socket) => {
    const splitter = new FrameSplitter()
    socket.on('data', (chunk: Buffer) => {
      for (const frame of splitter.push(chunk)) {
        if (frame.opCode !== OP_MSG) continue
        const { command } = parseOpMsg(frame.body)
        let reply: Record<string, unknown>
        if ('hello' in command)
          reply = { ok: 1, maxWireVersion: 21, isWritablePrimary: true, connectionId: ++connections }
        else if ('saslStart' in command || 'authenticate' in command) reply = answer(++signIns)
        else reply = { ok: 1, inprog: [] }
        const body = encodeOpMsg({ flags: 0, command: reply, sequences: [] })
        const send = () =>
          socket.write(encodeFrame({ requestID: 1, responseTo: frame.requestID, opCode: OP_MSG, body }))
        if (hold && !('hello' in command)) setTimeout(send, hold)
        else send()
      }
    })
    socket.on('error', () => socket.destroy())
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        signIns: () => signIns,
        close: () => server.close(),
      }),
    ),
  )
}

/** What the worker's driver does: a socket to the proxy, its token, and the host it wants. */
function dial(proxyPort: number, token: string, target: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      const name = Buffer.from(target, 'utf8')
      const length = Buffer.alloc(2)
      length.writeUInt16BE(name.length)
      socket.write(Buffer.concat([Buffer.from(token, 'hex'), length, name]))
      // A hello, as the driver sends first (the proxy signs in once the preamble is read).
      const body = encodeOpMsg({ flags: 0, command: { hello: 1, $db: 'admin' }, sequences: [] })
      socket.write(encodeFrame({ requestID: 1, responseTo: 0, opCode: OP_MSG, body }))
    })
    socket.on('close', () => resolve())
    socket.on('error', () => undefined)
  })
}

const closers: Array<() => void | Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  // Last made, first closed: a proxy closes once the sockets to it are gone.
  for (const c of closers.splice(0).reverse()) await c()
})

describe("a shell session's sign-in", () => {
  const proxyFor = (port: number, mechanism = 'SCRAM-SHA-256', refused = vi.fn()) => {
    const settings = ConnectionSettingsSchema.parse({
      hosts: [{ host: '127.0.0.1', port }],
      auth: {
        mechanism,
        username: 'u',
        password: 'wrong',
        authSource: mechanism === 'PLAIN' ? '$external' : 'admin',
      },
    })
    const proxy = new ShellProxy({
      settings,
      sessionId: 's',
      connectionId: 'c1',
      appName: 'mm-shell:refused',
      allowHost: (h, p) => h === '127.0.0.1' && p === port,
      tls: null,
      onRefused: refused,
    })
    closers.push(() => proxy.close())
    return { proxy, refused }
  }

  it("is tried once when the worker's driver opens many sockets at once (sixth review, I1)", async () => {
    const mongo = await refusingMongo(REFUSED, 50)
    closers.push(mongo.close)
    const { proxy, refused } = proxyFor(mongo.port)
    const { port, token } = await proxy.listen()
    await Promise.all(Array.from({ length: 5 }, () => dial(port, token, `127.0.0.1:${mongo.port}`)))
    expect(mongo.signIns()).toBe(1)
    expect(refused).toHaveBeenCalledTimes(1)
  })

  it('is not taken for refused when the server answered otherwise, a shutdown say (sixth review, I2)', async () => {
    const mongo = await refusingMongo(() => ({
      ok: 0,
      code: 91,
      codeName: 'ShutdownInProgress',
      errmsg: 'shutting down',
    }))
    closers.push(mongo.close)
    const { proxy, refused } = proxyFor(mongo.port)
    const { port, token } = await proxy.listen()
    for (let i = 0; i < 3; i++) await dial(port, token, `127.0.0.1:${mongo.port}`)
    expect(refused).not.toHaveBeenCalled()
    // Each socket tried: nothing was refused.
    expect(mongo.signIns()).toBe(3)
  })

  it('says nothing of a refusal met once the session was closed (sixth review, M1)', async () => {
    const mongo = await refusingMongo(REFUSED, 100)
    closers.push(mongo.close)
    const { proxy, refused } = proxyFor(mongo.port)
    const { port, token } = await proxy.listen()
    const dialled = dial(port, token, `127.0.0.1:${mongo.port}`)
    await new Promise((r) => setTimeout(r, 30))
    await proxy.close()
    await dialled
    await new Promise((r) => setTimeout(r, 150))
    expect(refused).not.toHaveBeenCalled()
  })

  it('kills no operation once refused: no sign-in for it (sixth review, M3)', async () => {
    // PLAIN: one saslStart; the first passes, every later one is refused.
    const mongo = await refusingMongo((n) => (n === 1 ? { ok: 1, done: true } : REFUSED(n)))
    closers.push(mongo.close)
    const { proxy, refused } = proxyFor(mongo.port, 'PLAIN')
    const { port, token } = await proxy.listen()
    const kept = new Promise<void>((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        const name = Buffer.from(`127.0.0.1:${mongo.port}`, 'utf8')
        const length = Buffer.alloc(2)
        length.writeUInt16BE(name.length)
        socket.write(Buffer.concat([Buffer.from(token, 'hex'), length, name]))
        resolve()
      })
      closers.push(() => void socket.destroy())
    })
    await kept
    await new Promise((r) => setTimeout(r, 100))
    await dial(port, token, `127.0.0.1:${mongo.port}`)
    expect(refused).toHaveBeenCalledTimes(1)
    const before = mongo.signIns()
    await proxy.killOps()
    expect(mongo.signIns()).toBe(before)
  })

  it('is tried once: after the server refused it, the session dials no more and says so', async () => {
    const mongo = await refusingMongo()
    closers.push(mongo.close)
    const refused = vi.fn()
    const settings = ConnectionSettingsSchema.parse({
      hosts: [{ host: '127.0.0.1', port: mongo.port }],
      auth: { mechanism: 'SCRAM-SHA-256', username: 'u', password: 'wrong', authSource: 'admin' },
    })
    const proxy = new ShellProxy({
      settings,
      sessionId: 's',
      connectionId: 'c1',
      appName: 'mm-shell:refused',
      allowHost: (h, p) => h === '127.0.0.1' && p === mongo.port,
      tls: null,
      onRefused: refused,
    })
    closers.push(() => proxy.close())
    const { port, token } = await proxy.listen()
    for (let i = 0; i < 4; i++) await dial(port, token, `127.0.0.1:${mongo.port}`)
    expect(mongo.signIns()).toBe(1)
    expect(refused).toHaveBeenCalledTimes(1)
  })
})

describe('the client a shell is planned with', () => {
  const settings: ConnectionSettings = ConnectionSettingsSchema.parse({
    hosts: [{ host: 'db', port: 27017 }],
  })
  const managerFailing = (fail: () => Error) => {
    const m = new ConnectionManager({
      load: () => ({ settings }),
      createClient: () =>
        ({
          connect: async () => {
            throw fail()
          },
          close: async () => undefined,
          db: () => ({ command: async () => ({}) }),
        }) as unknown as MongoClient,
    })
    closers.push(() => m.closeAll(1_000))
    return m
  }

  it('is refused with the sign-in the server refused, kept or not: no shell opens', async () => {
    const m = managerFailing(
      () =>
        new MongoServerError({
          code: 18,
          codeName: 'AuthenticationFailed',
          errmsg: 'Authentication failed.',
        }),
    )
    for (let i = 0; i < 2; i++) {
      const e = await shellClient(m, 'c1').catch((err: unknown) => err)
      expect(e).toBeInstanceOf(ConnectionError)
      expect(e).toMatchObject({ kind: 'auth' })
    }
  })

  it("is refused while a refusal is kept, though the connection's client is still open (sixth review, I1)", async () => {
    const m = new ConnectionManager({
      load: () => ({ settings }),
      createClient: () =>
        ({
          connect: async () => undefined,
          close: async () => undefined,
          db: () => ({ command: async () => ({ version: '8.0.0' }) }),
        }) as unknown as MongoClient,
    })
    closers.push(() => m.closeAll(1_000))
    await m.getClient('c1')
    m.noteRefusal('c1', new ConnectionError('auth', 'refused'))
    expect(await shellClient(m, 'c1').catch((e: unknown) => e)).toMatchObject({
      kind: 'auth',
      remembered: true,
    })
  })

  it('is none when the server is only out of reach: the shell says so itself', async () => {
    const m = managerFailing(() => new Error('connect ECONNREFUSED 127.0.0.1:27017'))
    expect(await shellClient(m, 'c1')).toBeUndefined()
  })

  it('a refusal the shell met is kept for the connection: its pages do not sign in again', async () => {
    let dials = 0
    const m = new ConnectionManager({
      load: () => ({ settings }),
      createClient: () => {
        dials++
        return {
          connect: async () => undefined,
          close: async () => undefined,
          db: () => ({ command: async () => ({ version: '8.0.0' }) }),
        } as unknown as MongoClient
      },
    })
    closers.push(() => m.closeAll(1_000))
    m.noteRefusal('c1', new ConnectionError('auth', 'Authentication failed'))
    expect(await m.getClient('c1').catch((e: unknown) => e)).toMatchObject({ kind: 'auth', remembered: true })
    expect(dials).toBe(0)
  })
})

/** A server that takes the connection and never says a word. */
function silentMongo(): Promise<{ port: number; close: () => void }> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => socket.destroy())
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () => {
          for (const s of sockets) s.destroy()
          server.close()
        },
      }),
    ),
  )
}

describe('a shell session signing in, seventh review', () => {
  const proxyTo = (ports: number[], settingsOver: Record<string, unknown> = {}, refused = vi.fn()) => {
    const settings = ConnectionSettingsSchema.parse({
      hosts: ports.map((port) => ({ host: '127.0.0.1', port })),
      auth: { mechanism: 'SCRAM-SHA-256', username: 'u', password: 'wrong', authSource: 'admin' },
      ...settingsOver,
    })
    const proxy = new ShellProxy({
      settings,
      sessionId: 's',
      connectionId: 'c1',
      appName: 'mm-shell:seventh',
      allowHost: (h, p) => h === '127.0.0.1' && ports.includes(p),
      tls: null,
      onRefused: refused,
    })
    closers.push(() => proxy.close())
    return { proxy, refused }
  }

  it("knows Atlas's refusal by its words (I3)", async () => {
    const mongo = await refusingMongo(() => ({
      ok: 0,
      code: 8000,
      codeName: 'AtlasError',
      errmsg: 'bad auth : authentication failed',
    }))
    closers.push(mongo.close)
    const { proxy, refused } = proxyTo([mongo.port])
    const { port, token } = await proxy.listen()
    for (let i = 0; i < 3; i++) await dial(port, token, `127.0.0.1:${mongo.port}`)
    expect(mongo.signIns()).toBe(1)
    expect(refused).toHaveBeenCalledTimes(1)
  })

  it('holds no member back behind one that does not answer (I2)', async () => {
    const silent = await silentMongo()
    const mongo = await refusingMongo()
    closers.push(silent.close, mongo.close)
    const { proxy, refused } = proxyTo([silent.port, mongo.port])
    const { port, token } = await proxy.listen()
    void dial(port, token, `127.0.0.1:${silent.port}`)
    await new Promise((r) => setTimeout(r, 50))
    const started = Date.now()
    await dial(port, token, `127.0.0.1:${mongo.port}`)
    // The member that answers was signed in to (and refused) while the silent one still waits:
    // not after the silent one's handshake gave up (15 s).
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(mongo.signIns()).toBe(1)
    expect(refused).toHaveBeenCalledTimes(1)
  })

  it('gives up a handshake a server took and never answered, in time (I2)', async () => {
    const silent = await silentMongo()
    closers.push(silent.close)
    const settings = ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port: silent.port }] })
    const started = Date.now()
    await expect(
      openUpstream(settings, '127.0.0.1', silent.port, { tls: null, appName: 't', handshakeTimeoutMs: 200 }),
    ).rejects.toThrow(/handshake timeout/)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('dials nothing for a socket the worker closed while it waited (M1)', async () => {
    const mongo = await refusingMongo(() => ({ ok: 1, done: true }), 200)
    closers.push(mongo.close)
    const { proxy } = proxyTo([mongo.port], {
      auth: { mechanism: 'PLAIN', username: 'u', password: 'p', authSource: '$external' },
    })
    const { port, token } = await proxy.listen()
    void dial(port, token, `127.0.0.1:${mongo.port}`)
    await new Promise((r) => setTimeout(r, 30))
    const gone = net.connect(port, '127.0.0.1', () => {
      const name = Buffer.from(`127.0.0.1:${mongo.port}`, 'utf8')
      const length = Buffer.alloc(2)
      length.writeUInt16BE(name.length)
      gone.write(Buffer.concat([Buffer.from(token, 'hex'), length, name]))
      setTimeout(() => gone.destroy(), 30)
    })
    gone.on('error', () => undefined)
    await new Promise((r) => setTimeout(r, 500))
    expect(mongo.signIns()).toBe(1)
  })
})

describe('a shell whose sign-in the server refused (seventh review, I1)', () => {
  /** A worker of the test's: on init it dials the proxy as the driver would; ready only if told. */
  class DialingWorker extends EventEmitter {
    pid = 4321
    stderr = new EventEmitter()
    constructor(
      private readonly target: string,
      private readonly readyFirst: boolean,
    ) {
      super()
    }
    send(msg: { type?: string; proxyPort?: number; token?: string }): boolean {
      if (msg.type !== 'init') return true
      const go = () => void dial(msg.proxyPort!, msg.token!, this.target)
      if (this.readyFirst) {
        queueMicrotask(() => this.emit('message', { type: 'ready', prompt: '>' }))
        setTimeout(go, 50)
      } else go()
      return true
    }
    kill(): boolean {
      this.emit('exit', null, 'SIGKILL')
      return true
    }
  }
  const managerAt = (port: number, readyFirst: boolean) => {
    const settings = ConnectionSettingsSchema.parse({
      hosts: [{ host: '127.0.0.1', port }],
      auth: { mechanism: 'SCRAM-SHA-256', username: 'u', password: 'wrong', authSource: 'admin' },
    })
    const refused = vi.fn()
    const m = new ShellManager({
      config: { shell: { maxPerUser: 3, maxTotal: 20, commandTimeoutMs: 60_000, idleMs: 0, lifetimeMs: 0 } },
      now: () => Date.now(),
      log: { warn() {}, info() {}, error() {} },
      audit: () => undefined,
      plan: () => ({
        settings,
        readOnly: false,
        admin: false,
        allowHost: (h: string, p: number) => h === '127.0.0.1' && p === port,
        tls: null,
      }),
      bundlePath: '/fake/worker.cjs',
      killGraceMs: 20,
      spawnFn: (() => new DialingWorker(`127.0.0.1:${port}`, readyFirst)) as never,
      rss: null,
      onRefused: refused,
    })
    closers.push(() => m.shutdown())
    return { m, refused }
  }
  const caller = { owner: 'local', readOnly: false, admin: false } as never

  it('fails the open at once, as the refusal, not when the start times out', async () => {
    const mongo = await refusingMongo()
    closers.push(mongo.close)
    const { m, refused } = managerAt(mongo.port, false)
    const started = Date.now()
    const e = await m.open(caller, 'c1', 'admin').catch((err: unknown) => err)
    expect(e).toBeInstanceOf(ConnectionError)
    expect(e).toMatchObject({ kind: 'auth' })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(refused).toHaveBeenCalledWith('c1')
  })

  it('ends a session refused later, saying why', async () => {
    const mongo = await refusingMongo()
    closers.push(mongo.close)
    const { m } = managerAt(mongo.port, true)
    const ended = vi.fn()
    m.onEnded(ended)
    const { sessionId } = await m.open(caller, 'c1', 'admin')
    await vi.waitFor(() => expect(ended).toHaveBeenCalledWith(sessionId, 'refused'), { timeout: 5_000 })
  })
})

describe('a shell signing in, final review', () => {
  it('waits once per server dialled: over SSH every member is the one tunnel', async () => {
    const mongo = await refusingMongo(REFUSED, 50)
    closers.push(mongo.close)
    const settings = ConnectionSettingsSchema.parse({
      hosts: [
        { host: 'a.example', port: 27017 },
        { host: 'b.example', port: 27017 },
      ],
      auth: { mechanism: 'SCRAM-SHA-256', username: 'u', password: 'wrong', authSource: 'admin' },
    })
    const refused = vi.fn()
    const proxy = new ShellProxy({
      settings,
      sessionId: 's',
      connectionId: 'c1',
      appName: 'mm-shell:ssh',
      allowHost: () => true,
      tls: null,
      // As a tunnel: every member named is the one endpoint.
      dial: () => ({ host: '127.0.0.1', port: mongo.port }),
      onRefused: refused,
    })
    closers.push(() => proxy.close())
    const { port, token } = await proxy.listen()
    await Promise.all([dial(port, token, 'a.example:27017'), dial(port, token, 'b.example:27017')])
    expect(mongo.signIns()).toBe(1)
  })

  it('gives up a handshake that trickles in, at its deadline (not an idle timer)', async () => {
    const sockets = new Set<net.Socket>()
    const server = net.createServer((socket) => {
      sockets.add(socket)
      socket.on('error', () => undefined)
      // A byte at a time, for ever: never idle, never answering.
      const drip = setInterval(() => socket.write(Buffer.from([0])), 50)
      socket.on('close', () => clearInterval(drip))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    closers.push(() => {
      for (const s of sockets) s.destroy()
      server.close()
    })
    const port = (server.address() as net.AddressInfo).port
    const settings = ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port }] })
    const started = Date.now()
    await expect(
      openUpstream(settings, '127.0.0.1', port, { tls: null, appName: 't', handshakeTimeoutMs: 300 }),
    ).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(3_000)
  })
})

describe('a shell restarting when its sign-in is refused (final review)', () => {
  /** A worker that is ready at once and dials nothing, then stops: the manager restarts it. */
  class QuietWorker extends EventEmitter {
    pid = 1111
    stderr = new EventEmitter()
    send(msg: { type?: string }): boolean {
      if (msg.type === 'init') queueMicrotask(() => this.emit('message', { type: 'ready', prompt: '>' }))
      return true
    }
    kill(): boolean {
      this.emit('exit', null, 'SIGKILL')
      return true
    }
  }
  /** Its restart: dials the proxy, as the driver would, and is never ready. */
  class RestartWorker extends EventEmitter {
    pid = 2222
    stderr = new EventEmitter()
    constructor(private readonly target: string) {
      super()
    }
    send(msg: { type?: string; proxyPort?: number; token?: string }): boolean {
      if (msg.type === 'init') void dial(msg.proxyPort!, msg.token!, this.target)
      return true
    }
    kill(): boolean {
      this.emit('exit', null, 'SIGKILL')
      return true
    }
  }

  it('ends as refused, not as crashed', async () => {
    const mongo = await refusingMongo()
    closers.push(mongo.close)
    const settings = ConnectionSettingsSchema.parse({
      hosts: [{ host: '127.0.0.1', port: mongo.port }],
      auth: { mechanism: 'SCRAM-SHA-256', username: 'u', password: 'wrong', authSource: 'admin' },
    })
    const workers: EventEmitter[] = []
    const m = new ShellManager({
      config: { shell: { maxPerUser: 3, maxTotal: 20, commandTimeoutMs: 60_000, idleMs: 0, lifetimeMs: 0 } },
      now: () => Date.now(),
      log: { warn() {}, info() {}, error() {} },
      audit: () => undefined,
      plan: () => ({
        settings,
        readOnly: false,
        admin: false,
        allowHost: (h: string, p: number) => h === '127.0.0.1' && p === mongo.port,
        tls: null,
      }),
      bundlePath: '/fake/worker.cjs',
      killGraceMs: 20,
      spawnFn: (() => {
        const w = workers.length === 0 ? new QuietWorker() : new RestartWorker(`127.0.0.1:${mongo.port}`)
        workers.push(w)
        return w
      }) as never,
      rss: null,
    })
    closers.push(() => m.shutdown())
    const ended = vi.fn()
    m.onEnded(ended)
    const { sessionId } = await m.open(
      { owner: 'local', readOnly: false, admin: false } as never,
      'c1',
      'admin',
    )
    // The worker stops: the manager starts another, whose sign-in the server refuses.
    workers[0]!.emit('exit', 1, null)
    await vi.waitFor(() => expect(ended).toHaveBeenCalled(), { timeout: 5_000 })
    expect(ended).toHaveBeenCalledWith(sessionId, 'refused')
  })
})
