<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { ref } from 'vue'
import { Link2, Share2, Users, X } from 'lucide-vue-next'
import type { AiHistoryItem } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import { useHistoryWords } from './historyWords'
import { useSharing } from './sharing'

/**
 * User review 2026-10-09: a request's sharing — its owner shares it with the team (when there is a
 * team to share with), copies its link and takes it back (even with no teammate left: share review
 * I3); a teammate reads who shared it, read-only.
 */
const props = defineProps<{ item: AiHistoryItem }>()
const w = useHistoryWords()
const sharing = useSharing()
const busy = ref(false)
async function set(on: boolean): Promise<void> {
  busy.value = true
  try {
    await sharing.set(props.item.id, on)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <p
    v-if="item.mine === false"
    data-request-shared
    class="flex items-center gap-2 rounded-xl border border-line bg-info-soft/60 px-4 py-2.5 text-ui text-fg-muted"
  >
    <Users class="size-4 shrink-0 text-info" aria-hidden="true" />
    {{ w.t('aiHistory.share.by', { name: item.sharedBy ?? '' }) }}
  </p>
  <div
    v-else-if="item.shared"
    data-request-shared
    class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-accent-soft/50 px-4 py-2.5"
  >
    <Users class="size-4 shrink-0 text-accent-fg" aria-hidden="true" />
    <span class="min-w-0 flex-1 text-ui text-fg">
      <span class="font-medium">{{ w.t('aiHistory.share.sharedTitle') }}</span>
      <span class="text-fg-muted">
        ·
        {{
          item.thread && item.action !== 'chat'
            ? w.t('aiHistory.share.sharedHintChain')
            : w.t('aiHistory.share.sharedHint')
        }}</span
      >
    </span>
    <DsButton size="sm" :icon="Link2" @click="sharing.copyLink(item.id)">
      {{ w.t('aiHistory.share.copyLink') }}
    </DsButton>
    <DsButton size="sm" variant="ghost" :icon="X" :loading="busy" @click="set(false)">
      {{ w.t('aiHistory.share.unshare') }}
    </DsButton>
  </div>
  <p
    v-else-if="sharing.available.value && item.shareable === false"
    data-request-unshareable
    class="text-small text-fg-subtle"
  >
    {{ w.t('aiHistory.share.unshareable') }}
  </p>
  <div v-else-if="sharing.available.value" class="flex">
    <DsButton size="sm" :icon="Share2" :loading="busy" data-request-share @click="set(true)">
      {{ w.t('aiHistory.share.share') }}
    </DsButton>
  </div>
</template>
