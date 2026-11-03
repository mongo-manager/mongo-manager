<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Clipboard, Download, Trash2, X } from 'lucide-vue-next'

/**
 * UI redesign R1 checkpoint 3: what can be done with the documents selected on the page — copied,
 * exported or deleted together (only what this caller may do).
 */
defineProps<{ count: number; canWrite: boolean; canExport: boolean }>()
const emit = defineEmits<{ copy: []; export: []; delete: []; clear: [] }>()
const { t } = useI18n()
const action =
  'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-small font-medium transition-colors duration-120'
</script>

<template>
  <div
    data-selection-bar
    role="region"
    :aria-label="t('documents.selection.label')"
    class="mx-4 mb-2 flex animate-rise flex-wrap items-center gap-1.5 rounded-xl border border-accent/40 bg-accent-soft px-3 py-1.5 text-ui"
  >
    <span class="mr-1 font-medium text-accent-fg tabular-nums">{{
      t('documents.selection.count', { n: count }, count)
    }}</span>
    <button type="button" :class="[action, 'text-fg hover:bg-surface']" @click="emit('copy')">
      <Clipboard class="size-3.5" aria-hidden="true" />{{ t('documents.copy') }}
    </button>
    <button
      v-if="canExport"
      type="button"
      :class="[action, 'text-fg hover:bg-surface']"
      @click="emit('export')"
    >
      <Download class="size-3.5" aria-hidden="true" />{{ t('documents.selection.export') }}
    </button>
    <button
      v-if="canWrite"
      type="button"
      :class="[action, 'text-danger hover:bg-danger-soft']"
      @click="emit('delete')"
    >
      <Trash2 class="size-3.5" aria-hidden="true" />{{ t('documents.selection.delete') }}
    </button>
    <button
      type="button"
      :class="[action, 'ml-auto text-fg-muted hover:bg-surface hover:text-fg']"
      @click="emit('clear')"
    >
      <X class="size-3.5" aria-hidden="true" />{{ t('documents.selection.clear') }}
    </button>
  </div>
</template>
