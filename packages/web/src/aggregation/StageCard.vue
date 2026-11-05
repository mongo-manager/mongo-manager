<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { STAGES, type PreviewStageResult } from '@mongo-manager/shared/browser'
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  GripVertical,
  Trash2,
} from 'lucide-vue-next'
import DsCodeEditor from '@/ds/DsCodeEditor.vue'
import DsSpinner from '@/ds/DsSpinner.vue'
import type { Completion } from '@/ds/code/completion'
import DocumentJsonList from '@/documents/DocumentJsonList.vue'
import DocumentTree from '@/documents/DocumentTree.vue'
import { toRows } from '@/documents/rows'
import type { DocumentItem } from '@/api/documents'
import { parseCard, type Card } from './stages'
import StageOperatorCombobox from './StageOperatorCombobox.vue'

/** Phase 2a spec §4.2: one stage, its editor and its preview. */
const props = defineProps<{
  card: Card
  index: number
  total: number
  result: PreviewStageResult | null
  loading: boolean
  previewMode: 'json' | 'tree'
  completions: readonly Completion[]
  /** The assistant's last answer changed this stage (shown for a moment). */
  highlight?: boolean
}>()
const emit = defineEmits<{
  patch: [changes: Partial<Card>]
  move: [delta: number]
  duplicate: []
  remove: []
}>()
const { t } = useI18n()

const docsUrl = computed(() => STAGES.find((s) => s.operator === props.card.operator)?.docsUrl)
const parsed = computed(() => parseCard(props.card))
const parseError = computed(() => {
  const p = parsed.value
  if (!('error' in p)) return null
  if (p.error.message === 'empty') return t('aggregation.empty')
  return p.error.line !== undefined
    ? t('aggregation.parseError', { message: p.error.message, line: p.error.line, column: p.error.column })
    : p.error.message
})
const rows = computed(() =>
  props.result && 'documents' in props.result ? toRows(props.result.documents as DocumentItem[], 0) : [],
)
const text = computed({
  get: () => props.card.text,
  set: (value: string) => emit('patch', { text: value }),
})

const icon =
  'grid size-7 cursor-pointer place-items-center rounded-md text-fg-subtle transition-colors duration-120 hover:bg-subtle hover:text-fg disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent'

function onKeydown(event: KeyboardEvent): void {
  if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
  event.preventDefault()
  emit('move', event.key === 'ArrowUp' ? -1 : 1)
}
</script>

<template>
  <section
    :data-stage="card.id"
    :aria-label="t('aggregation.stageLabel', { n: index + 1, operator: card.operator })"
    class="grid overflow-hidden rounded-xl border bg-surface shadow-xs transition-[border-color,box-shadow,opacity] duration-160 focus-within:border-line-strong lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
    :class="[
      card.enabled ? 'border-line' : 'border-dashed border-line-strong opacity-70',
      highlight ? 'border-accent/60 ring-3 ring-accent/20' : '',
    ]"
    :data-changed="highlight ? '' : undefined"
    @keydown="onKeydown"
  >
    <div class="flex min-w-0 flex-col">
      <header class="flex flex-wrap items-center gap-1.5 border-b border-line px-2 py-1.5">
        <span
          draggable="true"
          class="grid size-7 cursor-grab place-items-center rounded-md text-fg-subtle hover:bg-subtle hover:text-fg"
          :title="t('aggregation.drag')"
        >
          <GripVertical class="size-4" aria-hidden="true" />
        </span>
        <StageOperatorCombobox :operator="card.operator" @pick="emit('patch', { operator: $event })" />
        <a
          v-if="docsUrl"
          :href="docsUrl"
          target="_blank"
          rel="noopener noreferrer"
          :class="icon"
          :title="t('aggregation.docs')"
        >
          <BookOpen class="size-3.5" aria-hidden="true" /><span class="sr-only">{{
            t('aggregation.docs')
          }}</span>
        </a>
        <label class="ml-auto flex cursor-pointer items-center gap-1.5 text-small text-fg-muted select-none">
          <input
            type="checkbox"
            class="peer sr-only"
            :checked="card.enabled"
            @change="emit('patch', { enabled: ($event.target as HTMLInputElement).checked })"
          />
          <span
            class="relative h-4 w-7 rounded-full bg-muted transition-colors duration-160 peer-checked:bg-accent peer-focus-visible:ring-3 peer-focus-visible:ring-focus/30 after:absolute after:top-0.5 after:left-0.5 after:size-3 after:rounded-full after:bg-surface after:shadow-xs after:transition-transform after:duration-160 peer-checked:after:translate-x-3"
            aria-hidden="true"
          />
          {{ t('aggregation.enabled') }}
        </label>
        <span class="mx-0.5 h-4 w-px bg-line" aria-hidden="true" />
        <button
          type="button"
          :class="icon"
          :aria-label="t('aggregation.moveUp')"
          :disabled="index === 0"
          @click="emit('move', -1)"
        >
          <ArrowUp class="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          :class="icon"
          :aria-label="t('aggregation.moveDown')"
          :disabled="index === total - 1"
          @click="emit('move', 1)"
        >
          <ArrowDown class="size-3.5" aria-hidden="true" />
        </button>
        <button type="button" :class="icon" :title="t('aggregation.duplicate')" @click="emit('duplicate')">
          <Copy class="size-3.5" aria-hidden="true" /><span class="sr-only">{{
            t('aggregation.duplicate')
          }}</span>
        </button>
        <button
          type="button"
          :class="icon"
          :title="card.collapsed ? t('aggregation.expand') : t('aggregation.collapse')"
          :aria-expanded="!card.collapsed"
          @click="emit('patch', { collapsed: !card.collapsed })"
        >
          <ChevronsDownUp v-if="!card.collapsed" class="size-3.5" aria-hidden="true" />
          <ChevronsUpDown v-else class="size-3.5" aria-hidden="true" />
          <span class="sr-only">{{
            card.collapsed ? t('aggregation.expand') : t('aggregation.collapse')
          }}</span>
        </button>
        <button
          type="button"
          :class="[icon, 'hover:bg-danger-soft hover:text-danger']"
          :title="t('aggregation.remove')"
          @click="emit('remove')"
        >
          <Trash2 class="size-3.5" aria-hidden="true" /><span class="sr-only">{{
            t('aggregation.remove')
          }}</span>
        </button>
      </header>
      <div v-if="!card.collapsed" class="p-2">
        <DsCodeEditor
          v-model="text"
          :label="t('aggregation.value', { n: index + 1 })"
          hide-label
          multiline
          :rows="4"
          :completions="completions"
        />
      </div>
      <p v-if="parseError" role="alert" class="px-3 pb-2 text-small text-danger">{{ parseError }}</p>
    </div>
    <div
      data-preview
      class="flex min-w-0 flex-col border-t border-line bg-canvas/70 text-ui lg:border-t-0 lg:border-l"
    >
      <div class="flex items-center gap-2 border-b border-line px-3 py-1.5 text-small">
        <span class="font-medium text-fg-muted">{{ t('aggregation.output') }}</span>
        <DsSpinner v-if="loading" :size="12" />
        <span
          v-if="card.enabled && !parseError && !loading && result && 'documents' in result"
          class="ml-auto rounded-full bg-accent-soft px-2 py-0.5 font-medium text-accent-fg tabular-nums"
          >{{
            result.truncated
              ? t('aggregation.documentsMore', { n: result.count })
              : t('aggregation.documents', result.count)
          }}</span
        >
        <span
          v-if="
            card.enabled && !parseError && !loading && result && 'documents' in result && result.truncated
          "
          class="text-caption text-fg-subtle"
          >{{ t('aggregation.firstShown', { n: result.count }) }}</span
        >
      </div>
      <div class="min-h-0 flex-1 p-2">
        <p v-if="!card.enabled" class="px-1 py-2 text-fg-subtle">{{ t('aggregation.disabled') }}</p>
        <p v-else-if="parseError" class="px-1 py-2 text-fg-subtle">{{ t('aggregation.fixFirst') }}</p>
        <p v-else-if="loading" class="px-1 py-2 text-fg-subtle">{{ t('aggregation.loading') }}</p>
        <template v-else-if="result && 'documents' in result">
          <div v-if="rows.length" class="max-h-72 min-h-0 overflow-auto rounded-lg">
            <DocumentJsonList v-if="previewMode === 'json'" :rows="rows" :can-write="false" />
            <DocumentTree v-else :rows="rows" :can-write="false" />
          </div>
          <p v-else class="px-1 py-2 text-fg-subtle">{{ t('aggregation.noOutput') }}</p>
        </template>
        <p
          v-else-if="result && 'error' in result"
          role="alert"
          class="px-1 py-2 text-small break-words text-danger"
        >
          {{ result.error.message }}
        </p>
        <p v-else-if="result && 'skipped' in result" class="px-1 py-2 text-fg-subtle">
          {{ result.skipped === 'write' ? t('aggregation.skippedWrite') : t('aggregation.skippedPrevious') }}
        </p>
      </div>
    </div>
  </section>
</template>
