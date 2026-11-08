// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Document, MongoClient } from 'mongodb'
import type { CollectionLatency, LatencyOfKind } from '@mongo-manager/shared'
import { LENIENT } from '../data/mongo-errors'
import { OWN_READ } from './slow-queries'

type Kind = 'reads' | 'writes' | 'commands'
/** How long one collection's stats may take: a slow one is listed without them. */
const STATS_MS = 10_000

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v === undefined || v === null ? 0 : String(v))
  return Number.isFinite(n) ? n : 0
}
const round2 = (v: number) => Math.round(v * 100) / 100

/**
 * Widgets wave 2 (2026-10-27): the lower bound, in ms, of the latencyStats histogram bucket the 95th
 * percentile falls in — MongoDB keeps buckets, not samples, so this is what it can say.
 */
export function p95Ms(histogram: unknown): number | null {
  if (!Array.isArray(histogram)) return null
  const buckets = (histogram as Document[])
    .map((b) => ({ micros: num(b.micros), count: num(b.count) }))
    .filter((b) => b.count > 0)
    .sort((a, b) => a.micros - b.micros)
  const total = buckets.reduce((n, b) => n + b.count, 0)
  if (total === 0) return null
  let seen = 0
  for (const b of buckets) {
    seen += b.count
    if (seen >= total * 0.95) return round2(b.micros / 1000)
  }
  return null
}

/**
 * A collection's latency from its $collStats answers — one per shard behind a mongos, added up — or
 * null when none says it.
 */
export function latencyOf(answers: Document[]): Omit<CollectionLatency, 'ns'> | null {
  const stats = answers.map((a) => a.latencyStats as Document | undefined).filter((s): s is Document => !!s)
  if (!stats.length) return null
  const kind = (k: Kind): LatencyOfKind => {
    const parts = stats.map((s) => (s[k] ?? {}) as Document)
    const ops = parts.reduce((n, p) => n + num(p.ops), 0)
    const micros = parts.reduce((n, p) => n + num(p.latency), 0)
    return {
      ops,
      avgMs: ops > 0 ? round2(micros / ops / 1000) : null,
      p95Ms: p95Ms(parts.flatMap((p) => (Array.isArray(p.histogram) ? (p.histogram as Document[]) : []))),
    }
  }
  return { reads: kind('reads'), writes: kind('writes'), commands: kind('commands') }
}

/** One collection's latency, read as the monitor reads (its comment, lenient UTF-8, a time limit). */
export async function collectionLatency(client: MongoClient, ns: string): Promise<CollectionLatency> {
  const dot = ns.indexOf('.')
  try {
    const answers = await client
      .db(ns.slice(0, dot))
      .collection(ns.slice(dot + 1))
      .aggregate([{ $collStats: { latencyStats: { histograms: true } } }], {
        ...LENIENT,
        comment: OWN_READ,
        maxTimeMS: STATS_MS,
      })
      .toArray()
    const latency = latencyOf(answers)
    return latency ? { ns, ...latency } : { ns, reads: null, writes: null, commands: null }
  } catch {
    // Refused (no collStats right), gone meanwhile or too slow: listed without its stats.
    return { ns, reads: null, writes: null, commands: null }
  }
}
