import { z } from 'zod'
import { CollectionNameSchema, DatabaseNameSchema } from '../schemas'

/** Phase 3e-1 spec §1.1: what a feed watches. */
export const WATCH_SCOPES = ['collection', 'database', 'deployment'] as const
export type WatchScope = (typeof WATCH_SCOPES)[number]

/** Spec §1.4: the data changes, and the expanded events shown with "Include schema changes". */
export const DATA_OPS = ['insert', 'update', 'replace', 'delete'] as const
export const SCHEMA_OPS = [
  'drop',
  'rename',
  'dropDatabase',
  'create',
  'createIndexes',
  'dropIndexes',
  'modify',
  'shardCollection',
  'refineCollectionShardKey',
  'reshardCollection',
] as const
export const WATCH_OPS = [...DATA_OPS, ...SCHEMA_OPS] as const
export type WatchOp = (typeof WATCH_OPS)[number]

/** Plan ruling 1: the filter fits the socket's 16 KiB message with the rest of the subscription. */
export const MAX_WATCH_FILTER_BYTES = 12 * 1024
export const MAX_WATCH_FILTER_DEPTH = 20
/** Spec §4.2: the events the web keeps. */
export const MAX_WATCH_EVENTS = 2000

export const WatchOptionsSchema = z.strictObject({
  ops: z
    .array(z.enum(WATCH_OPS))
    .min(1)
    .max(WATCH_OPS.length)
    .default([...DATA_OPS]),
  /** `fullDocument: 'updateLookup'`: the whole document after an update. */
  fullDocument: z.boolean().default(false),
  /** `showExpandedEvents`: schema changes (indexes, collections, options). */
  schemaChanges: z.boolean().default(false),
  /** `fullDocumentBeforeChange: 'whenAvailable'` (collection scope; costs nothing without pre-images). */
  before: z.boolean().default(true),
  /**
   * W4.7: record the events, as this viewer sees them (masked where they are), to a file on the server
   * (bounded) to replay or download later. Needs the export right on the connection.
   */
  record: z.boolean().default(false),
  /** W4.7: raise an app event (`watch.matched`) for alerts when events pass the feed's filter. */
  alert: z.boolean().default(false),
})
export type WatchOptions = z.infer<typeof WatchOptionsSchema>

/** W4.7: a recording's file, at most this large (also bounded by the owner's transfer space). */
export const MAX_WATCH_RECORDING_BYTES = 64 * 1024 * 1024
/** W4.7: a feed raises `watch.matched` at most this often. */
export const WATCH_ALERT_EVERY_MS = 10_000

/** W4.7: a recorded feed, as its owner lists it. */
/** W4 review I9: a replay is read a page at a time: at most this many events, and this many bytes. */
export const WATCH_REPLAY_PAGE = 500
export const WATCH_REPLAY_PAGE_BYTES = 2 * 1024 * 1024

/** W4 review I9: a page of a recording's events, from a place (a byte offset) to the next one. */
export interface WatchRecordingPage {
  events: WatchEvent[]
  /** Where the next page starts. */
  next: number
  /** Nothing after `next` (so far: a recording still being written may grow). */
  end: boolean
}

export interface WatchRecording {
  id: string
  name: string
  /** "db" or "db.coll"; null: the whole deployment. */
  namespace: string | null
  size: number
  createdAt: number
  expiresAt: number
  /** Recorded masked (the viewer was restricted, then): replayed as it was recorded. */
  masked: boolean
  /** Still being written (its feed runs). */
  recording: boolean
}

/** W4.7: turn a collection's pre- and post-images on or off (from the Watch page). */
export const PreImagesSchema = z.strictObject({ enabled: z.boolean() })
export type PreImagesRequest = z.infer<typeof PreImagesSchema>

/** Spec §1.2: what a subscription watches; the database and collection where the scope needs them. */
export const WatchTargetSchema = z
  .strictObject({
    connectionId: z.string().min(1).max(64),
    scope: z.enum(WATCH_SCOPES),
    db: DatabaseNameSchema.optional(),
    coll: CollectionNameSchema.optional(),
  })
  .superRefine((t, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message })
    if (t.scope === 'deployment' && (t.db !== undefined || t.coll !== undefined))
      issue('The deployment scope takes no database or collection')
    if (t.scope !== 'deployment' && t.db === undefined) issue('A database is required')
    if (t.scope === 'collection' && t.coll === undefined) issue('A collection is required')
    if (t.scope === 'database' && t.coll !== undefined) issue('The database scope takes no collection')
  })
export type WatchTarget = z.infer<typeof WatchTargetSchema>

/** Spec §2.3: why a feed was refused (`error`) or ended (`ended`). */
export const WATCH_REASONS = [
  'closed',
  'access',
  'turned_off',
  'limit',
  'not_replica_set',
  'view',
  'unauthorized',
  'history_lost',
  'event_too_large',
  'connection',
  'invalidate',
  'filter',
  'masking_filter',
  /** W4.7: a recording asked by someone without the export right on the connection. */
  'record_denied',
  'internal',
] as const
export type WatchReason = (typeof WATCH_REASONS)[number]

/**
 * Spec §1.3, final review C1/I6: the parts of an event too large for the feed, with their size in
 * bytes. Sent beside the event, never inside a document, so no field of a document can pose as it.
 */
export interface WatchElided {
  fullDocument?: number
  before?: number
  documentKey?: number
  update?: number
  description?: number
}

/** Final review I6: what the web keeps of a feed at most, in serialised bytes. */
export const MAX_WATCH_KEPT_BYTES = 64 * 1024 * 1024

export interface WatchUpdate {
  /** Updated values by dotted path (canonical EJSON, masked). */
  updated: Record<string, unknown>
  /** Removed field paths (names, never values). */
  removed: string[]
  /** Arrays cut to a new size: the path and the size only. */
  truncated: Array<{ field: string; newSize: number }>
}

/** Spec §1.5: an event as the web sees it. Resume tokens, sessions and UUIDs never leave the server. */
export interface WatchEvent {
  /** Per feed, from 1. */
  seq: number
  op: string
  ns: { db: string; coll?: string }
  /** A rename's target. */
  to?: { db: string; coll: string }
  documentKey?: unknown
  fullDocument?: unknown
  /** `fullDocumentBeforeChange`. */
  before?: unknown
  update?: WatchUpdate
  /** An expanded event's `operationDescription` (plan ruling 3). */
  description?: unknown
  /** Seconds since the epoch (the event's cluster time). */
  clusterTime: number
  /** Milliseconds since the epoch, when MongoDB reports it. */
  wallTime?: number
  /** Something in this event was masked. */
  masked: boolean
  /** Parts left out for their size. */
  elided?: WatchElided
  /** The event's serialised size, for the web's memory bound. */
  bytes: number
}
