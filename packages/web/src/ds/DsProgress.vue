<script setup lang="ts">
import { computed } from 'vue'
/**
 * UI redesign R2–R5 spec §1: a progress bar. With a value (0–1) it says how far along; without one it
 * says only that something is under way (indeterminate), as a progressbar with no value. As a meter
 * it says how full something is (a quota, a cache) rather than how far a task has come.
 */
const props = withDefaults(
  defineProps<{
    label: string
    /** 0–1; undefined when how far along is not known. */
    value?: number
    tone?: 'accent' | 'danger' | 'warning' | 'success'
    size?: 'sm' | 'md'
    /**
     * The value as words for a screen reader ("40 of 100 MB"), when a percentage says too little; while
     * how far is not known, what is known ("still running, 3 min").
     */
    valueText?: string
    /** How full something is (role meter), not a task's progress. */
    meter?: boolean
  }>(),
  { value: undefined, tone: 'accent', size: 'sm', valueText: undefined, meter: false },
)
const percent = computed(() =>
  props.value === undefined ? undefined : Math.round(Math.min(1, Math.max(0, props.value)) * 100),
)
const fill = computed(
  () =>
    ({ accent: 'bg-accent', danger: 'bg-danger', warning: 'bg-warning', success: 'bg-success' })[props.tone],
)
</script>

<template>
  <div
    :role="meter ? 'meter' : 'progressbar'"
    :aria-label="label"
    aria-valuemin="0"
    aria-valuemax="100"
    :aria-valuenow="percent"
    :aria-valuetext="valueText"
    class="relative w-full overflow-hidden rounded-full bg-muted"
    :class="size === 'md' ? 'h-2' : 'h-1.5'"
  >
    <div
      v-if="percent !== undefined"
      class="h-full rounded-full transition-[width] duration-220 ease-out-soft motion-reduce:transition-none"
      :class="fill"
      :style="{ width: `${percent}%` }"
    />
    <div
      v-else
      class="absolute inset-y-0 w-1/3 animate-[ds-indeterminate_1.4s_ease-in-out_infinite] rounded-full motion-reduce:animate-none motion-reduce:w-full motion-reduce:opacity-40"
      :class="fill"
    />
  </div>
</template>
