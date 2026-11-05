<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import DsInput from '@/ds/DsInput.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import { connectionsApi, queryKeys } from '@/api/connections'
import type { WorkspaceTab } from '@/stores/tabs'
import { useTabsStore } from '@/stores/tabs'
import { useToastStore } from '@/stores/toasts'
import { useFormErrors } from './formErrors'

const props = defineProps<{ connectionId: string; db: string; coll: string }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const queryClient = useQueryClient()
const tabs = useTabsStore()
const toasts = useToastStore()
const to = ref(props.coll)
const { general, reset, showError, errorFor } = useFormErrors()

const isOld = (tab: WorkspaceTab) =>
  tab.kind === 'collection' &&
  tab.params.connectionId === props.connectionId &&
  tab.params.db === props.db &&
  tab.params.coll === props.coll

const { mutate: rename, isPending } = useMutation({
  mutationFn: () =>
    connectionsApi.renameCollection(props.connectionId, props.db, props.coll, to.value.trim()),
  onMutate: reset,
  onSuccess: async ({ name }) => {
    // Its tab is renamed in its place, shown only if it was (review 2026-10-12, minor 18).
    const old = tabs.tabs.find(isOld)
    // A plugin page on it goes on with the new name (review I4).
    for (const page of tabs.tabs)
      if (
        page.kind === 'pluginPage' &&
        page.params.connectionId === props.connectionId &&
        page.params.db === props.db &&
        page.params.coll === props.coll
      )
        tabs.setView(page.id, { coll: name })
    // What was read under either name (pages, counts, indexes, stats) goes: a collection made later
    // with one of them starts empty (review 2026-10-13, web).
    for (const coll of [props.coll, name])
      queryClient.removeQueries({ queryKey: [...queryKeys.collections(props.connectionId, props.db), coll] })
    await queryClient.invalidateQueries({
      queryKey: queryKeys.collections(props.connectionId, props.db),
      exact: true,
    })
    if (old)
      tabs.replace(old.id, {
        kind: 'collection',
        title: `${props.db}.${name}`,
        params: { connectionId: props.connectionId, db: props.db, coll: name },
      })
    toasts.push({ kind: 'success', message: t('collection.renamed', { name }) })
    emit('close')
  },
  onError: showError,
})
</script>

<template>
  <DsDialog open :title="t('collection.rename')" size="sm" @close="emit('close')">
    <form class="flex flex-col gap-4" novalidate @submit.prevent="rename()">
      <DsInput
        v-model="to"
        :label="t('collection.renameTo')"
        :error="errorFor('to')"
        autocomplete="off"
        required
      />
      <DsFormErrors :messages="general" />
      <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
    </form>
    <template #footer>
      <DsButton @click="emit('close')">{{ t('common.cancel') }}</DsButton>
      <DsButton variant="primary" :loading="isPending" @click="rename()">{{ t('menu.rename') }}</DsButton>
    </template>
  </DsDialog>
</template>
