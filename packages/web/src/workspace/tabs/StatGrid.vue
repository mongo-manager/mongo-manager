<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import DsProgress from '@/ds/DsProgress.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'

/**
 * UI redesign R2–R5 spec §2: statistics as one card of figures, not one box per figure. The figures
 * share each row's width and the hairlines between them are the card's own colour showing through.
 * A figure may carry a bar (how full a cache is: UI redesign R3, Monitoring), and while the figures
 * are not known yet each value is a placeholder of its shape.
 */
withDefaults(
  defineProps<{
    items: Array<{
      label: string
      value: string
      bar?: {
        value: number
        label: string
        valueText?: string
        tone?: 'accent' | 'warning' | 'danger'
        /** How full something is (a cache), not a task's progress. */
        meter?: boolean
      }
    }>
    loading?: boolean
  }>(),
  { loading: false },
)
</script>

<template>
  <dl class="flex flex-wrap gap-px overflow-hidden rounded-card border border-line bg-line shadow-xs">
    <div
      v-for="item in items"
      :key="item.label"
      class="flex min-w-36 flex-1 basis-36 flex-col gap-1 bg-surface px-4 py-3"
    >
      <dt class="truncate text-caption font-medium text-fg-subtle">{{ item.label }}</dt>
      <dd v-if="loading"><DsSkeleton class="mt-0.5 h-6 w-16" /></dd>
      <dd v-else class="flex flex-col gap-1.5">
        <span class="truncate text-title-m font-semibold text-fg tabular-nums">{{ item.value }}</span>
        <DsProgress
          v-if="item.bar"
          :label="item.bar.label"
          :value="item.bar.value"
          :value-text="item.bar.valueText"
          :tone="item.bar.tone ?? 'accent'"
          :meter="item.bar.meter ?? false"
        />
      </dd>
    </div>
  </dl>
</template>
