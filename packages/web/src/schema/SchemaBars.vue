<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatCount } from '@/format'

/**
 * W2 (2026-10-16): a Schema field's ranges or most common values as bars, each a button that adds
 * it to the Documents filter (Compass's click-to-query) — a list a keyboard and a screen reader
 * reach, where a chart's bars are not. A bar with no condition (a value cut short) is only shown.
 */
const props = defineProps<{
  label: string
  items: Array<{ label: string; value: number; filterable: boolean }>
  /** Whether bars add to the filter at all (the field has a query path and a tab to filter). */
  canFilter: boolean
}>()
const emit = defineEmits<{ pick: [index: number] }>()
const { t, locale } = useI18n()
const max = computed(() => Math.max(1, ...props.items.map((i) => i.value)))
const width = (v: number) => `${Math.max(2, (v / max.value) * 100)}%`
const row =
  'grid w-full grid-cols-[minmax(0,11rem)_minmax(0,1fr)_3.5rem] items-center gap-2 rounded-md px-1.5 py-1 text-left text-small'
</script>

<template>
  <figure class="flex min-w-0 flex-col gap-1.5">
    <figcaption class="text-small font-medium text-fg-muted">{{ label }}</figcaption>
    <p v-if="items.length === 0" class="text-small text-fg-subtle">{{ t('charts.empty') }}</p>
    <ul v-else class="flex flex-col" :aria-label="label">
      <li v-for="(item, i) in items" :key="i" data-schema-bar>
        <button
          v-if="canFilter && item.filterable"
          type="button"
          :class="[
            row,
            'group cursor-pointer transition-colors duration-120 hover:bg-subtle focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none',
          ]"
          :aria-label="t('schema.filter.add', { value: item.label, n: formatCount(item.value, locale) })"
          :title="t('schema.filter.hint')"
          @click="emit('pick', i)"
        >
          <span class="truncate font-mono text-fg" :title="item.label">{{ item.label }}</span>
          <span class="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <span
              class="block h-full rounded-full bg-accent/70 transition-colors duration-120 group-hover:bg-accent"
              :style="{ width: width(item.value) }"
            />
          </span>
          <span class="text-right text-fg-muted tabular-nums">{{ formatCount(item.value, locale) }}</span>
        </button>
        <div v-else :class="row">
          <span class="truncate font-mono text-fg" :title="item.label">{{ item.label }}</span>
          <span class="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <span class="block h-full rounded-full bg-fg-subtle/50" :style="{ width: width(item.value) }" />
          </span>
          <span class="text-right text-fg-muted tabular-nums">{{ formatCount(item.value, locale) }}</span>
        </div>
      </li>
    </ul>
  </figure>
</template>
