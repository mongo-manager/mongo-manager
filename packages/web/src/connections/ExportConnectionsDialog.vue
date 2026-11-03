<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMutation } from '@tanstack/vue-query'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import DsInput from '@/ds/DsInput.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import { connectionsApi } from '@/api/connections'
import { downloadJson } from '@/download'
import { useSessionStore } from '@/stores/session'
import { useToastStore } from '@/stores/toasts'
import { useFormErrors } from './formErrors'

const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const session = useSessionStore()
const toasts = useToastStore()
const includeSecrets = ref(false)
const password = ref('')
const team = computed(() => session.status?.mode === 'team')
const { general, reset, showError } = useFormErrors({ flatten: true })

const { mutate: exportAll, isPending } = useMutation({
  mutationFn: () =>
    connectionsApi.exportAll(
      includeSecrets.value,
      includeSecrets.value && team.value ? password.value : undefined,
    ),
  onMutate: reset,
  onSuccess: (file) => {
    downloadJson(file, `mongo-manager-connections-${file.exportedAt.slice(0, 10)}.json`)
    toasts.push({
      kind: 'success',
      message: t('transfer.exported', { count: file.connections.length }, file.connections.length),
    })
    emit('close')
  },
  onError: showError,
})
</script>

<template>
  <DsDialog open :title="t('transfer.export')" size="sm" @close="emit('close')">
    <form class="flex flex-col gap-4" novalidate @submit.prevent="exportAll()">
      <DsCheckbox v-model="includeSecrets" :label="t('transfer.includeSecrets')" />
      <p
        v-if="includeSecrets"
        class="rounded-lg border border-warning/25 bg-warning-soft px-3 py-2.5 text-ui text-warning"
      >
        {{ t('transfer.includeSecretsWarning') }}
      </p>
      <DsInput
        v-if="includeSecrets && team"
        v-model="password"
        type="password"
        :label="t('transfer.password')"
        autocomplete="current-password"
      />
      <DsFormErrors :messages="general" />
      <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
    </form>
    <template #footer>
      <DsButton @click="emit('close')">{{ t('common.cancel') }}</DsButton>
      <DsButton variant="primary" :loading="isPending" @click="exportAll()">{{
        t('transfer.download')
      }}</DsButton>
    </template>
  </DsDialog>
</template>
