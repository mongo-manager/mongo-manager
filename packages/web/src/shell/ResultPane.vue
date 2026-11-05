<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQueryClient } from '@tanstack/vue-query'
import {
  Braces,
  ChevronsDown,
  ExternalLink,
  FileJson,
  FileSpreadsheet,
  ListTree,
  Maximize2,
  Minimize2,
  Rows3,
  SquareTerminal,
  Table2,
  Trash2,
  Undo2,
  X,
} from 'lucide-vue-next'
import { MAX_CSV_COLUMNS, csvFile } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsIconButton from '@/ds/DsIconButton.vue'
import DocumentTable from '@/documents/DocumentTable.vue'
import DocumentTree from '@/documents/DocumentTree.vue'
import {
  columnsOf,
  MAX_COLUMNS,
  type DocumentRow,
  type InspectorMode,
  type Row,
  type RowAction,
} from '@/documents/rows'
import { toShell } from '@/documents/values'
import { openLibraryItem } from '@/library/openItem'
import { downloadText } from '@/download'
import { formatCount } from '@/format'
import { useToastStore } from '@/stores/toasts'
import { useCollectionViewsStore } from '@/stores/collectionViews'
import { originPaging, originToLibraryItem, resultKey, resultRows, type ShellResult } from './results'
import ResultHistory from './ResultHistory.vue'

/**
 * User request 2026-10-11 (the shell's redesign), 2026-10-12 (the history in the header): the view as a segmented
 * control, its actions as icon buttons named in their tooltips.
 *
 * Phase 3a-2 spec §2: the shell's result pane. It shows a result as a table, a tree or text (canonical
 * EJSON), read-only; "More" asks the shell for the next batch (it); a cursor of a plain query opens in
 * its collection view; the documents shown export as JSON or CSV (with the formula guard). Earlier
 * results (10 at most, in memory) can be picked again.
 */
/** `wide`: the results take the whole width (the terminal out of sight), asked for with `wide`. */
const props = defineProps<{
  connectionId: string
  db: string
  results: readonly ShellResult[]
  wide?: boolean
  /** Results cleared can be brought back (the empty pane offers them). */
  restorable?: boolean
}>()
const emit = defineEmits<{ more: []; wide: [wide: boolean]; clear: []; restore: [] }>()
/** The collection view's inspector, read-only here (loaded when first used). */
const DocumentPage = defineAsyncComponent(() => import('@/documents/page/DocumentPage.vue'))
const { t, locale } = useI18n()
const queryClient = useQueryClient()
const toasts = useToastStore()

const picked = ref<number | null>(null)
// A new result is shown as it arrives.
watch(
  () => (props.results[0] ? resultKey(props.results[0]) : null),
  () => (picked.value = null),
)
const current = computed(
  () => props.results.find((r) => resultKey(r) === picked.value) ?? props.results[0] ?? null,
)
// "it" continues the newest cursor only, so More is offered on the newest result (final review M3).
const canMore = computed(
  () =>
    !!current.value?.hasMore &&
    !!props.results[0] &&
    resultKey(current.value) === resultKey(props.results[0]),
)

const VIEWS = [
  { value: 'table', icon: Table2 },
  { value: 'tree', icon: ListTree },
  { value: 'text', icon: Braces },
] as const

type View = 'table' | 'tree' | 'text'
/** The arrows move between the views one may pick (a radio group's keys). */
function onViewKey(event: KeyboardEvent): void {
  const open = VIEWS.map((v) => v.value).filter((v) => v === 'text' || !!current.value?.documents)
  const i = open.indexOf(view.value)
  const step =
    event.key === 'ArrowRight' || event.key === 'ArrowDown'
      ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
        ? -1
        : 0
  if (!step || i < 0) return
  event.preventDefault()
  chosen.value = open[(i + step + open.length) % open.length]!
  void nextTick(() =>
    (event.currentTarget as HTMLElement | null)
      ?.querySelector<HTMLElement>(`[data-view="${chosen.value}"]`)
      ?.focus(),
  )
}
const chosen = ref<View>('table')
const view = computed<View>(() => (current.value?.documents ? chosen.value : 'text'))
const allRows = computed(() => (current.value ? resultRows(current.value) : []))

/**
 * User report 2026-10-12 ("filtrele butonun çalışmıyor"): a cell's Filter keeps the rows with that
 * value in that field, here, on the result shown — a show collections list too. Each filter is a
 * chip to take off; another result starts with none. What is shown is what is exported.
 */
interface CellFilter {
  field: string
  value: unknown
  /** The value as the shell writes it: shown, and what rows are compared by. */
  text: string
}
const filters = ref<CellFilter[]>([])
/** A value as a filter's name says it: briefly (a long value is cut, review M15). */
const brief = (text: string) => (text.length > 60 ? `${text.slice(0, 59)}…` : text)
const pane = ref<HTMLElement | null>(null)
/** The Clear button goes with the results: the focus stays in the pane, never dropped on the page. */
function clear(): void {
  emit('clear')
  void nextTick(() => pane.value?.focus())
}
/** So does the Restore button, once the results are back. */
function restore(): void {
  emit('restore')
  void nextTick(() => pane.value?.focus())
}
/** The focus where the filters were: the next chip, else the view picked (never on nothing). */
async function dropFilters(drop: (f: CellFilter) => boolean): Promise<void> {
  const at = filters.value.findIndex(drop)
  filters.value = filters.value.filter((f) => !drop(f))
  await nextTick()
  const removes = pane.value?.querySelectorAll<HTMLButtonElement>('[data-result-filter] button') ?? []
  const next = removes[Math.min(Math.max(at, 0), removes.length - 1)]
  ;(next ?? pane.value?.querySelector<HTMLElement>(`[data-view="${view.value}"]`))?.focus()
}
function filterBy(field: string, value: unknown): void {
  const text = toShell(value, 0)
  if (filters.value.some((f) => f.field === field && f.text === text)) return
  filters.value = [...filters.value, { field, value, text }]
}
const rows = computed(() =>
  filters.value.length
    ? allRows.value.filter((r) => filters.value.every((f) => toShell(r.value[f.field], 0) === f.text))
    : allRows.value,
)
/** The documents shown, as received (canonical EJSON): what the text view and the exports hold. */
const shownDocs = computed(() => (current.value?.documents ? rows.value.map((r) => r.raw) : null))
const columns = computed(() => columnsOf(allRows.value as Row[], MAX_COLUMNS))

/** User report 2026-10-12 ("incele butonu … çalışmıyor"): Inspect opens the document, read-only. */
const inspected = ref<InspectorMode | null>(null)
/**
 * Final review minor: the walk's order is let go with the page — a later result whose rows have the
 * same keys must not walk the old one.
 */
function closeInspected(): void {
  inspected.value = null
  useCollectionViewsStore().stateFor('shell-results').inspector.order = null
}
/** What opened the document (its aria-label): the focus goes back to it from the page. */
const opener = ref<string | null>(null)
// Another result shown: its own rows, no filter or inspector carried over.
watch(
  () => (current.value ? resultKey(current.value) : null),
  () => {
    filters.value = []
    inspected.value = null
  },
)
const rowHeight = 36
const target = computed(() => ({
  connectionId: props.connectionId,
  db: current.value?.origin?.db ?? props.db,
  coll: current.value?.origin?.coll ?? '',
}))
const text = computed(() => {
  const r = current.value
  if (!r || r.value === undefined) return ''
  return JSON.stringify(shownDocs.value ?? r.value, null, 2)
})

async function onAction(kind: RowAction, row: Row): Promise<void> {
  if (row.kind !== 'document') return
  if (kind === 'inspect') {
    opener.value = (document.activeElement as HTMLElement | null)?.getAttribute('aria-label') ?? null
    inspected.value = { kind: 'document', id: row.key, tab: 'tree' }
    return
  }
  if (kind !== 'copy') return
  try {
    await navigator.clipboard.writeText(toShell(row.value))
    toasts.push({ kind: 'success', message: t('documents.copied') })
  } catch {
    toasts.push({ kind: 'error', message: t('documents.copyFailed') })
  }
}

function openInCollection(): void {
  const origin = current.value?.origin
  // W5: the collection view starts at the query's skip, its limit the page size.
  if (origin)
    void openLibraryItem(props.connectionId, originToLibraryItem(origin), {
      t,
      queryClient,
      paging: originPaging(origin),
    })
}

function fileName(extension: string): string {
  const base = current.value?.origin?.coll || 'shell-result'
  return `${base}-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`
}
function exportJson(): void {
  const docs = shownDocs.value
  if (docs) downloadText(`${JSON.stringify(docs, null, 2)}\n`, fileName('json'))
}
function exportCsv(): void {
  const docs = shownDocs.value
  if (!docs) return
  const { text: csv, droppedColumns } = csvFile(docs)
  downloadText(csv, fileName('csv'))
  if (droppedColumns > 0)
    toasts.push({
      kind: 'info',
      message: t('shell.results.csvColumnsDropped', { max: MAX_CSV_COLUMNS, count: droppedColumns }),
    })
}
</script>

<template>
  <section
    ref="pane"
    tabindex="-1"
    class="flex h-full min-h-0 flex-col outline-none"
    :aria-label="t('shell.results.title')"
    data-result-pane
  >
    <div class="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
      <Rows3 class="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
      <h3 class="text-small font-semibold tracking-wide text-fg-muted uppercase">
        {{ t('shell.results.title') }}
      </h3>
      <!-- The last results: one button naming the result shown, its list the others. -->
      <ResultHistory
        v-if="current"
        :results="results"
        :current-key="resultKey(current)"
        @pick="picked = $event"
      />
      <!-- The results forgotten (user report 2026-10-12: they stayed whatever was cleared). -->
      <DsIconButton
        v-if="current"
        size="sm"
        :icon="Trash2"
        :label="t('shell.results.clear')"
        data-result-clear
        @click="clear"
      />
    </div>
    <DsEmptyState
      v-if="!current"
      class="m-auto"
      :icon="SquareTerminal"
      :title="t('shell.results.emptyTitle')"
      :description="t('shell.results.empty')"
    >
      <template v-if="restorable" #actions>
        <DsButton size="sm" :icon="Undo2" data-result-restore @click="restore">
          {{ t('shell.results.restore') }}
        </DsButton>
      </template>
    </DsEmptyState>
    <template v-else>
      <div class="flex flex-col gap-2 border-b border-line px-3 py-2">
        <div class="flex flex-wrap items-center gap-2">
          <div
            role="radiogroup"
            :aria-label="t('shell.results.view')"
            class="inline-flex items-center gap-0.5 rounded-lg bg-subtle p-0.5 ring-1 ring-line ring-inset"
            @keydown="onViewKey"
          >
            <button
              v-for="v in VIEWS"
              :key="v.value"
              type="button"
              role="radio"
              :aria-checked="view === v.value"
              :tabindex="view === v.value ? 0 : -1"
              :disabled="v.value !== 'text' && !current.documents"
              class="inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-2 text-small font-medium transition-[background-color,color] duration-120 disabled:cursor-not-allowed disabled:opacity-40"
              :class="
                view === v.value
                  ? 'bg-surface text-fg shadow-xs ring-1 ring-line'
                  : 'text-fg-muted hover:text-fg'
              "
              :data-view="v.value"
              @click="chosen = v.value"
            >
              <component :is="v.icon" class="size-3.5" aria-hidden="true" />{{
                t(`shell.results.${v.value}`)
              }}
            </button>
          </div>
          <div class="ml-auto flex items-center gap-0.5">
            <DsButton v-if="canMore" size="sm" :icon="ChevronsDown" data-result-more @click="emit('more')">
              {{ t('shell.results.more') }}
            </DsButton>
            <DsIconButton
              v-if="current.origin"
              size="sm"
              :icon="ExternalLink"
              :label="t('shell.results.open')"
              data-result-open
              @click="openInCollection"
            />
            <DsIconButton
              size="sm"
              :icon="FileJson"
              :label="t('shell.results.exportJson')"
              :disabled="!current.documents"
              data-result-export-json
              @click="exportJson"
            />
            <DsIconButton
              size="sm"
              :icon="FileSpreadsheet"
              :label="t('shell.results.exportCsv')"
              :disabled="!current.documents"
              data-result-export-csv
              @click="exportCsv"
            />
            <DsIconButton
              size="sm"
              :icon="wide ? Minimize2 : Maximize2"
              :label="t('shell.results.widen')"
              :aria-pressed="wide ? 'true' : 'false'"
              class="max-lg:hidden"
              data-result-wide
              @click="emit('wide', !wide)"
            />
          </div>
        </div>
        <!-- The filters on the result shown, each a chip to take off. -->
        <div v-if="filters.length" class="flex flex-wrap items-center gap-1.5" data-result-filters>
          <span
            v-for="f in filters"
            :key="`${f.field}=${f.text}`"
            class="inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-accent-soft pr-0.5 pl-2 font-mono text-small text-accent-fg"
            data-result-filter
          >
            <span class="truncate">{{
              t('shell.results.filterChip', { field: f.field, value: f.text })
            }}</span>
            <button
              type="button"
              class="grid size-5 shrink-0 cursor-pointer place-items-center rounded hover:bg-accent/15"
              :aria-label="t('shell.results.removeFilter', { field: f.field, value: brief(f.text) })"
              @click="dropFilters((x) => x === f)"
            >
              <X class="size-3" aria-hidden="true" />
            </button>
          </span>
          <span class="text-small text-fg-subtle tabular-nums" aria-live="polite">{{
            t('shell.results.filtered', {
              n: formatCount(rows.length, locale),
              total: formatCount(allRows.length, locale),
            })
          }}</span>
          <button
            v-if="filters.length > 1"
            type="button"
            class="cursor-pointer text-small text-fg-muted underline-offset-2 hover:text-fg hover:underline"
            @click="dropFilters(() => true)"
          >
            {{ t('shell.results.clearFilters') }}
          </button>
        </div>
      </div>
      <p v-if="current.truncated" class="m-3 text-ui text-warning">{{ t('shell.results.truncated') }}</p>
      <!-- The rows, or the document opened from them in their place (document page design §6.1). -->
      <div v-else class="flex min-h-0 flex-1" data-result-body>
        <DocumentPage
          v-if="inspected"
          class="min-w-0 flex-1"
          :target="target"
          tab-id="shell-results"
          :rows="rows"
          :mode="inspected"
          :can-write="false"
          :fields="[]"
          :total="rows.length"
          :explain-readonly="false"
          :identify="(r: DocumentRow) => r.key"
          :opener="opener"
          @update:mode="inspected = $event"
          @close="closeInspected"
          @action="onAction"
        />
        <div v-else-if="view === 'table'" class="min-h-0 min-w-0 flex-1 overflow-auto" data-result-table>
          <DocumentTable
            :rows="rows"
            :columns="columns"
            :can-write="false"
            :inline-edit="false"
            :row-height="rowHeight"
            :target="target"
            @action="onAction"
            @filter-by="filterBy"
          />
        </div>
        <div v-else-if="view === 'tree'" class="min-h-0 min-w-0 flex-1 overflow-auto p-2" data-result-tree>
          <DocumentTree :rows="rows" :can-write="false" @action="onAction" />
        </div>
        <pre
          v-else
          class="m-0 min-h-0 min-w-0 flex-1 overflow-auto bg-subtle/50 p-3 font-mono text-small leading-relaxed whitespace-pre-wrap text-fg"
          data-result-text
          >{{ text }}</pre>
      </div>
    </template>
  </section>
</template>
