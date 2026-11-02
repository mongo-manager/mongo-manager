import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConnectionSettings } from '@mongo-manager/shared'
import { ShellProxy } from '../src/shell/proxy/proxy'
import { FrameSplitter, encodeFrame, encodeOpMsg, parseOpMsg, OP_MSG } from '../src/shell/proxy/wire'

/**
 * Security review 2026-10-16 of the shell fixes (I-2, I-3, I-4 and the minors on the kill): the
 * session's operations are found by the connections the worker holds, not by a name it can change;
 * monitoring is told by the command's first field; one kill runs at a time and is cut off hard;
 * nothing but connection upkeep passes while no command runs; and what is still outstanding when a
 * command ends is known.
 */

type Reply = Record<string, unknown> | null
interface Mock {
  port: number
  /** Every command seen, with the appName of the connection it came on. */
  seen: Array<{ app: string; cmd: Record<string, unknown> }>
  closedKills: number
  close: () => void
}

/** A fake MongoDB: `answer` returns a reply, or null to never answer. Each connection gets an id. */
function mockMongo(
  answer: (cmd: Record<string, unknown>, app: string) => Reply,
  extraHello: Record<string, unknown> = {},
): Promise<Mock> {
  let nextId = 40
  const mock: Mock = { port: 0, seen: [], closedKills: 0, close: () => undefined }
  const server = net.createServer((socket) => {
    const connectionId = ++nextId
    let app = ''
    const splitter = new FrameSplitter()
    socket.on('data', (chunk: Buffer) => {
      for (const frame of splitter.push(chunk)) {
        if (frame.opCode !== OP_MSG) continue
        const { command } = parseOpMsg(frame.body)
        const client = command.client as { application?: { name?: string } } | undefined
        if (client?.application?.name) app = client.application.name
        mock.seen.push({ app, cmd: command })
        const reply =
          'hello' in command && client
            ? app.endsWith(':kill') && answer(command, app) === null
              ? null
              : { maxWireVersion: 21, isWritablePrimary: true, connectionId, ...extraHello }
            : answer(command, app)
        if (reply === null) continue
        const body = encodeOpMsg({ flags: 0, command: { ok: 1, ...reply }, sequences: [] })
        socket.write(encodeFrame({ requestID: 1, responseTo: frame.requestID, opCode: OP_MSG, body }))
      }
    })
    socket.on('close', () => {
      if (app.endsWith(':kill')) mock.closedKills++
    })
    socket.on('error', () => socket.destroy())
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      mock.port = (server.address() as net.AddressInfo).port
      mock.close = () => server.close()
      resolve(mock)
    }),
  )
}

const settingsFor = (port: number) =>
  ({
    scheme: 'mongodb',
    hosts: [{ host: '127.0.0.1', port }],
    auth: { mechanism: 'none' },
    tls: { enabled: false },
  }) as unknown as ConnectionSettings

/** A worker-like client of the proxy: the preamble, then OP_MSG commands; replies by request id. */
async function client(proxyPort: number, token: string, target: number) {
  const socket = net.connect(proxyPort, '127.0.0.1')
  await new Promise((r) => socket.once('connect', r))
  const name = Buffer.from(`127.0.0.1:${target}`)
  const head = Buffer.alloc(34)
  Buffer.from(token, 'hex').copy(head, 0)
  head.writeUInt16BE(name.length, 32)
  socket.write(Buffer.concat([head, name]))
  const replies = new Map<number, Record<string, unknown>>()
  const splitter = new FrameSplitter()
  socket.on('data', (chunk: Buffer) => {
    for (const frame of splitter.push(chunk)) replies.set(frame.responseTo, parseOpMsg(frame.body).command)
  })
  let id = 100
  return {
    socket,
    replies,
    send(command: Record<string, unknown>, flags = 0): number {
      const requestID = ++id
      const body = encodeOpMsg({ flags, command: { ...command, $db: 'shop' }, sequences: [] })
      socket.write(encodeFrame({ requestID, responseTo: 0, opCode: OP_MSG, body }))
      return requestID
    },
  }
}

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

async function setup(
  answer: (cmd: Record<string, unknown>, app: string) => Reply,
  options: { active?: () => boolean; killTimeoutMs?: number; hello?: Record<string, unknown> } = {},
) {
  const { hello, ...proxyOptions } = options
  const mock = await mockMongo(answer, hello)
  cleanup.push(() => mock.close())
  const proxy = new ShellProxy({
    settings: settingsFor(mock.port),
    sessionId: 'k',
    appName: 'mm-shell:k',
    allowHost: () => true,
    tls: null,
    ...proxyOptions,
  })
  cleanup.push(() => proxy.close())
  const { port, token } = await proxy.listen()
  const worker = await client(port, token, mock.port)
  cleanup.push(() => worker.socket.destroy())
  // The relay is up once a first command comes back.
  const ping = worker.send({ ping: 1 })
  await expect.poll(() => worker.replies.has(ping), { timeout: 5000 }).toBe(true)
  return { mock, proxy, worker }
}

const listingOf = (mock: Mock) => mock.seen.filter((s) => 'currentOp' in s.cmd).map((s) => s.cmd)
const killedOf = (mock: Mock) => mock.seen.filter((s) => 'killOp' in s.cmd).map((s) => s.cmd.op)

describe('killing the session’s operations', () => {
  it('finds them by the worker’s connections, and spares only real monitoring', async () => {
    const inprog = [
      { opid: 1, connectionId: 41, appName: 'mm-shell:k', command: { hello: 1, topologyVersion: {} } },
      // A command with a hello field is no monitoring (I-2: it dodged the kill).
      { opid: 2, connectionId: 41, appName: 'mm-shell:k', command: { dbHash: 1, hello: 1 } },
      // Filed under another appName ($client), still on the worker's connection.
      { opid: 3, connectionId: 41, appName: 'x', command: { find: 'c' } },
      // Another client's operation, whatever it calls itself.
      { opid: 4, connectionId: 99, appName: 'mm-shell:k', command: { find: 'c' } },
    ]
    const { mock, proxy } = await setup((cmd) => ('currentOp' in cmd ? { inprog } : {}))
    expect(await proxy.killOps()).toBe(2)
    expect(killedOf(mock)).toEqual([2, 3])
    expect(listingOf(mock)[0]).toMatchObject({ currentOp: 1, $ownOps: true, connectionId: { $in: [41] } })
  })

  // Second review 2026-10-16 (N-1): a mongos lists the shards' operations, whose connectionId is the
  // shard's id for the mongos→shard connection: it never matches ours, and may match another
  // client's by number. On a mongos only the session's own appName counts.
  it('on a mongos, kills by the session’s appName only, never by a shard-side connection id', async () => {
    const inprog = [
      // Ours, on a shard: a shard-side id that is not ours.
      { opid: 'sh0:11', shard: 'sh0', connectionId: 7, appName: 'mm-shell:k', command: { find: 'c' } },
      // Another client's, whose shard-side id happens to equal our connection's id.
      { opid: 'sh0:12', shard: 'sh0', connectionId: 41, appName: 'compass', command: { find: 'c' } },
      // Our driver's monitoring, on the mongos.
      { opid: 13, connectionId: 41, appName: 'mm-shell:k', command: { hello: 1 } },
    ]
    const { mock, proxy } = await setup((cmd) => ('currentOp' in cmd ? { inprog } : {}), {
      hello: { msg: 'isdbgrid' },
    })
    expect(await proxy.killOps()).toBe(1)
    expect(killedOf(mock)).toEqual(['sh0:11'])
    const listing = listingOf(mock)[0]!
    expect(listing).toMatchObject({ currentOp: 1, $ownOps: true, appName: 'mm-shell:k' })
    expect(listing).not.toHaveProperty('connectionId')
    expect(listing).not.toHaveProperty('$or')
  })

  it('on a mongod, kills by connection id only, never another connection’s same-named operation', async () => {
    const inprog = [
      { opid: 21, connectionId: 41, appName: 'mm-shell:k', command: { find: 'c' } },
      { opid: 22, connectionId: 55, appName: 'mm-shell:k', command: { find: 'c' } },
    ]
    const { mock, proxy } = await setup((cmd) => ('currentOp' in cmd ? { inprog } : {}))
    expect(await proxy.killOps()).toBe(1)
    expect(killedOf(mock)).toEqual([21])
  })

  it('runs one kill at a time: a second asked meanwhile shares the first', async () => {
    const { mock, proxy } = await setup((cmd) => ('currentOp' in cmd ? { inprog: [] } : {}))
    const [a, b] = await Promise.all([proxy.killOps(), proxy.killOps()])
    expect([a, b]).toEqual([0, 0])
    expect(listingOf(mock)).toHaveLength(1)
    expect(proxy.killing).toBe(false)
  })

  it('cuts a kill off hard at its time limit: its connection closes, nothing is sent after', async () => {
    const { mock, proxy } = await setup((_, app) => (app.endsWith(':kill') ? null : {}), {
      killTimeoutMs: 300,
    })
    const started = Date.now()
    expect(await proxy.killOps()).toBe(0)
    expect(Date.now() - started).toBeLessThan(2000)
    await expect.poll(() => mock.closedKills, { timeout: 2000 }).toBe(1)
    await new Promise((r) => setTimeout(r, 300))
    expect(listingOf(mock)).toHaveLength(0)
  })
})

describe('commands while no command runs (I-3)', () => {
  it('refuses everything but connection upkeep while the session is idle', async () => {
    let active = true
    const { mock, worker } = await setup(() => ({}), { active: () => active })
    active = false
    const find = worker.send({ find: 'c', filter: {} })
    const agg = worker.send({ aggregate: 'c', pipeline: [], cursor: {} })
    const upkeep = [
      worker.send({ hello: 1 }),
      worker.send({ endSessions: [] }),
      worker.send({ killCursors: 'c', cursors: [] }),
    ]
    await expect.poll(() => worker.replies.size, { timeout: 5000 }).toBeGreaterThanOrEqual(6)
    expect(worker.replies.get(find)).toMatchObject({
      ok: 0,
      errmsg: expect.stringMatching(/no command is running/),
    })
    expect(worker.replies.get(agg)).toMatchObject({ ok: 0 })
    for (const id of upkeep) expect(worker.replies.get(id)).toMatchObject({ ok: 1 })
    expect(mock.seen.some((s) => 'find' in s.cmd || 'aggregate' in s.cmd)).toBe(false)
  })

  it('knows when a command still waits for its answer, monitoring aside', async () => {
    let hold = true
    const { proxy, worker } = await setup((cmd) => ('find' in cmd && hold ? null : {}))
    expect(proxy.busy()).toBe(false)
    worker.send({ find: 'c', filter: {} })
    await expect.poll(() => proxy.busy(), { timeout: 5000 }).toBe(true)
    hold = false
    worker.send({ hello: 1 })
    await new Promise((r) => setTimeout(r, 100))
    expect(proxy.busy()).toBe(true)
  })

  // Second review 2026-10-16 (minor): an unacknowledged write (moreToCome: no reply ever comes) left
  // running escaped the kill at a command's end.
  it('remembers a request that gets no answer, until the command it was sent in ends', async () => {
    const { proxy, worker } = await setup(() => ({}))
    expect(proxy.endCommand()).toBe(false)
    worker.send({ insert: 'c', documents: [{ a: 1 }], writeConcern: { w: 0 } }, 1 << 1)
    await expect.poll(() => proxy.busy(), { timeout: 5000 }).toBe(true)
    // Asked once at the command's end: outstanding then, forgotten after.
    expect(proxy.endCommand()).toBe(true)
    expect(proxy.endCommand()).toBe(false)
  })
})
