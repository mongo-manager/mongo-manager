<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRef, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import DsMenu from '@/ds/DsMenu.vue'
import DsResizeHandle from '@/ds/DsResizeHandle.vue'
import type { DsMenuItem } from '@/ds/menu'
import {
  ArrowDown,
  ArrowDownWideNarrow,
  ArrowUp,
  ArrowUpNarrowWide,
  ChevronDown,
  Copy,
  EyeOff,
  ListFilter,
  Lock,
  MoveHorizontal,
  Pencil,
  Trash2,
  X,
} from 'lucide-vue-next'
import { COLUMN_WIDTH, hasId, rowIdKey, type Row, type RowAction } from './rows'
import { sortState, type SortDir } from './sortModel'
import { copyName } from '@/workspace/copyName'
import { rowId, rowMenuItems, type CellContext } from './rowMenu'
import { useToastStore } from '@/stores/toasts'
import { useRowExtras } from './rowExtras'
import ValueCell from './ValueCell.vue'
import PluginCellText from '@/plugins/PluginCellText.vue'
import NestedValue from './NestedValue.vue'
import { toShell, typeOf } from './values'
import { touches } from './caution'
import InlineCellEditor from './InlineCellEditor.vue'
import { editableType } from './scalarEdit'
import type { CollectionTarget } from '@/api/documents'
import { pathSafe } from '@mongo-manager/shared/browser'
import type { DocumentRow } from './rows'
import { useVirtualRows } from './useVirtualRows'
import { useMaskedPath } from '@/masking/useMaskedPaths'

const props = defineProps<{
  rows: Row[]
  columns: string[]
  canWrite: boolean
  rowHeight: number
  target: CollectionTarget
  /** Off while a projection is applied: the row version would not match the stored document. */
  inlineEdit: boolean
  /** UI redesign R1 checkpoint 3: the selected documents (by _id), when selection is offered. */
  selected?: ReadonlySet<string>
  /** W1 (completion §2): the run query's sort (canonical EJSON); headers sort when it is given. */
  sort?: Record<string, unknown>
  /** W1: the widths the user gave columns, in pixels. */
  widths?: Record<string, number>
  /** W8: fields kept encrypted on the server (client-side encryption), marked with a lock. */
  encryptedFields?: ReadonlySet<string>
  /** Document page design §6.1: the document last open (its row id key), marked when back from it. */
  lastOpened?: string | null
}>()
const emit = defineEmits<{
  action: [kind: RowAction, row: Row]
  toggle: [row: Row]
  toggleAll: []
  /** Filter by a cell's value: the field and the value. */
  filterBy: [field: string, value: unknown]
  /** W1: sort by a column (added to the sort with Shift; `to` a direction from the header's menu). */
  sort: [field: string, additive: boolean, to?: SortDir | null]
  /** W1: a column's new width, or null to let it size itself again. */
  resize: [field: string, width: number | null]
  hide: [field: string]
}>()
const { t } = useI18n()
const extras = useRowExtras()
const isMasked = useMaskedPath()

// ---- W1 (completion §2): headers that sort, resize and copy their name
/**
 * A column sorts when its name is a field path (a top-level name with a dot would sort another field)
 * and its values are not hidden from the user: the server refuses such a sort (phase 3c §3.7), and
 * an order of hidden values would tell them.
 */
const sortable = (column: string) => pathSafe(column) && !isMasked.value([column])
/**
 * W1 review (minor 9, 10): why a header sorts or does not, said by its title and, for screen readers,
 * by a description (one hidden text of each kind, shared by the headers).
 */
const hintIds = { sort: useId(), masked: useId(), path: useId() }
const hintOf = (column: string): keyof typeof hintIds =>
  sortable(column) ? 'sort' : pathSafe(column) ? 'masked' : 'path'
const HINT_TEXT = {
  sort: 'explorer.sort.hint',
  masked: 'explorer.sort.masked',
  path: 'explorer.sort.notPath',
}
/** Each column's sort, worked out once per sort (the header renders again as the rows scroll). */
const sortStates = computed(() => {
  const states = new Map<string, NonNullable<ReturnType<typeof sortState>>>()
  for (const column of props.columns) {
    const s = sortState(props.sort, column)
    if (s) states.set(column, s)
  }
  return states
})
const sorting = (column: string) => sortStates.value.get(column)
function ariaSort(column: string): 'ascending' | 'descending' | undefined {
  const s = sorting(column)
  if (!s || s.position !== 1) return undefined
  return s.dir === 1 ? 'ascending' : 'descending'
}
function onSort(column: string, event: MouseEvent): void {
  if (!sortable(column)) return
  emit('sort', column, event.shiftKey)
}
/** Widths measured when the pointer or focus reaches a header (a drag starts from what is drawn). */
const measured = ref<Record<string, number>>({})
function measure(column: string, event: Event): void {
  const th = (event.currentTarget as HTMLElement | null)?.closest('th')
  const width = th ? Math.round(th.getBoundingClientRect().width) : 0
  if (width > 0) measured.value = { ...measured.value, [column]: width }
}
const widthOf = (column: string) => props.widths?.[column] ?? measured.value[column] ?? COLUMN_WIDTH.default
const fixed = (column: string) => props.widths?.[column]
const headStyle = (column: string) => {
  const w = fixed(column)
  return w ? { width: `${w}px`, minWidth: `${w}px`, maxWidth: `${w}px` } : undefined
}
const cellStyle = (column: string) => {
  const w = fixed(column)
  return w ? { maxWidth: `${w}px`, width: `${w}px` } : undefined
}
function headerMenu(column: string): DsMenuItem[] {
  const s = sorting(column)
  const canSort = sortable(column)
  return [
    ...(props.sort !== undefined || canSort
      ? [
          { id: 'asc', label: t('explorer.sort.ascending'), icon: ArrowUpNarrowWide, disabled: !canSort },
          { id: 'desc', label: t('explorer.sort.descending'), icon: ArrowDownWideNarrow, disabled: !canSort },
          ...(s ? [{ id: 'clear', label: t('explorer.sort.clear'), icon: X }] : []),
        ]
      : []),
    { id: 'copy', label: t('explorer.copyName.action'), icon: Copy, separator: true },
    { id: 'hide', label: t('explorer.column.hide'), icon: EyeOff },
    ...(fixed(column) ? [{ id: 'width', label: t('explorer.column.resetWidth'), icon: MoveHorizontal }] : []),
  ]
}
/** The headers' menus, built when what they offer changes, not on every scroll. */
const headerMenus = computed(() => new Map(props.columns.map((c) => [c, headerMenu(c)])))
function onHeaderMenu(column: string, id: string): void {
  if (id === 'asc' || id === 'desc') {
    if (sortable(column)) emit('sort', column, false, id === 'asc' ? 1 : -1)
  } else if (id === 'clear') emit('sort', column, true, null)
  else if (id === 'copy') void copyName(column, t)
  else if (id === 'hide') emit('hide', column)
  else if (id === 'width') emit('resize', column, null)
}
const container = ref<HTMLElement | null>(null)
const range = useVirtualRows(
  container,
  computed(() => props.rows.length),
  toRef(props, 'rowHeight'),
)
const visible = computed(() => props.rows.slice(range.value.start, range.value.end))

// UI redesign R1 checkpoint 3: each column says the kind of value it holds (its most common one).
const TYPE_SAMPLE = 200
const columnTypes = computed(() => {
  const out = new Map<string, string>()
  const rows = props.rows.slice(0, TYPE_SAMPLE)
  for (const column of props.columns) {
    const counts = new Map<string, number>()
    for (const row of rows)
      if (row.kind === 'document' && Object.hasOwn(row.value, column)) {
        const type = typeOf(row.value[column])
        counts.set(type, (counts.get(type) ?? 0) + 1)
      }
    let best = ''
    for (const [type, n] of counts) if (!best || n > counts.get(best)!) best = type
    if (best) out.set(column, best)
  }
  return out
})
const selecting = computed(() => props.selected !== undefined)
const selectedOnPage = computed(() =>
  props.selected ? props.rows.filter((r) => props.selected!.has(rowIdKey(r))).length : 0,
)
/** Reviewer B I3: the rows that can be selected (those with an _id). */
const selectableCount = computed(() => props.rows.filter(hasId).length)
/** A cell's value can be filtered by when it is a plain value (not a document, not hidden). */
const filterable = (row: DocumentRow, column: string) => {
  if (!Object.hasOwn(row.value, column)) return false
  const value = row.value[column]
  if (isContainer(value)) return false
  if (value === '***' && isMasked.value([column])) return false
  return !['binary', 'code', 'undefined', 'regex'].includes(typeOf(value))
}

const isContainer = (v: unknown) => {
  const type = typeOf(v)
  return type === 'object' || type === 'array'
}

/**
 * Top-level scalar fields other than _id are edited in place; the rest open the document editor.
 * A name that is not a valid path would update another field (final review C1), and a text box
 * would drop line breaks (C2).
 */
const inlineEditable = (row: DocumentRow, column: string) => {
  if (!props.canWrite || !props.inlineEdit || column === '_id' || !pathSafe(column)) return false
  if (!Object.hasOwn(row.value, column)) return false
  const value = row.value[column]
  // Phase 3c §7: a value the server hides is not edited in place (it cannot be changed).
  if (value === '***' && isMasked.value([column])) return false
  if (typeof value === 'string' && /[\r\n]/.test(value)) return false
  // A field shown as a value it is not stored as is not changed in place (data review round 2).
  if (row.caution && touches(row.caution, column)) return false
  return editableType(typeOf(value))
}

const editing = ref<{ key: string; column: string } | null>(null)
const isEditing = (row: Row, column: string) =>
  editing.value?.key === row.key && editing.value.column === column

function startEdit(row: DocumentRow, column: string): void {
  if (inlineEditable(row, column)) editing.value = { key: row.key, column }
}

/** After an edit, focus returns to the cell; a saved row comes back with a new key, so by position. */
let refocus: { index: number; column: string } | null = null

function focusCell(): void {
  if (!refocus) return
  const row = props.rows[refocus.index]
  const cell =
    row &&
    container.value?.querySelector<HTMLElement>(
      `tr[data-key="${CSS.escape(row.key)}"] td[data-field="${CSS.escape(refocus.column)}"]`,
    )
  cell?.focus()
}

async function finishEdit(reloading: boolean): Promise<void> {
  const was = editing.value
  editing.value = null
  if (!was) return
  refocus = { index: props.rows.findIndex((r) => r.key === was.key), column: was.column }
  await nextTick()
  focusCell()
  // Without a reload there is no new row to wait for.
  if (!reloading) refocus = null
}

// The saved row is replaced when the page reloads: focus its cell again, once.
watch(
  () => props.rows,
  async () => {
    if (!refocus) return
    await nextTick()
    focusCell()
    refocus = null
  },
)

// Menus and labels once per rendered row, not once per binding.
const menus = computed(
  () =>
    new Map(
      visible.value.map((row) => [
        row.key,
        { items: rowMenuItems(row, props.canWrite, t, extras.value), id: rowId(row) },
      ]),
    ),
)

// Scrolling the focused row out of the rendered range removes it: keep focus in the table.
let lastFocused: HTMLElement | null = null
let observer: MutationObserver | undefined
onMounted(() => {
  const el = container.value
  if (!el) return
  el.addEventListener('focusin', (event) => {
    lastFocused = event.target as HTMLElement
    keepInSight(lastFocused)
  })
  observer = new MutationObserver(() => {
    if (!lastFocused || lastFocused.isConnected) return
    const active = document.activeElement
    if (active && active !== document.body) return
    lastFocused = null
    el.focus()
  })
  observer.observe(el, { childList: true, subtree: true })
})
onBeforeUnmount(() => observer?.disconnect())

/**
 * User report 2026-11-07 (WCAG 2.4.11): the frozen columns and the sticky header cover what scrolls
 * under them, and the browser scrolls a focused cell into view only when none of it is in the box —
 * Shift+Tab back along a row scrolled sideways left the focus under the row's actions. What takes the
 * focus is moved out from under them (scroll-padding alone moves only what is wholly hidden).
 */
function keepInSight(el: HTMLElement): void {
  const box = container.value
  if (!box || el === box || el.closest('[data-frozen]')) return
  const area = box.getBoundingClientRect()
  const rect = el.getBoundingClientRect()
  const edge = box.querySelector('thead [data-frozen-edge]')?.getBoundingClientRect().right ?? area.left
  if (rect.left < edge) box.scrollLeft -= edge - rect.left
  // The header's own controls move sideways only: the header stays at the top.
  if (el.closest('thead')) return
  const head = box.querySelector('thead')?.getBoundingClientRect().bottom ?? area.top
  if (rect.top < head) box.scrollTop -= head - rect.top
}

// ---- Document page design §6.10: the row's actions where a first-time user looks for them
const toasts = useToastStore()
/** A right click on a row (and the cell it was on): its menu holds the cell's own actions too. */
const context = ref<{ key: string; cell?: CellContext & { value: unknown } } | null>(null)
const rowMenus = new Map<string, { openMenu: () => Promise<void> }>()
/** Keeps a row's menu while it is drawn, for a right click to open it. */
const keepMenu = (key: string) => (el: unknown) =>
  el ? rowMenus.set(key, el as { openMenu: () => Promise<void> }) : rowMenus.delete(key)
function itemsFor(row: Row): DsMenuItem[] {
  const ctx = context.value
  if (ctx?.key === row.key && ctx.cell) return rowMenuItems(row, props.canWrite, t, extras.value, ctx.cell)
  return menus.value.get(row.key)?.items ?? []
}
function cellContext(row: Row, field: string | undefined): (CellContext & { value: unknown }) | undefined {
  if (!field || row.kind !== 'document' || !Object.hasOwn(row.value, field)) return undefined
  const value = row.value[field]
  return { field, value, filter: filterable(row, field) ? toShell(value, 0) : null }
}
async function openRowMenu(row: Row, field: string | undefined): Promise<void> {
  context.value = { key: row.key, cell: cellContext(row, field) }
  await nextTick()
  await rowMenus.get(row.key)?.openMenu()
}
function onContextMenu(event: MouseEvent, row: Row): void {
  if (!menus.value.get(row.key)?.items.length) return
  // Final review minor: selected text (to copy) and a text field (to paste) keep the browser's menu.
  const target = event.target as HTMLElement
  if (target.closest('input, textarea, [contenteditable="true"]')) return
  if (window.getSelection()?.toString()) return
  event.preventDefault()
  void openRowMenu(row, (event.target as HTMLElement).closest<HTMLElement>('td[data-field]')?.dataset.field)
}
function onCellKeydown(event: KeyboardEvent, row: Row, column: string): void {
  if (!(event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) return
  event.preventDefault()
  void openRowMenu(row, column)
}
async function onRowMenu(row: Row, id: string): Promise<void> {
  const cell = context.value?.key === row.key ? context.value.cell : undefined
  context.value = null
  if (id === 'copyValue' && cell) {
    // A hidden value is "***" here already: the server never sent it.
    const text = typeof cell.value === 'string' ? cell.value : toShell(cell.value, 0)
    try {
      await navigator.clipboard.writeText(text)
      toasts.push({ kind: 'success', message: t('documents.valueCopied') })
    } catch {
      toasts.push({ kind: 'error', message: t('documents.copyFailed') })
    }
  } else if (id === 'filterBy' && cell) emit('filterBy', cell.field, cell.value)
  else emit('action', id as RowAction, row)
}
/** The _id cell of a document is a way into it. */
const opensDocument = (row: Row, column: string) => column === '_id' && row.kind === 'document' && hasId(row)
const quickButton =
  'inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 font-sans text-small text-fg-muted transition-colors duration-120 hover:bg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-focus'
// User request 2026-11-05: "freeze the buttons at the start" — the selection box and the row's
// actions stay at the left edge when the fields scroll sideways. A frozen cell is opaque, the surface
// under its row's tint (--row-tint, which the row paints too): the tints are see-through, and the
// fields passing under the cell would show.
const frozen = 'sticky z-[1] bg-surface bg-linear-to-r from-(--row-tint) to-(--row-tint)'

defineExpose({
  /** Scrolls the row of `id` (a row id key) into view when it is out of it. */
  reveal(id: string): void {
    const el = container.value
    const at = props.rows.findIndex((r) => rowIdKey(r) === id)
    if (!el || at < 0) return
    const top = at * props.rowHeight
    if (top < el.scrollTop || top + props.rowHeight > el.scrollTop + el.clientHeight)
      el.scrollTop = Math.max(0, top - el.clientHeight / 2)
  },
})
</script>

<template>
  <div ref="container" data-results-scroll class="@container h-full overflow-auto outline-none" tabindex="-1">
    <span v-for="(id, kind) in hintIds" :id="id" :key="kind" class="sr-only">{{ t(HINT_TEXT[kind]) }}</span>
    <table class="w-max min-w-full border-separate border-spacing-0 text-small">
      <thead class="sticky top-0 z-10 bg-subtle">
        <tr>
          <th
            v-if="selecting"
            scope="col"
            data-frozen
            class="sticky left-0 z-[1] w-8 max-w-8 min-w-8 border-b border-line bg-subtle pl-3"
          >
            <input
              type="checkbox"
              class="size-3.5 cursor-pointer accent-accent align-middle"
              :aria-label="t('documents.selection.all')"
              :checked="selectableCount > 0 && selectedOnPage === selectableCount"
              :indeterminate="selectedOnPage > 0 && selectedOnPage < selectableCount"
              @change="emit('toggleAll')"
            />
          </th>
          <th
            scope="col"
            data-frozen
            data-frozen-edge
            class="sticky z-[1] border-r border-b border-line bg-subtle"
            :class="selecting ? 'left-8' : 'left-0'"
          >
            <span class="sr-only">{{ t('documents.actionsColumn') }}</span>
          </th>
          <th
            v-for="(column, at) in columns"
            :key="column"
            scope="col"
            :data-column="column"
            :aria-sort="ariaSort(column)"
            :style="headStyle(column)"
            class="group/head relative border-b border-line py-1 pr-1 pl-1.5 text-left align-bottom"
            @pointerenter="measure(column, $event)"
            @focusin="measure(column, $event)"
          >
            <div class="flex min-w-0 items-end gap-0.5">
              <button
                type="button"
                data-sort
                class="flex min-w-0 flex-1 flex-col items-start rounded-md px-1.5 py-0.5 text-left transition-colors duration-120 focus-visible:outline-2 focus-visible:outline-focus"
                :class="sortable(column) ? 'cursor-pointer hover:bg-muted' : 'cursor-default'"
                :aria-disabled="sortable(column) ? undefined : 'true'"
                :title="t(HINT_TEXT[hintOf(column)])"
                :aria-describedby="hintIds[hintOf(column)]"
                @click="onSort(column, $event)"
              >
                <span class="flex max-w-full min-w-0 items-center gap-1">
                  <span class="truncate font-mono font-medium text-fg">{{ column }}</span>
                  <Lock
                    v-if="encryptedFields?.has(column)"
                    data-encrypted-field
                    class="size-3 shrink-0 text-accent-fg"
                    :aria-label="t('encryption.fieldMark')"
                    role="img"
                  />
                  <component
                    :is="sorting(column)!.dir === 1 ? ArrowUp : ArrowDown"
                    v-if="sorting(column)"
                    class="size-3.5 shrink-0 text-accent-fg"
                    aria-hidden="true"
                  />
                  <span
                    v-if="sorting(column) && sorting(column)!.count > 1"
                    class="font-sans text-caption font-semibold text-accent-fg tabular-nums"
                    aria-hidden="true"
                    >{{ sorting(column)!.position }}</span
                  >
                  <span v-if="sorting(column) && sorting(column)!.position > 1" class="sr-only">{{
                    t('explorer.sort.secondary', {
                      n: sorting(column)!.position,
                      dir: t(sorting(column)!.dir === 1 ? 'explorer.sort.asc' : 'explorer.sort.desc'),
                    })
                  }}</span>
                </span>
                <span
                  v-if="columnTypes.get(column)"
                  class="block font-sans text-caption font-normal text-fg-subtle"
                  >{{ columnTypes.get(column) }}</span
                >
              </button>
              <DsMenu
                focusable
                :icon="ChevronDown"
                :label="t('explorer.column.menu', { name: column })"
                :items="headerMenus.get(column) ?? []"
                trigger-class="mb-0.5 size-6 rounded-md text-fg-subtle opacity-0 hover:bg-muted hover:text-fg group-focus-within/head:opacity-100 group-hover/head:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-focus aria-expanded:bg-muted aria-expanded:opacity-100 pointer-coarse:opacity-100"
                @select="onHeaderMenu(column, $event)"
              />
            </div>
            <!-- User report 2026-10-30: the last column's handle stays inside the table — standing out
                 past its edge, it widened the table by 3px and scrolled it sideways. -->
            <DsResizeHandle
              edge="right"
              :class="at === columns.length - 1 ? 'right-0!' : undefined"
              :value="widthOf(column)"
              :min="COLUMN_WIDTH.min"
              :max="COLUMN_WIDTH.max"
              :label="t('explorer.column.resize', { name: column })"
              @update:value="emit('resize', column, $event)"
              @dblclick="emit('resize', column, null)"
            />
          </th>
          <th data-row-filler class="w-full border-b border-line" aria-hidden="true" />
        </tr>
      </thead>
      <tbody class="font-mono">
        <tr v-if="range.padTop > 0" aria-hidden="true" :style="{ height: `${range.padTop}px` }" />
        <tr
          v-for="row in visible"
          :key="row.key"
          data-row
          class="group/row bg-(--row-tint)"
          :data-key="row.key"
          :data-last-opened="lastOpened && rowIdKey(row) === lastOpened ? '' : undefined"
          :class="
            selected?.has(rowIdKey(row))
              ? '[--row-tint:color-mix(in_oklab,var(--color-accent-soft)_60%,transparent)]'
              : lastOpened && rowIdKey(row) === lastOpened
                ? '[--row-tint:color-mix(in_oklab,var(--color-accent-soft)_40%,transparent)]'
                : 'hover:[--row-tint:var(--color-subtle)]'
          "
          :style="{ height: `${rowHeight}px` }"
          @dblclick="row.kind === 'document' && canWrite && hasId(row) && emit('action', 'edit', row)"
          @contextmenu="onContextMenu($event, row)"
        >
          <td
            v-if="selecting"
            data-frozen
            :class="frozen"
            class="left-0 w-8 max-w-8 min-w-8 border-b border-line pl-3"
          >
            <input
              type="checkbox"
              class="size-3.5 cursor-pointer accent-accent align-middle"
              :aria-label="t('documents.selection.one', { id: menus.get(row.key)?.id ?? '' })"
              :checked="selected!.has(rowIdKey(row))"
              :disabled="!hasId(row)"
              :title="hasId(row) ? undefined : t('documents.selection.noId')"
              @change="emit('toggle', row)"
            />
          </td>
          <!-- User report 2026-11-05: the row's actions at its start, as SQL tools have them — Edit,
               Delete and the menu, always in sight with their words (the buttons that came under the
               pointer looked bad). A right click opens this same menu; the _id opens the document. -->
          <td
            data-frozen
            :class="[frozen, selecting ? 'left-8' : 'left-0']"
            class="border-r border-b border-line px-1 whitespace-nowrap"
          >
            <div
              v-if="menus.get(row.key)?.items.length"
              data-row-lead
              class="flex items-center gap-0.5"
              @click.capture="context = null"
              @dblclick.stop
            >
              <template v-if="row.kind === 'document' && canWrite && hasId(row)">
                <button
                  type="button"
                  :class="quickButton"
                  :aria-label="t('documents.editDocument', { id: menus.get(row.key)!.id })"
                  @click="emit('action', 'edit', row)"
                >
                  <Pencil class="size-3.5" aria-hidden="true" />{{ t('documents.edit') }}
                </button>
                <button
                  type="button"
                  :class="quickButton"
                  class="hover:text-danger"
                  :aria-label="t('documents.deleteDocument', { id: menus.get(row.key)!.id })"
                  @click="emit('action', 'delete', row)"
                >
                  <Trash2 class="size-3.5" aria-hidden="true" />{{ t('documents.delete') }}
                </button>
              </template>
              <DsMenu
                :ref="keepMenu(row.key)"
                focusable
                :label="t('documents.actions', { id: menus.get(row.key)!.id })"
                :items="itemsFor(row)"
                @select="onRowMenu(row, $event)"
              />
            </div>
          </td>
          <template v-if="row.kind === 'document'">
            <!-- A plugin's hint beside a value (a date beside an ObjectId) gets room for both (user
                 report 2026-10-13: the date was cut short). -->
            <td
              v-for="column in columns"
              :key="column"
              :data-field="column"
              :style="cellStyle(column)"
              :tabindex="inlineEditable(row, column) ? 0 : undefined"
              :aria-keyshortcuts="inlineEditable(row, column) ? 'Enter' : undefined"
              :class="[
                'group/cell relative max-w-80 border-b border-line px-3 has-[[data-plugin-cell]]:max-w-[30rem]',
                isEditing(row, column) ? 'overflow-visible whitespace-nowrap' : 'truncate',
                inlineEditable(row, column) && 'focus-visible:outline-2 focus-visible:outline-focus',
              ]"
              @keydown="onCellKeydown($event, row, column)"
              @dblclick="inlineEditable(row, column) && ($event.stopPropagation(), startEdit(row, column))"
              @keydown.enter.self.prevent="startEdit(row, column)"
            >
              <!-- User report 2026-11-07: the editor lies over the cell, whose value stays (unseen) to
                   hold the column's width — opening it shifted every column after it. -->
              <InlineCellEditor
                v-if="isEditing(row, column)"
                :target="target"
                :row="row"
                :column="column"
                :label="t('documents.inline.label', { field: column, id: menus.get(row.key)?.id ?? '' })"
                @done="finishEdit"
              />
              <!-- What plugins say of a nested value: beside it, or over it from the whole cell. -->
              <PluginCellText
                v-if="Object.hasOwn(row.value, column) && isContainer(row.value[column])"
                :value="row.value[column]"
                :path="[column]"
                host="td"
              >
                <NestedValue
                  :value="row.value[column]"
                  :label="t('documents.nestedShow', { field: column, id: menus.get(row.key)?.id ?? '' })"
                  :path="[column]"
                />
              </PluginCellText>
              <!-- The value gives way before a plugin's hint does: the hint stays whole. -->
              <span
                v-else
                class="inline-flex max-w-full items-center align-middle"
                :class="isEditing(row, column) && 'invisible'"
              >
                <!-- Cut short, the value is whole in its title (review 2026-10-13) — or, where a plugin
                     speaks of it in a tooltip (the time an ObjectId was made), first in that tooltip,
                     which the cell shows when hovered or focused. -->
                <PluginCellText
                  v-slot="{ tipped }"
                  :value="Object.hasOwn(row.value, column) ? row.value[column] : undefined"
                  :path="[column]"
                  host="td"
                  show-value
                >
                  <!-- Design §6.10: the _id opens its document (what plugins say of it stays beside it). -->
                  <component
                    :is="opensDocument(row, column) ? 'button' : 'span'"
                    data-cell-value
                    :type="opensDocument(row, column) ? 'button' : undefined"
                    :data-open-id="opensDocument(row, column) ? '' : undefined"
                    :aria-label="
                      opensDocument(row, column)
                        ? t('documents.inspectDocument', { id: menus.get(row.key)?.id ?? '' })
                        : undefined
                    "
                    class="min-w-0 truncate"
                    :class="
                      opensDocument(row, column)
                        ? 'cursor-pointer text-left underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus'
                        : ''
                    "
                    :title="
                      !tipped && Object.hasOwn(row.value, column) ? toShell(row.value[column], 0) : undefined
                    "
                    @click="
                      opensDocument(row, column) && ($event.stopPropagation(), emit('action', 'inspect', row))
                    "
                    @dblclick="opensDocument(row, column) && $event.stopPropagation()"
                  >
                    <ValueCell
                      :value="Object.hasOwn(row.value, column) ? row.value[column] : undefined"
                      :present="Object.hasOwn(row.value, column)"
                      :path="[column]"
                    />
                  </component>
                </PluginCellText>
              </span>
              <button
                v-if="!isEditing(row, column) && filterable(row, column)"
                type="button"
                class="absolute top-1/2 right-1 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-md bg-surface text-fg-subtle opacity-0 shadow-xs ring-1 ring-line transition-opacity duration-120 group-hover/cell:opacity-100 hover:text-accent-fg focus-visible:opacity-100"
                :aria-label="t('documents.filterBy', { field: column, value: toShell(row.value[column], 0) })"
                :title="t('documents.filterBy', { field: column, value: toShell(row.value[column], 0) })"
                @click.stop="emit('filterBy', column, row.value[column])"
                @dblclick.stop
              >
                <ListFilter class="size-3.5" aria-hidden="true" />
              </button>
            </td>
          </template>
          <td
            v-else
            :colspan="columns.length"
            class="max-w-0 truncate border-b border-line px-3 font-sans text-warning"
            :title="row.reason"
          >
            {{ t('documents.unsupported', { reason: row.reason }) }}
          </td>
          <td data-row-filler class="w-full border-b border-line" aria-hidden="true" />
        </tr>
        <tr v-if="range.padBottom > 0" aria-hidden="true" :style="{ height: `${range.padBottom}px` }" />
      </tbody>
    </table>
  </div>
</template>
