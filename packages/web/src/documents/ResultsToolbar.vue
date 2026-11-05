<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Braces,
  ChartColumn,
  ChevronLeft,
  ChevronRight,
  CopyPlus,
  Download,
  FilePlus2,
  GitCompare,
  LayoutList,
  Layers,
  RefreshCw,
  Table2,
  Trash2,
  Upload,
} from 'lucide-vue-next'
import DsMenu from '@/ds/DsMenu.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import DsSpinner from '@/ds/DsSpinner.vue'
import DsSplitButton from '@/ds/DsSplitButton.vue'
import DsTooltip from '@/ds/DsTooltip.vue'
import type { DsMenuItem } from '@/ds/menu'
import type { CountResult } from '@/api/documents'
import type { CollectionViewState, ViewMode } from '@/stores/collectionViews'
import { formatCount } from '@/format'

/**
 * UI redesign R1 revision 2 §4.4: the results toolbar — where the page is, how the results are shown,
 * and what can be done with them (only what this caller may do).
 */
const props = defineProps<{
  state: CollectionViewState
  /** Offset of the first row on screen (the page shown, not the one loading). */
  first: number
  /** A new page is loading: paging waits for it. */
  loadingPage: boolean
  count: CountResult | undefined
  rowCount: number
  hasMore: boolean
  fetching: boolean
  canWrite: boolean
  /** Phase 3d-1: may import files (documents:write) and may export them (data:export or the grant). */
  canImport?: boolean
  canExport?: boolean
}>()
const emit = defineEmits<{
  refresh: []
  insert: []
  import: []
  export: []
  /** Phase 3d-2: copy the collection, or compare it with a target. */
  copy: []
  compare: []
  bulk: [operation: 'update' | 'delete']
  page: [page: number]
  mode: [mode: ViewMode]
}>()
const { t, locale } = useI18n()

const modes = computed(() => [
  { value: 'table' as const, label: t('documents.view.table'), icon: Table2 },
  { value: 'cards' as const, label: t('documents.view.cards'), icon: LayoutList },
  { value: 'json' as const, label: t('documents.view.json'), icon: Braces },
  // W1 (completion §2): the results as a chart.
  { value: 'chart' as const, label: t('documents.view.chart'), icon: ChartColumn },
])
const mode = computed({
  get: () => props.state.mode,
  set: (next: ViewMode) => emit('mode', next),
})

const range = computed(() => {
  const n = (v: number) => formatCount(v, locale.value)
  if (props.rowCount === 0) return t('documents.count.none')
  const first = props.first
  const values = { from: n(first + 1), to: n(first + props.rowCount) }
  const c = props.count
  if (c?.count != null)
    return t(c.exact ? 'documents.count.exact' : 'documents.count.estimated', {
      ...values,
      total: n(c.count),
    })
  if (c?.atLeast != null) return t('documents.count.atLeast', { ...values, total: n(c.atLeast) })
  return t('documents.count.unknown', values)
})

const more = computed<DsMenuItem[]>(() => [
  ...(props.canExport ? [{ id: 'export', label: t('dataTransfer.export'), icon: Download }] : []),
  ...(props.canImport ? [{ id: 'import', label: t('dataTransfer.import'), icon: Upload }] : []),
  ...(props.canExport
    ? [
        { id: 'copy', label: t('documents.results.copyTo'), icon: CopyPlus },
        { id: 'compare', label: t('documents.results.compareWith'), icon: GitCompare },
      ]
    : []),
  ...(props.canWrite
    ? [
        { id: 'update', label: t('documents.updateMany'), icon: Layers, separator: !!props.canExport },
        { id: 'delete', label: t('documents.deleteMany'), icon: Trash2, danger: true },
      ]
    : []),
])
function onMore(id: string): void {
  if (id === 'update' || id === 'delete') emit('bulk', id)
  else if (id === 'export') emit('export')
  else if (id === 'import') emit('import')
  else if (id === 'copy') emit('copy')
  else if (id === 'compare') emit('compare')
}
const addItems = computed<DsMenuItem[]>(() => [
  { id: 'insert', label: t('documents.insert'), icon: FilePlus2 },
  ...(props.canImport ? [{ id: 'import', label: t('documents.results.importFile'), icon: Upload }] : []),
])
function onAdd(id: string): void {
  if (id === 'import') emit('import')
  else emit('insert')
}
const pageButton =
  'grid size-8 cursor-pointer place-items-center rounded-lg text-fg-muted transition-colors duration-120 hover:bg-subtle hover:text-fg disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent'
</script>

<template>
  <div class="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-4 pb-2 text-ui">
    <!-- W1: pages are the table's, cards' and JSON's; the chart reads the query's documents itself. -->
    <div v-if="state.mode !== 'chart'" class="flex items-center gap-0.5">
      <button
        type="button"
        :class="pageButton"
        :aria-label="t('documents.page.previous')"
        :disabled="state.page === 0 || loadingPage"
        @click="emit('page', state.page - 1)"
      >
        <ChevronLeft class="size-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        :class="pageButton"
        :aria-label="t('documents.page.next')"
        :disabled="!hasMore || loadingPage"
        @click="emit('page', state.page + 1)"
      >
        <ChevronRight class="size-4" aria-hidden="true" />
      </button>
    </div>
    <p v-if="state.mode !== 'chart'" class="min-w-0 font-medium text-fg tabular-nums" aria-live="polite">
      {{ range }}
    </p>
    <DsSpinner v-if="fetching" :label="t('documents.loading')" />
    <div class="ml-auto flex flex-wrap items-center justify-end gap-1.5">
      <DsSegmented v-model="mode" size="sm" icon-only :label="t('documents.view.label')" :options="modes" />
      <DsTooltip :text="t('documents.refresh')">
        <button
          type="button"
          :class="pageButton"
          :aria-label="t('documents.refresh')"
          @click="emit('refresh')"
        >
          <RefreshCw class="size-4" aria-hidden="true" />
        </button>
      </DsTooltip>
      <DsMenu
        v-if="more.length"
        focusable
        size="md"
        :label="t('documents.results.more')"
        :items="more"
        @select="onMore"
      />
      <DsSplitButton
        v-if="canWrite"
        :label="t('documents.insert')"
        :icon="FilePlus2"
        :items="addItems"
        :menu-label="t('documents.results.addMore')"
        @click="emit('insert')"
        @select="onAdd"
      />
    </div>
  </div>
</template>
