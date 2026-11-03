<script setup lang="ts">
import { useId } from 'vue'

/** Phase 3d-3b D2: one labelled field of the destination editor, with its help or its error under it. */
defineProps<{
  label: string
  type?: string
  placeholder?: string
  help?: string
  error?: string | null
  readonly?: boolean
  mono?: boolean
  autocomplete?: string
  inputmode?: 'text' | 'decimal' | 'numeric'
  /** Wrong, explained elsewhere (describedby names where). */
  invalid?: boolean
  describedby?: string
}>()
const model = defineModel<string>({ default: '' })
const id = useId()
</script>

<template>
  <div class="flex flex-col gap-1.5 text-ui">
    <label :for="id" class="text-small font-medium text-fg-muted">{{ label }}</label>
    <input
      :id="id"
      v-model="model"
      :type="type ?? 'text'"
      :placeholder="placeholder"
      :readonly="readonly"
      :autocomplete="autocomplete ?? 'off'"
      :inputmode="inputmode"
      spellcheck="false"
      :aria-invalid="error || invalid ? 'true' : undefined"
      :aria-describedby="
        [error || help ? `${id}-note` : '', describedby ?? ''].filter(Boolean).join(' ') || undefined
      "
      class="h-8 w-full rounded-md border bg-surface px-2.5 text-ui text-fg transition-[border-color,box-shadow] duration-120 ease-out-soft placeholder:text-fg-subtle focus:ring-3 focus:outline-none"
      :class="[
        mono ? 'font-mono text-[12.5px]' : '',
        readonly ? 'bg-subtle text-fg-muted' : '',
        error
          ? 'border-danger focus:border-danger focus:ring-danger/20'
          : 'border-line-strong focus:border-focus focus:ring-focus/20',
      ]"
    />
    <p
      v-if="error || help"
      :id="`${id}-note`"
      class="text-small"
      :class="error ? 'text-danger' : 'text-fg-subtle'"
    >
      {{ error || help }}
    </p>
  </div>
</template>
