import { randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  AlertChannelsSchema,
  type AlertChannels,
  type AlertDelivery,
  type AlertEvent,
  type AlertMetric,
  type AlertRuleInput,
  type AlertRuleView,
  type AlertState,
  type AlertView,
  type SmtpSettingsInput,
  type SmtpSettingsView,
  type WebhookView,
} from '@mongo-manager/shared'
import type { SecretBox } from '../crypto/secret-box'
import { Errors } from '../errors'

/** W3.3: where a channel's secret is sealed (its own context: one row's secret opens no other). */
export const alertChannelContext = (id: string): string => `alert-channel:${id}`
export const SMTP_ID = 'smtp'
/** History is kept this long, and at most this many rows. */
export const ALERT_KEEP_MS = 90 * 86_400_000
export const ALERT_KEEP_ROWS = 20_000
const MAX_WEBHOOKS = 20
const MAX_RULES = 500
const MAX_DELIVERIES = 20

export interface RuleRow {
  id: string
  kind: 'metric' | 'event'
  connectionId: string | null
  metric: AlertMetric | null
  event: AlertEvent | null
  threshold: number | null
  slowOpSeconds: number | null
  sustain: number
  enabled: boolean
  channels: AlertChannels
  snoozedUntil: number | null
}

export interface EventRow {
  id: string
  ruleId: string | null
  connectionId: string | null
  connectionName: string | null
  metric: AlertMetric | null
  event: AlertEvent | null
  state: AlertState
  value: number | null
  threshold: number | null
  startedAt: number
  resolvedAt: number | null
  acknowledgedAt: number | null
  acknowledgedBy: string | null
  detail: Record<string, string | number | boolean | null>
  deliveries: AlertDelivery[]
  snoozed: boolean
}

interface RuleDb {
  id: string
  kind: 'metric' | 'event'
  connection_id: string | null
  metric: string | null
  event: string | null
  threshold: number | null
  slow_op_seconds: number | null
  sustain: number
  enabled: number
  channels: string
  snoozed_until: number | null
}

interface EventDb {
  id: string
  rule_id: string | null
  connection_id: string | null
  connection_name: string | null
  metric: string | null
  event: string | null
  state: AlertState
  value: number | null
  threshold: number | null
  started_at: number
  resolved_at: number | null
  acknowledged_at: number | null
  acknowledged_by: string | null
  detail: string
  deliveries: string
  snoozed: number
}

interface ChannelDb {
  id: string
  kind: 'smtp' | 'webhook'
  name: string
  config: string
  secret: string | null
  enabled: number
  created_at: number
  updated_at: number
}

const json = <T>(text: string, fallback: T): T => {
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

const toRule = (r: RuleDb): RuleRow => ({
  id: r.id,
  kind: r.kind,
  connectionId: r.connection_id,
  metric: r.metric as AlertMetric | null,
  event: r.event as AlertEvent | null,
  threshold: r.threshold,
  slowOpSeconds: r.slow_op_seconds,
  sustain: r.sustain,
  enabled: r.enabled === 1,
  channels: AlertChannelsSchema.catch({ inApp: true, email: false, webhooks: [] }).parse(
    json(r.channels, {}),
  ),
  snoozedUntil: r.snoozed_until,
})

const toEvent = (r: EventDb): EventRow => ({
  id: r.id,
  ruleId: r.rule_id,
  connectionId: r.connection_id,
  connectionName: r.connection_name,
  metric: r.metric as AlertMetric | null,
  event: r.event as AlertEvent | null,
  state: r.state,
  value: r.value,
  threshold: r.threshold,
  startedAt: r.started_at,
  resolvedAt: r.resolved_at,
  acknowledgedAt: r.acknowledged_at,
  acknowledgedBy: r.acknowledged_by,
  detail: json(r.detail, {}),
  deliveries: json(r.deliveries, []),
  snoozed: r.snoozed === 1,
})

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

export function eventView(e: EventRow): AlertView {
  return {
    id: e.id,
    ruleId: e.ruleId,
    connectionId: e.connectionId,
    connectionName: e.connectionName,
    metric: e.metric,
    event: e.event,
    state: e.state,
    value: e.value,
    threshold: e.threshold,
    startedAt: iso(e.startedAt)!,
    resolvedAt: iso(e.resolvedAt),
    acknowledgedAt: iso(e.acknowledgedAt),
    acknowledgedBy: e.acknowledgedBy,
    detail: e.detail,
    deliveries: e.deliveries,
    snoozed: e.snoozed,
  }
}

export interface WebhookRow {
  id: string
  name: string
  url: string
  enabled: boolean
  createdAt: number
}

/** A webhook's signing secret: 32 random bytes, prefixed so it is recognised where it is pasted. */
const newSecret = () => `whsec_${randomBytes(32).toString('base64url')}`

/**
 * W3.3: alert rules, what fired (the history), and the channels. The SMTP password and webhook
 * secrets are sealed with the app key (key rotation re-seals them) and never read back to a client.
 */
export class AlertRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly box: SecretBox,
    private readonly now: () => number,
  ) {}

  // Rules.

  listRules(connectionId?: string): RuleRow[] {
    const rows = (connectionId
      ? this.db
          .prepare('SELECT * FROM alert_rules WHERE connection_id = ? ORDER BY created_at')
          .all(connectionId)
      : this.db.prepare('SELECT * FROM alert_rules ORDER BY created_at').all()) as unknown as RuleDb[]
    return rows.map(toRule)
  }

  getRule(id: string): RuleRow | undefined {
    const row = this.db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(id) as RuleDb | undefined
    return row ? toRule(row) : undefined
  }

  createRule(input: AlertRuleInput, createdBy: string | null): RuleRow {
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM alert_rules').get() as { n: number }
    if (n >= MAX_RULES)
      throw Errors.conflict(`At most ${MAX_RULES} alert rules`, { reason: 'too_many_rules' })
    const id = randomUUID()
    const at = this.now()
    this.db
      .prepare(
        `INSERT INTO alert_rules (id, kind, connection_id, metric, event, threshold, slow_op_seconds, sustain,
           enabled, channels, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.kind,
        input.connectionId,
        input.kind === 'metric' ? input.metric : null,
        input.kind === 'event' ? input.event : null,
        input.kind === 'metric' ? input.threshold : null,
        input.kind === 'metric' && input.metric === 'slowOps' ? (input.slowOpSeconds ?? 5) : null,
        input.kind === 'metric' ? input.sustain : 1,
        input.enabled ? 1 : 0,
        JSON.stringify(input.channels),
        createdBy,
        at,
        at,
      )
    return this.getRule(id)!
  }

  patchRule(
    id: string,
    patch: {
      threshold?: number
      slowOpSeconds?: number
      sustain?: number
      enabled?: boolean
      channels?: AlertChannels
    },
  ): RuleRow {
    const rule = this.getRule(id)
    if (!rule) throw Errors.notFound('Alert rule not found')
    const next = {
      threshold: rule.kind === 'metric' ? (patch.threshold ?? rule.threshold) : null,
      slowOpSeconds: rule.metric === 'slowOps' ? (patch.slowOpSeconds ?? rule.slowOpSeconds) : null,
      sustain: rule.kind === 'metric' ? (patch.sustain ?? rule.sustain) : 1,
      enabled: patch.enabled ?? rule.enabled,
      channels: patch.channels ?? rule.channels,
    }
    this.db
      .prepare(
        `UPDATE alert_rules SET threshold = ?, slow_op_seconds = ?, sustain = ?, enabled = ?, channels = ?,
           updated_at = ? WHERE id = ?`,
      )
      .run(
        next.threshold,
        next.slowOpSeconds,
        next.sustain,
        next.enabled ? 1 : 0,
        JSON.stringify(next.channels),
        this.now(),
        id,
      )
    return this.getRule(id)!
  }

  deleteRule(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM alert_rules WHERE id = ?').run(id).changes) > 0
  }

  snooze(id: string, until: number | null): RuleRow {
    if (!this.getRule(id)) throw Errors.notFound('Alert rule not found')
    this.db
      .prepare('UPDATE alert_rules SET snoozed_until = ?, updated_at = ? WHERE id = ?')
      .run(until, this.now(), id)
    return this.getRule(id)!
  }

  /** Connections whose enabled metric rules need samples. */
  metricConnections(): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT connection_id FROM alert_rules
           WHERE kind = 'metric' AND enabled = 1 AND connection_id IS NOT NULL ORDER BY connection_id`,
        )
        .all() as Array<{ connection_id: string }>
    ).map((r) => r.connection_id)
  }

  // Events.

  openFiring(ruleId: string): EventRow | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM alert_events WHERE rule_id = ? AND state = 'firing' ORDER BY started_at DESC LIMIT 1",
      )
      .get(ruleId) as EventDb | undefined
    return row ? toEvent(row) : undefined
  }

  getEvent(id: string): EventRow | undefined {
    const row = this.db.prepare('SELECT * FROM alert_events WHERE id = ?').get(id) as EventDb | undefined
    return row ? toEvent(row) : undefined
  }

  insertEvent(
    e: Omit<EventRow, 'id' | 'deliveries' | 'acknowledgedAt' | 'acknowledgedBy' | 'resolvedAt'>,
  ): EventRow {
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO alert_events (id, rule_id, connection_id, connection_name, metric, event, state, value,
           threshold, started_at, detail, snoozed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        e.ruleId,
        e.connectionId,
        e.connectionName,
        e.metric,
        e.event,
        e.state,
        e.value,
        e.threshold,
        e.startedAt,
        JSON.stringify(e.detail),
        e.snoozed ? 1 : 0,
      )
    return this.getEvent(id)!
  }

  resolve(id: string, value: number | null): EventRow | undefined {
    this.db
      .prepare(
        "UPDATE alert_events SET state = 'resolved', resolved_at = ?, value = COALESCE(?, value) WHERE id = ? AND state = 'firing'",
      )
      .run(this.now(), value, id)
    return this.getEvent(id)
  }

  /** The highest value seen while it fires (what the history shows). */
  raise(id: string, value: number): void {
    this.db
      .prepare("UPDATE alert_events SET value = MAX(COALESCE(value, ?), ?) WHERE id = ? AND state = 'firing'")
      .run(value, value, id)
  }

  addDelivery(id: string, delivery: AlertDelivery): void {
    const row = this.getEvent(id)
    if (!row) return
    const deliveries = [...row.deliveries, delivery].slice(-MAX_DELIVERIES)
    this.db.prepare('UPDATE alert_events SET deliveries = ? WHERE id = ?').run(JSON.stringify(deliveries), id)
  }

  acknowledge(id: string, by: string): EventRow | undefined {
    this.db
      .prepare(
        'UPDATE alert_events SET acknowledged_at = COALESCE(acknowledged_at, ?), acknowledged_by = COALESCE(acknowledged_by, ?) WHERE id = ?',
      )
      .run(this.now(), by, id)
    return this.getEvent(id)
  }

  /** Firing alerts, and events of the last day nobody acknowledged: what the bell may show. */
  active(): EventRow[] {
    const since = this.now() - 86_400_000
    // Review of C7a (M7): what fires is never pushed out by events (a report's runs among them).
    const firing = this.db
      .prepare("SELECT * FROM alert_events WHERE state = 'firing' ORDER BY started_at DESC")
      .all() as unknown as EventDb[]
    const events = this.db
      .prepare(
        `SELECT * FROM alert_events WHERE state = 'event' AND started_at >= ? AND acknowledged_at IS NULL
         ORDER BY started_at DESC LIMIT 500`,
      )
      .all(since) as unknown as EventDb[]
    return [...firing, ...events].map(toEvent)
  }

  /** Design 2026-10-25 (C7): a report's runs beyond its last `keep` leave the history. */
  pruneReport(reportId: string, keep: number): void {
    this.db
      .prepare(
        `DELETE FROM alert_events WHERE event = 'report.ready' AND json_extract(detail, '$.reportId') = ?
           AND id NOT IN (SELECT id FROM alert_events WHERE event = 'report.ready'
             AND json_extract(detail, '$.reportId') = ? ORDER BY started_at DESC LIMIT ?)`,
      )
      .run(reportId, reportId, keep)
  }

  history(q: { connectionId?: string; state?: AlertState; limit: number; before?: number }): EventRow[] {
    const where: string[] = []
    const params: Array<string | number> = []
    if (q.connectionId) {
      where.push('connection_id = ?')
      params.push(q.connectionId)
    }
    if (q.state) {
      where.push('state = ?')
      params.push(q.state)
    }
    if (q.before !== undefined) {
      where.push('started_at < ?')
      params.push(q.before)
    }
    return (
      this.db
        .prepare(
          `SELECT * FROM alert_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY started_at DESC, rowid DESC LIMIT ?`,
        )
        .all(...params, q.limit) as unknown as EventDb[]
    ).map(toEvent)
  }

  /** Firing alerts on a connection (the cards' count). */
  firingCount(connectionId: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM alert_events WHERE connection_id = ? AND state = 'firing'")
        .get(connectionId) as { n: number }
    ).n
  }

  prune(): number {
    const old = Number(
      this.db
        .prepare("DELETE FROM alert_events WHERE state != 'firing' AND started_at < ?")
        .run(this.now() - ALERT_KEEP_MS).changes,
    )
    const extra = Number(
      this.db
        .prepare(
          `DELETE FROM alert_events WHERE state != 'firing' AND id IN (
             SELECT id FROM alert_events ORDER BY started_at DESC LIMIT -1 OFFSET ?)`,
        )
        .run(ALERT_KEEP_ROWS).changes,
    )
    return old + extra
  }

  // Channels.

  private channel(id: string): ChannelDb | undefined {
    return this.db.prepare('SELECT * FROM alert_channels WHERE id = ?').get(id) as ChannelDb | undefined
  }

  private openSecret(row: ChannelDb): string | null {
    if (!row.secret) return null
    return this.box.open(row.secret, alertChannelContext(row.id))
  }

  smtpView(): SmtpSettingsView | null {
    const row = this.channel(SMTP_ID)
    if (!row) return null
    const c = json<Partial<SmtpSettingsView>>(row.config, {})
    return {
      enabled: row.enabled === 1,
      host: String(c.host ?? ''),
      port: Number(c.port ?? 587),
      security: c.security === 'tls' ? 'tls' : 'starttls',
      username: typeof c.username === 'string' && c.username ? c.username : null,
      passwordSet: row.secret !== null,
      from: String(c.from ?? ''),
      recipients: Array.isArray(c.recipients) ? c.recipients.map(String) : [],
    }
  }

  /** The SMTP settings with the password opened, for sending only. */
  smtp(): (SmtpSettingsView & { password: string | null }) | null {
    const view = this.smtpView()
    if (!view) return null
    return { ...view, password: this.openSecret(this.channel(SMTP_ID)!) }
  }

  setSmtp(input: SmtpSettingsInput): SmtpSettingsView {
    const row = this.channel(SMTP_ID)
    const at = this.now()
    const config = JSON.stringify({
      host: input.host,
      port: input.port,
      security: input.security,
      username: input.username ?? null,
      from: input.from,
      recipients: input.recipients,
    })
    // W3 review (I3): the stored password is for the server and account it was typed for. Pointed
    // at another (host, port, security, account), it must be typed again — never handed to a new
    // server by the next AUTH.
    const stored = this.smtpView()
    if (
      row?.secret &&
      input.password === undefined &&
      stored &&
      (stored.host.toLowerCase() !== input.host.toLowerCase() ||
        stored.port !== input.port ||
        stored.security !== input.security ||
        (stored.username ?? '') !== (input.username ?? ''))
    )
      throw Errors.validation('Enter the password again: the server or the account changed', {
        reason: 'password_required',
      })
    const secret =
      input.password === undefined
        ? (row?.secret ?? null)
        : input.password === null || input.password === ''
          ? null
          : this.box.seal(input.password, alertChannelContext(SMTP_ID))
    if (row)
      this.db
        .prepare('UPDATE alert_channels SET config = ?, secret = ?, enabled = ?, updated_at = ? WHERE id = ?')
        .run(config, secret, input.enabled ? 1 : 0, at, SMTP_ID)
    else
      this.db
        .prepare(
          `INSERT INTO alert_channels (id, kind, name, config, secret, enabled, created_at, updated_at)
           VALUES (?, 'smtp', 'E-mail', ?, ?, ?, ?, ?)`,
        )
        .run(SMTP_ID, config, secret, input.enabled ? 1 : 0, at, at)
    return this.smtpView()!
  }

  /** The channel turned off or on, its settings and password kept; null when none is set up. */
  setSmtpEnabled(enabled: boolean): SmtpSettingsView | null {
    const changed = this.db
      .prepare('UPDATE alert_channels SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, this.now(), SMTP_ID)
    return changed.changes === 0 ? null : this.smtpView()
  }

  webhooks(): WebhookRow[] {
    return (
      this.db
        .prepare("SELECT * FROM alert_channels WHERE kind = 'webhook' ORDER BY created_at")
        .all() as unknown as ChannelDb[]
    ).map((r) => ({
      id: r.id,
      name: r.name,
      url: String(json<{ url?: unknown }>(r.config, {}).url ?? ''),
      enabled: r.enabled === 1,
      createdAt: r.created_at,
    }))
  }

  webhook(id: string): WebhookRow | undefined {
    return this.webhooks().find((w) => w.id === id)
  }

  webhookSecret(id: string): string | null {
    const row = this.channel(id)
    return row && row.kind === 'webhook' ? this.openSecret(row) : null
  }

  createWebhook(input: { name: string; url: string; enabled: boolean }): WebhookView {
    if (this.webhooks().length >= MAX_WEBHOOKS)
      throw Errors.conflict(`At most ${MAX_WEBHOOKS} webhooks`, { reason: 'too_many_webhooks' })
    const id = randomUUID()
    const secret = newSecret()
    const at = this.now()
    this.db
      .prepare(
        `INSERT INTO alert_channels (id, kind, name, config, secret, enabled, created_at, updated_at)
         VALUES (?, 'webhook', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        JSON.stringify({ url: input.url }),
        this.box.seal(secret, alertChannelContext(id)),
        input.enabled ? 1 : 0,
        at,
        at,
      )
    return { ...webhookView(this.webhook(id)!), secret }
  }

  patchWebhook(
    id: string,
    patch: { name?: string; url?: string; enabled?: boolean; rotateSecret?: true },
  ): WebhookView {
    const current = this.webhook(id)
    if (!current) throw Errors.notFound('Webhook not found')
    const secret = patch.rotateSecret ? newSecret() : null
    this.db
      .prepare(
        `UPDATE alert_channels SET name = ?, config = ?, enabled = ?, secret = COALESCE(?, secret), updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.name ?? current.name,
        JSON.stringify({ url: patch.url ?? current.url }),
        (patch.enabled ?? current.enabled) ? 1 : 0,
        secret ? this.box.seal(secret, alertChannelContext(id)) : null,
        this.now(),
        id,
      )
    return { ...webhookView(this.webhook(id)!), ...(secret ? { secret } : {}) }
  }

  deleteWebhook(id: string): boolean {
    const gone =
      Number(
        this.db.prepare("DELETE FROM alert_channels WHERE id = ? AND kind = 'webhook'").run(id).changes,
      ) > 0
    if (gone)
      // Rules that named it stop naming it.
      for (const rule of this.listRules())
        if (rule.channels.webhooks.includes(id))
          this.patchRule(rule.id, {
            channels: { ...rule.channels, webhooks: rule.channels.webhooks.filter((w) => w !== id) },
          })
    // Review of C7b (I3): reports that named it stop naming it too.
    if (gone)
      for (const r of this.db.prepare('SELECT id, channels FROM alert_reports').all() as Array<{
        id: string
        channels: string
      }>) {
        let ch: { webhooks?: unknown } | null
        try {
          ch = JSON.parse(r.channels) as { webhooks?: unknown } | null
        } catch {
          continue
        }
        if (!ch || !Array.isArray(ch.webhooks) || !ch.webhooks.includes(id)) continue
        this.db
          .prepare('UPDATE alert_reports SET channels = ? WHERE id = ?')
          .run(JSON.stringify({ ...ch, webhooks: ch.webhooks.filter((w) => w !== id) }), r.id)
      }
    return gone
  }
}

export function webhookView(w: WebhookRow): WebhookView {
  return {
    id: w.id,
    name: w.name,
    url: w.url,
    enabled: w.enabled,
    createdAt: new Date(w.createdAt).toISOString(),
  }
}

export function ruleView(rule: RuleRow, firing: EventRow | undefined): AlertRuleView {
  return {
    id: rule.id,
    kind: rule.kind,
    connectionId: rule.connectionId,
    metric: rule.metric,
    event: rule.event,
    threshold: rule.threshold,
    slowOpSeconds: rule.slowOpSeconds,
    sustain: rule.sustain,
    enabled: rule.enabled,
    channels: rule.channels,
    snoozedUntil: iso(rule.snoozedUntil),
    firing: firing ? { since: iso(firing.startedAt)!, value: firing.value ?? 0 } : null,
  }
}
