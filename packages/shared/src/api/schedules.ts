// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { z } from 'zod'
import { UiLanguageSchema } from '../languages'
import { BACKUP_ENGINES, BACKUP_FORMATS, BackupScopeSchema, type BackupFormat } from './backup'
import { MAX_SEND_DESTINATIONS } from './destinations'
import { isTimeZone } from '../schedule/zone'

const unique = (list: readonly unknown[]) => new Set(list).size === list.length

/** Phase 3d-3c spec §1.3: a time of day as HH:MM (24 h). */
export const TimeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time as HH:MM')

/** Spec §1.3: presets and a 5-field cron expression. Days are ISO: 1 Monday … 7 Sunday. */
export const CadenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('hourly'),
    every: z.number().int().min(1).max(24),
    minute: z.number().int().min(0).max(59),
  }),
  z.strictObject({
    kind: z.literal('daily'),
    times: z.array(TimeOfDaySchema).min(1).max(4).refine(unique, 'A time is listed twice'),
  }),
  z.strictObject({
    kind: z.literal('weekly'),
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7).refine(unique, 'A day is listed twice'),
    time: TimeOfDaySchema,
  }),
  z.strictObject({
    kind: z.literal('monthly'),
    day: z.union([z.number().int().min(1).max(28), z.literal('last')]),
    time: TimeOfDaySchema,
  }),
  z.strictObject({ kind: z.literal('cron'), expression: z.string().trim().min(1).max(200) }),
])
export type Cadence = z.infer<typeof CadenceSchema>
export type CronFieldName = 'minute' | 'hour' | 'dayOfMonth' | 'month' | 'dayOfWeek'
/** Why a cadence is refused (spec §1.3): an invalid cron, one that never runs, runs less than an hour apart. */
/** Final review minor 2: the kinds of cron refusal (schedules.cron.<code> in the web). */
export type CronProblemCode =
  | 'not_number'
  | 'not_name_or_number'
  | 'out_of_range'
  | 'too_many'
  | 'not_item'
  | 'bad_step'
  | 'backwards'
  | 'too_long'
  | 'shortcut'
  | 'fields'
export type CadenceProblem =
  | {
      reason: 'cron'
      field: CronFieldName | null
      message: string
      code: CronProblemCode
      params: Record<string, string | number>
    }
  | { reason: 'never' }
  | { reason: 'min_gap'; minutes: number }

/** D8: a zone Intl knows; the browser's own zone is the editor's default. */
export const TimeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isTimeZone, 'An IANA time zone such as Europe/Berlin')

/** Spec §1.4: the newest `last`, plus one per day, ISO week and month for that many of them. */
export const RetentionSchema = z.strictObject({
  last: z.number().int().min(1).max(100),
  daily: z.number().int().min(0).max(90),
  weekly: z.number().int().min(0).max(52),
  monthly: z.number().int().min(0).max(60),
})
export type RetentionPolicy = z.infer<typeof RetentionSchema>
export const RETENTION_PRESETS = {
  daily30: { last: 7, daily: 30, weekly: 0, monthly: 0 },
  standard: { last: 7, daily: 14, weekly: 8, monthly: 12 },
  long: { last: 7, daily: 30, weekly: 26, monthly: 60 },
} as const satisfies Record<string, RetentionPolicy>
export type RetentionPreset = keyof typeof RETENTION_PRESETS | 'custom'

export const MAX_SCHEDULES_PER_USER = 10
export const MAX_SCHEDULE_RUNS_KEPT = 200
/** Spec §1.4: a policy change removing more than this many backups now needs a confirmation. */
export const RETENTION_CONFIRM_ABOVE = 10

/** Spec §1.2 "What": the 3d-3a dump options a schedule repeats. */
export const ScheduleDumpSchema = z.strictObject({
  scope: BackupScopeSchema,
  engine: z.enum(BACKUP_ENGINES).default('builtin'),
  indexes: z.boolean().default(true),
  options: z.boolean().default(true),
  anonymous: z.boolean().default(false),
})
export type ScheduleDump = z.infer<typeof ScheduleDumpSchema>

const Name = z.string().trim().min(1).max(80)
const Destinations = z
  .array(z.string().uuid())
  .min(1)
  .max(MAX_SEND_DESTINATIONS)
  .refine(unique, 'A destination is listed twice')

/**
 * W4.4: a restore drill every N runs — the run's backup restored into a scratch database of the
 * connection, verified and dropped (null: none).
 */
export const DrillSettingSchema = z.strictObject({ everyRuns: z.number().int().min(1).max(30) })
export type DrillSetting = z.infer<typeof DrillSettingSchema>

export const ScheduleInputSchema = z.strictObject({
  name: Name,
  connectionId: z.string().min(1).max(64),
  dump: ScheduleDumpSchema,
  format: z.enum(BACKUP_FORMATS).default('mmbak'),
  cadence: CadenceSchema,
  timeZone: TimeZoneSchema,
  destinations: Destinations,
  keepOnServer: z.boolean().default(false),
  retention: RetentionSchema.default(RETENTION_PRESETS.standard),
  drill: DrillSettingSchema.nullable().default(null),
})
export type ScheduleInput = z.infer<typeof ScheduleInputSchema>

/** Plan ruling 20: the connection is not editable; ruling 21: `confirmRemovals` confirms a large removal. */
export const SchedulePatchSchema = z.strictObject({
  name: Name.optional(),
  dump: ScheduleDumpSchema.optional(),
  format: z.enum(BACKUP_FORMATS).optional(),
  cadence: CadenceSchema.optional(),
  timeZone: TimeZoneSchema.optional(),
  destinations: Destinations.optional(),
  keepOnServer: z.boolean().optional(),
  retention: RetentionSchema.optional(),
  drill: DrillSettingSchema.nullable().optional(),
  confirmRemovals: z.number().int().min(0).max(100_000).optional(),
})
export type SchedulePatch = z.infer<typeof SchedulePatchSchema>

/** Spec §3.4: cadence → next runs and words; retention (of a saved schedule) → what goes now. */
export const SchedulePreviewSchema = z.strictObject({
  cadence: CadenceSchema.optional(),
  /** Next runs are told in this zone (UTC when left out); with `scheduleId`, removals count it too. */
  timeZone: TimeZoneSchema.optional(),
  retention: RetentionSchema.optional(),
  /** Final review minor 8: an edited schedule's draft locations, for the removals now. */
  destinations: Destinations.optional(),
  keepOnServer: z.boolean().optional(),
  scheduleId: z.string().uuid().optional(),
  locale: UiLanguageSchema.default('en'),
})

/** Plan ruling 19: why a schedule is paused (schedules.pause.<reason> in the web). */
export const PAUSE_REASONS = [
  'owner',
  'admin',
  'owner_disabled',
  'connection_access',
  'destination_access',
  'destination_gone',
  'key_inactive',
  'personal_plain',
  'encrypted_only',
  /** Final review I2: its cadence or time zone cannot be read by this server (another ICU, a damaged row). */
  'invalid_cadence',
  /** Final review I6: its own kept server copies fill the owner's backup space. */
  'server_space',
] as const
export type PauseReason = (typeof PAUSE_REASONS)[number]
export const RUN_OUTCOMES = ['succeeded', 'partial', 'failed', 'skipped', 'missed'] as const
export type RunOutcome = (typeof RUN_OUTCOMES)[number]
export const RUN_KINDS = ['scheduled', 'catchup', 'manual'] as const
export type RunKind = (typeof RUN_KINDS)[number]

/** One mark of a card's run strip (spec §5: the last 14 runs). */
export interface RunMark {
  id: string
  dueAt: number
  outcome: RunOutcome | 'running' | 'queued'
  /** Final review I4: why it failed, was partial or skipped (schedules.reason.<reason>). */
  reason: string | null
}

export interface ScheduleView {
  id: string
  name: string
  owner: { id: string; username: string | null }
  /** The viewer owns it (administrators see others' schedules too). */
  mine: boolean
  connectionId: string
  connectionName: string | null
  dump: ScheduleDump
  format: BackupFormat
  key: { id: string; name: string; fingerprint: string; state: KeyState } | null
  cadence: Cadence
  timeZone: string
  destinations: Array<{ id: string; name: string | null; coldStorage: boolean }>
  keepOnServer: boolean
  retention: RetentionPolicy
  /** W4.4: a restore drill every N runs, or none. */
  drill: DrillSetting | null
  state: 'active' | 'paused'
  pause: { reason: PauseReason; by: 'owner' | 'admin' | 'system'; byName: string | null } | null
  nextRunAt: number | null
  lastRuns: RunMark[]
  createdAt: number
  updatedAt: number
}

export interface ScheduleRunView {
  id: string
  dueAt: number
  kind: RunKind
  startedAt: number | null
  finishedAt: number | null
  outcome: RunOutcome | 'running' | 'queued'
  /** A reason code (schedules.reason.<code>); null for a success. */
  reason: string | null
  /** The failed job's words, when there was one. */
  message: string | null
  backupId: string | null
  dumpJobId: string | null
  sendJobId: string | null
  size: number | null
  copies: Array<{
    destinationId: string
    name: string | null
    state: 'complete' | 'failed' | 'missing'
    reason: string | null
  }>
  removals: Array<{ location: string; name: string | null; removed: number; failed: number; waiting: number }>
  /** How many due times a stopped server missed (a missed row); "more" when there were more than counted. */
  missed: number | null
  missedMore: boolean
  keyFingerprint: string | null
  /** W4.4: the restore drill of this run, when one was due. */
  drill: DrillOutcome | null
}

/** W4.4: what a run's restore drill found (reason codes: schedules.drill.reason.<code>). */
export interface DrillOutcome {
  state: 'passed' | 'failed' | 'skipped'
  reason?: string
  jobId?: string
  namespaces?: number
  /** Namespaces whose count or contents differed (at most 20). */
  mismatched?: string[]
}

export interface SchedulesList {
  /** Plan ruling 22: false when MM_BACKUP_SCHEDULES=0. */
  enabled: boolean
  schedules: ScheduleView[]
}

export interface SchedulePreview {
  /** The next five runs in the zone. */
  runs: number[]
  words: string | null
  problem: CadenceProblem | null
  /** Per location, how many of the schedule's backups the policy would remove now. */
  removals: Array<{ location: string; name: string | null; count: number }>
}

/** Spec §1.1: a user's backup keys. */
export const KEY_STATES = ['active', 'retired', 'imported', 'pending'] as const
export type KeyState = (typeof KEY_STATES)[number]
export interface BackupKeyView {
  id: string
  name: string
  fingerprint: string
  state: KeyState
  createdAt: number
  confirmedAt: number | null
  retiredAt: number | null
  uses: { schedules: number; backups: number }
}
/** The one answer that carries a kit (D1): shown once, never stored. */
export interface BackupKeyCreated {
  key: BackupKeyView
  kit: string
  fileName: string
}
const KeyName = z.string().trim().min(1).max(64)
export const KeyCreateSchema = z.strictObject({ name: KeyName.optional() })
export const KeyConfirmSchema = z.strictObject({ check: z.string().trim().min(1).max(16) })
export const KeyImportSchema = z.strictObject({
  kit: z.string().min(1).max(8192),
  name: KeyName.optional(),
})
