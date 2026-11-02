<script setup lang="ts">
/** A small spinner for buttons and inline waits; content waits use DsSkeleton instead. */
withDefaults(defineProps<{ size?: number; label?: string }>(), { size: 14, label: undefined })
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 16 16"
    class="shrink-0 animate-spin motion-reduce:animate-none"
    :role="label ? 'status' : undefined"
    :aria-label="label"
    :aria-hidden="label ? undefined : 'true'"
  >
    <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="2" />
    <path
      d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
    />
  </svg>
</template>
