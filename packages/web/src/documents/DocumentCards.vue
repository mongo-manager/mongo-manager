<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Copy } from 'lucide-vue-next'
import DsMenu from '@/ds/DsMenu.vue'
import DsTooltip from '@/ds/DsTooltip.vue'
import type { Row, RowAction } from './rows'
import { hasId, rowIdKey } from './rows'
import { rowId, rowMenuItems } from './rowMenu'
import { useRowExtras } from './rowExtras'
import ValueCell from './ValueCell.vue'
import RowQuickActions from './RowQuickActions.vue'
import TreeNode from './TreeNode.vue'

/**
 * UI redesign R1 revision 2 §4.4: the Cards view — each document a card with its _id, its first fields
 * (typed values, nested ones open in place) and its actions; a card opens in the inspector.
 */
const props = defineProps<{
  rows: Row[]
  canWrite: boolean
  selectedId: string | null
  /** UI redesign R1 checkpoint 3: the documents selected (by _id), when selection is offered. */
  selected?: ReadonlySet<string>
}>()
const emit = defineEmits<{ action: [kind: RowAction, row: Row]; toggle: [row: Row] }>()
const { t } = useI18n()
const extras = useRowExtras()
const FIRST = 8
/** Reviewer B Minor 12: the _id's path, so a hidden _id shows its lock. */
const ID_PATH = ['_id'] as const
/** The field name itself (not a word to translate). */
const ID_FIELD = '_id'

const cards = computed(() =>
  props.rows.map((row) => {
    const fields = row.kind === 'document' ? Object.entries(row.value).filter(([name]) => name !== '_id') : []
    return {
      row,
      id: rowIdKey(row),
      label: rowId(row),
      fields,
      // User report 2026-11-05: Open stays in the menu — with no Open button, the keyboard's way to it.
      menu: rowMenuItems(row, props.canWrite, t, extras.value),
    }
  }),
)
const expanded = ref(new Set<string>())
function toggleMore(key: string): void {
  const next = new Set(expanded.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expanded.value = next
}

/** A click on the card itself (not on one of its controls) inspects it. */
function onCardClick(event: MouseEvent, row: Row): void {
  if ((event.target as HTMLElement).closest('button, a, input, [role="menu"]')) return
  if (window.getSelection()?.toString()) return
  emit('action', 'inspect', row)
}

const copiedId = ref<string | null>(null)
async function copyId(row: Row): Promise<void> {
  try {
    await navigator.clipboard.writeText(rowId(row))
    copiedId.value = rowIdKey(row)
    setTimeout(() => (copiedId.value = null), 1200)
  } catch {
    // the clipboard was refused; the id stays selectable
  }
}
// The card of the document last open is in sight when the results come back from its page (design §6.1).
const list = ref<HTMLElement | null>(null)
watch(
  () => props.selectedId,
  async (id) => {
    if (!id) return
    await nextTick()
    list.value?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView?.({ block: 'nearest' })
  },
  { immediate: true },
)
const iconButton =
  'grid size-7 cursor-pointer place-items-center rounded-md text-fg-subtle transition-colors duration-120 hover:bg-subtle hover:text-fg'
</script>

<template>
  <div ref="list" class="h-full overflow-auto px-4 py-3">
    <ol class="flex flex-col gap-2.5">
      <li
        v-for="card in cards"
        :key="card.row.key"
        data-card
        :aria-current="card.id === selectedId ? 'true' : undefined"
        class="group relative cursor-default rounded-xl border bg-surface shadow-xs transition-[border-color,box-shadow] duration-160 ease-out-soft [contain-intrinsic-size:auto_180px] [content-visibility:auto]"
        :class="
          card.id === selectedId
            ? 'border-accent/70 ring-3 ring-accent/15'
            : 'border-line hover:border-line-strong'
        "
        @click="onCardClick($event, card.row)"
      >
        <div class="flex min-w-0 items-center gap-2 border-b border-line px-3.5 py-2">
          <input
            v-if="selected"
            type="checkbox"
            class="size-3.5 shrink-0 cursor-pointer accent-accent"
            :aria-label="t('documents.selection.one', { id: card.label })"
            :checked="selected.has(card.id)"
            :disabled="!hasId(card.row)"
            :title="hasId(card.row) ? undefined : t('documents.selection.noId')"
            @change="emit('toggle', card.row)"
          />
          <span class="shrink-0 font-mono text-small text-fg-subtle">{{ ID_FIELD }}</span>
          <!-- User report 2026-11-05: the _id opens the document to read, as in the table. -->
          <button
            v-if="card.row.kind === 'document' && hasId(card.row)"
            type="button"
            data-open-id
            class="min-w-0 cursor-pointer truncate text-left font-mono text-[12.5px] underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus"
            :aria-label="t('documents.inspectDocument', { id: card.label })"
            @click="emit('action', 'inspect', card.row)"
          >
            <ValueCell :value="card.row.value._id" present :path="ID_PATH" quoted />
          </button>
          <span v-else class="min-w-0 truncate font-mono text-[12.5px]">
            <ValueCell
              v-if="card.row.kind === 'document'"
              :value="card.row.value._id"
              :present="'_id' in card.row.value"
              :path="ID_PATH"
              quoted
            />
            <span v-else class="text-fg-muted">{{ card.label }}</span>
          </span>
          <DsTooltip :text="t('documents.copyId')">
            <button
              type="button"
              :class="[iconButton, 'size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100']"
              :aria-label="t('documents.copyId')"
              @click="copyId(card.row)"
            >
              <component :is="copiedId === card.id ? Check : Copy" class="size-3.5" aria-hidden="true" />
            </button>
          </DsTooltip>
          <div class="ml-auto flex shrink-0 items-center gap-0.5">
            <RowQuickActions
              :row="card.row"
              :can-write="canWrite"
              :label="card.label"
              @action="(kind, row) => emit('action', kind, row)"
            />
            <DsMenu
              v-if="card.menu.length"
              focusable
              :label="t('documents.actions', { id: card.label })"
              :items="card.menu"
              @select="emit('action', $event as RowAction, card.row)"
            />
          </div>
        </div>
        <ul v-if="card.row.kind === 'document'" class="px-1.5 py-1.5">
          <TreeNode
            v-for="[name, value] in expanded.has(card.row.key) ? card.fields : card.fields.slice(0, FIRST)"
            :key="name"
            :name="name"
            :value="value"
            :depth="0"
          />
        </ul>
        <p v-else class="px-3.5 py-2.5 text-ui text-warning">
          {{ t('documents.unsupported', { reason: card.row.reason }) }}
        </p>
        <div v-if="card.fields.length > FIRST" class="px-3.5 pb-2">
          <button
            type="button"
            class="cursor-pointer text-small font-medium text-accent-fg hover:underline"
            :aria-expanded="expanded.has(card.row.key)"
            @click="toggleMore(card.row.key)"
          >
            {{
              expanded.has(card.row.key)
                ? t('documents.fewerFields')
                : t('documents.moreFields', { count: card.fields.length - FIRST }, card.fields.length - FIRST)
            }}
          </button>
        </div>
      </li>
    </ol>
  </div>
</template>
