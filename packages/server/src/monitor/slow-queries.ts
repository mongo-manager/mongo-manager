// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { EJSON } from 'bson'
import type { Document, MongoClient } from 'mongodb'
import { toClient } from '../data/ejson-io'
import type { OperationKind, QueryOrigin } from '@mongo-manager/shared'
import { isAdminOnlyNs, isDrillScratchNs } from '../connections/access'
import { holdsSecret, maskCommand, redactSecrets, type Masker } from '../masking'
import { queryOriginOf } from '../shell/proxy/origin'

/** Phase 3b spec §3.2. */
export const MAX_LOG_LINES = 1024
export const MAX_LINE_BYTES = 64 * 1024
export const MAX_COMMAND_TEXT = 16 * 1024
export const MAX_ENTRIES = 200
/** The id of MongoDB's structured "Slow query" log line. */
const SLOW_QUERY_ID = 51803

/** A slow operation before it is redacted: the command still as driver values. */
export interface RawSlow {
  source: 'profile' | 'log'
  ts: string
  ns: string
  db: string
  op: string
  durationMs: number
  planSummary?: string
  keysExamined?: number
  docsExamined?: number
  nreturned?: number
  command: Document | null
  /** One of mongo-manager's monitoring reads, by its comment or its cursor's (final review M8). */
  own?: boolean
  /** Index advice gaps (2026-10-27): MongoDB's own hash of the query's shape (8.0+), when it gave one. */
  shapeHash?: string
  /** A getMore's originating command (final review Minor 16): what its shape is. */
  origin?: Document | null
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' ? v.slice(0, max) : undefined
const doc = (v: unknown): Document | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Document) : null
const iso = (v: unknown): string =>
  v instanceof Date && !Number.isNaN(v.getTime()) ? v.toISOString() : new Date(0).toISOString()
const dbOf = (ns: string): string => (ns.includes('.') ? ns.slice(0, ns.indexOf('.')) : ns)

/** Command names as the profiler's `op` names them, so both sources filter alike. */
const OP_OF: Record<string, string> = {
  find: 'query',
  insert: 'insert',
  update: 'update',
  delete: 'remove',
  getMore: 'getmore',
}
/** The kinds a log line's `type` names; anything else is read from the command. */
const LOG_KINDS = new Set(['query', 'insert', 'update', 'remove', 'getmore'])
const opOf = (command: Document | null, type?: unknown): string => {
  if (typeof type === 'string' && LOG_KINDS.has(type)) return type
  const name = command ? Object.keys(command)[0] : undefined
  // A statement as the log reports an update ({ q, u }) or a delete ({ q, limit }) (final review I2).
  if (name === 'q') return command && 'u' in command ? 'update' : 'remove'
  return (name && OP_OF[name]) ?? 'command'
}

/**
 * The query an entry ran, for "Open in Explain" — only when the command holds no secret: an
 * origin is built from the command as MongoDB reported it, so one the redaction would change is
 * never sent (final review I1).
 */
export function explainOrigin(command: Document | null, db: string): QueryOrigin | undefined {
  if (!command) return undefined
  try {
    const shown = toClient(command)
    if (holdsSecret(shown)) return undefined
    return queryOriginOf({ name: Object.keys(command)[0] ?? '', db, body: command }) ?? undefined
  } catch {
    return undefined
  }
}

function withCounters(entry: RawSlow, a: Document): RawSlow {
  const planSummary = str(a.planSummary, 200)
  const keysExamined = num(a.keysExamined)
  const docsExamined = num(a.docsExamined)
  const nreturned = num(a.nreturned ?? a.nReturned)
  // A hash only (64 hexadecimal characters): nothing else MongoDB might put there is passed on.
  const shapeHash =
    typeof a.queryShapeHash === 'string' && /^[0-9A-Fa-f]{64}$/.test(a.queryShapeHash)
      ? a.queryShapeHash
      : undefined
  return {
    ...entry,
    ...(shapeHash ? { shapeHash } : {}),
    ...(planSummary ? { planSummary } : {}),
    ...(keysExamined !== undefined ? { keysExamined } : {}),
    ...(docsExamined !== undefined ? { docsExamined } : {}),
    ...(nreturned !== undefined ? { nreturned } : {}),
  }
}

/**
 * "Slow query" lines of getLog('global'), at most the last 1024, each parsed on its own (relaxed
 * EJSON into driver values); a line that is too long or does not parse is skipped.
 */
export function parseSlowLog(lines: unknown): RawSlow[] {
  if (!Array.isArray(lines)) return []
  const out: RawSlow[] = []
  for (const line of lines.slice(-MAX_LOG_LINES)) {
    if (typeof line !== 'string' || Buffer.byteLength(line) > MAX_LINE_BYTES) continue
    let parsed: unknown
    try {
      parsed = EJSON.parse(line, { relaxed: true })
    } catch {
      continue
    }
    const entry = doc(parsed)
    const attr = entry && doc(entry.attr)
    if (!entry || !attr || entry.id !== SLOW_QUERY_ID) continue
    const ns = str(attr.ns, 256) ?? ''
    const command = doc(attr.command)
    out.push(
      withCounters(
        {
          source: 'log',
          ts: iso(entry.t),
          ns,
          db: dbOf(ns),
          op: opOf(command, attr.type),
          durationMs: num(attr.durationMillis) ?? 0,
          command,
          origin: doc(attr.originatingCommand),
          own: isOwnCommand(command ?? null) || isOwnCommand(doc(attr.originatingCommand) ?? null),
        },
        attr,
      ),
    )
  }
  return out
}

/**
 * A command as the list shows it: canonical EJSON with secrets hidden for everyone and personal
 * values masked when a masker is given, cut to 16 KiB. A command holding a value that cannot be
 * shown (a date outside JavaScript's range) is shown as nothing rather than failing the list.
 */
export function commandText(
  command: Document | null,
  mask?: { masker: Masker; db: string; coll: string },
): string {
  if (!command) return ''
  let value: unknown
  try {
    value = redactSecrets(toClient(command))
  } catch {
    return ''
  }
  if (mask) value = maskCommand(value, mask.db, mask.coll, mask.masker)
  const text = JSON.stringify(value)
  return text.length > MAX_COMMAND_TEXT ? `${text.slice(0, MAX_COMMAND_TEXT)}…` : text
}

/** One system.profile document, as the driver read it. */
export function fromProfile(d: Document): RawSlow {
  const ns = str(d.ns, 256) ?? ''
  const command = doc(d.command) ?? doc(d.originatingCommand)
  return withCounters(
    {
      source: 'profile',
      ts: iso(d.ts),
      ns,
      db: dbOf(ns),
      op: str(d.op, 32) ?? opOf(command),
      durationMs: num(d.millis) ?? 0,
      command,
      origin: doc(d.originatingCommand),
      own: isOwnCommand(doc(d.command) ?? null) || isOwnCommand(doc(d.originatingCommand) ?? null),
    },
    d,
  )
}

/** What an entry shows of a system.profile document; the rest (locks, storage, execStats) stays in MongoDB (final review M6). */
const PROFILE_FIELDS = {
  ts: 1,
  ns: 1,
  op: 1,
  millis: 1,
  planSummary: 1,
  keysExamined: 1,
  docsExamined: 1,
  nreturned: 1,
  command: 1,
  originatingCommand: 1,
  queryShapeHash: 1,
}
const refusal = (e: unknown): string => ((e as { code?: unknown }).code === 13 ? 'not_permitted' : 'error')
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export const collOf = (ns: string): string => (ns.includes('.') ? ns.slice(ns.indexOf('.') + 1) : '')

export interface SlowFilter {
  db?: string
  coll?: string
  op?: OperationKind[]
  minMs?: number
  source: 'profile' | 'log' | 'both'
}

/**
 * Phase 3b §3.2 and §6a: the slow operations of both sources, filtered, newest first; each source's
 * refusal is noted and the other still answers. Admin-only namespaces (the local database, credential
 * collections; security audit 2026-10-16) are left out for non-admins.
 * Shared by the slow-query list and the index advice.
 */
export async function collectSlow(
  client: MongoClient,
  q: SlowFilter,
  limit: number,
  admin: boolean,
): Promise<{ raw: RawSlow[]; refused: { profile?: string; log?: string } }> {
  const refused: { profile?: string; log?: string } = {}
  const raw: RawSlow[] = []
  if (q.source !== 'log') {
    if (!q.db) refused.profile = 'no_db'
    else {
      const match: Document = {}
      if (q.coll) match.ns = `${q.db}.${q.coll}`
      if (q.op) match.op = { $in: q.op }
      if (q.minMs !== undefined) match.millis = { $gte: q.minMs }
      try {
        const docs = await client
          .db(q.db)
          .collection('system.profile')
          .find(match, {
            sort: { ts: -1 },
            limit,
            maxTimeMS: 5000,
            projection: PROFILE_FIELDS,
            comment: OWN_READ,
          })
          .toArray()
        raw.push(...docs.map(fromProfile))
      } catch (e) {
        refused.profile = refusal(e)
      }
    }
  }
  if (q.source !== 'profile') {
    try {
      const log = await client.db('admin').command({ getLog: 'global', comment: OWN_READ })
      const scope = q.db ? new RegExp(`^${escapeRegex(q.coll ? `${q.db}.${q.coll}` : q.db)}(\\.|$)`) : null
      raw.push(
        ...parseSlowLog(log.log).filter(
          (e) =>
            (!scope || scope.test(e.ns)) &&
            (q.minMs === undefined || e.durationMs >= q.minMs) &&
            (!q.op || (q.op as string[]).includes(e.op)),
        ),
      )
    } catch (e) {
      refused.log = refusal(e)
    }
  }
  return {
    raw: raw
      // Mongo Manager's own reads (the profiler is on while this lists it) are not the user's slow queries.
      // W4 re-review C1: nor a restore drill's scratch database.
      .filter((e) => !isOwnEntry(e) && (admin || !isAdminOnlyNs(e.ns)) && !isDrillScratchNs(e.ns))
      .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)),
    refused,
  }
}

/** The comment on mongo-manager's own reads, so they never show up as the user's slow queries. */
export const OWN_READ = 'mm-monitor'
/**
 * One of mongo-manager's own monitoring reads (profiler, log, live charts). A user's queries run
 * through the app carry mm:<request> and a job's mm-job:<id>: those are the user's work and stay.
 */
export const isOwnCommand = (command: Document | null): boolean =>
  typeof command?.comment === 'string' &&
  (command.comment === OWN_READ || command.comment.startsWith(`${OWN_READ}:`))

/** An entry of mongo-manager's own reads: its command, or the command that opened its cursor. */
export const isOwnEntry = (e: RawSlow): boolean => e.own === true || isOwnCommand(e.command)
