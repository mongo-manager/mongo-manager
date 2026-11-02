import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  MAX_SCHEDULES_PER_USER,
  MIN_GAP_MS,
  RETENTION_CONFIRM_ABOVE,
  ScheduleInputSchema,
  SchedulePatchSchema,
  SchedulePreviewSchema,
  cadenceProblem,
  compileCadence,
  describeCadence,
  nextRuns,
  type CadenceProblem,
  type SchedulePreview,
  type SchedulesList,
} from '@mongo-manager/shared'
import { Errors } from '../errors'
import { parseInput } from '../validate'
import { requireAuth } from '../http/guards'
import type { Principal } from '../http/context'
import { ownerOf } from '../transfer/files'
import { nextRunOf, type ScheduleRecord } from '../backup/schedules/repo'
import { toRunView, toScheduleView } from '../backup/schedules/views'
import { previewRemovals } from '../backup/schedules/retention-run'
import { isAdministrator, mayBackUp, plainProblem } from '../backup/schedules/policy'
import { effectiveRole, unattended } from '../connections/access'

const IdParams = z.object({ id: z.string().uuid() })
const CADENCE_WORDS: Record<CadenceProblem['reason'], string> = {
  cron: 'The cron expression cannot be read',
  never: 'This cadence never runs in the next five years',
  min_gap: 'Runs must be at least an hour apart',
}

/** Phase 3d-3c spec §0, §1.2–§1.4, §3.4: schedules — their owners edit them; administrators oversee them. */
export async function scheduleRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app
  const S = () => ctx.backup.schedules

  /** Spec §3.4: an unknown schedule, or another's for a non-administrator, is not found. */
  const visible = (principal: Principal, id: string): ScheduleRecord => {
    const s = S().get(id)
    if (!s || (s.owner !== ownerOf(principal) && !isAdministrator(principal)))
      throw Errors.notFound('Schedule not found')
    return s
  }
  /** Spec §0: administrators do not edit someone else's schedule. */
  const owned = (principal: Principal, id: string): ScheduleRecord => {
    const s = visible(principal, id)
    if (s.owner !== ownerOf(principal))
      throw Errors.forbidden('Only its owner edits a schedule; pause or delete it instead', {
        reason: 'not_owner',
      })
    return s
  }
  const view = (principal: Principal, s: ScheduleRecord) => toScheduleView(ctx, principal, s)
  /** Final review I2: a cadence or zone this server cannot read is refused in words, never a 500. */
  const nextOrRefuse = (s: ScheduleRecord): number | null => {
    try {
      return nextRunOf(s, ctx.now())
    } catch {
      throw Errors.conflict(
        'This schedule’s cadence or time zone cannot be read on this server; edit it first',
        {
          reason: 'invalid_cadence',
        },
      )
    }
  }

  /** The checks every save repeats; answers the key a .mmbak schedule uses. */
  function check(
    principal: Principal,
    s: Pick<ScheduleRecord, 'connectionId' | 'dump' | 'format' | 'cadence' | 'destinations'>,
  ): { keyId: string | null } {
    if (!ctx.connections.get(s.connectionId) || !effectiveRole(ctx, principal, s.connectionId))
      throw Errors.notFound('Connection not found')
    if (!mayBackUp(ctx, principal, s.connectionId)) throw Errors.forbidden()
    const problem = cadenceProblem(s.cadence, ctx.now())
    if (problem)
      throw Errors.validation(problem.reason === 'cron' ? problem.message : CADENCE_WORDS[problem.reason], {
        reason: `cadence_${problem.reason}`,
        problem,
      })
    for (const id of s.destinations)
      if (!ctx.backup.destinations.levelOf(id, principal)) throw Errors.notFound('Destination not found')
    if (s.format !== 'mmbak') {
      // Judged as the schedule will run: on its own, where the owner's view of the data (local mode's
      // hiding, a "hide from me") masks nothing it writes (review of the rework, I3).
      const plain = plainProblem(ctx, unattended(principal), s.connectionId, s.dump, s.destinations)
      if (plain === 'encrypted_only')
        throw Errors.conflict('A chosen destination takes encrypted backups only', { reason: plain })
      if (plain === 'personal_plain')
        throw Errors.conflict('An unencrypted backup of personal data cannot leave the server', {
          reason: plain,
        })
      return { keyId: null }
    }
    const active = ctx.backup.keys.active(ownerOf(principal))
    if (!active)
      throw Errors.conflict('Create a backup key first: scheduled encrypted backups use it', {
        reason: 'key_required',
      })
    return { keyId: active.id }
  }
  const audited = (s: ScheduleRecord, extra: Record<string, unknown> = {}) => ({
    details: { schedule: s.id, name: s.name, owner: s.owner, connection: s.connectionId, ...extra },
  })

  app.get('/backup-schedules', { preHandler: requireAuth }, async (request): Promise<SchedulesList> => {
    const principal = request.principal!
    const list = isAdministrator(principal) ? S().list() : S().list(ownerOf(principal))
    return { enabled: ctx.backup.limits.schedules, schedules: list.map((s) => view(principal, s)) }
  })

  app.post(
    '/backup-schedules',
    { preHandler: requireAuth, config: { audit: 'backup.schedule.create' } },
    async (request, reply) => {
      const body = parseInput(ScheduleInputSchema, request.body)
      const principal = request.principal!
      const owner = ownerOf(principal)
      if (S().countFor(owner) >= MAX_SCHEDULES_PER_USER)
        throw Errors.conflict(`At most ${MAX_SCHEDULES_PER_USER} schedules per user`, {
          reason: 'schedule_limit',
        })
      const { keyId } = check(principal, body)
      const s = S().create({ ...body, owner, keyId, nextRunAt: nextRunOf(body, ctx.now()) })
      request.auditInfo = audited(s, { format: s.format, destinations: s.destinations.length })
      return reply.status(201).send(view(principal, s))
    },
  )

  app.patch(
    '/backup-schedules/:id',
    { preHandler: requireAuth, config: { audit: 'backup.schedule.update' } },
    async (request) => {
      const { id } = parseInput(IdParams, request.params)
      const { confirmRemovals, ...patch } = parseInput(SchedulePatchSchema, request.body)
      const principal = request.principal!
      const before = owned(principal, id)
      const next = { ...before, ...patch }
      const { keyId } = check(principal, next)
      // Final review minor 8: where, when (the zone moves day boundaries) and keep change removals too.
      const removing = (['retention', 'timeZone', 'destinations', 'keepOnServer'] as const).some(
        (k) => patch[k] !== undefined && JSON.stringify(patch[k]) !== JSON.stringify(before[k]),
      )
      if (removing) {
        // Spec §1.4, plan ruling 21: a change that removes more than ten now needs that count confirmed.
        const removals = previewRemovals(ctx, next)
        const count = removals.reduce((n, r) => n + r.count, 0)
        if (count > RETENTION_CONFIRM_ABOVE && confirmRemovals !== count)
          throw Errors.conflict(`These changes would remove ${count} backups now; confirm to save them`, {
            reason: 'retention_confirm',
            count,
            removals,
          })
      }
      const timing = patch.cadence !== undefined || patch.timeZone !== undefined
      const s = S().update(id, {
        ...patch,
        keyId,
        ...(timing && before.state === 'active' ? { nextRunAt: nextRunOf(next, ctx.now()) } : {}),
      })
      // Final review I1: copies kept for this schedule go back to the normal time to live.
      if (before.keepOnServer && !s.keepOnServer) ctx.backup.store.releaseRetained(id)
      request.auditInfo = audited(s, { changed: Object.keys(patch) })
      return view(principal, s)
    },
  )

  app.delete(
    '/backup-schedules/:id',
    { preHandler: requireAuth, config: { audit: 'backup.schedule.delete' } },
    async (request, reply) => {
      const { id } = parseInput(IdParams, request.params)
      const s = visible(request.principal!, id)
      // Plan ruling 15: its server copies expire normally from now on; its backups and copies stay, detached.
      ctx.backup.store.releaseRetained(s.id)
      S().remove(s.id)
      request.auditInfo = audited(s)
      return reply.status(204).send()
    },
  )

  app.post(
    '/backup-schedules/:id/pause',
    { preHandler: requireAuth, config: { audit: 'backup.schedule.pause' } },
    async (request) => {
      const { id } = parseInput(IdParams, request.params)
      const principal = request.principal!
      const s = visible(principal, id)
      const mine = s.owner === ownerOf(principal)
      if (s.state === 'active')
        S().pause(s.id, mine ? 'owner' : 'admin', mine ? 'owner' : `admin:${principal.username}`)
      request.auditInfo = audited(s)
      return view(principal, S().get(s.id)!)
    },
  )

  app.post(
    '/backup-schedules/:id/resume',
    { preHandler: requireAuth, config: { audit: 'backup.schedule.resume' } },
    async (request) => {
      const { id } = parseInput(IdParams, request.params)
      const principal = request.principal!
      const s = visible(principal, id)
      // Final review minor 24: an administrator's pause is an administrator's to lift.
      if (s.state === 'paused' && s.pauseReason === 'admin' && !isAdministrator(principal))
        throw Errors.forbidden('An administrator paused this schedule; ask one to resume it', {
          reason: 'paused_by_admin',
        })
      // The next run checks every right again; one still missing pauses it again with its reason.
      if (s.state === 'paused') S().resume(s.id, nextOrRefuse(s))
      request.auditInfo = audited(s)
      return view(principal, S().get(s.id)!)
    },
  )

  app.get('/backup-schedules/:id/runs', { preHandler: requireAuth }, async (request) => {
    const { id } = parseInput(IdParams, request.params)
    const s = visible(request.principal!, id)
    return ctx.backup.runs.list(s.id).map((r) => toRunView(ctx, request.principal!, s.connectionId, r))
  })

  app.post(
    '/backup-schedules/:id/run',
    { preHandler: requireAuth, config: { audit: 'backup.schedule.run' } },
    async (request, reply) => {
      const { id } = parseInput(IdParams, request.params)
      const s = visible(request.principal!, id)
      const run = ctx.backup.scheduler.runNow(s.id, request.agentVia)
      request.auditInfo = audited(s, { run: run.id })
      return reply.status(202).send({ run: toRunView(ctx, request.principal!, s.connectionId, run) })
    },
  )

  app.post(
    '/backup-schedules/preview',
    { preHandler: requireAuth },
    async (request): Promise<SchedulePreview> => {
      const body = parseInput(SchedulePreviewSchema, request.body)
      const principal = request.principal!
      // Spec §3.4: 60 previews a minute per user; nothing here runs long.
      ctx.backup.schedulePreviews.enter(ownerOf(principal))()
      let runs: number[] = []
      let words: string | null = null
      let problem: CadenceProblem | null = null
      if (body.cadence) {
        problem = cadenceProblem(body.cadence, ctx.now())
        if (!problem || problem.reason === 'min_gap')
          runs = nextRuns(compileCadence(body.cadence), body.timeZone ?? 'UTC', ctx.now(), 5, {
            minGapMs: MIN_GAP_MS,
          })
        words = describeCadence(body.cadence, body.locale)
      }
      // Final review minor 8: the edited draft's zone, locations and keep count, not the policy alone;
      // a destination the caller may not use is never named here.
      const removals = body.scheduleId
        ? previewRemovals(ctx, {
            ...visible(principal, body.scheduleId),
            ...(body.retention ? { retention: body.retention } : {}),
            ...(body.timeZone ? { timeZone: body.timeZone } : {}),
            ...(body.keepOnServer !== undefined ? { keepOnServer: body.keepOnServer } : {}),
            ...(body.destinations
              ? {
                  destinations: body.destinations.filter((d) =>
                    ctx.backup.destinations.levelOf(d, principal),
                  ),
                }
              : {}),
          })
        : []
      return { runs, words, problem, removals }
    },
  )
}
