<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CompareReport } from '@mongo-manager/shared/browser'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import { describeError } from '@/api/errors'
import { transferApi } from '@/api/transfer'
import { useJobsStore } from '@/jobs/store'
import { useToastStore } from '@/stores/toasts'

/**
 * Phase 3d-2 spec §3.2, §6.4: apply a comparison. Inserts and replacements are on; deleting the
 * target's extra documents is off, and needs the target's name typed to be turned on.
 */
const props = defineProps<{ report: CompareReport; jobId: string }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const jobs = useJobsStore()
const toasts = useToastStore()
const id = useId()

const insert = ref(true)
const replace = ref(true)
const remove = ref(false)
const confirm = ref('')
const confirmPersonal = ref(false)
// Final review I5: inserted and replaced documents carry values the target's rules do not hide.
const personal = computed(() => props.report.missingRules.length > 0 && (insert.value || replace.value))
const busy = ref(false)
const errors = ref<string[]>([])
const name = computed(() => props.report.target.coll ?? props.report.target.db)
const ready = computed(
  () =>
    !busy.value &&
    (insert.value || replace.value || remove.value) &&
    (!remove.value || confirm.value === name.value) &&
    (!personal.value || confirmPersonal.value),
)

async function start(): Promise<void> {
  busy.value = true
  errors.value = []
  try {
    const { job } = await transferApi.startSync({
      compareJobId: props.jobId,
      insert: insert.value,
      replace: replace.value,
      delete: remove.value,
      ...(remove.value ? { confirm: confirm.value } : {}),
      confirmPersonal: personal.value && confirmPersonal.value,
    })
    jobs.upsert(job)
    toasts.push({ kind: 'info', message: t('dataTransfer.sync.started') })
    emit('close')
  } catch (e) {
    errors.value = [describeError(e, t)]
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <DsDialog open :title="t('dataTransfer.sync.title', { name })" size="md" @close="emit('close')">
    <div class="flex flex-col gap-3 text-ui">
      <DsFormErrors :messages="errors" />
      <label class="flex items-center gap-2">
        <input v-model="insert" type="checkbox" class="size-4 accent-accent" />
        {{ t('dataTransfer.sync.insert') }}
      </label>
      <label class="flex items-center gap-2">
        <input v-model="replace" type="checkbox" class="size-4 accent-accent" />
        {{ t('dataTransfer.sync.replace') }}
      </label>
      <label class="flex items-center gap-2">
        <input v-model="remove" data-test="sync-delete" type="checkbox" class="size-4 accent-accent" />
        {{ t('dataTransfer.sync.delete') }}
      </label>
      <div v-if="personal" class="flex flex-col gap-2 rounded-lg border border-warning/30 p-3">
        <p class="font-medium">{{ t('dataTransfer.sync.personalTitle') }}</p>
        <ul class="font-mono text-small">
          <li v-for="r in report.missingRules" :key="r">{{ r }}</li>
        </ul>
        <label class="flex items-center gap-2">
          <input
            v-model="confirmPersonal"
            data-test="sync-confirm-personal"
            type="checkbox"
            class="size-4 accent-accent"
          />
          {{ t('dataTransfer.sync.confirmPersonal') }}
        </label>
      </div>
      <label v-if="remove" :for="`${id}-confirm`" class="flex flex-col gap-1">
        {{ t('dataTransfer.sync.typeName', { name }) }}
        <input
          :id="`${id}-confirm`"
          v-model="confirm"
          data-test="sync-confirm"
          autocomplete="off"
          class="h-8 rounded-md border border-line-strong bg-surface px-2 font-mono text-ui"
        />
      </label>
    </div>
    <template #footer>
      <DsButton variant="ghost" @click="emit('close')">{{ t('dataTransfer.cancel') }}</DsButton>
      <DsButton variant="primary" :disabled="!ready" :loading="busy" @click="start">
        {{ t('dataTransfer.sync.start') }}
      </DsButton>
    </template>
  </DsDialog>
</template>
