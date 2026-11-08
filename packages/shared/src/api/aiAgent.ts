// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { z } from 'zod'
import { UiLanguageSchema } from '../languages'
import type { Role } from '../permissions'
import type { AiPolicy, AiResult } from './ai'
import { ArchivePasswordSchema } from './backup'
import { TimeZoneSchema, type RetentionPolicy } from './schedules'

/**
 * W6.3 (completion §2): the agentic assistant. It reads and acts on MongoDB through the app's own
 * routes, as the person, with their rights and masking; every change waits for the person's click.
 */
export const AI_AGENT_LIMITS = {
  /** Requests to the provider in one turn (each may ask for tools). */
  steps: 10,
  /** Tool calls in one turn. */
  callsPerTurn: 20,
  /** Tool calls a minute, per person, over all their turns. */
  callsPerMinute: 30,
  /** Documents a read tool hands to the provider at most. */
  documents: 10,
  /** Documents one insert may hold. */
  insertDocuments: 50,
  /** A tool result as sent to the provider (bytes of JSON). */
  resultBytes: 12 * 1024,
  /** How long a change waits for the person's answer. */
  decisionMs: 10 * 60_000,
  /**
   * Review of C4 (I1): the changes a plan may hold — each takes a round of the turn's, the plan one
   * and the answer one.
   */
  planChanges: 8,
  /**
   * Design 2026-10-25 (C6): a collection this large has a read explained first; one that would scan
   * it whole is said before it runs.
   */
  largeCollection: 100_000,
  /** A line written while the turn waits, so that proxies keep the answer open. */
  pingMs: 15_000,
} as const

export const AI_AGENT_READ_TOOLS = [
  'list_connections',
  'check_connection',
  'list_databases',
  'list_collections',
  'collection_stats',
  'find_documents',
  'count_documents',
  'analyze_schema',
  'list_indexes',
  'explain_query',
  'run_aggregation',
  'list_backup_destinations',
  'list_jobs',
  'get_job',
  'list_backups',
  'list_schedules',
  'server_status',
  'replica_set',
  'server_top',
  'slow_queries',
  'index_advice',
  'current_operations',
  'list_users',
  'list_roles',
  // Design 2026-10-25 (C2).
  'distinct_values',
  // C7: alerts and scheduled reports.
  'list_alerts',
  'list_alert_rules',
] as const
export const AI_AGENT_WRITE_TOOLS = [
  'create_database',
  'create_collection',
  'insert_documents',
  'update_documents',
  'delete_documents',
  'create_index',
  'drop_index',
  'drop_collection',
  'drop_database',
  'run_backup',
  'create_backup_schedule',
  'run_schedule',
  'pause_schedule',
  'resume_schedule',
  'update_schedule',
  'delete_schedule',
  'restore_backup',
  'kill_operation',
  'create_user',
  'drop_user',
  // Design 2026-10-25 (C1).
  'export_documents',
  // C3.
  'set_validator',
  'create_search_index',
  'rename_collection',
  'copy_collection',
  // C7: alert rules and scheduled reports (an administrator's).
  'create_alert_rule',
  'update_alert_rule',
  'snooze_alert_rule',
  'delete_alert_rule',
  'create_report',
  'update_report',
  'run_report',
  'delete_report',
] as const
/** C4: plan_changes shows several changes first; each then comes on its own card. */
export const AI_AGENT_UI_TOOLS = ['open_in_app', 'plan_changes'] as const
export const AI_AGENT_TOOLS = [...AI_AGENT_READ_TOOLS, ...AI_AGENT_WRITE_TOOLS, ...AI_AGENT_UI_TOOLS] as const
export type AiAgentTool = (typeof AI_AGENT_TOOLS)[number]
export type AiAgentToolKind = 'read' | 'write' | 'ui'
export function agentToolKind(tool: AiAgentTool): AiAgentToolKind {
  if ((AI_AGENT_READ_TOOLS as readonly string[]).includes(tool)) return 'read'
  if ((AI_AGENT_WRITE_TOOLS as readonly string[]).includes(tool)) return 'write'
  return 'ui'
}
/**
 * Review of C5 (I3): the tools that act on a connection, those an administrator may turn off on one —
 * not those that name none (the connections themselves, the destinations, a plan).
 */
export const AI_AGENT_CONNECTION_TOOLS = AI_AGENT_TOOLS.filter(
  (t) => t !== 'list_connections' && t !== 'list_backup_destinations' && t !== 'plan_changes',
) as readonly AiAgentTool[]
export const isAgentTool = (name: string): name is AiAgentTool =>
  (AI_AGENT_TOOLS as readonly string[]).includes(name)

/** The sections of a collection tab the agent may open. */
export const AI_AGENT_SECTIONS = ['documents', 'aggregations', 'schema', 'indexes', 'validation'] as const
export type AiAgentSection = (typeof AI_AGENT_SECTIONS)[number]

/**
 * Design 2026-10-25 (B7): the page the person is on, named to the model — an app page, or a section of
 * a connection's page.
 */
export const AI_AGENT_APP_PAGES = [
  'schedules',
  'jobs',
  'destinations',
  'liveSyncs',
  'alerts',
  'audit',
  'aiHistory',
] as const
export const AI_AGENT_PAGES = [
  ...AI_AGENT_APP_PAGES,
  // A connection's (or a database's) sections.
  'overview',
  'performance',
  'watch',
  'databaseAccess',
  'sharding',
  'backups',
  'encryption',
  'personalData',
] as const
export type AiAgentPage = (typeof AI_AGENT_PAGES)[number]

/** A turn of the agent (`POST /api/ai/agent`). */
export const AiAgentTurnSchema = z.strictObject({
  /** Absent: a new chat. */
  chat: z.uuid().optional(),
  message: z.string().trim().min(1).max(8000),
  language: UiLanguageSchema.default('en'),
  provider: z.uuid().optional(),
  retry: z.boolean().default(false),
  /** The tab the person is looking at: named to the model, never read. */
  focus: z
    .strictObject({
      connectionId: z.string().min(1).max(64).optional(),
      db: z.string().min(1).max(64).optional(),
      coll: z.string().min(1).max(255).optional(),
      /** B7: the page (or the connection's section) the person is on. */
      page: z.enum(AI_AGENT_PAGES).optional(),
    })
    // A database is a connection's; something is named (a page, or a connection).
    .refine(
      (f) =>
        (f.db === undefined || f.connectionId !== undefined) &&
        // Review of B7 (nit): a collection is a database's.
        (f.coll === undefined || f.db !== undefined) &&
        (f.connectionId !== undefined || f.page),
    )
    .optional(),
  /**
   * Documents' values may go to the provider in this turn (the person's consent, per message, as
   * sample documents are in a chat turn). Off: tools hand over names, counts and schemas only.
   */
  documents: z.boolean().default(false),
  /** Design 2026-10-25 (A4): the person's time zone, for the times they give (a schedule's). */
  // Review of A4 (I4): only a hint — a zone this server does not know is left out, never a refused turn.
  timeZone: TimeZoneSchema.optional().catch(undefined),
})
export type AiAgentTurn = z.output<typeof AiAgentTurnSchema>
export type AiAgentTurnBody = z.input<typeof AiAgentTurnSchema>

/** The person's answer to a proposed change (`POST /api/ai/agent/runs/:run/decide`). */
export const AiAgentDecisionSchema = z.strictObject({
  call: z.string().min(1).max(128),
  /** C4: `backup` makes the backup the card offers, before its change may be confirmed. */
  decision: z.enum(['confirm', 'decline', 'backup']),
  /** The name typed for a destructive change. */
  // Review of B4 (nit 9): a MongoDB user's name may be 256 characters.
  confirm: z.string().max(256).optional(),
  /** An encrypted backup's password: from the person to the backup, never to the model or a log. */
  password: ArchivePasswordSchema.optional(),
  /** C4: the password of the backup made first: from the person to the backup only (its length the route's). */
  backupPassword: z.string().max(1024).optional(),
  /**
   * User request 2026-10-26: the backup made without a password, as a compressed archive — where the
   * card offers it (`proposal.plain`).
   */
  plain: z.literal(true).optional(),
})
export type AiAgentDecision = z.infer<typeof AiAgentDecisionSchema>

/**
 * The AI database manager (design 2026-10-25, A2): what an administrator allows the agent on the
 * server — off, read-only (reads run, no change is proposed) or full.
 */
export const AI_AGENT_POLICIES = ['off', 'read', 'full'] as const
export const AiAgentPolicySchema = z.strictObject({ policy: z.enum(AI_AGENT_POLICIES) })
export type AiAgentPolicy = z.infer<typeof AiAgentPolicySchema>

/** Agent mode, per person (`GET`/`PUT /api/me/ai-agent`). */
export const AiAgentPreferenceSchema = z.strictObject({ on: z.boolean() })
export interface AiAgentPreference {
  on: boolean
  /** The person may use the assistant somewhere, and an administrator allows the agent (A2). */
  available: boolean
  /** The person may use the assistant at all — the agent aside (to say why the switch is off). */
  assistant: boolean
  /** What an administrator allows the agent on this server. */
  policy: AiAgentPolicy['policy']
}

/** A connection as the agent is told of it: by name, never its address or secrets. */
export interface AiAgentConnectionInfo {
  name: string
  access: Role
  readOnly: boolean
  policy: AiPolicy
  /** Agent writes allowed on it (an administrator can turn them off per connection). */
  writes: boolean
  defaultDatabase: string | null
  /** C5: the tools an administrator turned off on it. */
  toolsOff?: AiAgentTool[]
}

export type AiAgentStepState =
  'running' | 'awaiting' | 'done' | 'declined' | 'refused' | 'error' | 'expired' | 'cancelled'

/** Where a step acts. */
export interface AiAgentPlace {
  connectionId: string
  connection: string
  db?: string
  coll?: string
}

/** What a step's result handed to the provider ("Sent:" per step). */
export type AiAgentSentKind =
  'nothing' | 'names' | 'counts' | 'stats' | 'schema' | 'indexes' | 'plan' | 'documents' | 'outcome'

/** A proposed change, shown as a card before anything is written. */
export interface AiAgentProposal {
  /** Exactly what will be sent (canonical Extended JSON), masked where the person sees masks. */
  payload: unknown
  /**
   * Design 2026-10-25 (C4): a change that loses data offers a backup of what it would lose first
   * (encrypted, its password from the card), where the person may run one.
   */
  backup?: { scope: 'database' | 'collection'; db: string; coll?: string }
  /**
   * User request 2026-10-26: an encrypted backup the person may make without a password instead, as a
   * compressed archive (gzip) — offered where the route would take it (a destination that accepts
   * encrypted backups only, or personal data that cannot leave the server unencrypted, offers none).
   * `personal`: it would hold personal data in clear.
   */
  plain?: { personal: boolean }
  /** What the app's own preview found, where it has one. */
  preview?: {
    matched?: number
    total?: number
    exists?: boolean
    databaseExists?: boolean
    documents?: number
    collections?: number
    namespaces?: number
    nextRuns?: number[]
    words?: string | null
    format?: string
    /** A TTL index: the documents it would delete at once (security review I3). */
    expiring?: number
    /** Design 2026-10-25 (A3): a backup's kept copy is removed after this many hours. */
    expiresInHours?: number
    /** Where a backup is sent once kept (names), and whether the kept copy goes then. */
    destinations?: string[]
    deleteLocal?: boolean
    /** A4: what a schedule keeps of its backups. */
    retention?: RetentionPolicy
    /** A4: the zone a schedule's times are in (review of A4, M2: said on the card). */
    timeZone?: string
    /** B1: the backups a schedule's change removes now (its retention, zone or destinations). */
    removals?: number
    /** Review of B1: the schedule is paused — its new runs wait for it to be resumed. */
    paused?: boolean
    /** Review of B1: a schedule deleted keeps its backups. */
    backupsStay?: boolean
    /** B2: a restore's namespaces, the targets there already, and the documents a replace overwrites. */
    existing?: number
    lost?: number
    /** Review of B2: a replace overwrites a target whose count is not known. */
    lostUnknown?: boolean
    /** Review of B2: namespaces the plan leaves out, and what it warns of (codes). */
    skipped?: number
    warnings?: string[]
    /** Review of B2 (M9): the connection the backup was made of. */
    from?: string
    /** C3: a validator — the documents it would refuse now, of how many; whether it replaces or removes rules. */
    failing?: number
    failingUnknown?: boolean
    /** Review of C3 (M8): a level or an action other than the rules had. */
    level?: string
    levelWas?: string
    action?: string
    actionWas?: string
    /** The rules a validator replaces, as the person may see them (canonical Extended JSON). */
    currentRules?: Record<string, unknown>
    failingAtLeast?: boolean
    replaces?: boolean
    removes?: boolean
    /** C1: an export's count is a lower bound; its file compressed; a SQL file's dialect. */
    documentsAtLeast?: boolean
    /** C3: a copy's target — there already (with how many documents), the mode, masked as the person sees it. */
    targetExists?: boolean
    /** C3: the views that read a renamed collection, left reading nothing. */
    viewsLeft?: number
    /** C7: where an alert rule or a report is said (webhooks by name). */
    channels?: { inApp: boolean; email: boolean; webhooks: string[] }
    /** C7: how many counts a report says. */
    counts?: number
    /** C7: a rule snoozed for so many minutes from the click, or woken (null). */
    snoozeMinutes?: number | null
    targetDocuments?: number
    mode?: string
    masked?: boolean
    /** C1: an estimate (no filter). */
    documentsAbout?: boolean
    compressed?: boolean
    dialect?: string
    /** B4: how many roles a user dropped holds. */
    roles?: number
    /** B3: the operation a kill stops — its kind, namespace and how long it has run. */
    operation?: string
    namespace?: string
    secsRunning?: number
    /** Fourth review of B2 (I1): when the backup was made (two of one name told apart). */
    made?: number
    /** Fourth review of B2 (I2): the capped targets written into (a few), and how many more. */
    capped?: string[]
    cappedMore?: number
  }
  /** The name the person must type (a drop, or a change of every document). */
  typed?: string
  /** An encrypted backup asks the person for its password. */
  password?: boolean
  /** B4: the password asked is a new MongoDB user's (else a backup's). */
  passwordFor?: 'user'
  /** B2: the password opens a backup (one field, as the backup was made), not a new one. */
  opening?: boolean
  destructive?: boolean
}

export interface AiAgentStep {
  id: string
  tool: AiAgentTool
  kind: AiAgentToolKind
  place: AiAgentPlace | null
  state: AiAgentStepState
  /** Numbers and short words about the result (never document values). */
  summary?: Record<string, number | string | boolean>
  sent?: AiAgentSentKind
  /** How many documents' values went to the provider. */
  documents?: number
  reason?: string
  proposal?: AiAgentProposal
  /**
   * Design 2026-10-25 (B5): the read a find or an aggregation step made, for the panel to show its
   * documents from the person's own read. To the person's browser only: never kept with the turn,
   * never told to the provider.
   */
  results?: AiAgentResults
  /** C4: the plan a plan_changes step showed. */
  plan?: AiAgentPlan
  /** C4: the change of the turn's plan this step is (its place in the plan, from 0). */
  planItem?: number
  /** C4: the backup its card made before the change. */
  backup?: AiAgentStepBackup
}

/** C4: several changes shown first; each then comes on its own card, in this order. */
export interface AiAgentPlan {
  /** The model's words, shown to the person as text. */
  title: string
  changes: Array<{ tool: AiAgentTool; about: string }>
}

/** C4: a backup a card made before its change: running, made, or why not. */
export interface AiAgentStepBackup {
  state: 'running' | 'done' | 'error'
  job?: string
  reason?: string
}

/** B5: a step's read, as its route took it (canonical Extended JSON). */
export type AiAgentResults =
  | {
      kind: 'find'
      filter: Record<string, unknown>
      projection?: Record<string, unknown>
      sort?: Record<string, unknown>
      hint?: string | Record<string, unknown>
      limit: number
    }
  | { kind: 'aggregate'; stages: Record<string, unknown>[]; limit: number }

/** What a stored agent turn keeps about its steps (in clear: never values). */
export interface AiAgentStepRecord {
  tool: AiAgentTool
  connectionId: string | null
  namespace: string | null
  state: AiAgentStepState
  sent?: AiAgentSentKind
  /** How many documents' values went to the provider (a count: 2026-10-31, read again it said 0). */
  documents?: number
  /** What it found or did: counts and names only (never values, nor a route's own words). */
  summary?: Record<string, number | string | boolean>
  /** Why it was refused or failed: the code only (review of the history's steps, M4). */
  reason?: string
  /** C4: the plan a plan_changes step showed (the model's words, as the answer's are kept). */
  plan?: AiAgentPlan
  /** C4: the change of the turn's plan this step was. */
  planItem?: number
  /** C4: the backup its card made first (its state and job). */
  backup?: AiAgentStepBackup
}

/**
 * The AI database manager (design 2026-10-25, A1): what an opened collection shows — a find for its
 * documents, or a pipeline for its builder (one that writes never run on arrival). Canonical
 * Extended JSON; the person's own route runs it, with their rights and masking.
 */
export type AiAgentShow =
  | (Extract<AiResult, { kind: 'query' }> & { limit?: number })
  | (Extract<AiResult, { kind: 'pipeline' }> & { writes: boolean })

/** A page or tab the agent opened (UI only). */
export interface AiAgentOpen {
  connectionId: string
  db?: string
  coll?: string
  section?: AiAgentSection
  show?: AiAgentShow
}

export const AI_AGENT_NOTES = ['tools_unsupported', 'steps_limit', 'calls_limit', 'plan_unfinished'] as const
export type AiAgentNote = (typeof AI_AGENT_NOTES)[number]
