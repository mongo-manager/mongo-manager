<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { Bot, RotateCw } from 'lucide-vue-next'
import type { AiAgentPolicy } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import { aiAgentApi, aiAgentKeys } from '@/api/aiAgent'
import { describeError } from '@/api/errors'
import { useToastStore } from '@/stores/toasts'
import { useDialogStore } from '@/stores/dialogs'
import { useAssistantStore } from './chat/store'

/**
 * The AI database manager (design 2026-10-25, A2): what the agent may do for everyone on this server
 * — off, read only or full — saved as it is chosen. Each person still turns agent mode on themselves.
 */
type Policy = AiAgentPolicy['policy']
const { t } = useI18n()
const toasts = useToastStore()
const queryClient = useQueryClient()
const assistant = useAssistantStore()
const current = useQuery({ queryKey: aiAgentKeys.policy, queryFn: aiAgentApi.policy })
const options = computed(() =>
  (['off', 'read', 'full'] as const).map((value) => ({ value, label: t(`ai.agentPolicy.${value}`) })),
)
const value = computed(() => current.data.value?.policy ?? null)
const dialogs = useDialogStore()
const saving = ref(false)
const WIDTH: Record<Policy, number> = { off: 0, read: 1, full: 2 }
/**
 * Review of A2 (I3): the control's arrows choose as they move — narrowing what the agent may do for
 * everyone is asked first, and one save goes at a time (a choice made meanwhile is not taken).
 */
async function choose(policy: Policy): Promise<void> {
  const from = value.value
  if (policy === from || saving.value || !from) return
  // Busy from the question on (re-review, nit): a choice made while it is open asks nothing more.
  saving.value = true
  try {
    if (
      WIDTH[policy] < WIDTH[from] &&
      !(await dialogs.confirm({
        title: t('ai.agentPolicy.confirmTitle'),
        message: t(`ai.agentPolicy.confirm.${policy}`),
        confirmLabel: t(`ai.agentPolicy.${policy}`),
      }))
    )
      return
    const saved = await aiAgentApi.setPolicy(policy)
    queryClient.setQueryData(aiAgentKeys.policy, saved)
    // The assistant's own switch says it at once (offered, read only, or off).
    void assistant.loadAgentMode()
    toasts.push({ kind: 'success', message: t('ai.agentPolicy.saved') })
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section
    data-agent-policy
    aria-labelledby="ai-agent-policy"
    class="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5 shadow-xs"
  >
    <header class="flex items-start gap-3">
      <span
        class="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-fg"
        aria-hidden="true"
      >
        <Bot class="size-5" />
      </span>
      <div class="min-w-0">
        <h3 id="ai-agent-policy" class="text-title-s font-semibold text-fg">
          {{ t('ai.agentPolicy.title') }}
        </h3>
        <p class="max-w-3xl text-ui text-fg-muted">{{ t('ai.agentPolicy.intro') }}</p>
      </div>
    </header>
    <DsCallout v-if="current.isError.value" tone="danger">
      {{ describeError(current.error.value, t) }}
      <template #action>
        <DsButton size="sm" :icon="RotateCw" @click="current.refetch()">{{ t('common.retry') }}</DsButton>
      </template>
    </DsCallout>
    <div v-else-if="value" class="flex flex-col gap-2" :aria-busy="saving">
      <DsSegmented
        :model-value="value"
        :label="t('ai.agentPolicy.label')"
        :options="options"
        aria-describedby="ai-agent-policy-hint"
        @update:model-value="(p: Policy) => void choose(p)"
      />
      <p id="ai-agent-policy-hint" class="text-small text-fg-muted">{{ t(`ai.agentPolicy.${value}Hint`) }}</p>
    </div>
    <DsSkeleton v-else class="h-8 w-72 rounded-lg" />
  </section>
</template>
