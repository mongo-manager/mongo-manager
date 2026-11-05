<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
/** A state as a dot, always with its words for screen readers (no color-only signal). */
defineProps<{ state: 'connected' | 'connecting' | 'error' | 'idle'; label: string }>()
const COLORS = {
  connected: 'bg-accent',
  connecting: 'bg-warning',
  error: 'bg-danger',
  idle: 'bg-line-strong',
} as const
</script>

<template>
  <span class="relative inline-flex size-2 shrink-0">
    <span
      v-if="state === 'connecting'"
      class="absolute inset-0 animate-ping rounded-full bg-warning opacity-60 motion-reduce:animate-none"
      aria-hidden="true"
    />
    <span class="relative size-2 rounded-full" :class="COLORS[state]" aria-hidden="true" />
    <span class="sr-only">{{ label }}</span>
  </span>
</template>
