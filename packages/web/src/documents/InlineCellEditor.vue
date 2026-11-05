<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, onMounted, ref, toRef, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { ApiError } from '@/api/client'
import { describeError } from '@/api/errors'
import { documentsApi, type CollectionTarget } from '@/api/documents'
import { useToastStore } from '@/stores/toasts'
import type { DocumentRow } from './rows'
import { useDocumentActions } from './documentActions'
import { editText, parseScalar } from './scalarEdit'
import { toWire } from '@mongo-manager/shared/browser'
import { encodeValue, typeOf } from './values'

/**
 * Edits one top-level scalar field in place: the value keeps its BSON type (Review Focus 2) and
 * is written with $set, pinned to the version shown in the table.
 */
const props = defineProps<{ target: CollectionTarget; row: DocumentRow; column: string; label: string }>()
/** `done`: true when something was written and the page reloads. */
const emit = defineEmits<{ done: [reloading: boolean] }>()
const { t } = useI18n()
const toasts = useToastStore()
const actions = useDocumentActions(toRef(props, 'target'))
const type = computed(() => typeOf(props.row.value[props.column]))
const text = ref(editText(props.row.value[props.column]))
const error = ref('')
const saving = ref(false)
const input = ref<HTMLInputElement | null>(null)
const errorId = useId()

onMounted(() => {
  input.value?.focus()
  input.value?.select()
})

async function save(event: KeyboardEvent): Promise<void> {
  // Enter that confirms an input method's composition is not a save.
  if (saving.value || event.isComposing) return
  const parsed = parseScalar(type.value, text.value)
  if (!parsed.ok) {
    error.value = t(`documents.inline.invalid.${parsed.error}`)
    return
  }
  // Nothing changed: nothing is written (and nothing audited).
  if (toWire(parsed.value) === toWire(props.row.value[props.column])) {
    emit('done', false)
    return
  }
  saving.value = true
  try {
    await documentsApi.update(
      props.target,
      props.row.raw._id,
      encodeValue({ [props.column]: parsed.value }),
      [],
      props.row.hash,
    )
    toasts.push({ kind: 'success', message: t('documents.inline.saved') })
    emit('done', true)
    await actions.refresh()
  } catch (e) {
    if (e instanceof ApiError && (e.code === 'DOCUMENT_CHANGED' || e.code === 'NOT_FOUND')) {
      toasts.push({ kind: 'error', message: t('documents.inline.changed') })
      emit('done', true)
      await actions.refresh()
    } else {
      error.value = describeError(e, t)
    }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <span class="relative block">
    <input
      ref="input"
      v-model="text"
      data-test="inline-editor"
      class="w-full min-w-24 rounded border border-accent bg-surface px-1 font-mono text-small outline-none"
      :aria-label="label"
      :aria-invalid="error ? 'true' : undefined"
      :aria-describedby="error ? errorId : undefined"
      :readonly="saving"
      spellcheck="false"
      autocomplete="off"
      @keydown.enter.prevent.stop="save"
      @keydown.escape.prevent.stop="emit('done', false)"
      @dblclick.stop
    />
    <span
      v-if="error"
      :id="errorId"
      role="alert"
      class="absolute left-0 top-full z-20 mt-0.5 w-max max-w-80 whitespace-normal rounded bg-danger px-2 py-1 font-sans text-small text-on-danger shadow"
    >
      {{ error }}
    </span>
  </span>
</template>
