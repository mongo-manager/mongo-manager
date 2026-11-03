import { z } from 'zod'
import { CollectionNameSchema, DatabaseNameSchema } from '../schemas'
import { CadenceSchema, TimeZoneSchema, type Cadence } from './schedules'

/**
 * W3 (completion §2 W3.3–W3.4): alerts on a connection's server metrics and on the app's own
 * events, sent in the app (the bell), by e-mail and to webhooks; and each connection's live health.
 */

/** What a metric rule watches; each is read from the monitoring the server already does. */
export const ALERT_METRICS = [
  /** Open client connections on the server. */
  'connections',
  /** Operations per second, all kinds together. */
  'opcounters',
  /** The most a secondary is behind its primary, in seconds (replica sets). */
  'replicationLag',
  /** WiredTiger cache in use, percent of its configured size. */
  'cacheFill',
  /** The data files' disk in use, percent (MongoDB 4.4+ dbStats). */
  'diskUse',
  /** Operations running longer than the rule's seconds. */
  'slowOps',
] as const
export type AlertMetric = (typeof ALERT_METRICS)[number]

export const ALERT_EVENTS = [
  'backup.failed',
  'schedule.failed',
  'liveSync.stopped',
  'job.failed',
  /** W4 review I4: from the app events (docs/app-events.md). */
  'backup.drillFailed',
  'liveSync.conflicts',
  'watch.matched',
  /** Design 2026-10-25 (C7): a scheduled report ran (its counts in the detail). */
  'report.ready',
] as const
export type AlertEvent = (typeof ALERT_EVENTS)[number]
/** C7: the events a rule may take (a report's run goes through its own report's channels). */
export type RuleEvent = Exclude<AlertEvent, 'report.ready'>
export const RULE_EVENTS = ALERT_EVENTS.filter((e): e is RuleEvent => e !== 'report.ready')

/** How each metric is measured (shown next to thresholds). */
export const ALERT_UNITS: Record<AlertMetric, 'count' | 'perSecond' | 'seconds' | 'percent'> = {
  connections: 'count',
  opcounters: 'perSecond',
  replicationLag: 'seconds',
  cacheFill: 'percent',
  diskUse: 'percent',
  slowOps: 'count',
}

/**
 * Hysteresis: a firing alert resolves only once its value is this far below the threshold (a
 * value hovering at the line does not fire and resolve every minute).
 */
export const ALERT_CLEAR_RATIO = 0.9

const Id = z.string().min(1).max(64)

export const AlertChannelsSchema = z.strictObject({
  inApp: z.boolean().default(true),
  email: z.boolean().default(false),
  webhooks: z.array(Id).max(10).default([]),
})
export type AlertChannels = z.infer<typeof AlertChannelsSchema>

export const AlertRuleInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('metric'),
    connectionId: Id,
    metric: z.enum(ALERT_METRICS),
    threshold: z.number().min(0).max(1e12),
    /** slowOps: an operation counts once it has run this long. */
    slowOpSeconds: z.number().int().min(1).max(86_400).optional(),
    /** Samples (one a minute) the value must stay above the threshold before it fires. */
    sustain: z.number().int().min(1).max(60).default(2),
    enabled: z.boolean().default(true),
    channels: AlertChannelsSchema.prefault({}),
  }),
  z.strictObject({
    kind: z.literal('event'),
    /** null: every connection. */
    connectionId: Id.nullable().default(null),
    event: z.enum(
      RULE_EVENTS as [Exclude<AlertEvent, 'report.ready'>, ...Exclude<AlertEvent, 'report.ready'>[]],
    ),
    enabled: z.boolean().default(true),
    channels: AlertChannelsSchema.prefault({}),
  }),
])
export type AlertRuleInput = z.infer<typeof AlertRuleInputSchema>

export const AlertRulePatchSchema = z
  .strictObject({
    threshold: z.number().min(0).max(1e12).optional(),
    slowOpSeconds: z.number().int().min(1).max(86_400).optional(),
    sustain: z.number().int().min(1).max(60).optional(),
    enabled: z.boolean().optional(),
    channels: AlertChannelsSchema.optional(),
  })
  .refine((p) => Object.keys(p).length > 0, { message: 'Nothing to change' })

/** Snooze: no notifications until then (alerts still recorded); null wakes it. */
export const AlertSnoozeSchema = z.strictObject({
  minutes: z
    .number()
    .int()
    .min(1)
    .max(30 * 24 * 60)
    .nullable(),
})

export interface AlertRuleView {
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
  snoozedUntil: string | null
  /** A metric rule's state now: firing (with when it started) or quiet. */
  firing: { since: string; value: number } | null
}

export type AlertState = 'firing' | 'resolved' | 'event'

export interface AlertDelivery {
  channel: 'email' | 'webhook'
  /** A webhook's name. */
  target: string | null
  ok: boolean
  at: string
  attempts: number
  /** A short reason code or text, never a secret. */
  error: string | null
}

export interface AlertView {
  id: string
  ruleId: string | null
  connectionId: string | null
  connectionName: string | null
  metric: AlertMetric | null
  event: AlertEvent | null
  state: AlertState
  value: number | null
  threshold: number | null
  startedAt: string
  resolvedAt: string | null
  acknowledgedAt: string | null
  acknowledgedBy: string | null
  /** Names only (a job's kind, a namespace, a schedule's name): never values or error text. */
  detail: Record<string, string | number | boolean | null>
  deliveries: AlertDelivery[]
  snoozed: boolean
}

/**
 * Design 2026-10-25 (C7): a scheduled report — a few counts of one connection on a cadence, said
 * through the alert channels, numbers only. A label names each count (in the bell, mail and webhooks).
 */
export const MAX_REPORT_MEASURES = 10
const RESERVED_LABELS = new Set(['report', 'reportId'])
export const ReportMeasureSchema = z.strictObject({
  label: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .refine((l) => !RESERVED_LABELS.has(l), 'That label is the report’s own'),
  db: DatabaseNameSchema,
  coll: CollectionNameSchema,
  /** A filter as canonical Extended JSON; none counts every document (the collection's estimate). */
  filter: z.record(z.string(), z.unknown()).optional(),
})
export type ReportMeasure = z.infer<typeof ReportMeasureSchema>
const Measures = z
  .array(ReportMeasureSchema)
  .min(1)
  .max(MAX_REPORT_MEASURES)
  .refine((ms) => new Set(ms.map((m) => m.label)).size === ms.length, 'Each count has its own label')
export const ReportInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  connectionId: Id,
  measures: Measures,
  cadence: CadenceSchema,
  timeZone: TimeZoneSchema,
  enabled: z.boolean().default(true),
  channels: AlertChannelsSchema.prefault({}),
})
export type ReportInput = z.infer<typeof ReportInputSchema>
export const ReportPatchSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(80).optional(),
    measures: Measures.optional(),
    cadence: CadenceSchema.optional(),
    timeZone: TimeZoneSchema.optional(),
    enabled: z.boolean().optional(),
    channels: AlertChannelsSchema.optional(),
  })
  .refine((p) => Object.keys(p).length > 0, { message: 'Nothing to change' })
export type ReportPatch = z.infer<typeof ReportPatchSchema>
/** A count of a run: none (and why, a code) where it could not be counted; "at least" past its bound. */
export interface ReportValue {
  label: string
  count: number | null
  atLeast?: true
  reason?: string
}
export interface ReportView {
  id: string
  connectionId: string
  name: string
  measures: ReportMeasure[]
  cadence: Cadence
  timeZone: string
  enabled: boolean
  channels: AlertChannels
  nextRunAt: number | null
  lastRun: { at: number; values: ReportValue[] } | null
  createdAt: number
}

export const AlertHistoryQuerySchema = z.strictObject({
  connectionId: Id.optional(),
  state: z.enum(['firing', 'resolved', 'event']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.coerce.number().int().min(0).optional(),
})

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
/** An address in a mail header: one plain address, nothing that could start another header. */
export const EmailAddressSchema = z
  .string()
  .max(254)
  .regex(/^[^\s@<>()",;:\\[\]]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/, 'Not an e-mail address')

export const SMTP_SECURITY = ['starttls', 'tls'] as const

/** The SMTP channel; the password is write-only (sealed at rest, never sent back). */
export const SmtpSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  host: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[A-Za-z0-9.-]+$|^\[[0-9A-Fa-f:.]+\]$/, 'Not a host name'),
  port: z.number().int().min(1).max(65535),
  /** TLS from the start (465), or STARTTLS (587, 25); a server that offers neither is refused. */
  security: z.enum(SMTP_SECURITY),
  username: z
    .string()
    .max(256)
    .refine((v) => !CONTROL.test(v), 'Control characters are not allowed')
    .optional(),
  /** Omitted: keep the stored one; null: remove it. */
  password: z.string().max(1024).nullable().optional(),
  from: EmailAddressSchema,
  recipients: z.array(EmailAddressSchema).min(1).max(20),
})
export type SmtpSettingsInput = z.infer<typeof SmtpSettingsSchema>
/** User report 2026-10-30: the channel's switch alone, the saved settings kept as they are. */
export const SmtpEnabledSchema = z.strictObject({ enabled: z.boolean() })

export interface SmtpSettingsView {
  enabled: boolean
  host: string
  port: number
  security: (typeof SMTP_SECURITY)[number]
  username: string | null
  passwordSet: boolean
  from: string
  recipients: string[]
}

export const WebhookInputSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(80)
    .refine((v) => !CONTROL.test(v), 'Control characters are not allowed'),
  url: z.string().min(8).max(2048).url(),
  enabled: z.boolean().default(true),
})
export const WebhookPatchSchema = z
  .strictObject({
    name: z
      .string()
      .min(1)
      .max(80)
      .refine((v) => !CONTROL.test(v), 'Control characters are not allowed')
      .optional(),
    url: z.string().min(8).max(2048).url().optional(),
    enabled: z.boolean().optional(),
    /** Make a new signing secret (shown once). */
    rotateSecret: z.literal(true).optional(),
  })
  .refine((p) => Object.keys(p).length > 0, { message: 'Nothing to change' })

export interface WebhookView {
  id: string
  name: string
  url: string
  enabled: boolean
  createdAt: string
  /** Only in the answer that made it: the HMAC-SHA256 signing secret, shown once. */
  secret?: string
}

export interface AlertChannelsView {
  email: SmtpSettingsView | null
  webhooks: WebhookView[]
}

/** Per-user: whether the bell shows alerts to this user (off until they turn it on). */
export const AlertOptInSchema = z.strictObject({ inApp: z.boolean() })

/** W3.4: a connection's live health, cheap and cached by the server. */
export interface ConnectionHealth {
  connectionId: string
  /** idle: no client open and none was asked for (the list never connects on its own). */
  /** per_person: a per-person OIDC connection in team mode — each person signs in (W7). */
  state: 'ok' | 'down' | 'idle' | 'per_person'
  latencyMs: number | null
  version: string | null
  topology: 'standalone' | 'replicaSet' | 'sharded' | 'loadBalanced' | null
  /** Alerts firing now on this connection (counted for users who may see them). */
  alertsFiring: number
  checkedAt: string | null
}
