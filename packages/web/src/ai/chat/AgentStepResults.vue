<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { LoaderCircle } from 'lucide-vue-next'
import type { AiAgentResults, RunLine } from '@mongo-manager/shared/browser'
import { documentsApi, type DocumentItem } from '@/api/documents'
import { aggregateApi } from '@/api/aggregate'
import { describeError } from '@/api/errors'
import { readNdjson } from '@/aggregation/ndjson'
import DocumentJsonList from '@/documents/DocumentJsonList.vue'
import { toRows } from '@/documents/rows'
import { provideMaskedPaths } from '@/masking/useMaskedPaths'
import DsCallout from '@/ds/DsCallout.vue'

/**
 * Design 2026-10-25 (B5): a read step's documents, read again as the person through the app's own
 * routes — their rights and masking — and shown here only: never sent to the assistant (the documents
 * chip stays the only way values reach it), never one of their recent queries.
 */
const props = defineProps<{
  results: AiAgentResults
  connectionId: string
  db: string
  coll: string
}>()
const { t } = useI18n()
// The collection's hidden fields carry their lock, as in its tab (a guide only: the server hides them).
provideMaskedPaths(toRef(props, 'connectionId'), toRef(props, 'db'), toRef(props, 'coll'))
const items = ref<DocumentItem[]>([])
const state = ref<'reading' | 'done' | 'error'>('reading')
const error = ref<string | null>(null)
const more = ref(false)
const rows = computed(() => toRows(items.value, 0))
const controller = new AbortController()

async function read(): Promise<void> {
  const target = { connectionId: props.connectionId, db: props.db, coll: props.coll }
  const r = props.results
  try {
    if (r.kind === 'find') {
      const page = await documentsApi.find(
        target,
        {
          filter: r.filter,
          ...(r.projection ? { projection: r.projection } : {}),
          ...(r.sort ? { sort: r.sort } : {}),
          ...(r.hint !== undefined ? { hint: r.hint } : {}),
          skip: 0,
          limit: r.limit,
          // The agent's own read: out of the recent queries, with a find's time (review of B5, M2).
          record: false,
        },
        controller.signal,
      )
      items.value = page.documents
      more.value = page.hasMore
    } else {
      const stream = await aggregateApi.run(
        target,
        { stages: r.stages, limit: r.limit, remember: false },
        controller.signal,
      )
      const docs: DocumentItem[] = []
      await readNdjson(
        stream,
        (lines) => {
          for (const line of lines as RunLine[]) {
            if ('end' in line) more.value = line.end.truncated
            else if ('error' in line) error.value = line.error.message
            else docs.push(line as DocumentItem)
          }
        },
        undefined,
        controller.signal,
      )
      items.value = docs
    }
    state.value = error.value ? 'error' : 'done'
  } catch (e) {
    if (controller.signal.aborted) return
    error.value = describeError(e, t)
    state.value = 'error'
  }
}
onMounted(() => void read())
onBeforeUnmount(() => controller.abort())
</script>

<template>
  <div
    class="flex flex-col gap-1.5 rounded-lg border border-line bg-canvas px-2.5 py-2"
    :aria-busy="state === 'reading'"
    data-agent-results-list
  >
    <p class="text-small text-fg-subtle">{{ t('ai.agent.results.note') }}</p>
    <p v-if="state === 'reading'" class="flex items-center gap-1.5 text-small text-fg-muted" role="status">
      <LoaderCircle class="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      {{ t('ai.agent.results.reading') }}
    </p>
    <DsCallout v-else-if="state === 'error'" tone="danger" role="alert">{{ error }}</DsCallout>
    <p v-else-if="!rows.length" class="text-small text-fg-muted" role="status">
      {{ t('ai.agent.results.none') }}
    </p>
    <template v-else>
      <div class="-mx-2.5 max-h-96 overflow-auto">
        <DocumentJsonList :rows="rows" :can-write="false" :actions="false" />
      </div>
      <p class="text-small text-fg-subtle" role="status">
        {{
          more
            ? t('ai.agent.results.more', { n: rows.length }, rows.length)
            : t('ai.agent.results.count', { n: rows.length }, rows.length)
        }}
      </p>
    </template>
  </div>
</template>
