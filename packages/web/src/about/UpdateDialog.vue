<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Download } from 'lucide-vue-next'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsDialog from '@/ds/DsDialog.vue'
import { ApiError } from '@/api/client'
import { explainError } from '@/api/reasons'
import { useUpdatesStore } from '@/stores/updates'

/**
 * The updater (2026-11-03): what Update does, said before it is done — a database copy, a restart,
 * connections dropping for a moment — and the jobs that would stop, when the server counts some.
 */
const props = defineProps<{ open: boolean; version: string }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const store = useUpdatesStore()
const busy = ref(false)
const jobs = ref<number | null>(null)
const error = ref<string | null>(null)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    jobs.value = null
    error.value = null
  },
)

async function confirm(): Promise<void> {
  busy.value = true
  error.value = null
  try {
    await store.install(props.version, jobs.value !== null)
    emit('close')
  } catch (e) {
    const details =
      e instanceof ApiError ? (e.details as { reason?: string; jobs?: number } | undefined) : undefined
    if (details?.reason === 'update_jobs' && typeof details.jobs === 'number') jobs.value = details.jobs
    else error.value = explainError(e, t)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <DsDialog :open="open" :title="t('about.updates.dialog.title', { version })" @close="emit('close')">
    <div class="flex flex-col gap-3 text-ui text-fg">
      <p>{{ t('about.updates.dialog.body') }}</p>
      <p class="text-fg-muted">{{ t('about.updates.dialog.rollback') }}</p>
      <DsCallout v-if="jobs !== null" tone="warning" data-update-jobs>{{
        t('about.updates.dialog.jobs', { n: jobs }, jobs)
      }}</DsCallout>
      <DsCallout v-if="error" tone="danger">{{ error }}</DsCallout>
    </div>
    <template #footer>
      <DsButton variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</DsButton>
      <DsButton variant="primary" :icon="Download" :loading="busy" @click="confirm">{{
        t('about.updates.dialog.confirm')
      }}</DsButton>
    </template>
  </DsDialog>
</template>
