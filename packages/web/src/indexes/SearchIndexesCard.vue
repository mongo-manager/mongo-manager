<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { FileJson, Plus, RotateCw, ScanSearch, Trash2 } from 'lucide-vue-next'
import DsBadge from '@/ds/DsBadge.vue'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsCard from '@/ds/DsCard.vue'
import DsDataTable from '@/ds/DsDataTable.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsMenu from '@/ds/DsMenu.vue'
import DsStatusDot from '@/ds/DsStatusDot.vue'
import type { DsColumn } from '@/ds/table'
import type { DsMenuItem } from '@/ds/menu'
import { documentKeys, documentsApi, type CollectionTarget, type SearchIndexInfo } from '@/api/documents'
import { describeError } from '@/api/errors'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import { decodeValue } from '@/documents/values'

const SearchIndexDialog = defineAsyncComponent(() => import('./SearchIndexDialog.vue'))

/**
 * W2.6 (2026-10-16): Atlas Search and Vector Search indexes, in the Indexes tab beside the others —
 * each with its kind, status (building, ready, failed…) and what it covers; created from a JSON
 * definition or, for vectors, a guided form; edited and dropped. A server without search (not
 * Atlas, no mongot) says what it needs.
 */
const props = defineProps<{ target: CollectionTarget; canManage: boolean }>()
const { t } = useI18n()
const queryClient = useQueryClient()
const dialogs = useDialogStore()
const toasts = useToastStore()

/** Atlas's states while an index is not settled yet: looked at again every few seconds (a stale index
 * stays queryable and may stay so for long: it is not polled). */
const MOVING = new Set(['PENDING', 'BUILDING', 'DELETING'])
const { data, isPending, isError, error, refetch } = useQuery({
  queryKey: documentKeys.searchIndexes(props.target),
  queryFn: () => documentsApi.searchIndexes(props.target),
  refetchInterval: (query) =>
    query.state.data?.indexes.some((i: SearchIndexInfo) => MOVING.has(i.status)) ? 5_000 : false,
})
const supported = computed(() => data.value?.supported === true)
const indexes = computed(() => data.value?.indexes ?? [])
const refresh = () => queryClient.invalidateQueries({ queryKey: documentKeys.searchIndexes(props.target) })

type Tone = 'connected' | 'connecting' | 'error' | 'idle'
const STATUS: Record<string, { tone: Tone; key: string }> = {
  READY: { tone: 'connected', key: 'ready' },
  PENDING: { tone: 'connecting', key: 'pending' },
  BUILDING: { tone: 'connecting', key: 'building' },
  STALE: { tone: 'connecting', key: 'stale' },
  FAILED: { tone: 'error', key: 'failed' },
  DELETING: { tone: 'idle', key: 'deleting' },
  DOES_NOT_EXIST: { tone: 'idle', key: 'gone' },
}
const statusOf = (index: SearchIndexInfo) => STATUS[index.status] ?? { tone: 'idle' as Tone, key: 'unknown' }

/** What an index covers: a vector index's fields, or a search index's mapped fields or "dynamic". */
function covers(index: SearchIndexInfo): string[] {
  const d = decodeValue(index.definition) as Record<string, unknown>
  if (index.type === 'vectorSearch') {
    const fields = Array.isArray(d.fields) ? (d.fields as Array<Record<string, unknown>>) : []
    return fields.map((f) =>
      f.type === 'vector'
        ? t('searchIndexes.vectorField', {
            path: String(f.path),
            dims: String(Number((f.numDimensions as { valueOf(): unknown })?.valueOf?.() ?? f.numDimensions)),
            similarity: String(f.similarity),
          })
        : t('searchIndexes.filterField', { path: String(f.path) }),
    )
  }
  const mappings = (d.mappings ?? {}) as Record<string, unknown>
  const fields = Object.keys((mappings.fields ?? {}) as Record<string, unknown>)
  return [...(mappings.dynamic === true ? [t('searchIndexes.dynamic')] : []), ...fields]
}

const columns = computed<DsColumn[]>(() => [
  { key: 'name', label: t('indexes.name'), mono: true },
  { key: 'type', label: t('searchIndexes.type'), width: '9rem' },
  { key: 'status', label: t('searchIndexes.status'), width: '10rem' },
  { key: 'covers', label: t('searchIndexes.covers') },
])
const rowMenu = (): DsMenuItem[] => [
  { id: 'edit', label: t('searchIndexes.edit'), icon: FileJson },
  { id: 'drop', label: t('indexes.drop'), icon: Trash2, danger: true },
]
const editing = ref<SearchIndexInfo | null>(null)
const creating = ref(false)
function onRowMenu(index: SearchIndexInfo, id: string): void {
  if (id === 'edit') editing.value = index
  else void drop(index)
}
async function drop(index: SearchIndexInfo): Promise<void> {
  const ok = await dialogs.confirm({
    title: t('indexes.drop'),
    message: t('searchIndexes.dropConfirm', { name: index.name }),
    confirmLabel: t('menu.drop'),
    danger: true,
  })
  if (!ok) return
  try {
    await documentsApi.dropSearchIndex(props.target, index.name)
    await refresh()
    toasts.push({ kind: 'success', message: t('searchIndexes.dropped', { name: index.name }) })
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  }
}
</script>

<template>
  <DsCard :title="t('searchIndexes.title')" :count="supported ? indexes.length : undefined" actions-shown>
    <template #actions>
      <DsButton v-if="canManage && supported" size="sm" :icon="Plus" @click="creating = true">
        {{ t('searchIndexes.create') }}
      </DsButton>
    </template>
    <DsCallout v-if="data && !data.supported" tone="info" data-search-unsupported>
      {{ t('searchIndexes.unsupported') }}
    </DsCallout>
    <DsDataTable
      v-else
      :label="t('searchIndexes.title')"
      :error="isError ? describeError(error, t) : undefined"
      :columns="columns"
      :rows="indexes"
      :loading-label="t('app.loading')"
      :row-key="(index: SearchIndexInfo) => index.name"
      :loading="isPending"
      :actions-label="t('documents.actionsColumn')"
    >
      <template #cell-name="{ row: index }">
        <span class="break-all">{{ index.name }}</span>
      </template>
      <template #cell-type="{ row: index }">
        <DsBadge :tone="index.type === 'vectorSearch' ? 'accent' : 'neutral'">{{
          index.type === 'vectorSearch' ? t('searchIndexes.vectorSearch') : t('searchIndexes.search')
        }}</DsBadge>
      </template>
      <template #cell-status="{ row: index }">
        <span class="inline-flex items-center gap-1.5 text-small text-fg">
          <DsStatusDot
            :state="statusOf(index).tone"
            :label="t(`searchIndexes.statuses.${statusOf(index).key}`)"
          />
          <span aria-hidden="true">{{ t(`searchIndexes.statuses.${statusOf(index).key}`) }}</span>
        </span>
        <span v-if="index.status === 'READY' && !index.queryable" class="block text-caption text-fg-subtle">{{
          t('searchIndexes.notQueryable')
        }}</span>
        <span v-if="index.message" class="block text-caption break-words text-danger">{{
          index.message
        }}</span>
      </template>
      <template #cell-covers="{ row: index }">
        <span class="flex flex-wrap gap-1">
          <span
            v-for="part in covers(index)"
            :key="part"
            class="inline-flex max-w-full rounded-md bg-muted px-1.5 py-0.5 font-mono text-small [overflow-wrap:anywhere] text-fg"
            >{{ part }}</span
          >
        </span>
      </template>
      <template #actions="{ row: index }">
        <DsMenu
          v-if="canManage"
          focusable
          touch
          :label="t('indexes.actionsFor', { name: index.name })"
          :items="rowMenu()"
          @select="onRowMenu(index, $event)"
        />
      </template>
      <template #retry>
        <DsButton size="sm" :icon="RotateCw" @click="refetch()">{{ t('common.retry') }}</DsButton>
      </template>
      <template #empty>
        <DsEmptyState
          :icon="ScanSearch"
          :title="t('searchIndexes.emptyTitle')"
          :description="t('searchIndexes.empty')"
        >
          <template v-if="canManage" #actions>
            <DsButton variant="primary" :icon="Plus" @click="creating = true">{{
              t('searchIndexes.create')
            }}</DsButton>
          </template>
        </DsEmptyState>
      </template>
    </DsDataTable>
    <SearchIndexDialog v-if="creating" :target="target" @close="creating = false" @saved="refresh" />
    <SearchIndexDialog
      v-if="editing"
      :target="target"
      :index="editing"
      @close="editing = null"
      @saved="refresh"
    />
  </DsCard>
</template>
