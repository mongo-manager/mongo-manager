<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Minus, Plus } from 'lucide-vue-next'
import type { FieldChange } from '@mongo-manager/shared/browser'
import { toShell, typeOf } from './values'

defineProps<{ changes: FieldChange[] }>()
const { t } = useI18n()

const MAX = 200
/** One line of shell text with the BSON type, so a type change is visible. */
function show(change: FieldChange, side: 'before' | 'after'): string {
  if (!(side in change)) return t('editor.missing')
  const text = toShell(change[side], 0)
  return text.length > MAX ? `${text.slice(0, MAX)}…` : text
}
const kind = (c: FieldChange) => ('before' in c ? ('after' in c ? 'changed' : 'removed') : 'added')
</script>

<template>
  <ul data-test="diff" class="flex max-h-80 flex-col gap-2 overflow-auto font-mono text-small">
    <li
      v-for="(change, i) in changes"
      :key="`${i}:${change.path}`"
      :data-kind="kind(change)"
      class="rounded-lg border border-line p-2"
    >
      <div class="font-semibold text-fg">{{ change.path }}</div>
      <div class="mt-1 grid grid-cols-[auto_1fr] gap-x-2">
        <Minus aria-hidden="true" class="mt-0.5 size-3 text-danger" />
        <span class="break-all text-fg-muted">
          <span class="sr-only">{{ t('editor.before') }}</span>
          {{ show(change, 'before') }}
          <span v-if="'before' in change" class="ml-1 text-fg-subtle">{{ typeOf(change.before) }}</span>
        </span>
        <Plus aria-hidden="true" class="mt-0.5 size-3 text-success" />
        <span class="break-all text-fg">
          <span class="sr-only">{{ t('editor.after') }}</span>
          {{ show(change, 'after') }}
          <span v-if="'after' in change" class="ml-1 text-fg-subtle">{{ typeOf(change.after) }}</span>
        </span>
      </div>
    </li>
  </ul>
</template>
