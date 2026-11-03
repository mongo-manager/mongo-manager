import type { Document, MongoClient } from 'mongodb'
import type { ShardingDetail, ShardingView } from '@mongo-manager/shared'
import { redactUris } from '../connections/errors'
import { toClient } from '../data/ejson-io'
import { MASK, maskDocument, type Masker } from '../masking'

/** Phase 3b spec §5. */
export const MAX_SHARDED_COLLECTIONS = 500
export const MAX_JUMBO = 20
const MAX_MONGOS = 100
/** Bounds on what hostile or odd config documents can make the answer carry (final review M6). */
const MAX_SHARDS = 1000
const MAX_TAGS = 50
const MAX_KEY_FIELDS = 32
/** A mongos that has not pinged the config servers for this long is shown as stale. */
const STALE_PING_MS = 60_000

const refusal = (e: unknown): string => ((e as { code?: unknown }).code === 13 ? 'not_permitted' : 'error')
const str = (v: unknown, max = 256): string => (typeof v === 'string' ? v.slice(0, max) : '')
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** How a chunk group names its collection: a UUID as EJSON text, whatever class the driver used. */
const uuidKey = (v: unknown): string | null =>
  v === undefined || v === null ? null : JSON.stringify(toClient(v))
/**
 * A host list without credentials: connection strings, and bare user:password@ in a host
 * (final review M4).
 */
const hostText = (v: unknown, max = 2048): string => redactUris(str(v, max)).replace(/[^\s/@,]+@/g, '')

/** What the gathering read, each part possibly missing (refused). */
export interface ShardingRaw {
  shards: Document[] | null
  balancer: Document | null
  balancerSettings: Document | null
  mongos: Document[] | null
  collections: Document[] | null
  chunks: Document[] | null
}

/** The overview from what MongoDB answered: counts, spreads and stale pings. Pure. */
export function shardingView(raw: ShardingRaw, refused: ShardingView['refused'], now: number): ShardingView {
  const perCollection = new Map<string, Map<string, { n: number; jumbo: number }>>()
  for (const group of raw.chunks ?? []) {
    const id = group._id as Document | undefined
    if (!id) continue
    const coll = uuidKey(id.uuid)
    if (coll === null) continue
    const shard = str(id.shard)
    const byShard = perCollection.get(coll) ?? new Map<string, { n: number; jumbo: number }>()
    byShard.set(shard, { n: num(group.n) ?? 0, jumbo: num(group.jumbo) ?? 0 })
    perCollection.set(coll, byShard)
  }
  const shardDocs = (raw.shards ?? []).slice(0, MAX_SHARDS)
  const shardIds = shardDocs.map((s) => str(s._id))
  const collections = (raw.collections ?? []).slice(0, MAX_SHARDED_COLLECTIONS).map((c) => {
    // A collection without a UUID has no chunks it can be matched with.
    const uuid = uuidKey(c.uuid)
    const byShard =
      (uuid === null ? undefined : perCollection.get(uuid)) ?? new Map<string, { n: number; jumbo: number }>()
    const chunks: Record<string, number> = {}
    for (const [shard, v] of byShard) chunks[shard] = v.n
    const counts = (shardIds.length ? shardIds : [...byShard.keys()]).map((s) => chunks[s] ?? 0)
    const key: Record<string, number | string> = {}
    for (const [field, dir] of Object.entries((c.key as Document | undefined) ?? {}).slice(0, MAX_KEY_FIELDS))
      key[str(field)] = typeof dir === 'string' ? dir.slice(0, 32) : (num(dir) ?? 1)
    return {
      ns: str(c._id),
      key,
      unique: c.unique === true,
      balancing: c.noBalance !== true,
      chunks,
      imbalance: counts.length ? Math.max(...counts) - Math.min(...counts) : 0,
      jumbo: [...byShard.values()].reduce((sum, v) => sum + v.jumbo, 0),
    }
  })
  const shards = shardDocs.map((s) => {
    const id = str(s._id)
    let colls = 0
    let chunks = 0
    for (const byShard of perCollection.values()) {
      const v = byShard.get(id)
      if (v && v.n > 0) {
        colls++
        chunks += v.n
      }
    }
    return {
      id,
      hosts: hostText(s.host),
      draining: s.draining === true,
      tags: Array.isArray(s.tags) ? s.tags.slice(0, MAX_TAGS).map((t: unknown) => str(t, 64)) : [],
      collections: colls,
      chunks,
    }
  })
  const window = (raw.balancerSettings?.activeWindow ?? null) as Document | null
  const balancer = raw.balancer
    ? {
        mode: str(raw.balancer.mode, 32) || 'unknown',
        inRound: raw.balancer.inBalancerRound === true,
        rounds: num(raw.balancer.numBalancerRounds),
        window: window ? { start: str(window.start, 16), stop: str(window.stop, 16) } : null,
      }
    : null
  const mongos = (raw.mongos ?? []).slice(0, MAX_MONGOS).map((m) => {
    const ping = m.ping instanceof Date ? m.ping : null
    return {
      host: hostText(m._id, 256),
      version: str(m.mongoVersion, 32) || null,
      upSeconds: num(m.up),
      ping: ping ? ping.toISOString() : null,
      stale: !ping || now - ping.getTime() > STALE_PING_MS,
    }
  })
  return {
    shards,
    balancer,
    mongos,
    collections,
    more: (raw.collections?.length ?? 0) > MAX_SHARDED_COLLECTIONS,
    refused,
  }
}

/**
 * A chunk bound as config.chunks stores it: one key per shard-key field, named by its whole path
 * ("customer.email"). Each key is matched as that path; a personal one's value is masked whole
 * (final review C1: a dotted key is not a nested document).
 */
function maskBound(bound: unknown, masker: Masker, db: string, coll: string): unknown {
  const ns = masker.forNs(db, coll)
  if (!ns.any) return bound
  if (typeof bound !== 'object' || bound === null || Array.isArray(bound)) return MASK
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const [key, value] of Object.entries(bound)) {
    const path = key.split('.')
    out[key] = ns.matches(path) || ns.under(path) ? MASK : maskDocument(value, ns, path)
  }
  return out
}

/** Runs one part; a refusal is noted and the rest goes on. */
async function part<T>(
  refused: Record<string, string>,
  name: string,
  read: () => Promise<T>,
): Promise<T | null> {
  try {
    return await read()
  } catch (e) {
    refused[name] = refusal(e)
    return null
  }
}

/** Reads the overview from a mongos. Each part is read on its own. */
export async function gatherSharding(
  client: MongoClient,
  ns: string | undefined,
  now: number,
): Promise<ShardingView> {
  const admin = client.db('admin')
  const config = client.db('config')
  const refused: Record<string, string> = {}
  const shards = await part(
    refused,
    'shards',
    async () => ((await admin.command({ listShards: 1 })).shards ?? []) as Document[],
  )
  const balancer = await part(refused, 'balancer', () => admin.command({ balancerStatus: 1 }))
  const settings = balancer
    ? await part(refused, 'balancer', async () => {
        const [doc] = await config
          .collection('settings')
          .find({ _id: 'balancer' } as Document)
          .toArray()
        return doc ?? null
      })
    : null
  const mongos = await part(refused, 'mongos', () =>
    config
      .collection('mongos')
      .find({}, { limit: MAX_MONGOS, sort: { _id: 1 } })
      .toArray(),
  )
  const filter: Document = { dropped: { $ne: true } }
  if (ns) filter._id = { $regex: `^${escapeRegex(ns)}(\\.|$)` }
  const collections = await part(refused, 'collections', () =>
    config
      .collection('collections')
      .find(filter, { limit: MAX_SHARDED_COLLECTIONS + 1, sort: { _id: 1 } })
      .toArray(),
  )
  const uuids = (collections ?? []).slice(0, MAX_SHARDED_COLLECTIONS).map((c) => c.uuid)
  const chunks =
    uuids.length === 0
      ? []
      : await part(refused, 'chunks', () =>
          config
            .collection('chunks')
            .aggregate([
              { $match: { uuid: { $in: uuids } } },
              {
                $group: {
                  _id: { uuid: '$uuid', shard: '$shard' },
                  n: { $sum: 1 },
                  jumbo: { $sum: { $cond: [{ $eq: ['$jumbo', true] }, 1, 0] } },
                },
              },
            ])
            .toArray(),
        )
  return shardingView(
    { shards, balancer, balancerSettings: settings, mongos, collections, chunks },
    refused,
    now,
  )
}

/** One collection on demand: its size per shard, and at most 20 jumbo chunks (bounds masked). */
export async function gatherShardingDetail(
  client: MongoClient,
  ns: string,
  masker: Masker | null,
): Promise<ShardingDetail> {
  const dot = ns.indexOf('.')
  const db = ns.slice(0, dot)
  const coll = ns.slice(dot + 1)
  const refused: Record<string, string> = {}
  // A sharded time-series collection's chunks belong to system.buckets.<name>: its rules are the
  // view's (final review C1).
  const ruleColl = coll.startsWith('system.buckets.') ? coll.slice('system.buckets.'.length) : coll
  const sizesHidden = masker?.forNs(db, ruleColl).any === true
  /** Rules apply here: the jumbo chunks listed are a random few. */
  const ruled = sizesHidden
  const stats = await part(refused, 'stats', () =>
    client
      .db(db)
      .collection(coll)
      .aggregate([{ $collStats: { storageStats: {} } }])
      .toArray(),
  )
  const jumbo = await part(refused, 'jumbo', async () => {
    const [meta] = await client
      .db('config')
      .collection('collections')
      .find({ _id: ns } as Document)
      .toArray()
    if (!meta) return []
    const chunks = client.db('config').collection('chunks')
    const match = { uuid: meta.uuid, jumbo: true }
    const projection = { shard: 1, min: 1, max: 1 }
    // Twelfth and thirteenth reviews of explain masking (M-4, M-1): the chunks' index is by their
    // bounds, and so, mostly, are their _ids; where rules apply, the ones listed are a random few.
    return ruled
      ? chunks
          .aggregate([{ $match: match }, { $sample: { size: MAX_JUMBO } }, { $project: projection }])
          .toArray()
      : chunks.find(match, { limit: MAX_JUMBO, projection }).toArray()
  })
  const bound = (v: unknown) => {
    const shown = toClient(v)
    return masker ? maskBound(shown, masker, db, ruleColl) : shown
  }
  return {
    ns,
    shards: (stats ?? []).map((s) => {
      const storage = (s.storageStats ?? {}) as Document
      // Twelfth review of explain masking (I3): a size tells the length of what rules hide.
      const size = sizesHidden ? null : num(storage.size)
      return { shard: str(s.shard), size, count: num(storage.count) }
    }),
    jumbo: (jumbo ?? [])
      .slice(0, MAX_JUMBO)
      .map((c) => ({ shard: str(c.shard), min: bound(c.min), max: bound(c.max) })),
    refused,
    ...(sizesHidden ? { sizesHidden: true as const } : {}),
  }
}
