import type { FastifyRequest } from 'fastify'
import type { Document, MongoClient } from 'mongodb'
import { clientFor } from '../data/mongo-errors'
import { maskerFor } from './request'
import { IndexListingFailed, notSupported, type GateDeps } from './gate'
import { newCtx } from './gate/context'
import { sourceShape } from './gate/pipeline'
import { nsMaskerFrom, type Masker, type NsMasker, type Pattern } from './match'

/** View definitions and index lists one request may read for the gate. */
const MAX_LOOKUPS = 100

/**
 * Phase 3c: what the gate reads for this request, or null when nothing is hidden from the caller.
 * View definitions and index lists are read at most once per namespace and request.
 */
export function gateFor(request: FastifyRequest, client: MongoClient): GateDeps | null {
  const masker = maskerFor(request)
  return masker ? gateDepsFor(masker, client) : null
}

/** The gate's lookups for one masker and client: a request's, or a job's (phase 3d-1). */
export function gateDepsFor(
  masker: Masker,
  client: MongoClient,
  /** A job's comment (a cancel kills its listings) and the time it has left (next round, M-E). */
  budget: { comment?: string; timeLeft?: () => number } = {},
): GateDeps {
  const infos = new Map<string, Promise<Document | undefined>>()
  const indexes = new Map<string, Promise<Document[]>>()
  const unread = new Map<string, unknown>()
  const once = <T>(cache: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> => {
    let hit = cache.get(key)
    if (!hit) {
      if (cache.size >= MAX_LOOKUPS) throw notSupported('A query this complex', key)
      hit = read()
      cache.set(key, hit)
    }
    return hit
  }
  /** A listing's time limit and comment: the job's where it has one (next round, M-E). */
  const listing = () => ({
    maxTimeMS: Math.max(1, Math.min(LISTING_MS, budget.timeLeft?.() ?? LISTING_MS)),
    ...(budget.comment ? { comment: budget.comment } : {}),
  })
  // One listing per namespace, read for its view definition and its kind. A failure is read again
  // next time, and is the writer's to stop on, as an index listing's (next round, M-2). An
  // unauthorized one (13) too: a database's catalog is one right for all its collections, where an
  // index listing's 13 is that collection's, refused as a right (write.ts denied()).
  const infoOf = (db: string, coll: string) =>
    once(infos, `${db}.${coll}`, async () => {
      try {
        const [info] = await client
          .db(db)
          .listCollections({ name: coll }, { nameOnly: false, ...listing() })
          .toArray()
        return info as Document | undefined
      } catch (e) {
        infos.delete(`${db}.${coll}`)
        throw new IndexListingFailed(e, 'catalog')
      }
    })
  return {
    masker,
    view: async (db, coll) => {
      const info = await infoOf(db, coll)
      if (info?.type !== 'view') return null
      const options = (info.options ?? {}) as { viewOn?: unknown; pipeline?: unknown; collation?: unknown }
      return {
        viewOn: String(options.viewOn),
        pipeline: Array.isArray(options.pipeline) ? (options.pipeline as Document[]) : [],
        // Fourteenth review of explain masking (I-1): what every read of it compares with.
        ...(options.collation && typeof options.collation === 'object'
          ? { collation: options.collation as Document }
          : {}),
      }
    },
    kind: async (db, coll) => {
      const info = await infoOf(db, coll)
      if (!info) return 'missing'
      return info.type === 'view' ? 'view' : info.type === 'timeseries' ? 'timeseries' : 'collection'
    },
    storage: async (db, coll) => {
      const info = await infoOf(db, coll)
      if (!info) return null
      const options = (info.options ?? {}) as {
        clusteredIndex?: unknown
        timeseries?: Document
        collation?: unknown
      }
      const series = options.timeseries
      return {
        clustered: Boolean(options.clusteredIndex),
        // Sixteenth review of explain masking (I-2): what its pipelines' joins compare with.
        ...(options.collation && typeof options.collation === 'object'
          ? { collation: options.collation as Document }
          : {}),
        ...(series && typeof series.timeField === 'string'
          ? {
              timeseries: {
                timeField: series.timeField,
                ...(typeof series.metaField === 'string' ? { metaField: series.metaField } : {}),
              },
            }
          : {}),
      }
    },
    // Final reviews of the agent's gate (M-4, M-2, and the next review's M-1, M-2): a failed listing
    // answers none for now, keeps its error for a write to say, and is read again next time (one
    // failure must not last a job); a namespace that does not exist, or a view, has none: kept as the
    // answer (NamespaceNotFound 26, CommandNotSupportedOnView 166).
    indexes: (db, coll) => {
      const key = `${db}.${coll}`
      return once(indexes, key, () =>
        client
          .db(db)
          .collection(coll)
          .listIndexes(listing())
          .toArray()
          .then((list) => {
            unread.delete(key)
            return list
          })
          .catch((e: unknown) => {
            if (NO_INDEXES.has((e as { code?: unknown } | null)?.code as number)) {
              unread.delete(key)
              return []
            }
            unread.set(key, e)
            indexes.delete(key)
            return []
          }),
      )
    },
    indexesUnread: (db, coll) => unread.has(`${db}.${coll}`),
    indexesFailure: (db, coll) => unread.get(`${db}.${coll}`),
  }
}

/** A namespace with no index list of its own: it does not exist, or it is a view. */
const NO_INDEXES = new Set([26, 166])
/** How long an index listing may take (a slow one is a job's failure, as any read). */
const LISTING_MS = 30_000

/** Everything is personal: what cannot be resolved is masked whole (in doubt, mask). */
const EVERYTHING: readonly Pattern[] = [['**']]

/**
 * A masker whose rules for the given namespaces follow views to what they read (final review I3):
 * a definition, a saved query or a command on a view is masked by its source's rules. A namespace
 * that cannot be resolved (a closed view, a system collection, too many lookups) is masked whole.
 */
export async function viewAwareMasker(
  masker: Masker,
  /** A factory gives each namespace its own lookups (a backup's many: fifteenth review, I-1). */
  deps: GateDeps | (() => GateDeps),
  namespaces: ReadonlyArray<readonly [string, string]>,
): Promise<Masker> {
  const resolved = new Map<string, NsMasker>()
  for (const [db, coll] of namespaces) {
    const key = JSON.stringify([db, coll])
    if (resolved.has(key)) continue
    let patterns: readonly Pattern[]
    try {
      const own = typeof deps === 'function' ? deps() : deps
      patterns = (await sourceShape(db, coll, newCtx(own, db))).list()
    } catch {
      // Refused (a closed view, a system collection), unreadable or too many lookups: in doubt, mask.
      patterns = EVERYTHING
    }
    resolved.set(key, nsMaskerFrom(patterns))
  }
  return {
    anyRules: masker.anyRules,
    anyInDb: (db) => masker.anyInDb(db),
    forNs: (db, coll) => resolved.get(JSON.stringify([db, coll])) ?? masker.forNs(db, coll),
  }
}

/** "db.coll" strings as [db, coll] pairs, distinct, without namespaces that name no collection. */
export function namespacePairs(namespaces: readonly string[]): Array<readonly [string, string]> {
  const out = new Map<string, readonly [string, string]>()
  for (const ns of namespaces) {
    const dot = ns.indexOf('.')
    if (dot > 0 && dot < ns.length - 1) out.set(ns, [ns.slice(0, dot), ns.slice(dot + 1)])
  }
  return [...out.values()]
}

/** The view-aware masker of this request for these namespaces, or null when nothing is hidden. */
export async function viewAwareMaskerFor(
  request: FastifyRequest,
  namespaces: ReadonlyArray<readonly [string, string]>,
): Promise<Masker | null> {
  const masker = maskerFor(request)
  if (!masker || namespaces.length === 0) return masker
  const deps = gateFor(request, await clientFor(request))!
  return viewAwareMasker(masker, deps, namespaces)
}

/** The part of a cache key that tells masked results from full ones (phase 3c §4.8). */
export function viewKey(request: FastifyRequest): string {
  if (!maskerFor(request)) return 'full'
  return `masked:${request.server.ctx.personalFields.get(request.connection!.id).version}`
}
