// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { z } from 'zod'
import { CollectionNameSchema, DatabaseNameSchema } from '../schemas'
import type { CompareDiffSample, CompareSample, CopyPlan } from './transfer'
import { EjsonObjectSchema } from './data'

/** Phase 3e-2 spec §1.2. */
export const LIVE_SYNC_STATES = [
  'copying',
  'catching_up',
  'live',
  'paused',
  'attention',
  'retrying',
  'cutting_over',
  'completed',
  'failed',
  'stopped',
] as const
export type LiveSyncState = (typeof LIVE_SYNC_STATES)[number]
/** States with a worker: they read the source and write the target (plan ruling 10). */
export const RUNNING_STATES = ['copying', 'catching_up', 'live', 'retrying', 'cutting_over'] as const
/** A sync never leaves these. */
export const FINAL_STATES = ['completed', 'failed', 'stopped'] as const

/** Spec §1.3 (plan ruling 3). */
export const START_MODES = ['copy', 'replace', 'merge', 'from_now'] as const
export type StartMode = (typeof START_MODES)[number]
/** Spec §1.7. */
export const ERROR_POLICIES = ['pause', 'skip'] as const
export type ErrorPolicy = (typeof ERROR_POLICIES)[number]

/** Spec §2.3, plan ruling 6 (`connection_deleted`) and 1 (`copy_failed`, `copy_interrupted`). */
export const LIVE_SYNC_REASONS = [
  'owner',
  'admin',
  'owner_access',
  'rules_changed',
  'connection_changed',
  'connection_deleted',
  'read_only',
  'write_error',
  'schema_changed',
  'source_gone',
  'turned_off',
  'copy_failed',
  'copy_interrupted',
  'history_lost',
  'target_gone',
  /** Final review I8: the change stream raised an error waiting cannot fix (the detail names it). */
  'stream_error',
  /** W4.6: a scheduled sync waits for its time (paused); at its time its plan no longer held. */
  'scheduled',
  'scheduled_refused',
  /** W4 review I5: a two-way direction paused because the other one stopped (resumed with it). */
  'partner_stopped',
  /** W4 review (minor): a filter runs server JavaScript, which the server no longer allows. */
  'filter_refused',
  /** W4 review (minor): a two-way side's pre- and post-images were turned off. */
  'pre_images_off',
  /** W4 re-review (minor): too many changes wait for the other side, or the oplog nears their place. */
  'two_way_backlog',
  /** W4 re-review 2 (minor): after a backlog, waiting for the other side to be live again. */
  'partner_catching_up',
  'internal',
] as const
export type LiveSyncReason = (typeof LIVE_SYNC_REASONS)[number]

/** Spec §2.4, §1.4, §1.7, §1.5 (plan ruling 8). */
export const LIVE_SYNC_LIMITS = {
  perUser: 3,
  batchChanges: 1000,
  batchBytes: 8 * 1024 * 1024,
  logRows: 500,
  skipped: 1000,
  liveMs: 2000,
  verifySuspects: 10_000,
} as const

const Ref = z.string().min(1).max(64)

/** Spec §1.1, §1.3, §1.7, §3.2: a new live sync, with the confirmations its plan asked for. */
export const LiveSyncRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100).optional(),
    source: z.strictObject({
      connectionId: Ref,
      db: DatabaseNameSchema,
      coll: CollectionNameSchema.optional(),
      /** A database sync's chosen collections; absent: all of them. */
      collections: z.array(CollectionNameSchema).min(1).max(1000).optional(),
    }),
    target: z.strictObject({
      connectionId: Ref,
      db: DatabaseNameSchema,
      coll: CollectionNameSchema.optional(),
    }),
    startMode: z.enum(START_MODES).default('copy'),
    errorPolicy: z.enum(ERROR_POLICIES).default('pause'),
    followNew: z.boolean().default(true),
    anonymous: z.boolean().default(false),
    confirmPersonal: z.boolean().default(false),
    addRulesToTarget: z.boolean().default(false),
    confirmTtl: z.boolean().default(false),
    /** Spec §1.4: writes made on the target by others are overwritten. */
    confirmOverwrite: z.boolean().default(false),
    /** Spec §1.3: the copy may outlast half the source's oplog window. */
    confirmOplog: z.boolean().default(false),
    /** "Replace the target": the target's name, typed. */
    confirmTarget: z.string().max(256).optional(),
    /** Final review m16: "Start again" — the caller's sync this one replaces (stopped when this starts). */
    replaces: z.uuid().optional(),
    /**
     * W4.6: a collection sync of the source documents this filter matches (canonical EJSON). A
     * document that stops matching is removed from the target; the source evaluates the filter.
     */
    filter: EjsonObjectSchema.optional(),
    /** W4.6: start at this time (ms since the epoch, a minute to 30 days ahead); paused until then. */
    startAt: z.number().int().positive().optional(),
    /**
     * W4.6: two-way — the target's changes come back to the source too (a collection sync from now,
     * both sides holding the same documents). Needs pre- and post-images on both collections
     * (`enablePreImages` turns them on) and the owner's confirmation of what it does.
     */
    twoWay: z.boolean().default(false),
    enablePreImages: z.boolean().default(false),
    confirmTwoWay: z.boolean().default(false),
    planHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .superRefine((r, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message })
    if ((r.source.coll === undefined) !== (r.target.coll === undefined))
      issue('Sync a collection to a collection, or a database to a database')
    if (r.source.coll !== undefined && r.source.collections !== undefined)
      issue('A collection sync names no collections')
    if (r.filter !== undefined && r.source.coll === undefined) issue('Only a collection sync takes a filter')
  })
export type LiveSyncRequest = z.infer<typeof LiveSyncRequestSchema>

/** Spec §5: the wizard's warning cards (each confirmable where §3/§1 asks). */
export type LiveSyncWarning =
  | 'overwrite'
  | 'oplog_window'
  | 'oplog_unknown'
  | 'personal_unruled'
  | 'unique_masked'
  | 'ttl'
  /** W4.6: a two-way sync — last writer wins, and the other side's writes come back. */
  | 'two_way'

export interface LiveSyncPlan {
  planHash: string
  /** The initial copy's plan (3d-2); for "from now" what it would have been (access and masks). */
  copy: CopyPlan
  /** The sync masks what it writes: the owner is restricted on the source, or it is anonymous. */
  masked: boolean
  warnings: LiveSyncWarning[]
  /** Reason codes the start would answer with. */
  refusals: string[]
  /** The source collections that `left_out` names: the copy leaves them out (each says why). */
  leftOut?: string[]
  /** The size and time are null where rules hide personal data from the caller. */
  estimate: { documents: number; bytes: number | null; seconds: number | null }
  oplogWindowSeconds: number | null
}

export interface LiveSyncCounters {
  inserted: number
  replaced: number
  deleted: number
  skipped: number
  batches: number
  /** When the last applied change happened in the source (ms), or null. */
  lastEventAt: number | null
  lagMs: number
  /** When the stream last had nothing waiting (ms): everything up to then is applied. */
  caughtUpAt: number | null
  /** W4.6: a two-way direction's conflicts settled (last writer wins); absent: none yet. */
  conflicts?: number
}
export const ZERO_COUNTERS: LiveSyncCounters = {
  inserted: 0,
  replaced: 0,
  deleted: 0,
  skipped: 0,
  batches: 0,
  lastEventAt: null,
  lagMs: 0,
  caughtUpAt: null,
}

/** Spec §1.5, plan ruling 8. */
export interface LiveSyncVerifyPair {
  source: string
  target: string
  same: number
  different: number
  onlySource: number
  onlyTarget: number
  /** Suspects beyond the settling bound: counted as found, not checked again. */
  unsettled: number
  /** Up to 20 `_id`s still different after settling (canonical EJSON). */
  ids: unknown[]
  /**
   * W4.6: what differs, as the compare view shows it (documents and field changes, cut). Kept on the
   * server only: never in a sync's view; its owner reads them through the verify samples route.
   */
  samples?: LiveSyncVerifySamplesOf
}
/** W4.6: a verification's samples for one collection (the 3d-2 compare report's form). */
export interface LiveSyncVerifySamplesOf {
  onlySource: CompareSample[]
  onlyTarget: CompareSample[]
  different: CompareDiffSample[]
}
/** W4.6: the verify samples route's answer, for the sync's owner. */
export interface LiveSyncVerifySamples {
  finishedAt: number | null
  masked: boolean
  pairs: Array<Omit<LiveSyncVerifyPair, 'samples'> & { samples: LiveSyncVerifySamplesOf }>
}
export interface LiveSyncVerify {
  state: 'running' | 'done' | 'failed'
  startedAt: number
  finishedAt: number | null
  pairs: LiveSyncVerifyPair[]
  /** Why it failed (our words; a code for a restricted owner). */
  error?: string
  /** W4.6: the rules versions the samples were read under (server-side; samples go when they move). */
  versions?: { source: number; target: number }
}

/** Spec §5: a sync as the web sees it. The place and its token never appear. */
export interface LiveSyncView {
  id: string
  name: string
  mine: boolean
  owner: string
  source: {
    connectionId: string
    connectionName: string
    db: string
    coll: string | null
    collections: string[] | null
  }
  target: { connectionId: string; connectionName: string; db: string; coll: string | null }
  startMode: StartMode
  errorPolicy: ErrorPolicy
  followNew: boolean
  anonymous: boolean
  masked: boolean
  /** W4.6: a scheduled sync's start (ms), while it waits; null otherwise. */
  scheduledAt: number | null
  /** W4.6: one direction of a two-way sync: its partner (the other direction) and which side it is. */
  twoWay: { partner: string; side: 'forward' | 'reverse' } | null
  /** W4.6: the filter of a filtered sync (canonical EJSON), or null. */
  filter: Record<string, unknown> | null
  state: LiveSyncState
  reason: LiveSyncReason | null
  /** A code, a namespace or an `_id` (never MongoDB's text for a restricted owner). */
  detail: string | null
  /** 'owner', 'admin:<name>' or 'system'. */
  pausedBy: string | null
  counters: LiveSyncCounters
  copyJobId: string | null
  /** When the initial copy finished (null: copying, or "from now"). */
  copiedAt: number | null
  /** `retrying`: when the next attempt starts. */
  retryAt: number | null
  verify: LiveSyncVerify | null
  createdAt: number
  updatedAt: number
  finishedAt: number | null
}

export interface LiveSyncEvent {
  at: number
  /** W4.6: "conflict": a two-way conflict settled (the detail names the _id, the winner and why). */
  kind: 'state' | 'error' | 'batch' | 'schema' | 'verify' | 'skipped' | 'conflict'
  state?: LiveSyncState
  reason?: LiveSyncReason
  detail?: string
  counts?: Partial<LiveSyncCounters>
}
export interface LiveSyncDetail extends LiveSyncView {
  events: LiveSyncEvent[]
}

/** Spec §3.2, S9: the owner confirms a reviewed summary. */
export const LiveSyncConfirmSchema = z.strictObject({
  planHash: z.string().regex(/^[0-9a-f]{64}$/),
  confirmPersonal: z.boolean().default(false),
  addRulesToTarget: z.boolean().default(false),
})
export type LiveSyncConfirm = z.infer<typeof LiveSyncConfirmSchema>

export interface LiveSyncsList {
  enabled: boolean
  /** MM_LIVE_SYNC_MAX, and the per-user limit. */
  max: number
  perUser: number
  syncs: LiveSyncView[]
}

/** W4.6: the lag history asked for — the last minutes (10 minutes to a day). */
export const LiveSyncLagQuerySchema = z.strictObject({
  minutes: z.coerce.number().int().min(10).max(1440).default(60),
})
/** W4.6: the largest lag of each span, oldest first (at most 360 points). */
export interface LiveSyncLag {
  points: Array<{ at: number; lag: number }>
}

export const LiveSyncFinishSchema = z.strictObject({ verify: z.boolean().default(true) })
export const LiveSyncSchemaSchema = z.strictObject({ ignore: z.boolean() })
