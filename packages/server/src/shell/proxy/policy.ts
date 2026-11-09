// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { findServerJs } from '@mongo-manager/shared'
import {
  SYSTEM_DATABASES,
  CREDENTIAL_COLLECTIONS,
  hostsKeyVault,
  isDrillScratch,
  isEncryptionNamespace,
} from '../../connections/access'

/**
 * Phase 3a-1 spec §5.3: the command policy, applied in the proxy — outside the process that runs
 * user code. Read-only sessions may run only an allow-list of read commands. Non-admins of the
 * connection may not run cluster-admin or user-management commands, may not touch credential
 * collections, and may not write to admin/config/local. Refusals become a MongoDB error the worker
 * prints normally.
 */

/** Commands allowed on a read-only session. Everything else is refused. */
export const READ_COMMANDS = new Set([
  'find',
  'getmore',
  'getMore',
  'aggregate',
  'count',
  'distinct',
  'listcollections',
  'listCollections',
  'listdatabases',
  'listDatabases',
  'listindexes',
  'listIndexes',
  'dbstats',
  'dbStats',
  'collstats',
  'collStats',
  'connectionstatus',
  'connectionStatus',
  'serverstatus',
  'serverStatus',
  'buildinfo',
  'buildInfo',
  'hostinfo',
  'hostInfo',
  'hello',
  'ismaster',
  'isMaster',
  'ping',
  'explain',
  'killcursors',
  'killCursors',
  'endsessions',
  'endSessions',
  'getparameter',
  'getParameter',
  'whatsmyuri',
  'currentop',
  'currentOp',
  'lockinfo',
  'lockInfo',
  'aggregatelistsearchindexes',
])

/** Commands only a connection admin may run (they manage users, the cluster, or the server). */
export const ADMIN_ONLY_COMMANDS = new Set(
  [
    'createUser',
    'dropUser',
    'dropAllUsersFromDatabase',
    'updateUser',
    'grantRolesToUser',
    'revokeRolesFromUser',
    'createRole',
    'dropRole',
    'dropAllRolesFromDatabase',
    'grantRolesToRole',
    'revokeRolesFromRole',
    'grantPrivilegesToRole',
    'revokePrivilegesFromRole',
    'updateRole',
    // applyOps can write to any namespace (including admin.system.users) directly, sidestepping the
    // createUser/insert restrictions; reIndex, cloneCollectionAsCapped and godinsert are low-level
    // maintenance/internal operations. All are for connection admins only (review I1).
    'applyOps',
    'reIndex',
    'cloneCollectionAsCapped',
    'godinsert',
    'shutdown',
    'fsync',
    'fsyncUnlock',
    'setParameter',
    'setFeatureCompatibilityVersion',
    'setDefaultRWConcern',
    'replSetReconfig',
    'replSetStepDown',
    'replSetInitiate',
    'replSetResizeOplog',
    'addShard',
    'removeShard',
    'enableSharding',
    'shardCollection',
    'logRotate',
    'killAllSessions',
    'killAllSessionsByPattern',
    'killOp',
    'dropConnections',
    'rotateCertificates',
    'flushRouterConfig',
    // Security review 2026-10-13 (M6): replication, cluster parameters, sessions, logs, the command
    // line, fail points, signing in as someone else, sharding and other users' operations.
    'replSetFreeze',
    'replSetMaintenance',
    'replSetSyncFrom',
    'replSetAbortPrimaryCatchUp',
    'setClusterParameter',
    'setUserWriteBlockMode',
    'killSessions',
    'getLog',
    'getCmdLineOpts',
    'configureFailPoint',
    'saslStart',
    'saslContinue',
    'authenticate',
    'logout',
    'moveChunk',
    'moveRange',
    'splitChunk',
    'split',
    'mergeChunks',
    'movePrimary',
    'balancerStart',
    'balancerStop',
    'configureCollectionBalancing',
    'setAllowMigrations',
    'clearJumboFlag',
    'cleanupOrphaned',
    'reshardCollection',
    'abortReshardCollection',
    'commitReshardCollection',
    'refineCollectionShardKey',
    'updateZoneKeyRange',
    'addShardToZone',
    'removeShardFromZone',
    'transitionToDedicatedConfigServer',
    'currentOp',
    'top',
    // Security audit 2026-10-16 (minors): the profiler's filter for every database, the diagnostic
    // data (it holds the command line getCmdLineOpts guards), the locks of other users' operations
    // (as currentOp), the audit and server logs, the free monitoring, the users' cache, the query
    // sampler and the query settings of every client.
    'setProfilingFilterGlobally',
    'getDiagnosticData',
    'lockInfo',
    'setAuditConfig',
    'logApplicationMessage',
    'clearLog',
    'rotateFTDC',
    'setFreeMonitoring',
    'invalidateUserCache',
    'configureQueryAnalyzer',
    'setQuerySettings',
    'removeQuerySettings',
  ].map((c) => c.toLowerCase()),
)

/** Stages that read other users' operations, sessions or queries: connection admins only (M6). */
const ADMIN_ONLY_STAGES = [
  '$currentOp',
  '$listSessions',
  '$listLocalSessions',
  '$planCacheStats',
  // It tails every write, like the oplog; with showSystemEvents, credential changes too (review
  // 2026-10-13 of the policy, I1).
  '$changeStream',
  // Other users' query shapes and filters, and every collection's catalog entry (data review
  // 2026-10-13, M6).
  '$listSampledQueries',
  '$queryStats',
  '$listCatalog',
  // Query settings keep representative queries with their values; the cluster's whole catalog
  // (round 2, Minor 8).
  '$querySettings',
  '$listClusterCatalog',
]

/** A namespace written whole, "db.coll", as dataSize, renameCollection and bulkWrite take them. */
const wholeNs = (v: unknown): { db: string; coll: string } | null => {
  if (typeof v !== 'string') return null
  const dot = v.indexOf('.')
  return dot > 0 ? { db: v.slice(0, dot), coll: v.slice(dot + 1) } : null
}

/** Commands that run on admin and name the namespaces they write (renameCollection, bulkWrite). */
const NAMESPACE_WRITES = new Set(['renamecollection', 'bulkwrite'])

/** The fields of a profile command that only reads the profiling level (security review M5). */
const PROFILE_READ_FIELDS = new Set(['profile', '$db', 'lsid', '$clusterTime', '$readPreference'])

/** A field name JavaScript would put first whatever its place on the wire (review H2). */
const NUMBER_LIKE = /^(0|[1-9]\d*)$/

/** Write commands (refused on a read-only session). */
const WRITE_COMMANDS = new Set(
  [
    'insert',
    'update',
    'delete',
    'findAndModify',
    'findandmodify',
    'create',
    'createIndexes',
    'drop',
    'dropDatabase',
    'dropIndexes',
    'renameCollection',
    'collMod',
    'mapReduce',
    'mapreduce',
    'bulkWrite',
    'createSearchIndexes',
    'updateSearchIndex',
    'dropSearchIndex',
    'compact',
    'convertToCapped',
    'emptycapped',
  ].map((c) => c.toLowerCase()),
)

export interface Command {
  name: string
  db: string
  body: Record<string, unknown>
}

/**
 * A refusal; `code` marks the ones the page words itself (SERVER_JS: server-side JavaScript is off,
 * security audit 2026-10-16).
 */
export type PolicyResult = { allow: true } | { allow: false; reason: string; code?: 'SERVER_JS' }

/**
 * Security review 2026-10-16 (I-2): the only $-prefixed top-level arguments the driver sends. Every
 * other one is MongoDB's internal business ($client, $audit, $configServerState, $impersonatedUser,
 * $tenant, …) — $client let a command pass for another client's.
 */
const DRIVER_DOLLAR_ARGUMENTS = new Set(['$db', '$clusterTime', '$readPreference'])
/** Internal arguments without a $. */
const INTERNAL_ARGUMENTS = new Set(['mayBypassWriteBlocking'])

/**
 * Commands that always run JavaScript on the MongoDB server, whatever their fields: mapReduce takes
 * its map and reduce as code, group its $reduce, and the eval command a function (the last two
 * are gone since MongoDB 4.2, refused all the same).
 */
const SERVER_JS_COMMANDS = new Set(['mapreduce', 'group', 'eval', '$eval'])

/**
 * Security audit 2026-10-16 (Important 1): the shell honours `allowServerJs` as every other path does
 * (assertNoServerJs). The whole command is scanned — filters, pipelines at any depth, update
 * pipelines, validators, an explained command and the folded kind-1 sequences — so no field can carry
 * $where, $function or $accumulator past it. A body too deep to scan is refused (fail closed).
 */
function serverJsIn(cmd: Command): string | null {
  if (SERVER_JS_COMMANDS.has(cmd.name.toLowerCase())) return cmd.name
  return findServerJs(cmd.body)
}

/** Read the command name (the first field) from an OP_MSG command document. */
export function commandName(body: Record<string, unknown>): string {
  for (const key of Object.keys(body)) {
    if (!key.startsWith('$')) return key
  }
  return ''
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** A namespace a stage names: a collection name, or {db, coll}. */
type Named = { db?: string; coll: string }
const named = (v: unknown): Named | null =>
  typeof v === 'string'
    ? { coll: v }
    : isObject(v) && typeof v.coll === 'string'
      ? { coll: v.coll, ...(typeof v.db === 'string' ? { db: v.db } : {}) }
      : null

/**
 * Every stage of a pipeline at any depth ($facet, $lookup and $unionWith nest pipelines), with the
 * namespaces it reads or writes (security review 2026-10-13, H1, M5).
 */
function* stagesOf(pipeline: unknown, depth = 0): Generator<Record<string, unknown>> {
  if (!Array.isArray(pipeline) || depth > 20) return
  for (const stage of pipeline) {
    if (!isObject(stage)) continue
    yield stage
    if (isObject(stage.$facet))
      for (const branch of Object.values(stage.$facet)) yield* stagesOf(branch, depth + 1)
    if (isObject(stage.$lookup)) yield* stagesOf(stage.$lookup.pipeline, depth + 1)
    if (isObject(stage.$unionWith)) yield* stagesOf(stage.$unionWith.pipeline, depth + 1)
  }
}

/** Whether a pipeline nests deeper than stagesOf reads (round 2, Minor 8): refused, never let through. */
function tooDeep(pipeline: unknown, depth = 0): boolean {
  if (!Array.isArray(pipeline)) return false
  if (depth > 20) return pipeline.length > 0
  return pipeline.some(
    (stage) =>
      isObject(stage) &&
      ((isObject(stage.$facet) && Object.values(stage.$facet).some((b) => tooDeep(b, depth + 1))) ||
        (isObject(stage.$lookup) && tooDeep(stage.$lookup.pipeline, depth + 1)) ||
        (isObject(stage.$unionWith) && tooDeep(stage.$unionWith.pipeline, depth + 1))),
  )
}

/** The namespaces a pipeline reads besides its own collection. */
function pipelineReads(pipeline: unknown): Named[] {
  const out: Named[] = []
  for (const s of stagesOf(pipeline)) {
    const lookup = isObject(s.$lookup) ? named(s.$lookup.from) : null
    const union = named(s.$unionWith)
    const graph = isObject(s.$graphLookup) ? named(s.$graphLookup.from) : null
    for (const n of [lookup, union, graph]) if (n) out.push(n)
  }
  return out
}

/** The namespaces a pipeline writes ($out, $merge). */
function pipelineWritesTo(pipeline: unknown): Named[] {
  const out: Named[] = []
  for (const s of stagesOf(pipeline)) {
    const target =
      '$out' in s
        ? named(s.$out)
        : '$merge' in s
          ? named(isObject(s.$merge) ? s.$merge.into : s.$merge)
          : null
    if (target) out.push(target)
  }
  return out
}

/**
 * Collections a non-admin may not read: the credential ones, and the profiler, which records every
 * client's commands with their literal values — what currentOp shows only connection admins
 * (security audit 2026-10-16).
 */
const READ_RESTRICTED = new Set([...CREDENTIAL_COLLECTIONS, 'system.profile'])
/** …and client-side encryption's key vaults and Queryable Encryption metadata (security review C1). */
const readRestricted = (db: string, coll: string) =>
  READ_RESTRICTED.has(coll) || isEncryptionNamespace(db, coll)

/** The collections of the server's own: users, keys, the profiler, stored code and views. */
const isSystemCollection = (coll: string) => coll.startsWith('system.')

/** Does an aggregation pipeline write ($out / $merge), at any nesting the shell can express? */
function pipelineWrites(pipeline: unknown): boolean {
  if (!Array.isArray(pipeline)) return false
  for (const stage of pipeline) {
    if (!stage || typeof stage !== 'object') continue
    const s = stage as Record<string, unknown>
    if ('$out' in s || '$merge' in s) return true
    // $facet and $lookup can nest pipelines; a write there is still a write.
    if ('$facet' in s && s.$facet && typeof s.$facet === 'object') {
      for (const branch of Object.values(s.$facet as Record<string, unknown>))
        if (pipelineWrites(branch)) return true
    }
    if ('$lookup' in s && s.$lookup && typeof s.$lookup === 'object') {
      if (pipelineWrites((s.$lookup as { pipeline?: unknown }).pipeline)) return true
    }
    if ('$unionWith' in s && s.$unionWith && typeof s.$unionWith === 'object') {
      if (pipelineWrites((s.$unionWith as { pipeline?: unknown }).pipeline)) return true
    }
  }
  return false
}

function isWrite(name: string, body: Record<string, unknown>): boolean {
  const lower = name.toLowerCase()
  if (WRITE_COMMANDS.has(lower)) return true
  if (lower === 'aggregate') return pipelineWrites(body.pipeline)
  return false
}

/** The collection a command names, if any (its first-field value when that is a string). */
/** W4 review C1: the command's database, or a database it names (a whole namespace, a pipeline's). */
function namesDrillScratch(cmd: Command): boolean {
  if (isDrillScratch(cmd.db)) return true
  const whole = [
    cmd.body[cmd.name],
    cmd.body.to,
    ...(Array.isArray(cmd.body.nsInfo) ? cmd.body.nsInfo : []),
  ].map((v) => wholeNs(isObject(v) ? v.ns : v))
  if (whole.some((n) => n && isDrillScratch(n.db))) return true
  // W4 re-review (minor): writes into it as well — $out/$merge, mapReduce's out, applyOps.
  const out = cmd.body.out
  if (isObject(out) && typeof out.db === 'string' && isDrillScratch(out.db)) return true
  const ops = Array.isArray(cmd.body.applyOps) ? cmd.body.applyOps : []
  if (ops.some((o) => isObject(o) && typeof o.ns === 'string' && isDrillScratch(wholeNs(o.ns)?.db)))
    return true
  return [...pipelineReads(cmd.body.pipeline), ...pipelineWritesTo(cmd.body.pipeline)].some((n) =>
    isDrillScratch(n.db),
  )
}

function targetCollection(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name]
  return typeof value === 'string' ? value : undefined
}

export function commandPolicy(context: {
  readOnly: boolean
  admin: boolean
  /** The server's allowServerJs (MM_ALLOW_SERVER_JS or the config file); off unless the operator turned it on. */
  allowServerJs?: boolean
}): (cmd: Command) => PolicyResult {
  return (cmd: Command): PolicyResult => {
    const lower = cmd.name.toLowerCase()
    if (!cmd.name) return { allow: false, reason: 'empty command' }
    // A number-like field changes which field JavaScript reads first (review 2026-10-13, H2).
    if (Object.keys(cmd.body).some((k) => NUMBER_LIKE.test(k)) || NUMBER_LIKE.test(cmd.name))
      return { allow: false, reason: 'a command field named like a number' }

    // Internal arguments, for admins too (security review 2026-10-16, I-2): $client made MongoDB
    // file the operation under another client's appName, out of reach of the session's kill.
    const internal = Object.keys(cmd.body).find(
      (k) => (k.startsWith('$') && !DRIVER_DOLLAR_ARGUMENTS.has(k)) || INTERNAL_ARGUMENTS.has(k),
    )
    if (internal) return { allow: false, reason: `the internal argument ${internal} is not accepted` }

    // Server-side JavaScript, for admins too: the setting is the server's (security audit 2026-10-16).
    if (!context.allowServerJs) {
      const js = serverJsIn(cmd)
      // findServerJs fails closed on a body too deep to scan: refused, and said as what it is.
      if (js === '(nesting too deep)')
        return { allow: false, reason: 'the command is nested too deeply to check for server JavaScript' }
      if (js)
        return {
          allow: false,
          code: 'SERVER_JS',
          reason: `${js} runs JavaScript on the MongoDB server and is disabled. Set MM_ALLOW_SERVER_JS=1 (or allowServerJs in the config file) to allow it.`,
        }
    }

    // W4 review C1: a restore drill's scratch database, for admins too — whatever names it (a
    // pipeline too deep to read through could hide it: refused for admins as well).
    if (tooDeep(cmd.body.pipeline)) return { allow: false, reason: 'the pipeline is nested too deeply' }
    if (namesDrillScratch(cmd))
      return { allow: false, reason: 'a restore drill’s scratch database is not open to anyone' }

    // An explained command is judged by what it explains.
    if (lower === 'explain') {
      const inner = cmd.body.explain
      if (inner && typeof inner === 'object') {
        if (Object.keys(inner).some((k) => NUMBER_LIKE.test(k)))
          return { allow: false, reason: 'a command field named like a number' }
        const innerName = commandName(inner as Record<string, unknown>)
        const r = commandPolicy(context)({
          name: innerName,
          db: cmd.db,
          body: inner as Record<string, unknown>,
        })
        if (!r.allow) return r
      }
    }

    if (context.readOnly) {
      if (isWrite(cmd.name, cmd.body))
        return { allow: false, reason: `${cmd.name} writes; this session is read-only` }
      if (!READ_COMMANDS.has(cmd.name) && lower !== 'explain') {
        return { allow: false, reason: `${cmd.name} is not a read command; this session is read-only` }
      }
    }

    if (!context.admin) {
      if (ADMIN_ONLY_COMMANDS.has(lower)) {
        return { allow: false, reason: `${cmd.name} is restricted to connection admins` }
      }
      // The oplog holds every write, credentials included (security review 2026-10-13, M1).
      if (cmd.db === 'local')
        return { allow: false, reason: 'the local database is restricted to connection admins' }
      const coll = targetCollection(cmd.body, cmd.name)
      if (coll && readRestricted(cmd.db, coll)) {
        return { allow: false, reason: `${cmd.db}.${coll} is restricted to connection admins` }
      }
      // A credential namespace written whole (dataSize "admin.system.users") or in a list (dbHash).
      const whole = wholeNs(coll)
      const listed = Array.isArray(cmd.body.collections) ? cmd.body.collections : []
      if (
        (whole && readRestricted(whole.db, whole.coll)) ||
        listed.some((c) => readRestricted(cmd.db, String(c)))
      )
        return {
          allow: false,
          reason: 'credential collections and the profiler are restricted to connection admins',
        }
      // The local database named from another one (dataSize "local.oplog.rs"; data review M6).
      if (whole?.db === 'local')
        return { allow: false, reason: 'the local database is restricted to connection admins' }
      // Credentials and other users' operations through a pipeline, at any depth (H1, M6).
      const pipeline = cmd.body.pipeline
      if (tooDeep(pipeline)) return { allow: false, reason: 'the pipeline is nested too deeply' }
      for (const n of pipelineReads(pipeline))
        if (readRestricted(n.db ?? cmd.db, n.coll) || n.db === 'local')
          return { allow: false, reason: `${n.db ?? cmd.db}.${n.coll} is restricted to connection admins` }
      for (const s of stagesOf(pipeline))
        for (const stage of ADMIN_ONLY_STAGES)
          if (stage in s) return { allow: false, reason: `${stage} is restricted to connection admins` }
      // Users' credentials and roles' privileges (H1); every database's users and roles, and their
      // authentication restrictions (security audit 2026-10-16).
      if (
        (lower === 'usersinfo' || lower === 'rolesinfo') &&
        (cmd.body.showCredentials ||
          cmd.body.showPrivileges ||
          cmd.body.showAuthenticationRestrictions ||
          cmd.body.forAllDBs ||
          (isObject(cmd.body[cmd.name]) && (cmd.body[cmd.name] as Record<string, unknown>).forAllDBs))
      )
        return { allow: false, reason: 'credentials and privileges are restricted to connection admins' }
      // The privileges of the connection's MongoDB user (security audit 2026-10-16).
      if (lower === 'connectionstatus' && cmd.body.showPrivileges)
        return { allow: false, reason: 'the MongoDB user’s privileges are restricted to connection admins' }
      // Writes elsewhere: another database of the server's own, or a system collection (M5).
      const writes: Named[] = [...pipelineWritesTo(pipeline)]
      if (lower === 'mapreduce' && typeof cmd.body.out === 'string') writes.push({ coll: cmd.body.out })
      if (lower === 'mapreduce' && isObject(cmd.body.out)) {
        const out = cmd.body.out
        const into = [out.replace, out.merge, out.reduce].find((v) => typeof v === 'string') as
          string | undefined
        writes.push({ coll: into ?? '', ...(typeof out.db === 'string' ? { db: out.db } : {}) })
      }
      for (const w of writes)
        if ((w.db && SYSTEM_DATABASES.has(w.db)) || isSystemCollection(w.coll))
          return {
            allow: false,
            reason: `writing to ${w.db ?? cmd.db}.${w.coll} is restricted to connection admins`,
          }
      if (coll && isSystemCollection(coll) && isWrite(cmd.name, cmd.body))
        return { allow: false, reason: `writing to ${cmd.db}.${coll} is restricted to connection admins` }
      // The profiler records every client's queries: reading its level only (M5).
      if (
        lower === 'profile' &&
        (cmd.body.profile !== -1 || Object.keys(cmd.body).some((k) => !PROFILE_READ_FIELDS.has(k)))
      )
        return { allow: false, reason: 'changing the profiler is restricted to connection admins' }
      // No writing to the server's own databases.
      // renameCollection and bulkWrite run on admin and name what they write: judged by those names,
      // so an editor may rename within their database and bulk-write their collections (review M4).
      if (NAMESPACE_WRITES.has(lower)) {
        const names =
          lower === 'renamecollection'
            ? [wholeNs(cmd.body.renameCollection), wholeNs(cmd.body.to)]
            : (Array.isArray(cmd.body.nsInfo) ? cmd.body.nsInfo : []).map((i) =>
                wholeNs(isObject(i) ? i.ns : undefined),
              )
        for (const n of names)
          if (
            !n ||
            SYSTEM_DATABASES.has(n.db) ||
            isSystemCollection(n.coll) ||
            CREDENTIAL_COLLECTIONS.has(n.coll) ||
            isEncryptionNamespace(n.db, n.coll)
          )
            return {
              allow: false,
              reason: `${cmd.name} on ${n ? `${n.db}.${n.coll}` : 'an unnamed namespace'} is restricted to connection admins`,
            }
        return { allow: true }
      }
      if (SYSTEM_DATABASES.has(cmd.db) && isWrite(cmd.name, cmd.body)) {
        return { allow: false, reason: `writing to ${cmd.db} is restricted to connection admins` }
      }
      // W8 re-review: the database holding a key vault takes every data key with it.
      if (lower === 'dropdatabase' && (SYSTEM_DATABASES.has(cmd.db) || hostsKeyVault(cmd.db))) {
        return { allow: false, reason: `dropping ${cmd.db} is restricted to connection admins` }
      }
    }

    return { allow: true }
  }
}
