<script setup lang="ts">
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { RotateCw } from 'lucide-vue-next'
import LineChart from '@/charts/LineChart.vue'
import BarChart from '@/charts/BarChart.vue'
import { serverApi, serverKeys, type HistoryRange } from '@/api/server'
import { describeError } from '@/api/errors'
import { formatBytes } from '@/format'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsCard from '@/ds/DsCard.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import StatGrid from '@/workspace/tabs/StatGrid.vue'
import { useMonitor } from './useMonitor'
import OperationsTable from './OperationsTable.vue'
import ReplicaSetPanel from './ReplicaSetPanel.vue'
import ProfilerPanel from './ProfilerPanel.vue'
import SlowQueriesPanel from './SlowQueriesPanel.vue'
import IndexAdvicePanel from './IndexAdvicePanel.vue'
import { historySeries } from './historySeries'

/**
 * A Compass-like Performance view of the server behind a connection (phase 1i spec §7). UI redesign
 * R3 §4: one card of figures, then each part of the page as a card; its time span is chosen in the
 * connection header (HistoryControls), so the span arrives here as `range`.
 */
const props = withDefaults(
  defineProps<{
    connectionId: string
    canOperate: boolean
    /** Phase 3b: nothing is changed on a read-only connection (the profiler included). */
    readOnly?: boolean
    /** Phase 3b: personal values are hidden from this user (no "Open in Explain"). */
    restricted?: boolean
    /** Phase 3b §6a: may build indexes here (indexes:write, not read-only): "Create index" is offered. */
    canCreateIndexes?: boolean
    /** Phase 3b §6: live (the last 5 minutes) or a stored range of the metric history. */
    range?: 'live' | HistoryRange
  }>(),
  { readOnly: false, restricted: false, canCreateIndexes: false, range: 'live' },
)
const { t, locale } = useI18n()
const { samples, error } = useMonitor(props.connectionId)
const nowId = useId()

const OPS = ['insert', 'query', 'update', 'delete', 'getmore', 'command'] as const
const mb = 1024 ** 2

const history = useQuery({
  queryKey: computed(() =>
    serverKeys.history(props.connectionId, props.range === 'live' ? '1h' : props.range),
  ),
  queryFn: () => serverApi.history(props.connectionId, props.range as HistoryRange),
  enabled: computed(() => props.range !== 'live'),
  refetchInterval: 60_000,
})
// The same answer the header's controls read (one request): says why a stored span is empty.
const historySettings = useQuery({
  queryKey: serverKeys.historySettings(props.connectionId),
  queryFn: () => serverApi.historySettings(props.connectionId),
  refetchInterval: 60_000,
  retry: false,
})
const stored = computed(() => {
  const answer = history.data.value
  if (props.range === 'live' || !answer) return null
  return historySeries({ ...answer, from: Date.parse(answer.from), to: Date.parse(answer.to) })
})
/** A stored span with nothing in it: not recorded, or nothing recorded yet. */
const historyNote = computed(() => {
  if (props.range === 'live') return null
  const settings = historySettings.data.value
  if (settings && !settings.enabled) return props.canOperate ? t('history.offAdmin') : t('history.off')
  if (history.data.value && history.data.value.points.length === 0) return t('history.empty')
  return null
})
const named = (series: Array<{ name: string; points: Array<number | null> }>) =>
  series.map((s) => ({ ...s, name: t(`performance.series.${s.name}`) }))

// Rates need a previous reading: a baseline sample (the first, or after a restart) has none.
const rated = computed(() => samples.value.filter((s) => !s.baseline))
const opsSeries = computed(
  () => stored.value?.ops ?? OPS.map((op) => ({ name: op, points: rated.value.map((s) => s.ops[op]) })),
)
const connectionSeries = computed(() =>
  stored.value
    ? named(stored.value.connections)
    : [{ name: t('performance.series.current'), points: samples.value.map((s) => s.connections.current) }],
)
const networkSeries = computed(() =>
  stored.value
    ? named(stored.value.network)
    : [
        { name: t('performance.series.in'), points: rated.value.map((s) => s.network.inPerSec) },
        { name: t('performance.series.out'), points: rated.value.map((s) => s.network.outPerSec) },
      ],
)
const memorySeries = computed(() =>
  stored.value
    ? named(stored.value.memory)
    : [
        { name: t('performance.series.resident'), points: samples.value.map((s) => s.memory.residentMb) },
        { name: t('performance.series.virtual'), points: samples.value.map((s) => s.memory.virtualMb) },
        {
          name: t('performance.series.cache'),
          points: samples.value.map((s) => (s.cache?.usedBytes ?? 0) / mb),
        },
      ],
)
const latest = computed(() => samples.value[samples.value.length - 1] ?? null)
const latestRated = computed(() => rated.value[rated.value.length - 1] ?? null)

const perSecond = (v: number) => t('performance.perSecond', { value: formatBytes(v, locale.value) })
const megabytes = (v: number) => `${Math.round(v)} MB`
const rate = (v: number) => String(Math.round(v * 10) / 10)
const NONE = '—'

/**
 * The latest reading as one card of figures. Not a live region: it changes every few seconds, and a
 * screen reader reads it when asked (UI redesign R3: refreshing figures are not announced).
 */
const figures = computed(() => {
  const s = latest.value
  const r = latestRated.value
  const cache = s?.cache
  const opsTotal = r ? OPS.reduce((sum, op) => sum + r.ops[op], 0) : null
  return [
    { label: t('performance.figures.connections'), value: s ? String(s.connections.current) : NONE },
    { label: t('performance.figures.ops'), value: opsTotal === null ? NONE : rate(opsTotal) },
    {
      label: t('performance.figures.queued'),
      value: s
        ? t('performance.figures.queuedValue', { readers: s.queues.readers, writers: s.queues.writers })
        : NONE,
    },
    { label: t('performance.figures.networkIn'), value: r ? perSecond(r.network.inPerSec) : NONE },
    { label: t('performance.figures.networkOut'), value: r ? perSecond(r.network.outPerSec) : NONE },
    { label: t('performance.figures.resident'), value: s ? megabytes(s.memory.residentMb) : NONE },
    ...(cache
      ? [
          {
            label: t('performance.figures.cache'),
            value: formatBytes(cache.usedBytes, locale.value),
            ...(cache.maxBytes > 0
              ? {
                  bar: {
                    value: cache.usedBytes / cache.maxBytes,
                    label: t('performance.figures.cacheFill'),
                    meter: true,
                    valueText: t('performance.figures.cacheOf', {
                      used: formatBytes(cache.usedBytes, locale.value),
                      max: formatBytes(cache.maxBytes, locale.value),
                    }),
                    tone:
                      cache.usedBytes / cache.maxBytes > 0.95 ? ('warning' as const) : ('accent' as const),
                  },
                }
              : {}),
          },
        ]
      : []),
  ]
})

const top = useQuery({
  queryKey: serverKeys.top(props.connectionId),
  queryFn: () => serverApi.top(props.connectionId),
  refetchInterval: 10_000,
  retry: false,
})
const topItems = computed(() =>
  (top.data.value?.collections ?? []).map((c) => ({ label: c.ns, value: c.totalMs })),
)
const charts = computed(() => [
  { key: 'ops', label: t('performance.charts.ops'), series: opsSeries.value, format: rate },
  { key: 'connections', label: t('performance.charts.connections'), series: connectionSeries.value },
  { key: 'network', label: t('performance.charts.network'), series: networkSeries.value, format: perSecond },
  { key: 'memory', label: t('performance.charts.memory'), series: memorySeries.value, format: megabytes },
])
</script>

<template>
  <div class="flex flex-col gap-4 p-4" data-performance>
    <DsCallout v-if="error" tone="danger">{{ t(`performance.errors.${error}`) }}</DsCallout>
    <section :aria-labelledby="nowId">
      <h3 :id="nowId" class="sr-only">{{ t('performance.figures.title') }}</h3>
      <StatGrid :items="figures" :loading="!latest && !error" />
    </section>
    <ReplicaSetPanel :connection-id="connectionId" />
    <DsCallout v-if="range !== 'live' && history.isError.value" tone="danger">
      {{ describeError(history.error.value, t) }}
      <template #action>
        <DsButton size="sm" :icon="RotateCw" @click="history.refetch()">{{ t('common.retry') }}</DsButton>
      </template>
    </DsCallout>
    <DsCallout v-else-if="historyNote" tone="info" data-history-note>{{ historyNote }}</DsCallout>
    <div class="grid min-w-0 gap-4 lg:grid-cols-2">
      <DsCard v-for="chart in charts" :key="chart.key" :title="chart.label">
        <LineChart caption-hidden :label="chart.label" :series="chart.series" :format="chart.format" />
      </DsCard>
    </div>
    <OperationsTable :connection-id="connectionId" :can-operate="canOperate" />
    <DsCard :title="t('performance.hottest')">
      <p class="mb-3 text-small text-fg-subtle">{{ t('performance.hottestChart') }}</p>
      <DsCallout v-if="top.isError.value" tone="danger">
        {{ describeError(top.error.value, t) }}
        <template #action>
          <DsButton size="sm" :icon="RotateCw" @click="top.refetch()">{{ t('common.retry') }}</DsButton>
        </template>
      </DsCallout>
      <div
        v-else-if="top.isPending.value"
        role="status"
        :aria-label="t('app.loading')"
        class="flex flex-col gap-2"
      >
        <DsSkeleton v-for="n in 4" :key="n" class="h-5" :style="{ width: `${90 - n * 15}%` }" />
      </div>
      <BarChart
        v-else
        caption-hidden
        :label="t('performance.hottestChart')"
        :items="topItems"
        :format="(v: number) => t('performance.milliseconds', { n: v })"
      />
    </DsCard>
    <SlowQueriesPanel :connection-id="connectionId" :restricted="restricted" />
    <IndexAdvicePanel :connection-id="connectionId" :can-create="canCreateIndexes" />
    <ProfilerPanel :connection-id="connectionId" :can-operate="canOperate" :read-only="readOnly" />
  </div>
</template>
