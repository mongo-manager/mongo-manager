// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Component } from 'vue'
import {
  Activity,
  AlertTriangle,
  BellRing,
  ChartBar,
  Cpu,
  Gauge,
  Hourglass,
  Layers,
  ListTree,
  Snail,
  Bot,
  ChartColumn,
  ChartLine,
  Clock,
  HardDrive,
  Lightbulb,
  ListChecks,
  MonitorCog,
  Network,
  Pin,
  Server,
  Sparkles,
  TerminalSquare,
  Timer,
} from 'lucide-vue-next'
import type { Widget, WidgetSize, WidgetType } from '@mongo-manager/shared/browser'
import PlacesModule from '../PlacesModule.vue'
import AttentionModule from '../AttentionModule.vue'
import QueriesModule from '../QueriesModule.vue'
import ActivityModule from '../ActivityModule.vue'
import ConnectionsWidget from './ConnectionsWidget.vue'
import QuickWidget from './QuickWidget.vue'
import ConnectionWidget from './ConnectionWidget.vue'
import ServerStatusBody from './ServerStatusBody.vue'
import MetricBody from './MetricBody.vue'
import ReplicaBody from './ReplicaBody.vue'
import OperationsBody from './OperationsBody.vue'
import TopCollectionsBody from './TopCollectionsBody.vue'
import DatabaseSizesBody from './DatabaseSizesBody.vue'
import AppStatusWidget from './AppStatusWidget.vue'
import AiUsageWidget from './AiUsageWidget.vue'
import NextActionsWidget from './NextActionsWidget.vue'
import SlowQueriesBody from './SlowQueriesBody.vue'
import AlertsWidget from './AlertsWidget.vue'
import IndexHealthBody from './IndexHealthBody.vue'
import ShardBalanceBody from './ShardBalanceBody.vue'
import ReplicationBody from './ReplicationBody.vue'
import CollectionLatencyBody from './CollectionLatencyBody.vue'
import ServerFactsBody from './ServerFactsBody.vue'
import DataKpiBody from './DataKpiBody.vue'

export type WidgetGroup = 'workspace' | 'mongodb' | 'app' | 'ai'

/** What the dashboard knows of a kind of widget. */
export interface WidgetDef {
  type: WidgetType
  group: WidgetGroup
  icon: Component
  /** i18n keys. */
  title: string
  description: string
  /** Its width when added. */
  size: WidgetSize
  component: Component
  /** The component's props for a widget of this kind. */
  props?: (widget: Widget) => Record<string, unknown>
  /** Settings asked when added (and changed later); `database`: a server and one of its databases. */
  settings: 'none' | 'connection' | 'metric' | 'database' | 'pipeline'
  /** More than one may be on the dashboard. */
  many: boolean
  /** What the user needs on the widget's connection (MongoDB widgets). */
  permission?: 'server:monitor' | 'databases:read' | 'aggregation:run'
}

const workspace = (
  type: WidgetType,
  icon: Component,
  title: string,
  size: WidgetSize,
  component: Component,
  props?: WidgetDef['props'],
): WidgetDef => ({
  type,
  group: 'workspace',
  icon,
  title,
  description: `overview.widgets.${type}.description`,
  size,
  component,
  ...(props ? { props } : {}),
  settings: 'none',
  many: false,
})

/** A MongoDB widget about one connection's server (or its databases). */
const onServer = (
  type: WidgetType,
  icon: Component,
  size: WidgetSize,
  body: Component,
  permission: WidgetDef['permission'] = 'server:monitor',
): WidgetDef => ({
  type,
  group: 'mongodb',
  icon,
  title: `overview.widgets.${type}.title`,
  description: `overview.widgets.${type}.description`,
  size,
  component: ConnectionWidget,
  props: () => ({ titleKey: `overview.widgets.${type}.title`, body, permission }),
  settings: 'connection',
  many: true,
  permission,
})

/** User review 2026-10-09: the widgets the Overview offers. */
export const WIDGETS: Partial<Record<WidgetType, WidgetDef>> = {
  continue: workspace('continue', Clock, 'home.continue', 'm', PlacesModule, () => ({ kind: 'continue' })),
  pinned: workspace('pinned', Pin, 'layout.pinned', 'm', PlacesModule, () => ({ kind: 'pinned' })),
  attention: workspace('attention', AlertTriangle, 'layout.needsAttention', 'xl', AttentionModule),
  connections: workspace('connections', Server, 'home.connections', 'xl', ConnectionsWidget),
  queries: workspace('queries', TerminalSquare, 'home.queries', 'm', QueriesModule),
  activity: workspace('activity', ListChecks, 'layout.activity', 'm', ActivityModule),
  quick: workspace('quick', Sparkles, 'home.actions', 'm', QuickWidget),
  // User review 2026-10-09 ("Mongo durumu, sunucu durumu … grafiksel"): one server each.
  serverStatus: {
    type: 'serverStatus',
    group: 'mongodb',
    icon: Activity,
    title: 'overview.widgets.serverStatus.title',
    description: 'overview.widgets.serverStatus.description',
    size: 'm',
    component: ConnectionWidget,
    props: () => ({ titleKey: 'overview.widgets.serverStatus.title', body: ServerStatusBody }),
    settings: 'connection',
    many: true,
    permission: 'server:monitor',
  },
  metric: {
    type: 'metric',
    group: 'mongodb',
    icon: ChartLine,
    title: 'overview.widgets.metric.title',
    description: 'overview.widgets.metric.description',
    size: 'l',
    component: ConnectionWidget,
    props: (w) => ({
      titleKey: `overview.metrics.names.${(w.settings as { metric: string }).metric}`,
      body: MetricBody,
    }),
    settings: 'metric',
    many: true,
    permission: 'server:monitor',
  },
  replica: onServer('replica', Network, 'm', ReplicaBody),
  operations: onServer('operations', Timer, 'm', OperationsBody),
  topCollections: onServer('topCollections', ChartColumn, 'm', TopCollectionsBody),
  databaseSizes: onServer('databaseSizes', HardDrive, 'm', DatabaseSizesBody, 'databases:read'),
  // Widgets wave 2 (2026-10-27): from the research of that day (Atlas, PMM, Datadog).
  slowQueries: onServer('slowQueries', Snail, 'm', SlowQueriesBody),
  replication: onServer('replication', Gauge, 'm', ReplicationBody),
  shardBalance: onServer('shardBalance', Layers, 'm', ShardBalanceBody),
  collectionLatency: onServer('collectionLatency', Hourglass, 'm', CollectionLatencyBody),
  serverFacts: onServer('serverFacts', Cpu, 'm', ServerFactsBody),
  // A number or bars from a saved pipeline (Atlas Charts), run where the user may run aggregations.
  dataKpi: {
    ...onServer('dataKpi', ChartBar, 'm', DataKpiBody, 'aggregation:run'),
    settings: 'pipeline',
  },
  indexHealth: {
    ...onServer('indexHealth', ListTree, 'm', IndexHealthBody),
    settings: 'database',
  },
  // User review 2026-10-09: Mongo Manager's own work, and the AI's use.
  appStatus: {
    type: 'appStatus',
    group: 'app',
    icon: MonitorCog,
    title: 'overview.widgets.appStatus.title',
    description: 'overview.widgets.appStatus.description',
    size: 'm',
    component: AppStatusWidget,
    settings: 'none',
    many: false,
  },
  aiUsage: {
    type: 'aiUsage',
    group: 'ai',
    icon: Bot,
    title: 'overview.widgets.aiUsage.title',
    description: 'overview.widgets.aiUsage.description',
    size: 'm',
    component: AiUsageWidget,
    settings: 'none',
    many: false,
  },
  // Widgets wave 2: the alerts firing now, as the bell shows them.
  alerts: {
    type: 'alerts',
    group: 'app',
    icon: BellRing,
    title: 'overview.widgets.alerts.title',
    description: 'overview.widgets.alerts.description',
    size: 'm',
    component: AlertsWidget,
    settings: 'none',
    many: false,
  },
  // completion W6.2: the next steps (its own menu turns the AI's order on and off).
  nextActions: {
    type: 'nextActions',
    group: 'ai',
    icon: Lightbulb,
    title: 'overview.widgets.nextActions.title',
    description: 'overview.widgets.nextActions.description',
    size: 'm',
    component: NextActionsWidget,
    props: (w) => ({ widget: w }),
    settings: 'none',
    many: false,
  },
}

export const WIDGET_GROUPS: WidgetGroup[] = ['workspace', 'mongodb', 'app', 'ai']
