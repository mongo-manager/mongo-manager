<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { CircleAlert, Equal, FileText } from 'lucide-vue-next'
import { documentDiff, type FieldChange } from '@mongo-manager/shared/browser'
import type { BulkSamples } from '@/api/documents'
import DiffList from './DiffList.vue'
import { decodeValue, idLabel, toShell } from './values'

/**
 * W2.3 (2026-10-16): a bulk operation's preview on a few matched documents — what an update changes
 * in each (masked values stay masked, so they never read as a change), the documents a delete
 * removes, or why there is no such preview.
 */
const props = defineProps<{ samples: BulkSamples; operation: 'update' | 'delete' }>()
const { t } = useI18n()

interface Shown {
  id: string
  fails: boolean
  changes: FieldChange[]
  text: string
}
const MAX_TEXT = 600
const shown = computed<Shown[]>(() => {
  if (!('documents' in props.samples)) return []
  return props.samples.documents.map((s) => {
    const before = decodeValue(s.before) as Record<string, unknown>
    const after = s.after ? (decodeValue(s.after) as Record<string, unknown>) : null
    const text = toShell(before, 2)
    const diff = after ? documentDiff(before, after) : null
    return {
      id: idLabel(before._id),
      fails: !!s.fails,
      changes: diff && diff.kind !== 'none' ? diff.changes : [],
      text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text,
    }
  })
})
const unavailable = computed(() => ('unavailable' in props.samples ? props.samples : null))
const KNOWN = new Set([
  'positional',
  'path',
  'modifier',
  'operator',
  'condition',
  'timestamp',
  'conflict',
  'stage',
  'error',
  'id',
  'changed',
  'large',
  'repeats',
])
</script>

<template>
  <section data-bulk-samples class="flex flex-col gap-2" :aria-label="t('bulk.samples.title')">
    <h3 class="text-small font-medium text-fg-muted">
      {{ operation === 'update' ? t('bulk.samples.title') : t('bulk.samples.deleteTitle') }}
    </h3>
    <p v-if="unavailable" class="rounded-lg bg-subtle px-3 py-2 text-small text-fg-muted">
      {{
        t(
          `bulk.samples.unavailable.${KNOWN.has(unavailable.unavailable) ? unavailable.unavailable : 'error'}`,
        )
      }}
      <span v-if="unavailable.message" class="mt-1 block font-mono break-words text-fg-subtle">{{
        unavailable.message
      }}</span>
    </p>
    <p v-else-if="shown.length === 0" class="text-small text-fg-subtle">{{ t('bulk.samples.none') }}</p>
    <ol v-else class="flex flex-col gap-2">
      <li
        v-for="(s, i) in shown"
        :key="i"
        data-bulk-sample
        class="rounded-lg border border-line bg-surface p-2.5"
      >
        <p class="mb-1.5 flex items-center gap-1.5 text-small text-fg-muted">
          <FileText class="size-3.5 shrink-0" aria-hidden="true" />
          <span class="truncate font-mono">{{ t('bulk.samples.id', { id: s.id }) }}</span>
        </p>
        <p v-if="s.fails" class="flex items-start gap-1.5 text-small text-danger">
          <CircleAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />{{ t('bulk.samples.fails') }}
        </p>
        <template v-else-if="operation === 'update'">
          <DiffList v-if="s.changes.length" :changes="s.changes" />
          <p v-else class="flex items-center gap-1.5 text-small text-fg-subtle">
            <Equal class="size-3.5" aria-hidden="true" />{{ t('bulk.samples.unchanged') }}
          </p>
        </template>
        <pre
          v-else
          class="max-h-48 overflow-auto rounded-md bg-canvas p-2 font-mono text-small break-words whitespace-pre-wrap text-fg"
          >{{ s.text }}</pre>
      </li>
    </ol>
    <p v-if="'documents' in samples && samples.cut" class="text-small text-fg-subtle">
      {{ t('bulk.samples.cut') }}
    </p>
  </section>
</template>
