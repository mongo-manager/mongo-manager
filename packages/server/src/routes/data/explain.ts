// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyInstance } from 'fastify'
import type { Document, MongoClient } from 'mongodb'
import {
  ExplainRequestSchema,
  permissionsFor,
  serializeValue,
  type ExplainResult,
  type ExplainVerbosity,
} from '@mongo-manager/shared'
import { Errors } from '../../errors'
import { parseInput } from '../../validate'
import { requireConnection } from '../../connections/access'
import { TIME_LIMIT, clientFor, ranOutOfTime, withMongo } from '../../data/mongo-errors'
import { fromClient } from '../../data/ejson-io'
import { clientGone, trackOperation } from '../../data/operations'
import { inspectPipeline } from '../../aggregation/inspect'
import { normaliseExplain } from '../../explain/normalise'
import { adviceFor } from '../../explain/advice'
import { suggestIndex } from '../../explain/suggest'
import type { PlanNode } from '../../explain/types'
import { gateFor } from '../../masking/restricted'
import { guardAggregate, guardFind } from '../../masking/gate'
import { maskExplain, planRefusal } from '../../masking/explain'
import { planRefused } from '../../masking/gate/refusal'
import { holdReadSlot } from '../../data/page'
import { CollParams, assertNoServerJs } from './params'

/** Warnings an index can answer: only then is one suggested. */
const INDEX_WARNINGS = new Set(['COLLSCAN', 'IN_MEMORY_SORT', 'LOW_SELECTIVITY', 'FETCH_FILTER'])

/**
 * The limit of the plan asked for alone after a run that ran out of time: a plan that takes longer
 * than this is the trouble itself.
 */
const PLAN_MS = 5_000

function* nodes(node: PlanNode | null): Generator<PlanNode> {
  if (!node) return
  yield node
  for (const child of node.children) yield* nodes(child)
}

/** The first field of every index of each joined collection; a refused listing counts as indexed. */
async function joinIndexes(
  client: MongoClient,
  db: string,
  colls: string[],
  comment: string,
  gone: () => boolean,
) {
  const known = new Map<string, Set<string> | null>()
  for (const coll of colls) {
    if (gone()) break
    const indexes = await client
      .db(db)
      .collection(coll)
      .indexes({ maxTimeMS: 5_000, comment } as never)
      .catch(() => null)
    known.set(coll, indexes ? new Set(indexes.map((i) => Object.keys(i.key)[0]!)) : null)
  }
  return (coll: string, field: string) => {
    const first = known.get(coll)
    return first === null || first === undefined || first.has(field)
  }
}

/** Phase 2b spec §2.1: how MongoDB runs a query or a pipeline, normalised, with advice. */
export async function explainRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/connections/:id/databases/:db/collections/:coll/explain',
    { preHandler: requireConnection('documents:read'), config: { masking: 'guarded' } },
    async (request, reply): Promise<ExplainResult> => {
      const { db, coll } = parseInput(CollParams, request.params)
      const body = parseInput(ExplainRequestSchema, request.body ?? {})
      // Security audit 2026-10-16 (Important 2): executionStats runs the query or the pipeline (up to
      // 120 s) — one of the user's run slots, as a run.
      holdReadSlot(request, reply, request.server.ctx.aggregation.slots)
      const client = await clientFor(request)
      // Phase 3c §3, §4.3: a restricted user's query goes through the gate; the answer is masked.
      const gate = gateFor(request, client)
      let run: (
        collection: ReturnType<ReturnType<MongoClient['db']>['collection']>,
        comment: string,
        verbosity: ExplainVerbosity,
        ms: number,
      ) => Promise<Document>
      let query: { filter?: Document; sort?: Document; stages?: Document[] }
      if (body.kind === 'find') {
        const filter = fromClient<Document>(body.filter, 'filter')
        const projection = body.projection ? fromClient<Document>(body.projection, 'projection') : undefined
        const sort = body.sort ? fromClient<Document>(body.sort, 'sort') : undefined
        const collation = body.collation ? fromClient<Document>(body.collation, 'collation') : undefined
        const hint = typeof body.hint === 'object' ? fromClient<Document>(body.hint, 'hint') : body.hint
        assertNoServerJs(request, filter, projection, sort)
        query = { filter, ...(sort ? { sort } : {}) }
        const guarded = gate
          ? await withMongo(() =>
              guardFind(
                db,
                coll,
                {
                  filter,
                  ...(projection ? { projection } : {}),
                  ...(sort ? { sort } : {}),
                  ...(hint !== undefined ? { hint } : {}),
                  ...(collation ? { collation } : {}),
                },
                gate,
              ),
            )
          : null
        const shown = guarded ? guarded.projection : projection
        // Twelfth review (Minor 2): the query the documents route runs, in the gate's order.
        const order = guarded ? guarded.sort : sort
        const readHint = guarded ? guarded.hint : hint
        run = (collection, comment, verbosity, ms) =>
          collection
            .find(guarded?.filter ?? filter, {
              ...(shown ? { projection: shown } : {}),
              ...(order ? { sort: order } : {}),
              ...(collation ? { collation: collation as never } : {}),
              ...(readHint !== undefined ? { hint: readHint } : {}),
              ...(body.skip !== undefined ? { skip: body.skip } : {}),
              ...(body.limit !== undefined ? { limit: body.limit } : {}),
              comment,
            })
            .explain({ verbosity, maxTimeMS: ms })
      } else {
        const role = request.connectionRole!
        const readOnly = request.server.ctx.config.readOnly || request.connection!.readOnly
        if (!permissionsFor(role, { readOnly }).has('aggregation:run')) throw Errors.forbidden()
        const stages = fromClient<Document[]>(body.stages, 'stages')
        // Explain in executionStats mode runs the pipeline: a write is never run unconfirmed (spec R3).
        if (inspectPipeline(request, stages, db).write)
          throw Errors.validation(
            'A pipeline that writes ($out or $merge) is not explained: remove its last stage',
          )
        query = { stages }
        const guarded = gate ? await withMongo(() => guardAggregate(db, coll, stages, gate)) : null
        run = (collection, comment, verbosity, ms) =>
          collection
            .aggregate(guarded?.stages ?? stages, { comment, allowDiskUse: true })
            .explain({ verbosity, maxTimeMS: ms })
      }
      const comment = trackOperation(request, reply, client)
      const collection = client.db(db).collection(coll)
      // A run can stop at its time limit before MongoDB gives anything, numbers or plan (a slow
      // first document, or its JavaScript engine starting): the plan alone, which runs at most the
      // planner's trial, is then asked for, through the same gate, with a short limit of its own.
      // If that fails too, the first failure stands.
      // Ninth review (M3): a restricted user's plan is read alone first, and refused before the
      // query runs when it shows an index holding personal data (the answer is checked again).
      // Where no rule applies, nothing is checked (tenth review, M5); a plan read too slowly here
      // leaves it to the answer's check (M4).
      const checks = gate !== null && (gate.masker.anyRules || gate.masker.anyInDb(db))
      let planned: Document | null = null
      if (checks && body.verbosity !== 'queryPlanner') {
        planned = await withMongo(() =>
          run(collection, comment, 'queryPlanner', Math.min(body.maxTimeMS, PLAN_MS)).catch((e: unknown) =>
            ranOutOfTime(e) ? null : Promise.reject(e),
          ),
        )
        const refused = planned ? await withMongo(() => planRefusal(planned, gate, db, coll)) : null
        if (refused) throw planRefused(refused)
      }
      let planOnly = false
      const answer = await withMongo(() =>
        run(collection, comment, body.verbosity, body.maxTimeMS).catch(async (e: unknown) => {
          if (body.verbosity === 'queryPlanner' || !ranOutOfTime(e) || clientGone(request, reply)) throw e
          // The plan alone ran out of time already: it is not asked for again (eleventh review, M6).
          if (checks && planned === null) throw e
          // The plan alone, read already for a restricted user's check, is not asked for again.
          const plan =
            planned ??
            (await run(collection, comment, 'queryPlanner', Math.min(body.maxTimeMS, PLAN_MS)).catch(() =>
              Promise.reject(e),
            ))
          planOnly = true
          return plan
        }),
      )
      // Eighth review: a plan reading an index that holds personal data is not explained at all.
      const refused = checks && gate ? await withMongo(() => planRefusal(answer, gate, db, coll)) : null
      if (refused) throw planRefused(refused)
      const raw = (gate ? maskExplain(answer) : answer) as Document
      const view = normaliseExplain(raw)
      if (planOnly) view.incomplete = { code: 50, message: TIME_LIMIT, planOnly: true }
      // W5 re-review: through mongos a join pushed into the plan is in each shard's, not the merge's.
      const trees = [view.winning, ...(view.shards ?? []).map((s) => s.winning)]
      const joined = [
        ...trees
          .flatMap((tree) => [...nodes(tree)])
          .filter((n) => n.stage === 'EQ_LOOKUP' && n.foreignCollection)
          .map((n) => n.foreignCollection!.replace(/^[^.]*\./, '')),
        ...view.pipeline.flatMap((s) => (s.from ? [s.from] : [])),
      ]
      const warnings = adviceFor(view, {
        foreignIndexed: await joinIndexes(client, db, [...new Set(joined)], comment, () =>
          clientGone(request, reply),
        ),
      })
      // A view has no indexes of its own: listIndexes fails there, and nothing is suggested.
      const existing = clientGone(request, reply)
        ? null
        : await collection.indexes({ maxTimeMS: 5_000, comment } as never).catch(() => null)
      const suggestion =
        existing && warnings.some((w) => INDEX_WARNINGS.has(w.code)) ? suggestIndex(query, existing) : null
      const { raw: _raw, ...rest } = view
      return { ...rest, warnings, suggestion, raw: serializeValue(raw) } as ExplainResult
    },
  )
}
