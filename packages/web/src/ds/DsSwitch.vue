<script setup lang="ts">
import { useId } from 'vue'

/**
 * An on/off setting that takes effect as a choice in a form (a checkbox with role="switch"): Space
 * toggles it, its label and hint are read with it.
 */
defineProps<{ label: string; hint?: string; disabled?: boolean }>()
const model = defineModel<boolean>({ required: true })
const id = useId()
</script>

<template>
  <div class="flex items-start gap-3">
    <span class="relative mt-0.5 inline-flex shrink-0">
      <input
        :id="id"
        v-model="model"
        type="checkbox"
        role="switch"
        :disabled="disabled"
        :aria-describedby="hint ? `${id}-hint` : undefined"
        class="peer absolute inset-0 m-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      />
      <span
        aria-hidden="true"
        class="pointer-events-none relative h-5 w-9 rounded-full bg-line-strong transition-colors duration-160 peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus peer-disabled:opacity-50 after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-surface after:shadow-xs after:transition-transform after:duration-160 peer-checked:after:translate-x-4 motion-reduce:transition-none motion-reduce:after:transition-none"
      />
    </span>
    <div class="flex min-w-0 flex-col gap-0.5">
      <label :for="id" class="cursor-pointer text-ui text-fg">{{ label }}</label>
      <p v-if="hint" :id="`${id}-hint`" class="text-small text-fg-subtle">{{ hint }}</p>
    </div>
  </div>
</template>
