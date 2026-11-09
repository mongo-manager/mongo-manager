<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import DsMenu from '@/ds/DsMenu.vue'
import RowQuickActions from './RowQuickActions.vue'
import DsLazyCodeView from '@/ds/DsLazyCodeView.vue'
import { hasId, rowIdKey, type Row, type RowAction } from './rows'
import { rowId, rowMenuItems } from './rowMenu'
import { useRowExtras } from './rowExtras'
import { toJsonShell } from './values'
import { HIDDEN_TOKEN, markHidden, useMaskedPath } from '@/masking/useMaskedPaths'

/**
 * The JSON view: each document as shell JSON, in a card like the Cards view's (UI redesign R1
 * checkpoint 3) — its _id, its actions and, when selection is offered, a box to select it.
 */
const props = withDefaults(
  defineProps<{
    rows: Row[]
    canWrite: boolean
    selected?: ReadonlySet<string>
    /** Review of B5 (M3): no row menu where nothing handles its actions (an agent step's documents). */
    actions?: boolean
  }>(),
  { actions: true, selected: undefined },
)
const emit = defineEmits<{ action: [kind: RowAction, row: Row]; toggle: [row: Row] }>()
const { t } = useI18n()
const extras = useRowExtras()
const isMasked = useMaskedPath()
// W5: hidden values carry a lock and a label here too, as in the table.
const hidden = computed(() => ({ token: HIDDEN_TOKEN, label: t('masking.hiddenValue') }))
const items = computed(() =>
  props.rows.map((row) => ({
    row,
    id: rowIdKey(row),
    label: rowId(row),
    menu: rowMenuItems(row, props.canWrite, t, extras.value),
    text: row.kind === 'document' ? toJsonShell(markHidden(row.value, isMasked.value)) : '',
  })),
)
</script>

<template>
  <div data-results-scroll class="h-full overflow-auto px-4 py-3">
    <ol class="flex flex-col gap-2.5">
      <li
        v-for="item in items"
        :key="item.row.key"
        data-results-item
        :data-key="item.id"
        class="overflow-hidden rounded-xl border bg-surface shadow-xs [contain-intrinsic-size:auto_160px] [content-visibility:auto]"
        :class="selected?.has(item.id) ? 'border-accent/60 ring-3 ring-accent/15' : 'border-line'"
      >
        <div class="flex min-w-0 items-center gap-2 border-b border-line px-3 py-1.5">
          <input
            v-if="selected"
            type="checkbox"
            class="size-3.5 shrink-0 cursor-pointer accent-accent"
            :aria-label="t('documents.selection.one', { id: item.label })"
            :checked="selected.has(item.id)"
            :disabled="!hasId(item.row)"
            :title="hasId(item.row) ? undefined : t('documents.selection.noId')"
            @change="emit('toggle', item.row)"
          />
          <!-- User report 2026-11-05: the _id opens the document to read, as in the table. -->
          <button
            v-if="actions && item.row.kind === 'document' && hasId(item.row)"
            type="button"
            data-open-id
            class="min-w-0 cursor-pointer truncate text-left font-mono text-small text-v-oid underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus"
            :aria-label="t('documents.inspectDocument', { id: item.label })"
            @click="emit('action', 'inspect', item.row)"
          >
            {{ item.label }}
          </button>
          <span v-else class="min-w-0 truncate font-mono text-small text-v-oid">{{ item.label }}</span>
          <div class="ml-auto flex shrink-0 items-center gap-0.5">
            <RowQuickActions
              v-if="actions"
              :row="item.row"
              :can-write="canWrite"
              :label="item.label"
              @action="(kind, row) => emit('action', kind, row)"
            />
            <DsMenu
              v-if="actions && item.menu.length"
              focusable
              :label="t('documents.actions', { id: item.label })"
              :items="item.menu"
              @select="emit('action', $event as RowAction, item.row)"
            />
          </div>
        </div>
        <div class="px-3 py-2">
          <DsLazyCodeView v-if="item.row.kind === 'document'" :text="item.text" :hidden="hidden" />
          <p v-else class="text-ui text-warning">
            {{ t('documents.unsupported', { reason: item.row.reason }) }}
          </p>
        </div>
      </li>
    </ol>
  </div>
</template>
