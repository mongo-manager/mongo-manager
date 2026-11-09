<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import type { Component } from 'vue'
import DsTooltip from '@/ds/DsTooltip.vue'
import { ariaKeys } from '@/workspace/shortcuts'

/**
 * UI redesign R1 revision 2 §3.1: one sidebar entry — icon and label, or, in the rail, the icon alone
 * with its label as name and tooltip.
 */
defineOptions({ inheritAttrs: false })
withDefaults(
  defineProps<{
    icon: Component
    label: string
    active?: boolean
    collapsed?: boolean
    /** A count that needs a person, and what it means for a screen reader. */
    badge?: number
    badgeLabel?: string
    shortcut?: string[]
    nested?: boolean
  }>(),
  {
    active: false,
    collapsed: false,
    badge: undefined,
    badgeLabel: undefined,
    shortcut: undefined,
    nested: false,
  },
)
</script>

<template>
  <DsTooltip v-if="collapsed" :text="label" :shortcut="shortcut" placement="right-start">
    <button
      v-bind="$attrs"
      type="button"
      :aria-label="badge ? `${label}, ${badgeLabel ?? badge}` : label"
      :aria-keyshortcuts="shortcut ? ariaKeys(shortcut) : undefined"
      :aria-current="active ? 'page' : undefined"
      class="relative grid size-9 cursor-pointer place-items-center rounded-lg transition-colors duration-120 ease-out-soft"
      :class="active ? 'bg-accent-soft text-accent-fg' : 'text-fg-muted hover:bg-muted hover:text-fg'"
    >
      <component :is="icon" class="size-[18px]" aria-hidden="true" />
      <span
        v-if="badge"
        class="absolute top-1.5 right-1.5 size-2 rounded-full bg-warning ring-2 ring-canvas"
        aria-hidden="true"
      />
    </button>
  </DsTooltip>
  <button
    v-else
    v-bind="$attrs"
    type="button"
    :aria-label="badge ? `${label}, ${badgeLabel ?? badge}` : undefined"
    :aria-keyshortcuts="shortcut ? ariaKeys(shortcut) : undefined"
    :aria-current="active ? 'page' : undefined"
    class="group flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg text-ui transition-colors duration-120 ease-out-soft"
    :class="[
      nested ? 'h-7 pr-2 pl-9' : 'h-8 px-2.5',
      active ? 'bg-accent-soft font-medium text-accent-fg' : 'text-fg-muted hover:bg-muted hover:text-fg',
    ]"
  >
    <component :is="icon" v-if="!nested" class="size-4 shrink-0" aria-hidden="true" />
    <span class="min-w-0 flex-1 truncate text-left">{{ label }}</span>
    <span
      v-if="badge"
      class="shrink-0 rounded-full bg-warning-soft px-1.5 text-caption leading-[18px] font-medium text-warning tabular-nums"
      aria-hidden="true"
      >{{ badge }}</span
    >
  </button>
</template>
