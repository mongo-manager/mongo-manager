<script setup lang="ts">
import { useId } from 'vue'

defineProps<{ title: string; description?: string }>()
const titleId = useId()
</script>

<template>
  <!-- A region named by its title; the title takes focus when the page's section list brings you here. -->
  <section :aria-labelledby="titleId" class="scroll-mt-5 rounded-card border border-line bg-surface p-5">
    <h3
      :id="titleId"
      tabindex="-1"
      class="rounded-sm text-title-s font-semibold text-fg outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      {{ title }}
    </h3>
    <p v-if="description" class="mt-1 text-ui text-fg-subtle">{{ description }}</p>
    <div class="mt-4"><slot /></div>
  </section>
</template>
