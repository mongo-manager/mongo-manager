// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Document, MongoClient } from 'mongodb'
import type { FieldHint, KeyHints, ShardCollectionInput, ShardKey, ZonesView } from '@mongo-manager/shared'
import { toWire } from '@mongo-manager/shared'
import { AppError, Errors } from '../errors'
import { toAppError } from '../data/mongo-errors'
import { fromClient } from '../data/ejson-io'

/**
 * W3.2: sharding management on a mongos — shard a collection, zones and their key ranges, the
 * balancer and its window. Commands are built from validated fields only; MongoDB's refusal is said
 * as MongoDB's, naming the command and the role it takes.
 */
const COMMAND_MS = 30_000
/** The key picker's sample: enough for a hint, small enough to read in seconds. */
export const HINT_SAMPLE = 1000
const MAX_RANGES = 1000
const MAX_SHARDS = 1000
const MONOTONIC_TYPES = new Set(['objectId', 'date', 'timestamp'])

const ROLE_FOR: Record<string, string> = {
  shardCollection: 'enableSharding or clusterManager',
  enableSharding: 'enableSharding or clusterManager',
  addShardToZone: 'clusterManager',
  removeShardFromZone: 'clusterManager',
  updateZoneKeyRange: 'clusterManager',
  balancerStart: 'clusterManager',
  balancerStop: 'clusterManager',
  activeWindow: 'clusterManager',
  keyHints: 'read on the collection',
}

/** MongoDB's answer, said as MongoDB's: a refusal names the command and the role it takes. */
export function shardingError(e: unknown, command: string): unknown {
  if ((e as { code?: unknown }).code === 13)
    return Errors.forbidden(
      `MongoDB refused ${command}: the connection's account needs ${ROLE_FOR[command] ?? 'more privileges'}`,
      { reason: 'mongo_not_permitted', command },
    )
  return toAppError(e)
}

async function admin(client: MongoClient, cmd: Document, name: string): Promise<Document> {
  try {
    return await client.db('admin').command(cmd, { timeoutMS: COMMAND_MS })
  } catch (e) {
    throw shardingError(e, name)
  }
}

/** A shard key in its given order (a Map: BSON keeps it, whatever the field names look like). */
export function keyDocument(key: ShardKey): Map<string, 1 | 'hashed'> {
  return new Map(key.map((f) => [f.field, f.kind === 'hashed' ? 'hashed' : 1] as const))
}

const ALREADY = new Set([23 /* AlreadyInitialized */, 59 /* CommandNotFound: 6.0+ needs none */])

export async function shardCollection(client: MongoClient, input: ShardCollectionInput): Promise<Document> {
  const db = input.ns.slice(0, input.ns.indexOf('.'))
  // Before 6.0 the database must be enabled first; later servers accept and ignore it.
  try {
    await client.db('admin').command({ enableSharding: db }, { timeoutMS: COMMAND_MS })
  } catch (e) {
    if (!ALREADY.has(Number((e as { code?: unknown }).code))) throw shardingError(e, 'enableSharding')
  }
  const cmd: Document = { shardCollection: input.ns, key: keyDocument(input.key), unique: input.unique }
  if (input.numInitialChunks !== undefined) cmd.numInitialChunks = input.numInitialChunks
  if (input.presplitHashedZones) cmd.presplitHashedZones = true
  const answer = await admin(client, cmd, 'shardCollection')
  return { ns: input.ns, sharded: answer.ok === 1 || answer.ok === true }
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Hints for a candidate shard key from a sample: how many distinct values each field has, how
 * often the most frequent one appears, whether it grows with insertion order, and whether an
 * index supports it. Counted inside MongoDB ($facet of $group stages): no value leaves it.
 */
export async function keyHints(client: MongoClient, ns: string, fields: string[]): Promise<KeyHints> {
  const dot = ns.indexOf('.')
  const coll = client.db(ns.slice(0, dot)).collection(ns.slice(dot + 1))
  const project: Document = {}
  fields.forEach((f, i) => (project[`f${i}`] = `$${f}`))
  const facet: Document = { total: [{ $count: 'n' }] }
  fields.forEach((_, i) => {
    facet[`f${i}`] = [
      { $match: { [`f${i}`]: { $exists: true } } },
      { $group: { _id: `$f${i}`, n: { $sum: 1 } } },
      { $group: { _id: null, distinct: { $sum: 1 }, top: { $max: '$n' }, present: { $sum: '$n' } } },
    ]
    facet[`t${i}`] = [
      { $group: { _id: { $type: `$f${i}` }, n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 3 },
    ]
  })
  const combinedId: Document = {}
  fields.forEach((_, i) => (combinedId[`f${i}`] = `$f${i}`))
  facet.combined = [
    { $group: { _id: combinedId, n: { $sum: 1 } } },
    { $group: { _id: null, distinct: { $sum: 1 }, top: { $max: '$n' } } },
  ]
  let result: Document
  let documents: number | null
  let indexes: Document[]
  try {
    ;[result] = (await coll
      .aggregate(
        [{ $sample: { size: HINT_SAMPLE } }, { $project: { _id: 0, ...project } }, { $facet: facet }],
        {
          maxTimeMS: COMMAND_MS,
          allowDiskUse: false,
        },
      )
      .toArray()) as [Document]
    documents = await coll.estimatedDocumentCount({ maxTimeMS: 5_000 }).catch(() => null)
    indexes = await coll.listIndexes().toArray()
  } catch (e) {
    throw shardingError(e, 'keyHints')
  }
  const sampled = num((result?.total as Document[] | undefined)?.[0]?.n)
  const hints: FieldHint[] = fields.map((field, i) => {
    const g = ((result?.[`f${i}`] as Document[] | undefined) ?? [])[0] ?? {}
    const types = ((result?.[`t${i}`] as Document[] | undefined) ?? []) as Document[]
    const dominant = types[0]?._id
    return {
      field,
      present: num(g.present),
      distinct: num(g.distinct),
      topShare: sampled ? Math.round((num(g.top) / sampled) * 1000) / 1000 : 0,
      monotonic: typeof dominant === 'string' && MONOTONIC_TYPES.has(dominant),
    }
  })
  const c = ((result?.combined as Document[] | undefined) ?? [])[0] ?? {}
  const combined = {
    distinct: num(c.distinct),
    topShare: sampled ? Math.round((num(c.top) / sampled) * 1000) / 1000 : 0,
  }
  const indexed = indexes.some((ix) => {
    const keys = Object.keys((ix.key ?? {}) as Document)
    return fields.every((f, i) => keys[i] === f)
  })
  let shardedKey: Record<string, number | string> | null = null
  try {
    const [meta] = await client
      .db('config')
      .collection('collections')
      .find({ _id: ns, dropped: { $ne: true } } as Document, { limit: 1 })
      .toArray()
    if (meta?.key && typeof meta.key === 'object') {
      shardedKey = {}
      for (const [k, v] of Object.entries(meta.key as Document).slice(0, 32))
        shardedKey[k.slice(0, 256)] = typeof v === 'string' ? v.slice(0, 16) : num(v)
    }
  } catch {
    // Not allowed to read config.collections: the hint simply does not say.
  }
  const ratio = sampled ? combined.distinct / sampled : 0
  const verdict: KeyHints['verdict'] =
    sampled === 0 || combined.distinct < 10 || combined.topShare >= 0.3
      ? 'poor'
      : ratio >= 0.5 && combined.topShare <= 0.05
        ? 'good'
        : 'fair'
  return { ns, sampled, documents, fields: hints, combined, indexed, shardedKey, verdict }
}

const str = (v: unknown, max = 256) => (typeof v === 'string' ? v.slice(0, max) : '')
const refusal = (e: unknown) => ((e as { code?: unknown }).code === 13 ? 'not_permitted' : 'error')

export async function zones(client: MongoClient): Promise<ZonesView> {
  const refused: ZonesView['refused'] = {}
  let shards: Document[] = []
  try {
    shards = (
      ((await client.db('admin').command({ listShards: 1 }, { timeoutMS: COMMAND_MS })).shards ??
        []) as Document[]
    ).slice(0, MAX_SHARDS)
  } catch (e) {
    refused.shards = refusal(e)
  }
  let ranges: Document[] = []
  try {
    ranges = await client
      .db('config')
      .collection('tags')
      .find({}, { limit: MAX_RANGES + 1, sort: { ns: 1, min: 1 } })
      .toArray()
  } catch (e) {
    refused.ranges = refusal(e)
  }
  const shardViews = shards.map((s) => ({
    id: str(s._id, 128),
    zones: (Array.isArray(s.tags) ? s.tags : []).slice(0, 100).map((t: unknown) => str(t, 64)),
  }))
  const names = new Set<string>()
  for (const s of shardViews) for (const z of s.zones) names.add(z)
  const rangeViews = ranges.slice(0, MAX_RANGES).map((r) => {
    names.add(str(r.tag, 64))
    return { ns: str(r.ns), min: toWire(r.min ?? {}), max: toWire(r.max ?? {}), zone: str(r.tag, 64) }
  })
  return {
    shards: shardViews,
    zones: [...names].filter(Boolean).sort(),
    ranges: rangeViews,
    more: ranges.length > MAX_RANGES,
    refused,
  }
}

export async function zoneShard(
  client: MongoClient,
  input: { shard: string; zone: string; action: 'add' | 'remove' },
): Promise<void> {
  const name = input.action === 'add' ? 'addShardToZone' : 'removeShardFromZone'
  await admin(client, { [name]: input.shard, zone: input.zone }, name)
}

/**
 * A zone bound as given: an object of shard key fields whose values are plain values or
 * MinKey/MaxKey — never an operator, which MongoDB would read as something else.
 */
export function parseBound(text: string, what: string): Document {
  let value: unknown
  try {
    value = fromClient(JSON.parse(text), what)
  } catch (e) {
    if (e instanceof AppError) throw e
    throw Errors.validation(`${what} is not valid Extended JSON`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw Errors.validation(`${what} must be an object of the shard key's fields`)
  const entries = Object.entries(value as Document)
  if (entries.length === 0 || entries.length > 32)
    throw Errors.validation(`${what} must name the shard key's fields`)
  for (const [field, v] of entries) {
    if (field.startsWith('$')) throw Errors.validation(`${what} cannot hold an operator`)
    if (
      v !== null &&
      typeof v === 'object' &&
      !('_bsontype' in (v as object)) &&
      !(v instanceof Date) &&
      Object.keys(v as object).some((k) => k.startsWith('$'))
    )
      throw Errors.validation(`${what} cannot hold an operator`)
  }
  return value as Document
}

export async function zoneRange(
  client: MongoClient,
  input: { ns: string; min: string; max: string; zone: string | null },
): Promise<void> {
  const min = parseBound(input.min, 'The lower bound')
  const max = parseBound(input.max, 'The upper bound')
  await admin(client, { updateZoneKeyRange: input.ns, min, max, zone: input.zone }, 'updateZoneKeyRange')
}

export async function balancer(client: MongoClient, action: 'start' | 'stop'): Promise<void> {
  const name = action === 'start' ? 'balancerStart' : 'balancerStop'
  await admin(client, { [name]: 1, maxTimeMS: COMMAND_MS }, name)
}

/** The balancer's active window lives in config.settings, as sh.setBalancerState's companions write it. */
export async function balancerWindow(
  client: MongoClient,
  window: { start: string; stop: string } | null,
): Promise<void> {
  try {
    await client
      .db('config')
      .collection('settings')
      .updateOne(
        { _id: 'balancer' } as Document,
        window
          ? { $set: { activeWindow: { start: window.start, stop: window.stop } } }
          : { $unset: { activeWindow: '' } },
        { upsert: true, timeoutMS: COMMAND_MS },
      )
  } catch (e) {
    throw shardingError(e, 'activeWindow')
  }
}
