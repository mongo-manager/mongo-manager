import { afterEach, describe, expect, it } from 'vitest'
import net from 'node:net'
import { acceptSocks, newSocksCredentials, socksConnect } from '../src/connections/socks'

// Plan 1c deferred minor: the SSH tunnel's local endpoint is this SOCKS5 server. It is the only
// thing between another program on the machine and the database behind the tunnel.
const servers: net.Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r))
})

const credentials = newSocksCredentials()

/** A tunnel endpoint whose one target echoes what it gets, prefixed so its bytes are told apart. */
async function endpoint(
  handshakeMs?: number,
  connect: () => Promise<unknown> = async () => undefined,
): Promise<{ port: number; outcomes: string[] }> {
  const outcomes: string[] = []
  const server = net.createServer((socket) => {
    socket.on('error', () => undefined)
    acceptSocks(socket, credentials, connect, handshakeMs).then(
      () => {
        outcomes.push('accepted')
        socket.on('data', (d: Buffer) => socket.write(Buffer.concat([Buffer.from('echo:'), d])))
        socket.resume()
      },
      (e: Error) => outcomes.push(e.message),
    )
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { port: (server.address() as net.AddressInfo).port, outcomes }
}

/** Writes the given chunks, collects all the endpoint answers until it closes (or 2 s pass). */
const exchange = (port: number, ...chunks: Buffer[]) =>
  new Promise<Buffer>((resolve) => {
    const got: Buffer[] = []
    const socket = net.connect(port, '127.0.0.1', () => {
      for (const c of chunks) socket.write(c)
    })
    socket.on('data', (d: Buffer) => got.push(d))
    socket.on('error', () => undefined)
    socket.on('close', () => resolve(Buffer.concat(got)))
    setTimeout(() => socket.destroy(), 2_000)
  })

const greeting = Buffer.from([5, 1, 2])
const auth = (user = credentials.username, pass = credentials.password) => {
  const u = Buffer.from(user)
  const p = Buffer.from(pass)
  return Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p])
}
const request = (command = 1) => Buffer.from([5, command, 0, 1, 127, 0, 0, 1, 0x69, 0x87])
const OK = [5, 2, 1, 0, 5, 0, 0, 1, 0, 0, 0, 0, 0, 0]

describe('the tunnel endpoint (SOCKS5)', () => {
  it('serves CONNECT only, to a client with the credentials', async () => {
    const { port, outcomes } = await endpoint()
    const bind = await exchange(port, greeting, auth(), request(2))
    expect([...bind]).toEqual([5, 2, 1, 0, 5, 7, 0, 1, 0, 0, 0, 0, 0, 0])
    expect(outcomes).toEqual(['socks: only CONNECT is served'])
  })

  it('refuses the right user name with the wrong password, and the reverse', async () => {
    const { port } = await endpoint()
    expect([...(await exchange(port, greeting, auth(credentials.username, 'x')))]).toEqual([5, 2, 1, 1])
    expect([...(await exchange(port, greeting, auth('mm-someone', credentials.password)))]).toEqual([
      5, 2, 1, 1,
    ])
    // A password that only starts like the right one is wrong too.
    expect([
      ...(await exchange(port, greeting, auth(credentials.username, credentials.password + 'x'))),
    ]).toEqual([5, 2, 1, 1])
  })

  it('closes a client that stalls in the handshake, or sends too much of one', async () => {
    const { port, outcomes } = await endpoint(200)
    expect((await exchange(port, Buffer.from([5]))).length).toBe(0)
    expect((await exchange(port, Buffer.from([5, 255]), Buffer.alloc(2048, 1))).length).toBe(0)
    expect(outcomes.sort()).toEqual(['socks: handshake timed out', 'socks: handshake too long'])
  })

  // Review of the deferred fixes (M1): success was answered before the target was reached.
  it('says the request failed when the target cannot be reached, and only then', async () => {
    const { port, outcomes } = await endpoint(undefined, async () => {
      throw new Error('channel refused')
    })
    const answer = await exchange(port, greeting, auth(), request())
    expect([...answer]).toEqual([5, 2, 1, 0, 5, 1, 0, 1, 0, 0, 0, 0, 0, 0])
    expect(outcomes).toEqual(['channel refused'])
    let reached = false
    const slow = await endpoint(undefined, async () => {
      await new Promise((r) => setTimeout(r, 300))
      reached = true
    })
    const late = await new Promise<number[]>((resolve) => {
      const socket = net.connect(slow.port, '127.0.0.1', () =>
        socket.write(Buffer.concat([greeting, auth(), request()])),
      )
      let got = Buffer.alloc(0)
      socket.on('data', (d: Buffer) => {
        got = Buffer.concat([got, d])
        // The success reply arrives after the target was reached, never before.
        if (got.length >= OK.length) {
          resolve([...got.subarray(4, 6), reached ? 1 : 0])
          socket.destroy()
        }
      })
    })
    expect(late).toEqual([5, 0, 1])
  })

  // Review of the deferred fixes (M2): a request it cannot serve is answered as RFC 1928 says.
  it('answers an unknown address type and a wrong authentication version', async () => {
    const { port } = await endpoint()
    const odd = Buffer.from([5, 1, 0, 9, 1, 2])
    expect([...(await exchange(port, greeting, auth(), odd))]).toEqual([
      5, 2, 1, 0, 5, 8, 0, 1, 0, 0, 0, 0, 0, 0,
    ])
    const badVersion = Buffer.concat([Buffer.from([2]), auth().subarray(1)])
    expect([...(await exchange(port, greeting, badVersion))]).toEqual([5, 2, 1, 1])
  })

  it('keeps the bytes a client sends right after its request', async () => {
    const { port } = await endpoint()
    const answer = await exchange(port, Buffer.concat([greeting, auth(), request(), Buffer.from('ping')]))
    expect([...answer.subarray(0, OK.length)]).toEqual(OK)
    expect(answer.subarray(OK.length).toString()).toBe('echo:ping')
  })

  it('lets its own client through, and only with the right credentials', async () => {
    const { port } = await endpoint()
    const socket = await socksConnect(port, credentials)
    const echoed = await new Promise<string>((resolve) => {
      socket.once('data', (d: Buffer) => resolve(d.toString()))
      socket.write('hello')
    })
    expect(echoed).toBe('echo:hello')
    socket.destroy()
    await expect(socksConnect(port, { ...credentials, password: 'wrong' })).rejects.toThrow(/refused/)
  })
})
