// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  FINAL_STATES,
  LIVE_SYNC_LIMITS,
  RUNNING_STATES,
  LiveSyncConfirmSchema,
  LiveSyncFinishSchema,
  LiveSyncLagQuerySchema,
  LiveSyncSchemaSchema,
  LiveSyncRequestSchema,
  permissionsFor,
  type AuditAction,
  type LiveSyncDetail,
  type LiveSyncLag,
  type LiveSyncVerifySamples,
  type LiveSyncPlan,
  type LiveSyncRequest,
  type LiveSyncsList,
} from '@mongo-manager/shared'
import { Errors } from '../errors'
import { parseInput } from '../validate'
import { requireAuth } from '../http/guards'
import { safeEqual } from '../http/security'
import type { Principal } from '../http/context'
import { effectiveRole, isRestricted, mayExport, requireExport } from '../connections/access'
import { sendTransferFile } from './transfer'
import { compileRules } from '../masking/match'
import { isAdministrator } from '../backup/schedules/policy'
import { ownerOf } from '../transfer/files'
import { addMissingRules, startCopyJob } from '../transfer/copy-start'
import { assertTransferRoom } from './data/transfer'
import { operationTime, planLiveSync, type PlannedSync } from '../livesync/plan'
import { tsFrom, type LiveSyncRecord } from '../livesync/repo'
import { requestAs } from '../livesync/caller'
import { planHash } from '../transfer/copy-access'
import { withMongo } from '../data/mongo-errors'

const SyncParams = z.object({ syncId: z.uuid() })
/** W4.6: how far ahead a sync's start may be scheduled. */
export const SCHEDULE_MIN_MS = 60_000
export const SCHEDULE_MAX_MS = 30 * 86_400_000

/** Phase 3e-2 spec §2.5: live syncs. Planned and created on their source (:id); controlled by id. */
export async function liveSyncRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app
  const runner = () => ctx.liveSync

  /** S1, S8: an unknown sync, or another's for a non-administrator, is not found. */
  const visible = (principal: Principal, id: string): LiveSyncRecord => {
    const r = runner().repo.get(id)
    if (!r || (r.owner !== ownerOf(principal) && !isAdministrator(principal)))
      throw Errors.notFound('Live sync not found')
    return r
  }
  /** Spec §3.1: only the owner creates, finishes or confirms. */
  const owned = (principal: Principal, id: string): LiveSyncRecord => {
    const r = visible(principal, id)
    if (r.owner !== ownerOf(principal))
      throw Errors.forbidden('Only its owner can do this; pause or stop it instead', { reason: 'not_owner' })
    return r
  }
  const syncOf = (request: FastifyRequest) => parseInput(SyncParams, request.params).syncId
  const ns = (db: string, coll: string | null) => (coll ? `${db}.${coll}` : db)
  const audited = (r: LiveSyncRecord, extra: Record<string, unknown> = {}) => ({
    details: {
      sync: r.id,
      owner: r.owner,
      source: r.source.connectionId,
      sourceNamespace: ns(r.source.db, r.source.coll),
      target: r.target.connectionId,
      targetNamespace: ns(r.target.db, r.target.coll),
      ...extra,
    },
  })
  /**
   * Final review m16: "Start again" names the sync it replaces — the caller's own, not running —
   * which stops when the new one starts and no longer counts toward the limits.
   */
  const replacedOf = (principal: Principal, body: LiveSyncRequest): LiveSyncRecord | undefined => {
    if (!body.replaces) return undefined
    const old = runner().repo.get(body.replaces)
    if (!old || old.owner !== ownerOf(principal)) throw Errors.notFound('Live sync not found')
    if ((RUNNING_STATES as readonly string[]).includes(old.state))
      throw Errors.conflict('Stop or pause the sync first', { reason: 'running' })
    return old
  }
  const refuse = (planned: PlannedSync, planHash: string | undefined) => {
    if (planned.plan.refusals.length)
      throw Errors.conflict('The live sync cannot start as asked', {
        reason: 'refused',
        reasons: planned.plan.refusals,
      })
    if (!planHash || !safeEqual(planned.plan.planHash, planHash))
      throw Errors.conflict('The sync changed since its summary; review it again', { reason: 'plan_changed' })
  }

  /**
   * W4.6: a two-way sync is planned both ways — from the source (this request) and back from the
   * target, as the caller — and its summary joins both: every refusal and warning of either, a hash
   * of both, and room for two syncs within the limits. A one-way sync is planned as before.
   */
  async function planBoth(
    request: FastifyRequest,
    body: LiveSyncRequest,
    replaced: LiveSyncRecord | undefined,
  ): Promise<{ forward: PlannedSync; reverse: PlannedSync | null; plan: LiveSyncPlan }> {
    const forward = await planLiveSync(request, body, runner().edges(replaced?.id), undefined, replaced)
    if (!body.twoWay || !body.source.coll || !body.target.coll)
      return { forward, reverse: null, plan: forward.plan }
    const principal = request.principal!
    const extra = new Set<string>()
    // The way back reads the target: the caller must be allowed to read and export from it.
    const role = effectiveRole(ctx, principal, body.target.connectionId)
    if (
      !role ||
      !permissionsFor(role).has('documents:read') ||
      !mayExport(ctx, principal, body.target.connectionId)
    )
      extra.add('two_way_target_rights')
    const releases: Array<() => void> = []
    const back = requestAs(ctx, principal, body.target.connectionId, releases)
    if (!back) throw Errors.notFound('Connection not found')
    let reverse: PlannedSync
    try {
      reverse = await planLiveSync(
        back,
        {
          ...body,
          name: undefined,
          source: { connectionId: body.target.connectionId, db: body.target.db, coll: body.target.coll },
          target: { connectionId: body.source.connectionId, db: body.source.db, coll: body.source.coll },
          replaces: undefined,
        },
        runner().edges(replaced?.id),
        undefined,
        replaced,
      )
    } finally {
      for (const release of releases) release()
    }
    // Two syncs start: both must fit within the limits.
    const owner = ownerOf(principal)
    const freed = replaced && !(FINAL_STATES as readonly string[]).includes(replaced.state) ? 1 : 0
    if (runner().repo.countActive(owner) - freed + 2 > LIVE_SYNC_LIMITS.perUser) extra.add('limit_user')
    if (runner().repo.countActive() - freed + 2 > ctx.config.liveSync.maxSyncs) extra.add('limit_server')
    const plan: LiveSyncPlan = {
      ...forward.plan,
      planHash: planHash({ forward: forward.plan.planHash, reverse: reverse.plan.planHash }),
      refusals: [...new Set([...forward.plan.refusals, ...reverse.plan.refusals, ...extra])],
      warnings: [...new Set([...forward.plan.warnings, ...reverse.plan.warnings])],
    }
    // The forward side's own `leftOut` names its pairs. The way back names none: a masked two-way
    // sync is refused (two_way_masked), and a series or a Queryable Encryption pair has its own
    // refusal (review of the agent's gate).
    return { forward, reverse, plan }
  }

  app.post(
    '/connections/:id/live-syncs/plan',
    { preHandler: requireExport(), config: { masking: 'guarded' } },
    async (request): Promise<LiveSyncPlan> => {
      const body = parseInput(LiveSyncRequestSchema, request.body)
      const replaced = replacedOf(request.principal!, body)
      return (await planBoth(request, body, replaced)).plan
    },
  )

  /**
   * W4.6: a two-way sync — two linked syncs, from now, each the other's way back. Pre- and
   * post-images are turned on first when the owner asked; each side's T0 is read on its own primary.
   */
  async function createTwoWay(request: FastifyRequest, body: LiveSyncRequest): Promise<LiveSyncRecord> {
    const principal = request.principal!
    if (body.startAt !== undefined)
      throw Errors.validation('A two-way sync starts now', { reason: 'start_at' })
    const replaced = replacedOf(principal, body)
    const { forward, reverse, plan } = await planBoth(request, body, replaced)
    if (plan.refusals.length)
      throw Errors.conflict('The live sync cannot start as asked', {
        reason: 'refused',
        reasons: plan.refusals,
      })
    if (!body.planHash || !safeEqual(plan.planHash, body.planHash))
      throw Errors.conflict('The sync changed since its summary; review it again', { reason: 'plan_changed' })
    const images = { changeStreamPreAndPostImages: { enabled: true } }
    if (body.enablePreImages) {
      await withMongo(() =>
        forward.sourceClient.db(body.source.db).command({ collMod: body.source.coll, ...images }),
      )
      await withMongo(() =>
        forward.prepared.targetClient.db(body.target.db).command({ collMod: body.target.coll, ...images }),
      )
    }
    const [ta, tb] = (
      await Promise.all([operationTime(forward.sourceClient), operationTime(reverse!.sourceClient)])
    ).map(tsFrom)
    const owner = ownerOf(principal)
    const src = { connectionId: body.source.connectionId, db: body.source.db, coll: body.source.coll! }
    const dst = { connectionId: body.target.connectionId, db: body.target.db, coll: body.target.coll! }
    const name = body.name ?? `${ns(src.db, src.coll)} ⇄ ${ns(dst.db, dst.coll)}`
    const twoWay = (partner: string, side: 'forward' | 'reverse') => ({ partner, side, echo: [], lost: {} })
    const fwd = runner().create({
      owner,
      name,
      source: { ...src, collections: null },
      target: dst,
      options: { ...forward.options, twoWay: twoWay('', 'forward') },
      stamps: forward.stamps,
      state: 'catching_up',
      startAt: `${ta!.t}.${ta!.i + 1}`,
      copyJobId: null,
    })
    const rev = runner().create({
      owner,
      name: `${name} (back)`,
      source: { ...dst, collections: null },
      target: src,
      options: { ...reverse!.options, twoWay: twoWay(fwd.id, 'reverse') },
      stamps: reverse!.stamps,
      state: 'catching_up',
      startAt: `${tb!.t}.${tb!.i + 1}`,
      copyJobId: null,
    })
    runner().repo.update(fwd.id, { options: { ...fwd.options, twoWay: twoWay(rev.id, 'forward') } })
    request.auditInfo = audited(fwd, {
      twoWay: true,
      partner: rev.id,
      preImagesEnabled: body.enablePreImages,
      errorPolicy: 'pause',
      ...(replaced ? { replaces: replaced.id } : {}),
    })
    if (replaced && !(FINAL_STATES as readonly string[]).includes(replaced.state))
      await runner().stop(replaced, 'owner')
    return runner().repo.get(fwd.id)!
  }

  app.post(
    '/connections/:id/live-syncs',
    { preHandler: requireExport(), config: { masking: 'guarded', audit: 'livesync.create' } },
    async (request, reply) => {
      const body = parseInput(LiveSyncRequestSchema, request.body)
      if (!body.planHash)
        throw Errors.validation('Start a live sync from its summary', { reason: 'plan_required' })
      const principal = request.principal!
      if (body.twoWay)
        return reply.status(201).send(runner().view(principal, await createTwoWay(request, body)))
      // W4.6: a scheduled start — a minute to 30 days ahead; nothing is copied or read until then.
      const scheduled = body.startAt !== undefined
      if (
        scheduled &&
        (body.startAt! < ctx.now() + SCHEDULE_MIN_MS || body.startAt! > ctx.now() + SCHEDULE_MAX_MS)
      )
        throw Errors.validation('Start it between a minute and 30 days from now', { reason: 'start_at' })
      const copying = body.startMode !== 'from_now'
      if (copying && !scheduled) assertTransferRoom(ctx, principal)
      const replaced = replacedOf(principal, body)
      const planned = await planLiveSync(request, body, runner().edges(replaced?.id), undefined, replaced)
      refuse(planned, body.planHash)
      // Plan ruling 2: T0, before the copy starts. Final review m9: a copy's changes start a second
      // earlier (writes still in flight at T0 are replayed — idempotent); "from now" just after T0.
      // A scheduled sync reads its T0 when its time comes.
      const t0 = scheduled ? null : tsFrom(await operationTime(planned.sourceClient))
      const startAt = !t0 ? null : copying ? `${Math.max(0, t0.t - 1)}.${t0.i}` : `${t0.t}.${t0.i + 1}`
      // S6: no await from here to the start, so the limits hold.
      const owner = ownerOf(principal)
      const freed = replaced && !(FINAL_STATES as readonly string[]).includes(replaced.state) ? 1 : 0
      if (runner().repo.countActive(owner) - freed >= LIVE_SYNC_LIMITS.perUser)
        throw Errors.conflict('The live sync cannot start as asked', {
          reason: 'refused',
          reasons: ['limit_user'],
        })
      if (runner().repo.countActive() - freed >= ctx.config.liveSync.maxSyncs)
        throw Errors.conflict('The live sync cannot start as asked', {
          reason: 'refused',
          reasons: ['limit_server'],
        })
      const addRules = addMissingRules(request, planned.input, planned.prepared, 'livesync.create')
      const job =
        copying && !scheduled
          ? startCopyJob(
              request,
              planned.input,
              planned.prepared,
              addRules,
              {
                coll: body.source.coll ?? '*',
                target: body.target.coll
                  ? `${body.target.db}.${body.target.coll}`
                  : `${body.target.db} (live sync)`,
              },
              { primaryReads: true },
            )
          : null
      const record = runner().create({
        owner,
        name:
          body.name ??
          `${ns(body.source.db, body.source.coll ?? null)} → ${ns(body.target.db, body.target.coll ?? null)}`,
        source: {
          connectionId: body.source.connectionId,
          db: body.source.db,
          coll: body.source.coll ?? null,
          collections: body.source.collections ?? null,
        },
        target: {
          connectionId: body.target.connectionId,
          db: body.target.db,
          coll: body.target.coll ?? null,
        },
        options: scheduled
          ? {
              ...planned.options,
              scheduledAt: body.startAt!,
              // What the owner confirmed now holds for the plan made again at the start.
              confirmed: {
                confirmOverwrite: body.confirmOverwrite,
                confirmOplog: body.confirmOplog,
                confirmTtl: body.confirmTtl,
                confirmPersonal: body.confirmPersonal,
                ...(body.confirmTarget !== undefined ? { confirmTarget: body.confirmTarget } : {}),
              },
            }
          : planned.options,
        stamps: {
          ...planned.stamps,
          // Rules added just now are the target's version the sync starts under.
          versions: {
            source: planned.stamps.versions.source,
            target: ctx.personalFields.get(body.target.connectionId).version,
          },
        },
        state: scheduled ? 'paused' : copying ? 'copying' : 'catching_up',
        startAt,
        copyJobId: job?.id ?? null,
        ...(scheduled ? { reason: 'scheduled' as const } : {}),
      })
      request.auditInfo = audited(record, {
        startMode: body.startMode,
        errorPolicy: body.errorPolicy,
        masked: planned.options.masked,
        anonymous: body.anonymous,
        personalUnruled: planned.prepared.plan.missingRules.length > 0 && !body.addRulesToTarget,
        rulesAdded: addRules.length,
        copyJob: job?.id ?? null,
        ...(replaced ? { replaces: replaced.id } : {}),
      })
      if (replaced && !(FINAL_STATES as readonly string[]).includes(replaced.state))
        await runner().stop(replaced, 'owner')
      return reply.status(201).send(runner().view(principal, record))
    },
  )

  app.get('/live-syncs', { preHandler: requireAuth }, async (request): Promise<LiveSyncsList> => {
    const principal = request.principal!
    const list = isAdministrator(principal) ? runner().repo.list() : runner().repo.list(ownerOf(principal))
    return {
      enabled: ctx.config.liveSync.enabled,
      max: ctx.config.liveSync.maxSyncs,
      perUser: LIVE_SYNC_LIMITS.perUser,
      syncs: list.map((r) => runner().view(principal, r)),
    }
  })

  app.get('/live-syncs/:syncId', { preHandler: requireAuth }, async (request): Promise<LiveSyncDetail> => {
    const principal = request.principal!
    const r = visible(principal, syncOf(request))
    return { ...runner().view(principal, r), events: runner().repo.events(r.id) }
  })

  /** W4.6: the lag history (the largest lag of each span), for whoever may see the sync. */
  app.get('/live-syncs/:syncId/lag', { preHandler: requireAuth }, async (request): Promise<LiveSyncLag> => {
    const r = visible(request.principal!, syncOf(request))
    const { minutes } = parseInput(LiveSyncLagQuerySchema, request.query ?? {})
    return { points: runner().repo.lagHistory(r.id, ctx.now() - minutes * 60_000) }
  })

  const control = (
    path: string,
    action: AuditAction,
    run: (principal: Principal, r: LiveSyncRecord) => Promise<LiveSyncRecord> | LiveSyncRecord,
    ownerOnly = false,
  ) =>
    app.post(
      `/live-syncs/:syncId/${path}`,
      { preHandler: requireAuth, config: { audit: action } },
      async (request) => {
        const principal = request.principal!
        const id = syncOf(request)
        const r = ownerOnly ? owned(principal, id) : visible(principal, id)
        request.auditInfo = audited(r)
        return runner().view(principal, await run(principal, r))
      },
    )
  const by = (principal: Principal, r: LiveSyncRecord) => (r.owner === ownerOf(principal) ? 'owner' : 'admin')
  control('pause', 'livesync.pause', (p, r) => runner().pause(r, by(p, r), p.username))
  control('resume', 'livesync.resume', (p, r) => {
    // W4.6: a scheduled sync starts early on its owner's word only (it starts as its owner).
    if (r.state === 'paused' && r.reason === 'scheduled' && r.owner !== ownerOf(p))
      throw Errors.forbidden('Only its owner can start it early', { reason: 'not_owner' })
    return runner().resume(r, isAdministrator(p))
  })
  control('stop', 'livesync.stop', (p, r) => runner().stop(r, by(p, r)))
  control('skip', 'livesync.skip', (_p, r) => runner().skip(r), true)
  control('verify', 'livesync.verify', (_p, r) => runner().verify(r))
  app.post(
    '/live-syncs/:syncId/finish',
    { preHandler: requireAuth, config: { audit: 'livesync.finish' } },
    async (request) => {
      const principal = request.principal!
      const r = owned(principal, syncOf(request))
      const { verify } = parseInput(LiveSyncFinishSchema, request.body ?? {})
      request.auditInfo = audited(r, { verify })
      return runner().view(principal, await runner().finish(r, verify))
    },
  )
  app.post(
    '/live-syncs/:syncId/apply-schema',
    { preHandler: requireAuth, config: { audit: 'livesync.schema' } },
    async (request) => {
      const principal = request.principal!
      const r = owned(principal, syncOf(request))
      const { ignore } = parseInput(LiveSyncSchemaSchema, request.body)
      request.auditInfo = audited(r, { ignore, collection: r.skip?.ns ?? null })
      return runner().view(principal, await runner().applySchema(r, ignore))
    },
  )

  app.delete(
    '/live-syncs/:syncId',
    { preHandler: requireAuth, config: { audit: 'livesync.delete' } },
    async (request, reply) => {
      const r = visible(request.principal!, syncOf(request))
      request.auditInfo = audited(r)
      runner().remove(r)
      return reply.status(204).send()
    },
  )

  /**
   * W4.6: the documents the target refused ("skip and record"), for the sync's owner only — while
   * they may still read and export from the source; an unmasked file is not given to an owner
   * restricted since, and a masked one not once the source's rules moved (it was masked under others).
   */
  app.get(
    '/live-syncs/:syncId/rejected',
    { preHandler: requireAuth, config: { audit: 'livesync.download' } },
    async (request, reply) => {
      const principal = request.principal!
      const r = owned(principal, syncOf(request))
      const file = runner().rejected.fileOf(r)
      if (!file) throw Errors.notFound('No document was refused')
      const sourceId = r.source.connectionId
      assertMayRead(principal, r, false)
      if (r.options.masked && file.rulesVersion !== ctx.personalFields.get(sourceId).version)
        throw Errors.conflict('The source’s personal-field rules changed since', { reason: 'rules_changed' })
      request.auditInfo = audited(r, { kind: 'rejected', size: file.size })
      return sendTransferFile(reply, file, ctx.transfer.files, file.name)
    },
  )

  /**
   * W4.6: the last verification's samples (documents and field changes, as the compare view shows
   * them), for the sync's owner only, under the same conditions as its other data — both sides
   * readable, nothing hidden from them since, and the rules the samples were read under unchanged.
   */
  app.get(
    '/live-syncs/:syncId/verify/samples',
    { preHandler: requireAuth, config: { audit: 'livesync.samples' } },
    async (request): Promise<LiveSyncVerifySamples> => {
      const principal = request.principal!
      const r = owned(principal, syncOf(request))
      const v = r.verify
      if (!v || v.state !== 'done') throw Errors.notFound('No verification has finished')
      assertMayRead(principal, r, true)
      const now = {
        source: ctx.personalFields.get(r.source.connectionId).version,
        target: ctx.personalFields.get(r.target.connectionId).version,
      }
      if (!v.versions || v.versions.source !== now.source || v.versions.target !== now.target)
        throw Errors.conflict('The personal-field rules changed since; verify again', {
          reason: 'rules_changed',
        })
      request.auditInfo = audited(r)
      return {
        finishedAt: v.finishedAt,
        masked: r.options.masked,
        pairs: v.pairs.map((p) => ({
          ...p,
          samples: p.samples ?? { onlySource: [], onlyTarget: [], different: [] },
        })),
      }
    },
  )

  /**
   * W4.6: the owner may still read what a sync's file or samples hold: documents:read on the source
   * and its export right (and documents:read on the target when it shows target documents); an
   * unmasked sync's data not once personal values are hidden from them on the source, nor target
   * documents once they are restricted there and the target has rules.
   */
  function assertMayRead(principal: Principal, r: LiveSyncRecord, target: boolean): void {
    const can = (id: string) => {
      const role = ctx.connections.get(id) ? effectiveRole(ctx, principal, id) : null
      return !!role && permissionsFor(role).has('documents:read')
    }
    const sourceId = r.source.connectionId
    if (!can(sourceId) || !mayExport(ctx, principal, sourceId) || (target && !can(r.target.connectionId)))
      throw Errors.forbidden('You may no longer read this sync’s data', { reason: 'owner_access' })
    if (!r.options.masked && isRestricted(ctx, principal, sourceId))
      throw Errors.forbidden('Personal values are hidden from you on the source now', {
        reason: 'masked_now',
      })
    if (
      target &&
      isRestricted(ctx, principal, r.target.connectionId) &&
      compileRules(ctx.personalFields.get(r.target.connectionId).rules).anyInDb(r.target.db)
    )
      throw Errors.forbidden('Personal values are hidden from you on the target now', {
        reason: 'masked_now',
      })
  }

  /** Spec §3.2, S9: the summary an owner reviews before a sync stopped by a change resumes. */
  const reviewOf = async (
    request: FastifyRequest,
    r: LiveSyncRecord,
    extra: Partial<LiveSyncRequest> = {},
  ) => {
    if (r.source.connectionId !== request.connection!.id) throw Errors.notFound('Live sync not found')
    const body = LiveSyncRequestSchema.parse({
      name: r.name,
      source: {
        connectionId: r.source.connectionId,
        db: r.source.db,
        ...(r.source.coll
          ? { coll: r.source.coll }
          : r.source.collections
            ? { collections: r.source.collections }
            : {}),
      },
      target: {
        connectionId: r.target.connectionId,
        db: r.target.db,
        ...(r.target.coll ? { coll: r.target.coll } : {}),
      },
      startMode: 'from_now',
      errorPolicy: r.options.errorPolicy,
      followNew: r.options.followNew,
      anonymous: r.options.anonymous,
      ...(r.options.filter ? { filter: r.options.filter } : {}),
      confirmOverwrite: true,
      ...extra,
    })
    return planLiveSync(request, body, runner().edges(r.id), r)
  }

  app.post(
    '/connections/:id/live-syncs/:syncId/review',
    { preHandler: requireExport(), config: { masking: 'guarded' } },
    async (request): Promise<LiveSyncPlan> => {
      const r = owned(request.principal!, syncOf(request))
      const body = parseInput(LiveSyncConfirmSchema.partial(), request.body ?? {})
      return (await reviewOf(request, r, body)).plan
    },
  )

  app.post(
    '/connections/:id/live-syncs/:syncId/confirm',
    { preHandler: requireExport(), config: { masking: 'guarded', audit: 'livesync.resume' } },
    async (request) => {
      const principal = request.principal!
      const r = owned(principal, syncOf(request))
      const { planHash, ...confirm } = parseInput(LiveSyncConfirmSchema, request.body)
      const planned = await reviewOf(request, r, confirm)
      refuse(planned, planHash)
      const addRules = addMissingRules(request, planned.input, planned.prepared, 'livesync.confirm')
      const stamps = {
        ...planned.stamps,
        versions: {
          source: planned.stamps.versions.source,
          target: ctx.personalFields.get(r.target.connectionId).version,
        },
      }
      request.auditInfo = audited(r, {
        confirmed: r.reason,
        personalUnruled: planned.prepared.plan.missingRules.length > 0 && !confirm.addRulesToTarget,
        rulesAdded: addRules.length,
      })
      return runner().view(
        principal,
        await runner().confirm(
          r,
          { stamps, options: planned.options },
          { confirmPersonal: confirm.confirmPersonal },
        ),
      )
    },
  )
}
