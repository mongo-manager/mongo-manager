<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts" generic="V extends string">
import { ref, type Component } from 'vue'

/**
 * UI redesign R1 revision 2 §2: a segmented control — a radio group with roving arrows, so the whole
 * control is one Tab stop and the arrows choose.
 */
const props = withDefaults(
  defineProps<{
    label: string
    /** A disabled choice is shown, never chosen (by a click or the arrows). */
    options: Array<{ value: V; label: string; icon?: Component; disabled?: boolean }>
    size?: 'sm' | 'md'
    /** Show only the icons (their labels stay as accessible names and tooltips). */
    iconOnly?: boolean
    /** Span the whole width, the choices sharing it alike (a form's one choice, as on sign-in). */
    fill?: boolean
  }>(),
  { size: 'md', iconOnly: false, fill: false },
)
const model = defineModel<V>({ required: true })
const root = ref<HTMLElement | null>(null)

/** The first choice that may be chosen from index on, stepping by step (wrapping round). */
function choose(index: number, step: 1 | -1): void {
  const n = props.options.length
  for (let k = 0; k < n; k++) {
    const i = (((index + k * step) % n) + n) % n
    const option = props.options[i]
    if (!option || option.disabled) continue
    model.value = option.value
    root.value?.querySelectorAll<HTMLElement>('[role="radio"]')[i]?.focus()
    return
  }
}
function onKeydown(event: KeyboardEvent, index: number): void {
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') choose(index + 1, 1)
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') choose(index - 1, -1)
  else if (event.key === 'Home') choose(0, 1)
  else if (event.key === 'End') choose(props.options.length - 1, -1)
  else return
  event.preventDefault()
}
</script>

<template>
  <div
    ref="root"
    role="radiogroup"
    :aria-label="label"
    class="items-center gap-0.5 rounded-lg bg-subtle p-0.5 ring-1 ring-line ring-inset"
    :class="fill ? 'flex w-full' : 'inline-flex max-w-full shrink-0 flex-wrap'"
  >
    <button
      v-for="(option, i) in options"
      :key="option.value"
      type="button"
      role="radio"
      :aria-checked="model === option.value"
      :aria-label="iconOnly ? option.label : undefined"
      :title="iconOnly ? option.label : undefined"
      :tabindex="model === option.value ? 0 : -1"
      :disabled="option.disabled"
      class="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-[background-color,color,box-shadow] duration-120 ease-out-soft focus-visible:outline-offset-0"
      :class="[
        size === 'sm' ? 'h-6 px-2 text-small' : 'h-7 px-2.5 text-ui',
        fill ? 'flex-1' : '',
        iconOnly ? (size === 'sm' ? 'w-7 px-0' : 'w-8 px-0') : '',
        model === option.value
          ? 'bg-surface text-fg shadow-xs ring-1 ring-line'
          : 'text-fg-muted enabled:hover:text-fg disabled:cursor-not-allowed disabled:opacity-50',
      ]"
      @click="model = option.value"
      @keydown="onKeydown($event, i)"
    >
      <component :is="option.icon" v-if="option.icon" class="size-3.5 shrink-0" aria-hidden="true" />
      <span v-if="!iconOnly">{{ option.label }}</span>
    </button>
  </div>
</template>
