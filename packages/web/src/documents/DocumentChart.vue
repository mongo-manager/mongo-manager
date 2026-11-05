<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { useKeepPreviousShown } from '@/masking/rulesEpoch'
import { ChartColumn, ChartLine, ChartPie, ChartScatter, Lock, RefreshCw } from 'lucide-vue-next'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import DsSelect from '@/ds/DsSelect.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import EChart from '@/charts/EChart.vue'
import { categoryOption, pieOption, scatterOption } from '@/charts/options'
import { useChartTheme } from '@/charts/theme'
import type { ChartHit, TipContent } from '@/charts/tip'
import { documentKeys, documentsApi, type CollectionTarget, type CountResult } from '@/api/documents'
import { describeError } from '@/api/errors'
import { useMaskedPath } from '@/masking/useMaskedPaths'
import { formatCount } from '@/format'
import type { FindQuery } from './queryBuild'
import { toRows, type Row } from './rows'
import { typeOf } from './values'
import {
  CHART_MEASURES,
  CHART_SAMPLE,
  NO_VALUE,
  OTHER,
  chartData,
  chartFields,
  chartProjection,
  numberOf,
  refusedField,
  type ChartKind,
  type ChartMeasure,
  type ChartSpec,
} from './chartModel'

/**
 * W1 (completion §2): the results as a chart in the app itself (Atlas Charts' quick look, without
 * leaving the collection): bars, a line, points or a pie, from fields picked here. It reads the query's
 * documents apart from the page shown (up to CHART_SAMPLE of them, only the fields drawn) and says when
 * there were more. A field hidden from the user is not offered, and one kept from before is refused
 * before anything is read (phase 3c).
 */
const props = defineProps<{
  target: CollectionTarget
  query: FindQuery
  /** The page shown: the fields offered come from it. */
  rows: Row[]
  count: CountResult | undefined
}>()
const spec = defineModel<ChartSpec>({ required: true })
const { t, locale } = useI18n()
const theme = useChartTheme()
const isMasked = useMaskedPath()

const pageDocs = computed(() => props.rows.flatMap((r) => (r.kind === 'document' ? [r.value] : [])))
const fields = computed(() => chartFields(pageDocs.value, isMasked.value))
/** What a field holds on the page, its most common kind. */
function kindOf(field: string): 'number' | 'date' | 'text' | null {
  const counts = { number: 0, date: 0, text: 0 }
  for (const doc of pageDocs.value) {
    let v: unknown = doc
    for (const key of field.split('.'))
      v = v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined
    if (v === undefined) continue
    if (numberOf(v) !== null) counts.number++
    else if (typeOf(v) === 'date') counts.date++
    else counts.text++
  }
  const best = (Object.entries(counts) as Array<[keyof typeof counts, number]>).sort(
    (a, b) => b[1] - a[1],
  )[0]!
  return best[1] > 0 ? best[0] : null
}
const numeric = computed(() => fields.value.filter((f) => kindOf(f) === 'number'))

// The first time, a field is chosen for the user: a category for x, a number for a measure.
watch(
  fields,
  (list) => {
    if (!spec.value.x && list.length) {
      const x =
        list.find((f) => f !== '_id' && kindOf(f) === 'text') ?? list.find((f) => f !== '_id') ?? list[0]!
      spec.value = { ...spec.value, x }
    }
  },
  { immediate: true },
)
function set<K extends keyof ChartSpec>(key: K, value: ChartSpec[K]): void {
  const next = { ...spec.value, [key]: value }
  if (
    (key === 'measure' || key === 'kind') &&
    !next.y &&
    (next.measure !== 'count' || next.kind === 'scatter')
  )
    next.y = numeric.value.find((f) => f !== next.x) ?? ''
  spec.value = next
}

const kinds = computed(() => [
  { value: 'bar' as const, label: t('explorer.chart.kinds.bar'), icon: ChartColumn },
  { value: 'line' as const, label: t('explorer.chart.kinds.line'), icon: ChartLine },
  { value: 'scatter' as const, label: t('explorer.chart.kinds.scatter'), icon: ChartScatter },
  { value: 'pie' as const, label: t('explorer.chart.kinds.pie'), icon: ChartPie },
])
const kind = computed({ get: () => spec.value.kind, set: (v: ChartKind) => set('kind', v) })
const measure = computed({ get: () => spec.value.measure, set: (v: ChartMeasure) => set('measure', v) })
const field = (key: 'x' | 'y' | 'group') =>
  computed({ get: () => spec.value[key], set: (v: string) => set(key, v) })
const x = field('x')
const y = field('y')
const group = field('group')
/** A field kept from before stays listed, so the select shows what is chosen (and why it is refused). */
const options = (list: string[], current: string, none: boolean) => [
  ...(none ? [{ value: '', label: t('explorer.chart.none') }] : []),
  ...[...new Set([...list, ...(current ? [current] : [])])].map((f) => ({ value: f, label: f })),
]
// W1 review (minor 5): a pie is of counts or sums; an average kept from bars becomes a sum.
watch(
  () => [spec.value.kind, spec.value.measure] as const,
  ([kind, m]) => {
    if (kind === 'pie' && m === 'avg') spec.value = { ...spec.value, measure: 'sum' }
  },
  { immediate: true },
)
const measures = computed(() =>
  CHART_MEASURES.filter((m) => spec.value.kind !== 'pie' || m !== 'avg').map((m) => ({
    value: m,
    label: t(`explorer.chart.measures.${m}`),
  })),
)
const needsY = computed(() => spec.value.kind === 'scatter' || spec.value.measure !== 'count')

const refused = computed(() => refusedField(spec.value, isMasked.value))
const ready = computed(() => !!spec.value.x && (!needsY.value || !!spec.value.y) && !refused.value)
const body = computed(() => {
  const q = props.query
  return {
    filter: q.filter,
    // Only the fields drawn are read — of the query's own projection, when it has one (W1 review).
    projection: chartProjection(spec.value, q.projection),
    ...(q.sort ? { sort: q.sort } : {}),
    ...(q.collation ? { collation: q.collation } : {}),
    ...(q.hint !== undefined ? { hint: q.hint } : {}),
    ...(q.maxTimeMS !== undefined ? { maxTimeMS: q.maxTimeMS } : {}),
    skip: q.skip,
    limit: CHART_SAMPLE,
    // A chart's read is not one of the user's recent queries (nor a plugin's read, held to 10 s).
    record: false,
  }
})
const keepPreviousShown = useKeepPreviousShown()
const read = useQuery({
  queryKey: computed(() => [...documentKeys.page(props.target, body.value), 'chart'] as const),
  queryFn: ({ signal }) => documentsApi.find(props.target, body.value, signal),
  enabled: ready,
  placeholderData: keepPreviousShown,
})
const docs = computed(() =>
  toRows(read.data.value?.documents ?? [], 0).flatMap((r) => (r.kind === 'document' ? [r.value] : [])),
)
const data = computed(() => (ready.value ? chartData(docs.value, spec.value, isMasked.value) : null))

const n = (v: number) => formatCount(v, locale.value)
const format = (v: number) =>
  new Intl.NumberFormat(locale.value, { maximumFractionDigits: 2 }).format(Math.round(v * 100) / 100)
const nameOf = (s: string) =>
  s === NO_VALUE
    ? t('explorer.chart.noValue')
    : s === OTHER
      ? t('explorer.chart.other')
      : s === 'count' && spec.value.measure === 'count'
        ? t('explorer.chart.measures.count')
        : s
const label = computed(() => {
  const s = spec.value
  if (s.kind === 'scatter') return t('explorer.chart.scatterOf', { x: s.x, y: s.y })
  if (s.measure === 'count') return t('explorer.chart.countBy', { x: s.x })
  return t('explorer.chart.measureBy', { measure: t(`explorer.chart.measures.${s.measure}`), y: s.y, x: s.x })
})
const option = computed(() => {
  const d = data.value
  if (!d || d.kind === 'refused' || d.kind === 'negative') return null
  if (d.kind === 'points') {
    if (!d.series.length) return null
    return scatterOption(
      {
        label: label.value,
        xType: d.xType,
        series: d.series.map((s) => ({ ...s, name: nameOf(s.name) })),
        format,
      },
      theme.value,
    )
  }
  if (!d.categories.length) return null
  const categories = d.categories.map(nameOf)
  if (spec.value.kind === 'pie')
    return pieOption(
      {
        label: label.value,
        items: categories.map((c, i) => ({ label: c, value: d.series[0]?.values[i] ?? 0 })),
      },
      theme.value,
    )
  return categoryOption(
    {
      kind: spec.value.kind === 'line' ? 'line' : 'bar',
      label: label.value,
      categories,
      series: d.series.map((s) => ({ ...s, name: nameOf(s.name) })),
      format,
    },
    theme.value,
  )
})

/** The app's own tooltip (ChartTip): what is pointed at, as text. */
function tip(hit: ChartHit): TipContent | null {
  const d = data.value
  if (!d || d.kind === 'refused' || d.kind === 'negative') return null
  const color = (i: number) => theme.value.palette[i % theme.value.palette.length]
  if (d.kind === 'points') {
    if (hit.kind !== 'item') return null
    const s = d.series[hit.series ?? 0]
    const p = s?.points[hit.index]
    if (!s || !p) return null
    const xText = d.xType === 'date' ? new Date(p[0]).toISOString() : format(p[0])
    return {
      rows: [
        { name: nameOf(s.name), value: '', color: color(hit.series ?? 0) },
        { name: spec.value.x, value: xText },
        { name: spec.value.y, value: format(p[1]) },
      ],
    }
  }
  const category = d.categories[hit.index]
  if (category === undefined) return null
  if (spec.value.kind === 'pie') {
    const total = (d.series[0]?.values ?? []).reduce<number>((a, v) => a + (v ?? 0), 0) || 1
    const v = d.series[0]?.values[hit.index] ?? 0
    return {
      rows: [
        {
          name: nameOf(category),
          value: `${format(v)} (${Math.round((v / total) * 100)}%)`,
          color: color(hit.index),
        },
      ],
    }
  }
  const series = hit.kind === 'item' && hit.series !== undefined ? [hit.series] : d.series.map((_, i) => i)
  return {
    rows: [
      { name: nameOf(category), value: '' },
      ...series.flatMap((i) => {
        const v = d.series[i]?.values[hit.index]
        return v === null || v === undefined
          ? []
          : [{ name: nameOf(d.series[i]!.name), value: format(v), color: color(i) }]
      }),
    ],
  }
}

const sampledNote = computed(() => {
  const got = read.data.value?.documents.length ?? 0
  if (got < CHART_SAMPLE) return ''
  const total = props.count?.count ?? props.count?.atLeast ?? null
  return total !== null && total > got
    ? t('explorer.chart.sampled', { shown: n(got), total: n(total) })
    : read.data.value?.hasMore
      ? t('explorer.chart.sampledMore', { shown: n(got) })
      : ''
})
const skippedNote = computed(() => {
  const d = data.value
  const k = d && d.kind !== 'refused' && d.kind !== 'negative' ? d.skipped : 0
  return k > 0 ? t('explorer.chart.skipped', { n: n(k) }, k) : ''
})
/** The rows a screen reader reads (a few hundred at most). */
const tableRows = computed(() => {
  const d = data.value
  if (!d || d.kind === 'refused' || d.kind === 'negative') return []
  if (d.kind === 'points')
    return d.series
      .flatMap((s) => s.points.map((p) => [nameOf(s.name), format(p[0]), format(p[1])]))
      .slice(0, 300)
  return d.categories.map((c, i) => [
    nameOf(c),
    ...d.series.map((s) => (s.values[i] == null ? '' : format(s.values[i]!))),
  ])
})
const tableHead = computed(() => {
  const d = data.value
  if (!d || d.kind === 'refused' || d.kind === 'negative') return []
  if (d.kind === 'points') return [t('explorer.chart.group'), spec.value.x, spec.value.y]
  return [spec.value.x, ...d.series.map((s) => nameOf(s.name))]
})
</script>

<template>
  <section data-results-chart class="flex h-full min-h-0 flex-col">
    <div
      role="group"
      :aria-label="t('explorer.chart.label')"
      class="flex flex-wrap items-end gap-x-3 gap-y-2 border-b border-line px-4 py-2"
    >
      <DsSegmented v-model="kind" size="sm" icon-only :label="t('explorer.chart.kind')" :options="kinds" />
      <div class="w-44 max-w-full">
        <DsSelect
          v-model="x"
          size="sm"
          :label="spec.kind === 'pie' ? t('explorer.chart.slices') : t('explorer.chart.x')"
          :options="options(fields, spec.x, false)"
        />
      </div>
      <div v-if="spec.kind !== 'scatter'" class="w-32">
        <DsSelect v-model="measure" size="sm" :label="t('explorer.chart.measure')" :options="measures" />
      </div>
      <div v-if="needsY" class="w-44 max-w-full">
        <DsSelect
          v-model="y"
          size="sm"
          :label="spec.kind === 'scatter' ? t('explorer.chart.yAxis') : t('explorer.chart.y')"
          :options="options(spec.kind === 'scatter' ? fields : numeric, spec.y, !spec.y)"
        />
      </div>
      <div v-if="spec.kind !== 'pie'" class="w-44 max-w-full">
        <DsSelect
          v-model="group"
          size="sm"
          :label="t('explorer.chart.group')"
          :options="options(fields, spec.group, true)"
        />
      </div>
    </div>
    <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-4">
      <DsCallout v-if="refused" tone="warning">
        <span class="inline-flex items-center gap-1.5">
          <Lock class="size-3.5" aria-hidden="true" />{{ t('explorer.chart.refused', { field: refused }) }}
        </span>
      </DsCallout>
      <DsEmptyState
        v-else-if="!fields.length && !spec.x"
        :icon="ChartColumn"
        :title="t('explorer.chart.noFields')"
      />
      <DsEmptyState
        v-else-if="!ready"
        :icon="ChartColumn"
        :title="
          !spec.x
            ? t('explorer.chart.pickX')
            : t('explorer.chart.pickY', { measure: t(`explorer.chart.measures.${spec.measure}`) })
        "
      />
      <DsCallout v-else-if="read.isError.value" tone="danger" :title="t('explorer.chart.failed')">
        <span class="break-words">{{ describeError(read.error.value, t) }}</span>
        <template #action>
          <DsButton size="sm" :icon="RefreshCw" @click="read.refetch()">{{
            t('documents.states.retry')
          }}</DsButton>
        </template>
      </DsCallout>
      <!-- W1 review (minor 6): a new read shows the skeleton, not the last one's documents drawn
           with the new fields ("Nothing to chart" for a moment). -->
      <div
        v-else-if="read.isPending.value || (read.isPlaceholderData.value && read.isFetching.value)"
        data-chart-loading
        :aria-label="t('explorer.chart.loading')"
        class="flex flex-1 flex-col gap-2"
      >
        <DsSkeleton class="h-full min-h-64 w-full" />
      </div>
      <DsCallout v-else-if="data?.kind === 'negative'" tone="warning">{{
        t('explorer.chart.negative')
      }}</DsCallout>
      <DsEmptyState v-else-if="!option" :icon="ChartColumn" :title="t('explorer.chart.empty')" />
      <figure v-else class="flex min-h-72 flex-1 flex-col gap-2">
        <figcaption class="text-small font-medium text-fg-muted">{{ label }}</figcaption>
        <div class="min-h-64 flex-1">
          <EChart :option="option" :label="label" height="h-full" :tip="tip" />
        </div>
        <!-- In an sr-only box: a table keeps its content's width, and would push the page. -->
        <div class="sr-only">
          <table>
            <caption>
              {{
                label
              }}
            </caption>
            <thead>
              <tr>
                <th v-for="(h, i) in tableHead" :key="i" scope="col">{{ h }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, i) in tableRows" :key="i">
                <td v-for="(cell, j) in row" :key="j">{{ cell }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </figure>
      <p v-if="option && (sampledNote || skippedNote)" class="text-small text-fg-subtle" role="status">
        {{ [sampledNote, skippedNote].filter(Boolean).join(' ') }}
      </p>
    </div>
  </section>
</template>
