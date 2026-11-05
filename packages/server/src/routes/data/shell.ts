// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseInput } from '../../validate'
import { requireConnection } from '../../connections/access'
import { guardShell } from './shell-gate'
import { ownerOf } from './owners'

/** Phase 3a-1 spec §7: a connection's shell command history, for the terminal. Owner-only. */
export async function shellHistoryRoutes(app: FastifyInstance): Promise<void> {
  const BASE = '/connections/:id/shell/history'
  const Query = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(1000) })

  // The connection guard needs a permission; documents:read is the floor for anyone with the shell.
  app.get(
    BASE,
    { preHandler: requireConnection('documents:read'), config: { masking: 'denied' } },
    async (request) => {
      guardShell(request)
      const { limit } = parseInput(Query, request.query ?? {})
      const entries = request.server.ctx.shellHistory.list({
        owner: ownerOf(request),
        connectionId: request.connection!.id,
        limit,
      })
      return { entries: entries.map((e) => ({ id: e.id, code: e.code, usedAt: e.usedAt, count: e.count })) }
    },
  )

  app.delete(
    BASE,
    { preHandler: requireConnection('documents:read'), config: { masking: 'denied' } },
    async (request, reply) => {
      guardShell(request)
      request.server.ctx.shellHistory.clear(ownerOf(request), request.connection!.id)
      return reply.status(204).send()
    },
  )
}
