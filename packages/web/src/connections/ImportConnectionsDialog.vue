<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import { SECRET_MASK } from '@mongo-manager/shared/browser'
import { connectionsApi, queryKeys } from '@/api/connections'
import { formatBytes } from '@/format'
import { useToastStore } from '@/stores/toasts'
import { useFormErrors } from './formErrors'

class InvalidFile extends Error {}
class TooLarge extends Error {}

/** The server accepts request bodies up to 1 MB; larger files are refused before reading them. */
const MAX_BYTES = 1024 * 1024

const emit = defineEmits<{ close: [] }>()
const { t, locale } = useI18n()
const queryClient = useQueryClient()
const toasts = useToastStore()
const inputId = useId()
const file = ref<File | null>(null)
const { general, reset, showError } = useFormErrors({ flatten: true })

function onFile(event: Event): void {
  file.value = (event.target as HTMLInputElement).files?.[0] ?? null
  reset()
}

let hadMaskedSecrets = false

async function readFile(): Promise<unknown> {
  if (file.value!.size > MAX_BYTES) throw new TooLarge()
  try {
    const text = await file.value!.text()
    hadMaskedSecrets = text.includes(SECRET_MASK)
    const data = JSON.parse(text) as { format?: unknown } | null
    if (data?.format === 'mongo-manager-connections') return data
  } catch {
    // not JSON: reported below
  }
  throw new InvalidFile()
}

const { mutate: importFile, isPending } = useMutation({
  mutationFn: async () => connectionsApi.importAll(await readFile()),
  onMutate: reset,
  onSuccess: async ({ created, libraryPathsDropped, refusedOptionsDropped }) => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.connections, exact: true })
    toasts.push({ kind: 'success', message: t('transfer.imported', { count: created }, created) })
    // Masks are not secrets: the server drops them, so those connections still need their passwords.
    if (hadMaskedSecrets)
      toasts.push({ kind: 'info', message: t('transfer.secretsDropped'), timeoutMs: 10000 })
    // Security review I2: a library path is code the server runs; the server never imports one.
    if (libraryPathsDropped)
      toasts.push({
        kind: 'info',
        message: t('transfer.libraryPathsDropped', { count: libraryPathsDropped }, libraryPathsDropped),
        timeoutMs: 10000,
      })
    // Fourth review: a file saved before timeoutMS was refused comes in without it.
    if (refusedOptionsDropped)
      toasts.push({
        kind: 'info',
        message: t('transfer.refusedOptionsDropped', { count: refusedOptionsDropped }, refusedOptionsDropped),
        timeoutMs: 10000,
      })
    emit('close')
  },
  onError: (e) => {
    if (e instanceof TooLarge)
      general.value = [t('transfer.tooLarge', { size: formatBytes(MAX_BYTES, locale.value) })]
    else if (e instanceof InvalidFile) general.value = [t('transfer.invalidFile')]
    else showError(e)
  },
})
</script>

<template>
  <DsDialog open :title="t('transfer.import')" size="sm" @close="emit('close')">
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-1.5">
        <label :for="inputId" class="text-small font-medium text-fg">{{ t('transfer.file') }}</label>
        <input
          :id="inputId"
          type="file"
          accept=".json,application/json"
          class="text-ui text-fg-muted file:mr-3 file:h-8 file:cursor-pointer file:rounded-lg file:border file:border-line-strong file:bg-surface file:px-3 file:text-ui file:font-medium file:text-fg hover:file:bg-subtle"
          @change="onFile"
        />
      </div>
      <DsFormErrors :messages="general" />
    </div>
    <template #footer>
      <DsButton @click="emit('close')">{{ t('common.cancel') }}</DsButton>
      <DsButton variant="primary" :disabled="!file" :loading="isPending" @click="importFile()">
        {{ t('transfer.importButton') }}
      </DsButton>
    </template>
  </DsDialog>
</template>
