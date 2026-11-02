import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Document } from 'mongodb'
import {
  CollectionCopyRequestSchema,
  CompareRequestSchema,
  DatabaseCompareRequestSchema,
  DatabaseCopyRequestSchema,
} from '@mongo-manager/shared'
import { fromClient } from '../../data/ejson-io'
import { prepareCompare } from '../../transfer/compare-access'
import type { CompareJobParams } from '../../transfer/compare-job'
import { Errors } from '../../errors'
import { safeEqual } from '../../http/security'
import { parseInput } from '../../validate'
import { isEncryptionNamespace, requireExport, SYSTEM_DATABASES } from '../../connections/access'
import { clientFor, withMongo } from '../../data/mongo-errors'
import { toView } from '../../jobs/visibility'
import { prepareCopy, type PrepareInput } from '../../transfer/copy-plan'
import { addMissingRules, startCopyJob } from '../../transfer/copy-start'
import { ownerOf } from '../../transfer/files'
import { assertTransferRoom } from './transfer'
import { CollParams, DbParams, assertNoServerJs } from './params'

const COLL = '/connections/:id/databases/:db/collections/:coll'
const DB = '/connections/:id/databases/:db'

/** Spec §7.4: at most this many collections in one database job. */
const MAX_COLLECTIONS = 1000

/** Phase 3d-2: copy, compare and sync routes on the source connection (the path's :id). */
export async function copyRoutes(app: FastifyInstance): Promise<void> {
  /** A database job's collections: the chosen ones (each must exist), or all; never system ones. */
  /**
   * A database job's collections — the chosen ones (each must exist), or all — and, for a copy, its
   * chosen views (final review M4): a list that names views copies only those; one that names none
   * leaves the views to the "views" option. System collections and Queryable Encryption's metadata
   * collections (enxcol_.*, final review M12) are never copied or compared.
   */
  async function databasePairs(
    request: FastifyRequest,
    db: string,
    chosen: string[] | undefined,
    allowViews = false,
  ): Promise<{ pairs: Array<[string, string]>; viewNames: string[] | null }> {
    if (SYSTEM_DATABASES.has(db))
      throw Errors.forbidden('System databases are not copied', { reason: 'system_namespace' })
    const client = await clientFor(request)
    const infos = await withMongo(() => client.db(db).listCollections({}, { nameOnly: true }).toArray())
    const copyable = (n: string) => !n.startsWith('system.') && !isEncryptionNamespace(db, n)
    const names = infos.filter((i) => i.type !== 'view' && copyable(i.name)).map((i) => i.name)
    const views = infos.filter((i) => i.type === 'view' && copyable(i.name)).map((i) => i.name)
    const pick = chosen ? chosen.filter((n) => !allowViews || !views.includes(n)) : names
    for (const n of pick) if (!names.includes(n)) throw Errors.notFound(`Collection ${n} not found`)
    if (pick.length > MAX_COLLECTIONS)
      throw Errors.validation(`At most ${MAX_COLLECTIONS} collections per job`)
    const viewNames = allowViews ? (chosen ?? []).filter((n) => views.includes(n)) : []
    return { pairs: pick.map((n) => [n, n]), viewNames: viewNames.length ? viewNames : null }
  }

  /** Spec §8.2: a start re-plans, refuses on any refusal or a changed plan, then starts the job. */
  async function startCopy(
    request: FastifyRequest,
    reply: FastifyReply,
    input: PrepareInput,
    planHash: string | undefined,
    jobTarget: { coll: string; target: string },
  ) {
    if (!planHash) throw Errors.validation('Start a copy from its plan', { reason: 'plan_required' })
    const principal = request.principal!
    assertTransferRoom(app.ctx, principal)
    const prepared = await prepareCopy(request, input)
    if (prepared.plan.refusals.length)
      throw Errors.conflict('The copy cannot start as asked', {
        reason: 'refused',
        reasons: prepared.plan.refusals,
      })
    if (!safeEqual(prepared.plan.planHash, planHash))
      throw Errors.conflict('The copy changed since its plan; review it again', { reason: 'plan_changed' })
    const addRules = addMissingRules(request, input, prepared, 'transfer.copy')
    const job = startCopyJob(request, input, prepared, addRules, jobTarget)
    request.auditInfo = {
      details: {
        job: job.id,
        target: input.target.connectionId,
        targetDb: input.target.db,
        mode: input.options.mode,
        masked: prepared.plan.masked,
        anonymous: input.options.anonymous,
        personalUnruled: prepared.plan.missingRules.length > 0 && !input.options.addRulesToTarget,
        rulesAdded: addRules.length,
      },
    }
    return reply.status(202).send({ job: toView(app.ctx, principal, job) })
  }

  app.post(
    `${COLL}/copy/plan`,
    { preHandler: requireExport(), config: { masking: 'guarded' } },
    async (request) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const { source, target, ...options } = parseInput(CollectionCopyRequestSchema, request.body)
      const prepared = await prepareCopy(request, {
        db,
        pairs: [[coll, target.coll]],
        views: false,
        target: { connectionId: target.connectionId, db: target.db },
        options,
        source,
      })
      return prepared.plan
    },
  )

  app.post(
    `${COLL}/copy`,
    { preHandler: requireExport(), config: { masking: 'guarded', audit: 'transfer.copy.start' } },
    async (request, reply) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const { source, target, ...options } = parseInput(CollectionCopyRequestSchema, request.body)
      return startCopy(
        request,
        reply,
        {
          db,
          pairs: [[coll, target.coll]],
          views: false,
          target: { connectionId: target.connectionId, db: target.db },
          options,
          source,
        },
        options.planHash,
        { coll, target: `${target.db}.${target.coll}` },
      )
    },
  )

  app.post(
    `${DB}/copy/plan`,
    { preHandler: requireExport(), config: { masking: 'guarded' } },
    async (request) => {
      const { db } = parseInput(DbParams, request.params)
      const { target, collections, views, ...options } = parseInput(DatabaseCopyRequestSchema, request.body)
      const { pairs, viewNames } = await databasePairs(request, db, collections, true)
      return (await prepareCopy(request, { db, pairs, views, viewNames, target, options, source: null })).plan
    },
  )

  app.post(
    `${DB}/copy`,
    { preHandler: requireExport(), config: { masking: 'guarded', audit: 'transfer.copy.start' } },
    async (request, reply) => {
      const { db } = parseInput(DbParams, request.params)
      const { target, collections, views, ...options } = parseInput(DatabaseCopyRequestSchema, request.body)
      const { pairs, viewNames } = await databasePairs(request, db, collections, true)
      return startCopy(
        request,
        reply,
        { db, pairs, views, viewNames, target, options, source: null },
        options.planHash,
        {
          coll: '*',
          target: `${target.db} (${pairs.length})`,
        },
      )
    },
  )

  /** Spec §6, §8.2: a compare job, from a collection or a database's chosen collections. */
  async function startCompare(
    request: FastifyRequest,
    reply: FastifyReply,
    input: {
      db: string
      pairs: Array<[string, string]>
      target: { connectionId: string; db: string }
      filter: Document
      filterText: Record<string, unknown>
      ignore: string[]
      coll: string | null
      targetColl: string | null
    },
  ) {
    const principal = request.principal!
    assertTransferRoom(app.ctx, principal)
    const {
      sourceClient: _s,
      targetClient: _t,
      ...prepared
    } = await prepareCompare(
      app.ctx,
      principal,
      { connectionId: request.connection!.id, client: await clientFor(request) },
      input,
    )
    assertTransferRoom(app.ctx, principal)
    const params: CompareJobParams = {
      owner: ownerOf(principal),
      prepared,
      source: { connectionId: request.connection!.id, db: input.db, coll: input.coll },
      target: { connectionId: input.target.connectionId, db: input.target.db, coll: input.targetColl },
      filter: input.filterText,
      ignore: input.ignore,
      sampleLimit: input.coll ? { perGroup: 50, total: 150 } : { perGroup: 10, total: 500 },
    }
    const job = app.ctx.jobs.start(
      app.ctx.jobKinds['data.compare'],
      {
        userId: principal.kind === 'user' ? principal.userId : null,
        connectionId: request.connection!.id,
        targetConnectionId: input.target.connectionId,
        db: input.db,
        coll: input.coll ?? '*',
        target: `${input.target.db}${input.targetColl ? `.${input.targetColl}` : ''}`,
      },
      params,
    )
    request.auditInfo = {
      details: { job: job.id, target: input.target.connectionId, targetDb: input.target.db },
    }
    return reply.status(202).send({ job: toView(app.ctx, principal, job) })
  }

  app.post(
    `${COLL}/compare`,
    { preHandler: requireExport(), config: { masking: 'guarded', audit: 'transfer.compare.start' } },
    async (request, reply) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const body = parseInput(CompareRequestSchema, request.body)
      const filter = fromClient<Document>(body.filter, 'filter')
      assertNoServerJs(request, filter)
      return startCompare(request, reply, {
        db,
        pairs: [[coll, body.target.coll]],
        target: { connectionId: body.target.connectionId, db: body.target.db },
        filter,
        filterText: body.filter,
        ignore: body.ignore,
        coll,
        targetColl: body.target.coll,
      })
    },
  )

  app.post(
    `${DB}/compare`,
    { preHandler: requireExport(), config: { masking: 'guarded', audit: 'transfer.compare.start' } },
    async (request, reply) => {
      const { db } = parseInput(DbParams, request.params)
      const body = parseInput(DatabaseCompareRequestSchema, request.body)
      return startCompare(request, reply, {
        db,
        pairs: (await databasePairs(request, db, body.collections)).pairs,
        target: body.target,
        filter: {},
        filterText: {},
        ignore: body.ignore,
        coll: null,
        targetColl: null,
      })
    },
  )
}
