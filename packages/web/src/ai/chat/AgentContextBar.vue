<script setup lang="ts">
import { useI18n } from 'vue-i18n'

/**
 * W6.3 §1, §4: what an agent message carries — the words, the names of the connections the person
 * may use (never an address), the tab they look at — and, only when they allow it for this message,
 * documents' values (as sample documents are allowed in a chat turn).
 */
defineProps<{
  /** The tab the person looks at, in words ("shop.orders on Prod"), or null. */
  focus: string | null
  /** Why documents cannot be allowed (provider or policy), or null. */
  documentsRefused: string | null
}>()
const documents = defineModel<boolean>('documents', { required: true })
const { t } = useI18n()
</script>

<template>
  <div class="flex flex-col gap-2" data-agent-context>
    <div class="flex flex-wrap items-center gap-1.5" role="group" :aria-label="t('ai.chat.context.label')">
      <span
        v-if="focus"
        class="inline-flex h-7 items-center rounded-full border border-line px-2.5 text-xs text-fg-muted"
      >
        {{ t('ai.agent.context.focus', { place: focus }) }}
      </span>
      <button
        type="button"
        :class="[
          'inline-flex h-7 cursor-pointer items-center gap-1 rounded-full border px-2.5 text-xs transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
          documents
            ? 'border-accent bg-accent-soft text-accent-fg'
            : 'border-line text-fg-muted hover:bg-subtle',
        ]"
        :aria-pressed="documents"
        :disabled="!!documentsRefused"
        :title="
          documentsRefused ?? `${t('ai.agent.context.documentsHint')}. ${t('ai.agent.context.documentsOff')}`
        "
        data-agent-documents
        @click="documents = !documents"
      >
        {{ t('ai.agent.context.documents') }}
      </button>
    </div>
    <!-- UI review of wave B: said when it matters — values may go, or cannot; the chip's tooltip says
         the rest. -->
    <p v-if="documents || documentsRefused" class="text-small text-fg-subtle">
      {{ documentsRefused ?? t('ai.agent.context.documentsOn') }}
    </p>
  </div>
</template>
