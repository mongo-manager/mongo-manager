<script setup lang="ts">
import { inject } from 'vue'
import { useI18n } from 'vue-i18n'
import DsField from '@/ds/DsField.vue'
import { DRAFT_KEY } from './useDestinationDraft'

/** Phase 3d-3b §2.2: a folder on this server, inside MM_BACKUP_FOLDER_ROOTS (the server checks it). */
const { draft } = inject(DRAFT_KEY)!
const { t } = useI18n()
</script>

<template>
  <section class="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5">
    <DsField v-model="draft.name" :label="t('destinations.editor.name')" />
    <DsField
      :model-value="String(draft.config.path ?? '')"
      :label="t('destinations.editor.path')"
      :help="t('destinations.type.folderHelp')"
      placeholder="/srv/backups/mongo-manager"
      mono
      @update:model-value="(v) => (draft.config.path = v)"
    />
  </section>
</template>
