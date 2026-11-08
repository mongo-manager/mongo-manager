<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { ArrowRight } from 'lucide-vue-next'

/** Widgets wave 2: a widget's link to the page where more is seen and done (as Operations' "see all"). */
const emit = defineEmits<{ open: [] }>()
</script>

<template>
  <button
    type="button"
    class="inline-flex cursor-pointer items-center gap-1 self-start rounded-md px-1 py-0.5 text-small font-medium text-accent-fg hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:min-h-11"
    @click="emit('open')"
  >
    <slot /><ArrowRight class="size-3.5" aria-hidden="true" />
  </button>
</template>
