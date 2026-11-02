<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { Plus, ShieldCheck, Sparkles } from 'lucide-vue-next'
import { AI_LIMITS, type AiProviderView } from '@mongo-manager/shared/browser'
import DsCallout from '@/ds/DsCallout.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import DsPageHeader from '@/ds/DsPageHeader.vue'
import DsButton from '@/ds/DsButton.vue'
import { aiApi, aiKeys } from '@/api/ai'
import { aiHistoryKeys } from '@/api/aiHistory'
import { describeError } from '@/api/errors'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import AiProviderCard from './AiProviderCard.vue'
import AiProviderEditor from './AiProviderEditor.vue'
import AiHistorySettings from './AiHistorySettings.vue'
import AiAgentPolicySettings from './AiAgentPolicySettings.vue'
import { useAiWords } from './words'
import { useAiStatus } from './useAi'

/** Phase 4a-1 spec §6: an administrator's AI providers. */
const { t } = useI18n()
const words = useAiWords()
const queryClient = useQueryClient()
const toasts = useToastStore()
const dialogs = useDialogStore()
const list = useQuery({ queryKey: aiKeys.providers, queryFn: aiApi.providers })
// Final review I6: the server's limits, read-only.
const status = useAiStatus()
const limits = computed(() => status.data.value?.limits)
// Final review minor 5: the privacy line says how long chats are kept.
const retention = computed(() => {
  const days = status.data.value?.chat?.days
  return days === 0
    ? t('ai.settings.retentionMemory')
    : t('ai.settings.retentionDays', { days: days ?? 30 }, days ?? 30)
})
const providers = computed(() => list.data.value ?? [])
// Review of R3–R5, minor 20: the server keeps this many; Add says why it is off.
const atLimit = computed(() => providers.value.length >= AI_LIMITS.providers)
const editing = ref<AiProviderView | null | 'new'>(null)
const testing = ref<string | null>(null)

const refresh = () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: aiKeys.providers }),
    queryClient.invalidateQueries({ queryKey: aiKeys.status }),
    // A price entered prices the provider's earlier requests: the AI history is counted again.
    queryClient.invalidateQueries({ queryKey: aiHistoryKeys.all }),
  ])

async function test(p: AiProviderView): Promise<void> {
  testing.value = p.id
  try {
    const r = await aiApi.test(p.id)
    toasts.push(
      r.outcome === 'ok'
        ? { kind: 'success', message: t('ai.settings.testPassed', { ms: r.ms }) }
        : { kind: 'error', message: words.reason(r.outcome) },
    )
    await refresh()
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  } finally {
    testing.value = null
  }
}
async function remove(p: AiProviderView): Promise<void> {
  const ok = await dialogs.confirm({
    title: t('ai.settings.removeTitle', { name: p.name }),
    message: t('ai.settings.removeMessage'),
    confirmLabel: t('ai.settings.remove'),
    danger: true,
  })
  if (!ok) return
  try {
    await aiApi.remove(p.id)
    await refresh()
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  }
}
async function makeDefault(p: AiProviderView): Promise<void> {
  try {
    await aiApi.update(p.id, { isDefault: true })
    await refresh()
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  }
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <DsPageHeader :title="t('ai.settings.title')" :icon="Sparkles" :description="t('ai.settings.intro')">
      <template #actions>
        <DsButton size="sm" variant="primary" :disabled="atLimit" @click="editing = 'new'">
          <Plus class="size-4" aria-hidden="true" />{{ t('ai.settings.add') }}
        </DsButton>
      </template>
    </DsPageHeader>
    <div class="min-h-0 flex-1 overflow-auto">
      <div class="mx-auto flex max-w-6xl flex-col gap-6 p-6">
        <aside class="flex gap-3 rounded-xl border border-line bg-subtle p-4 text-ui text-fg">
          <ShieldCheck class="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
          <p>{{ t('ai.settings.privacy', { retention }) }}</p>
        </aside>
        <DsCallout v-if="atLimit" tone="info">{{
          t('ai.settings.atLimit', { n: AI_LIMITS.providers })
        }}</DsCallout>
        <div v-if="list.isPending.value" aria-busy="true" class="flex flex-col gap-3">
          <span class="sr-only" role="status">{{ t('app.loading') }}</span
          ><DsSkeleton v-for="i in 3" :key="i" class="h-20 rounded-card" />
        </div>
        <DsCallout v-else-if="list.isError.value" tone="danger"
          >{{ describeError(list.error.value, t)
          }}<template #action
            ><DsButton size="sm" @click="list.refetch()">{{ t('common.retry') }}</DsButton></template
          ></DsCallout
        >
        <div
          v-else-if="!providers.length"
          class="rounded-2xl border border-dashed border-line-strong p-10 text-center"
        >
          <p class="font-medium text-fg">{{ t('ai.settings.emptyTitle') }}</p>
          <p class="mx-auto mt-1 max-w-xl text-ui text-fg-muted">
            {{ t('ai.settings.empty') }}
          </p>
        </div>
        <!-- Phase 4a-2: as many columns as the tab has room for (the assistant panel may take some). -->
        <div v-else class="grid grid-cols-[repeat(auto-fill,minmax(min(18rem,100%),1fr))] gap-4">
          <AiProviderCard
            v-for="p in providers"
            :key="p.id"
            :provider="p"
            :testing="testing === p.id"
            @test="test(p)"
            @edit="editing = p"
            @remove="remove(p)"
            @make-default="makeDefault(p)"
          />
        </div>
        <AiAgentPolicySettings />
        <AiHistorySettings />
        <p v-if="limits" data-ai-limits class="text-ui text-fg">
          {{ t('ai.settings.limits', limits) }}
        </p>
        <p class="text-small text-fg-subtle">{{ t('ai.settings.networks') }}</p>
      </div>
    </div>
    <AiProviderEditor
      v-if="editing !== null"
      :provider="editing === 'new' ? null : editing"
      @close="editing = null"
      @saved="refresh"
    />
  </div>
</template>
