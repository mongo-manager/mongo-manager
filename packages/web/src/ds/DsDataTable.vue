<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts" generic="T">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import DsCallout from './DsCallout.vue'
import DsSkeleton from './DsSkeleton.vue'
import { widthPx, type DsColumn } from './table'

/**
 * UI redesign R2–R5 spec §2: a list of things as a table — 32 px rows (28 dense), a sticky head,
 * a hover row, numbers right-aligned in tabular figures, and each row's actions in the last column,
 * shown on hover or focus (always on touch). Cells are the caller's (`#cell-<key>`); the states
 * (loading, error, empty) take the table's place.
 */

const props = withDefaults(
  defineProps<{
    /** The table's name for screen readers. */
    label: string
    columns: readonly DsColumn[]
    rows: readonly T[]
    rowKey: (row: T) => string
    /** The actions column's name for screen readers; the column is there only with `#actions`. */
    actionsLabel?: string
    loading?: boolean
    dense?: boolean
    /** Rows are told apart when one is the current one (opened, selected). */
    current?: string
    /** What the loading state says to a screen reader (the caller's words). */
    loadingLabel?: string
    /** A failure to load, shown in the table's place (its retry in `#retry`). */
    error?: string
    /** The actions column's width, when a row holds more than its "…" (a download beside it). */
    actionsWidth?: string
    /** Its actions shown all the time (a row's main action, such as Create index or Download). */
    actionsVisible?: boolean
  }>(),
  {
    actionsLabel: undefined,
    loading: false,
    dense: false,
    current: undefined,
    loadingLabel: undefined,
    error: undefined,
    actionsWidth: undefined,
    actionsVisible: false,
  },
)

/**
 * Review of the Monitoring redesign (Important 1): the table measures its own box. Columns marked
 * `hideBelow` leave when the box is narrower; the fixed widths apply only when they fit with room for
 * the other columns (8 rem each), else every column shares the box. The actions column always stays,
 * so a row's menu is never clipped. Unmeasured (no layout), the box counts as wide.
 */
const box = ref<HTMLElement | null>(null)
const boxWidth = ref(Number.POSITIVE_INFINITY)
let observer: ResizeObserver | undefined
onMounted(() => {
  const el = box.value
  if (!el) return
  if (el.clientWidth > 0) boxWidth.value = el.clientWidth
  if (typeof ResizeObserver === 'undefined') return
  observer = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width
    if (width) boxWidth.value = width
  })
  observer.observe(el)
})
onBeforeUnmount(() => observer?.disconnect())

const FLEX_MIN = 128
const ACTIONS_PX = 56
const shown = computed(() =>
  props.columns.filter((c) => c.hideBelow === undefined || boxWidth.value >= c.hideBelow),
)
const widthsFit = computed(() => {
  const width = boxWidth.value
  if (!Number.isFinite(width)) return true
  let needed = props.actionsWidth ? widthPx(props.actionsWidth, width) || ACTIONS_PX : ACTIONS_PX
  for (const c of shown.value) needed += c.width ? widthPx(c.width, width) || FLEX_MIN : FLEX_MIN
  return needed <= width
})
const widthOf = (c: DsColumn) => (c.width && widthsFit.value ? { width: c.width } : undefined)
/** A cell's own value, when the caller gives no slot for its column. */
const cell = (row: T, key: string) => (row as Record<string, unknown>)[key]

defineSlots<{
  [cell: `cell-${string}`]: (props: { row: T; index: number }) => unknown
  actions?: (props: { row: T; index: number }) => unknown
  empty?: () => unknown
  loading?: () => unknown
  retry?: () => unknown
}>()
</script>

<template>
  <!-- No scroll box of its own, so the head sticks to the page's scroller (review of K+R2, I4); clipped,
       with fixed columns, so a long value truncates in its cell rather than widen the page (R3, I-2). -->
  <div ref="box" class="min-w-0 overflow-x-clip">
    <DsCallout v-if="error" tone="danger">
      {{ error }}
      <template v-if="$slots.retry" #action><slot name="retry" /></template>
    </DsCallout>
    <div
      v-else-if="loading"
      class="flex flex-col gap-2 p-1"
      role="status"
      :aria-label="loadingLabel ?? label"
    >
      <slot name="loading">
        <DsSkeleton v-for="n in 4" :key="n" class="h-6" />
      </slot>
    </div>
    <slot v-else-if="rows.length === 0" name="empty" />
    <table v-else class="w-full table-fixed border-separate border-spacing-0 text-ui" :aria-label="label">
      <thead>
        <tr>
          <th
            v-for="column in shown"
            :key="column.key"
            scope="col"
            class="sticky top-0 z-10 border-b border-line bg-surface px-3 py-2 text-small font-medium whitespace-nowrap text-fg-subtle first:pl-4"
            :class="column.align === 'right' ? 'text-right' : 'text-left'"
            :style="widthOf(column)"
          >
            <span :class="column.hideLabel ? 'sr-only' : ''">{{ column.label }}</span>
          </th>
          <th
            v-if="$slots.actions"
            scope="col"
            class="sticky top-0 z-10 border-b border-line bg-surface pr-2"
            :class="actionsWidth ? '' : 'w-14'"
            :style="actionsWidth ? { width: actionsWidth } : undefined"
          >
            <span class="sr-only">{{ actionsLabel }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(row, index) in rows"
          :key="rowKey(row)"
          class="group/row transition-colors duration-120 hover:bg-subtle"
          :class="
            current !== undefined && rowKey(row) === current ? 'bg-accent-soft hover:bg-accent-soft' : ''
          "
          :aria-current="current !== undefined && rowKey(row) === current ? 'true' : undefined"
        >
          <td
            v-for="column in shown"
            :key="column.key"
            class="overflow-hidden border-b border-line px-3 text-ellipsis align-middle first:pl-4"
            :class="[
              dense ? 'h-7' : 'h-8',
              column.align === 'right' ? 'text-right tabular-nums' : '',
              column.mono ? 'font-mono text-[12.5px]' : '',
            ]"
          >
            <slot :name="`cell-${column.key}`" :row="row" :index="index">
              {{ cell(row, column.key) }}
            </slot>
          </td>
          <td v-if="$slots.actions" class="border-b border-line pr-2 text-right align-middle">
            <div
              class="flex justify-end"
              :class="
                actionsVisible
                  ? ''
                  : 'opacity-0 transition-opacity duration-120 group-hover/row:opacity-100 group-focus-within/row:opacity-100 has-[[aria-expanded=true]]:opacity-100 pointer-coarse:opacity-100'
              "
            >
              <slot name="actions" :row="row" :index="index" />
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
