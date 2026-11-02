import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Db } from 'mongodb'
import type { Readable } from 'node:stream'
import { z } from 'zod'
import { EJSON } from 'bson'
import {
  ConvertSamplesRequestSchema,
  ExportRequestSchema,
  ImportRequestSchema,
  SqlExportRequestSchema,
  SqlImportRequestSchema,
  TransferPreviewRequestSchema,
  permissionsFor,
  type SqlPreviewResponse,
} from '@mongo-manager/shared'
import { Errors } from '../../errors'
import { parseInput } from '../../validate'
import { isAdminOnlyNamespace, requireConnection, requireExport } from '../../connections/access'
import { sourcePlan } from '../../transfer/source-plan'
import type { ExportJobParams } from '../../transfer/export-job'
import type { Principal, ServerContext } from '../../http/context'
import { clientFor, toAppError, withMongo } from '../../data/mongo-errors'
import { maskerFor } from '../../masking/request'
import { gateFor } from '../../masking/restricted'
import { TRANSFER_KINDS, toView } from '../../jobs/visibility'
import { ownerOf, type TransferFile } from '../../transfer/files'
import { openDump, preview } from '../../transfer/source'
import { convertSamples } from '../../transfer/samples'
import { scanSqlDump } from '../../transfer/formats/sqldump'
import { uniqueNames } from '../../transfer/formats/sqlwrite'
import { MAX_TRANSFER_JOBS, MiB, SQL_PREVIEW_MS } from '../../transfer/limits'

/** Review M17: the columns a SQL preview lists for one table (columnCount says how many there are). */
const PREVIEW_COLUMNS = 200
import { validateMappingShape } from '../../transfer/mapping'
import { checkImportPlan } from '../../transfer/protect'
import { CollParams, DbParams, SYSTEM_DATABASES, assertTargetAllowed } from './params'
import { SQL_PLUGIN } from '../../plugins/service'

const UploadQuery = z.object({ name: z.string().max(255).default('upload') })
const UploadParams = z.object({ id: z.string().min(1).max(64), uploadId: z.string().uuid() })

/** Phase 3d-1 §8.2: documents:write plus jobs:run on the connection. */
export function requireImport() {
  const write = requireConnection('documents:write')
  return async (request: FastifyRequest): Promise<void> => {
    await write(request)
    if (!permissionsFor(request.connectionRole!).has('jobs:run')) throw Errors.forbidden()
  }
}

/**
 * A database's collection names as its user may list them (review 2026-10-11): a MongoDB user
 * allowed some collections only lists them with authorizedCollections, as the collection list does.
 */
export async function listCollectionNames(db: Db): Promise<string[]> {
  try {
    return (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name)
  } catch (e) {
    if ((e as { code?: unknown }).code !== 13) throw toAppError(e)
    return withMongo(async () =>
      (await db.listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray()).map(
        (c) => c.name,
      ),
    )
  }
}

/** "20261001-143005": the time part of an export's file name. */
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

/** Spec §7 T2, T18: at most MAX_TRANSFER_JOBS running transfer jobs per user. */
export function assertTransferRoom(ctx: ServerContext, principal: Principal): void {
  const userId = principal.kind === 'user' ? principal.userId : null
  const running = ctx.jobs
    .list({ state: 'running' })
    .filter((j) => TRANSFER_KINDS.has(j.kind) && j.userId === userId).length
  if (running >= MAX_TRANSFER_JOBS)
    throw Errors.conflict(`You already have ${MAX_TRANSFER_JOBS} transfers running`, {
      reason: 'transfer_busy',
    })
}

/**
 * Twenty-first and twenty-second reviews of explain masking (nit, I-1, M-4): an import into a view
 * writes nothing (MongoDB refuses every write into one), as a copy's and a restore's say before they
 * start. Asked once, by name only and of the collections the connection's user may read, so a user
 * granted a few collections alone imports as before.
 */
async function refuseViewTargets(request: FastifyRequest, db: string, colls: string[]): Promise<void> {
  const client = await clientFor(request)
  const names = [...new Set(colls)]
  const infos = await withMongo(() =>
    client
      .db(db)
      .listCollections({ name: { $in: names } }, { nameOnly: true, authorizedCollections: true })
      .toArray(),
  )
  const view = infos.find((i) => i.type === 'view')
  if (view)
    throw Errors.conflict(`The target ${String(view.name).slice(0, 200)} is a view`, {
      reason: 'target_is_view',
      collection: String(view.name).slice(0, 200),
    })
}

/**
 * Phase 3d-1: file import and export on a connection. Uploads and previews only read the caller's own
 * bytes ('names-only': MongoDB is never reached); the import and export routes go through the gate.
 */
export async function transferRoutes(app: FastifyInstance): Promise<void> {
  // Spec §4.1: uploads are raw bytes streamed to disk; this parser exists only inside this plugin,
  // and TransferFiles.receive enforces the size (a stream parser is not bound by bodyLimit).
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload))
  const uploads = '/connections/:id/transfer/uploads'
  const importer = requireImport()
  // User request 2026-11-02: SQL import and export come with the SQL → MongoDB plugin; while it does
  // not run, their routes are refused as their pages are not offered.
  const assertSqlPlugin = () => {
    if (!app.ctx.plugins.runs(SQL_PLUGIN))
      throw Errors.forbidden(
        'SQL import and export come with the SQL → MongoDB plugin: turn it on in Plugins',
        {
          reason: 'sql_plugin_off',
        },
      )
  }
  const sqlPlugin = async () => assertSqlPlugin()

  app.put(
    uploads,
    { preHandler: importer, config: { masking: 'names-only', audit: 'transfer.upload', streamBody: true } },
    async (request, reply) => {
      if (!String(request.headers['content-type'] ?? '').startsWith('application/octet-stream'))
        throw Errors.unsupportedType()
      const { name } = parseInput(UploadQuery, request.query)
      const owner = ownerOf(request.principal!)
      const leave = app.ctx.transfer.uploads.enter(owner)
      try {
        const length = Number(request.headers['content-length'])
        const file = await app.ctx.transfer.files.receive({
          owner,
          connectionId: request.connection!.id,
          name,
          body: request.body as Readable,
          ...(Number.isFinite(length) ? { declaredLength: length } : {}),
        })
        request.auditInfo = { details: { upload: file.id, name: file.name, size: file.size } }
        return reply.status(201).send({ uploadId: file.id, size: file.size })
      } finally {
        leave()
      }
    },
  )

  const ownUpload = (request: FastifyRequest): TransferFile => {
    const { uploadId } = parseInput(UploadParams, request.params)
    const file = app.ctx.transfer.files.get(ownerOf(request.principal!), uploadId)
    if (!file || file.kind !== 'upload' || !file.complete || file.connectionId !== request.connection!.id)
      throw Errors.notFound('Upload not found')
    return file
  }

  app.post(
    `${uploads}/:uploadId/preview`,
    { preHandler: importer, config: { masking: 'names-only' } },
    async (request) => {
      const file = ownUpload(request)
      const body = parseInput(TransferPreviewRequestSchema, request.body ?? {})
      const leave = app.ctx.transfer.previews.enter(file.owner)
      try {
        return await preview(file, app.ctx.transfer.files, body, app.ctx.transfer.limits)
      } finally {
        leave()
      }
    },
  )

  // W4.1: the mapping step's samples as the import would write them. The text is the caller's own
  // (bounded by the schema and the body limit); MongoDB is never reached ('names-only').
  app.post(
    '/connections/:id/transfer/convert-samples',
    { preHandler: importer, config: { masking: 'names-only' } },
    async (request) => convertSamples(parseInput(ConvertSamplesRequestSchema, request.body ?? {})),
  )

  app.post(
    '/connections/:id/databases/:db/collections/:coll/import',
    { preHandler: importer, config: { masking: 'guarded', audit: 'transfer.import.start' } },
    async (request, reply) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const body = parseInput(ImportRequestSchema, request.body)
      const principal = request.principal!
      const owner = ownerOf(principal)
      const file = app.ctx.transfer.files.get(owner, body.uploadId)
      if (!file || file.kind !== 'upload' || !file.complete || file.connectionId !== request.connection!.id)
        throw Errors.notFound('Upload not found')
      if ((body.format === 'csv' || body.format === 'xlsx') && !body.mapping)
        throw Errors.validation('CSV and xlsx imports need a mapping', { reason: 'mapping_required' })
      const paths = validateMappingShape({
        mapping: body.mapping,
        constants: body.constants,
        keys: body.keys,
        allowUnusual: body.allowUnusualKeys,
      })
      assertTransferRoom(app.ctx, principal)
      await refuseViewTargets(request, db, [coll])
      // Spec §8.2: a restricted caller's plan is checked now; each record is checked again as written.
      const masker = maskerFor(request)
      if (masker) {
        const gate = gateFor(request, await clientFor(request))!
        await withMongo(() =>
          checkImportPlan(
            db,
            coll,
            { paths, keys: body.mode === 'insert' ? [] : body.keys, mode: body.mode },
            gate,
          ),
        )
      }
      // Again, with no await before the start: requests that ran meanwhile have started theirs (I9).
      assertTransferRoom(app.ctx, principal)
      const job = app.ctx.jobs.start(
        app.ctx.jobKinds['data.import'],
        {
          userId: principal.kind === 'user' ? principal.userId : null,
          connectionId: request.connection!.id,
          db,
          coll,
          // The jobs list and the end notice tell a dry run from an import.
          target: body.dryRun ? `${file.name} (dry run)` : file.name,
        },
        { owner, uploadId: file.id, request: body, masker },
      )
      request.auditInfo = {
        details: { job: job.id, format: body.format, mode: body.mode, dryRun: body.dryRun },
      }
      return reply.status(202).send({ job: toView(app.ctx, principal, job) })
    },
  )

  // User request 2026-10-10: a SQL dump's tables, their columns and first rows — the caller's own
  // bytes only ('names-only'); the dump is read, never run.
  app.post(
    `${uploads}/:uploadId/sql-preview`,
    { preHandler: [importer, sqlPlugin], config: { masking: 'names-only' } },
    async (request): Promise<SqlPreviewResponse> => {
      const file = ownUpload(request)
      const { limits } = app.ctx.transfer
      const leave = app.ctx.transfer.previews.enter(file.owner)
      let opened: Awaited<ReturnType<typeof openDump>> | undefined
      // Review I3: a whole dump is read for its tables, but for so long only, and not for a caller
      // who left; what was read by then is shown, said to be cut short.
      const gone = new AbortController()
      const onClose = () => gone.abort()
      request.raw.once('close', onClose)
      try {
        // Review I1: inside the try, so a file that cannot be opened gives the preview back.
        opened = await openDump(file, app.ctx.transfer.files, limits)
        // Review M17: the response stays small: 2 MiB of first rows, 200 columns a table listed.
        const scan = await scanSqlDump(opened.bytes, {
          samples: 5,
          sampleBytes: 2 * MiB,
          columnsPerTable: PREVIEW_COLUMNS,
          signal: AbortSignal.any([gone.signal, AbortSignal.timeout(limits.previewMs ?? SQL_PREVIEW_MS)]),
        })
        return {
          gzip: opened.gzip,
          dialect: scan.dialect,
          tables: scan.tables.map((t) => ({
            key: t.key,
            name: t.name,
            ...(t.schema ? { schema: t.schema } : {}),
            columns: t.columns.map((c) => ({ name: c.name, type: c.type, kind: c.kind })),
            columnCount: t.columnCount,
            primaryKey: t.primaryKey,
            rows: t.rows,
            samples: t.samples.map((d) => EJSON.serialize(d, { relaxed: false }) as Record<string, unknown>),
            // Review M10: why every row of a table would fail, before it is chosen.
            ...(t.error ? { error: t.error } : {}),
          })),
          skipped: scan.skipped,
          truncated: scan.truncated,
          ...(scan.error ? { error: scan.error } : {}),
        }
      } finally {
        request.raw.off('close', onClose)
        await opened?.close()
        leave()
      }
    },
  )

  // User request 2026-10-10: the chosen tables of a dump into collections of this database, as one job.
  app.post(
    '/connections/:id/databases/:db/import-sql',
    { preHandler: [importer, sqlPlugin], config: { masking: 'guarded', audit: 'transfer.importSql.start' } },
    async (request, reply) => {
      const { db } = parseInput(DbParams, request.params)
      const body = parseInput(SqlImportRequestSchema, request.body)
      const principal = request.principal!
      const owner = ownerOf(principal)
      const file = app.ctx.transfer.files.get(owner, body.uploadId)
      if (!file || file.kind !== 'upload' || !file.complete || file.connectionId !== request.connection!.id)
        throw Errors.notFound('Upload not found')
      const chosen = body.tables.filter((t) => t.include)
      if (!chosen.length) throw Errors.validation('Choose at least one table', { reason: 'no_table' })
      // Data review 2026-10-13 (M7): two tables' rows with the same key (id 1 and id 1) would replace
      // each other in one collection, counted as matches.
      if (body.mode !== 'insert' && new Set(chosen.map((t) => t.collection)).size !== chosen.length)
        throw Errors.validation(
          'In upsert and merge, each table goes to its own collection: rows of two tables with the same key would replace each other',
          { reason: 'shared_collection' },
        )
      // A system database or collection is a connection admin's only, as for any write.
      assertTargetAllowed(request, db)
      for (const t of chosen) assertTargetAllowed(request, db, t.collection)
      assertTransferRoom(app.ctx, principal)
      await refuseViewTargets(
        request,
        db,
        chosen.map((t) => t.collection),
      )
      // Spec §8.2 (review M8): a restricted caller's plan is checked now as far as it is known (its
      // keys, an upsert); each table's columns when the job has read them; each row as written.
      const masker = maskerFor(request)
      if (masker) {
        const gate = gateFor(request, await clientFor(request))!
        for (const t of chosen)
          await withMongo(() =>
            checkImportPlan(
              db,
              t.collection,
              { paths: [], keys: body.mode === 'insert' ? [] : ['_id'], mode: body.mode },
              gate,
            ),
          )
      }
      // Again, with no await before the start: requests that ran meanwhile have started theirs (I9).
      assertTransferRoom(app.ctx, principal)
      const job = app.ctx.jobs.start(
        app.ctx.jobKinds['data.importSql'],
        {
          userId: principal.kind === 'user' ? principal.userId : null,
          connectionId: request.connection!.id,
          db,
          coll: '*',
          target: body.dryRun ? `${file.name} (dry run)` : file.name,
        },
        { owner, uploadId: file.id, request: body, masker },
      )
      request.auditInfo = {
        details: { job: job.id, tables: chosen.length, mode: body.mode, dryRun: body.dryRun },
      }
      return reply.status(202).send({ job: toView(app.ctx, principal, job) })
    },
  )

  app.post(
    '/connections/:id/databases/:db/collections/:coll/export',
    { preHandler: requireExport(), config: { masking: 'guarded', audit: 'transfer.export.start' } },
    async (request, reply) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const body = parseInput(ExportRequestSchema, request.body)
      // Review of 1.0.1 (I1): a collection exported as SQL is the plugin's too (the agent's way here).
      if (body.format === 'sql') assertSqlPlugin()
      const principal = request.principal!
      assertTransferRoom(app.ctx, principal)
      const client = await clientFor(request)
      // Spec §8.1: a restricted caller's source goes through the gate, as a read would.
      const gate = gateFor(request, client)
      const plan = await sourcePlan(request, db, coll, body.source, gate)
      const name = `${coll}-${stamp(app.ctx.now())}`
      const masked = gate !== null
      // Again, with no await before the start: requests that ran meanwhile have started theirs (I9).
      assertTransferRoom(app.ctx, principal)
      const job = app.ctx.jobs.start(
        app.ctx.jobKinds['data.export'],
        {
          userId: principal.kind === 'user' ? principal.userId : null,
          connectionId: request.connection!.id,
          db,
          coll,
          target: `${name}.${body.format}`,
        },
        {
          owner: ownerOf(principal),
          request: body,
          plan,
          masked,
          rulesVersion: app.ctx.personalFields.get(request.connection!.id).version,
          name,
        },
      )
      request.auditInfo = { details: { job: job.id, format: body.format, source: body.source.kind, masked } }
      return reply.status(202).send({ job: toView(app.ctx, principal, job) })
    },
  )

  // User requests 2026-10-11, 2026-10-12: the SQL ↔ MongoDB page — chosen collections of one
  // database as one SQL file; each collection planned as a whole-collection export is (the masking
  // gate per collection), each table named uniquely as its dialect compares.
  // The database is the address's, as an import's: every audit of the start names it (review I2).
  app.post(
    '/connections/:id/databases/:db/export-sql',
    {
      preHandler: [requireExport(), sqlPlugin],
      config: { masking: 'guarded', audit: 'transfer.exportSql.start' },
    },
    async (request, reply) => {
      const { db } = parseInput(DbParams, request.params)
      if (SYSTEM_DATABASES.has(db))
        throw Errors.validation('A system database is never exported as SQL', { reason: 'system_db' })
      const body = parseInput(SqlExportRequestSchema, request.body)
      const principal = request.principal!
      assertTransferRoom(app.ctx, principal)
      const client = await clientFor(request)
      const present = new Set(await listCollectionNames(client.db(db)))
      const missing = body.collections.find((c) => !present.has(c))
      if (missing !== undefined) throw Errors.notFound(`Collection not found: ${db}.${missing}`)
      // Security review C1: the collections come from the body, out of the connection guard's
      // sight — what a direct read refuses (credentials, key vaults, QE metadata) is refused here.
      if (request.connectionRole !== 'admin' && body.collections.some((c) => isAdminOnlyNamespace(db, c)))
        throw Errors.forbidden('System namespaces are restricted to connection admins')
      // A gate for each collection: one reads at most 100 views and index lists (review 2026-10-11).
      const masked = gateFor(request, client) !== null
      const dialect = body.sql.dialect
      const tables = uniqueNames(body.collections, dialect)
      const parts: NonNullable<ExportJobParams['parts']> = []
      for (const [i, coll] of body.collections.entries())
        parts.push({
          db,
          coll,
          table: tables[i]!,
          plan: await sourcePlan(request, db, coll, { kind: 'collection' }, gateFor(request, client)),
        })
      const request_ = ExportRequestSchema.parse({
        source: { kind: 'collection' },
        format: 'sql',
        gzip: body.gzip,
        sql: body.sql,
      })
      const name = `${db}-${stamp(app.ctx.now())}`
      // Again, with no await before the start: requests that ran meanwhile have started theirs (I9).
      assertTransferRoom(app.ctx, principal)
      const job = app.ctx.jobs.start(
        app.ctx.jobKinds['data.export'],
        {
          userId: principal.kind === 'user' ? principal.userId : null,
          connectionId: request.connection!.id,
          db,
          coll: '*',
          target: `${name}.sql${body.gzip ? '.gz' : ''}`,
        },
        {
          owner: ownerOf(principal),
          request: request_,
          plan: parts[0]!.plan,
          parts,
          masked,
          rulesVersion: app.ctx.personalFields.get(request.connection!.id).version,
          name,
        },
      )
      request.auditInfo = {
        details: {
          job: job.id,
          collections: parts.length,
          dialect,
          masked,
        },
      }
      return reply.status(202).send({ job: toView(app.ctx, principal, job) })
    },
  )

  app.delete(
    `${uploads}/:uploadId`,
    { preHandler: importer, config: { masking: 'names-only' } },
    async (request, reply) => {
      const file = ownUpload(request)
      app.ctx.transfer.files.delete(file.owner, file.id)
      return reply.status(204).send()
    },
  )
}
