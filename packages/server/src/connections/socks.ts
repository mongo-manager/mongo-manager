// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import net from 'node:net'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * The SSH tunnel's local endpoint speaks SOCKS5 with a user name and password (RFC 1928, RFC 1929)
 * made for each tunnel: a loopback port is open to every program on the machine, and the database
 * behind a bastion often has no sign-in of its own (plan 1c deferred minor). The driver reaches it
 * through its proxy options; the shell proxy through socksConnect.
 */
export interface SocksCredentials {
  username: string
  password: string
}

export const newSocksCredentials = (): SocksCredentials => ({
  username: `mm-${randomBytes(9).toString('base64url')}`,
  password: randomBytes(32).toString('base64url'),
})

/** On loopback a handshake takes a millisecond; a client still at it after this is not one of ours. */
export const HANDSHAKE_MS = 5_000
const VERSION = 5
const USER_PASS = 2
const NO_METHOD = 0xff
const AUTH_VERSION = 1
const CONNECT = 1

// Equal-length digests for timingSafeEqual, under a key this process makes and never shows
// (CodeQL 2026-11-01): what is compared is the generated password, never a stored one.
const COMPARE_KEY = randomBytes(32)
const digest = (b: Buffer) => createHmac('sha256', COMPARE_KEY).update(b).digest()
/** Compares without telling, by its timing, how much of a guess was right. */
const same = (a: Buffer, b: Buffer) => timingSafeEqual(digest(a), digest(b)) && a.length === b.length

/** Reads exactly n bytes of a handshake; anything after them stays in the socket for what follows. */
class Reader {
  private buffer = Buffer.alloc(0)
  private wanted: { n: number; resolve: (b: Buffer) => void } | undefined
  private failed: Error | undefined
  private rejecters = new Set<(e: Error) => void>()

  constructor(private readonly socket: net.Socket) {
    socket.on('data', this.onData)
    socket.once('close', () => this.fail(new Error('socks: closed during the handshake')))
    socket.once('error', (e) => this.fail(e))
  }

  private readonly onData = (chunk: Buffer): void => {
    this.buffer = Buffer.concat([this.buffer, chunk])
    // A handshake is a few hundred bytes at most; more before it ends is not one.
    if (this.buffer.length > 1024) return this.fail(new Error('socks: handshake too long'))
    this.deliver()
  }

  private deliver(): void {
    if (!this.wanted || this.buffer.length < this.wanted.n) return
    const { n, resolve } = this.wanted
    this.wanted = undefined
    const out = this.buffer.subarray(0, n)
    this.buffer = this.buffer.subarray(n)
    resolve(out)
  }

  private fail(e: Error): void {
    this.failed ??= e
    for (const reject of this.rejecters) reject(e)
    this.rejecters.clear()
  }

  read(n: number): Promise<Buffer> {
    if (this.failed) return Promise.reject(this.failed)
    return new Promise((resolve, reject) => {
      this.rejecters.add(reject)
      this.wanted = {
        n,
        resolve: (b) => {
          this.rejecters.delete(reject)
          resolve(b)
        },
      }
      this.deliver()
    })
  }

  /** Stops reading; bytes already received past the handshake go back to the socket. */
  release(): void {
    this.socket.off('data', this.onData)
    this.socket.pause()
    if (this.buffer.length > 0) this.socket.unshift(this.buffer)
    this.buffer = Buffer.alloc(0)
  }
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('socks: handshake timed out')), ms)
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer)) as Promise<T>
}

/** A reply to a request: the status and an empty IPv4 address (the client does not use it). */
const reply = (status: number) => Buffer.from([VERSION, status, 0, 1, 0, 0, 0, 0, 0, 0])
const GENERAL_FAILURE = 1
const COMMAND_NOT_SUPPORTED = 7
const ADDRESS_NOT_SUPPORTED = 8

/**
 * The server side: a client that offers no user name and password, or the wrong ones, is answered
 * as RFC 1928/1929 say and closed. A CONNECT then goes to the tunnel's one target (the address the
 * client names is not used): `connect` opens it, and only then is the client told it succeeded, or
 * that it failed (review of the deferred fixes, M1). Resolves with what `connect` opened; the
 * socket is paused, any bytes sent after the request kept for it.
 */
export async function acceptSocks<T>(
  socket: net.Socket,
  credentials: SocksCredentials,
  connect: () => Promise<T>,
  handshakeMs = HANDSHAKE_MS,
): Promise<T> {
  const reader = new Reader(socket)
  const expectedUser = Buffer.from(credentials.username)
  const expectedPass = Buffer.from(credentials.password)
  const refuse = (answer: Buffer, why: string): never => {
    socket.end(answer)
    throw new Error(why)
  }
  const handshake = async () => {
    const [version, count] = await reader.read(2)
    // Not SOCKS5: there is no answer it would understand.
    if (version !== VERSION || count === 0) throw new Error('socks: not a SOCKS5 greeting')
    const methods = await reader.read(count!)
    if (!methods.includes(USER_PASS)) refuse(Buffer.from([VERSION, NO_METHOD]), 'socks: no acceptable method')
    socket.write(Buffer.from([VERSION, USER_PASS]))
    const [authVersion, userLength] = await reader.read(2)
    if (authVersion !== AUTH_VERSION)
      refuse(Buffer.from([AUTH_VERSION, 1]), 'socks: bad authentication version')
    const user = userLength ? await reader.read(userLength) : Buffer.alloc(0)
    const [passLength] = await reader.read(1)
    const pass = passLength ? await reader.read(passLength) : Buffer.alloc(0)
    // Both compared, whatever the first says, so the time taken tells nothing either.
    const userOk = same(user, expectedUser)
    const passOk = same(pass, expectedPass)
    if (!(userOk && passOk)) refuse(Buffer.from([AUTH_VERSION, 1]), 'socks: wrong credentials')
    socket.write(Buffer.from([AUTH_VERSION, 0]))
    const [reqVersion, command, , addressType] = await reader.read(4)
    if (reqVersion !== VERSION) throw new Error('socks: not a SOCKS5 request')
    if (command !== CONNECT) refuse(reply(COMMAND_NOT_SUPPORTED), 'socks: only CONNECT is served')
    if (addressType === 1) await reader.read(4)
    else if (addressType === 4) await reader.read(16)
    else if (addressType === 3) await reader.read((await reader.read(1))[0]!)
    else refuse(reply(ADDRESS_NOT_SUPPORTED), 'socks: unknown address type')
    await reader.read(2) // the port
    reader.release()
  }
  try {
    await withDeadline(handshake(), handshakeMs)
  } catch (e) {
    reader.release()
    if (!socket.destroyed && !socket.writableEnded) socket.destroy()
    else socket.destroySoon()
    throw e
  }
  let opened: T
  try {
    opened = await connect()
  } catch (e) {
    if (!socket.destroyed) socket.end(reply(GENERAL_FAILURE))
    throw e
  }
  socket.write(reply(0))
  return opened
}

/** The client side, for the shell proxy: a socket through the tunnel, past its handshake. */
export function socksConnect(
  port: number,
  credentials: SocksCredentials,
  timeoutMs = HANDSHAKE_MS,
): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    const reader = new Reader(socket)
    const timer = setTimeout(() => socket.destroy(new Error('socks: connect timed out')), timeoutMs)
    const fail = (e: Error) => {
      clearTimeout(timer)
      socket.destroy()
      reject(e)
    }
    socket.once('connect', () => {
      void (async () => {
        socket.write(Buffer.from([VERSION, 1, USER_PASS]))
        const [version, method] = await reader.read(2)
        if (version !== VERSION || method !== USER_PASS) throw new Error('socks: method refused')
        const user = Buffer.from(credentials.username)
        const pass = Buffer.from(credentials.password)
        socket.write(
          Buffer.concat([Buffer.from([AUTH_VERSION, user.length]), user, Buffer.from([pass.length]), pass]),
        )
        const [, status] = await reader.read(2)
        if (status !== 0) throw new Error('socks: credentials refused')
        // CONNECT to 0.0.0.0:0: the tunnel has one target and does not read the address.
        socket.write(Buffer.from([VERSION, CONNECT, 0, 1, 0, 0, 0, 0, 0, 0]))
        const reply = await reader.read(10)
        if (reply[1] !== 0) throw new Error(`socks: connect refused (${reply[1]})`)
        reader.release()
        clearTimeout(timer)
        // Flowing again for the caller, which reads from it in the same turn: the server says
        // nothing until it is asked (MongoDB's client speaks first), so nothing is read unheard.
        socket.resume()
        resolve(socket)
      })().catch(fail)
    })
    socket.once('error', fail)
  })
}
