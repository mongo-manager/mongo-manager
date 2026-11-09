<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { FileUp } from 'lucide-vue-next'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import DsTextarea from '@/ds/DsTextarea.vue'
import DsInput from '@/ds/DsInput.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import { keysApi } from '@/api/schedules'
import { useToastStore } from '@/stores/toasts'
import { readKitFile, useKeyError } from './kit'

/** Spec §1.1 import: a kit pasted or read from its file; the key opens backups, new ones use it once active. */
const emit = defineEmits<{ close: []; done: [name: string] }>()
const { t } = useI18n()
const toasts = useToastStore()
const keyError = useKeyError()
const kit = ref('')
const name = ref('')
const busy = ref(false)
const errors = ref<string[]>([])

async function onFile(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    kit.value = await readKitFile(file)
    errors.value = []
  } catch (e) {
    errors.value = [keyError(e)]
  }
}

async function submit(): Promise<void> {
  if (!kit.value.trim()) return
  busy.value = true
  errors.value = []
  try {
    const view = await keysApi.import(kit.value, name.value.trim() || undefined)
    kit.value = ''
    toasts.push({ kind: 'success', message: t('keys.importFlow.done', { name: view.name }) })
    emit('done', view.name)
    emit('close')
  } catch (e) {
    errors.value = [keyError(e)]
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <DsDialog open :title="t('keys.importFlow.title')" size="md" @close="emit('close')">
    <form id="kit-import" class="flex flex-col gap-4 text-ui" @submit.prevent="submit">
      <p class="text-fg-muted">{{ t('keys.importFlow.lead') }}</p>
      <DsTextarea v-model="kit" :label="t('keys.importFlow.kit')" :rows="6" mono />
      <label
        class="inline-flex w-fit cursor-pointer items-center gap-2 rounded-lg border border-line-strong px-3 py-2 font-medium text-fg hover:bg-subtle focus-within:ring-2 focus-within:ring-focus"
      >
        <FileUp class="size-4" aria-hidden="true" />{{ t('keys.importFlow.file') }}
        <input type="file" accept=".txt,text/plain" class="sr-only" @change="onFile" />
      </label>
      <DsInput v-model="name" :label="t('keys.importFlow.name')" :maxlength="64" />
    </form>
    <DsFormErrors v-if="errors.length" class="mt-3" :messages="errors" />
    <template #footer>
      <DsButton variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</DsButton>
      <DsButton type="submit" form="kit-import" variant="primary" :loading="busy" :disabled="!kit.trim()">{{
        t('keys.importFlow.submit')
      }}</DsButton>
    </template>
  </DsDialog>
</template>
