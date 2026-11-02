import type { FastifyRequest } from 'fastify'
import type { Document, MongoClient } from 'mongodb'
import { serverLevel, type ServerLevel } from '../backup/series'
import {
  formatRule,
  PersonalRuleSchema,
  PersonalRulesBodySchema,
  type CollectionCopyRequest,
  type CopyPath,
  type CopyPlan,
  type Deployment,
  type ExportSource,
  type PersonalRule,
} from '@mongo-manager/shared'
import { AppError, Errors } from '../errors'
import { asConnectionFailure, clientFor, withMongo } from '../data/mongo-errors'
import { personOf } from '../connections/access'
import { isCsfleCollection } from '../encryption/fields'
import { gateDepsFor, viewAwareMasker } from '../masking/restricted'
import { maskerForPrincipal } from '../masking/request'
import { compileRules, nsMaskerFrom, type Masker, type Pattern } from '../masking/match'
import type { ExportPlan } from './export-job'
import { isWholeSource, sourcePlan } from './source-plan'
import { assertCopySource, assertCopyTarget, copyNeeds, planHash, resolveSide } from './copy-access'
import {
  createOptions,
  indexPlan,
  uniqueOverMask,
  viewOrder,
  type IndexPlan,
  type SourceCollection,
  type ViewDef,
} from './collection-spec'
import { compareDeployments, deploymentOf } from './same-deployment'
import { bucketRuled, bucketWriteRuled, isFileContents } from '../masking/gridfs'
import { viewMasked, withoutMaskedIndexes, withoutMaskedValidator } from './masked-definitions'
import { isOrderRefusal } from '../masking/gate'
import { mapLimited } from '../backup/concurrency'

/** The copy request's settings: mode, keys and switches (a collection copy's, without source and target). */
export type CopyOptions = Omit<CollectionCopyRequest, 'source' | 'target'>

export interface PrepareInput {
  db: string
  /** [source collection, target collection] pairs, in order. */
  pairs: Array<[string, string]>
  views: boolean
  target: { connectionId: string; db: string }
  options: CopyOptions
  /** A collection copy's source; null for a database copy (each collection whole). */
  source: ExportSource | null
  /** A database copy's chosen views; null: every view (when `views` is on). */
  viewNames?: string[] | null
  /**
   * A live sync's initial copy: a pair into a time series is a skip it refuses with its own reason,
   * never the copy's 409 (a sync cannot "use inserts only"; final review, M-1).
   */
  seriesAsSkip?: boolean
}

/** A masked database copy's reads planned at once (eighteenth review, Minor 9). */
const READS_AT_ONCE = 8

/** A name as a refusal says it: at most 200 characters, cut with an ellipsis. */
export const shownName = (name: string) => (name.length > 200 ? `${name.slice(0, 199)}…` : name)

export interface CopyPair {
  source: string
  target: string
  info: SourceCollection
  exists: boolean
  count: number | null
  sharded: boolean
  path: CopyPath
  /** How to create the target, why it is skipped, or null when nothing is created. */
  create: { options: Document } | { skip: string } | null
  /** The target's kind where it exists (a time series, a collection), in the plan's hash. */
  targetType: string | null
  indexes: IndexPlan | null
  /** Paths written as "***" (a restricted source, or an anonymous copy); null: none. */
  mask: Pattern[] | null
  /** Source rules the target lacks, in target names. */
  missing: PersonalRule[]
  fullSort: boolean
  /** W4.3: the source collection's estimated documents and data size. */
  sourceCount: number | null
  sourceBytes: number | null
  /** Security audit 2026-10-16: definitions a masked copy leaves out (they hold masked values). */
  validatorLeftOut: boolean
  indexesLeftOut: string[]
  /** W8: a Queryable Encryption source (refused) or a CSFLE one (copied as stored). */
  encryption: 'queryable' | 'ciphertext' | null
  /**
   * Seventeenth review of explain masking (I1-b): a masked database copy's read of this collection,
   * in the gate's order (the target's insertion order is the read's); null where the copy has a
   * query of its own, or nothing is hidden.
   */
  read: ExportPlan | null
}

/**
 * W8 (completion): a Queryable Encryption collection's values are tied to its encryption
 * metadata (the enxcol_ collections and the key vault): a copy is refused, said by its reason, never
 * skipped in silence. A CSFLE collection is copied as stored — ciphertext, never decrypted (a copy
 * reads with the client that does not decrypt), readable only with the source's keys.
 */
export function copyEncryption(info: Pick<SourceCollection, 'options'>): 'queryable' | 'ciphertext' | null {
  if (info.options?.encryptedFields) return 'queryable'
  return isCsfleCollection(info.options) ? 'ciphertext' : null
}

export function encryptionRefusals(pairs: Array<Pick<CopyPair, 'encryption'>>): string[] {
  return pairs.some((p) => p.encryption === 'queryable') ? ['encrypted_collection'] : []
}

export interface Prepared {
  plan: CopyPlan
  pairs: CopyPair[]
  views: ViewDef[]
  sourcePlan: ExportPlan | null
  sourceClient: MongoClient
  targetClient: MongoClient
  sourceMasker: Masker | null
  targetMasker: Masker | null
  versions: { source: number; target: number }
}

/** Options a $out copy cannot reproduce: such a collection goes through the stream. */
const SHAPE_KEYS = ['capped', 'timeseries', 'clusteredIndex', 'collation', 'changeStreamPreAndPostImages']

async function listInfo(client: MongoClient, db: string): Promise<SourceCollection[]> {
  const infos = await withMongo(() => client.db(db).listCollections({}, { nameOnly: false }).toArray())
  return infos.map((i) => ({
    name: i.name,
    type: String(i.type ?? 'collection'),
    options: (i.options ?? {}) as Document,
  }))
}

/** W4 review (minor): how many source sizes a plan reads at once. */
const SIZES_AT_ONCE = 8

/**
 * W4 review (minor): the sizes of a plan's source collections, read a few at a time (a plan of many
 * collections is asked again as a target is typed), in the order given.
 */
export async function sourceSizes(
  client: MongoClient,
  db: string,
  colls: ReadonlyArray<readonly [name: string, type: string]>,
): Promise<Array<{ count: number | null; bytes: number | null }>> {
  const out: Array<{ count: number | null; bytes: number | null }> = new Array(colls.length)
  let next = 0
  const worker = async () => {
    while (next < colls.length) {
      const i = next++
      const [name, type] = colls[i]!
      out[i] = await sourceSize(client, db, name, type)
    }
  }
  await Promise.all(Array.from({ length: Math.min(SIZES_AT_ONCE, colls.length) }, worker))
  return out
}

/**
 * W4.3: a source collection's estimated documents and data size — $collStats where the user may run
 * it, else the estimated count alone. Never a failure of the plan: an answer MongoDB refuses is null.
 */
export async function sourceSize(
  client: MongoClient,
  db: string,
  coll: string,
  type: string,
): Promise<{ count: number | null; bytes: number | null }> {
  if (type !== 'collection' && type !== 'timeseries') return { count: null, bytes: null }
  const c = client.db(db).collection(coll)
  try {
    // A sharded collection answers once per shard: the sums are the collection's.
    const shards = await c
      .aggregate<{ storageStats?: { count?: unknown; size?: unknown } }>(
        [{ $collStats: { storageStats: {} } }],
        { maxTimeMS: 5_000, comment: 'mm-copy-plan' },
      )
      .toArray()
    const count = shards.reduce((n, s) => n + Number(s.storageStats?.count), 0)
    const bytes = shards.reduce((n, s) => n + Number(s.storageStats?.size), 0)
    if (shards.length && Number.isFinite(count) && Number.isFinite(bytes)) return { count, bytes }
  } catch {
    // No collStats right: the estimated count is enough.
  }
  try {
    return {
      count: await c.estimatedDocumentCount({ maxTimeMS: 5_000, comment: 'mm-copy-plan' }),
      bytes: null,
    }
  } catch {
    return { count: null, bytes: null }
  }
}

async function isSharded(client: MongoClient, ns: string, mongos: boolean): Promise<boolean> {
  if (!mongos) return false
  try {
    return (
      (await client
        .db('config')
        .collection('collections')
        .findOne({ _id: ns as never })) !== null
    )
  } catch {
    return false
  }
}

/**
 * Spec §7.3 (final review I7): how a pair's target is created — from the source's options when it is
 * new or replaced, or not at all — and an encrypted source is skipped whatever the target is.
 */
export function decideCreate(
  info: SourceCollection,
  exists: boolean,
  mode: CopyOptions['mode'],
  want: { options: boolean; validator: boolean },
  allowServerJs: boolean,
  /** Review of db45c424: the target's feature level (null: unknown). */
  target: ServerLevel | null = null,
): { options: Document } | { skip: string } | null {
  if (info.options?.encryptedFields)
    return {
      skip: 'A Queryable Encryption collection cannot be copied: its values are tied to the source’s encryption metadata. Leave it out of the copy',
    }
  if (info.type === 'view' || (exists && mode !== 'replace')) return null
  return createOptions(info, want, allowServerJs, target)
}

/**
 * Phase 3d-2 spec §3.1, §4, §5, §7: everything a copy needs to know before it starts — both sides'
 * access, the source plan through the gate, each pair's target state and path, the masks, the rules
 * the target lacks, and the refusals — with the hash of what the user will review.
 */
export async function prepareCopy(request: FastifyRequest, input: PrepareInput): Promise<Prepared> {
  const { ctx } = request.server
  const principal = request.principal!
  const o = input.options
  assertCopyTarget(input.target.db)
  for (const [, t] of input.pairs) assertCopyTarget(input.target.db, t)
  // Security review C1: nor read from them, whoever copies (a key vault is key material).
  for (const [s] of input.pairs) assertCopySource(input.db, s)
  // Read access first (enough to describe the target); the write needs are checked below.
  resolveSide(ctx, principal, input.target.connectionId, ['documents:read'])
  const sourceId = request.connection!.id
  const sourceClient = await clientFor(request)
  // W7: the caller's own sign-in on the target (a per-person OIDC connection in team mode).
  const targetClient = await ctx.manager
    .getClient(input.target.connectionId, { user: personOf(principal) })
    .catch(asConnectionFailure)
  const sourceMasker = maskerForPrincipal(ctx, principal, sourceId)
  const targetMasker = maskerForPrincipal(ctx, principal, input.target.connectionId)
  const srcRules = ctx.personalFields.get(sourceId)
  const dstRules = ctx.personalFields.get(input.target.connectionId)
  const sameConnection = sourceId === input.target.connectionId
  const [sd, td] = await withMongo(() =>
    Promise.all([deploymentOf(sourceClient), deploymentOf(targetClient)]),
  )
  const deployment: Deployment = sameConnection ? 'same' : compareDeployments(sd, td)

  // Final review C1, I6: what the copied documents hold that is personal comes from the 3c gate's
  // output (views resolved, $lookup and moved fields followed), never from the namespace name alone.
  // The plan itself is guarded for a restricted caller (their masker) and for an anonymous copy (all
  // the source's rules); an unmasked copy reads ungated and only probes the gate for the warning.
  const allRules = compileRules(srcRules.rules)
  const ruleGate = srcRules.rules.length ? gateDepsFor(allRules, sourceClient) : null
  const planGate = sourceMasker ? gateDepsFor(sourceMasker, sourceClient) : o.anonymous ? ruleGate : null
  const first = input.pairs[0]![0]
  const plan = input.source ? await sourcePlan(request, input.db, first, input.source, planGate) : null
  /** Personal paths of the copied documents; `uncertain` when the gate could not follow the source. */
  const personalOf = async (s: string): Promise<{ patterns: Pattern[]; uncertain: boolean }> => {
    if (!ruleGate) return { patterns: [], uncertain: false }
    if (input.source && planGate) return { patterns: [...(plan!.output?.patterns ?? [])], uncertain: false }
    if (input.source)
      try {
        const probe = await sourcePlan(request, input.db, s, input.source, ruleGate)
        return { patterns: [...(probe.output?.patterns ?? [])], uncertain: false }
      } catch (e) {
        if (!(e instanceof AppError) || e.statusCode !== 403) throw e
        // In doubt: what the namespace (through its views) holds, and the user must confirm.
        const masker = await viewAwareMasker(allRules, ruleGate, [[input.db, s]])
        return { patterns: [...masker.forNs(input.db, s).patterns], uncertain: true }
      }
    // A database copy reads real collections whole: their own rules.
    return { patterns: [...allRules.forNs(input.db, s).patterns], uncertain: false }
  }

  const sources = await listInfo(sourceClient, input.db)
  const targets = await listInfo(targetClient, input.target.db)
  // Review of db45c424: what the target takes is set by its feature level (its FCV).
  const level = await serverLevel(targetClient)
  // Security audit 2026-10-16 (Important 3): a masked or anonymous copy leaves out the definitions
  // that hold values masking would change, as a masked backup does; views masked against what they read.
  const definitionMasker =
    (sourceMasker ?? (o.anonymous && allRules.anyRules ? allRules : null)) && planGate
      ? await withMongo(() =>
          viewAwareMasker(sourceMasker ?? allRules, planGate, [
            ...input.pairs.map(([s]) => [input.db, s] as const),
            ...(input.views
              ? sources.filter((i) => i.type === 'view').map((i) => [input.db, i.name] as const)
              : []),
          ]),
        )
      : null
  const dstMasker = compileRules(dstRules.rules)
  const pairs: CopyPair[] = []
  // W4 review (minor): read at once, a few at a time, before the pairs are looked at one by one.
  // Eighteenth review (Minor 9): a masked database copy's reads, in the gate's order, planned a few
  // at a time, each with its own lookups; an order refusal is kept as such (seventeenth review, I1-b).
  const masked = sourceMasker !== null || (o.anonymous && allRules.anyRules)
  const reads =
    !input.source && masked
      ? await mapLimited(input.pairs, READS_AT_ONCE, async ([s]) => {
          try {
            return await sourcePlan(
              request,
              input.db,
              s,
              { kind: 'query', filter: {}, skip: 0 },
              gateDepsFor(sourceMasker ?? allRules, sourceClient),
            )
          } catch (e) {
            // Any other refusal stands only where the read is needed (a bucket left out needs none).
            return isOrderRefusal(e) ? ('refused' as const) : { failed: e }
          }
        })
      : []
  const sizes = await sourceSizes(
    sourceClient,
    input.db,
    input.pairs.map(([s]) => [s, sources.find((i) => i.name === s)?.type ?? 'missing'] as const),
  )
  let createsCollections = false
  // Final review of the masking side channels (nit): the sources the gate could not follow; only a
  // pair written asks for a confirmation.
  const unsure = new Set<string>()
  for (const [index, [s, t]] of input.pairs.entries()) {
    const info = sources.find((i) => i.name === s)
    if (!info) throw Errors.notFound(`Collection ${s} not found`)
    const existing = targets.find((i) => i.name === t)
    if (existing?.type === 'view')
      throw Errors.conflict(`The target ${shownName(t)} is a view`, {
        reason: 'target_is_view',
        collection: shownName(t),
      })
    const exists = existing !== undefined
    const count = exists
      ? await withMongo(() => targetClient.db(input.target.db).collection(t).estimatedDocumentCount())
      : null
    const sharded = await isSharded(targetClient, `${input.target.db}.${t}`, td.kind === 'mongos')
    const size = sizes[index]!
    const personal = await personalOf(s)
    // Review of the rule scope (M2): a ruled bucket's chunks are personal data whole — its contents.
    if (
      isFileContents(s) &&
      bucketRuled(allRules, input.db, s) &&
      !nsMaskerFrom(personal.patterns).matches(['data'])
    )
      personal.patterns.push(['data'])
    if (personal.uncertain) unsure.add(s)
    const mask: Pattern[] | null =
      (sourceMasker !== null || o.anonymous) && personal.patterns.length ? personal.patterns : null
    // Final review C2: masking _id would make every document "***" — and tell hidden ids apart.
    // Security review 2026-10-13 round 2 (I2): GridFS file contents are denied where personal fields
    // are hidden, and a masked or anonymous copy cannot carry them; the bucket is left out whole. So
    // for a caller restricted on the target, whose gate refuses a bucket's chunks there: its files
    // are not copied without them (review of the agent's gate, I-1).
    // User report 2026-10-27: where a rule reaches the bucket (the source's), or what it is written
    // into (the target's).
    let create =
      (sourceMasker !== null || o.anonymous) && bucketRuled(allRules, input.db, s)
        ? { skip: 'GridFS file contents cannot be masked; the bucket is not copied' }
        : bucketWriteRuled(targetMasker, s, input.target.db, t)
          ? {
              skip: "GridFS file contents cannot be checked against the target's rules; the bucket is not copied",
            }
          : decideCreate(
              info,
              exists,
              o.mode,
              { options: o.options, validator: o.validator },
              ctx.config.allowServerJs,
              level,
            )
    // Final review of explain masking (Minors 1, 2): MongoDB changes no single document of a time
    // series ($merge into one fails whole, an upsert or merge record by record): a copy by key into
    // one, there or to be created, is refused before anything is made; a database copy leaves it out,
    // before its masked read is planned (M-2).
    const intoSeries =
      existing?.type === 'timeseries' ||
      (!exists && create !== null && 'options' in create && create.options.timeseries !== undefined)
    // Nor can a replace copy a series: it fills a staging collection and renames it into place, and
    // MongoDB renames no time series, nor anything over one ("cannot rename view", "a view already
    // exists with that name": measured on 8.2), as a restore refuses (final review, I-1).
    // Final review (M-1): only where the staged copy would be one (the source's options kept); with
    // options off it is a plain collection, renamed as any is.
    const stagedSeries = create !== null && 'options' in create && create.options.timeseries !== undefined
    if (
      o.mode === 'replace' &&
      (stagedSeries || existing?.type === 'timeseries') &&
      !(create && 'skip' in create)
    ) {
      // Final review of the masking side channels (M-4): what to do differs, the target or the source.
      const into = existing?.type === 'timeseries'
      if (input.source && !input.seriesAsSkip)
        throw into
          ? Errors.conflict(
              `${shownName(t)} is a time series: a replace cannot swap it out; copy into it with inserts, or into another collection`,
              { reason: 'replace_into_timeseries', collection: shownName(t) },
            )
          : Errors.conflict(
              `${shownName(s)} is a time series: a replace cannot copy it; copy it with inserts into a new or empty collection, or without its time-series options`,
              { reason: 'replace_timeseries', collection: shownName(s) },
            )
      create = {
        skip: into
          ? 'A replace cannot swap a time series out (MongoDB renames nothing over one): copy into it with inserts, or into another collection'
          : 'A replace cannot copy a time series (MongoDB renames none): copy it with inserts into a new or empty collection, or without its time-series options',
      }
    }
    const refusedMode = o.mode === 'upsert' || o.mode === 'merge'
    if (refusedMode && intoSeries && !(create && 'skip' in create)) {
      if (input.source && !input.seriesAsSkip)
        throw Errors.conflict(`${shownName(t)} is a time series: a copy can only insert into it`, {
          reason: 'target_timeseries',
          collection: shownName(t),
        })
      create = { skip: 'A time series takes only inserts: copy it with inserts' }
    }
    // Seventeenth review (I1-b): a masked database copy reads each collection in the gate's order,
    // with its own lookups; one stored in the order of a hidden value is left out.
    let read: ExportPlan | null = null
    if (mask && !(create && 'skip' in create)) {
      const planned = reads[index]
      if (planned === 'refused')
        create = { skip: 'Stored in the order of a hidden value; it is left out of a masked copy' }
      else if (planned && 'failed' in planned) throw planned.failed
      // A masked pair of a database copy is always planned (nineteenth review, Minor 10): none
      // would read unordered. A query's copy reads by its own plan.
      else if (!planned) {
        if (!input.source) throw new Error(`No read was planned for ${s}`)
      } else read = planned
    }
    let validatorLeftOut = false
    if (definitionMasker && create && 'options' in create) {
      const kept = withoutMaskedValidator(create.options, input.db, s, definitionMasker)
      create = { options: kept.options }
      validatorLeftOut = kept.left
    }
    if (create && 'options' in create) createsCollections = true
    const personalUnique = (key: Document, partial: unknown) =>
      uniqueOverMask({ key, unique: true, partialFilterExpression: partial }, mask)
    const listed =
      o.indexes && info.type !== 'view'
        ? indexPlan(
            await withMongo(() =>
              sourceClient
                .db(input.db)
                .collection(s)
                .listIndexes({ comment: 'mm-copy-plan' } as never)
                .toArray(),
            ),
            personalUnique,
            level,
          )
        : null
    const kept =
      listed && definitionMasker ? withoutMaskedIndexes(listed, input.db, s, definitionMasker) : null
    const indexes = kept?.plan ?? listed
    // Final review M1: a time series or clustered collection's own TTL deletes target documents too.
    const collectionTtl = create && 'options' in create && create.options.expireAfterSeconds !== undefined
    const whole = input.source === null || isWholeSource(input.source)
    const shape = SHAPE_KEYS.some((k) => k in info.options)
    const shortcut =
      sameConnection &&
      mask === null &&
      targetMasker === null &&
      whole &&
      info.type === 'collection' &&
      !shape &&
      !sharded &&
      ((o.mode === 'insert' && !exists) ||
        o.mode === 'replace' ||
        // "Update only" is honoured and counted record by record: $merge would insert what matches
        // nothing (review of the data fixes, C1).
        (o.mode === 'upsert' && !o.updateOnly && o.keys.length === 1 && o.keys[0] === '_id'))
    const covered = dstMasker.forNs(input.target.db, t)
    const missing = mask
      ? []
      : personal.patterns
          .filter((path) => !covered.covers(path))
          .map((path) => ({ db: input.target.db, coll: t, field: path.join('.') }))
    // Final review M11: a non-simple default collation on either side forces a full sort.
    const collated = (c: unknown) =>
      c !== undefined && (c as { locale?: unknown } | null)?.locale !== 'simple'
    pairs.push({
      source: s,
      target: t,
      info,
      exists,
      targetType: existing?.type ?? null,
      count,
      sharded,
      path: shortcut ? 'shortcut' : 'stream',
      create,
      indexes:
        indexes && collectionTtl ? { ...indexes, ttl: [...indexes.ttl, `${s} (collection)`] } : indexes,
      mask,
      missing,
      fullSort: collated(info.options.collation) || collated(existing?.options.collation),
      sourceCount: size.count,
      // Twelfth review of explain masking (I3): no size of what rules hide from the caller.
      sourceBytes: sourceMasker !== null && mask !== null ? null : size.bytes,
      validatorLeftOut,
      read,
      indexesLeftOut: kept?.left ?? [],
      encryption: copyEncryption(info),
    })
    if (!indexes && collectionTtl)
      pairs.at(-1)!.indexes = { build: [], skipped: [], ttl: [`${s} (collection)`] }
  }

  // Final review M4: views can be chosen one by one (a database copy's `viewNames`).
  const chosenViews = (input.viewNames ?? null) === null ? null : new Set(input.viewNames)
  const allViews = sources
    .filter((i) => i.type === 'view' && !i.name.startsWith('system.'))
    .filter((i) => chosenViews === null || chosenViews.has(i.name))
  if (chosenViews)
    for (const v of chosenViews)
      if (!allViews.some((i) => i.name === v)) throw Errors.notFound(`View ${v} not found`)
  const ordered: ViewDef[] = input.views
    ? viewOrder(
        allViews.map((i) => ({
          name: i.name,
          viewOn: String(i.options.viewOn),
          pipeline: (i.options.pipeline ?? []) as Document[],
        })),
      ).ordered
    : []
  // Security audit 2026-10-16 (Important 3): a view is its pipeline; one masking would change is left out.
  const viewsLeftOut = definitionMasker
    ? ordered.filter((v) => viewMasked(v, input.db, definitionMasker)).map((v) => v.name)
    : []
  const views = ordered.filter((v) => !viewsLeftOut.includes(v.name))

  // The target's write needs, now that we know what the copy creates (views too, final review M8).
  const target = resolveSide(
    ctx,
    principal,
    input.target.connectionId,
    copyNeeds({ mode: o.mode, indexes: o.indexes, createsCollections, views: views.length > 0 }),
  )

  const refusals = new Set<string>()
  // Final review of explain masking (nit): a pair left out writes nothing: none of its refusals.
  const written = pairs.filter((p) => !(p.create && 'skip' in p.create))
  const uncertain = written.some((p) => unsure.has(p.source))
  for (const p of written) {
    const sameNs = input.db === input.target.db && p.source === p.target
    if (sameNs && deployment === 'same') refusals.add('same_namespace')
    if (sameNs && deployment === 'unknown' && o.mode === 'replace') refusals.add('replace_uncertain')
    if (o.mode === 'replace' && p.sharded) refusals.add('sharded_replace')
    if (o.mode === 'replace' && (targetMasker?.forNs(input.target.db, p.target).any ?? false))
      refusals.add('personal_replace')
    if (p.indexes?.ttl.length && !o.confirmTtl) refusals.add('confirm_ttl')
  }
  // Final review of explain masking (M-2): a pair left out writes no _id.
  if (
    written.some(
      (p) => p.mask && (nsMaskerFrom(p.mask).matches(['_id']) || nsMaskerFrom(p.mask).under(['_id'])),
    )
  )
    refusals.add('personal_id')
  for (const r of encryptionRefusals(pairs)) refusals.add(r)
  const missing = written.flatMap((p) => p.missing)
  const addable = missing.every((r) => PersonalRuleSchema.safeParse(r).success)
  const mayAddRules = target.role === 'admin' && addable && !uncertain
  if ((missing.length || uncertain) && !o.confirmPersonal && !o.addRulesToTarget)
    refusals.add('confirm_personal')
  if (o.addRulesToTarget && (missing.length || uncertain) && !mayAddRules) refusals.add('add_rules_forbidden')
  // Final review M3: the target's rules stay within the limit the rules page can save.
  if (o.addRulesToTarget && mayAddRules) {
    const merged = [
      ...dstRules.rules,
      ...missing.filter((r) => !dstRules.rules.some((d) => formatRule(d) === formatRule(r))),
    ]
    if (!PersonalRulesBodySchema.safeParse({ rules: merged }).success) refusals.add('too_many_rules')
  }

  const versions = { source: srcRules.version, target: dstRules.version }
  const { planHash: _hash, dryRun: _dryRun, ...settings } = o
  const copyPlan: CopyPlan = {
    planHash: planHash({
      request: {
        ...settings,
        source: input.source,
        pairs: input.pairs,
        target: input.target,
        views: input.views,
        viewNames: input.viewNames ?? null,
      },
      versions,
      deployment,
      sources: pairs.map((p) => [p.source, p.info.type, p.info.options]),
      // Final review of explain masking (M-3): a target recreated as another kind is another plan.
      targets: pairs.map((p) => [p.target, p.exists, p.sharded, p.targetType]),
      // Final review M2: what the user confirmed includes the indexes and their TTLs.
      indexes: pairs.map((p) => [p.indexes?.build.map((b) => b.name) ?? [], p.indexes?.ttl ?? []]),
      views: views.map((v) => v.name),
    }),
    collections: pairs.map((p) => ({
      source: p.source,
      target: p.target,
      exists: p.exists,
      count: p.count,
      path: p.path,
      sharded: p.sharded,
      ttlIndexes: p.indexes?.ttl ?? [],
      fullSort: p.fullSort,
      sourceCount: p.sourceCount,
      sourceBytes: p.sourceBytes,
      ...(p.create && 'skip' in p.create ? { skipped: p.create.skip } : {}),
      ...(p.validatorLeftOut ? { validatorLeftOut: true as const } : {}),
      ...(p.indexesLeftOut.length ? { indexesLeftOut: p.indexesLeftOut } : {}),
      ...(p.encryption ? { encrypted: p.encryption } : {}),
    })),
    views: views.map((v) => v.name),
    ...(viewsLeftOut.length ? { viewsLeftOut } : {}),
    masked: sourceMasker !== null && pairs.some((p) => p.mask !== null),
    missingRules: [...new Set(missing.map(formatRule))],
    mayAddRules,
    deployment,
    refusals: [...refusals],
  }
  return {
    plan: copyPlan,
    pairs,
    views,
    sourcePlan: plan,
    sourceClient,
    targetClient,
    sourceMasker,
    targetMasker,
    versions,
  }
}
