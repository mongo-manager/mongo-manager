// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Document } from 'mongodb'

const OPS = ['insert', 'query', 'update', 'delete', 'getmore', 'command'] as const
type Op = (typeof OPS)[number]

/** What is kept of one serverStatus: counters and gauges, no names, no hosts. */
export interface RawStatus {
  /** When it was read (ms), for the rates. */
  at: number
  /** Milliseconds the server has been up: when it drops, the server restarted. */
  uptime: number
  /** host:pid: a different server (failover, another address) is a new baseline too. */
  process: string
  ops: Record<Op, number>
  bytesIn: number
  bytesOut: number
  connections: { current: number; available: number }
  memory: { residentMb: number; virtualMb: number }
  cache: { usedBytes: number; dirtyBytes: number; maxBytes: number } | null
  queues: { readers: number; writers: number }
  /** The MongoDB version (user review 2026-10-09: the Overview's server status); null when unsaid. */
  version: string | null
  /**
   * Widgets wave 2 (2026-10-27): counters for how well queries use indexes, how long operations take,
   * cursors, transactions and errors; null where the server does not report the section.
   */
  scanned: { keys: number; docs: number; returned: number } | null
  latency: Record<LatencyKind, { micros: number; ops: number }> | null
  cursors: { open: number; noTimeout: number; timedOut: number } | null
  transactions: { committed: number; aborted: number } | null
  asserts: { regular: number; user: number; msg: number } | null
}

const LATENCY = ['reads', 'writes', 'commands'] as const
type LatencyKind = (typeof LATENCY)[number]

/** One point of the Performance charts (phase 1i spec §3). */
export interface ServerSample {
  t: number
  ops: Record<Op, number>
  network: { inPerSec: number; outPerSec: number }
  connections: { current: number; available: number }
  memory: { residentMb: number; virtualMb: number }
  cache: { usedBytes: number; dirtyBytes: number; maxBytes: number } | null
  queues: { readers: number; writers: number }
  /** The server restarted, or another one answers, since the last sample: the rates start again. */
  restarted: boolean
  /** No previous reading to compare with: the rates are not measured (the charts skip them). */
  baseline: boolean
  /** User review 2026-10-09: how long the server has been up, and its version (never its host). */
  uptimeSec: number
  version: string | null
  /** Wave 2: keys and documents scanned per document returned; null when nothing was returned. */
  targeting: { keysPerReturned: number | null; docsPerReturned: number | null }
  /** Wave 2: milliseconds per operation; null without operations. */
  latency: { readsMs: number | null; writesMs: number | null; commandsMs: number | null }
  cursors: { open: number; noTimeout: number } | null
  transactions: { committedPerSec: number | null; abortedPerSec: number | null }
  errors: {
    regularPerSec: number | null
    userPerSec: number | null
    msgPerSec: number | null
    cursorTimeoutsPerSec: number | null
  }
}

/** Counters come as Int32, Int64 (Long) or Double depending on the server; all become numbers. */
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v === undefined || v === null ? 0 : String(v))
  return Number.isFinite(n) ? n : 0
}

const section = (v: unknown): Document | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Document) : undefined

export function rawFrom(status: Document, at: number): RawStatus {
  const metrics = section(status.metrics)
  const executor = section(metrics?.queryExecutor)
  const document = section(metrics?.document)
  const cursor = section(metrics?.cursor)
  const latencies = section(status.opLatencies)
  const transactions = section(status.transactions)
  const asserts = section(status.asserts)
  const cache = (status.wiredTiger as Document | undefined)?.cache as Document | undefined
  const queue = ((status.globalLock as Document | undefined)?.currentQueue ?? {}) as Document
  const counters = (status.opcounters ?? {}) as Document
  return {
    at,
    uptime: status.uptimeMillis !== undefined ? num(status.uptimeMillis) : num(status.uptime) * 1000,
    process: `${String(status.host ?? '')}:${String(status.pid ?? '')}`,
    ops: Object.fromEntries(OPS.map((op) => [op, num(counters[op])])) as Record<Op, number>,
    bytesIn: num((status.network as Document | undefined)?.bytesIn),
    bytesOut: num((status.network as Document | undefined)?.bytesOut),
    connections: {
      current: num((status.connections as Document | undefined)?.current),
      available: num((status.connections as Document | undefined)?.available),
    },
    memory: {
      residentMb: num((status.mem as Document | undefined)?.resident),
      virtualMb: num((status.mem as Document | undefined)?.virtual),
    },
    cache: cache
      ? {
          usedBytes: num(cache['bytes currently in the cache']),
          dirtyBytes: num(cache['tracked dirty bytes in the cache']),
          maxBytes: num(cache['maximum bytes configured']),
        }
      : null,
    queues: { readers: num(queue.readers), writers: num(queue.writers) },
    version: typeof status.version === 'string' ? status.version.slice(0, 40) : null,
    scanned:
      executor && document
        ? {
            keys: num(executor.scanned),
            docs: num(executor.scannedObjects),
            returned: num(document.returned),
          }
        : null,
    latency: latencies
      ? (Object.fromEntries(
          LATENCY.map((k) => [
            k,
            { micros: num(section(latencies[k])?.latency), ops: num(section(latencies[k])?.ops) },
          ]),
        ) as RawStatus['latency'])
      : null,
    cursors: cursor
      ? {
          open: num(section(cursor.open)?.total),
          noTimeout: num(section(cursor.open)?.noTimeout),
          timedOut: num(cursor.timedOut),
        }
      : null,
    transactions: transactions
      ? { committed: num(transactions.totalCommitted), aborted: num(transactions.totalAborted) }
      : null,
    asserts: asserts
      ? { regular: num(asserts.regular), user: num(asserts.user), msg: num(asserts.msg) }
      : null,
  }
}

const round2 = (v: number) => Math.round(v * 100) / 100
/** a's growth over b's, or null when b did not grow (nothing to divide by). */
const per = (a: number, b: number, scale = 1): number | null => (b > 0 ? round2((a / b) * scale) : null)

/** Rates since `prev`; zero for the first sample and right after a restart (Review Focus 2). */
export function sampleFrom(prev: RawStatus | null, next: RawStatus): ServerSample {
  const restarted = prev !== null && (next.uptime < prev.uptime || next.process !== prev.process)
  const seconds = prev && !restarted ? Math.max((next.at - prev.at) / 1000, 0.001) : 0
  const measured = prev !== null && !restarted
  const rate = (now: number, before: number) =>
    seconds > 0 ? Math.max(0, Math.round(((now - before) / seconds) * 100) / 100) : 0
  return {
    t: next.at,
    ops: Object.fromEntries(OPS.map((op) => [op, rate(next.ops[op], prev?.ops[op] ?? 0)])) as Record<
      Op,
      number
    >,
    network: {
      inPerSec: rate(next.bytesIn, prev?.bytesIn ?? 0),
      outPerSec: rate(next.bytesOut, prev?.bytesOut ?? 0),
    },
    connections: next.connections,
    memory: next.memory,
    cache: next.cache,
    queues: next.queues,
    restarted,
    baseline: prev === null || restarted,
    uptimeSec: Math.max(0, Math.floor(next.uptime / 1000)),
    version: next.version,
    ...wave2(measured ? prev : null, next, seconds),
  }
}

/**
 * Widgets wave 2: the new metrics between two readings; with no earlier reading to compare (a
 * baseline) or a section either reading lacks, null — a gap, never a false zero.
 */
function wave2(
  prev: RawStatus | null,
  next: RawStatus,
  seconds: number,
): Pick<ServerSample, 'targeting' | 'latency' | 'cursors' | 'transactions' | 'errors'> {
  const growth = (now: number, before: number) => Math.max(0, now - before)
  const rate = (now: number | undefined, before: number | undefined) =>
    now === undefined || before === undefined || seconds <= 0 ? null : round2(growth(now, before) / seconds)
  const s = prev?.scanned && next.scanned ? { a: prev.scanned, b: next.scanned } : null
  const returned = s ? growth(s.b.returned, s.a.returned) : 0
  const l = prev?.latency && next.latency ? { a: prev.latency, b: next.latency } : null
  const ms = (k: LatencyKind) =>
    l ? per(growth(l.b[k].micros, l.a[k].micros), growth(l.b[k].ops, l.a[k].ops), 1 / 1000) : null
  return {
    targeting: {
      keysPerReturned: s ? per(growth(s.b.keys, s.a.keys), returned) : null,
      docsPerReturned: s ? per(growth(s.b.docs, s.a.docs), returned) : null,
    },
    latency: { readsMs: ms('reads'), writesMs: ms('writes'), commandsMs: ms('commands') },
    cursors: next.cursors ? { open: next.cursors.open, noTimeout: next.cursors.noTimeout } : null,
    transactions: {
      committedPerSec: rate(next.transactions?.committed, prev?.transactions?.committed),
      abortedPerSec: rate(next.transactions?.aborted, prev?.transactions?.aborted),
    },
    errors: {
      regularPerSec: rate(next.asserts?.regular, prev?.asserts?.regular),
      userPerSec: rate(next.asserts?.user, prev?.asserts?.user),
      msgPerSec: rate(next.asserts?.msg, prev?.asserts?.msg),
      cursorTimeoutsPerSec: rate(next.cursors?.timedOut, prev?.cursors?.timedOut),
    },
  }
}
