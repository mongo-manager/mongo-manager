// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyRequest } from 'fastify'
import type { Document } from 'mongodb'
import { permissionsFor, type ExportSource } from '@mongo-manager/shared'
import { Errors } from '../errors'
import { fromClient } from '../data/ejson-io'
import { withMongo } from '../data/mongo-errors'
import { guardAggregate, guardFind, type GateDeps } from '../masking/gate'
import { inspectPipeline } from '../aggregation/inspect'
import { assertNoServerJs } from '../routes/data/params'
import type { ExportPlan } from './export-job'

/**
 * Phase 3d-1 spec §8.1 (moved from the export route in phase 3d-2): what a job reads from a
 * collection — a query or a pipeline — checked and, for a restricted caller, rewritten by the gate,
 * as a read would be. Exports and copies share it.
 */
export async function sourcePlan(
  request: FastifyRequest,
  db: string,
  coll: string,
  source: ExportSource,
  gate: GateDeps | null,
): Promise<ExportPlan> {
  if (source.kind === 'pipeline') {
    if (!permissionsFor(request.connectionRole!).has('aggregation:run')) throw Errors.forbidden()
    const stages = fromClient<Document[]>(source.stages, 'pipeline')
    // The aggregation builder's checks (refused stages, credential collections, server-side
    // JavaScript), then no write at all (3d-1 final review I1).
    if (inspectPipeline(request, stages, db).write)
      throw Errors.validation('An export cannot write with $out or $merge', {
        reason: 'export_write_stage',
      })
    // Twelfth review (M2): a job reads in an order that hides nothing, whatever the indexes then.
    const guarded = gate
      ? await withMongo(() => guardAggregate(db, coll, stages, gate, { order: 'always' }))
      : null
    return { kind: 'aggregate', stages: guarded?.stages ?? stages, output: guarded?.output ?? null }
  }
  const q = source.kind === 'query' ? source : { kind: 'query' as const, filter: {}, skip: 0 }
  const filter = fromClient<Document>(q.filter, 'filter')
  const projection =
    'projection' in q && q.projection ? fromClient<Document>(q.projection, 'projection') : undefined
  const sort = 'sort' in q && q.sort ? fromClient<Document>(q.sort, 'sort') : undefined
  const collation =
    'collation' in q && q.collation ? fromClient<Document>(q.collation, 'collation') : undefined
  const rawHint = 'hint' in q ? q.hint : undefined
  const hint = typeof rawHint === 'object' ? fromClient<Document>(rawHint, 'hint') : rawHint
  assertNoServerJs(request, filter, projection)
  const guarded = gate
    ? await withMongo(() =>
        guardFind(
          db,
          coll,
          {
            filter,
            ...(projection ? { projection } : {}),
            ...(sort ? { sort } : {}),
            ...(hint ? { hint } : {}),
            ...(collation ? { collation } : {}),
          },
          gate,
          { order: 'always' },
        ),
      )
    : null
  const shown = guarded ? guarded.projection : projection
  return {
    kind: 'find',
    filter: guarded?.filter ?? filter,
    options: {
      ...(shown ? { projection: shown } : {}),
      // The gate's order and hint where rules apply: no hidden value's order (ninth review).
      ...((guarded ? guarded.sort : sort) ? { sort: guarded ? guarded.sort : sort } : {}),
      ...(collation ? { collation: collation as never } : {}),
      ...((guarded ? guarded.hint : hint) ? { hint: guarded ? guarded.hint : hint } : {}),
      skip: q.skip,
      ...('limit' in q && q.limit ? { limit: q.limit } : {}),
    },
    finish: guarded ? (docs) => guarded.finish(docs) : null,
    repeats: guarded?.repeats ?? false,
    checksId: guarded?.checksId ?? false,
    output: guarded?.output ?? null,
  }
}

/** The whole collection, or a query with nothing but a filter: what $out/$merge can copy as is. */
export const isWholeSource = (s: ExportSource): boolean =>
  s.kind === 'collection' ||
  (s.kind === 'query' && !s.projection && !s.sort && !s.collation && !s.hint && !s.limit && s.skip === 0)
