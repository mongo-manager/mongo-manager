<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import type { BsonTypeName } from '@mongo-manager/shared/browser'
import DsSelect from '@/ds/DsSelect.vue'
import { EDITABLE_TYPES, editText, lineBreaks } from '../scalarEdit'
import { typeOf } from '../values'

/**
 * Document page design §6.5: what the tree edits in place — a value (its type kept, or another of the
 * types a cell edits), a key's name, or a new field or array item. It only collects what was typed;
 * the tree checks it and says why it is refused (`error`). A string is written in a box of several
 * lines (review 2026-11-07, critical: a one-line box dropped every line break of a stack trace);
 * Enter applies, Shift+Enter starts a new line.
 */
export type EditorKind = 'value' | 'rename' | 'field' | 'item'
export interface EditorInput {
  key: string
  type: BsonTypeName | 'object' | 'array'
  text: string
}

const props = defineProps<{
  kind: EditorKind
  /** The field's name, for the labels. */
  name: string
  /** The value being changed (kind "value"). */
  value?: unknown
  error?: string
}>()
const emit = defineEmits<{ apply: [input: EditorInput]; cancel: [] }>()
const { t } = useI18n()
const id = useId()

const startType = (): EditorInput['type'] => {
  if (props.kind !== 'value') return 'string'
  const type = typeOf(props.value)
  return EDITABLE_TYPES.includes(type) ? type : 'string'
}
const key = ref(props.kind === 'rename' ? props.name : '')
const type = ref<EditorInput['type']>(startType())
const text = ref(props.kind === 'value' ? editText(props.value) : '')
/** A new field or item may also be an empty object or array, filled in afterwards. */
const types = computed(() =>
  (props.kind === 'value' ? EDITABLE_TYPES : [...EDITABLE_TYPES, 'object' as const, 'array' as const]).map(
    (value) => ({ value, label: value }),
  ),
)
const hasKey = computed(() => props.kind === 'rename' || props.kind === 'field')
const hasValue = computed(() => props.kind !== 'rename' && type.value !== 'object' && type.value !== 'array')
const lines = computed(() => (type.value === 'string' ? text.value.split('\n').length : 1))
/** A box gives every line break back as \n: a string written with \r\n gets its own back. */
const crlf = props.kind === 'value' && typeof props.value === 'string' && lineBreaks(props.value) === 'crlf'
const typed = (): EditorInput => ({
  key: key.value,
  type: type.value,
  text: type.value === 'string' && crlf ? text.value.replace(/\r?\n/g, '\r\n') : text.value,
})

const root = ref<HTMLElement | null>(null)
onMounted(() =>
  nextTick(() => {
    const first = root.value?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea')
    first?.focus()
    first?.select()
  }),
)

function apply(event: KeyboardEvent): void {
  // Enter that confirms an input method's composition is not an apply.
  if (event.isComposing) return
  emit('apply', typed())
}
function onTextKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey) return
  event.preventDefault()
  apply(event)
}
</script>

<template>
  <span
    ref="root"
    data-tree-editor
    class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 font-mono text-small"
    @keydown.escape.prevent.stop="emit('cancel')"
    @keydown.stop
    @click.stop
    @dblclick.stop
  >
    <input
      v-if="hasKey"
      v-model="key"
      class="w-40 rounded border border-accent bg-surface px-1.5 py-0.5 outline-none"
      :aria-label="
        kind === 'rename' ? t('documents.docPage.renameLabel', { name }) : t('documents.docPage.newKey')
      "
      :aria-invalid="error ? 'true' : undefined"
      :aria-describedby="error ? `${id}-error` : undefined"
      spellcheck="false"
      autocomplete="off"
      @keydown.enter.prevent="apply"
    />
    <DsSelect
      v-if="kind !== 'rename'"
      v-model="type"
      :label="t('documents.docPage.valueType', { name })"
      hide-label
      size="sm"
      :options="types"
    />
    <textarea
      v-if="hasValue && type === 'string'"
      v-model="text"
      :rows="Math.min(lines, 12)"
      class="min-w-32 flex-1 resize-y rounded border border-accent bg-surface px-1.5 py-0.5 leading-5 outline-none"
      :class="lines > 1 ? 'basis-full' : ''"
      :aria-label="
        kind === 'value' ? t('documents.docPage.editValue', { name }) : t('documents.docPage.newValue')
      "
      :aria-invalid="error ? 'true' : undefined"
      :aria-describedby="error ? `${id}-hint ${id}-error` : `${id}-hint`"
      aria-keyshortcuts="Shift+Enter"
      spellcheck="false"
      autocomplete="off"
      @keydown="onTextKeydown"
    />
    <input
      v-else-if="hasValue"
      v-model="text"
      class="min-w-32 flex-1 rounded border border-accent bg-surface px-1.5 py-0.5 outline-none"
      :aria-label="
        kind === 'value' ? t('documents.docPage.editValue', { name }) : t('documents.docPage.newValue')
      "
      :aria-invalid="error ? 'true' : undefined"
      :aria-describedby="error ? `${id}-error` : undefined"
      spellcheck="false"
      autocomplete="off"
      @keydown.enter.prevent="apply"
    />
    <button
      type="button"
      class="cursor-pointer rounded-md bg-accent px-2 py-0.5 font-sans text-small text-on-accent hover:bg-accent-hover"
      @click="emit('apply', typed())"
    >
      {{ t('documents.docPage.apply') }}
    </button>
    <button
      type="button"
      class="cursor-pointer rounded-md px-2 py-0.5 font-sans text-small text-fg-muted hover:bg-subtle"
      @click="emit('cancel')"
    >
      {{ t('common.cancel') }}
    </button>
    <span
      v-if="hasValue && type === 'string'"
      :id="`${id}-hint`"
      class="basis-full font-sans text-caption text-fg-subtle"
      >{{ t('documents.docPage.newLineHint') }}</span
    >
    <span v-if="error" :id="`${id}-error`" role="alert" class="basis-full font-sans text-small text-danger">
      {{ error }}
    </span>
  </span>
</template>
