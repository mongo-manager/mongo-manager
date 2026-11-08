// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Readable } from 'node:stream'
import { BackupUploadCreateSchema, InspectRequestSchema, type BackupUploadView } from '@mongo-manager/shared'
import type { BackupFileRow } from '../backup/store'
import { inspectBackup } from '../backup/inspect'
import { kitFrom } from '../backup/keys/kit'
import { slotKeysFor } from '../backup/keys/slot-keys'
import { canRestoreSomewhere, resolveSource, withPasswordThrottle } from '../backup/source'
import { prepareRestore } from '../backup/restore-plan'
import { RestoreRequestSchema, RestoreStartSchema } from '@mongo-manager/shared'
import { z } from 'zod'
import { requireAuth } from '../http/guards'
import { contentDisposition } from './transfer'
import { assertBackupAccess, toBackupView } from '../backup/access'
import { DumpRequestSchema, DumpStartSchema, permissionsFor } from '@mongo-manager/shared'
import { Errors } from '../errors'
import { parseInput } from '../validate'
import { safeEqual } from '../http/security'
import { requireConnection, requireExport, unattended } from '../connections/access'
import { plainProblem } from '../backup/schedules/policy'
import { toView } from '../jobs/visibility'
import { ownerOf } from '../transfer/files'
import { prepareDump } from '../backup/dump-plan'
import { backupFileName } from '../backup/dump-job'
import { findTools, toolsAvailability } from '../backup/tools'
import { serverVersionOf } from '../backup/series'
import { clientFor } from '../data/mongo-errors'
import { assertBackupRoom } from '../backup/room'
import { startSend, toCopyView } from '../backup/send-job'
import { SendRequestSchema } from '@mongo-manager/shared'
import { abortOnGone } from '../http/gone'
import { effectiveRole } from '../connections/access'
import { holdReadSlot } from '../data/page'

/** Spec §6: export on the connection, and jobs:run. */
export function requireBackup() {
  const exporter = requireExport()
  return async (request: FastifyRequest): Promise<void> => {
    await exporter(request)
    if (!permissionsFor(request.connectionRole!).has('jobs:run')) throw Errors.forbidden()
  }
}

const PlanQuery = z.strictObject({ asScheduled: z.literal('1').optional() })

/** Phase 3d-3a: dump and restore routes. */
export async function backupRoutes(app: FastifyInstance): Promise<void> {
  const C = '/connections/:id'

  app.post(
    `${C}/backup/plan`,
    { preHandler: requireBackup(), config: { masking: 'guarded' } },
    async (request, reply) => {
      const body = parseInput(DumpRequestSchema, request.body)
      // The schedule editor's plan: as the schedule will run (prepareDump).
      const { asScheduled } = parseInput(PlanQuery, request.query ?? {})
      // Fifteenth review of explain masking (Minor 7): a plan lists and reads each namespace (two
      // commands each, up to the archive's limit) — one of the user's read slots, as a read.
      holdReadSlot(request, reply, request.server.ctx.documents.slots)
      const { plan } = await prepareDump(request, body, { asScheduled: asScheduled === '1' })
      if (asScheduled !== '1') return plan
      // What the schedule's save will say of a plain format, by the same rule (third review, N4).
      const plain = plainProblem(app.ctx, unattended(request.principal!), request.connection!.id, body, [])
      return { ...plan, scheduledPersonal: plain === 'personal_plain' }
    },
  )

  app.post(
    `${C}/backup`,
    { preHandler: requireBackup(), config: { masking: 'guarded', audit: 'backup.dump.start' } },
    async (request, reply) => {
      const body = parseInput(DumpStartSchema, request.body)
      const { password, planHash: echoed, ...plain } = body
      const principal = request.principal!
      assertBackupRoom(app.ctx, principal)
      // Sixteenth review (M4): planned again here, so held as the plan route holds it.
      holdReadSlot(request, reply, request.server.ctx.documents.slots)
      const prepared = await prepareDump(request, plain)
      if (prepared.plan.refusals.length)
        throw Errors.conflict('The backup cannot start as asked', {
          reason: 'refused',
          reasons: prepared.plan.refusals,
        })
      if (!safeEqual(prepared.plan.planHash, echoed))
        throw Errors.conflict('The backup changed since its plan; review it again', {
          reason: 'plan_changed',
        })
      // Again, with no await before the start (3d-1 final review I9).
      assertBackupRoom(app.ctx, principal)
      const fileName = backupFileName(plain.scope, plain.format, app.ctx.now())
      const job = app.ctx.jobs.start(
        app.ctx.jobKinds['backup.dump'],
        {
          userId: principal.kind === 'user' ? principal.userId : null,
          connectionId: request.connection!.id,
          db: plain.scope.kind === 'server' ? '*' : plain.scope.db,
          coll: plain.scope.kind === 'collection' ? plain.scope.coll : '*',
          target: fileName,
        },
        {
          owner: ownerOf(principal),
          request: { ...plain, planHash: echoed },
          password: password ?? null,
          prepared,
          fileName,
          sendAs: plain.destinations.length ? principal : null,
          ...(request.agentVia ? { agent: request.agentVia } : {}),
        },
      )
      request.auditInfo = {
        details: {
          job: job.id,
          scope: plain.scope.kind,
          engine: plain.engine,
          format: plain.format,
          masked: prepared.plan.masked,
          anonymous: plain.anonymous,
          // Phase 3d-3b final review B5 (spec §4.7): where it goes once kept, and whether it stays here.
          destinations: plain.destinations,
          deleteLocal: plain.deleteLocal,
        },
      }
      return reply.status(202).send({ job: toView(app.ctx, principal, job) })
    },
  )

  const BackupParams = z.object({ backupId: z.string().uuid() })
  const ListQuery = z.object({ connectionId: z.string().min(1).max(64).optional() })

  /** Spec §3.3: the caller's kept backups they may still use, newest first. */
  app.get('/backups', { preHandler: requireAuth }, async (request) => {
    const { connectionId } = parseInput(ListQuery, request.query)
    const owner = ownerOf(request.principal!)
    return app.ctx.backup.store
      .list(owner, connectionId ? { connectionId } : {})
      .filter((row) => {
        try {
          assertBackupAccess(app.ctx, request.principal!, row)
          return true
        } catch {
          return false
        }
      })
      .map((row) => {
        // Phase 3d-3c: a scheduled backup is marked with its schedule while that exists.
        const schedule = row.scheduleId ? app.ctx.backup.schedules.get(row.scheduleId) : undefined
        return toBackupView(
          row,
          app.ctx.backup.copies.byBackup(row.id).map((c) => toCopyView(app.ctx, c)),
          schedule ? { id: schedule.id, name: schedule.name } : null,
        )
      })
  })

  /** Phase 3d-3b spec §1.2: send a kept backup to destinations (D8: the download checks first). */
  app.post(
    '/backups/:backupId/send',
    { preHandler: requireAuth, config: { audit: 'backup.send.start' } },
    async (request, reply) => {
      const { backupId } = parseInput(BackupParams, request.params)
      const body = parseInput(SendRequestSchema, request.body)
      const principal = request.principal!
      const row = app.ctx.backup.store.get(ownerOf(principal), backupId)
      if (!row) throw Errors.notFound('Backup not found')
      assertBackupAccess(app.ctx, principal, row)
      const job = startSend(app.ctx, principal, row, body.destinationIds, body.deleteLocal)
      request.auditInfo = {
        details: {
          job: job.id,
          backup: row.id,
          destinations: body.destinationIds,
          deleteLocal: body.deleteLocal,
        },
      }
      return reply.status(202).send({ job: toView(app.ctx, principal, job) })
    },
  )

  /** U9: the storage bar and the empty state's "kept for N hours". */
  app.get('/backups/usage', { preHandler: requireAuth }, async (request) => ({
    used: app.ctx.backup.store.usage(ownerOf(request.principal!)),
    quota: app.ctx.backup.limits.quota,
    ttlHours: Math.round(app.ctx.backup.limits.ttlMs / 3600_000),
    // The part size an encrypted backup gets when none is chosen (MM_BACKUP_CHUNK_MB).
    chunkMb: app.ctx.backup.limits.chunkBytes / (1024 * 1024),
  }))

  app.get(
    '/backups/:backupId/download',
    { preHandler: requireAuth, config: { audit: 'backup.download' } },
    async (request, reply) => {
      const { backupId } = parseInput(BackupParams, request.params)
      const row = app.ctx.backup.store.get(ownerOf(request.principal!), backupId)
      if (!row) throw Errors.notFound('Backup not found')
      assertBackupAccess(app.ctx, request.principal!, row)
      request.auditInfo = {
        details: { backup: row.id, connection: row.connectionId, size: row.size, format: row.meta!.format },
      }
      const handle = await app.ctx.backup.store.openRead(row)
      // A download the browser never renders (3d-1 T14).
      return reply
        .header('content-type', row.meta!.format === 'gzip' ? 'application/gzip' : 'application/octet-stream')
        .header('content-disposition', contentDisposition(row.name))
        .header('content-length', String(row.size))
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "sandbox; default-src 'none'")
        .header('cache-control', 'no-store')
        .send(handle.createReadStream())
    },
  )

  app.delete(
    '/backups/:backupId',
    { preHandler: requireAuth, config: { audit: 'backup.delete' } },
    async (request, reply) => {
      const { backupId } = parseInput(BackupParams, request.params)
      const owner = ownerOf(request.principal!)
      const row = app.ctx.backup.store.get(owner, backupId)
      if (!row || row.kind !== 'backup') throw Errors.notFound('Backup not found')
      // Final review minor 15: one still being written belongs to its job (cancel the job instead).
      if (!row.complete)
        throw Errors.conflict('This backup is still being written; cancel its job to stop it', {
          reason: 'backup_running',
        })
      app.ctx.backup.store.delete(owner, backupId)
      request.auditInfo = { details: { backup: row.id, connection: row.connectionId } }
      return reply.status(204).send()
    },
  )

  // Plan ruling 2: resumable uploads, raw bytes streamed to disk; this parser exists only here.
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload))
  const UploadParams = z.object({ uploadId: z.string().uuid() })
  const OffsetQuery = z.object({ offset: z.coerce.number().int().min(0) })
  const uploadView = (row: BackupFileRow): BackupUploadView => ({
    uploadId: row.id,
    name: row.name,
    size: row.declaredSize ?? 0,
    received: row.size,
    complete: row.complete,
  })
  const ownUpload = (request: FastifyRequest): BackupFileRow => {
    const { uploadId } = parseInput(UploadParams, request.params)
    const row = app.ctx.backup.store.get(ownerOf(request.principal!), uploadId)
    if (!row || row.kind !== 'upload') throw Errors.notFound('Upload not found')
    return row
  }

  app.post(
    '/backups/uploads',
    { preHandler: requireAuth, config: { audit: 'backup.upload' } },
    async (request, reply) => {
      const body = parseInput(BackupUploadCreateSchema, request.body)
      if (!canRestoreSomewhere(app.ctx, request.principal!)) throw Errors.forbidden()
      const row = app.ctx.backup.store.createUpload({
        owner: ownerOf(request.principal!),
        name: body.name,
        size: body.size,
      })
      request.auditInfo = { details: { upload: row.id, size: body.size } }
      return reply.status(201).send(uploadView(row))
    },
  )

  app.put(
    '/backups/uploads/:uploadId',
    { preHandler: requireAuth, config: { streamBody: true } },
    async (request) => {
      if (!String(request.headers['content-type'] ?? '').startsWith('application/octet-stream'))
        throw Errors.unsupportedType()
      const row = ownUpload(request)
      const { offset } = parseInput(OffsetQuery, request.query)
      const length = Number(request.headers['content-length'])
      const leave = app.ctx.backup.uploads.enter(row.owner)
      try {
        return await app.ctx.backup.store.appendUpload({
          owner: row.owner,
          id: row.id,
          offset,
          body: request.body as Readable,
          ...(Number.isSafeInteger(length) && length >= 0 ? { declaredLength: length } : {}),
        })
      } finally {
        leave()
      }
    },
  )

  app.get('/backups/uploads/:uploadId', { preHandler: requireAuth }, async (request) =>
    uploadView(ownUpload(request)),
  )

  app.delete('/backups/uploads/:uploadId', { preHandler: requireAuth }, async (request, reply) => {
    const row = ownUpload(request)
    app.ctx.backup.store.delete(row.owner, row.id)
    return reply.status(204).send()
  })

  /** U4: what a backup holds, from its prelude; while uploading, "waiting"; encrypted, "password". */
  app.post(
    '/backups/inspect',
    { preHandler: requireAuth, config: { audit: 'backup.inspect' } },
    async (request, reply) => {
      const body = parseInput(InspectRequestSchema, request.body)
      const principal = request.principal!
      const row = resolveSource(app.ctx, principal, body.source)
      request.auditInfo = { details: { source: body.source.kind, file: row.id } }
      // Security review 2026-10-13 (M4): under the server's read gate, taken before a kit's key is
      // read (round 2, Minor 1); a client gone stops the read and gives the slot back (Minor 2).
      const leave = app.ctx.backup.reads.enter(ownerOf(principal))
      const ctl = abortOnGone(reply)
      // Phase 3d-3c: a kit's key lives for this request only.
      let kitKey: Buffer | null = null
      let found: Awaited<ReturnType<typeof inspectBackup>>
      try {
        kitKey = body.kit !== undefined ? kitFrom(body.kit) : null
        found = await withPasswordThrottle(app.ctx, ownerOf(principal), row, (onWrongPassword) =>
          inspectBackup(app.ctx.backup.store, row, {
            ...(body.password !== undefined ? { password: body.password } : {}),
            keys: slotKeysFor(app.ctx, ownerOf(principal), kitKey),
            signal: ctl.signal,
            onWrongPassword,
          }),
        )
      } finally {
        leave()
        kitKey?.fill(0)
      }
      // Final review minor 6: a poll that is still waiting is not a row in the audit log.
      if (found.state === 'waiting') request.auditInfo = { ...request.auditInfo, quiet: true }
      return found
    },
  )

  /** Spec §3.2, U5–U7: what a restore into this connection will do, and what it needs confirmed. */
  app.post(
    `${C}/restore/plan`,
    { preHandler: requireConnection('documents:write'), config: { masking: 'guarded' } },
    async (request, reply) =>
      (await prepareRestore(request, parseInput(RestoreRequestSchema, request.body), reply)).plan,
  )

  app.post(
    `${C}/restore`,
    {
      preHandler: requireConnection('documents:write'),
      config: { masking: 'guarded', audit: 'backup.restore.start' },
    },
    async (request, reply) => {
      const body = parseInput(RestoreStartSchema, request.body)
      const { password, kit, planHash: echoed, ...plain } = body
      const principal = request.principal!
      assertBackupRoom(app.ctx, principal)
      const prepared = await prepareRestore(
        request,
        {
          ...plain,
          ...(password !== undefined ? { password } : {}),
          ...(kit !== undefined ? { kit } : {}),
        },
        reply,
      )
      if (prepared.plan.refusals.length)
        throw Errors.conflict('The restore cannot start as asked', {
          reason: 'refused',
          reasons: prepared.plan.refusals,
        })
      if (!safeEqual(prepared.plan.planHash, echoed))
        throw Errors.conflict('The restore changed since its plan; review it again', {
          reason: 'plan_changed',
        })
      // Again, with no await before the start (3d-1 final review I9).
      assertBackupRoom(app.ctx, principal)
      const id = request.connection!.id
      if (prepared.addRules.length && !plain.dryRun) {
        // Spec §5.2: appended, never removed, before the restore starts; audited like the rules route.
        const current = app.ctx.personalFields.stored(id).rules
        app.ctx.personalFields.set(id, [...current, ...prepared.addRules])
        prepared.versions.target = app.ctx.personalFields.get(id).version
        app.ctx.audit.append({
          action: 'connections.personalFields',
          outcome: 'success',
          userId: principal.kind === 'user' ? principal.userId : null,
          username: null,
          ip: request.ip,
          connectionId: id,
          namespace: null,
          details: {
            before: current.length,
            after: current.length + prepared.addRules.length,
            by: 'backup.restore',
          },
        })
      }
      app.ctx.backup.store.keepUntil(prepared.row.id, app.ctx.now() + app.ctx.backup.limits.maxJobMs)
      const first = plain.mapping[0]!.to
      const job = app.ctx.jobs.start(
        app.ctx.jobKinds['backup.restore'],
        {
          userId: principal.kind === 'user' ? principal.userId : null,
          connectionId: id,
          db: first.db,
          coll: plain.mapping.length === 1 ? first.coll : '*',
          target: plain.dryRun ? `${prepared.row.name} (dry run)` : prepared.row.name,
        },
        {
          owner: ownerOf(principal),
          request: { ...plain, planHash: echoed },
          password: password ?? null,
          kit: kit !== undefined ? kitFrom(kit) : null,
          prepared,
          ...(request.agentVia ? { agent: request.agentVia } : {}),
        },
      )
      request.auditInfo = {
        details: {
          job: job.id,
          mode: plain.mode,
          engine: plain.engine,
          dryRun: plain.dryRun,
          namespaces: plain.mapping.length,
          masked: Boolean(prepared.plan.summary.mongoManager?.masked),
        },
      }
      return reply.status(202).send({ job: toView(app.ctx, principal, job) })
    },
  )

  // Plan ruling 13: availability depends on the caller's role and restriction here, and on the tunnel.
  app.get(
    `${C}/backup/tools`,
    { preHandler: requireConnection('documents:read'), config: { masking: 'names-only' } },
    async (request) => {
      const found = await findTools(app.ctx.backup.limits.toolsPath)
      // 8.3 and later need newer tools: the version is asked only where the answer can turn on it,
      // and the whole question, opening the client too, waits two seconds at most (second review);
      // a server that does not answer in time is judged as an old one.
      const version =
        found &&
        !request.connection!.settings.ssh?.enabled &&
        effectiveRole(app.ctx, request.principal!, request.connection!.id) === 'admin'
          ? await Promise.race([
              clientFor(request, { asStored: true })
                .then((client) => serverVersionOf(client, 2_000))
                .catch(() => null),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000).unref()),
            ])
          : null
      return toolsAvailability(app.ctx, request.principal!, request.connection!.id, found, version)
    },
  )
}
