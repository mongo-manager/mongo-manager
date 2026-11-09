<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { MessageSquare, RotateCw, Table, Trash2 } from 'lucide-vue-next'
import type { AiHistoryItem } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import JobStatusIcon from '@/jobs/JobStatusIcon.vue'
import { aiHistoryApi, aiHistoryKeys } from '@/api/aiHistory'
import { describeError } from '@/api/errors'
import { useAssistantStore } from '@/ai/chat/store'
import { ACTION_ICONS, useHistoryWords } from './historyWords'
import RequestContent from './RequestContent.vue'
import RequestPlace from './RequestPlace.vue'
import ShareBar from './ShareBar.vue'
import { reopenableResult, useReopen, useRequestPlace } from './reopen'
import DsCallout from '@/ds/DsCallout.vue'

/**
 * User review 2026-10-09: one AI request in full — what was asked, the answer, what it wrote, what
 * left for the provider, the tokens, the cost and the time; its query reopened where it belongs.
 */
const props = defineProps<{ item: AiHistoryItem }>()
const emit = defineEmits<{ remove: [item: AiHistoryItem] }>()
const w = useHistoryWords()
const assistant = useAssistantStore()
const reopenIn = useReopen()

const full = useQuery({
  queryKey: computed(() => aiHistoryKeys.item(props.item.id)),
  queryFn: () => aiHistoryApi.get(props.item.id),
})
const content = computed(() => full.data.value?.content ?? null)
/** A query or pipeline it wrote opens in its collection, as the AI panel inserts it. */
const place = useRequestPlace(() => props.item)
const result = computed(() => (place.openable.value ? reopenableResult(props.item, content.value) : null))
const reopenable = computed(() => result.value !== null)
const reopen = () => reopenIn(props.item, result.value!)
function openChat(): void {
  if (!props.item.chatId) return
  void assistant.openChat(props.item.chatId)
  assistant.show()
}
const when = (ms: number) =>
  new Date(ms).toLocaleString(w.locale.value, { dateStyle: 'medium', timeStyle: 'medium' })
</script>

<template>
  <div class="flex flex-col gap-5" data-request-details>
    <header class="flex flex-wrap items-start gap-3">
      <JobStatusIcon class="mt-1" :status="w.status(item)" :label="w.outcome(item)" />
      <div class="min-w-0 flex-1">
        <h2 tabindex="-1" class="flex items-center gap-2 text-title-l font-semibold text-fg outline-none">
          <component :is="ACTION_ICONS[item.action]" class="size-5 text-fg-subtle" aria-hidden="true" />
          {{ w.action(item.action) }}
        </h2>
        <p class="text-ui" :class="w.answered(item) ? 'text-fg-muted' : 'text-danger'">
          {{ w.outcome(item) }}
        </p>
        <RequestPlace
          v-if="item.namespace"
          class="mt-2"
          :connection-id="item.connectionId"
          :namespace="item.namespace"
        />
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <DsButton v-if="reopenable" size="sm" variant="primary" :icon="Table" @click="reopen">
          {{ w.t('aiHistory.reopen') }}
        </DsButton>
        <!-- A teammate's shared request is read-only: its chat and its removing are its owner's. -->
        <template v-if="item.mine !== false">
          <DsButton v-if="item.chatId" size="sm" :icon="MessageSquare" @click="openChat">
            {{ w.t('aiHistory.openChat') }}
          </DsButton>
          <DsButton size="sm" variant="ghost" :icon="Trash2" @click="emit('remove', item)">
            {{ w.t('aiHistory.remove') }}
          </DsButton>
        </template>
      </div>
    </header>
    <ShareBar :item="item" />

    <div class="grid grid-cols-1 items-start gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <aside class="rounded-xl border border-line bg-surface p-4 shadow-xs lg:sticky lg:top-0">
        <dl class="grid gap-y-3 text-ui">
          <div>
            <dt class="text-small text-fg-subtle">{{ w.t('aiHistory.when') }}</dt>
            <dd class="text-fg tabular-nums">{{ when(item.at) }} · {{ w.ms(item.ms) }}</dd>
          </div>
          <div>
            <dt class="text-small text-fg-subtle">{{ w.t('aiHistory.model') }}</dt>
            <dd class="min-w-0 break-words text-fg">
              {{ item.provider.name }} · <span class="font-mono text-small">{{ item.provider.model }}</span>
            </dd>
          </div>
          <div>
            <dt class="text-small text-fg-subtle">{{ w.t('aiHistory.tokens') }}</dt>
            <dd data-request-tokens class="text-fg tabular-nums">
              {{
                w.t('aiHistory.tokensLine', {
                  input: w.exact(item.usage.input),
                  output: w.exact(item.usage.output),
                  total: w.exact(item.usage.input + item.usage.output),
                })
              }}
            </dd>
          </div>
          <div>
            <dt class="text-small text-fg-subtle">{{ w.t('aiHistory.cost') }}</dt>
            <dd data-request-cost class="text-fg tabular-nums">
              {{ item.cost ? w.money(item.cost) : w.t('aiHistory.noPrice') }}
            </dd>
          </div>
        </dl>
      </aside>
      <div class="flex min-w-0 flex-col gap-5">
        <div
          v-if="full.isPending.value"
          class="flex flex-col gap-2 py-2"
          role="status"
          :aria-label="w.t('aiHistory.loading')"
        >
          <DsSkeleton v-for="n in 3" :key="n" class="h-5" />
        </div>
        <DsCallout v-else-if="full.isError.value" tone="danger">
          {{ describeError(full.error.value, w.t) }}
          <template #action>
            <DsButton size="sm" :icon="RotateCw" @click="full.refetch()">{{ w.t('common.retry') }}</DsButton>
          </template>
        </DsCallout>
        <p v-else-if="!content" class="rounded-lg bg-subtle px-3 py-2 text-ui text-fg-muted">
          {{ w.t('aiHistory.notKeptLong') }}
        </p>
        <RequestContent v-else :content="content" />
      </div>
    </div>
  </div>
</template>
