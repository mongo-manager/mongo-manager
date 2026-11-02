<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { RotateCw, Settings2, Trash2 } from 'lucide-vue-next'
import type { KpiRefresh, RunLine } from '@mongo-manager/shared/browser'
import { aggregateApi, aggregateKeys } from '@/api/aggregate'
import { ApiError } from '@/api/client'
import { readNdjson } from '@/aggregation/ndjson'
import DsButton from '@/ds/DsButton.vue'
import DsSpinner from '@/ds/DsSpinner.vue'
import { formatRelative } from '@/format'
import WidgetError from './WidgetError.vue'
import { useWidget } from './context'
import { widgetError } from './errors'
import { oneAtATime } from './kpiQueue'

/**
 * Widgets wave 2 (2026-10-27; Atlas Charts' number and bar charts): a number, or bars, from one of the
 * user's saved pipelines. It runs as the aggregation page runs it — through the same route, so a
 * restricted user's run is gated and masked — at most 20 documents, and is no recent pipeline. A
 * pipeline that writes is never run. A value that is not a number (one masked) is said as hidden.
 */
const props = defineProps<{ connectionId: string }>()
const { t, locale } = useI18n()
const widget = useWidget()
interface KpiSettings {
  db: string
  coll: string
  pipelineId: string
  display: 'number' | 'bars'
  refresh: KpiRefresh
}
// Review nit: read safely outside a dashboard too (nothing runs without its settings).
const settings = computed(
  () =>
    (widget?.value.widget.settings ?? {
      db: '',
      coll: '',
      pipelineId: '',
      display: 'number',
      refresh: 'manual',
    }) as KpiSettings,
)
const target = computed(() => ({
  connectionId: props.connectionId,
  db: settings.value.db,
  coll: settings.value.coll,
}))
const pipelines = useQuery({
  queryKey: computed(() => aggregateKeys.pipelines(target.value)),
  queryFn: () => aggregateApi.pipelines.list(target.value),
})
const pipeline = computed(
  () => pipelines.data.value?.pipelines.find((p) => p.id === settings.value.pipelineId) ?? null,
)
const WRITES = new Set(['$out', '$merge'])
const writes = computed(() =>
  (pipeline.value?.stages ?? []).some(
    (s) => !!s && typeof s === 'object' && Object.keys(s).some((k) => WRITES.has(k)),
  ),
)
/** Review of wave 2 (I1): nothing to run (the run route takes one stage at least). */
const empty = computed(() => pipeline.value !== null && pipeline.value.stages.length === 0)
const LIMIT = 20
const INTERVAL: Record<KpiRefresh, number | false> = {
  manual: false,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
}
/** The user's runs are all taken (429): tried again a few times, after the wait the server says. */
const busy = (e: unknown) => e instanceof ApiError && e.status === 429
const BUSY_TRIES = 3
/** The wait the server asks for before the next try (a second when it says none; ten at most). */
function waitOf(e: unknown): number {
  const ms = Number(((e as ApiError).details as { retryAfterMs?: unknown } | undefined)?.retryAfterMs)
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 10_000) : 1_000
}
async function runOnce(signal: AbortSignal): Promise<{ docs: unknown[]; error: string | null }> {
  const stream = await aggregateApi.run(
    target.value,
    {
      stages: pipeline.value!.stages as Record<string, unknown>[],
      limit: LIMIT,
      maxTimeMS: 15_000,
      remember: false,
    },
    signal,
  )
  const docs: unknown[] = []
  let error: string | null = null
  let ended = false
  await readNdjson(
    stream,
    (lines) => {
      for (const line of lines as RunLine[]) {
        if ('document' in line) docs.push(line.document)
        else if ('error' in line) error = line.error.message
        else if ('end' in line) ended = true
      }
    },
    undefined,
    signal,
  )
  // No end line: the stream was cut short.
  if (!ended && !error) error = t('aggregation.run.incomplete')
  return { docs, error }
}
const run = useQuery({
  // Review of wave 2 (M9): under the collection's keys, so a refresh of the connection, a dropped
  // collection or a deleted connection lets it go as it does the rest.
  queryKey: computed(() => [
    ...aggregateKeys.pipelines(target.value),
    'kpi',
    settings.value.pipelineId,
    JSON.stringify(pipeline.value?.stages ?? null),
  ]),
  queryFn: ({ signal }) => oneAtATime(() => runOnce(signal), signal),
  enabled: computed(() => !!pipeline.value && !writes.value && !empty.value),
  refetchInterval: computed(() => INTERVAL[settings.value.refresh]),
  staleTime: Infinity,
  refetchOnWindowFocus: false,
  retry: (count, e) => busy(e) && count < BUSY_TRIES,
  retryDelay: (_count, e) => waitOf(e),
})

/** A number as canonical EJSON gives it (or a plain one); anything else — a masked value — is none. */
function numberOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  for (const k of ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal']) {
    if (typeof o[k] !== 'string') continue
    const n = Number(o[k])
    return Number.isFinite(n) ? n : null
  }
  return null
}
/** A bar's name from its _id, as text. */
function labelOf(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  const o = v as Record<string, unknown>
  if (typeof o.$oid === 'string') return o.$oid
  const n = numberOf(v)
  if (n !== null) return String(n)
  if (o.$date !== undefined) {
    const at = typeof o.$date === 'string' ? o.$date : (o.$date as { $numberLong?: string }).$numberLong
    const d = at === undefined ? NaN : Date.parse(/^\d+$/.test(at) ? new Date(Number(at)).toISOString() : at)
    if (Number.isFinite(d)) return new Date(d).toLocaleString(locale.value)
  }
  const text = JSON.stringify(v)
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}
const docs = computed(() =>
  (run.data.value?.docs ?? []).filter((d): d is Record<string, unknown> => !!d && typeof d === 'object'),
)
/**
 * The field shown (review of wave 2, M8: the spec's "first numeric field"): the first one past _id
 * holding a number in a document shown — its name is shown with it — else the first one (said hidden).
 */
const field = computed(() => {
  const keys = Object.keys(docs.value[0] ?? {}).filter((k) => k !== '_id')
  const shown = settings.value.display === 'number' ? docs.value.slice(0, 1) : docs.value.slice(0, 12)
  return keys.find((k) => shown.some((d) => numberOf(d[k]) !== null)) ?? keys[0] ?? null
})
const format = (n: number) => new Intl.NumberFormat(locale.value, { maximumFractionDigits: 2 }).format(n)
const value = computed(() => (field.value ? numberOf(docs.value[0]![field.value]) : null))
const bars = computed(() => {
  const key = field.value
  const rows = docs.value.slice(0, 12).map((d) => ({
    label: labelOf(d._id),
    value: key ? numberOf(d[key]) : null,
  }))
  const max = Math.max(0, ...rows.map((r) => Math.abs(r.value ?? 0)))
  return rows.map((r) => ({
    ...r,
    width: r.value === null || !max ? 0 : (Math.abs(r.value) / max) * 100,
    // Review nit: a value below zero is drawn in another colour (its text keeps its sign).
    negative: r.value !== null && r.value < 0,
  }))
})
const updated = computed(() =>
  run.dataUpdatedAt.value
    ? t('overview.kpi.updated', { when: formatRelative(run.dataUpdatedAt.value - Date.now(), locale.value) })
    : null,
)
</script>

<template>
  <div class="flex flex-col gap-3">
    <div v-if="pipelines.isPending.value" class="flex items-center gap-2 py-2 text-ui text-fg-subtle">
      <DsSpinner :size="14" />{{ t('overview.status.waiting') }}
    </div>
    <WidgetError
      v-else-if="pipelines.isError.value"
      :text="t(`overview.errors.${widgetError(pipelines.error.value)}`)"
      :retry="() => void pipelines.refetch()"
    />
    <div v-else-if="!pipeline" data-widget-state class="flex flex-col items-start gap-3 py-1">
      <p class="text-ui text-fg-muted">{{ t('overview.kpi.gone') }}</p>
      <div v-if="widget" class="flex flex-wrap gap-2">
        <DsButton size="sm" class="pointer-coarse:h-11" :icon="Settings2" @click="widget.configure()">{{
          t('overview.dashboard.settings')
        }}</DsButton>
        <DsButton
          size="sm"
          variant="ghost"
          class="pointer-coarse:h-11"
          :icon="Trash2"
          @click="widget.remove()"
          >{{ t('overview.dashboard.remove') }}</DsButton
        >
      </div>
    </div>
    <template v-else>
      <p class="truncate text-small text-fg-subtle">
        <span class="font-medium text-fg">{{ pipeline.name }}</span> ·
        <span class="font-mono">{{ settings.db }}.{{ settings.coll }}</span>
      </p>
      <p v-if="writes" class="text-ui text-fg-muted">{{ t('overview.kpi.writes') }}</p>
      <p v-else-if="empty" class="text-ui text-fg-muted">{{ t('overview.kpi.noStage') }}</p>
      <div v-else-if="run.isPending.value" class="flex items-center gap-2 py-2 text-ui text-fg-subtle">
        <DsSpinner :size="14" />{{ t('overview.kpi.running') }}
      </div>
      <WidgetError
        v-else-if="run.isError.value || run.data.value?.error"
        :text="
          run.data.value?.error
            ? t('overview.kpi.failed', { message: run.data.value.error })
            : t(`overview.errors.${widgetError(run.error.value)}`)
        "
        :retry="() => void run.refetch()"
      />
      <p v-else-if="!docs.length" class="text-ui text-fg-muted">{{ t('overview.kpi.empty') }}</p>
      <div v-else-if="settings.display === 'number'" class="flex flex-col">
        <span
          v-if="value !== null"
          data-kpi-value
          class="text-3xl leading-tight font-semibold text-fg tabular-nums"
          >{{ format(value) }}</span
        >
        <span v-else class="text-ui text-fg-muted">{{ t('overview.kpi.hidden') }}</span>
        <span v-if="field" class="text-small text-fg-subtle">{{ field }}</span>
      </div>
      <ul v-else class="flex flex-col gap-1.5">
        <li v-for="(b, i) in bars" :key="i" data-kpi-bar class="flex min-w-0 flex-col gap-0.5 text-small">
          <span class="flex min-w-0 justify-between gap-2">
            <span class="min-w-0 truncate text-fg">{{ b.label }}</span>
            <span class="shrink-0 tabular-nums" :class="b.value === null ? 'text-fg-subtle' : 'text-fg'">{{
              b.value === null ? t('overview.kpi.hidden') : format(b.value)
            }}</span>
          </span>
          <span class="h-1.5 rounded-full bg-subtle" aria-hidden="true">
            <span
              class="block h-full rounded-full"
              :class="b.negative ? 'bg-warning' : 'bg-accent'"
              :style="{ width: `${b.width}%` }"
            />
          </span>
        </li>
      </ul>
      <div v-if="!writes && !empty" class="flex flex-wrap items-center gap-2">
        <DsButton
          size="sm"
          variant="ghost"
          class="pointer-coarse:h-11"
          :icon="RotateCw"
          :disabled="run.isFetching.value"
          @click="void run.refetch()"
          >{{ t('overview.kpi.refresh') }}</DsButton
        >
        <span v-if="updated" class="text-caption text-fg-subtle">{{ updated }}</span>
      </div>
    </template>
  </div>
</template>
