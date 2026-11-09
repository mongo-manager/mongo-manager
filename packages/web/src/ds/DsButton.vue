<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, type Component } from 'vue'
import DsSpinner from './DsSpinner.vue'

/** UI redesign R1 spec §2: the one button. Primary is the accent; there is at most one per area. */
const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
    size?: 'sm' | 'md' | 'lg'
    loading?: boolean
    type?: 'button' | 'submit'
    icon?: Component
    iconRight?: Component
    block?: boolean
    /**
     * A prop, not a fall-through attribute: `disabled: false` from a caller once replaced the button's
     * own and made a loading button clickable (review of the connection form fix, 2026-10-16).
     */
    disabled?: boolean
  }>(),
  {
    variant: 'secondary',
    size: 'md',
    loading: false,
    type: 'button',
    icon: undefined,
    iconRight: undefined,
    block: false,
    disabled: false,
  },
)

const SIZES = {
  sm: 'h-7 gap-1.5 px-2.5 text-small',
  md: 'h-8 gap-1.5 px-3 text-ui',
  lg: 'h-9 gap-2 px-3.5 text-ui',
} as const
const VARIANTS = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover shadow-[inset_0_1px_0_rgb(255_255_255/0.08)]',
  secondary: 'border border-line-strong bg-surface text-fg hover:bg-subtle',
  ghost: 'text-fg-muted hover:bg-subtle hover:text-fg',
  danger: 'bg-danger text-on-danger hover:opacity-90',
} as const
const classes = computed(() => [
  'inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md font-medium whitespace-nowrap select-none',
  'transition-[background-color,border-color,color,opacity,transform] duration-120 ease-out-soft active:translate-y-px',
  'disabled:pointer-events-none disabled:opacity-50',
  // Off but focusable, so its reason (aria-describedby) is read and a click can say what is missing.
  'aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:active:translate-y-0',
  SIZES[props.size],
  VARIANTS[props.variant],
  props.block ? 'w-full' : '',
])
</script>

<template>
  <button
    :type="type"
    :disabled="loading || disabled"
    :aria-busy="loading ? 'true' : undefined"
    :class="classes"
  >
    <DsSpinner v-if="loading" :size="size === 'sm' ? 12 : 14" />
    <component :is="icon" v-else-if="icon" class="size-4 shrink-0" aria-hidden="true" />
    <slot />
    <component :is="iconRight" v-if="iconRight" class="size-4 shrink-0 opacity-70" aria-hidden="true" />
  </button>
</template>
