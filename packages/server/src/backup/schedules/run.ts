// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import {
  DumpRequestSchema,
  permissionsFor,
  type DrillOutcome,
  type DrillReport,
  type DumpReport,
  type PauseReason,
  type RunOutcome,
} from '@mongo-manager/shared'
import { SERVER_LOCATION, applyRetention } from './retention-run'
import { AppError } from '../../errors'
import { toAppError } from '../../data/mongo-errors'
import type { Principal, ServerContext } from '../../http/context'
import type { JobRecord } from '../../jobs/types'
import { HIDDEN_JOB_ERROR } from '../../jobs/visibility'
import { effectiveRole, isRestricted, viewing } from '../../connections/access'
import { planDump, type PreparedDump } from '../dump-plan'
import { backupFileName, type DumpJobParams } from '../dump-job'
import { runChecks } from './policy'
import type { RunDetails, ScheduleRecord } from './repo'
import { waitForJob } from './wait'

/** Plan ruling 19: the dump plan's refusals that pause a schedule; any other fails the run only. */
const PAUSES: Record<string, PauseReason> = {
  destination_encrypted_only: 'encrypted_only',
  destination_personal_plain: 'personal_plain',
  destination_unknown: 'destination_access',
}
const messageOf = (e: unknown): string => {
  const err = toAppError(e)
  return err instanceof AppError ? err.message : 'The run failed'
}

/**
 * Spec §1.5: each destination's copy for a run. Short names review 12 (M-2): a destination the
 * send failed before any copy of it was made (the local file could not be read, a policy refused
 * it) takes its reason from the send's notes, by its id (a deleted one has no name).
 */
export function runCopies(
  destinations: readonly string[],
  copies: ReadonlyArray<{ destinationId: string; state: string; reason?: string | null }>,
  noted: ReadonlyArray<{ destination?: string; destinationId?: string; reason: string | null }> | undefined,
  nameOf: (id: string) => string | null,
) {
  return destinations.map((id) => {
    const c = copies.find((x) => x.destinationId === id)
    return {
      destinationId: id,
      name: nameOf(id),
      state: (!c ? 'missing' : c.state === 'complete' ? 'complete' : 'failed') as
        'missing' | 'complete' | 'failed',
      reason: c
        ? c.state !== 'complete'
          ? (c.reason ?? null)
          : null
        : (noted?.find((f) => f.destinationId === id)?.reason ?? null),
    }
  })
}

/**
 * W4.4: a drill is due on every Nth run that made a backup — counted since the last run that drilled
 * (or was due to and could not), this one included.
 */
export function drillIsDue(ctx: ServerContext, s: ScheduleRecord, runId: string): boolean {
  if (!s.drill) return false
  let since = 0
  for (const r of ctx.backup.runs.list(s.id, 64)) {
    if (r.id === runId) continue
    if (r.details.drill) break
    if (r.backupId) since++
  }
  return since + 1 >= s.drill.everyRuns
}

type DrillStart = { jobId: string } | { skipped: string }

/**
 * W4.4: the drill job, as the owner now: it writes a scratch database on the schedule's connection, so
 * the owner must be allowed to create databases and write there (read-only mode included); otherwise
 * the drill is skipped, never the backup.
 */
function startDrill(
  ctx: ServerContext,
  s: ScheduleRecord,
  principal: Principal,
  runId: string,
  backupId: string,
): DrillStart {
  const connection = ctx.connections.get(s.connectionId)
  const role = connection ? effectiveRole(ctx, principal, s.connectionId) : null
  const readOnly = ctx.config.readOnly || Boolean(connection?.readOnly)
  const may = role ? permissionsFor(role, { readOnly }) : null
  if (!may?.has('documents:write') || !may.has('databases:write')) return { skipped: 'drill_rights' }
  try {
    const job = ctx.jobs.start(
      ctx.jobKinds['backup.drill'],
      {
        userId: principal.kind === 'user' ? principal.userId : null,
        connectionId: s.connectionId,
        db: s.dump.scope.kind === 'server' ? '*' : s.dump.scope.db,
        coll: '*',
        target: `${s.name} — restore drill`,
      },
      { owner: s.owner, backupId, schedule: { id: s.id, name: s.name, runId } },
      { scheduled: true },
    )
    return { jobId: job.id }
  } catch {
    return { skipped: 'server_busy' }
  }
}

async function drillOutcome(ctx: ServerContext, owner: string, start: DrillStart): Promise<DrillOutcome> {
  if ('skipped' in start) return { state: 'skipped', reason: start.skipped }
  await waitForJob(ctx.jobs, start.jobId)
  const report = ctx.transfer.reports.get(owner, start.jobId) as DrillReport | undefined
  if (!report) return { state: 'failed', reason: 'drill_failed', jobId: start.jobId }
  const mismatched = report.namespaces
    .filter((n) => n.contents === 'mismatch' || n.crc === 'mismatch')
    .map((n) => n.ns)
  return {
    state: report.ok ? 'passed' : 'failed',
    jobId: start.jobId,
    namespaces: report.namespaces.length,
    ...(report.ok ? {} : { reason: report.code ?? (mismatched.length ? 'drill_mismatch' : 'drill_failed') }),
    ...(mismatched.length ? { mismatched: mismatched.slice(0, 20) } : {}),
  }
}

/**
 * Spec §1.5: checks as the owner now; a `backup.dump` job with the owner's key slot that queues its
 * own `backup.send`; the outcome per location; retention where this run's copy completed. Never
 * throws: everything ends in the run row and one audit entry.
 */
export async function executeRun(ctx: ServerContext, runId: string): Promise<void> {
  const runs = ctx.backup.runs
  const run = runs.get(runId)
  if (!run || run.outcome) return
  const s = ctx.backup.schedules.get(run.scheduleId)
  if (!s) {
    runs.finish(runId, 'skipped', 'schedule_gone', {})
    return
  }
  runs.start(runId)
  // Final review of wave B (M1): started for an agent's turn, its rows name it to the end.
  const agent = ctx.backup.scheduler.takeAgent(runId)
  const details: RunDetails = {}
  let outcome: RunOutcome = 'failed'
  let reason: string | null = null
  let key: Buffer | null = null
  // Final review minor 23: set once the owner is known; every failure message after that honours it.
  let hidden = false
  try {
    const checks = runChecks(ctx, s)
    if (!checks.ok) {
      ctx.backup.schedules.pause(s.id, checks.pause, 'system')
      reason = checks.pause
      return
    }
    key = checks.key?.key ?? null
    if (checks.key) details.keyFingerprint = checks.key.fingerprint
    const principal = checks.principal
    // Phase 3c §4.7: a restricted owner never reads MongoDB's own words (they can quote values) —
    // nor one who hides the values from themselves: the history is read as its owner views data.
    hidden = isRestricted(ctx, viewing(principal), s.connectionId)
    // W4.4: a drill due this run keeps the server copy until it has restored it.
    const drillDue = drillIsDue(ctx, s, run.id)
    const request = DumpRequestSchema.parse({
      ...s.dump,
      format: s.format,
      destinations: s.destinations,
      deleteLocal: !s.keepOnServer && !drillDue,
    })
    let prepared: PreparedDump
    const release = ctx.manager.hold(s.connectionId)
    try {
      const client = await ctx.manager.getClient(s.connectionId)
      prepared = await planDump(
        { ctx, principal, connectionId: s.connectionId, client, comment: `mm-schedule:${run.id}` },
        request,
      )
    } catch (e) {
      // Temporary (plan ruling 19): the schedule stays active.
      const err = toAppError(e)
      reason = err instanceof AppError && err.statusCode === 404 ? 'scope_gone' : 'connection'
      details.message = hidden ? HIDDEN_JOB_ERROR : messageOf(e)
      return
    } finally {
      release()
    }
    const pause = prepared.plan.refusals.map((r) => PAUSES[r]).find((p) => p !== undefined)
    if (pause) {
      ctx.backup.schedules.pause(s.id, pause, 'system')
      reason = pause
      return
    }
    // Final review I6: this schedule's own kept copies fill the space. Kept copies have no time to
    // live and retention runs only after a run that succeeds, so nothing would ever free it: pause.
    if (
      prepared.plan.refusals.includes('backup_quota') &&
      s.keepOnServer &&
      ctx.backup.store.bySchedule(s.id).length > 0
    ) {
      ctx.backup.schedules.pause(s.id, 'server_space', 'system')
      reason = 'server_space'
      return
    }
    if (prepared.plan.refusals.length) {
      reason = prepared.plan.refusals[0]!
      return
    }
    const scope = s.dump.scope
    const fileName = backupFileName(scope, s.format, ctx.now())
    const params: DumpJobParams = {
      owner: s.owner,
      request: { ...request, planHash: prepared.plan.planHash },
      password: null,
      serverKey: checks.key ? { keyId: checks.key.keyId, key: Buffer.from(checks.key.key) } : null,
      prepared,
      fileName,
      sendAs: principal,
      schedule: { id: s.id, name: s.name, runId: run.id, keep: s.keepOnServer },
      ...(agent ? { agent } : {}),
    }
    let dump: JobRecord
    try {
      dump = ctx.jobs.start(
        ctx.jobKinds['backup.dump'],
        {
          userId: principal.kind === 'user' ? principal.userId : null,
          connectionId: s.connectionId,
          db: scope.kind === 'server' ? '*' : scope.db,
          coll: scope.kind === 'collection' ? scope.coll : '*',
          target: fileName,
        },
        params,
        { scheduled: true },
      )
    } catch (e) {
      params.serverKey?.key.fill(0)
      reason = 'server_busy'
      details.message = messageOf(e)
      return
    }
    runs.setJobs(run.id, { dumpJobId: dump.id })
    const dumped = await waitForJob(ctx.jobs, dump.id)
    const report = ctx.transfer.reports.get(s.owner, dump.id) as DumpReport | undefined
    if (dumped.state !== 'done' || !report?.backupId) {
      reason = dumped.state === 'cancelled' ? 'cancelled' : 'dump_failed'
      if (dumped.error) details.message = hidden ? HIDDEN_JOB_ERROR : dumped.error
      return
    }
    details.size = report.size
    runs.setJobs(run.id, { backupId: report.backupId, sendJobId: report.sendJobId ?? null })
    // W4.4: the drill restores this run's backup while it is sent.
    const drill = drillDue ? startDrill(ctx, s, principal, run.id, report.backupId) : null
    const sent = report.sendJobId ? await waitForJob(ctx.jobs, report.sendJobId) : null
    const copies = ctx.backup.copies.forRun(s.id, report.backupId)
    details.copies = runCopies(
      s.destinations,
      copies,
      report.sendJobId ? ctx.backup.jobNotes.get(report.sendJobId)?.failures : undefined,
      (id) => ctx.backup.destinations.get(id)?.name ?? null,
    )
    // Spec §1.5 step 6: a location is each destination, and this server when it keeps copies.
    const local = s.keepOnServer ? ctx.backup.store.byId(report.backupId) : undefined
    const locations = s.destinations.length + (s.keepOnServer ? 1 : 0)
    const good = details.copies.filter((c) => c.state === 'complete').length + (local?.complete ? 1 : 0)
    outcome = good === locations ? 'succeeded' : good > 0 ? 'partial' : 'failed'
    if (drill) {
      details.drill = await drillOutcome(ctx, s.owner, drill)
      // The copy kept for the drill goes as the send would have let it go: once every destination
      // has its own complete copy (otherwise it stays for its time to live, as a kept local copy).
      if (!s.keepOnServer && details.copies.every((c) => c.state === 'complete'))
        ctx.backup.store.delete(s.owner, report.backupId)
    }
    if (outcome !== 'succeeded') {
      reason = report.sendJobId ? 'send_failed' : 'send_not_started'
      const said = sent?.error ?? report.sendError
      if (said) details.message = said
    }
    // Spec §1.4, D6: per location, only where this run's copy completed, with the schedule as it is
    // now (a deleted schedule removes nothing).
    const current = ctx.backup.schedules.get(s.id)
    if (current) {
      const removals: NonNullable<RunDetails['removals']> = []
      for (const c of details.copies) {
        const made = copies.find((x) => x.destinationId === c.destinationId)
        if (c.state !== 'complete' || !made) continue
        removals.push({
          location: c.destinationId,
          name: c.name,
          ...(await applyRetention(ctx, current, { id: c.destinationId, name: c.name }, made.id)),
        })
      }
      if (current.keepOnServer && local?.complete)
        removals.push({
          location: SERVER_LOCATION,
          name: null,
          ...(await applyRetention(ctx, current, { id: SERVER_LOCATION, name: null }, local.id)),
        })
      details.removals = removals
    }
  } catch (e) {
    reason = 'internal'
    details.message = hidden ? HIDDEN_JOB_ERROR : messageOf(e)
  } finally {
    key?.fill(0)
    runs.finish(run.id, outcome, reason, details)
    ctx.audit.append({
      action: 'backup.schedule.run.finish',
      outcome: outcome === 'failed' ? 'failure' : 'success',
      userId: s.owner === 'local' ? null : s.owner,
      username: null,
      ip: null,
      connectionId: s.connectionId,
      namespace: null,
      details: {
        ...(agent ? { agent: { ...agent } } : {}),
        schedule: s.id,
        name: s.name,
        run: run.id,
        kind: run.kind,
        outcome,
        reason,
        ...(details.size !== undefined ? { size: details.size } : {}),
      },
    })
    // W3.3: a run that failed (or reached only some destinations) is an alert event — the
    // schedule's name and the reason code, never the error's words.
    if (outcome === 'failed' || outcome === 'partial')
      try {
        ctx.alerts.event({
          event: 'schedule.failed',
          connectionId: s.connectionId,
          detail: { schedule: s.name, outcome, reason: reason ?? null },
        })
      } catch {
        // An alert that cannot be recorded never fails the run's own bookkeeping.
      }
  }
}
