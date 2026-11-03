import type { Document, MongoClient } from 'mongodb'
import type { IndexAdvice } from '@mongo-manager/shared'
import { suggestIndex } from '../explain/suggest'
import { collectSlow, collOf, isOwnEntry, type RawSlow } from './slow-queries'
import { isAdminOnlyNamespace } from '../connections/access'

/** Phase 3b spec §6a. */
export const MAX_ADVICE_ENTRIES = 1000
export const MAX_SUGGESTIONS = 20
export const MAX_UNNEEDED = 200
const MAX_KEY_FIELDS = 32
const MAX_NAME_BYTES = 256
/** Documents read per document returned above which a query "scans". */
const SCAN_RATIO = 100

/** What the unneeded-index notes must know of an index: the options that make it not redundant. */
export type IndexInfo = {
  name: string
  key: Document
  unique?: boolean
  expireAfterSeconds?: number
  partialFilterExpression?: Document
  sparse?: boolean
  hidden?: boolean
  collation?: Document
}

/** A query that scanned: a collection scan, or far more documents read than returned. */
const scanned = (e: RawSlow): boolean =>
  (e.planSummary ?? '').includes('COLLSCAN') ||
  (e.docsExamined ?? 0) > SCAN_RATIO * Math.max(1, e.nreturned ?? 0)

const doc = (v: unknown): Document | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Document) : undefined

/** The filter, sort or pipeline a command ran, for suggestIndex; null for anything else. */
function queryOf(
  command: Document | null,
): { filter?: Document; sort?: Document; stages?: Document[] } | null {
  if (!command) return null
  const name = Object.keys(command)[0]
  switch (name) {
    case 'find':
    case 'findAndModify':
    case 'findandmodify': {
      const filter = doc(command.filter ?? command.query)
      const sort = doc(command.sort)
      return { ...(filter ? { filter } : {}), ...(sort ? { sort } : {}) }
    }
    case 'count':
    case 'distinct': {
      const filter = doc(command.query)
      return filter ? { filter } : {}
    }
    case 'aggregate':
      return Array.isArray(command.pipeline) ? { stages: command.pipeline as Document[] } : null
    case 'q': {
      const filter = doc(command.q)
      return filter ? { filter } : null
    }
    default:
      return null
  }
}

const bytes = (s: string) => Buffer.byteLength(s)
const nameOk = (s: string) => bytes(s) <= MAX_NAME_BYTES

/**
 * An entry that can get a suggestion: it scanned, names a user collection (system collections scan
 * by design) and is the user's query (mongo-manager's own reads are not).
 */
const suggestible = (e: RawSlow): boolean =>
  scanned(e) &&
  nameOk(e.ns) &&
  !collOf(e.ns).startsWith('system.') &&
  !isOwnEntry(e) &&
  queryOf(e.command) !== null

/** Index use by name, added up across shards: a mongos answers one document per shard (final review I3). */
export function usageFrom(stats: readonly Document[]): Map<string, number> {
  const usage = new Map<string, number>()
  for (const s of stats) {
    const ops = Number((s.accesses as Document | undefined)?.ops ?? 0)
    usage.set(String(s.name), (usage.get(String(s.name)) ?? 0) + (Number.isFinite(ops) ? ops : 0))
  }
  return usage
}

/**
 * Index advice gaps (2026-10-27): an index of plain keys (ascending, descending, hashed) serves a
 * prefix of itself; a text, geospatial or wildcard one does not (it leaves documents out, or needs
 * its own operator).
 */
const plainKeys = (index: IndexInfo): boolean =>
  Object.entries(index.key).every(([f, d]) => !f.includes('$**') && (typeof d === 'number' || d === 'hashed'))

/** A longer index serves every query the shorter one does only when nothing narrows it (final review I2). */
const fullyServes = (longer: IndexInfo, shorter: IndexInfo): boolean =>
  plainKeys(longer) &&
  !longer.partialFilterExpression &&
  longer.sparse !== true &&
  longer.hidden !== true &&
  JSON.stringify(longer.collation ?? null) === JSON.stringify(shorter.collation ?? null)

/**
 * Suggestions by the ESR rule for the queries that scanned (grouped by namespace and key, ranked by
 * the time they cost), and notes on indexes that may be unneeded. Only field names and index names
 * leave this function — never a value from a query. With `known`, only namespaces whose indexes
 * were read get a suggestion: without the list, an existing index would be suggested again
 * (final review I1). Pure.
 */
export function adviceFrom(
  entries: readonly RawSlow[],
  indexes: ReadonlyMap<string, readonly IndexInfo[]>,
  usage: ReadonlyMap<string, ReadonlyMap<string, number>>,
  known?: ReadonlySet<string>,
  /** Index sizes by namespace; null where they are hidden from the caller (rules there). */
  sizes?: ReadonlyMap<string, ReadonlyMap<string, number> | null>,
): Omit<IndexAdvice, 'refused' | 'skipped'> {
  type Group = IndexAdvice['suggestions'][number] & { ratios: number[] }
  const groups = new Map<string, Group>()
  for (const e of entries) {
    if (!suggestible(e) || (known && !known.has(e.ns))) continue
    let suggestion: ReturnType<typeof suggestIndex>
    try {
      suggestion = suggestIndex(
        queryOf(e.command)!,
        (indexes.get(e.ns) ?? []).map((i) => ({ key: i.key })),
      )
    } catch {
      continue
    }
    if (!suggestion || suggestion.key.length > MAX_KEY_FIELDS || !suggestion.key.every(([f]) => nameOk(f)))
      continue
    const id = JSON.stringify([e.ns, suggestion.key])
    const group =
      groups.get(id) ??
      ({
        ns: e.ns,
        key: suggestion.key,
        count: 0,
        totalMs: 0,
        avgMs: 0,
        ratio: null,
        reason: {
          equality: suggestion.reason.equality,
          sort: suggestion.reason.sort,
          range: suggestion.reason.range,
        },
        ratios: [],
      } satisfies Group)
    group.count++
    group.totalMs += e.durationMs
    if (e.docsExamined !== undefined) group.ratios.push(e.docsExamined / Math.max(1, e.nreturned ?? 0))
    groups.set(id, group)
  }
  const suggestions = [...groups.values()]
    .map(({ ratios, ...g }) => ({
      ...g,
      avgMs: Math.round(g.totalMs / g.count),
      ratio: ratios.length ? Math.round(ratios.reduce((a, b) => a + b, 0) / ratios.length) : null,
    }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, MAX_SUGGESTIONS)

  const unneeded: IndexAdvice['unneeded'] = []
  for (const [ns, list] of indexes) {
    // MongoDB's own collections keep the indexes they need (config.system.sessions' TTL, …).
    if (collOf(ns).startsWith('system.')) continue
    for (const index of list) {
      // _id and unique indexes enforce something; a TTL index deletes documents (work $indexStats
      // does not count); a hidden one is kept on purpose (final review I2).
      if (index.name === '_id_' || index.unique === true) continue
      if (index.expireAfterSeconds !== undefined || index.hidden === true) continue
      const entries = Object.entries(index.key)
      // Index advice gaps (2026-10-27): the same key too, where the other serves it whole.
      const longer = list.find((other) => {
        if (other === index || !fullyServes(other, index)) return false
        const o = Object.entries(other.key)
        return o.length >= entries.length && entries.every(([f, d], i) => o[i]?.[0] === f && o[i]?.[1] === d)
      })
      const ops = usage.get(ns)?.get(index.name) ?? null
      const sizeBytes = sizes?.get(ns)?.get(index.name) ?? null
      // Final review Minor 17: hidden (personal data rules), told apart from not known.
      const about = {
        ns,
        name: index.name,
        key: index.key,
        ...(sizes?.get(ns) === null ? { sizeHidden: true as const } : {}),
      }
      if (longer)
        unneeded.push({
          ...about,
          reason: Object.keys(longer.key).length === entries.length ? 'duplicate' : 'prefix',
          of: longer.name,
          ops,
          sizeBytes,
        })
      else if (ops === 0) unneeded.push({ ...about, reason: 'unused', ops, sizeBytes })
    }
  }
  return {
    suggestions,
    unneeded: unneeded.slice(0, MAX_UNNEEDED),
    moreUnneeded: Math.max(0, unneeded.length - MAX_UNNEEDED),
  }
}

/** Index advice gaps (2026-10-27): the collections whose indexes are read, and how many at once. */
export const MAX_ADVICE_COLLECTIONS = 200
const READ_AT_ONCE = 8

/**
 * Final review I6: the collections whose indexes are read — those the slow queries touched first
 * (their suggestions need them), then the others by name, up to `max`.
 */
export function collectionsToRead(names: readonly string[], slow: readonly string[], max: number): string[] {
  const known = new Set(names)
  const first = [...new Set(slow)].filter((n) => known.has(n))
  const rest = names.filter((n) => !first.includes(n))
  return [...first, ...rest].slice(0, max)
}

/** Index sizes by name, added up across shards (a mongos answers one document per shard). */
export function sizesFrom(stats: readonly Document[]): Map<string, number> {
  const sizes = new Map<string, number>()
  for (const s of stats)
    for (const [name, bytes] of Object.entries(
      ((s.storageStats as Document | undefined)?.indexSizes ?? {}) as Document,
    )) {
      const n = Number(bytes)
      if (Number.isFinite(n)) sizes.set(name, (sizes.get(name) ?? 0) + n)
    }
  return sizes
}

/**
 * Reads the slow queries of `db`, then every collection's indexes, their use and their sizes (at most
 * 200 collections, by name; index advice gaps 2026-10-27: not only those slow queries touched).
 * `sizesHidden(coll)`: the caller may not know its sizes (personal data rules there).
 */
export async function gatherAdvice(
  client: MongoClient,
  db: string,
  admin: boolean,
  sizesHidden: (coll: string) => boolean = () => false,
): Promise<IndexAdvice> {
  const { raw, refused } = await collectSlow(client, { db, source: 'both' }, MAX_ADVICE_ENTRIES, admin)
  const entries = raw.slice(0, MAX_ADVICE_ENTRIES)
  const indexes = new Map<string, IndexInfo[]>()
  const usage = new Map<string, Map<string, number>>()
  const sizes = new Map<string, Map<string, number> | null>()
  let indexRefusal: string | undefined
  let names: string[] = []
  try {
    names = (
      await client
        .db(db)
        .listCollections(
          { type: { $in: ['collection', 'timeseries'] } },
          { nameOnly: true, authorizedCollections: true },
        )
        .toArray()
    )
      .map((c) => String(c.name))
      // Final review I1: what only a connection's admins may read (credentials, key material) is
      // never read for anyone else.
      .filter(
        (n) => !n.startsWith('system.') && nameOk(`${db}.${n}`) && (admin || !isAdminOnlyNamespace(db, n)),
      )
      .sort()
  } catch (e) {
    indexRefusal = (e as { code?: unknown }).code === 13 ? 'not_permitted' : 'error'
  }
  const read = collectionsToRead(
    names,
    entries.map((e) => collOf(e.ns)),
    MAX_ADVICE_COLLECTIONS,
  )
  const one = async (name: string) => {
    const ns = `${db}.${name}`
    const coll = client.db(db).collection(name)
    try {
      indexes.set(ns, (await coll.listIndexes().toArray()).map(indexInfo))
    } catch (e) {
      indexRefusal = (e as { code?: unknown }).code === 13 ? 'not_permitted' : 'error'
      return
    }
    try {
      usage.set(ns, usageFrom(await coll.aggregate([{ $indexStats: {} }]).toArray()))
    } catch {
      // Without usage figures an index is never called unused.
    }
    if (sizesHidden(name)) sizes.set(ns, null)
    else
      try {
        sizes.set(ns, sizesFrom(await coll.aggregate([{ $collStats: { storageStats: {} } }]).toArray()))
      } catch {
        // Its sizes stay unknown.
      }
  }
  for (let i = 0; i < read.length; i += READ_AT_ONCE)
    await Promise.all(read.slice(i, i + READ_AT_ONCE).map(one))
  return {
    ...adviceFrom(entries, indexes, usage, new Set(indexes.keys()), sizes),
    skipped: names.length - read.length,
    refused: { ...refused, ...(indexRefusal ? { indexes: indexRefusal } : {}) },
  }
}

/** The options an index is kept for, as listIndexes answers them. */
const indexInfo = (i: Document): IndexInfo => ({
  name: String(i.name),
  key: (i.key ?? {}) as Document,
  unique: i.unique === true,
  ...(typeof i.expireAfterSeconds === 'number' ? { expireAfterSeconds: i.expireAfterSeconds } : {}),
  ...(doc(i.partialFilterExpression) ? { partialFilterExpression: doc(i.partialFilterExpression) } : {}),
  ...(i.sparse === true ? { sparse: true } : {}),
  ...(i.hidden === true ? { hidden: true } : {}),
  ...(doc(i.collation) ? { collation: doc(i.collation) } : {}),
})
