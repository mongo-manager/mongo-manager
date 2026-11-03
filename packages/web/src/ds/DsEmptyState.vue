<script setup lang="ts">
import type { Component } from 'vue'

/** UI redesign R1 spec §2: what is empty, in a sentence, and what to do about it. */
defineProps<{ icon?: Component; title: string; description?: string }>()
</script>

<template>
  <div class="flex flex-col items-center px-6 py-12 text-center">
    <span
      v-if="icon"
      class="mb-4 grid size-11 place-items-center rounded-xl bg-subtle text-fg-muted ring-1 ring-line ring-inset"
    >
      <component :is="icon" class="size-5" aria-hidden="true" />
    </span>
    <p class="text-title-s font-semibold text-fg">{{ title }}</p>
    <p v-if="description" class="mt-1 max-w-sm text-ui text-fg-muted">{{ description }}</p>
    <div v-if="$slots.actions" class="mt-5 flex flex-wrap items-center justify-center gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
