<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import EChart from './EChart.vue'
import { lineOption } from './options'
import type { ChartHit, TipContent } from './tip'
import { useChartTheme } from './theme'

/**
 * A time-series chart on ECharts (phase 1j): zoom with the wheel or a pinch, tooltips as plain
 * text. The latest values are in the chart's accessible name and in a table screen readers get.
 */
const props = withDefaults(
  defineProps<{
    label: string
    series: Array<{ name: string; points: Array<number | null> }>
    format?: (value: number) => string
    height?: string
    /** Its name for screen readers only: the card around it shows the same title (UI redesign R3). */
    captionHidden?: boolean
  }>(),
  { format: (v: number) => String(Math.round(v * 100) / 100), height: undefined, captionHidden: false },
)
const { t } = useI18n()
const theme = useChartTheme()

const longest = computed(() => Math.max(0, ...props.series.map((s) => s.points.length)))
const latest = computed(() =>
  props.series.map((s) => ({
    name: s.name,
    value:
      typeof s.points[s.points.length - 1] === 'number' ? props.format(s.points[s.points.length - 1]!) : '—',
  })),
)
const name = computed(() =>
  longest.value === 0
    ? props.label
    : `${props.label}: ${latest.value.map((l) => `${l.name} ${l.value}`).join(', ')}`,
)
/** Every series at the pointed sample; a series that started later is aligned to the right. */
function tip(hit: ChartHit): TipContent | null {
  if (hit.kind !== 'sample') return null
  const palette = theme.value.palette
  return {
    rows: props.series.map((s, i) => {
      const point = s.points[hit.index - (longest.value - s.points.length)]
      return {
        name: s.name,
        value: typeof point === 'number' ? props.format(point) : '—',
        color: palette[i % palette.length],
      }
    }),
  }
}
const option = computed(() =>
  lineOption({ label: props.label, series: props.series, format: props.format }, theme.value),
)
</script>

<template>
  <figure class="flex flex-col gap-1">
    <figcaption :class="captionHidden ? 'sr-only' : 'text-small font-medium text-fg-muted'">
      {{ label }}
    </figcaption>
    <div class="relative">
      <EChart :option="option" :label="name" :height="height" :tip="tip" />
      <p
        v-if="longest === 0"
        class="absolute inset-0 flex items-center justify-center text-small text-fg-subtle"
      >
        {{ t('charts.waiting') }}
      </p>
    </div>
    <!-- In an sr-only box: a table keeps its content's width, and would push the page. -->
    <div class="sr-only">
      <table>
        <caption>
          {{
            t('charts.latest', { name: label })
          }}
        </caption>
        <tbody>
          <tr v-for="(line, i) in latest" :key="i">
            <td>{{ line.name }}</td>
            <td>{{ line.value }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </figure>
</template>
