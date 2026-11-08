<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import WidgetError from './WidgetError.vue'
import { widgetError } from './errors'
import { RANGES, type Metric, type Range } from '@mongo-manager/shared/browser'
import { serverApi, serverKeys } from '@/api/server'
import LineChart from '@/charts/LineChart.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import { formatBytes } from '@/format'
import { useDashboardStore } from '@/stores/dashboard'
import { useWidget } from './context'
import { historyMetric, liveMetric, type MetricUnit } from './metricSeries'
import { useSharedMonitor } from './sharedMonitor'

/**
 * User review 2026-10-09 ("grafiksel olarak bir şeyler"): one metric of one server as a chart — live
 * (the last five minutes), or the last hour, day or week from stored history. The range is the
 * widget's setting. Live beyond the socket's limit shows the last hour and says so.
 */
const props = defineProps<{ connectionId: string }>()
const { t, locale } = useI18n()
const widget = useWidget()
const dashboard = useDashboardStore()
const settings = computed(
  () =>
    (widget?.value.widget.settings ?? { metric: 'opcounters', range: 'live' }) as {
      metric: Metric
      range: Range
    },
)
const monitor = useSharedMonitor(() => (settings.value.range === 'live' ? props.connectionId : null))
/** What is drawn: live, or a stored range (the last hour when live is not possible). */
const stored = computed<Exclude<Range, 'live'> | null>(() =>
  settings.value.range !== 'live'
    ? settings.value.range
    : monitor.live.value || monitor.paused.value
      ? null
      : '1h',
)
const history = useQuery({
  queryKey: computed(() => serverKeys.history(props.connectionId, stored.value ?? '1h')),
  queryFn: () => serverApi.history(props.connectionId, stored.value!),
  enabled: computed(() => stored.value !== null && !monitor.paused.value),
  refetchInterval: 60_000,
})
const drawn = computed(() => {
  if (stored.value === null) return liveMetric(settings.value.metric, monitor.samples.value)
  return history.data.value ? historyMetric(settings.value.metric, history.data.value) : null
})
const FORMAT: Record<MetricUnit, (v: number) => string> = {
  perSecond: (v) => new Intl.NumberFormat(locale.value, { maximumFractionDigits: 1 }).format(v),
  bytesPerSecond: (v) => `${formatBytes(v, locale.value)}/s`,
  count: (v) => new Intl.NumberFormat(locale.value).format(v),
  mb: (v) => formatBytes(v * 1024 ** 2, locale.value),
  ratio: (v) => new Intl.NumberFormat(locale.value, { maximumFractionDigits: 1 }).format(v),
  ms: (v) => `${new Intl.NumberFormat(locale.value, { maximumFractionDigits: 2 }).format(v)} ms`,
}
const series = computed(() =>
  (drawn.value?.series ?? []).map((s) => ({ ...s, name: t(`overview.metrics.series.${s.name}`) })),
)
// User report 2026-10-27: a range another chart of this server and metric shows is not offered.
const ranges = computed(() =>
  RANGES.map((r) => ({
    value: r,
    label: t(`overview.metrics.ranges.${r}`),
    disabled:
      r !== settings.value.range &&
      dashboard.shownBy(
        { type: 'metric', settings: { ...settings.value, connectionId: props.connectionId, range: r } },
        widget?.value.widget.id,
      ),
  })),
)
const range = computed({
  get: () => settings.value.range,
  set: (value: Range) => {
    if (widget)
      dashboard.configure(widget.value.widget.id, {
        ...settings.value,
        connectionId: props.connectionId,
        range: value,
      })
  },
})
/** A stored range with nothing kept (history off, or the server just added): said, not an empty chart. */
const hasReadings = computed(() => (drawn.value?.series ?? []).some((s) => s.points.some((p) => p !== null)))
const error = computed(() =>
  stored.value === null
    ? monitor.error.value
    : history.isError.value
      ? widgetError(history.error.value)
      : null,
)
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="text-small text-fg-subtle">
        {{ t(`overview.metrics.units.${drawn?.unit ?? 'count'}`) }}
        <template v-if="settings.range === 'live' && stored !== null">
          · {{ t('overview.metrics.liveLimited') }}</template
        >
      </p>
      <DsSegmented v-model="range" size="sm" :label="t('overview.metrics.range')" :options="ranges" />
    </div>
    <WidgetError
      v-if="error"
      :text="t(`overview.errors.${error}`)"
      :retry="stored !== null ? () => void history.refetch() : undefined"
    />
    <p
      v-if="stored !== null && drawn && !hasReadings"
      class="rounded-lg bg-subtle px-3 py-6 text-center text-small text-fg-muted"
    >
      {{ t('overview.metrics.noReadings') }}
    </p>
    <div v-else data-metric-chart>
      <LineChart
        :label="t(`overview.metrics.names.${settings.metric}`)"
        :series="series"
        :format="FORMAT[drawn?.unit ?? 'count']"
        height="h-44"
      />
    </div>
  </div>
</template>
