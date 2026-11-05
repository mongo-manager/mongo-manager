// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { AuditAction } from '@mongo-manager/shared'
import type { UpdateService } from '../updates/service'
import type { AgentVia } from '../ai/agent/calls'
import type { AccessSignal } from '../auth/policy'
import type { LaunchGate, LocalBrowser } from '../auth/launch'
import type { PluginService } from '../plugins/service'
import type { MongoClient } from 'mongodb'
import type { Scheduler } from '../backup/schedules/scheduler'
import type { RunRepo, ScheduleRepo } from '../backup/schedules/repo'
import type { RefusalAudit } from '../masking/audit'
import type { MaskingMode } from '../masking/modes'
import type { PreviewCache } from '../aggregation/cache'
import type { RunSlots } from '../aggregation/run'
import type { SavedPipelineRepo } from '../aggregation/saved'
import type { Permission, Role } from '@mongo-manager/shared'
import type { Config } from '../config'
import type { Store } from '../store/db'
import type { SecretBox } from '../crypto/secret-box'
import type { UserRepo } from '../auth/users'
import type { SessionRepo } from '../auth/sessions'
import type { AuditRepo } from '../audit/audit'
import type { KnownSignIns, LoginThrottle } from '../auth/throttle'
import type { SignInBans, SignInBudget } from '../auth/bans'
import type { AccessList } from '../auth/accessList'
import type { PasswordWork } from '../auth/passwordWork'
import type { SetupState } from '../auth/setup'
import type { ChallengeStore, MfaTickets, RecoveryCodeRepo } from '../auth/mfa'
import type { PasskeyRepo } from '../auth/passkeys'
import type { ConnectionRecord, ConnectionRepo } from '../connections/repo'
import type { GrantRepo } from '../connections/grants'
import type { ConnectionManager } from '../connections/manager'
import type { QueryHistoryRepo } from '../queries/history'
import type { FavouriteRepo } from '../queries/favourites'
import type { SnippetRepo } from '../queries/snippets'
import type { PersonalFieldsRepo } from '../masking/repo'
import type { ProfilerReverts } from '../monitor/profiler'
import type { HistoryRecorder, HistoryRepo } from '../monitor/history'
import type { JobRunner } from '../jobs/runner'
import type { MonitorHub } from '../monitor/hub'
import type { JobKind, JobKindName } from '../jobs/types'
import type { LibraryLimits } from '../routes/data/library'
import type { TransferFiles } from '../transfer/files'
import type { BackupStore } from '../backup/store'
import type { BackupLimits } from '../backup/limits'
import type { ToolSlots } from '../backup/tools'
import type { CopyRepo, DestinationRepo } from '../backup/destinations/repo'
import type { DestinationSlots } from '../backup/destinations/slots'
import type { BackupReadGate } from '../backup/read-gate'
import type { DeviceFlows } from '../backup/destinations/device-flows'
import type { GoogleHosts, GoogleTokens } from '../backup/destinations/google-auth'
import type { BackupKeyRepo } from '../backup/keys/repo'
import type { Egress } from '../net/egress'
import type { TransferReports } from '../transfer/reports'
import type { TransferLimits } from '../transfer/limits'
import type { PreviewGate, UploadGate } from '../transfer/upload-gate'
import type { TransferPresets } from '../transfer/presets'
import type { ShellManager } from '../shell/manager'
import type { ShellHistoryRepo } from '../shell/history'
import type { WatchManager } from '../changestreams/manager'
import type { LiveSyncRunner } from '../livesync/runner'
import type { AiServices } from '../ai/run'
import type { PreferencesRepo } from '../store/preferences'
import type { StepUps } from '../auth/stepup'
import type { AppEvents } from '../events/app-events'
import type { ReportRunner } from '../alerts/reports'
import type { AlertService } from '../alerts/service'
import type { HealthCache } from '../connections/health'
import type { OptionalModules } from '../optional/modules'
import type { ConnectionPolicy } from '../connections/policy'
import type { OidcBroker } from '../oidc/broker'
import type { SocketEgress } from '../net/egress'
import type { EncryptionToolsFactory } from '../encryption/tools'

/** Phase 3d-3b (plan ruling 7): a running send or fetch, and what its job shows meanwhile. */
export interface TransferEntry {
  userId: string | null
  destinationIds: string[]
  kind?: 'send' | 'fetch'
  /** A send's backup: one transfer per backup and destination at a time (final review B8). */
  backupId?: string
  /** A fetch's upload: the store's sweeper leaves it while the transfer runs (B9). */
  uploadId?: string
  /** A send of an unencrypted backup: turning encrypted-only on stops it there (B21). */
  plain?: boolean
  /** Destinations it waits a transfer slot for (spec §4.2 "Waiting for the destination"). */
  waiting?: Set<string>
  /** Stops the transfer to one destination; a send goes on with its others. */
  stop?: (destinationId: string, why: string, reason: string) => void
}

/** Phase 3d-3b final review B12, B29: what a send or fetch job says besides its state. */
export interface JobNotes {
  localKept?: boolean
  verified?: boolean
  /** B33: a failed send's destinations, by name, with their reason codes. */
  /** Short names review 12 (M-2): the destination's id too, for a schedule's run to find it by. */
  failures?: Array<{ destination: string; destinationId?: string; reason: string | null }>
  /** Phase 3d-3c: the schedule a scheduled dump or send runs for. */
  schedule?: { id: string; name: string }
}

export type Principal =
  | {
      kind: 'local'
      userId: 'local'
      username: 'owner'
      role: 'admin'
      csrfToken: string
      /**
       * Work running on its own for the local user (a scheduled backup, retention, a live sync): the
       * local hide is how they view data, never what such work writes (review 2026-10-13, C1).
       */
      unattended?: true
      /** Review of the audit fixes (important 1): the browser this request came from (its cookie). */
      browser?: LocalBrowser
    }
  | {
      kind: 'user'
      userId: string
      username: string
      role: Role
      csrfToken: string
      sessionId: string
      sessionIdHash: string
      /**
       * Work running on its own for them (a scheduled backup, a live sync): their "hide from me" is
       * how they view data, never what such work writes (user request 2026-10-24).
       */
      unattended?: true
    }

export interface ServerContext {
  config: Config
  store: Store
  secretBox: SecretBox
  users: UserRepo
  sessions: SessionRepo
  /** 4c review I1: access changed (2FA required, a role): open sockets are checked again. */
  access: AccessSignal
  audit: AuditRepo
  localCsrfToken: string
  /** Security audit 2026-10-16: local mode's launch links and cookie; null in team mode. */
  launch: LaunchGate | null
  now: () => number
  throttle: LoginThrottle
  /** Security review 2026-10-13 (L1): where each account signed in from lately. */
  knownSignIns: KnownSignIns
  /** Sign-in bans (2026-10-30): addresses refused at the sign-in, and the checks' shared workers. */
  bans: SignInBans
  /** Panel access (2026-10-30): the addresses the team-mode panel answers. */
  accessList: AccessList
  signInBudget: SignInBudget
  passwordWork: PasswordWork
  /** Security review 2026-10-13 (L2): sessions that proved a second factor lately. */
  stepUps: StepUps
  setup: SetupState
  tickets: MfaTickets
  challenges: ChallengeStore
  recoveryCodes: RecoveryCodeRepo
  passkeys: PasskeyRepo
  connections: ConnectionRepo
  grants: GrantRepo
  manager: ConnectionManager
  /** Phase 2c: finds and aggregation runs, per user (it replaced recent queries). */
  history: QueryHistoryRepo
  /** Phase 2c: favourite finds. */
  favourites: FavouriteRepo
  snippets: SnippetRepo
  /** Phase 3b: the personal-field rules of each connection. */
  personalFields: PersonalFieldsRepo
  /** Phase 3b: the profiler reverts waiting to run. */
  profilerReverts: ProfilerReverts
  /** Phase 3b §6: metric history, and the recorder that samples enabled connections. */
  metricHistory: HistoryRepo
  historyRecorder: HistoryRecorder
  jobs: JobRunner
  /** Phase 1i: live serverStatus samplers, one per watched connection. */
  monitor: MonitorHub
  /** The job kinds, by name: the job routes start them and recovery settles their leftovers. */
  jobKinds: Record<JobKindName, JobKind<unknown>>
  /** Phase 3d-1: file import and export (files, reports, limits). */
  transfer: {
    files: TransferFiles
    reports: TransferReports
    presets: TransferPresets
    limits: TransferLimits
    uploads: UploadGate
    previews: PreviewGate
  }
  /** Phase 3d-3a: kept backups, restore uploads, password attempts and tool process slots. */
  backup: {
    store: BackupStore
    limits: BackupLimits
    attempts: LoginThrottle
    /** Spec §7.6: at most two tool processes per server. */
    tools: ToolSlots
    /** Where tool folders are made (the server's own directory; swept at start). */
    toolsTmp: string
    /** Parts of resumable uploads (plan ruling 2): many per minute, two at once. */
    uploads: UploadGate
    /** Security review 2026-10-13 (M4): reads of a backup to inspect or plan it, a few at once. */
    reads: BackupReadGate
    /** Tests replace how tool processes are spawned (to see their arguments); production leaves it. */
    spawnImpl?: typeof import('node:child_process').spawn
    /** Phase 3d-3b: destinations, their copies, the one outbound client and the transfer slots. */
    destinations: DestinationRepo
    copies: CopyRepo
    egress: Egress
    /** Google's hosts; tests point them at a fake Google (never through the environment). */
    googleHosts: GoogleHosts
    deviceFlows: DeviceFlows
    slots: DestinationSlots
    /** Running send and fetch jobs, so a deleted destination or a revoked grant cancels them (plan ruling 7). */
    transfers: Map<string, TransferEntry>
    /** Notes of finished and running send and fetch jobs, by job id (bounded, in memory). */
    jobNotes: Map<string, JobNotes>
    /** Spec §4.5: destination tests, 10 a minute per administrator. */
    destTests: UploadGate
    /** Final review B23: destination listings, per user (each can read many manifests). */
    destLists: UploadGate
    tokens: Map<string, GoogleTokens>
    /** Phase 3d-3c: users' backup keys (sealed) and their creation/import limit (10 an hour). */
    keys: BackupKeyRepo
    keyGate: UploadGate
    /** Phase 3d-3c: schedules and their runs. */
    schedules: ScheduleRepo
    runs: RunRepo
    /** Spec §3.4: schedule previews, 60 a minute per user. */
    schedulePreviews: UploadGate
    /** Phase 3d-3c spec §3.2: the scheduling loop. */
    scheduler: Scheduler
  }
  ops: { kill(client: MongoClient, comment: string): Promise<number> }
  /** Phase 2a: pipelines saved per collection. */
  savedPipelines: SavedPipelineRepo
  /** Phase 2a: the preview cache, the streamed-run slots and the run output cap. */
  aggregation: { cache: PreviewCache; slots: RunSlots; previewSlots: RunSlots; maxRunBytes: number }
  /** Security review 2026-10-13 (M3): finds in flight per user, and a page's byte cap. */
  documents: { slots: RunSlots; maxPageBytes: number }
  /** Security audit 2026-10-16 (minor): connection tests in flight per user (the manager caps the server). */
  connectionTests: RunSlots
  /** Phase 2c: the bounds of one library search (tests lower them). */
  library: { limits: LibraryLimits }
  /** Phase 3a-1: the advanced shell. */
  shell: ShellManager
  /** Phase 3a-1: per-user shell command history. */
  shellHistory: ShellHistoryRepo
  /** Phase 3c §4.1: the key of document pins (an HMAC, derived from the master key). */
  docPinKey: Buffer
  /** Phase 3c §4.5: the key of validation rules versions; never a document pin's (final review C3). */
  rulesVersionKey: Buffer
  /** Phase 3c §8: audits what the query gate refused, bounded per user. */
  maskingAudit: RefusalAudit
  /** Phase 3e-1: change-stream feeds. */
  watch: WatchManager
  /** Phase 3e-2: live syncs. */
  liveSync: LiveSyncRunner
  /** Phase 4a-1: the AI assistant. */
  ai: AiServices
  /** User review 2026-10-09: what each user arranges for themselves (the Overview dashboard). */
  preferences: PreferencesRepo
  /** Phase 4b §2: the plugins found, installed and approved. */
  plugins: PluginService
  /** User request 2026-10-11: reaches GitHub for a plugin's release (public addresses only). */
  pluginsEgress: Egress
  /** The updater (2026-11-03): the check, its daily timer and the install. */
  updates: UpdateService
  /** Phase 4b §3: signs plugin frame tickets (derived from the master key; never a session's). */
  pluginFrameKey: Buffer
  /** W3.3: alert rules, their evaluation, channels and history. */
  alerts: AlertService
  /** Design 2026-10-25 (C7): scheduled reports. */
  reports: ReportRunner
  /** W4 review I4: the app-event hook of this server (drills, two-way conflicts, Watch matches). */
  events: AppEvents
  /** W3.4: each connection's live health, cached. */
  health: HealthCache
  /** W8: the optional native packages found at start (npm package only). */
  optionalModules: OptionalModules
  /** W7, W8: what this server lets connections sign in with and load. */
  policy(): ConnectionPolicy
  /** W7: people's MONGODB-OIDC sign-ins. */
  oidc: OidcBroker
  /** W8: sockets to key management services, through the egress guard. */
  kmsEgress: SocketEgress
  /** W8: data keys and encrypted collections (the driver's ClientEncryption; tests give a fake). */
  encryptionTools: EncryptionToolsFactory
}

export interface AuditInfo {
  /** When set (even to null), the audit row records this account instead of the request principal. */
  userId?: string | null
  username?: string
  details?: Record<string, unknown>
  /** A successful answer that repeats (a poll) and is not worth a row; failures are still recorded. */
  quiet?: boolean
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: ServerContext
    /** "METHOD /url" of every registered route (S12 matrix). */
    routeInventory: ReadonlySet<string>
    /** Phase 3c §6: the masking declaration of every connection route. */
    routeMasking: Map<string, MaskingMode | undefined>
  }
  interface FastifyRequest {
    principal: Principal | null
    auditInfo: AuditInfo | null
    /** B6: the agent's turn this request was made for (from its call's token only). */
    agentVia: AgentVia | null
    connection: ConnectionRecord | null
    connectionRole: Role | null
    /** W8: the permission the route asked of the connection (a write is never decrypted for a masked user). */
    connectionPermission: Permission | null
    /** Connection holds taken for this request (clientFor), released when it has answered. */
    releases: Array<() => void> | null
  }
  interface FastifyContextConfig {
    /** Audit action name; set on every mutating route (spec §4.1). One the web app has words for. */
    audit?: AuditAction
    /** false = skip the CSRF token check (Origin is still checked). Only for login/setup. */
    csrf?: false
    /** Phase 3c §6: how a connection route treats personal data (required on every one). */
    masking?: MaskingMode
    /**
     * Security audit 2026-10-16: the route streams its body to disk (an upload), so its body is
     * bounded by idleness, not by a total deadline (http/body-guard.ts).
     */
    streamBody?: true
    /**
     * Sign-in bans (2026-10-30): a sign-in step — rate limited per address with the others, and its
     * cheap refusals (rate limited, held back, banned) not written to the audit log one by one.
     */
    signIn?: true
  }
}
