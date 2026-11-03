import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { DATA_WRITE_PERMISSIONS, JOB_STATES, permissionsFor } from '@mongo-manager/shared'
import { Errors } from '../errors'
import { parseInput } from '../validate'
import { requireAuth } from '../http/guards'
import { effectiveRole } from '../connections/access'
import { canCancel, canSee, cancelPermission, toView } from '../jobs/visibility'
import type { JobRecord } from '../jobs/types'

const ListQuery = z.object({
  state: z.enum(JOB_STATES).optional(),
  connectionId: z.string().min(1).max(64).optional(),
})
const IdParams = z.object({ id: z.uuid() })
/** The newest jobs a user is shown; older ones stay in the table until pruned. */
const MAX_LISTED = 200

/** Phase 1h spec §5: the jobs a user may see, one of them, and cancelling one. */
export async function jobRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app

  const visible = (request: FastifyRequest): JobRecord => {
    const { id } = parseInput(IdParams, request.params)
    const job = ctx.jobs.get(id)
    // An invisible job answers exactly like a missing one.
    if (!job || !canSee(ctx, request.principal!, job)) throw Errors.notFound('Job not found')
    return job
  }

  app.get('/jobs', { preHandler: requireAuth }, async (request) => {
    const q = parseInput(ListQuery, request.query)
    const principal = request.principal!
    const jobs = ctx.jobs
      .list({ ...q, limit: 1000 })
      .filter((job) => canSee(ctx, principal, job))
      .slice(0, MAX_LISTED)
    return { jobs: jobs.map((job) => toView(ctx, principal, job)) }
  })

  app.get('/jobs/:id', { preHandler: requireAuth }, async (request) => ({
    job: toView(ctx, request.principal!, visible(request)),
  }))

  app.post(
    '/jobs/:id/cancel',
    { preHandler: requireAuth, config: { audit: 'jobs.cancel' } },
    async (request, reply) => {
      const principal = request.principal!
      const job = visible(request)
      request.connection = ctx.connections.get(job.connectionId) ?? null
      request.auditInfo = { details: { kind: job.kind, target: job.target, db: job.db, coll: job.coll } }
      if (job.state !== 'running')
        throw Errors.conflict('The job has already finished', { reason: 'finished' })
      if (!canCancel(ctx, principal, job)) {
        // Say read-only when that is the only obstacle, as every other write route does.
        const permission = cancelPermission(job)
        const role = request.connection ? effectiveRole(ctx, principal, job.connectionId) : null
        const readOnly = ctx.config.readOnly || request.connection?.readOnly === true
        if (
          readOnly &&
          role &&
          DATA_WRITE_PERMISSIONS.has(permission) &&
          permissionsFor(role).has(permission)
        )
          throw Errors.readOnly()
        throw Errors.forbidden()
      }
      const outcome = await ctx.jobs.cancel(job.id)
      if (outcome === 'finished')
        throw Errors.conflict('The job has already finished', { reason: 'finished' })
      if (outcome === 'not-stopped')
        throw Errors.conflict('The job could not be stopped; it is still running', { reason: 'not_stopped' })
      // pending: told to stop and winding down; its end arrives over the real-time channel.
      return reply
        .status(outcome === 'pending' ? 202 : 200)
        .send({ job: toView(ctx, principal, ctx.jobs.get(job.id)!) })
    },
  )
}
