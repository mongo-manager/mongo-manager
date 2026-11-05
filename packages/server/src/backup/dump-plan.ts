// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyRequest } from 'fastify'
import type { Principal, ServerContext } from '../http/context'
import type { Document, MongoClient } from 'mongodb'
import {
  BACKUP_SYSTEM_DATABASES,
  type BackupScope,
  type DumpPlan,
  type DumpRequest,
  type MongoManagerHeader,
  type NamespaceType,
  type PersonalRule,
  type PreflightCheck,
} from '@mongo-manager/shared'
import { Errors } from '../errors'
import { clientFor, withMongo } from '../data/mongo-errors'
import { toClient } from '../data/ejson-io'
import { deploymentOf } from '../transfer/same-deployment'
import { mapLimited } from './concurrency'
import { maskerForPrincipal } from '../masking/request'
import { compileRules, type Masker, type Pattern } from '../masking/match'
import { gateDepsFor, viewAwareMasker } from '../masking/restricted'
import { guardFind, isOrderRefusal } from '../masking/gate'
import { maskCollectionOptions, maskIndexOptions } from '../masking/definitions'
import {
  isDrillScratch,
  isEncryptionNamespace,
  isRestrictedNamespace,
  unattended,
} from '../connections/access'
import { indexPlan } from '../transfer/collection-spec'
import { planHash, rulesOn } from '../transfer/copy-access'
import { ownerOf } from '../transfer/files'
import { VERSION } from '../version'
import { findTools, toolSafeName, toolsAvailability, type FoundTools } from './tools'
import { MAX_ARCHIVE_NAMESPACES, MAX_METADATA_BYTES } from './limits'
import { knownVersion, rawSeries, seriesAccess } from './series'
import { bucketRuled } from '../masking/gridfs'
import { BSON } from 'bson'
import { MongoManagerHeaderSchema } from '@mongo-manager/shared'
import { metadataText, type NamespaceMeta } from './archive-writer'

export interface DumpPair {
  db: string
  coll: string
  type: NamespaceType
  options: Document
  indexes: Document[]
  uuid?: string
  skipped?: string
  note?: string
  documents: number | null
  bytes: number | null
  ttl: string[]
  personal: string[]
  /** A masked dump's read, rewritten by the 3c gate; null: read the collection whole. */
  read: {
    filter: Document
    options: Document
    finish: ((docs: Document[]) => Document[]) | null
  } | null
  /** Paths written as "***" in this namespace's documents; null: none. */
  mask: Pattern[] | null
}

export interface PreparedDump {
  plan: DumpPlan
  pairs: DumpPair[]
  client: MongoClient
  serverVersion: string
  versions: { source: number }
  masked: boolean
  header: MongoManagerHeader
  found: FoundTools | null
}

const skipName = (n: string) => n.startsWith('system.') || n.startsWith('enxcol_.')
/** Compression the estimate assumes per format (zstd about 4×, gzip about 3×). */
const RATIO = { archive: 1, gzip: 0.33, mmbak: 0.25 } as const
const BIG = 50 * 1024 ** 3
/** The tools engine's arguments must fit a Windows command line (32 767 characters). */
const MAX_TOOL_ARGS = 24_000
const statsCache = new Map<string, { at: number; documents: number | null; bytes: number | null }>()

const STATS_TTL_MS = 30_000
const VERSION_UNKNOWN =
  'The server does not say its version, so where this time series keeps its data is not known; it is left out'
const STATS_MAX = 2_000

/** Final review I4: per connection (two connections may hold the same names), and bounded. */
async function stats(
  connectionId: string,
  client: MongoClient,
  db: string,
  coll: string,
  comment: string,
): Promise<{ documents: number | null; bytes: number | null }> {
  const key = JSON.stringify([connectionId, db, coll])
  const hit = statsCache.get(key)
  if (hit && Date.now() - hit.at < STATS_TTL_MS) return hit
  if (statsCache.size >= STATS_MAX) {
    const now = Date.now()
    for (const [k, v] of statsCache) if (now - v.at >= STATS_TTL_MS) statsCache.delete(k)
    if (statsCache.size >= STATS_MAX) statsCache.clear()
  }
  try {
    const [s] = await client
      .db(db)
      .collection(coll)
      .aggregate([{ $collStats: { storageStats: {} } }], { comment, maxTimeMS: 5_000 })
      .toArray()
    const value = {
      at: Date.now(),
      documents: Number(s?.storageStats?.count ?? 0),
      bytes: Number(s?.storageStats?.size ?? 0),
    }
    statsCache.set(key, value)
    return value
  } catch {
    return { documents: null, bytes: null }
  }
}

/** Plan ruling 14: a definition the masker would change is not written at all. */
const changes = (before: unknown, after: unknown) => JSON.stringify(before) !== JSON.stringify(after)

/** Spec §5.3: what mongodump reads. Names were checked with toolSafeName by the plan (B15). */
/**
 * mongodump's selection. `complete` says the plan dumps everything the scope names; otherwise each
 * planned namespace is named, so views left out and skipped namespaces stay out (final review minor 14).
 */
export function dumpToolArgs(
  scope: BackupScope,
  pairs: Array<Pick<DumpPair, 'db' | 'coll'>>,
  complete = true,
): string[] {
  if (scope.kind === 'collection') return [`--db=${scope.db}`, `--collection=${scope.coll}`]
  if (!complete) return pairs.map((p) => `--nsInclude=${p.db}.${p.coll}`)
  if (scope.kind === 'database' && !scope.collections) return [`--db=${scope.db}`]
  if (scope.kind === 'database') return pairs.map((p) => `--nsInclude=${p.db}.${p.coll}`)
  if (scope.databases) return scope.databases.map((d) => `--nsInclude=${d}.*`)
  return ['--nsExclude=admin.*', '--nsExclude=config.*', '--nsExclude=local.*']
}

/** Whether the plan dumps all that the scope names: nothing skipped, views kept. */
export const toolsComplete = (scope: BackupScope, pairs: Array<Pick<DumpPair, 'skipped'>>): boolean =>
  !(scope.kind === 'database' && scope.views === false) && pairs.every((p) => !p.skipped)

/** Phase 3d-3c (plan ruling 11): who plans, on which connection, with which client — a request or a schedule's run. */
export interface DumpEnv {
  ctx: ServerContext
  principal: Principal
  connectionId: string
  client: MongoClient
  /** Tags the plan's MongoDB operations. */
  comment: string
}

/** The dump routes' plan: the request's caller, connection and client. */
/**
 * `asScheduled`: planned as a schedule runs it — on its own, where the caller's view of the data
 * (local mode's hiding, a "hide from me") masks nothing it writes; a grant masks it all the same
 * (second review of the personal-data rework, A).
 */
export async function prepareDump(
  request: FastifyRequest,
  input: DumpRequest,
  options: { asScheduled?: boolean } = {},
): Promise<PreparedDump> {
  return planDump(
    {
      ctx: request.server.ctx,
      principal: options.asScheduled ? unattended(request.principal!) : request.principal!,
      connectionId: request.connection!.id,
      client: await clientFor(request),
      comment: `mm-backup-plan:${request.id}`,
    },
    input,
  )
}

/** What the archive's prelude names of a pair, as the dump job writes it. */
const metaOf = (p: DumpPair): NamespaceMeta => ({
  db: p.db,
  coll: p.coll,
  type: p.type,
  options: p.options,
  indexes: p.indexes,
  ...(p.uuid ? { uuid: p.uuid } : {}),
})

/**
 * Fourth and fifth reviews of the CI fixes: whether a backup's header, as ArchiveWriter.begin writes
 * it (its start time as a job's), would be refused by its own reader — past its limits on masked
 * paths or rules, or its size, with a kilobyte to spare.
 */
export function headerUnreadable(header: MongoManagerHeader, serverVersion: string): boolean {
  const written = {
    concurrent_collections: 1,
    version: '0.1',
    server_version: knownVersion(serverVersion) ? serverVersion : '0.0.0',
    tool_version: header.tool,
    mongoManager: { ...header, startedAt: Date.now() },
  }
  return (
    !MongoManagerHeaderSchema.safeParse(header).success ||
    BSON.calculateObjectSize(written) > MAX_METADATA_BYTES - 1024
  )
}

/**
 * Sixth review of the CI fixes (important 2): whether the namespaces' metadata, as the archive's
 * prelude holds it, passes what the reader takes in all (many collections, or large validators):
 * such a backup would be written whole and then refused as damaged.
 */
export function metadataTooLarge(metas: NamespaceMeta[]): boolean {
  let total = 0
  for (const m of metas)
    total += BSON.calculateObjectSize({
      db: m.db,
      collection: m.coll,
      metadata: metadataText(m),
      size: 0,
      type: m.type,
    })
  return total > MAX_METADATA_BYTES - 1024
}

/**
 * What the plan recommends: the encrypted format where personal data would be readable, the tools
 * for a big backup. Twelfth review of explain masking (I3): a size hidden from the caller is not
 * weighed, or the recommendation would tell it.
 */
export function recommendation(o: {
  personal: boolean
  tools: boolean
  hidden: boolean
  bytes: number
}): DumpPlan['recommended'] {
  if (o.personal) return { format: 'mmbak', engine: 'builtin', reason: 'personal' }
  if (o.tools && !o.hidden && o.bytes > BIG) return { format: 'gzip', engine: 'tools', reason: 'size' }
  return { format: 'gzip', engine: 'builtin', reason: null }
}

/**
 * Phase 3d-3a spec §3.1, §5.1, §6, U1, U2: what a dump will hold — namespaces, masks, skips, sizes,
 * the preflight checks and the recommendation — and the hash the start must echo.
 */
export async function planDump(env: DumpEnv, input: DumpRequest): Promise<PreparedDump> {
  const { ctx, principal, connectionId, client, comment } = env
  const rules = ctx.personalFields.get(connectionId)
  const restricted = maskerForPrincipal(ctx, principal, connectionId)
  // A restricted caller's dump is masked by their masker; an anonymous one by all the rules.
  const maskMasker: Masker | null =
    restricted ?? (input.anonymous && rules.rules.length ? compileRules(rules.rules) : null)
  // A masked dump goes through the gate: each namespace with its own lookups (fifteenth review, I-1).
  const gate = maskMasker !== null
  const scope = input.scope
  const build = await withMongo(() => client.db('admin').command({ buildInfo: 1 }))
  const serverVersion = String(build.version ?? 'unknown')

  // The databases of the scope, without the system ones.
  let dbs: string[]
  if (scope.kind === 'server') {
    const listed = await withMongo(() =>
      client.db('admin').admin().listDatabases({ nameOnly: true, authorizedDatabases: true }),
    )
    const names = listed.databases
      .map((d) => d.name)
      .filter((n) => !BACKUP_SYSTEM_DATABASES.includes(n) && !isDrillScratch(n))
    if (scope.databases)
      for (const d of scope.databases)
        if (!names.includes(d)) throw Errors.notFound(`Database ${d} not found`)
    dbs = scope.databases ?? names
  } else {
    // W4 review C1: a restore drill's scratch database is backed up by no one.
    if (isDrillScratch(scope.db))
      throw Errors.forbidden('A restore drill’s scratch database is not open to anyone')
    dbs = [scope.db]
  }

  const pairs: DumpPair[] = []
  const work: Array<() => Promise<void>> = []
  for (const db of dbs) {
    const infos = await withMongo(() => client.db(db).listCollections({}, { nameOnly: false }).toArray())
    let chosen = infos.filter((i) => !skipName(i.name))
    if (scope.kind === 'collection') {
      chosen = chosen.filter((i) => i.name === scope.coll)
      if (!chosen.length) throw Errors.notFound(`Collection ${scope.coll} not found`)
    } else if (scope.kind === 'database') {
      const named = scope.collections
      if (named)
        for (const n of named)
          if (!chosen.some((i) => i.name === n)) throw Errors.notFound(`Collection ${n} not found`)
      const namesViews = named?.some((n) => chosen.find((i) => i.name === n)?.type === 'view') ?? false
      chosen = chosen.filter((i) =>
        i.type === 'view'
          ? namesViews
            ? named!.includes(i.name)
            : scope.views
          : !named || named.includes(i.name),
      )
    }
    // 3c: a view's pipeline is masked against what it reads (view-aware definitions masker).
    const defMasker =
      maskMasker && chosen.length
        ? await withMongo(() =>
            viewAwareMasker(
              maskMasker,
              () => gateDepsFor(maskMasker, client),
              chosen.map((i) => [db, i.name] as const),
            ),
          )
        : null
    for (const info of chosen) {
      if (pairs.length >= MAX_ARCHIVE_NAMESPACES)
        throw Errors.conflict('Too many collections for one backup', { reason: 'too_many_namespaces' })
      const type: NamespaceType =
        info.type === 'view' ? 'view' : info.type === 'timeseries' ? 'timeseries' : 'collection'
      const options = ((info as { options?: Document }).options ?? {}) as Document
      const uuid = (info as { info?: { uuid?: { buffer: Uint8Array } } }).info?.uuid
      const pair: DumpPair = {
        db,
        coll: info.name,
        type,
        options,
        indexes: [],
        ...(uuid ? { uuid: Buffer.from(uuid.buffer).toString('hex') } : {}),
        documents: null,
        bytes: null,
        ttl: [],
        personal: [],
        read: null,
        mask: null,
      }
      pairs.push(pair)
      // Security review C1 (ruling): a key vault is key material, never in a backup file anyone may
      // later fetch or restore; it is backed up with the operator's own tools.
      if (isEncryptionNamespace(db, info.name)) {
        pair.skipped =
          'Encryption keys (the key vault) are not backed up here: back them up with your own tools'
        continue
      }
      if (isRestrictedNamespace(db, info.name, false)) {
        pair.skipped = 'Credential collections are not backed up'
        continue
      }
      if (options.encryptedFields) {
        pair.skipped = 'Encrypted (Queryable Encryption) collections are not backed up'
        continue
      }
      // Security review 2026-10-13 round 2 (I4): GridFS file contents are not read where personal
      // fields are hidden; their bucket is left out whole, never refused whole. User report
      // 2026-10-27: where a rule reaches the bucket.
      if (bucketRuled(maskMasker, db, info.name)) {
        pair.skipped = 'GridFS file contents cannot be masked; the bucket is left out of a masked backup'
        continue
      }
      const nsRules = maskMasker?.forNs(db, info.name)
      if (type === 'timeseries' && nsRules?.any) {
        pair.skipped =
          'A time series with personal fields cannot be masked; it is left out of a masked backup'
        continue
      }
      // Review of the CI fixes (minor 4): where a time series keeps its data depends on the server's
      // version (series.ts); a server that does not say it is never guessed at.
      if (type === 'timeseries' && !knownVersion(serverVersion)) {
        pair.skipped = VERSION_UNKNOWN
        continue
      }
      const masksTo = (o: Document) => maskCollectionOptions(toClient(o), db, info.name, defMasker!)
      if (defMasker && changes(toClient(options), masksTo(options))) {
        // Final review minor 16: a collection keeps its (masked) data; only its validation, which
        // holds the values, is left out. A view or time series is its definition: left out whole.
        const { validator: _v, validationLevel: _l, validationAction: _a, ...rest } = options
        if (type !== 'collection' || changes(toClient(rest), masksTo(rest))) {
          pair.skipped = 'Its definition holds values that would be masked; it is left out of a masked backup'
          continue
        }
        pair.options = rest
        pair.note = 'Its validator holds values that would be masked; the backup keeps the data without it'
      }
      if (type === 'view') continue
      // Final review minor 17: indexes and sizes are read several namespaces at a time, after the loop.
      work.push(async () => {
        const listed = await withMongo(() =>
          client
            .db(db)
            .collection(info.name)
            .listIndexes({ comment } as never)
            .toArray(),
        )
        const masks = nsRules?.any ? [...nsRules.patterns] : []
        const personalUnique = (key: Document) =>
          masks.length > 0 &&
          Object.keys(key).some((k) =>
            masks.some((p) => p.join('.') === k || k.startsWith(`${p.join('.')}.`)),
          )
        const ip = indexPlan(listed, personalUnique)
        const kept = ip.build.filter(
          (ix) =>
            !defMasker || !changes(toClient(ix), maskIndexOptions(toClient(ix), db, info.name, defMasker)),
        )
        // Only what the server lists: a time series has no _id index, and mongorestore would pass a
        // made-up one to create as idIndex, which MongoDB refuses for time series (found by B20).
        const idIndex = listed.find((i) => i.name === '_id_')
        pair.indexes = [...(idIndex ? [idIndex] : []), ...kept]
        pair.ttl = kept.filter((ix) => ix.expireAfterSeconds !== undefined).map((ix) => String(ix.name))
        const s = await stats(
          connectionId,
          client,
          db,
          type === 'timeseries' ? seriesAccess(info.name, serverVersion).coll : info.name,
          comment,
        )
        pair.documents = s.documents
        pair.bytes = s.bytes
        if (type === 'timeseries') return
        if (gate) {
          // Twelfth review (I5): read in the gate's order, as the check on each page expects; where
          // there is none to read in, the collection is left out (thirteenth review, M5).
          // Each namespace its own lookups: one dump's gate would run out past a hundred, and only
          // an order refusal leaves a collection out (fourteenth review, I-B).
          const own = gateDepsFor(maskMasker!, client)
          let guarded: Awaited<ReturnType<typeof guardFind>>
          try {
            guarded = await withMongo(() =>
              guardFind(db, info.name, { filter: {} }, own, { order: 'always' }),
            )
          } catch (e) {
            if (!isOrderRefusal(e)) throw e
            pair.skipped = 'Stored in the order of a hidden value; it is left out of a masked backup'
            return
          }
          // Fourteenth review (Minor 5): said before it runs.
          if (guarded.checksId) {
            // Fifteenth review (Minor 1): beside a note already made, not over it.
            const note = 'Read in _id order: a document _id stops the backup'
            pair.note = pair.note ? `${pair.note}. ${note}` : note
          }
          pair.read = {
            filter: guarded.filter,
            options: {
              ...(guarded.projection ? { projection: guarded.projection } : {}),
              ...(guarded.sort ? { sort: guarded.sort } : {}),
              ...(guarded.hint ? { hint: guarded.hint } : {}),
            },
            finish: (docs) => guarded.finish(docs),
          }
          const out = [...(guarded.output?.patterns ?? [])]
          pair.mask = out.length ? out : null
        } else {
          const own = compileRules(rules.rules).forNs(db, info.name)
          pair.personal = own.any ? own.patterns.map((p) => `${db}.${info.name}.${p.join('.')}`) : []
        }
      })
    }
  }
  await mapLimited(work, 8, (f) => f())

  const owner = ownerOf(principal)
  const found = await findTools(ctx.backup.limits.toolsPath)
  const tools = toolsAvailability(ctx, principal, connectionId, found, serverVersion)
  const included = pairs.filter((p) => !p.skipped)
  // Twelfth review of explain masking (I3): a restricted caller reads no size of what rules hide
  // (polled while a document is written, it tells its length); the checks still weigh it.
  // By the rules, not the read: a collection left out has no read, but its size (fourteenth review, I-A).
  const sizeHidden = (p: DumpPair) =>
    restricted !== null && (p.mask !== null || restricted.forNs(p.db, p.coll).any)
  const hidden = included.some(sizeHidden)
  const bytes = included.reduce((s, p) => s + (p.bytes ?? 0), 0)
  const fileBytes = Math.round(bytes * RATIO[input.format])
  const seconds = estimateSeconds(ctx, principal, connectionId, bytes)
  const personal = included.flatMap((p) => p.personal)
  const masked = maskMasker !== null
  const room = ctx.backup.store.room(owner)
  const checks: PreflightCheck[] = [{ key: 'permissions', level: 'ok' }]
  const refusals: string[] = []
  checks.push({
    key: 'size',
    level: 'ok',
    params: hidden ? { hidden: 1 } : { bytes, fileBytes, ...(seconds !== null ? { seconds } : {}) },
  })
  const quota: Record<string, number> = hidden ? { room, hidden: 1 } : { room, fileBytes }
  if (fileBytes > room) {
    checks.push({ key: 'quota', level: 'block', params: quota, fix: { kind: 'deleteOld' } })
    refusals.push('backup_quota')
  } else checks.push({ key: 'quota', level: fileBytes > room * 0.8 ? 'warn' : 'ok', params: quota })
  if (restricted) checks.push({ key: 'masked', level: 'ok' })
  if (personal.length && input.format !== 'mmbak') {
    // Encrypting is the first way out; making it anonymous or leaving those collections out are the others.
    // From the pairs, not by splitting paths: a collection name may hold dots.
    const holders = included.filter((p) => p.personal.length).map((p) => `${p.db}.${p.coll}`)
    const more: NonNullable<PreflightCheck['more']> = []
    if (input.engine === 'builtin' && !input.anonymous && !restricted) more.push({ kind: 'anonymous' })
    if (scope.kind === 'database' && holders.length < included.length)
      more.push({ kind: 'exclude', names: holders })
    checks.push({
      key: 'personal',
      level: 'warn',
      params: { count: personal.length },
      fix: { kind: 'encrypt' },
      ...(more.length ? { more } : {}),
    })
  } else if (personal.length)
    checks.push({ key: 'personal', level: 'ok', params: { count: personal.length } })
  const tsSkipped = pairs.filter((p) => p.type === 'timeseries' && p.skipped).map((p) => `${p.db}.${p.coll}`)
  // Second and third reviews (minor 3): each said as why it was left out.
  const unversioned = pairs
    .filter((p) => p.type === 'timeseries' && p.skipped === VERSION_UNKNOWN)
    .map((p) => `${p.db}.${p.coll}`)
  const unversionedSet = new Set(unversioned)
  const personalSeries = tsSkipped.filter((n) => !unversionedSet.has(n))
  if (personalSeries.length)
    checks.push({ key: 'timeseries', level: 'warn', params: { names: personalSeries.join(', ') } })
  if (unversioned.length)
    checks.push({ key: 'timeseries_version', level: 'warn', params: { names: unversioned.join(', ') } })
  const encrypted = pairs.filter((p) => p.options.encryptedFields).map((p) => `${p.db}.${p.coll}`)
  if (encrypted.length)
    checks.push({ key: 'encrypted', level: 'warn', params: { names: encrypted.join(', ') } })
  // Phase 3d-3b V5: each chosen destination, as the caller may see it; refused here, not at the send.
  for (const id of input.destinations) {
    const record = ctx.backup.destinations.levelOf(id, principal)
      ? ctx.backup.destinations.get(id)
      : undefined
    if (!record) {
      checks.push({ key: 'destination', level: 'block', params: { name: '', reason: 'unknown' } })
      refusals.push('destination_unknown')
    } else if (input.format !== 'mmbak' && record.policy.encryptedOnly) {
      checks.push({
        key: 'destination',
        level: 'block',
        params: { name: record.name, reason: 'encrypted_only' },
        fix: { kind: 'encrypt' },
      })
      refusals.push('destination_encrypted_only')
    } else if (input.format !== 'mmbak' && !masked && personal.length > 0) {
      checks.push({
        key: 'destination',
        level: 'block',
        params: { name: record.name, reason: 'personal_plain' },
        fix: { kind: 'encrypt' },
      })
      refusals.push('destination_personal_plain')
    } else checks.push({ key: 'destination', level: 'ok', params: { name: record.name } })
  }
  if (input.engine === 'tools') {
    const safe = included.every((p) => toolSafeName(p.db) && toolSafeName(p.coll))
    const fits = dumpToolArgs(scope, included, toolsComplete(scope, pairs)).join(' ').length <= MAX_TOOL_ARGS
    const reason = !tools.available
      ? tools.reason!
      : input.anonymous
        ? 'anonymous'
        : !safe || !fits
          ? 'names'
          : null
    if (reason) {
      checks.push({ key: 'tools', level: 'block', params: { reason } })
      refusals.push('tools_unavailable')
    } else checks.push({ key: 'tools', level: 'ok', params: { version: tools.version ?? '' } })
  }
  if (!included.length) refusals.push('empty')
  const recommended = recommendation({ personal: personal.length > 0, tools: tools.available, hidden, bytes })

  const versions = { source: rules.version }
  const ruleList: PersonalRule[] = included.flatMap((p) => rulesOn(rules.rules, p.db, p.coll))
  const deployment = await deploymentOf(client).catch(() => null)
  const header: MongoManagerHeader = {
    tool: `mongo-manager ${VERSION}`,
    scope,
    masked,
    anonymous: input.anonymous,
    maskedPaths: included.flatMap((p) => (p.mask ?? []).map((m) => `${p.db}.${p.coll}.${m.join('.')}`)),
    rules: [...new Map(ruleList.map((r) => [`${r.db}.${r.coll}.${r.field}`, r])).values()],
    startedAt: 0,
    // Final review I9: so a restore can tell it is going back onto its own source.
    ...(deployment ? { deployment } : {}),
    // Second review (minor 6): its time series kept under their own names, as mongorestore 100.16
    // and later looks for them (series.ts).
    ...(rawSeries(serverVersion) ? { series: 'own' as const } : {}),
  }
  // Fourth review (minor 5): a header its own reader would refuse (too many masked paths or rules)
  // is never written; the backup is refused before it starts.
  // Only the built-in engine writes this header; the namespaces' metadata the app reads back from
  // either engine's archive (restore, inspect, drill), so it is refused for both (seventh review).
  if (input.engine !== 'tools' && headerUnreadable(header, serverVersion)) refusals.push('header_too_large')
  // Sixth review (important 2): nor namespace metadata past what the reader takes in all.
  if (metadataTooLarge(included.map(metaOf))) refusals.push('metadata_too_large')
  const plan: DumpPlan = {
    planHash: planHash({
      request: input,
      versions,
      masked,
      namespaces: pairs.map((p) => [
        p.db,
        p.coll,
        p.type,
        p.skipped ?? null,
        p.note ?? null,
        p.indexes.map((i) => i.name),
        p.mask,
      ]),
      tools: tools.available,
    }),
    namespaces: pairs.map((p) => ({
      db: p.db,
      coll: p.coll,
      type: p.type,
      documents: p.documents,
      bytes: sizeHidden(p) ? null : p.bytes,
      ttl: p.ttl,
      personal: p.personal,
      ...(p.skipped ? { skipped: p.skipped } : {}),
      ...(p.note ? { note: p.note } : {}),
    })),
    estimate: hidden ? { bytes: null, fileBytes: null, seconds: null } : { bytes, fileBytes, seconds },
    tools,
    masked,
    recommended,
    checks,
    refusals,
  }
  return { plan, pairs, client, serverVersion, versions, masked, header, found }
}

/** Plan ruling 8 (3d-3a): seconds from the throughput of this caller's last five dumps on this connection. */
function estimateSeconds(
  ctx: ServerContext,
  principal: Principal,
  connectionId: string,
  bytes: number,
): number | null {
  const owner = ownerOf(principal)
  const rates: number[] = []
  for (const j of ctx.jobs.list({ state: 'done' })) {
    if (rates.length >= 5) break
    if (j.kind !== 'backup.dump' || j.connectionId !== connectionId) continue
    const r = ctx.transfer.reports.get(owner, j.id)
    if (r?.kind === 'dump' && r.throughput !== null && r.throughput > 0) rates.push(r.throughput)
  }
  if (!rates.length) return null
  const avg = rates.reduce((s, r) => s + r, 0) / rates.length
  return Math.ceil(bytes / avg)
}
