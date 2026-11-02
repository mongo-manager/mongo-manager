import {
  MongoClient,
  type AutoEncryptionOptions,
  type Document,
  type MongoClientOptions,
  type OIDCCallbackFunction,
} from 'mongodb'
import {
  MIN_MONGODB_VERSION,
  isSupportedMongoVersion,
  type ConnectionSettings,
  type SshSettings,
} from '@mongo-manager/shared'
import { clientSpec, type SignInHooks } from './client-spec'
import { ConnectionError, OIDC_PER_PERSON, classifyError, type ConnectionErrorKind } from './errors'
import { connectionProblem, type ConnectionPolicy } from './policy'
import type { SocksCredentials } from './socks'

/**
 * W7, W8 (completion): who a client is for. In team mode a connection that signs each person in
 * with OIDC has a client per person, never shared (their own tokens); a connection with client-side
 * encryption has a client that decrypts — for interactive use by someone who may see the data — and
 * one that reads values as stored (everything else: jobs, copies, monitoring).
 */
export interface ClientAs {
  /** The person whose OIDC tokens sign in: a team user's id (local mode has only 'local'). */
  user?: string | null
  /** Decrypt reads and encrypt writes automatically (W8). */
  decrypt?: boolean
}

/** No policy given: nothing that signs in as the server or loads native code (the safe side). */
const CLOSED_POLICY: ConnectionPolicy = {
  teamMode: true,
  allowKerberos: false,
  allowWorkloadIdentity: false,
  cryptSharedLibPath: undefined,
  kmsAllowedHosts: [],
  modules: {
    distribution: 'source',
    clientEncryption: { status: 'missing', version: null },
    kerberos: { status: 'missing', version: null },
  },
}

interface Scope {
  /** OIDC with a person's own sign-in, in team mode: a client per person. */
  perPerson: boolean
  oidc: boolean
  encrypted: boolean
}

const SEP = '\u0000'
const connectionOf = (key: string): string => key.split(SEP, 1)[0]!

/**
 * Fourth review of the unreachable fix (I1): a sign-in the server refused was tried again unasked
 * (the health check every 30 s, each widget and tab, Retry twice over), and with a directory's
 * lockout rules that locks the account out. A refusal is kept for this long, or until the
 * connection is edited, a person signs in again, or a test of it passes; meanwhile the server is
 * not dialled for it and the refusal is said again, marked as kept.
 */
export const REFUSAL_KEPT_MS = 5 * 60_000
/**
 * Fifth review (M2): a refusal is the credential's, kept by connection and person: the decrypting
 * client signs in with the same one as the plain client, and is not refused a second time.
 */
const refusalKeyOf = (key: string): string =>
  key
    .split(SEP)
    .filter((part) => part !== 'decrypt')
    .join(SEP)
/** Fifth review (nit 2): a clock that never goes back, so a refusal is never kept longer. */
const monotonic = (): number => performance.now()
/** Whether a client key is a person's (W7) or, with no person in it, the connection's own. */
const personOfKey = (key: string): string | null =>
  key
    .split(SEP)
    .find((part) => part.startsWith('u:'))
    ?.slice(2) ?? null
/** What is a refusal: a sign-in refused (MongoDB's or SSH's), or an SSH host key that changed. */
export function isRefusal(e: ConnectionError): boolean {
  if (e.kind === 'auth' || e.kind === 'ssh-host-key') return true
  // ssh2's words when every method it tried was refused (a network failure says otherwise).
  return e.kind === 'ssh' && /authentication methods failed/i.test(e.message)
}

export interface Tunnel {
  localPort: number
  /** The SOCKS5 user name and password the local endpoint answers to (made for each tunnel). */
  credentials: SocksCredentials
  fingerprint: string
  /** Called once when the SSH session ends for any reason (immediately if it already has). */
  onClose(listener: () => void): void
  close(): Promise<void>
}

export type OpenTunnel = (
  ssh: SshSettings,
  target: { host: string; port: number },
  /** `signal`: the open was stopped (the app closes, the connection changed): the handshake ends. */
  opts?: { readyTimeoutMs?: number; signal?: AbortSignal },
) => Promise<Tunnel>

export interface ManagerDeps {
  load(id: string): { settings: ConnectionSettings } | undefined
  /** `dialled`: the SSH host the key came from (review of the open's stop, minor 6). */
  pinFingerprint?(id: string, fingerprint: string, dialled: SshSettings): void
  openTunnel?: OpenTunnel
  idleMs?: number
  /** Hard deadline for a whole connection test, every phase included (default 6 s). */
  testTimeoutMs?: number
  /** Connection tests allowed at the same time (default 8). */
  maxConcurrentTests?: number
  /**
   * Runs once a saved connection's client is open, before anyone else uses it; failures are ignored.
   * `signal`: the open was stopped, and the client is being closed.
   */
  onOpen?(id: string, client: MongoClient, signal: AbortSignal): Promise<void>
  /** W7, W8: what this server allows (mode, its settings, the optional packages). */
  policy?: () => ConnectionPolicy
  /** W7: the OIDC broker's callback for a connection and a person ('local' in local mode). */
  oidcCallback?(connectionId: string, user: string): OIDCCallbackFunction
  /** W8: the automatic encryption of a connection's decrypting client (null: a test of settings). */
  autoEncryption?(connectionId: string | null, settings: ConnectionSettings): Promise<AutoEncryptionOptions>
  /** Tests build fake clients. */
  createClient?(uri: string, options: MongoClientOptions): MongoClient
}

/** W7: a connection test's sign-in — this person's tokens of a saved connection, or a probe. */
export interface TestAs {
  oidcCallback?: OIDCCallbackFunction
}

export type TestResult =
  | {
      ok: true
      latencyMs: number
      serverVersion: string
      topology: 'standalone' | 'replicaSet' | 'sharded' | 'loadBalanced'
      setName?: string
      sshFingerprint?: string
    }
  | {
      ok: false
      error: {
        kind: ConnectionErrorKind
        message: string
        sshFingerprint?: string
        /** Sixth review (M4): a refusal kept, said again with nothing dialled. */
        remembered?: boolean
        /** W7: the identity provider the server named (an OIDC sign-in is needed). */
        issuer?: string
      }
    }

interface Entry {
  client: MongoClient
  tunnel?: Tunnel
  /** buildInfo.version, read once when the client opened. */
  version: string
  timer?: NodeJS.Timeout
}

const PHASE_TIMEOUT_MS = 5_000
/** Why a client still opening was stopped: the server closes, or its connection changed or went. */
const SHUTTING_DOWN = 'The server is shutting down'
const CHANGED_WHILE_OPENING =
  'The connection was edited, removed or signed out while it was opening; try again'

/**
 * Settles as `work` does, or rejects with the signal's reason at once when it is stopped. `work` is
 * watched either way: left unwatched, its later failure would end the process (second review of
 * the open's stop, minor 1).
 */
export function unlessStopped<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  return new Promise<T>((resolve, reject) => {
    const stopped = () => reject(signal.reason)
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stopped))
    if (signal.aborted) return stopped()
    signal.addEventListener('abort', stopped, { once: true })
  })
}

async function closeEntry(entry: Entry): Promise<void> {
  if (entry.timer) clearTimeout(entry.timer)
  await entry.client.close().catch(() => undefined)
  await entry.tunnel?.close().catch(() => undefined)
}

export function topologyOf(hello: Document): 'standalone' | 'replicaSet' | 'sharded' | 'loadBalanced' {
  if (hello.msg === 'isdbgrid') return 'sharded'
  if (hello.serviceId) return 'loadBalanced'
  if (hello.setName) return 'replicaSet'
  return 'standalone'
}

export class ConnectionManager {
  /** Clients by key: the connection id, then (W7, W8) a person and whether it decrypts. */
  private readonly entries = new Map<string, Promise<Entry>>()
  /**
   * CI 2026-10-22: what stops a client still opening when it is closed. A server that does not
   * answer held the app's close for its whole cap, and an edit of its connection until the server
   * selection gave up.
   */
  private readonly opening = new WeakMap<Promise<Entry>, AbortController>()
  /** Operations still running on a connection: its client is not closed for being idle meanwhile. */
  private readonly holds = new Map<string, number>()
  /** W7, W8: how a connection's clients are keyed, read once from its settings (until invalidated). */
  private readonly scopes = new Map<string, Scope>()
  /** Refusals kept by client key (see REFUSAL_KEPT_MS). */
  private readonly refusals = new Map<string, { error: ConnectionError; at: number }>()
  private readonly idleMs: number
  private readonly testTimeoutMs: number
  private readonly maxConcurrentTests: number
  private activeTests = 0
  /** After closeAll nothing may open a client again (a late poll or job during shutdown). */
  private closed = false
  /** Second review of the open's stop (minor 4): connection tests under way stop when the app closes. */
  private readonly stopping = new AbortController()

  constructor(private readonly deps: ManagerDeps) {
    this.idleMs = deps.idleMs ?? 10 * 60_000
    this.testTimeoutMs = deps.testTimeoutMs ?? 6_000
    this.maxConcurrentTests = deps.maxConcurrentTests ?? 8
  }

  private policy(): ConnectionPolicy {
    return this.deps.policy?.() ?? CLOSED_POLICY
  }

  private scopeOf(id: string): Scope {
    const known = this.scopes.get(id)
    if (known) return known
    const record = this.deps.load(id)
    if (!record) throw new ConnectionError('config', 'Connection not found')
    const { auth, encryption } = record.settings
    const oidc = auth.mechanism === 'MONGODB-OIDC' && !auth.oidc?.environment
    const scope = { oidc, perPerson: oidc && this.policy().teamMode, encrypted: encryption?.enabled === true }
    this.scopes.set(id, scope)
    return scope
  }

  /** The key of a client: whose sign-in, and whether it decrypts (only where it makes a difference). */
  private keyFor(id: string, scope: Scope, as: ClientAs): string {
    let key = id
    if (scope.perPerson) {
      // Abuse case: work with no person behind it would borrow someone's sign-in.
      if (!as.user) throw new ConnectionError('oidc', OIDC_PER_PERSON)
      key += `${SEP}u:${as.user}`
    }
    if (scope.encrypted && as.decrypt) key += `${SEP}decrypt`
    return key
  }

  getClient(id: string, as: ClientAs = {}): Promise<MongoClient> {
    if (this.closed) return Promise.reject(new ConnectionError('closed', SHUTTING_DOWN))
    let key: string
    let scope: Scope
    try {
      scope = this.scopeOf(id)
      key = this.keyFor(id, scope, as)
    } catch (e) {
      return Promise.reject(e)
    }
    let pending = this.entries.get(key)
    const refusalKey = refusalKeyOf(key)
    const kept = pending ? undefined : this.refusals.get(refusalKey)
    if (kept) {
      if (monotonic() - kept.at < REFUSAL_KEPT_MS)
        return Promise.reject(
          new ConnectionError(kept.error.kind, kept.error.message, kept.error.fingerprint, true),
        )
      this.refusals.delete(refusalKey)
    }
    if (!pending) {
      const stop = new AbortController()
      const current = this.open(id, scope, as, stop.signal)
      pending = current
      this.entries.set(key, current)
      this.opening.set(current, stop)
      current.then(
        (entry) => {
          this.opening.delete(current)
          // A dropped SSH session makes the cached client useless: evict it so the next call reconnects.
          entry.tunnel?.onClose(() => {
            if (this.entries.get(key) === current) void this.close(key)
          })
        },
        (e: unknown) => {
          this.opening.delete(current)
          if (this.entries.get(key) !== current) return
          this.entries.delete(key)
          const failure = classifyError(e)
          if (isRefusal(failure)) this.refusals.set(refusalKey, { error: failure, at: monotonic() })
        },
      )
    }
    return pending.then((entry) => {
      this.arm(key, entry)
      return entry.client
    })
  }

  /**
   * Keeps a connection's client open while an operation runs (a request, an index build that
   * takes an hour): the idle timer only starts once the last hold is released. Returns the release,
   * which counts once however often it is called.
   */
  hold(id: string): () => void {
    this.holds.set(id, (this.holds.get(id) ?? 0) + 1)
    void this.entries.get(id)?.then(
      (entry) => entry.timer && clearTimeout(entry.timer),
      () => undefined,
    )
    let released = false
    return () => {
      if (released) return
      released = true
      const left = (this.holds.get(id) ?? 1) - 1
      if (left > 0) {
        this.holds.set(id, left)
        return
      }
      this.holds.delete(id)
      for (const key of this.keysOf(id))
        void this.entries.get(key)?.then(
          (entry) => this.arm(key, entry),
          () => undefined,
        )
    }
  }

  /** The keys of a connection's clients (every person, decrypting or not). */
  private keysOf(id: string): string[] {
    return [...this.entries.keys()].filter((key) => connectionOf(key) === id)
  }

  /** Clients currently open or opening (for /metrics). */
  openCount(): number {
    return this.entries.size
  }

  /**
   * W7: whether a connection signs each person in (a per-person OIDC connection in team mode), so
   * work with no person behind it has no client of it. Read without dialling; false when unknown.
   */
  perPerson(id: string): boolean {
    try {
      return this.scopeOf(id).perPerson
    } catch {
      return false
    }
  }

  /** Its connection's settings changed: how it signs in is read afresh (seventh review, nit). */
  rescope(id: string): void {
    this.scopes.delete(id)
  }

  /** W3.4: a client is open (or opening) for this connection; asking opens nothing. */
  isOpen(id: string): boolean {
    return this.keysOf(id).length > 0
  }

  /** W3.4: the server's version read when its client opened; null when none is open. */
  async version(id: string): Promise<string | null> {
    for (const key of this.keysOf(id)) {
      const entry = await this.entries.get(key)?.catch(() => undefined)
      if (entry) return entry.version
    }
    return null
  }

  private async close(key: string, why = CHANGED_WHILE_OPENING): Promise<void> {
    const pending = this.entries.get(key)
    if (!pending) return
    this.entries.delete(key)
    // Still opening: it stops, and is left at once wherever it was (an open one has nothing to stop).
    this.opening.get(pending)?.abort(new ConnectionError('closed', why))
    const entry = await pending.catch(() => undefined)
    if (entry) await closeEntry(entry)
  }

  /**
   * A connection's kept refusals are forgotten: it was edited, or a test of it passed (its sign-in
   * works again). With a person, theirs and the connection's own only (fifth review, M3).
   */
  forgetRefusal(id: string, user?: string): void {
    for (const key of [...this.refusals.keys()]) {
      if (connectionOf(key) !== id) continue
      const person = personOfKey(key)
      if (user === undefined || person === null || person === user) this.refusals.delete(key)
    }
  }

  /**
   * Fifth review (I1): a refusal met elsewhere (the shell's own sign-in, through its proxy) is kept
   * for the connection as its clients' would be.
   */
  noteRefusal(id: string, error: ConnectionError, user?: string): void {
    // Review of A5 (I2): a person's own sign-in refused is theirs, never everyone's.
    let perPerson = false
    try {
      perPerson = user !== undefined && this.scopeOf(id).perPerson
    } catch {
      // A connection gone meanwhile: kept by its id, forgotten with it.
    }
    this.refusals.set(perPerson ? `${id}${SEP}u:${user}` : id, { error, at: monotonic() })
  }

  /**
   * Review of A5: whether a client of a connection is open now — opened, not opening (unlike isOpen),
   * and a person's own where each signs in with theirs: what the app knows, never a dial.
   */
  openNow(id: string, user: string): boolean {
    for (const [key, entry] of this.entries) {
      if (connectionOf(key) !== id || this.opening.has(entry)) continue
      const person = personOfKey(key)
      if (person === null || person === user) return true
    }
    return false
  }

  /** The refusal kept for a connection (and a person), if any (fifth review, M1: its test). */
  refusalOf(id: string, user?: string): ConnectionError | null {
    for (const key of user ? [`${id}${SEP}u:${user}`, id] : [id]) {
      const kept = this.refusals.get(key)
      if (kept && monotonic() - kept.at < REFUSAL_KEPT_MS) return kept.error
    }
    return null
  }

  /** Closes every client of a connection (its settings changed, or it is gone). */
  async invalidate(id: string): Promise<void> {
    this.scopes.delete(id)
    this.forgetRefusal(id)
    await Promise.all(this.keysOf(id).map((key) => this.close(key)))
  }

  /**
   * W7: one person's clients of a connection, after their sign-in changed (signed in again, signed
   * out, revoked): the driver keeps the tokens it was given, so the client goes with them.
   */
  async invalidateUser(id: string, user: string): Promise<void> {
    const scope = this.scopes.get(id)
    // Local mode's one person: an OIDC connection's clients are theirs; nothing else is touched.
    const theirs = (key: string): boolean => {
      if (connectionOf(key) !== id) return false
      const person = personOfKey(key)
      return person !== null ? person === user : scope?.oidc === true && !scope.perPerson
    }
    const keys = this.keysOf(id).filter(theirs)
    // Signed in again: their refusal is not theirs any more (kept by the same keys).
    for (const key of [...this.refusals.keys()]) if (theirs(key)) this.refusals.delete(key)
    await Promise.all(keys.map((key) => this.close(key)))
  }

  /** Closes every client; waits at most timeoutMs for connections that are still opening (spec §4.4 drain). */
  async closeAll(timeoutMs = 10_000): Promise<void> {
    this.closed = true
    this.stopping.abort(new ConnectionError('closed', SHUTTING_DOWN))
    const all = Promise.all([...this.entries.keys()].map((key) => this.close(key, SHUTTING_DOWN)))
    let timer: NodeJS.Timeout | undefined
    const cap = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
      timer.unref()
    })
    await Promise.race([all, cap])
    clearTimeout(timer)
  }

  async test(settings: ConnectionSettings, as: TestAs = {}): Promise<TestResult> {
    // Review of the open's stop (minor 10): nothing is dialled once the app closes.
    if (this.closed) return { ok: false, error: { kind: 'closed', message: SHUTTING_DOWN } }
    if (this.activeTests >= this.maxConcurrentTests) {
      return {
        ok: false,
        error: { kind: 'busy', message: 'Too many connection tests are running; try again in a moment' },
      }
    }
    this.activeTests++
    let entry: Entry | undefined
    let timedOut = false
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<TestResult>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true
        resolve({
          ok: false,
          error: { kind: 'timeout', message: 'The server did not answer before the test timeout' },
        })
      }, this.testTimeoutMs)
    })
    const run = (async (): Promise<TestResult> => {
      const started = performance.now()
      try {
        entry = await this.connect(
          settings,
          {
            serverSelectionTimeoutMS: Math.min(
              settings.serverSelectionTimeoutMS ?? PHASE_TIMEOUT_MS,
              PHASE_TIMEOUT_MS,
            ),
            connectTimeoutMS: Math.min(settings.connectTimeoutMS ?? PHASE_TIMEOUT_MS, PHASE_TIMEOUT_MS),
            timeoutMS: PHASE_TIMEOUT_MS,
          },
          undefined,
          { readyTimeoutMs: PHASE_TIMEOUT_MS },
          await this.hooksFor(null, settings, { oidcCallback: as.oidcCallback, decrypt: true }),
          this.stopping.signal,
        )
        if (timedOut) return { ok: false, error: { kind: 'timeout', message: 'timed out' } }
        const admin = entry.client.db('admin')
        await unlessStopped(admin.command({ ping: 1 }), this.stopping.signal)
        const latencyMs = Math.round(performance.now() - started)
        const hello = await unlessStopped(admin.command({ hello: 1 }), this.stopping.signal)
        return {
          ok: true,
          latencyMs,
          serverVersion: entry.version,
          topology: topologyOf(hello),
          ...(typeof hello.setName === 'string' ? { setName: hello.setName } : {}),
          ...(entry.tunnel ? { sshFingerprint: entry.tunnel.fingerprint } : {}),
        }
      } catch (e) {
        const err = classifyError(e)
        return {
          ok: false,
          error: {
            kind: err.kind,
            message: err.message,
            ...(err.fingerprint ? { sshFingerprint: err.fingerprint } : {}),
          },
        }
      }
    })()
    try {
      return await Promise.race([run, deadline])
    } finally {
      clearTimeout(timer)
      this.activeTests--
      // Whatever finished (or is still pending), the resources must be released.
      void run.finally(() => {
        if (entry) void closeEntry(entry)
      })
      if (entry) await closeEntry(entry)
    }
  }

  private arm(key: string, entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = undefined
    if (this.holds.has(connectionOf(key))) return
    entry.timer = setTimeout(() => void this.close(key), this.idleMs)
    entry.timer.unref()
  }

  /**
   * W7, W8: the OIDC callback and automatic encryption of one client. Checked against the policy
   * first, so a refused connection builds neither (nor loads the encryption library).
   */
  private async hooksFor(
    connectionId: string | null,
    settings: ConnectionSettings,
    want: { oidcCallback?: OIDCCallbackFunction | undefined; decrypt: boolean },
  ): Promise<SignInHooks> {
    const problem = connectionProblem(settings, this.policy())
    if (problem) throw new ConnectionError('config', problem.message)
    const hooks: SignInHooks = {}
    if (want.oidcCallback) hooks.oidcCallback = want.oidcCallback
    if (want.decrypt && settings.encryption?.enabled) {
      if (!this.deps.autoEncryption)
        throw new ConnectionError('encryption', 'Client-side encryption is not available on this server')
      hooks.autoEncryption = await this.deps.autoEncryption(connectionId, settings)
    }
    return hooks
  }

  private async open(id: string, scope: Scope, as: ClientAs, signal: AbortSignal): Promise<Entry> {
    const record = this.deps.load(id)
    if (!record) throw new ConnectionError('config', 'Connection not found')
    // Local mode has one person; in team mode the caller named them (keyFor refused otherwise).
    const person = scope.perPerson ? as.user! : 'local'
    const hooks = await this.hooksFor(id, record.settings, {
      oidcCallback: scope.oidc ? this.deps.oidcCallback?.(id, person) : undefined,
      decrypt: as.decrypt === true,
    })
    const entry = await this.connect(
      record.settings,
      {},
      (fingerprint, dialled) => this.deps.pinFingerprint?.(id, fingerprint, dialled),
      undefined,
      hooks,
      signal,
    )
    // What runs once it opened has no deadline of its own: a stop leaves it, closing the client.
    try {
      signal.throwIfAborted()
      await unlessStopped(
        this.deps.onOpen?.(id, entry.client, signal).catch(() => undefined) ?? Promise.resolve(),
        signal,
      )
    } catch (e) {
      await closeEntry(entry)
      throw e
    }
    return entry
  }

  private async connect(
    settings: ConnectionSettings,
    overrides: Partial<MongoClientOptions>,
    onNewFingerprint?: (fingerprint: string, dialled: SshSettings) => void,
    tunnelOpts?: { readyTimeoutMs?: number },
    hooks: SignInHooks = {},
    signal?: AbortSignal,
  ): Promise<Entry> {
    signal?.throwIfAborted()
    // Review minor 5: a refused sign-in method dials no tunnel and pins no host key (W7, W8: the
    // server's policy, checked again here for a caller that built no hooks).
    const problem = connectionProblem(settings, this.policy())
    if (problem) throw new ConnectionError('config', problem.message)
    let tunnel: Tunnel | undefined
    if (settings.ssh?.enabled) {
      if (!this.deps.openTunnel) throw new ConnectionError('config', 'SSH tunnels are not available')
      const target = settings.hosts[0]!
      try {
        tunnel = await this.deps.openTunnel(
          settings.ssh,
          { host: target.host, port: target.port ?? 27017 },
          { ...tunnelOpts, ...(signal ? { signal } : {}) },
        )
      } catch (e) {
        // Stopped: why it was, not how the handshake ended.
        throw signal?.aborted ? signal.reason : e
      }
      if (signal?.aborted) {
        await tunnel.close().catch(() => undefined)
        throw signal.reason
      }
      if (!settings.ssh.hostFingerprint) onNewFingerprint?.(tunnel.fingerprint, settings.ssh)
    }
    let client: MongoClient | undefined
    let connecting: Promise<unknown> | undefined
    // Closing a client ends its connect (and buildInfo) at once, with "Topology is closed"; but the
    // driver does some work before it makes what a close ends (a mongodb+srv host's lookup, the
    // encryption's start, TLS files read), so the open is left at once (unlessStopped below), and
    // a client made after this close is closed once made.
    const stop = () => {
      void client?.close().catch(() => undefined)
      void connecting?.then(
        () => client?.close().catch(() => undefined),
        () => undefined,
      )
    }
    signal?.addEventListener('abort', stop, { once: true })
    try {
      const spec = clientSpec(
        settings,
        tunnel ? { host: '127.0.0.1', port: tunnel.localPort, credentials: tunnel.credentials } : undefined,
        overrides,
        hooks,
      )
      client = this.deps.createClient
        ? this.deps.createClient(spec.uri, spec.options)
        : new MongoClient(spec.uri, spec.options)
      connecting = client.connect()
      await unlessStopped(connecting, signal)
      signal?.throwIfAborted()
      // Phase 1h spec §10: older servers are refused before anything else runs against them.
      const version = String(
        (await unlessStopped(client.db('admin').command({ buildInfo: 1 }), signal)).version,
      )
      if (!isSupportedMongoVersion(version)) {
        throw new ConnectionError(
          'unsupported',
          `MongoDB ${version} is not supported. mongo-manager supports MongoDB ${MIN_MONGODB_VERSION} and later.`,
        )
      }
      signal?.throwIfAborted()
      return tunnel ? { client, tunnel, version } : { client, version }
    } catch (e) {
      await client?.close().catch(() => undefined)
      await tunnel?.close().catch(() => undefined)
      // Stopped: why it was, not the driver's "Topology is closed".
      throw signal?.aborted ? signal.reason : e
    } finally {
      signal?.removeEventListener('abort', stop)
    }
  }
}
