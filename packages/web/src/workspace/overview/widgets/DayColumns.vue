<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * A column a day (oldest first), small enough for a widget: each column's day and value as its
 * tooltip, and a table for screen readers.
 */
const props = defineProps<{
  label: string
  days: Array<{ day: string; value: number; name: string }>
  format: (value: number) => string
}>()
const { t } = useI18n()
const W = 300
const H = 64
const GAP = 2
const max = computed(() => Math.max(1, ...props.days.map((d) => d.value)))
const bars = computed(() => {
  const width = (W - GAP * (props.days.length - 1)) / Math.max(1, props.days.length)
  return props.days.map((d, i) => {
    // An empty day still shows, as a line on the floor.
    const h = d.value > 0 ? Math.max(3, (d.value / max.value) * (H - 2)) : 1
    return { ...d, x: i * (width + GAP), y: H - h, w: width, h }
  })
})
</script>

<template>
  <figure class="flex flex-col gap-1.5">
    <figcaption class="text-small font-medium text-fg-muted">{{ label }}</figcaption>
    <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" class="h-16 w-full" aria-hidden="true">
      <rect
        v-for="(b, i) in bars"
        :key="b.day"
        :data-day="b.day"
        :x="b.x"
        :y="b.y"
        :width="b.w"
        :height="b.h"
        rx="1.5"
        :class="b.value > 0 ? (i === bars.length - 1 ? 'fill-accent' : 'fill-accent/55') : 'fill-line'"
      >
        <title>{{ b.name }}: {{ format(b.value) }}</title>
      </rect>
    </svg>
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
            <th scope="col">{{ t('charts.day') }}</th>
            <th scope="col">{{ label }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in days" :key="d.day">
            <th scope="row">{{ d.name }}</th>
            <td>{{ format(d.value) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </figure>
</template>
