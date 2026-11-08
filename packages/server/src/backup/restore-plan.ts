// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Document, MongoClient } from 'mongodb'
import {
  findServerJs,
  formatRule,
  permissionsFor,
  PersonalRulesBodySchema,
  type ArchiveSummary,
  type PersonalRule,
  type PreflightCheck,
  type RestorePlan,
  type RestoreRequest,
  type Role,
} from '@mongo-manager/shared'
import { Errors } from '../errors'
import { isEncryptionNamespace } from '../connections/access'
import { clientFor, withMongo } from '../data/mongo-errors'
import { maskerForPrincipal } from '../masking/request'
import { nsMaskerFrom, type Masker } from '../masking/match'
import {
  createOptions,
  indexPlan,
  optionsTargetMayRefuse,
  sameBucketing,
  type IndexPlan,
  type ViewDef,
} from '../transfer/collection-spec'
import { missingRules, planHash } from '../transfer/copy-access'
import { compareDeployments, deploymentOf } from '../transfer/same-deployment'
import { ownerOf } from '../transfer/files'
import type { ArchiveEvent } from './archive-reader'
import type { NamespaceMeta } from './archive-writer'
import type { BackupFileRow } from './store'
import { KeyNeeded, openArchive, PasswordNeeded, summarize } from './pipeline'
import { slotKeysFor } from './keys/slot-keys'
import { kitFrom } from './keys/kit'
import { mapLimited } from './concurrency'
import { resolveSource, withPasswordThrottle } from './source'
import { findTools, toolsAvailability, toolSafeName, type FoundTools } from './tools'
import { bucketWriteRuled } from '../masking/gridfs'
import { abortOnGone } from '../http/gone'
import { assertNotDrillScratch } from '../connections/access'
import { knownVersion, rawSeries, serverLevel, serverVersionOf, toolsFindSeries } from './series'

export interface RestorePair {
  from: { db: string; coll: string }
  to: { db: string; coll: string }
  meta: NamespaceMeta
  /** The archive namespace its documents come under (a time series: its buckets). */
  dataFrom: string
  exists: boolean
  documents: number | null
  action: 'create' | 'insert' | 'upsert' | 'replace'
  create: { options: Document } | { skip: string } | null
  indexes: IndexPlan | null
  /**
   * Backup review M8: a replaced target's own indexes, rebuilt on what replaces it when the backup's
   * are not restored (the swap would drop them). Its own, so no new index is asked for.
   */
  kept: IndexPlan | null
  /** Backup review M8: the target's own options are what the replacement is made with. */
  keptOptions?: boolean
  /** Backup review I3: the replaced target is a time series (it cannot be renamed over). */
  seriesTarget?: boolean
  /** Backup review I4: the target's own cap applies (a larger backup would lose documents). */
  capped?: boolean
  /**
   * Backup review I5, M10: what deletes the written documents by age — a date field (as the records
   * hold it), its age limit, and the TTL index's partial filter.
   */
  expiry: ExpiryRule[]
  ttl: string[]
  skipped?: string
  confirmName: boolean
  /** The validator the written collection will enforce (for a dry run's prediction), or null. */
  validator: Document | null
  /** A view's definition with its sources renamed as the mapping renames them. */
  viewDef?: { viewOn: string; pipeline: Document[] }
}

export interface ExpiryRule {
  field: string
  ms: number
  partial?: Document
}

/** Backup review I5, M10: the TTL indexes among these index specifications. */
export function ttlRulesOf(indexes: Document[]): ExpiryRule[] {
  return indexes.flatMap((i) => {
    const fields = Object.keys((i.key ?? {}) as Document)
    const seconds = Number(i.expireAfterSeconds)
    if (fields.length !== 1 || i.expireAfterSeconds === undefined || !Number.isFinite(seconds)) return []
    const partial = i.partialFilterExpression as Document | undefined
    return [{ field: fields[0]!, ms: seconds * 1000, ...(partial ? { partial } : {}) }]
  })
}

/**
 * Backup review I5: a collection's own expiry — a clustered collection's on its _id, a time series'
 * on its buckets' latest time (the records a restore writes are buckets).
 */
export function collectionExpiry(options: Document | undefined): ExpiryRule[] {
  const seconds = Number(options?.expireAfterSeconds)
  if (options?.expireAfterSeconds === undefined || !Number.isFinite(seconds)) return []
  const series = options.timeseries as Document | undefined
  if (series && typeof series.timeField === 'string')
    return [{ field: `control.max.${series.timeField}`, ms: seconds * 1000 }]
  return options.clusteredIndex ? [{ field: '_id', ms: seconds * 1000 }] : []
}

/**
 * Final review I8: a view (and its $lookup, $graphLookup and $unionWith) reads the restored names.
 * A source restored into another database cannot be followed: null.
 */
function renamedView(
  pair: RestorePair,
  targetOf: Map<string, { db: string; coll: string }>,
): { viewOn: string; pipeline: Document[] } | null {
  let lost = false
  const rename = (name: string): string => {
    const t = targetOf.get(`${pair.from.db}.${name}`)
    if (!t) return name
    if (t.db !== pair.to.db) lost = true
    return t.coll
  }
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (v === null || typeof v !== 'object') return v
    const out: Document = {}
    for (const [k, x] of Object.entries(v as Document)) {
      if (
        (k === '$lookup' || k === '$graphLookup') &&
        x &&
        typeof x === 'object' &&
        typeof (x as Document).from === 'string'
      )
        out[k] = walk({ ...(x as Document), from: rename((x as Document).from as string) })
      else if (k === '$unionWith' && typeof x === 'string') out[k] = rename(x)
      else if (k === '$unionWith' && x && typeof x === 'object' && typeof (x as Document).coll === 'string')
        out[k] = walk({ ...(x as Document), coll: rename((x as Document).coll as string) })
      else out[k] = walk(x)
    }
    return out
  }
  const viewOn = rename(String(pair.meta.options.viewOn))
  const pipeline = walk((pair.meta.options.pipeline ?? []) as Document[]) as Document[]
  return lost ? null : { viewOn, pipeline }
}

export interface PreparedRestore {
  plan: RestorePlan
  pairs: RestorePair[]
  views: Array<{ pair: RestorePair; def: ViewDef }>
  row: BackupFileRow
  container: ArchiveSummary['container']
  client: MongoClient
  targetMasker: Masker | null
  versions: { target: number }
  addRules: PersonalRule[]
  found: FoundTools | null
}

/** Spec §6: documents:write and jobs:run on the target. */
export function requireRestoreAccess(role: Role | null): void {
  const p = role ? permissionsFor(role) : null
  if (!p || !p.has('documents:write') || !p.has('jobs:run')) throw Errors.forbidden()
}

/** The prelude's summary, and each namespace's metadata by "db.coll". */
async function readPrelude(
  container: ArchiveSummary['container'],
  events: AsyncGenerator<ArchiveEvent>,
): Promise<{ summary: ArchiveSummary; metas: Map<string, NamespaceMeta> }> {
  const metas = new Map<string, NamespaceMeta>()
  async function* tap(): AsyncGenerator<ArchiveEvent> {
    try {
      for await (const e of events) {
        if (e.kind === 'meta') metas.set(`${e.meta.db}.${e.meta.coll}`, e.meta)
        yield e
      }
    } finally {
      await events.return(undefined)
    }
  }
  const summary = await summarize(container, tap())
  return { summary, metas }
}

async function countOf(client: MongoClient, db: string, coll: string): Promise<number | null> {
  try {
    return await client.db(db).collection(coll).estimatedDocumentCount({ maxTimeMS: 5_000 })
  } catch {
    return null
  }
}

/**
 * Phase 3d-3a spec §3.2, §5.2, U5–U7: reads the archive's prelude, checks the mapping, looks at
 * each target, and says what the restore will do and what it needs confirmed.
 */
export async function prepareRestore(
  request: FastifyRequest,
  input: RestoreRequest,
  /** Its client gone, the read stops and gives its slot back (security review round 2, I7). */
  reply?: FastifyReply,
): Promise<PreparedRestore> {
  const { ctx } = request.server
  const principal = request.principal!
  const targetId = request.connection!.id
  const role = request.connectionRole
  requireRestoreAccess(role)
  const owner = ownerOf(principal)
  const row = resolveSource(ctx, principal, input.source)
  if (!row.complete) throw Errors.conflict('The upload is not complete', { reason: 'upload_incomplete' })
  // Security review 2026-10-13 (M4): the backup's prelude is read under the server's read gate,
  // taken before a kit's key is read (round 2, Minor 1).
  const leave = ctx.backup.reads.enter(owner)
  const ctl = reply ? abortOnGone(reply) : new AbortController()
  // Phase 3d-3c: a kit given with the plan is used for this plan only (the job gets its own).
  let kitKey: Buffer | null = null
  let prelude: Awaited<ReturnType<typeof readPrelude>> & { container: ArchiveSummary['container'] }
  try {
    kitKey = input.kit !== undefined ? kitFrom(input.kit) : null
    prelude = await withPasswordThrottle(ctx, owner, row, async (onWrongPassword) => {
      const opened = await openArchive(ctx.backup.store, row, {
        ...(input.password !== undefined ? { password: input.password } : {}),
        keys: slotKeysFor(ctx, owner, kitKey),
        signal: ctl.signal,
        follow: 'complete',
        onWrongPassword,
      }).catch((e: unknown) => {
        if (e instanceof PasswordNeeded)
          throw Errors.validation('This backup is encrypted: give its password', {
            reason: 'backup_password_needed',
          })
        // Phase 3d-3c: none of the caller's keys opens it: its recovery kit is needed (or its password).
        if (e instanceof KeyNeeded)
          throw Errors.validation('This backup opens with a backup key: give its recovery kit', {
            reason: 'backup_key_needed',
            fingerprint: e.fingerprint,
            password: e.password,
          })
        throw e
      })
      return { container: opened.container, ...(await readPrelude(opened.container, opened.events)) }
    })
  } finally {
    leave()
    kitKey?.fill(0)
  }
  const { container, summary, metas } = prelude

  const client = await clientFor(request)
  // Review of db45c424: what the target takes is set by its feature level (its FCV).
  const level = await serverLevel(client)
  const targetMasker = maskerForPrincipal(ctx, principal, targetId)
  const dstRules = ctx.personalFields.get(targetId)
  const mm = summary.mongoManager
  const backupMasked = Boolean(mm && (mm.masked || mm.anonymous))
  const pairs: RestorePair[] = []
  const seen = new Set<string>()
  // Final review minor 17: one listCollections per target database, and the counts a few at a time.
  const namesByDb = new Map<string, string[]>()
  assertRestoreMapping(input.mapping)
  for (const m of input.mapping) namesByDb.set(m.to.db, [...(namesByDb.get(m.to.db) ?? []), m.to.coll])
  const listed = new Map<string, Document>()
  for (const [db, names] of namesByDb)
    for (const info of await withMongo(() =>
      client
        .db(db)
        .listCollections({ name: { $in: names } }, { nameOnly: false })
        .toArray(),
    ))
      listed.set(`${db}.${info.name}`, info as Document)
  const countable = input.mapping.filter((m) => {
    const info = listed.get(`${m.to.db}.${m.to.coll}`)
    return info !== undefined && info.type !== 'view'
  })
  const counted = new Map<string, number | null>(
    await mapLimited(
      countable,
      8,
      async (m) => [`${m.to.db}.${m.to.coll}`, await countOf(client, m.to.db, m.to.coll)] as const,
    ),
  )
  for (const m of input.mapping) {
    const meta = metas.get(`${m.from.db}.${m.from.coll}`)
    if (!meta)
      throw Errors.validation(`The backup has no ${m.from.db}.${m.from.coll}`, {
        reason: 'unknown_namespace',
      })
    const key = `${m.to.db}.${m.to.coll}`
    if (seen.has(key))
      throw Errors.validation(`${key} is the target of two namespaces`, { reason: 'duplicate_target' })
    seen.add(key)
    const existing = listed.get(key)
    const exists = existing !== undefined
    const documents = exists && existing.type !== 'view' ? (counted.get(key) ?? null) : null
    const pair: RestorePair = {
      from: m.from,
      to: m.to,
      meta,
      dataFrom: meta.type === 'timeseries' ? `system.buckets.${meta.coll}` : meta.coll,
      exists,
      documents,
      action: exists ? input.mode : 'create',
      create: null,
      indexes: null,
      kept: null,
      expiry: [],
      ttl: [],
      // U7: overwriting data needs its name typed; an empty or unknown count is asked too.
      confirmName: input.mode === 'replace' && exists && documents !== 0,
      validator: null,
    }
    pairs.push(pair)
    // Security review C1: a restore never writes a key vault or Queryable Encryption metadata — a
    // data key's master key endpoint is where the next decrypting read sends its KMS token — nor
    // copies one a backup holds into another namespace (W4 × W8: data keys an editor could read).
    if (isEncryptionNamespace(m.to.db, m.to.coll) || isEncryptionNamespace(m.from.db, m.from.coll)) {
      pair.skipped = 'Encryption keys and metadata are not restored here'
      continue
    }
    if (existing?.type === 'view') {
      pair.skipped = 'The target is a view'
      continue
    }
    if (meta.type === 'view') {
      const pipeline = (meta.options.pipeline ?? []) as Document[]
      const js = findServerJs(pipeline)
      if (js && !ctx.config.allowServerJs)
        pair.skipped = `Its pipeline uses ${js}, which runs JavaScript on the server`
      else if (JSON.stringify(pipeline).match(/"\$(out|merge)"/)) pair.skipped = 'Its pipeline writes'
      continue
    }
    // Security review 2026-10-13 round 2 (I4): GridFS file contents are denied where personal fields
    // are hidden: their chunks would be refused one by one, leaving files without contents. The
    // bucket is left out whole, said in the plan.
    // By either name: a bucket restored under another (review of the agent's gate, nit). User report
    // 2026-10-27: where a rule reaches what it is written into.
    if (bucketWriteRuled(targetMasker, m.from.coll, m.to.db, m.to.coll)) {
      pair.skipped = 'GridFS file contents cannot be checked for personal fields; the bucket is not restored'
      continue
    }
    // Buckets are written as they are: the 3c gate cannot check them for personal values.
    if (meta.type === 'timeseries' && targetMasker?.forNs(m.to.db, m.to.coll).any) {
      pair.skipped = 'A time series cannot be checked for personal fields before it is written'
      continue
    }
    // Final review I5: buckets go only into a time series this restore creates, or one that already
    // has the same time field, meta field and bucketing (review of 69adc29a, I-3: of another, a
    // query by time misses them); never into a plain collection.
    const series = meta.type === 'timeseries' ? (meta.options.timeseries as Document | undefined) : undefined
    if (meta.type === 'timeseries') {
      if (!series || typeof series.timeField !== 'string') {
        pair.skipped = 'The backup names a time series without its time series options'
        continue
      }
      const theirs =
        existing?.type === 'timeseries' ? (existing.options?.timeseries as Document | undefined) : undefined
      if (
        exists &&
        (!theirs ||
          theirs.timeField !== series.timeField ||
          (theirs.metaField ?? null) !== (series.metaField ?? null) ||
          !sameBucketing(theirs, series))
      ) {
        pair.skipped = 'The target is not a time series with the same time field, meta field and bucketing'
        continue
      }
    }
    // Backup review M8: Replace replaces the documents. A setting not taken from the backup stays
    // the target's own — the swap would otherwise drop its options, validator and indexes.
    const replacing = exists && input.mode === 'replace' && existing.type !== 'view'
    if (replacing && existing.type === 'timeseries') pair.seriesTarget = true
    if (replacing && !input.options) {
      pair.keptOptions = true
      pair.create = createOptions(
        { name: m.to.coll, type: existing.type, options: existing.options },
        { options: true, validator: true },
        ctx.config.allowServerJs,
      )
    } else if (!exists || input.mode === 'replace')
      pair.create = createOptions(
        { name: meta.coll, type: meta.type, options: meta.options },
        // A time series is one by its options: those are kept even when options are left out.
        { options: input.options || meta.type === 'timeseries', validator: input.options },
        ctx.config.allowServerJs,
        level,
      )
    if (pair.create && 'skip' in pair.create) {
      pair.skipped = pair.create.skip
      continue
    }
    // Final review I7: what the written collection will check — its new options, or the target's.
    const rules = (pair.create && 'options' in pair.create ? pair.create.options : existing?.options) as
      Document | undefined
    if (rules?.validator && rules.validationLevel !== 'off' && rules.validationAction !== 'warn')
      pair.validator = rules.validator as Document
    // A masked backup holds "***" where its paths were: a unique index over them cannot be built.
    const masked = backupMasked
      ? nsMaskerFrom(
          (mm!.maskedPaths ?? [])
            .filter((p) => p.startsWith(`${m.from.db}.${m.from.coll}.`))
            .map((p) => p.slice(m.from.db.length + m.from.coll.length + 2).split('.')),
        )
      : null
    const created = pair.create && 'options' in pair.create ? pair.create.options : null
    // Backup review I4: a cap the backup did not bring — the target's own, kept or written into.
    pair.capped = Boolean(
      pair.keptOptions ? created?.capped : exists && !replacing && existing.options?.capped,
    )
    if (input.indexes) {
      pair.indexes = indexPlan(
        meta.indexes,
        (k) =>
          masked !== null &&
          Object.keys(k).some((f) => masked.matches(f.split('.')) || masked.under(f.split('.'))),
        level,
      )
      // Review M5: the backup's indexes keep the collation they were built with — none means the
      // simple one, never a kept target's default.
      if (pair.keptOptions && created?.collation)
        for (const spec of pair.indexes.build) spec.collation ??= { locale: 'simple' }
    }
    // The target's own indexes: kept when a replace does not restore the backup's (M8), and what a
    // restore into it otherwise meets (its TTL deletes what is written: review M3).
    const theirs =
      exists && (replacing ? !input.indexes : true)
        ? await withMongo(() => client.db(m.to.db).collection(m.to.coll).listIndexes().toArray())
        : []
    if (replacing && !input.indexes) pair.kept = indexPlan(theirs, () => false)
    // Backup review I5: every TTL the written collection will have — the backup's indexes, the kept
    // ones, and a collection-level expiry it is created with — is confirmed; what deletes by age is
    // counted (M10), the target's own included. Buckets hold no index fields: a time series counts
    // its collection-level expiry only.
    const createdExpiry = collectionExpiry(created ?? undefined)
    pair.ttl = [
      ...(pair.indexes?.ttl ?? []),
      ...(pair.kept?.ttl ?? []),
      ...(createdExpiry.length ? ['expireAfterSeconds'] : []),
    ]
    const buckets = (created ?? existing?.options)?.timeseries !== undefined || meta.type === 'timeseries'
    pair.expiry = [
      ...(buckets ? [] : ttlRulesOf([...(pair.indexes?.build ?? []), ...(replacing ? [] : theirs)])),
      ...(buckets ? [] : ttlRulesOf(pair.kept?.build ?? [])),
      ...(created ? createdExpiry : collectionExpiry(existing?.options)),
    ]
  }

  const targetOf = new Map(input.mapping.map((m) => [`${m.from.db}.${m.from.coll}`, m.to]))
  for (const pair of pairs)
    if (pair.meta.type === 'view' && !pair.skipped) {
      const def = renamedView(pair, targetOf)
      if (def) pair.viewDef = def
      else pair.skipped = 'A collection it reads is restored into another database'
    }

  const refusals = new Set<string>()
  const checks: PreflightCheck[] = []
  const live = pairs.filter((p) => !p.skipped)
  const perms = permissionsFor(role!)
  if (live.some((p) => p.action === 'create' || p.action === 'replace') && !perms.has('databases:write'))
    refusals.add('permissions')
  if (live.some((p) => p.indexes?.build.length) && !perms.has('indexes:write')) refusals.add('permissions')
  if (live.some((p) => p.ttl.length) && !input.confirmTtl) refusals.add('confirm_ttl')
  for (const p of live)
    if (p.confirmName && !input.confirmNames.includes(`${p.to.db}.${p.to.coll}`)) refusals.add('confirm_name')
  // Plan ruling 15: MongoDB cannot rename a time series, so staging then swapping does not hold.
  if (live.some((p) => (p.meta.type === 'timeseries' || p.seriesTarget) && p.action === 'replace'))
    refusals.add('timeseries_replace')
  // A restricted caller must not drop values they cannot see.
  if (targetMasker && live.some((p) => p.action === 'replace' && targetMasker.forNs(p.to.db, p.to.coll).any))
    refusals.add('personal_replace')
  // B11: a masked backup written over existing documents puts "***" where real values were.
  if (backupMasked && live.some((p) => p.exists && p.action !== 'insert') && !input.confirmMasked)
    refusals.add('confirm_masked')
  // Rules an unmasked backup carries that the target lacks (spec §5.2).
  const missing: PersonalRule[] = []
  if (mm && !backupMasked)
    for (const p of live) missing.push(...missingRules(mm.rules, p.from, dstRules.rules, p.to))
  const mayAddRules = role === 'admin'
  if (missing.length && !input.confirmPersonal && !input.addRulesToTarget) refusals.add('confirm_personal')
  if (input.addRulesToTarget && missing.length) {
    if (!mayAddRules) refusals.add('add_rules_forbidden')
    else if (!PersonalRulesBodySchema.safeParse({ rules: [...dstRules.rules, ...missing] }).success)
      refusals.add('too_many_rules')
  }
  const found = await findTools(ctx.backup.limits.toolsPath)
  // Review of the CI fixes (important 2): mongorestore must read the archive's layout as well as write
  // the target's, so the newer of the two versions sets how new it must be.
  const targetVersion = await serverVersionOf(client)
  const tools = toolsAvailability(
    ctx,
    principal,
    targetId,
    found,
    rawSeries(summary.serverVersion) ? summary.serverVersion : targetVersion,
  )
  const series = live.some((p) => p.meta.type === 'timeseries')
  // Second review (minor 7): said in the plan, as the job would stop at once.
  if (series && !knownVersion(targetVersion)) refusals.add('series_version')
  if (input.engine === 'tools') {
    // MongoDB 9.0 (local run, 2026-10-20; review of db45c424): mongorestore passes options and
    // indexes as the archive has them. What the target may refuse of them, by its feature level,
    // is said in the plan; the built-in engine leaves it out. A namespace written into an existing
    // collection is not created, so passes no options.
    const beyond = [
      ...new Set(
        live.flatMap((p) =>
          optionsTargetMayRefuse(
            {
              // Without options (--noOptionsRestore) it passes none; a series then is refused below.
              options: p.create && 'options' in p.create && input.options ? p.meta.options : {},
              indexes: p.meta.indexes,
            },
            level,
            summary.serverVersion,
            input.indexes,
          ),
        ),
      ),
    ]
    const reason = !tools.available
      ? tools.reason!
      : // Review of abf29ea7: a container mongorestore cannot open is said first; no other reason
        // could be acted on.
        container === 'mmbak' || container === 'directory'
        ? container
        : series && !toolsFindSeries(summary.serverVersion, summary.toolVersion, mm?.series === 'own')
          ? 'series'
          : // Review of 8e719ba7 (I-3): mongorestore 100.19 stops at once: "cannot specify
            // --noOptionsRestore when restoring timeseries collections".
            series && !input.options
            ? 'series_without_options'
            : // Review of 182c2882: nor into an existing one ("timeseries collection … already exists
              // on the destination … use --drop"), whatever the archive or the target.
              live.some((p) => p.meta.type === 'timeseries' && p.exists)
              ? 'series_exists'
              : beyond.length
                ? 'newer_options'
                : input.mode === 'upsert'
                  ? 'upsert'
                  : !live.every((p) => [p.from.db, p.from.coll, p.to.db, p.to.coll].every(toolSafeName))
                    ? 'names'
                    : // Review M1: mongorestore drops a replaced target with its indexes and options.
                      live.some((p) => p.kept || p.keptOptions)
                      ? 'keeps_own'
                      : // mongorestore renames collections, never what a view reads (final review I8).
                        live.some(
                            (p) =>
                              p.viewDef &&
                              JSON.stringify(p.viewDef) !==
                                JSON.stringify({
                                  viewOn: String(p.meta.options.viewOn),
                                  pipeline: p.meta.options.pipeline ?? [],
                                }),
                          )
                        ? 'views'
                        : null
    checks.push({
      key: 'tools',
      level: reason ? 'block' : 'ok',
      ...(reason
        ? {
            params:
              reason === 'newer_options'
                ? // Names from the archive, so bounded: five at most, 64 characters each.
                  {
                    reason,
                    fields: [
                      ...beyond.slice(0, 5).map((k) => k.slice(0, 64)),
                      ...(beyond.length > 5 ? ['…'] : []),
                    ].join(', '),
                  }
                : { reason },
          }
        : {}),
    })
    if (reason) refusals.add('tools_unavailable')
  }
  // Final review I9, U5: writing over the very deployment the backup came from.
  if (mm?.deployment && live.some((p) => p.exists)) {
    const here = await deploymentOf(client).catch(() => null)
    if (here && compareDeployments(mm.deployment, here) === 'same')
      checks.push({ key: 'source', level: 'warn' })
  }
  const conflicts = live.filter((p) => p.exists)
  checks.push({
    key: 'conflict',
    level: conflicts.length ? 'warn' : 'ok',
    params: { count: conflicts.length },
  })
  // Backup review I4: a capped collection keeps only as many documents as its cap allows.
  const capped = live.filter((p) => p.capped)
  if (capped.length)
    checks.push({
      key: 'capped',
      level: 'warn',
      params: { names: capped.map((p) => `${p.to.db}.${p.to.coll}`).join(', ') },
    })
  if (live.some((p) => p.ttl.length))
    checks.push({
      key: 'ttl',
      level: input.confirmTtl ? 'ok' : 'warn',
      params: { names: live.flatMap((p) => p.ttl).join(', ') },
    })
  if (backupMasked) checks.push({ key: 'masked', level: refusals.has('confirm_masked') ? 'warn' : 'ok' })
  if (missing.length)
    checks.push({
      key: 'rules',
      level: input.confirmPersonal || input.addRulesToTarget ? 'ok' : 'warn',
      params: { count: missing.length },
    })

  const views = live
    .filter((p) => p.meta.type === 'view')
    .map((pair) => ({
      pair,
      def: {
        name: pair.to.coll,
        viewOn: pair.viewDef!.viewOn,
        pipeline: pair.viewDef!.pipeline,
      },
    }))
  const versions = { target: dstRules.version }
  const { password: _pw, kit: _kit, dryRun: _dry, ...settings } = input
  const plan: RestorePlan = {
    planHash: planHash({
      request: settings,
      file: [row.id, row.size, row.sha256],
      versions,
      pairs: pairs.map((p) => [
        p.from,
        p.to,
        p.exists,
        p.action,
        p.skipped ?? null,
        p.confirmName,
        p.indexes?.build.map((i) => i.name) ?? [],
        // Review M6: the target's own settings a replace keeps.
        p.kept?.build ?? [],
        p.keptOptions ? p.create : null,
        // Fifth review of B2 (M-2): a target turned capped since the plan is a change.
        Boolean(p.capped),
      ]),
    }),
    summary,
    namespaces: pairs.map((p) => ({
      from: p.from,
      to: p.to,
      type: p.meta.type,
      exists: p.exists,
      documents: p.documents,
      action: p.action,
      ttl: p.ttl,
      ...(p.kept || p.keptOptions
        ? { keepsOwn: { indexes: Boolean(p.kept), options: Boolean(p.keptOptions) } }
        : {}),
      confirmName: p.confirmName,
      ...(p.capped ? { capped: true } : {}),
      ...(p.skipped ? { skipped: p.skipped } : {}),
    })),
    missingRules: [...new Set(missing.map(formatRule))],
    mayAddRules,
    tools,
    checks,
    refusals: [...refusals],
  }
  return {
    plan,
    pairs,
    views,
    row,
    container,
    client,
    targetMasker,
    versions,
    addRules: input.addRulesToTarget && mayAddRules ? missing : [],
    found,
  }
}

/**
 * W4 final review (minor): a restore never writes into, nor reads from, a restore drill's scratch
 * database — checked here as well as by the request scan (which a padded request must not outrun).
 */
export function assertRestoreMapping(
  mapping: ReadonlyArray<{ from: { db: string }; to: { db: string } }>,
): void {
  for (const m of mapping) assertNotDrillScratch(m.from.db, m.to.db)
}
