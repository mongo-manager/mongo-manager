// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyInstance } from 'fastify'
import type { Document } from 'mongodb'
import { z } from 'zod'
import {
  AI_AGENT_LIMITS,
  AI_LIMITS,
  BUILTIN_ROLES,
  BUILTIN_ROLE_NAMES,
  DEPLOYMENT_DBS,
  DatabaseNameSchema,
  EXTERNAL_DB,
  RoleRefSchema,
  UserNameSchema,
  isBroadRoleRef,
  agentToolKind,
  describeCadence,
  deserializeValue,
  findServerJs,
  parseShellExpression,
  serializeValue,
  stageOperator,
  type AiAgentConnectionInfo,
  type ValidationState,
  type ValidationTestResult,
  CollectionNameSchema,
  CreateSearchIndexSchema,
  type CopyPlan,
  ERROR_AND_LOG_SINCE,
  SearchIndexNameSchema,
  VECTOR_PROBLEMS,
  parseMongoVersion,
  vectorDefinitionProblem,
  type AiAgentOpen,
  type AiAgentShow,
  type AiAgentPlace,
  type AiAgentPlan,
  type AiAgentProposal,
  type AiAgentResults,
  type AiAgentSentKind,
  type AiAgentStepState,
  type AiAgentTool,
  type BackupView,
  type DumpPlan,
  type DumpReport,
  type RestorePlan,
  type JobView,
  type ExplainPlanNode,
  type DbRolesAnswer,
  type DbUserDetail,
  type DbUsersAnswer,
  type ExplainResult,
  type IndexAdvice,
  type Permission,
  type SlowQuery,
  type Role,
  type RetentionPolicy,
  type SchedulePreview,
  type ScheduleView,
  type SchedulesList,
  type SchemaAnalysis,
  MAX_STAGES,
  MAX_SCHEDULES_PER_USER,
  RETENTION_CONFIRM_ABOVE,
  RETENTION_PRESETS,
  ScheduleDumpSchema,
  TimeZoneSchema,
  AlertRuleInputSchema,
  ReportInputSchema,
  ReportPatchSchema,
  permissionsFor,
  type AlertChannels,
  type AlertChannelsView,
  type AlertRuleView,
  type AlertView,
  type ReportValue,
  type ReportView,
  type UiLanguage,
} from '@mongo-manager/shared'
import type { Principal, ServerContext } from '../../http/context'
import type { ConnectionRecord } from '../../connections/repo'
import { ConnectionError, type ConnectionErrorKind } from '../../connections/errors'
import { isRefusal } from '../../connections/manager'
import {
  mayExport,
  SYSTEM_DATABASES,
  hostsKeyVault,
  isAdminOnlyNamespace,
  isDrillScratch,
  isEncryptionNamespace,
  personOf,
  restrictedByOthers,
  unattended,
} from '../../connections/access'
import { isEncryptionMetadata } from '../../encryption/fields'
import type { ServerSample } from '../../monitor/sampler'
import type { OperationView, replicaView } from '../../routes/data/server'
import { LOWER_BOUND_LIMIT as VALIDATION_BOUND } from '../../routes/data/validation'
import { compileRules } from '../../masking/match'
import { gateDepsFor, viewAwareMasker } from '../../masking/restricted'
import {
  guardAggregate,
  guardBulkUpdate,
  guardCount,
  guardFind,
  guardIndexBuild,
  guardInsertUnique,
  guardValidator,
  keySorted,
  MASKING_UNSUPPORTED,
  type GateDeps,
} from '../../masking/gate'
import { sourceShape } from '../../masking/gate/pipeline'
import { newCtx } from '../../masking/gate/context'
import { planRefusal } from '../../masking/explain'
import { maskDocument } from '../../masking/document'
import { redactSecrets } from '../../masking/secrets'
import { maskAnalysis } from '../../masking/schema'
import { maskCommand } from '../../masking/command'
import { maskerForPrincipal } from '../../masking/request'
import { maskFilterDef } from '../../masking/definitions'
import { AppError } from '../../errors'
import { ownerOf } from '../../transfer/files'
import { isAdministrator, plainProblem } from '../../backup/schedules/policy'
import { mapLimited } from '../../backup/concurrency'
import { agentPolicy } from './policy'
import { ADMIN_ONLY_STAGES, REFUSED_STAGES, pipelineReads } from '../../aggregation/inspect'
import { aiMasker, cutDocument, summarise } from '../context'
import { callRoute, type AgentAuth, type RouteAnswer } from './calls'
import type { ChangeEnd, DecisionInput } from './runs'
import { TOOL_ARGS, type ToolArgs } from './tools'
import { SQL_PLUGIN } from '../../plugins/service'

/** A connection the agent may name: its label is unique among them. */
export interface AgentConnection {
  id: string
  label: string
  record: ConnectionRecord
  role: Role
  /** The person's permissions there, read-only mode applied. */
  permissions: ReadonlySet<Permission>
  /** The role's permissions without read-only mode (to say "read-only" rather than "not allowed"). */
  full: ReadonlySet<Permission>
  info: AiAgentConnectionInfo
}

export interface ToolEnv {
  app: FastifyInstance
  ctx: ServerContext
  principal: Principal
  /** The person, for the reads of this turn. */
  auth: AgentAuth
  connections: AgentConnection[]
  /**
   * W6.3 security review (I4): the connection as it is now — its policy, the agent-writes switch and
   * the person's rights read again on every call; null when the agent may no longer use it.
   */
  recheck(c: AgentConnection): AgentConnection | null
  /** Documents' values may go to the provider (the person's consent and the provider's permission). */
  documents: boolean
  language: UiLanguage
  /** Design 2026-10-25 (A4): the person's time zone, sent with the turn. */
  timeZone?: string
  /** C6: the step running says this meanwhile (a whole-collection scan, before it runs). */
  progress?: (summary: Record<string, number | string | boolean>) => void
  /** C6: a read about to scan a large collection (runTool tells the step and the model). */
  scanning?: (documents: number, reads: 'may' | 'all') => void
}

export interface StepPatch {
  place: AiAgentPlace | null
  state: AiAgentStepState
  summary?: Record<string, number | string | boolean>
  sent?: AiAgentSentKind
  documents?: number
  reason?: string
  /** B5: the read made, for the person's panel only. */
  results?: AiAgentResults
  /** C4: the plan a plan_changes step shows. */
  plan?: AiAgentPlan
}

/** C4: a backup made from a card, through the backup route as the person: its job, or why not. */
export type BackupStart = (auth: AgentAuth, password: string) => Promise<{ job: string } | { reason: string }>

/** A change, once the person answered: carried out through its route, as them. */
export type ChangeRun = (auth: AgentAuth, input: DecisionInput) => Promise<ChangeEnd>

export type ToolOutcome =
  | {
      type: 'result'
      step: StepPatch
      content: Record<string, unknown>
      touched?: string | readonly string[]
    }
  | {
      type: 'proposal'
      step: StepPatch
      proposal: AiAgentProposal
      run: ChangeRun
      touched: string
      /** C4: the backup the card offers, made on the person's asking. */
      backup?: BackupStart
    }
  | { type: 'open'; step: StepPatch; target: AiAgentOpen; content: Record<string, unknown> }

/** Why a tool did not run, said to the model as a code (and to the person in words). */
class Refusal extends Error {
  constructor(
    readonly reason: string,
    readonly hint?: string,
  ) {
    super(reason)
  }
}

const enc = encodeURIComponent
const connPath = (c: AgentConnection) => `/connections/${enc(c.id)}`
const dbPath = (c: AgentConnection, db: string) => `${connPath(c)}/databases/${enc(db)}`
const collPath = (c: AgentConnection, db: string, coll: string) => `${dbPath(c, db)}/collections/${enc(coll)}`
const placeOf = (c: AgentConnection, db?: string, coll?: string): AiAgentPlace => ({
  connectionId: c.id,
  connection: c.label,
  ...(db ? { db } : {}),
  ...(coll ? { coll } : {}),
})

/** The connection a name stands for: exactly, else the one name that differs in case only. */
export function connectionNamed(list: AgentConnection[], name: string): AgentConnection | null {
  const exact = list.find((c) => c.label === name)
  if (exact) return exact
  const folded = list.filter((c) => c.label.toLowerCase() === name.trim().toLowerCase())
  return folded.length === 1 ? folded[0]! : null
}

/** MongoDB text from the model: JSON or shell syntax, read by the safe evaluator; never run. */
function value(raw: unknown, what: string): unknown {
  try {
    if (typeof raw === 'string') return raw.trim() ? parseShellExpression(raw) : undefined
    return raw === undefined ? undefined : deserializeValue(raw)
  } catch {
    throw new Refusal('invalid_arguments', `${what} is not valid JSON`)
  }
}
const isPlain = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)

function objectArg(raw: unknown, what: string, fallback?: Record<string, unknown>): Record<string, unknown> {
  const v = value(raw, what)
  if (v === undefined && fallback) return fallback
  if (!isPlain(v)) throw new Refusal('invalid_arguments', `${what} must be an object`)
  return v
}
function stagesArg(raw: unknown): Record<string, unknown>[] {
  const v = value(raw, 'pipeline')
  if (!Array.isArray(v) || !v.every(isPlain) || v.length > AI_LIMITS.stages)
    throw new Refusal('invalid_arguments', 'pipeline must be an array of stages')
  return v
}
/** Security: the agent never runs JavaScript on the MongoDB server, wherever the server allows it. */
function noServerJs(...values: unknown[]): void {
  for (const v of values) if (v !== undefined && findServerJs(v)) throw new Refusal('server_js')
}
const writesAt = (stages: readonly unknown[]) =>
  stages.some((s) => ['$out', '$merge'].includes(stageOperator(s) ?? ''))
const wire = (v: unknown) => serializeValue(v) as Record<string, unknown>

/**
 * A connection failure's kind as a reason. Review of A5 (I1): one it cannot sort is "failed" —
 * connection_unknown is the agent's own refusal of a connection it may not use.
 */
const connectionReason = (kind: string): string =>
  kind === 'unknown' ? 'connection_failed' : `connection_${kind}`

/** A connection's SSH tunnel whose host key no one has pinned: the agent never takes one on. */
const unpinned = (c: AgentConnection): boolean =>
  !!c.record.settings.ssh?.enabled && !c.record.settings.ssh.hostFingerprint

/** Review of A5 (I2): what each connection's check found this turn — one dial a turn at most. */
// Review of C6: by the turn's own person (the env is copied for each call, its auth is the turn's).
const checkedIn = new WeakMap<AgentAuth, Map<string, string | null>>()

const TestAnswer = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    error: z.object({ kind: z.string().max(40), message: z.string().optional() }),
  }),
])

export function routeError(answer: RouteAnswer): Refusal {
  const body = answer.body as { code?: unknown; details?: { reason?: unknown; kind?: unknown } } | null
  const reason =
    typeof body?.details?.reason === 'string'
      ? body.details.reason
      : // Design 2026-10-25 (A5): a connection's failure by its kind (it said "mongo_error").
        body?.code === 'MONGO_ERROR' && typeof body.details?.kind === 'string'
        ? connectionReason(body.details.kind)
        : body?.code === 'UNSUPPORTED_SERVER'
          ? 'connection_unsupported'
          : answer.status === 403
            ? 'forbidden'
            : answer.status === 404
              ? 'not_found'
              : typeof body?.code === 'string'
                ? body.code.toLowerCase()
                : 'route_error'
  return new Refusal(reason)
}
/** The person's own words for a refusal the route gave them (to the panel only, never the model). */
function routeMessage(answer: RouteAnswer): string | undefined {
  const m = (answer.body as { message?: unknown } | null)?.message
  return typeof m === 'string' ? m.slice(0, 300) : undefined
}
async function read(
  env: ToolEnv,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<RouteAnswer> {
  const answer = await callRoute(env.app, env.auth, method, path, body)
  if (answer.status >= 400) {
    const e = routeError(answer)
    ;(e as { message: string }).message = routeMessage(answer) ?? e.reason
    throw e
  }
  return answer
}

/** A namespace whose documents never go to a provider (4a-1 §1.3, security audit 2026-10-16). */
function sendable(db: string, coll: string, c: AgentConnection): void {
  if (coll.startsWith('system.') || isAdminOnlyNamespace(db, coll)) throw new Refusal('credential_collection')
  // W8: nor client-side encryption's key vault and Queryable Encryption's metadata.
  if (isEncryptionMetadata(c.record.settings.encryption, db, coll)) throw new Refusal('credential_collection')
  // W4 re-review (minor): nor a restore drill's scratch copy of a backup.
  if (isDrillScratch(db)) throw new Refusal('system_namespace')
}

/** W8: document writes the agent never proposes where client-side encryption is on. */
const DOCUMENT_WRITES: ReadonlySet<AiAgentTool> = new Set<AiAgentTool>([
  'insert_documents',
  'update_documents',
  'delete_documents',
])

const WRITE_PERMISSION: Partial<Record<AiAgentTool, Permission>> = {
  create_database: 'databases:write',
  create_collection: 'databases:write',
  drop_collection: 'databases:write',
  drop_database: 'databases:write',
  insert_documents: 'documents:write',
  update_documents: 'documents:write',
  delete_documents: 'documents:write',
  create_index: 'indexes:write',
  drop_index: 'indexes:write',
  run_backup: 'jobs:run',
  // A4: a schedule runs backups as jobs of its owner.
  create_backup_schedule: 'jobs:run',
  // B2: as the restore route (which wants jobs:run too, checked with it).
  restore_backup: 'documents:write',
  // B3: as the kill route.
  kill_operation: 'server:operations',
  // B4: as the Database Access routes.
  create_user: 'databases:admin',
  // C3: as the Validation and Search indexes tabs.
  set_validator: 'databases:write',
  rename_collection: 'databases:write',
  copy_collection: 'documents:write',
  create_search_index: 'indexes:write',
  drop_user: 'databases:admin',
  // B1: as the schedules page — the owner's own, who runs backups (the routes let an owner pause or
  // delete theirs without it; the agent asks it of every change to a schedule, the safer way).
  run_schedule: 'jobs:run',
  pause_schedule: 'jobs:run',
  resume_schedule: 'jobs:run',
  update_schedule: 'jobs:run',
  delete_schedule: 'jobs:run',
}

/** Changes to backups and schedules: their namespaces are checked as their routes check them. */
const BACKUP_CHANGES = new Set<AiAgentTool>([
  'run_backup',
  'create_backup_schedule',
  'run_schedule',
  'pause_schedule',
  'resume_schedule',
  'update_schedule',
  'delete_schedule',
])

/**
 * Before any change is proposed: the connection allows the agent's writes, the person may make this
 * change there (read-only mode said as such), and it is not one of MongoDB's own namespaces. The
 * route checks every right again when the person confirms.
 */
function mayChange(tool: AiAgentTool, c: AgentConnection, db?: string, coll?: string): void {
  if (!c.record.aiAgentWrites) throw new Refusal('agent_writes_off')
  // Review of C5 (I1): on the connection the change resolved — a schedule's own, a restore's target.
  if (c.record.aiAgentToolsOff.includes(tool)) throw new Refusal('tool_off')
  const needed = WRITE_PERMISSION[tool]
  if (needed && !c.permissions.has(needed)) throw new Refusal(c.full.has(needed) ? 'read_only' : 'forbidden')
  // W8: the agent's routes read and write as stored (nothing decrypted for a provider), so its
  // document writes would not be encrypted: none is proposed where client-side encryption is on.
  if (DOCUMENT_WRITES.has(tool) && c.record.settings.encryption?.enabled)
    throw new Refusal('encrypted_connection')
  if (!BACKUP_CHANGES.has(tool)) {
    if (db && (SYSTEM_DATABASES.has(db) || isDrillScratch(db))) throw new Refusal('system_namespace')
    if (coll?.startsWith('system.')) throw new Refusal('system_namespace')
    // W8 re-review: the key vault and Queryable Encryption metadata are never changed by the agent,
    // nor the database holding a key vault dropped (every data key would go with it), whoever asks.
    if (db && coll && isEncryptionNamespace(db, coll)) throw new Refusal('system_namespace')
    if (tool === 'drop_database' && db && hostsKeyVault(db)) throw new Refusal('system_namespace')
  }
}

/** What a restricted person sees of a payload: their masks, as on screen (W6.3 §3). */
function shownTo(
  env: ToolEnv,
  c: AgentConnection,
  db: string,
  coll: string,
  command: Record<string, unknown>,
) {
  const masker = maskerForPrincipal(env.ctx, env.principal, c.id)
  return masker ? (maskCommand(command, db, coll, masker) as Record<string, unknown>) : command
}

/** Documents for the provider: the rules for everyone over what the person may see, cut and bounded. */
async function forModel(
  env: ToolEnv,
  c: AgentConnection,
  db: string,
  coll: string,
  docs: unknown[],
  query: { find: { filter: Document; projection?: Document; sort?: Document } } | { stages: Document[] },
): Promise<string[] | null> {
  const { rules } = env.ctx.personalFields.get(c.id)
  const out = (masked: (d: unknown) => unknown) =>
    docs.map((d) => cutDocument(deserializeValue(redactSecrets(masked(d))), AI_LIMITS.sampleBytes))
  if (!ruled(rules, db)) return out((d) => d)
  const release = env.ctx.manager.hold(c.id)
  try {
    const client = await env.ctx.manager.getClient(c.id, { user: personOf(env.principal) })
    const deps = gateDepsFor(compileRules(rules), client)
    // The rules follow the query's output (a renamed or computed field keeps its rule); a query the
    // rules cannot follow sends no values at all.
    const output =
      'stages' in query
        ? (await guardAggregate(db, coll, query.stages, deps, { order: false })).output
        : (await guardFind(db, coll, query.find, deps, { order: false })).output
    return out((d) => maskDocument(d, output))
  } catch {
    return null
  } finally {
    release()
  }
}

/** A tool result within its bound: the longest list in it is halved until it fits. */
function bounded(content: Record<string, unknown>): Record<string, unknown> {
  const size = () => Buffer.byteLength(JSON.stringify(content))
  while (size() > AI_AGENT_LIMITS.resultBytes) {
    const lists = Object.entries(content).filter(([, v]) => Array.isArray(v) && v.length > 0) as Array<
      [string, unknown[]]
    >
    if (!lists.length) return { truncated: true, note: 'The result was too large to send' }
    const [key, list] = lists.sort((a, b) => JSON.stringify(b[1]).length - JSON.stringify(a[1]).length)[0]!
    content[key] = list.slice(0, Math.floor(list.length / 2))
    content.truncated = true
  }
  return content
}

const stripPlan = (n: ExplainPlanNode | null): unknown =>
  n
    ? {
        stage: n.stage,
        ...(n.indexName ? { index: n.indexName } : {}),
        ...(n.keyPattern ? { keys: n.keyPattern } : {}),
        ...(n.direction ? { direction: n.direction } : {}),
        ...(n.isMultiKey ? { multiKey: true } : {}),
        ...(n.children?.length ? { children: n.children.map(stripPlan) } : {}),
      }
    : null

const DOCS_NOT_ALLOWED =
  'The documents’ values were not sent to you: the person did not allow documents for this message. Say what you found in numbers, or ask them to allow documents.'

type Handler = (env: ToolEnv, args: never) => Promise<ToolOutcome>
const result = (
  step: StepPatch,
  content: Record<string, unknown>,
  touched?: string | readonly string[],
): ToolOutcome => ({
  type: 'result',
  step,
  content: bounded(content),
  ...(touched ? { touched } : {}),
})

function need(env: ToolEnv, name: string, dials = true): AgentConnection {
  const named = connectionNamed(env.connections, name)
  // W6.3 security review (I4): read again now — a policy turned off mid-turn stops the next call.
  const c = named ? env.recheck(named) : null
  if (!c) throw new Refusal('connection_unknown')
  // Review of A5 (I3): a host key no one has looked at is never pinned by the agent's dial.
  if (dials && unpinned(c)) throw new Refusal('connection_ssh-host-key')
  return c
}

/** The gate's lookups on a connection's client, for the time of `use` (the connection held). */
async function withDeps<T>(
  env: ToolEnv,
  c: AgentConnection,
  rules: Parameters<typeof compileRules>[0],
  use: (deps: GateDeps) => Promise<T>,
): Promise<T> {
  const release = env.ctx.manager.hold(c.id)
  try {
    return await use(
      gateDepsFor(
        compileRules(rules),
        await env.ctx.manager.getClient(c.id, { user: personOf(env.principal) }),
      ),
    )
  } finally {
    release()
  }
}

const MAX_SOURCES = 50

/**
 * W6.3 re-review (N1), ruling: stages that read other clients' queries ($planCacheStats, $queryStats,
 * $listSampledQueries, $querySettings, $currentOp, the sessions) or the catalog with its validators and
 * view pipelines ($listCatalog, $listClusterCatalog) are never run for the agent, at any depth — they
 * answer whatever the connection's rules say. $indexStats and $collStats carry the server's address
 * (never sent to a provider); their counts come from list_indexes and collection_stats instead.
 * $shardedDataDistribution (names and counts) stays allowed.
 */
const DIAGNOSTIC_STAGES: ReadonlySet<string> = new Set([
  ...ADMIN_ONLY_STAGES,
  ...REFUSED_STAGES,
  '$indexStats',
  '$collStats',
])

/**
 * W6.3 security review (I1): what a read reaches, never MongoDB's own collections — its collection,
 * every namespace its pipeline reads ($lookup, $graphLookup, $unionWith, $facet, at any depth), and
 * through views, each view's source and the namespaces its pipeline reads, all the way down.
 */
async function sourcesAllowed(
  env: ToolEnv,
  c: AgentConnection,
  db: string,
  coll: string,
  stages: readonly unknown[] = [],
): Promise<void> {
  const reads = (s: readonly unknown[], at: string) => {
    let diagnostic = false
    let found: Array<{ db: string; coll: string }> | null = null
    try {
      found = pipelineReads(s, at, (op) => {
        if (DIAGNOSTIC_STAGES.has(op)) diagnostic = true
      })
    } catch {
      // A malformed pipeline is said as such, unless it held a diagnostic stage (said first).
    }
    if (diagnostic) throw new Refusal('diagnostic_stage')
    if (!found) throw new Refusal('invalid_arguments', 'The pipeline is not valid')
    return found
  }
  const queue = [{ db, coll }, ...reads(stages, db)]
  for (const ns of queue) sendable(ns.db, ns.coll, c)
  await withDeps(env, c, [], async (deps) => {
    const seen = new Set<string>()
    while (queue.length) {
      const ns = queue.shift()!
      const key = `${ns.db}.${ns.coll}`
      if (seen.has(key)) continue
      seen.add(key)
      if (seen.size > MAX_SOURCES) throw new Refusal('invalid_arguments', 'Too many views to follow')
      // W6.3 re-review (minor 2): a catalog that cannot be read proves nothing — refused, not assumed.
      const view = await deps.view(ns.db, ns.coll).catch(() => {
        throw new Refusal('source_unknown')
      })
      if (!view) continue
      const next = [{ db: ns.db, coll: view.viewOn }, ...reads(view.pipeline, ns.db)]
      for (const n of next) sendable(n.db, n.coll, c)
      queue.push(...next)
    }
  })
}

/**
 * W6.3 security review (I2): a count, a match or an order on a personal field answers about its
 * values (a prefix at a time), whatever is withheld from the answer. The model's filter, sort,
 * pipeline or index is checked by the masking gate against the connection's rules — for everyone,
 * as what is sent to a provider is — and refused before anything runs when it touches one.
 */
type AiQuery =
  | { find: { filter: Document; projection?: Document; sort?: Document } }
  | { stages: Document[] }
  | { filter: Document }
  | { update: { filter: Document; update: Document | Document[] } }
  | { view: { viewOn: string; stages: Document[] } }
  | { insert: Document[] }
  | { index: { key: Record<string, unknown>; options: Record<string, unknown> } }
  // C3: a validator (checked as the Validation tab checks one), a search index (it copies values).
  | { validator: Document }
  | { searchIndex: true }
/**
 * Final review of explain masking (P-1): what the gate would run in its place. The gate rewrites a
 * query as often as it refuses one (a comparison of what may hold a hidden value, a sort checked
 * page by page, the order a hidden value gives): a check alone would let the model run the original
 * as a person no rule hides anything from. So for that person a find, a count, an update or a view
 * the gate would rewrite is refused, and the order it gives (a find's sort and hint, a pipeline's
 * stages) is what is run or explained. A restricted person's own route applies the rewrite itself;
 * what the gate refuses is refused to everyone.
 */
interface Guarded {
  /** No rule hides anything from the person: their routes run what they are sent, ungated. */
  open: boolean
  find?: { sort?: Document; hint?: string | Document }
  stages?: Document[]
}
/** Two values alike, whatever their keys' order (the gate rebuilds a `$let` or a `$map` in its own). */
// Review of C3b (nit): the gate's own (its values are serialized first: plain objects only).
const canonical = keySorted
const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(serializeValue(a ?? null))) ===
  JSON.stringify(canonical(serializeValue(b ?? null)))
async function gated(
  env: ToolEnv,
  c: AgentConnection,
  db: string,
  coll: string,
  q: AiQuery,
): Promise<Guarded> {
  const open = !maskerForPrincipal(env.ctx, env.principal, c.id)
  const { rules } = env.ctx.personalFields.get(c.id)
  // A key vault's own rules apply with none (final review of the agent's gate, M-5).
  if (!ruled(rules, db)) return { open }
  const rewritten = (hint?: string) => {
    if (open) throw new Refusal('personal_field', hint)
  }
  try {
    return await withDeps(env, c, rules, async (deps): Promise<Guarded> => {
      if ('find' in q) {
        const g = await guardFind(db, coll, q.find, deps)
        if (
          !sameValue(g.filter, q.find.filter) ||
          !sameValue(g.projection, q.find.projection) ||
          g.checked.length > 0 ||
          g.repeats
        )
          rewritten()
        return {
          open,
          find: { ...(g.sort ? { sort: g.sort } : {}), ...(g.hint !== undefined ? { hint: g.hint } : {}) },
        }
      }
      if ('stages' in q) {
        const stages = (await guardAggregate(db, coll, q.stages, deps)).stages
        // Final review of the agent's gate (M-2): what the gate adds counts toward the routes' bound.
        if (open && stages.length > MAX_STAGES)
          throw new Refusal(
            'invalid_arguments',
            `the pipeline needs more than ${MAX_STAGES} stages once personal data is checked: use fewer`,
          )
        return { open, stages }
      }
      // Review of C3 (I7): a validator as the Validation tab checks one, for everyone — and as the count
      // of documents breaking it reads it.
      if ('validator' in q) {
        // Re-review of C3 (minor 2): said what to change where rules apply.
        await guardValidator(db, coll, q.validator, deps).catch((e: unknown) => {
          if (
            e instanceof AppError &&
            (e.details as { reason?: unknown } | undefined)?.reason === MASKING_UNSUPPORTED
          )
            throw new Refusal(
              'personal_field',
              'where personal-data rules apply, rules are a query naming no personal field, without $expr or $jsonSchema',
            )
          throw e
        })
        const g = await guardCount(db, coll, q.validator, undefined, deps)
        if (!sameValue(g.filter, q.validator)) rewritten()
        return { open }
      }
      // Review of C3 (I5): a search index copies the values of what it maps into the search engine —
      // none where personal-data rules apply to the collection (or a view's source), for anyone.
      if ('searchIndex' in q) {
        if ((await sourceShape(db, coll, newCtx(deps, db))).any)
          throw new Refusal('personal_field', 'a search index would copy personal values where rules apply')
        return { open }
      }
      if ('filter' in q) {
        const g = await guardCount(db, coll, q.filter, undefined, deps)
        if (!sameValue(g.filter, q.filter)) rewritten()
        return { open }
      }
      // Final review of the agent's gate (I-2): a change copies, compares or keeps what is hidden as
      // a read does (an update from "$profile.email", a $max over a sub-document holding one), and a
      // view's pipeline is what a read of it runs.
      if ('update' in q) {
        const g = await guardBulkUpdate(db, coll, q.update.filter, q.update.update, deps)
        if (!sameValue(g.filter, q.update.filter) || !sameValue(g.update, q.update.update)) rewritten()
        return { open }
      }
      // Final reviews of the agent's gate (I-1, M-2, M-3): a stored view runs as it is, its $limit,
      // $skip, groups or joins in the order MongoDB reads, and lives on past today's indexes. What it
      // reads is checked as any pipeline; where a stage depends on the order documents come in, it is
      // checked in the gate's order whatever the indexes, and refused where that adds one.
      if ('view' in q) {
        const plain = await guardAggregate(db, q.view.viewOn, q.view.stages, deps, { order: false })
        if (!sameValue(plain.stages, q.view.stages)) rewritten()
        if (q.view.stages.some((s) => !ORDER_FREE.has(Object.keys(s)[0] ?? ''))) {
          const ordered = await guardAggregate(db, q.view.viewOn, q.view.stages, deps, { order: 'always' })
          if (!sameValue(ordered.stages, q.view.stages)) rewritten(VIEW_ORDER)
        }
        return { open }
      }
      // Final review of the agent's gate (M-2): to everyone, as a duplicate key answers it.
      if ('insert' in q) {
        try {
          await guardInsertUnique(db, coll, q.insert, deps)
        } catch (e) {
          // The hint where a unique index refused it, not where its namespace did (nits).
          if (e instanceof AppError && e.statusCode === 403 && !flagged(e, 'indexes'))
            throw new Refusal('personal_field', flagged(e, 'unique') ? UNIQUE : undefined)
          throw e
        }
        return { open }
      }
      await guardIndexBuild(db, coll, q.index.key, q.index.options as never, deps)
      return { open }
    })
  } catch (e) {
    if (e instanceof Refusal) throw e
    // Indexes that could not be read are said as such, not as a personal field (nit).
    if (e instanceof AppError && flagged(e, 'indexes')) throw new Refusal('indexes_unread')
    if (e instanceof AppError && e.statusCode === 403) throw new Refusal('personal_field')
    if (e instanceof AppError) throw new Refusal('invalid_arguments')
    throw e
  }
}
const decoded = (v: unknown) => deserializeValue<Document>(serializeValue(v))
/** A gate refusal's flag (a unique index, indexes that could not be read). */
const flagged = (e: AppError, flag: 'unique' | 'indexes') =>
  (e.details as Record<string, unknown> | undefined)?.[flag] === true
/** The connection's rules, for everyone: what is sent to a provider (W6.3). */
const everyone = (env: ToolEnv, c: AgentConnection) => compileRules(env.ctx.personalFields.get(c.id).rules)
/** Rules apply in the database: the connection's, or a key vault's own (they apply with none). */
const ruled = (rules: Parameters<typeof compileRules>[0], db: string) =>
  rules.length > 0 || compileRules(rules).anyInDb(db)
/** Stages whose output does not depend on the order documents come in. */
const ORDER_FREE = new Set([
  '$match',
  '$project',
  '$addFields',
  '$set',
  '$unset',
  '$replaceRoot',
  '$replaceWith',
  '$redact',
  '$sort',
  '$count',
  '$unwind',
  '$sortByCount',
])
const VIEW_ORDER =
  'A stored view runs in the order MongoDB reads, which may follow hidden personal data: begin it, and each join’s own pipeline, with { $sort: { _id: 1 } }, or leave out $limit, $skip, groups and joins. Where _id may hold a hidden value, the source is a time series, the collation folds _ids, it begins with $geoNear or a $graphLookup reads ruled data, no order makes it storable.'
const UNIQUE =
  'A unique index over personal data would tell, by a duplicate key, whether a stored document holds this value: leave that value out.'
const REORDERED = {
  rewritten:
    'An index here may order by hidden personal data: the query is explained with the gate’s own order added (an _id tie-break or the natural order).',
}
const SIZES = ['size', 'storageSize', 'avgObjSize', 'totalIndexSize']
const REWRITTEN = {
  rewritten:
    'Fields here may hold hidden personal data: the pipeline runs with them compared, grouped or sorted as "***", or in a random order. Its answer is not what the pipeline as written would give.',
}
/** A change's gate, asked again when the person confirms it: rules may have changed meanwhile. */
async function gatedAgain(
  env: ToolEnv,
  c: AgentConnection,
  db: string,
  coll: string,
  q: AiQuery,
): Promise<ChangeEnd | null> {
  try {
    await gated(env, c, db, coll, q)
    return null
  } catch (e) {
    if (e instanceof Refusal) return { state: 'error', reason: e.reason }
    throw e
  }
}

/**
 * W6.3 security review (I3): how many documents a TTL index would delete at once — those whose date
 * is already past the index's age (MongoDB's TTL monitor runs every minute, on the server's clock).
 * Only a single-field key expires documents. Undefined when it cannot be counted (the card still
 * asks for the name).
 */
async function expiringNow(
  env: ToolEnv,
  c: AgentConnection,
  db: string,
  coll: string,
  key: Record<string, unknown>,
  seconds: number,
  partial: Record<string, unknown> | undefined,
): Promise<number | undefined> {
  const fields = Object.keys(key)
  if (fields.length !== 1) return 0
  const before = { [fields[0]!]: { $lt: new Date(Date.now() - seconds * 1000) } }
  const filter = partial ? { $and: [before, partial] } : before
  const answer = await callRoute(env.app, env.auth, 'POST', `${collPath(c, db, coll)}/count`, {
    filter: wire(filter),
  })
  const body = answer.body as { count?: number | null; atLeast?: number } | null
  return answer.status < 300 ? (body?.count ?? body?.atLeast ?? undefined) : undefined
}

const HANDLERS: Record<AiAgentTool, Handler> = {
  list_connections: async (env) => {
    // W6.3 security review (I4): as they are now — one turned off since the turn began is not listed.
    const now = env.connections.flatMap((c) => env.recheck(c) ?? [])
    const person = personOf(env.principal)
    // Design 2026-10-25 (A5): whether each is open now, and a refusal kept for it — never a dial.
    const reach = (c: AgentConnection) => {
      const problem = unpinned(c) ? 'ssh-host-key' : env.ctx.manager.refusalOf(c.id, person)?.kind
      return { open: env.ctx.manager.openNow(c.id, person), ...(problem ? { problem } : {}) }
    }
    return result(
      { place: null, state: 'done', sent: 'names', summary: { connections: now.length } },
      { connections: now.map((c) => ({ ...c.info, ...reach(c) })) },
    )
  },

  /**
   * Design 2026-10-25 (A5): whether a connection answers, through the app's own test — then opened
   * as the person opening it would (its databases read), so the app shows it connected. Only the
   * kind of a failure goes back: never its words, an address or a port.
   */
  check_connection: async (env, a: ToolArgs<'check_connection'>) => {
    const c = need(env, a.connection, false)
    const answer = (problem: string | null) => {
      const told: Record<string, string | boolean> =
        problem === null ? { connected: true } : { connected: false, problem }
      return result({ place: placeOf(c), state: 'done', sent: 'outcome', summary: told }, told, c.id)
    }
    if (unpinned(c)) return answer('ssh-host-key')
    let checked = checkedIn.get(env.auth)
    if (!checked) checkedIn.set(env.auth, (checked = new Map()))
    // Re-review of A5 (M-c): by the connection as it is now — an edit meanwhile is checked afresh.
    const key = `${c.id}:${c.record.updatedAt}`
    const before = checked.get(key)
    if (before !== undefined) return answer(before)
    const problem = await checkOnce(env, c)
    // N-a: a test that never dialled (busy, the app closing) says nothing of the server.
    if (problem !== 'busy' && problem !== 'closed') checked.set(key, problem)
    return answer(problem)
  },

  list_databases: async (env, a: ToolArgs<'list_databases'>) => {
    const c = need(env, a.connection)
    const answer = await read(env, 'GET', `${connPath(c)}/databases`)
    const list = (
      (answer.body as { databases?: Array<{ name: string; sizeOnDisk: number | null; empty: boolean }> })
        .databases ?? []
    ).filter((d) => !SYSTEM_DATABASES.has(d.name) && !isDrillScratch(d.name))
    const rules = everyone(env, c)
    return result(
      { place: placeOf(c), state: 'done', sent: 'names', summary: { databases: list.length } },
      // Twelfth review of explain masking (nit): a null size the model is told is hidden.
      // Final review of the agent's gate (M-5): where rules apply, sizes are hidden from the provider
      // as from a restricted person (they tell the length of what is hidden), whoever asks.
      {
        databases: list.map((d) => {
          const size = rules.anyInDb(d.name) ? null : d.sizeOnDisk
          return {
            name: d.name,
            sizeOnDisk: size,
            empty: d.empty,
            ...(size === null ? { sizeHidden: true } : {}),
          }
        }),
      },
      c.id,
    )
  },

  list_collections: async (env, a: ToolArgs<'list_collections'>) => {
    const c = need(env, a.connection)
    const answer = await read(env, 'GET', `${dbPath(c, a.database)}/collections`)
    const list = (answer.body as Array<{ name: string; type: string }> | null) ?? []
    return result(
      { place: placeOf(c, a.database), state: 'done', sent: 'names', summary: { collections: list.length } },
      { collections: list.map((x) => ({ name: x.name, type: x.type })) },
      c.id,
    )
  },

  collection_stats: async (env, a: ToolArgs<'collection_stats'>) => {
    const c = need(env, a.connection)
    await sourcesAllowed(env, c, a.database, a.collection)
    const s = (await read(env, 'GET', `${collPath(c, a.database, a.collection)}/stats`)).body as Record<
      string,
      unknown
    >
    const { rules } = env.ctx.personalFields.get(c.id)
    const hidden =
      ruled(rules, a.database) &&
      (await withDeps(
        env,
        c,
        rules,
        async (deps) =>
          (await viewAwareMasker(compileRules(rules), deps, [[a.database, a.collection]])).forNs(
            a.database,
            a.collection,
          ).any,
      ))
    // Twelfth review of explain masking (nit): a null size the model is told is hidden, not unknown.
    const pick = [
      'count',
      'size',
      'storageSize',
      'avgObjSize',
      'totalIndexSize',
      'nindexes',
      'capped',
      'sizesHidden',
    ]
    return result(
      {
        place: placeOf(c, a.database, a.collection),
        state: 'done',
        sent: 'stats',
        summary: { count: Number(s.count ?? 0) },
      },
      // Final review of the agent's gate (M-5): no size where rules apply there, whoever asks (as the
      // route judges it: a view by its source, a GridFS bucket's chunks whole).
      hidden
        ? {
            ...Object.fromEntries(pick.filter((k) => k in s).map((k) => [k, s[k]])),
            ...Object.fromEntries(SIZES.map((k) => [k, null])),
            sizesHidden: true,
          }
        : Object.fromEntries(pick.filter((k) => k in s).map((k) => [k, s[k]])),
      c.id,
    )
  },

  find_documents: async (env, a: ToolArgs<'find_documents'>) => {
    const c = need(env, a.connection)
    const filter = objectArg(a.filter, 'filter', {})
    const projection = a.projection === undefined ? undefined : objectArg(a.projection, 'projection')
    const sort = a.sort === undefined ? undefined : objectArg(a.sort, 'sort')
    noServerJs(filter, projection, sort)
    await sourcesAllowed(env, c, a.database, a.collection)
    const guarded = await gated(env, c, a.database, a.collection, {
      find: {
        filter: decoded(filter),
        ...(projection ? { projection: decoded(projection) } : {}),
        ...(sort ? { sort: decoded(sort) } : {}),
      },
    })
    // A person no rule hides anything from reads ungated: the gate's order is sent with the query
    // (a restricted person's own read takes it already; final review, P-1).
    const order = guarded.find && guarded.open ? guarded.find : null
    const limit = a.limit ?? AI_AGENT_LIMITS.documents
    // B5: the read as the route takes it — the panel makes the same one, as the person.
    const asked = {
      filter: wire(filter),
      ...(projection ? { projection: wire(projection) } : {}),
      ...(order ? (order.sort ? { sort: wire(order.sort) } : {}) : sort ? { sort: wire(sort) } : {}),
      ...(order?.hint !== undefined
        ? { hint: typeof order.hint === 'string' ? order.hint : wire(order.hint) }
        : {}),
      limit,
    } as Omit<Extract<AiAgentResults, { kind: 'find' }>, 'kind'>
    // C6: a filter or an order over a large collection is explained first; a whole scan said.
    await scanAhead(
      env,
      c,
      a.database,
      a.collection,
      {
        kind: 'find',
        filter: asked.filter,
        ...(asked.sort ? { sort: asked.sort } : {}),
        ...(asked.hint !== undefined ? { hint: asked.hint } : {}),
        // Review of C6 (I2): the plan of the read as it runs, its limit with it.
        limit,
      },
      Object.keys(filter).length > 0 || asked.sort !== undefined ? 'may' : 'none',
    )
    const answer = await read(env, 'POST', `${collPath(c, a.database, a.collection)}/find`, {
      ...asked,
      record: false,
    })
    const results: AiAgentResults = { kind: 'find', ...asked }
    const page = answer.body as { documents: Array<{ document?: unknown }>; hasMore: boolean }
    const docs = page.documents.flatMap((d) => ('document' in d ? [d.document] : []))
    const place = placeOf(c, a.database, a.collection)
    const shown = env.documents
      ? await forModel(env, c, a.database, a.collection, docs, {
          find: {
            filter: deserializeValue<Document>(wire(filter)),
            ...(projection ? { projection: deserializeValue<Document>(wire(projection)) } : {}),
            ...(sort ? { sort: deserializeValue<Document>(wire(sort)) } : {}),
          },
        })
      : null
    const summary = { returned: docs.length, more: page.hasMore }
    if (!shown)
      return result(
        { place, state: 'done', sent: 'counts', summary, results },
        {
          found: docs.length,
          more: page.hasMore,
          note: env.documents
            ? 'The documents touch personal fields the rules cannot follow: their values were not sent.'
            : DOCS_NOT_ALLOWED,
        },
        c.id,
      )
    return result(
      { place, state: 'done', sent: 'documents', documents: shown.length, summary, results },
      { found: docs.length, more: page.hasMore, documents: shown },
      c.id,
    )
  },

  count_documents: async (env, a: ToolArgs<'count_documents'>) => {
    const c = need(env, a.connection)
    const filter = objectArg(a.filter, 'filter', {})
    noServerJs(filter)
    await sourcesAllowed(env, c, a.database, a.collection)
    await gated(env, c, a.database, a.collection, { filter: decoded(filter) })
    // C6: a count with a filter reads what it matches (none: the collection's own estimate).
    if (Object.keys(filter).length)
      await scanAhead(env, c, a.database, a.collection, { kind: 'find', filter: wire(filter) }, 'all')
    const body = (
      await read(env, 'POST', `${collPath(c, a.database, a.collection)}/count`, { filter: wire(filter) })
    ).body as { count: number | null; exact: boolean; atLeast?: number }
    return result(
      {
        place: placeOf(c, a.database, a.collection),
        state: 'done',
        sent: 'counts',
        summary: { count: body.count ?? body.atLeast ?? 0 },
      },
      {
        count: body.count,
        exact: body.exact,
        ...(body.atLeast !== undefined ? { atLeast: body.atLeast } : {}),
      },
      c.id,
    )
  },

  analyze_schema: async (env, a: ToolArgs<'analyze_schema'>) => {
    const c = need(env, a.connection)
    await sourcesAllowed(env, c, a.database, a.collection)
    const analysis = (
      await read(env, 'POST', `${collPath(c, a.database, a.collection)}/schema`, {
        sampleSize: AI_LIMITS.schemaSample,
      })
    ).body as SchemaAnalysis
    // The rules for everyone (4a-1 §1.3): personal paths named, nothing below them, never values.
    const release = env.ctx.manager.hold(c.id)
    let summary
    try {
      const client = await env.ctx.manager.getClient(c.id, { user: personOf(env.principal) })
      const ns = (await aiMasker(env.ctx, client, c.id, a.database, a.collection)).forNs(
        a.database,
        a.collection,
      )
      summary = summarise(maskAnalysis(analysis, ns), null, AI_LIMITS.schemaPaths)
    } finally {
      release()
    }
    return result(
      {
        place: placeOf(c, a.database, a.collection),
        state: 'done',
        sent: 'schema',
        summary: { fields: summary.fields.length, sampled: summary.sampled },
      },
      { schema: summary },
      c.id,
    )
  },

  list_indexes: async (env, a: ToolArgs<'list_indexes'>) => {
    const c = need(env, a.connection)
    // W6.3 security review (minor 5): as every read of a collection.
    await sourcesAllowed(env, c, a.database, a.collection)
    const list = ((await read(env, 'GET', `${collPath(c, a.database, a.collection)}/indexes`)).body ??
      []) as Array<{
      name: string
      key: unknown
      options: Record<string, unknown>
    }>
    // Names, keys and flags — a partial filter as a flag (4a-1 plan ruling 6).
    const indexes = list.map((i) => ({
      name: i.name,
      keys: i.key,
      ...(i.options.unique ? { unique: true } : {}),
      ...(i.options.sparse ? { sparse: true } : {}),
      ...(i.options.hidden ? { hidden: true } : {}),
      ...(i.options.expireAfterSeconds !== undefined ? { ttl: true } : {}),
      ...(i.options.partialFilterExpression ? { partial: true } : {}),
    }))
    return result(
      {
        place: placeOf(c, a.database, a.collection),
        state: 'done',
        sent: 'indexes',
        summary: { indexes: indexes.length },
      },
      { indexes },
      c.id,
    )
  },

  explain_query: async (env, a: ToolArgs<'explain_query'>) => {
    const c = need(env, a.connection)
    let body: Record<string, unknown>
    let explained: Record<string, string> = {}
    if (a.pipeline !== undefined) {
      const stages = stagesArg(a.pipeline)
      noServerJs(stages)
      if (writesAt(stages)) throw new Refusal('write_pipeline')
      await sourcesAllowed(env, c, a.database, a.collection, stages)
      const guarded = await gated(env, c, a.database, a.collection, { stages: stages.map(decoded) })
      // Final review of the agent's gate (I-1): what is explained is what would run.
      const run = guarded.stages && guarded.open ? guarded.stages.map(wire) : wire(stages)
      if (guarded.stages && !sameValue(guarded.stages, stages.map(decoded))) explained = REWRITTEN
      body = { kind: 'aggregate', stages: run, verbosity: 'queryPlanner', maxTimeMS: 10_000 }
    } else {
      const filter = objectArg(a.filter, 'filter', {})
      const sort = a.sort === undefined ? undefined : objectArg(a.sort, 'sort')
      noServerJs(filter, sort)
      await sourcesAllowed(env, c, a.database, a.collection)
      const guarded = await gated(env, c, a.database, a.collection, {
        find: { filter: decoded(filter), ...(sort ? { sort: decoded(sort) } : {}) },
      })
      const order = guarded.find && guarded.open ? guarded.find : null
      // Final review of the agent's gate (nit): said where the gate added an order.
      if (
        guarded.find &&
        ((guarded.find.sort !== undefined &&
          !sameValue(guarded.find.sort, sort ? decoded(sort) : undefined)) ||
          guarded.find.hint !== undefined)
      )
        explained = REORDERED
      body = {
        kind: 'find',
        filter: wire(filter),
        ...(order ? (order.sort ? { sort: wire(order.sort) } : {}) : sort ? { sort: wire(sort) } : {}),
        ...(order?.hint !== undefined
          ? { hint: typeof order.hint === 'string' ? order.hint : wire(order.hint) }
          : {}),
        verbosity: 'queryPlanner',
        maxTimeMS: 10_000,
      }
    }
    const view = (await read(env, 'POST', `${collPath(c, a.database, a.collection)}/explain`, body))
      .body as ExplainResult
    // Final review of the agent's gate (I-1): a plan that reads an index holding personal data is
    // sent to no one (its keys, its multikey paths), as the route refuses it to a restricted person.
    // The plan as MongoDB gave it, as the route checks it (final review of the agent's gate, M-3).
    const { rules } = env.ctx.personalFields.get(c.id)
    if (ruled(rules, a.database)) {
      const refused = await withDeps(env, c, rules, (deps) =>
        planRefusal(deserializeValue(view.raw), deps, a.database, a.collection),
      ).catch(() => 'unknown' as const)
      // A check that could not finish sends no plan, said as such (nits).
      if (refused === 'unknown') throw new Refusal('plan_unchecked')
      // An index the plan names but the check could not place, or too many namespaces (nit).
      if (refused) throw new Refusal(refused.why === 'index' ? 'personal_index' : 'plan_unchecked')
    }
    // Stage names, indexes, keys and advice codes — never a stage's filter (4a-1 plan ruling 6).
    return result(
      {
        place: placeOf(c, a.database, a.collection),
        state: 'done',
        sent: 'plan',
        summary: { stage: view.winning?.stage ?? view.pipeline[0]?.stage ?? '' },
      },
      {
        winning: stripPlan(view.winning),
        rejected: view.rejected.slice(0, 3).map(stripPlan),
        stages: view.pipeline.map((s) => s.stage),
        advice: view.warnings.map((w) => w.code),
        ...(view.suggestion ? { suggestedIndex: Object.fromEntries(view.suggestion.key) } : {}),
        ...explained,
      },
      c.id,
    )
  },

  run_aggregation: async (env, a: ToolArgs<'run_aggregation'>) => {
    const c = need(env, a.connection)
    const stages = stagesArg(a.pipeline)
    if (!stages.length) throw new Refusal('invalid_arguments', 'pipeline needs at least one stage')
    noServerJs(stages)
    // Read-only: a pipeline that writes is refused here, wherever its stage stands.
    if (writesAt(stages)) throw new Refusal('write_pipeline')
    await sourcesAllowed(env, c, a.database, a.collection, stages)
    const guarded = await gated(env, c, a.database, a.collection, { stages: stages.map(decoded) })
    // A person no rule hides anything from reads ungated: the pipeline the gate rewrote is what runs
    // (a restricted person's own run takes it already; final review, P-1).
    const run = guarded.stages && guarded.open ? guarded.stages : null
    // Final reviews of the agent's gate (M-3, nit): the model is told its answer is not the original's
    // (a restricted person's route rewrites it by the same rules).
    const changed = guarded.stages && !sameValue(guarded.stages, stages.map(decoded)) ? REWRITTEN : {}
    const limit = a.limit ?? AI_AGENT_LIMITS.documents
    const ran = (run ? run.map(wire) : wire(stages)) as Record<string, unknown>[]
    // C6: a pipeline over a large collection is explained first; one that reads it whole is said.
    await scanAhead(
      env,
      c,
      a.database,
      a.collection,
      // Review of C6 (I2): with the rows the route keeps at most, as it runs.
      { kind: 'aggregate', stages: ran.length < MAX_STAGES ? [...ran, { $limit: limit }] : ran },
      pipelineScan(stages),
    )
    const answer = await read(env, 'POST', `${collPath(c, a.database, a.collection)}/aggregate/run`, {
      stages: ran,
      limit,
      remember: false,
    })
    // B5: the pipeline as it ran, for the person's panel.
    const results: AiAgentResults = { kind: 'aggregate', stages: ran, limit }
    const docs: unknown[] = []
    let failed: string | null = null
    for (const line of answer.text.split('\n')) {
      if (!line.trim()) continue
      const l = JSON.parse(line) as { document?: unknown; error?: { code?: string } }
      if (l.document !== undefined) docs.push(l.document)
      else if (l.error) failed = l.error.code ?? 'route_error'
    }
    if (failed) throw new Refusal(String(failed).toLowerCase())
    const place = placeOf(c, a.database, a.collection)
    const shown = env.documents
      ? await forModel(env, c, a.database, a.collection, docs, {
          stages: deserializeValue<Document[]>(wire(stages)),
        })
      : null
    if (!shown)
      return result(
        { place, state: 'done', sent: 'counts', summary: { returned: docs.length }, results },
        {
          returned: docs.length,
          note: env.documents
            ? 'The results touch personal fields the rules cannot follow: their values were not sent.'
            : DOCS_NOT_ALLOWED,
          ...changed,
        },
        c.id,
      )
    return result(
      {
        place,
        state: 'done',
        sent: 'documents',
        documents: shown.length,
        summary: { returned: docs.length },
        results,
      },
      { returned: docs.length, documents: shown, ...changed },
      c.id,
    )
  },

  /**
   * Design 2026-10-25 (C2): a field's distinct values through the person's own aggregation — told only
   * under the consent for this message and as the personal-data rules let them go; else how many.
   */
  distinct_values: async (env, a: ToolArgs<'distinct_values'>) => {
    const c = need(env, a.connection)
    const field = fieldPath(a.field)
    const filter = objectArg(a.filter, 'filter', {})
    noServerJs(filter)
    const match = Object.keys(filter).length ? [{ $match: filter }] : []
    // As MongoDB's distinct (review of C2, I2, M5): through arrays at every level of the path (an
    // array of subdocuments too), each element a value; null a value; a missing field none.
    const parts = field.split('.')
    // Re-review of C2 (M3): MongoDB does not walk an array of arrays above the field — nor does this.
    const unwinds = parts.flatMap((_, i) => {
      const prefix = parts.slice(0, i + 1).join('.')
      const unwind = { $unwind: { path: `$${prefix}`, preserveNullAndEmptyArrays: true } }
      return i < parts.length - 1
        ? [unwind, { $match: { [prefix]: { $not: { $type: 'array' } } } }]
        : [unwind]
    })
    const each: Document[] = [...match, ...unwinds, { $match: { [field]: { $exists: true } } }]
    const values: Document[] = [
      ...each,
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
    ]
    const howMany: Document[] = [...each, { $group: { _id: `$${field}` } }, { $count: 'distinct' }]
    await sourcesAllowed(env, c, a.database, a.collection, values)
    // Review of C2 (C1): the agent's own check of personal data, for everyone — a count or a match on a
    // personal field is refused (it would tell its values), as run_aggregation and count_documents do.
    const countGate = await gated(env, c, a.database, a.collection, { stages: howMany.map(decoded) })
    const valuesGate = await gated(env, c, a.database, a.collection, { stages: values.map(decoded) })
    // C6: the values are grouped over every document the filter keeps — explained first where large.
    await scanAhead(
      env,
      c,
      a.database,
      a.collection,
      {
        kind: 'aggregate',
        stages: (countGate.stages && countGate.open ? countGate.stages : howMany).map(wire),
      },
      'all',
    )
    const counted = await aggregateRead(
      env,
      c,
      a.database,
      a.collection,
      countGate.stages && countGate.open ? countGate.stages : howMany,
      1,
    )
    // Re-review of C2 (M4): what ran is not what was written — said, as run_aggregation says it.
    const changed =
      (countGate.stages && !sameValue(countGate.stages, howMany.map(decoded))) ||
      (valuesGate.stages && !sameValue(valuesGate.stages, values.map(decoded)))
        ? REWRITTEN
        : {}
    const distinct = Number((deserializeValue(counted[0] ?? {}) as { distinct?: unknown }).distinct ?? 0)
    const place = placeOf(c, a.database, a.collection)
    // The values read only where they may go, and only when there are some (review of C2, M4).
    const top =
      env.documents && distinct > 0
        ? await aggregateRead(
            env,
            c,
            a.database,
            a.collection,
            valuesGate.stages && valuesGate.open ? valuesGate.stages : values,
            AI_AGENT_LIMITS.documents,
          )
        : []
    const shown =
      env.documents && top.length
        ? await forModel(env, c, a.database, a.collection, top, {
            stages: deserializeValue<Document[]>(wire(values)),
          })
        : null
    if (!shown)
      return result(
        { place, state: 'done', sent: 'counts', summary: { distinct } },
        {
          distinct,
          ...changed,
          // Re-review (nit): none read (they changed meanwhile) is no rule's doing.
          ...(env.documents && top.length > 0
            ? { note: 'The values touch personal fields the rules cannot follow: they were not sent.' }
            : !env.documents
              ? { note: DOCS_NOT_ALLOWED }
              : {}),
        },
        c.id,
      )
    const told = shown.map((text) => {
      const d = JSON.parse(text) as { _id?: unknown; count?: unknown }
      return { value: d._id ?? null, count: d.count }
    })
    return result(
      // Values, not documents: counted as what was sent (review of C2, nit).
      { place, state: 'done', sent: 'documents', documents: told.length, summary: { distinct } },
      { distinct, values: told, ...(distinct > told.length ? { more: true } : {}), ...changed },
      c.id,
    )
  },

  list_backup_destinations: async (env) => {
    const list = ((await read(env, 'GET', '/backup-destinations')).body ?? []) as Array<{
      name: string
      type: string
      level: string
    }>
    return result(
      { place: null, state: 'done', sent: 'names', summary: { destinations: list.length } },
      {
        destinations: list.map((d) => ({ name: d.name, type: d.type, access: d.level })),
      },
    )
  },

  // Design 2026-10-25 (A3): the person's own jobs and kept backups — of the connections the agent is
  // told of only, both sides of a two-sided job; states, sizes and names, never an error's own words,
  // a path or a checksum. What they told of is a source of the turn (review of A3, I2).
  list_jobs: async (env, a: ToolArgs<'list_jobs'>) => {
    const c = a.connection ? need(env, a.connection, false) : null
    const q = new URLSearchParams({
      ...(c ? { connectionId: c.id } : {}),
      ...(a.state ? { state: a.state } : {}),
    })
    const jobs = ((await read(env, 'GET', `/jobs${q.size ? `?${q}` : ''}`)).body as { jobs: JobView[] }).jobs
    const told = jobs.flatMap((j) => jobForModel(env, j, 'list_jobs')).slice(0, JOBS_LISTED)
    return result(
      { place: c ? placeOf(c) : null, state: 'done', sent: 'names', summary: { jobs: told.length } },
      { jobs: told.map((j) => j.told) },
      [...new Set(told.map((j) => j.connectionId))],
    )
  },

  get_job: async (env, a: ToolArgs<'get_job'>) => {
    const job = ((await read(env, 'GET', `/jobs/${a.job}`)).body as { job: JobView }).job
    const [found] = jobForModel(env, job, 'get_job')
    // A job not the person's, or of a connection the agent is not told of, answers as a missing one.
    if (!found) throw new Refusal('not_found')
    // Review of A3 (I5): a backup sent on to destinations is not done when its dump is — its send job.
    let send = {}
    if (job.kind === 'backup.dump' && job.state === 'done') {
      const report = await callRoute(env.app, env.auth, 'GET', `/transfer/jobs/${job.id}/report`)
      const r =
        report.status < 300 ? (report.body as { sendJobId?: string | null; sendError?: string | null }) : null
      if (r?.sendJobId) send = { sendJob: r.sendJobId }
      else if (r?.sendError) send = { sendFailed: true }
    }
    return result(
      { place: found.place, state: 'done', sent: 'names', summary: { state: job.state } },
      { ...found.told, ...send },
      found.connectionId,
    )
  },

  list_backups: async (env, a: ToolArgs<'list_backups'>) => {
    const c = a.connection ? need(env, a.connection, false) : null
    const list = ((await read(env, 'GET', `/backups${c ? `?connectionId=${encodeURIComponent(c.id)}` : ''}`))
      .body ?? []) as BackupView[]
    const told = list
      .flatMap((b) => {
        const at = toldConnection(env, b.connectionId, 'list_backups')
        if (!at || !scopeTold(b.scope)) return []
        // Review of A3 (I4): where personal-data rules apply, the size is hidden from the provider,
        // as collection_stats hides it — it tells the length of what is hidden.
        const rules = everyone(env, at)
        const hidden =
          b.scope.kind === 'server' ? rules.anyRules || ruledAnywhere(env, at) : rules.anyInDb(b.scope.db)
        return [
          {
            connectionId: at.id,
            told: {
              id: b.id,
              name: b.name,
              connection: at.label,
              scope: b.scope,
              format: b.format,
              size: hidden ? null : b.size,
              ...(hidden ? { sizeHidden: true } : {}),
              namespaces: b.namespaces,
              finishedAt: new Date(b.finishedAt).toISOString(),
              expiresAt: new Date(b.expiresAt).toISOString(),
              // Each copy sent on, by its destination's name and state (a reason code, never words).
              copies: b.copies.map((x) => ({
                destination: x.destinationName,
                state: x.state,
                ...(x.reason ? { reason: x.reason } : {}),
              })),
            },
          },
        ]
      })
      .slice(0, JOBS_LISTED)
    return result(
      { place: c ? placeOf(c) : null, state: 'done', sent: 'names', summary: { backups: told.length } },
      { backups: told.map((b) => b.told) },
      [...new Set(told.map((b) => b.connectionId))],
    )
  },

  create_database: async (env, a: ToolArgs<'create_database'>) => {
    const c = need(env, a.connection)
    mayChange('create_database', c, a.database, a.collection)
    const dbs = (
      (await read(env, 'GET', `${connPath(c)}/databases`)).body as { databases: Array<{ name: string }> }
    ).databases
    if (dbs.some((d) => d.name === a.database))
      throw new Refusal('exists', 'The database exists: use create_collection')
    const payload = { name: a.database, collection: a.collection }
    return proposal(c, a.database, a.collection, payload, { databaseExists: false }, async (auth) => {
      const r = await callRoute(env.app, auth, 'POST', `${connPath(c)}/databases`, payload)
      return r.status < 300 ? done({ created: a.database }) : failed(r)
    })
  },

  create_collection: async (env, a: ToolArgs<'create_collection'>) => {
    const c = need(env, a.connection)
    mayChange('create_collection', c, a.database, a.collection)
    let payload: Record<string, unknown>
    switch (a.kind) {
      case 'capped':
        payload = { kind: 'capped', name: a.collection, size: a.size ?? 0, ...(a.max ? { max: a.max } : {}) }
        break
      case 'timeseries':
        payload = {
          kind: 'timeseries',
          name: a.collection,
          timeField: a.timeField ?? '',
          ...(a.metaField ? { metaField: a.metaField } : {}),
          ...(a.granularity ? { granularity: a.granularity } : {}),
          ...(a.expireAfterSeconds ? { expireAfterSeconds: a.expireAfterSeconds } : {}),
        }
        break
      case 'view': {
        const stages = stagesArg(a.pipeline ?? '[]')
        noServerJs(stages)
        if (writesAt(stages)) throw new Refusal('write_pipeline')
        // W6.3 security review (I1): a view never reads MongoDB's own collections either.
        await sourcesAllowed(env, c, a.database, a.viewOn ?? '', stages)
        // Final review of the agent's gate (I-2): nor what is hidden where the gate would rewrite it.
        await gated(env, c, a.database, a.viewOn ?? '', {
          view: { viewOn: a.viewOn ?? '', stages: stages.map(decoded) },
        })
        payload = { kind: 'view', name: a.collection, viewOn: a.viewOn ?? '', pipeline: wire(stages) }
        break
      }
      default:
        payload = { kind: 'collection', name: a.collection, clustered: !!a.clustered }
    }
    const dbs = (
      (await read(env, 'GET', `${connPath(c)}/databases`)).body as { databases: Array<{ name: string }> }
    ).databases
    const databaseExists = dbs.some((d) => d.name === a.database)
    if (databaseExists) {
      const colls = ((await read(env, 'GET', `${dbPath(c, a.database)}/collections`)).body ?? []) as Array<{
        name: string
      }>
      if (colls.some((x) => x.name === a.collection)) throw new Refusal('exists')
    }
    return proposal(c, a.database, a.collection, payload, { databaseExists, exists: false }, async (auth) => {
      // Final review of the agent's gate (M-1): a view's gate, with the rules as they are now.
      if (a.kind === 'view') {
        const stages = stagesArg(a.pipeline ?? '[]').map(decoded)
        const viewOn = a.viewOn ?? ''
        const refusedNow = await gatedAgain(env, c, a.database, viewOn, { view: { viewOn, stages } })
        if (refusedNow) return refusedNow
      }
      const r = await callRoute(env.app, auth, 'POST', `${dbPath(c, a.database)}/collections`, payload)
      return r.status < 300 ? done({ created: `${a.database}.${a.collection}` }) : failed(r)
    })
  },

  insert_documents: async (env, a: ToolArgs<'insert_documents'>) => {
    const c = need(env, a.connection)
    mayChange('insert_documents', c, a.database, a.collection)
    const docs = value(a.documents, 'documents')
    const list = Array.isArray(docs) ? docs : isPlain(docs) ? [docs] : null
    if (!list || !list.length || !list.every(isPlain) || list.length > AI_AGENT_LIMITS.insertDocuments)
      throw new Refusal(
        'invalid_arguments',
        `documents must be 1 to ${AI_AGENT_LIMITS.insertDocuments} objects`,
      )
    const documents = list.map(wire)
    await gated(env, c, a.database, a.collection, { insert: list.map(decoded) })
    const exists = await collectionExists(env, c, a.database, a.collection)
    const payload = { documents }
    return proposal(
      c,
      a.database,
      a.collection,
      payload,
      { documents: documents.length, exists },
      async (auth) => {
        const refusedNow = await gatedAgain(env, c, a.database, a.collection, { insert: list.map(decoded) })
        if (refusedNow) return refusedNow
        const r = await callRoute(
          env.app,
          auth,
          'POST',
          `${collPath(c, a.database, a.collection)}/documents`,
          payload,
        )
        return r.status < 300 ? done({ inserted: documents.length }) : failed(r)
      },
      {
        shown: {
          documents: shownTo(env, c, a.database, a.collection, { insert: a.collection, documents }).documents,
        },
      },
    )
  },

  update_documents: async (env, a: ToolArgs<'update_documents'>) => bulk(env, a, 'update'),
  delete_documents: async (env, a: ToolArgs<'delete_documents'>) => bulk(env, a, 'delete'),

  create_index: async (env, a: ToolArgs<'create_index'>) => {
    const c = need(env, a.connection)
    mayChange('create_index', c, a.database, a.collection)
    const keys = objectArg(a.keys, 'keys')
    const partial =
      a.partialFilterExpression === undefined
        ? undefined
        : objectArg(a.partialFilterExpression, 'partialFilterExpression')
    noServerJs(partial)
    const key = Object.fromEntries(
      Object.entries(keys).map(([k, v]) => [k, typeof v === 'number' ? (v < 0 ? -1 : 1) : v]),
    )
    const options = {
      ...(a.name ? { name: a.name } : {}),
      ...(a.unique ? { unique: true } : {}),
      ...(a.sparse ? { sparse: true } : {}),
      ...(a.hidden ? { hidden: true } : {}),
      ...(a.expireAfterSeconds !== undefined ? { expireAfterSeconds: a.expireAfterSeconds } : {}),
      ...(partial ? { partialFilterExpression: wire(partial) } : {}),
    }
    const payload = { key, options }
    // W6.3 security review (I2): a unique build or a partial filter on a personal field answers about it.
    const indexQuery: AiQuery = {
      index: {
        key,
        options: {
          ...(a.unique ? { unique: true } : {}),
          ...(a.expireAfterSeconds !== undefined ? { expireAfterSeconds: a.expireAfterSeconds } : {}),
          ...(partial ? { partialFilterExpression: decoded(partial) } : {}),
        },
      },
    }
    await gated(env, c, a.database, a.collection, indexQuery)
    // W6.3 security review (I3): a TTL index deletes documents (past-dated ones within a minute):
    // what would expire now is counted, and the collection's name is typed, as for a drop.
    const ttl = a.expireAfterSeconds !== undefined
    const expiring = ttl
      ? await expiringNow(env, c, a.database, a.collection, key, a.expireAfterSeconds!, partial)
      : undefined
    const masker = maskerForPrincipal(env.ctx, env.principal, c.id)
    const shown =
      masker && partial
        ? {
            key,
            options: {
              ...options,
              partialFilterExpression: maskFilterDef(wire(partial), a.database, a.collection, masker),
            },
          }
        : payload
    return proposal(
      c,
      a.database,
      a.collection,
      payload,
      expiring !== undefined ? { expiring } : {},
      async (auth) => {
        // Final review of the agent's gate (M-1): the rules as they are now.
        const refusedNow = await gatedAgain(env, c, a.database, a.collection, indexQuery)
        if (refusedNow) return refusedNow
        const r = await callRoute(
          env.app,
          auth,
          'POST',
          `${collPath(c, a.database, a.collection)}/indexes`,
          payload,
        )
        return r.status < 300 ? done({ started: true }) : failed(r)
      },
      { shown, ...(ttl ? { typed: a.collection, destructive: true } : {}) },
    )
  },

  drop_index: async (env, a: ToolArgs<'drop_index'>) => {
    const c = need(env, a.connection)
    mayChange('drop_index', c, a.database, a.collection)
    if (a.name === '_id_') throw new Refusal('forbidden', 'The _id index cannot be dropped')
    const list = ((await read(env, 'GET', `${collPath(c, a.database, a.collection)}/indexes`)).body ??
      []) as Array<{ name: string }>
    if (!list.some((i) => i.name === a.name)) throw new Refusal('not_found')
    return proposal(c, a.database, a.collection, { name: a.name }, { exists: true }, async (auth) => {
      const r = await callRoute(
        env.app,
        auth,
        'DELETE',
        `${collPath(c, a.database, a.collection)}/indexes/${enc(a.name)}`,
      )
      return r.status < 300 ? done({ dropped: a.name }) : failed(r)
    })
  },

  drop_collection: async (env, a: ToolArgs<'drop_collection'>) => {
    const c = need(env, a.connection)
    mayChange('drop_collection', c, a.database, a.collection)
    // Only what is there is proposed for dropping (no card for a name the model made up).
    if (!(await collectionExists(env, c, a.database, a.collection))) throw new Refusal('not_found')
    const s = (await read(env, 'GET', `${collPath(c, a.database, a.collection)}/stats`)).body as {
      count?: number
    }
    // As the app's own dialog: the name is typed, and the route checks it again.
    return proposal(
      c,
      a.database,
      a.collection,
      { drop: `${a.database}.${a.collection}` },
      { documents: Number(s.count ?? 0) },
      async (auth, input) => {
        const r = await callRoute(env.app, auth, 'DELETE', collPath(c, a.database, a.collection), {
          confirm: input.confirm ?? '',
        })
        return r.status < 300 ? done({ dropped: `${a.database}.${a.collection}` }) : failed(r)
      },
      { typed: a.collection, destructive: true, backup: backupOffer(env, c, a.database, a.collection) },
    )
  },

  drop_database: async (env, a: ToolArgs<'drop_database'>) => {
    const c = need(env, a.connection)
    mayChange('drop_database', c, a.database)
    const dbs = (
      (await read(env, 'GET', `${connPath(c)}/databases`)).body as { databases: Array<{ name: string }> }
    ).databases
    if (!dbs.some((d) => d.name === a.database)) throw new Refusal('not_found')
    const s = (await read(env, 'GET', `${dbPath(c, a.database)}/stats`)).body as {
      collections?: number
      objects?: number
    }
    return proposal(
      c,
      a.database,
      undefined,
      { dropDatabase: a.database },
      { collections: Number(s.collections ?? 0), documents: Number(s.objects ?? 0) },
      async (auth, input) => {
        const r = await callRoute(env.app, auth, 'DELETE', dbPath(c, a.database), {
          confirm: input.confirm ?? '',
        })
        return r.status < 300 ? done({ dropped: a.database }) : failed(r)
      },
      { typed: a.database, destructive: true, backup: backupOffer(env, c, a.database) },
    )
  },

  run_backup: async (env, a: ToolArgs<'run_backup'>) => {
    const c = need(env, a.connection)
    mayChange('run_backup', c, a.database, a.collection)
    if (a.collection && !a.database) throw new Refusal('invalid_arguments', 'collection needs its database')
    const scope = a.collection
      ? { kind: 'collection', db: a.database!, coll: a.collection }
      : a.database
        ? { kind: 'database', db: a.database }
        : { kind: 'server' }
    // Design 2026-10-25 (A3): sent on to destinations the person may use, named as they are listed.
    const destinations = a.destinations.length
      ? (((await read(env, 'GET', '/backup-destinations')).body ?? []) as Array<{ id: string; name: string }>)
      : []
    // Named as listed: exactly, else in another letter case where that is the only one; each once
    // (review of A3, minor 12; second re-review, minor 4).
    const found = destinationsNamed(destinations, a.destinations)
    if (!found) throw new Refusal('destination_unknown')
    const ids = found.map((d) => d.id)
    const names = found.map((d) => d.name)
    if (a.deleteLocal && !ids.length) throw new Refusal('invalid_arguments', 'deleteLocal needs destinations')
    const request = {
      scope,
      format: a.format,
      ...(ids.length ? { destinations: ids as string[], deleteLocal: a.deleteLocal } : {}),
    }
    const plan = (await read(env, 'POST', `${connPath(c)}/backup/plan`, request)).body as DumpPlan
    // Review of A3 (minor 11): why, as the plan's codes (never its words).
    if (plan.refusals.length) throw new Refusal('backup_refused', plan.refusals.join(', '))
    // User request 2026-10-26: an encrypted backup may be made without a password instead, as a
    // compressed archive — offered only where the route would take that one too (its own plan: a
    // destination that takes encrypted backups only, or personal data that may not leave the server
    // unencrypted, refuses it).
    const plainRequest = { ...request, format: 'gzip' as const }
    // Review (minor 3): that plan failing (a busy read, a timeout) offers none; the card stands.
    const plainPlan =
      a.format === 'mmbak'
        ? await read(env, 'POST', `${connPath(c)}/backup/plan`, plainRequest).then(
            (r) => r.body as DumpPlan,
            () => null,
          )
        : null
    const plainOffer =
      plainPlan && !plainPlan.refusals.length
        ? {
            personal:
              !plainPlan.masked && plainPlan.namespaces.some((n) => !n.skipped && n.personal.length > 0),
          }
        : null
    return proposal(
      c,
      a.database,
      a.collection,
      request,
      {
        namespaces: plan.namespaces.length,
        format: a.format,
        // The kept copy is removed after this — said before it is made (review of W6.3, A3).
        expiresInHours: Math.max(1, Math.ceil(env.ctx.backup.limits.ttlMs / 3_600_000)),
        ...(names.length ? { destinations: names, deleteLocal: a.deleteLocal } : {}),
      },
      async (auth, input) => {
        const plain = input.plain === true && plainPlan !== null && plainOffer !== null
        const r = await callRoute(
          env.app,
          auth,
          'POST',
          `${connPath(c)}/backup`,
          plain
            ? { ...plainRequest, planHash: plainPlan.planHash }
            : {
                ...request,
                planHash: plan.planHash,
                ...(a.format === 'mmbak' ? { password: input.password ?? '' } : {}),
              },
        )
        // The job is said back, so the turn can follow it (get_job) and the person open it — and the
        // format it was made in (the person may have chosen no password).
        const job = (r.body as { job?: { id?: unknown } } | null)?.job?.id
        return r.status < 300
          ? done({
              started: true,
              format: plain ? 'gzip' : a.format,
              ...(typeof job === 'string' ? { job } : {}),
            })
          : failed(r)
      },
      // Review of A3 (minor 10): the card shows the destinations by name, never their ids.
      {
        password: a.format === 'mmbak',
        ...(plainOffer ? { plain: plainOffer } : {}),
        ...(names.length ? { shown: { ...request, destinations: names } } : {}),
      },
    )
  },

  create_backup_schedule: async (env, a: ToolArgs<'create_backup_schedule'>) => {
    const c = need(env, a.connection)
    mayChange('create_backup_schedule', c, a.database, a.collection)
    if (a.collection && !a.database) throw new Refusal('invalid_arguments', 'collection needs its database')
    // Third review of A4 (minor 1): a scope of MongoDB's own refused as such, whatever its format.
    if (a.database && (SYSTEM_DATABASES.has(a.database) || isDrillScratch(a.database)))
      throw new Refusal('system_namespace')
    if (a.collection?.startsWith('system.')) throw new Refusal('system_namespace')
    // Design 2026-10-25 (A4): what the route would refuse on confirm, refused before any card — a
    // schedule that cannot run is no proposal.
    // As the route reads them (review of A4, N1): the server's switch, the owner's count, the key.
    const owner = ownerOf(env.principal)
    if (!env.ctx.backup.limits.schedules) throw new Refusal('schedules_off')
    if (env.ctx.backup.schedules.countFor(owner) >= MAX_SCHEDULES_PER_USER)
      throw new Refusal('schedule_limit')
    const destinations = ((await read(env, 'GET', '/backup-destinations')).body ?? []) as Array<{
      id: string
      name: string
    }>
    // Review of A4 (M1): none at all is no destination; some, none named, the model is told them to ask.
    if (!destinations.length) throw new Refusal('no_destination')
    if (!a.destinations.length) throw new Refusal('destination_needed', `ask which: ${namesOf(destinations)}`)
    // Named as listed: exactly, else in another letter case where that is the only one; each once
    // (review of A3, minor 12; second re-review, minor 4).
    const found = destinationsNamed(destinations, a.destinations)
    // Third review of A4 (nit): the names it may use, so the model can put it right.
    if (!found) throw new Refusal('destination_unknown', `the destinations are: ${namesOf(destinations)}`)
    const ids = found.map((d) => d.id)
    const names = found.map((d) => d.name)
    // An encrypted schedule uses the person's backup key: none active, none runs.
    if (a.format === 'mmbak' && !env.ctx.backup.keys.active(owner)) throw new Refusal('key_required')
    // Review of A4 (M3): the model may leave the zone out — the person's own, sent with the turn.
    const timeZone = a.timeZone ?? env.timeZone
    if (!timeZone) throw new Refusal('invalid_arguments', 'a time zone is needed')
    // Third review of A4 (minor 2): one this server does not know, said so (not the route's 400).
    if (!TimeZoneSchema.safeParse(timeZone).success)
      throw new Refusal('invalid_arguments', 'the time zone is not one this server knows')
    const cadence = objectArg(a.cadence, 'cadence')
    const preview = (
      await read(env, 'POST', '/backup-schedules/preview', {
        cadence,
        timeZone,
        locale: env.language,
      })
    ).body as SchedulePreview
    // Review of A4 (I1): every problem the route refuses, under an hour apart included — with what
    // the model needs to put it right.
    if (preview.problem) throw new Refusal(`cadence_${preview.problem.reason}`, cadenceHint(preview.problem))
    const retention = RETENTION_PRESETS[a.retention]
    const payload = {
      name: a.name,
      connectionId: c.id,
      dump: {
        scope: a.collection
          ? { kind: 'collection', db: a.database!, coll: a.collection }
          : a.database
            ? { kind: 'database', db: a.database }
            : { kind: 'server' },
      },
      format: a.format,
      cadence,
      timeZone,
      destinations: ids,
      keepOnServer: !!a.keepOnServer,
      retention,
    }
    // Review of A4 (I2): an unencrypted schedule judged as the route judges it, as it will run.
    if (a.format !== 'mmbak') {
      const dump = ScheduleDumpSchema.safeParse(payload.dump)
      if (!dump.success) throw new Refusal('invalid_arguments', 'the backup scope is not valid')
      const plain = plainProblem(env.ctx, unattended(env.principal), c.id, dump.data, ids)
      if (plain) throw new Refusal(plain)
    }
    return proposal(
      c,
      a.database,
      a.collection,
      payload,
      { nextRuns: preview.runs.slice(0, 3), words: preview.words, retention, timeZone },
      async (auth) => {
        const r = await callRoute(env.app, auth, 'POST', '/backup-schedules', payload)
        return r.status < 300 ? done({ created: a.name }) : failed(r)
      },
      // W6.3 security review (minor 3): the card names the connection and the destinations, as the
      // schedule editor does; their ids are what is sent.
      {
        shown: (() => {
          const { connectionId: _id, destinations: _ids, ...rest } = payload
          return { connection: c.label, ...rest, destinations: names }
        })(),
      },
    )
  },

  /**
   * Design 2026-10-25 (B2): a backup restored through the restore plan, as the app's Restore does —
   * a destructive card naming the target, its name typed; an encrypted backup's password on the card
   * (the plan is made again with it on the click, and what it would do must be what the card said);
   * never into one of MongoDB's own namespaces, and nothing the plan asks to be confirmed besides a
   * replace's names (TTL indexes, personal data, masked backups: the app's Restore says those).
   */
  restore_backup: async (env, a: ToolArgs<'restore_backup'>) => {
    const c = need(env, a.connection)
    const b = await backupNamed(env, a.backup, a.from)
    // Second review of C5 (I1): restoring off on the connection the backup was made of, however it was
    // named (by `from`, by its id alone) — checked again on the click.
    const restoringOff = () =>
      !!toldConnection(env, b.connectionId)?.record.aiAgentToolsOff.includes('restore_backup')
    if (restoringOff()) throw new Refusal('tool_off')
    const sources = await backupNamespaces(env, b)
    if (a.collection && b.scope.kind !== 'collection')
      throw new Refusal('invalid_arguments', 'a collection is for a backup of one collection')
    const mapping = sources.map((f) => ({
      from: f,
      to: { db: a.database ?? f.db, coll: a.collection ?? f.coll },
    }))
    const targetDb = mapping[0]!.to.db
    // A backup of one collection is restored into one; of a database, into a database.
    const targetColl = b.scope.kind === 'collection' ? mapping[0]!.to.coll : undefined
    // Review of B2 (nit): the agent's own switch said first, then the restore route's rights (jobs:run:
    // every role that writes documents has it, so it stands behind documents:write, as the route's).
    mayChange('restore_backup', c, targetDb, targetColl)
    if (!c.permissions.has('jobs:run')) throw new Refusal(c.full.has('jobs:run') ? 'read_only' : 'forbidden')
    for (const m of mapping)
      if (m.to.coll.startsWith('system.') || isEncryptionNamespace(m.to.db, m.to.coll))
        throw new Refusal('system_namespace')
    const request = {
      source: { kind: 'backup', backupId: b.id },
      mapping,
      mode: a.mode,
      // Review of B2 (M4): a backup's indexes only where the person may make them (every role that
      // writes documents may make them today: a guard for a grant that one day may not).
      ...(c.permissions.has('indexes:write') ? {} : { indexes: false }),
    }
    const path = `${connPath(c)}/restore/plan`
    const planned = await callRoute(env.app, env.auth, 'POST', path, request)
    let expected: RestoreExpectation[]
    let opening = false
    let warnings: string[] = []
    // Third review of B2 (M3): the capped targets the card names, so the click stops on another.
    let capped = new Set<string>()
    if (planned.status < 300) {
      const plan = planned.body as RestorePlan
      refuseBlocked(plan.refusals)
      expected = expectationOf(plan)
      // Review of B2 (M2): what the plan warns of, by its code (capped collections, the same server).
      warnings = plan.checks.filter((k) => k.level === 'warn' && WARNED.has(k.key)).map((k) => k.key)
      capped = cappedOf(plan)
    } else {
      const refused = routeError(planned)
      // An encrypted backup: the card asks its password; what it does is read from the target now.
      // Review of B2 (M3): one a key opens that has a password too takes the password.
      const withPassword =
        refused.reason === 'backup_password_needed' ||
        (refused.reason === 'backup_key_needed' &&
          (planned.body as { details?: { password?: unknown } } | null)?.details?.password === true)
      if (!withPassword) throw refused
      opening = true
      const seen = await targetsNow(env, c, mapping, a.mode)
      expected = seen.map(({ capped: _c, ...x }) => x)
      // Third review of B2 (M2): a capped target the card can see, named as the plan names it.
      capped = new Set(seen.filter((x) => x.capped).map((x) => x.key))
      if (capped.size) warnings.push('capped')
      // Re-review of B2 (M3): written over the server it was made of — the same connection, or one
      // to the same hosts (third review, M2) — said as the plan says it.
      const madeOf = toldConnection(env, b.connectionId)
      if (
        (b.connectionId === c.id || (madeOf && sameHosts(madeOf, c))) &&
        expected.some((x) => x.exists && !x.skipped)
      )
        warnings.push('source')
    }
    const live = expected.filter((x) => !x.skipped)
    // Review of B2 (M2): nothing left to restore is no card.
    if (!live.length) throw new Refusal('restore_nothing')
    const lost = live.reduce((n, x) => n + (x.action === 'replace' ? (x.documents ?? 0) : 0), 0)
    // M1: a replace over a target whose count is not known says so.
    const lostUnknown = live.some((x) => x.action === 'replace' && x.exists && x.documents === null)
    const existing = live.filter((x) => x.exists).length
    // Review of B2 (C1, I1): the targets a replace overwrites, as the card says them — confirmed by
    // the person's typing, sent with the plan and the start alike (the plan's hash covers them).
    const confirmNames = live.filter((x) => x.confirmName).map((x) => x.key)
    const source = toldConnection(env, b.connectionId)
    const typed = targetColl ? `${targetDb}.${targetColl}` : targetDb
    // Fourth review of B2 (I2): the capped targets by name, a few, so what the click guards is seen.
    const cappedNames = [...capped].sort()
    return proposal(
      c,
      targetDb,
      targetColl,
      { restore: b.name, into: typed, mode: a.mode },
      {
        namespaces: live.length,
        ...(existing ? { existing } : {}),
        ...(lost ? { lost } : {}),
        ...(lostUnknown ? { lostUnknown: true } : {}),
        ...(expected.length > live.length ? { skipped: expected.length - live.length } : {}),
        ...(warnings.length ? { warnings } : {}),
        // Re-review of B2 (nit 9): said beside what is sent, never as part of it.
        ...(source && source.id !== c.id ? { from: source.label } : {}),
        // Fourth review of B2 (I1): which backup, by when it was made — two of one name differ in it.
        made: b.finishedAt,
        ...(cappedNames.length ? { capped: cappedNames.slice(0, CAPPED_SAID) } : {}),
        ...(cappedNames.length > CAPPED_SAID ? { cappedMore: cappedNames.length - CAPPED_SAID } : {}),
      },
      async (auth, input) => {
        if (restoringOff()) return { state: 'error', reason: 'tool_off' }
        const secret = opening && input.password ? { password: input.password } : {}
        const asked = { ...request, ...secret, confirmNames }
        const again = await callRoute(env.app, auth, 'POST', path, asked)
        if (again.status >= 300) return failed(again)
        const plan = again.body as RestorePlan
        // What the click starts is what the card said: the targets as they were, a replace's names
        // the ones the card named (one more asked now is a change: refused, never confirmed unseen).
        const now = expectationOf(plan)
        if (!sameTargets(now, expected) || plan.refusals.includes('confirm_name'))
          return { state: 'error', reason: 'plan_changed' }
        // A target left out, a warning, or a capped target the card did not say (re-reviews of B2, I1
        // and M3): for an encrypted backup, what only its password shows — said as such, so it is not
        // asked again and again (third review, M2) — else a change.
        const warned = plan.checks.filter((k) => k.level === 'warn' && WARNED.has(k.key)).map((k) => k.key)
        const differs =
          !sameSkips(now, expected) ||
          warned.some((k) => !warnings.includes(k)) ||
          [...cappedOf(plan)].some((n) => !capped.has(n))
        if (differs) {
          if (!opening) return { state: 'error', reason: 'plan_changed' }
          // Fourth review of B2 (M2): the targets read again as the card read them — changed since,
          // a change; as they were, what only the password shows.
          // Fifth review (M-3): read as the one who clicked; a target not read said as such.
          let seen: Awaited<ReturnType<typeof targetsNow>>
          try {
            seen = await targetsNow(env, c, mapping, a.mode, auth)
          } catch (err) {
            if (err instanceof Refusal) return { state: 'error', reason: err.reason }
            throw err
          }
          const same =
            sameTargets(seen, expected) &&
            sameSkips(seen, expected) &&
            seen.filter((x) => x.capped).every((x) => capped.has(x.key)) &&
            seen.filter((x) => x.capped).length === capped.size
          return { state: 'error', reason: same ? 'restore_plan_differs' : 'plan_changed' }
        }
        if (plan.refusals.length) return { state: 'error', reason: `restore_${plan.refusals[0]}` }
        const started = await callRoute(env.app, auth, 'POST', `${connPath(c)}/restore`, {
          ...asked,
          planHash: plan.planHash,
        })
        const job = (started.body as { job?: { id?: string } } | null)?.job?.id
        return started.status < 300 ? done({ started: true, ...(job ? { job } : {}) }) : failed(started)
      },
      {
        typed,
        destructive: true,
        ...(opening ? { password: true, opening: true } : {}),
        // C4: what a restore writes over, backed up first on asking.
        ...(existing ? { backup: backupOffer(env, c, targetDb, targetColl) } : {}),
      },
    )
  },

  /**
   * Design 2026-10-25 (B1): the person's own schedules — never another's (an administrator sees every
   * one; the agent tells theirs), nor one of a connection the agent is not told of; where, when and
   * how they went, by names and words, never an id nor an error's words.
   */
  list_schedules: async (env, a: ToolArgs<'list_schedules'>) => {
    const c = a.connection ? need(env, a.connection, false) : null
    const told = (await ownSchedules(env, 'list_schedules'))
      .filter((s) => !c || s.view.connectionId === c.id)
      .slice(0, JOBS_LISTED)
    return result(
      { place: c ? placeOf(c) : null, state: 'done', sent: 'names', summary: { schedules: told.length } },
      { schedules: told.map((s) => scheduleTold(env, s)) },
      [...new Set(told.map((s) => s.c.id))],
    )
  },

  run_schedule: async (env, a: ToolArgs<'run_schedule'>) => {
    const s = await scheduleNamed(env, a.schedule, 'run_schedule', a.connection)
    // Review of B1 (M4): what the route answers on the click, said before any card.
    if (!env.ctx.backup.limits.schedules) throw new Refusal('schedules_off')
    if (env.ctx.backup.scheduler.busy(s.view.id)) throw new Refusal('run_running')
    return scheduleProposal(s, { runSchedule: s.view.name }, {}, async (auth) => {
      const r = await callRoute(env.app, auth, 'POST', `/backup-schedules/${s.view.id}/run`)
      // Review of B1 (M5): the run is queued or running — its job comes later; list_jobs finds it.
      const run = (r.body as { run?: { outcome?: string } } | null)?.run?.outcome
      return r.status < 300
        ? done({ schedule: s.view.name, did: 'started', ...(run ? { run } : {}) })
        : failed(r)
    })
  },

  pause_schedule: async (env, a: ToolArgs<'pause_schedule'>) => {
    const s = await scheduleNamed(env, a.schedule, 'pause_schedule', a.connection)
    if (s.view.state === 'paused') throw new Refusal('schedule_paused')
    return scheduleProposal(s, { pauseSchedule: s.view.name }, {}, async (auth) => {
      const r = await callRoute(env.app, auth, 'POST', `/backup-schedules/${s.view.id}/pause`)
      return r.status < 300 ? done({ schedule: s.view.name, did: 'paused' }) : failed(r)
    })
  },

  resume_schedule: async (env, a: ToolArgs<'resume_schedule'>) => {
    const s = await scheduleNamed(env, a.schedule, 'resume_schedule', a.connection)
    if (s.view.state === 'active') throw new Refusal('schedule_active')
    // As the route: an administrator's pause is an administrator's to lift.
    if (s.view.pause?.by === 'admin' && !isAdministrator(env.principal)) throw new Refusal('paused_by_admin')
    return scheduleProposal(s, { resumeSchedule: s.view.name }, {}, async (auth) => {
      const r = await callRoute(env.app, auth, 'POST', `/backup-schedules/${s.view.id}/resume`)
      return r.status < 300 ? done({ schedule: s.view.name, did: 'resumed' }) : failed(r)
    })
  },

  /**
   * B1: only what is given changes, checked as a new schedule is (its cadence, zone, destinations, an
   * unencrypted one's), and the backups the change removes now are said on the card. Above ten, the
   * route asks for their count to be confirmed, so the count the person saw is the one sent: a count
   * that moved meanwhile past ten is refused by the route (one that stays at ten or under is applied,
   * as the schedule editor applies it).
   */
  update_schedule: async (env, a: ToolArgs<'update_schedule'>) => {
    const s = await scheduleNamed(env, a.schedule, 'update_schedule', a.connection)
    const patch: Record<string, unknown> = {}
    let names: string[] | undefined
    if (a.name !== undefined && a.name !== s.view.name) {
      // Review of B1 (M6): a name another of the person's schedules has would make both unnameable.
      const own = await ownSchedules(env)
      if (own.some((o) => o.view.id !== s.view.id && o.view.name.toLowerCase() === a.name!.toLowerCase()))
        throw new Refusal('schedule_name_taken')
      patch.name = a.name
    }
    if (a.cadence !== undefined) patch.cadence = objectArg(a.cadence, 'cadence')
    if (a.timeZone !== undefined) {
      if (!TimeZoneSchema.safeParse(a.timeZone).success)
        throw new Refusal('invalid_arguments', 'the time zone is not one this server knows')
      // Review of B1 (M3): the zone it has already is no change.
      if (a.timeZone !== s.view.timeZone) patch.timeZone = a.timeZone
    }
    if (a.destinations !== undefined) {
      const listed = ((await read(env, 'GET', '/backup-destinations')).body ?? []) as Array<{
        id: string
        name: string
      }>
      const found = a.destinations.length ? destinationsNamed(listed, a.destinations) : null
      if (!found) throw new Refusal('destination_unknown', `the destinations are: ${namesOf(listed)}`)
      patch.destinations = found.map((d) => d.id)
      names = found.map((d) => d.name)
    }
    if (a.keepOnServer !== undefined) patch.keepOnServer = a.keepOnServer
    if (a.retention !== undefined) patch.retention = RETENTION_PRESETS[a.retention]
    if (!Object.keys(patch).length) throw new Refusal('invalid_arguments', 'nothing to change')
    const current: Record<string, unknown> = {
      retention: s.view.retention,
      timeZone: s.view.timeZone,
      destinations: s.view.destinations.map((d) => d.id),
      keepOnServer: s.view.keepOnServer,
    }
    const timeZone = (patch.timeZone as string | undefined) ?? s.view.timeZone
    // Review of B1 (nit): a stored zone this server cannot read is put right with a new one.
    if (!TimeZoneSchema.safeParse(timeZone).success)
      throw new Refusal('invalid_cadence', 'give the schedule a time zone this server knows')
    const timing = patch.cadence !== undefined || patch.timeZone !== undefined
    const preview = (
      await read(env, 'POST', '/backup-schedules/preview', {
        scheduleId: s.view.id,
        // Review of B1 (M3): a zone alone gives the next runs of the cadence it has.
        ...(timing ? { cadence: patch.cadence ?? s.view.cadence } : {}),
        timeZone,
        ...(patch.retention ? { retention: patch.retention } : {}),
        ...(patch.destinations ? { destinations: patch.destinations } : {}),
        ...(patch.keepOnServer !== undefined ? { keepOnServer: patch.keepOnServer } : {}),
        locale: env.language,
      })
    ).body as SchedulePreview
    if (preview.problem) throw new Refusal(`cadence_${preview.problem.reason}`, cadenceHint(preview.problem))
    // As the route checks every save (review of B1, M8): an unencrypted one judged on the
    // destinations it will have, an encrypted one needs the owner's active key.
    if (s.view.format !== 'mmbak') {
      const ids = (patch.destinations as string[] | undefined) ?? s.view.destinations.map((d) => d.id)
      const plain = plainProblem(env.ctx, unattended(env.principal), s.c.id, s.view.dump, ids)
      if (plain) throw new Refusal(plain)
    } else if (!env.ctx.backup.keys.active(ownerOf(env.principal))) throw new Refusal('key_required')
    // Review of B1 (M2): as the route counts them — only a change of what decides what is kept.
    const keeping = (['retention', 'timeZone', 'destinations', 'keepOnServer'] as const).some(
      (k) => patch[k] !== undefined && JSON.stringify(patch[k]) !== JSON.stringify(current[k]),
    )
    const removals = keeping ? preview.removals.reduce((n, r) => n + r.count, 0) : 0
    const shown = { updateSchedule: s.view.name, ...patch, ...(names ? { destinations: names } : {}) }
    return scheduleProposal(
      s,
      shown,
      {
        ...(timing ? { nextRuns: preview.runs.slice(0, 3), words: preview.words, timeZone } : {}),
        // Review of B1 (M3): a paused schedule's new runs wait for it to be resumed.
        ...(timing && s.view.state === 'paused' ? { paused: true } : {}),
        ...(patch.retention ? { retention: patch.retention as RetentionPolicy } : {}),
        ...(removals ? { removals } : {}),
      },
      async (auth) => {
        const r = await callRoute(env.app, auth, 'PATCH', `/backup-schedules/${s.view.id}`, {
          ...patch,
          ...(removals > RETENTION_CONFIRM_ABOVE ? { confirmRemovals: removals } : {}),
        })
        return r.status < 300 ? done({ schedule: s.view.name, did: 'updated' }) : failed(r)
      },
    )
  },

  delete_schedule: async (env, a: ToolArgs<'delete_schedule'>) => {
    const s = await scheduleNamed(env, a.schedule, 'delete_schedule', a.connection)
    // As the schedules page: its name typed; its backups and copies stay.
    return scheduleProposal(
      s,
      { deleteSchedule: s.view.name },
      { backupsStay: true },
      async (auth) => {
        const r = await callRoute(env.app, auth, 'DELETE', `/backup-schedules/${s.view.id}`)
        return r.status < 300 ? done({ schedule: s.view.name, did: 'deleted' }) : failed(r)
      },
      { typed: s.view.name, destructive: true },
    )
  },

  /**
   * Design 2026-10-25 (B3): the server's health, read as the person's Performance tab reads it (under
   * server:monitor) — numbers, names and kinds; never its host, a command's text nor a value.
   */
  server_status: async (env, a: ToolArgs<'server_status'>) => {
    const c = need(env, a.connection)
    const s = (await read(env, 'GET', `${connPath(c)}/server/status`)).body as ServerSample
    const mb = (bytes: number) => Math.round(bytes / 1_048_576)
    const status = {
      version: s.version,
      uptimeHours: Math.round((s.uptimeSec / 3600) * 10) / 10,
      connections: s.connections,
      // A first reading has none before it: no rates yet.
      ...(s.baseline ? { ratesMeasured: false } : { opsPerSecond: s.ops, network: s.network }),
      ...(s.restarted ? { restartedSinceLastReading: true } : {}),
      memory: s.memory,
      ...(s.cache
        ? {
            cache: {
              usedMb: mb(s.cache.usedBytes),
              dirtyMb: mb(s.cache.dirtyBytes),
              maxMb: mb(s.cache.maxBytes),
            },
          }
        : {}),
      queues: s.queues,
    }
    return result(
      { place: placeOf(c), state: 'done', sent: 'stats', summary: s.version ? { version: s.version } : {} },
      status,
      c.id,
    )
  },

  replica_set: async (env, a: ToolArgs<'replica_set'>) => {
    const c = need(env, a.connection)
    const told = replicaTold((await read(env, 'GET', `${connPath(c)}/server/replica`)).body as ReplicaAnswer)
    const members = Array.isArray(told.members) ? told.members.length : 0
    return result(
      {
        place: placeOf(c),
        state: 'done',
        sent: 'stats',
        summary: members ? { members } : { mode: String(told.mode) },
      },
      told,
      c.id,
    )
  },

  server_top: async (env, a: ToolArgs<'server_top'>) => {
    const c = need(env, a.connection)
    const body = (await read(env, 'GET', `${connPath(c)}/server/top`)).body as {
      collections: Array<{ ns: string; totalMs: number; readMs: number; writeMs: number; count: number }>
    }
    const collections = body.collections.flatMap(({ ns, ...times }) => {
      const place = toldNamespace(ns, c)
      return place ? [{ ...place, ...times }] : []
    })
    return result(
      { place: placeOf(c), state: 'done', sent: 'stats', summary: { collections: collections.length } },
      { collections },
      c.id,
    )
  },

  slow_queries: async (env, a: ToolArgs<'slow_queries'>) => {
    const c = need(env, a.connection)
    if (a.collection && !a.database)
      throw new Refusal('invalid_arguments', 'a collection is named with its database')
    const q = new URLSearchParams({ limit: String(SLOW_TOLD) })
    if (a.database) q.set('db', a.database)
    if (a.collection) q.set('coll', a.collection)
    const body = (await read(env, 'GET', `${connPath(c)}/server/slow-queries?${q}`)).body as {
      entries: SlowQuery[]
      refused: Record<string, string>
    }
    // The command (its values) and an explain origin are never told: the shape of each, by numbers.
    // Review of B3 (I3): nor the keys examined — over an index of personal data they tell how many
    // values a document holds there (documents examined and returned tell the scan).
    const queries = body.entries.flatMap((x) => {
      const place = toldNamespace(x.ns, c)
      if (!place) return []
      return [
        {
          ...place,
          at: x.ts,
          source: x.source,
          op: x.op,
          durationMs: x.durationMs,
          ...(x.planSummary ? { planSummary: x.planSummary } : {}),
          ...(x.docsExamined !== undefined ? { docsExamined: x.docsExamined } : {}),
          ...(x.nreturned !== undefined ? { returned: x.nreturned } : {}),
        },
      ]
    })
    return result(
      {
        place: placeOf(c, a.database, a.collection),
        state: 'done',
        sent: 'stats',
        summary: { queries: queries.length },
      },
      // M5: what could not be read, by its code (no_db, not_permitted, error).
      { queries, ...(Object.keys(body.refused ?? {}).length ? { notRead: body.refused } : {}) },
      c.id,
    )
  },

  index_advice: async (env, a: ToolArgs<'index_advice'>) => {
    const c = need(env, a.connection)
    const advice = (
      await read(env, 'GET', `${connPath(c)}/server/index-advice?${new URLSearchParams({ db: a.database })}`)
    ).body as IndexAdvice
    const suggestions = advice.suggestions.flatMap((s) => {
      const place = toldNamespace(s.ns, c)
      return place
        ? [{ ...place, keys: s.key, queries: s.count, avgMs: s.avgMs, ratio: s.ratio, reason: s.reason }]
        : []
    })
    const unneeded = advice.unneeded.flatMap((u) => {
      const place = toldNamespace(u.ns, c)
      return place
        ? [{ ...place, index: u.name, keys: u.key, reason: u.reason, ...(u.of ? { of: u.of } : {}) }]
        : []
    })
    return result(
      {
        place: placeOf(c, a.database),
        state: 'done',
        sent: 'indexes',
        summary: { suggestions: suggestions.length, unneeded: unneeded.length },
      },
      {
        suggestions,
        unneeded,
        ...(advice.skipped ? { collectionsLeftOut: advice.skipped } : {}),
        ...(Object.keys(advice.refused ?? {}).length ? { notRead: advice.refused } : {}),
      },
      c.id,
    )
  },

  current_operations: async (env, a: ToolArgs<'current_operations'>) => {
    const c = need(env, a.connection)
    const listed = await runningOps(env, c, a.database)
    const operations = listed.operations.flatMap((o) => {
      const place = o.ns ? toldNamespace(o.ns, c) : {}
      if (!place) return []
      return [
        {
          opid: o.opid,
          op: o.op,
          ...place,
          secsRunning: o.secsRunning,
          ...(o.waitingForLock ? { waitingForLock: true } : {}),
          ...(o.planSummary ? { planSummary: o.planSummary } : {}),
          // Review of B3 (M1): Mongo Manager's own work (a job, a request through the app) is stopped
          // where it runs, never by a kill.
          ...(o.own ? { appOwn: true } : {}),
          ...(o.killable === false ? { stoppable: false } : {}),
        },
      ]
    })
    return result(
      {
        place: placeOf(c, a.database),
        state: 'done',
        sent: 'stats',
        summary: { operations: operations.length },
      },
      {
        operations,
        ...(listed.more ? { more: true } : {}),
        // M4: an account that may not see others' operations sees its own only — said so.
        ...(listed.scope === 'own' ? { onlyOwn: true } : {}),
      },
      c.id,
    )
  },

  /** B3: one running operation stopped, by its opid as current_operations told it — the opid typed. */
  kill_operation: async (env, a: ToolArgs<'kill_operation'>) => {
    const c = need(env, a.connection)
    // Review of B3 (I2, M2): read-only, the agent's switch and server:operations, before any lookup.
    if (c.info.readOnly) throw new Refusal('read_only')
    mayChange('kill_operation', c)
    // As the route: running now, as this account sees it — never a made-up opid.
    // Third review of B3 (M8): asked for by its opid, however many run.
    const op = (await runningOps(env, c, undefined, a.opid)).operations.find((o) => o.opid === a.opid)
    // Re-review of B3 (nit): one the agent was never told of (a namespace it may not be told) is unknown.
    if (!op || (op.ns && !toldNamespace(op.ns, c))) throw new Refusal('operation_unknown')
    if (op.own) throw new Refusal('operation_own')
    // M1: one another member runs (a set read from a secondary) is listed, never stopped.
    if (op.killable === false) throw new Refusal('operation_not_primary')
    const { db, coll } = splitNs(op.ns)
    // Never MongoDB's own databases (a command's "$cmd" is no collection).
    const place = { db: db || undefined, coll: coll && coll !== '$cmd' ? coll : undefined }
    mayChange('kill_operation', c, place.db, place.coll)
    return proposal(
      c,
      place.db,
      place.coll,
      { killOperation: op.opid },
      { operation: op.op, ...(op.ns ? { namespace: op.ns } : {}), secsRunning: op.secsRunning },
      async (auth) => {
        // I1: what the card said runs under that opid still — its namespace, kind, start and member
        // (re-review, M-2) — else nothing is stopped; one finished is said by the route.
        const r = await callRoute(
          env.app,
          auth,
          'POST',
          `${connPath(c)}/server/operations/${enc(op.opid)}/kill`,
          {
            ns: op.ns,
            op: op.op,
            ...(op.startedAt !== undefined ? { startedAt: op.startedAt } : {}),
            ...(op.member ? { member: op.member } : {}),
          },
        )
        return r.status < 300 ? done({ killed: op.opid }) : failed(r)
      },
      { typed: op.opid, destructive: true },
    )
  },

  /**
   * Design 2026-10-25 (B4): MongoDB's users, as Database Access lists them (databases:admin) — names,
   * databases and roles only; never a credential.
   */
  list_users: async (env, a: ToolArgs<'list_users'>) => {
    const c = need(env, a.connection)
    mayManageUsers(env, c)
    const q = a.database ? `?${new URLSearchParams({ db: a.database })}` : ''
    const body = (await read(env, 'GET', `${connPath(c)}/database-access/users${q}`)).body as DbUsersAnswer
    const users = body.users.map((u) => ({
      user: u.user,
      database: u.db,
      roles: u.roles.map((r) => `${r.role}@${r.db}`),
      // The connection signs in as it: never dropped by the agent.
      ...(u.own ? { connectionSignsInAs: true } : {}),
      ...(u.restrictions ? { restrictions: u.restrictions } : {}),
    }))
    return result(
      { place: placeOf(c, a.database), state: 'done', sent: 'names', summary: { users: users.length } },
      { users, ...(body.more ? { more: true } : {}), ...(body.refused ? { someNotRead: true } : {}) },
      c.id,
    )
  },

  /** B4: a database's custom roles — what they inherit and how many privileges they hold. */
  list_roles: async (env, a: ToolArgs<'list_roles'>) => {
    const c = need(env, a.connection)
    mayManageUsers(env, c)
    const listed = await customRoles(env, c, a.database)
    const roles = listed.roles.map((r) => ({
      role: r.role,
      database: r.db,
      inherits: r.roles.map((x) => `${x.role}@${x.db}`),
      privileges: r.privileges?.length ?? null,
      ...(r.broad ? { overTheDeployment: true } : {}),
    }))
    return result(
      { place: placeOf(c, a.database), state: 'done', sent: 'names', summary: { roles: roles.length } },
      {
        roles,
        ...(listed.more ? { more: true } : {}),
        // Review of B4 (M4): what MongoDB would not list is said, never read as "none".
        ...(listed.refused ? { someNotRead: true } : {}),
      },
      c.id,
    )
  },

  /** B4: a user created with roles on a card — its password typed there, never the model's. */
  create_user: async (env, a: ToolArgs<'create_user'>) => {
    const c = need(env, a.connection)
    // One with no password (Kerberos, LDAP, x.509) is made from Database Access.
    if (a.database === EXTERNAL_DB) throw new Refusal('external_user')
    mayManageUsers(env, c)
    if (c.info.readOnly) throw new Refusal('read_only')
    // The agent's switch and databases:admin; a user's database may be admin (no namespace checks).
    mayChange('create_user', c)
    // Review of B4 (I1, M5): never in MongoDB's own databases nor a drill's scratch copy; names as
    // MongoDB takes them.
    userDatabase(a.database)
    if (!UserNameSchema.safeParse(a.user).success || DOT_NAMES.has(a.user))
      throw new Refusal('invalid_arguments', 'not a user name')
    const roles = a.roles.map((r) => roleRefOf(r, a.database))
    if (await userNamed(env, c, a.database, a.user)) throw new Refusal('user_exists')
    // No right over the whole deployment: those are given from Database Access, confirmed there.
    await refuseBroad(env, c, roles)
    const payload = { createUser: a.user, database: a.database, roles: roles.map((r) => `${r.role}@${r.db}`) }
    return proposal(
      c,
      a.database,
      undefined,
      payload,
      {},
      // The route checks again on the click: never sent `confirmBroad`, a role made broad since is
      // refused there; a user made since too (user_exists).
      async (auth, input) => {
        const r = await callRoute(env.app, auth, 'POST', `${connPath(c)}/database-access/users`, {
          db: a.database,
          user: a.user,
          password: input.password,
          roles,
        })
        return r.status < 300 ? done({ created: a.user }) : failed(r)
      },
      { password: true, passwordFor: 'user' },
    )
  },

  /** B4: a user dropped, its name typed — never the account the connection signs in as. */
  drop_user: async (env, a: ToolArgs<'drop_user'>) => {
    const c = need(env, a.connection)
    mayManageUsers(env, c)
    if (c.info.readOnly) throw new Refusal('read_only')
    mayChange('drop_user', c)
    if (a.database !== EXTERNAL_DB) userDatabase(a.database)
    if (DOT_NAMES.has(a.user)) throw new Refusal('invalid_arguments', 'not a user name')
    const user = await userNamed(env, c, a.database, a.user)
    if (!user) throw new Refusal('user_unknown')
    if (user.own) throw new Refusal('own_account')
    return proposal(
      c,
      a.database,
      undefined,
      { dropUser: a.user, database: a.database },
      user.roles.length ? { roles: user.roles.length } : {},
      async (auth) => {
        const path = `${connPath(c)}/database-access/users/${enc(a.database)}/${enc(a.user)}`
        const r = await callRoute(env.app, auth, 'DELETE', path)
        return r.status < 300 ? done({ dropped: a.user }) : failed(r)
      },
      { typed: a.user, destructive: true },
    )
  },

  /**
   * Design 2026-10-25 (C1): an export as a card — the person's own (data:export, or an export
   * granted), with their rights and hidden fields, started on their click and followed as a job. A
   * find or a read-only pipeline, checked as a read is; never one of MongoDB's own namespaces.
   */
  /**
   * Design 2026-10-25 (C3): validation rules on a card — tested first against the documents there (how
   * many break them), checked as a filter is (no personal field told), saved only over the rules the
   * card was made from.
   */
  set_validator: async (env, a: ToolArgs<'set_validator'>) => {
    const c = need(env, a.connection)
    mayChange('set_validator', c, a.database, a.collection)
    // Review of C3 (I1): with client-side encryption a validator is the encryption's own schema —
    // replaced or removed here, new writes would go in plain: never through the agent.
    if (c.record.settings.encryption?.enabled) throw new Refusal('encrypted_connection')
    // Review of C3 (M10): rules are removed by an explicit {} only (a blank argument is no "remove all").
    if (typeof a.validator === 'string' && !a.validator.trim())
      throw new Refusal('invalid_arguments', 'validator: the rules, or {} to remove them')
    const validator = objectArg(a.validator, 'validator', {})
    noServerJs(validator)
    const removes = Object.keys(validator).length === 0
    const path = `${collPath(c, a.database, a.collection)}/validation`
    const state = (await read(env, 'GET', path)).body as ValidationState
    if (state.kind === 'view') throw new Refusal('target_is_view')
    // Review of C3 (M9): as the Validation tab — no rules on a time series; errorAndLog where MongoDB has it.
    if (state.kind === 'timeseries') throw new Refusal('validator_timeseries')
    if (removes && state.validator === null) throw new Refusal('no_rules')
    // Review of C3 (M8): the level and the action the rules have, unless asked otherwise.
    const level = a.level ?? state.validationLevel
    const action = a.action ?? state.validationAction
    if (action === 'errorAndLog' && !versionAtLeast(state.serverVersion, ERROR_AND_LOG_SINCE))
      throw new Refusal('validator_action_unsupported')
    const query: AiQuery = { validator: decoded(validator) }
    let tested: { failing?: number; failingAtLeast?: true; failingUnknown?: true; total?: number } = {}
    if (!removes) {
      // A validator is a filter: it answers about the fields it names (a personal one is refused).
      await gated(env, c, a.database, a.collection, query)
      const t = (await read(env, 'POST', `${path}/test`, { validator: wire(validator) }))
        .body as ValidationTestResult
      tested = {
        total: t.total,
        ...(t.failing !== null
          ? { failing: t.failing }
          : t.failingAtLeast !== undefined
            ? t.failingAtLeast >= VALIDATION_BOUND
              ? { failing: t.failingAtLeast, failingAtLeast: true as const }
              : { failing: t.failingAtLeast }
            : { failingUnknown: true as const }),
      }
    }
    return proposal(
      c,
      a.database,
      a.collection,
      { validator: wire(validator), validationLevel: level, validationAction: action },
      {
        ...tested,
        replaces: state.validator !== null,
        ...(removes ? { removes: true } : {}),
        ...(level !== state.validationLevel ? { level, levelWas: state.validationLevel } : {}),
        ...(action !== state.validationAction ? { action, actionWas: state.validationAction } : {}),
        // Re-review of C3 (minor 6): the rules replaced, as the person may see them (the route's own read
        // masked them), shown beside what is sent.
        ...(state.validator !== null ? { currentRules: state.validator } : {}),
      },
      async (auth) => {
        // Review of C3 (M6): rules named personal since the card are checked again on the click.
        if (!removes) {
          const refusedNow = await gatedAgain(env, c, a.database, a.collection, query)
          if (refusedNow) return refusedNow
        }
        const r = await callRoute(env.app, auth, 'PUT', path, {
          validator: removes ? null : wire(validator),
          validationLevel: level,
          validationAction: action,
          // Only over the rules the card was made from.
          expected: state.version,
        })
        if (r.status < 300) return done({ validator: removes ? 'removed' : 'set' })
        // Review of C3 (I4): the collection's rules changed since the card, said as such.
        const reason = (r.body as { details?: { reason?: unknown } } | null)?.details?.reason
        return r.status === 409 && reason === 'rules_changed'
          ? { state: 'error', reason: 'validator_changed' }
          : failed(r)
      },
      {
        shown: {
          validator: removes
            ? {}
            : shownTo(env, c, a.database, a.collection, { find: a.collection, filter: wire(validator) })
                .filter,
          validationLevel: level,
          validationAction: action,
        },
        // Review of C3 (M10): replacing or removing rules changes what may be written: said as such.
        ...(state.validator !== null || (level !== 'off' && action !== 'warn' && (tested.failing ?? 0) > 0)
          ? { destructive: true }
          : {}),
      },
    )
  },

  /** Design 2026-10-25 (C3): a search index on a card — only where the server has search. */
  create_search_index: async (env, a: ToolArgs<'create_search_index'>) => {
    const c = need(env, a.connection)
    mayChange('create_search_index', c, a.database, a.collection)
    if (!SearchIndexNameSchema.safeParse(a.name).success)
      throw new Refusal('invalid_arguments', 'not an index name')
    const definition = objectArg(a.definition, 'definition', {})
    noServerJs(definition)
    // Where personal data is hidden from this person, the route changes nothing there.
    const masker = maskerForPrincipal(env.ctx, env.principal, c.id)
    if (masker?.anyInDb(a.database)) throw new Refusal('masking_unsupported')
    // Review of C3 (I5): nor, for anyone, where personal-data rules apply to the collection.
    await gated(env, c, a.database, a.collection, { searchIndex: true })
    const type = a.type ?? 'search'
    // Review of C3 (M9): checked as the route checks it (its size, a vector definition) before any card.
    const body = CreateSearchIndexSchema.safeParse({ name: a.name, type, definition: wire(definition) })
    if (!body.success)
      throw new Refusal('invalid_arguments', body.error.issues[0]?.message ?? 'not a search index')
    if (type === 'vectorSearch') {
      const problem = vectorDefinitionProblem(definition)
      if (problem) throw new Refusal('invalid_arguments', VECTOR_PROBLEMS[problem])
    }
    const path = `${collPath(c, a.database, a.collection)}/search-indexes`
    const listed = (await read(env, 'GET', path)).body as
      | { supported: true; indexes: Array<{ name: string }> }
      | { supported: false; reason: string; indexes: [] }
    if (!listed.supported) throw new Refusal(`search_${listed.reason}`)
    if (listed.indexes.some((i) => i.name === a.name)) throw new Refusal('exists')
    return proposal(
      c,
      a.database,
      a.collection,
      { createSearchIndex: a.name, type, definition: wire(definition) },
      {},
      async (auth) => {
        // Re-review of C3 (minor 5): rules added since the card refuse it now too.
        const refusedNow = await gatedAgain(env, c, a.database, a.collection, { searchIndex: true })
        if (refusedNow) return refusedNow
        const r = await callRoute(env.app, auth, 'POST', path, {
          name: a.name,
          type,
          definition: wire(definition),
        })
        return r.status < 300 ? done({ created: a.name }) : failed(r)
      },
    )
  },

  /**
   * Design 2026-10-25 (C3): a collection renamed on a card that takes its name typed — never onto a
   * name taken or a system one, nor where personal-data rules name the collection (they would stay with
   * the old name: its data unmasked under the new one).
   */
  rename_collection: async (env, a: ToolArgs<'rename_collection'>) => {
    const c = need(env, a.connection)
    mayChange('rename_collection', c, a.database, a.collection)
    mayChange('rename_collection', c, a.database, a.to)
    if (!CollectionNameSchema.safeParse(a.to).success || a.to === a.collection)
      throw new Refusal('invalid_arguments', 'not another collection name')
    // Review of C3b (minor 2): where client-side encryption is on, its schema names the namespace: the
    // renamed collection's writes would go in plain.
    if (c.record.settings.encryption?.enabled) throw new Refusal('encrypted_connection')
    const renameRefused = () => {
      // Review of C4 (M8): client-side encryption turned on since the card.
      if (env.recheck(c)?.record.settings.encryption?.enabled) return 'encrypted_connection'
      if (
        env.ctx.personalFields
          .get(c.id)
          .rules.some((r) => r.coll === a.collection && (r.db === '*' || r.db === a.database))
      )
        return 'rules_follow_name'
      const masker = maskerForPrincipal(env.ctx, env.principal, c.id)
      return masker?.anyInDb(a.database) ? 'masking_unsupported' : null
    }
    const refusedFirst = renameRefused()
    if (refusedFirst) throw new Refusal(refusedFirst)
    const listed = await collectionsListed(env, c, a.database)
    const self = listed.find((x) => x.name === a.collection)
    if (!self) throw new Refusal('not_found')
    // Review of C3b (minor 1): MongoDB renames neither a view nor a time series.
    if (self.type === 'view') throw new Refusal('rename_view')
    if (self.type === 'timeseries') throw new Refusal('rename_timeseries')
    if (listed.some((x) => x.name === a.to)) throw new Refusal('exists')
    // Review of C3b (nit): the views reading it find nothing once it is renamed — said on the card.
    const views = listed.filter((x) => x.type === 'view' && x.options?.viewOn === a.collection).length
    return proposal(
      c,
      a.database,
      a.collection,
      { renameCollection: `${a.database}.${a.collection}`, to: `${a.database}.${a.to}` },
      views ? { viewsLeft: views } : {},
      async (auth) => {
        // Review of C3b (I3): rules named since the card refuse it now, for anyone.
        const refusedNow = renameRefused()
        if (refusedNow) return { state: 'error', reason: refusedNow }
        const r = await callRoute(env.app, auth, 'POST', `${collPath(c, a.database, a.collection)}/rename`, {
          to: a.to,
        })
        return r.status < 300 ? done({ renamed: a.to }) : failed(r)
      },
      { typed: a.collection, destructive: true },
    )
  },

  /**
   * Design 2026-10-25 (C3): a collection copied on a card, as the app's Copy does — from the person's
   * own plan (its refusals said before any card; the agent never confirms personal data or TTL
   * indexes for them), followed as a job; a replace takes the target's name typed.
   */
  copy_collection: async (env, a: ToolArgs<'copy_collection'>) => {
    const c = need(env, a.connection)
    // Review of C3b (I4): a card, as every change — none where the agent may not propose one.
    if (!c.record.aiAgentWrites) throw new Refusal('agent_writes_off')
    if (!mayExport(env.ctx, env.principal, c.id)) throw new Refusal('forbidden')
    exportable(a.database, a.collection, c)
    const target = a.toConnection ? need(env, a.toConnection) : c
    const toDb = a.toDatabase ?? a.database
    // The target is written: the agent's switch there, the person's rights there, never a system namespace.
    mayChange('copy_collection', target, toDb, a.toCollection)
    // Review of C3b (minor 3): documents written as stored where client-side encryption is on — never
    // proposed by the agent (W8), as its other document writes.
    if (target.record.settings.encryption?.enabled) throw new Refusal('encrypted_connection')
    if (!CollectionNameSchema.safeParse(a.toCollection).success)
      throw new Refusal('invalid_arguments', 'not a collection name')
    const given = givenArg
    if (given(a.pipeline) && given(a.filter))
      throw new Refusal('invalid_arguments', 'a filter or a pipeline, not both')
    let source: Record<string, unknown> = { kind: 'collection' }
    // Review of C3b (I1, I2): what picks the documents is the gate's for everyone (what it picks by
    // could be counted in the target), checked again on the click, and shown masked as it goes.
    let query: AiQuery | null = null
    let shownPick: Record<string, unknown> = {}
    if (given(a.pipeline)) {
      const stages = stagesArg(a.pipeline!)
      if (!stages.length) throw new Refusal('invalid_arguments', 'pipeline needs at least one stage')
      noServerJs(stages)
      if (writesAt(stages)) throw new Refusal('write_pipeline')
      await sourcesAllowed(env, c, a.database, a.collection, stages)
      query = { stages: stages.map(decoded) }
      source = { kind: 'pipeline', stages: wire(stages) }
      shownPick = {
        pipeline: shownTo(env, c, a.database, a.collection, {
          aggregate: a.collection,
          pipeline: wire(stages),
        }).pipeline,
      }
    } else if (given(a.filter)) {
      const filter = objectArg(a.filter, 'filter', {})
      noServerJs(filter)
      await sourcesAllowed(env, c, a.database, a.collection)
      query = { filter: decoded(filter) }
      source = { kind: 'query', filter: wire(filter) }
      shownPick = {
        filter: shownTo(env, c, a.database, a.collection, { find: a.collection, filter: wire(filter) })
          .filter,
      }
    } else await sourcesAllowed(env, c, a.database, a.collection)
    const picks = async (): Promise<string | null> => {
      if (!query) return null
      const g = await gated(env, c, a.database, a.collection, query)
      // A pipeline the gate would run otherwise (personal fields compared or grouped) copies what it
      // picks by them: refused, as a filter on one is.
      return 'stages' in query && g.stages && !sameValue(g.stages, query.stages) ? 'personal_field' : null
    }
    const pickRefused = await picks()
    if (pickRefused) throw new Refusal(pickRefused)
    const mode = a.mode ?? 'insert'
    const body = { source, target: { connectionId: target.id, db: toDb, coll: a.toCollection }, mode }
    const plan = (await read(env, 'POST', `${collPath(c, a.database, a.collection)}/copy/plan`, body))
      .body as CopyPlan
    // The plan's refusals, by their own words (a confirmation the agent never gives is one).
    if (plan.refusals.length) throw new Refusal(copyRefusal(plan.refusals[0]!), plan.refusals.join(', '))
    const one = plan.collections[0]
    if (!one || one.skipped) throw new Refusal('copy_refused', one?.skipped ?? 'nothing to copy')
    // Review of C3b (I5): into a collection there already, every mode but insert changes its documents.
    const overwrites = one.exists && mode !== 'insert'
    // Review of C3b (minor 6): how many a filter picks, as the person's own count says.
    let picked: { documents?: number; documentsAtLeast?: true; documentsAbout?: true } = {}
    if (source.kind === 'collection' && typeof one.sourceCount === 'number')
      picked = { documents: one.sourceCount, documentsAbout: true }
    else if (source.kind === 'query') {
      const answer = (
        await read(env, 'POST', `${collPath(c, a.database, a.collection)}/count`, { filter: source.filter })
      ).body as { count: number | null; exact?: boolean; atLeast?: number }
      const n = answer.count ?? answer.atLeast
      if (typeof n === 'number')
        picked = {
          documents: n,
          ...(answer.count === null && n >= COUNT_BOUND ? { documentsAtLeast: true as const } : {}),
          ...(answer.count !== null && answer.exact === false ? { documentsAbout: true as const } : {}),
        }
    }
    const shownCopy = {
      copy: `${a.database}.${a.collection}`,
      to: `${target.label} / ${toDb}.${a.toCollection}`,
      mode,
    }
    return proposal(
      c,
      a.database,
      a.collection,
      shownCopy,
      {
        mode,
        targetExists: one.exists,
        ...(one.exists && typeof one.count === 'number' ? { targetDocuments: one.count } : {}),
        ...picked,
        ...(plan.masked ? { masked: true } : {}),
      },
      async (auth) => {
        // Review of C3b (I4): the target's switches as they are now — the decide route reads the source's.
        const now = env.recheck(target)
        // Review of C4 (nit): a target gone since the card, said as such.
        if (!now) return { state: 'error', reason: 'not_found' }
        if (!now.record.aiAgentWrites) return { state: 'error', reason: 'agent_writes_off' }
        // Review of C4 (M8): client-side encryption turned on there since the card.
        if (now.record.settings.encryption?.enabled) return { state: 'error', reason: 'encrypted_connection' }
        if (now.record.aiAgentToolsOff.includes('copy_collection'))
          return { state: 'error', reason: 'tool_off' }
        if (now.record.aiPolicy === 'off') return { state: 'error', reason: 'ai_off' }
        // Review of C4 (nit): the gate once — its refusal, or a pick it would run otherwise.
        try {
          const pickedNow = await picks()
          if (pickedNow) return { state: 'error', reason: pickedNow }
        } catch (e) {
          if (e instanceof Refusal) return { state: 'error', reason: e.reason }
          throw e
        }
        const r = await callRoute(env.app, auth, 'POST', `${collPath(c, a.database, a.collection)}/copy`, {
          ...body,
          planHash: plan.planHash,
        })
        const job = (r.body as { job?: { id?: unknown } } | null)?.job?.id
        return r.status < 300
          ? done({ started: true, ...(typeof job === 'string' ? { job } : {}) })
          : failed(r)
      },
      // Into a collection there already: a replace takes its name typed; any other mode changes it.
      {
        shown: { ...shownCopy, ...shownPick },
        ...(overwrites
          ? { typed: `${toDb}.${a.toCollection}`, destructive: true }
          : one.exists
            ? { destructive: true }
            : {}),
        // C4: a target whose documents a copy changes, backed up first on asking.
        ...(overwrites ? { backup: backupOffer(env, target, toDb, a.toCollection) } : {}),
      },
    )
  },

  export_documents: async (env, a: ToolArgs<'export_documents'>) => {
    const c = need(env, a.connection)
    // Review of C1 (I1): a card, as every change — none where the agent may not propose one.
    if (!c.record.aiAgentWrites) throw new Refusal('agent_writes_off')
    if (!mayExport(env.ctx, env.principal, c.id)) throw new Refusal('forbidden')
    // Review of 1.0.1 (I1): an SQL file is the SQL → MongoDB plugin's, as the export route says.
    if (a.format === 'sql' && !env.ctx.plugins.runs(SQL_PLUGIN))
      throw new Refusal(
        'sql_plugin_off',
        'SQL comes with the SQL → MongoDB plugin, which is off: offer another format',
      )
    exportable(a.database, a.collection, c)
    // Review of C1 (M4): a field left blank is none.
    // Re-review (nit): an empty object is none too, beside a pipeline.
    const given = givenArg
    const piped = given(a.pipeline)
    if (piped && [a.filter, a.projection, a.sort].some(given))
      throw new Refusal('invalid_arguments', 'a find or a pipeline, not both')
    if (piped && a.limit) throw new Refusal('invalid_arguments', 'add a $limit stage to the pipeline instead')
    let source: Record<string, unknown>
    let shownSource: Record<string, unknown>
    let counted: { documents?: number; documentsAtLeast?: true; documentsAbout?: true } = {}
    let pick: AiQuery | null = null
    if (piped) {
      const stages = stagesArg(a.pipeline!)
      if (!stages.length) throw new Refusal('invalid_arguments', 'pipeline needs at least one stage')
      noServerJs(stages)
      // An export reads: a pipeline that writes is refused here, wherever its stage stands.
      if (writesAt(stages)) throw new Refusal('write_pipeline')
      await sourcesAllowed(env, c, a.database, a.collection, stages)
      source = { kind: 'pipeline', stages: wire(stages) }
      shownSource = {
        // Re-review of C1 (I1): masked as it goes (canonical Extended JSON), as the other cards are.
        pipeline: shownTo(env, c, a.database, a.collection, {
          aggregate: a.collection,
          pipeline: wire(stages),
        }).pipeline,
      }
    } else {
      const filter = given(a.filter) ? objectArg(a.filter, 'filter', {}) : {}
      const projection = given(a.projection) ? objectArg(a.projection, 'projection') : undefined
      const sort = given(a.sort) ? objectArg(a.sort, 'sort') : undefined
      noServerJs(filter, projection, sort)
      await sourcesAllowed(env, c, a.database, a.collection)
      // Final review of wave C (minor 1): what it picks by is the gate's for everyone, as a copy's is —
      // the export's job counts its filter, and its progress is said to the model. Checked again on
      // the click.
      if (Object.keys(filter).length) pick = { filter: decoded(filter) }
      source = {
        kind: 'query',
        filter: wire(filter),
        ...(projection ? { projection: wire(projection) } : {}),
        ...(sort ? { sort: wire(sort) } : {}),
        ...(a.limit ? { limit: a.limit } : {}),
      }
      // Review of C1 (I2): the card shows what goes — as this person may see it.
      const masked = shownTo(env, c, a.database, a.collection, {
        find: a.collection,
        filter: wire(filter),
        ...(projection ? { projection: wire(projection) } : {}),
        ...(sort ? { sort: wire(sort) } : {}),
      })
      shownSource = {
        filter: masked.filter,
        ...(projection ? { projection: masked.projection } : {}),
        ...(sort ? { sort: masked.sort } : {}),
        ...(a.limit ? { limit: a.limit } : {}),
      }
      // How many go, as the person's own count says — "at least" where it could only bound it (M3).
      const answer = (
        await read(env, 'POST', `${collPath(c, a.database, a.collection)}/count`, { filter: wire(filter) })
      ).body as { count: number | null; exact?: boolean; atLeast?: number }
      const n = answer.count ?? answer.atLeast
      // Re-review of C1 (M5, nit): a bound reached is "at least" (below its cap it is the count); an
      // estimate (no filter) is "about"; under the limit asked, the limit is what goes.
      const reached = a.limit !== undefined && typeof n === 'number' && n >= a.limit
      if (typeof n === 'number')
        counted = {
          documents: a.limit ? Math.min(n, a.limit) : n,
          ...(!reached && answer.count === null && n >= COUNT_BOUND
            ? { documentsAtLeast: true as const }
            : {}),
          ...(!reached && answer.count !== null && answer.exact === false
            ? { documentsAbout: true as const }
            : {}),
        }
    }
    if (pick) await gated(env, c, a.database, a.collection, pick)
    const dialect = a.format === 'sql' ? (a.dialect ?? 'postgres') : undefined
    const body = {
      source,
      format: a.format,
      ...(a.gzip ? { gzip: true } : {}),
      ...(dialect ? { sql: { dialect } } : {}),
    }
    return proposal(
      c,
      a.database,
      a.collection,
      { export: `${a.database}.${a.collection}`, format: a.format },
      {
        format: a.format,
        ...counted,
        ...(dialect ? { dialect } : {}),
        ...(a.gzip ? { compressed: true } : {}),
      },
      async (auth) => {
        const again = pick ? await gatedAgain(env, c, a.database, a.collection, pick) : null
        if (again) return again
        const r = await callRoute(
          env.app,
          auth,
          'POST',
          `${collPath(c, a.database, a.collection)}/export`,
          body,
        )
        // The job is said back: the step opens it, where the file is downloaded.
        const job = (r.body as { job?: { id?: unknown } } | null)?.job?.id
        return r.status < 300
          ? done({ started: true, ...(typeof job === 'string' ? { job } : {}) })
          : failed(r)
      },
      {
        shown: {
          export: `${a.database}.${a.collection}`,
          format: a.format,
          ...(dialect ? { dialect } : {}),
          ...(a.gzip ? { gzip: true } : {}),
          ...shownSource,
        },
      },
    )
  },

  /**
   * Design 2026-10-25 (C7): the alerts the person may see — an administrator's history, anyone else's
   * bell — of the connections the agent is told of: what, where, when and numbers, never a value.
   */
  list_alerts: async (env, a: ToolArgs<'list_alerts'>) => {
    const on = a.connection ? need(env, a.connection, false) : null
    const admin = alertsAdmin(env)
    const list = (
      admin
        ? (
            await read(
              env,
              'GET',
              `/alerts/history?limit=50${a.state ? `&state=${a.state}` : ''}${on ? `&connectionId=${encodeURIComponent(on.id)}` : ''}`,
            )
          ).body
        : (await read(env, 'GET', '/alerts/active')).body
    ) as AlertView[]
    const told = list
      .filter((e) => !a.state || e.state === a.state)
      .flatMap((e) => {
        const c = e.connectionId ? toldConnection(env, e.connectionId, 'list_alerts') : null
        if (e.connectionId && !c) return []
        if (on && c?.id !== on.id) return []
        return [
          {
            id: e.id,
            ...(e.metric ? { metric: e.metric, value: e.value, threshold: e.threshold } : { event: e.event }),
            state: e.state,
            connection: c?.label ?? null,
            at: e.startedAt,
            ...(e.resolvedAt ? { resolvedAt: e.resolvedAt } : {}),
            // A report's run: its counts (numbers), for an administrator only (as the bell says them).
            ...(admin && e.event === 'report.ready'
              ? { report: e.detail.report, counts: reportCounts(e.detail) }
              : {}),
          },
        ]
      })
      .slice(0, 30)
    return result(
      { place: on ? placeOf(on) : null, state: 'done', sent: 'names', summary: { alerts: told.length } },
      {
        alerts: told,
        ...(admin ? {} : { note: 'Only the alerts in the person’s bell (they turn it on in Alerts).' }),
      },
      on?.id,
    )
  },

  /** C7: an administrator's alert rules and scheduled reports, their channels by name. */
  list_alert_rules: async (env, a: ToolArgs<'list_alert_rules'>) => {
    if (!alertsAdmin(env)) throw new Refusal('forbidden')
    const on = a.connection ? need(env, a.connection, false) : null
    const hooks = await webhookNames(env)
    const channels = (ch: AlertChannels) => ({
      inApp: ch.inApp,
      email: ch.email,
      webhooks: ch.webhooks.map((id) => hooks.get(id) ?? 'a deleted webhook'),
    })
    const rules = ((await read(env, 'GET', '/alerts/rules')).body as AlertRuleView[]).flatMap((r) => {
      const c = r.connectionId ? toldConnection(env, r.connectionId, 'list_alert_rules') : null
      if (r.connectionId && !c) return []
      if (on && c?.id !== on.id) return []
      return [
        {
          id: r.id,
          ...(r.kind === 'metric'
            ? {
                metric: r.metric,
                threshold: r.threshold,
                sustainMinutes: r.sustain,
                slowOpSeconds: r.slowOpSeconds,
              }
            : { event: r.event }),
          connection: c?.label ?? (r.kind === 'event' ? 'every connection' : null),
          enabled: r.enabled,
          channels: channels(r.channels),
          ...(r.snoozedUntil ? { snoozedUntil: r.snoozedUntil } : {}),
          ...(r.firing ? { firingSince: r.firing.since, value: r.firing.value } : {}),
        },
      ]
    })
    const reports = ((await read(env, 'GET', '/alerts/reports')).body as ReportView[]).flatMap((r) => {
      const c = toldConnection(env, r.connectionId, 'list_alert_rules')
      if (!c || (on && c.id !== on.id)) return []
      return [
        {
          id: r.id,
          name: r.name,
          connection: c.label,
          // Where and whether a filter picks — never the filter (its values are an administrator's).
          counts: r.measures.map((m) => ({
            label: m.label,
            namespace: `${m.db}.${m.coll}`,
            filtered: !!m.filter,
          })),
          cadence: describeCadence(r.cadence, env.language),
          timeZone: r.timeZone,
          enabled: r.enabled,
          channels: channels(r.channels),
          ...(r.nextRunAt ? { nextRun: new Date(r.nextRunAt).toISOString() } : {}),
          ...(r.lastRun
            ? { lastRun: { at: new Date(r.lastRun.at).toISOString(), counts: r.lastRun.values } }
            : {}),
        },
      ]
    })
    return result(
      {
        place: on ? placeOf(on) : null,
        state: 'done',
        sent: 'names',
        summary: { rules: rules.length, reports: reports.length },
      },
      { rules, reports },
      on?.id,
    )
  },

  /** C7: an alert rule on a card, through the alerts route as the person (an administrator). */
  create_alert_rule: async (env, a: ToolArgs<'create_alert_rule'>) => {
    if (!alertsAdmin(env)) throw new Refusal('forbidden')
    // A rule for every connection is the app's own (made on the Alerts page): the agent's are a connection's.
    if (!a.connection) throw new Refusal('invalid_arguments', 'name its connection')
    const c = need(env, a.connection)
    if (!c.record.aiAgentWrites) throw new Refusal('agent_writes_off')
    const ch = await channelsOf(env, a)
    const input =
      a.kind === 'metric'
        ? {
            kind: 'metric' as const,
            connectionId: c.id,
            metric: a.metric,
            threshold: a.threshold,
            sustain: a.sustain ?? 2,
            ...(a.metric === 'slowOps' ? { slowOpSeconds: a.slowOpSeconds ?? 5 } : {}),
            enabled: true,
            channels: ch.channels,
          }
        : { kind: 'event' as const, connectionId: c.id, event: a.event, enabled: true, channels: ch.channels }
    const parsed = AlertRuleInputSchema.safeParse(input)
    if (!parsed.success)
      throw new Refusal('invalid_arguments', parsed.error.issues[0]?.message ?? 'not an alert rule')
    const shown = {
      ...(a.kind === 'metric'
        ? { metric: a.metric, threshold: a.threshold, sustainMinutes: a.sustain ?? 2 }
        : { event: a.event }),
      connection: c.label,
      channels: ch.shown,
    }
    return alertCard(c, shown, { channels: ch.shown }, async (auth) => {
      const r = await callRoute(env.app, auth, 'POST', '/alerts/rules', parsed.data)
      return r.status < 300 ? done({ alertRule: 'created' }) : failed(r)
    })
  },

  update_alert_rule: async (env, a: ToolArgs<'update_alert_rule'>) => {
    const { rule, c } = await alertRuleNamed(env, a.rule, 'update_alert_rule')
    if (rule.kind !== 'metric' && (a.threshold !== undefined || a.sustain !== undefined))
      throw new Refusal('invalid_arguments', 'an event rule has no threshold')
    const changes = a.threshold !== undefined || a.sustain !== undefined || a.enabled !== undefined
    const named = a.inApp !== undefined || a.email !== undefined || a.webhooks !== undefined
    if (!changes && !named) throw new Refusal('invalid_arguments', 'nothing to change')
    const ch = named ? await channelsOf(env, a, rule.channels) : null
    const patch = {
      ...(a.threshold !== undefined ? { threshold: a.threshold } : {}),
      ...(a.sustain !== undefined ? { sustain: a.sustain } : {}),
      ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
      ...(ch ? { channels: ch.channels } : {}),
    }
    const shown = { rule: a.rule, ...patch, ...(ch ? { channels: ch.shown } : {}) }
    return alertCard(c, shown, ch ? { channels: ch.shown } : {}, async (auth) => {
      const r = await callRoute(env.app, auth, 'PATCH', `/alerts/rules/${enc(rule.id)}`, patch)
      return r.status < 300 ? done({ alertRule: 'updated' }) : failed(r)
    })
  },

  snooze_alert_rule: async (env, a: ToolArgs<'snooze_alert_rule'>) => {
    const { rule, c } = await alertRuleNamed(env, a.rule, 'snooze_alert_rule')
    return alertCard(
      c,
      { rule: rule.id, minutes: a.minutes || null },
      { snoozeMinutes: a.minutes || null },
      async (auth) => {
        const r = await callRoute(env.app, auth, 'POST', `/alerts/rules/${enc(rule.id)}/snooze`, {
          minutes: a.minutes || null,
        })
        return r.status < 300 ? done({ alertRule: a.minutes ? 'snoozed' : 'woken' }) : failed(r)
      },
    )
  },

  delete_alert_rule: async (env, a: ToolArgs<'delete_alert_rule'>) => {
    const { rule, c } = await alertRuleNamed(env, a.rule, 'delete_alert_rule')
    return alertCard(
      c,
      { deleteRule: rule.id, ...(rule.metric ? { metric: rule.metric } : { event: rule.event }) },
      {},
      async (auth) => {
        const r = await callRoute(env.app, auth, 'DELETE', `/alerts/rules/${enc(rule.id)}`)
        return r.status < 300 ? done({ alertRule: 'deleted' }) : failed(r)
      },
      true,
    )
  },

  /**
   * C7: a scheduled report on a card — its counts checked as the route checks them before any card
   * (no personal field, no view, none of MongoDB's own, no server JavaScript), its cadence's next
   * runs and words, its channels by name; made through the route as the person.
   */
  create_report: async (env, a: ToolArgs<'create_report'>) => {
    if (!alertsAdmin(env)) throw new Refusal('forbidden')
    const c = need(env, a.connection)
    if (!c.record.aiAgentWrites) throw new Refusal('agent_writes_off')
    const measures = a.counts.map((m) => {
      const filter = m.filter !== undefined && givenArg(m.filter) ? objectArg(m.filter, 'filter') : undefined
      noServerJs(filter)
      return {
        label: m.label,
        db: m.database,
        coll: m.collection,
        ...(filter && Object.keys(filter).length ? { filter: wire(filter) } : {}),
      }
    })
    const { cadence, timeZone, preview } = await reportCadence(env, a.cadence, a.timeZone)
    const ch = await channelsOf(env, a)
    const input = ReportInputSchema.safeParse({
      name: a.name,
      connectionId: c.id,
      measures,
      cadence,
      timeZone,
      enabled: true,
      channels: ch.channels,
    })
    if (!input.success)
      throw new Refusal('invalid_arguments', input.error.issues[0]?.message ?? 'not a report')
    if (await reportNameTaken(env, a.name)) throw new Refusal('report_name_taken')
    const problem = await env.ctx.reports.problem(input.data)
    if (problem)
      throw new Refusal(
        `report_${problem.reason}`,
        problem.measure !== undefined ? `count ${problem.measure + 1}` : undefined,
      )
    const shown = {
      name: a.name,
      connection: c.label,
      counts: measures.map((m) => ({
        label: m.label,
        namespace: `${m.db}.${m.coll}`,
        ...(m.filter
          ? { filter: shownTo(env, c, m.db, m.coll, { find: m.coll, filter: m.filter }).filter }
          : {}),
      })),
      cadence,
      timeZone,
      channels: ch.shown,
    }
    return alertCard(
      c,
      shown,
      {
        counts: measures.length,
        nextRuns: preview.runs.slice(0, 3),
        words: preview.words,
        timeZone,
        channels: ch.shown,
      },
      async (auth) => {
        const r = await callRoute(env.app, auth, 'POST', '/alerts/reports', input.data)
        return r.status < 300 ? done({ report: 'created', name: a.name }) : failed(r)
      },
    )
  },

  update_report: async (env, a: ToolArgs<'update_report'>) => {
    const { report, c } = await reportNamed(env, a.report, 'update_report')
    const timing = a.cadence !== undefined || a.timeZone !== undefined
    const named = a.inApp !== undefined || a.email !== undefined || a.webhooks !== undefined
    if (!timing && !named && a.enabled === undefined && a.name === undefined)
      throw new Refusal('invalid_arguments', 'nothing to change')
    const when = timing
      ? await reportCadence(env, a.cadence ?? report.cadence, a.timeZone ?? report.timeZone)
      : null
    const ch = named ? await channelsOf(env, a, report.channels) : null
    if (a.name !== undefined && (await reportNameTaken(env, a.name, report.id)))
      throw new Refusal('report_name_taken')
    const patch = {
      ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
      ...(a.name !== undefined ? { name: a.name } : {}),
      ...(when ? { cadence: when.cadence, timeZone: when.timeZone } : {}),
      ...(ch ? { channels: ch.channels } : {}),
    }
    if (!ReportPatchSchema.safeParse(patch).success)
      throw new Refusal('invalid_arguments', 'not a change of a report')
    return alertCard(
      c,
      { report: report.name, ...patch, ...(ch ? { channels: ch.shown } : {}) },
      {
        ...(when
          ? { nextRuns: when.preview.runs.slice(0, 3), words: when.preview.words, timeZone: when.timeZone }
          : {}),
        ...(ch ? { channels: ch.shown } : {}),
      },
      async (auth) => {
        const r = await callRoute(env.app, auth, 'PATCH', `/alerts/reports/${enc(report.id)}`, patch)
        return r.status < 300 ? done({ report: 'updated', name: a.name ?? report.name }) : failed(r)
      },
    )
  },

  /** C7: a report run now — its counts said through its channels; the model is told them (numbers). */
  run_report: async (env, a: ToolArgs<'run_report'>) => {
    const { report, c } = await reportNamed(env, a.report, 'run_report')
    const hooks = await webhookNames(env)
    const shownChannels = {
      inApp: report.channels.inApp,
      email: report.channels.email,
      webhooks: report.channels.webhooks.map((id) => hooks.get(id) ?? 'a deleted webhook'),
    }
    return alertCard(
      c,
      { runReport: report.name },
      { counts: report.measures.length, channels: shownChannels },
      async (auth) => {
        const r = await callRoute(env.app, auth, 'POST', `/alerts/reports/${enc(report.id)}/run`)
        if (r.status >= 300) return failed(r)
        const body = r.body as { values?: ReportValue[]; sent?: boolean } | null
        const values = (body?.values ?? []).slice(0, 10)
        const sent = body?.sent !== false
        return {
          state: 'done',
          summary: { report: sent ? 'ran' : 'ranKept', name: report.name, counts: values.length },
          result: { ran: report.name, counts: values, sent },
        }
      },
    )
  },

  delete_report: async (env, a: ToolArgs<'delete_report'>) => {
    const { report, c } = await reportNamed(env, a.report, 'delete_report')
    return alertCard(
      c,
      { deleteReport: report.name },
      { counts: report.measures.length },
      async (auth) => {
        const r = await callRoute(env.app, auth, 'DELETE', `/alerts/reports/${enc(report.id)}`)
        return r.status < 300 ? done({ report: 'deleted', name: report.name }) : failed(r)
      },
      true,
    )
  },

  /**
   * Design 2026-10-25 (C4): several changes shown first as a plan. The turn holds the model to it:
   * each change then comes on its own card in this order; one declined or refused stops the rest.
   */
  plan_changes: async (env, a: ToolArgs<'plan_changes'>) => {
    // A plan of changes the agent may not propose is none (as each of its changes would be).
    const policy = agentPolicy(env.ctx)
    if (policy !== 'full') throw new Refusal(`agent_policy_${policy}`)
    return result(
      {
        place: null,
        state: 'done',
        summary: { changes: a.changes.length },
        plan: { title: a.title, changes: a.changes.map((x) => ({ tool: x.tool, about: x.about })) },
      },
      {
        planned: a.changes.length,
        note: 'Shown to the person. Now propose each change in this order, one at a time: a change declined or refused stops the rest.',
      },
    )
  },

  open_in_app: async (env, a: ToolArgs<'open_in_app'>) => {
    const c = need(env, a.connection)
    if (a.collection && !a.database) throw new Refusal('invalid_arguments', 'collection needs its database')
    // The AI database manager (design 2026-10-25, A1): what the collection shows, checked as a read
    // is — no server JavaScript, no namespace a read may not send — and run by the person's route.
    // Review of A1 (minor 5): a blank optional field is none (some models fill every field). A filter
    // of {} is a find of everything here: beside a pipeline, both at once, refused (A1's ruling, kept
    // in the re-review of C3).
    const given = (v: unknown) => v !== undefined && !(typeof v === 'string' && !v.trim())
    // Re-review (M3): a limit alone is a find of that many — on Documents of a collection only; beside
    // another section, or with no collection, it is left alone (second re-review, minor 6).
    const limitFinds =
      a.limit !== undefined && !!a.collection && (a.section === undefined || a.section === 'documents')
    const find = given(a.filter) || given(a.sort) || given(a.projection) || (limitFinds && !given(a.pipeline))
    if (a.limit !== undefined && given(a.pipeline))
      throw new Refusal('invalid_arguments', 'a limit is for a find; add a $limit stage to the pipeline')
    const pipeline = given(a.pipeline)
    if ((find || pipeline) && !a.collection)
      throw new Refusal('invalid_arguments', 'a query needs its collection')
    if (find && pipeline) throw new Refusal('invalid_arguments', 'a find or a pipeline, not both')
    let show: AiAgentShow | undefined
    if (find) {
      const filter = given(a.filter) ? objectArg(a.filter, 'filter') : {}
      const projection = given(a.projection) ? objectArg(a.projection, 'projection') : undefined
      const sort = given(a.sort) ? objectArg(a.sort, 'sort') : undefined
      noServerJs(filter, projection, sort)
      await sourcesAllowed(env, c, a.database!, a.collection!)
      show = {
        kind: 'query',
        filter: wire(filter),
        ...(projection ? { projection: wire(projection) } : {}),
        ...(sort ? { sort: wire(sort) } : {}),
        ...(limitFinds ? { limit: a.limit } : {}),
      }
    } else if (pipeline) {
      const stages = stagesArg(a.pipeline)
      if (!stages.length) throw new Refusal('invalid_arguments', 'pipeline needs at least one stage')
      noServerJs(stages)
      await sourcesAllowed(env, c, a.database!, a.collection!, stages)
      const writes = writesAt(stages)
      // Review of A1 (minor 6): placing a pipeline that writes is a change — allowed as one would be.
      if (writes) writeAllowed(env, c, a.database!, stages)
      show = { kind: 'pipeline', stages: stages.map(wire), writes }
    }
    // Review of A1 (minor 7): a find opens Documents, a pipeline the builder — never another section.
    const opens = show ? (show.kind === 'query' ? 'documents' : 'aggregations') : undefined
    if (opens && a.section && a.section !== opens)
      throw new Refusal('invalid_arguments', `a ${show!.kind} opens ${opens}, not ${a.section}`)
    const section = opens ?? a.section
    const target: AiAgentOpen = {
      connectionId: c.id,
      ...(a.database ? { db: a.database } : {}),
      ...(a.database && a.collection ? { coll: a.collection } : {}),
      ...(a.database && a.collection && section ? { section } : {}),
      ...(show ? { show } : {}),
    }
    return {
      type: 'open',
      step: { place: placeOf(c, a.database, a.collection), state: 'done', sent: 'nothing' },
      target,
      content: { opened: true },
    }
  },
}

/**
 * Review of A1 (minor 6): a pipeline that writes, put in the builder, as a change: the policy, the
 * agent's writes on the connection, the person's right to write documents, and a target that is
 * none of MongoDB's own namespaces nor one a read may not send.
 */
function writeAllowed(
  env: ToolEnv,
  c: AgentConnection,
  db: string,
  stages: readonly Record<string, unknown>[],
): void {
  if (agentPolicy(env.ctx) === 'read') throw new Refusal('agent_policy_read')
  if (!c.record.aiAgentWrites) throw new Refusal('agent_writes_off')
  if (!c.permissions.has('documents:write'))
    throw new Refusal(c.full.has('documents:write') ? 'read_only' : 'forbidden')
  // Re-review (M1): every write stage, not the first one only (a card of the builder may be turned off).
  for (const stage of stages.filter((s) => ['$out', '$merge'].includes(stageOperator(s) ?? '')))
    writeTargetAllowed(c, db, stage)
}

function writeTargetAllowed(c: AgentConnection, db: string, stage: Record<string, unknown>): void {
  const op = stageOperator(stage)!
  const raw = op === '$merge' && isPlain(stage[op]) ? (stage[op] as Record<string, unknown>).into : stage[op]
  const target =
    typeof raw === 'string'
      ? { db, coll: raw }
      : isPlain(raw) && typeof raw.coll === 'string'
        ? { db: typeof raw.db === 'string' ? raw.db : db, coll: raw.coll }
        : null
  if (!target || !target.coll) throw new Refusal('invalid_arguments', `${op} needs a collection`)
  if (SYSTEM_DATABASES.has(target.db) || isDrillScratch(target.db) || target.coll.startsWith('system.'))
    throw new Refusal('system_namespace')
  sendable(target.db, target.coll, c)
}

/**
 * The destinations a person named, each once: the exact name first, else another letter case where
 * only one fits — the database folds ASCII only, so "Ärchiv" and "ärchiv" may both be there. Null
 * when one is unknown or fits two.
 */
export function destinationsNamed<D extends { id: string; name: string }>(
  list: readonly D[],
  wanted: readonly string[],
): D[] | null {
  const out: D[] = []
  for (const name of wanted) {
    const exact = list.find((d) => d.name === name)
    const folded = exact ? [exact] : list.filter((d) => d.name.toLowerCase() === name.toLowerCase())
    if (folded.length !== 1) return null
    if (!out.includes(folded[0]!)) out.push(folded[0]!)
  }
  return out
}

/** Destinations' names for a hint, at most as many as a list tells. */
const namesOf = (list: ReadonlyArray<{ name: string }>) =>
  list
    .slice(0, JOBS_LISTED)
    .map((d) => d.name)
    .join(', ')

/**
 * Design 2026-10-25 (A5): a connection checked through the app's own test, then opened as the person
 * opening it would (its databases read). Review of A5 (I2): a refusal kept is said without a dial,
 * whoever asks, and a refused sign-in is kept — the model never tries one again and again.
 */
async function checkOnce(env: ToolEnv, c: AgentConnection): Promise<string | null> {
  const person = personOf(env.principal)
  const kept = env.ctx.manager.refusalOf(c.id, person)
  if (kept) return kept.kind
  const test = TestAnswer.safeParse((await read(env, 'POST', `${connPath(c)}/test`)).body)
  if (!test.success) throw new Refusal('route_error')
  if (!test.data.ok) {
    const { kind, message = '' } = test.data.error
    const failure = new ConnectionError(kind as ConnectionErrorKind, message)
    if (isRefusal(failure)) env.ctx.manager.noteRefusal(c.id, failure, person)
    return kind
  }
  try {
    await read(env, 'GET', `${connPath(c)}/databases`)
  } catch (e) {
    if (!(e instanceof Refusal)) throw e
    // Review of A5 (M2): a right refused is the server answering — connected.
    if (e.reason === 'forbidden') return null
    if (e.reason === 'oidc_sign_in') return 'oidc'
    if (
      e.reason.startsWith('connection_') &&
      e.reason !== 'connection_unknown' &&
      e.reason !== 'connection_failed'
    )
      return e.reason.slice(11)
    // Re-review of A5 (M-d): any other failure (the server busy, an error of the app's) is no answer.
    return 'unknown'
  }
  return null
}

/** B2: what a restore does to each target: compared on the click with what the card said. */
interface RestoreExpectation {
  key: string
  exists: boolean
  action: string
  documents: number | null
  skipped: boolean
  /** A replace over a target holding documents (or not known to hold none): its name confirmed. */
  confirmName: boolean
}

/** Review of B2 (M2): the plan's warnings a restore's card says (the rest are the app's Restore's). */
const WARNED = new Set(['capped', 'source'])

const expectationOf = (plan: RestorePlan): RestoreExpectation[] =>
  plan.namespaces.map((n) => ({
    key: `${n.to.db}.${n.to.coll}`,
    exists: n.exists,
    action: n.action,
    documents: n.documents,
    skipped: !!n.skipped,
    confirmName: n.confirmName,
  }))

/** The capped targets a plan writes into, by their whole names (fourth review of B2, M1). */
const cappedOf = (plan: RestorePlan): Set<string> =>
  new Set(plan.namespaces.filter((n) => n.capped && !n.skipped).map((n) => `${n.to.db}.${n.to.coll}`))
/** Fourth review of B2 (I2): the capped targets a card names (the rest counted). */
const CAPPED_SAID = 5

/**
 * Two connections reached the same way with a host in common are one server (the plan compares
 * deployments; this, before it, from what is stored).
 */
export const sameHosts = (x: AgentConnection, y: AgentConnection) => {
  // Fourth review of B2 (M4): reached the same way (SRV or seeds, the same tunnel), a host in common.
  const way = (c: AgentConnection) => {
    const s = c.record.settings
    return `${s.scheme}|${s.ssh?.enabled ? `${s.ssh.host.toLowerCase()}:${s.ssh.port}` : ''}`
  }
  const hosts = (c: AgentConnection) =>
    c.record.settings.hosts.map(
      (h) => `${h.host.toLowerCase()}:${h.port ?? (c.record.settings.scheme === 'mongodb' ? 27017 : '')}`,
    )
  const theirs = new Set(hosts(y))
  return way(x) === way(y) && hosts(x).some((h) => theirs.has(h))
}

/** The targets left out where the card left them out (re-review of B2, I1). */
const sameSkips = (now: RestoreExpectation[], was: RestoreExpectation[]) =>
  now.every((x, i) => x.skipped === was[i]?.skipped)

/** The same targets, there or not as they were, each done as said (a count may move; a target may not). */
const sameTargets = (now: RestoreExpectation[], was: RestoreExpectation[]) =>
  now.length === was.length &&
  now.every(
    (x, i) =>
      x.key === was[i]!.key &&
      x.exists === was[i]!.exists &&
      x.action === was[i]!.action &&
      // Review of B2 (I1): a target emptied, or filled, since the card is a change too (one the card
      // left out is sameSkips's).
      x.confirmName === was[i]!.confirmName,
  )

/** B2: what only the app's Restore page confirms (TTL indexes, personal data, masked backups…). */
function refuseBlocked(refusals: string[]): void {
  const blocked = refusals.filter((r) => r !== 'confirm_name')
  if (blocked.length) throw new Refusal(`restore_${blocked[0]}`, `the plan asks: ${blocked.join(', ')}`)
}

/** B2: a backup the person may restore, by its name as listed — of a connection and scope told. */
async function backupNamed(env: ToolEnv, name: string, from?: string): Promise<BackupView> {
  // Re-review of B2 (M4): the connection it was made of tells two of one name apart.
  let of: AgentConnection | null = null
  if (from) {
    try {
      of = need(env, from, false)
    } catch (err) {
      // Third review of B2 (N2): `from` said as such, never taken for the target (fourth, nit: only
      // a connection not known; anything else as it is).
      if (err instanceof Refusal && err.reason === 'connection_unknown')
        throw new Refusal('backup_from_unknown')
      // Fifth review (nit): another refusal of `from` said as `from`'s, never the target's.
      if (err instanceof Refusal)
        throw new Refusal(err.reason, 'it is `from`, the connection the backup was made of, that was refused')
      throw err
    }
  }
  const listed = (((await read(env, 'GET', '/backups')).body ?? []) as BackupView[]).filter(
    (b) => toldConnection(env, b.connectionId) && scopeTold(b.scope) && (!of || b.connectionId === of.id),
  )
  // Third review of B2 (N1): by its id as list_backups gives it, too (two made in one second share a name).
  const byId = listed.find((b) => b.id === name)
  if (byId) return byId
  const exact = listed.filter((b) => b.name === name)
  const folded = listed.filter((b) => b.name.toLowerCase() === name.toLowerCase())
  const found = exact.length === 1 ? exact[0] : folded.length === 1 ? folded[0] : undefined
  // Review of B2 (M5): two of that name are said so, never taken for either.
  if (!found && (exact.length > 1 || folded.length > 1))
    throw new Refusal(
      'backup_ambiguous',
      of
        ? 'two backups of that connection have that name; give its id'
        : 'two backups have that name; give `from` or its id',
    )
  if (!found)
    throw new Refusal(
      'backup_unknown',
      listed.length ? `the backups are: ${namesOf(listed)}` : 'there is no backup',
    )
  return found
}

/**
 * B2: a backup's namespaces, as its own dump job reported them (a backup of one collection: that one).
 * A backup of a whole server, or one made elsewhere, is restored from the app's Restore page.
 */
async function backupNamespaces(env: ToolEnv, b: BackupView): Promise<Array<{ db: string; coll: string }>> {
  if (b.scope.kind === 'collection') return [{ db: b.scope.db, coll: b.scope.coll }]
  if (b.scope.kind !== 'database') throw new Refusal('restore_in_app')
  // Review of B2 (I2): as the backup keeps them (its dump report goes after a day).
  const kept = env.ctx.backup.store.byId(b.id)?.meta?.included
  const own = kept?.filter((n) => n.db === (b.scope as { db: string }).db) ?? []
  if (own.length) return own.map((n) => ({ db: n.db, coll: n.coll }))
  if (!b.jobId) throw new Refusal('restore_namespaces_unknown')
  const report = await callRoute(env.app, env.auth, 'GET', `/transfer/jobs/${b.jobId}/report`)
  const reported = report.status < 300 ? (report.body as Partial<DumpReport> | null) : null
  const names = (reported?.namespaces ?? [])
    .filter((n) => !n.skipped && n.db === (b.scope as { db: string }).db)
    .map((n) => ({ db: n.db, coll: n.coll }))
  if (!names.length) throw new Refusal('restore_namespaces_unknown')
  return names
}

/** B2: the targets as they are now (an encrypted backup's plan waits for its password). */
async function targetsNow(
  env: ToolEnv,
  c: AgentConnection,
  mapping: Array<{ to: { db: string; coll: string } }>,
  mode: string,
  auth: AgentAuth = env.auth,
): Promise<Array<RestoreExpectation & { capped: boolean }>> {
  type Listed = { name: string; type?: string; options?: { capped?: unknown } }
  const there = new Map<string, Map<string, Listed>>()
  for (const db of new Set(mapping.map((m) => m.to.db))) {
    const r = await readBusy(() => callRoute(env.app, auth, 'GET', `${dbPath(c, db)}/collections`))
    // Fourth review of B2 (M3): a listing not read is no card (never "every target new").
    if (r.status >= 300) throw new Refusal('restore_targets_unread')
    const listed = (r.body ?? []) as Listed[]
    there.set(db, new Map(listed.map((x) => [x.name, x])))
  }
  // Review of B2 (M8): the counts a few at once, as the plan reads them — within the person's read
  // slots, a busy one tried again (third review, M1).
  return mapLimited(mapping, 3, async ({ to }) => {
    const info = there.get(to.db)!.get(to.coll)
    const exists = info !== undefined
    // Re-review of B2 (M3): a view is left out, as the plan leaves it (its count none).
    const view = info?.type === 'view'
    let documents: number | null = null
    if (exists && !view) {
      // Re-review of B2 (M2): counted as the plan counts (an estimate, every shard's), not by stats.
      const count = () =>
        callRoute(env.app, auth, 'POST', `${collPath(c, to.db, to.coll)}/count`, { filter: {} })
      const s = await readBusy(count)
      const n = s.status < 300 ? (s.body as { count?: number | null }).count : null
      documents = typeof n === 'number' ? n : null
    }
    return {
      key: `${to.db}.${to.coll}`,
      exists,
      action: exists ? mode : 'create',
      documents,
      skipped: view,
      // As the plan asks it: a replace over documents, or over a count not known.
      confirmName: mode === 'replace' && exists && documents !== 0,
      // Third review of B2 (M2): its own cap, kept where it is written into, not replaced.
      capped: exists && !view && mode !== 'replace' && info?.options?.capped === true,
    }
  })
}

/** Fourth review of B2 (M3): a read the person's slots refused (429) asked once more, its wait waited. */
export async function readBusy(call: () => Promise<RouteAnswer>): Promise<RouteAnswer> {
  const first = await call()
  if (first.status !== 429) return first
  // Fifth review (nit): the wait the route told, never more than BUSY_WAIT_MS.
  const told = Number((first.body as { details?: { retryAfterMs?: unknown } } | null)?.details?.retryAfterMs)
  await new Promise((r) =>
    setTimeout(r, Number.isFinite(told) && told > 0 ? Math.min(told, BUSY_WAIT_MS) : BUSY_WAIT_MS),
  )
  return call()
}
const BUSY_WAIT_MS = 2_000

/**
 * Review of B4: MongoDB's accounts are a database administrator's (databases:admin, read-only mode
 * aside: a listing is a read), never a restricted person's — as Database Access refuses them; refused
 * before any read or card.
 */
function mayManageUsers(env: ToolEnv, c: AgentConnection): void {
  if (!c.full.has('databases:admin')) throw new Refusal('forbidden')
  if (restrictedByOthers(env.ctx, env.principal, c.id)) throw new Refusal('users_restricted')
}

/** Review of B5 (nit): names a URL path would read as "this" or "the one above". */
const DOT_NAMES: ReadonlySet<string> = new Set(['.', '..'])

/** Review of B4 (I1, M5): a user's database — a name MongoDB takes, never its own nor a drill's. */
function userDatabase(db: string): void {
  if (!DatabaseNameSchema.safeParse(db).success) throw new Refusal('invalid_arguments', 'not a database name')
  if (DEPLOYMENT_DBS.has(db) || isDrillScratch(db)) throw new Refusal('system_namespace')
}

/** C3: a server's version at least this one (unknown: no). */
function versionAtLeast(version: string, least: string): boolean {
  const v = parseMongoVersion(version)
  const [major, minor] = least.split('.').map(Number) as [number, number]
  return !!v && (v.major > major || (v.major === major && v.minor >= minor))
}

/**
 * C1: an argument given — blank text and {} (as text, or as the object a model may send) are none
 * (re-review of C3, nit).
 */
function givenArg(v: unknown): boolean {
  if (v === undefined) return false
  if (typeof v === 'string') return !!v.trim() && !/^\{\s*\}$/.test(v.trim())
  return !(v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)
}

/** C7: alert rules and reports are an administrator's, as the alerts routes ask (settings:manage). */
const alertsAdmin = (env: ToolEnv) => permissionsFor(env.principal.role).has('settings:manage')

/** C7: a report run's counts, from its event's detail (its own name and id left out). */
const reportCounts = (detail: Record<string, unknown>) =>
  Object.entries(detail)
    .filter(([k]) => k !== 'report' && k !== 'reportId')
    .map(([label, count]) => ({ label, count }))

/** C7: the webhooks by id, their names only (never an address, never a secret). */
async function webhookNames(env: ToolEnv): Promise<Map<string, string>> {
  const body = (await read(env, 'GET', '/alerts/channels')).body as AlertChannelsView
  return new Map(body.webhooks.map((w) => [w.id, w.name]))
}

/**
 * C7: where a rule or report is said, as the model names it — the bell, e-mail, webhooks by their
 * names as listed (exactly, else in another letter case where that is the only one); unnamed ones
 * keep what was there.
 */
async function channelsOf(
  env: ToolEnv,
  a: { inApp?: boolean | undefined; email?: boolean | undefined; webhooks?: string[] | undefined },
  before?: AlertChannels,
): Promise<{ channels: AlertChannels; shown: { inApp: boolean; email: boolean; webhooks: string[] } }> {
  const body = (await read(env, 'GET', '/alerts/channels')).body as AlertChannelsView
  const hooks = body.webhooks.map((w) => ({ id: w.id, name: w.name }))
  const live = new Set(hooks.map((w) => w.id))
  // Review of C7b (I3): a webhook deleted since is no longer one it is said to.
  let ids = (before?.webhooks ?? []).filter((id) => live.has(id))
  if (a.webhooks !== undefined) {
    // Review of C7b (I2): a name two webhooks share names neither (the person could not tell which).
    for (const name of a.webhooks) {
      const exact = hooks.filter((w) => w.name === name).length
      const folded = hooks.filter((w) => w.name.toLowerCase() === name.toLowerCase()).length
      if (exact > 1 || (exact === 0 && folded > 1)) throw new Refusal('webhook_ambiguous', name)
    }
    const found = destinationsNamed(hooks, a.webhooks)
    if (!found) throw new Refusal('webhook_unknown', `the webhooks are: ${namesOf(hooks)}`)
    // Review of C7b (M7): one turned off would send nothing: said before any card.
    const off = found.find((w) => !body.webhooks.find((x) => x.id === w.id)?.enabled)
    if (off) throw new Refusal('webhook_off', off.name)
    ids = found.map((w) => w.id)
  }
  const channels = {
    inApp: a.inApp ?? before?.inApp ?? true,
    email: a.email ?? before?.email ?? false,
    webhooks: ids,
  }
  // E-mail where no mail server is set up would send nothing: said before any card — when asked for
  // (review of C7b, M6: a rule that has it already may still have its other channels changed).
  if (a.email === true && !body.email?.enabled) throw new Refusal('email_off')
  const byId = new Map(hooks.map((w) => [w.id, w.name]))
  return {
    channels,
    shown: { ...channels, webhooks: ids.map((id) => byId.get(id) ?? 'a deleted webhook') },
  }
}

/** C7: an alert rule by its id, of a connection the agent is told of. */
async function alertRuleNamed(
  env: ToolEnv,
  id: string,
  tool: AiAgentTool,
): Promise<{ rule: AlertRuleView; c: AgentConnection }> {
  if (!alertsAdmin(env)) throw new Refusal('forbidden')
  const rule = ((await read(env, 'GET', '/alerts/rules')).body as AlertRuleView[]).find((r) => r.id === id)
  if (!rule) throw new Refusal('not_found')
  // A rule for every connection is the app's own: changed on the Alerts page, not by the agent.
  if (!rule.connectionId) throw new Refusal('rule_every_connection')
  const c = toldConnection(env, rule.connectionId)
  if (!c) throw new Refusal('not_found')
  if (!c.record.aiAgentWrites) throw new Refusal('agent_writes_off')
  // Review of C7b (I1): the tool off on the connection the rule is of.
  if (c.record.aiAgentToolsOff.includes(tool)) throw new Refusal('tool_off')
  return { rule, c }
}

/** C7: a report by its id or its name (exactly, else in another letter case where that is the only one). */
async function reportNamed(
  env: ToolEnv,
  name: string,
  tool: AiAgentTool,
): Promise<{ report: ReportView; c: AgentConnection }> {
  if (!alertsAdmin(env)) throw new Refusal('forbidden')
  const all = ((await read(env, 'GET', '/alerts/reports')).body as ReportView[]).filter(
    (r) => !!toldConnection(env, r.connectionId),
  )
  const exact = all.filter((r) => r.id === name || r.name === name)
  const folded = all.filter((r) => r.name.toLowerCase() === name.toLowerCase())
  const report = exact.length === 1 ? exact[0] : folded.length === 1 ? folded[0] : undefined
  if (!report) throw new Refusal(exact.length + folded.length > 1 ? 'report_ambiguous' : 'not_found')
  const c = toldConnection(env, report.connectionId)!
  if (!c.record.aiAgentWrites) throw new Refusal('agent_writes_off')
  // Review of C7b (I1): the tool off on the connection the report is of.
  if (c.record.aiAgentToolsOff.includes(tool)) throw new Refusal('tool_off')
  return { report, c }
}

/** Review of C7b (M10): a report's name another report has (in any letter case) is taken. */
async function reportNameTaken(env: ToolEnv, name: string, other?: string): Promise<boolean> {
  const all = (await read(env, 'GET', '/alerts/reports')).body as ReportView[]
  return all.some((r) => r.id !== other && r.name.toLowerCase() === name.toLowerCase())
}

/** C7: a report's cadence as the schedule preview reads it: its runs, its words, a problem refused. */
async function reportCadence(
  env: ToolEnv,
  raw: unknown,
  zone: string | undefined,
): Promise<{ cadence: Record<string, unknown>; timeZone: string; preview: SchedulePreview }> {
  const timeZone = zone ?? env.timeZone
  if (!timeZone) throw new Refusal('invalid_arguments', 'a time zone is needed')
  if (!TimeZoneSchema.safeParse(timeZone).success)
    throw new Refusal('invalid_arguments', 'the time zone is not one this server knows')
  const cadence =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : objectArg(raw, 'cadence')
  const preview = (
    await read(env, 'POST', '/backup-schedules/preview', { cadence, timeZone, locale: env.language })
  ).body as SchedulePreview
  if (preview.problem) throw new Refusal(`cadence_${preview.problem.reason}`, cadenceHint(preview.problem))
  return { cadence, timeZone, preview }
}

/**
 * C7: an alert or report change on its card, on its connection (the agent's own switch and the tools
 * turned off there read again on the click, as every change's).
 */
function alertCard(
  c: AgentConnection,
  shown: Record<string, unknown>,
  preview: NonNullable<AiAgentProposal['preview']>,
  run: ChangeRun,
  destructive = false,
): ToolOutcome {
  return proposal(c, undefined, undefined, shown, preview, run, destructive ? { destructive: true } : {})
}

/** C3: a database's collections as the app lists them for the person: names, kinds, a view's source. */
type Listed = { name: string; type?: string; options?: { viewOn?: unknown } }
async function collectionsListed(env: ToolEnv, c: AgentConnection, db: string): Promise<Listed[]> {
  const body = (await read(env, 'GET', `${connPath(c)}/databases/${enc(db)}/collections`)).body as
    { collections?: Listed[] } | Listed[]
  return Array.isArray(body) ? body : (body.collections ?? [])
}

/** Review of C3b (minor 6): a copy plan's refusal, by its own words where the agent has them. */
export const COPY_REFUSALS = new Set([
  'same_namespace',
  'replace_uncertain',
  'sharded_replace',
  'personal_replace',
  'confirm_ttl',
  'personal_id',
  'confirm_personal',
  'add_rules_forbidden',
  'too_many_rules',
])
const copyRefusal = (code: string) => (COPY_REFUSALS.has(code) ? `copy_${code}` : 'copy_refused')

/** C1: a count's bound — the count route counts up to this many when an exact count is too slow. */
const COUNT_BOUND = 10_000

/** C2: a field's path as MongoDB reads one — dotted names, none empty, none an operator. */
function fieldPath(text: string): string {
  const parts = text.split('.')
  if (text.length > 255 || parts.some((p) => !p || p.startsWith('$') || p.includes('\0')))
    throw new Refusal('invalid_arguments', 'not a field’s path')
  // Re-review of C2 (M2): a position (a.0.b) is no field to unwind through: a pipeline says it.
  if (parts.some((p) => /^\d+$/.test(p)))
    throw new Refusal(
      'invalid_arguments',
      'a part made of digits (an array position, or a field named so): run a pipeline for it instead',
    )
  return text
}

/** C2: a pipeline's documents (canonical Extended JSON) through the person's own aggregation route. */
async function aggregateRead(
  env: ToolEnv,
  c: AgentConnection,
  db: string,
  coll: string,
  stages: Document[],
  limit: number,
): Promise<unknown[]> {
  const answer = await read(env, 'POST', `${collPath(c, db, coll)}/aggregate/run`, {
    stages: wire(stages),
    limit,
    remember: false,
  })
  const docs: unknown[] = []
  for (const line of answer.text.split('\n')) {
    if (!line.trim()) continue
    const l = JSON.parse(line) as { document?: unknown; error?: { code?: string } }
    // As the route wrote it (canonical Extended JSON): the masks read it so.
    if (l.document !== undefined) docs.push(l.document)
    else if (l.error) throw new Refusal(String(l.error.code ?? 'route_error').toLowerCase())
  }
  return docs
}

/** C1: a namespace an export may read — never one of MongoDB's own, a credential's or a drill's. */
function exportable(db: string, coll: string, c: AgentConnection): void {
  if (SYSTEM_DATABASES.has(db) || isDrillScratch(db) || coll.startsWith('system.'))
    throw new Refusal('system_namespace')
  if (isAdminOnlyNamespace(db, coll) || isEncryptionMetadata(c.record.settings.encryption, db, coll))
    throw new Refusal('credential_collection')
}

/** B4: a role as the model names it — "role" in the user's database, or "role@database". */
function roleRefOf(text: string, userDb: string): { role: string; db: string } {
  const at = text.lastIndexOf('@')
  const ref = at > 0 ? { role: text.slice(0, at), db: text.slice(at + 1) } : { role: text, db: userDb }
  // Review of B4 (M5): as the route takes a role (no control characters, a database's name).
  if (!RoleRefSchema.safeParse(ref).success)
    throw new Refusal('invalid_arguments', 'a role is "role" or "role@database"')
  if (isDrillScratch(ref.db)) throw new Refusal('system_namespace')
  // A built-in role of the admin database only, named in another, is no role there.
  const builtin = BUILTIN_ROLES.find((b) => b.role === ref.role)
  if (builtin && builtin.scope === 'admin' && ref.db !== 'admin') throw new Refusal('role_unknown')
  return ref
}

/**
 * Review of B4 (M4): one user, asked for by name (Database Access's own read of it) — null when MongoDB
 * has none by that name; a refusal is said, never read as "none".
 */
async function userNamed(env: ToolEnv, c: AgentConnection, db: string, user: string) {
  const path = `${connPath(c)}/database-access/users/${enc(db)}/${enc(user)}`
  const answer = await callRoute(env.app, env.auth, 'GET', path)
  // Review of B5 (M6): MongoDB has none by that name — not any other 404 (a connection gone).
  if (
    answer.status === 404 &&
    (answer.body as { details?: { reason?: unknown } } | null)?.details?.reason === 'user_unknown'
  )
    return null
  if (answer.status >= 400) throw routeError(answer)
  return answer.body as DbUserDetail
}

/** B4: a database's custom roles, as Database Access lists them — what it could not list said. */
async function customRoles(env: ToolEnv, c: AgentConnection, db: string) {
  const body = (await read(env, 'GET', `${connPath(c)}/database-access/roles?${new URLSearchParams({ db })}`))
    .body as DbRolesAnswer
  return { roles: body.roles.filter((r) => !r.builtin), more: body.more, refused: body.refused.includes(db) }
}

/**
 * B4: no role over the whole deployment through the agent (review of B4, I1: as the shared rule says
 * — a built-in by its name and database, any role of local or config; a custom one as Database Access
 * judges its definition); one not there is unknown, one MongoDB would not list is not judged.
 */
async function refuseBroad(env: ToolEnv, c: AgentConnection, roles: Array<{ role: string; db: string }>) {
  const custom = new Map<string, Awaited<ReturnType<typeof customRoles>>>()
  for (const r of roles) if (isBroadRoleRef(r)) throw new Refusal('broad_role')
  for (const r of roles) {
    if (BUILTIN_ROLE_NAMES.has(r.role)) continue
    if (!custom.has(r.db)) custom.set(r.db, await customRoles(env, c, r.db))
    const listed = custom.get(r.db)!
    const found = listed.roles.find((x) => x.role === r.role)
    if (found?.broad) throw new Refusal('broad_role')
    if (found) continue
    if (listed.refused) throw new Refusal('roles_not_permitted')
    throw new Refusal(listed.more ? 'roles_unlisted' : 'role_unknown')
  }
}

/** B3: slow queries told at most (the newest). */
const SLOW_TOLD = 30

/** A namespace's database and collection (a database alone has no collection). */
function splitNs(ns: string): { db: string; coll: string } {
  const dot = ns.indexOf('.')
  return dot < 0 ? { db: ns, coll: '' } : { db: ns.slice(0, dot), coll: ns.slice(dot + 1) }
}

/**
 * B3: a namespace as the agent tells it, by database and collection — none of client-side
 * encryption's key vault or metadata, nor a restore drill's scratch copy.
 */
function toldNamespace(ns: string, c: AgentConnection): { database: string; collection?: string } | null {
  const { db, coll } = splitNs(ns)
  if (!db || isDrillScratch(db) || (coll && isEncryptionNamespace(db, coll))) return null
  // Review of B3 (M6): an administrators-only namespace (credentials, the local database) only to a
  // connection administrator — stricter than the Performance tab, which shows a monitor its name.
  if (c.role !== 'admin' && isAdminOnlyNamespace(db, coll || undefined)) return null
  return coll && coll !== '$cmd' ? { database: db, collection: coll } : { database: db }
}

/** B3: the operations running now, as the Performance tab lists them (longest first, 50 at most). */
async function runningOps(
  env: ToolEnv,
  c: AgentConnection,
  db?: string,
  opid?: string,
): Promise<{ operations: OperationView[]; more?: boolean; scope?: 'all' | 'own' }> {
  const params = new URLSearchParams()
  if (db) params.set('ns', db)
  if (opid) params.set('opid', opid)
  const q = params.toString() ? `?${params}` : ''
  return (await read(env, 'GET', `${connPath(c)}/server/operations${q}`)).body as {
    operations: OperationView[]
    more?: boolean
    scope?: 'all' | 'own'
  }
}

type ReplicaAnswer = { mode: 'standalone' | 'sharded' } | ReturnType<typeof replicaView>

/**
 * B3: a replica set as the agent tells it — each member by its number in the set, never its host (a
 * heartbeat's message, which names hosts, as a flag); the primary and each sync source by number.
 */
export function replicaTold(view: ReplicaAnswer): Record<string, unknown> & { members?: unknown[] } {
  if (view.mode !== 'replicaSet') return { mode: view.mode }
  const numberOf = new Map(view.members.map((m, i) => [m.name, i + 1]))
  return {
    mode: 'replicaSet',
    set: view.set,
    primary: view.primary ? (numberOf.get(view.primary) ?? null) : null,
    majorityLagSeconds: view.majorityLagSeconds,
    oplogWindowHours: view.oplogWindowHours,
    members: view.members.map((m, i) => ({
      member: i + 1,
      state: m.state,
      healthy: m.healthy,
      ...(m.self ? { self: true } : {}),
      ...(m.arbiter ? { arbiter: true } : {}),
      ...(m.hidden ? { hidden: true } : {}),
      ...(m.priority !== null ? { priority: m.priority } : {}),
      ...(m.votes !== null ? { votes: m.votes } : {}),
      ...(m.lagSeconds !== null ? { lagSeconds: m.lagSeconds } : {}),
      ...(m.pingMs !== null ? { pingMs: m.pingMs } : {}),
      ...(m.uptimeSeconds !== null ? { uptimeHours: Math.round((m.uptimeSeconds / 3600) * 10) / 10 } : {}),
      ...(m.lastHeartbeatMessage ? { heartbeatFailing: true } : {}),
      ...(m.syncSource ? { syncsFrom: numberOf.get(m.syncSource) ?? 'outside the set' } : {}),
    })),
  }
}

/** B1: one of the person's schedules, with the connection it backs up as the agent may use it. */
interface OwnSchedule {
  view: ScheduleView
  c: AgentConnection
}

/**
 * B1: the person's own schedules (an administrator's list holds everyone's), each of a connection
 * the agent is told of, of a scope it may be told (never MongoDB's own, never a backup's "*").
 */
async function ownSchedules(env: ToolEnv, tool?: AiAgentTool): Promise<OwnSchedule[]> {
  const list = ((await read(env, 'GET', '/backup-schedules')).body as SchedulesList).schedules
  return list.flatMap((view) => {
    if (!view.mine || !scopeTold(view.dump.scope)) return []
    const c = toldConnection(env, view.connectionId, tool)
    return c ? [{ view, c }] : []
  })
}

/** A preset's name for a retention that is one; its numbers otherwise. */
const retentionName = (r: RetentionPolicy) =>
  (Object.keys(RETENTION_PRESETS) as Array<keyof typeof RETENTION_PRESETS>).find(
    (k) => JSON.stringify(RETENTION_PRESETS[k]) === JSON.stringify(r),
  ) ?? r

/** A schedule as the model is told of it: names and words, never an id nor an error's words. */
function scheduleTold(env: ToolEnv, { view, c }: OwnSchedule): Record<string, unknown> {
  const scope = view.dump.scope
  return {
    name: view.name,
    connection: c.label,
    ...(scope.kind !== 'server' ? { database: scope.db } : {}),
    ...(scope.kind === 'collection' ? { collection: scope.coll } : {}),
    cadence: describeCadence(view.cadence, env.language),
    timeZone: view.timeZone,
    state: view.state,
    ...(view.pause ? { paused: { reason: view.pause.reason, by: view.pause.by } } : {}),
    // Review of B1 (nit): times in UTC, said so in their names (the zone is the schedule's own).
    nextRunUtc: view.nextRunAt === null ? null : new Date(view.nextRunAt).toISOString(),
    format: view.format,
    destinations: view.destinations.flatMap((d) => (d.name ? [d.name] : [])),
    keepOnServer: view.keepOnServer,
    retention: retentionName(view.retention),
    // Review of B1 (I1): the view keeps the last runs oldest first — the latest five, newest first.
    lastRuns: view.lastRuns
      .slice(-5)
      .reverse()
      .map((r) => ({
        atUtc: new Date(r.dueAt).toISOString(),
        outcome: r.outcome,
        ...(r.reason ? { reason: r.reason } : {}),
      })),
  }
}

/**
 * B1: a schedule by its name — exactly, else the only one in another letter case — of the person's
 * own; one not found is said with the names it may use. The change is one the agent may make there.
 */
async function scheduleNamed(
  env: ToolEnv,
  name: string,
  tool: AiAgentTool,
  connection?: string,
): Promise<OwnSchedule> {
  // Review of B1 (M6): a connection named narrows two schedules of one name.
  const on = connection ? need(env, connection, false) : null
  const own = (await ownSchedules(env)).filter((s) => !on || s.c.id === on.id)
  const exact = own.filter((s) => s.view.name === name)
  // Review of B1 (M7): as connections and destinations are named, whatever the server's locale.
  const folded = own.filter((s) => s.view.name.toLowerCase() === name.toLowerCase())
  const found = exact.length === 1 ? exact[0] : folded.length === 1 ? folded[0] : undefined
  if (!found && (exact.length > 1 || folded.length > 1))
    throw new Refusal(
      'schedule_ambiguous',
      `${Math.max(exact.length, folded.length)} schedules have that name; name the connection, or ask the person which`,
    )
  if (!found)
    throw new Refusal(
      'schedule_unknown',
      own.length ? `the schedules are: ${namesOf(own.map((s) => s.view))}` : 'there is no schedule',
    )
  mayChange(tool, found.c)
  return found
}

/** A schedule's change as a card: where its backups come from, and what the person confirms. */
function scheduleProposal(
  s: OwnSchedule,
  payload: Record<string, unknown>,
  preview: AiAgentProposal['preview'],
  run: ChangeRun,
  extra: { typed?: string; destructive?: boolean } = {},
): ToolOutcome {
  const scope = s.view.dump.scope
  return proposal(
    s.c,
    scope.kind !== 'server' ? scope.db : undefined,
    scope.kind === 'collection' ? scope.coll : undefined,
    payload,
    preview,
    run,
    extra,
  )
}

/** A cadence problem as the model can put it right: never the route's own words. */
function cadenceHint(p: NonNullable<SchedulePreview['problem']>): string {
  if (p.reason === 'min_gap') return `runs only ${p.minutes} minutes apart; at least an hour is needed`
  if (p.reason === 'cron')
    return `the cron expression's ${p.field ?? 'field'} is not valid (${p.code ?? 'cron'})`
  return 'it never runs in the next five years'
}

/** Design 2026-10-25 (A3): how many jobs or backups the agent is told of at once. */
const JOBS_LISTED = 20

/** A connection the agent is told of, as it is now (review of A3, minor 8: read again per call). */
function toldConnection(env: ToolEnv, id: string, tool?: AiAgentTool): AgentConnection | null {
  const c = env.connections.find((x) => x.id === id)
  const now = c ? env.recheck(c) : null
  // Review of C5 (I2): a read that names no connection leaves out those where it is off.
  return now && tool && now.record.aiAgentToolsOff.includes(tool) ? null : now
}

/** A name the agent may be told: a backup job's "*" is none, nor are MongoDB's own (minor 18). */
const namePart = (v: string | undefined) => (v && v !== '*' ? v : undefined)
const dbTold = (db: string | undefined) =>
  !db || db === '*' || (!SYSTEM_DATABASES.has(db) && !isDrillScratch(db))
const scopeTold = (scope: BackupView['scope']) =>
  scope.kind === 'server' ||
  (dbTold(scope.db) && !(scope.kind === 'collection' && scope.coll.startsWith('system.')))
/** A key vault on the connection hides sizes as a rule does (anyInDb counts it). */
const ruledAnywhere = (env: ToolEnv, c: AgentConnection) =>
  !!c.record.settings.encryption?.enabled && !!c.record.settings.encryption.keyVaultNamespace

/**
 * A job as the agent is told of it: the person's own (review of A3, I3: an administrator sees every
 * job, the agent tells only theirs), both its sides told of (minor 9); where, what and how far —
 * never the words of its error.
 */
function jobForModel(env: ToolEnv, j: JobView, tool: AiAgentTool) {
  if (!j.mine) return []
  const c = toldConnection(env, j.connectionId, tool)
  if (!c || (j.targetConnectionId && !toldConnection(env, j.targetConnectionId, tool)) || !dbTold(j.db))
    return []
  const db = namePart(j.db)
  const coll = db ? namePart(j.coll) : undefined
  return [
    {
      connectionId: c.id,
      place: placeOf(c, db, coll),
      told: {
        id: j.id,
        kind: j.kind,
        connection: c.label,
        ...(db ? { db } : {}),
        ...(coll ? { coll } : {}),
        state: j.state,
        ...(j.progress && j.progress.total > 0
          ? { percent: Math.min(100, Math.round((j.progress.done / j.progress.total) * 100)) }
          : {}),
        failed: j.error !== null,
        startedAt: new Date(j.startedAt).toISOString(),
        ...(j.finishedAt ? { finishedAt: new Date(j.finishedAt).toISOString() } : {}),
      },
    },
  ]
}

async function collectionExists(
  env: ToolEnv,
  c: AgentConnection,
  db: string,
  coll: string,
): Promise<boolean | undefined> {
  const answer = await callRoute(env.app, env.auth, 'GET', `${dbPath(c, db)}/collections`)
  if (answer.status >= 400) return undefined
  return ((answer.body ?? []) as Array<{ name: string }>).some((x) => x.name === coll)
}

/** Update and delete: the bulk preview's count first (the app's own preview), confirmed after. */
async function bulk(
  env: ToolEnv,
  a: ToolArgs<'update_documents'> | ToolArgs<'delete_documents'>,
  operation: 'update' | 'delete',
): Promise<ToolOutcome> {
  const tool = operation === 'update' ? 'update_documents' : 'delete_documents'
  const c = need(env, a.connection)
  mayChange(tool, c, a.database, a.collection)
  const filter = objectArg(a.filter, 'filter')
  const updateValue = 'update' in a ? value(a.update, 'update') : undefined
  if (
    operation === 'update' &&
    !isPlain(updateValue) &&
    !(Array.isArray(updateValue) && updateValue.every(isPlain))
  )
    throw new Refusal('invalid_arguments', 'update must be update operators or an update pipeline')
  noServerJs(filter, updateValue)
  // W6.3 security review (I2): the preview's count answers the filter; an update what it changes
  // (final review of the agent's gate, I-2).
  await gated(
    env,
    c,
    a.database,
    a.collection,
    operation === 'update'
      ? {
          update: {
            filter: decoded(filter),
            update: decoded(updateValue),
          },
        }
      : { filter: decoded(filter) },
  )
  const request = {
    filter: wire(filter),
    operation,
    ...(updateValue !== undefined ? { update: serializeValue(updateValue) } : {}),
  }
  const previewPath = `${collPath(c, a.database, a.collection)}/bulk/preview`
  // Only the counts and the signature are kept: the preview's sample documents (W2) are never handed
  // to the model, nor shown on the card.
  type Preview = { matched: number; total: number; requiresConfirmation: boolean; filterHash: string }
  const preview = (await read(env, 'POST', previewPath, request)).body as Preview
  const place = placeOf(c, a.database, a.collection)
  if (preview.matched === 0)
    return result(
      { place, state: 'done', sent: 'counts', summary: { matched: 0 } },
      {
        matched: 0,
        note: 'Nothing matches the filter: no change was proposed.',
      },
      c.id,
    )
  const command =
    operation === 'update'
      ? { update: a.collection, updates: [{ q: request.filter, u: request.update }] }
      : { delete: a.collection, deletes: [{ q: request.filter }] }
  const masked = shownTo(env, c, a.database, a.collection, command)
  const statement = ((masked.updates ?? masked.deletes) as Array<Record<string, unknown>>)[0]!
  const shown = { filter: statement.q, ...(operation === 'update' ? { update: statement.u } : {}) }
  return proposal(
    c,
    a.database,
    a.collection,
    { filter: request.filter, ...(request.update !== undefined ? { update: request.update } : {}) },
    { matched: preview.matched, total: preview.total },
    async (auth, input) => {
      // W6.3 security review (minor 2): the card may outlive the preview's signature (10 minutes).
      // The preview is made again now, as the person: the same count is carried out; a different
      // one (or one that now reaches every document) is said, and nothing is changed.
      // Final review of the agent's gate (M-1): the rules as they are now.
      const refusedNow = await gatedAgain(
        env,
        c,
        a.database,
        a.collection,
        operation === 'update'
          ? { update: { filter: decoded(filter), update: decoded(updateValue) } }
          : { filter: decoded(filter) },
      )
      if (refusedNow) return refusedNow
      const again = await callRoute(env.app, auth, 'POST', previewPath, request)
      if (again.status >= 300) return failed(again)
      const fresh = again.body as Preview
      if (fresh.matched !== preview.matched || fresh.requiresConfirmation !== preview.requiresConfirmation)
        return { state: 'error', reason: 'count_changed' }
      const r = await callRoute(
        env.app,
        auth,
        'POST',
        `${collPath(c, a.database, a.collection)}/bulk/execute`,
        {
          ...request,
          filterHash: fresh.filterHash,
          ...(fresh.requiresConfirmation ? { confirm: input.confirm ?? '' } : {}),
        },
      )
      if (r.status >= 300) return failed(r)
      const out = r.body as { matched?: number; modified?: number; deleted?: number }
      return done(
        operation === 'update'
          ? { matched: out.matched ?? 0, modified: out.modified ?? 0 }
          : { deleted: out.deleted ?? 0 },
      )
    },
    {
      shown,
      ...(preview.requiresConfirmation ? { typed: a.collection } : {}),
      destructive: operation === 'delete',
      // C4: the documents it changes or deletes, backed up first on asking.
      backup: backupOffer(env, c, a.database, a.collection),
    },
  )
}

const done = (summary: Record<string, number | string | boolean>): ChangeEnd => ({
  state: 'done',
  summary,
  result: { ...summary },
})
const failed = (r: RouteAnswer): ChangeEnd => ({ state: 'error', reason: routeError(r).reason })

/**
 * Design 2026-10-25 (C4): before a change that loses data, the card offers a backup of what it would
 * lose — where the person may run one, never of MongoDB's own namespaces. Made on their asking,
 * through the app's backup route as them (its plan and its rules), encrypted with the password they
 * type on the card; the change may be confirmed once it is made.
 */
function backupOffer(
  env: ToolEnv,
  c: AgentConnection,
  db: string,
  coll?: string,
): { offer: NonNullable<AiAgentProposal['backup']>; start: BackupStart } | undefined {
  if (!c.permissions.has('jobs:run')) return undefined
  // Review of C5 (minor 2): nor where an administrator turned backing up off for the agent.
  if (c.record.aiAgentToolsOff.includes('run_backup')) return undefined
  // Review of C4 (M2): a backup is an export of what it holds (the backup route asks for both).
  if (!mayExport(env.ctx, env.principal, c.id)) return undefined
  if (SYSTEM_DATABASES.has(db) || isDrillScratch(db) || coll?.startsWith('system.')) return undefined
  const scope = coll ? { kind: 'collection' as const, db, coll } : { kind: 'database' as const, db }
  return {
    offer: { scope: scope.kind, db, ...(coll ? { coll } : {}) },
    async start(auth, password) {
      // Review of C4 (M1): the connection it backs up as it is now (a copy's target is not the one the
      // decide route reads) — the agent still allowed there.
      const now = env.recheck(c)
      if (!now) return { reason: 'not_found' }
      if (now.record.aiPolicy === 'off') return { reason: 'ai_off' }
      if (!now.record.aiAgentWrites) return { reason: 'agent_writes_off' }
      // Second review of C5 (M1): backing up turned off for the agent since the card.
      if (now.record.aiAgentToolsOff.includes('run_backup')) return { reason: 'tool_off' }
      const request = { scope, format: 'mmbak' as const }
      const planned = await callRoute(env.app, auth, 'POST', `${connPath(c)}/backup/plan`, request)
      if (planned.status >= 300) return { reason: routeError(planned).reason }
      const plan = planned.body as DumpPlan
      if (plan.refusals.length) return { reason: 'backup_refused' }
      const r = await callRoute(env.app, auth, 'POST', `${connPath(c)}/backup`, {
        ...request,
        planHash: plan.planHash,
        password,
      })
      const job = (r.body as { job?: { id?: unknown } } | null)?.job?.id
      if (r.status >= 300) return { reason: routeError(r).reason }
      return typeof job === 'string' ? { job } : { reason: 'backup_failed' }
    },
  }
}

function proposal(
  c: AgentConnection,
  db: string | undefined,
  coll: string | undefined,
  payload: Record<string, unknown>,
  preview: AiAgentProposal['preview'],
  run: ChangeRun,
  extra: {
    shown?: unknown
    typed?: string
    password?: boolean
    passwordFor?: 'user'
    opening?: boolean
    destructive?: boolean
    /** User request 2026-10-26: the backup may be made without a password instead. */
    plain?: { personal: boolean }
    /** C4: the backup the card offers first. */
    backup?: ReturnType<typeof backupOffer>
  } = {},
): ToolOutcome {
  return {
    type: 'proposal',
    step: { place: placeOf(c, db, coll), state: 'awaiting', sent: 'outcome' },
    proposal: {
      payload: extra.shown === undefined ? payload : extra.shown,
      ...(preview && Object.keys(preview).length ? { preview } : {}),
      ...(extra.typed ? { typed: extra.typed } : {}),
      ...(extra.password ? { password: true } : {}),
      ...(extra.passwordFor ? { passwordFor: extra.passwordFor } : {}),
      ...(extra.opening ? { opening: true } : {}),
      ...(extra.destructive ? { destructive: true } : {}),
      ...(extra.plain ? { plain: extra.plain } : {}),
      ...(extra.backup ? { backup: extra.backup.offer } : {}),
    },
    run,
    touched: c.id,
    ...(extra.backup ? { backup: extra.backup.start } : {}),
  }
}

/**
 * Where a call asked to work, from arguments that may not have parsed: a connection the person has
 * and names within a name's bounds only (review of the history's steps, M1).
 */
export function argsPlace(env: ToolEnv, raw: unknown): AiAgentPlace | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { connection?: unknown; database?: unknown; collection?: unknown }
  const named = typeof r.connection === 'string' ? connectionNamed(env.connections, r.connection) : null
  // Re-review (M-b): as now — a connection the agent may no longer use is no place.
  const c = named ? env.recheck(named) : null
  if (!c) return null
  // Re-review (M-a): as the tools read names — trimmed, then bounded; a database has no dot.
  const name = (v: unknown) => {
    const t = typeof v === 'string' ? v.trim() : ''
    return t && t.length <= 255 ? t : undefined
  }
  const given = name(r.database)
  const db = given && !given.includes('.') ? given : undefined
  return placeOf(c, db, db ? name(r.collection) : undefined)
}

/**
 * Design 2026-10-25 (C6): a read over a large collection is explained first — the plan only, through
 * the person's own explain route, nothing of it sent anywhere — and one that would scan the collection
 * whole is said on its step before it runs. `unbounded`: the read may go through every document (a
 * filter, an order, a pipeline not cut short at once); a plain look at the first documents never does.
 */
async function scanAhead(
  env: ToolEnv,
  c: AgentConnection,
  db: string,
  coll: string,
  explain: Record<string, unknown>,
  reads: ScanReads,
): Promise<void> {
  if (reads === 'none' || !env.scanning) return
  // Review of C6 (minor 6): never a reason for the read to fail.
  try {
    // Re-review of C6 (I-1): the collection's own stats (their shards summed by the route) — cheap,
    // and failing at once on a view or a time series (a count of one runs its whole pipeline).
    const stats = await callRoute(env.app, env.auth, 'GET', `${collPath(c, db, coll)}/stats`)
    if (stats.status >= 300) return
    const n = Number((stats.body as { count?: unknown } | null)?.count ?? 0)
    if (!Number.isFinite(n) || n < AI_AGENT_LIMITS.largeCollection) return
    const answer = await callRoute(env.app, env.auth, 'POST', `${collPath(c, db, coll)}/explain`, {
      ...explain,
      verbosity: 'queryPlanner',
      maxTimeMS: 5_000,
    })
    // A plan not had (a view, a refusal, time out) says nothing: the read goes on as it would.
    if (answer.status >= 300) return
    const view = answer.body as ExplainResult
    const trees = [view.winning, ...(view.shards ?? []).map((s) => s.winning)]
    const has = (stage: string) => {
      const found = (node: ExplainResult['winning']): boolean =>
        !!node && (node.stage === stage || node.children.some(found))
      return trees.some(found)
    }
    if (!has('COLLSCAN')) return
    // Review of C6 (I2): under a limit it may stop at its first matches — said as "may", unless an
    // order in memory, a count, a group or the values make it read every document.
    env.scanning(n, reads === 'all' || has('SORT') ? 'all' : 'may')
  } catch {
    // The read goes on as it would.
  }
}

/** C6: how much of a collection a read may go through, before its plan says how. */
type ScanReads = 'none' | 'may' | 'all'
/** Review of C6 (I2): stages that read every document they are given before anything goes on. */
const BLOCKING = new Set([
  // Re-review of C6 (M-4): a sample large enough is a scan and a random order.
  '$sample',
  '$group',
  '$sort',
  '$bucket',
  '$bucketAuto',
  '$count',
  '$facet',
  '$sortByCount',
  '$setWindowFields',
])
/**
 * C6: a pipeline cut short at once ($limit first) never reads the collection whole; one that groups,
 * orders or counts reads every document; others may (review of C6, minor 3: a $sample of a share
 * large enough is a scan and a sort, so it is explained as any other).
 */
const pipelineScan = (stages: Document[]): ScanReads => {
  // Re-review of C6 (M-2, M-3): in their order — a $limit met first stops the read (after a filter it
  // may go far, before one never); a blocking stage met first reads everything; a pipeline that never
  // filters reads only the rows it returns.
  let filters = false
  for (const s of stages) {
    const name = Object.keys(s)[0] ?? ''
    if (name === '$limit') return filters ? 'may' : 'none'
    if (BLOCKING.has(name)) return 'all'
    const unwind = (s as { $unwind?: unknown }).$unwind
    if (
      name === '$match' ||
      name === '$redact' ||
      (name === '$unwind' &&
        !(typeof unwind === 'object' && unwind !== null && (unwind as Document).preserveNullAndEmptyArrays))
    )
      filters = true
  }
  return filters ? 'may' : 'none'
}

/** C6: a read that scanned a large collection whole, said with its end — so an index can be offered. */
function withScan(out: ToolOutcome, documents: number, reads: 'may' | 'all'): ToolOutcome {
  // Review of C6 (minor 4): a read that ran out of its time is when the advice matters most.
  if (out.type !== 'result' || (out.step.state !== 'done' && out.step.state !== 'error')) return out
  return {
    ...out,
    step: {
      ...out.step,
      summary: { ...out.step.summary, scanned: documents, ...(reads === 'may' ? { scanMay: true } : {}) },
    },
    content: {
      ...out.content,
      collectionScan: {
        documents,
        whole: reads === 'all',
        note:
          reads === 'all'
            ? 'No index serves this read: it read the whole collection. If the person reads it so again, suggest an index (index_advice, or explain_query for its plan).'
            : 'No index serves this read: it may read up to the whole collection to find what it returns. If the person reads it so again, suggest an index (index_advice, or explain_query for its plan).',
      },
    },
  }
}

/** C5: whether a call names a connection where its tool is turned off now. */
function toolOffOn(env: ToolEnv, name: AiAgentTool, args: unknown): boolean {
  const a = (args ?? {}) as { connection?: unknown; toConnection?: unknown; from?: unknown }
  // Review of C5 (minor 1): a restore's backup source, named by `from`, too.
  return [a.connection, a.toConnection, a.from].some((n) => {
    if (typeof n !== 'string' || !n) return false
    const c = connectionNamed(env.connections, n)
    const now = c ? env.recheck(c) : null
    return !!now && now.record.aiAgentToolsOff.includes(name)
  })
}

/** One tool call: its arguments read, the tool run as the person, a refusal said as a code. */
export async function runTool(env: ToolEnv, name: AiAgentTool, raw: unknown): Promise<ToolOutcome> {
  const parsed = TOOL_ARGS[name].safeParse(raw ?? {})
  const fallbackPlace = () => argsPlace(env, raw)
  if (!parsed.success)
    return result(
      { place: fallbackPlace(), state: 'refused', reason: 'invalid_arguments' },
      {
        refused: 'invalid_arguments',
        message: parsed.error.issues
          .map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`)
          .join('; ')
          .slice(0, 500),
      },
    )
  // Re-review of C6 (M-1): kept outside, so a read that failed after its scan was found says it too.
  let scanned: { n: number; reads: 'may' | 'all' } | null = null
  try {
    // A2: an administrator's policy as it is now, on every call — read-only refuses a change before
    // its card; off refuses everything (turned off while the turn runs).
    const policy = agentPolicy(env.ctx)
    if (policy === 'off') throw new Refusal('agent_policy_off')
    if (policy === 'read' && agentToolKind(name) === 'write') throw new Refusal('agent_policy_read')
    // Design 2026-10-25 (C5): a tool an administrator turned off on a connection it names (a copy's
    // target too), as it is now — refused before anything is read there.
    if (toolOffOn(env, name, parsed.data)) throw new Refusal('tool_off')
    // C6: a whole-collection scan said on the step before the read runs, and with its end.
    const own: ToolEnv = {
      ...env,
      scanning: (n, reads) => {
        scanned = { n, reads }
        env.progress?.({ scanning: n, ...(reads === 'may' ? { scanMay: true } : {}) })
      },
    }
    const out = await (HANDLERS[name] as (env: ToolEnv, args: unknown) => Promise<ToolOutcome>)(
      own,
      parsed.data,
    )
    const s = scanned as { n: number; reads: 'may' | 'all' } | null
    return s ? withScan(out, s.n, s.reads) : out
  } catch (e) {
    if (!(e instanceof Refusal)) throw e
    const place = fallbackPlace()
    const unknown = e.reason === 'connection_unknown'
    const s = scanned as { n: number; reads: 'may' | 'all' } | null
    const said = (out: ToolOutcome) => (s ? withScan(out, s.n, s.reads) : out)
    return said(
      result(
        {
          place: unknown ? null : place,
          state: agentToolKind(name) === 'read' && !isRefusalReason(e.reason) ? 'error' : 'refused',
          reason: e.reason,
          ...(e.message !== e.reason && !unknown ? { summary: { message: e.message } } : {}),
        },
        {
          refused: e.reason,
          ...(e.hint ? { message: e.hint } : {}),
          // Names only: the model may say which connections it can use.
          ...(unknown ? { available: env.connections.map((c) => c.label) } : {}),
        },
      ),
    )
  }
}

/** Refusals the agent itself makes (the others are errors a route answered). */
const OWN_REFUSALS = new Set([
  'connection_unknown',
  'agent_policy_off',
  'agent_policy_read',
  // C5: a tool an administrator turned off on the connection.
  'tool_off',
  'invalid_arguments',
  'server_js',
  'write_pipeline',
  'credential_collection',
  'agent_writes_off',
  'read_only',
  'system_namespace',
  'exists',
  'destination_unknown',
  // Design 2026-10-25 (A4): a schedule that would not run, refused before its card (a change's step is
  // refused whatever its reason; listed so that a read meeting one says it the same way).
  'schedules_off',
  'schedule_limit',
  'no_destination',
  'destination_needed',
  'key_required',
  'encrypted_only',
  'personal_plain',
  'cadence_min_gap',
  'cadence_cron',
  'cadence_never',
  'backup_refused',
  // W6.3 re-review (minor 1): refusals of the review are refusals (denied), not failures.
  'personal_field',
  'diagnostic_stage',
  'source_unknown',
  // W8.
  'encrypted_connection',
  // Ninth review of explain masking: a plan over an index holding personal data.
  'personal_index',
  // Final review of the agent's gate (nit): a plan whose check could not finish.
  'plan_unchecked',
  // Nor a change where the collection's indexes could not be read.
  'indexes_unread',
  // Review of B4: MongoDB's accounts, a database administrator's only (a read refused is denied too).
  'forbidden',
  'users_restricted',
  'roles_not_permitted',
  'roles_unlisted',
])
const isRefusalReason = (reason: string) => OWN_REFUSALS.has(reason)
