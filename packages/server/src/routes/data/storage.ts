import type { FastifyInstance } from 'fastify'
import type { Document, MongoClient } from 'mongodb'
import {
  CompactBodySchema,
  ShardKeyAnalysisBodySchema,
  type CompactEstimate,
  type ShardKeyAnalysis,
  type StorageCollection,
  type StorageReport,
} from '@mongo-manager/shared'
import { Errors } from '../../errors'
import { parseInput } from '../../validate'
import { requireConnection } from '../../connections/access'
import { clientFor, LENIENT, toAppError, withMongo } from '../../data/mongo-errors'
import { toClient } from '../../data/ejson-io'
import { maskerFor } from '../../masking/request'
import { bucketRuled } from '../../masking/gridfs'
import { CollParams, DbParams } from './params'

/** The collections one report reads (by name), and how many at once. */
const MAX_COLLECTIONS = 500
const READ_AT_ONCE = 8
/** How many documents analyzeShardKey samples for a key's characteristics. */
const SAMPLE_SIZE = 10_000
const MAX_COMMON_VALUES = 10
/** The longest a time series' measurements are counted. */
const COUNT_MS = 5_000
/** The longest one analysis may run. */
const ANALYSIS_MS = 60_000
/** WiredTiger's own name for the space a file holds free for reuse. */
const REUSABLE = 'file bytes available for reuse'

const n = (v: unknown): number => {
  const x = Number(v ?? 0)
  return Number.isFinite(x) ? x : 0
}
const code = (e: unknown): unknown => (e as { code?: unknown }).code

/** MongoDB refused the command: the account lacks a role (said as such, never as a failure). */
function refused(e: unknown, what: string): unknown {
  if (code(e) === 13)
    return Errors.forbidden(`MongoDB refused ${what}: the account needs a role that allows it`, {
      reason: 'mongo_not_permitted',
    })
  return e
}

/** Final review Minor 1: a version that cannot be read is taken as too old (never as new enough). */
export function versionAtLeast(version: unknown, major: number): boolean {
  const m = Number(String(version ?? '').split('.')[0])
  return Number.isFinite(m) && m >= major
}

/**
 * Why analyzeShardKey gave no answer, where MongoDB said a reason the report tells (final review
 * Minor 13: an IllegalOperation is "no index" only when it says so); null for any other failure.
 */
export function shardKeyRefusal(e: unknown): 'version' | 'no_index' | null {
  const c = code(e)
  if (c === 59) return 'version'
  const message = String(
    (e as { errmsg?: unknown; message?: unknown }).errmsg ?? (e as { message?: unknown }).message ?? '',
  )
  if ((c === 20 || c === 27) && /index/i.test(message)) return 'no_index'
  return null
}

/** The collection's kind (collection, timeseries, view), or null when it is not there. */
async function kindOf(client: MongoClient, db: string, coll: string): Promise<string | null> {
  const [found] = await withMongo(() =>
    client.db(db).listCollections({ name: coll }, { nameOnly: true, authorizedCollections: true }).toArray(),
  )
  return found ? String(found.type) : null
}

const isMongos = async (client: MongoClient) =>
  (await client.db('admin').command({ hello: 1 })).msg === 'isdbgrid'

/** One collection's storage from its $collStats answers (one a shard behind a mongos, added up). */
export function storageOf(
  name: string,
  type: StorageCollection['type'],
  answers: readonly Document[],
  hidden: boolean,
): StorageCollection {
  const parts = answers.map((a) => (a.storageStats ?? {}) as Document)
  const sum = (read: (p: Document) => unknown) => parts.reduce((t, p) => t + n(read(p)), 0)
  const free = (d: unknown) =>
    ((d as Document | undefined)?.['block-manager'] as Document | undefined)?.[REUSABLE]
  // Final review Minor 7: where WiredTiger did not say (another engine, a shard's answer), the free
  // space is not known — never 0.
  const freeOf = (values: unknown[]) =>
    values.some((v) => v !== undefined) ? values.reduce<number>((t, v) => t + n(v), 0) : null
  const indexes = new Map<string, { size: number; free: unknown[] }>()
  for (const p of parts) {
    const details = (p.indexDetails ?? {}) as Document
    for (const [index, bytes] of Object.entries((p.indexSizes ?? {}) as Document)) {
      const known = indexes.get(index) ?? { size: 0, free: [] }
      indexes.set(index, { size: known.size + n(bytes), free: [...known.free, free(details[index])] })
    }
  }
  const size = (v: number | null) => (hidden ? null : v)
  const list = [...indexes.entries()].map(([index, s]) => ({
    name: index,
    size: size(s.size),
    freeBytes: size(freeOf(s.free)),
  }))
  return {
    name,
    type,
    count: answers.reduce((t, a, i) => t + n(a.count ?? parts[i]!.count), 0),
    size: size(sum((p) => p.size)),
    storageSize: size(sum((p) => p.storageSize)),
    freeBytes: size(freeOf(parts.map((p) => free(p.wiredTiger)))),
    indexSize: size(sum((p) => p.totalIndexSize)),
    indexFreeBytes: size(freeOf([...indexes.values()].flatMap((s) => s.free))),
    indexes: list,
    ...(hidden ? { sizesHidden: true as const } : {}),
  }
}

/** What analyzeShardKey's key characteristics say, the key's values as canonical EJSON. */
export function analysisOf(answer: Document, key: Record<string, unknown>): ShardKeyAnalysis {
  const k = (answer.keyCharacteristics ?? {}) as Document
  const num = (v: unknown) => (v === undefined || v === null ? null : n(v))
  const fields = Object.keys(key)
  const valueOf = (v: unknown) => {
    const doc = (v ?? {}) as Document
    return toClient(fields.length === 1 ? doc[fields[0]!] : doc)
  }
  const type = String(((k.monotonicity ?? {}) as Document).type ?? 'unknown')
  return {
    available: true,
    numDocsTotal: num(k.numDocsTotal),
    numDocsSampled: num(k.numDocsSampled),
    numDistinctValues: num(k.numDistinctValues),
    avgDocSizeBytes: num(k.avgDocSizeBytes),
    isUnique: typeof k.isUnique === 'boolean' ? k.isUnique : null,
    mostCommonValues: (Array.isArray(k.mostCommonValues) ? (k.mostCommonValues as Document[]) : [])
      .slice(0, MAX_COMMON_VALUES)
      .map((m) => ({ value: valueOf(m.value), frequency: n(m.frequency) })),
    monotonicity: type === 'monotonic' || type === 'not monotonic' ? type : 'unknown',
  }
}

/**
 * Plugins wave 4 (2026-10-27): a database's storage (for the storage report), compact's estimate and
 * compact itself (run only on the user's typed confirmation in the app's own dialog), and a shard
 * key's analysis. A restricted user is told no size, and is refused compact and the analysis, where
 * the rules reach (a size or a key's values tell what they hide).
 */
export async function storageRoutes(app: FastifyInstance): Promise<void> {
  const DB = '/connections/:id/databases/:db'
  const COLL = `${DB}/collections/:coll`
  const admin = requireConnection('databases:admin')

  app.get(
    `${DB}/storage`,
    { preHandler: requireConnection('databases:read'), config: { masking: 'names-only' } },
    async (request): Promise<StorageReport> => {
      const { db } = parseInput(DbParams, request.params)
      const client = await clientFor(request)
      const masker = maskerFor(request)
      const listed = await withMongo(() =>
        client.db(db).listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray(),
      )
      const all = listed
        .filter(
          (c) =>
            (c.type === 'collection' || c.type === 'timeseries') && !String(c.name).startsWith('system.'),
        )
        .map((c) => ({ name: String(c.name), type: c.type as StorageCollection['type'] }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      const read = all.slice(0, MAX_COLLECTIONS)
      const out: StorageCollection[] = []
      for (let i = 0; i < read.length; i += READ_AT_ONCE)
        out.push(
          ...(await Promise.all(
            read.slice(i, i + READ_AT_ONCE).map(async ({ name, type }) => {
              // Final review Minor 6: a bucket's chunks add up to its files' sizes.
              const hidden = masker?.forNs(db, name).any === true || bucketRuled(masker, db, name)
              try {
                const answers = await client
                  .db(db)
                  .collection(name)
                  .aggregate([{ $collStats: { storageStats: {}, count: {} } }], LENIENT)
                  .toArray()
                const row = storageOf(name, type, answers, hidden)
                // Final review Minor 7: a time series' $collStats counts its buckets; its measurements
                // are counted (bounded), or not known.
                if (type === 'timeseries')
                  row.count = await client
                    .db(db)
                    .collection(name)
                    .countDocuments({}, { maxTimeMS: COUNT_MS })
                    .catch(() => null)
                return row
              } catch {
                return {
                  name,
                  type,
                  count: null,
                  size: null,
                  storageSize: null,
                  freeBytes: null,
                  indexSize: null,
                  indexFreeBytes: null,
                  indexes: [],
                  unread: true as const,
                  ...(hidden ? { sizesHidden: true as const } : {}),
                }
              }
            }),
          )),
        )
      return { collections: out, more: all.length > read.length }
    },
  )

  app.post(
    `${COLL}/compact-estimate`,
    { preHandler: admin, config: { masking: 'denied-when-ruled' } },
    async (request): Promise<CompactEstimate> => {
      const { db, coll } = parseInput(CollParams, request.params)
      const client = await clientFor(request)
      // Final review Minor 5: a time series is not compacted here (its buckets are a system collection).
      if ((await kindOf(client, db, coll)) === 'timeseries') return { available: false, reason: 'timeseries' }
      if (await withMongo(() => isMongos(client))) return { available: false, reason: 'mongos' }
      // Before MongoDB 8.0 compact takes no dryRun — and a server that does not know the option may
      // simply run compact: never asked there (found by the 7.0 test), nor where the version is unknown.
      const build = await withMongo(() => client.db('admin').command({ buildInfo: 1 }))
      if (!versionAtLeast(build.version, 8)) return { available: false, reason: 'version' }
      try {
        const answer = await client.db(db).command({ compact: coll, dryRun: true })
        // An answer without the estimate is no dry run's: said as such.
        if (answer.estimatedBytesFreed === undefined) return { available: false, reason: 'version' }
        return { available: true, estimatedBytes: n(answer.estimatedBytesFreed) }
      } catch (e) {
        if (code(e) === 13) throw refused(e, 'compact')
        throw toAppError(e)
      }
    },
  )

  app.post(
    `${COLL}/compact`,
    { preHandler: admin, config: { masking: 'denied-when-ruled', audit: 'collections.compact' } },
    async (request) => {
      const { db, coll } = parseInput(CollParams, request.params)
      if (app.ctx.config.readOnly || request.connection!.readOnly) throw Errors.readOnly()
      const { confirm } = parseInput(CompactBodySchema, request.body ?? {})
      if (confirm !== coll) throw Errors.validation('Type the collection’s name to compact it')
      const client = await clientFor(request)
      if ((await kindOf(client, db, coll)) === 'timeseries')
        throw Errors.validation('A time series collection is not compacted here')
      try {
        // Final review Minor 2: MongoDB's own error, so a missing role is told as such.
        const answer = await client.db(db).command({ compact: coll })
        request.auditInfo = { details: { bytesFreed: n(answer.bytesFreed) } }
        return { bytesFreed: n(answer.bytesFreed) }
      } catch (e) {
        if (code(e) === 13) throw refused(e, 'compact')
        throw toAppError(e)
      }
    },
  )

  app.post(
    `${COLL}/shard-key-analysis`,
    { preHandler: requireConnection('documents:read'), config: { masking: 'denied-when-ruled' } },
    async (request): Promise<ShardKeyAnalysis> => {
      const { db, coll } = parseInput(CollParams, request.params)
      const { key } = parseInput(ShardKeyAnalysisBodySchema, request.body ?? {})
      const client = await clientFor(request)
      // A standalone server keeps no shard key statistics: said before asking.
      const hello = await withMongo(() => client.db('admin').command({ hello: 1 }))
      if (hello.msg !== 'isdbgrid' && typeof hello.setName !== 'string') {
        const build = await withMongo(() => client.db('admin').command({ buildInfo: 1 }))
        return versionAtLeast(build.version, 7)
          ? { available: false, reason: 'standalone' }
          : { available: false, reason: 'version' }
      }
      try {
        const answer = await client.db('admin').command(
          {
            analyzeShardKey: `${db}.${coll}`,
            key,
            keyCharacteristics: true,
            readWriteDistribution: false,
            sampleSize: SAMPLE_SIZE,
            // Final review Minor 13: MongoDB checks the connection's account, shared by the app's
            // users: the app bounds what one analysis may take.
            maxTimeMS: ANALYSIS_MS,
          },
          LENIENT,
        )
        return analysisOf(answer, key)
      } catch (e) {
        if (code(e) === 13) throw refused(e, 'analyzeShardKey')
        const reason = shardKeyRefusal(e)
        if (reason) return { available: false, reason }
        throw toAppError(e)
      }
    },
  )
}
