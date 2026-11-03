<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { LazyVChart } from './lazy'
import ChartTip from './ChartTip.vue'
import type { ChartHit, TipContent } from './tip'

/**
 * One ECharts canvas; it resizes with its container (autoresize). Its tooltip is the app's own
 * (ChartTip): the chart says what is pointed at, `tip` says what to show for it.
 */
const props = defineProps<{
  option: Record<string, unknown>
  label: string
  height?: string
  tip?: (hit: ChartHit) => TipContent | null
}>()

const hit = ref<ChartHit | null>(null)
const pointer = reactive({ x: 0, y: 0 })
const content = computed(() => (hit.value && props.tip ? props.tip(hit.value) : null))

function onAxisPointer(params: unknown): void {
  const value = (params as { axesInfo?: Array<{ value?: unknown }> }).axesInfo?.[0]?.value
  const index = Number(value)
  hit.value = value === undefined || !Number.isInteger(index) ? null : { kind: 'sample', index }
}
/** Marks pointed at one by one (a line's points are told by the axis pointer instead). */
const ITEM_SERIES = new Set(['bar', 'scatter', 'pie'])
/** A bar, a point or a slice, and its series (W1: the results chart has several). */
function onItem(params: unknown): void {
  const { dataIndex, seriesIndex, seriesType } = params as {
    dataIndex?: unknown
    seriesIndex?: unknown
    seriesType?: unknown
  }
  if (typeof seriesType === 'string' && ITEM_SERIES.has(seriesType) && typeof dataIndex === 'number')
    hit.value = {
      kind: 'item',
      index: dataIndex,
      ...(typeof seriesIndex === 'number' ? { series: seriesIndex } : {}),
    }
}
function onItemOut(): void {
  if (hit.value?.kind === 'item') hit.value = null
}
function onMove(event: MouseEvent): void {
  pointer.x = event.clientX
  pointer.y = event.clientY
}
const hide = () => (hit.value = null)
</script>

<template>
  <div
    role="img"
    :aria-label="label"
    :class="height ?? 'h-40'"
    class="w-full min-w-0"
    @mousemove="onMove"
    @mouseleave="hide"
  >
    <LazyVChart
      :option="option"
      autoresize
      class="h-full w-full"
      @updateaxispointer="onAxisPointer"
      @mouseover="onItem"
      @mouseout="onItemOut"
      @globalout="hide"
    />
    <ChartTip :content="content" :pointer="pointer" />
  </div>
</template>
