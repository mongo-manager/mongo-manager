<script setup lang="ts">
import { CircleAlert } from 'lucide-vue-next'

defineProps<{ messages: string[] }>()
</script>

<template>
  <div
    v-if="messages.length > 0"
    role="alert"
    class="flex items-start gap-2.5 rounded-lg border border-danger/25 bg-danger-soft px-3 py-2.5 text-ui text-fg"
  >
    <CircleAlert class="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
    <div class="min-w-0 flex-1">
      <p v-for="message in messages" :key="message" class="break-words">{{ message }}</p>
    </div>
  </div>
</template>
