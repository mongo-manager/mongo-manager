import { z } from 'zod'
import {
  CollectionNameSchema,
  DatabaseNameSchema,
  WATCH_SCOPES,
  WatchOptionsSchema,
  type JobView,
  type LiveSyncView,
  type WatchEvent,
  type WatchReason,
} from '@mongo-manager/shared'
import type { ServerSample } from '../monitor/sampler'

/** What a browser may send on /ws (phase 1h spec §4); anything else closes the socket. */
export const ClientMessage = z.union([
  z.strictObject({ type: z.literal('hello'), csrf: z.string().min(1).max(256) }),
  z.strictObject({ ch: z.literal('jobs'), type: z.enum(['sub', 'unsub']) }),
  // Phase 3e-2: the caller's live syncs (all for administrators).
  z.strictObject({ ch: z.literal('livesync'), type: z.enum(['sub', 'unsub']) }),
  // Phase 1i: live server metrics of one connection.
  z.strictObject({
    ch: z.literal('monitor'),
    type: z.enum(['sub', 'unsub']),
    connectionId: z.string().min(1).max(64),
  }),
  // Phase 3a-1: the advanced shell.
  z.strictObject({
    ch: z.literal('shell'),
    type: z.literal('open'),
    connectionId: z.string().min(1).max(64),
    db: z.string().min(1).max(64),
    /** The shell's redesign (2026-10-11): the tab's own tag, echoed on its opened or failed. */
    ref: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .optional(),
  }),
  z.strictObject({
    ch: z.literal('shell'),
    type: z.literal('eval'),
    sessionId: z.string().min(1).max(64),
    id: z.number().int().min(1),
    code: z.string().max(256 * 1024),
  }),
  z.strictObject({
    ch: z.literal('shell'),
    type: z.enum(['cancel', 'close', 'attach']),
    sessionId: z.string().min(1).max(64),
  }),
  // Phase 3a-2: complete the code up to the caret (answered with completions).
  z.strictObject({
    ch: z.literal('shell'),
    type: z.literal('complete'),
    sessionId: z.string().min(1).max(64),
    id: z.number().int().min(1),
    code: z.string().max(256 * 1024),
  }),
  // Phase 3e-1: change-stream feeds. The scope takes exactly the database and collection it needs.
  z
    .strictObject({
      ch: z.literal('watch'),
      type: z.literal('sub'),
      id: z.uuid(),
      connectionId: z.string().min(1).max(64),
      scope: z.enum(WATCH_SCOPES),
      db: DatabaseNameSchema.optional(),
      coll: CollectionNameSchema.optional(),
      filter: z.record(z.string(), z.unknown()).default({}),
      options: WatchOptionsSchema.prefault({}),
      /** Final review I5: the last event received, so a reconnect resumes right after it. */
      after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      /** Final review M10: the feed was paused before its socket went. */
      paused: z.boolean().optional(),
    })
    .superRefine((m, ctx) => {
      if (m.scope === 'deployment' ? m.db !== undefined || m.coll !== undefined : m.db === undefined)
        ctx.addIssue({ code: 'custom', message: 'The scope does not match its database' })
      if ((m.scope === 'collection') !== (m.coll !== undefined))
        ctx.addIssue({ code: 'custom', message: 'The scope does not match its collection' })
    }),
  z.strictObject({ ch: z.literal('watch'), type: z.enum(['unsub', 'pause']), id: z.uuid() }),
  z.strictObject({
    ch: z.literal('watch'),
    type: z.literal('resume'),
    id: z.uuid(),
    from: z.enum(['here', 'now']),
  }),
])
export type ClientMessage = z.infer<typeof ClientMessage>

export type ServerMessage =
  | { type: 'ready' }
  // The updater (2026-11-03): an update is installed and the server restarts; every page says so.
  | { ch: 'server'; type: 'restarting'; payload: { version: string } }
  // now: the server's clock, so the page shows elapsed times without its own clock's skew.
  | { ch: 'jobs'; type: 'snapshot'; payload: { jobs: JobView[]; now: number } }
  | { ch: 'jobs'; type: 'update'; payload: { job: JobView; now: number } }
  | { ch: 'jobs'; type: 'gone'; payload: { id: string } }
  | { ch: 'livesync'; type: 'update'; payload: { sync: LiveSyncView } }
  | { ch: 'livesync'; type: 'gone'; payload: { id: string } }
  | { ch: 'monitor'; type: 'sample'; payload: ServerSample & { connectionId: string } }
  | {
      ch: 'monitor'
      type: 'error'
      payload: { connectionId: string; code: 'FORBIDDEN' | 'TOO_MANY' | 'NOT_PERMITTED' | 'UNREACHABLE' }
    }
  // Phase 3a-1: the advanced shell.
  // Every message names its session (an open, its tab's ref): tabs share one socket (2026-10-11).
  | {
      ch: 'shell'
      type: 'opened'
      payload: { sessionId: string; prompt: string; db?: string; ref?: string; running?: boolean }
    }
  | {
      ch: 'shell'
      type: 'print' | 'result' | 'done' | 'error' | 'reset'
      payload: Record<string, unknown> & { sessionId: string }
    }
  // The reason is a code (idle, lifetime, closed, access, ended, …), worded by the page.
  | { ch: 'shell'; type: 'closed'; payload: { sessionId: string; reason: string } }
  | {
      ch: 'shell'
      type: 'failed'
      payload: { code: string; message: string; sessionId?: string; ref?: string }
    }
  | { ch: 'shell'; type: 'completions'; payload: { sessionId: string; id: number; items: string[] } }
  // Phase 3e-1: change-stream feeds.
  | {
      ch: 'watch'
      type: 'started'
      payload: {
        id: string
        preImages: boolean | null
        /** Resumed after a reconnect; `gap`: not right after the last event received (some may be missed). */
        resumed: boolean
        gap: boolean
        paused: boolean
        /** The collection exists yet (collection scope; null elsewhere). */
        exists: boolean | null
        /** W4.7: the feed records its events to a file. */
        recording?: boolean
      }
    }
  | { ch: 'watch'; type: 'events'; payload: { id: string; events: WatchEvent[]; lagMs: number } }
  /** W4.7: the recording stopped (its file is full); the feed itself goes on. */
  | { ch: 'watch'; type: 'recording'; payload: { id: string; state: 'full' } }
  | { ch: 'watch'; type: 'paused'; payload: { id: string } }
  | { ch: 'watch'; type: 'resumed'; payload: { id: string; from: 'here' | 'now' } }
  | { ch: 'watch'; type: 'error' | 'ended'; payload: { id: string; reason: WatchReason; detail?: string } }

/** Close codes, private range (4000–4999). */
export const CLOSE = {
  badMessage: 4400,
  unauthenticated: 4401,
  /** No valid hello: a stale CSRF token (the page can refresh it) or none in time. The session may be fine. */
  badHello: 4403,
  timeout: 4408,
  tooLarge: 4413,
  tooMany: 4429,
  shutdown: 1001,
} as const
