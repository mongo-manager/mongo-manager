<script setup lang="ts">
import ProductMark from '@/workspace/ProductMark.vue'
defineProps<{ title: string; subtitle?: string }>()
</script>

<template>
  <main class="flex min-h-full items-center justify-center p-4">
    <section class="w-full max-w-sm rounded-card border border-line bg-surface p-8 shadow-sm">
      <p class="mb-6 flex items-center gap-2 text-title-m font-semibold text-fg">
        <ProductMark :size="28" />
        {{ $t('app.name') }}
      </p>
      <h1 class="text-title-l font-semibold text-fg">{{ title }}</h1>
      <p v-if="subtitle" class="mt-1 text-ui text-fg-subtle">{{ subtitle }}</p>
      <div class="mt-6"><slot /></div>
    </section>
  </main>
</template>
