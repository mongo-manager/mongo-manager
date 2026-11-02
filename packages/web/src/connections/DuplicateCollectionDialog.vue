<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMutation } from '@tanstack/vue-query'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import DsInput from '@/ds/DsInput.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import { ApiError } from '@/api/client'
import { connectionsApi } from '@/api/connections'
import { useToastStore } from '@/stores/toasts'
import { useJobsStore } from '@/jobs/store'
import { useFormErrors } from './formErrors'

/** Copies every document into a new collection of the same database ($out on the server). */
const props = defineProps<{ connectionId: string; db: string; coll: string }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const toasts = useToastStore()
const jobs = useJobsStore()
const to = ref(`${props.coll}_copy`)
const { general, reset, showError, errorFor } = useFormErrors()
const nameTaken = ref(false)

const { mutate: duplicate, isPending } = useMutation({
  mutationFn: () =>
    connectionsApi.duplicateCollection(props.connectionId, props.db, props.coll, to.value.trim()),
  onMutate: () => {
    reset()
    nameTaken.value = false
  },
  // Phase 1h: the copy runs as a job. The tray follows it; the tree refreshes when it is done.
  onSuccess: ({ job }) => {
    jobs.upsert(job)
    toasts.push({ kind: 'info', message: t('collection.duplicateStarted') })
    emit('close')
  },
  // The target name exists already: say so at the field, not as a generic conflict.
  onError: (e) => {
    if (e instanceof ApiError && e.code === 'CONFLICT') nameTaken.value = true
    else showError(e)
  },
})
</script>

<template>
  <DsDialog open :title="t('collection.duplicate')" size="sm" @close="emit('close')">
    <form class="flex flex-col gap-4" novalidate @submit.prevent="duplicate()">
      <DsInput
        v-model="to"
        :label="t('collection.duplicateTo')"
        :hint="t('collection.duplicateHint')"
        :error="nameTaken ? t('collection.nameTaken') : errorFor('to')"
        autocomplete="off"
        required
      />
      <DsFormErrors :messages="general" />
      <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
    </form>
    <template #footer>
      <DsButton @click="emit('close')">{{ t('common.cancel') }}</DsButton>
      <DsButton variant="primary" :loading="isPending" @click="duplicate()">{{
        t('menu.duplicate')
      }}</DsButton>
    </template>
  </DsDialog>
</template>
