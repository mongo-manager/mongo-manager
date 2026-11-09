<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import EChart from './EChart.vue'
import { barOption } from './options'
import type { ChartHit, TipContent } from './tip'
import { useChartTheme } from './theme'

/** Horizontal bars on ECharts (phase 1j), with a table for screen readers. */
const props = withDefaults(
  defineProps<{
    label: string
    items: Array<{ label: string; value: number }>
    format?: (value: number) => string
    /** Its name for screen readers only: the card around it shows the same title (UI redesign R3). */
    captionHidden?: boolean
  }>(),
  { format: (v: number) => String(v), captionHidden: false },
)
const { t } = useI18n()
const theme = useChartTheme()

const option = computed(() =>
  barOption({ label: props.label, items: props.items, format: props.format }, theme.value),
)
function tip(hit: ChartHit): TipContent | null {
  const item = hit.kind === 'item' ? props.items[hit.index] : undefined
  return item
    ? { rows: [{ name: item.label, value: props.format(item.value), color: theme.value.palette[0] }] }
    : null
}
/** Tall enough for every bar, within 8 rem and 24 rem. */
const height = computed(() => `${Math.min(24, Math.max(8, props.items.length * 1.4 + 2))}rem`)
</script>

<template>
  <figure class="flex flex-col gap-2">
    <figcaption :class="captionHidden ? 'sr-only' : 'text-small font-medium text-fg-muted'">
      {{ label }}
    </figcaption>
    <p v-if="items.length === 0" class="text-small text-fg-subtle">{{ t('charts.empty') }}</p>
    <div v-else :style="{ height }">
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
        <tbody>
          <tr v-for="(item, i) in items" :key="i">
            <td>{{ item.label }}</td>
            <td>{{ format(item.value) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </figure>
</template>
