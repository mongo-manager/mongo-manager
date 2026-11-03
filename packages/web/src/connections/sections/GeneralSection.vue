<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight } from 'lucide-vue-next'
import {
  AI_AGENT_CONNECTION_TOOLS,
  AI_AGENT_WRITE_TOOLS,
  type AiAgentTool,
} from '@mongo-manager/shared/browser'
import DsInput from '@/ds/DsInput.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import DsSelect from '@/ds/DsSelect.vue'
import { useConnectionForm } from '../formContext'

const { t } = useI18n()
const { form, errorFor } = useConnectionForm()

/**
 * Design 2026-10-25 (C5): the agent's tools an administrator turns off on this connection, as the
 * MongoDB MCP server's disabled tools — reads and changes apart; a change tool is moot while the
 * agent may not change anything here.
 */
// Review of C5 (I3): only the tools that act on a connection — the others have nothing to turn off here.
const WRITES = new Set<string>(AI_AGENT_WRITE_TOOLS)
const GROUPS = computed(() => [
  { key: 'read', tools: AI_AGENT_CONNECTION_TOOLS.filter((t) => !WRITES.has(t)) },
  { key: 'write', tools: AI_AGENT_CONNECTION_TOOLS.filter((t) => WRITES.has(t)) },
])
const allowed = (tool: AiAgentTool) => !form.aiAgentToolsOff.includes(tool)
function setAllowed(tool: AiAgentTool, on: boolean): void {
  const off = new Set(form.aiAgentToolsOff)
  if (on) off.delete(tool)
  else off.add(tool)
  // Review of C5 (minor 4): in the agent's order, so a form toggled back is unchanged.
  form.aiAgentToolsOff = AI_AGENT_CONNECTION_TOOLS.filter((t) => off.has(t))
}
// Second review of C5 (M2): the list's own error, or one of its items' (aiAgentToolsOff.3).
const toolsError = computed(
  () =>
    errorFor('aiAgentToolsOff') ??
    AI_AGENT_CONNECTION_TOOLS.map((_, i) => errorFor(`aiAgentToolsOff.${i}`)).find((e) => e !== undefined),
)
const writesOffHint = useId()
/** Review of C5 (minor 5): a save the server refused for them opens the list to show why. */
const open = ref(false)
watch(toolsError, (e) => {
  if (e) open.value = true
})
function toggled(event: Event): void {
  open.value = (event.target as HTMLDetailsElement).open
}
</script>

<template>
  <DsInput
    v-model="form.group"
    :label="t('connection.group')"
    :error="errorFor('group')"
    autocomplete="off"
  />
  <DsCheckbox v-model="form.readOnly" :label="t('connection.readOnly')" />
  <DsSelect
    v-model="form.aiPolicy"
    :label="t('connection.aiPolicy')"
    :hint="t('connection.aiPolicyHint')"
    :options="[
      { value: 'any', label: t('connection.aiPolicies.any') },
      { value: 'local', label: t('connection.aiPolicies.local') },
      { value: 'off', label: t('connection.aiPolicies.off') },
    ]"
  />
  <!-- W6.3: an administrator turns the agent's changes off here; each still needs the person's click. -->
  <DsCheckbox
    v-if="form.aiPolicy !== 'off'"
    v-model="form.aiAgentWrites"
    :label="t('connection.aiAgentWrites')"
    :hint="t('connection.aiAgentWritesHint')"
  />
  <details
    v-if="form.aiPolicy !== 'off'"
    :open="open"
    class="group rounded-lg border border-line"
    data-agent-tools
    @toggle="toggled"
  >
    <summary
      class="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-ui text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none [&::-webkit-details-marker]:hidden"
    >
      <ChevronRight
        class="size-4 shrink-0 text-fg-muted transition-transform group-open:rotate-90 motion-reduce:transition-none"
        aria-hidden="true"
      />
      <span class="flex-1 font-medium">{{ t('connection.aiAgentTools') }}</span>
      <span class="text-small text-fg-muted" data-agent-tools-count>{{
        form.aiAgentToolsOff.length
          ? t('connection.aiAgentToolsOff', { n: form.aiAgentToolsOff.length }, form.aiAgentToolsOff.length)
          : t('connection.aiAgentToolsAll')
      }}</span>
    </summary>
    <div class="flex flex-col gap-3 border-t border-line px-3 py-3">
      <p class="text-small text-fg-muted">{{ t('connection.aiAgentToolsHint') }}</p>
      <p v-if="toolsError" class="text-small text-danger" role="alert" data-agent-tools-error>
        {{ toolsError }}
      </p>
      <fieldset
        v-for="group in GROUPS"
        :key="group.key"
        class="flex flex-col gap-1.5"
        :aria-describedby="group.key === 'write' && !form.aiAgentWrites ? writesOffHint : undefined"
      >
        <legend class="mb-1 text-small font-medium text-fg-muted">
          {{ t(`connection.aiAgentToolGroups.${group.key}`) }}
        </legend>
        <p
          v-if="group.key === 'write' && !form.aiAgentWrites"
          :id="writesOffHint"
          class="-mt-0.5 mb-1 text-small text-fg-subtle"
          data-agent-tools-writes-off
        >
          {{ t('connection.aiAgentToolsWritesOff') }}
        </p>
        <div class="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
          <DsCheckbox
            v-for="tool in group.tools"
            :key="tool"
            :model-value="allowed(tool)"
            :label="t(`ai.agent.tool.${tool}`)"
            :disabled="group.key === 'write' && !form.aiAgentWrites"
            :data-agent-tool="tool"
            @update:model-value="(on: boolean) => setAllowed(tool, on)"
          />
        </div>
      </fieldset>
    </div>
  </details>
</template>
