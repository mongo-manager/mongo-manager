import { ALERT_CLEAR_RATIO, ALERT_UNITS, type AlertDelivery, type AlertMetric } from '@mongo-manager/shared'
import type { SocketEgress } from '../net/egress'
import { SmtpError, sendMail } from './smtp'
import { postWebhook, type WebhookResult } from './webhook'
import type { AlertRepo, EventRow, RuleRow } from './repo'

/** What a notification says a metric is (mail subjects and bodies are in English, as logs are). */
export const METRIC_LABELS: Record<AlertMetric, string> = {
  connections: 'connections',
  opcounters: 'operations',
  replicationLag: 'replication lag',
  cacheFill: 'WiredTiger cache',
  diskUse: 'disk use',
  slowOps: 'slow operations',
}
const EVENT_LABELS: Record<string, string> = {
  'backup.failed': 'Backup failed',
  'schedule.failed': 'Scheduled backup failed',
  'liveSync.stopped': 'Live sync stopped',
  'job.failed': 'Job failed',
  'report.ready': 'Report',
}

export function formatValue(metric: AlertMetric, value: number | null): string {
  if (value === null) return '—'
  const rounded = Math.round(value * 10) / 10
  switch (ALERT_UNITS[metric]) {
    case 'perSecond':
      return `${rounded}/s`
    case 'seconds':
      return `${rounded} s`
    case 'percent':
      return `${rounded}%`
    default:
      return String(rounded)
  }
}

export type NoticeKind = 'firing' | 'resolved' | 'event'

/** W3 review (M7): deliveries at once, and waiting at most. */
const MAX_DELIVERING = 4
const MAX_QUEUED = 200

/** The subject and text of a notification: names and numbers only, never values or hosts. */
export function describe(e: EventRow, kind: NoticeKind): { subject: string; text: string } {
  const where = e.connectionName ?? 'a deleted connection'
  if (kind === 'event' || !e.metric) {
    const what = EVENT_LABELS[e.event ?? ''] ?? 'Event'
    // Design 2026-10-25 (C7): a report by its name, its counts one a line (not its id).
    const report = e.event === 'report.ready' ? String(e.detail.report ?? '') : null
    const lines = [
      report ? `${what} “${report}” on ${where}.` : `${what} on ${where}.`,
      '',
      ...Object.entries(e.detail)
        .filter(([k]) => !report || (k !== 'report' && k !== 'reportId'))
        .map(([k, v]) => `${k}: ${v === null ? '—' : String(v)}`),
      `At: ${new Date(e.startedAt).toISOString()}`,
    ]
    return {
      subject: report
        ? `[Mongo Manager] ${what}: ${report} (${where})`
        : `[Mongo Manager] ${what} on ${where}`,
      text: lines.join('\n'),
    }
  }
  const label = METRIC_LABELS[e.metric]
  const value = formatValue(e.metric, e.value)
  const threshold = formatValue(e.metric, e.threshold)
  const subject =
    kind === 'firing'
      ? `[Mongo Manager] Firing: ${label} ${value} on ${where}`
      : `[Mongo Manager] Resolved: ${label} on ${where}`
  const lines = [
    kind === 'firing'
      ? `${label} is above ${threshold} on ${where}: ${value}.`
      : `${label} is back below the threshold on ${where}.`,
    '',
    `Threshold: ${threshold} (it resolves at ${formatValue(e.metric, (e.threshold ?? 0) * ALERT_CLEAR_RATIO)} or less)`,
    `Since: ${new Date(e.startedAt).toISOString()}`,
    ...(e.resolvedAt ? [`Resolved: ${new Date(e.resolvedAt).toISOString()}`] : []),
    '',
    'Acknowledge or snooze it in Mongo Manager.',
  ]
  return { subject, text: lines.join('\n') }
}

export function webhookPayload(e: EventRow, kind: NoticeKind, now: number) {
  return {
    type: `alert.${kind}`,
    id: e.id,
    at: new Date(now).toISOString(),
    alert: {
      metric: e.metric,
      event: e.event,
      state: e.state,
      value: e.value,
      threshold: e.threshold,
      unit: e.metric ? ALERT_UNITS[e.metric] : null,
      startedAt: new Date(e.startedAt).toISOString(),
      resolvedAt: e.resolvedAt ? new Date(e.resolvedAt).toISOString() : null,
      connection: { id: e.connectionId, name: e.connectionName },
      detail: e.detail,
    },
  }
}

export interface NotifierDeps {
  repo: AlertRepo
  egress: SocketEgress
  now: () => number
  warn: (fields: Record<string, unknown>, message: string) => void
  retryMs?: readonly number[]
  /** MM_ALERTS=0: nothing is sent. */
  enabled: boolean
}

/**
 * W3.3: sends what fired to its rule's channels, in the background (the evaluation never waits on
 * a mail server), and writes what happened to each delivery on the alert. A snoozed rule's alerts
 * are recorded but not sent.
 */
export class AlertNotifier {
  private readonly pending = new Set<Promise<void>>()
  /** Tests trust their mail server's CA. */
  private extraCa: string | undefined

  constructor(private readonly d: NotifierDeps) {}

  trust(caPem: string): void {
    this.extraCa = caPem
  }

  /** Resolves once every delivery queued so far has ended (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size || this.queue.length) {
      if (this.pending.size) await Promise.allSettled([...this.pending])
      else this.pump()
    }
  }

  /**
   * W3 review (M7): deliveries wait in one bounded queue and go a few at a time, however many
   * channels and alerts fire at once; past the bound the oldest waiting ones are dropped (and said).
   */
  private readonly queue: Array<() => Promise<void>> = []
  private enqueue(task: () => Promise<void>): void {
    if (this.queue.length >= MAX_QUEUED) {
      this.queue.shift()
      this.d.warn({ queued: MAX_QUEUED }, 'alerts: too many notifications waiting; the oldest was dropped')
    }
    this.queue.push(task)
    this.pump()
  }
  private pump(): void {
    while (this.pending.size < MAX_DELIVERING && this.queue.length) {
      const task = this.queue.shift()!
      const work = task().catch((err: unknown) => this.d.warn({ err }, 'alerts: a notification failed'))
      this.pending.add(work)
      void work.finally(() => {
        this.pending.delete(work)
        this.pump()
      })
    }
  }

  notify(e: EventRow, rule: RuleRow, kind: NoticeKind): void {
    if (!this.d.enabled || e.snoozed) return
    if (rule.snoozedUntil !== null && rule.snoozedUntil > this.d.now()) return
    if (rule.channels.email) this.enqueue(() => this.mail(e, kind))
    for (const id of rule.channels.webhooks) this.enqueue(() => this.hook(e, kind, id))
  }

  private record(id: string, d: Omit<AlertDelivery, 'at'>): void {
    try {
      this.d.repo.addDelivery(id, { ...d, at: new Date(this.d.now()).toISOString() })
    } catch {
      // The store is closing: the delivery happened; only its note is lost.
    }
  }

  private async mail(e: EventRow, kind: NoticeKind): Promise<void> {
    const smtp = this.d.repo.smtp()
    if (!smtp?.enabled) return
    const { subject, text } = describe(e, kind)
    const result = await this.sendSmtp(smtp, subject, text)
    this.record(e.id, { channel: 'email', target: null, ok: result.ok, attempts: 1, error: result.error })
  }

  private async sendSmtp(
    smtp: NonNullable<ReturnType<AlertRepo['smtp']>>,
    subject: string,
    text: string,
  ): Promise<{ ok: boolean; error: string | null }> {
    try {
      await sendMail(this.d.egress, {
        host: smtp.host,
        port: smtp.port,
        security: smtp.security,
        username: smtp.username,
        password: smtp.password,
        message: { from: smtp.from, to: smtp.recipients, subject, text },
        ...(this.extraCa ? { caPem: this.extraCa } : {}),
      })
      return { ok: true, error: null }
    } catch (err) {
      return { ok: false, error: err instanceof SmtpError ? err.reason : 'error' }
    }
  }

  private async hook(e: EventRow, kind: NoticeKind, id: string): Promise<void> {
    const webhook = this.d.repo.webhook(id)
    if (!webhook?.enabled) return
    const secret = this.d.repo.webhookSecret(id)
    if (!secret) return
    const result = await postWebhook(
      this.d.egress,
      { url: webhook.url, secret },
      webhookPayload(e, kind, this.d.now()),
      {
        ...(this.d.retryMs ? { retryMs: this.d.retryMs } : {}),
      },
    )
    this.record(e.id, {
      channel: 'webhook',
      target: webhook.name,
      ok: result.ok,
      attempts: result.attempts,
      error: result.error,
    })
  }

  /** A test message to the configured recipients. */
  async testEmail(): Promise<{ ok: boolean; error: string | null }> {
    const smtp = this.d.repo.smtp()
    if (!smtp) return { ok: false, error: 'not_configured' }
    return this.sendSmtp(
      smtp,
      '[Mongo Manager] Test message',
      'This is a test of the alert e-mail channel. Alerts will arrive like this.',
    )
  }

  /** A signed test delivery (no retries). */
  async testWebhook(id: string): Promise<WebhookResult> {
    const webhook = this.d.repo.webhook(id)
    const secret = this.d.repo.webhookSecret(id)
    if (!webhook || !secret) return { ok: false, attempts: 0, error: 'not_found' }
    return postWebhook(
      this.d.egress,
      { url: webhook.url, secret },
      { type: 'alert.test', at: new Date(this.d.now()).toISOString() },
      { retryMs: [] },
    )
  }
}
