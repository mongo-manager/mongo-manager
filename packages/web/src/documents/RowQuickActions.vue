<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Pencil, Trash2 } from 'lucide-vue-next'
import { hasId, type Row, type RowAction } from './rows'

/**
 * Document page design §6.10; user report 2026-11-05: a document's Edit and Delete, always shown with
 * their words in a card's or a list item's header, as the table's rows show them — not only under
 * the pointer, not only in a menu. Edit opens the document; Delete asks first.
 */
const props = defineProps<{ row: Row; canWrite: boolean; label: string }>()
const emit = defineEmits<{ action: [kind: RowAction, row: Row] }>()
const { t } = useI18n()
const button =
  'inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-small text-fg-muted transition-colors duration-120 hover:bg-subtle hover:text-fg focus-visible:outline-2 focus-visible:outline-focus'
</script>

<template>
  <template v-if="row.kind === 'document' && canWrite && hasId(row)">
    <button
      type="button"
      :class="button"
      :aria-label="t('documents.editDocument', { id: label })"
      @click="emit('action', 'edit', props.row)"
    >
      <Pencil class="size-3.5" aria-hidden="true" />{{ t('documents.edit') }}
    </button>
    <button
      type="button"
      :class="[button, 'hover:text-danger']"
      :aria-label="t('documents.deleteDocument', { id: label })"
      @click="emit('action', 'delete', props.row)"
    >
      <Trash2 class="size-3.5" aria-hidden="true" />{{ t('documents.delete') }}
    </button>
  </template>
</template>
