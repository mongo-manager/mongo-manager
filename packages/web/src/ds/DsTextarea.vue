<script setup lang="ts">
import { useId } from 'vue'

defineProps<{
  label: string
  rows?: number
  mono?: boolean
  error?: string
  hint?: string
  placeholder?: string
  /** Select the whole value on focus, so typing replaces it (masked secrets). */
  selectOnFocus?: boolean
}>()
const model = defineModel<string>({ required: true })
const id = useId()
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <label :for="id" class="text-small font-medium text-fg-muted">{{ label }}</label>
    <textarea
      :id="id"
      v-model="model"
      :rows="rows ?? 4"
      :placeholder="placeholder"
      spellcheck="false"
      autocomplete="off"
      :aria-invalid="error ? 'true' : undefined"
      :aria-describedby="error ? `${id}-error` : hint ? `${id}-hint` : undefined"
      class="px-3 py-2 w-full rounded-lg border bg-surface text-ui text-fg shadow-xs transition-[border-color,box-shadow] duration-120 ease-out-soft placeholder:text-fg-subtle hover:border-fg-subtle/60 focus:ring-3 focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-subtle disabled:opacity-70"
      :class="[
        mono ? 'font-mono text-[12.5px]' : '',
        error
          ? 'border-danger focus:border-danger focus:ring-danger/20'
          : 'border-line-strong focus:border-focus focus:ring-focus/20',
      ]"
      @focus="selectOnFocus && ($event.target as HTMLInputElement).select()"
    />
    <p v-if="error" :id="`${id}-error`" class="text-small text-danger">{{ error }}</p>
    <p v-else-if="hint" :id="`${id}-hint`" class="text-small text-fg-subtle">{{ hint }}</p>
  </div>
</template>
