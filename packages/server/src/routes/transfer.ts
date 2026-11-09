// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { Document } from 'mongodb'
import {
  findServerJs,
  permissionsFor,
  PresetSchema,
  SyncRequestSchema,
  type TransferReport,
} from '@mongo-manager/shared'
import type { Principal, ServerContext } from '../http/context'
import { fromClient } from '../data/ejson-io'
import { asConnectionFailure, withMongo } from '../data/mongo-errors'
import { toView } from '../jobs/visibility'
import { copyNeeds, resolveSide } from '../transfer/copy-access'
import { prepareCompare } from '../transfer/compare-access'
import type { SyncJobParams } from '../transfer/sync-job'
import { assertTransferRoom } from './data/transfer'
import { requireAuth } from '../http/guards'
import { parseInput } from '../validate'
import { Errors } from '../errors'
import { shownName } from '../transfer/copy-plan'
import { ownerOf, type TransferFile, type TransferFiles } from '../transfer/files'
import { effectiveRole, isRestricted, mayExport, personOf } from '../connections/access'

const JobParams = z.object({ jobId: z.string().uuid() })
const PresetParams = z.object({ presetId: z.string().uuid() })
const PresetQuery = z.object({ kind: z.enum(['import', 'export', 'copy']).optional() })

const TYPES: Record<string, string> = {
  csv: 'text/csv; charset=utf-8',
  sql: 'application/sql; charset=utf-8',
  json: 'application/json',
  ndjson: 'application/x-ndjson',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

/** A listing asked before a job starts: short, it answers by name. */
const LISTING_MS = 10_000

/** Spec §7 T14: a server-built name: an ASCII fallback plus RFC 5987; CR, LF and quotes cannot occur. */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || 'file'
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/** Streams a transfer file as a download that a browser never renders (spec §7 T14). */
export async function sendTransferFile(
  reply: FastifyReply,
  file: TransferFile,
  files: TransferFiles,
  name: string,
): Promise<FastifyReply> {
  const handle = await files.openRead(file)
  const ext = file.format ?? 'bin'
  // W4.6: a file that may still grow (a live sync's rejected records) is sent as it is now.
  const size = file.complete ? file.size : (await handle.stat()).size
  return reply
    .header('content-type', file.gzip ? 'application/gzip' : (TYPES[ext] ?? 'application/octet-stream'))
    .header('content-disposition', contentDisposition(`${name}.${ext}${file.gzip ? '.gz' : ''}`))
    .header('content-length', String(size))
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "sandbox; default-src 'none'")
    .header('cache-control', 'no-store')
    .send(size > 0 ? handle.createReadStream({ start: 0, end: size - 1 }) : (await handle.close(), ''))
}

/**
 * Phase 3d-2 final review I2: a copy's, compare's or sync's report and files show data of two
 * connections. Like an export file, they are withdrawn (410) when the caller can no longer read
 * either side or export from the source, became restricted on a side they were not masked for, or
 * the personal-field rules moved since they were made.
 */
function assertTwoSidedResult(
  ctx: ServerContext,
  principal: Principal,
  jobId: string,
  report: TransferReport | undefined,
): void {
  const job = ctx.jobs.get(jobId)
  if (
    !job ||
    !job.targetConnectionId ||
    !(job.kind === 'data.copy' || job.kind === 'data.compare' || job.kind === 'data.sync')
  )
    return
  for (const id of [job.connectionId, job.targetConnectionId]) {
    const role = ctx.connections.get(id) ? effectiveRole(ctx, principal, id) : null
    if (!role || !permissionsFor(role).has('documents:read'))
      throw Errors.gone('You can no longer read one of the connections of this transfer')
  }
  if (!mayExport(ctx, principal, job.connectionId))
    throw Errors.gone('You can no longer export from this connection')
  // Only the two-sided reports (copy, compare, sync) carry both sides' versions and restrictions.
  if (!report || (report.kind !== 'copy' && report.kind !== 'compare' && report.kind !== 'sync')) return
  if (
    ctx.personalFields.get(job.connectionId).version !== report.versions.source ||
    ctx.personalFields.get(job.targetConnectionId).version !== report.versions.target
  )
    throw Errors.gone('The personal-field rules changed; run it again')
  if (!('restricted' in report)) return
  if (
    (!report.restricted.source && isRestricted(ctx, principal, job.connectionId)) ||
    (!report.restricted.target && isRestricted(ctx, principal, job.targetConnectionId))
  )
    throw Errors.gone('Personal fields are now hidden from you; run it again')
}

/** Phase 3d-1: the caller's own transfer results — job reports and files (owner only, by job id). */
export async function transferApiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/transfer/jobs/:jobId/report', { preHandler: requireAuth }, async (request) => {
    const { jobId } = parseInput(JobParams, request.params)
    const report = app.ctx.transfer.reports.get(ownerOf(request.principal!), jobId)
    if (!report) throw Errors.notFound('Report not found')
    assertTwoSidedResult(app.ctx, request.principal!, jobId, report)
    return report
  })

  // Spec §4.4: the caller's own saved settings.
  app.get('/transfer/presets', { preHandler: requireAuth }, async (request) => {
    const { kind } = parseInput(PresetQuery, request.query)
    return { presets: app.ctx.transfer.presets.list(ownerOf(request.principal!), kind) }
  })
  app.post('/transfer/presets', { preHandler: requireAuth }, async (request, reply) => {
    const input = parseInput(PresetSchema, request.body)
    return reply.status(201).send(app.ctx.transfer.presets.create(ownerOf(request.principal!), input))
  })
  app.put('/transfer/presets/:presetId', { preHandler: requireAuth }, async (request) => {
    const { presetId } = parseInput(PresetParams, request.params)
    return app.ctx.transfer.presets.update(
      ownerOf(request.principal!),
      presetId,
      parseInput(PresetSchema, request.body),
    )
  })
  app.delete('/transfer/presets/:presetId', { preHandler: requireAuth }, async (request, reply) => {
    const { presetId } = parseInput(PresetParams, request.params)
    app.ctx.transfer.presets.delete(ownerOf(request.principal!), presetId)
    return reply.status(204).send()
  })

  // Plan ruling 3: a file outlives neither the right to export nor the rules it was masked under.
  app.get(
    '/transfer/files/:jobId',
    { preHandler: requireAuth, config: { audit: 'transfer.download' } },
    async (request, reply) => {
      const { jobId } = parseInput(JobParams, request.params)
      const principal = request.principal!
      const { ctx } = app
      const file = ctx.transfer.files.byJob(ownerOf(principal), jobId, 'export')
      if (!file || !file.complete) throw Errors.notFound('File not found')
      if (file.expiresAt <= ctx.now()) throw Errors.gone('The file expired; export again')
      if (!ctx.connections.get(file.connectionId) || !mayExport(ctx, principal, file.connectionId))
        throw Errors.gone('You can no longer export from this connection')
      if (!file.masked && isRestricted(ctx, principal, file.connectionId))
        throw Errors.gone('Personal fields are now hidden from you; export again')
      if (file.masked && ctx.personalFields.get(file.connectionId).version !== file.rulesVersion)
        throw Errors.gone('The personal-field rules changed; export again')
      request.auditInfo = { details: { job: jobId, kind: 'export', size: file.size, masked: file.masked } }
      return sendTransferFile(reply, file, ctx.transfer.files, file.name)
    },
  )

  // Phase 3d-2 spec §6.4, T15: a sync takes everything but its switches from the stored comparison,
  // checks it is the caller's, alive and made under today's rules, and re-guards both sides now.
  app.post(
    '/transfer/sync',
    { preHandler: requireAuth, config: { audit: 'transfer.sync.start' } },
    async (request, reply) => {
      const body = parseInput(SyncRequestSchema, request.body)
      const principal = request.principal!
      const { ctx } = app
      const compared = ctx.transfer.reports.get(ownerOf(principal), body.compareJobId)
      if (!compared || compared.kind !== 'compare') throw Errors.notFound('Comparison not found')
      // Final review I9: a failed or cancelled comparison is partial; its counts are no baseline.
      if (!compared.complete || ctx.jobs.get(body.compareJobId)?.state !== 'done')
        throw Errors.conflict('The comparison did not finish; compare again', {
          reason: 'compare_incomplete',
        })
      const src = compared.source
      const dst = compared.target
      if (
        ctx.personalFields.get(src.connectionId).version !== compared.versions.source ||
        ctx.personalFields.get(dst.connectionId).version !== compared.versions.target
      )
        throw Errors.conflict('The personal-field rules changed since the comparison; compare again', {
          reason: 'rules_changed',
        })
      resolveSide(ctx, principal, src.connectionId, ['documents:read'])
      if (!mayExport(ctx, principal, src.connectionId)) throw Errors.forbidden()
      resolveSide(
        ctx,
        principal,
        dst.connectionId,
        copyNeeds({ mode: 'upsert', indexes: false, createsCollections: false, deletes: body.delete }),
      )
      if (body.delete && body.confirm !== (dst.coll ?? dst.db))
        throw Errors.validation('Type the target name to confirm deletions', { reason: 'confirm_name' })
      // Final review M9: the stored filter is checked again: server-side JavaScript may be off now.
      const storedFilter = fromClient<Document>(compared.filter, 'filter')
      const js = findServerJs(storedFilter)
      if (js && !ctx.config.allowServerJs)
        throw Errors.validation(`${js} runs JavaScript on the MongoDB server and is disabled.`)
      assertTransferRoom(ctx, principal)
      const sourceClient = await ctx.manager
        .getClient(src.connectionId, { user: personOf(principal) })
        .catch(asConnectionFailure)
      const {
        sourceClient: _s,
        targetClient,
        ...prepared
      } = await prepareCompare(
        ctx,
        principal,
        { connectionId: src.connectionId, client: sourceClient },
        {
          db: src.db,
          pairs: compared.collections.map((c): [string, string] => [c.source, c.target]),
          target: { connectionId: dst.connectionId, db: dst.db },
          filter: storedFilter,
          ignore: compared.ignore,
        },
      )
      // Final review of explain masking (Minor 1): MongoDB replaces no single document of a time
      // series, and a pinned delete there matches nothing (its $expr meets the buckets): said now,
      // not as documents "changed meanwhile".
      if (body.replace || body.delete) {
        // Filtered by name alone (what a listing of the collections a user may read takes), the
        // kind read from each.
        const series = (
          await withMongo(() =>
            targetClient
              .db(dst.db)
              .listCollections(
                { name: { $in: prepared.pairs.map((p) => p.target) } },
                { nameOnly: true, authorizedCollections: true, maxTimeMS: LISTING_MS },
              )
              .toArray(),
          )
        ).filter((c) => c.type === 'timeseries')
        if (series.length)
          throw Errors.conflict(
            `${shownName(String(series[0]!.name))} is a time series: a sync can only insert into it`,
            {
              reason: 'target_timeseries',
              collection: shownName(String(series[0]!.name)),
            },
          )
      }
      const ruledTarget =
        prepared.targetMasker !== null &&
        prepared.pairs.some((p) => prepared.targetMasker!.forNs(dst.db, p.target).any)
      if (body.delete && ruledTarget)
        throw Errors.forbidden('Deleting where personal fields are hidden from you is not allowed', {
          reason: 'personal_delete',
        })
      const sameNames = src.db === dst.db && prepared.pairs.some((p) => p.source === p.target)
      if (sameNames && prepared.deployment === 'same')
        throw Errors.conflict('The source and the target are the same collection', {
          reason: 'same_namespace',
        })
      if (body.delete && sameNames && prepared.deployment === 'unknown')
        throw Errors.conflict('The target may be the source itself; deletions are refused', {
          reason: 'delete_uncertain',
        })
      // Final review I5: a sync writes like a copy: values under rules the target lacks need consent.
      const personalUnruled = prepared.missingRules.length > 0 && (body.insert || body.replace)
      if (personalUnruled && !body.confirmPersonal)
        throw Errors.conflict('Personal values would be visible on the target; confirm to sync', {
          reason: 'confirm_personal',
          missingRules: prepared.missingRules,
        })
      assertTransferRoom(ctx, principal)
      const params: SyncJobParams = {
        owner: ownerOf(principal),
        compareJobId: body.compareJobId,
        prepared,
        source: src,
        target: dst,
        switches: { insert: body.insert, replace: body.replace, delete: body.delete },
        compared: compared.collections.map((c) => ({ source: c.source, onlyTarget: c.onlyTarget })),
      }
      const job = ctx.jobs.start(
        ctx.jobKinds['data.sync'],
        {
          userId: principal.kind === 'user' ? principal.userId : null,
          connectionId: src.connectionId,
          targetConnectionId: dst.connectionId,
          db: src.db,
          coll: src.coll ?? '*',
          target: `${dst.db}${dst.coll ? `.${dst.coll}` : ''}`,
        },
        params,
      )
      request.auditInfo = {
        details: { job: job.id, compareJobId: body.compareJobId, delete: body.delete, personalUnruled },
      }
      return reply.status(202).send({ job: toView(ctx, principal, job) })
    },
  )

  app.get(
    '/transfer/jobs/:jobId/rejected',
    { preHandler: requireAuth, config: { audit: 'transfer.download' } },
    async (request, reply) => {
      const { jobId } = parseInput(JobParams, request.params)
      const file = app.ctx.transfer.files.byJob(ownerOf(request.principal!), jobId, 'rejected')
      if (!file || !file.complete || file.expiresAt <= app.ctx.now()) throw Errors.notFound('File not found')
      assertTwoSidedResult(
        app.ctx,
        request.principal!,
        jobId,
        app.ctx.transfer.reports.get(ownerOf(request.principal!), jobId),
      )
      request.auditInfo = { details: { job: jobId, kind: 'rejected', size: file.size } }
      return sendTransferFile(reply, file, app.ctx.transfer.files, file.name)
    },
  )
}
