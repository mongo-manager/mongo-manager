// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { UpdateInstallBodySchema, UpdateSettingsBodySchema, permissionsFor } from '@mongo-manager/shared'
import { parseInput } from '../validate'
import { requireAuth, requirePermission } from '../http/guards'

/**
 * The updater (2026-11-03): everyone signed in sees the installed version; administrators
 * (settings:manage) check, turn the daily check on or off and install — each write audited.
 */
export async function updateRoutes(app: FastifyInstance): Promise<void> {
  const admin = requirePermission('settings:manage')
  const isAdmin = (request: FastifyRequest) =>
    !!request.principal &&
    permissionsFor(request.principal.role, { readOnly: app.ctx.config.readOnly }).has('settings:manage')

  app.get('/updates', { preHandler: requireAuth }, async (request) =>
    app.ctx.updates.status(isAdmin(request)),
  )

  app.post('/updates/check', { preHandler: admin, config: { audit: 'updates.check' } }, async () =>
    app.ctx.updates.check(),
  )

  app.put(
    '/updates/settings',
    { preHandler: admin, config: { audit: 'updates.settings' } },
    async (request) => {
      const { auto } = parseInput(UpdateSettingsBodySchema, request.body)
      request.auditInfo = { details: { auto } }
      return app.ctx.updates.setAuto(auto)
    },
  )

  app.post(
    '/updates/install',
    { preHandler: admin, config: { audit: 'updates.install' } },
    async (request, reply) => {
      const { version, confirmJobs } = parseInput(UpdateInstallBodySchema, request.body)
      request.auditInfo = { details: { from: app.ctx.updates.deps.installed, to: version } }
      app.ctx.updates.install(version, confirmJobs ?? false)
      return reply.code(202).send(app.ctx.updates.status(true))
    },
  )
}
