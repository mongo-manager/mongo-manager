<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Minus, Plus } from 'lucide-vue-next'
import type { FieldChange } from '@mongo-manager/shared/browser'
import { toShell, typeOf } from './values'

const props = defineProps<{ changes: FieldChange[] }>()
const { t } = useI18n()

const MAX = 200
/** How much of the text before a change a long value shows. */
const BEFORE = 60
const ELLIPSIS = '…'

/** One side of a change: its text, or in a long value the part that changed between its context. */
type Shown = { text: string } | { lead: string; changed: string; tail: string }
type Side = 'before' | 'after'

/**
 * Both sides as one line of shell text. Review 2026-11-07: a long value is shown around its first
 * change, the changed part marked — cut at its start, a change on line 30 of a stack trace (or its
 * line breaks gone) looked like no change at all.
 */
function sides(change: FieldChange): Record<Side, Shown> {
  const text = (side: Side) => (side in change ? toShell(change[side], 0) : null)
  const before = text('before')
  const after = text('after')
  const whole = (s: string | null): Shown =>
    s === null
      ? { text: t('editor.missing') }
      : { text: s.length > MAX ? `${s.slice(0, MAX)}${ELLIPSIS}` : s }
  if (before === null || after === null || (before.length <= MAX && after.length <= MAX))
    return { before: whole(before), after: whole(after) }
  let same = 0
  while (same < before.length && same < after.length && before[same] === after[same]) same++
  let sameEnd = 0
  while (
    sameEnd < before.length - same &&
    sameEnd < after.length - same &&
    before[before.length - 1 - sameEnd] === after[after.length - 1 - sameEnd]
  )
    sameEnd++
  const around = (s: string): Shown => {
    const from = Math.max(0, same - BEFORE)
    const to = Math.min(s.length, from + MAX)
    const changedTo = Math.min(s.length - sameEnd, to)
    return {
      lead: (from > 0 ? ELLIPSIS : '') + s.slice(from, same),
      changed: s.slice(same, changedTo),
      tail: s.slice(changedTo, to) + (to < s.length ? ELLIPSIS : ''),
    }
  }
  return { before: around(before), after: around(after) }
}
const kind = (c: FieldChange) => ('before' in c ? ('after' in c ? 'changed' : 'removed') : 'added')
const rows = computed(() => props.changes.map((change) => ({ change, shown: sides(change) })))
</script>

<template>
  <ul data-test="diff" class="flex max-h-80 flex-col gap-2 overflow-auto font-mono text-small">
    <li
      v-for="({ change, shown }, i) in rows"
      :key="`${i}:${change.path}`"
      :data-kind="kind(change)"
      class="rounded-lg border border-line p-2"
    >
      <div class="font-semibold text-fg">{{ change.path }}</div>
      <div class="mt-1 grid grid-cols-[auto_1fr] gap-x-2">
        <template v-for="side in ['before', 'after'] as const" :key="side">
          <Minus v-if="side === 'before'" aria-hidden="true" class="mt-0.5 size-3 text-danger" />
          <Plus v-else aria-hidden="true" class="mt-0.5 size-3 text-success" />
          <span class="break-all" :class="side === 'before' ? 'text-fg-muted' : 'text-fg'">
            <span class="sr-only">{{ side === 'before' ? t('editor.before') : t('editor.after') }}</span>
            <template v-if="'text' in shown[side]">{{ shown[side].text }}</template>
            <template v-else
              >{{ shown[side].lead
              }}<mark
                class="rounded-sm text-inherit"
                :class="side === 'before' ? 'bg-danger-soft' : 'bg-success-soft'"
                >{{ shown[side].changed }}</mark
              >{{ shown[side].tail }}</template
            >
            <span v-if="side in change" class="ml-1 text-fg-subtle">{{ typeOf(change[side]) }}</span>
          </span>
        </template>
      </div>
    </li>
  </ul>
</template>
