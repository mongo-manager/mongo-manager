// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { MongoClient } from 'mongodb'
import type { AuditAction } from '@mongo-manager/shared'
import {
  BalancerActionSchema,
  BalancerWindowSchema,
  KeyHintsQuerySchema,
  ShardCollectionSchema,
  ShardingDetailQuerySchema,
  ShardingQuerySchema,
  ZoneRangeSchema,
  ZoneShardSchema,
} from '@mongo-manager/shared'
import { Errors } from '../../errors'
import { parseInput } from '../../validate'
import {
  CREDENTIAL_COLLECTIONS,
  isAdminOnlyNamespace,
  isEncryptionNamespace,
  SYSTEM_DATABASES,
  isRestricted,
  requireConnection,
} from '../../connections/access'
import { clientFor, withMongo } from '../../data/mongo-errors'
import { maskerFor } from '../../masking/request'
import { notSupported } from '../../masking/gate/refusal'
import { gatherSharding, gatherShardingDetail } from '../../monitor/sharding'
import {
  balancer,
  balancerWindow,
  keyHints,
  shardCollection,
  zoneRange,
  zoneShard,
  zones,
} from '../../sharding/admin'

/** The overview needs a mongos; anything else answers not_sharded (the replica panel explains it). */
async function mongosClient(request: FastifyRequest): Promise<MongoClient> {
  const client = await clientFor(request)
  const hello = await withMongo(() => client.db('admin').command({ hello: 1 }))
  if (hello.msg !== 'isdbgrid')
    throw Errors.conflict('This server is not a mongos', { reason: 'not_sharded' })
  return client
}

/** W3.2: MongoDB's own and system namespaces are never sharded from here. */
function assertShardable(ns: string): void {
  const dot = ns.indexOf('.')
  const db = ns.slice(0, dot)
  const coll = ns.slice(dot + 1)
  if (
    SYSTEM_DATABASES.has(db) ||
    coll.startsWith('system.') ||
    CREDENTIAL_COLLECTIONS.has(coll) ||
    isEncryptionNamespace(db, coll)
  )
    throw Errors.forbidden('System namespaces cannot be sharded here', { reason: 'system_namespace' })
}

/**
 * Phase 3b spec §5: a read-only overview of a sharded cluster — shards, the balancer, the mongos
 * routers and the sharded collections — and one collection's detail on demand. W3.2 adds the
 * changes (databases:admin): shard a collection with the key picker's hints, zones and their key
 * ranges, the balancer and its window. Restricted users never reach them; a read-only connection
 * shows but changes nothing; each change is audited.
 */
export async function shardingRoutes(app: FastifyInstance): Promise<void> {
  const base = '/connections/:id/server/sharding'
  const monitor = requireConnection('server:monitor')

  app.get(base, { preHandler: monitor, config: { masking: 'names-only' } }, async (request) => {
    const { ns } = parseInput(ShardingQuerySchema, request.query ?? {})
    return gatherSharding(await mongosClient(request), ns, app.ctx.now())
  })

  app.get(`${base}/detail`, { preHandler: monitor, config: { masking: 'guarded' } }, async (request) => {
    const { ns } = parseInput(ShardingDetailQuerySchema, request.query ?? {})
    // The namespace comes from the query, so the connection guard's system-namespace check does
    // not see it: credential collections are for connection admins (final review M5).
    const nsDb = ns.slice(0, Math.max(0, ns.indexOf('.')))
    const coll = ns.slice(ns.indexOf('.') + 1)
    if (request.connectionRole !== 'admin' && isAdminOnlyNamespace(nsDb, coll))
      throw Errors.forbidden('System namespaces are restricted to connection admins')
    return gatherShardingDetail(await mongosClient(request), ns, maskerFor(request))
  })

  const connection = requireConnection('databases:admin')
  const manage = async (request: FastifyRequest): Promise<void> => {
    await connection(request)
    if (isRestricted(app.ctx, request.principal!, request.connection!.id))
      throw notSupported('Managing sharding', request.connection!.id)
  }
  const change = async (request: FastifyRequest): Promise<void> => {
    await manage(request)
    if (app.ctx.config.readOnly || request.connection!.readOnly) throw Errors.readOnly()
  }
  const read = { preHandler: manage, config: { masking: 'denied' as const } }
  const write = (audit: AuditAction) => ({ preHandler: change, config: { masking: 'denied' as const, audit } })

  app.get(`${base}/key-hints`, read, async (request) => {
    const { ns, fields } = parseInput(KeyHintsQuerySchema, request.query ?? {})
    assertShardable(ns)
    return keyHints(await mongosClient(request), ns, fields)
  })

  app.post(`${base}/collections`, write('sharding.collection.shard'), async (request) => {
    const input = parseInput(ShardCollectionSchema, request.body)
    request.auditInfo = {
      details: {
        ns: input.ns,
        key: input.key.map((f) => `${f.field}:${f.kind === 'hashed' ? 'hashed' : 1}`),
        unique: input.unique,
        ...(input.numInitialChunks !== undefined ? { numInitialChunks: input.numInitialChunks } : {}),
        ...(input.presplitHashedZones ? { presplitHashedZones: true } : {}),
      },
    }
    assertShardable(input.ns)
    return shardCollection(await mongosClient(request), input)
  })

  app.get(`${base}/zones`, read, async (request) => {
    return zones(await mongosClient(request))
  })

  app.post(`${base}/zones/shards`, write('sharding.zone.shard'), async (request) => {
    const input = parseInput(ZoneShardSchema, request.body)
    request.auditInfo = { details: { ...input } }
    await zoneShard(await mongosClient(request), input)
    return { ok: true }
  })

  app.post(`${base}/zones/ranges`, write('sharding.zone.range'), async (request) => {
    const input = parseInput(ZoneRangeSchema, request.body)
    // Bounds are shard key values: the audit keeps where and which zone, not the values.
    request.auditInfo = { details: { ns: input.ns, zone: input.zone } }
    assertShardable(input.ns)
    await zoneRange(await mongosClient(request), input)
    return { ok: true }
  })

  app.post(`${base}/balancer`, write('sharding.balancer'), async (request) => {
    const { action } = parseInput(BalancerActionSchema, request.body)
    request.auditInfo = { details: { action } }
    await balancer(await mongosClient(request), action)
    return { ok: true }
  })

  app.put(`${base}/balancer/window`, write('sharding.balancer.window'), async (request) => {
    const { window } = parseInput(BalancerWindowSchema, request.body)
    request.auditInfo = { details: { window } }
    await balancerWindow(await mongosClient(request), window)
    return { ok: true }
  })
}
