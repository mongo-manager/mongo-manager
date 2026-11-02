<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import DsSwitch from '@/ds/DsSwitch.vue'
import { describeError } from '@/api/errors'
import { useToastStore } from '@/stores/toasts'
import { useAssistantStore } from '@/ai/chat/store'

/**
 * The AI database manager (design 2026-10-25, A2): the person's agent-mode switch in their
 * preferences — the same one the assistant shows — and why it is not offered when an administrator
 * turned the agent off.
 */
const { t } = useI18n()
const toasts = useToastStore()
const store = useAssistantStore()
onMounted(() => {
  if (store.agentMode === null) void store.loadAgentMode()
})
const shown = computed(() => store.agentAssistant)
const hint = computed(() =>
  store.agentPolicy === 'off'
    ? t('ai.agent.policyOff')
    : store.agentPolicy === 'read'
      ? t('ai.agent.policyRead')
      : t('account.preferences.agentHint'),
)
async function toggle(on: boolean): Promise<void> {
  try {
    await store.setAgentMode(on)
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  }
}
</script>

<template>
  <div v-if="shown" data-agent-mode-setting>
    <DsSwitch
      :model-value="store.agentAvailable && store.agentMode === true"
      :label="t('account.preferences.agent')"
      :hint="hint"
      :disabled="store.busy || !store.agentAvailable"
      @update:model-value="(on: boolean) => void toggle(on)"
    />
  </div>
</template>
