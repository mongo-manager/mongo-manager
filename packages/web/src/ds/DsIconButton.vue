<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, type Component } from 'vue'
import { ariaKeys } from '@/workspace/shortcuts'
import DsTooltip from './DsTooltip.vue'
import type { Placement } from './position'

/** UI redesign R1 spec §2: an icon-only control — its name is required and shown as its tooltip. */
defineOptions({ inheritAttrs: false })
const props = withDefaults(
  defineProps<{
    label: string
    icon: Component
    size?: 'sm' | 'md' | 'lg'
    variant?: 'ghost' | 'secondary'
    /** Drawn as on (its panel is open); the state itself is told by aria-expanded or aria-pressed. */
    active?: boolean
    shortcut?: string[]
    placement?: Placement
    badge?: string | number
  }>(),
  { size: 'md', variant: 'ghost', shortcut: undefined, placement: 'bottom', badge: undefined },
)
const SIZES = { sm: 'size-7', md: 'size-8', lg: 'size-9' } as const
const classes = computed(() => [
  'relative inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md',
  'transition-[background-color,color] duration-120 ease-out-soft disabled:pointer-events-none disabled:opacity-50',
  SIZES[props.size],
  props.active
    ? 'bg-accent-soft text-accent-fg'
    : props.variant === 'secondary'
      ? 'border border-line-strong bg-surface text-fg-muted hover:bg-subtle hover:text-fg'
      : 'text-fg-muted hover:bg-subtle hover:text-fg',
])
</script>

<template>
  <DsTooltip :text="label" :shortcut="shortcut" :placement="placement">
    <button
      type="button"
      v-bind="$attrs"
      :aria-label="label"
      :aria-keyshortcuts="shortcut ? ariaKeys(shortcut) : undefined"
      :class="classes"
    >
      <component :is="icon" class="size-4" aria-hidden="true" />
      <span
        v-if="badge !== undefined && badge !== ''"
        class="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] leading-4 font-semibold text-on-accent tabular-nums"
        aria-hidden="true"
        >{{ badge }}</span
      >
      <slot />
    </button>
  </DsTooltip>
</template>
