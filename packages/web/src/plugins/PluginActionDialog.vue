<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import DsDialog from '@/ds/DsDialog.vue'
import type { CollectionTarget } from '@/api/documents'
import PluginFrame from './PluginFrame.vue'
import { frameKey, localized, type Contribution } from './store'

/** Phase 4b §3: a plugin's document action, opened in a dialog with that document. */
const props = defineProps<{
  action: Contribution | null
  target: CollectionTarget
  documentId: unknown
}>()
const emit = defineEmits<{ close: []; 'open-document': [id: unknown] }>()
const { t, locale } = useI18n()
const title = computed(() =>
  props.action
    ? t('plugins.actionTitle', {
        action: localized(props.action.title, locale.value),
        plugin: localized(props.action.plugin.name, locale.value),
      })
    : '',
)
</script>

<template>
  <DsDialog :open="!!action" size="xl" :title="title" @close="emit('close')">
    <div v-if="action" class="flex h-[min(70vh,40rem)] flex-col">
      <PluginFrame
        :key="frameKey(action)"
        :plugin="action.plugin"
        kind="documentAction"
        :contribution="action.id"
        :target="target"
        :document-id="documentId"
        @open-document="emit('open-document', $event)"
        @applied="emit('close')"
      />
    </div>
  </DsDialog>
</template>
