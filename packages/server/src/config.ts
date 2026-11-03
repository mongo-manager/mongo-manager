import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { localFullPath } from './backup/series'

/**
 * The platform paths are checked for: this computer's, or the one a service is installed for (the
 * CLI's service install reads that machine's config). Fourth review of the CI fixes (minor 9): on
 * Windows the message says what a full path is there; /backups is on the current drive.
 */
let pathPlatform: NodeJS.Platform = process.platform
const absoluteMessage = () =>
  pathPlatform === 'win32'
    ? 'must be an absolute path on this computer, with its drive (as D:\\backups)'
    : 'must be an absolute path on this computer'
import { z } from 'zod'
import { isIP } from 'node:net'
import { classifyAddress, privateNetworkProblem } from './net/cidr'
/** Said as the path is checked, for the platform it is checked for. */
const mustBeLocalFull = (p: string, ctx: z.RefinementCtx) => {
  if (!localFullPath(p, pathPlatform)) ctx.addIssue({ code: 'custom', message: absoluteMessage() })
}

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const

/** Spec §4: how long a shell lives at most by default (12 hours). */
const SHELL_LIFETIME_MS = 12 * 60 * 60 * 1000

/** Phase 3a-1: the advanced shell settings, each field with a default. */
const ShellConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxPerUser: z.number().int().min(1).max(50).default(3),
  maxTotal: z.number().int().min(1).max(500).default(20),
  commandTimeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
  /**
   * The operator's idle and lifetime limits for a shell (0: none). User report 2026-10-12: a shell its
   * page holds stays open however long it is unused, as Compass's does (no idle limit by default);
   * one no page holds goes after the reconnect grace anyway. Security audit 2026-10-16: a shell
   * lives at most 12 hours by default, as spec §4 has it, so one left open is not kept for ever.
   */
  idleMs: z
    .number()
    .int()
    .refine((ms) => ms === 0 || (ms >= 10_000 && ms <= 86_400_000), '0 (none), or 10000 to 86400000')
    .default(0),
  lifetimeMs: z
    .number()
    .int()
    .refine((ms) => ms === 0 || (ms >= 60_000 && ms <= 86_400_000), '0 (none), or 60000 to 86400000')
    .default(SHELL_LIFETIME_MS),
  /**
   * Spec §4, configurable since the security audit of 2026-10-16: the worker's resident memory cap
   * (measured by the server from the operating system), the output of one command, and commands per
   * session a second.
   */
  rssMb: z.number().int().min(128).max(16_384).default(384),
  outputMb: z.number().int().min(1).max(64).default(5),
  commandsPerSecond: z.number().int().min(1).max(1000).default(20),
  /** Unprivileged ids the worker drops to when the server runs as root on POSIX. */
  uid: z.number().int().min(0).optional(),
  gid: z.number().int().min(0).optional(),
})

/** Phase 3d-1 spec §7: file transfer limits (sizes in MiB), each field with a default. */
const TransferConfigSchema = z.object({
  maxUploadMb: z.number().int().min(1).max(65_536).default(1024),
  quotaMb: z.number().int().min(16).max(1_048_576).default(5120),
  /**
   * All users together (security review 2026-10-13): they cannot fill the data directory's disk.
   * Not set: 51200, or the per-user quota when that is larger.
   */
  totalQuotaMb: z.number().int().min(16).max(16_777_216).optional(),
  ttlHours: z.number().int().min(1).max(720).default(24),
  maxJobHours: z.number().int().min(1).max(72).default(6),
})

/** Phase 3d-3b §3, phase 4a-1 §2.2: networks an outbound client may reach besides public addresses. */
const PrivateNetworksSchema = z
  .array(z.string().min(1).max(64))
  .max(64)
  .default(() => [])
  .superRefine((list, ctx) => {
    for (const text of list) {
      const problem = privateNetworkProblem(text)
      if (problem) ctx.addIssue({ code: 'custom', message: `${text}: ${problem}` })
    }
  })

/**
 * W4.5: the HTTP(S) proxy destinations go through — http:// or https://, credentials allowed, no path
 * or query; a metadata or link-local proxy is refused (an operator's proxy may be private).
 */
const ProxySchema = z
  .string()
  .max(2048)
  .superRefine((text, ctx) => {
    let url: URL
    try {
      url = new URL(text)
    } catch {
      return void ctx.addIssue({ code: 'custom', message: 'not a URL' })
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      ctx.addIssue({ code: 'custom', message: 'an http:// or https:// proxy is expected' })
    if (url.pathname !== '/' || url.search || url.hash || /[?#]/.test(text))
      ctx.addIssue({ code: 'custom', message: 'the proxy is an address only: no path, query or fragment' })
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (!host) ctx.addIssue({ code: 'custom', message: 'the proxy has no host' })
    else if (isIP(host)) {
      const v = classifyAddress(host, [])
      if (!v.ok && (v.reason === 'metadata' || v.reason === 'link_local' || v.reason === 'reserved'))
        ctx.addIssue({ code: 'custom', message: `the proxy's address is not allowed (${v.reason})` })
    }
  })

/** Phase 3d-3a spec §7.5: backup limits (sizes in MiB), each field with a default. */
const BackupConfigSchema = z.object({
  quotaMb: z.number().int().min(16).max(1_048_576).default(20_480),
  totalQuotaMb: z.number().int().min(16).max(16_777_216).default(102_400),
  maxUploadMb: z.number().int().min(1).max(1_048_576).default(20_480),
  ttlHours: z.number().int().min(1).max(720).default(24),
  maxJobHours: z.number().int().min(1).max(72).default(12),
  chunkMb: z.union([z.literal(16), z.literal(32), z.literal(64), z.literal(128)]).default(64),
  // Review of the CI fixes (minor 9): a relative one would name the folder the server runs from.
  toolsPath: z.string().min(1).max(4096).superRefine(mustBeLocalFull).optional(),
  /**
   * Phase 3d-3b §4.6: directories folder destinations may use (absolute paths), trimmed as the env's
   * are and as service install reads them for the systemd unit (review 2026-10-18, minor 5).
   */
  folderRoots: z.array(z.string().trim().min(1).max(4096).superRefine(mustBeLocalFull)).max(16).default([]),
  /** Phase 3d-3b §3: networks destinations may reach besides public addresses (and plain http there). */
  privateNetworks: PrivateNetworksSchema,
  /** W4.5: MM_BACKUP_PROXY — destinations outside the listed networks are reached through it. */
  proxy: ProxySchema.optional(),
  destPartMb: z.number().int().min(16).max(512).default(64),
  destTransfers: z.number().int().min(1).max(8).default(2),
  /**
   * W4 re-review (minor): MM_BACKUP_DRILL_MAX_MB — the most a restore drill writes. Needed where the
   * server does not say its free disk space (Atlas shared tiers); a bound besides it elsewhere.
   */
  drillMaxMb: z.number().int().min(1).max(10_485_760).optional(),
  /** Phase 3d-3c §3.2: MM_BACKUP_SCHEDULES=0 turns the scheduler off. */
  schedules: z.boolean().default(true),
  /** Phase 3d-3c §3.2: scheduled runs at once, server-wide. */
  scheduleConcurrency: z.number().int().min(1).max(8).default(2),
})
const BACKUP_DEFAULTS = {
  quotaMb: 20_480,
  totalQuotaMb: 102_400,
  maxUploadMb: 20_480,
  ttlHours: 24,
  maxJobHours: 12,
  chunkMb: 64 as const,
  folderRoots: [] as string[],
  privateNetworks: [] as string[],
  destPartMb: 64,
  destTransfers: 2,
  schedules: true,
  scheduleConcurrency: 2,
}

/** Phase 3e-1 spec §2.2: the Watch feed. */
const WatchConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxFeeds: z.number().int().min(1).max(500).default(50),
})
const WATCH_DEFAULTS = { enabled: true, maxFeeds: 50 }
/** Phase 3e-2 spec §2.4: live syncs. */
const LiveSyncConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxSyncs: z.number().int().min(1).max(100).default(10),
})
const LIVE_SYNC_DEFAULTS = { enabled: true, maxSyncs: 10 }
/** Phase 4a-1 spec §3.3: the AI assistant. */
const AiConfigSchema = z.object({
  enabled: z.boolean().default(true),
  privateNetworks: PrivateNetworksSchema,
  perMinute: z.number().int().min(1).max(120).default(10),
  /** W6.3 re-review (minor 3): an agent's further rounds a minute, per person (they count for the day). */
  agentPerMinute: z.number().int().min(1).max(120).default(30),
  perDay: z.number().int().min(1).max(10_000).default(200),
  maxConcurrent: z.number().int().min(1).max(64).default(8),
  /** Phase 4a-2 spec §2.4: days a chat is kept after its last message; 0 keeps chats in memory only. */
  chatDays: z.number().int().min(0).max(365).default(30),
})
const AI_DEFAULTS = {
  enabled: true,
  privateNetworks: [] as string[],
  perMinute: 10,
  agentPerMinute: 30,
  perDay: 200,
  maxConcurrent: 8,
  chatDays: 30,
}

/**
 * W3.3: alerts. Mail servers and webhooks are reached through the egress guard: public addresses,
 * and private ones only inside the networks listed here (MM_ALERTS_PRIVATE_NETWORKS).
 */
const AlertsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  privateNetworks: PrivateNetworksSchema,
})

/**
 * W7: MONGODB-OIDC. Identity providers are reached through the egress guard: public addresses, and
 * private ones only inside the networks listed here (MM_OIDC_PRIVATE_NETWORKS).
 */
const OidcConfigSchema = z.object({ privateNetworks: PrivateNetworksSchema })

/**
 * W8: client-side encryption. The crypt_shared library is code the server loads: in team mode only
 * this one, the operator's (MM_CRYPT_SHARED_LIB_PATH); a connection may name its own in local mode.
 */
const EncryptionConfigSchema = z.object({
  cryptSharedLibPath: z.string().min(1).max(4096).superRefine(mustBeLocalFull).optional(),
  /** Networks key management services (KMIP on premises) may be on (MM_KMS_PRIVATE_NETWORKS). */
  privateNetworks: PrivateNetworksSchema,
  /**
   * Security review C1: key management service hosts (host or host:port, 443 by default) a KMS
   * socket may reach besides the providers' own (MM_KMS_ALLOWED_HOSTS): a VPC endpoint, a KMIP server.
   */
  allowedHosts: z
    .array(z.string().regex(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*(?::\d{1,5})?$/, 'host or host:port'))
    .max(64)
    .default(() => []),
})

/** The updater (2026-11-03): MM_UPDATES=off turns it off whole; MM_UPDATE_PROXY reaches GitHub through a proxy. */
const UpdatesConfigSchema = z.object({
  enabled: z.boolean().default(true),
  proxy: ProxySchema.optional(),
})

const ConfigSchema = z.object({
  webPort: z.number().int().min(0).max(65535),
  host: z.string().min(1),
  auth: z.boolean(),
  dataDir: z.string().min(1),
  readOnly: z.boolean(),
  allowServerJs: z.boolean(),
  /** Phase 4c §4: administrators must have 2FA (MM_REQUIRE_ADMIN_2FA); also a setting in the app. */
  requireAdmin2fa: z.boolean(),
  /** Required 2FA (2026-10-28): every user must have 2FA (MM_REQUIRE_2FA); also a setting in the app. */
  requireAll2fa: z.boolean(),
  trustedProxies: z.array(z.string().min(1)),
  allowedHosts: z.array(z.string().min(1)),
  // Segments made only of dots ("/../") are refused: they would climb out of the prefix.
  basePath: z.string().regex(/^\/(?:(?!\.+\/)[A-Za-z0-9._~-]+\/)*$/, 'basePath must start and end with "/"'),
  unsafeNoAuth: z.boolean(),
  open: z.boolean(),
  uri: z.string().min(1).optional(),
  secretKey: z.string().min(1).optional(),
  /** Enables GET /metrics for a scraper presenting it as a bearer token (spec §3.5); off when unset. */
  metricsToken: z.string().min(32, 'metricsToken must be at least 32 characters').max(512).optional(),
  /** Built web app directory; defaults to the one shipped next to the server. */
  webRoot: z.string().min(1).optional(),
  /** Append JSON logs to this file (0600) instead of stdout, e.g. for a Windows scheduled task. */
  logFile: z.string().min(1).optional(),
  logLevel: z.enum(LOG_LEVELS),
  /** API requests one client address may make per minute (spec S13); raised for heavy automation. */
  apiRateLimit: z.number().int().min(60).max(100_000),
  /**
   * Independent review of the security pass (minor): open connections in all (MM_MAX_CONNECTIONS)
   * and from one address (MM_MAX_CONNECTIONS_PER_IP; not counted behind trusted proxies, which carry
   * everyone's: the proxy caps them there).
   */
  maxConnections: z.number().int().min(16).max(100_000),
  maxConnectionsPerIp: z.number().int().min(2).max(100_000),
  /** Phase 4b §1: the largest GridFS upload, in MB (MM_GRIDFS_MAX_MB). */
  gridfsMaxMb: z.number().int().min(1).max(10_240),
  /**
   * W6.4 review (minor 13): the documents one data model may sample in all, across its collections
   * (MM_MODEL_MAX_DOCS); past it each collection's sample is made smaller.
   */
  modelMaxDocs: z.number().int().min(100).max(1_000_000),
  /** Phase 4b §2: plugins at all (MM_PLUGINS); each one still needs an administrator's approval. */
  plugins: z.boolean(),
  /**
   * User request 2026-10-11: plugins installed from GitHub releases (MM_PLUGINS_GITHUB). Off unless a
   * server turns it on (user request 2026-10-12: "şimdilik githubdan indirmeyi pasife al").
   */
  pluginsGithub: z.boolean(),
  /** Phase 4b §4: the plugins shipped with the build, named by the program that starts the server. */
  bundledPluginsDir: z.string().min(1).optional(),
  /** Phase 3a-1: the advanced shell. Off disables it entirely; the limits bound each session. */
  shell: ShellConfigSchema.default({
    enabled: true,
    maxPerUser: 3,
    maxTotal: 20,
    commandTimeoutMs: 60_000,
    idleMs: 0,
    lifetimeMs: SHELL_LIFETIME_MS,
    rssMb: 384,
    outputMb: 5,
    commandsPerSecond: 20,
  }),
  /** Phase 3d-1: file import and export limits. */
  transfer: TransferConfigSchema.default({ maxUploadMb: 1024, quotaMb: 5120, ttlHours: 24, maxJobHours: 6 }),
  /** Phase 3d-3a: backup limits and the tools' directory. */
  backup: BackupConfigSchema.default(() => ({ ...BACKUP_DEFAULTS, folderRoots: [], privateNetworks: [] })),
  /** Phase 3e-1: change-stream feeds (on by default) and how many may run at once. */
  watch: WatchConfigSchema.default(WATCH_DEFAULTS),
  liveSync: LiveSyncConfigSchema.default(LIVE_SYNC_DEFAULTS),
  /** Phase 4a-1: the AI assistant. */
  ai: AiConfigSchema.default(() => ({ ...AI_DEFAULTS, privateNetworks: [] })),
  /** W3.3: alerts (MM_ALERTS) and the private networks their channels may reach. */
  alerts: AlertsConfigSchema.default(() => ({ enabled: true, privateNetworks: [] })),
  /**
   * W8: Kerberos signs in with the ticket of the account the server runs as — in team mode, every
   * user as that account. Refused there unless an administrator allows it (MM_ALLOW_KERBEROS).
   */
  allowKerberos: z.boolean(),
  /**
   * W7: an OIDC workload identity (Azure, GCP, Kubernetes) is the host's own: in team mode refused
   * unless an administrator allows it (MM_ALLOW_WORKLOAD_IDENTITY), and chosen per connection anyway.
   */
  allowWorkloadIdentity: z.boolean(),
  /**
   * Security review I6: OIDC sign-in with a code (the device flow). Whoever approves the code at the
   * identity provider signs in — someone handed another's code signs them in to this account — so in
   * team mode it is off unless an administrator turns it on (MM_OIDC_DEVICE_FLOW); on in local mode.
   */
  oidcDeviceFlow: z.boolean().optional(),
  oidc: OidcConfigSchema.default(() => ({ privateNetworks: [] })),
  encryption: EncryptionConfigSchema.default(() => ({ privateNetworks: [], allowedHosts: [] })),
  updates: UpdatesConfigSchema.default(() => ({ enabled: true })),
})

export type Config = z.infer<typeof ConfigSchema>
// The partial schema (config files) keeps shell optional without injecting its defaults, so a file
// with no shell key reads back without one; the final ConfigSchema still fills them.
export const PartialConfigSchema = ConfigSchema.partial().strict().extend({
  shell: ShellConfigSchema.optional(),
  transfer: TransferConfigSchema.optional(),
  backup: BackupConfigSchema.optional(),
  watch: WatchConfigSchema.optional(),
  liveSync: LiveSyncConfigSchema.optional(),
  ai: AiConfigSchema.optional(),
  alerts: AlertsConfigSchema.optional(),
  oidc: OidcConfigSchema.optional(),
  encryption: EncryptionConfigSchema.optional(),
  updates: UpdatesConfigSchema.optional(),
})
export type PartialConfig = z.infer<typeof PartialConfigSchema>

/** API requests one client address may make per minute, unless MM_API_RATE_LIMIT says otherwise. */
export const DEFAULT_API_RATE_LIMIT = 600

export class ConfigError extends Error {
  override name = 'ConfigError'
}

export function defaultConfig(): Config {
  return {
    webPort: 4321,
    host: '127.0.0.1',
    auth: false,
    dataDir: join(homedir(), '.mongo-manager'),
    readOnly: false,
    allowServerJs: false,
    requireAdmin2fa: false,
    requireAll2fa: false,
    trustedProxies: [],
    allowedHosts: [],
    basePath: '/',
    unsafeNoAuth: false,
    open: true,
    logLevel: 'info',
    apiRateLimit: DEFAULT_API_RATE_LIMIT,
    maxConnections: 1_000,
    maxConnectionsPerIp: 256,
    gridfsMaxMb: 512,
    modelMaxDocs: 20_000,
    plugins: true,
    pluginsGithub: false,
    shell: {
      enabled: true,
      maxPerUser: 3,
      maxTotal: 20,
      commandTimeoutMs: 60_000,
      idleMs: 0,
      lifetimeMs: SHELL_LIFETIME_MS,
      rssMb: 384,
      outputMb: 5,
      commandsPerSecond: 20,
    },
    transfer: { maxUploadMb: 1024, quotaMb: 5120, ttlHours: 24, maxJobHours: 6 },
    // Final review minor 18: fresh lists, never the module's.
    backup: { ...BACKUP_DEFAULTS, folderRoots: [], privateNetworks: [] },
    watch: WATCH_DEFAULTS,
    liveSync: LIVE_SYNC_DEFAULTS,
    ai: { ...AI_DEFAULTS, privateNetworks: [] },
    alerts: { enabled: true, privateNetworks: [] },
    updates: { enabled: true },
    allowKerberos: false,
    allowWorkloadIdentity: false,
    oidc: { privateNetworks: [] },
    encryption: { privateNetworks: [], allowedHosts: [] },
  }
}

function envBool(name: string, value: string): boolean {
  if (/^(1|true|yes|on)$/i.test(value)) return true
  if (/^(0|false|no|off)$/i.test(value)) return false
  throw new ConfigError(`${name} must be a boolean (1/0/true/false), got "${value}"`)
}

function envInt(name: string, value: string): number {
  if (!/^\d+$/.test(value)) throw new ConfigError(`${name} must be an integer, got "${value}"`)
  return Number(value)
}

const envList = (value: string) =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

export function configFromEnv(env: Record<string, string | undefined>): PartialConfig {
  const get = (name: string) => {
    const v = env[name]
    return v === undefined || v === '' ? undefined : v
  }
  const out: Record<string, unknown> = {}
  const set = (key: keyof Config, name: string, parse: (name: string, v: string) => unknown) => {
    const v = get(name)
    if (v !== undefined) out[key] = parse(name, v)
  }
  const text = (_name: string, v: string) => v
  set('webPort', 'MM_WEB_PORT', envInt)
  set('host', 'MM_HOST', text)
  set('auth', 'MM_AUTH', envBool)
  set('dataDir', 'MM_DATA_DIR', text)
  set('readOnly', 'MM_READ_ONLY', envBool)
  set('allowServerJs', 'MM_ALLOW_SERVER_JS', envBool)
  set('requireAdmin2fa', 'MM_REQUIRE_ADMIN_2FA', envBool)
  set('requireAll2fa', 'MM_REQUIRE_2FA', envBool)
  set('gridfsMaxMb', 'MM_GRIDFS_MAX_MB', envInt)
  set('modelMaxDocs', 'MM_MODEL_MAX_DOCS', envInt)
  set('plugins', 'MM_PLUGINS', envBool)
  set('pluginsGithub', 'MM_PLUGINS_GITHUB', envBool)
  set('trustedProxies', 'MM_TRUSTED_PROXIES', (_n, v) => envList(v))
  set('allowedHosts', 'MM_ALLOWED_HOSTS', (_n, v) => envList(v))
  set('basePath', 'MM_BASE_PATH', text)
  set('webRoot', 'MM_WEB_ROOT', text)
  set('unsafeNoAuth', 'MM_UNSAFE_NO_AUTH', envBool)
  set('open', 'MM_OPEN', envBool)
  set('uri', 'MM_URI', text)
  set('secretKey', 'MM_SECRET_KEY', text)
  set('metricsToken', 'MM_METRICS_TOKEN', text)
  set('logLevel', 'MM_LOG_LEVEL', text)
  set('logFile', 'MM_LOG_FILE', text)
  set('apiRateLimit', 'MM_API_RATE_LIMIT', envInt)
  set('maxConnections', 'MM_MAX_CONNECTIONS', envInt)
  set('maxConnectionsPerIp', 'MM_MAX_CONNECTIONS_PER_IP', envInt)
  // W7, W8: sign-in with the server's own identity, in team mode.
  set('allowKerberos', 'MM_ALLOW_KERBEROS', envBool)
  set('allowWorkloadIdentity', 'MM_ALLOW_WORKLOAD_IDENTITY', envBool)
  set('oidcDeviceFlow', 'MM_OIDC_DEVICE_FLOW', envBool)
  // Phase 3a-1: shell settings from the environment (a partial object merged over the default).
  const shell: Record<string, unknown> = {}
  const shellFlag = (key: string, name: string, parse: (name: string, v: string) => unknown) => {
    const v = get(name)
    if (v !== undefined) shell[key] = parse(name, v)
  }
  shellFlag('enabled', 'MM_SHELL_ENABLED', envBool)
  shellFlag('maxPerUser', 'MM_SHELL_MAX_PER_USER', envInt)
  shellFlag('maxTotal', 'MM_SHELL_MAX_TOTAL', envInt)
  shellFlag('commandTimeoutMs', 'MM_SHELL_COMMAND_TIMEOUT_MS', envInt)
  shellFlag('idleMs', 'MM_SHELL_IDLE_MS', envInt)
  shellFlag('lifetimeMs', 'MM_SHELL_LIFETIME_MS', envInt)
  shellFlag('rssMb', 'MM_SHELL_RSS_MB', envInt)
  shellFlag('outputMb', 'MM_SHELL_OUTPUT_MB', envInt)
  shellFlag('commandsPerSecond', 'MM_SHELL_COMMANDS_PER_SECOND', envInt)
  shellFlag('uid', 'MM_SHELL_UID', envInt)
  shellFlag('gid', 'MM_SHELL_GID', envInt)
  if (Object.keys(shell).length > 0) out.shell = shell
  // Phase 3d-1: transfer limits (MiB and hours), merged over the defaults the same way.
  const transfer: Record<string, unknown> = {}
  const transferFlag = (key: string, name: string) => {
    const v = get(name)
    if (v !== undefined) transfer[key] = envInt(name, v)
  }
  transferFlag('maxUploadMb', 'MM_TRANSFER_MAX_UPLOAD')
  transferFlag('quotaMb', 'MM_TRANSFER_QUOTA')
  transferFlag('totalQuotaMb', 'MM_TRANSFER_TOTAL_QUOTA')
  transferFlag('ttlHours', 'MM_TRANSFER_TTL_HOURS')
  transferFlag('maxJobHours', 'MM_TRANSFER_MAX_JOB_HOURS')
  if (Object.keys(transfer).length > 0) out.transfer = transfer
  // Phase 3d-3a: backup limits, merged over the defaults the same way.
  const backup: Record<string, unknown> = {}
  const backupFlag = (key: string, name: string) => {
    const v = get(name)
    if (v !== undefined) backup[key] = envInt(name, v)
  }
  backupFlag('quotaMb', 'MM_BACKUP_QUOTA')
  backupFlag('totalQuotaMb', 'MM_BACKUP_TOTAL_QUOTA')
  backupFlag('maxUploadMb', 'MM_BACKUP_MAX_UPLOAD')
  backupFlag('ttlHours', 'MM_BACKUP_TTL_HOURS')
  backupFlag('maxJobHours', 'MM_BACKUP_MAX_JOB_HOURS')
  backupFlag('chunkMb', 'MM_BACKUP_CHUNK_MB')
  // Phase 3d-3b: destinations.
  backupFlag('destPartMb', 'MM_BACKUP_DEST_PART_MB')
  backupFlag('destTransfers', 'MM_BACKUP_DEST_TRANSFERS')
  backupFlag('drillMaxMb', 'MM_BACKUP_DRILL_MAX_MB')
  // Phase 3d-3c: the scheduler.
  backupFlag('scheduleConcurrency', 'MM_BACKUP_SCHEDULE_CONCURRENCY')
  const schedules = get('MM_BACKUP_SCHEDULES')
  if (schedules !== undefined) backup.schedules = envBool('MM_BACKUP_SCHEDULES', schedules)
  const roots = get('MM_BACKUP_FOLDER_ROOTS')
  if (roots !== undefined)
    backup.folderRoots = roots
      .split(delimiter)
      .map((s) => s.trim())
      .filter(Boolean)
  const nets = get('MM_BACKUP_PRIVATE_NETWORKS')
  if (nets !== undefined) backup.privateNetworks = envList(nets)
  const proxy = get('MM_BACKUP_PROXY')
  if (proxy !== undefined && proxy.trim()) backup.proxy = proxy.trim()
  const toolsPath = get('MM_MONGODB_TOOLS_PATH')
  if (toolsPath !== undefined) backup.toolsPath = toolsPath
  if (Object.keys(backup).length > 0) out.backup = backup
  // The updater (2026-11-03).
  const updates: Record<string, unknown> = {}
  const updatesOn = get('MM_UPDATES')
  if (updatesOn !== undefined) updates.enabled = envBool('MM_UPDATES', updatesOn)
  const updateProxy = get('MM_UPDATE_PROXY')
  if (updateProxy !== undefined && updateProxy.trim()) updates.proxy = updateProxy.trim()
  if (Object.keys(updates).length > 0) out.updates = updates
  // Phase 3e-1: the Watch feed.
  const watch: Record<string, unknown> = {}
  const watchOn = get('MM_WATCH')
  if (watchOn !== undefined) watch.enabled = envBool('MM_WATCH', watchOn)
  const watchMax = get('MM_WATCH_MAX_FEEDS')
  if (watchMax !== undefined) watch.maxFeeds = envInt('MM_WATCH_MAX_FEEDS', watchMax)
  if (Object.keys(watch).length > 0) out.watch = watch
  // Phase 3e-2: live syncs.
  const liveSync: Record<string, unknown> = {}
  const liveOn = get('MM_LIVE_SYNC')
  if (liveOn !== undefined) liveSync.enabled = envBool('MM_LIVE_SYNC', liveOn)
  const liveMax = get('MM_LIVE_SYNC_MAX')
  if (liveMax !== undefined) liveSync.maxSyncs = envInt('MM_LIVE_SYNC_MAX', liveMax)
  if (Object.keys(liveSync).length > 0) out.liveSync = liveSync
  // Phase 4a-1: the AI assistant.
  const ai: Record<string, unknown> = {}
  const aiOn = get('MM_AI')
  if (aiOn !== undefined) ai.enabled = envBool('MM_AI', aiOn)
  const aiNets = get('MM_AI_PRIVATE_NETWORKS')
  if (aiNets !== undefined) ai.privateNetworks = envList(aiNets)
  const aiFlags = [
    ['perMinute', 'MM_AI_PER_MINUTE'],
    ['agentPerMinute', 'MM_AI_AGENT_PER_MINUTE'],
    ['perDay', 'MM_AI_PER_DAY'],
    ['maxConcurrent', 'MM_AI_MAX_CONCURRENT'],
    ['chatDays', 'MM_AI_CHAT_DAYS'],
  ] as const
  for (const [key, name] of aiFlags) {
    const v = get(name)
    if (v !== undefined) ai[key] = envInt(name, v)
  }
  if (Object.keys(ai).length > 0) out.ai = ai
  // W3.3: alerts.
  const alerts: Record<string, unknown> = {}
  const alertsOn = get('MM_ALERTS')
  if (alertsOn !== undefined) alerts.enabled = envBool('MM_ALERTS', alertsOn)
  const alertNets = get('MM_ALERTS_PRIVATE_NETWORKS')
  if (alertNets !== undefined) alerts.privateNetworks = envList(alertNets)
  if (Object.keys(alerts).length > 0) out.alerts = alerts
  // W7: the identity providers' private networks.
  const oidcNets = get('MM_OIDC_PRIVATE_NETWORKS')
  if (oidcNets !== undefined) out.oidc = { privateNetworks: envList(oidcNets) }
  // W8: the operator's crypt_shared library, and the networks of key management services.
  const encryption: Record<string, unknown> = {}
  const cryptShared = get('MM_CRYPT_SHARED_LIB_PATH')
  if (cryptShared !== undefined) encryption.cryptSharedLibPath = cryptShared
  const kmsNets = get('MM_KMS_PRIVATE_NETWORKS')
  if (kmsNets !== undefined) encryption.privateNetworks = envList(kmsNets)
  // Security review C1: key management service hosts besides the providers' own.
  const kmsHosts = get('MM_KMS_ALLOWED_HOSTS')
  if (kmsHosts !== undefined) encryption.allowedHosts = envList(kmsHosts)
  if (Object.keys(encryption).length > 0) out.encryption = encryption
  return out as PartialConfig
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ')
}

const isSection = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Each layer overrides only the settings it names, in sections too (review of the CLI docs: one
 * shell limit in the environment replaced the file's whole shell section, turning a disabled shell
 * back on). A list is one value. Keys that would reach an object's prototype are never copied.
 */
function mergeLayers(...layers: object[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined || k === '__proto__' || k === 'constructor' || k === 'prototype') continue
      const below = out[k]
      out[k] = isSection(v) && isSection(below) ? mergeLayers(below, v) : v
    }
  }
  return out
}

export function readConfigFile(path: string, platform?: NodeJS.Platform): PartialConfig {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    // The parser's message quotes the text around the error, which may be part of a secret key.
    const position = /position (\d+)/.exec((e as Error).message)?.[1]
    throw new ConfigError(
      `Config file ${path} is not valid JSON${position ? ` (at character ${position})` : ''}`,
    )
  }
  return parseConfigFile(raw, path, platform)
}

/** A config file's contents, checked; an error names the file and the settings, never the values. */
/** `run` with the config's paths checked for `platform` (see pathPlatform). */
function forPlatform<T>(platform: NodeJS.Platform | undefined, run: () => T): T {
  const was = pathPlatform
  pathPlatform = platform ?? process.platform
  try {
    return run()
  } finally {
    pathPlatform = was
  }
}

export function parseConfigFile(raw: unknown, path: string, platform?: NodeJS.Platform): PartialConfig {
  const result = forPlatform(platform, () => PartialConfigSchema.safeParse(raw))
  if (!result.success) throw new ConfigError(`Config file ${path} is invalid: ${formatIssues(result.error)}`)
  return result.data
}

export function resolveConfig(input: {
  cli?: PartialConfig
  env?: Record<string, string | undefined>
  file?: PartialConfig
  /** The platform its paths are for (default this one's): a service install's target. */
  platform?: NodeJS.Platform
}): Config {
  const merged = mergeLayers(
    defaultConfig(),
    input.file ?? {},
    configFromEnv(input.env ?? {}),
    input.cli ?? {},
  )
  const result = forPlatform(input.platform, () => ConfigSchema.safeParse(merged))
  if (!result.success) throw new ConfigError(`Invalid configuration: ${formatIssues(result.error)}`)
  return result.data
}

export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
}

/**
 * Security review 2026-10-13 (low): what a team-mode start should say about its transport — sign-ins
 * crossing a network unencrypted, and session cookies that cannot be marked Secure behind an HTTPS
 * proxy the server does not trust (it cannot tell the request came over HTTPS).
 */
export function startupWarnings(config: Config): string[] {
  const warnings: string[] = []
  const { quotaMb, totalQuotaMb } = config.transfer
  if (totalQuotaMb !== undefined && totalQuotaMb < quotaMb)
    warnings.push(
      `MM_TRANSFER_TOTAL_QUOTA (${totalQuotaMb} MiB) is below MM_TRANSFER_QUOTA (${quotaMb} MiB): one user ` +
        'can fill the transfer storage of everyone.',
    )
  // Security audit 2026-10-16: the Host check takes only addresses and localhost here (http/security).
  if (!isLoopbackHost(config.host) && config.allowedHosts.length === 0)
    warnings.push(
      `Listening on ${config.host} without --allowed-hosts: only addresses and localhost are accepted as ` +
        'the host name (a defence against DNS rebinding). Name the host names people open it by with ' +
        '--allowed-hosts (MM_ALLOWED_HOSTS).',
    )
  if (!config.auth || config.trustedProxies.length > 0) return warnings
  if (!isLoopbackHost(config.host))
    warnings.push(
      `Team mode listens on ${config.host} over plain HTTP: passwords and session cookies cross the network ` +
        'unencrypted. Serve it through an HTTPS reverse proxy and name the proxy with --trusted-proxies.',
    )
  const publicHost = config.allowedHosts.find((h) => !isLoopbackHost(h.replace(/^\[|\]$/g, '')))
  if (publicHost && isLoopbackHost(config.host))
    warnings.push(
      `--allowed-hosts names ${publicHost}, but no proxy is trusted: behind an HTTPS proxy every request looks ` +
        'like plain HTTP, so session cookies are not marked Secure. Name the proxy with --trusted-proxies.',
    )
  return warnings
}

/** Spec §5 S1: never expose an unauthenticated instance beyond loopback unless explicitly overridden. */
export function assertSafeBind(config: Config): void {
  if (config.auth || config.unsafeNoAuth) return
  if (!isLoopbackHost(config.host)) {
    throw new ConfigError(
      `Refusing to listen on ${config.host} without authentication. ` +
        'Use --auth (team mode), bind to 127.0.0.1, or pass --unsafe-no-auth if you understand the risk.',
    )
  }
  // A loopback bind can still be published by a reverse proxy; that also needs authentication.
  const publicHost = config.allowedHosts.find((h) => !isLoopbackHost(h.replace(/^\[|\]$/g, '')))
  if (config.trustedProxies.length > 0 || publicHost) {
    throw new ConfigError(
      `Refusing to run without authentication behind a reverse proxy${publicHost ? ` for ${publicHost}` : ''}. ` +
        'Use --auth (team mode), or pass --unsafe-no-auth if you understand the risk.',
    )
  }
}
