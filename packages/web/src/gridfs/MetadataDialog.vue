<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { TriangleAlert } from 'lucide-vue-next'
import type { GridFsFile } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsDialog from '@/ds/DsDialog.vue'
import { cautionText } from '@/documents/caution'

/**
 * Phase 4b §1: a file's metadata as JSON (relaxed EJSON), checked before it is saved; empty clears it.
 */
const props = defineProps<{
  open: boolean
  name: string
  metadata: Record<string, unknown> | null
  /** Data review 2026-10-13 (M3): a field the app would change if saved, said before saving. */
  caution?: GridFsFile['caution']
}>()
const emit = defineEmits<{ close: []; save: [metadata: Record<string, unknown> | null] }>()
const { t } = useI18n()
const text = ref('')
const error = ref('')
watch(
  () => [props.open, props.metadata] as const,
  ([open]) => {
    if (!open) return
    text.value = props.metadata ? JSON.stringify(props.metadata, null, 2) : ''
    error.value = ''
  },
  { immediate: true },
)
function save(): void {
  if (!text.value.trim()) {
    emit('save', null)
    return
  }
  try {
    const value = JSON.parse(text.value) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    emit('save', value as Record<string, unknown>)
  } catch {
    error.value = t('gridfs.metadata.invalid')
  }
}
</script>

<template>
  <DsDialog :open="open" size="lg" :title="t('gridfs.metadata.title', { name })" @close="emit('close')">
    <div data-gridfs-metadata class="flex flex-col gap-2">
      <p
        v-if="caution"
        data-caution
        role="note"
        class="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning-soft px-3 py-2 text-small text-warning"
      >
        <TriangleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>{{ cautionText(t, caution, 'refused') }}</span>
      </p>
      <label class="text-small font-medium text-fg-muted" for="gridfs-metadata">{{
        t('gridfs.metadata.label')
      }}</label>
      <textarea
        id="gridfs-metadata"
        v-model="text"
        rows="12"
        spellcheck="false"
        class="w-full rounded-md border bg-surface p-2.5 font-mono text-[12.5px] text-fg focus:border-focus focus:ring-3 focus:ring-focus/20 focus:outline-none"
        :class="error ? 'border-danger' : 'border-line-strong'"
        :aria-invalid="error ? 'true' : undefined"
        :aria-describedby="error ? 'gridfs-metadata-error' : 'gridfs-metadata-hint'"
      />
      <p v-if="error" id="gridfs-metadata-error" role="alert" class="text-small text-danger">{{ error }}</p>
      <p v-else id="gridfs-metadata-hint" class="text-small text-fg-subtle">
        {{ t('gridfs.metadata.hint') }}
      </p>
    </div>
    <template #footer>
      <DsButton variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</DsButton>
      <DsButton variant="primary" @click="save">{{ t('gridfs.metadata.save') }}</DsButton>
    </template>
  </DsDialog>
</template>
