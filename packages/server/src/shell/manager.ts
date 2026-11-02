import { randomUUID } from 'node:crypto'
import { ConnectionError, SIGN_IN_REFUSED } from '../connections/errors'
import type tls from 'node:tls'
import type { ConnectionSettings, QueryOrigin } from '@mongo-manager/shared'
import type { ErrorCode } from '@mongo-manager/shared'
import { AppError } from '../errors'
import type { SocksCredentials } from '../connections/socks'
import { ShellProxy } from './proxy/proxy'
import {
  ShellToWorker,
  WorkerToShell,
  MAX_COMMAND_BYTES,
  MAX_IPC_MESSAGE_BYTES,
  OUTPUT_CAP_BYTES,
} from './ipc'
import { spawnWorker, isSea } from './spawn'
import { rssSource, type RssSource } from './rss'
import { forgetScram } from './proxy/scram'
import { MAX_MESSAGE_DEPTH, jsonDepthWithin, type WorkerProcess } from './channel'

/**
 * Phase 3a-1 spec §4–§8: owns shell sessions. Each has a sandboxed worker and an authenticating
 * proxy. The manager enforces the limits, cancels and restarts workers, closes sessions when access
 * changes, and reports each command for audit. Credentials live in the proxy; the worker gets none.
 */

const KILL_GRACE_MS = 2000
const RESTART_WINDOW_MS = 60_000
const MAX_RESTARTS = 3
const MIB = 1024 * 1024
/** Spec §4 defaults, each configurable (config.shell.rssMb, outputMb, commandsPerSecond). */
const DEFAULT_RSS_MB = 384
const DEFAULT_OUTPUT_MB = OUTPUT_CAP_BYTES / MIB
const DEFAULT_COMMANDS_PER_SECOND = 20
/**
 * Security audit 2026-10-16 (Important 2): the worker is pinged for as long as it lives, not only
 * while a command runs; one that leaves a ping unanswered this long while no command or completion
 * runs is stuck (a loop a command left behind) and is reset.
 */
const PING_MS = 1000
const HANG_MS = 15_000
/** A ping unanswered this long means the worker is busy: its memory is then measured from outside. */
const BUSY_AFTER_MS = 500
const RATE_WINDOW_MS = 1000
/** Phase 3a-2 spec §3.2: completion requests per session per second, and how long to wait for one. */
const COMPLETE_RATE_MAX = 10
const COMPLETE_TIMEOUT_MS = 2500
/** A completion the worker has not finished by then resets it, as a runaway command does. */
const COMPLETE_KILL_MS = 5000
const IPC_MAX_PER_SEC = 1000

export type Reason =
  | 'idle'
  | 'lifetime'
  | 'timeout'
  | 'memory'
  | 'ipc'
  | 'crash'
  | 'closed'
  | 'access'
  /** Closed to make room for its owner's new shell (no page held it, no command ran). */
  | 'evicted'
  /** It stopped answering while no command ran (security audit 2026-10-16). */
  | 'hang'
  /** The server refused its sign-in (sixth review of the unreachable fix, M2). */
  | 'refused'

export interface EvalPart {
  type: 'print' | 'result' | 'done' | 'error' | 'reset'
  id?: number
  text?: string
  resultType?: string | null
  value?: unknown
  prompt?: string
  message?: string
  /** Phase 3a-2: the query a cursor result came from, and whether the cursor has more. */
  origin?: QueryOrigin
  hasMore?: boolean
  /** With done: the shell's current database, after `use` too (final review M6). */
  db?: string
  /** With a result: the piece of a script it is of; with an error: the pieces left unrun. */
  command?: string
  skipped?: number
  /** With an error the page words itself: STOPPED, NOT_AVAILABLE (exit, quit, cls), DISCONNECTED, SERVER_JS. */
  code?: string
}

/**
 * The worker's error codes the page words in the user's language. SERVER_JS: the proxy refused
 * server-side JavaScript (security audit 2026-10-16).
 */
const PAGE_CODES = new Set(['STOPPED', 'NOT_AVAILABLE', 'DISCONNECTED', 'SERVER_JS'])

/** Who is opening a session: the owner, whether they are a connection admin, and read-only state. */
export interface ShellCaller extends ShellUser {
  owner: string | null
  admin: boolean
  readOnly: boolean
}

/** Who uses a session, for its audit rows (security review 2026-10-13). */
export interface ShellUser {
  username?: string | null
  ip?: string | null
}

/** The upstream a session connects to; built from the connection, injected in tests. */
export interface UpstreamPlan {
  settings: ConnectionSettings
  readOnly: boolean
  admin: boolean
  allowHost: (host: string, port: number) => boolean
  tls: tls.ConnectionOptions | null
  /** Maps the worker's named target to the actual upstream address (identity, or an SSH tunnel). */
  dial?: (host: string, port: number) => { host: string; port: number; socks?: SocksCredentials }
  /** Called when the session ends, to release a tunnel. */
  release?: () => void
}

export interface ShellAuditRow {
  action: 'shell.open' | 'shell.close' | 'shell.reset' | 'shell.eval'
  userId: string | null
  username: string | null
  ip: string | null
  connectionId: string
  db?: string
  details: Record<string, unknown>
}

export interface ShellManagerDeps {
  config: {
    shell: {
      maxPerUser: number
      maxTotal: number
      commandTimeoutMs: number
      idleMs: number
      lifetimeMs: number
      uid?: number
      gid?: number
      /** Spec §4: the worker's resident memory cap (default 384 MiB). */
      rssMb?: number
      /** Spec §4: the output of one command (default 5 MiB). */
      outputMb?: number
      /** Spec §4: commands per session per second (default 20). */
      commandsPerSecond?: number
    }
    /** The server's allowServerJs (MM_ALLOW_SERVER_JS); off (the default) refuses server JavaScript in the shell too. */
    allowServerJs?: boolean
  }
  now: () => number
  /** A session's sign-in was refused by the server: the connection keeps the refusal (manager.ts). */
  onRefused?: (connectionId: string) => void
  log: {
    warn: (o: object, m: string) => void
    info: (o: object, m: string) => void
    error: (o: object, m: string) => void
  }
  audit: (row: ShellAuditRow) => void
  /** Build the upstream plan, or throw an AppError (SHELL_UNSUPPORTED_AUTH, NOT_FOUND). */
  plan: (caller: ShellCaller, connectionId: string) => Promise<UpstreamPlan> | UpstreamPlan
  /** Record a run in history (Task 5 wires this; a no-op here). */
  record?: (owner: string | null, connectionId: string, code: string) => void
  bundlePath: string | null
  /** Tests inject a worker; production spawns one (spawnWorker). */
  spawnFn?: () => WorkerProcess
  /** Tests shorten the kill grace. */
  killGraceMs?: number
  /** How long a detached session waits for the socket to reattach before closing (default 2 min). */
  reconnectGraceMs?: number
  /** How long to wait for a worker's ready prompt before giving up (default 20s). */
  startTimeoutMs?: number
  /** How long a completion request waits for the worker before answering nothing (default 2.5s). */
  completeTimeoutMs?: number
  /** How long a completion may run in the worker before it is reset (default 5s). */
  completeKillMs?: number
  /** Mask secret-looking text before a command is audited. */
  mask?: (code: string) => string
  /** How the worker's memory is measured from outside; null for not at all (tests). */
  rss?: RssSource | null
  /** How often the worker is pinged (default 1s), and how long an unanswered ping is a hang (15s). */
  pingMs?: number
  hangMs?: number
}

interface Session {
  id: string
  /** While its worker starts: what fails the start (seventh review, I1: a refused sign-in). */
  failStart?: (e: Error) => void
  owner: string | null
  /** The page using it now: its user's name and address, for the audit rows. */
  who: { username: string | null; ip: string | null }
  connectionId: string
  db: string
  appName: string
  plan: UpstreamPlan
  proxy: ShellProxy
  proxyPort: number
  token: string
  worker: WorkerProcess | null
  ready: boolean
  /** The last prompt the worker reported (ready or a finished command), for a reattach. */
  prompt: string
  /** The shell's current database: the one opened, until `use` changes it (final review M6). */
  currentDb: string
  running: {
    id: number
    sink: (p: EvalPart) => void
    output: number
    /** The output passed the cap: the rest is dropped until the command ends. */
    truncated: boolean
    timer: ReturnType<typeof setTimeout>
    code: string
    startedAt: number
    summary: Record<string, number>
    outcome: 'ok' | 'error' | 'cancelled'
    /**
     * Ctrl+C or the time limit ended it: its operations were killed, so it may well end with MongoDB's
     * "interrupted" error and no reset — audited as cancelled or timeout all the same.
     */
    ending?: 'cancelled' | 'timeout'
    /** The find or aggregate the proxy relayed during this command (phase 3a-2). */
    origin?: QueryOrigin
  } | null
  createdAt: number
  lastActivity: number
  restarts: number[]
  reconnectTimer?: ReturnType<typeof setTimeout>
  ipcTimes: number[]
  evalTimes: number[]
  /** Completion requests in the last second (phase 3a-2). */
  completeTimes: number[]
  /** Completion replies awaited from the worker, by request id. */
  completions: Map<number, (items: string[]) => void>
  idleTimer?: ReturnType<typeof setTimeout>
  lifetimeTimer?: ReturnType<typeof setTimeout>
  /**
   * The worker's watch, for its whole life (security audit 2026-10-16, Important 2): pings, its
   * memory measured from outside, and the hang deadline.
   */
  watch?: {
    timer: ReturnType<typeof setInterval>
    worker: WorkerProcess
    /** Ticks so far; pings and measurements are paced by them. */
    ticks: number
    /** When the oldest unanswered ping was sent: the clock's time, and the tick. */
    pingSince?: number
    pingTick?: number
    lastPingTick: number
    lastSampleTick: number
    /** When the worker last stopped being busy with a command or a completion. */
    quietSince: number
    sampling: boolean
  }
  attached: boolean
  /** The origin of the last cursor shown, kept for `it` (phase 3a-2). */
  lastOrigin?: QueryOrigin
  /** Commands refused while no command ran, by name, for the next audit row (review I-3). */
  refusedWhileIdle: Record<string, number>
  /** When the last kill was asked for with no command running (one a second at most). */
  idleKillAt?: number
}

function shellError(code: ErrorCode, message: string, status = 409): AppError {
  return new AppError(code, message, status)
}

export class ShellManager {
  private readonly sessions = new Map<string, Session>()
  /** Told when a session ends, by whatever ended it (review 2026-10-11: idle, lifetime, a crash). */
  private readonly ended = new Set<(sessionId: string, reason: Reason) => void>()

  constructor(private readonly deps: ShellManagerDeps) {}

  /** Listen for sessions ending; returns the way to stop listening. */
  onEnded(listener: (sessionId: string, reason: Reason) => void): () => void {
    this.ended.add(listener)
    return () => this.ended.delete(listener)
  }

  /**
   * Opens under way, by owner: counted with the sessions, so opens made at once never all pass the
   * limits before any is counted (review 2026-10-12, I6).
   */
  private readonly opening = new Map<string | null, number>()
  private openingTotal = 0

  private countFor(owner: string | null): number {
    let n = this.opening.get(owner) ?? 0
    for (const s of this.sessions.values()) if (s.owner === owner) n++
    return n
  }

  private reserve(owner: string | null): () => void {
    this.opening.set(owner, (this.opening.get(owner) ?? 0) + 1)
    this.openingTotal++
    let released = false
    return () => {
      if (released) return
      released = true
      this.openingTotal--
      const left = (this.opening.get(owner) ?? 1) - 1
      if (left > 0) this.opening.set(owner, left)
      else this.opening.delete(owner)
    }
  }

  async open(
    caller: ShellCaller,
    connectionId: string,
    db: string,
  ): Promise<{ sessionId: string; prompt: string }> {
    const owner = caller.owner
    // The plan first: an open refused for it never closes a session to make room (review I4).
    const plan = await this.deps.plan(caller, connectionId)
    let release: () => void
    try {
      await this.makeRoom(owner)
      // Checked and counted at once (nothing awaited between): opens at once hold to the limits.
      if (this.sessions.size + this.openingTotal >= this.deps.config.shell.maxTotal)
        throw shellError('TOO_MANY', 'Too many shells are open on the server')
      if (this.countFor(owner) >= this.deps.config.shell.maxPerUser)
        throw shellError('TOO_MANY', 'You have too many shells open')
      release = this.reserve(owner)
    } catch (e) {
      plan.release?.()
      throw e
    }
    try {
      return await this.start(caller, connectionId, db, plan)
    } finally {
      release()
    }
  }

  /** The session itself: its proxy, its worker, its timers (its slot already counted). */
  private async start(
    caller: ShellCaller,
    connectionId: string,
    db: string,
    plan: UpstreamPlan,
  ): Promise<{ sessionId: string; prompt: string }> {
    const owner = caller.owner
    const id = randomUUID()
    const appName = `mm-shell:${id}`
    const proxy = new ShellProxy({
      settings: plan.settings,
      sessionId: id,
      connectionId,
      appName,
      allowHost: plan.allowHost,
      tls: plan.tls,
      readOnly: plan.readOnly,
      admin: plan.admin,
      allowServerJs: this.deps.config.allowServerJs ?? false,
      dial: plan.dial,
      onCommand: (name, refused) => this.onCommand(id, name, refused),
      onRefused: () => {
        this.deps.onRefused?.(connectionId)
        // Its worker would only fail to select a server, unsaid: it ends, saying why (M2).
        const refused = this.sessions.get(id)
        if (!refused) return
        // Still starting: the open fails now, as the refusal (not after the start's 20 s, as late).
        if (!refused.ready && refused.failStart)
          refused.failStart(new ConnectionError('auth', SIGN_IN_REFUSED))
        else void this.destroy(refused, 'refused')
      },
      // Security review 2026-10-16 (I-3): a command or completion runs, or the worker is starting.
      active: () => {
        const s = this.sessions.get(id)
        return !s || !s.ready || s.running !== null || s.completions.size > 0
      },
      onQuery: (origin) => this.onQuery(id, origin),
    })
    let listening: { port: number; token: string }
    try {
      listening = await proxy.listen()
    } catch (e) {
      // Never a session: what its plan holds goes now.
      plan.release?.()
      throw e
    }
    const { port, token } = listening
    const session: Session = {
      id,
      owner,
      connectionId,
      db,
      appName,
      plan,
      proxy,
      proxyPort: port,
      token,
      worker: null,
      ready: false,
      prompt: '>',
      currentDb: db,
      running: null,
      createdAt: this.deps.now(),
      lastActivity: this.deps.now(),
      restarts: [],
      ipcTimes: [],
      evalTimes: [],
      completeTimes: [],
      completions: new Map(),
      refusedWhileIdle: {},
      attached: true,
      who: { username: caller.username ?? null, ip: caller.ip ?? null },
    }
    this.sessions.set(id, session)
    try {
      const prompt = await this.spawn(session, true)
      this.armTimers(session)
      this.deps.audit({
        action: 'shell.open',
        userId: owner,
        ...session.who,
        connectionId,
        db,
        details: { sessionId: id },
      })
      return { sessionId: id, prompt }
    } catch (e) {
      await this.destroy(session, 'crash')
      throw e
    }
  }

  /**
   * At a limit, the caller's own sessions no page holds (a page reloaded or closed, waiting out the
   * reconnect grace) make room, oldest first — never a session a page holds, never another user's
   * (user report 2026-10-12: "too many shells open" after a reload with none open).
   */
  private async makeRoom(owner: string | null): Promise<void> {
    const { maxTotal, maxPerUser } = this.deps.config.shell
    while (this.sessions.size + this.openingTotal >= maxTotal || this.countFor(owner) >= maxPerUser) {
      // Never one whose command runs: a page reloaded during a long write comes back to it (review I4).
      const unheld = [...this.sessions.values()]
        .filter((s) => s.owner === owner && !s.attached && !s.running)
        .sort((a, b) => a.lastActivity - b.lastActivity)[0]
      if (!unheld) return
      await this.destroy(unheld, 'evicted')
    }
  }

  /** Start (or restart) the worker and wait for its ready prompt. */
  /** `opening`: the open waits on it, and a refused sign-in fails it at once (a restart ends instead). */
  private spawn(session: Session, opening = false): Promise<string> {
    const child =
      this.deps.spawnFn?.() ??
      spawnWorker({
        bundlePath: this.deps.bundlePath,
        uid: this.deps.config.shell.uid,
        gid: this.deps.config.shell.gid,
        seaSubcommand: isSea(),
      })
    session.worker = child
    session.ready = false
    let stderr = ''
    child.stderr?.on('data', (b: Buffer) => {
      stderr = (stderr + b.toString()).slice(-64 * 1024)
    })
    // What a worker already replaced still sends is no business of its successor's (security
    // review 2026-10-16: it could have reset the new one).
    child.on('message', (raw: unknown) => {
      if (session.worker === child) this.onWorkerMessage(session, raw)
    })
    // The channel refused a message before parsing it: too large, or not JSON (security audit
    // 2026-10-16). Treated as any other IPC violation.
    // A line on stdout that is no message (a library's own output): set aside, and logged once.
    let noted = false
    child.on('noise', (text: string) => {
      if (noted) return
      noted = true
      this.deps.log.warn({ sessionId: session.id, text: text.slice(0, 200) }, 'shell worker wrote to stdout')
    })
    child.on('violation', () => {
      if (this.sessions.get(session.id) === session && session.worker === child) this.reset(session, 'ipc')
    })
    child.on('exit', () => {
      if (stderr)
        this.deps.log.warn({ sessionId: session.id, stderr: stderr.slice(0, 2048) }, 'shell worker stderr')
      if (this.sessions.get(session.id) === session && session.worker === child) this.onWorkerGone(session)
    })
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.failStart = undefined
        reject(shellError('BUSY', 'The shell did not start in time', 500))
      }, this.deps.startTimeoutMs ?? 20_000)
      if (opening)
        session.failStart = (e) => {
          clearTimeout(timer)
          child.off('message', onReady)
          session.failStart = undefined
          reject(e)
        }
      const onReady = (raw: unknown): void => {
        const parsed = WorkerToShell.safeParse(raw)
        if (!parsed.success) return
        if (parsed.data.type === 'ready') {
          clearTimeout(timer)
          child.off('message', onReady)
          session.ready = true
          this.startWatch(session, child)
          session.prompt = parsed.data.prompt
          // A new worker starts on the database the session opened.
          session.currentDb = session.db
          session.failStart = undefined
          resolve(parsed.data.prompt)
        } else if (parsed.data.type === 'error' && parsed.data.id === 0) {
          clearTimeout(timer)
          child.off('message', onReady)
          session.failStart = undefined
          reject(shellError('BUSY', parsed.data.message, 502))
        }
      }
      child.on('message', onReady)
      this.send(session, {
        type: 'init',
        proxyPort: session.proxyPort,
        token: session.token,
        uri: this.workerUri(session),
        db: session.db,
        appName: session.appName,
        syncTimeoutMs: this.deps.config.shell.commandTimeoutMs,
        outputCapBytes: this.outputCap(),
      })
    })
  }

  /** The worker's URI: the connection's hosts and topology, but no credential, TLS or SSH option. */
  private workerUri(session: Session): string {
    const s = session.plan.settings
    const hosts = s.hosts.map((h) => `${h.host}${h.port ? `:${h.port}` : ''}`).join(',')
    const params = new URLSearchParams()
    if (s.hosts.length === 1) params.set('directConnection', 'true')
    if (s.replicaSet) params.set('replicaSet', s.replicaSet)
    params.set('appName', session.appName)
    params.set('serverSelectionTimeoutMS', '8000')
    // The db in the path makes it the shell's current database, as mongosh does for a URI with one.
    return `mongodb://${hosts}/${encodeURIComponent(session.db)}?${params.toString()}`
  }

  private send(session: Session, message: ShellToWorker): void {
    session.worker?.send(message)
  }

  private onWorkerMessage(session: Session, raw: unknown): void {
    // Enforce the IPC message rate.
    const now = this.deps.now()
    session.ipcTimes = session.ipcTimes.filter((t) => now - t < 1000)
    session.ipcTimes.push(now)
    if (session.ipcTimes.length > IPC_MAX_PER_SEC) return void this.reset(session, 'ipc')

    const size = safeSize(raw)
    if (size > MAX_IPC_MESSAGE_BYTES) return void this.reset(session, 'ipc')

    const parsed = WorkerToShell.safeParse(raw)
    if (!parsed.success) return void this.reset(session, 'ipc')
    const message = parsed.data
    const run = session.running
    if (message.type === 'ready') return // handled in spawn
    if (message.type === 'completions') {
      // A reply after the request gave up (or for an unknown id) is simply dropped: not a violation.
      const resolve = session.completions.get(message.id)
      session.completions.delete(message.id)
      resolve?.(message.items)
      return
    }
    if (message.type === 'pong') {
      if (session.watch) session.watch.pingSince = session.watch.pingTick = undefined
      if (message.rss > this.rssCap()) this.reset(session, 'memory')
      return
    }
    // Output with no command running: a worker streaming it unseen kept the server parsing without
    // end (security review 2026-10-16, I-7). Before the worker is ready, nothing but ready counts.
    if (!run) return void (session.ready ? this.reset(session, 'ipc') : undefined)
    if ('id' in message && message.id !== run.id && message.id !== 0) return void this.reset(session, 'ipc')

    if (message.type === 'truncated') {
      // The worker held back a result too large to send (security audit 2026-10-16): said once.
      if (!run.truncated) this.truncate(run)
      return
    }

    if (message.type === 'print') {
      // Past the cap, what the command prints is dropped until it ends: it is never ended early,
      // for the worker would still be running it (review 2026-10-12, I5: the next command was then
      // refused and the worker reset).
      if (run.truncated) return
      run.output += Buffer.byteLength(message.text)
      if (run.output > this.outputCap()) return this.truncate(run)
      run.sink({ type: 'print', id: run.id, text: message.text })
    } else if (message.type === 'result') {
      if (run.truncated) return
      // Its depth was measured with the whole message, above.
      const size = safeSize(message.value, { depthKnown: true })
      if (run.output + size > this.outputCap()) {
        this.truncate(run)
      } else {
        run.output += size
        const origin = this.resultOrigin(session, message.resultType)
        run.sink({
          type: 'result',
          id: run.id,
          resultType: message.resultType,
          value: message.value,
          ...(origin ? { origin } : {}),
          ...(message.hasMore !== undefined ? { hasMore: message.hasMore } : {}),
          ...(message.command !== undefined ? { command: message.command } : {}),
        })
      }
    } else if (message.type === 'error') {
      // A script stopped on request was cancelled, not failed (second review 2026-10-12, minor 15).
      run.outcome = message.code === 'STOPPED' ? 'cancelled' : 'error'
      run.sink({
        type: 'error',
        id: run.id,
        message: message.message,
        // The codes the page words itself; any other error is shown as the shell said it.
        ...(PAGE_CODES.has(message.code) ? { code: message.code } : {}),
        ...(message.skipped !== undefined ? { skipped: message.skipped } : {}),
      })
    } else if (message.type === 'done') {
      session.prompt = message.prompt
      if (message.db) session.currentDb = message.db
      this.finishRun(session, message)
    }
  }

  /** The output passed the cap: said once; the rest of the command's output is dropped. */
  private truncate(run: NonNullable<Session['running']>): void {
    run.truncated = true
    run.sink({ type: 'print', id: run.id, text: '\n[output truncated]' })
  }

  private finishRun(session: Session, done: { prompt: string; db?: string }): void {
    const run = session.running
    if (!run) return
    clearTimeout(run.timer)
    this.quiet(session)
    this.auditEval(session, run.ending ?? run.outcome)
    run.sink({ type: 'done', id: run.id, prompt: done.prompt, ...(done.db ? { db: done.db } : {}) })
    session.running = null
    // A request still unanswered once the command ended was left running by its code (`void
    // db.c.aggregate(…)`): its operation is killed (security review 2026-10-16, I-3).
    if (session.proxy.endCommand()) this.killOps(session, 'done')
  }

  /** One shell.eval audit row per command: masked code, outcome, duration, proxy command summary. */
  private auditEval(session: Session, outcome: string): void {
    const run = session.running
    if (!run) return
    const mask = this.deps.mask ?? ((c: string) => c)
    this.deps.audit({
      action: 'shell.eval',
      userId: session.owner,
      ...session.who,
      connectionId: session.connectionId,
      db: session.db,
      details: {
        sessionId: session.id,
        code: mask(run.code).slice(0, 2048),
        // A script of many lines is kept in part: how long it was says what was left out (second
        // review 2026-10-12, minor 16). No hash of it: one of short code could be guessed back.
        codeBytes: Buffer.byteLength(run.code),
        outcome,
        durationMs: this.deps.now() - run.startedAt,
        commands: run.summary,
        ...this.takeIdleRefusals(session),
      },
    })
  }

  async evaluate(
    owner: string | null,
    sessionId: string,
    id: number,
    code: string,
    sink: (p: EvalPart) => void,
  ): Promise<void> {
    const session = this.sessionOf(owner, sessionId)
    if (code.length > MAX_COMMAND_BYTES) throw shellError('BUSY', 'The command is too long', 413)
    if (session.running) throw shellError('BUSY', 'A command is already running in this shell')
    // A worker starting again after a reset takes no command yet: one sent now would be dropped
    // unseen and run into its timeout (security audit 2026-10-16: resets are more frequent now).
    if (!session.ready || !session.worker)
      throw shellError('BUSY', 'The shell is starting again after a reset; try again in a moment')
    // The last command's operations are being killed: a new one could be caught by that kill
    // (review 2026-10-16, minor).
    if (session.proxy.killing)
      throw shellError('BUSY', "The last command's operations are being ended; try again in a moment")
    const now = this.deps.now()
    session.evalTimes = session.evalTimes.filter((t) => now - t < RATE_WINDOW_MS)
    if (session.evalTimes.length >= (this.deps.config.shell.commandsPerSecond ?? DEFAULT_COMMANDS_PER_SECOND))
      throw shellError('RATE_LIMITED', 'Too many commands; slow down', 429)
    session.evalTimes.push(now)
    session.lastActivity = now
    this.armTimers(session)

    const timer = setTimeout(() => this.onTimeout(session), this.deps.config.shell.commandTimeoutMs)
    session.running = {
      id,
      sink,
      output: 0,
      truncated: false,
      timer,
      code,
      startedAt: now,
      summary: {},
      outcome: 'ok',
    }
    this.deps.record?.(owner, session.connectionId, code)
    this.send(session, { type: 'eval', id, code })
  }

  /**
   * Phase 3a-2 spec §3.2: ask the worker to complete the code. Bounded like evaluate: the same
   * ownership check and size cap, at most 10 requests a second, nothing while a command runs or the
   * worker is not ready (the request is then never sent), and an answer of nothing after the timeout.
   */
  async complete(owner: string | null, sessionId: string, id: number, code: string): Promise<string[]> {
    const session = this.sessionOf(owner, sessionId)
    if (code.length > MAX_COMMAND_BYTES) throw shellError('BUSY', 'The command is too long', 413)
    if (session.running || !session.ready || !session.worker) return []
    // One completion at a time, until the worker has really answered — not only until the client
    // stopped waiting — so completion work stays bounded (final review I2).
    if (session.completions.size > 0) return []
    const now = this.deps.now()
    session.completeTimes = session.completeTimes.filter((t) => now - t < RATE_WINDOW_MS)
    if (session.completeTimes.length >= COMPLETE_RATE_MAX) return []
    session.completeTimes.push(now)
    session.lastActivity = now
    this.armTimers(session)
    return new Promise<string[]>((resolve) => {
      let answered = false
      const answer = (items: string[]): void => {
        if (!answered) {
          answered = true
          resolve(items)
        }
      }
      // The client gets nothing after the wait; the worker's reply still ends the completion.
      const wait = setTimeout(() => answer([]), this.deps.completeTimeoutMs ?? COMPLETE_TIMEOUT_MS)
      // A completion the worker never finishes is stopped the way a runaway command is.
      const kill = setTimeout(() => {
        if (session.completions.get(id) === finish) this.reset(session, 'timeout')
      }, this.deps.completeKillMs ?? COMPLETE_KILL_MS)
      const finish = (items: string[]): void => {
        clearTimeout(wait)
        clearTimeout(kill)
        this.quiet(session)
        answer(items)
      }
      session.completions.set(id, finish)
      this.send(session, { type: 'complete', id, code })
    })
  }

  /** Answer every awaited completion with nothing (the worker is being reset or the session closed). */
  private dropCompletions(session: Session): void {
    const pending = [...session.completions.values()]
    session.completions.clear()
    for (const resolve of pending) resolve([])
  }

  cancel(owner: string | null, sessionId: string): void {
    const session = this.sessionOf(owner, sessionId)
    const run = session.running
    if (!run) {
      // Nothing runs, but code a command left running may hold an operation open (security review
      // 2026-10-16, I-3): killed too, at most once a second.
      const now = this.deps.now()
      if (session.idleKillAt !== undefined && now - session.idleKillAt < 1000) return
      session.idleKillAt = now
      return this.killOps(session, 'cancel')
    }
    // A burst of Ctrl+C is one cancel: one kill, one grace (security review 2026-10-16, I-4).
    if (run.ending === 'cancelled') return
    run.ending ??= 'cancelled'
    this.send(session, { type: 'cancel', id: run.id })
    // Spec §5.4: the operations tagged with this session's appName are killed on MongoDB (security
    // audit 2026-10-16: they ran on); if the worker does not report done shortly, restart it.
    this.killOps(session, 'cancel')
    setTimeout(() => {
      if (session.running && session.running.id === run.id) this.reset(session, 'timeout')
    }, this.deps.killGraceMs ?? KILL_GRACE_MS)
  }

  private onTimeout(session: Session): void {
    const run = session.running
    if (!run) return
    run.ending = 'timeout'
    this.send(session, { type: 'cancel', id: run.id })
    this.killOps(session, 'timeout')
    setTimeout(() => {
      if (session.running && session.running.id === run.id) this.reset(session, 'timeout')
    }, this.deps.killGraceMs ?? KILL_GRACE_MS)
  }

  /**
   * Security audit 2026-10-16 (Important 3): end the session's operations on MongoDB, in the
   * background; what was killed, or why it could not be, goes to the log.
   */
  private killOps(session: Session, why: string): void {
    session.proxy.killOps().then(
      (killed) => {
        if (killed > 0) this.deps.log.info({ sessionId: session.id, killed, why }, 'shell: operations killed')
      },
      (err: unknown) =>
        this.deps.log.warn({ sessionId: session.id, err, why }, 'shell: could not kill operations'),
    )
  }

  /** Kill and restart the worker, keeping the session; the client is told it was reset. */
  private reset(session: Session, reason: Reason): void {
    if (!this.sessions.has(session.id)) return
    const now = this.deps.now()
    session.restarts = session.restarts.filter((t) => now - t < RESTART_WINDOW_MS)
    session.restarts.push(now)
    this.deps.audit({
      action: 'shell.reset',
      userId: session.owner,
      ...session.who,
      connectionId: session.connectionId,
      details: { sessionId: session.id, reason },
    })
    const run = session.running
    if (run) {
      clearTimeout(run.timer)
      // Its operations would run on without the worker (security audit 2026-10-16, I3).
      this.killOps(session, reason)
      // The command did not finish normally; record how it ended.
      this.auditEval(session, reason === 'timeout' ? 'timeout' : 'cancelled')
      session.running = null
      run.sink({ type: 'reset', message: 'The shell was reset; variables were lost' })
      run.sink({ type: 'done', id: run.id, prompt: '>' })
    }
    session.running = null
    this.stopWatch(session)
    const worker = session.worker
    session.worker = null
    session.ready = false
    this.dropCompletions(session)
    worker?.removeAllListeners('exit')
    worker?.kill('SIGKILL')
    // Spec §4: three restarts within a minute close the session (this reset is one of them).
    if (session.restarts.length >= MAX_RESTARTS) {
      void this.close(session.owner, session.id, 'crash')
      return
    }
    this.spawn(session).catch(() => void this.close(session.owner, session.id, 'crash'))
  }

  private rssCap(): number {
    return (this.deps.config.shell.rssMb ?? DEFAULT_RSS_MB) * MIB
  }

  private outputCap(): number {
    return Math.round((this.deps.config.shell.outputMb ?? DEFAULT_OUTPUT_MB) * MIB)
  }

  /** How the worker's memory is measured from outside: the platform's way, unless one is injected. */
  private get rss(): RssSource | null {
    if (this.deps.rss !== undefined) return this.deps.rss
    this.platformRss ??= { source: rssSource() }
    return this.platformRss.source
  }
  private platformRss?: { source: RssSource | null }

  /** A command or completion just ended: an unanswered ping is judged from now on. */
  private quiet(session: Session): void {
    if (session.watch) session.watch.quietSince = this.deps.now()
  }

  /**
   * Security audit 2026-10-16 (Important 2): watch a ready worker until it goes. Each tick pings it
   * (its answer carries its memory); measures its resident memory from the operating system — often
   * while it does not answer (busy in synchronous code, where an ArrayBuffer balloon happens), now
   * and then while it does (its answers are not taken on trust); and resets it past the cap, or when
   * it has not answered for the hang deadline while no command or completion runs.
   */
  private startWatch(session: Session, worker: WorkerProcess): void {
    this.stopWatch(session)
    const pingMs = this.deps.pingMs ?? PING_MS
    const source = this.rss
    const tickMs = Math.max(10, Math.min(pingMs, source?.busyMs ?? pingMs))
    const every = (ms: number) => Math.max(1, Math.round(ms / tickMs))
    const pace = {
      ping: every(pingMs),
      busy: every(Math.min(BUSY_AFTER_MS, pingMs)),
      sampleBusy: every(source?.busyMs ?? pingMs),
      sampleIdle: every(source?.idleMs ?? pingMs),
    }
    const watch: NonNullable<Session['watch']> = {
      worker,
      timer: setInterval(() => this.tick(session, watch, pace, source), tickMs),
      ticks: 0,
      lastPingTick: -pace.ping,
      lastSampleTick: 0,
      quietSince: this.deps.now(),
      sampling: false,
    }
    watch.timer.unref?.()
    session.watch = watch
  }

  private stopWatch(session: Session): void {
    if (session.watch) clearInterval(session.watch.timer)
    session.watch = undefined
  }

  private tick(
    session: Session,
    watch: NonNullable<Session['watch']>,
    pace: { ping: number; busy: number; sampleBusy: number; sampleIdle: number },
    source: RssSource | null,
  ): void {
    if (session.watch !== watch || session.worker !== watch.worker) return void clearInterval(watch.timer)
    const tick = ++watch.ticks
    const now = this.deps.now()
    const busy = session.running !== null || session.completions.size > 0
    // A hang: no answer for the deadline, counted from when the worker last had nothing to do.
    if (!busy && watch.pingSince !== undefined) {
      const since = Math.max(watch.pingSince, watch.quietSince)
      if (now - since >= (this.deps.hangMs ?? HANG_MS)) return void this.reset(session, 'hang')
    }
    // One ping at a time: a busy worker finds one waiting, not a pile (review 2026-10-16, minor).
    if (watch.pingSince === undefined && tick - watch.lastPingTick >= pace.ping) {
      watch.lastPingTick = tick
      watch.pingSince ??= now
      watch.pingTick ??= tick
      this.send(session, { type: 'ping' })
    }
    const pid = watch.worker.pid
    if (!source || !pid || watch.sampling) return
    const unanswered = watch.pingTick !== undefined && tick - watch.pingTick >= pace.busy
    if (tick - watch.lastSampleTick < (unanswered ? pace.sampleBusy : pace.sampleIdle)) return
    watch.lastSampleTick = tick
    watch.sampling = true
    source
      .read(pid)
      .then((bytes) => {
        if (bytes !== null && bytes > this.rssCap() && session.watch === watch) this.reset(session, 'memory')
      })
      .catch(() => undefined)
      .finally(() => {
        watch.sampling = false
      })
  }

  private onWorkerGone(session: Session): void {
    // The worker exited on its own (crash or OOM); restart under the same budget.
    this.reset(session, 'crash')
  }

  /** An allowed find/aggregate seen by the proxy; only one inside a running command counts. */
  private onQuery(sessionId: string, origin: () => QueryOrigin | null): void {
    const session = this.sessions.get(sessionId)
    // While a completion is pending, what the proxy sees may be the completer's own sample query:
    // it is never credited to the command (final review I2). The origin is worked out only here,
    // for a query that counts (final review M9).
    if (!session?.running || session.completions.size > 0) return
    const found = origin()
    if (found) session.running.origin = found
  }

  /**
   * Phase 3a-2 spec §3.3: a result carries an origin only when it is the cursor of the query the
   * command ran; `it` keeps the last cursor's origin; any other result forgets it.
   */
  private resultOrigin(session: Session, resultType: string | null): QueryOrigin | undefined {
    if (resultType === 'Cursor' || resultType === 'AggregationCursor') {
      session.lastOrigin = session.running?.origin
      return session.lastOrigin
    }
    if (resultType === 'CursorIterationResult') return session.lastOrigin
    session.lastOrigin = undefined
    return undefined
  }

  /** The commands refused while no command ran since the last audit row, for the next one. */
  private takeIdleRefusals(session: Session): { refusedWhileIdle?: Record<string, number> } {
    const refused = session.refusedWhileIdle
    if (Object.keys(refused).length === 0) return {}
    session.refusedWhileIdle = {}
    return { refusedWhileIdle: refused }
  }

  private onCommand(sessionId: string, name: string, refused: boolean): void {
    const session = this.sessions.get(sessionId)
    // Refused while nothing ran: what code a command left running tried (security review I-3).
    if (session && !session.running && session.completions.size === 0 && refused) {
      if (Object.keys(session.refusedWhileIdle).length < 100 || name in session.refusedWhileIdle)
        session.refusedWhileIdle[name] = (session.refusedWhileIdle[name] ?? 0) + 1
      return
    }
    if (!session || !session.running || session.completions.size > 0) return
    const key = refused ? `refused:${name}` : name
    session.running.summary[key] = (session.running.summary[key] ?? 0) + 1
  }

  /**
   * The operator's idle and lifetime limits, when set (0: none, the default). User report 2026-10-12
   * ("Uzun zaman kullanılmayan Shell neden kapanıyor"): a shell its page holds stays open however long
   * it is not used, as Compass's does; one no page holds still goes after the reconnect grace.
   */
  private armTimers(session: Session): void {
    clearTimeout(session.idleTimer)
    session.idleTimer = undefined
    if (this.deps.config.shell.idleMs > 0)
      session.idleTimer = setTimeout(
        () => void this.close(session.owner, session.id, 'idle'),
        this.deps.config.shell.idleMs,
      )
    if (!session.lifetimeTimer && this.deps.config.shell.lifetimeMs > 0) {
      session.lifetimeTimer = setTimeout(
        () => void this.close(session.owner, session.id, 'lifetime'),
        this.deps.config.shell.lifetimeMs,
      )
    }
  }

  private sessionOf(owner: string | null, sessionId: string): Session {
    const session = this.sessions.get(sessionId)
    if (!session || session.owner !== owner) throw shellError('NOT_FOUND', 'Shell session not found', 404)
    return session
  }

  /**
   * A socket came back for the session. `sink` takes over the output of a command still running
   * (review 2026-10-11: it went to the socket that dropped, and never finished on screen).
   */
  attach(
    owner: string | null,
    sessionId: string,
    sink?: (p: EvalPart) => void,
    /** The page taking it: its rows carry this page's address from now on. */
    who?: ShellUser,
  ): { prompt: string; db: string; running: boolean } {
    const session = this.sessionOf(owner, sessionId)
    session.attached = true
    if (who) session.who = { username: who.username ?? null, ip: who.ip ?? null }
    clearTimeout(session.reconnectTimer)
    session.reconnectTimer = undefined
    this.armTimers(session)
    if (session.running && sink) session.running.sink = sink
    return { prompt: session.prompt, db: session.currentDb, running: session.running !== null }
  }

  /** The socket dropped: keep the session for the reconnect grace, then close it if no one returns. */
  detach(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.attached = false
    clearTimeout(session.reconnectTimer)
    session.reconnectTimer = setTimeout(
      () => void this.close(session.owner, session.id, 'closed'),
      this.deps.reconnectGraceMs ?? 120_000,
    )
  }

  async close(owner: string | null, sessionId: string, reason: Reason): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session || session.owner !== owner) return
    await this.destroy(session, reason)
  }

  /**
   * The connection and the rules a session was opened with, for the hub to re-check access on every
   * command. Undefined when the session is unknown or not owned by the caller.
   */
  sessionInfo(
    owner: string | null,
    sessionId: string,
  ): { connectionId: string; admin: boolean; readOnly: boolean } | undefined {
    const s = this.sessions.get(sessionId)
    if (!s || s.owner !== owner) return undefined
    return { connectionId: s.connectionId, admin: s.plan.admin, readOnly: s.plan.readOnly }
  }

  /** Close every session matching a connection or user (grant removed, user deleted, sign-out). */
  async closeFor(match: { connectionId?: string; userId?: string | null }, reason: Reason): Promise<void> {
    const doomed = [...this.sessions.values()].filter(
      (s) =>
        (match.connectionId === undefined || s.connectionId === match.connectionId) &&
        (match.userId === undefined || s.owner === match.userId),
    )
    for (const s of doomed) await this.destroy(s, reason)
    // The connection changed or was deleted (or its grants did): its salted passwords go too, so
    // none outlives a password change (second review 2026-10-16).
    if (match.connectionId !== undefined && match.userId === undefined) forgetScram(match.connectionId)
  }

  private async destroy(session: Session, reason: Reason): Promise<void> {
    if (!this.sessions.delete(session.id)) return
    clearTimeout(session.idleTimer)
    clearTimeout(session.lifetimeTimer)
    clearTimeout(session.reconnectTimer)
    this.stopWatch(session)
    this.dropCompletions(session)
    if (session.running) {
      clearTimeout(session.running.timer)
      session.running.sink({ type: 'error', message: `The shell was closed (${reason})` })
      session.running.sink({ type: 'done', id: session.running.id, prompt: '>' })
    }
    // A command still running: its operations end too, before the tunnel they need is released
    // (security audit 2026-10-16, I3; bounded in the proxy). Asked for before the worker goes, while
    // its connections are still there to name.
    const killing = session.running !== null ? session.proxy.killOps().catch(() => 0) : null
    const worker = session.worker
    session.worker = null
    worker?.removeAllListeners('exit')
    worker?.kill('SIGKILL')
    await killing
    await session.proxy.close()
    session.plan.release?.()
    this.deps.audit({
      action: 'shell.close',
      userId: session.owner,
      ...session.who,
      connectionId: session.connectionId,
      details: { sessionId: session.id, reason, ...this.takeIdleRefusals(session) },
    })
    for (const listener of this.ended) {
      try {
        listener(session.id, reason)
      } catch (err) {
        this.deps.log.error({ err }, 'shell: a session-ended listener failed')
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const session of [...this.sessions.values()]) await this.destroy(session, 'closed')
  }

  /** For tests and /metrics. */
  count(): number {
    return this.sessions.size
  }
}

/**
 * Bytes a value takes as JSON; Infinity for one too deep to pass on. `depthKnown` for a part of a
 * message whose depth was measured already (review 2026-10-17, minor 8: not scanned twice).
 */
function safeSize(raw: unknown, { depthKnown = false } = {}): number {
  let text: string
  try {
    text = JSON.stringify(raw) ?? ''
  } catch {
    // Too deep to write is too deep to pass on: refused, never counted as nothing (security review
    // 2026-10-16, I-6).
    return Infinity
  }
  // Node 26 writes a value of any depth: deeper than the channel takes is refused the same way.
  return depthKnown || jsonDepthWithin(text, MAX_MESSAGE_DEPTH) ? Buffer.byteLength(text) : Infinity
}
