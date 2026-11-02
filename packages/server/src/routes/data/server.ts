import { createHmac, randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Document, MongoClient } from 'mongodb'
import { OperationsQuerySchema, type OperationsQuery } from '@mongo-manager/shared'
import { AppError, Errors } from '../../errors'
import { parseInput } from '../../validate'
import { isAdminOnlyNamespace, isDrillScratchNs, requireConnection } from '../../connections/access'
import { redactUris } from '../../connections/errors'
import { ANY_MEMBER, LENIENT, clientFor, toAppError, withMongo } from '../../data/mongo-errors'
import { toClient } from '../../data/ejson-io'
import { listOperations } from '../../jobs/current-op'
import { maskCommand, redactSecrets, type Masker } from '../../masking'
import { viewAwareMaskerFor, namespacePairs } from '../../masking/restricted'
import { OWN_READ } from '../../monitor/slow-queries'
import { collectionLatency } from '../../monitor/collection-latency'
import { gatherFacts } from '../../monitor/facts'

const MAX_OPERATIONS = 50
const MAX_TOP = 15
/** Widgets wave 2: the collections whose latency is read (one $collStats each). */
const MAX_LATENCY = 5
const MAX_COMMAND_BYTES = 4 * 1024
const SYSTEM_DB = /^(admin|local|config)(\.|$)/
/** Operations tagged by mongo-manager itself: jobs, the monitor, requests being cancelled. */
const OWN_COMMENT = /^mm[-:]/

const OpParams = z.object({ id: z.string().min(1).max(64), opid: z.string().min(1).max(64) })
/** Review of B3 (I1): what the caller saw under that opid; anything else running there is not stopped. */
const KillBody = z.strictObject({
  // Third review of B3 (M2): what was seen is required — a kill saying nothing stops nothing.
  ns: z.string().max(256),
  op: z.string().max(32),
  // Re-review of B3 (M-2): when it started, and the member it runs on, as the list said them.
  startedAt: z.number().finite().optional(),
  member: z.string().max(64).optional(),
})
/** How far two readings of when an operation started may differ (each read a moment apart). */
const STARTED_SLACK_MS = 2_000

export interface OperationView {
  opid: string
  op: string
  ns: string
  secsRunning: number
  planSummary?: string
  waitingForLock: boolean
  desc: string
  /**
   * Phase 3b §2.4: for everyone with server:monitor, secrets always hidden and personal values
   * masked for a restricted user; credential namespaces only for connection admins.
   */
  command?: string
  /** Review of B3 (M1): Mongo Manager's own work (a job, a request through the app): stopped where it runs. */
  own?: true
  /**
   * Re-review of B3 (M-2): when it started (the server's clock) and the member it runs on (an opaque
   * digest, never its host) — what a kill checks it still is.
   */
  startedAt?: number
  member?: string
  /** Third review of B3 (M1): run where a kill cannot reach it (a secondary): listed, never stopped. */
  killable?: false
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')

/**
 * The comment on the listing's own $currentOp aggregate, so it always leaves itself out; distinct
 * from the other monitoring reads, which "monitoring reads" shows (final review M7).
 */
const LISTING = `${OWN_READ}:ops`

/**
 * An operation of mongo-manager itself (a job, the monitor, a request being cancelled). A getMore
 * carries the comment of the command that opened its cursor, in one of two places by version
 * (final review 1i, Minor 7).
 */
export function isOwnOperation(op: Document): boolean {
  const comments = [
    (op.command as Document | undefined)?.comment,
    ((op.cursor as Document | undefined)?.originatingCommand as Document | undefined)?.comment,
    (op.originatingCommand as Document | undefined)?.comment,
  ]
  return comments.some((c) => typeof c === 'string' && OWN_COMMENT.test(c))
}

/** MongoDB refused a monitoring command: the account lacks a role, not the user a permission. */
function refusedByMongo(e: unknown, what: string): unknown {
  if ((e as { code?: unknown }).code === 13)
    return Errors.forbidden(`MongoDB refused ${what}: the account needs the clusterMonitor role`, {
      reason: 'mongo_not_permitted',
    })
  return toAppError(e)
}

/** What the list and the kill need of an operation; never client, clientMetadata or effectiveUsers. */
const FIELDS = {
  opid: 1,
  op: 1,
  ns: 1,
  microsecs_running: 1,
  planSummary: 1,
  waitingForLock: 1,
  desc: 1,
  command: 1,
  currentOpTime: 1,
  host: 1,
  'cursor.originatingCommand.comment': 1,
  'originatingCommand.comment': 1,
}

/**
 * Active operations, slowest first, as MongoDB reports them to this account. The sorting and the
 * limit run in MongoDB, so a busy server does not send every operation every 5 s (Minor 6).
 */
async function active(request: FastifyRequest, limit?: number): Promise<Document[]> {
  const client = await clientFor(request)
  // Re-review of B3 (M-1): an error (no primary in an election) is said, never taken for "none running".
  const { ops } = await withMongo(() =>
    listOperations(
      client,
      { active: true, op: { $ne: 'none' }, 'command.comment': { $ne: LISTING } },
      {
        comment: LISTING,
        // Review of B3 (I1): read where killOp runs (the primary), whatever the connection reads from.
        primary: true,
        stages: [
          { $sort: { microsecs_running: -1 } },
          ...(limit ? [{ $limit: limit }] : []),
          { $project: FIELDS },
        ],
      },
    ),
  )
  return ops
}

/**
 * One operation as the list shows it. The command is redacted for everyone (secrets, connection
 * strings) and masked for a restricted caller before it is cut to size; an operation on an
 * admin-only namespace (a credential collection, the local database: security audit 2026-10-16) shows
 * no command to a non-admin (phase 3b §2.4, §4).
 */
export function operationView(op: Document, masker: Masker | null, admin: boolean): OperationView {
  const ns = text(op.ns, 256)
  const out: OperationView = {
    opid: String(op.opid),
    op: text(op.op, 32),
    ns,
    secsRunning: Math.round(Number(op.microsecs_running ?? 0) / 100_000) / 10,
    waitingForLock: op.waitingForLock === true,
    desc: text(op.desc, 100),
  }
  if (typeof op.planSummary === 'string') out.planSummary = op.planSummary.slice(0, 200)
  if (isOwnOperation(op)) out.own = true
  // Third review of B3 (M4): only where it says how long it has run (else "now" would move each read).
  const now = Date.parse(String(op.currentOpTime ?? ''))
  const ran =
    op.microsecs_running === undefined || op.microsecs_running === null ? NaN : Number(op.microsecs_running)
  if (Number.isFinite(now) && Number.isFinite(ran)) out.startedAt = Math.round(now - ran / 1000)
  if (typeof op.host === 'string' && op.host) out.member = memberOf(op.host)
  const dot = ns.indexOf('.')
  const [db, coll] = dot < 0 ? [ns, ''] : [ns.slice(0, dot), ns.slice(dot + 1)]
  if (op.command && (admin || !isAdminOnlyNamespace(db, coll))) {
    let command = redactSecrets(toClient(op.command))
    if (masker) command = maskCommand(command, db, coll, masker)
    const json = JSON.stringify(command)
    out.command = json.length > MAX_COMMAND_BYTES ? `${json.slice(0, MAX_COMMAND_BYTES)}…` : json
  }
  // Never: client (address), clientMetadata, effectiveUsers (names of other accounts).
  return out
}

/**
 * A member told apart without naming its host — keyed for this process, so no guess of a host can be
 * checked against it (third review of B3, M3); a restart only makes a kill seen before it refused.
 */
const MEMBER_KEY = randomBytes(32)
const memberOf = (host: string): string =>
  createHmac('sha256', MEMBER_KEY).update(host).digest('hex').slice(0, 16)

const directOf = (client: MongoClient): boolean => client.options.directConnection === true
/** The read preference the connection's reads go by (primary unless it says otherwise). */
const preferenceOf = (client: MongoClient): string => client.readPreference.mode
/** How long the kill's own read waits for the primary when the list was read elsewhere. */
const REACH_MS = 3_000

/**
 * Fourth and fifth reviews of B3: of the operations listed elsewhere (a secondary), those a kill reaches —
 * the same opid on the same member, read where the kill reads (the primary), the listed opids only; with
 * no primary to read (an election), none (the list still shows).
 */
async function reachOf(client: MongoClient, ops: Document[], idle: boolean): Promise<Set<string>> {
  const opids = ops.slice(0, MAX_OPERATIONS).map((o) => o.opid)
  if (!opids.length) return new Set()
  try {
    const { ops: there } = await listOperations(
      client,
      { 'command.comment': { $ne: LISTING }, opid: { $in: opids } },
      {
        internal: idle,
        comment: LISTING,
        primary: true,
        timeoutMS: REACH_MS,
        stages: [{ $project: { opid: 1, host: 1 } }],
      },
    )
    return new Set(there.map((o) => `${String(o.opid)}|${String(o.host ?? '')}`))
  } catch {
    return new Set()
  }
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The $match of the list, built only from validated values (phase 3b §4). */
export function operationsMatch(q: OperationsQuery): Document {
  const match: Document = { 'command.comment': { $ne: LISTING } }
  // Mongo Manager's monitoring reads are left out in MongoDB, before the limit, so the list is never
  // short (final review M1). A user's request through the app (mm:<id>) and a job (mm-job:<id>)
  // are the user's work and stay listed (phase 3b-2). The comment sits in one of three places.
  if (!q.own) {
    match.$nor = [
      { 'command.comment': OWN_READ },
      { 'cursor.originatingCommand.comment': OWN_READ },
      { 'originatingCommand.comment': OWN_READ },
    ]
  }
  if (!q.idle) Object.assign(match, { active: true, op: { $ne: 'none' } })
  if (q.ns) match.ns = { $regex: `^${escapeRegex(q.ns)}(\\.|$)` }
  if (q.op) match.op = q.idle ? { $in: q.op } : { $in: q.op, $ne: 'none' }
  if (q.minSecs !== undefined) match.microsecs_running = { $gte: Math.round(q.minSecs * 1_000_000) }
  if (q.waitingForLock) match.waitingForLock = true
  // Third review of B3 (M8): one by its opid (a number, or a shard's "shard:123").
  if (q.opid) match.opid = /^-?\d+$/.test(q.opid) ? Number(q.opid) : q.opid
  return match
}

/** The seconds of a BSON timestamp, whichever class the driver used (Timestamp .t, Long .high). */
const seconds = (ts: unknown): number | null => {
  const t = (ts as { t?: unknown } | undefined)?.t ?? (ts as { high?: unknown } | undefined)?.high
  return typeof t === 'number' ? t : null
}
/** Members whose optime is a real position in the oplog (not the epoch of an initial sync). */
const REPLICATING = new Set(['PRIMARY', 'SECONDARY'])
const date = (v: unknown): Date | null => (v instanceof Date && !Number.isNaN(v.getTime()) ? v : null)

/** Hours between the first and the last entry of the oplog: how long a member may be away and catch up. */
async function oplogWindow(client: import('mongodb').MongoClient): Promise<number | null> {
  const oplog = client.db('local').collection('oplog.rs')
  const [first, last] = await Promise.all([
    oplog.findOne({}, { sort: { $natural: 1 }, projection: { ts: 1 }, ...ANY_MEMBER }),
    oplog.findOne({}, { sort: { $natural: -1 }, projection: { ts: 1 }, ...ANY_MEMBER }),
  ])
  const a = seconds(first?.ts)
  const b = seconds(last?.ts)
  return a === null || b === null ? null : Math.round(((b - a) / 3600) * 10) / 10
}

/**
 * Phase 1j spec §2. Lag is measured against the primary's last write, only for members that are up
 * and hold data: no primary, a member down or an arbiter means no lag, never NaN or a negative one.
 */
/**
 * Widgets wave 2 (2026-10-27): how much of its size the oplog uses, and how fast it fills — what it
 * holds over the hours it spans (Atlas's "oplog GB/hour"); none for an empty window.
 */
function oplogUse(stats: Document | null, windowHours: number | null) {
  const size = typeof stats?.size === 'number' ? stats.size : null
  const max = typeof stats?.maxSize === 'number' ? stats.maxSize : null
  if (size === null || max === null) return null
  const MB = 1024 ** 2
  return {
    usedMb: Math.round(size / MB),
    maxMb: Math.round(max / MB),
    gbPerHour: windowHours ? Math.round((size / 1024 ** 3 / windowHours) * 100) / 100 : null,
  }
}

/** The oplog's storage stats (size, maxSize), read where the window is; null when refused. */
async function oplogStats(client: MongoClient): Promise<Document | null> {
  const [stats] = await client
    .db('local')
    .collection('oplog.rs')
    .aggregate(
      [
        { $collStats: { storageStats: {} } },
        { $project: { 'storageStats.size': 1, 'storageStats.maxSize': 1 } },
      ],
      {
        ...ANY_MEMBER,
        maxTimeMS: 5_000,
      },
    )
    .toArray()
  return (stats?.storageStats as Document | undefined) ?? null
}

export function replicaView(
  status: Document,
  config: Document | null,
  oplogWindowHours: number | null,
  oplog: Document | null = null,
) {
  const raw = (Array.isArray(status.members) ? status.members : []) as Document[]
  const primary = raw.find((m) => m.stateStr === 'PRIMARY')
  const primaryOptime = date(primary?.optimeDate)
  // By member id: the host in the configuration can be spelt differently from the status name.
  const configured = new Map<unknown, Document>(
    ((config?.members ?? []) as Document[]).map((m) => [m._id, m]),
  )
  const optimes = (status.optimes ?? {}) as Document
  // How far the majority-committed point is behind the primary's last write; else, from the optimes
  // of the member that answered.
  const committedAt = date(optimes.lastCommittedWallTime)
  const applied = seconds((optimes.appliedOpTime as Document | undefined)?.ts)
  const committed = seconds((optimes.lastCommittedOpTime as Document | undefined)?.ts)
  const majorityLagSeconds =
    primaryOptime && committedAt
      ? Math.max(0, Math.round((primaryOptime.getTime() - committedAt.getTime()) / 100) / 10)
      : applied !== null && committed !== null
        ? Math.max(0, applied - committed)
        : null
  return {
    mode: 'replicaSet' as const,
    set: String(status.set ?? ''),
    date: date(status.date)?.toISOString() ?? null,
    primary: primary ? String(primary.name) : null,
    majorityLagSeconds,
    oplogWindowHours,
    oplog: oplogUse(oplog, oplogWindowHours),
    lastElection: date(primary?.electionDate)?.toISOString() ?? null,
    members: raw.map((m) => {
      const name = String(m.name)
      const conf = configured.get(m._id)
      const healthy = m.health === 1
      const arbiter = m.stateStr === 'ARBITER' || conf?.arbiterOnly === true
      // An initial sync (STARTUP2), RECOVERING or ROLLBACK reports the epoch: no lag, not 56 years.
      const optime = REPLICATING.has(String(m.stateStr)) ? date(m.optimeDate) : null
      const lag =
        healthy && !arbiter && primaryOptime && optime && optime.getTime() > 0
          ? Math.max(0, Math.round((primaryOptime.getTime() - optime.getTime()) / 100) / 10)
          : null
      const message =
        typeof m.lastHeartbeatMessage === 'string' && m.lastHeartbeatMessage ? m.lastHeartbeatMessage : null
      return {
        name,
        state: typeof m.stateStr === 'string' ? m.stateStr : 'UNKNOWN',
        healthy,
        self: m.self === true,
        uptimeSeconds: typeof m.uptime === 'number' ? m.uptime : null,
        lagSeconds: lag,
        pingMs: typeof m.pingMs === 'number' || typeof m.pingMs === 'bigint' ? Number(m.pingMs) : null,
        lastHeartbeat: date(m.lastHeartbeat)?.toISOString() ?? null,
        lastHeartbeatMessage: message ? message.slice(0, 200) : null,
        syncSource: typeof m.syncSourceHost === 'string' && m.syncSourceHost ? m.syncSourceHost : null,
        priority: typeof conf?.priority === 'number' ? conf.priority : null,
        hidden: typeof conf?.hidden === 'boolean' ? conf.hidden : null,
        votes: typeof conf?.votes === 'number' ? conf.votes : null,
        arbiter,
      }
    }),
  }
}

/** Phase 1i spec §3-4: the server behind a connection, for the Performance tab. */
export async function serverRoutes(app: FastifyInstance): Promise<void> {
  const base = '/connections/:id/server'
  const monitor = requireConnection('server:monitor')

  // The polling fallback of the live channel: one reading, with rates against the previous one.
  app.get(`${base}/status`, { preHandler: monitor, config: { masking: 'names-only' } }, async (request) => {
    try {
      return await app.ctx.monitor.status(request.connection!.id)
    } catch (e) {
      throw refusedByMongo(e, 'serverStatus')
    }
  })

  app.get(`${base}/operations`, { preHandler: monitor, config: { masking: 'guarded' } }, async (request) => {
    const q = parseInput(OperationsQuerySchema, request.query ?? {})
    const admin = request.connectionRole === 'admin'
    const client = await clientFor(request)
    // A failure other than a missing role is reported, not shown as an empty list (final review M2).
    const { ops, scope } = await withMongo(() =>
      listOperations(client, operationsMatch(q), {
        internal: q.idle ?? false,
        comment: LISTING,
        stages: [{ $sort: { microsecs_running: -1 } }, { $limit: MAX_OPERATIONS + 1 }, { $project: FIELDS }],
      }),
    )
    // Fourth review of B3 (critical): read elsewhere (a secondary) — the operations the kill reaches, read
    // where it reads them (the primary); through a direct connection the kill runs on the member read.
    const reach =
      directOf(client) || preferenceOf(client) === 'primary'
        ? null
        : await reachOf(client, ops, q.idle ?? false)
    // Final review I3: an operation on a view is masked by the view's source rules.
    const masker = await viewAwareMaskerFor(
      request,
      namespacePairs(ops.slice(0, MAX_OPERATIONS).map((op) => String(op.ns ?? ''))),
    )
    return {
      // W4 re-review C1: a drill's own operations are not listed (they name its scratch database).
      operations: ops
        .slice(0, MAX_OPERATIONS)
        .filter((op) => !isDrillScratchNs(String(op.ns ?? '')))
        .map((op) => {
          const view = operationView(op, masker, admin)
          // Third review of B3 (M1): listed where the connection reads; stoppable only where a kill runs
          // — the same opid on the same member when read where the kill reads (fourth review, critical:
          // never a set's configured names against the names $currentOp reports).
          return !reach || reach.has(`${String(op.opid)}|${String(op.host ?? '')}`)
            ? view
            : { ...view, killable: false as const }
        }),
      more: ops.length > MAX_OPERATIONS,
      scope,
    }
  })

  app.post(
    `${base}/operations/:opid/kill`,
    {
      preHandler: requireConnection('server:operations'),
      config: { masking: 'names-only', audit: 'server.killOp' },
    },
    async (request) => {
      const { opid } = parseInput(OpParams, request.params)
      // Read-only means nothing is changed through the app, killing included.
      if (app.ctx.config.readOnly || request.connection!.readOnly) throw Errors.readOnly()
      const expected = parseInput(KillBody, request.body ?? {})
      // Only an operation this account can see now: a made-up opid kills nothing.
      const op = (await active(request)).find((o) => String(o.opid) === opid)
      // Re-review of B3 (M-1): what has finished is said as such.
      if (!op)
        throw new AppError('NOT_FOUND', 'No such running operation', 404, { reason: 'operation_finished' })
      const ns = text(op.ns, 256)
      request.auditInfo = { details: { op: text(op.op, 32), ns } }
      // Review of B3 (I1): another operation under the opid the caller saw (a restart, a failover)
      // is never stopped in its place — its namespace, kind, start and member as they were seen
      // (re-review, M-2).
      const view = operationView(op, null, false)
      if (SYSTEM_DB.test(ns)) throw Errors.forbidden('Operations on system databases cannot be killed here')
      if (isOwnOperation(op))
        throw Errors.forbidden('Operations of mongo-manager itself are stopped from the jobs tray')
      // Fifth review of B3 (nit 7): where it says them, its member and start must be said — and be what
      // was seen (sixth review, nit 4: one not said is refused as such, not as another operation).
      if (
        (view.member !== undefined && expected.member === undefined) ||
        (view.startedAt !== undefined && expected.startedAt === undefined)
      )
        throw Errors.conflict('Say what was seen of it: its start and member', {
          reason: 'operation_unconfirmed',
        })
      const changed =
        expected.ns !== ns ||
        expected.op !== view.op ||
        (view.member !== undefined && expected.member !== view.member) ||
        (view.startedAt !== undefined && Math.abs(expected.startedAt! - view.startedAt) > STARTED_SLACK_MS)
      if (changed) {
        // The audit row says what was expected (re-review, nit).
        request.auditInfo = { details: { op: view.op, ns, expected } }
        throw Errors.conflict('Another operation runs under that opid now', { reason: 'operation_changed' })
      }
      await withMongo(async () => (await clientFor(request)).db('admin').command({ killOp: 1, op: op.opid }))
      return { killed: opid }
    },
  )

  // Phase 1j: the members of a replica set, which is primary, which are down, and how far behind.
  app.get(`${base}/replica`, { preHandler: monitor, config: { masking: 'names-only' } }, async (request) => {
    try {
      return await replicaStatus(request)
    } catch (e) {
      // An answer the driver could not decode is a MongoDB problem (502). Anything else is a bug and
      // reaches the global handler as one (500, logged with its stack) — final review 1j, Important 4.
      if (e instanceof Error && e.name.startsWith('BSON')) {
        request.log.warn(
          { error: e.name, message: redactUris(e.message).slice(0, 300) },
          'replica set status failed',
        )
        throw new AppError('MONGO_ERROR', 'Could not read the replica set status; try again', 502)
      }
      throw e
    }
  })

  async function replicaStatus(request: FastifyRequest) {
    const client = await clientFor(request)
    const admin = client.db('admin')
    const hello = await withMongo(() => admin.command({ hello: 1 }, ANY_MEMBER))
    if (hello.msg === 'isdbgrid') return { mode: 'sharded' }
    if (typeof hello.setName !== 'string') return { mode: 'standalone' }
    let status: Document
    try {
      status = await admin.command({ replSetGetStatus: 1 }, ANY_MEMBER)
    } catch (e) {
      throw refusedByMongo(e, 'replSetGetStatus')
    }
    // The configuration and the oplog add detail; an account that may not read them still sees the rest.
    const config = await admin
      .command({ replSetGetConfig: 1 }, ANY_MEMBER)
      .then((r) => (r.config as Document | undefined) ?? null)
      .catch(() => null)
    const [oplogWindowHours, oplog] = await Promise.all([
      oplogWindow(client).catch(() => null),
      Promise.resolve()
        .then(() => oplogStats(client))
        .catch(() => null),
    ])
    return replicaView(status, config, oplogWindowHours, oplog)
  }

  app.get(`${base}/top`, { preHandler: monitor, config: { masking: 'names-only' } }, async (request) => ({
    collections: await busiest(await clientFor(request), MAX_TOP),
  }))

  // Widgets wave 2 (2026-10-27; Atlas Namespace Insights): the busiest collections' latency.
  app.get(
    `${base}/collection-latency`,
    { preHandler: monitor, config: { masking: 'names-only' } },
    async (request) => {
      const client = await clientFor(request)
      const top = await busiest(client, MAX_LATENCY)
      return { collections: await Promise.all(top.map((c) => collectionLatency(client, c.ns))) }
    },
  )

  // Widgets wave 2 (mongosh's banner): version, FCV, engine, host size, start-up warnings — no host.
  app.get(`${base}/facts`, { preHandler: monitor, config: { masking: 'names-only' } }, async (request) =>
    gatherFacts(await clientFor(request)),
  )
}

/**
 * The collections a server spends its time on, from `top`: no system database or collection, no
 * restore drill's scratch, only collections that exist; the busiest first.
 */
async function busiest(client: MongoClient, limit: number) {
  let result: Document
  try {
    result = await client.db('admin').command({ top: 1 }, LENIENT)
  } catch (e) {
    throw refusedByMongo(e, 'the top command')
  }
  const totals = (result.totals ?? {}) as Record<string, Document>
  const ms = (v: unknown) => Math.round(Number((v as Document | undefined)?.time ?? 0) / 1000)
  const collections = Object.entries(totals)
    // System databases and system collections (system.profile, system.views, system.buckets.*).
    // W4 re-review C1: nor a restore drill's scratch database (its random name is no one's to see).
    .filter(
      ([ns]) => ns.includes('.') && !SYSTEM_DB.test(ns) && !/\.system\./.test(ns) && !isDrillScratchNs(ns),
    )
    .map(([ns, t]) => ({
      ns,
      totalMs: ms(t.total),
      readMs: ms(t.readLock),
      writeMs: ms(t.writeLock),
      count: Number((t.total as Document | undefined)?.count ?? 0),
    }))
    .sort((a, b) => b.totalMs - a.totalMs || b.count - a.count)
    .slice(0, limit * 4)
  return (await existing(client, collections)).slice(0, limit)
}

/**
 * User report 2026-10-10: top counts every namespace a command named — a find on a mistyped name
 * ("orderss") too, though no such collection was ever made. Only collections that exist are kept,
 * asked of each database once (by the names in question); a database that cannot be listed keeps
 * its names (they are not hidden for want of a right).
 */
async function existing<T extends { ns: string }>(client: MongoClient, rows: T[]): Promise<T[]> {
  const byDb = new Map<string, string[]>()
  for (const { ns } of rows) {
    const dot = ns.indexOf('.')
    const db = ns.slice(0, dot)
    byDb.set(db, [...(byDb.get(db) ?? []), ns.slice(dot + 1)])
  }
  const found = new Set<string>()
  await Promise.all(
    [...byDb].map(async ([db, names]) => {
      try {
        const listed = await client
          .db(db)
          .listCollections({ name: { $in: names } }, { nameOnly: true, authorizedCollections: true })
          .toArray()
        for (const c of listed) found.add(`${db}.${c.name}`)
      } catch {
        for (const name of names) found.add(`${db}.${name}`)
      }
    }),
  )
  return rows.filter((r) => found.has(r.ns))
}
