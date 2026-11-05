// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { z } from 'zod'
import { KeyPath } from './transfer'
import type { CopyView } from './destinations'
import { PersonalRuleSchema } from '../masking/rules'
import type { RowError } from './transfer'

/** Phase 3d-3a spec §4: what a backup file may be. */
export const BACKUP_FORMATS = ['archive', 'gzip', 'mmbak'] as const
export type BackupFormat = (typeof BACKUP_FORMATS)[number]
export const BACKUP_ENGINES = ['builtin', 'tools'] as const
export type BackupEngine = (typeof BACKUP_ENGINES)[number]
export const RESTORE_MODES = ['insert', 'upsert', 'replace'] as const
export type RestoreMode = (typeof RESTORE_MODES)[number]
export const MMBAK_CHUNK_MB = [16, 32, 64, 128] as const
export const MIN_BACKUP_PASSWORD = 12
export const MAX_BACKUP_NAMESPACES = 10_000
/** Never backed up by the built-in engine, never a restore target (spec §2, §5.2). */
export const BACKUP_SYSTEM_DATABASES: readonly string[] = ['admin', 'local', 'config']

/** MongoDB's database name rules, and none of the system databases. */
export const BackupDbName = z
  .string()
  .min(1)
  .max(63)
  // eslint-disable-next-line no-control-regex -- NUL is one of the characters refused here
  .regex(/^[^/\\. "$*<>:|?\u0000]+$/, 'Invalid database name')
  .refine((s) => !BACKUP_SYSTEM_DATABASES.includes(s), 'System databases are not backed up or restored')
/** A collection a backup may name or a restore may write: no NUL, no `$`, not a system collection. */
export const BackupCollName = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (s) => !s.includes('\u0000') && !s.includes('$') && !s.startsWith('system.'),
    'Invalid collection name',
  )

export const BackupScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('collection'), db: BackupDbName, coll: BackupCollName }),
  z.strictObject({
    kind: z.literal('database'),
    db: BackupDbName,
    /** Chosen collections and views; a list naming views narrows the views to those (3d-2 rule). */
    collections: z.array(BackupCollName).min(1).max(MAX_BACKUP_NAMESPACES).optional(),
    views: z.boolean().default(true),
  }),
  z.strictObject({
    kind: z.literal('server'),
    databases: z.array(BackupDbName).min(1).max(1000).optional(),
  }),
])
export type BackupScope = z.infer<typeof BackupScopeSchema>

const PlanHash = z.string().regex(/^[0-9a-f]{64}$/)
export const BackupPasswordSchema = z.string().min(MIN_BACKUP_PASSWORD).max(1024)
/** Opening a file made elsewhere: any non-empty password. */
export const ArchivePasswordSchema = z.string().min(1).max(1024)
/** Phase 3d-3c: a recovery kit's text, as pasted or read from its file (spec §1.1, D7: bounded). */
export const KitTextSchema = z.string().min(1).max(8192)
const ChunkMb = z.union([z.literal(16), z.literal(32), z.literal(64), z.literal(128)])

export const DumpRequestSchema = z.strictObject({
  scope: BackupScopeSchema,
  engine: z.enum(BACKUP_ENGINES).default('builtin'),
  indexes: z.boolean().default(true),
  options: z.boolean().default(true),
  anonymous: z.boolean().default(false),
  format: z.enum(BACKUP_FORMATS).default('mmbak'),
  /** Left out: the server's MM_BACKUP_CHUNK_MB (final review minor 2). */
  chunkMb: ChunkMb.optional(),
  /** Phase 3d-3b: destinations the backup is sent to once kept. */
  destinations: z.array(z.string().uuid()).max(8).default([]),
  /** Phase 3d-3b: delete the kept copy once every destination verified its upload. */
  deleteLocal: z.boolean().default(false),
})
export type DumpRequest = z.infer<typeof DumpRequestSchema>
export const DumpStartSchema = DumpRequestSchema.extend({
  planHash: PlanHash,
  password: BackupPasswordSchema.optional(),
}).refine((r) => (r.format === 'mmbak') === (r.password !== undefined), {
  message: 'An encrypted backup needs a password, and only an encrypted backup takes one',
  path: ['password'],
})
export type DumpStart = z.infer<typeof DumpStartSchema>

export const RestoreSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('upload'), uploadId: z.string().uuid() }),
  z.strictObject({ kind: z.literal('backup'), backupId: z.string().uuid() }),
])
export type RestoreSource = z.infer<typeof RestoreSourceSchema>

/** `from` names a namespace of the archive (matched, never used as a name); `to` is checked. */
export const RestoreMappingSchema = z.strictObject({
  from: z.strictObject({ db: z.string().min(1).max(128), coll: z.string().min(1).max(512) }),
  to: z.strictObject({ db: BackupDbName, coll: BackupCollName }),
})
export type RestoreMapping = z.infer<typeof RestoreMappingSchema>

export const RestoreRequestSchema = z.strictObject({
  source: RestoreSourceSchema,
  password: ArchivePasswordSchema.optional(),
  kit: KitTextSchema.optional(),
  mapping: z.array(RestoreMappingSchema).min(1).max(MAX_BACKUP_NAMESPACES),
  mode: z.enum(RESTORE_MODES).default('insert'),
  keys: z.array(KeyPath).min(1).max(32).default(['_id']),
  indexes: z.boolean().default(true),
  options: z.boolean().default(true),
  engine: z.enum(BACKUP_ENGINES).default('builtin'),
  onError: z.enum(['stop', 'continue']).default('continue'),
  confirmTtl: z.boolean().default(false),
  confirmPersonal: z.boolean().default(false),
  confirmMasked: z.boolean().default(false),
  addRulesToTarget: z.boolean().default(false),
  /** "db.coll" of each non-empty target a replace overwrites, typed by the user (U7). */
  confirmNames: z.array(z.string().max(320)).max(MAX_BACKUP_NAMESPACES).default([]),
  dryRun: z.boolean().default(false),
})
export type RestoreRequest = z.infer<typeof RestoreRequestSchema>
export const RestoreStartSchema = RestoreRequestSchema.extend({ planHash: PlanHash })
export type RestoreStart = z.infer<typeof RestoreStartSchema>

export const InspectRequestSchema = z.strictObject({
  source: RestoreSourceSchema,
  password: ArchivePasswordSchema.optional(),
  kit: KitTextSchema.optional(),
})
export type InspectRequest = z.infer<typeof InspectRequestSchema>

export const BackupUploadCreateSchema = z.strictObject({
  name: z.string().min(1).max(255),
  size: z.number().int().min(1),
})

/** What the built-in engine adds to the archive header (spec §4.1). */
/** Final review I9: the deployment a backup was taken from, as 3d-2 identifies one. */
export const BackupDeploymentSchema = z.strictObject({
  kind: z.enum(['standalone', 'replicaSet', 'mongos']),
  processId: z.string().max(200).optional(),
  setName: z.string().max(200).optional(),
  hosts: z.array(z.string().max(300)).max(100).optional(),
  clusterId: z.string().max(200).optional(),
  replicaSetId: z.string().max(200).optional(),
})
export const MongoManagerHeaderSchema = z.strictObject({
  tool: z.string().max(100),
  scope: BackupScopeSchema.nullable().default(null),
  masked: z.boolean(),
  anonymous: z.boolean(),
  maskedPaths: z.array(z.string().max(2048)).max(100_000),
  rules: z.array(PersonalRuleSchema).max(10_000),
  startedAt: z.number().int().min(0),
  deployment: BackupDeploymentSchema.optional(),
  /** CI 2026-10-18: its time series are kept under their own names (a backup of MongoDB 8.3 and later). */
  series: z.literal('own').optional(),
})
export type MongoManagerHeader = z.infer<typeof MongoManagerHeaderSchema>
/**
 * Third review of the CI fixes (important 1): how a header is read — keys a later version adds are
 * left out, never the whole header with its masked flag, rules and deployment (a restore would then
 * write *** over real values without asking).
 */
export const MongoManagerHeaderReadSchema = z.object(MongoManagerHeaderSchema.shape)

export type NamespaceType = 'collection' | 'view' | 'timeseries'
export interface ArchiveNamespace {
  db: string
  coll: string
  type: NamespaceType
  indexes: number
  ttl: string[]
  capped: boolean
  viewOn?: string
}
export interface ArchiveSummary {
  container: 'archive' | 'gzip' | 'mmbak' | 'directory'
  serverVersion: string | null
  toolVersion: string | null
  mongoManager: MongoManagerHeader | null
  namespaces: ArchiveNamespace[]
}
/** Phase 3d-3c spec §5: how an encrypted backup was opened, for "Opened with your backup key K-…". */
export type OpenedWith =
  | { kind: 'password' }
  | { kind: 'key'; fingerprint: string; name: string }
  | { kind: 'kit'; fingerprint: string }
/** U4: an inspection answers before the upload ends, or says what it waits for. */
export type InspectResponse =
  | { state: 'ready'; summary: ArchiveSummary; openedWith?: OpenedWith }
  | { state: 'waiting'; received: number; size: number }
  | { state: 'password' }
  /** Phase 3d-3c: a backup-key file none of the caller's keys opens: the kit (or the password, if it has one). */
  | { state: 'key'; fingerprint: string; password: boolean }

export type ToolsReason = 'missing' | 'broken' | 'old' | 'not_admin' | 'restricted' | 'unsupported'
export interface ToolsAvailability {
  available: boolean
  reason?: ToolsReason
  /** Only for admins of the connection. */
  version?: string
}

export const PREFLIGHT_FIXES = ['encrypt', 'anonymous', 'deleteOld', 'exclude'] as const
export type PreflightFix = (typeof PREFLIGHT_FIXES)[number]
export interface PreflightCheck {
  key:
    | 'permissions'
    | 'quota'
    | 'size'
    | 'ttl'
    | 'capped'
    | 'personal'
    | 'timeseries'
    | 'timeseries_version'
    | 'encrypted'
    | 'tools'
    | 'masked'
    | 'conflict'
    | 'rules'
    | 'source'
    | 'destination'
  level: 'ok' | 'warn' | 'block'
  params?: Record<string, string | number>
  fix?: { kind: PreflightFix; names?: string[] }
  /** Other fixes for the same check, offered after `fix` (final review minor 11). */
  more?: Array<{ kind: PreflightFix; names?: string[] }>
}

export interface DumpNamespace {
  db: string
  coll: string
  type: NamespaceType
  documents: number | null
  bytes: number | null
  ttl: string[]
  /** Not in the backup, and why. */
  skipped?: string
  /** In the backup, with something of it left out, and why (final review minor 16). */
  note?: string
  /** "db.coll.field" paths held in clear (an unmasked backup) — the personal-data warning. */
  personal: string[]
}
export interface DumpPlan {
  planHash: string
  namespaces: DumpNamespace[]
  /** Null where rules hide personal data from the caller in what the backup holds. */
  estimate: { bytes: number | null; fileBytes: number | null; seconds: number | null }
  tools: ToolsAvailability
  masked: boolean
  recommended: { format: BackupFormat; engine: BackupEngine; reason: 'personal' | 'size' | null }
  checks: PreflightCheck[]
  refusals: string[]
  /**
   * Planned as a schedule (`asScheduled`): whether its save refuses a plain format for personal data —
   * judged, as the save judges it, by the rules' names (one naming a collection gone counts too).
   */
  scheduledPersonal?: boolean
}

export interface RestoreNamespacePlan {
  from: { db: string; coll: string }
  to: { db: string; coll: string }
  type: NamespaceType
  exists: boolean
  /** The target's document count when it exists. */
  documents: number | null
  action: 'create' | 'insert' | 'upsert' | 'replace'
  ttl: string[]
  /** Backup review M8: a replaced target keeps its own indexes or options (the backup's are not restored). */
  keepsOwn?: { indexes: boolean; options: boolean }
  skipped?: string
  /** A replace of a non-empty target: its "db.coll" must be in confirmNames. */
  confirmName: boolean
  /** Fourth review of B2 (M1): a capped target written into keeps only what its cap allows. */
  capped?: boolean
}
export interface RestorePlan {
  planHash: string
  summary: ArchiveSummary
  namespaces: RestoreNamespacePlan[]
  missingRules: string[]
  mayAddRules: boolean
  tools: ToolsAvailability
  checks: PreflightCheck[]
  refusals: string[]
}

export interface BackupView {
  id: string
  name: string
  jobId: string | null
  connectionId: string
  scope: BackupScope
  engine: BackupEngine
  format: BackupFormat
  masked: boolean
  anonymous: boolean
  size: number
  sha256: string
  namespaces: number
  startedAt: number
  finishedAt: number
  expiresAt: number
  /** Phase 3d-3b: this backup's copies on destinations. */
  copies: CopyView[]
  /** Phase 3d-3c: the schedule that made it, while that schedule exists. */
  schedule?: { id: string; name: string } | null
}
export interface BackupUploadView {
  uploadId: string
  name: string
  size: number
  received: number
  complete: boolean
}

export interface DumpReport {
  kind: 'dump'
  scope: BackupScope
  engine: BackupEngine
  format: BackupFormat
  namespaces: Array<DumpNamespace & { written: number }>
  backupId: string | null
  size: number
  sha256: string | null
  masked: boolean
  anonymous: boolean
  startedAt: number
  finishedAt: number | null
  /** Bytes per second of the read side (U2's duration estimate). */
  throughput: number | null
  versions: { source: number }
  restricted: { source: boolean }
  /** Scrubbed tool output (tools engine, unrestricted callers only). */
  toolLog?: string[]
  /** Phase 3d-3b: the send job queued when the dump finished (null when none, or it could not start). */
  sendJobId?: string | null
  sendError?: string | null
}
export interface RestoreNamespaceReport {
  from: string
  to: string
  type: NamespaceType
  read: number
  inserted: number
  matched: number
  modified: number
  upserted: number
  skipped: number
  /** Backup review M9: of the skipped, documents found stored as the backup has them (a restore run again). */
  alreadyThere?: number
  /**
   * Backup review M10: documents a TTL index on the target deletes as soon as they are written (their
   * date is already past its expiry) — counted in a dry run too.
   */
  expiring?: number
  failed: number
  wouldMatch?: number
  errors: RowError[]
  moreErrors: boolean
  indexes: { built: string[]; skipped: Array<{ name: string; reason: string }> }
  crc: 'ok' | 'mismatch' | 'absent'
  failure?: string
}
/**
 * W4.4: a restore drill — a kept backup restored into a scratch database (`mm_drill_<hex>`) of its
 * connection, each namespace's count and contents compared with the backup, the database dropped.
 */
export interface DrillNamespaceReport {
  ns: string
  type: NamespaceType
  /** Documents (a time series: buckets) the backup holds. */
  archived: number
  /** Documents found in the scratch database after the restore. */
  restored: number
  crc: 'ok' | 'mismatch' | 'absent'
  /** Whether the documents read back are, byte for byte, those the restore wrote; views are skipped. */
  contents: 'match' | 'mismatch' | 'skipped'
  reason?: string
}
export interface DrillReport {
  kind: 'drill'
  backupId: string
  backupName: string
  ok: boolean
  namespaces: DrillNamespaceReport[]
  /** Why the drill could not run to its end (the restore failed, the backup could not be read). */
  failure?: string
  /**
   * W4 review I2: why it failed, as a code (schedules.drill.reason.<code>): drill_mismatch,
   * drill_failed, drill_cleanup (the scratch database is still there), drill_cleanup_rights,
   * drill_space.
   */
  code?:
    | 'drill_mismatch'
    | 'drill_failed'
    | 'drill_cleanup'
    | 'drill_cleanup_rights'
    | 'drill_space'
    | 'drill_space_unknown'
  /** W4 review I2: the scratch database it restored into, and whether dropping it failed. */
  scratch?: string
  cleanup?: 'failed'
  startedAt: number
  finishedAt: number | null
  schedule?: { id: string; name: string }
}

/** W4 re-review (minor): a connection's leftover drill scratch databases (names and sizes only). */
export interface DrillLeftovers {
  databases: Array<{ name: string; sizeOnDisk: number }>
  /** A drill runs on the connection now (nothing is dropped meanwhile). */
  running: boolean
}

export interface RestoreReport {
  kind: 'restore'
  dryRun: boolean
  mode: RestoreMode
  engine: BackupEngine
  source: { kind: 'upload' | 'backup'; name: string }
  namespaces: RestoreNamespaceReport[]
  views: Array<{ name: string; created: boolean; reason?: string }>
  rejectedFile: boolean
  masked: boolean
  rulesAdded: number
  versions: { target: number }
  restricted: { target: boolean }
  toolLog?: string[]
}
