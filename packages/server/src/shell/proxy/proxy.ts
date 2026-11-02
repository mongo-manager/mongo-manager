import net from 'node:net'
import tls from 'node:tls'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { ConnectionSettings, QueryOrigin } from '@mongo-manager/shared'
import {
  FrameSplitter,
  commandWithSequences,
  encodeFrame,
  encodeOpMsg,
  errorReply,
  isHello,
  parseOpMsg,
  legacyHello,
  stripHelloFields,
  OP_MSG,
  OP_COMPRESSED,
  OP_QUERY,
  type Frame,
} from './wire'
import { openUpstream, UpstreamRefused, Rpc } from './upstream'
import type { SocksCredentials } from '../../connections/socks'
import { commandPolicy, type Command } from './policy'
import { MAX_ORIGIN_BYTES, queryOriginOf } from './origin'

/**
 * Phase 3a-1 spec §5: the per-session authenticating proxy. The worker connects here (never to
 * MongoDB directly), proving the session token and naming its intended host in a preamble. The
 * proxy checks the token and the host allow-list, opens an authenticated upstream socket, and
 * relays — rewriting the worker's hello and refusing compression, unknown opcodes and oversize
 * frames. It holds the credentials; the worker never does.
 */

const PREAMBLE_TIMEOUT_MS = 1000
/** How long killing a session's operations may take on one server, all told. */
const KILL_TIMEOUT_MS = 5000
const TOKEN_BYTES = 32
const MAX_TARGET_BYTES = 300

export interface ShellProxyOptions {
  settings: ConnectionSettings
  sessionId: string
  /** The saved connection: SCRAM's salted-password cache is kept per connection. */
  connectionId?: string
  appName: string
  /** True when the worker may connect to this host:port (the connection's topology). */
  allowHost: (host: string, port: number) => boolean
  /** TLS options for the upstream, from the connection's clientSpec; null for plaintext. */
  tls?: tls.ConnectionOptions | null
  maxConnections?: number
  /** Read-only session: only the read command allow-list passes (spec §5.3). */
  readOnly?: boolean
  /** A connection admin's session: cluster and user-management commands pass. */
  admin?: boolean
  /** The server's allowServerJs (MM_ALLOW_SERVER_JS): without it $where, $function, $accumulator and mapReduce are refused. */
  allowServerJs?: boolean
  /** Each worker→server command, and whether the policy refused it (for the audit summary). */
  onCommand?: (name: string, refused: boolean) => void
  /** The server refused the session's sign-in: said once; the session dials no more. */
  onRefused?: () => void
  /**
   * Phase 3a-2: an allowed find or collection aggregate, for the result's origin (spec §3.3). The
   * origin is a function, so it is worked out only by a caller that wants it.
   */
  onQuery?: (origin: () => QueryOrigin | null) => void
  /** Maps the worker's named target to the real upstream address (identity, or an SSH tunnel). */
  dial?: (host: string, port: number) => { host: string; port: number; socks?: SocksCredentials }
  /**
   * Whether a command or completion runs, or the worker is starting (security review 2026-10-16,
   * I-3): while not, only connection upkeep passes — code a command left running reaches nothing.
   */
  active?: () => boolean
  /** How long one kill may take, all servers together (default 5 s; tests shorten it). */
  killTimeoutMs?: number
}

/** The commands that keep a connection up, which pass while no command runs. */
const UPKEEP = new Set(['hello', 'ismaster', 'endsessions', 'killcursors'])
/** A topology check: the worker's driver monitoring its servers. */
const MONITORING = new Set(['hello', 'ismaster'])
/** OP_MSG flag: the sender expects no reply. */
const MORE_TO_COME = 1 << 1

/** One of the worker's connections through the proxy, as the server knows it. */
interface Link {
  host: string
  port: number
  /** The server's id for the connection (its hello's connectionId), as currentOp shows it. */
  connectionId: number | null
  /** A mongos: the operations it starts on the shards carry the client's appName, not this id. */
  mongos: boolean
  /** Requests sent and not yet answered (monitoring and fire-and-forget aside). */
  pending: Set<number>
}

/**
 * Reads only the headers of the frames the server sends, to know which requests were answered: no
 * frame is held in memory, a frame's body is skipped as it passes.
 */
class ReplyWatcher {
  private header = Buffer.alloc(0)
  private skip = 0

  constructor(private readonly answered: (responseTo: number) => void) {}

  push(chunk: Buffer): void {
    let at = 0
    while (at < chunk.length) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, chunk.length - at)
        this.skip -= n
        at += n
        continue
      }
      const need = 16 - this.header.length
      const take = chunk.subarray(at, at + need)
      this.header = this.header.length ? Buffer.concat([this.header, take]) : Buffer.from(take)
      at += take.length
      if (this.header.length < 16) return
      const length = this.header.readInt32LE(0)
      this.answered(this.header.readInt32LE(8))
      this.header = Buffer.alloc(0)
      this.skip = Math.max(0, length - 16)
    }
  }
}

const UNAUTHORIZED = 13
/**
 * The codeName of a refusal for server-side JavaScript: the worker turns it into the SERVER_JS code
 * the page words in the user's language (security audit 2026-10-16).
 */
export const SERVER_JS_CODE_NAME = 'MongoManagerServerJsDisabled'
/**
 * A command frame larger than this gets no origin: it would almost always pass MAX_ORIGIN_BYTES, and
 * all that is lost is the result's link to the collection view.
 */
const MAX_ORIGIN_FRAME_BYTES = 4 * MAX_ORIGIN_BYTES

/**
 * Bytes from `from` written to `to`; while `to` cannot take more, `from` waits (security review
 * 2026-10-13, M7: what the server sent a slow worker piled up in memory).
 */
export function relay(
  from: { pause(): unknown; resume(): unknown },
  to: { write(chunk: Buffer): boolean; once(event: 'drain', listener: () => void): unknown },
): (chunk: Buffer) => void {
  return (chunk) => {
    if (!to.write(chunk)) {
      from.pause()
      to.once('drain', () => from.resume())
    }
  }
}

/**
 * The driver's own topology monitoring (an awaitable hello) is no operation of the user's, and
 * killing it would only make the driver reconnect. Told by the command's first field (security review
 * 2026-10-16, I-2: `{ dbHash: 1, hello: 1 }` passed for monitoring and dodged the kill).
 */
function isMonitoring(op: Record<string, unknown>): boolean {
  const command = op.command
  if (!command || typeof command !== 'object') return false
  const first = Object.keys(command as Record<string, unknown>)[0]
  return first !== undefined && MONITORING.has(first.toLowerCase())
}

export class ShellProxy {
  private server: net.Server | null = null
  private token = ''
  private connections = 0
  private readonly max: number
  /** The worker's connections through the proxy (security review 2026-10-16, I-2). */
  private readonly links = new Set<Link>()
  /**
   * Fifth review of the unreachable fix (I1): the server refused this session's sign-in. Every
   * socket the worker's driver opens after (each retry, each reconnect) is closed undialled.
   */
  private refused = false
  /**
   * Sixth review (I1): a sign-in under way, by member: later sockets to it wait for it until one
   * passed. By member, not for the session (seventh review, I2): one that does not answer holds
   * back no other, a primary up behind a member gone.
   */
  private readonly signingIn = new Map<string, Promise<void>>()
  private signedIn = false
  /** Sixth review (M1): closed (its connection edited, the session ended): what is under way stops. */
  private readonly stopping = new AbortController()
  /** A request was sent that gets no answer (moreToCome) since the last command ended. */
  private unanswerable = false
  /** The kill under way, if any: one at a time (security review 2026-10-16, I-4). */
  private kill: Promise<number> | null = null

  constructor(private readonly options: ShellProxyOptions) {
    this.max = options.maxConnections ?? 16
  }

  async listen(): Promise<{ port: number; token: string }> {
    this.token = randomBytes(TOKEN_BYTES).toString('hex')
    const server = net.createServer((socket) => this.onConnection(socket))
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const port = (server.address() as net.AddressInfo).port
    return { port, token: this.token }
  }

  /** The Node ≥ 25 path: an already-accepted loopback socket handed from the parent. */
  acceptHandle(socket: net.Socket): void {
    this.onConnection(socket)
  }

  private onConnection(down: net.Socket): void {
    if (this.connections >= this.max) {
      down.destroy()
      return
    }
    this.connections++
    down.once('close', () => this.connections--)
    this.readPreamble(down)
  }

  /** Read token + length-prefixed "host:port", validate, then relay. */
  private readPreamble(down: net.Socket): void {
    let header: Buffer = Buffer.alloc(0)
    const timer = setTimeout(() => down.destroy(), PREAMBLE_TIMEOUT_MS)
    const onData = (chunk: Buffer): void => {
      header = header.length ? Buffer.concat([header, chunk]) : Buffer.from(chunk)
      if (header.length < TOKEN_BYTES + 2) return
      const len = header.readUInt16BE(TOKEN_BYTES)
      if (len === 0 || len > MAX_TARGET_BYTES) return void down.destroy()
      if (header.length < TOKEN_BYTES + 2 + len) return
      clearTimeout(timer)
      down.off('data', onData)
      down.pause()
      const token = header.subarray(0, TOKEN_BYTES)
      const expected = Buffer.from(this.token, 'hex')
      if (token.length !== expected.length || !timingSafeEqual(token, expected)) return void down.destroy()
      const target = header.subarray(TOKEN_BYTES + 2, TOKEN_BYTES + 2 + len).toString('utf8')
      const rest = header.subarray(TOKEN_BYTES + 2 + len)
      const colon = target.lastIndexOf(':')
      const host = target.slice(0, colon)
      const port = Number(target.slice(colon + 1))
      if (!host || !Number.isInteger(port) || !this.options.allowHost(host, port)) return void down.destroy()
      void this.relay(down, host, port, rest)
    }
    down.on('data', onData)
    down.on('error', () => down.destroy())
  }

  private async relay(down: net.Socket, host: string, port: number, pending: Buffer): Promise<void> {
    if (this.refused || this.stopping.signal.aborted) return void down.destroy()
    // Sixth review (I1): the driver opens its sockets at once; until one signed in, one tries at a
    // time, so a refused sign-in is tried once however many sockets were waiting.
    // What is dialled, not what is named: over SSH every member is the tunnel's one server (final review).
    let member: string
    try {
      const dialled = this.options.dial ? this.options.dial(host, port) : { host, port }
      member = `${dialled.host}:${dialled.port}`
    } catch {
      return void down.destroy()
    }
    for (
      let under = this.signingIn.get(member);
      !this.signedIn && under;
      under = this.signingIn.get(member)
    ) {
      await under
      if (this.refused || this.stopping.signal.aborted || down.destroyed) return void down.destroy()
    }
    let done: (() => void) | undefined
    if (!this.signedIn) this.signingIn.set(member, new Promise<void>((resolve) => (done = resolve)))
    let up: net.Socket
    let link: Link
    try {
      // The worker names the real host; an SSH connection dials the tunnel endpoint instead.
      const target = this.options.dial ? this.options.dial(host, port) : { host, port }
      const upstream = await openUpstream(this.options.settings, target.host, target.port, {
        tls: this.options.tls ?? null,
        appName: this.options.appName,
        credentialScope: this.options.connectionId,
        signal: this.stopping.signal,
        ...('socks' in target && target.socks ? { socks: target.socks } : {}),
      })
      this.signedIn = true
      up = upstream.socket
      // Seventh review (M1): the worker's socket closed meanwhile: nothing is left signed in for it.
      if (down.destroyed) {
        up.destroy()
        return
      }
      const id = Number(upstream.hello.connectionId)
      link = {
        host,
        port,
        connectionId: Number.isSafeInteger(id) ? id : null,
        mongos: upstream.hello.msg === 'isdbgrid',
        pending: new Set(),
      }
      this.links.add(link)
    } catch (e) {
      this.noteRefused(e)
      // The worker's driver sees the connection drop and reports it as a connection error.
      down.destroy()
      return
    } finally {
      if (done) {
        this.signingIn.delete(member)
        done()
      }
    }

    const toServer = new FrameSplitter()
    const policy = commandPolicy({
      readOnly: this.options.readOnly ?? false,
      admin: this.options.admin ?? false,
      allowServerJs: this.options.allowServerJs ?? false,
    })
    const guard = (frame: Frame): boolean => {
      if (frame.opCode === OP_COMPRESSED) return false
      if (frame.opCode !== OP_MSG && frame.opCode !== OP_QUERY) return false
      return true
    }
    const onWorkerData = (chunk: Buffer): void => {
      let frames: Frame[]
      try {
        frames = toServer.push(chunk)
      } catch {
        down.destroy()
        up.destroy()
        return
      }
      for (const frame of frames) {
        if (!guard(frame)) {
          down.destroy()
          up.destroy()
          return
        }
        // The worker is treated as an adversary (it could be crafting frames after an escape), so a
        // corrupt or hostile frame must drop the connection, never throw out of this data handler
        // (that would be an uncaught exception and take the whole server down — review I3). Each
        // OP_MSG is parsed exactly once, here, and reused for both the hello rewrite and the policy.
        let outgoing: Frame
        if (frame.opCode === OP_MSG) {
          let command: Command
          let body: Buffer
          try {
            const msg = parseOpMsg(frame.body)
            const stripped = isHello(msg.command) && stripHelloFields(msg.command)
            body = stripped ? encodeOpMsg(msg) : frame.body
            // The policy judges the command with any document sequences folded in (review M2).
            command = {
              // Its first field on the wire, never JavaScript's order (security review 2026-10-13, H2).
              name: msg.name,
              db: String(msg.command.$db ?? 'admin'),
              body: commandWithSequences(msg),
            }
          } catch {
            down.destroy()
            up.destroy()
            return
          }
          // The command policy is enforced here, outside the worker (spec §5.3). While no command
          // runs, only connection upkeep passes (security review 2026-10-16, I-3).
          const lower = command.name.toLowerCase()
          const idle = this.options.active ? !this.options.active() : false
          const verdict =
            idle && !UPKEEP.has(lower)
              ? {
                  allow: false as const,
                  reason:
                    'no command is running in this shell: code left running after a command does not reach the database',
                }
              : policy(command)
          this.options.onCommand?.(command.name, !verdict.allow)
          if (!verdict.allow) {
            // Answer the worker with a MongoDB error; never forward the command.
            down.write(
              encodeFrame(
                errorReply(
                  frame.requestID,
                  UNAUTHORIZED,
                  `Refused by Mongo Manager: ${verdict.reason}`,
                  verdict.code === 'SERVER_JS' ? SERVER_JS_CODE_NAME : undefined,
                ),
              ),
            )
            continue
          }
          // A bad origin is simply not reported; it never affects relaying the command. It is worked
          // out only when asked for (a command is running), and never for a frame too large for its
          // origin to be kept anyway (final review M9).
          if (this.options.onQuery && frame.body.length <= MAX_ORIGIN_FRAME_BYTES) {
            this.options.onQuery(() => {
              try {
                return queryOriginOf(command)
              } catch {
                return null
              }
            })
          }
          // Answered later: what is still outstanding when a command ends is known (busy()).
          if (!UPKEEP.has(lower)) {
            if (frame.body.readUInt32LE(0) & MORE_TO_COME) this.unanswerable = true
            else link.pending.add(frame.requestID)
          }
          outgoing = { ...frame, body }
        } else {
          // OP_QUERY: only the legacy handshake hello, stripped of its client metadata too; anything
          // else drops the connection (security review 2026-10-13, H2).
          try {
            outgoing = legacyHello(frame)
          } catch {
            down.destroy()
            up.destroy()
            return
          }
        }
        if (!up.write(encodeFrame(outgoing))) down.pause()
      }
    }
    down.on('data', onWorkerData)
    // A side that cannot keep up holds the other back: nothing piles up in the server's memory
    // (security review 2026-10-13, M7).
    const toWorker = relay(up, down)
    const watcher = new ReplyWatcher((responseTo) => link.pending.delete(responseTo))
    up.on('data', (chunk: Buffer) => {
      watcher.push(chunk)
      toWorker(chunk)
    })
    up.on('drain', () => down.resume())
    const end = (): void => {
      this.links.delete(link)
      down.destroy()
      up.destroy()
    }
    down.on('error', end)
    up.on('error', end)
    down.on('close', end)
    up.on('close', end)
    // Flush any bytes that arrived with the preamble, then resume.
    if (pending.length) onWorkerData(pending)
    down.resume()
  }

  /** Whether a request of the worker's still waits for its answer (monitoring aside). */
  busy(): boolean {
    if (this.unanswerable) return true
    for (const link of this.links) if (link.pending.size > 0) return true
    return false
  }

  /**
   * A command ended: whether anything it sent may still run on the server — a request unanswered,
   * or one that gets no answer at all (moreToCome, an unacknowledged write: second review
   * 2026-10-16). The latter is forgotten once asked.
   */
  endCommand(): boolean {
    const outstanding = this.busy()
    this.unanswerable = false
    return outstanding
  }

  /** Whether a kill is under way. */
  get killing(): boolean {
    return this.kill !== null
  }

  /**
   * Spec §5.4, security audit 2026-10-16 (I3) and its review (I-2, I-4): end the operations of the
   * worker's connections on MongoDB. The connections are taken as they are now — a worker started
   * after this call is never touched. On each server, a connection of the proxy's own, with the
   * connection's credentials, lists the operations of those connections (currentOp with $ownOps
   * and their ids; on a mongos, whose listing shows the shards' operations under shard-side ids,
   * by the session's appName alone — $client is refused by the policy) and kills each but the
   * driver's monitoring. One kill at a time: one asked for meanwhile shares it. It is cut off hard
   * after its time limit: its connections are closed and nothing more is sent.
   */
  killOps(): Promise<number> {
    if (this.kill) return this.kill
    const servers = new Map<string, { host: string; port: number; ids: number[]; mongos: boolean }>()
    for (const link of this.links) {
      const key = `${link.host}:${link.port}`
      const server = servers.get(key) ?? { host: link.host, port: link.port, ids: [], mongos: false }
      if (link.connectionId !== null) server.ids.push(link.connectionId)
      server.mongos ||= link.mongos
      servers.set(key, server)
    }
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), this.options.killTimeoutMs ?? KILL_TIMEOUT_MS)
    const work = Promise.all(
      [...servers.values()]
        .filter((s) => s.ids.length > 0 || s.mongos)
        .map((s) => this.killOpsOn(s, abort.signal).catch(() => 0)),
    ).then((counts) => counts.reduce((a, b) => a + b, 0))
    this.kill = work.finally(() => {
      clearTimeout(timer)
      abort.abort()
      this.kill = null
    })
    return this.kill
  }

  /** A sign-in the server refused: said once, and none more for this session (not once closed). */
  private noteRefused(e: unknown): void {
    if (!(e instanceof UpstreamRefused) || this.refused || this.stopping.signal.aborted) return
    this.refused = true
    this.options.onRefused?.()
  }

  private async killOpsOn(
    server: { host: string; port: number; ids: number[]; mongos: boolean },
    signal: AbortSignal,
  ): Promise<number> {
    // Sixth review (M3): no sign-in to kill with once one was refused.
    if (this.refused) return 0
    const target = this.options.dial ? this.options.dial(server.host, server.port) : server
    const appName = this.options.appName
    const upstream = await openUpstream(this.options.settings, target.host, target.port, {
      tls: this.options.tls ?? null,
      // Its own name and connection: the listing never finds, and kills, itself.
      appName: `${appName}:kill`,
      credentialScope: this.options.connectionId,
      connectTimeoutMs: KILL_TIMEOUT_MS,
      signal,
      ...('socks' in target && target.socks ? { socks: target.socks } : {}),
    }).catch((e: unknown) => {
      this.noteRefused(e)
      throw e
    })
    try {
      const rpc = new Rpc(upstream.socket)
      // Second review 2026-10-16 (N-1): a mongos lists the shards' operations, whose connectionId is
      // the shard's id for the mongos→shard connection — never ours, and maybe another client's by
      // number. There the session's appName alone counts (the policy refuses $client, so no other
      // name can be given); on a mongod, its connections' ids alone.
      const filter = server.mongos ? { appName } : { connectionId: { $in: server.ids } }
      const listed = await rpc.command('admin', {
        currentOp: 1,
        $ownOps: true,
        ...filter,
      })
      const ops = Array.isArray(listed.inprog) ? (listed.inprog as Array<Record<string, unknown>>) : []
      let killed = 0
      for (const op of ops) {
        if (signal.aborted) break
        const ours = server.mongos
          ? op.appName === appName
          : op.shard === undefined && server.ids.includes(Number(op.connectionId))
        if (!ours || op.opid === undefined || isMonitoring(op)) continue
        const reply = await rpc.command('admin', { killOp: 1, op: op.opid })
        if (reply.ok === 1) killed++
      }
      return killed
    } finally {
      upstream.socket.destroy()
    }
  }

  async close(): Promise<void> {
    this.stopping.abort()
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
