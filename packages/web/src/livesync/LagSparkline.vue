<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * Phase 3e-2 spec §5: how far behind a sync was over the last minutes, as a small line on its card.
 * A screen reader hears the current and the largest lag (plan ruling 22: what this page saw).
 */
const props = withDefaults(
  defineProps<{
    points: Array<{ at: number; lag: number }>
    /** W4.6: the detail panel's larger chart. */
    height?: number
  }>(),
  { height: 36 },
)
const { t, locale } = useI18n()
const W = 240
const H = props.height
const seconds = (ms: number) =>
  new Intl.NumberFormat(locale.value, {
    style: 'unit',
    unit: 'second',
    unitDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(ms / 1000)
const max = computed(() => Math.max(0, ...props.points.map((p) => p.lag)))
const line = computed(() => {
  const first = props.points[0]?.at ?? 0
  const span = Math.max(1, (props.points.at(-1)?.at ?? 1) - first)
  const top = Math.max(1, max.value)
  return props.points
    .map((p) => `${(((p.at - first) / span) * W).toFixed(1)},${(H - 2 - (p.lag / top) * (H - 4)).toFixed(1)}`)
    .join(' ')
})
const label = computed(() =>
  t('liveSync.card.lagSummary', {
    title: t('liveSync.card.lagChart'),
    now: seconds(props.points.at(-1)?.lag ?? 0),
    max: seconds(max.value),
  }),
)
</script>

<template>
  <svg
    data-lag
    role="img"
    :aria-label="label"
    :viewBox="`0 0 ${W} ${H}`"
    preserveAspectRatio="none"
    class="w-full text-accent-fg"
    :style="{ height: `${H}px` }"
  >
    <line :x1="0" :x2="W" :y1="H - 1" :y2="H - 1" class="stroke-line" stroke-width="1" />
    <polyline
      :points="line"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linejoin="round"
      stroke-linecap="round"
      vector-effect="non-scaling-stroke"
    />
  </svg>
</template>
