<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowDown,
  ArrowDownFromLine,
  ArrowRight,
  ArrowUp,
  ArrowUpFromLine,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Columns2,
  FoldVertical,
  Rows2,
  UnfoldVertical,
} from 'lucide-vue-next'
import type { FieldChange } from '@mongo-manager/shared/browser'
import DsBadge from '@/ds/DsBadge.vue'
import DsIconButton from '@/ds/DsIconButton.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import { toShell, typeOf } from '../values'
import { diffLines, foldUnchanged, inlineChange, type DiffRow, type Spans } from '../lineDiff'
import { valueChanges } from '../valueChanges'
import { DiffLine } from './diffLine'

/**
 * User request 2026-11-07: the review before a save, as a code review shows a commit — each field's
 * value as indented lines, the old beside the new, the changed part of a line marked, and long runs
 * of unchanged lines folded. Narrow, or by choice, the two sides stack in one column.
 *
 * User reports 2026-11-07 on the first versions: unchanged lines opened could not be folded again;
 * opening them sent the change out of sight ("the changed line must always be seen"). Lines open 20
 * at a time above or below a change, or all, and fold again, and the change stays on the screen
 * whatever opens or folds; the bar moves from change to change (also N and P), a map at the side
 * shows where the changes are, a button brings one back when scrolling left none in sight, and each
 * nested field says in words which values changed.
 */
const props = defineProps<{
  changes: FieldChange[]
  /**
   * User request 2026-11-07: the whole document is written (replaced) — one change, the document
   * before and after, shown as such: every field, the ones not changed too.
   */
  whole?: boolean
}>()
const { t } = useI18n()

type Layout = 'split' | 'unified'
const LAYOUT_KEY = 'mm.reviewDiffLayout'
function storedLayout(): Layout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'unified' ? 'unified' : 'split'
  } catch {
    return 'split'
  }
}
const layout = ref<Layout>(storedLayout())
watch(layout, (value) => {
  try {
    localStorage.setItem(LAYOUT_KEY, value)
  } catch {
    // A per-viewer convenience: without storage the choice lasts as long as the page.
  }
})
const layouts = computed(() => [
  { value: 'split' as const, label: t('editor.diff.split'), icon: Columns2 },
  { value: 'unified' as const, label: t('editor.diff.unified'), icon: Rows2 },
])

/** Below this width the two sides would be too narrow to read: one column. */
const SPLIT_MIN_WIDTH = 760
const root = ref<HTMLElement | null>(null)
const scroller = ref<HTMLElement | null>(null)
const content = ref<HTMLElement | null>(null)
const narrow = ref(false)
let observer: ResizeObserver | null = null
onMounted(() => {
  document.addEventListener('keydown', onKey)
  // The review takes the focus: Escape, Ctrl+Enter, N and P work at once, the arrows scroll it.
  scroller.value?.focus({ preventScroll: true })
  void nextTick(measureAll)
  if (!root.value || typeof ResizeObserver === 'undefined') return
  observer = new ResizeObserver(() => {
    narrow.value = (root.value?.getBoundingClientRect().width ?? SPLIT_MIN_WIDTH) < SPLIT_MIN_WIDTH
    measureAll()
  })
  observer.observe(root.value)
  if (content.value) observer.observe(content.value)
})
onBeforeUnmount(() => {
  observer?.disconnect()
  document.removeEventListener('keydown', onKey)
})
const split = computed(() => layout.value === 'split' && !narrow.value)

/** A field's rows shown at first; a value of many lines (a large array added) shows the rest on request. */
const FIRST_ROWS = 3000
const MORE_ROWS = 5000
/** Unchanged lines opened at a time above or below a change. */
const STEP = 20
/** A run of opened lines this long has a Hide at its end too, not only at its start. */
const LONG_RUN = 30

const lines = (change: FieldChange, side: 'before' | 'after') =>
  side in change ? toShell(change[side], 2).split('\n') : []
/** A document or an array: a value whose changes are worth naming by path. */
const nested = (v: unknown) =>
  Array.isArray(v) ||
  (v !== null && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v)))
const fields = computed(() =>
  props.changes.map((change) => {
    const rows = diffLines(lines(change, 'before'), lines(change, 'after'))
    const kind = props.whole
      ? 'replaced'
      : 'before' in change
        ? 'after' in change
          ? 'changed'
          : 'removed'
        : 'added'
    const fieldCount = Object.keys((change.after ?? {}) as object).length
    const types = props.whole
      ? t('editor.diff.fieldCount', { n: fieldCount }, fieldCount)
      : 'before' in change && 'after' in change && typeOf(change.before) !== typeOf(change.after)
        ? `${typeOf(change.before)} → ${typeOf(change.after)}`
        : typeOf('after' in change ? change.after : change.before)
    const summary =
      kind !== 'added' && kind !== 'removed' && nested(change.before) && nested(change.after)
        ? valueChanges(change.path, change.before, change.after)
        : null
    return {
      change,
      label: props.whole ? t('editor.diff.writeWhole') : change.path,
      kind,
      types,
      summary: summary?.changes.length ? summary : null,
      parts: foldUnchanged(rows),
      added: rows.filter((r) => r.kind === 'add' || r.kind === 'mod').length,
      removed: rows.filter((r) => r.kind === 'del' || r.kind === 'mod').length,
    } as const
  }),
)
const totals = computed(() => ({
  added: fields.value.reduce((s, f) => s + f.added, 0),
  removed: fields.value.reduce((s, f) => s + f.removed, 0),
}))

/** Fields folded by their header; lines opened in each fold (from its top and from its bottom). */
const closed = reactive(new Set<number>())
const opened = reactive(new Map<string, { top: number; bottom: number }>())
const limits = reactive(new Map<number, number>())
const current = ref(0)
const marked = ref<string | null>(null)
watch(
  () => props.changes,
  () => {
    closed.clear()
    opened.clear()
    limits.clear()
    current.value = 0
    marked.value = null
  },
)
const toggle = (i: number) => (closed.has(i) ? closed.delete(i) : closed.add(i))

/** What a field shows, in order: lines, a fold's bar, the Hide of lines opened. */
type Item =
  | { type: 'row'; key: string; row: DiffRow; hunk?: number }
  | { type: 'fold'; key: string; fold: string; hidden: number; below: boolean; above: boolean; open: boolean }
  | { type: 'hide'; key: string; fold: string; count: number }

const changed = (part: { kind: string } | undefined) => !!part && part.kind !== 'fold' && part.kind !== 'same'
/** Every change (a run of lines changed together) of every field, in order: what N and P move to. */
const hunks = computed(() => {
  const out: Array<{ field: number; key: string }> = []
  fields.value.forEach((f, i) =>
    f.parts.forEach((part, p) => {
      if (changed(part) && !changed(f.parts[p - 1])) out.push({ field: i, key: String(p) })
    }),
  )
  return out
})
const hunkAt = computed(() => new Map(hunks.value.map((h, n) => [`${h.field}:${h.key}`, n])))

function items(i: number): Item[] {
  const parts = fields.value[i]!.parts
  const out: Item[] = []
  parts.forEach((part, p) => {
    if (part.kind !== 'fold') {
      out.push({ type: 'row', key: String(p), row: part, hunk: hunkAt.value.get(`${i}:${p}`) })
      return
    }
    const fold = `${i}:${p}`
    const total = part.rows.length
    const { top, bottom } = opened.get(fold) ?? { top: 0, bottom: 0 }
    const hidden = total - top - bottom
    const row = (r: number): Item => ({ type: 'row', key: `${p}.${r}`, row: part.rows[r]! })
    if (hidden <= 0) {
      out.push({ type: 'hide', key: `fold:${p}`, fold, count: total })
      for (let r = 0; r < total; r++) out.push(row(r))
      if (total >= LONG_RUN) out.push({ type: 'hide', key: `fold:${p}:end`, fold, count: total })
      return
    }
    for (let r = 0; r < top; r++) out.push(row(r))
    out.push({
      type: 'fold',
      key: `fold:${p}`,
      fold,
      hidden,
      // Lines open below the change before the fold, and above the change after it.
      below: p > 0,
      above: p < parts.length - 1,
      open: top + bottom > 0,
    })
    for (let r = total - bottom; r < total; r++) out.push(row(r))
  })
  return out
}
const shown = computed(() =>
  fields.value.map((_, i) => {
    const all = items(i)
    const limit = limits.get(i) ?? FIRST_ROWS
    return { items: all.slice(0, limit), rest: Math.max(0, all.length - limit) }
  }),
)

// ---- The change stays on the screen whatever opens or folds
const rowEl = (field: number, key: string) =>
  scroller.value?.querySelector<HTMLElement>(`[data-review-field="${field}"] [data-key="${key}"]`) ?? null
/** Room kept between a change brought into sight and the edges (the field's header is over the top). */
const MARGIN = 24
/** Scrolls as little as it takes for the element to be in sight, below its field's sticky header. */
function reveal(el: HTMLElement | null): void {
  const box = scroller.value
  if (!el || !box) return
  const view = box.getBoundingClientRect()
  const header = el.closest('[data-review-field]')?.querySelector('h3')?.getBoundingClientRect().height ?? 0
  const at = el.getBoundingClientRect()
  const top = view.top + header + MARGIN
  const bottom = view.bottom - MARGIN
  if (at.top < top) box.scrollTop -= top - at.top
  else if (at.bottom > bottom) box.scrollTop += at.bottom - bottom
}
/** Changes what is shown, the change named staying where it was on the screen, and in sight. */
async function keepPlace(field: number, key: string, change: () => void): Promise<void> {
  const top = rowEl(field, key)?.getBoundingClientRect().top
  change()
  await nextTick()
  const el = rowEl(field, key)
  const now = el?.getBoundingClientRect().top
  if (top !== undefined && now !== undefined && scroller.value) scroller.value.scrollTop += now - top
  reveal(el)
  measureAll()
}
function foldOf(fold: string) {
  const [i, p] = fold.split(':').map(Number) as [number, number]
  const parts = fields.value[i]!.parts
  const part = parts[p]!
  // The changes either side of the fold (none before the first, none after the last).
  let before: string | null = null
  let after: string | null = null
  for (let q = p - 1; q >= 0 && before === null; q--) if (changed(parts[q])) before = String(q)
  for (let q = p + 1; q < parts.length && after === null; q++) if (changed(parts[q])) after = String(q)
  return { i, p, total: part.kind === 'fold' ? part.rows.length : 0, before, after }
}
function open(fold: string, how: 'below' | 'above' | 'all'): void {
  const { i, total, before, after } = foldOf(fold)
  const now = opened.get(fold) ?? { top: 0, bottom: 0 }
  const next =
    how === 'all'
      ? { top: total, bottom: 0 }
      : how === 'below'
        ? { ...now, top: Math.min(total - now.bottom, now.top + STEP) }
        : { ...now, bottom: Math.min(total - now.top, now.bottom + STEP) }
  // Lines opened below a change come under it, which stays; above one, or all, they come over the
  // change after the fold, which stays (the end of a value has none: the change before it stays).
  const anchor = how === 'below' ? (before ?? after) : (after ?? before)
  if (anchor) void keepPlace(i, anchor, () => opened.set(fold, next))
  else opened.set(fold, next)
}
function hide(fold: string): void {
  const { i, before, after } = foldOf(fold)
  const anchor = after ?? before
  if (anchor) void keepPlace(i, anchor, () => opened.delete(fold))
  else opened.delete(fold)
}

/** Every fold open, or none: the change the bar is at stays where it is. */
const allOpen = computed(() =>
  fields.value.every((f, i) =>
    f.parts.every((part, p) => {
      if (part.kind !== 'fold') return true
      const o = opened.get(`${i}:${p}`)
      return !!o && o.top + o.bottom >= part.rows.length
    }),
  ),
)
const hasFolds = computed(() => fields.value.some((f) => f.parts.some((p) => p.kind === 'fold')))
function openAll(): void {
  const target = hunks.value[current.value] ?? hunks.value[0]
  const change = () => {
    if (allOpen.value) opened.clear()
    else
      fields.value.forEach((f, i) =>
        f.parts.forEach((part, p) => {
          if (part.kind === 'fold') opened.set(`${i}:${p}`, { top: part.rows.length, bottom: 0 })
        }),
      )
  }
  if (target) void keepPlace(target.field, target.key, change)
  else change()
}

// ---- Moving from change to change
async function goTo(n: number): Promise<void> {
  const target = hunks.value[n]
  if (!target) return
  current.value = n
  const { field, key } = target
  closed.delete(field)
  const at = items(field).findIndex((it) => it.key === key)
  if (at >= (limits.get(field) ?? FIRST_ROWS)) limits.set(field, at + MORE_ROWS)
  marked.value = `${field}:${key}`
  await nextTick()
  rowEl(field, key)?.scrollIntoView?.({ block: 'center' })
  measureAll()
}
function go(step: number): void {
  const count = hunks.value.length
  if (!count) return
  // The first press goes to the first change (the one shown when the review opened).
  void goTo(marked.value === null && step > 0 ? 0 : (current.value + step + count) % count)
}
/** N and P, as in a code review — not while something is typed in, nor with a modifier. */
function onKey(event: KeyboardEvent): void {
  if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return
  const el = event.target as HTMLElement | null
  if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return
  if (document.querySelector('[aria-modal="true"]') || !root.value?.isConnected) return
  const k = event.key.toLowerCase()
  if (k !== 'n' && k !== 'p') return
  event.preventDefault()
  go(k === 'n' ? 1 : -1)
}

// ---- Where the changes are: the map at the side, and the way back to one out of sight
type Tone = 'del' | 'add' | 'mod'
const view = reactive({ top: 0, height: 1, scrollable: false })
const markers = ref<Array<{ top: number; height: number; tone: Tone }>>([])
/** Which way the nearest change is when none is in sight (null while one is), and which one it is. */
const away = ref<null | 'up' | 'down'>(null)
let nearest = 0
function measureView(): void {
  const box = scroller.value
  if (!box) return
  const total = box.scrollHeight || 1
  view.top = box.scrollTop / total
  view.height = Math.min(1, box.clientHeight / total)
  view.scrollable = box.scrollHeight > box.clientHeight + 40
  const b = box.getBoundingClientRect()
  let best = Number.POSITIVE_INFINITY
  let seen = false
  for (const el of box.querySelectorAll<HTMLElement>('tr[data-hunk]')) {
    const r = el.getBoundingClientRect()
    if (r.bottom > b.top + 40 && r.top < b.bottom) {
      seen = true
      break
    }
    const distance = r.top < b.top ? b.top - r.bottom : r.top - b.bottom
    if (distance < best) {
      best = distance
      nearest = Number(el.dataset.hunk)
      away.value = r.top < b.top ? 'up' : 'down'
    }
  }
  if (seen || best === Number.POSITIVE_INFINITY) away.value = null
}
function measureMarkers(): void {
  const box = scroller.value
  if (!box) return
  const total = box.scrollHeight || 1
  const top0 = box.getBoundingClientRect().top - box.scrollTop
  const out: Array<{ top: number; height: number; tone: Tone }> = []
  for (const el of box.querySelectorAll<HTMLElement>('tr[data-change]')) {
    const r = el.getBoundingClientRect()
    const top = (r.top - top0) / total
    const height = r.height / total
    const tone = el.dataset.change as Tone
    const last = out.at(-1)
    // Rows next to each other are one mark; a mark of removed and added lines is a change.
    if (last && top - (last.top + last.height) < 0.002) {
      last.height = top + height - last.top
      if (last.tone !== tone) last.tone = 'mod'
    } else out.push({ top, height, tone })
  }
  markers.value = out
}
/** Measured once a frame at most (at once where there are no frames, as in tests). */
let frame = 0
function onFrame(work: () => void): void {
  if (typeof requestAnimationFrame !== 'function') return work()
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(work)
}
function measureAll(): void {
  onFrame(() => {
    measureView()
    measureMarkers()
  })
}
const onScroll = () => onFrame(measureView)
watch([shown, split], () => void nextTick(measureAll))
/** A press on the map scrolls there, the place pressed in the middle. */
function onMapPress(event: MouseEvent): void {
  const box = scroller.value
  const map = event.currentTarget as HTMLElement
  if (!box) return
  const ratio = (event.clientY - map.getBoundingClientRect().top) / map.getBoundingClientRect().height
  box.scrollTop = ratio * box.scrollHeight - box.clientHeight / 2
}
const MARK_TONE = { del: 'bg-danger', add: 'bg-success', mod: 'bg-info' } as const

/** A line's text in three parts: the part changed in place is marked. */
function spans(row: DiffRow, side: 'before' | 'after'): Spans {
  if (row.kind !== 'mod') return [row.text, '', '']
  return inlineChange(row.before, row.after)?.[side] ?? [row[side], '', '']
}
/** The sign of lines removed (a minus, not a hyphen). */
const MINUS = '−'
const NUM = 'border-r border-line px-2 text-right align-top text-fg-subtle select-none tabular-nums'
const NUM_TONE = {
  same: '',
  del: 'bg-danger/10 text-danger shadow-[inset_3px_0_0_var(--ds-danger)]',
  add: 'bg-success/10 text-success shadow-[inset_3px_0_0_var(--ds-success)]',
} as const
const TEXT = 'border-r border-line px-2 align-top break-all whitespace-pre-wrap text-fg last:border-r-0'
const TEXT_TONE = { same: '', del: 'bg-danger-soft', add: 'bg-success-soft' } as const
/** The side a line was added to or removed from has none: hatched, as code reviews draw it. */
const EMPTY =
  'border-r border-line bg-subtle/40 bg-[image:repeating-linear-gradient(135deg,var(--ds-line-strong)_0_1px,transparent_1px_7px)] last:border-r-0'
const KIND_TONE = { changed: 'info', added: 'success', removed: 'danger', replaced: 'warning' } as const
const CURRENT = 'data-current:outline-2 data-current:-outline-offset-2 data-current:outline-accent'
const counts = 'shrink-0 font-mono text-small tabular-nums'
const barButton =
  'inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 font-sans text-small text-fg-muted hover:bg-accent-soft hover:text-accent-fg focus-visible:outline-2 focus-visible:outline-accent'
const toolButton =
  'inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-small text-fg-muted transition-colors duration-120 hover:bg-subtle hover:text-fg'
const tone = (row: DiffRow, side: 'del' | 'add') => (row.kind === 'same' ? 'same' : side)
</script>

<template>
  <section ref="root" data-test="diff" data-review-diff class="flex min-h-0 flex-col">
    <div
      data-review-bar
      class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-canvas px-4 py-2"
    >
      <slot name="summary" />
      <span :class="counts" data-review-totals>
        <span class="text-success">+{{ totals.added }}</span>
        <span class="ml-1.5 text-danger">{{ MINUS }}{{ totals.removed }}</span>
        <span class="sr-only">{{ t('editor.diff.lineCounts', totals) }}</span>
      </span>
      <div class="ml-auto flex flex-wrap items-center gap-1">
        <div
          v-if="hunks.length"
          class="flex items-center gap-0.5"
          role="group"
          :aria-label="t('editor.diff.changes')"
        >
          <DsIconButton
            :icon="ChevronUp"
            size="sm"
            :label="t('editor.diff.previous')"
            :shortcut="['P']"
            data-review-previous
            @click="go(-1)"
          />
          <span class="min-w-24 text-center text-small text-fg-muted tabular-nums" data-review-position>
            {{ t('editor.diff.position', { n: current + 1, total: hunks.length }) }}
          </span>
          <DsIconButton
            :icon="ChevronDown"
            size="sm"
            :label="t('editor.diff.next')"
            :shortcut="['N']"
            data-review-next
            @click="go(1)"
          />
        </div>
        <button v-if="hasFolds" type="button" :class="toolButton" data-review-all @click="openAll">
          <component :is="allOpen ? FoldVertical : UnfoldVertical" class="size-3.5" aria-hidden="true" />
          {{ allOpen ? t('editor.diff.onlyChanges') : t('editor.diff.allLines') }}
        </button>
        <DsSegmented
          v-if="!narrow"
          v-model="layout"
          size="sm"
          :label="t('editor.diff.layout')"
          :options="layouts"
        />
      </div>
    </div>

    <div class="relative flex min-h-0 flex-1">
      <div
        ref="scroller"
        data-document-content
        role="region"
        tabindex="0"
        :aria-label="t('editor.diff.changes')"
        class="min-h-0 min-w-0 flex-1 overflow-auto [overflow-anchor:none] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        @scroll.passive="onScroll"
      >
        <div ref="content" class="flex flex-col gap-3 p-4">
          <slot name="notice" />
          <article
            v-for="(field, i) in fields"
            :key="`${i}:${field.change.path}`"
            :data-kind="field.kind"
            :data-review-field="i"
            class="shrink-0 rounded-lg border border-line bg-raised"
          >
            <h3
              class="sticky top-0 z-[1] m-0 rounded-t-lg border-b border-line bg-subtle text-ui font-normal"
            >
              <button
                type="button"
                class="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-t-lg px-3 py-2 text-left hover:bg-line/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                :aria-expanded="!closed.has(i)"
                @click="toggle(i)"
              >
                <component
                  :is="closed.has(i) ? ChevronRight : ChevronDown"
                  class="size-4 shrink-0 text-fg-subtle"
                  aria-hidden="true"
                />
                <span
                  class="min-w-0 truncate font-semibold text-fg"
                  :class="{ 'font-mono': !whole }"
                  :title="field.label"
                  >{{ field.label }}</span
                >
                <DsBadge :tone="KIND_TONE[field.kind]">{{ t(`editor.diff.kind.${field.kind}`) }}</DsBadge>
                <span class="truncate text-small text-fg-subtle">{{ field.types }}</span>
                <span :class="counts" class="ml-auto">
                  <span class="text-success">+{{ field.added }}</span>
                  <span class="ml-1.5 text-danger">{{ MINUS }}{{ field.removed }}</span>
                  <span class="sr-only">{{ t('editor.diff.lineCounts', field) }}</span>
                </span>
              </button>
            </h3>

            <!-- The values changed, by path: what the lines below say, in words -->
            <ul
              v-if="field.summary && !closed.has(i)"
              data-review-summary
              :aria-label="t('editor.diff.valuesChanged')"
              class="m-0 flex list-none flex-col gap-1 border-b border-line px-3 py-2 text-small"
            >
              <li
                v-for="(c, k) in field.summary.changes"
                :key="`${k}:${c.path}`"
                class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 font-mono"
              >
                <span class="text-fg">{{ c.path }}</span>
                <span class="sr-only">{{ t(`editor.diff.kind.${c.kind}`) }}</span>
                <del
                  v-if="c.before !== undefined"
                  class="rounded-sm bg-danger-soft px-1 break-all text-danger decoration-danger/50"
                  >{{ c.before }}</del
                >
                <ArrowRight
                  v-if="c.kind === 'changed'"
                  class="size-3 shrink-0 text-fg-subtle"
                  aria-hidden="true"
                />
                <ins
                  v-if="c.after !== undefined"
                  class="rounded-sm bg-success-soft px-1 break-all text-success no-underline"
                  >{{ c.after }}</ins
                >
              </li>
              <li v-if="field.summary.more" class="text-fg-subtle">
                {{ t('editor.diff.moreValues', { n: field.summary.more }, field.summary.more) }}
              </li>
            </ul>

            <div v-if="!closed.has(i)" class="overflow-hidden rounded-b-lg font-mono text-[12.5px] leading-5">
              <table
                class="w-full table-fixed border-collapse"
                :data-layout="split ? 'split' : 'unified'"
                :aria-label="t('editor.diff.table', { path: field.label })"
              >
                <colgroup>
                  <col class="w-12" />
                  <col :class="split ? '' : 'w-12'" />
                  <col v-if="split" class="w-12" />
                  <col />
                </colgroup>
                <tbody>
                  <template v-for="item in shown[i]!.items" :key="item.key">
                    <!-- Unchanged lines folded: open them below the change before, above the one after, or all -->
                    <tr v-if="item.type === 'fold'" data-fold :data-key="item.key">
                      <td :colspan="split ? 4 : 3" class="border-y border-line bg-subtle/70 px-2 py-0.5">
                        <div class="flex flex-wrap items-center gap-1 font-sans">
                          <DsIconButton
                            v-if="item.below"
                            :icon="ArrowDownFromLine"
                            size="sm"
                            :label="
                              t(
                                'editor.diff.openBelow',
                                { n: Math.min(STEP, item.hidden) },
                                Math.min(STEP, item.hidden),
                              )
                            "
                            data-open-below
                            @click="open(item.fold, 'below')"
                          />
                          <DsIconButton
                            v-if="item.above"
                            :icon="ArrowUpFromLine"
                            size="sm"
                            :label="
                              t(
                                'editor.diff.openAbove',
                                { n: Math.min(STEP, item.hidden) },
                                Math.min(STEP, item.hidden),
                              )
                            "
                            data-open-above
                            @click="open(item.fold, 'above')"
                          />
                          <button
                            type="button"
                            :class="barButton"
                            data-open-all
                            @click="open(item.fold, 'all')"
                          >
                            <UnfoldVertical class="size-3.5" aria-hidden="true" />
                            {{ t('editor.diff.hidden', { n: item.hidden }, item.hidden) }}
                          </button>
                          <button
                            v-if="item.open"
                            type="button"
                            :class="barButton"
                            data-hide
                            @click="hide(item.fold)"
                          >
                            <FoldVertical class="size-3.5" aria-hidden="true" />{{ t('editor.diff.hide') }}
                          </button>
                        </div>
                      </td>
                    </tr>
                    <!-- Lines opened in full: Hide folds them again -->
                    <tr v-else-if="item.type === 'hide'" data-hide-row :data-key="item.key">
                      <td :colspan="split ? 4 : 3" class="border-y border-line bg-subtle/70 px-2 py-0.5">
                        <button type="button" :class="barButton" data-hide @click="hide(item.fold)">
                          <FoldVertical class="size-3.5" aria-hidden="true" />
                          {{ t('editor.diff.hideShown', { n: item.count }, item.count) }}
                        </button>
                      </td>
                    </tr>

                    <!-- Side by side: the old line on the left, the new on the right -->
                    <tr
                      v-else-if="split"
                      :data-row="item.row.kind"
                      :data-change="item.row.kind === 'same' ? undefined : item.row.kind"
                      :data-key="item.key"
                      :data-hunk="item.hunk"
                      :data-current="marked === `${i}:${item.key}` || undefined"
                      :class="CURRENT"
                    >
                      <template v-if="item.row.kind === 'add'">
                        <td :class="EMPTY" />
                        <td :class="EMPTY" />
                      </template>
                      <template v-else>
                        <td :class="[NUM, NUM_TONE[tone(item.row, 'del')]]">{{ item.row.left }}</td>
                        <td :class="[TEXT, TEXT_TONE[tone(item.row, 'del')]]">
                          <DiffLine :spans="spans(item.row, 'before')" :tone="tone(item.row, 'del')" />
                        </td>
                      </template>
                      <template v-if="item.row.kind === 'del'">
                        <td :class="EMPTY" />
                        <td :class="EMPTY" />
                      </template>
                      <template v-else>
                        <td :class="[NUM, NUM_TONE[tone(item.row, 'add')]]">{{ item.row.right }}</td>
                        <td :class="[TEXT, TEXT_TONE[tone(item.row, 'add')]]">
                          <DiffLine :spans="spans(item.row, 'after')" :tone="tone(item.row, 'add')" />
                        </td>
                      </template>
                    </tr>

                    <!-- One column: a line changed in place is its old line, then its new one -->
                    <template v-else>
                      <tr v-if="item.row.kind === 'same'" data-row="same" :data-key="item.key">
                        <td :class="NUM">{{ item.row.left }}</td>
                        <td :class="NUM">{{ item.row.right }}</td>
                        <td :class="TEXT"><DiffLine :spans="spans(item.row, 'before')" tone="same" /></td>
                      </tr>
                      <tr
                        v-if="item.row.kind === 'del' || item.row.kind === 'mod'"
                        data-row="del"
                        data-change="del"
                        :data-key="item.key"
                        :data-hunk="item.hunk"
                        :data-current="marked === `${i}:${item.key}` || undefined"
                        :class="CURRENT"
                      >
                        <td :class="[NUM, NUM_TONE.del]">{{ item.row.left }}</td>
                        <td :class="[NUM, NUM_TONE.del]" />
                        <td :class="[TEXT, TEXT_TONE.del]">
                          <DiffLine :spans="spans(item.row, 'before')" tone="del" />
                        </td>
                      </tr>
                      <tr
                        v-if="item.row.kind === 'add' || item.row.kind === 'mod'"
                        data-row="add"
                        data-change="add"
                        :data-key="item.row.kind === 'add' ? item.key : undefined"
                        :data-hunk="item.row.kind === 'add' ? item.hunk : undefined"
                        :data-current="
                          (item.row.kind === 'add' && marked === `${i}:${item.key}`) || undefined
                        "
                        :class="CURRENT"
                      >
                        <td :class="[NUM, NUM_TONE.add]" />
                        <td :class="[NUM, NUM_TONE.add]">{{ item.row.right }}</td>
                        <td :class="[TEXT, TEXT_TONE.add]">
                          <DiffLine :spans="spans(item.row, 'after')" tone="add" />
                        </td>
                      </tr>
                    </template>
                  </template>
                </tbody>
              </table>
              <button
                v-if="shown[i]!.rest > 0"
                type="button"
                data-more-rows
                class="w-full cursor-pointer border-t border-line bg-subtle/70 px-3 py-1.5 text-left font-sans text-small text-fg-muted hover:bg-accent-soft hover:text-accent-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                @click="limits.set(i, (limits.get(i) ?? FIRST_ROWS) + MORE_ROWS)"
              >
                {{ t('editor.diff.showMore', { n: shown[i]!.rest }, shown[i]!.rest) }}
              </button>
            </div>
          </article>
          <slot name="after" />
        </div>
      </div>

      <!-- Where the changes are in the whole review, and the part in sight; a press scrolls there -->
      <div
        v-if="view.scrollable"
        data-change-map
        aria-hidden="true"
        class="relative w-3.5 shrink-0 cursor-pointer border-l border-line bg-subtle/40"
        @mousedown.prevent="onMapPress"
      >
        <div
          class="pointer-events-none absolute inset-x-0 rounded-sm border border-line-strong bg-fg/15"
          :style="{ top: `${view.top * 100}%`, height: `${view.height * 100}%` }"
        />
        <div
          v-for="(m, k) in markers"
          :key="k"
          class="pointer-events-none absolute inset-x-[3px] rounded-[1px]"
          :class="MARK_TONE[m.tone]"
          :style="{ top: `${m.top * 100}%`, height: `max(3px, ${m.height * 100}%)` }"
        />
      </div>

      <!-- Scrolled away from every change: one press brings the nearest back -->
      <button
        v-if="away"
        type="button"
        data-back-to-change
        class="absolute bottom-4 left-1/2 z-[2] inline-flex -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-raised px-3 py-1.5 text-small font-medium text-fg shadow-[var(--ds-shadow-float)] hover:bg-subtle focus-visible:outline-2 focus-visible:outline-accent"
        @click="goTo(nearest)"
      >
        <component :is="away === 'up' ? ArrowUp : ArrowDown" class="size-3.5" aria-hidden="true" />
        {{ t('editor.diff.backToChange') }}
      </button>
    </div>
  </section>
</template>
