<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ExplainPlanNode } from '@mongo-manager/shared/browser'

/**
 * Phase 2b spec §3.1 and R1: the plan as an accessible tree (not a drawing). Rows are the visible
 * nodes in order, indented by depth; the arrow keys move and fold as in any tree view.
 */
const props = defineProps<{ root: ExplainPlanNode; label: string; totalMs?: number }>()
const { t, locale } = useI18n()
const id = useId()

interface Row {
  key: string
  node: ExplainPlanNode
  depth: number
  parent: string | null
}

/** Folded nodes, by key (their path in the tree). */
const folded = ref(new Set<string>())
const rows = computed(() => {
  const out: Row[] = []
  const walk = (node: ExplainPlanNode, key: string, depth: number, parent: string | null) => {
    out.push({ key, node, depth, parent })
    if (!folded.value.has(key)) node.children.forEach((c, i) => walk(c, `${key}.${i}`, depth + 1, key))
  }
  walk(props.root, '0', 1, null)
  return out
})
const active = ref('0')
// A folded ancestor hides the focused row: the tree must stay reachable with Tab.
const focusKey = computed(() => (rows.value.some((r) => r.key === active.value) ? active.value : '0'))
watch(
  () => props.root,
  () => {
    folded.value = new Set()
    active.value = '0'
  },
)

/** Stages worth a mark: a scan of the whole collection, and a sort done in memory. */
const MARKED = new Set(['COLLSCAN', 'SORT'])
const number = (n: number) => new Intl.NumberFormat(locale.value).format(n)
const share = (node: ExplainPlanNode) =>
  props.totalMs && node.executionTimeMillisEstimate !== undefined
    ? Math.min(100, Math.round((node.executionTimeMillisEstimate / Math.max(props.totalMs, 1)) * 100))
    : null

function focusRow(key: string): void {
  active.value = key
  void nextTick(() => document.getElementById(`${id}-${key}`)?.focus())
}

function toggle(key: string, open?: boolean): void {
  const next = new Set(folded.value)
  const isOpen = !next.has(key)
  if (open ?? !isOpen) next.delete(key)
  else next.add(key)
  folded.value = next
}

function onKeydown(event: KeyboardEvent, row: Row, index: number): void {
  const list = rows.value
  const hasChildren = row.node.children.length > 0
  const open = !folded.value.has(row.key)
  switch (event.key) {
    case 'ArrowDown':
      if (index < list.length - 1) focusRow(list[index + 1]!.key)
      break
    case 'ArrowUp':
      if (index > 0) focusRow(list[index - 1]!.key)
      break
    case 'ArrowRight':
      if (hasChildren && !open) toggle(row.key, true)
      else if (hasChildren) focusRow(list[index + 1]!.key)
      break
    case 'ArrowLeft':
      if (hasChildren && open) toggle(row.key, false)
      else if (row.parent) focusRow(row.parent)
      break
    case 'Home':
      focusRow(list[0]!.key)
      break
    case 'End':
      focusRow(list[list.length - 1]!.key)
      break
    default:
      return
  }
  event.preventDefault()
}
</script>

<template>
  <ul role="tree" :aria-label="label" class="flex flex-col gap-1">
    <li
      v-for="(row, i) in rows"
      :id="`${id}-${row.key}`"
      :key="row.key"
      role="treeitem"
      :aria-level="row.depth"
      :aria-expanded="row.node.children.length ? !folded.has(row.key) : undefined"
      :aria-selected="focusKey === row.key"
      :tabindex="focusKey === row.key ? 0 : -1"
      :data-stage="row.node.stage"
      :data-mark="MARKED.has(row.node.stage) ? row.node.stage : undefined"
      class="relative rounded-lg border px-3 py-2 text-ui outline-none focus-visible:ring-2 focus-visible:ring-focus"
      :class="MARKED.has(row.node.stage) ? 'border-warning/25 bg-warning-soft' : 'border-line bg-surface'"
      :style="{ marginLeft: `${(row.depth - 1) * 1.5}rem` }"
      @keydown="onKeydown($event, row, i)"
      @click="active = row.key"
    >
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          v-if="row.node.children.length"
          type="button"
          tabindex="-1"
          class="cursor-pointer text-small text-fg-subtle"
          :aria-label="folded.has(row.key) ? t('explain.expand') : t('explain.collapse')"
          @click.stop="toggle(row.key)"
        >
          <svg
            viewBox="0 0 10 10"
            class="h-2.5 w-2.5 transition-transform"
            :class="folded.has(row.key) ? '-rotate-90' : ''"
            aria-hidden="true"
            fill="currentColor"
          >
            <path d="M1 3h8L5 8z" />
          </svg>
        </button>
        <span class="font-mono font-semibold">{{ row.node.stage }}</span>
        <span v-if="row.node.indexName" class="font-mono text-small text-accent-fg">{{
          row.node.indexName
        }}</span>
        <span v-if="row.node.nReturned !== undefined" class="text-small text-fg-muted">{{
          t('explain.returned', { n: number(row.node.nReturned) })
        }}</span>
        <span v-if="row.node.docsExamined !== undefined" class="text-small text-fg-muted">{{
          t('explain.docsExamined', { n: number(row.node.docsExamined) })
        }}</span>
        <span v-if="row.node.keysExamined !== undefined" class="text-small text-fg-muted">{{
          t('explain.keysExamined', { n: number(row.node.keysExamined) })
        }}</span>
        <span v-if="row.node.executionTimeMillisEstimate !== undefined" class="text-small text-fg-muted">{{
          t('explain.ms', { n: number(row.node.executionTimeMillisEstimate) })
        }}</span>
      </div>
      <p v-if="row.node.filter" class="mt-1 font-mono text-small break-all text-fg-muted">
        {{ row.node.filter }}
      </p>
      <div v-if="share(row.node) !== null" class="mt-1 h-1 rounded bg-muted" aria-hidden="true">
        <div class="h-1 rounded bg-accent" :style="{ width: `${share(row.node)}%` }" />
      </div>
    </li>
  </ul>
</template>
