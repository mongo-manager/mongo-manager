// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { AiMetrics } from '../ai/run'
import type { FastifyInstance } from 'fastify'
import { JOB_KINDS } from '@mongo-manager/shared'
import { safeEqual } from '../http/security'
import type { LiveSyncRunner } from '../livesync/runner'

const CLASSES = ['1xx', '2xx', '3xx', '4xx', '5xx'] as const
export type RequestCounts = Record<(typeof CLASSES)[number], number>

/** Counts every response of the server; the hook goes on the root instance (plugins are encapsulated). */
export function countRequests(app: FastifyInstance): RequestCounts {
  const counts: RequestCounts = { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 }
  app.addHook('onResponse', async (_request, reply) => {
    const cls = `${Math.floor(reply.statusCode / 100)}xx` as (typeof CLASSES)[number]
    if (cls in counts) counts[cls]++
  })
  return counts
}

/** Phase 3e-2 spec §2.6: live syncs by state, the largest lag, the changes applied (no names). */
function liveSyncLines(m: ReturnType<LiveSyncRunner['metrics']>): string[] {
  return [
    '# HELP mm_live_syncs Live syncs, by state.',
    '# TYPE mm_live_syncs gauge',
    ...Object.entries(m.states).map(([state, n]) => `mm_live_syncs{state="${state}"} ${n}`),
    '# HELP mm_live_sync_lag_seconds How far behind its source the furthest running live sync is.',
    '# TYPE mm_live_sync_lag_seconds gauge',
    `mm_live_sync_lag_seconds ${m.lagSeconds}`,
    '# HELP mm_live_sync_changes Changes applied by the live syncs that exist (inserted, replaced, deleted).',
    '# TYPE mm_live_sync_changes gauge',
    `mm_live_sync_changes ${m.changes}`,
  ]
}

function aiLines(m: AiMetrics): string[] {
  return [
    '# HELP mm_ai_requests_total AI assistant requests, by action and outcome.',
    '# TYPE mm_ai_requests_total counter',
    ...[...m.requests.entries()].sort().map(([k, n]) => {
      const [action, outcome] = k.split('|')
      return `mm_ai_requests_total{action="${action}",outcome="${outcome}"} ${n}`
    }),
    '# HELP mm_ai_tokens_total Tokens sent to and received from AI providers.',
    '# TYPE mm_ai_tokens_total counter',
    `mm_ai_tokens_total{direction="input"} ${m.tokens.input}`,
    `mm_ai_tokens_total{direction="output"} ${m.tokens.output}`,
  ]
}

/**
 * Optional Prometheus metrics (spec §3.5), registered only when metricsToken is set. The scraper
 * sends it as a bearer token, compared in constant time. The numbers carry no names: no user,
 * connection, database or collection appears in any label.
 */
export async function metricsRoutes(
  app: FastifyInstance,
  opts: { token: string; path: string; requests: RequestCounts },
): Promise<void> {
  const { requests } = opts
  const started = Date.now()

  app.get(opts.path, async (request, reply) => {
    const header = request.headers.authorization ?? ''
    // The scheme is case-insensitive (RFC 7235); the pattern's parts never overlap, so it runs in linear time.
    const token = /^Bearer +(\S+)\s*$/i.exec(header)?.[1] ?? ''
    if (!safeEqual(token, opts.token)) {
      return reply
        .status(401)
        .header('cache-control', 'no-store')
        .send({ code: 'UNAUTHENTICATED', message: 'Authentication required' })
    }
    const lines = [
      '# HELP mm_http_requests_total Requests answered, by status class.',
      '# TYPE mm_http_requests_total counter',
      ...CLASSES.map((c) => `mm_http_requests_total{class="${c}"} ${requests[c]}`),
      '# HELP mm_mongo_clients_open MongoDB clients open or opening.',
      '# TYPE mm_mongo_clients_open gauge',
      `mm_mongo_clients_open ${app.ctx.manager.openCount()}`,
      '# HELP mm_jobs_running Background jobs running, by kind.',
      '# TYPE mm_jobs_running gauge',
      ...JOB_KINDS.map((kind) => `mm_jobs_running{kind="${kind}"} ${app.ctx.jobs.runningCount(kind)}`),
      ...liveSyncLines(app.ctx.liveSync.metrics()),
      ...aiLines(app.ctx.ai.metrics),
      '# HELP process_resident_memory_bytes Resident memory size in bytes.',
      '# TYPE process_resident_memory_bytes gauge',
      `process_resident_memory_bytes ${process.memoryUsage().rss}`,
      '# HELP process_uptime_seconds Seconds since the server started.',
      '# TYPE process_uptime_seconds gauge',
      `process_uptime_seconds ${Math.floor((Date.now() - started) / 1000)}`,
    ]
    return reply
      .type('text/plain; version=0.0.4; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(`${lines.join('\n')}\n`)
  })
}
