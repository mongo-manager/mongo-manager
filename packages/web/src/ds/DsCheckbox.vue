<script setup lang="ts">
import { useId } from 'vue'

defineProps<{ label: string; hint?: string; disabled?: boolean }>()
const model = defineModel<boolean>({ required: true })
const id = useId()
</script>

<template>
  <div class="flex items-start gap-2.5">
    <input
      :id="id"
      v-model="model"
      type="checkbox"
      :disabled="disabled"
      class="mt-0.5 size-4 shrink-0 cursor-pointer rounded accent-accent disabled:cursor-not-allowed disabled:opacity-50"
      :aria-describedby="hint ? `${id}-hint` : undefined"
    />
    <div class="flex min-w-0 flex-col gap-0.5">
      <label :for="id" class="cursor-pointer text-ui text-fg">{{ label }}</label>
      <p v-if="hint" :id="`${id}-hint`" class="text-small text-fg-subtle">{{ hint }}</p>
    </div>
  </div>
</template>
