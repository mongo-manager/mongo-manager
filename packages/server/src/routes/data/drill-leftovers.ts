// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { DrillLeftovers } from '@mongo-manager/shared'
import { Errors } from '../../errors'
import { parseInput } from '../../validate'
import { requireConnection } from '../../connections/access'
import { clientFor, withMongo } from '../../data/mongo-errors'
import { DRILL_DB } from '../../jobs/duplicate'

const DropBody = z.strictObject({
  name: z.string().min(1).max(64),
  /** The name typed again, as the confirmation. */
  confirm: z.string().max(64),
})

/**
 * W4 re-review (minor): a restore drill's scratch database that could not be dropped (the drill's
 * report names it) is dropped from the app — by the connection's admins, by its typed name, only a
 * name a drill makes (mm_drill_ and 12 hex characters), and never while a drill runs anywhere. The list and the drop name databases only: nothing in them is read.
 */
export async function drillLeftoverRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app
  const base = '/connections/:id/backup/drill-leftovers'
  const admin = requireConnection('connections:manage')

  async function leftovers(request: Parameters<typeof clientFor>[0]) {
    const client = await clientFor(request)
    const listed = await withMongo(() =>
      client.db('admin').admin().listDatabases({ nameOnly: false, authorizedDatabases: true }),
    )
    return listed.databases
      .filter((d) => DRILL_DB.test(d.name))
      .map((d) => ({ name: d.name, sizeOnDisk: Number(d.sizeOnDisk ?? 0) }))
  }
  // W4 re-review 2 (minor): a drill on any connection — another one may point at the same deployment
  // (its scratch database would be this one) — holds every drop.
  const drillRunning = (_connectionId: string) =>
    ctx.jobs.list({ state: 'running' }).some((j) => j.kind === 'backup.drill')

  app.get(
    base,
    { preHandler: admin, config: { masking: 'names-only' } },
    async (request): Promise<DrillLeftovers> => ({
      databases: await leftovers(request),
      running: drillRunning(request.connection!.id),
    }),
  )

  app.post(
    `${base}/drop`,
    { preHandler: admin, config: { masking: 'names-only', audit: 'backup.drillCleanup' } },
    async (request) => {
      const body = parseInput(DropBody, request.body)
      if (!DRILL_DB.test(body.name))
        throw Errors.validation('Only a restore drill’s scratch database is dropped here', {
          reason: 'not_drill_scratch',
        })
      if (body.confirm !== body.name)
        throw Errors.validation('Type the database’s name to drop it', { reason: 'confirm_name' })
      const connectionId = request.connection!.id
      if (drillRunning(connectionId))
        throw Errors.conflict('A restore drill is running on this connection; drop it once it ends', {
          reason: 'drill_running',
        })
      if (!(await leftovers(request)).some((d) => d.name === body.name))
        throw Errors.notFound('That database is not there')
      const client = await clientFor(request)
      await withMongo(() => client.db(body.name).dropDatabase())
      ctx.personalFields.dropScratchRules(connectionId, body.name)
      request.auditInfo = { details: { database: body.name } }
      return { dropped: body.name }
    },
  )
}
