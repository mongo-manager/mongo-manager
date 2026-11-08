// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { twoFactorPending } from '../auth/policy'
import { ConnectionError } from '../connections/errors'
import { connectionAppError } from '../data/mongo-errors'
import type { WebSocket } from '@fastify/websocket'
import type { FastifyBaseLogger } from 'fastify'
import { safeEqual } from '../http/security'
import type { Principal, ServerContext } from '../http/context'
import { canSee, toView } from '../jobs/visibility'
import { permissionsFor } from '@mongo-manager/shared'
import { effectiveRole, mayUseShell } from '../connections/access'
import type { JobRecord } from '../jobs/types'
import type { LiveSyncRecord } from '../livesync/repo'
import { ownerOf } from '../transfer/files'
import { isAdministrator } from '../backup/schedules/policy'
import { CLOSE, ClientMessage, type ServerMessage } from './protocol'
import { WatchRefusal } from '../changestreams/target'
import type { Subscriber } from '../changestreams/manager'
import { WRITABLE_BYTES } from '../changestreams/feed'

type RawData = Buffer | ArrayBuffer | Buffer[]

export interface HubOptions {
  /** The first message, hello with the CSRF token, must come this soon. */
  helloTimeoutMs: number
  /** Ping interval; a socket missing two pongs in a row is closed. */
  pingMs: number
  maxMessageBytes: number
  maxMessagesPerSecond: number
  maxSocketsPerSession: number
  /** Connections one socket may watch at once (phase 1i spec §3). */
  maxMonitorsPerSocket: number
  /** Phase 3e-1 spec §2.2: change-stream feeds one socket may hold at once. */
  maxFeedsPerSocket: number
}

export const HUB_DEFAULTS: HubOptions = {
  helloTimeoutMs: 5_000,
  pingMs: 30_000,
  maxMessageBytes: 16 * 1024,
  maxMessagesPerSecond: 20,
  maxSocketsPerSession: 8,
  maxMonitorsPerSocket: 3,
  maxFeedsPerSocket: 3,
}

/** Jobs sent in a snapshot, newest first (as the REST list). */
const SNAPSHOT_LIMIT = 200
/** Refused hellos kept in the audit log per address and minute; addresses remembered at most. */
const HELLO_AUDIT_PER_WINDOW = 5
const HELLO_AUDIT_WINDOW_MS = 60_000
const HELLO_AUDIT_ADDRESSES = 1_000

interface Peer {
  socket: WebSocket
  /** The principal at the upgrade; re-read from the session before every push. */
  principal: Principal
  /** Session hash, or "local" in local mode: what the socket limit and sign-out close by. */
  key: string
  ready: boolean
  jobs: boolean
  /** Jobs this socket was told about: losing sight of one sends "gone". */
  sent: Set<string>
  window: { start: number; count: number }
  missedPongs: number
  helloTimer?: NodeJS.Timeout
  /** Watched connections and how to stop watching each. */
  watches: Map<string, () => void>
  /** Phase 3a-1: shell sessions opened over this socket, detached when it closes. */
  shellSessions: Set<string>
  /** Phase 3e-1: this socket's change-stream feeds; detached (parked for the grace) when it closes. */
  feeds: Set<string>
  /** Phase 3e-1 final review I3: this socket as its feeds know it (one object, compared by identity). */
  subscriber: Subscriber
  /** Phase 3e-2: subscribed to live syncs, and the ones it was told about. */
  liveSync: boolean
  syncs: Set<string>
}

/**
 * The /ws sockets (phase 1h spec §4). Every push re-reads the socket's session and user and checks
 * the job against the current grants, so sign-out, a disabled user or a revoked grant take effect
 * at once, not at the next reconnect.
 */
export class RealtimeHub {
  private readonly peers = new Set<Peer>()
  private readonly options: HubOptions
  private readonly heartbeat: NodeJS.Timeout
  private readonly unsubscribe: Array<() => void> = []
  /** Refused hellos audited per address in the current minute (security audit 2026-10-16). */
  private readonly helloRefusals = new Map<string, { start: number; count: number; suppressed: number }>()

  constructor(
    private readonly ctx: ServerContext,
    private readonly log: FastifyBaseLogger,
    options: Partial<HubOptions> = {},
  ) {
    this.options = { ...HUB_DEFAULTS, ...options }
    this.unsubscribe.push(
      // Review 2026-10-11: a shell session the server ends by itself (idle, lifetime, a crash) is
      // said to the page it is open on, so it stops saying "Connected".
      ctx.shell.onEnded((sessionId, reason) => this.shellEnded(sessionId, reason)),
      ctx.jobs.onChange((job) => this.pushJob(job)),
      ctx.updates.onRestarting((version) => {
        for (const peer of this.peers)
          if (peer.ready) this.send(peer, { ch: 'server', type: 'restarting', payload: { version } })
      }),
      ctx.liveSync.onChange((r, gone) => this.pushSync(r, gone)),
      ctx.sessions.onRevoke((r) => {
        if ('idHash' in r) this.closeWhere((p) => safeEqual(p.key, r.idHash))
        else this.closeWhere((p) => p.principal.userId === r.userId)
      }),
      // 4c review I1: access changed — every socket that may no longer stay goes now.
      // Panel access (2026-10-30): and every socket from an address the list no longer lets in.
      ctx.access.on(() =>
        this.closeWhere(
          (p) =>
            this.current(p) === null ||
            (ctx.config.auth && p.subscriber.ip !== null && !ctx.accessList.allows(p.subscriber.ip)),
        ),
      ),
    )
    // Review of the audit fixes (important 1): every browser signed out of local mode, at once.
    if (ctx.launch)
      this.unsubscribe.push(ctx.launch.onForget(() => this.closeWhere((p) => this.current(p) === null)))
    this.heartbeat = setInterval(() => this.beat(), this.options.pingMs)
    this.heartbeat.unref()
  }

  count(): number {
    return this.peers.size
  }

  attach(socket: WebSocket, principal: Principal, ip: string | null = null): void {
    const key = principal.kind === 'user' ? principal.sessionIdHash : 'local'
    const peer: Peer = {
      socket,
      principal,
      key,
      ready: false,
      jobs: false,
      sent: new Set(),
      window: { start: Date.now(), count: 0 },
      missedPongs: 0,
      watches: new Map(),
      shellSessions: new Set(),
      feeds: new Set(),
      subscriber: undefined as unknown as Subscriber,
      liveSync: false,
      syncs: new Set(),
    }
    peer.subscriber = {
      ip,
      principal: () => (this.peers.has(peer) ? this.current(peer) : null),
      send: (m) => this.send(peer, m),
      writable: () => peer.socket.bufferedAmount < WRITABLE_BYTES,
      ended: (id) => peer.feeds.delete(id),
    }
    if ([...this.peers].filter((p) => p.key === key).length >= this.options.maxSocketsPerSession) {
      socket.close(CLOSE.tooMany, 'Too many sockets')
      return
    }
    this.peers.add(peer)
    this.log.info({ userId: principal.userId }, 'realtime socket opened')
    peer.helloTimer = setTimeout(() => this.drop(peer, CLOSE.badHello), this.options.helloTimeoutMs)
    socket.on('message', (data: RawData, isBinary: boolean) => this.receive(peer, data, isBinary))
    socket.on('pong', () => (peer.missedPongs = 0))
    socket.on('close', (code: number) => {
      clearTimeout(peer.helloTimer)
      this.unwatchAll(peer)
      this.detachFeeds(peer)
      // Keep the shell sessions alive for the reconnect grace; the manager closes them if no one returns.
      for (const id of peer.shellSessions) this.ctx.shell.detach(id)
      this.peers.delete(peer)
      this.log.info({ userId: principal.userId, code }, 'realtime socket closed')
    })
    socket.on('error', () => this.drop(peer, CLOSE.badMessage))
  }

  close(): void {
    clearInterval(this.heartbeat)
    for (const off of this.unsubscribe) off()
    this.closeWhere(() => true, CLOSE.shutdown)
  }

  private receive(peer: Peer, data: RawData, isBinary: boolean): void {
    const now = Date.now()
    if (now - peer.window.start >= 1_000) peer.window = { start: now, count: 0 }
    if (++peer.window.count > this.options.maxMessagesPerSecond) return this.drop(peer, CLOSE.timeout)
    const bytes = Array.isArray(data) ? data.reduce((n, b) => n + b.length, 0) : data.byteLength
    if (bytes > this.options.maxMessageBytes) return this.drop(peer, CLOSE.tooLarge)
    if (isBinary) return this.drop(peer, CLOSE.badMessage)
    let parsed: ClientMessage
    try {
      const result = ClientMessage.safeParse(JSON.parse(String(data)))
      if (!result.success) return this.drop(peer, CLOSE.badMessage)
      parsed = result.data
    } catch {
      return this.drop(peer, CLOSE.badMessage)
    }
    if (!peer.ready) {
      if (parsed.type !== 'hello' || !safeEqual(parsed.csrf, peer.principal.csrfToken)) {
        this.auditBadHello(peer, parsed.type === 'hello' ? 'csrf' : 'no_hello')
        return this.drop(peer, CLOSE.badHello)
      }
      peer.ready = true
      clearTimeout(peer.helloTimer)
      return this.send(peer, { type: 'ready' })
    }
    if (parsed.type === 'hello') return
    if (parsed.ch === 'shell') return this.receiveShell(peer, parsed)
    if (parsed.ch === 'monitor') return this.receiveMonitor(peer, parsed.type, parsed.connectionId)
    if (parsed.ch === 'watch') return this.receiveWatch(peer, parsed)
    if (parsed.ch === 'livesync') return this.receiveLiveSync(peer, parsed.type)
    // One snapshot per subscription: a repeated sub costs a query each, so it is ignored.
    if (parsed.type === 'sub' && peer.jobs) return
    if (parsed.type === 'unsub') {
      peer.jobs = false
      peer.sent.clear()
      return
    }
    const principal = this.current(peer)
    if (!principal) return this.drop(peer, CLOSE.unauthenticated)
    peer.jobs = true
    const jobs = this.ctx.jobs
      .list({ limit: 1_000 })
      .filter((job) => canSee(this.ctx, principal, job))
      .slice(0, SNAPSHOT_LIMIT)
    peer.sent = new Set(jobs.map((j) => j.id))
    this.send(peer, {
      ch: 'jobs',
      type: 'snapshot',
      payload: { jobs: jobs.map((j) => toView(this.ctx, principal, j)), now: this.ctx.now() },
    })
  }

  private pushJob(job: JobRecord): void {
    for (const peer of this.peers) {
      if (!peer.ready || !peer.jobs) continue
      const principal = this.current(peer)
      if (!principal) {
        this.drop(peer, CLOSE.unauthenticated)
        continue
      }
      if (canSee(this.ctx, principal, job)) {
        peer.sent.add(job.id)
        this.send(peer, {
          ch: 'jobs',
          type: 'update',
          payload: { job: toView(this.ctx, principal, job), now: this.ctx.now() },
        })
      } else if (peer.sent.delete(job.id)) {
        this.send(peer, { ch: 'jobs', type: 'gone', payload: { id: job.id } })
      }
    }
  }

  private receiveLiveSync(peer: Peer, type: 'sub' | 'unsub'): void {
    peer.liveSync = type === 'sub'
    peer.syncs.clear()
  }

  /** Phase 3e-2 spec §2.5: a sync's change goes to its owner and administrators, re-checked per push. */
  private pushSync(r: LiveSyncRecord, gone: boolean): void {
    for (const peer of this.peers) {
      if (!peer.ready || !peer.liveSync) continue
      const principal = this.current(peer)
      if (!principal) {
        this.drop(peer, CLOSE.unauthenticated)
        continue
      }
      const sees = !gone && (r.owner === ownerOf(principal) || isAdministrator(principal))
      if (sees) {
        peer.syncs.add(r.id)
        this.send(peer, {
          ch: 'livesync',
          type: 'update',
          payload: { sync: this.ctx.liveSync.view(principal, r) },
        })
      } else if (peer.syncs.delete(r.id))
        this.send(peer, { ch: 'livesync', type: 'gone', payload: { id: r.id } })
    }
  }

  /** Whether this principal may watch the connection's server now. */
  private mayMonitor(principal: Principal, connectionId: string): boolean {
    const connection = this.ctx.connections.get(connectionId)
    const role = connection ? effectiveRole(this.ctx, principal, connectionId) : null
    return role !== null && permissionsFor(role).has('server:monitor')
  }

  /** Phase 3a-1: the shell channel. Access is re-checked on the current session, not the stale one. */
  private receiveShell(peer: Peer, msg: Extract<ClientMessage, { ch: 'shell' }>): void {
    const principal = this.current(peer)
    if (!principal) return this.drop(peer, CLOSE.unauthenticated)
    const owner = principal.kind === 'local' ? null : principal.userId
    // Who the shell's audit rows name (security review 2026-10-13).
    const shellUser = {
      username: principal.kind === 'user' ? principal.username : null,
      ip: peer.subscriber.ip,
    }
    // Whose failure it is: the session's, or the open's (its tab's ref).
    const tag =
      msg.type === 'open' ? (msg.ref !== undefined ? { ref: msg.ref } : {}) : { sessionId: msg.sessionId }
    const fail = (code: string, message: string, about: Record<string, unknown> = {}) =>
      this.send(peer, { ch: 'shell', type: 'failed', payload: { code, message, ...about, ...tag } })
    /** Seventh review (M2): a connection's failure names its kind, and a kept refusal says so. */
    const aboutOf = (e: unknown): Record<string, unknown> => {
      if (!(e instanceof ConnectionError)) return {}
      return { kind: e.kind, ...(e.remembered ? { remembered: true } : {}) }
    }
    const asError = (e: unknown): { code: string; message: string } => {
      // Sixth review (M4): a connection's failure (a refused sign-in) is answered as the routes do.
      const err = (e instanceof ConnectionError ? connectionAppError(e) : e) as {
        code?: string
        message?: string
      }
      return { code: err.code ?? 'INTERNAL', message: err.message ?? 'Shell error' }
    }

    if (msg.type === 'open') {
      if (!mayUseShell(this.ctx, principal, msg.connectionId))
        return fail('FORBIDDEN', 'You may not use the shell on this connection')
      const record = this.ctx.connections.get(msg.connectionId)
      if (!record) return fail('NOT_FOUND', 'Connection not found')
      const admin = effectiveRole(this.ctx, principal, msg.connectionId) === 'admin'
      const readOnly = this.ctx.config.readOnly || record.readOnly
      this.ctx.shell.open({ owner, admin, readOnly, ...shellUser }, msg.connectionId, msg.db).then(
        ({ sessionId, prompt }) => {
          // The socket went while the shell opened: no page knows the session, so it is let go
          // like any detached one (review 2026-10-12, I1: with no idle limit it was held forever).
          if (!this.peers.has(peer)) return this.ctx.shell.detach(sessionId)
          peer.shellSessions.add(sessionId)
          this.send(peer, { ch: 'shell', type: 'opened', payload: { sessionId, prompt, ...tag } })
        },
        (e) => fail(asError(e).code, asError(e).message, aboutOf(e)),
      )
      return
    }
    if (msg.type === 'attach') {
      // Access is read again before a session is taken back (review 2026-10-12, M8).
      if (this.shellAccessChanged(principal, owner, msg.sessionId))
        return this.closeForAccess(peer, owner, msg.sessionId)
      try {
        // A command still running finishes on this socket (review 2026-10-11).
        const { prompt, db, running } = this.ctx.shell.attach(
          owner,
          msg.sessionId,
          (part) =>
            this.send(peer, { ch: 'shell', type: part.type, payload: { ...part, sessionId: msg.sessionId } }),
          shellUser,
        )
        // The session is this socket's now: the one it left closing later never lets it go (user
        // report 2026-10-12: a reloaded page lost its shell two minutes after taking it over), and a
        // page still showing it is told (review I5: a duplicated browser tab took it without a word).
        for (const other of this.peers) {
          if (other === peer || !other.shellSessions.delete(msg.sessionId)) continue
          this.send(other, {
            ch: 'shell',
            type: 'closed',
            payload: { sessionId: msg.sessionId, reason: 'moved' },
          })
        }
        peer.shellSessions.add(msg.sessionId)
        this.send(peer, {
          ch: 'shell',
          type: 'opened',
          payload: { sessionId: msg.sessionId, prompt, db, running },
        })
      } catch {
        this.send(peer, {
          ch: 'shell',
          type: 'closed',
          payload: { sessionId: msg.sessionId, reason: 'ended' },
        })
      }
      return
    }
    if (msg.type === 'cancel') {
      try {
        this.ctx.shell.cancel(owner, msg.sessionId)
      } catch {
        // A cancel for an unknown session is ignored.
      }
      return
    }
    if (msg.type === 'close') {
      peer.shellSessions.delete(msg.sessionId)
      void this.ctx.shell.close(owner, msg.sessionId, 'closed')
      this.send(peer, {
        ch: 'shell',
        type: 'closed',
        payload: { sessionId: msg.sessionId, reason: 'closed' },
      })
      return
    }
    if (msg.type === 'complete') {
      // Phase 3a-2 spec §3.2 (A2): a completion is re-authorised exactly like a command.
      if (this.shellAccessChanged(principal, owner, msg.sessionId))
        return this.closeForAccess(peer, owner, msg.sessionId)
      const answer = (items: string[]) =>
        this.send(peer, {
          ch: 'shell',
          type: 'completions',
          payload: { sessionId: msg.sessionId, id: msg.id, items },
        })
      // An unknown session or an over-long request answers nothing: completion never shows an error.
      this.ctx.shell.complete(owner, msg.sessionId, msg.id, msg.code).then(answer, () => answer([]))
      return
    }
    if (msg.type === 'eval') {
      // Access is re-read on every command (as the monitor channel does), so a command never runs
      // under stale rules (spec §6, Review Focus 5). closeFor at the mutation points is the proactive
      // complement; this is the backstop that guarantees it at execution time.
      if (this.shellAccessChanged(principal, owner, msg.sessionId))
        return this.closeForAccess(peer, owner, msg.sessionId)
      this.ctx.shell
        .evaluate(owner, msg.sessionId, msg.id, msg.code, (part) =>
          this.send(peer, { ch: 'shell', type: part.type, payload: { ...part, sessionId: msg.sessionId } }),
        )
        .catch((e) => fail(asError(e).code, asError(e).message, aboutOf(e)))
    }
  }

  /**
   * True when the grant was revoked, the role changed, or the connection was turned read-only since
   * the session opened: nothing may run under the old rules. An unknown session is not "changed"; the
   * manager answers it itself.
   */
  private shellAccessChanged(principal: Principal, owner: string | null, sessionId: string): boolean {
    const info = this.ctx.shell.sessionInfo(owner, sessionId)
    if (!info) return false
    const record = this.ctx.connections.get(info.connectionId)
    const nowAdmin = effectiveRole(this.ctx, principal, info.connectionId) === 'admin'
    const nowReadOnly = this.ctx.config.readOnly || (record?.readOnly ?? false)
    return (
      !record ||
      !mayUseShell(this.ctx, principal, info.connectionId) ||
      nowAdmin !== info.admin ||
      nowReadOnly !== info.readOnly
    )
  }

  /** A session ended by the server: said once to each socket it was open on. */
  private shellEnded(sessionId: string, reason: string): void {
    for (const peer of this.peers) {
      if (!peer.shellSessions.delete(sessionId)) continue
      this.send(peer, { ch: 'shell', type: 'closed', payload: { sessionId, reason } })
    }
  }

  private closeForAccess(peer: Peer, owner: string | null, sessionId: string): void {
    peer.shellSessions.delete(sessionId)
    void this.ctx.shell.close(owner, sessionId, 'access')
    this.send(peer, {
      ch: 'shell',
      type: 'closed',
      payload: { sessionId, reason: 'access' },
    })
  }

  /** Phase 3e-1: the owner a feed id is scoped to (plan ruling 10). */
  private ownerOf(peer: Peer): string {
    return peer.principal.kind === 'user' ? peer.principal.userId : 'local'
  }

  /** The socket left: its feeds detach and wait out the reconnect grace. */
  private detachFeeds(peer: Peer): void {
    const owner = this.ownerOf(peer)
    for (const id of peer.feeds) void this.ctx.watch.detach(owner, id, peer.subscriber)
    peer.feeds.clear()
  }

  /**
   * Phase 3e-1: change-stream feeds. A subscription starts through the manager (access, limits,
   * filter, target); pause, resume and unsub act only on this socket's own feeds (W7).
   */
  private receiveWatch(peer: Peer, msg: Extract<ClientMessage, { ch: 'watch' }>): void {
    if (!this.current(peer)) return this.drop(peer, CLOSE.unauthenticated)
    const owner = this.ownerOf(peer)
    if (msg.type === 'sub') {
      const refuse = (reason: WatchRefusal['reason'], detail?: string) =>
        this.send(peer, {
          ch: 'watch',
          type: 'error',
          payload: { id: msg.id, reason, ...(detail !== undefined ? { detail } : {}) },
        })
      if (!peer.feeds.has(msg.id) && peer.feeds.size >= this.options.maxFeedsPerSocket)
        return refuse('limit', 'socket')
      peer.feeds.add(msg.id)
      const target = {
        connectionId: msg.connectionId,
        scope: msg.scope,
        ...(msg.db !== undefined ? { db: msg.db } : {}),
        ...(msg.coll !== undefined ? { coll: msg.coll } : {}),
      }
      this.ctx.watch
        .start(
          owner,
          {
            id: msg.id,
            target,
            filter: msg.filter,
            options: msg.options,
            ...(msg.after !== undefined ? { after: msg.after } : {}),
            ...(msg.paused !== undefined ? { paused: msg.paused } : {}),
          },
          peer.subscriber,
        )
        .catch((e: unknown) => {
          peer.feeds.delete(msg.id)
          if (e instanceof WatchRefusal) refuse(e.reason, e.detail)
          else {
            this.log.error({ err: e }, 'watch: a subscription failed')
            refuse('internal')
          }
        })
      return
    }
    if (!peer.feeds.has(msg.id)) return
    if (msg.type === 'unsub') {
      peer.feeds.delete(msg.id)
      void this.ctx.watch.stop(owner, msg.id, peer.subscriber)
    } else if (msg.type === 'pause') this.ctx.watch.pause(owner, msg.id, peer.subscriber)
    else if (msg.type === 'resume') void this.ctx.watch.resume(owner, msg.id, msg.from, peer.subscriber)
  }

  private receiveMonitor(peer: Peer, type: 'sub' | 'unsub', connectionId: string): void {
    if (type === 'unsub') {
      peer.watches.get(connectionId)?.()
      peer.watches.delete(connectionId)
      return
    }
    if (peer.watches.has(connectionId)) return
    const error = (code: 'FORBIDDEN' | 'TOO_MANY' | 'NOT_PERMITTED' | 'UNREACHABLE') =>
      this.send(peer, { ch: 'monitor', type: 'error', payload: { connectionId, code } })
    if (peer.watches.size >= this.options.maxMonitorsPerSocket) return error('TOO_MANY')
    const principal = this.current(peer)
    if (!principal) return this.drop(peer, CLOSE.unauthenticated)
    // An unknown connection answers like a forbidden one: nothing is learnt about its existence.
    if (!this.mayMonitor(principal, connectionId)) return error('FORBIDDEN')
    const off = this.ctx.monitor.subscribe(connectionId, (event) => {
      // A socket that left without a close event still stops its watches.
      if (!this.peers.has(peer)) return this.unwatchAll(peer)
      const now = this.current(peer)
      if (!now) return this.drop(peer, CLOSE.unauthenticated)
      // Access is read again for every sample, as for jobs.
      if (!this.mayMonitor(now, connectionId)) {
        peer.watches.get(connectionId)?.()
        peer.watches.delete(connectionId)
        return error('FORBIDDEN')
      }
      if ('error' in event) return error(event.error)
      this.send(peer, { ch: 'monitor', type: 'sample', payload: { ...event.sample, connectionId } })
    })
    peer.watches.set(connectionId, off)
  }

  private unwatchAll(peer: Peer): void {
    for (const off of peer.watches.values()) off()
    peer.watches.clear()
  }

  /** The socket's principal as it is now, or null when its session or user is gone. */
  private current(peer: Peer): Principal | null {
    const p = peer.principal
    // Review of the audit fixes (important 1): a browser signed out of local mode keeps no socket.
    if (p.kind === 'local') return !p.browser || this.ctx.launch?.alive(p.browser.idHash) ? p : null
    const session = this.ctx.sessions.peekHash(p.sessionIdHash)
    if (!session || session.userId !== p.userId) return null
    const user = this.ctx.users.findById(p.userId)
    if (!user || user.disabled) return null
    const now: Principal = { ...p, username: user.username, role: user.role }
    // Phase 4c §4, review I1: an administrator who must set 2FA up keeps no socket either.
    return twoFactorPending(this.ctx, now) ? null : now
  }

  /**
   * Security audit 2026-10-16: a refused hello (a wrong CSRF token: another site guessing, or a stale
   * page) is kept in the audit log — a few a minute from one address, so the log cannot be flooded;
   * the next entry says how many were left out.
   */
  private auditBadHello(peer: Peer, reason: 'csrf' | 'no_hello'): void {
    const ip = peer.subscriber.ip ?? 'unknown'
    const now = this.ctx.now()
    let window = this.helloRefusals.get(ip)
    if (!window || now - window.start >= HELLO_AUDIT_WINDOW_MS) {
      window = { start: now, count: 0, suppressed: window?.suppressed ?? 0 }
      this.helloRefusals.delete(ip)
      this.helloRefusals.set(ip, window)
      if (this.helloRefusals.size > HELLO_AUDIT_ADDRESSES)
        this.helloRefusals.delete(this.helloRefusals.keys().next().value!)
    }
    if (++window.count > HELLO_AUDIT_PER_WINDOW) {
      window.suppressed++
      return
    }
    const suppressed = window.suppressed
    window.suppressed = 0
    const principal = peer.principal
    try {
      this.ctx.audit.append({
        action: 'realtime.hello',
        outcome: 'denied',
        userId: principal.kind === 'user' ? principal.userId : null,
        username: principal.kind === 'user' ? principal.username : null,
        ip: peer.subscriber.ip,
        details: { reason, ...(suppressed > 0 ? { suppressed } : {}) },
      })
    } catch (err) {
      this.log.warn({ err }, 'realtime: a refused hello could not be audited')
    }
  }

  private beat(): void {
    for (const peer of this.peers) {
      if (peer.missedPongs >= 2) {
        this.drop(peer, CLOSE.timeout)
        continue
      }
      if (peer.ready && !this.current(peer)) {
        this.drop(peer, CLOSE.unauthenticated)
        continue
      }
      peer.missedPongs++
      peer.socket.ping()
    }
  }

  private send(peer: Peer, message: ServerMessage): void {
    if (peer.socket.readyState === peer.socket.OPEN) peer.socket.send(JSON.stringify(message))
  }

  private drop(peer: Peer, code: number): void {
    clearTimeout(peer.helloTimer)
    this.unwatchAll(peer)
    this.detachFeeds(peer)
    this.peers.delete(peer)
    if (peer.socket.readyState === peer.socket.OPEN || peer.socket.readyState === peer.socket.CONNECTING)
      peer.socket.close(code)
  }

  private closeWhere(match: (peer: Peer) => boolean, code: number = CLOSE.unauthenticated): void {
    for (const peer of [...this.peers]) if (match(peer)) this.drop(peer, code)
  }
}
