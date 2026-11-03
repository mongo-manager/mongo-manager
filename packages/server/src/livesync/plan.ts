import type { FastifyRequest } from 'fastify'
import type { Document, MongoClient } from 'mongodb'
import {
  LIVE_SYNC_LIMITS,
  type LiveSyncPlan,
  type LiveSyncRequest,
  type LiveSyncWarning,
  type Permission,
} from '@mongo-manager/shared'
import { Errors } from '../errors'
import { asConnectionFailure, connectionAppError, withMongo } from '../data/mongo-errors'
import { ConnectionError, OIDC_PER_PERSON } from '../connections/errors'
import { topologyOf } from '../connections/manager'
import { SYSTEM_DATABASES, assertNotDrillScratch, isEncryptionNamespace } from '../connections/access'
import { prepareCopy, type CopyOptions, type PrepareInput, type Prepared } from '../transfer/copy-plan'
import { planHash, resolveSide } from '../transfer/copy-access'
import { compareDeployments, deploymentOf, type DeploymentId } from '../transfer/same-deployment'
import { ownerOf } from '../transfer/files'
import { fromClient } from '../data/ejson-io'
import { compileRules, type NsMasker } from '../masking/match'
import { filterPaths } from '../masking/gate/filter'
import { isDocument } from '../masking/gate/values'
import { tsText, type LiveSyncOptions, type LiveSyncRecord, type LiveSyncStamps } from './repo'

/** Spec §3.1: a sync deletes, creates collections and builds indexes on its target, as a job. */
export const TARGET_NEEDS: Permission[] = ['documents:write', 'databases:write', 'indexes:write', 'jobs:run']

export interface SyncNode {
  deployment: DeploymentId
  db: string
  /** null: the whole database. */
  coll: string | null
}
export interface SyncEdge {
  source: SyncNode
  target: SyncNode
}

/** A review keeps the collections a sync already follows, and those that joined since. */
const mergePairs = (old: Array<[string, string]>, now: Array<[string, string]>): Array<[string, string]> => [
  ...old,
  ...now.filter(([s]) => !old.some(([o]) => o === s)),
]

/**
 * Final review I6: deployments are compared as deployments (an id where readable, else the set's
 * name and members); one that cannot be told apart counts as the same (as plan ruling 4).
 */
const overlaps = (x: SyncNode, y: SyncNode) =>
  compareDeployments(x.deployment, y.deployment) !== 'different' &&
  x.db === y.db &&
  (x.coll === null || y.coll === null || x.coll === y.coll)

/**
 * Spec §3.4: a new sync source → target closes a loop when, following the running syncs from its
 * target, one comes back onto its source (A→B while B→A, or longer chains).
 */
export function closesLoop(edges: SyncEdge[], source: SyncNode, target: SyncNode): boolean {
  const seen = new Set<number>()
  const queue: SyncNode[] = [target]
  while (queue.length) {
    const at = queue.shift()!
    if (overlaps(at, source)) return true
    edges.forEach((e, i) => {
      if (!seen.has(i) && overlaps(e.source, at)) {
        seen.add(i)
        queue.push(e.target)
      }
    })
  }
  return false
}

/** Spec §1.3: a copy expected to take more than half the source's oplog window asks for a confirmation. */
export function oplogWarning(
  seconds: number | null,
  windowSeconds: number | null,
): 'oplog_window' | 'oplog_unknown' | null {
  if (seconds === null) return null
  if (windowSeconds === null) return 'oplog_unknown'
  return seconds > windowSeconds / 2 ? 'oplog_window' : null
}

const LOGICAL = new Set(['$and', '$or', '$nor'])
/**
 * W4.6: a filter reads a value the masked sync hides — a hidden path, one above it (a sub-document
 * compared whole), or an operator that reads documents in ways a path list cannot show ($expr,
 * $where, $text, $jsonSchema…). Only a namespace with rules is checked.
 */
export function filterReadsMasked(filter: Document, hidden: NsMasker): boolean {
  if (!hidden.any) return false
  const operators = (f: unknown): boolean =>
    isDocument(f) &&
    Object.entries(f).some(([k, v]) =>
      LOGICAL.has(k) ? Array.isArray(v) && v.some(operators) : k.startsWith('$') && k !== '$comment',
    )
  if (operators(filter)) return true
  return filterPaths(filter).some((p) => hidden.matches(p) || hidden.under(p))
}

/** Plan ruling 6: a connection's settings as a hash: an edit that points it elsewhere changes it. */
export const settingsStamp = (settings: unknown): string => planHash(settings)

/** The source's cluster time now ("t.i"): `T0` before a copy, `T1` at a cutover (plan rulings 2, 14). */
export async function operationTime(client: MongoClient): Promise<string> {
  // Final review I2: on the primary, where the copy reads (a connection may prefer secondaries).
  const reply = await withMongo(() => client.db('admin').command({ ping: 1 }, { readPreference: 'primary' }))
  const time = reply.operationTime as { t: number; i: number } | undefined
  if (!time)
    throw Errors.conflict('The source did not say its cluster time', { reason: 'source_not_replica_set' })
  return tsText(time as never)
}

/** Bytes per second an initial copy is expected to move (a conservative streamed copy). */
const COPY_RATE = 20 * 1024 * 1024

/**
 * Spec §1.3: how many seconds of changes the oplog keeps. A full oplog keeps the span it holds; one
 * not full yet will hold its span scaled by how much room is left (at the rate it fills now).
 */
export function oplogWindowEstimate(
  span: number | null,
  size: number | null,
  max: number | null,
): number | null {
  if (!span || span <= 0) return null
  if (!size || !max || size >= max) return span
  return Math.round((span * max) / size)
}

async function oplogWindow(client: MongoClient): Promise<number | null> {
  try {
    const oplog = client.db('local').collection('oplog.rs')
    const [first] = await oplog.find({}, { sort: { $natural: 1 }, limit: 1, projection: { ts: 1 } }).toArray()
    const [last] = await oplog.find({}, { sort: { $natural: -1 }, limit: 1, projection: { ts: 1 } }).toArray()
    if (!first?.ts || !last?.ts) return null
    const span = (last.ts as { t: number }).t - (first.ts as { t: number }).t
    const [stats] = await oplog
      .aggregate<Document>([{ $collStats: { storageStats: {} } }])
      .toArray()
      .catch(() => [] as Document[])
    const storage = (stats?.storageStats ?? {}) as { size?: unknown; maxSize?: unknown }
    return oplogWindowEstimate(span, Number(storage.size) || null, Number(storage.maxSize) || null)
  } catch {
    return null
  }
}

async function sourceSize(
  client: MongoClient,
  db: string,
  colls: string[],
): Promise<{ documents: number; bytes: number }> {
  let documents = 0
  let bytes = 0
  for (const c of colls) {
    const [stats] = await withMongo(() =>
      client
        .db(db)
        .collection(c)
        .aggregate<Document>([{ $collStats: { storageStats: {} } }])
        .toArray(),
    ).catch(() => [])
    documents += Number(stats?.storageStats?.count ?? 0)
    bytes += Number(stats?.storageStats?.size ?? 0)
  }
  return { documents, bytes }
}

export interface PlannedSync {
  plan: LiveSyncPlan
  prepared: Prepared
  input: PrepareInput
  options: LiveSyncOptions
  stamps: LiveSyncStamps
  sourceClient: MongoClient
}

/** The source collections a database sync carries: the chosen ones (each must exist), or all. */
async function databasePairs(
  client: MongoClient,
  db: string,
  chosen?: string[],
): Promise<Array<[string, string]>> {
  // System databases never reach here: planLiveSync refuses them first (S1).
  const infos = await withMongo(() => client.db(db).listCollections({}, { nameOnly: true }).toArray())
  const names = infos
    .filter((i) => i.type !== 'view' && !i.name.startsWith('system.') && !isEncryptionNamespace(db, i.name))
    .map((i) => i.name)
  const pick = chosen ?? names
  for (const n of pick) if (!names.includes(n)) throw Errors.notFound(`Collection ${n} not found`)
  if (pick.length > 1000) throw Errors.validation('At most 1000 collections per sync')
  return pick.map((n) => [n, n])
}

/**
 * Phase 3e-2 spec §1.1, §1.3, §3: a new sync's plan — the 3d-2 copy plan for its access, masks and
 * refusals, plus what a live sync adds: a source with change streams, no time series or capped
 * target, no namespace that may be its own source, no loop, an empty target to copy first, the
 * confirmations and the limits.
 */
export async function planLiveSync(
  request: FastifyRequest,
  body: LiveSyncRequest,
  edges: SyncEdge[],
  /** Spec §3.2, S9: the sync under review — no limits (it counts already), its masking kept. */
  existing?: LiveSyncRecord,
  /** Final review m16: the caller's sync this one replaces ("Start again"): it no longer counts. */
  replaces?: LiveSyncRecord,
): Promise<PlannedSync> {
  const { ctx } = request.server
  const principal = request.principal!
  if (body.source.connectionId !== request.connection!.id)
    throw Errors.validation('The source is the connection in the path', { reason: 'source_mismatch' })
  // Spec §1.1, S1: MongoDB's own namespaces are never a source or a target.
  const system = (db: string, coll?: string) =>
    SYSTEM_DATABASES.has(db) || !!coll?.startsWith('system.') || isEncryptionNamespace(db, coll)
  if (system(body.source.db, body.source.coll) || system(body.target.db, body.target.coll))
    throw Errors.forbidden('System namespaces are not synced', { reason: 'system_namespace' })
  // W4 re-review C1: nor a restore drill's scratch database (a scheduled start plans here too).
  assertNotDrillScratch(body.source.db, body.target.db)
  // Sixth review of the open's stop (minor 2): a sync runs on its own, with no person behind it; a
  // side that signs each person in could never open. Refused here, before either is dialled — and
  // the target only once the planner may see it (seventh review, minor 1: 404 otherwise, as for
  // any connection they may not see).
  resolveSide(ctx, principal, body.target.connectionId, ['documents:read'])
  for (const id of [body.source.connectionId, body.target.connectionId])
    if (ctx.manager.perPerson(id)) throw connectionAppError(new ConnectionError('oidc', OIDC_PER_PERSON))
  const sourceClient = await ctx.manager.getClient(body.source.connectionId).catch(asConnectionFailure)
  const pairs: Array<[string, string]> = body.source.coll
    ? [[body.source.coll, body.target.coll!]]
    : await databasePairs(sourceClient, body.source.db, body.source.collections)
  // "From now" copies nothing: no indexes, options or validator are built at the start.
  const copying = body.startMode !== 'from_now'
  const copyOptions: CopyOptions = {
    mode: body.startMode === 'copy' ? 'insert' : body.startMode === 'replace' ? 'replace' : 'upsert',
    keys: ['_id'],
    updateOnly: false,
    onError: body.errorPolicy === 'pause' ? 'stop' : 'continue',
    dryRun: false,
    indexes: copying,
    validator: copying,
    options: copying,
    anonymous: body.anonymous,
    confirmPersonal: body.confirmPersonal,
    addRulesToTarget: body.addRulesToTarget,
    confirmTtl: body.confirmTtl,
  }
  const input: PrepareInput = {
    db: body.source.db,
    pairs,
    views: !body.source.coll && copying,
    target: { connectionId: body.target.connectionId, db: body.target.db },
    options: copyOptions,
    // W4.6: a filtered collection sync copies what its filter matches (the gate checks it as any query).
    source: body.source.coll
      ? body.filter
        ? { kind: 'query', filter: body.filter, skip: 0 }
        : { kind: 'collection' }
      : null,
    seriesAsSkip: true,
  }
  const prepared = await prepareCopy(request, input)
  // More than the copy needs: a sync writes on the target for as long as it runs.
  resolveSide(ctx, principal, body.target.connectionId, TARGET_NEEDS)
  const refusals = new Set(prepared.plan.refusals.filter((r) => r !== 'replace_uncertain'))
  // Final review of the agent's gate (nit): the collections left_out is about, for the wizard.
  const leftOut: string[] = []

  const hello = await withMongo(() => sourceClient.db('admin').command({ hello: 1 }))
  if (topologyOf(hello) === 'standalone') refusals.add('source_not_replica_set')
  const targetInfos = await withMongo(() =>
    prepared.targetClient.db(body.target.db).listCollections({}, { nameOnly: false }).toArray(),
  )
  for (const p of prepared.pairs) {
    if (p.info.options.timeseries) refusals.add('timeseries')
    // Final review I7: a view has no change stream of its own.
    if (p.info.type === 'view') refusals.add('view_source')
    const targetInfo = targetInfos.find((i) => i.name === p.target)
    if (p.info.options.capped || (targetInfo?.options as { capped?: unknown } | undefined)?.capped)
      refusals.add('capped_target')
    // Plan ruling 4: an unknown deployment with the same names may be the source itself.
    if (prepared.plan.deployment === 'unknown' && body.source.db === body.target.db && p.source === p.target)
      refusals.add('same_namespace_uncertain')
    if (prepared.targetMasker?.forNs(body.target.db, p.target).any) refusals.add('personal_target')
    // Security review 2026-10-13 round 2 (I2): a bucket the copy leaves out (its file contents,
    // denied where personal fields are hidden) would still be synced as it changes: refused.
    if (p.create && 'skip' in p.create && /GridFS/.test(p.create.skip)) refusals.add('gridfs_masked')
    // Final review of explain masking (M-5): nor any other pair the copy leaves out (stored in the order
    // of a hidden value, a JavaScript validator…): its target would hold only what changed. (A series
    // and a Queryable Encryption collection have their own.)
    else if (
      p.create &&
      'skip' in p.create &&
      !p.info.options.timeseries &&
      targetInfo?.type !== 'timeseries' &&
      p.encryption !== 'queryable'
    ) {
      refusals.add('left_out')
      leftOut.push(p.source)
    }
    // Final reviews of explain masking (I-1): a time series target takes none of the sync's
    // replacements (MongoDB changes no single document of one), and "replace" cannot rename its copy
    // over one ("a view already exists with that name": measured on 8.2). A series source is refused
    // above.
    if (targetInfo?.type === 'timeseries') refusals.add('timeseries_target')
    if (body.startMode === 'copy' && p.exists && (p.count ?? 0) > 0) refusals.add('target_not_empty')
  }
  const targetName = body.target.coll ?? body.target.db
  if (body.startMode === 'replace' && body.confirmTarget !== targetName) refusals.add('confirm_target')
  if (!body.confirmOverwrite) refusals.add('confirm_overwrite')

  const [sd, td] = await withMongo(() =>
    Promise.all([deploymentOf(sourceClient), deploymentOf(prepared.targetClient)]),
  )
  const deployments = { source: sd, target: td }
  // Final review I10: a review after an edit that points either side at another deployment starts
  // again instead (the place belongs to the old one; the new target lacks what came before).
  if (
    existing &&
    (compareDeployments(existing.stamps.deployments.source, sd) !== 'same' ||
      compareDeployments(existing.stamps.deployments.target, td) !== 'same')
  )
    refusals.add('deployment_changed')
  const node = (deployment: DeploymentId, db: string, coll: string | null): SyncNode => ({
    deployment,
    db,
    coll,
  })
  if (
    closesLoop(
      edges,
      node(deployments.source, body.source.db, body.source.coll ?? null),
      node(deployments.target, body.target.db, body.target.coll ?? null),
    )
  )
    refusals.add('loop')

  const owner = ownerOf(principal)
  if (!ctx.config.liveSync.enabled) refusals.add('turned_off')
  const count = (o?: string) => ctx.liveSync.repo.countActive(o)
  if (!existing) {
    // The sync being replaced stops when this one starts: it does not count against it.
    const freed = replaces && !['completed', 'failed', 'stopped'].includes(replaces.state) ? 1 : 0
    if (count(owner) - freed >= LIVE_SYNC_LIMITS.perUser) refusals.add('limit_user')
    if (count() - freed >= ctx.config.liveSync.maxSyncs) refusals.add('limit_server')
  }

  const size = await sourceSize(
    sourceClient,
    body.source.db,
    pairs.map(([s]) => s),
  )
  const seconds = copying ? Math.ceil(size.bytes / COPY_RATE) : null
  const windowSeconds = copying ? await oplogWindow(sourceClient) : null
  const warnings: LiveSyncWarning[] = ['overwrite']
  const oplog = oplogWarning(seconds, windowSeconds)
  if (oplog) warnings.push(oplog)
  if (oplog === 'oplog_window' && !body.confirmOplog) refusals.add('confirm_oplog')
  if (prepared.plan.missingRules.length && !body.addRulesToTarget) warnings.push('personal_unruled')
  const masked = prepared.sourceMasker !== null || body.anonymous
  // W4.6: a masked sync's filter may not read what it hides (the source evaluates it on raw values).
  if (masked && body.filter && body.source.coll) {
    const hidden = compileRules(ctx.personalFields.get(body.source.connectionId).rules).forNs(
      body.source.db,
      body.source.coll,
    )
    if (filterReadsMasked(fromClient<Document>(body.filter, 'filter'), hidden)) refusals.add('filter_masked')
  }
  if (existing && masked !== existing.options.masked) refusals.add('masking_changed')
  // W4.6: a two-way sync's own conditions (each direction is planned; the route joins both).
  if (body.twoWay) {
    warnings.push('two_way')
    if (!body.source.coll) refusals.add('two_way_collection')
    // Both sides must already hold the same documents: no copy (it would race the other side).
    if (body.startMode !== 'from_now') refusals.add('two_way_from_now')
    // Masked values cannot come back unmasked, nor be compared whole.
    if (masked) refusals.add('two_way_masked')
    if (body.filter) refusals.add('two_way_filter')
    if (prepared.pairs.some((p) => p.sharded)) refusals.add('two_way_sharded')
    if (body.source.coll && body.target.coll) {
      const fields = (connectionId: string, db: string, coll: string) =>
        JSON.stringify(
          compileRules(ctx.personalFields.get(connectionId).rules)
            .forNs(db, coll)
            .patterns.map((p) => p.join('.'))
            .sort(),
        )
      // Values travel both ways: both sides must hold the same personal-field rules.
      if (
        fields(body.source.connectionId, body.source.db, body.source.coll) !==
        fields(body.target.connectionId, body.target.db, body.target.coll)
      )
        refusals.add('two_way_rules')
      const imagesOn = (options: unknown) =>
        (options as { changeStreamPreAndPostImages?: { enabled?: unknown } } | undefined)
          ?.changeStreamPreAndPostImages?.enabled === true
      const sourceInfo = prepared.pairs[0]?.info
      const targetInfo = targetInfos.find((i) => i.name === body.target.coll)
      if (!body.enablePreImages && !(imagesOn(sourceInfo?.options) && imagesOn(targetInfo?.options)))
        refusals.add('pre_images_off')
    }
    if (!body.confirmTwoWay) refusals.add('confirm_two_way')
  }
  if (masked && prepared.pairs.some((p) => (p.indexes?.skipped.length ?? 0) > 0))
    warnings.push('unique_masked')
  if (prepared.pairs.some((p) => (p.indexes?.ttl.length ?? 0) > 0)) warnings.push('ttl')

  const sourceConn = ctx.connections.get(body.source.connectionId)!
  const targetConn = ctx.connections.get(body.target.connectionId)!
  const stamps: LiveSyncStamps = {
    versions: prepared.versions,
    settings: { source: settingsStamp(sourceConn.settings), target: settingsStamp(targetConn.settings) },
    deployments,
  }
  const options: LiveSyncOptions = {
    // A review plans "from now" only to skip the copy: the sync keeps how it started.
    startMode: existing?.options.startMode ?? body.startMode,
    // W4.6: a two-way batch is one transaction: a refused document pauses it (nothing to skip alone).
    errorPolicy: body.twoWay ? 'pause' : body.errorPolicy,
    // Spec §1.1: new collections follow only a database sync of all its collections.
    followNew: body.followNew && !body.source.coll && !body.source.collections,
    ...(existing?.options.ignored ? { ignored: existing.options.ignored } : {}),
    anonymous: body.anonymous,
    masked,
    pairs: existing ? mergePairs(existing.options.pairs, pairs) : pairs,
    ...(body.filter && body.source.coll ? { filter: body.filter } : {}),
  }
  const { planHash: _hash, confirmOverwrite: _o, confirmOplog: _p, confirmTarget: _t, ...settings } = body
  const plan: LiveSyncPlan = {
    planHash: planHash({ copy: prepared.plan.planHash, settings, warnings, deployments }),
    copy: prepared.plan,
    masked,
    warnings,
    refusals: [...refusals],
    ...(leftOut.length ? { leftOut } : {}),
    // Twelfth review of explain masking (I3): what rules hide from the caller has no size here, nor
    // the time its size would take (the oplog warning still weighs it).
    estimate:
      prepared.plan.masked && prepared.sourceMasker !== null
        ? { documents: size.documents, bytes: null, seconds: null }
        : { documents: size.documents, bytes: size.bytes, seconds },
    oplogWindowSeconds: windowSeconds,
  }
  return { plan, prepared, input, options, stamps, sourceClient }
}
