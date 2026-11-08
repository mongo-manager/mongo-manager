// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { z } from 'zod'
import { NEXT_ACTION_LIMITS } from './nextActions'
import { CollectionNameSchema, DatabaseNameSchema } from '../schemas'

/**
 * User review 2026-10-09 ("Genel bakış sayfasını yeniden tasarla … widget gibi ekle, kaldır, yerlerini
 * değiştir"): the Overview as a dashboard of widgets, saved for each user. Strict on write (every type,
 * size and setting known), lenient on read (a widget this version cannot read is left out, the rest
 * kept).
 */
export const DASHBOARD_LIMITS = { widgets: 30 } as const
/** 3, 6, 9 and 12 of the grid's 12 columns. */
export const WIDGET_SIZES = ['s', 'm', 'l', 'xl'] as const
export type WidgetSize = (typeof WIDGET_SIZES)[number]
/** Today's Overview modules. */
export const WORKSPACE_WIDGETS = [
  'continue',
  'pinned',
  'attention',
  'connections',
  'queries',
  'activity',
  'quick',
] as const
/** MongoDB widgets about one connection's server. */
export const CONNECTION_WIDGETS = [
  'serverStatus',
  'replica',
  'operations',
  'topCollections',
  'databaseSizes',
  // Widgets wave 2 (2026-10-27).
  'slowQueries',
  'replication',
  'shardBalance',
  'collectionLatency',
  'serverFacts',
] as const
export const WIDGET_TYPES = [
  ...WORKSPACE_WIDGETS,
  'metric',
  ...CONNECTION_WIDGETS,
  'appStatus',
  'aiUsage',
  // completion W6.2: the next steps.
  'nextActions',
  // Widgets wave 2 (2026-10-27): the alerts firing now; one database's index health.
  'alerts',
  'indexHealth',
  'dataKpi',
] as const
/** Widgets wave 2: how a data KPI shows its pipeline's answer, and how often it runs it again. */
export const KPI_DISPLAYS = ['number', 'bars'] as const
export const KPI_REFRESHES = ['manual', '5m', '15m', '1h'] as const
export type KpiRefresh = (typeof KPI_REFRESHES)[number]
export type WidgetType = (typeof WIDGET_TYPES)[number]
export const METRICS = [
  'opcounters',
  'network',
  'connections',
  'memory',
  'cache',
  'queues',
  // Widgets wave 2 (2026-10-27): Atlas, PMM and Datadog's query targeting, latency, cursors,
  // transactions and errors.
  'queryTargeting',
  'latency',
  'cursors',
  'transactions',
  'errors',
] as const
export type Metric = (typeof METRICS)[number]
export const RANGES = ['live', '1h', '24h', '7d'] as const
export type Range = (typeof RANGES)[number]

const base = {
  id: z.uuid(),
  size: z.enum(WIDGET_SIZES),
  collapsed: z.boolean().optional(),
  /**
   * User review 2026-10-09 ("widgetlar arası boşlukta"): the column (1–12) it starts at on the wide
   * grid, leaving the space before it empty; none: it follows the one before it.
   */
  col: z.number().int().min(1).max(12).optional(),
}
/**
 * The widget schemas: strict for what is saved, stripping for what is read — a field a newer version
 * added is left out, not the whole widget (final review 13).
 */
function widgetSchema(strict: boolean) {
  const obj = (strict ? z.strictObject : z.object) as typeof z.strictObject
  const none = obj({})
  const onConnection = obj({ connectionId: z.uuid() })
  const plain = <T extends string>(type: T) => obj({ ...base, type: z.literal(type), settings: none })
  const ofConnection = <T extends string>(type: T) =>
    obj({ ...base, type: z.literal(type), settings: onConnection })
  return z.discriminatedUnion('type', [
    plain('continue'),
    plain('pinned'),
    plain('attention'),
    plain('connections'),
    obj({
      ...base,
      type: z.literal('queries'),
      settings: obj({
        connectionId: z.uuid().optional(),
        view: z.enum(['recent', 'saved']).optional(),
      }),
    }),
    plain('activity'),
    plain('quick'),
    obj({
      ...base,
      type: z.literal('metric'),
      settings: obj({ connectionId: z.uuid(), metric: z.enum(METRICS), range: z.enum(RANGES) }),
    }),
    ofConnection('serverStatus'),
    ofConnection('replica'),
    ofConnection('operations'),
    ofConnection('topCollections'),
    ofConnection('databaseSizes'),
    ofConnection('slowQueries'),
    ofConnection('replication'),
    ofConnection('shardBalance'),
    ofConnection('collectionLatency'),
    ofConnection('serverFacts'),
    plain('alerts'),
    obj({
      ...base,
      type: z.literal('indexHealth'),
      settings: obj({ connectionId: z.uuid(), db: DatabaseNameSchema }),
    }),
    obj({
      ...base,
      type: z.literal('dataKpi'),
      settings: obj({
        connectionId: z.uuid(),
        db: DatabaseNameSchema,
        coll: CollectionNameSchema,
        pipelineId: z.uuid(),
        display: z.enum(KPI_DISPLAYS),
        refresh: z.enum(KPI_REFRESHES),
      }),
    }),
    plain('appStatus'),
    plain('aiUsage'),
    // W6.2: whether the AI puts them in order (asked for by the user), and the ones dismissed.
    obj({
      ...base,
      type: z.literal('nextActions'),
      settings: obj({
        ai: z.boolean().optional(),
        // Review I2: read leniently — an entry past the limits is dropped, never the whole widget.
        dismissed: (strict
          ? z.array(z.string().min(1).max(NEXT_ACTION_LIMITS.idChars)).max(NEXT_ACTION_LIMITS.dismissed)
          : z
              .array(z.unknown())
              .max(10_000)
              .transform((list) =>
                list
                  .filter(
                    (d): d is string =>
                      typeof d === 'string' && d.length > 0 && d.length <= NEXT_ACTION_LIMITS.idChars,
                  )
                  .slice(-NEXT_ACTION_LIMITS.dismissed),
              )
        ).optional(),
      }),
    }),
  ])
}
export const WidgetSchema = widgetSchema(true)
const WidgetReadSchema = widgetSchema(false)
export type Widget = z.infer<typeof WidgetSchema>
export type WidgetSettings<T extends WidgetType> = Extract<Widget, { type: T }>['settings']

/**
 * User report 2026-10-27 ("aynı sunucu durumu Demo ekleyebiliyorum saçma olmuş"): what a widget shows,
 * so that it is on the dashboard once — one of a kind; a server's kind once per server; a metric chart
 * once per server, metric and range. Its place, size and id play no part.
 */
export function widgetKey(widget: { type: string; settings?: object }): string {
  const settings = (widget.settings ?? {}) as {
    connectionId?: unknown
    metric?: unknown
    range?: unknown
    db?: unknown
    coll?: unknown
    pipelineId?: unknown
    display?: unknown
  }
  // How often it runs plays no part: the same answer, shown the same way.
  if (widget.type === 'dataKpi')
    return JSON.stringify([
      widget.type,
      settings.connectionId,
      settings.db,
      settings.coll,
      settings.pipelineId,
      settings.display,
    ])
  if (widget.type === 'indexHealth') return JSON.stringify([widget.type, settings.connectionId, settings.db])
  if (widget.type === 'metric')
    return JSON.stringify([widget.type, settings.connectionId, settings.metric, settings.range])
  if ((CONNECTION_WIDGETS as readonly string[]).includes(widget.type))
    return JSON.stringify([widget.type, settings.connectionId])
  return JSON.stringify([widget.type])
}

export const DashboardSchema = z
  .strictObject({
    version: z.literal(1),
    widgets: z.array(WidgetSchema).max(DASHBOARD_LIMITS.widgets),
  })
  .refine((d) => new Set(d.widgets.map((w) => w.id)).size === d.widgets.length, {
    message: 'Widget ids must be unique',
  })
  .refine((d) => new Set(d.widgets.map(widgetKey)).size === d.widgets.length, {
    message: 'A widget is on the dashboard once',
  })
export type Dashboard = z.infer<typeof DashboardSchema>

/** Today's Overview, as widgets — fresh ids each time it is made. */
export function defaultDashboard(newId: () => string): Dashboard {
  // Today's modules have no settings of their own (the queries widget's are optional).
  const widget = (type: (typeof WORKSPACE_WIDGETS)[number] | 'nextActions', size: WidgetSize) =>
    WidgetSchema.parse({ id: newId(), type, size, settings: {} })
  return {
    version: 1,
    widgets: [
      widget('continue', 'm'),
      widget('pinned', 'm'),
      widget('attention', 'xl'),
      widget('connections', 'xl'),
      widget('queries', 'm'),
      widget('activity', 'm'),
      widget('quick', 'm'),
      // W6.2: beside Quick links, worked out without AI unless the user asks for it.
      widget('nextActions', 'm'),
    ],
  }
}

/** A layout saved by a newer version of the app: not readable here, and not to be overwritten. */
export function isNewerDashboard(value: unknown): boolean {
  const version = (value as { version?: unknown } | null)?.version
  return typeof version === 'number' && version > 1
}

/**
 * A stored layout, read leniently: widgets this version cannot read, repeated ids and the same widget
 * again (saved before it was refused, 2026-10-27: the first is kept) are left out.
 */
export function readDashboard(value: unknown): Dashboard | null {
  if (!value || typeof value !== 'object') return null
  const stored = value as { version?: unknown; widgets?: unknown }
  if (stored.version !== 1 || !Array.isArray(stored.widgets)) return null
  const seen = new Set<string>()
  const shown = new Set<string>()
  const widgets: Widget[] = []
  for (const candidate of stored.widgets) {
    const read = WidgetReadSchema.safeParse(candidate)
    if (!read.success || seen.has(read.data.id) || shown.has(widgetKey(read.data))) continue
    seen.add(read.data.id)
    shown.add(widgetKey(read.data))
    widgets.push(read.data)
    if (widgets.length === DASHBOARD_LIMITS.widgets) break
  }
  return { version: 1, widgets }
}
