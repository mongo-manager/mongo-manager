<script setup lang="ts">
withDefaults(defineProps<{ tone?: 'neutral' | 'accent' | 'danger' | 'warning' | 'info' | 'success' }>(), {
  tone: 'neutral',
})
const TONES = {
  neutral: 'bg-subtle text-fg-muted ring-1 ring-line ring-inset',
  accent: 'bg-accent-soft text-accent-fg',
  danger: 'bg-danger-soft text-danger',
  warning: 'bg-warning-soft text-warning',
  info: 'bg-info-soft text-info',
  success: 'bg-success-soft text-success',
} as const
</script>

<template>
  <span
    class="inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-caption font-medium whitespace-nowrap tabular-nums"
    :class="TONES[tone]"
    ><slot
  /></span>
</template>
