<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import DsInput from '@/ds/DsInput.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import { connectionsApi, queryKeys } from '@/api/connections'
import { useTabsStore } from '@/stores/tabs'
import { useToastStore } from '@/stores/toasts'
import { openDatabaseTab } from '@/workspace/openTabs'
import { useFormErrors } from './formErrors'

const props = defineProps<{ connectionId: string }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const queryClient = useQueryClient()
const tabs = useTabsStore()
const toasts = useToastStore()
const name = ref('')
const collection = ref('')
const { general, reset, showError, errorFor } = useFormErrors()

const { mutate: create, isPending } = useMutation({
  mutationFn: () =>
    connectionsApi.createDatabase(props.connectionId, name.value.trim(), collection.value.trim()),
  onMutate: reset,
  onSuccess: async () => {
    const db = name.value.trim()
    await queryClient.invalidateQueries({ queryKey: queryKeys.databases(props.connectionId), exact: true })
    toasts.push({ kind: 'success', message: t('database.created', { name: db }) })
    openDatabaseTab(tabs, props.connectionId, db)
    emit('close')
  },
  onError: showError,
})
</script>

<template>
  <DsDialog open :title="t('database.new')" size="sm" @close="emit('close')">
    <form class="flex flex-col gap-4" novalidate @submit.prevent="create()">
      <DsInput
        v-model="name"
        :label="t('database.name')"
        :error="errorFor('name')"
        autocomplete="off"
        required
      />
      <DsInput
        v-model="collection"
        :label="t('database.firstCollection')"
        :hint="t('database.firstCollectionHint')"
        :error="errorFor('collection')"
        autocomplete="off"
        required
      />
      <DsFormErrors :messages="general" />
      <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
    </form>
    <template #footer>
      <DsButton @click="emit('close')">{{ t('common.cancel') }}</DsButton>
      <DsButton variant="primary" :loading="isPending" @click="create()">{{ t('database.create') }}</DsButton>
    </template>
  </DsDialog>
</template>
