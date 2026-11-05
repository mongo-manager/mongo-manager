// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { isIP } from 'node:net'
import { z } from 'zod'
import {
  AlertHistoryQuerySchema,
  AlertOptInSchema,
  AlertRuleInputSchema,
  AlertRulePatchSchema,
  AlertSnoozeSchema,
  ReportInputSchema,
  ReportPatchSchema,
  cadenceProblem,
  compileCadence,
  nextRunAfter,
  SmtpEnabledSchema,
  SmtpSettingsSchema,
  WebhookInputSchema,
  WebhookPatchSchema,
  permissionsFor,
  type AlertView,
} from '@mongo-manager/shared'
import { reportView } from '../alerts/reports'
import { Errors } from '../errors'
import { parseInput } from '../validate'
import { requireAuth, requirePermission } from '../http/guards'
import { effectiveRole } from '../connections/access'
import { classifyAddress } from '../net/cidr'
import { chatOwner } from '../ai/access'
import { UploadGate } from '../transfer/upload-gate'
import type { Principal } from '../http/context'
import { MAX_HISTORY_CONNECTIONS } from '../monitor/history'
import { samplingRoom } from '../monitor/sampling'
import { eventView, ruleView, webhookView, type EventRow } from '../alerts/repo'

const RuleParams = z.object({ ruleId: z.string().min(1).max(64) })
const WebhookParams = z.object({ webhookId: z.string().min(1).max(64) })
const AlertParams = z.object({ alertId: z.string().min(1).max(64) })
const RulesQuery = z.strictObject({ connectionId: z.string().min(1).max(64).optional() })
const OPT_IN = 'alerts.inApp'
const DISMISSED = 'alerts.dismissed'
const MAX_DISMISSED = 500
/** Details that are codes and numbers, shown to everyone who sees the alert (W3 review M8). */
const CODE_DETAILS = new Set(['seconds', 'kind', 'state', 'reason', 'outcome'])

/**
 * A webhook address as it is saved: https (plain http only to a listed private address), no
 * credentials in it, never a metadata or link-local address. A name is judged again where it
 * connects (the egress guard), so one that later resolves somewhere refused is refused then.
 */
function assertWebhookUrl(text: string, listed: (address: string) => boolean): void {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw Errors.validation('The webhook address is not valid', { reason: 'bad_url' })
  }
  if (url.username || url.password)
    throw Errors.validation('Credentials do not belong in the address', { reason: 'bad_url' })
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const literal = isIP(host) !== 0
  if (literal) {
    const v = classifyAddress(host, [])
    if (!v.ok && v.reason !== 'private' && v.reason !== 'loopback')
      throw Errors.validation('That address can never be reached from Mongo Manager', {
        reason: 'address_never',
      })
  }
  if (url.protocol === 'https:') return
  if (url.protocol === 'http:' && literal && listed(host)) return
  throw Errors.validation('Webhooks use https:// (plain http only inside MM_ALERTS_PRIVATE_NETWORKS)', {
    reason: 'http_refused',
  })
}

/**
 * W3.3: alerts. Rules, channels and history are for administrators (settings:manage); what a
 * user sees in the bell is what they opted in to, on connections whose server they may watch
 * (server:monitor there), from rules that send to the app. Every change is audited; secrets are
 * write-only (a webhook's signing secret is shown once, when it is made or rotated).
 */
export async function alertRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app
  const manage = requirePermission('settings:manage')
  const alerts = () => ctx.alerts
  // Tests of channels reach out: ten a minute per administrator.
  const tests = new UploadGate(ctx.now, { perMinute: 10, concurrent: 2 })
  const owner = (p: Principal) => chatOwner(p) ?? 'local'
  const optedIn = (p: Principal) => ctx.preferences.get(owner(p), OPT_IN) === true

  /** Whether this user may see this alert: they may watch its connection, or administer the app. */
  const mayView = (p: Principal, e: EventRow): boolean => {
    if (e.connectionId) {
      const role = effectiveRole(ctx, p, e.connectionId)
      if (role && permissionsFor(role).has('server:monitor')) return true
    }
    return isAdmin(p)
  }
  /** W3 review (M1): one cap for history and alerts together, on every path that adds one. */
  const assertRoom = (connectionId: string): void => {
    if (!samplingRoom(ctx, connectionId))
      throw Errors.conflict(
        `At most ${MAX_HISTORY_CONNECTIONS} connections are sampled for history and alerts`,
        { reason: 'too_many_sampled' },
      )
  }
  const isAdmin = (p: Principal) =>
    permissionsFor(p.role).has('settings:manage') && (p.kind === 'local' || p.role === 'admin')
  /** W3 review (M8): alerts this user put out of their own bell. */
  const dismissed = (p: Principal): string[] => {
    const v = ctx.preferences.get(owner(p), DISMISSED)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  }
  /**
   * W3 review (M8): an event's names (a live sync's name, a job's namespace, a schedule) are for
   * administrators; others see what happened (codes), not whose or where.
   */
  const shownTo = (p: Principal, view: AlertView): AlertView =>
    isAdmin(p)
      ? view
      : // Review of C7a (M1): a report's run says only that it ran (its labels could be a code's name).
        view.event === 'report.ready'
        ? { ...view, detail: {} }
        : {
            ...view,
            detail: Object.fromEntries(Object.entries(view.detail).filter(([k]) => CODE_DETAILS.has(k))),
          }
  const inBell = (p: Principal, e: EventRow): boolean => {
    // Design 2026-10-25 (C7): a report's run, where its report sends to the app.
    if (!e.ruleId && e.event === 'report.ready') {
      const report = ctx.reports.repo.get(String(e.detail.reportId ?? ''))
      return !!report?.channels.inApp && mayView(p, e)
    }
    if (!e.ruleId) return false
    const rule = alerts().repo.getRule(e.ruleId)
    return !!rule?.channels.inApp && mayView(p, e)
  }

  app.get('/alerts/rules', { preHandler: manage }, async (request) => {
    const { connectionId } = parseInput(RulesQuery, request.query ?? {})
    return alerts()
      .repo.listRules(connectionId)
      .map((r) => ruleView(r, r.kind === 'metric' ? alerts().repo.openFiring(r.id) : undefined))
  })

  app.post(
    '/alerts/rules',
    { preHandler: manage, config: { audit: 'alerts.rule.create' } },
    async (request, reply) => {
      const input = parseInput(AlertRuleInputSchema, request.body)
      request.auditInfo = {
        details: {
          kind: input.kind,
          connectionId: input.connectionId,
          ...(input.kind === 'metric'
            ? { metric: input.metric, threshold: input.threshold }
            : { event: input.event }),
        },
      }
      if (input.connectionId && !ctx.connections.get(input.connectionId))
        throw Errors.notFound('Connection not found')
      for (const id of input.channels.webhooks)
        if (!alerts().repo.webhook(id)) throw Errors.validation('A webhook named by the rule does not exist')
      if (input.kind === 'metric' && input.enabled) assertRoom(input.connectionId)
      const principal = request.principal!
      const rule = alerts().repo.createRule(input, principal.kind === 'user' ? principal.userId : null)
      ctx.historyRecorder.sync()
      return reply.code(201).send(ruleView(rule, undefined))
    },
  )

  app.patch(
    '/alerts/rules/:ruleId',
    { preHandler: manage, config: { audit: 'alerts.rule.update' } },
    async (request) => {
      const { ruleId } = parseInput(RuleParams, request.params)
      const patch = parseInput(AlertRulePatchSchema, request.body)
      request.auditInfo = { details: { rule: ruleId, ...patch } }
      for (const id of patch.channels?.webhooks ?? [])
        if (!alerts().repo.webhook(id)) throw Errors.validation('A webhook named by the rule does not exist')
      const before = alerts().repo.getRule(ruleId)
      // W3 review (M1): switching a threshold on takes a sampling place like making one does.
      if (before?.kind === 'metric' && before.connectionId && patch.enabled === true && !before.enabled)
        assertRoom(before.connectionId)
      const firing = alerts().repo.openFiring(ruleId)
      const rule = alerts().repo.patchRule(ruleId, patch)
      alerts().engine.ruleChanged(ruleId, rule, firing)
      ctx.historyRecorder.sync()
      return ruleView(rule, alerts().repo.openFiring(ruleId))
    },
  )

  app.delete(
    '/alerts/rules/:ruleId',
    { preHandler: manage, config: { audit: 'alerts.rule.delete' } },
    async (request, reply) => {
      const { ruleId } = parseInput(RuleParams, request.params)
      request.auditInfo = { details: { rule: ruleId } }
      const firing = alerts().repo.openFiring(ruleId)
      if (!alerts().repo.deleteRule(ruleId)) throw Errors.notFound('Alert rule not found')
      alerts().engine.ruleChanged(ruleId, undefined, firing)
      ctx.historyRecorder.sync()
      return reply.code(204).send()
    },
  )

  app.post(
    '/alerts/rules/:ruleId/snooze',
    { preHandler: manage, config: { audit: 'alerts.rule.snooze' } },
    async (request) => {
      const { ruleId } = parseInput(RuleParams, request.params)
      const { minutes } = parseInput(AlertSnoozeSchema, request.body)
      request.auditInfo = { details: { rule: ruleId, minutes } }
      const rule = alerts().repo.snooze(ruleId, minutes === null ? null : ctx.now() + minutes * 60_000)
      return ruleView(rule, alerts().repo.openFiring(ruleId))
    },
  )

  /**
   * Design 2026-10-25 (C7): scheduled reports, an administrator's as the rules are. Each saved one is
   * checked as it will run: no MongoDB namespace of its own, no server JavaScript, a connection that
   * does not sign in per person, a filter the personal-data gate takes for everyone, a cadence that
   * runs (an hour apart at least), webhooks that exist.
   */
  const ReportParams = z.object({ reportId: z.string().min(1).max(64) })
  const reportChecked = async (input: {
    connectionId: string
    measures: Parameters<typeof ctx.reports.problem>[0]['measures']
    cadence?: Parameters<typeof cadenceProblem>[0]
    timeZone?: string
    webhooks?: readonly string[]
  }): Promise<void> => {
    if (!ctx.connections.get(input.connectionId)) throw Errors.notFound('Connection not found')
    if (input.cadence) {
      const problem = cadenceProblem(input.cadence, ctx.now())
      if (problem) throw Errors.validation('That cadence cannot run', { reason: `cadence_${problem.reason}` })
      // Re-review of C7 (minor 2): its next run worked out in its zone, as the loop will.
      let next: number | null
      try {
        next = nextRunAfter(compileCadence(input.cadence), input.timeZone ?? 'UTC', ctx.now())
      } catch {
        next = null
      }
      if (next === null)
        throw Errors.validation('That schedule cannot be worked out', { reason: 'invalid_cadence' })
    }
    for (const id of input.webhooks ?? [])
      if (!alerts().repo.webhook(id)) throw Errors.validation('A webhook named by the report does not exist')
    const problem = input.measures.length ? await ctx.reports.problem(input) : null
    if (problem)
      throw Errors.validation('The report cannot count that', {
        reason: problem.reason,
        ...(problem.measure !== undefined ? { measure: problem.measure } : {}),
      })
  }
  app.get('/alerts/reports', { preHandler: manage }, async () => ctx.reports.repo.list().map(reportView))
  app.post(
    '/alerts/reports',
    { preHandler: manage, config: { audit: 'alerts.report.create' } },
    async (request, reply) => {
      const input = parseInput(ReportInputSchema, request.body)
      // Names and counts, never a filter.
      request.auditInfo = {
        details: { connectionId: input.connectionId, name: input.name, measures: input.measures.length },
      }
      await reportChecked({ ...input, webhooks: input.channels.webhooks })
      const principal = request.principal!
      const report = ctx.reports.repo.create(input, principal.kind === 'user' ? principal.userId : null)
      return reply.code(201).send(reportView(report))
    },
  )
  app.patch(
    '/alerts/reports/:reportId',
    { preHandler: manage, config: { audit: 'alerts.report.update' } },
    async (request) => {
      const { reportId } = parseInput(ReportParams, request.params)
      const patch = parseInput(ReportPatchSchema, request.body)
      request.auditInfo = {
        details: {
          report: reportId,
          fields: Object.keys(patch),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        },
      }
      const before = ctx.reports.repo.get(reportId)
      if (!before) throw Errors.notFound('Report not found')
      // Review of C7a (I2): the counts are checked when they change or the report is turned on —
      // never to turn one off or rename it (each run checks them again anyway).
      const counts = patch.measures !== undefined || (patch.enabled === true && !before.enabled)
      const timing =
        patch.cadence !== undefined ||
        patch.timeZone !== undefined ||
        (patch.enabled === true && !before.enabled)
      await reportChecked({
        connectionId: before.connectionId,
        measures: counts ? (patch.measures ?? before.measures) : [],
        ...(timing
          ? { cadence: patch.cadence ?? before.cadence, timeZone: patch.timeZone ?? before.timeZone }
          : {}),
        ...(patch.channels ? { webhooks: patch.channels.webhooks } : {}),
      })
      return reportView(ctx.reports.repo.patch(reportId, patch)!)
    },
  )
  app.delete(
    '/alerts/reports/:reportId',
    { preHandler: manage, config: { audit: 'alerts.report.delete' } },
    async (request, reply) => {
      const { reportId } = parseInput(ReportParams, request.params)
      request.auditInfo = { details: { report: reportId } }
      if (!ctx.reports.repo.delete(reportId)) throw Errors.notFound('Report not found')
      return reply.code(204).send()
    },
  )
  /** C7: a report run now — its counts said through its channels, as a scheduled run's are. */
  app.post(
    '/alerts/reports/:reportId/run',
    { preHandler: manage, config: { audit: 'alerts.report.run' } },
    async (request) => {
      const { reportId } = parseInput(ReportParams, request.params)
      request.auditInfo = { details: { report: reportId } }
      const report = ctx.reports.repo.get(reportId)
      if (!report) throw Errors.notFound('Report not found')
      const values = await ctx.reports.run(report)
      const ch = report.channels
      // Said back: whether its counts went anywhere — the bell, a mail server set up, a webhook that is
      // on (re-review of C7, minor 5); otherwise they were only kept.
      const hooks = ch.webhooks.some((id) => alerts().repo.webhook(id)?.enabled)
      const mail = ch.email && !!alerts().repo.smtpView()?.enabled
      return { values, sent: alerts().enabled && (ch.inApp || mail || hooks) }
    },
  )

  app.get('/alerts/channels', { preHandler: manage }, async () => ({
    email: alerts().repo.smtpView(),
    webhooks: alerts().repo.webhooks().map(webhookView),
  }))

  app.put(
    '/alerts/channels/email',
    { preHandler: manage, config: { audit: 'alerts.email.update' } },
    async (request) => {
      const input = parseInput(SmtpSettingsSchema, request.body)
      request.auditInfo = {
        details: {
          enabled: input.enabled,
          host: input.host,
          port: input.port,
          security: input.security,
          recipients: input.recipients.length,
          credential: input.password === undefined ? 'kept' : input.password ? 'set' : 'removed',
        },
      }
      return alerts().repo.setSmtp(input)
    },
  )

  /** User report 2026-10-30: the switch alone — mail off (or on) without the settings sent again. */
  app.patch(
    '/alerts/channels/email',
    { preHandler: manage, config: { audit: 'alerts.email.update' } },
    async (request) => {
      const { enabled } = parseInput(SmtpEnabledSchema, request.body)
      request.auditInfo = { details: { enabled } }
      const view = alerts().repo.setSmtpEnabled(enabled)
      if (!view) throw Errors.notFound('E-mail is not set up')
      return view
    },
  )

  app.post(
    '/alerts/channels/email/test',
    { preHandler: manage, config: { audit: 'alerts.email.test' } },
    async (request) => {
      const release = tests.enter(owner(request.principal!))
      try {
        const result = await alerts().notifier.testEmail()
        request.auditInfo = { details: { ok: result.ok, error: result.error } }
        return result
      } finally {
        release()
      }
    },
  )

  app.post(
    '/alerts/channels/webhooks',
    { preHandler: manage, config: { audit: 'alerts.webhook.create' } },
    async (request, reply) => {
      const input = parseInput(WebhookInputSchema, request.body)
      assertWebhookUrl(input.url, (a) => alerts().egress.listed(a))
      request.auditInfo = { details: { name: input.name, host: new URL(input.url).host } }
      return reply.code(201).send(alerts().repo.createWebhook(input))
    },
  )

  app.patch(
    '/alerts/channels/webhooks/:webhookId',
    { preHandler: manage, config: { audit: 'alerts.webhook.update' } },
    async (request) => {
      const { webhookId } = parseInput(WebhookParams, request.params)
      const patch = parseInput(WebhookPatchSchema, request.body)
      if (patch.url) assertWebhookUrl(patch.url, (a) => alerts().egress.listed(a))
      request.auditInfo = {
        details: {
          webhook: webhookId,
          ...(patch.name ? { name: patch.name } : {}),
          ...(patch.url ? { host: new URL(patch.url).host } : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          ...(patch.rotateSecret ? { rotated: true } : {}),
        },
      }
      return alerts().repo.patchWebhook(webhookId, patch)
    },
  )

  app.delete(
    '/alerts/channels/webhooks/:webhookId',
    { preHandler: manage, config: { audit: 'alerts.webhook.delete' } },
    async (request, reply) => {
      const { webhookId } = parseInput(WebhookParams, request.params)
      request.auditInfo = { details: { webhook: webhookId } }
      if (!alerts().repo.deleteWebhook(webhookId)) throw Errors.notFound('Webhook not found')
      return reply.code(204).send()
    },
  )

  app.post(
    '/alerts/channels/webhooks/:webhookId/test',
    { preHandler: manage, config: { audit: 'alerts.webhook.test' } },
    async (request) => {
      const { webhookId } = parseInput(WebhookParams, request.params)
      if (!alerts().repo.webhook(webhookId)) throw Errors.notFound('Webhook not found')
      const release = tests.enter(owner(request.principal!))
      try {
        const result = await alerts().notifier.testWebhook(webhookId)
        request.auditInfo = { details: { webhook: webhookId, ok: result.ok, error: result.error } }
        return result
      } finally {
        release()
      }
    },
  )

  app.get('/alerts/history', { preHandler: manage }, async (request): Promise<AlertView[]> => {
    const q = parseInput(AlertHistoryQuerySchema, request.query ?? {})
    return alerts().repo.history(q).map(eventView)
  })

  app.get('/alerts/active', { preHandler: requireAuth }, async (request): Promise<AlertView[]> => {
    const principal = request.principal!
    if (!alerts().enabled || !optedIn(principal)) return []
    const hidden = new Set(dismissed(principal))
    return alerts()
      .repo.active()
      .filter((e) => !hidden.has(e.id) && inBell(principal, e))
      .slice(0, 100)
      .map((e) => shownTo(principal, eventView(e)))
  })

  app.post(
    '/alerts/:alertId/acknowledge',
    // W3 review (M8): acknowledging is for everyone at once, so it is the administrators'.
    { preHandler: manage, config: { audit: 'alerts.acknowledge' } },
    async (request: FastifyRequest) => {
      const { alertId } = parseInput(AlertParams, request.params)
      const principal = request.principal!
      const event = alerts().repo.getEvent(alertId)
      // One the caller may not see answers as missing: it does not tell them it exists.
      if (!event || !mayView(principal, event)) throw Errors.notFound('Alert not found')
      request.auditInfo = { details: { alert: alertId } }
      return eventView(alerts().repo.acknowledge(alertId, principal.username)!)
    },
  )

  // W3 review (M8): out of this user's bell only (anyone who may see it).
  app.post('/alerts/:alertId/dismiss', { preHandler: requireAuth }, async (request: FastifyRequest) => {
    const { alertId } = parseInput(AlertParams, request.params)
    const principal = request.principal!
    const event = alerts().repo.getEvent(alertId)
    if (!event || !mayView(principal, event)) throw Errors.notFound('Alert not found')
    const kept = alerts()
      .repo.active()
      .map((e) => e.id)
    // Only what is still in the bell is remembered: the list cannot grow without end.
    const next = [...new Set([...dismissed(principal), alertId])].filter((id) => kept.includes(id))
    ctx.preferences.set(owner(principal), DISMISSED, next.slice(-MAX_DISMISSED))
    return { ok: true }
  })

  app.get('/me/alerts', { preHandler: requireAuth }, async (request) => ({
    inApp: optedIn(request.principal!),
    available: alerts().enabled,
  }))

  app.put('/me/alerts', { preHandler: requireAuth }, async (request) => {
    const { inApp } = parseInput(AlertOptInSchema, request.body)
    ctx.preferences.set(owner(request.principal!), OPT_IN, inApp)
    return { inApp, available: alerts().enabled }
  })
}
