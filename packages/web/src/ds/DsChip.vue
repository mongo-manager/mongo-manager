<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { useId, type Component } from 'vue'
import { X } from 'lucide-vue-next'

/**
 * UI redesign R1 revision 2 §2: a filter or suggestion chip. A removable chip removes with its button,
 * Delete or Backspace; a clickable one is a button of its own.
 */
withDefaults(
  defineProps<{
    label: string
    icon?: Component
    removable?: boolean
    removeLabel?: string
    pressed?: boolean
    /** A removable chip's description: how to remove it from the keyboard (W1 review, minor 10). */
    hint?: string
  }>(),
  { icon: undefined, removable: false, removeLabel: undefined, pressed: undefined, hint: undefined },
)
const hintId = useId()
const emit = defineEmits<{ remove: []; click: [] }>()
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault()
    emit('remove')
  }
}
</script>

<template>
  <span
    v-if="removable"
    data-chip
    tabindex="0"
    role="group"
    :aria-label="label"
    aria-keyshortcuts="Delete Backspace"
    :aria-describedby="hint ? hintId : undefined"
    class="inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md border border-line bg-subtle pr-1 pl-2 text-small text-fg"
    @keydown="onKeydown"
  >
    <component :is="icon" v-if="icon" class="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
    <span class="min-w-0 truncate font-mono text-[12px]">{{ label }}</span>
    <span v-if="hint" :id="hintId" class="sr-only">{{ hint }}</span>
    <button
      type="button"
      tabindex="-1"
      class="grid size-5 shrink-0 cursor-pointer place-items-center rounded text-fg-subtle hover:bg-muted hover:text-fg"
      :aria-label="removeLabel ?? label"
      @click="emit('remove')"
    >
      <X class="size-3" aria-hidden="true" />
    </button>
  </span>
  <button
    v-else
    type="button"
    data-chip
    :aria-pressed="pressed"
    class="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-small font-medium whitespace-nowrap transition-[background-color,border-color,color] duration-120 ease-out-soft"
    :class="
      pressed
        ? 'border-transparent bg-accent-soft text-accent-fg'
        : 'border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg'
    "
    @click="emit('click')"
  >
    <component :is="icon" v-if="icon" class="size-3.5 shrink-0" aria-hidden="true" />
    {{ label }}
  </button>
</template>
