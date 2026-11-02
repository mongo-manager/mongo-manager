import net from 'node:net'
import tls from 'node:tls'
import { Binary } from 'bson'
import type { ConnectionSettings } from '@mongo-manager/shared'
import { FrameSplitter, encodeFrame, encodeOpMsg, parseOpMsg, OP_MSG } from './wire'
import { ScramConversation, type ScramMechanism } from './scram'
import { socksConnect, type SocksCredentials } from '../../connections/socks'

/**
 * Phase 3a-1 spec §5.2: open a socket to one MongoDB host and authenticate it as the connection's
 * user, so the worker's driver, sharing this socket, runs as that user without ever holding the
 * credential. Supports SCRAM-SHA-1/256, MONGODB-X509 and PLAIN. GSSAPI, MONGODB-AWS and
 * MONGODB-OIDC are refused earlier (supportedMechanism).
 */

export interface UpstreamOptions {
  /** TLS material and SSH tunnelling come from the connection; this is the plain socket factory. */
  tls?: tls.ConnectionOptions | null
  appName: string
  /** Overrides the mechanism the settings imply (tests). */
  connectTimeoutMs?: number
  /** The whole handshake once connected (hello and sign-in), so a server gone silent holds nothing. */
  handshakeTimeoutMs?: number
  /** An SSH tunnel's endpoint: reached as a SOCKS5 proxy with the tunnel's credentials. */
  socks?: SocksCredentials
  /** Aborted: the socket is destroyed wherever the connection stands (security review 2026-10-16). */
  signal?: AbortSignal
  /** The connection whose credentials these are: SCRAM's salted-password cache is kept per connection. */
  credentialScope?: string
}

const UNSUPPORTED = new Set(['GSSAPI', 'MONGODB-AWS', 'MONGODB-OIDC'])
/** The hello and the sign-in together (a SCRAM conversation is three round trips). */
export const HANDSHAKE_TIMEOUT_MS = 15_000

/** Whether a connection's auth mechanism can be used by the proxy (spec §5.2). */
export function supportedMechanism(settings: ConnectionSettings): boolean {
  const m = settings.auth?.mechanism
  return !m || !UNSUPPORTED.has(m)
}

/** A minimal request/response over one socket for the handshake and auth commands. */
export class Rpc {
  private splitter = new FrameSplitter()
  private pending: { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void } | null = null
  private requestID = 1

  constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => {
      let frames
      try {
        frames = this.splitter.push(chunk)
      } catch (e) {
        this.fail(e as Error)
        return
      }
      for (const frame of frames) {
        if (frame.opCode !== OP_MSG)
          return this.fail(new Error(`upstream: unexpected opcode ${frame.opCode}`))
        const reply = this.pending
        this.pending = null
        reply?.resolve(parseOpMsg(frame.body).command)
      }
    })
    socket.on('error', (e) => this.fail(e))
    socket.on('close', () => this.fail(new Error('upstream: socket closed during handshake')))
  }

  private fail(e: Error): void {
    const p = this.pending
    this.pending = null
    p?.reject(e)
  }

  command(db: string, command: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (this.pending) return reject(new Error('upstream: overlapping commands'))
      this.pending = { resolve, reject }
      const body = encodeOpMsg({ flags: 0, command: { ...command, $db: db }, sequences: [] })
      this.socket.write(encodeFrame({ requestID: this.requestID++, responseTo: 0, opCode: OP_MSG, body }))
    })
  }

  detach(): void {
    this.socket.removeAllListeners('data')
    this.socket.removeAllListeners('error')
    this.socket.removeAllListeners('close')
  }
}

/**
 * Fifth review of the unreachable fix (I1): the server refused the session's sign-in. The proxy
 * tries no more for the session, and the connection keeps the refusal.
 */
export class UpstreamRefused extends Error {
  override name = 'UpstreamRefused'
}

/**
 * Sixth review (I2): a sign-in failed. Refused as such it is a refusal, as the driver's own
 * classifyError has it: AuthenticationFailed (18), or its words (seventh review, I3: Atlas answers
 * 8000 AtlasError, "bad auth : authentication failed"). Anything else (a shutdown, a mechanism the
 * server does not offer, a shard out of reach) is not: kept for five minutes it would stop the app.
 */
function signInFailed(message: string, reply: Record<string, unknown>): Error {
  return reply.code === 18 ||
    reply.codeName === 'AuthenticationFailed' ||
    /authentication failed/i.test(String(reply.errmsg ?? ''))
    ? new UpstreamRefused(message)
    : new Error(message)
}

async function connectSocket(host: string, port: number, opts: UpstreamOptions): Promise<net.Socket> {
  const timeout = opts.connectTimeoutMs ?? 10_000
  if (opts.signal?.aborted) throw new Error('upstream: aborted')
  // Through an SSH tunnel: its SOCKS5 handshake first, then TLS (if any) over that socket.
  const through = opts.socks ? await socksConnect(port, opts.socks, timeout) : undefined
  if (through) abortWith(through, opts.signal)
  if (through && !opts.tls) return through
  return new Promise((resolve, reject) => {
    const socket: net.Socket = opts.tls
      ? tls.connect({ ...(through ? { socket: through } : { host, port }), ...opts.tls }, () =>
          resolve(socket),
        )
      : net.connect(port, host, () => resolve(socket))
    abortWith(socket, opts.signal)
    // Each step's timer is its own: the handshake's, after, is not answered as a connect timeout.
    const onTimeout = () => socket.destroy(new Error('upstream: connect timeout'))
    socket.setTimeout(timeout)
    socket.once('timeout', onTimeout)
    // Seventh review (I2): over TLS, the timer runs until the connection is secure, not only connected.
    socket.once(opts.tls ? 'secureConnect' : 'connect', () => {
      socket.setTimeout(0)
      socket.off('timeout', onTimeout)
    })
    socket.on('error', reject)
  })
}

/** The socket is destroyed when the signal aborts, at whatever point the connection stands. */
function abortWith(socket: net.Socket, signal: AbortSignal | undefined): void {
  if (!signal) return
  if (signal.aborted) return void socket.destroy(new Error('upstream: aborted'))
  const onAbort = (): void => void socket.destroy(new Error('upstream: aborted'))
  signal.addEventListener('abort', onAbort, { once: true })
  socket.once('close', () => signal.removeEventListener('abort', onAbort))
}

function payload(reply: Record<string, unknown>): Buffer {
  const p = reply.payload
  if (p instanceof Binary) return Buffer.from(p.buffer)
  if (Buffer.isBuffer(p)) return p
  throw new Error('upstream: auth reply had no payload')
}

async function scramAuth(
  rpc: Rpc,
  mechanism: ScramMechanism,
  source: string,
  user: string,
  password: string,
  scope = '',
): Promise<void> {
  const convo = new ScramConversation(mechanism, user, password, undefined, scope)
  const start = await rpc.command(source, {
    saslStart: 1,
    mechanism,
    payload: new Binary(convo.start()),
    options: { skipEmptyExchange: true },
    autoAuthorize: 1,
  })
  if (start.ok !== 1)
    throw signInFailed(`upstream: saslStart failed: ${JSON.stringify(start.errmsg ?? start)}`, start)
  const clientFinal = await convo.clientFinal(payload(start))
  const cont = await rpc.command(source, {
    saslContinue: 1,
    conversationId: start.conversationId,
    payload: new Binary(clientFinal),
  })
  if (cont.ok !== 1)
    throw signInFailed(`upstream: saslContinue failed: ${JSON.stringify(cont.errmsg ?? cont)}`, cont)
  convo.verifyServerFinal(payload(cont))
  if (!cont.done) {
    const fin = await rpc.command(source, {
      saslContinue: 1,
      conversationId: start.conversationId,
      payload: new Binary(Buffer.alloc(0)),
    })
    if (fin.ok !== 1) throw signInFailed('upstream: final saslContinue failed', fin)
  }
}

async function plainAuth(rpc: Rpc, source: string, user: string, password: string): Promise<void> {
  const message = Buffer.from(`\0${user}\0${password}`, 'utf8')
  const reply = await rpc.command(source, { saslStart: 1, mechanism: 'PLAIN', payload: new Binary(message) })
  if (reply.ok !== 1)
    throw signInFailed(`upstream: PLAIN auth failed: ${JSON.stringify(reply.errmsg ?? reply)}`, reply)
}

async function x509Auth(rpc: Rpc, user?: string): Promise<void> {
  const reply = await rpc.command('$external', {
    authenticate: 1,
    mechanism: 'MONGODB-X509',
    ...(user ? { user } : {}),
  })
  if (reply.ok !== 1)
    throw signInFailed(`upstream: X509 auth failed: ${JSON.stringify(reply.errmsg ?? reply)}`, reply)
}

export interface Upstream {
  socket: net.Socket
  /** The server's hello, for topology and the host allow-list. */
  hello: Record<string, unknown>
}

/**
 * Connect to `host:port`, run the handshake with the proxy's own client metadata, authenticate as
 * the connection's user, and hand back the authenticated socket. The worker's driver then shares it.
 */
export async function openUpstream(
  settings: ConnectionSettings,
  host: string,
  port: number,
  opts: UpstreamOptions,
): Promise<Upstream> {
  const socket = await connectSocket(host, port, opts)
  // Seventh review (I2): a server that accepts the connection and then says nothing is left, in time.
  // A deadline for it all, not an idle timer: a server answering a byte at a time holds nothing.
  const deadline = setTimeout(
    () => socket.destroy(new Error('upstream: handshake timeout')),
    opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
  )
  try {
    return await handshake(socket, settings, opts)
  } catch (e) {
    // A connection that cannot be used is closed, never left open (over SSH, its channel with it).
    socket.destroy()
    throw e
  } finally {
    clearTimeout(deadline)
  }
}

async function handshake(
  socket: net.Socket,
  settings: ConnectionSettings,
  opts: UpstreamOptions,
): Promise<Upstream> {
  socket.setNoDelay(true)
  const rpc = new Rpc(socket)
  const auth = settings.auth
  const mechs = auth && auth.mechanism !== 'none' && auth.username ? mechList(auth.mechanism) : undefined
  // The proxy's hello is the connection's first, so it carries the client metadata with our appName
  // (so the worker's operations show appName=mm-shell:<id> for killOp). The worker's own hellos are
  // stripped of client downstream, since client may appear only on the first hello.
  const hello = await rpc.command('admin', {
    hello: 1,
    client: {
      application: { name: opts.appName },
      driver: { name: 'mongo-manager-shell-proxy', version: '2.0' },
      os: { type: process.platform },
    },
    ...(mechs && auth?.username ? { saslSupportedMechs: `${authSource(settings)}.${auth.username}` } : {}),
  })
  if (hello.ok !== 1 && hello.ismaster === undefined && hello.isWritablePrimary === undefined) {
    throw new Error(`upstream: handshake failed: ${JSON.stringify(hello.errmsg ?? hello)}`)
  }
  if (auth && auth.mechanism !== 'none') {
    const source = authSource(settings)
    if (auth.mechanism === 'MONGODB-X509') await x509Auth(rpc, auth.username || undefined)
    else if (auth.mechanism === 'PLAIN')
      await plainAuth(rpc, '$external', auth.username!, auth.password ?? '')
    else
      await scramAuth(
        rpc,
        resolveScram(auth.mechanism, hello),
        source,
        auth.username!,
        auth.password ?? '',
        opts.credentialScope,
      )
  }
  rpc.detach()
  return { socket, hello }
}

function authSource(settings: ConnectionSettings): string {
  return settings.auth?.authSource || settings.defaultDatabase || 'admin'
}

function mechList(mechanism: string): string[] {
  return mechanism === 'DEFAULT' ? ['SCRAM-SHA-256', 'SCRAM-SHA-1'] : [mechanism]
}

/** Pick the SCRAM variant: an explicit one, or the server's preference for DEFAULT. */
function resolveScram(mechanism: string, hello: Record<string, unknown>): ScramMechanism {
  if (mechanism === 'SCRAM-SHA-1' || mechanism === 'SCRAM-SHA-256') return mechanism
  const offered = Array.isArray(hello.saslSupportedMechs) ? (hello.saslSupportedMechs as string[]) : []
  return offered.includes('SCRAM-SHA-256') || offered.length === 0 ? 'SCRAM-SHA-256' : 'SCRAM-SHA-1'
}
