<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { Sparkles } from 'lucide-vue-next'
import type { AiAction } from '@mongo-manager/shared/browser'
import { connectionsApi, queryKeys } from '@/api/connections'
import { useWorkspaceDialogs } from '@/stores/workspaceDialogs'
import { aiOffered, useAiStatus } from './useAi'
import { useShortcutsStore } from '@/stores/shortcuts'

/** Plan ruling 17: Ask AI, beside the collection tab's sections. */
const props = defineProps<{
  connectionId: string
  db: string
  coll: string
  tabId: string
  actions: AiAction[]
}>()
const { t } = useI18n()
const status = useAiStatus()
const { data: connections } = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
const offered = computed(() =>
  aiOffered(
    status.data.value,
    connections.value?.find((c) => c.id === props.connectionId),
  ),
)
const dialogs = useWorkspaceDialogs()
// W5: the keys as this user bound them.
const shortcuts = useShortcutsStore()
function open(): void {
  if (!offered.value) return
  dialogs.open({
    kind: 'ai',
    connectionId: props.connectionId,
    db: props.db,
    coll: props.coll,
    tabId: props.tabId,
    actions: props.actions,
  })
}
defineExpose({ open, offered })
</script>

<template>
  <button
    v-if="offered"
    type="button"
    :title="`${t('ai.askLabel')} (${shortcuts.text('askAi')})`"
    :aria-keyshortcuts="shortcuts.aria('askAi')"
    class="mb-1.5 inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-accent bg-accent-soft px-2.5 py-1 text-ui font-medium text-accent-fg transition-colors duration-150 hover:bg-accent/20 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
    @click="open"
  >
    <Sparkles class="size-4" aria-hidden="true" />
    <span>{{ t('ai.ask') }}</span>
  </button>
</template>
