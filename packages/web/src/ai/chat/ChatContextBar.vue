<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Database, Globe } from 'lucide-vue-next'
import type { ChatParts, SampleChoice } from './store'
import DsSelect from '@/ds/DsSelect.vue'

/** Spec §1.3, §5: what the next message carries, as chips the person turns on and off. */
const props = defineProps<{
  namespace: string | null
  connectionName: string | null
  /** Why the active collection's data does not go (policy off, no right, gone, loading), or null. */
  notice: string | null
  hasCurrent: boolean
  pipeline: boolean
  /** Why samples cannot be sent (provider or policy), or null. */
  samplesRefused: string | null
}>()
const parts = defineModel<ChatParts | null>('parts', { required: true })
const samples = defineModel<SampleChoice>('samples', { required: true })
const { t } = useI18n()
const chip = (on: boolean) =>
  [
    'inline-flex h-7 cursor-pointer items-center gap-1 rounded-full border px-2.5 text-xs transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
    on ? 'border-accent bg-accent-soft text-accent-fg' : 'border-line text-fg-muted hover:bg-subtle',
  ].join(' ')
// Plan ruling 10: the current query follows the section until the person chooses.
const currentOn = computed(() => (parts.value?.current ?? true) && props.hasCurrent)
const toggle = (k: 'current' | 'indexes' | 'validator') => {
  if (!parts.value) return
  if (k === 'current') parts.value.current = !currentOn.value
  else parts.value[k] = !parts.value[k]
}
const currentLabel = computed(() =>
  props.hasCurrent
    ? t(props.pipeline ? 'ai.chat.context.currentPipeline' : 'ai.chat.context.current')
    : t('ai.chat.context.noCurrent'),
)
</script>

<template>
  <div class="flex flex-col gap-2" data-chat-context>
    <p class="flex items-center gap-1.5 text-small text-fg-muted">
      <Database v-if="namespace" class="size-3.5" aria-hidden="true" />
      <Globe v-else class="size-3.5" aria-hidden="true" />
      <span v-if="notice">{{ notice }}</span>
      <span v-else-if="namespace" class="truncate font-medium text-fg">{{
        t('ai.chat.context.about', { ns: namespace, connection: connectionName })
      }}</span>
      <span v-else>{{ t('ai.chat.context.general') }}</span>
    </p>
    <div
      v-if="namespace && parts"
      role="group"
      :aria-label="t('ai.chat.context.label')"
      class="flex flex-wrap gap-1.5"
    >
      <span :class="chip(true)" class="cursor-default">{{ t('ai.chat.context.schema') }}</span>
      <button
        type="button"
        :class="chip(currentOn)"
        :aria-pressed="currentOn"
        :disabled="!hasCurrent"
        @click="toggle('current')"
      >
        {{ currentLabel }}
      </button>
      <button
        type="button"
        :class="chip(parts.indexes)"
        :aria-pressed="parts.indexes"
        @click="toggle('indexes')"
      >
        {{ t('ai.chat.context.indexes') }}
      </button>
      <button
        type="button"
        :class="chip(parts.validator)"
        :aria-pressed="parts.validator"
        @click="toggle('validator')"
      >
        {{ t('ai.chat.context.validator') }}
      </button>
      <button
        type="button"
        :class="chip(samples.on)"
        :aria-pressed="samples.on"
        :disabled="!!samplesRefused"
        :title="samplesRefused ?? undefined"
        @click="samples.on = !samples.on"
      >
        {{ t('ai.chat.context.samples') }}
      </button>
    </div>
    <p v-if="namespace && samplesRefused" class="text-small text-fg-subtle">
      {{ samplesRefused }}
    </p>
    <div v-if="namespace && samples.on" class="grid grid-cols-[5rem_1fr] gap-2">
      <DsSelect
        v-model="samples.count"
        hide-label
        :label="t('ai.sheet.count')"
        :options="['1', '2', '3', '4', '5'].map((n) => ({ value: n, label: n }))"
      />
      <input
        v-model="samples.hide"
        :aria-label="t('ai.sheet.hide')"
        :placeholder="t('ai.sheet.hideHint')"
        class="h-8 rounded-md border border-line bg-surface px-2 font-mono text-small"
      />
    </div>
  </div>
</template>
