<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  EXPORT_LANGUAGES,
  exportFind,
  exportPipeline,
  type ExportLanguage,
  type FindExport,
} from '@mongo-manager/shared/browser'
import DsDialog from '@/ds/DsDialog.vue'
import { useToastStore } from '@/stores/toasts'

/**
 * Phase 2a spec §4.6: the pipeline as a program for each official driver — and, plugins wave 2, the
 * Documents query (decoded values). The connection string is never in the code: every program
 * reads MONGODB_URI.
 */
const props = defineProps<{
  db: string
  coll: string
  stages?: readonly unknown[]
  find?: Omit<FindExport, 'db' | 'coll'>
}>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const toasts = useToastStore()
const id = useId()

const NAMES: Record<ExportLanguage, string> = {
  node: 'Node.js',
  python: 'Python',
  java: 'Java',
  go: 'Go',
  csharp: 'C#',
  php: 'PHP',
  ruby: 'Ruby',
  rust: 'Rust',
}
const language = ref<ExportLanguage>('node')
const code = computed(() => {
  try {
    return props.find
      ? exportFind(language.value, { db: props.db, coll: props.coll, ...props.find })
      : exportPipeline(language.value, { db: props.db, coll: props.coll, stages: props.stages ?? [] })
  } catch (e) {
    return (e as Error).message
  }
})

function onKeydown(event: KeyboardEvent, index: number): void {
  const moves: Record<string, number> = { ArrowRight: index + 1, ArrowLeft: index - 1 }
  const next = moves[event.key]
  if (next === undefined) return
  event.preventDefault()
  const count = EXPORT_LANGUAGES.length
  language.value = EXPORT_LANGUAGES[(next + count) % count]!
  void nextTick(() => document.getElementById(`${id}-${language.value}`)?.focus())
}

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(code.value)
    toasts.push({ kind: 'success', message: t('aggregation.export.copied') })
  } catch {
    toasts.push({ kind: 'error', message: t('aggregation.export.copyFailed') })
  }
}
</script>

<template>
  <DsDialog open :title="t('aggregation.export.title')" size="lg" @close="emit('close')">
    <div class="flex flex-col gap-3">
      <div role="tablist" :aria-label="t('aggregation.export.language')" class="flex flex-wrap gap-1">
        <button
          v-for="(lang, i) in EXPORT_LANGUAGES"
          :id="`${id}-${lang}`"
          :key="lang"
          type="button"
          role="tab"
          :data-language="lang"
          :aria-selected="language === lang"
          :aria-controls="`${id}-panel`"
          :tabindex="language === lang ? 0 : -1"
          class="cursor-pointer rounded-md px-2.5 py-1 text-ui"
          :class="language === lang ? 'bg-accent text-on-accent' : 'text-fg-muted hover:bg-subtle'"
          @click="language = lang"
          @keydown="onKeydown($event, i)"
        >
          {{ NAMES[lang] }}
        </button>
      </div>
      <div :id="`${id}-panel`" role="tabpanel" :aria-labelledby="`${id}-${language}`">
        <pre
          data-export-code
          class="max-h-[60vh] overflow-auto rounded-lg bg-subtle p-3 font-mono text-small"
          >{{ code }}</pre>
      </div>
      <p class="text-small text-fg-subtle">{{ t('aggregation.export.uri') }}</p>
      <div class="flex justify-end gap-2">
        <button
          type="button"
          class="cursor-pointer rounded-lg bg-accent px-3 py-1.5 text-ui font-medium text-on-accent hover:bg-accent-hover"
          @click="copy"
        >
          {{ t('aggregation.export.copy') }}
        </button>
      </div>
    </div>
  </DsDialog>
</template>
