<script setup lang="ts">
/**
 * UI redesign R1 revision 2 §7: the product mark — a rounded tile in the accent with an "M" whose
 * strokes meet like two linked documents. Decorative unless it is given a label.
 */
withDefaults(defineProps<{ size?: number; label?: string }>(), { size: 28, label: undefined })
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 32 32"
    :role="label ? 'img' : undefined"
    :aria-label="label"
    :aria-hidden="label ? undefined : 'true'"
    class="shrink-0"
  >
    <rect width="32" height="32" rx="9" class="fill-accent" />
    <path
      d="M9.5 22.5V11.8c0-1 1.2-1.5 1.9-.8L16 15.6l4.6-4.6c.7-.7 1.9-.2 1.9.8v10.7"
      fill="none"
      class="stroke-on-accent"
      stroke-width="2.6"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <circle cx="16" cy="22.5" r="1.7" class="fill-on-accent" />
  </svg>
</template>
