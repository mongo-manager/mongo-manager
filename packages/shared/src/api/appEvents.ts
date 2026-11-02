/**
 * App events (completion design §2 W4.7 and W3.3): things that happened in Mongo Manager that
 * other parts of the app may act on — the alerts of W3 (in-app bell, e-mail, webhooks) subscribe to
 * them. The server emits them with `ctx.events.emit(kind, input)` (server/src/events/app-events.ts);
 * see docs/app-events.md for the contract. A live sync that stops is not one: the alerts read it from
 * the sync's own record (W4 review I4: one source).
 *
 * An event never holds a document value: ids, names, counts and short summaries only.
 */
export const APP_EVENT_KINDS = [
  /** A scheduled restore drill restored and verified a backup. */
  'backup.drill.passed',
  /** A scheduled restore drill could not restore, or found counts or contents that differ. */
  'backup.drill.failed',
  /** A two-way live sync resolved conflicting changes (last writer wins); they are listed. */
  'liveSync.conflicts',
  /** A change-stream watch saw an event that its alert filter matches. */
  'watch.matched',
] as const
export type AppEventKind = (typeof APP_EVENT_KINDS)[number]
export type AppEventSeverity = 'info' | 'warning' | 'critical'
/** Details are flat: names, ids, counts and flags (texts cut at 200 characters, at most 20 keys). */
export type AppEventDetails = Record<string, string | number | boolean | null>

export interface AppEvent {
  kind: AppEventKind
  /** Server time, ms since the epoch. */
  at: number
  severity: AppEventSeverity
  connectionId: string | null
  /** "db" or "db.coll", when the event is about one. */
  namespace: string | null
  /** The user whose job, schedule or sync it is ('local' in local mode), when there is one. */
  ownerId: string | null
  /** One sentence in English, at most 300 characters; alert channels may word it their own way. */
  summary: string
  details: AppEventDetails
}

/** What an emitter gives; the hook adds the time and bounds the rest. */
export interface AppEventInput {
  severity: AppEventSeverity
  summary: string
  connectionId?: string | null
  namespace?: string | null
  ownerId?: string | null
  details?: AppEventDetails
}
