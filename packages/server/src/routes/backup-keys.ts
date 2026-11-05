// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  KeyConfirmSchema,
  KeyCreateSchema,
  KeyImportSchema,
  type BackupKeyCreated,
  type BackupKeyView,
} from '@mongo-manager/shared'
import { parseInput } from '../validate'
import { requireAuth } from '../http/guards'
import type { ServerContext } from '../http/context'
import { ownerOf } from '../transfer/files'
import { kitFileName, kitFrom, kitText } from '../backup/keys/kit'
import type { BackupKeyRecord } from '../backup/keys/repo'

const IdParams = z.object({ id: z.string().uuid() })

export const toKeyView = (ctx: ServerContext, r: BackupKeyRecord): BackupKeyView => ({
  id: r.id,
  name: r.name,
  fingerprint: r.fingerprint,
  state: r.state,
  createdAt: r.createdAt,
  confirmedAt: r.confirmedAt,
  retiredAt: r.retiredAt,
  uses: ctx.backup.keys.uses(r.id),
})

/** Spec §3.5, D1: a key in the audit is its name and fingerprint, never its material. */
const audited = (r: BackupKeyRecord, extra: Record<string, unknown> = {}) => ({
  details: { key: r.id, name: r.name, fingerprint: r.fingerprint, ...extra },
})

/** Phase 3d-3c spec §1.1, §3.4: a user's own backup keys; nobody else's, administrators included (D3). */
export async function backupKeyRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app
  const keys = () => ctx.backup.keys

  app.get('/backup-keys', { preHandler: requireAuth }, async (request) =>
    keys()
      .list(ownerOf(request.principal!))
      .map((r) => toKeyView(ctx, r)),
  )

  app.post(
    '/backup-keys',
    { preHandler: requireAuth, config: { audit: 'backup.key.create' } },
    async (request, reply) => {
      const body = parseInput(KeyCreateSchema, request.body)
      const principal = request.principal!
      const owner = ownerOf(principal)
      // Spec §3.4: ten creations and imports an hour; nothing here runs long, so the slot goes at once.
      ctx.backup.keyGate.enter(owner)()
      const { record, key } = keys().create(owner, body.name)
      try {
        const kit = kitText({
          host: request.hostname,
          username: principal.username,
          name: record.name,
          fingerprint: record.fingerprint,
          createdAt: record.createdAt,
          key,
        })
        request.auditInfo = audited(record)
        const answer: BackupKeyCreated = {
          key: toKeyView(ctx, record),
          kit,
          fileName: kitFileName(record.fingerprint),
        }
        // D1: the one answer that carries key material, never kept by a cache.
        return reply.status(201).header('cache-control', 'no-store').send(answer)
      } finally {
        key.fill(0)
      }
    },
  )

  app.post(
    '/backup-keys/:id/confirm',
    { preHandler: requireAuth, config: { audit: 'backup.key.confirm' } },
    async (request) => {
      const { id } = parseInput(IdParams, request.params)
      const { check } = parseInput(KeyConfirmSchema, request.body)
      const { record, resumed } = keys().confirm(ownerOf(request.principal!), id, check)
      request.auditInfo = audited(record, { resumed: resumed.length })
      return toKeyView(ctx, record)
    },
  )

  app.post(
    '/backup-keys/:id/activate',
    { preHandler: requireAuth, config: { audit: 'backup.key.activate' } },
    async (request) => {
      const { id } = parseInput(IdParams, request.params)
      const { record, resumed } = keys().activate(ownerOf(request.principal!), id)
      request.auditInfo = audited(record, { resumed: resumed.length })
      return toKeyView(ctx, record)
    },
  )

  app.post(
    '/backup-keys/:id/retire',
    { preHandler: requireAuth, config: { audit: 'backup.key.retire' } },
    async (request) => {
      const { id } = parseInput(IdParams, request.params)
      const { record, paused } = keys().retire(ownerOf(request.principal!), id)
      request.auditInfo = audited(record, { paused: paused.length })
      return toKeyView(ctx, record)
    },
  )

  app.post(
    '/backup-keys/import',
    { preHandler: requireAuth, config: { audit: 'backup.key.import' } },
    async (request, reply) => {
      const body = parseInput(KeyImportSchema, request.body)
      const owner = ownerOf(request.principal!)
      ctx.backup.keyGate.enter(owner)()
      const key = kitFrom(body.kit)
      try {
        const record = keys().importKey(owner, key, body.name)
        request.auditInfo = audited(record)
        return reply.status(201).send(toKeyView(ctx, record))
      } finally {
        key.fill(0)
      }
    },
  )

  app.delete(
    '/backup-keys/:id',
    { preHandler: requireAuth, config: { audit: 'backup.key.delete' } },
    async (request, reply) => {
      const { id } = parseInput(IdParams, request.params)
      const record = keys().remove(ownerOf(request.principal!), id)
      request.auditInfo = audited(record)
      return reply.status(204).send()
    },
  )
}
