<script setup lang="ts">
import { computed } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import type { AiAgentPlace, AiHistoryContent } from '@mongo-manager/shared/browser'
import DsCodeBlock from '@/ds/DsCodeBlock.vue'
import SafeMarkdown from '@/ai/SafeMarkdown.vue'
import AgentSteps from '@/ai/chat/AgentSteps.vue'
import { storedSteps } from '@/ai/chat/store'
import { connectionsApi, queryKeys } from '@/api/connections'
import { useTabsStore } from '@/stores/tabs'
import { openCollectionTab, openDatabaseTab } from '@/workspace/openTabs'
import { useHistoryWords } from './historyWords'

/** User review 2026-10-09: what one request asked and was answered, what it wrote, and what was sent. */
const props = defineProps<{ content: AiHistoryContent }>()
const w = useHistoryWords()
const tabs = useTabsStore()
/**
 * User report 2026-10-25: an agent turn's steps — the changes it proposed among them — as its chat
 * draws them; a connection not in this person's list is said so, never by its id.
 */
const steps = computed(() => storedSteps(props.content.steps ?? []))
const { data: connections } = useQuery({
  queryKey: queryKeys.connections,
  queryFn: connectionsApi.list,
  enabled: () => steps.value.length > 0,
})
const listed = (id: string) => !!connections.value?.some((c) => c.id === id)
const connectionName = (id: string) =>
  connections.value === undefined
    ? ''
    : (connections.value.find((c) => c.id === id)?.name ?? w.t('ai.agent.connectionNotListed'))
function open(p: AiAgentPlace): void {
  const c = connections.value?.find((x) => x.id === p.connectionId)
  if (!c) return
  // A step opens only with its database (AgentSteps): a collection, or the database.
  if (p.db && p.coll) openCollectionTab(tabs, c.id, p.db, p.coll)
  else if (p.db) openDatabaseTab(tabs, c.id, p.db)
}
const pretty = (v: unknown) => JSON.stringify(v, null, 2)
</script>

<template>
  <section class="flex flex-col gap-1.5">
    <h4 class="text-caption font-semibold tracking-wide text-fg-subtle uppercase">
      {{ w.t('aiHistory.asked') }}
    </h4>
    <p
      data-request-prompt
      class="rounded-lg border border-line bg-surface p-3 text-ui break-words whitespace-pre-wrap text-fg"
    >
      {{ content.prompt || w.t('aiHistory.noWords') }}
    </p>
  </section>
  <section v-if="steps.length" data-request-steps class="flex flex-col gap-1.5">
    <h4 class="text-caption font-semibold tracking-wide text-fg-subtle uppercase">
      {{ w.t('aiHistory.agentSteps') }}
    </h4>
    <AgentSteps
      :steps="steps"
      :live="false"
      record
      :listed="listed"
      :connection-name="connectionName"
      @open="open"
    />
  </section>
  <section class="flex flex-col gap-1.5">
    <h4 class="text-caption font-semibold tracking-wide text-fg-subtle uppercase">
      {{ w.t('aiHistory.answered') }}
    </h4>
    <div data-request-answer class="rounded-lg border border-line bg-surface p-3 text-ui break-words text-fg">
      <SafeMarkdown v-if="content.answer" :source="content.answer" />
      <p v-else class="text-fg-subtle">{{ w.t('aiHistory.noAnswer') }}</p>
    </div>
  </section>
  <section v-if="content.result" data-request-result class="flex flex-col gap-1.5">
    <h4 class="text-caption font-semibold tracking-wide text-fg-subtle uppercase">
      {{ w.t('aiHistory.result') }}
    </h4>
    <DsCodeBlock
      :code="pretty(content.result)"
      :label="w.t('aiHistory.result')"
      :copy-label="w.t('aiHistory.copyResult')"
      full
    />
  </section>
  <p v-if="content.samples" data-request-samples class="text-small text-fg-muted">
    {{ w.t('aiHistory.samplesSent', { n: content.samples }, content.samples) }}
  </p>
  <details v-if="content.sent" class="group rounded-lg border border-line">
    <summary class="cursor-pointer px-3 py-2 text-ui text-fg-muted select-none hover:text-fg">
      {{ w.t('aiHistory.sent') }}
    </summary>
    <div class="border-t border-line p-2">
      <DsCodeBlock :code="pretty(content.sent)" :copy-label="w.t('aiHistory.copySent')" full />
    </div>
  </details>
</template>
