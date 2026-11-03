import { randomBytes, randomUUID } from 'node:crypto'
import { Scheduler } from '../backup/schedules/scheduler'
import { RunRepo, ScheduleRepo } from '../backup/schedules/repo'
import { RefusalAudit } from '../masking/audit'
import { WatchManager, type WatchDeps } from '../changestreams/manager'
import { LiveSyncRepo } from '../livesync/repo'
import { LiveSyncRunner, type RunnerDeps } from '../livesync/runner'
import { maskingGate, type MaskingMode } from '../masking/modes'

/** Routes of one connection: each declares how it treats personal data (phase 3c §6). */
const CONNECTION_ROUTE = /\/api\/connections\/:id(\/|$)/
import { forRestricted, restrictedRequest } from '../masking/errors'
import { PreviewCache } from '../aggregation/cache'
import { MAX_RUN_BYTES, RunSlots } from '../aggregation/run'
import { MAX_PAGE_BYTES } from '../data/page'
import { SavedPipelineRepo } from '../aggregation/saved'
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import { openLogFile } from './log-file'
import { BODY_LIMITS, guardBodies, type BodyLimits } from './body-guard'
import { trackHandlers, whenHandlerSettled } from './lifecycle'
import rateLimit from '@fastify/rate-limit'
import { DEFAULT_API_RATE_LIMIT, type Config } from '../config'
import type { Store } from '../store/db'
import type { SecretBox } from '../crypto/secret-box'
import { AppError, Errors } from '../errors'
import { UserRepo } from '../auth/users'
import { SessionRepo } from '../auth/sessions'
import { sessionIdleMs } from '../auth/sessionPolicy'
import { AuditRepo } from '../audit/audit'
import { healthRoutes } from '../routes/health'
import { KnownSignIns, LoginThrottle } from '../auth/throttle'
import { SignInBans, SignInBudget } from '../auth/bans'
import { AccessList } from '../auth/accessList'
import { PasswordWork } from '../auth/passwordWork'
import { dummyHash } from '../auth/passwords'
import { SetupState } from '../auth/setup'
import { ChallengeStore, MfaTickets, RecoveryCodeRepo } from '../auth/mfa'
import { PasskeyRepo } from '../auth/passkeys'
import { ConnectionRepo } from '../connections/repo'
import { registerKeyVaults } from '../connections/access'
import { GrantRepo } from '../connections/grants'
import { ConnectionManager } from '../connections/manager'
import { openSshTunnel } from '../connections/ssh'
import { killByComment } from '../data/operations'
import { SIGN_IN_RATE_LIMIT, authRoutes, signInBudget } from '../routes/auth'
import { passkeyRoutes } from '../routes/passkeys'
import { userRoutes } from '../routes/users'
import { auditRoutes } from '../routes/audit'
import { jobRoutes } from '../routes/jobs'
import { wsRoutes } from '../routes/ws'
import websocket from '@fastify/websocket'
import { RealtimeHub, type HubOptions } from '../realtime/hub'
import { connectionRoutes } from '../routes/connections'
import { dataRoutes } from '../routes/data'
import { backupRoutes } from '../routes/backup'
import { destinationRoutes } from '../routes/destinations'
import { BackupKeyRepo } from '../backup/keys/repo'
import { backupKeyRoutes } from '../routes/backup-keys'
import { scheduleRoutes } from '../routes/backup-schedules'
import { liveSyncRoutes } from '../routes/live-sync'
import { watchRoutes } from '../routes/watch'
import { dumpKind } from '../backup/dump-job'
import { restoreKind } from '../backup/restore-job'
import { sendKind, settleInterruptedCopies, sweepStaleCopies } from '../backup/send-job'
import { fetchKind } from '../backup/fetch-job'
import { drillKind } from '../backup/drill-job'
import { csrfGuard, hostAllowlist, isHealthPath } from './security'
import { readSessionId, resolvePrincipal } from './principal'
import { AccessSignal, twoFactorPending } from '../auth/policy'
import type { ServerContext } from './context'
import { QueryHistoryRepo } from '../queries/history'
import { FavouriteRepo } from '../queries/favourites'
import { SnippetRepo } from '../queries/snippets'
import { PersonalFieldsRepo } from '../masking/repo'
import { ProfilerReverter, ProfilerReverts } from '../monitor/profiler'
import { HistoryRecorder, HistoryRepo } from '../monitor/history'
import { LIBRARY_LIMITS, type LibraryLimits } from '../routes/data/library'
import { ShellManager } from '../shell/manager'
import { buildUpstreamPlan } from '../shell/plan'
import { keepingRefusal, shellClient } from '../shell/plan-client'
import { workerBundlePath } from '../shell/spawn'
import { ShellHistoryRepo } from '../shell/history'
import { maskCode } from '../shell/mask'
import { countRequests, metricsRoutes } from '../routes/metrics'
import { JobRepo } from '../jobs/repo'
import { JobRunner } from '../jobs/runner'
import { MonitorHub } from '../monitor/hub'
import { indexCreateKind } from '../jobs/index-create'
import { dropLeftoverStaging, duplicateKind } from '../jobs/duplicate'
import { toAppError } from '../data/mongo-errors'
import { registerWebApp, type WebAssets } from './web'
import { join } from 'node:path'
import { TransferFiles } from '../transfer/files'
import { BackupStore } from '../backup/store'
import { MAX_TOOL_PROCESSES, backupLimits } from '../backup/limits'
import { ToolSlots, sweepToolDirs } from '../backup/tools'
import { CopyRepo, DestinationRepo } from '../backup/destinations/repo'
import { DestinationSlots } from '../backup/destinations/slots'
import { BackupReadGate } from '../backup/read-gate'
import { DeviceFlows } from '../backup/destinations/device-flows'
import { GOOGLE_HOSTS } from '../backup/destinations/google-auth'
import { createEgress } from '../net/egress'
import { AiProviderRepo } from '../ai/providers'
import { createAiEgress } from '../ai/egress'
import { AiLimits } from '../ai/limits'
import { createChatStore } from '../ai/chats'
import { createAgentServices } from '../ai/agent/services'
import { aiRoutes } from '../routes/ai'
import { aiChatRoutes } from '../routes/ai-chat'
import { aiAgentRoutes } from '../routes/ai-agent'
import { aiHistoryRoutes } from '../routes/ai-history'
import { AiHistoryRepo, AiPriceRepo } from '../ai/requests'
import { SettingsRepo } from '../store/settings'
import { PreferencesRepo } from '../store/preferences'
import { PluginRepo } from '../plugins/repo'
import { PluginService } from '../plugins/service'
import { pluginRoutes } from '../routes/plugins'
import { updateRoutes } from '../routes/updates'
import { pluginFrameRoutes } from '../routes/plugin-frame'
import { meRoutes } from '../routes/me'
import { TransferReports } from '../transfer/reports'
import { transferLimits } from '../transfer/limits'
import { PreviewGate, UploadGate } from '../transfer/upload-gate'
import { TransferPresets } from '../transfer/presets'
import { importKind } from '../transfer/import-job'
import { importSqlKind } from '../transfer/import-sql-job'
import { exportKind } from '../transfer/export-job'
import { copyKind } from '../transfer/copy-job'
import { compareKind } from '../transfer/compare-job'
import { syncKind } from '../transfer/sync-job'
import { transferApiRoutes } from '../routes/transfer'
import './context'
import { StepUps } from '../auth/stepup'
import { appKey, auditChainKey } from '../crypto/app-keys'
import { LOCAL_KEY_HEADER, LaunchGate, linkRefusedPage } from '../auth/launch'
import { launchRoutes } from '../routes/launch'
import { AlertService } from '../alerts/service'
import { ReportRunner } from '../alerts/reports'
import { AppEvents } from '../events/app-events'
import { assertNotDrillScratch, namesDrillScratch } from '../connections/access'
import { alertRoutes } from '../routes/alerts'
import { HealthCache } from '../connections/health'
import { connectionHealthRoutes } from '../routes/connection-health'
import sea from 'node:sea'
import type { IdPInfo } from 'mongodb'
import {
  createOptionalRuntime,
  detectDistribution,
  detectOptionalModules,
  installOptionalHook,
  sourceLoader,
  verifiedHome,
  verifiedLoader,
  type OptionalModules,
} from '../optional/modules'
import { policyOf } from '../connections/policy'
import { OidcBroker, OidcFlowError } from '../oidc/broker'
import { OidcTokenRepo } from '../oidc/tokens'
import { ConnectionError, OIDC_SIGN_IN_NEEDED, SIGN_IN_REFUSED } from '../connections/errors'
import { autoEncryptionFor } from '../encryption/options'
import { oidcRoutes, oidcCallbackRoutes } from '../routes/oidc'
import { jobOwner } from '../jobs/identity'
import { encryptionToolsFactory, type EncryptionToolsFactory } from '../encryption/tools'
import { RUNNING_STATES, readOrigin } from '@mongo-manager/shared'
import { UpdateService } from '../updates/service'
import { VERSION } from '../version'

export interface AppDeps {
  /** Phase 3d-3c: tests drive the scheduler's ticks themselves (autoStart false). */
  scheduler?: { autoStart?: boolean }
  /** Design 2026-10-25 (C7): tests drive the reports' ticks themselves (autoStart false). */
  reports?: { autoStart?: boolean }
  config: Config
  store: Store
  secretBox: SecretBox
  logger?: boolean
  now?: () => number
  /** Directory holding the built web app (index.html + assets); omitted = API only. */
  webRoot?: string
  /** The built web app in memory (a standalone binary); wins over webRoot. */
  webAssets?: WebAssets
  /** Tests shorten the real-time channel's timers. */
  realtime?: Partial<HubOptions>
  /** The updater: asks the launcher to start the app again (startServer gives it). */
  requestRestart?: () => void
  /** Tests shorten how long a cancel waits for its job to end. */
  jobs?: { cancelGraceMs?: number }
  /** Tests shorten the metrics sampling interval. */
  monitor?: { intervalMs?: number }
  /** Tests lower the streamed run's output cap (64 MiB). */
  aggregation?: { maxRunBytes?: number }
  documents?: { maxPageBytes?: number }
  /** Tests lower the library search's bounds. */
  library?: Partial<LibraryLimits>
  /** Tests drive the Watch feed with fake streams and shorter timings. */
  watch?: Partial<Omit<WatchDeps, 'ctx'>>
  /** Phase 3e-2: worker timings and the push rate (tests). */
  liveSync?: Partial<Pick<RunnerDeps, 'timing' | 'pushMs'>>
  /**
   * Security audit 2026-10-16: local mode's per-install secret (auth/launch, kept in the data
   * directory by startServer). Omitted: one of this process alone — only its own links open it.
   */
  launchSecret?: Buffer
  /** Tests shorten the connection's and the body's timeouts. */
  http?: Partial<BodyLimits> & { connectionTimeoutMs?: number }
  /** W3.3: tests shorten the webhooks' waits between tries. */
  alerts?: { retryDelaysMs?: number[] }
  /** W8: tests say which optional packages are there (detected from the CLI's location otherwise). */
  optionalModules?: OptionalModules
  /** W8: tests give a fake ClientEncryption (the native package is never built here). */
  encryptionTools?: EncryptionToolsFactory
}

/**
 * Security audit 2026-10-16 (Important 1): a socket with no traffic either way for 10 minutes is
 * closed — while it waits for a request or its answer is read, never while a handler works (a $out
 * may run for 24 hours: lifecycle.ts switches the timeout off meanwhile, independent review I1).
 * Real-time sockets clear it once upgraded (ws). Headers must arrive within 30 s; bodies are bounded
 * in body-guard.ts.
 */
export const CONNECTION_IDLE_MS = 10 * 60_000
export const HEADERS_TIMEOUT_MS = 30_000

/**
 * Independent review of the security pass (minor): no one address holds every socket (slow
 * clients, held-open connections). Node refuses past maxConnections in all; past
 * maxConnectionsPerIp from one address a new socket is closed at once. Behind trusted proxies every
 * connection comes from them, so only the total applies there (the proxy limits its clients).
 */
function capConnections(
  server: import('node:http').Server,
  config: Config,
  warn: (fields: Record<string, unknown>, message: string) => void,
): void {
  server.maxConnections = config.maxConnections
  if (config.trustedProxies.length > 0) return
  const open = new Map<string, number>()
  // Second review (minor): a refusal is said — once a minute per address, so a flood writes one line.
  const said = new Map<string, number>()
  server.on('connection', (socket) => {
    const ip = socket.remoteAddress ?? ''
    const n = (open.get(ip) ?? 0) + 1
    if (n > config.maxConnectionsPerIp) {
      socket.destroy()
      const now = Date.now()
      if (now - (said.get(ip) ?? 0) >= 60_000) {
        said.set(ip, now)
        if (said.size > 10_000) said.clear()
        warn(
          { ip, open: n - 1, limit: config.maxConnectionsPerIp },
          'too many connections from one address: refused (raise MM_MAX_CONNECTIONS_PER_IP when many people share an address)',
        )
      }
      return
    }
    open.set(ip, n)
    socket.once('close', () => {
      const left = (open.get(ip) ?? 1) - 1
      if (left > 0) open.set(ip, left)
      else open.delete(ip)
    })
  })
}

const REDACT = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  // Second review (minor 5): local mode's page key (the request serializer leaves headers out anyway).
  'req.headers["x-mm-local"]',
  'res.headers["set-cookie"]',
  // Phase 3d-3b (plan ruling 5): outbound requests are never logged; this one is here for symmetry.
  'req.headers["x-amz-security-token"]',
]

/**
 * An address as the log shows it: a plugin frame's ticket — good for hours — left out (security
 * review 2026-10-13, ops), and the query's values too (security audit 2026-10-16, minor): searches
 * of the AI history, the library or GridFS, file names. The names stay, for whoever reads the log.
 */
/**
 * Path parameters that name a user's data (a GridFS file's _id — an email, a file name — or a
 * document's, a launch link's token): written as *** too (independent review of the security pass,
 * minor).
 */
const IDENTIFYING_PARAMS = ['fileId', 'docId', 'documentId', 'token']

function urlForLog(url: string, params?: unknown): string {
  const at = url.indexOf('?')
  let path = (at < 0 ? url : url.slice(0, at))
    .replace(/\/plugin-frame\/[^/?#]+/, '/plugin-frame/***')
    // Security audit 2026-10-16: nor a local launch link's token (the query's values, an mm_link
    // download ticket among them, are all *** below).
    .replace(/\/launch\/.*/, '/launch/***')
  const values = IDENTIFYING_PARAMS.map((k) => (params as Record<string, unknown> | undefined)?.[k]).filter(
    (v): v is string => typeof v === 'string' && v !== '',
  )
  if (values.length)
    path = path
      .split('/')
      .map((part) => {
        let decoded = part
        try {
          decoded = decodeURIComponent(part)
        } catch {
          // Malformed escapes: compared as written.
        }
        return values.includes(decoded) ? '***' : part
      })
      .join('/')
  if (at < 0) return path
  const names = url
    .slice(at + 1)
    .split('&')
    .filter(Boolean)
    .map((pair) => (pair.includes('=') ? `${pair.slice(0, pair.indexOf('=')).slice(0, 64)}=***` : '***'))
  return `${path}?${names.join('&')}`
}

/** A request as the log shows it (Fastify's own fields). */
export function requestForLog(req: FastifyRequest): Record<string, unknown> {
  return {
    method: req.method,
    url: urlForLog(req.url, req.params),
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  }
}

/** Per IP per minute. The SPA and its assets have their own, larger bucket (a page load is many files). */
/** The default API budget per client address and minute (config apiRateLimit, MM_API_RATE_LIMIT). */
export const RATE_LIMIT_API = DEFAULT_API_RATE_LIMIT
export const RATE_LIMIT_WEB = 3000
/**
 * CI 2026-11-01: the build's content-hashed files (a page load is hundreds; browsers keep them a
 * year), in a bucket of their own: a team behind one address no longer half loads the app.
 */
export const RATE_LIMIT_ASSETS = 20_000

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps
  const now = deps.now ?? Date.now
  const app = Fastify({
    logger: deps.logger
      ? {
          level: config.logLevel,
          redact: REDACT,
          serializers: { req: requestForLog },
          ...(config.logFile ? { stream: openLogFile(config.logFile) } : {}),
        }
      : false,
    trustProxy: config.trustedProxies.length > 0 ? config.trustedProxies : false,
    bodyLimit: 1024 * 1024,
    connectionTimeout: deps.http?.connectionTimeoutMs ?? CONNECTION_IDLE_MS,
    // Kept off on purpose: one deadline for a whole request would cut a long upload; body-guard.ts
    // bounds bodies per request instead (security audit 2026-10-16).
    requestTimeout: 0,
    // A GridFS file id (up to 512 characters) and a plugin frame ticket are one path part each;
    // Fastify's default (100) answered them with 414. Params are matched plainly, never by pattern.
    routerOptions: { maxParamLength: 1100 },
    genReqId: () => randomUUID(),
    requestIdHeader: false,
  })
  app.server.headersTimeout = HEADERS_TIMEOUT_MS
  capConnections(app.server, config, (fields, message) => app.log.warn(fields, message))
  // First of all hooks: a body's clock starts with its head, whatever refuses the request later.
  guardBodies(app, { ...BODY_LIMITS, ...deps.http })
  // Independent review (I1): no idle timeout while a handler works; whenHandlerSettled for I2.
  trackHandlers(app, deps.http?.connectionTimeoutMs ?? CONNECTION_IDLE_MS)

  // Every route this server answers (method and URL, without HEAD/OPTIONS): the S12 permission
  // matrix is checked against it, so a route cannot be added without deciding who may call it.
  const routeInventory = new Set<string>()
  app.decorate('routeInventory', routeInventory)
  const routeMasking = new Map<string, MaskingMode | undefined>()
  app.decorate('routeMasking', routeMasking)
  app.addHook('onRoute', (route) => {
    const methods = (Array.isArray(route.method) ? route.method : [route.method]).filter(
      (m) => m !== 'HEAD' && m !== 'OPTIONS',
    )
    for (const method of methods) routeInventory.add(`${method} ${route.url}`)
    // Phase 3c §6: every connection route declares its masking; denials run after its own guards.
    if (!CONNECTION_ROUTE.test(route.url)) return
    const mode = (route.config as { masking?: MaskingMode } | undefined)?.masking
    for (const method of methods) routeMasking.set(`${method} ${route.url}`, mode)
    if (mode === 'denied' || mode === 'denied-when-ruled') {
      const before = route.preHandler
        ? Array.isArray(route.preHandler)
          ? route.preHandler
          : [route.preHandler]
        : []
      route.preHandler = [...before, maskingGate(mode)]
    }
  })

  const connections = new ConnectionRepo(deps.store.db, deps.secretBox, now)
  // Security review C1: the key vaults its connections name are admin-only namespaces.
  const forgetKeyVaults = registerKeyVaults(connections)
  app.addHook('onClose', async () => {
    forgetKeyVaults()
  })
  // W8: the optional native packages, found once where the CLI is installed (never in the
  // standalone binary, the Docker image or the service's copy). Security review C2: from the one
  // verified directory only, and loaded when a connection first needs one (installOptionalHook).
  // Updater (2026-11-03): a version the launcher runs from the data directory finds them where the
  // install itself is (the launcher names it), never beside the downloaded copy.
  const origin = readOrigin(process.env)
  const bundled = /[\\/]dist$/.test(import.meta.dirname)
  const home = bundled
    ? verifiedHome(origin?.distribution === 'bundle' ? origin.installDir : import.meta.dirname)
    : null
  const distribution = detectDistribution({
    env: process.env,
    isSea: sea.isSea(),
    bundled,
    verified: home !== null,
  })
  const optionalLoader = home ? verifiedLoader(home) : distribution === 'source' ? sourceLoader() : null
  const optionalModules =
    deps.optionalModules ?? detectOptionalModules({ distribution, loader: optionalLoader })
  if (!deps.optionalModules && bundled)
    installOptionalHook(createOptionalRuntime(optionalModules, optionalLoader))
  const policy = () => policyOf(config, optionalModules)
  // W8: key management services are reached through the egress guard only.
  const kmsEgress = createEgress({
    networks: config.encryption.privateNetworks,
    networksSetting: 'MM_KMS_PRIVATE_NETWORKS',
  })
  const manager = new ConnectionManager({
    load: (id) => {
      const record = connections.get(id)
      if (record) connections.touch(id)
      return record
    },
    pinFingerprint: (id, fingerprint, dialled) => connections.setSshFingerprint(id, fingerprint, dialled),
    openTunnel: openSshTunnel,
    // Phase 1h: copies a previous process left interrupted leave a staging collection behind.
    onOpen: (id, client, signal) =>
      dropLeftoverStaging(ctx.jobs, id, client, {
        warn: (fields, message) => app.log.warn(fields, message),
        signal,
      }),
    policy,
    oidcCallback: (id, user) => ctx.oidc.callback(id, user),
    autoEncryption: (_id, settings) => autoEncryptionFor(settings, policy(), kmsEgress),
  })
  // Security audit 2026-10-16 (minor): one connection test at a time per user. Security review
  // Minor 7: a sign-in's probe is such a test, and takes the same slot.
  const connectionTests = new RunSlots(1)
  // W7: people's OIDC sign-ins; the identity provider the server names is found by a connection
  // attempt that stops at it.
  const oidc = new OidcBroker({
    egress: createEgress({
      networks: config.oidc.privateNetworks,
      networksSetting: 'MM_OIDC_PRIVATE_NETWORKS',
    }),
    tokens: new OidcTokenRepo(deps.store.db, deps.secretBox, now),
    now,
    invalidate: (id, user) => manager.invalidateUser(id, user),
    probe: async (connectionId, user) => {
      const record = connections.get(connectionId)
      if (!record) throw Errors.notFound('Connection not found')
      const release = connectionTests.acquire(user)
      if (!release)
        throw new OidcFlowError('oidc_busy', 'Your connection test is still running; try again in a moment')
      let named: IdPInfo | undefined
      try {
        await manager.test(record.settings, {
          oidcCallback: async (params) => {
            named = params.idpInfo
            throw new Error(OIDC_SIGN_IN_NEEDED)
          },
        })
      } finally {
        release()
      }
      if (!named)
        throw new OidcFlowError(
          'oidc_no_idp',
          'The MongoDB server named no identity provider: check the hosts, the allowed hosts and that the server signs in with OIDC',
        )
      return named
    },
    expectedIssuer: (id) => connections.get(id)?.settings.auth.oidc?.expectedIssuer,
    warn: (fields, message) => app.log.warn(fields, message),
  })
  // W7: a job's client is its owner's (jobs/identity); W8: values as stored — copies, exports and
  // backups move ciphertext as it is, never decrypted — except imports, whose writes are encrypted
  // (their routes refuse a caller who may not see the data, and a decrypt-only connection).
  const client = (id: string) => manager.getClient(id, { user: jobOwner() })
  const encryptingClient = (id: string) => manager.getClient(id, { user: jobOwner(), decrypt: true })
  const jobKinds = {
    'index.create': indexCreateKind({ client }),
    'collection.duplicate': duplicateKind({ client }),
    'data.import': importKind({ client: encryptingClient, ctx: () => ctx }),
    'data.importSql': importSqlKind({ client: encryptingClient, ctx: () => ctx }),
    'data.export': exportKind({ client, ctx: () => ctx }),
    'data.copy': copyKind({ client, ctx: () => ctx }),
    'data.compare': compareKind({ client, ctx: () => ctx }),
    'data.sync': syncKind({ client, ctx: () => ctx }),
    'backup.dump': dumpKind({ client, ctx: () => ctx }),
    'backup.restore': restoreKind({ client, ctx: () => ctx }),
    'backup.send': sendKind({ ctx: () => ctx }),
    'backup.fetch': fetchKind({ ctx: () => ctx }),
    'backup.drill': drillKind({ client, ctx: () => ctx }),
  } as ServerContext['jobKinds']

  // Phase 3b §6: metric history, sampled by a recorder that knows only enabled connections.
  const metricHistory = new HistoryRepo(deps.store.db)
  const historyRecorder = new HistoryRecorder({
    repo: metricHistory,
    client: (id) => manager.getClient(id),
    hold: (id) => manager.hold(id),
    now,
    // W3.3: connections with metric alert rules are sampled too, and every sample is evaluated.
    extra: () => ctx.alerts.sampled(),
    onSample: (id, sample, client) =>
      void ctx.alerts.engine
        .onSample(id, sample, client)
        .catch((err: unknown) => app.log.warn({ err }, 'alerts: evaluating a sample failed')),
  })
  const ctx: ServerContext = {
    config,
    store: deps.store,
    secretBox: deps.secretBox,
    users: new UserRepo(deps.store.db, now),
    // Session lifetime (2026-10-29): the idle time an administrator chose.
    sessions: new SessionRepo(deps.store.db, now, sessionIdleMs(deps.store.db, now)),
    access: new AccessSignal(),
    audit: (() => {
      const { key, keyCreated } = auditChainKey(deps.store.db, deps.secretBox)
      return new AuditRepo(deps.store.db, now, key, { keyCreated })
    })(),
    localCsrfToken: randomBytes(32).toString('base64url'),
    launch: config.auth ? null : new LaunchGate(deps.launchSecret ?? randomBytes(32), now, deps.store.db),
    now,
    // Security review 2026-10-13 (L1): an account at one address is held back after 5 guesses, an
    // address guessing at many accounts after 20, an account across addresses only after 50 — and
    // never where it signed in lately.
    throttle: new LoginThrottle(now, { freeByPrefix: { 'ip:': 20, 'account:': 50 } }),
    knownSignIns: new KnownSignIns(now),
    bans: new SignInBans(deps.store.db, now, { trustsProxies: config.trustedProxies.length > 0 }),
    signInBudget: new SignInBudget(now, SIGN_IN_RATE_LIMIT),
    accessList: new AccessList(deps.store.db, now, (message) => app.log.warn(message)),
    passwordWork: new PasswordWork(),
    stepUps: new StepUps(now),
    setup: new SetupState(),
    tickets: new MfaTickets(now),
    challenges: new ChallengeStore(now),
    recoveryCodes: new RecoveryCodeRepo(
      deps.store.db,
      now,
      appKey(deps.store.db, deps.secretBox, 'recovery-codes'),
    ),
    passkeys: new PasskeyRepo(deps.store.db, now),
    connections,
    grants: new GrantRepo(deps.store.db),
    manager,
    history: new QueryHistoryRepo(deps.store.db, deps.secretBox, now),
    favourites: new FavouriteRepo(deps.store.db, deps.secretBox, now),
    snippets: new SnippetRepo(deps.store.db, deps.secretBox, now),
    personalFields: new PersonalFieldsRepo(deps.store.db, deps.secretBox, now),
    profilerReverts: new ProfilerReverts(deps.store.db),
    metricHistory,
    historyRecorder,
    savedPipelines: new SavedPipelineRepo(deps.store.db, deps.secretBox, now),
    jobs: new JobRunner({
      repo: new JobRepo(deps.store.db),
      now,
      hold: (id) => manager.hold(id),
      ...(deps.jobs?.cancelGraceMs !== undefined ? { cancelGraceMs: deps.jobs.cancelGraceMs } : {}),
      describe: (e) => {
        const err = toAppError(e)
        return err instanceof AppError ? err.message : 'The job failed'
      },
    }),
    jobKinds,
    monitor: new MonitorHub({
      client,
      hold: (id) => manager.hold(id),
      now,
      ...(deps.monitor?.intervalMs !== undefined ? { intervalMs: deps.monitor.intervalMs } : {}),
    }),
    ops: { kill: killByComment },
    aggregation: {
      cache: new PreviewCache({ ttlMs: 60_000, max: 500, now }),
      // Runs, aggregation counts, explains and validation tests: two per user; security audit
      // 2026-10-16 (Important 2): sixteen on the server, so many users cannot hold every connection.
      slots: new RunSlots(2, 16),
      // Final review 2a, Minor 11: the web aborts older previews, so a few at once is plenty.
      previewSlots: new RunSlots(4),
      maxRunBytes: deps.aggregation?.maxRunBytes ?? MAX_RUN_BYTES,
    },
    // Security review 2026-10-13 (M3): a page of documents is read with a byte cap, a few at once.
    documents: { slots: new RunSlots(6, 32), maxPageBytes: deps.documents?.maxPageBytes ?? MAX_PAGE_BYTES },
    // Security audit 2026-10-16 (minor): a viewer may test a connection; one at a time per user, so
    // nobody holds the server's eight test slots alone.
    connectionTests,
    library: { limits: { ...LIBRARY_LIMITS, ...deps.library } },
    shell: undefined as unknown as ShellManager,
    shellHistory: new ShellHistoryRepo(deps.store.db, deps.secretBox, now),
    docPinKey: deps.secretBox.derive('mm-doc-pin-v1'),
    rulesVersionKey: deps.secretBox.derive('mm-rules-version-v1'),
    pluginFrameKey: deps.secretBox.derive('mm-plugin-frame-v1'),
    alerts: new AlertService({
      db: deps.store.db,
      box: deps.secretBox,
      now,
      enabled: config.alerts.enabled,
      privateNetworks: config.alerts.privateNetworks,
      connectionName: (id) => connections.get(id)?.name ?? null,
      warn: (fields, message) => app.log.warn(fields, message),
      ...(deps.alerts?.retryDelaysMs ? { retryMs: deps.alerts.retryDelaysMs } : {}),
    }),
    // Design 2026-10-25 (C7): made once the context is (it reads the alerts and the rules).
    reports: undefined as unknown as ReportRunner,
    events: new AppEvents(now),
    health: new HealthCache({ manager, now }),
    optionalModules,
    policy,
    oidc,
    kmsEgress,
    encryptionTools: deps.encryptionTools ?? encryptionToolsFactory(kmsEgress, policy),
    maskingAudit: undefined as unknown as RefusalAudit,
    watch: undefined as unknown as WatchManager,
    liveSync: undefined as unknown as ServerContext['liveSync'],
    preferences: new PreferencesRepo(deps.store.db, now),
    pluginsEgress: createEgress({
      networks: [],
      networksSetting: 'no setting (the GitHub install reaches public addresses only)',
    }),
    // The updater (2026-11-03): GitHub's public addresses only, through MM_UPDATE_PROXY when set.
    updates: new UpdateService({
      settings: new SettingsRepo(deps.store.db, now),
      egress: createEgress({
        networks: [],
        networksSetting: 'no setting (the update check reaches public addresses only)',
        ...(config.updates.proxy ? { proxy: config.updates.proxy } : {}),
      }),
      enabled: config.updates.enabled,
      now,
      dataDir: config.dataDir,
      installed: VERSION,
      origin,
      fallbackDistribution: distribution,
      env: process.env,
      nodeVersion: process.versions.node,
      db: deps.store.db,
      ...(deps.requestRestart ? { restart: deps.requestRestart } : {}),
      // Backups, transfers and imports under way, and live syncs with a worker.
      runningJobs: () => {
        const states = ctx.liveSync.metrics().states
        return ctx.jobs.runningCount() + RUNNING_STATES.reduce((n, s) => n + (states[s] ?? 0), 0)
      },
    }),
    plugins: new PluginService({
      repo: new PluginRepo(deps.store.db, now, deps.secretBox),
      userRoot: join(config.dataDir, 'plugins'),
      bundledRoot: config.bundledPluginsDir,
      enabled: config.plugins,
      now,
      warn: (message, details) => app.log.warn(details ?? {}, message),
      updated: (details) =>
        ctx.audit.append({
          action: 'plugins.updated',
          outcome: 'success',
          userId: null,
          username: null,
          ip: null,
          connectionId: null,
          namespace: null,
          details,
        }),
    }),
    ai: {
      providers: new AiProviderRepo(deps.store.db, deps.secretBox, now),
      egress: createAiEgress(config),
      limits: new AiLimits(now, {
        perMinute: config.ai.perMinute,
        agentPerMinute: config.ai.agentPerMinute,
        perDay: config.ai.perDay,
        perUser: 2,
        server: config.ai.maxConcurrent,
      }),
      tests: new UploadGate(now, { perMinute: 10, concurrent: 2 }),
      metrics: { requests: new Map(), tokens: { input: 0, output: 0 } },
      testMs: 60_000,
      history: new AiHistoryRepo(deps.store.db, deps.secretBox, new SettingsRepo(deps.store.db, now), now, {
        chatsKept: config.ai.chatDays > 0,
      }),
      // AI history review I3: a search opens sealed rows; 30 a minute per user.
      historySearches: new UploadGate(now, { perMinute: 30, concurrent: 1 }),
      prices: new AiPriceRepo(deps.store.db, now),
      agent: createAgentServices(now),
      ...(() => {
        // Final review minor 9: the store keeps the chats answering now out of its removals.
        const chatsRunning = new Set<string>()
        return {
          chats: createChatStore(deps.store.db, deps.secretBox, now, config.ai.chatDays, chatsRunning),
          chatsRunning,
        }
      })(),
    },
    transfer: (() => {
      const limits = transferLimits(config)
      return {
        files: new TransferFiles(deps.store.db, join(config.dataDir, 'transfer'), limits, now),
        reports: new TransferReports(deps.store.db, now),
        presets: new TransferPresets(deps.store.db, deps.secretBox, now),
        limits,
        uploads: new UploadGate(now),
        previews: new PreviewGate(),
      }
    })(),
    backup: (() => {
      const limits = backupLimits(config)
      return {
        store: new BackupStore(deps.store.db, join(config.dataDir, 'backups'), limits, now),
        limits,
        // Plan ruling 5: 10 free password attempts per file, then growing delays.
        // Plan ruling 5: ten password attempts per file (the lock starts after the tenth failure).
        attempts: new LoginThrottle(now, { freeAttempts: 9, baseDelayMs: 6_000, maxDelayMs: 15 * 60_000 }),
        tools: new ToolSlots(MAX_TOOL_PROCESSES),
        toolsTmp: join(config.dataDir, 'tools-tmp'),
        uploads: new UploadGate(now, { perMinute: 600, concurrent: 2 }),
        reads: new BackupReadGate(),
        // Phase 3d-3b.
        destinations: new DestinationRepo(deps.store.db, deps.secretBox, now),
        copies: new CopyRepo(deps.store.db, deps.secretBox, now),
        egress: createEgress({
          networks: config.backup.privateNetworks,
          ...(config.backup.proxy ? { proxy: config.backup.proxy } : {}),
        }),
        googleHosts: GOOGLE_HOSTS,
        deviceFlows: new DeviceFlows(now),
        slots: new DestinationSlots(config.backup.destTransfers),
        transfers: new Map(),
        jobNotes: new Map(),
        destTests: new UploadGate(now, { perMinute: 10, concurrent: 2 }),
        destLists: new UploadGate(now, { perMinute: 30, concurrent: 2 }),
        tokens: new Map(),
        // Phase 3d-3c.
        keys: new BackupKeyRepo(deps.store.db, deps.secretBox, now),
        keyGate: new UploadGate(now, { perMinute: 10, concurrent: 10, windowMs: 3_600_000 }),
        schedules: new ScheduleRepo(deps.store.db, now),
        runs: new RunRepo(deps.store.db, now),
        schedulePreviews: new UploadGate(now, { perMinute: 60, concurrent: 60 }),
        scheduler: undefined as unknown as Scheduler,
      }
    })(),
  }
  ctx.maskingAudit = new RefusalAudit(ctx.audit, now)
  // Second review (minor 3): every browser signed out of local mode ends the local shells (owner
  // null), a command running in them too — ctx.shell is read when it happens (made below).
  ctx.launch?.onForget(() => void ctx.shell.closeFor({ userId: null }, 'access'))
  ctx.watch = new WatchManager({ ctx: () => ctx, ...deps.watch })
  ctx.liveSync = new LiveSyncRunner({
    ctx: () => ctx,
    repo: new LiveSyncRepo(deps.store.db, deps.secretBox, now),
    ...deps.liveSync,
  })
  // W3.3: failed jobs and live syncs that stopped on their own become alert events.
  ctx.jobs.onChange((job) => ctx.alerts.onJob(job))
  ctx.liveSync.onChange((r) => ctx.alerts.onLiveSync(r))
  // W4 review I4: the app's events (a failed restore drill, two-way conflicts, Watch matches) too.
  ctx.events.on((e) => ctx.alerts.onAppEvent(e))
  ctx.reports = new ReportRunner({
    db: deps.store.db,
    now,
    manager,
    personalFields: ctx.personalFields,
    alerts: ctx.alerts,
    connectionName: (id) => connections.get(id)?.name ?? null,
    encrypted: (id) => !!connections.get(id)?.settings.encryption?.enabled,
    warn: (fields, message) => app.log.warn(fields, message),
  })
  ctx.backup.scheduler = new Scheduler({
    ctx: () => ctx,
    // Final review I2: the loop logs what failed and goes on.
    log: (err) => app.log.error({ err }, 'scheduled backups: a tick failed'),
  })
  // Phase 3a-1: the advanced shell. Its plan derives the upstream from the connection and the
  // caller's role; the worker never receives a credential.
  ctx.shell = new ShellManager({
    config: { shell: config.shell, allowServerJs: config.allowServerJs },
    now,
    log: app.log,
    audit: (row) =>
      ctx.audit.append({
        action: row.action,
        outcome: 'success',
        userId: row.userId,
        username: row.username,
        ip: row.ip,
        connectionId: row.connectionId,
        namespace: row.db ?? null,
        details: row.details,
      }),
    onRefused: (connectionId) =>
      manager.noteRefusal(connectionId, new ConnectionError('auth', SIGN_IN_REFUSED)),
    plan: async (caller, connectionId) => {
      const record = connections.get(connectionId)
      if (!record) throw Errors.notFound('Connection not found')
      const client = await shellClient(manager, connectionId)
      return keepingRefusal(manager, connectionId, () =>
        buildUpstreamPlan({
          settings: record.settings,
          // W8: the shell cannot encrypt (its worker loads no native module): on a connection with
          // client-side encryption it reads values as stored and writes nothing, so nothing lands
          // in the clear where it belongs encrypted.
          readOnly:
            caller.readOnly ||
            record.readOnly ||
            config.readOnly ||
            record.settings.encryption?.enabled === true,
          admin: caller.admin,
          client,
          openTunnel: openSshTunnel,
        }),
      )
    },
    bundlePath: workerBundlePath(),
    record: (owner, connectionId, code) => {
      try {
        ctx.shellHistory.record(owner, connectionId, code)
      } catch (e) {
        app.log.warn({ err: e }, 'could not record shell history')
      }
    },
    mask: maskCode,
  })
  // Phase 2c: recent queries become history once, with the key at hand. A failure leaves them in
  // place for the next start; it never stops this one.
  try {
    const { moved, dropped } = ctx.history.moveRecent()
    // Dropped rows are lost data: a warning (final review 2c, Minor 2).
    if (dropped)
      app.log.warn(
        { moved, dropped },
        'recent queries moved into the query history; some could not be opened',
      )
    else if (moved) app.log.info({ moved, dropped }, 'recent queries moved into the query history')
  } catch (e) {
    app.log.error(
      { err: e },
      'could not move recent queries into the query history; will retry at the next start',
    )
  }
  // Local mode's history goes when team mode starts (1g-1 Minor 11); how much is logged, never
  // silent (final review 2c, I4).
  if (config.auth) {
    // Review of the bans (minor 4): the unknown-user hash is made now, not by the first sign-ins —
    // which would each wait for it outside the password checks' queue.
    void dummyHash()
    const removed = ctx.history.forgetLocal()
    if (removed)
      app.log.warn({ removed }, 'local mode query history removed: team mode has no owner-less user')
    const shellRemoved = ctx.shellHistory.forgetLocal()
    if (shellRemoved)
      app.log.warn(
        { removed: shellRemoved },
        'local mode shell history removed: team mode has no owner-less user',
      )
  }
  app.decorate('ctx', ctx)
  app.decorateRequest('principal', null)
  app.decorateRequest('auditInfo', null)
  app.decorateRequest('agentVia', null)
  app.decorateRequest('connection', null)
  app.decorateRequest('connectionRole', null)
  app.decorateRequest('connectionPermission', null)
  app.decorateRequest('releases', null)
  // A connection used by a request stays open until the request has answered or was abandoned.
  const releaseHolds = async (request: FastifyRequest) => {
    for (const release of request.releases?.splice(0) ?? []) release()
  }
  app.addHook('onResponse', releaseHolds)
  // W4 re-review C1: a restore drill's scratch database is refused wherever a request names it — a
  // path, a query, or a body's source, target, mapping or scope (live sync, copy, compare, sync,
  // backup, restore, the agent's tools) — before any route reads it.
  app.addHook('preValidation', async (request) => {
    if (
      namesDrillScratch(request.params) ||
      namesDrillScratch(request.query) ||
      namesDrillScratch(request.body)
    )
      assertNotDrillScratch('mm_drill_')
  })
  // Second review of the security pass (N1): an abandoned request keeps its holds until its handler
  // is done — a confirmed $merge or bulk write outlives its closed tab, and so must its client.
  app.addHook('onRequestAbort', async (request) =>
    whenHandlerSettled(request, () => void releaseHolds(request)),
  )

  await app.register(cookie)
  // Security review 2026-10-13 (web, low): frames of the app show plugin frames only — a plugin's
  // frame navigating itself elsewhere (another site, or another address of the app with what it read
  // in the URL) is stopped by the browser. Named on the address the browser used, as the frame's own
  // policy is; 'none' when that address is not a plain host.
  const framesOf = (request: FastifyRequest): string => {
    const host = request.host
    if (!/^[A-Za-z0-9.:[\]-]{1,255}$/.test(host)) return "'none'"
    return `${request.protocol === 'https' ? 'https' : 'http'}://${host}${config.basePath.replace(/\/$/, '')}/plugin-frame/`
  }
  app.addHook('onRequest', async (request) => {
    ;(request.raw as { mmFrames?: string }).mmFrames = framesOf(request)
  })
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        // A GridFS preview's sound or video: bytes the app fetched itself, shown from a blob.
        mediaSrc: ["'self'", 'blob:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameSrc: [(req) => (req as { mmFrames?: string }).mmFrames ?? "'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  })
  const prefix = config.basePath.replace(/\/$/, '')
  const apiPath = `${prefix}/api`
  // Classified by the matched route, not the raw URL: the router decodes the path, so "/%61pi/…"
  // reaches an API route and must count against the API budget.
  const isApi = (request: FastifyRequest): boolean => {
    const route = request.routeOptions.url
    return route !== undefined && (route === apiPath || route.startsWith(`${apiPath}/`))
  }
  // Security review 2026-10-13 (ops): no API answer is kept by a browser or a proxy (documents,
  // users, settings), refusals and unknown addresses included; a route that sets its own policy keeps it.
  app.addHook('onSend', async (request, reply, payload) => {
    const path = request.url.split('?')[0]!
    if (
      (isApi(request) || path === apiPath || path.startsWith(`${apiPath}/`)) &&
      !reply.hasHeader('cache-control')
    )
      reply.header('cache-control', 'no-store')
    return payload
  })
  // A build file by its address: the static files share one wildcard route. The API is told first,
  // so a path that reaches an API route counts against the API, however it is spelled.
  const assetsPath = `${prefix}/assets/`
  const bucket = (request: FastifyRequest): 'api' | 'asset' | 'web' =>
    isApi(request)
      ? 'api'
      : (request.method === 'GET' || request.method === 'HEAD') && request.url.startsWith(assetsPath)
        ? 'asset'
        : 'web'
  const BUDGET = { api: config.apiRateLimit, asset: RATE_LIMIT_ASSETS, web: RATE_LIMIT_WEB }
  await app.register(rateLimit, {
    max: (request) => BUDGET[bucket(request)],
    keyGenerator: (request) => `${bucket(request)}:${request.ip}`,
    timeWindow: '1 minute',
    errorResponseBuilder: (_request, context) => Errors.rateLimited(context.ttl),
  })

  const hostAllowed = hostAllowlist(config)
  app.addHook('onRequest', async (request) => {
    if (!isHealthPath(request.url, prefix) && !hostAllowed(request.hostname.toLowerCase())) {
      throw Errors.forbidden('Host not allowed: add it with --allowed-hosts (MM_ALLOWED_HOSTS)', {
        reason: 'host_not_allowed',
      })
    }
  })
  // Panel access (2026-10-30): in team mode, an address the administrator's list leaves out reaches
  // nothing but the web app's own files (which say so) and the health checks — not the API, the
  // sign-in, the socket, plugin frames or the OIDC callback. A session it brings is ended. The
  // metrics carry their own token and are read by monitoring, not people: they are not the panel.
  if (config.auth)
    app.addHook('onRequest', async (request) => {
      const route = request.routeOptions.url
      if (route === undefined) return
      const gated =
        isApi(request) ||
        route === `${prefix}/ws` ||
        route.startsWith(`${prefix}/plugin-frame/`) ||
        route.startsWith(`${prefix}/oidc/`)
      if (!gated || ctx.accessList.allows(request.ip)) return
      const sessionId = readSessionId(request)
      if (sessionId) ctx.sessions.revoke(sessionId)
      throw Errors.forbidden('The panel does not answer this address', {
        reason: 'ip_not_allowed',
        address: request.ip,
      })
    })
  // Sign-in bans (2026-10-30): the sign-in steps' own budget per address, before any body is read.
  app.addHook('onRequest', async (request) => {
    if (request.routeOptions.config?.signIn) signInBudget(request)
  })
  app.addHook('onRequest', async (request) => {
    request.principal = resolvePrincipal(request)
  })
  // Security audit 2026-10-16 (important 2): in local mode the API and the socket answer only the
  // browser that opened a launch link — by the matched route, as below (the router decodes "/%61pi/…").
  // Review of the audit fixes (important 1): the cookie alone opens nothing (other ports of the host
  // get it too) — the API wants this browser's page key as well (x-mm-local); the socket's hello
  // wants the CSRF token, which only such a request gets; a download link, a one-time ticket the page
  // asked for. Only the claim of the key itself goes on the cookie (once, soon after the link).
  if (!config.auth)
    app.addHook('onRequest', async (request, reply) => {
      const refuse = () =>
        Errors.unauthenticated('Open Mongo Manager from the link it printed when it started', {
          reason: 'launch_required',
        })
      const route = request.routeOptions.url
      const browser = request.principal?.kind === 'local' ? request.principal.browser : undefined
      if (route === `${prefix}/ws` || route === `${apiPath}/auth/local/claim`) {
        if (!browser) throw refuse()
        return
      }
      if (!isApi(request)) return
      if (!browser) {
        request.principal = null
        throw refuse()
      }
      if (ctx.launch!.keyOk(browser, request.headers[LOCAL_KEY_HEADER])) return
      const query = request.query as Record<string, unknown> | undefined
      const ticket = query?.mm_link
      if (
        request.method === 'GET' &&
        typeof ticket === 'string' &&
        ctx.launch!.takeTicket(browser, ticket, request.url.split('?', 1)[0]!)
      ) {
        delete query!.mm_link
        return
      }
      request.principal = null
      // Second review (N2): a link the browser followed on its own, without its ticket (a quick
      // middle-click): a page saying where to click it, not a JSON refusal.
      if (request.method === 'GET' && request.headers['sec-fetch-mode'] === 'navigate')
        return reply
          .code(401)
          .header('content-type', 'text/html; charset=utf-8')
          .header('cache-control', 'no-store')
          .send(linkRefusedPage(config.basePath, request.headers['accept-language']))
      throw refuse()
    })
  // Independent review of the security pass (minor): every API route but those under /api/auth/
  // (status, setup, the sign-in steps — the only ones a caller not signed in may use, as the route
  // matrix says) needs a signed-in caller; refused on the request's head, before any body is parsed.
  // The routes under /api/auth/ that need one check it themselves.
  app.addHook('onRequest', async (request) => {
    if (request.principal || !isApi(request)) return
    if ((request.routeOptions.url ?? '').startsWith(`${apiPath}/auth/`)) return
    throw Errors.unauthenticated()
  })
  // Phase 4c §4: an administrator who must set 2FA up may reach their account only — not the API
  // nor the real-time socket (at <base>/ws). By the matched route, like the rate limit: the router
  // decodes "/%61pi/…" to an API route.
  app.addHook('onRequest', async (request) => {
    const route = request.routeOptions.url ?? ''
    const gated = (isApi(request) && !route.startsWith(`${apiPath}/auth/`)) || route === `${prefix}/ws`
    if (!gated) return
    if (twoFactorPending(ctx, request.principal))
      throw Errors.forbidden('Set up two-factor authentication first', {
        reason: 'two_factor_setup_required',
      })
  })
  app.addHook('onRequest', csrfGuard)
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id)
  })
  // Independent review (I1): a request whose answer never went out (its client left, its socket was
  // destroyed) gets no onResponse; its audit row is written when its response closes, once.
  const audited = new WeakSet<FastifyRequest>()
  const audit = (request: FastifyRequest, reply: FastifyReply, abortedStatus?: number) => {
    const action = request.routeOptions.config?.audit
    if (!action || audited.has(request)) return
    audited.add(request)
    const aborted = abortedStatus !== undefined
    const status = abortedStatus ?? reply.statusCode
    const principal = request.principal
    const info = request.auditInfo
    if (info?.quiet && status < 400) return
    // Sign-in bans (2026-10-30): a sign-in refused before anything was checked (rate limited, held
    // back, banned, busy) is no row of its own — a flood would fill the log; a ban is one row.
    if (status === 429 && request.routeOptions.config?.signIn) return
    // Sign-in routes act on the account named in the request, not on whoever may already be signed in.
    const nsParams = request.params as { db?: unknown; coll?: unknown }
    const namespace =
      typeof nsParams.db === 'string'
        ? typeof nsParams.coll === 'string'
          ? `${nsParams.db}.${nsParams.coll}`
          : nsParams.db
        : null
    const subject =
      info && info.userId !== undefined ? { userId: info.userId, username: info.username ?? null } : null
    ctx.audit.append({
      action,
      outcome: status < 400 ? 'success' : status === 401 || status === 403 ? 'denied' : 'failure',
      userId: subject ? subject.userId : (principal?.userId ?? null),
      username: subject ? subject.username : (principal?.username ?? info?.username ?? null),
      ip: request.ip,
      connectionId: request.connection?.id ?? null,
      namespace,
      details: {
        status,
        params: request.params,
        ...request.auditInfo?.details,
        // B6: made by the agent for a turn — its run, chat and call — whatever the route wrote.
        ...(request.agentVia ? { agent: { ...request.agentVia } } : {}),
        ...(aborted ? { aborted: true } : {}),
      },
    })
  }
  app.addHook('onResponse', async (request, reply) => audit(request, reply))
  app.addHook('onRequest', async (request, reply) => {
    reply.raw.once('close', () => {
      // Ended by the server (all of it handed over): its onResponse audits it.
      if (reply.raw.writableFinished || reply.raw.writableEnded) return
      // Second review (N1): the holds go when the handler is done, never at the close — a confirmed
      // write outlives its tab (aggregate.ts, final review I7), its connection with it.
      // Second review (minor): its audit row too, with what the handler really did (a write that
      // went through is a success), marked aborted.
      whenHandlerSettled(request, (outcome) => {
        void releaseHolds(request)
        const status = outcome.ok
          ? reply.statusCode
          : Number((outcome.error as { statusCode?: unknown } | null)?.statusCode) || 500
        try {
          audit(request, reply, status)
        } catch (err) {
          // A socket closed while the server shuts down: its store may be gone already.
          request.log.warn({ err }, 'could not audit a request whose answer never went out')
        }
      })
    })
  })

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      // Phase 3c §4.7: MongoDB's own text can quote a personal value; a restricted user gets codes.
      const shown = restrictedRequest(request) ? forRestricted(error) : error
      if (shown.statusCode === 403) ctx.maskingAudit.refused(request, shown)
      return reply.status(shown.statusCode).send(shown.toBody(request.id))
    }
    const status = error.statusCode ?? 500
    if (status === 413) return reply.status(413).send(Errors.payloadTooLarge().toBody(request.id))
    if (status >= 400 && status < 500) {
      return reply
        .status(status)
        .send(new AppError('VALIDATION_ERROR', 'Malformed request', status).toBody(request.id))
    }
    request.log.error({ err: error }, 'unhandled error')
    return reply
      .status(500)
      .send({ code: 'INTERNAL', message: 'Internal server error', correlationId: request.id })
  })
  // GET navigations outside /api fall back to the SPA (client-side routes); everything else is a JSON 404.
  let spaHtml: string | null = null
  app.setNotFoundHandler((request, reply) => {
    const apiPrefix = `${config.basePath}api/`
    // A missing file under assets/ is a 404, never the app page: a service worker or proxy that
    // caches hashed assets must not keep the page under a script's name (final review 1g-2, I1).
    let path = request.url.split('?')[0]!
    try {
      path = decodeURIComponent(path)
    } catch {
      // Malformed escapes: judged as written.
    }
    const wantsHtml =
      request.method === 'GET' &&
      !path.startsWith(apiPrefix) &&
      !path.startsWith(`${config.basePath}assets/`) &&
      path.startsWith(config.basePath)
    if (spaHtml && wantsHtml && /text\/html|\*\/\*/.test(String(request.headers.accept ?? ''))) {
      return reply
        .status(200)
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-cache')
        .send(spaHtml)
    }
    return reply.status(404).send(Errors.notFound('Route not found').toBody(request.id))
  })

  await app.register(healthRoutes, { prefix })
  // Security audit 2026-10-16: local mode's launch links.
  if (!config.auth) await app.register(launchRoutes, { prefix })
  if (config.metricsToken) {
    const requests = countRequests(app)
    await app.register(metricsRoutes, {
      token: config.metricsToken,
      path: `${config.basePath}metrics`,
      requests,
    })
  }
  await app.register(authRoutes, { prefix: `${prefix}/api` })
  await app.register(passkeyRoutes, { prefix: `${prefix}/api` })
  await app.register(userRoutes, { prefix: `${prefix}/api` })
  await app.register(auditRoutes, { prefix: `${prefix}/api` })
  await app.register(jobRoutes, { prefix: `${prefix}/api` })
  await app.register(transferApiRoutes, { prefix: `${prefix}/api` })
  // Phase 1h: one socket per tab; messages above 64 KiB are cut by ws itself, above 16 KiB by the hub.
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } })
  const hub = new RealtimeHub(ctx, app.log, deps.realtime)
  await app.register(wsRoutes, { prefix, hub })
  app.addHook('onClose', async () => hub.close())
  app.addHook('onClose', async () => ctx.watch.closeAll())
  app.addHook('onClose', async () => ctx.monitor.close())
  // Phase 3b §3.1: profiler level 2 goes back by itself, also after a restart.
  const reverter = new ProfilerReverter({
    reverts: ctx.profilerReverts,
    client: (id) => manager.getClient(id),
    hold: (id) => manager.hold(id),
    audit: (entry) => ctx.audit.append(entry),
    now,
  })
  reverter.start()
  app.addHook('onClose', async () => reverter.stop())
  historyRecorder.start()
  app.addHook('onClose', async () => historyRecorder.stop())
  await app.register(connectionRoutes, { prefix: `${prefix}/api` })
  await app.register(dataRoutes, { prefix: `${prefix}/api` })
  // Phase 3d-3a: dump and restore.
  await app.register(backupRoutes, { prefix: `${prefix}/api` })
  await app.register(destinationRoutes, { prefix: `${prefix}/api` })
  await app.register(backupKeyRoutes, { prefix: `${prefix}/api` })
  await app.register(scheduleRoutes, { prefix: `${prefix}/api` })
  await app.register(liveSyncRoutes, { prefix: `${prefix}/api` })
  // W4.7: recorded Watch feeds.
  await app.register(watchRoutes, { prefix: `${prefix}/api` })
  await app.register(aiRoutes, { prefix: `${prefix}/api` })
  await app.register(aiChatRoutes, { prefix: `${prefix}/api` })
  await app.register(aiAgentRoutes, { prefix: `${prefix}/api` })
  await app.register(aiHistoryRoutes, { prefix: `${prefix}/api` })
  await app.register(meRoutes, { prefix: `${prefix}/api` })
  await app.register(pluginRoutes, { prefix: `${prefix}/api` })
  await app.register(updateRoutes, { prefix: `${prefix}/api` })
  // W3.3, W3.4: alerts and the connections' live health.
  await app.register(alertRoutes, { prefix: `${prefix}/api` })
  await app.register(connectionHealthRoutes, { prefix: `${prefix}/api` })
  // W7: OIDC sign-in (the identity provider sends the browser back outside the API: no page key or
  // strict cookie comes with that navigation; the flow's own binding cookie does).
  await app.register(oidcRoutes, { prefix: `${prefix}/api` })
  await app.register(oidcCallbackRoutes, { prefix })
  // Phase 4b §3: plugin frames, outside the API (no session; a ticket in the path).
  await app.register(pluginFrameRoutes, { prefix, key: ctx.pluginFrameKey })
  if (deps.webAssets) {
    spaHtml = await registerWebApp(app, { assets: deps.webAssets, basePath: config.basePath })
  } else if (deps.webRoot) {
    spaHtml = await registerWebApp(app, { root: deps.webRoot, basePath: config.basePath })
  }
  const pruneTimer = setInterval(() => ctx.sessions.pruneExpired(), 10 * 60_000)
  pruneTimer.unref()
  app.addHook('onClose', async () => clearInterval(pruneTimer))
  // Phase 4a-2 spec §2.4: chats past their retention go at start-up and hourly.
  const sweepChats = () => {
    try {
      ctx.ai.chats.sweep()
    } catch (err) {
      app.log.error({ err }, 'AI chats: the retention sweep failed')
    }
    // User review 2026-10-09: the AI history past its days goes with the chats' sweep.
    try {
      ctx.ai.history.sweep()
    } catch (err) {
      app.log.error({ err }, 'AI history: the retention sweep failed')
    }
    // Phase 4c §2: the audit log past the days kept (when an administrator set them), in batches.
    ctx.audit.sweep().catch((err: unknown) => app.log.error({ err }, 'Audit log: the retention sweep failed'))
    // W3.3: alert history past 90 days (or 20 000 entries).
    try {
      ctx.alerts.repo.prune()
    } catch (err) {
      app.log.error({ err }, 'Alerts: the history sweep failed')
    }
  }
  sweepChats()
  const chatSweep = setInterval(sweepChats, 3600_000)
  chatSweep.unref()
  app.addHook('onClose', async () => clearInterval(chatSweep))
  ctx.jobs.recover(jobKinds)
  // Phase 3e-2 plan ruling 1: after the jobs a restart cut are settled (interrupted).
  ctx.liveSync.boot()
  // Phase 3d-3b final review B1: copies a previous process was sending are failed, resume state kept.
  settleInterruptedCopies(ctx)
  ctx.jobs.startMaintenance()
  // Phase 3d-1: partial files of a previous run go first; expired files and reports go hourly.
  ctx.transfer.files.init()
  ctx.transfer.files.startSweep(() => ctx.transfer.reports.sweep())
  app.addHook('onClose', async () => ctx.transfer.files.close())
  // Phase 3d-3a: partial backups of a previous run go first; expired backups and uploads hourly.
  ctx.backup.store.init()
  await sweepToolDirs(ctx.backup.toolsTmp)
  ctx.backup.store.startSweep()
  // Phase 4b §2: the plugin folders, read once at start-up (a failure leaves them unchanged).
  await ctx.plugins.scan().catch((err) => app.log.error({ err }, 'plugins: the scan failed'))
  // Phase 3d-3c spec §3.2: the scheduling loop (off with MM_BACKUP_SCHEDULES=0).
  if (deps.scheduler?.autoStart !== false) ctx.backup.scheduler.start()
  app.addHook('onClose', async () => ctx.backup.scheduler.stop())
  if (deps.reports?.autoStart !== false && config.alerts.enabled) ctx.reports.start()
  // The updater's daily check, when an administrator turned it on.
  ctx.updates.start()
  app.addHook('onClose', async () => ctx.updates.stop())
  // Phase 3d-3b: unfinished uploads older than a week are abandoned at the provider, hourly.
  const copySweep = setInterval(() => void sweepStaleCopies(ctx).catch(() => undefined), 3600_000)
  copySweep.unref()
  app.addHook('onClose', async () => clearInterval(copySweep))
  app.addHook('onClose', async () => ctx.backup.store.close())
  // W3.3: notifications under way get a few seconds to end (their notes need the store).
  app.addHook('onClose', async () => {
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      ctx.alerts.notifier.idle(),
      new Promise<void>((r) => {
        timer = setTimeout(r, 5_000)
        timer.unref()
      }),
    ])
    clearTimeout(timer)
  })
  app.addHook('onClose', async () => ctx.jobs.close())
  app.addHook('onClose', async () => manager.closeAll())
  app.addHook('onClose', async () => ctx.shell.shutdown())
  // Re-review of C7 (I1): the reports' tick stops before the clients and the notifier close.
  app.addHook('onClose', async () => {
    await ctx.reports.stop()
  })
  // Phase 3e-2: registered last, so it runs first (onClose hooks run last-in, first-out): live
  // syncs and their verifications stop while their clients and the store are still open.
  app.addHook('onClose', async () => ctx.liveSync.close())
  return app
}
