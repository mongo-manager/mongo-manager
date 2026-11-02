import type { FastifyInstance } from 'fastify'
import { SlowQueriesQuerySchema, type SlowQuery } from '@mongo-manager/shared'
import { parseInput } from '../../validate'
import { requireConnection } from '../../connections/access'
import { clientFor } from '../../data/mongo-errors'
import { namespacePairs, viewAwareMaskerFor } from '../../masking/restricted'
import { collectSlow, collOf, commandText, explainOrigin, MAX_ENTRIES } from '../../monitor/slow-queries'
import { queryShape } from '../../monitor/query-shape'

/**
 * Phase 3b spec §3.2: slow operations from system.profile and the server log, merged, newest
 * first. Secrets are hidden for everyone and personal values for a restricted user; credential
 * collections are for connection admins; an origin for "Open in Explain" goes only to a user who
 * sees the values.
 */
export async function slowQueryRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/connections/:id/server/slow-queries',
    { preHandler: requireConnection('server:monitor'), config: { masking: 'guarded' } },
    async (request) => {
      const q = parseInput(SlowQueriesQuerySchema, request.query ?? {})
      const limit = q.limit ?? MAX_ENTRIES
      const { raw, refused } = await collectSlow(
        await clientFor(request),
        { ...q, source: q.source ?? 'both' },
        limit,
        request.connectionRole === 'admin',
      )
      // Final review I3: a query on a view is masked by the view's source rules.
      const masker = await viewAwareMaskerFor(request, namespacePairs(raw.slice(0, limit).map((e) => e.ns)))
      const entries: SlowQuery[] = raw.slice(0, limit).map((e) => {
        const out: SlowQuery = {
          source: e.source,
          ts: e.ts,
          ns: e.ns,
          op: e.op,
          durationMs: e.durationMs,
          ...(e.planSummary ? { planSummary: e.planSummary } : {}),
          // Ninth review of explain masking: over an index holding personal data, the keys examined
          // tell how many values a document holds there: never shown to a restricted user.
          ...(e.keysExamined !== undefined && !masker ? { keysExamined: e.keysExamined } : {}),
          ...(e.docsExamined !== undefined ? { docsExamined: e.docsExamined } : {}),
          ...(e.nreturned !== undefined ? { nreturned: e.nreturned } : {}),
          command: commandText(e.command, masker ? { masker, db: e.db, coll: collOf(e.ns) } : undefined),
          // Index advice gaps (2026-10-27): what it asked, with no value — the same for everyone.
          shape: queryShape(e.command, e.origin),
          ...(e.shapeHash ? { shapeHash: e.shapeHash } : {}),
        }
        if (!masker) {
          const origin = explainOrigin(e.command, e.db)
          if (origin) out.origin = origin
        }
        return out
      })
      return { entries, refused }
    },
  )
}
