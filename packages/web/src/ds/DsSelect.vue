<script setup lang="ts" generic="T extends string">
import { useId } from 'vue'
import { ChevronDown } from 'lucide-vue-next'

/**
 * A labelled native select in the design kit's measure (DsInput's height, border and focus ring), so
 * a form's fields line up (phase 4c §5: the old kit's select stood taller than its neighbours).
 */
withDefaults(
  defineProps<{
    label: string
    options: ReadonlyArray<{ value: T; label: string }>
    hideLabel?: boolean
    size?: 'sm' | 'md'
    hint?: string
    error?: string
    disabled?: boolean
  }>(),
  { size: 'md', hint: undefined, error: undefined, disabled: false },
)
const model = defineModel<T>({ required: true })
const id = useId()
</script>

<template>
  <div class="flex min-w-0 flex-col gap-1.5">
    <label :for="id" :class="hideLabel ? 'sr-only' : 'text-small font-medium text-fg-muted'">{{
      label
    }}</label>
    <div class="relative">
      <select
        :id="id"
        v-model="model"
        :disabled="disabled"
        :aria-invalid="error ? 'true' : undefined"
        :aria-describedby="error ? `${id}-error` : hint ? `${id}-hint` : undefined"
        class="w-full min-w-0 cursor-pointer appearance-none rounded-md border bg-surface pr-8 pl-2.5 text-ui text-fg transition-[border-color,box-shadow] duration-120 ease-out-soft hover:border-fg-subtle focus:border-focus focus:ring-3 focus:ring-focus/20 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        :class="[
          size === 'sm' ? 'h-7' : 'h-8',
          error ? 'border-danger focus:border-danger focus:ring-danger/20' : 'border-line-strong',
        ]"
      >
        <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
      <ChevronDown
        class="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-fg-subtle"
        aria-hidden="true"
      />
    </div>
    <p v-if="error" :id="`${id}-error`" class="text-small text-danger">{{ error }}</p>
    <p v-else-if="hint" :id="`${id}-hint`" class="text-small text-fg-subtle">{{ hint }}</p>
  </div>
</template>
