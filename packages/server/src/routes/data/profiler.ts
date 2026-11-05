// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ProfilerChangeSchema } from '@mongo-manager/shared'
import { Errors } from '../../errors'
import { parseInput } from '../../validate'
import { isDrillScratch, requireConnection } from '../../connections/access'
import { clientFor, withMongo } from '../../data/mongo-errors'
import { ChangeLimiter, REVERT_AFTER_MS, readProfiler, writeProfiler } from '../../monitor/profiler'

const DB_NAME = /^[^/\\. "$*<>:|?]{1,64}$/
const DbParams = z.object({
  id: z.string().min(1).max(64),
  db: z.string().refine((v) => DB_NAME.test(v) && !v.includes(String.fromCharCode(0)), 'Not a database name'),
})

/** Why MongoDB would not report a database's profiler: the role the account lacks, or an error. */
const refusal = (e: unknown): string => ((e as { code?: unknown }).code === 13 ? 'dbAdmin' : 'error')

/**
 * Phase 3b spec §3.1: the profiler of each database. Monitors read it; connection admins change
 * it (not on a read-only connection, at most 10 changes a minute); level 2 must be confirmed and
 * reverts by itself after 30 minutes (ProfilerReverter applies it, even after a restart).
 */
export async function profilerRoutes(app: FastifyInstance): Promise<void> {
  const base = '/connections/:id/server/profiler'
  const limiter = new ChangeLimiter(app.ctx.now)

  app.get(
    base,
    { preHandler: requireConnection('server:monitor'), config: { masking: 'names-only' } },
    async (request) => {
      const client = await clientFor(request)
      const hello = await withMongo(() => client.db('admin').command({ hello: 1 }))
      const mongos = hello.msg === 'isdbgrid'
      const names = mongos
        ? []
        : (
            (await withMongo(() => client.db('admin').command({ listDatabases: 1, nameOnly: true })))
              .databases as Array<{ name: string }>
          )
            .map((d) => d.name)
            .filter((n) => n !== 'local' && !isDrillScratch(n))
      const pending = new Map(app.ctx.profilerReverts.pending(request.connection!.id).map((p) => [p.db, p]))
      const databases = await Promise.all(
        names.map(async (name) => {
          const p = pending.get(name)
          const revert = p
            ? {
                revertAt: new Date(p.deadline).toISOString(),
                // Whether the last attempt failed; the error text itself stays on the server (final review M3).
                ...(p.lastError ? { revertFailed: true } : {}),
              }
            : {}
          try {
            return { name, ...(await readProfiler(client, name)), ...revert }
          } catch (e) {
            return { name, refused: refusal(e), ...revert }
          }
        }),
      )
      return {
        scope: mongos ? 'mongos' : 'mongod',
        ...(typeof hello.me === 'string' ? { member: hello.me.slice(0, 256) } : {}),
        databases,
      }
    },
  )

  app.put(
    `${base}/:db`,
    {
      preHandler: requireConnection('server:operations'),
      config: { masking: 'names-only', audit: 'server.profiler' },
    },
    async (request) => {
      const { db } = parseInput(DbParams, request.params)
      const change = parseInput(ProfilerChangeSchema, request.body ?? {})
      // Read-only means nothing is changed through the app, server settings included.
      if (app.ctx.config.readOnly || request.connection!.readOnly) throw Errors.readOnly()
      // W7, security review Minor 4: level 2 is reverted by the server on its own, which has no
      // client of a per-person OIDC connection in team mode — it would stay on for good.
      const auth = request.connection!.settings.auth
      if (
        change.level === 2 &&
        app.ctx.config.auth &&
        auth.mechanism === 'MONGODB-OIDC' &&
        !auth.oidc?.environment
      )
        throw Errors.conflict(
          'Level 2 is switched off again by the server on its own, which cannot sign in to this connection: each person signs in with OIDC. Use level 1 instead',
          { reason: 'oidc_level2' },
        )
      const connectionId = request.connection!.id
      if (!limiter.take(connectionId)) throw Errors.rateLimited(60_000)
      const client = await clientFor(request)
      const hello = await withMongo(() => client.db('admin').command({ hello: 1 }))
      if (hello.msg === 'isdbgrid' && change.level !== 0)
        throw Errors.validation('A mongos has no profiler: only slowms and sampleRate apply, to its log')
      const next = { level: change.level, slowms: change.slowms, sampleRate: change.sampleRate }
      const reverts = app.ctx.profilerReverts
      // One change of this database at a time, and never while its revert runs (final review I3).
      return reverts.exclusive(connectionId, db, async () => {
        const previous = await withMongo(() => readProfiler(client, db))
        request.auditInfo = { details: { db, previous, next } }
        if (next.level !== 2) {
          await withMongo(() => writeProfiler(client, db, next))
          reverts.cancel(connectionId, db)
          return next
        }
        // Level 2: the revert is stored before level 2 is switched on, so a failure in between
        // never leaves it on for good. A pending revert keeps the settings from before the first.
        const pending = reverts.get(connectionId, db)
        const deadline = app.ctx.now() + REVERT_AFTER_MS
        const member = typeof hello.me === 'string' ? hello.me.slice(0, 256) : null
        reverts.schedule(connectionId, db, pending?.previous ?? previous, deadline, member)
        try {
          await withMongo(() => writeProfiler(client, db, next))
        } catch (e) {
          if (pending) reverts.restore(pending)
          else reverts.cancel(connectionId, db)
          throw e
        }
        return { ...next, revertAt: new Date(deadline).toISOString() }
      })
    },
  )
}
