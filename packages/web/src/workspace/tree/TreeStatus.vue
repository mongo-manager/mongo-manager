<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import DsSpinner from '@/ds/DsSpinner.vue'

defineProps<{ level: number; text: string; loading?: boolean; error?: boolean }>()
defineEmits<{ retry: [] }>()
</script>

<template>
  <li
    role="none"
    class="flex min-h-7 items-center gap-2 py-1 pr-2 text-small text-fg-subtle"
    :style="{ paddingLeft: `${(level - 1) * 14 + 26}px` }"
  >
    <DsSpinner v-if="loading" :size="12" />
    <span
      :role="error ? 'alert' : undefined"
      class="min-w-0 flex-1 break-words"
      :class="error ? 'text-danger' : ''"
    >
      {{ text }}
    </span>
    <button
      v-if="error"
      type="button"
      class="cursor-pointer rounded-md px-1.5 py-0.5 font-medium text-accent-fg hover:bg-accent-soft"
      @click="$emit('retry')"
    >
      {{ $t('tree.retry') }}
    </button>
  </li>
</template>
