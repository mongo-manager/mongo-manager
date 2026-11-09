// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type {
  CollectionLatency,
  IndexAdvice,
  ServerFacts,
  KeyHints,
  ShardCollectionInput,
  ZonesView,
  OperationsQuery,
  ShardingDetail,
  ShardingView,
  SlowQueriesQuery,
  SlowQuery,
} from '@mongo-manager/shared/browser'
import { api, path } from './client'

/** One point of the Performance charts (phase 1i spec §3). */
export interface ServerSample {
  connectionId?: string
  t: number
  ops: Record<'insert' | 'query' | 'update' | 'delete' | 'getmore' | 'command', number>
  network: { inPerSec: number; outPerSec: number }
  connections: { current: number; available: number }
  memory: { residentMb: number; virtualMb: number }
  cache: { usedBytes: number; dirtyBytes: number; maxBytes: number } | null
  queues: { readers: number; writers: number }
  restarted: boolean
  /** Nothing to compare with: its rates are not measured. */
  baseline?: boolean
  /** User review 2026-10-09: how long the server has been up, and its version (an older server: absent). */
  uptimeSec?: number
  version?: string | null
  /** Widgets wave 2 (2026-10-27): absent from an older server's sample (the charts show gaps). */
  targeting?: { keysPerReturned: number | null; docsPerReturned: number | null }
  latency?: { readsMs: number | null; writesMs: number | null; commandsMs: number | null }
  cursors?: { open: number; noTimeout: number } | null
  transactions?: { committedPerSec: number | null; abortedPerSec: number | null }
  errors?: {
    regularPerSec: number | null
    userPerSec: number | null
    msgPerSec: number | null
    cursorTimeoutsPerSec: number | null
  }
}

export interface OperationView {
  opid: string
  op: string
  ns: string
  secsRunning: number
  planSummary?: string
  waitingForLock: boolean
  desc: string
  /** Re-review of B3 (M-2): when it started, and the member it runs on (an opaque digest). */
  startedAt?: number
  member?: string
  /** Third review of B3 (M1): run where a kill cannot reach it (a secondary). */
  killable?: false
  /** Phase 3b: for everyone with server:monitor; secrets hidden, personal values masked for a restricted user. */
  command?: string
}

export interface TopEntry {
  ns: string
  totalMs: number
  readMs: number
  writeMs: number
  count: number
}

/** One member of a replica set (phase 1j spec §2). */
export interface ReplicaMember {
  name: string
  state: string
  healthy: boolean
  self: boolean
  uptimeSeconds: number | null
  lagSeconds: number | null
  pingMs: number | null
  lastHeartbeat: string | null
  lastHeartbeatMessage: string | null
  syncSource: string | null
  priority: number | null
  hidden: boolean | null
  votes: number | null
  arbiter: boolean
}

export type ReplicaStatus =
  | { mode: 'standalone' }
  | { mode: 'sharded' }
  | {
      mode: 'replicaSet'
      set: string
      date: string | null
      primary: string | null
      majorityLagSeconds: number | null
      oplogWindowHours: number | null
      /** Widgets wave 2: the oplog's use and rate (absent from an older server), the last election. */
      oplog?: { usedMb: number; maxMb: number; gbPerHour: number | null } | null
      lastElection?: string | null
      members: ReplicaMember[]
    }

/** Phase 3b spec §3.1: the profiler of one database, as the server reports it. */
export interface ProfilerDatabase {
  name: string
  level?: 0 | 1 | 2
  slowms?: number
  sampleRate?: number
  /** The role MongoDB wanted (dbAdmin), or "error". */
  refused?: string
  /** When level 2 goes back by itself. */
  revertAt?: string
  /** The last revert attempt failed (it is retried); the reason stays on the server. */
  revertFailed?: boolean
}

export interface ProfilerStatus {
  scope: 'mongod' | 'mongos'
  member?: string
  databases: ProfilerDatabase[]
}

export interface ProfilerChange {
  level: 0 | 1 | 2
  slowms: number
  sampleRate: number
  confirm?: boolean
}

export type { IndexAdvice, ShardingDetail, ShardingView, SlowQuery }

/** Phase 3b spec §6: one averaged point of stored metric history (a rate is null when unmeasured). */
export interface HistoryPoint {
  t: number
  ops: Record<'insert' | 'query' | 'update' | 'delete' | 'getmore' | 'command', number | null>
  network: { inPerSec: number | null; outPerSec: number | null }
  connections: { current: number; available: number }
  memory: { residentMb: number; virtualMb: number }
  cache: { usedBytes: number; dirtyBytes: number; maxBytes: number } | null
  queues: { readers: number; writers: number }
  restarted: boolean
  /** Widgets wave 2 (2026-10-27): absent from an older server's sample (the charts show gaps). */
  targeting?: { keysPerReturned: number | null; docsPerReturned: number | null }
  latency?: { readsMs: number | null; writesMs: number | null; commandsMs: number | null }
  cursors?: { open: number; noTimeout: number } | null
  transactions?: { committedPerSec: number | null; abortedPerSec: number | null }
  errors?: {
    regularPerSec: number | null
    userPerSec: number | null
    msgPerSec: number | null
    cursorTimeoutsPerSec: number | null
  }
}

export type HistoryRange = '1h' | '24h' | '7d'

export interface HistoryAnswer {
  range: HistoryRange
  stepMs: number
  from: string
  to: string
  points: HistoryPoint[]
}

export interface HistorySettings {
  enabled: boolean
  samples: number
  /** The last sample failed (it is retried); the reason stays on the server. */
  lastError: boolean
  lastErrorAt: string | null
}

/** A query string from filter values: empty values and empty lists are left out. */
function query(values: Record<string, unknown>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) continue
    params.set(key, Array.isArray(value) ? value.join(',') : String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

export const serverKeys = {
  status: (id: string) => ['connections', id, 'server', 'status'] as const,
  replica: (id: string) => ['connections', id, 'server', 'replica'] as const,
  operations: (id: string, filter: OperationsQuery = {}) =>
    ['connections', id, 'server', 'operations', filter] as const,
  profiler: (id: string) => ['connections', id, 'server', 'profiler'] as const,
  slowQueries: (id: string, q: SlowQueriesQuery) => ['connections', id, 'server', 'slow-queries', q] as const,
  top: (id: string) => ['connections', id, 'server', 'top'] as const,
  history: (id: string, range: HistoryRange) => ['connections', id, 'server', 'history', range] as const,
  historySettings: (id: string) => ['connections', id, 'server', 'history', 'settings'] as const,
  sharding: (id: string, ns: string) => ['connections', id, 'server', 'sharding', ns] as const,
  shardingDetail: (id: string, ns: string) =>
    ['connections', id, 'server', 'sharding', 'detail', ns] as const,
  indexAdvice: (id: string, db: string) => ['connections', id, 'server', 'index-advice', db] as const,
  zones: (id: string) => ['connections', id, 'server', 'sharding', 'zones'] as const,
  collectionLatency: (id: string) => ['connections', id, 'server', 'collection-latency'] as const,
  facts: (id: string) => ['connections', id, 'server', 'facts'] as const,
}

export const serverApi = {
  status: (id: string) => api.get<ServerSample>(path`connections/${id}/server/status`),
  operations: (id: string, filter: OperationsQuery = {}) =>
    api.get<{ operations: OperationView[]; more: boolean; scope: 'all' | 'own' }>(
      `${path`connections/${id}/server/operations`}${query(filter)}`,
    ),
  profiler: (id: string) => api.get<ProfilerStatus>(path`connections/${id}/server/profiler`),
  setProfiler: (id: string, db: string, change: ProfilerChange) =>
    api.put<ProfilerChange & { revertAt?: string }>(path`connections/${id}/server/profiler/${db}`, change),
  slowQueries: (id: string, q: SlowQueriesQuery) =>
    api.get<{ entries: SlowQuery[]; refused: { profile?: string; log?: string } }>(
      `${path`connections/${id}/server/slow-queries`}${query(q)}`,
    ),
  /** Re-review of B3 (M-3): what the person saw, so nothing else under that opid is stopped. */
  kill: (id: string, opid: string, seen: Pick<OperationView, 'ns' | 'op' | 'startedAt' | 'member'>) =>
    api.post<{ killed: string }>(path`connections/${id}/server/operations/${opid}/kill`, seen),
  top: (id: string) => api.get<{ collections: TopEntry[] }>(path`connections/${id}/server/top`),
  history: (id: string, range: HistoryRange) =>
    api.get<HistoryAnswer>(`${path`connections/${id}/server/history`}${query({ range })}`),
  historySettings: (id: string) => api.get<HistorySettings>(path`connections/${id}/server/history/settings`),
  setHistory: (id: string, enabled: boolean) =>
    api.put<HistorySettings>(path`connections/${id}/server/history/settings`, { enabled }),
  deleteHistory: (id: string) => api.delete<void>(path`connections/${id}/server/history`),
  sharding: (id: string, ns: string) =>
    api.get<ShardingView>(`${path`connections/${id}/server/sharding`}${query({ ns })}`),
  shardingDetail: (id: string, ns: string) =>
    api.get<ShardingDetail>(`${path`connections/${id}/server/sharding/detail`}${query({ ns })}`),
  indexAdvice: (id: string, db: string) =>
    api.get<IndexAdvice>(`${path`connections/${id}/server/index-advice`}${query({ db })}`),
  replica: (id: string) => api.get<ReplicaStatus>(path`connections/${id}/server/replica`),
  // Widgets wave 2 (2026-10-27).
  collectionLatency: (id: string) =>
    api.get<{ collections: CollectionLatency[] }>(path`connections/${id}/server/collection-latency`),
  facts: (id: string) => api.get<ServerFacts>(path`connections/${id}/server/facts`),
  // W3.2: sharding management (connection admins).
  keyHints: (id: string, ns: string, fields: string[]) =>
    api.get<KeyHints>(`${path`connections/${id}/server/sharding/key-hints`}${query({ ns, fields })}`),
  shardCollection: (id: string, input: ShardCollectionInput) =>
    api.post<{ ns: string; sharded: boolean }>(path`connections/${id}/server/sharding/collections`, input),
  zones: (id: string) => api.get<ZonesView>(path`connections/${id}/server/sharding/zones`),
  zoneShard: (id: string, input: { shard: string; zone: string; action: 'add' | 'remove' }) =>
    api.post<{ ok: true }>(path`connections/${id}/server/sharding/zones/shards`, input),
  zoneRange: (id: string, input: { ns: string; min: string; max: string; zone: string | null }) =>
    api.post<{ ok: true }>(path`connections/${id}/server/sharding/zones/ranges`, input),
  balancer: (id: string, action: 'start' | 'stop') =>
    api.post<{ ok: true }>(path`connections/${id}/server/sharding/balancer`, { action }),
  balancerWindow: (id: string, window: { start: string; stop: string } | null) =>
    api.put<{ ok: true }>(path`connections/${id}/server/sharding/balancer/window`, { window }),
}
