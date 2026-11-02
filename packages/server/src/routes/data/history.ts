import type { FastifyInstance, FastifyRequest } from 'fastify'
import { HistoryQuerySchema, HistorySettingsSchema, type HistoryRange } from '@mongo-manager/shared'
import { Errors } from '../../errors'
import { parseInput } from '../../validate'
import { requireConnection } from '../../connections/access'
import { MAX_HISTORY_CONNECTIONS } from '../../monitor/history'
import { samplingRoom } from '../../monitor/sampling'

/** Each range: how far back, and how long one averaged point is (≤ 500 points). */
const RANGES: Record<HistoryRange, { spanMs: number; stepMs: number }> = {
  '1h': { spanMs: 3600_000, stepMs: 60_000 },
  '24h': { spanMs: 24 * 3600_000, stepMs: 5 * 60_000 },
  '7d': { spanMs: 7 * 24 * 3600_000, stepMs: 30 * 60_000 },
}

/**
 * Phase 3b spec §6: the metric history of a connection. Monitors read it; a connection admin turns
 * recording on or off and deletes it. The error of a failed sample stays on the server.
 */
export async function historyRoutes(app: FastifyInstance): Promise<void> {
  const base = '/connections/:id/server/history'
  const monitor = requireConnection('server:monitor')
  const admin = requireConnection('server:operations')

  const settings = (request: FastifyRequest) => {
    const s = app.ctx.metricHistory.status(request.connection!.id)
    return {
      enabled: s.enabled,
      samples: s.samples,
      lastError: s.lastError !== null,
      lastErrorAt: s.lastErrorAt === null ? null : new Date(s.lastErrorAt).toISOString(),
    }
  }

  app.get(`${base}/settings`, { preHandler: monitor, config: { masking: 'names-only' } }, async (request) =>
    settings(request),
  )

  app.put(
    `${base}/settings`,
    { preHandler: admin, config: { masking: 'names-only', audit: 'server.history' } },
    async (request) => {
      const { enabled } = parseInput(HistorySettingsSchema, request.body ?? {})
      const connectionId = request.connection!.id
      request.auditInfo = { details: { enabled } }
      const history = app.ctx.metricHistory
      // W3 review (M1): alerts sample connections too; the cap counts both.
      if (enabled && !history.isEnabled(connectionId) && !samplingRoom(app.ctx, connectionId))
        throw Errors.conflict(`At most ${MAX_HISTORY_CONNECTIONS} connections can record metric history`, {
          reason: 'limit',
          max: MAX_HISTORY_CONNECTIONS,
        })
      history.setEnabled(connectionId, enabled)
      app.ctx.historyRecorder.sync()
      return settings(request)
    },
  )

  app.delete(
    base,
    { preHandler: admin, config: { masking: 'names-only', audit: 'server.history.delete' } },
    async (request, reply) => {
      app.ctx.metricHistory.clear(request.connection!.id)
      return reply.status(204).send()
    },
  )

  app.get(base, { preHandler: monitor, config: { masking: 'names-only' } }, async (request) => {
    const { range } = parseInput(HistoryQuerySchema, request.query ?? {})
    const { spanMs, stepMs } = RANGES[range]
    const to = app.ctx.now()
    const from = to - spanMs
    return {
      range,
      stepMs,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      points: app.ctx.metricHistory.points(request.connection!.id, from, to + 1, stepMs),
    }
  })
}
