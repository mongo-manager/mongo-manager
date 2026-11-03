<script setup lang="ts">
import { computed, defineAsyncComponent, markRaw, onBeforeUnmount, ref, shallowRef, toRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { FilePlus2, FilterX, Inbox, Lock, RefreshCw, SearchX, Upload } from 'lucide-vue-next'
import DsCallout from '@/ds/DsCallout.vue'
import DsButton from '@/ds/DsButton.vue'
import type { CollectionTarget } from '@/api/documents'
import { describeError } from '@/api/errors'
import { useCollectionViewsStore, type ViewMode } from '@/stores/collectionViews'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import { NEWEST_FIRST_SORT, buildQuery, hasQueryParts, sameParts, type FindQuery } from './queryBuild'
import { deserializeValue, parseQueryObject, serializeValue } from '@mongo-manager/shared/browser'
import { cycleSort, type SortDir } from './sortModel'
import { documentsApi } from '@/api/documents'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import { decodeValue, toQueryShell, toShell } from './values'
import { withoutChip, withoutScore, type FilterChip } from './filterChips'
import type { FilterSuggestion } from './suggestions'
import FilterChips from './FilterChips.vue'
import { useFavouriteSave } from './favourite'
import { loadWidths, saveWidths } from './columnWidths'
import { useSessionStore } from '@/stores/session'
import SaveItemDialog from '@/library/SaveItemDialog.vue'
import SuggestionChips from './SuggestionChips.vue'
import SelectionBar from './SelectionBar.vue'
import {
  COLUMN_WIDTH,
  arrangeColumns,
  columnsOf,
  fieldPaths,
  fieldType,
  fieldValues,
  hasId,
  inspectorKey,
  rowIdKey,
  type InspectorMode,
  type Row,
  type RowAction,
} from './rows'
import ColumnsMenu from './ColumnsMenu.vue'
import { completionsFor } from './completions'
import { useDocuments } from './useDocuments'
import { useDocumentActions } from './documentActions'
import QueryComposer from './QueryComposer.vue'
import QueryPanel from './QueryPanel.vue'
import ResultsToolbar from './ResultsToolbar.vue'
import DocumentTable from './DocumentTable.vue'
import DocumentJsonList from './DocumentJsonList.vue'
import DocumentCards from './DocumentCards.vue'
import { provideMaskedPaths } from '@/masking/useMaskedPaths'
import { Puzzle } from 'lucide-vue-next'
import { provideRowExtras } from './rowExtras'
import { provideCellPlace } from '@/plugins/cells'
import { showDocumentById } from './showDocument'
import PluginActionDialog from '@/plugins/PluginActionDialog.vue'
import { localized, usePluginsStore, type Contribution } from '@/plugins/store'
import { useEncryptedFields } from '@/encryption/useEncryptedFields'

const DocumentInspector = defineAsyncComponent(() => import('./DocumentInspector.vue'))
// W1: the chart view (and ECharts with it) loads the first time it is shown.
const DocumentChart = defineAsyncComponent(() => import('./DocumentChart.vue'))
const BulkDialog = defineAsyncComponent(() => import('./BulkDialog.vue'))
const ImportWizard = defineAsyncComponent(() => import('@/transfer/ImportWizard.vue'))
const ExportDataDialog = defineAsyncComponent(() => import('@/transfer/ExportDataDialog.vue'))
const CopyWizard = defineAsyncComponent(() => import('@/transfer/CopyWizard.vue'))
const ExportDialog = defineAsyncComponent(() => import('@/aggregation/ExportDialog.vue'))

const props = defineProps<{
  target: CollectionTarget
  tabId: string
  canWrite: boolean
  isView: boolean
  /** Phase 3d-1: data:export on this connection (by role, or a viewer's grant). */
  canExport?: boolean
}>()
const { t, locale } = useI18n()
const state = useCollectionViewsStore().stateFor(props.tabId)

/**
 * Plugins wave 2 (Export to Language): the query in use as a driver program — its parts decoded;
 * the page size is how the results are shown, not part of the query, so it is left out.
 */
const coding = ref(false)
const codeQuery = computed(() => {
  const q = state.query
  const decoded = (v: Record<string, unknown> | undefined) => (v ? deserializeValue(v) : undefined)
  return {
    filter: deserializeValue(q.filter),
    projection: decoded(q.projection),
    sort: decoded(q.sort),
    collation: decoded(q.collation),
    hint: typeof q.hint === 'string' ? q.hint : decoded(q.hint),
    ...(q.skip ? { skip: q.skip } : {}),
    ...(q.maxTimeMS ? { maxTimeMS: q.maxTimeMS } : {}),
  }
})

/** Phase 2b: Explain opens on the query last run here, and runs it. */
function whySlow(): void {
  state.explain.source = 'documents'
  state.explain.request++
  state.section = 'explain'
}
const target = toRef(props, 'target')
// W8: the fields client-side encryption keeps encrypted here, marked in the table's headers.
const encryptedFields = useEncryptedFields(target)
// Phase 3c §7: which values the server hides from this user here (locks, and a hint).
const masking = provideMaskedPaths(
  computed(() => props.target.connectionId),
  computed(() => props.target.db),
  computed(() => props.target.coll),
)
const { find, count, rows, shownSkip } = useDocuments(target, state)

// A page can empty out under us (bulk delete, other users): step back to one that has rows.
watch(
  () => [rows.value.length, find.isFetching.value, find.isPlaceholderData.value] as const,
  ([count, fetching, placeholder]) => {
    if (count === 0 && !fetching && !placeholder && state.page > 0) state.page--
  },
)

const writable = computed(() => props.canWrite && !props.isView)
const rowHeight = 36
const allColumns = computed(() => columnsOf(rows.value))
const arranged = computed(() => arrangeColumns(allColumns.value, state.columns))
// UI redesign R1 review: the field names seen while this tab is open (not only on the page shown), so a
// filter that matches nothing still completes them.
const MAX_FIELDS = 500
const seenFields = shallowRef<string[]>([])
watch(
  rows,
  (page) => {
    const known = new Set(seenFields.value)
    for (const path of fieldPaths(page)) if (known.size < MAX_FIELDS) known.add(path)
    if (known.size !== seenFields.value.length) seenFields.value = [...known]
  },
  { immediate: true },
)
const fields = computed(() => seenFields.value)
/** The values seen for a field on the page; a hidden field's are never offered (phase 3c §7). */
const valuesFor = (path: string): readonly string[] =>
  masking.matcher.value(path.split('.')) ? [] : fieldValues(rows.value, path)
const completions = computed(() => completionsFor('query', fields.value))
const actions = useDocumentActions(target)
const bulk = ref<'update' | 'delete' | null>(null)
const transfer = ref<'import' | 'export' | 'copy' | 'compare' | null>(null)
// The export starts from the query applied here; paging (skip and page size) is not part of it.
const exportQuery = computed(() => {
  const q = state.query
  return {
    filter: q.filter,
    ...(q.projection ? { projection: q.projection } : {}),
    ...(q.sort ? { sort: q.sort } : {}),
    ...(q.collation ? { collation: q.collation } : {}),
    ...(q.hint !== undefined ? { hint: q.hint } : {}),
  }
})

function apply(query: FindQuery): void {
  state.query = query
  state.page = 0
}

// UI redesign R1 revision 2 §4.3: the query in use, and the words it came from while it still matches.
const intent = computed(() =>
  state.intent && sameParts(state.intent, state.query) ? state.intent.prompt : null,
)
// The sort the tab opened with (newest first) is no part written: the panel stays as it was.
const openingOnly = (q: FindQuery): FindQuery =>
  state.openingSort !== null && JSON.stringify(q.sort) === JSON.stringify(NEWEST_FIRST_SORT)
    ? { ...q, sort: undefined }
    : q
const panelShown = computed(() => intent.value !== null || hasQueryParts(openingOnly(state.query)))
const composer = ref<InstanceType<typeof QueryComposer> | null>(null)

function refresh(): void {
  void actions.refresh()
}
/** W1 (completion §2): the query panel saves the query in use as a favourite. */
const favourite = useFavouriteSave(() => props.target)
/**
 * The query panel's star (final review of the query parameters, Minor 6): the bar's template with
 * its values as defaults when they make the query in use, else the query in use as it ran.
 */
function savePanelFavourite(): void {
  const built = buildQuery({ ...state.draft, skip: '', maxTimeMS: '' })
  const pick = (q: FindQuery | NonNullable<typeof template>) =>
    JSON.stringify([q.filter, q.projection, q.sort, q.collation, q.hint])
  const template = built.ok ? built.template : undefined
  if (built.ok && template && pick(built.query) === pick(state.query)) {
    const values = state.draft.params ?? {}
    favourite.start(
      template,
      Object.fromEntries(built.params.flatMap((n) => (Object.hasOwn(values, n) ? [[n, values[n]!]] : []))),
    )
  } else favourite.start(state.query)
}

// UI redesign R1 revision 2 §4.5: documents open in the inspector beside the results.
// Reviewer B I1: kept with the tab, so another section or tab does not lose it (or its edits).
const inspector = computed<InspectorMode | null>({
  get: () => state.inspector.mode,
  set: (mode) => {
    state.inspector.mode = mode ? markRaw(mode) : null
  },
})
const inspectorRef = ref<{ mayLeave: () => Promise<boolean> } | null>(null)
/** Every way to another document, a clone or a new one asks before unsaved edits go. */
async function setInspector(next: InspectorMode | null): Promise<void> {
  const current = inspector.value
  if (current && next && inspectorKey(current) === inspectorKey(next)) return
  if (current && inspectorRef.value && !(await inspectorRef.value.mayLeave())) return
  inspector.value = next
}
const inspectedId = computed(() => (inspector.value?.kind === 'document' ? inspector.value.id : null))
// ---- UI redesign R1 checkpoint 3: documents selected on the page, and what is done with them
const dialogs = useDialogStore()
const toasts = useToastStore()
const selected = shallowRef<ReadonlySet<string>>(new Set())
const selectedRows = computed(() => rows.value.filter((r) => selected.value.has(rowIdKey(r))))
const selectionStatus = computed(() =>
  selected.value.size ? t('documents.selection.count', { n: selected.value.size }, selected.value.size) : '',
)
watch(
  () => [state.query, state.page] as const,
  () => {
    selected.value = new Set()
  },
)
// Rows that are gone (deleted, another page loaded) are no longer selected.
watch(rows, (page) => {
  const here = new Set(page.map(rowIdKey))
  const kept = [...selected.value].filter((id) => here.has(id))
  if (kept.length !== selected.value.size) selected.value = new Set(kept)
})
function toggle(row: Row): void {
  if (!hasId(row)) return
  const next = new Set(selected.value)
  const id = rowIdKey(row)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}
function toggleAll(): void {
  // Reviewer B I3: only documents with an _id can be selected.
  const selectable = rows.value.filter(hasId)
  selected.value =
    selectable.length === 0 || selectedRows.value.length === selectable.length
      ? new Set()
      : new Set(selectable.map(rowIdKey))
}
/** The selected documents' _ids as sent (canonical EJSON, as received). */
const selectedIds = () =>
  selectedRows.value
    .map((r) => (r.kind === 'document' ? r.raw._id : r.rawId))
    .filter((id) => id !== undefined)
async function copySelected(): Promise<void> {
  const docs = selectedRows.value.flatMap((r) => (r.kind === 'document' ? [r.value] : []))
  try {
    await navigator.clipboard.writeText(toShell(docs))
    toasts.push({
      kind: 'success',
      message: t('documents.selection.copied', { n: docs.length }, docs.length),
    })
  } catch {
    toasts.push({ kind: 'error', message: t('documents.copyFailed') })
  }
}
const exportSelection = shallowRef<{ filter: Record<string, unknown> } | null>(null)
function exportSelected(): void {
  exportSelection.value = { filter: { _id: { $in: selectedIds() } } }
  transfer.value = 'export'
}
/** Deletes exactly the selected documents, through the bulk route's preview and its checks. */
async function deleteSelected(): Promise<void> {
  const selectedCount = selectedRows.value.length
  const body = { operation: 'delete' as const, filter: { _id: { $in: selectedIds() } } }
  try {
    // Reviewer B Minor 13: asked about what the server finds now (some may have gone meanwhile).
    const preview = await documentsApi.bulkPreview(target.value, body)
    const n = preview.matched
    if (n === 0) {
      selected.value = new Set()
      await actions.refresh()
      toasts.push({ kind: 'error', message: t('documents.selection.noneLeft') })
      return
    }
    const ok = await dialogs.confirm({
      title: t('documents.selection.deleteTitle', { n }, n),
      message:
        n < selectedCount
          ? `${t('documents.selection.someLeft', { n, of: selectedCount }, n)} ${t('documents.selection.deleteMessage', { n }, n)}`
          : t('documents.selection.deleteMessage', { n }, n),
      confirmLabel: t('documents.delete'),
      danger: true,
    })
    if (!ok) return
    // Every document of the collection: its name must be typed, as for Delete many.
    let confirm: string | undefined
    if (preview.requiresConfirmation) {
      const sure = await dialogs.confirm({
        title: t('documents.selection.deleteTitle', { n }, n),
        message: t('bulk.all', { name: target.value.coll }),
        confirmLabel: t('documents.delete'),
        danger: true,
        requireText: target.value.coll,
      })
      if (!sure) return
      confirm = target.value.coll
    }
    const result = await documentsApi.bulkExecute(target.value, body, preview.filterHash, confirm)
    selected.value = new Set()
    await actions.refresh()
    const deleted = result.deleted ?? 0
    toasts.push({ kind: 'success', message: t('bulk.deleted', { count: deleted }, deleted) })
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  }
}

// UI redesign R1 checkpoint 3: an empty result says whether the query or the collection is empty —
// only a filter or a skip can leave a collection's documents out (reviewer B Minor 7).
const filtered = computed(() => Object.keys(state.query.filter).length > 0 || state.query.skip > 0)
/** Clears the filter (and the skip), keeping the sort, the fields shown and the options. */
function clearFilter(): void {
  state.draft = { ...state.draft, filter: '', skip: '' }
  state.intent = null
  apply({ ...state.query, filter: {}, skip: 0 })
}

/** A cell's value added to the filter (its own condition), and the filter run. */
function filterBy(field: string, value: unknown): void {
  const condition = { [field]: value }
  let filter: Record<string, unknown> = condition
  const text = state.draft.filter.trim()
  if (text) {
    let current: Record<string, unknown>
    try {
      // A template's parameters are kept (final review I6).
      current = parseQueryObject(text, { params: true }) as Record<string, unknown>
    } catch {
      // Reviewer B Minor 5: a filter being written is the user's; it is never replaced unasked.
      toasts.push({ kind: 'error', message: t('documents.filterUnfinished') })
      return
    }
    filter =
      Object.keys(current).some((k) => k.startsWith('$')) || field in current
        ? { $and: [current, condition] }
        : { ...current, ...condition }
  }
  const draft = { ...state.draft, filter: toQueryShell(filter, 0) }
  const built = buildQuery(draft)
  if (!built.ok) {
    toasts.push({ kind: 'error', message: unbuilt(built) })
    return
  }
  state.draft = draft
  apply(built.query)
}

/** Why the bar's query cannot run as it is: a parameter with no value, or a part not finished. */
function unbuilt(built: Exclude<ReturnType<typeof buildQuery>, { ok: true }>): string {
  return built.field === 'params'
    ? t('query.params.required', { name: `{{${built.message}}}` })
    : t('documents.filterUnfinished')
}

/** Query parameters: the template the bar holds, when its values filled in are the query run. */
function templateRun(): ReturnType<typeof buildQuery> | null {
  const built = buildQuery({ ...state.draft, skip: '', maxTimeMS: '' })
  if (!built.ok || !built.template) return null
  return JSON.stringify(built.query.filter) === JSON.stringify(state.query.filter) ? built : null
}

// ---- W1 (completion §2): filter chips and suggestions
/** Whether a part's text in the bar is the part run: it parses to the same canonical value. */
function textIsRun(text: string, run: Record<string, unknown> | undefined): boolean {
  try {
    const parsed = parseQueryObject(text)
    const value = Object.keys(parsed).length ? serializeValue(parsed) : {}
    return JSON.stringify(value) === JSON.stringify(run ?? {})
  } catch {
    return false
  }
}
const shellOf = (part: Record<string, unknown> | undefined) =>
  part && Object.keys(part).length ? toShell(decodeValue(part), 0) : ''
/**
 * A chip removed takes its condition out of the filter run and runs the rest. W1 review (important 1):
 * the bar's text is rewritten only while it is the filter run — edits not yet run (and comments, and
 * the user's layout of a filter that is not the one run) are left as they are, and the toast says so;
 * Undo puts back the text and the query either way. A text search's chip takes its score with it
 * (minor 7): a sort or projection by { $meta: 'textScore' } without $text is refused by MongoDB.
 */
function removeChip(chip: FilterChip): void {
  const before = { draft: { ...state.draft }, query: state.query }
  let next: FindQuery = { ...state.query, filter: withoutChip(state.query.filter, chip) }
  if (chip.path[0] === '$text') {
    const { sort: _sort, projection: _projection, ...rest } = next
    const sort = withoutScore(next.sort)
    const projection = withoutScore(next.projection)
    next = { ...rest, ...(sort ? { sort } : {}), ...(projection ? { projection } : {}) }
  }
  // Final review I6: a template whose values make the filter run loses the condition too, its
  // parameters kept as written.
  const template = templateRun()
  const kept = !template && !textIsRun(state.draft.filter, state.query.filter)
  // Changed in place: the composer keeps its Options as they are (a new draft would open them).
  if (template?.ok && template.template)
    state.draft.filter = toQueryShell(decodeValue(withoutChip(template.template.filter, chip)), 0)
  else if (!kept) state.draft.filter = shellOf(next.filter)
  for (const part of ['sort', 'projection'] as const)
    if (next[part] !== state.query[part] && textIsRun(state.draft[part], state.query[part]))
      state.draft[part] = shellOf(next[part])
  apply(next)
  toasts.push({
    kind: 'info',
    message: t(kept ? 'explorer.chips.removedKept' : 'explorer.chips.removed', { condition: chip.label }),
    actions: [
      {
        label: t('explorer.chips.undo'),
        run: () => {
          state.draft = before.draft
          apply(before.query)
        },
      },
    ],
  })
}
/** The bar was used: suggestions need not wait for the browser to be idle (W1 review, minor 8). */
const barUsed = ref(false)
/** A suggestion is added as a condition of its own, as a cell's "Filter by" is. */
function addSuggestion(s: FilterSuggestion): void {
  filterBy(s.field, s.condition[s.field])
}

// ---- W1 (completion §2): the table's headers sort and size the columns
/**
 * A header sorts the results by writing the query's sort: the bar's query runs with it (from the first
 * page) and the Options' sort text shows it, so the composer stays the one place the sort is read from. A
 * column whose values are hidden is never sorted (the table offers no sort for it either).
 */
function sortBy(field: string, additive: boolean, to?: SortDir | null): void {
  if (masking.matcher.value([field])) return
  const next = cycleSort(state.query.sort, field, additive, to)
  const sort = next ? toShell(next, 0) : ''
  // W1 review (important 2): the bar's query runs with the sort, as a chip or "Filter by" runs it — so
  // the bar always shows what runs; a part still being written is not run half-done.
  const built = buildQuery({ ...state.draft, sort })
  if (!built.ok) {
    toasts.push({ kind: 'error', message: unbuilt(built) })
    return
  }
  // Changed in place: the Options count and the query panel show the sort; the Options panel is not
  // opened for it (on a phone it would leave the table no room).
  state.draft.sort = sort
  apply(built.query)
}
/**
 * W1 review (important 3): widths are kept per collection for this user (in this browser), so another
 * tab of the collection, or a later visit, finds them; the tab's own are taken first.
 */
const session = useSessionStore()
const widthOwner = () => session.me?.user.id ?? null
if (!Object.keys(state.columns.widths ?? {}).length) {
  const kept = loadWidths(widthOwner(), props.target)
  if (Object.keys(kept).length) state.columns = { ...state.columns, widths: kept }
}
/** A drag reports every move: the widths are written once a frame (W1 review, minor 13). */
const pendingWidths = new Map<string, number | null>()
let widthFrame = 0
function resize(field: string, width: number | null): void {
  pendingWidths.set(field, width)
  if (!widthFrame) widthFrame = requestAnimationFrame(writeWidths)
}
function writeWidths(): void {
  widthFrame = 0
  const widths = { ...(state.columns.widths ?? {}) }
  for (const [field, width] of pendingWidths) {
    if (width === null) delete widths[field]
    else widths[field] = Math.round(Math.min(COLUMN_WIDTH.max, Math.max(COLUMN_WIDTH.min, width)))
  }
  pendingWidths.clear()
  state.columns = { ...state.columns, widths }
  saveWidths(widthOwner(), props.target, widths)
}
onBeforeUnmount(() => {
  if (!widthFrame) return
  cancelAnimationFrame(widthFrame)
  writeWidths()
})
function hideColumn(field: string): void {
  if (!state.columns.hidden.includes(field))
    state.columns = { ...state.columns, hidden: [...state.columns.hidden, field] }
}

// Phase 4b §3: plugins' document actions, after the app's own; each opens its plugin with the document.
const plugins = usePluginsStore()
provideCellPlace(() => props.target)
provideRowExtras(
  computed(() =>
    plugins.documentActions.map((a) => ({
      id: a.key,
      label: localized(a.title, locale.value),
      icon: Puzzle,
    })),
  ),
)
const pluginAction = shallowRef<{ action: Contribution; id: unknown } | null>(null)
function openFromPlugin(id: unknown): void {
  pluginAction.value = null
  if (!showDocumentById(state, id)) toasts.push({ kind: 'error', message: t('plugins.badDocument') })
}

function onAction(kind: RowAction, row: Row): void {
  if (kind.startsWith('plugin:')) {
    // A tab of the same id is another thing (review M11): only the document actions.
    const action = plugins.documentActions.find((a) => a.key === kind)
    if (action && row.kind === 'document') pluginAction.value = { action, id: row.raw._id }
    return
  }
  if (kind === 'delete') void actions.remove(row)
  else if (row.kind !== 'document') return
  else if (kind === 'copy') void actions.copy(row)
  else if (kind === 'clone') void setInspector({ kind: 'clone', row })
  else void setInspector({ kind: 'document', id: rowIdKey(row), tab: kind === 'edit' ? 'edit' : 'fields' })
}
</script>

<template>
  <section class="flex h-full min-h-0 flex-col">
    <QueryComposer
      ref="composer"
      v-model="state.draft"
      :completions="completions"
      :target="target"
      :tab-id="tabId"
      :fields="fields"
      :values="valuesFor"
      :types="(path: string) => fieldType(rows, path)"
      @apply="apply"
      @focusin="barUsed = true"
    />
    <SuggestionChips
      v-if="state.ask.mode === 'query'"
      :target="target"
      :filter="state.query.filter"
      :is-view="isView"
      :wanted="barUsed"
      @add="addSuggestion"
    />
    <QueryPanel
      v-if="panelShown"
      :query="state.query"
      :coll="target.coll"
      :intent="intent"
      @edit="composer?.focus()"
      @explain="whySlow"
      @code="coding = true"
      @ask-again="composer?.ask($event)"
      @run="refresh"
      @save="savePanelFavourite"
    />
    <p
      v-if="masking.hidden.value"
      data-masked-banner
      class="flex items-center gap-1.5 px-4 pb-2 text-small text-fg-subtle"
    >
      <Lock class="size-3.5" aria-hidden="true" />{{ t('masking.banner') }}
    </p>
    <div class="flex min-h-0 flex-1">
      <div class="flex min-w-0 flex-1 flex-col">
        <ResultsToolbar
          :state="state"
          :first="shownSkip"
          :loading-page="find.isPlaceholderData.value"
          :count="count.data.value"
          :row-count="rows.length"
          :has-more="find.data.value?.hasMore ?? false"
          :fetching="find.isFetching.value"
          :can-write="writable"
          :can-import="writable"
          :can-export="canExport ?? false"
          @page="state.page = $event"
          @mode="state.mode = $event as ViewMode"
          @refresh="refresh"
          @import="transfer = 'import'"
          @export="transfer = 'export'"
          @copy="transfer = 'copy'"
          @compare="transfer = 'compare'"
          @insert="setInspector({ kind: 'insert' })"
          @bulk="bulk = $event"
        />
        <FilterChips :filter="state.query.filter" @remove="removeChip" @emptied="composer?.focus()" />
        <!-- Reviewer B Minor 11: always in the page, so the first count is announced too. -->
        <p data-selection-status role="status" class="sr-only">{{ selectionStatus }}</p>
        <SelectionBar
          v-if="selected.size"
          :count="selected.size"
          :can-write="writable"
          :can-export="canExport ?? false"
          @copy="copySelected"
          @export="exportSelected"
          @delete="deleteSelected"
          @clear="selected = new Set()"
        />
        <p v-if="isView" class="mx-4 mb-2 rounded-lg bg-subtle px-3 py-1.5 text-small text-fg-muted">
          {{ t('documents.readOnlyView') }}
        </p>
        <div class="min-h-0 flex-1 border-t border-line">
          <DsCallout
            v-if="find.isError.value"
            tone="danger"
            class="m-4"
            :title="t('documents.states.failed')"
          >
            <span class="break-words">{{ describeError(find.error.value, t) }}</span>
            <template #action>
              <DsButton size="sm" :icon="RefreshCw" @click="find.refetch()">{{
                t('documents.states.retry')
              }}</DsButton>
            </template>
          </DsCallout>
          <div
            v-else-if="find.isPending.value"
            class="flex flex-col gap-2 p-4"
            :aria-label="t('documents.loading')"
          >
            <DsSkeleton v-for="i in 6" :key="i" class="h-9 w-full" />
          </div>
          <div
            v-else-if="rows.length === 0 && filtered"
            class="flex flex-col items-center gap-2 px-4 py-16 text-center text-ui"
          >
            <span
              class="grid size-10 place-items-center rounded-xl bg-muted text-fg-muted"
              aria-hidden="true"
            >
              <SearchX class="size-5" />
            </span>
            <p class="font-medium text-fg">{{ t('documents.empty') }}</p>
            <p class="max-w-sm text-fg-muted">{{ t('documents.states.noMatchHint') }}</p>
            <DsButton size="sm" class="mt-1" :icon="FilterX" @click="clearFilter">
              {{ t('documents.states.clearFilter') }}
            </DsButton>
          </div>
          <div
            v-else-if="rows.length === 0"
            data-empty-state
            class="flex flex-col items-center gap-2 px-4 py-16 text-center text-ui"
          >
            <span
              class="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent-fg"
              aria-hidden="true"
            >
              <Inbox class="size-5" />
            </span>
            <p class="font-medium text-fg">{{ t('documents.states.emptyTitle') }}</p>
            <p class="max-w-sm text-fg-muted">
              {{ writable ? t('documents.states.emptyHint') : t('documents.states.emptyReadOnly') }}
            </p>
            <div v-if="writable" class="mt-1 flex flex-wrap justify-center gap-2">
              <DsButton
                size="sm"
                variant="primary"
                :icon="FilePlus2"
                @click="setInspector({ kind: 'insert' })"
              >
                {{ t('documents.insert') }}
              </DsButton>
              <DsButton size="sm" :icon="Upload" @click="transfer = 'import'">
                {{ t('documents.results.importFile') }}
              </DsButton>
            </div>
          </div>
          <div v-else-if="state.mode === 'table'" class="flex h-full min-h-0 flex-col">
            <div class="flex items-center gap-2 border-b border-line px-2 py-1 text-small text-fg-subtle">
              <ColumnsMenu v-model="state.columns" :columns="allColumns" />
              <p v-if="state.query.projection && writable">{{ t('documents.inline.projectionOff') }}</p>
              <p v-if="arranged.overflow > 0" role="status">
                {{ t('documents.columns.overflow', { count: arranged.overflow }, arranged.overflow) }}
              </p>
            </div>
            <DocumentTable
              :target="target"
              :inline-edit="!state.query.projection"
              :rows="rows"
              :columns="arranged.shown"
              :can-write="writable"
              :row-height="rowHeight"
              :selected="selected"
              :sort="state.query.sort ?? {}"
              :widths="state.columns.widths"
              :encrypted-fields="encryptedFields"
              @action="onAction"
              @toggle="toggle"
              @toggle-all="toggleAll"
              @filter-by="filterBy"
              @sort="sortBy"
              @resize="resize"
              @hide="hideColumn"
            />
          </div>
          <DocumentJsonList
            v-else-if="state.mode === 'json'"
            :rows="rows"
            :can-write="writable"
            :selected="selected"
            @action="onAction"
            @toggle="toggle"
          />
          <DocumentChart
            v-else-if="state.mode === 'chart'"
            v-model="state.chart"
            :target="target"
            :query="state.query"
            :rows="rows"
            :count="count.data.value"
          />
          <DocumentCards
            v-else
            :rows="rows"
            :can-write="writable"
            :selected-id="inspectedId"
            :selected="selected"
            @action="onAction"
            @toggle="toggle"
          />
        </div>
      </div>
      <DocumentInspector
        v-if="inspector"
        ref="inspectorRef"
        :target="target"
        :tab-id="tabId"
        :rows="rows"
        :mode="inspector"
        :can-write="writable"
        :fields="fields"
        @update:mode="inspector = $event"
        @close="inspector = null"
        @action="onAction"
      />
    </div>
    <ImportWizard
      v-if="transfer === 'import'"
      :connection-id="target.connectionId"
      :db="target.db"
      :coll="target.coll"
      @close="transfer = null"
    />
    <CopyWizard
      v-if="transfer === 'copy' || transfer === 'compare'"
      :connection-id="target.connectionId"
      :db="target.db"
      :coll="target.coll"
      :query="transfer === 'copy' ? exportQuery : undefined"
      :compare="transfer === 'compare'"
      @close="transfer = null"
    />
    <ExportDataDialog
      v-if="transfer === 'export'"
      :connection-id="target.connectionId"
      :db="target.db"
      :coll="target.coll"
      :query="exportSelection ?? exportQuery"
      :fields="fields"
      @close="((transfer = null), (exportSelection = null))"
    />
    <BulkDialog
      v-if="bulk"
      :target="target"
      :operation="bulk"
      :initial-filter="state.draft.filter"
      :fields="fields"
      @close="bulk = null"
    />
    <ExportDialog
      v-if="coding"
      :db="target.db"
      :coll="target.coll"
      :find="codeQuery"
      @close="coding = false"
    />
    <SaveItemDialog
      v-if="favourite.open.value"
      :title="t('library.saveFavourite')"
      :busy="favourite.busy.value"
      :error="favourite.error.value"
      @save="favourite.save"
      @close="favourite.open.value = false"
    />
    <PluginActionDialog
      :action="pluginAction?.action ?? null"
      :target="target"
      :document-id="pluginAction?.id"
      @close="pluginAction = null"
      @open-document="openFromPlugin"
    />
  </section>
</template>
