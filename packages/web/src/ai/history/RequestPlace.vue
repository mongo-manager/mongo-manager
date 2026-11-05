<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { ExternalLink, SearchX } from 'lucide-vue-next'
import { useTabsStore } from '@/stores/tabs'
import { openCollectionTab } from '@/workspace/openTabs'
import NamespaceChip from './NamespaceChip.vue'
import { useHistoryWords } from './historyWords'
import { useRequestPlace } from './reopen'

/**
 * User review 2026-10-09: where a request was asked, large at the top of its page, one click away —
 * and, when its connection or collection is gone, said so instead of an "open" that opens nothing.
 */
const props = defineProps<{ connectionId: string | null; namespace: string }>()
const w = useHistoryWords()
const tabs = useTabsStore()
const { presence, gone, openable } = useRequestPlace(() => props)
function open(): void {
  const dot = props.namespace.indexOf('.')
  openCollectionTab(tabs, props.connectionId!, props.namespace.slice(0, dot), props.namespace.slice(dot + 1))
}
</script>

<template>
  <div data-request-place class="flex min-w-0 flex-wrap items-center gap-2">
    <span class="text-small font-medium text-fg-subtle">{{ w.t('aiHistory.where') }}</span>
    <NamespaceChip :connection-id="connectionId" :namespace="namespace" large />
    <button
      v-if="openable"
      type="button"
      class="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-small font-medium text-accent-fg hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-focus"
      @click="open"
    >
      <ExternalLink class="size-3.5" aria-hidden="true" />{{ w.t('aiHistory.openCollection') }}
    </button>
    <span v-else-if="gone" data-place-gone class="inline-flex items-center gap-1 text-small text-warning">
      <SearchX class="size-3.5" aria-hidden="true" />{{
        presence === 'noConnection' ? w.t('aiHistory.connectionGone') : w.t('aiHistory.collectionGone')
      }}
    </span>
  </div>
</template>
