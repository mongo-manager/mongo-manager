<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { fillSnippet, type SnippetView } from '@mongo-manager/shared/browser'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import DsInput from '@/ds/DsInput.vue'
/**
 * Phase 3a-2 spec §3.5: fill a snippet's parameters and put the code in the terminal. Each value
 * becomes a literal of its parameter's type (fillSnippet), so it can never become code. Nothing runs:
 * the code is inserted for the user to read — a shared snippet names its author — and run
 * themselves, under their own rights.
 */
const props = defineProps<{ snippet: SnippetView }>()
const emit = defineEmits<{ insert: [code: string]; close: [] }>()
const { t } = useI18n()

const values = ref<Record<string, string>>(
  Object.fromEntries(props.snippet.params.map((p) => [p.name, p.default ?? ''])),
)
const errors = ref<Record<string, string>>({})

function insert(): void {
  // An empty field falls back to the default; a required one without either is an error.
  const given = Object.fromEntries(
    Object.entries(values.value).map(([name, value]) => [name, value === '' ? undefined : value]),
  )
  const result = fillSnippet(props.snippet.code, props.snippet.params, given)
  if (!result.ok) {
    errors.value = Object.fromEntries(
      Object.entries(result.errors).map(([name, kind]) => [name, t(`shell.snippets.errors.${kind}`)]),
    )
    return
  }
  errors.value = {}
  emit('insert', result.code)
}
</script>

<template>
  <DsDialog open :title="snippet.name" size="md" @close="emit('close')">
    <form class="flex flex-col gap-4" novalidate @submit.prevent="insert">
      <p v-if="!snippet.mine && snippet.owner" class="text-ui text-fg-muted">
        {{ t('shell.snippets.by', { owner: snippet.owner }) }}
      </p>
      <p class="text-small text-fg-subtle">{{ t('shell.snippets.insertHint') }}</p>
      <pre class="max-h-40 overflow-auto rounded-lg bg-subtle p-2 font-mono text-small whitespace-pre-wrap">{{
        snippet.code
      }}</pre>
      <DsInput
        v-for="p in snippet.params"
        :key="p.name"
        :model-value="values[p.name] ?? ''"
        :label="`${p.name} (${t(`shell.snippets.types.${p.type}`)})`"
        :error="errors[p.name]"
        autocomplete="off"
        @update:model-value="(value: string) => (values[p.name] = value)"
      />
      <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
    </form>
    <template #footer>
      <DsButton @click="emit('close')">{{ t('common.cancel') }}</DsButton>
      <DsButton variant="primary" @click="insert">{{ t('shell.snippets.insert') }}</DsButton>
    </template>
  </DsDialog>
</template>
