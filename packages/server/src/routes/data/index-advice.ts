// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyInstance } from 'fastify'
import { IndexAdviceQuerySchema } from '@mongo-manager/shared'
import { parseInput } from '../../validate'
import { assertNotDrillScratch, isAdminOnlyNamespace, requireConnection } from '../../connections/access'
import { Errors } from '../../errors'
import { clientFor } from '../../data/mongo-errors'
import { gatherAdvice } from '../../monitor/index-advice'
import { maskerFor } from '../../masking/request'

/**
 * Phase 3b spec §6a: index suggestions from a database's slow queries, and notes on indexes that
 * may be unneeded. Names only, so the answer is the same for a restricted user; nothing is built
 * or dropped here — the create-index dialog does that, under its own rules.
 */
export async function indexAdviceRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/connections/:id/server/index-advice',
    { preHandler: requireConnection('server:monitor'), config: { masking: 'names-only' } },
    async (request) => {
      const { db } = parseInput(IndexAdviceQuerySchema, request.query ?? {})
      // Final review I1: the database comes from the query, not the path — checked here as the path's
      // would be: a drill's scratch database is no one's, local is a connection admin's only.
      assertNotDrillScratch(db)
      if (request.connectionRole !== 'admin' && isAdminOnlyNamespace(db))
        throw Errors.forbidden('System namespaces are restricted to connection admins')
      // Index advice gaps (2026-10-27): index sizes tell how much a collection holds — hidden where
      // the rules hide values from the caller, as its other sizes are.
      const masker = maskerFor(request)
      return gatherAdvice(
        await clientFor(request),
        db,
        request.connectionRole === 'admin',
        (coll) => !!masker?.forNs(db, coll).any,
      )
    },
  )
}
