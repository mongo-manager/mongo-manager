<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, X } from 'lucide-vue-next'
import {
  MAX_VECTOR_DIMENSIONS,
  QueryParseError,
  VECTOR_QUANTIZATIONS,
  VECTOR_PROBLEMS,
  VECTOR_SIMILARITIES,
  parseShellExpression,
  serializeValue,
  vectorDefinitionProblem,
  type SearchIndexType,
  type VectorProblem,
} from '@mongo-manager/shared/browser'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import DsCodeEditor from '@/ds/DsCodeEditor.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import DsIconButton from '@/ds/DsIconButton.vue'
import DsInput from '@/ds/DsInput.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import DsSelect from '@/ds/DsSelect.vue'
import { documentsApi, type CollectionTarget, type SearchIndexInfo } from '@/api/documents'
import { describeError } from '@/api/errors'
import { ApiError } from '@/api/client'
import { useToastStore } from '@/stores/toasts'
import { decodeValue, isDocument, toShell } from '@/documents/values'

/**
 * W2.6 (2026-10-16): a new Atlas Search or Vector Search index, or an index's definition edited.
 * A search index is written as its JSON definition; a vector index from a guided form (the vector
 * field, its dimensions and similarity, the filter fields) or as JSON — the form writes the JSON,
 * so either way what is sent is what is shown. Text is read by the safe shell parser (no eval).
 */
const props = defineProps<{ target: CollectionTarget; index?: SearchIndexInfo }>()
const emit = defineEmits<{ close: []; saved: [] }>()
const { t } = useI18n()
const toasts = useToastStore()

const editing = computed(() => props.index !== undefined)
const type = ref<SearchIndexType>(props.index?.type ?? 'search')
const name = ref(props.index?.name ?? 'default')
const SEARCH_EXAMPLE = '{ mappings: { dynamic: true } }'
const text = ref(props.index ? toShell(decodeValue(props.index.definition), 2) : SEARCH_EXAMPLE)
/** The vector form, or its JSON. */
const vectorMode = ref<'form' | 'json'>('form')
const vector = ref({ path: '', dims: '', similarity: 'cosine', quantization: '' })
const filters = ref<string[]>([])
const errors = ref<string[]>([])
const textError = ref('')
const busy = ref(false)

const types = computed(() => [
  { value: 'search' as const, label: t('searchIndexes.search') },
  { value: 'vectorSearch' as const, label: t('searchIndexes.vectorSearch') },
])
const modes = computed(() => [
  { value: 'form' as const, label: t('searchIndexes.form.guided') },
  { value: 'json' as const, label: t('searchIndexes.form.json') },
])
const similarities = computed(() =>
  VECTOR_SIMILARITIES.map((s) => ({ value: s, label: t(`searchIndexes.form.similarities.${s}`) })),
)
const quantizations = computed(() => [
  { value: '', label: t('searchIndexes.form.quantizations.none') },
  ...VECTOR_QUANTIZATIONS.filter((q) => q !== 'none').map((q) => ({
    value: q,
    label: t(`searchIndexes.form.quantizations.${q}`),
  })),
])
// A new index's name follows its kind until the user names it.
watch(type, (next) => {
  if (editing.value) return
  if (name.value === 'default' || name.value === 'vector_index')
    name.value = next === 'vectorSearch' ? 'vector_index' : 'default'
  if (next === 'search' && text.value.trim() === '') text.value = SEARCH_EXAMPLE
})

/** W2 review (minor 9): a vector definition's problem in the user's language. */
const isVectorProblem = (reason: unknown): reason is VectorProblem =>
  typeof reason === 'string' && Object.hasOwn(VECTOR_PROBLEMS, reason)
const problemText = (problem: VectorProblem) =>
  t(`searchIndexes.problems.${problem}`, { max: MAX_VECTOR_DIMENSIONS })

/** The guided form as a definition (decoded values: numDimensions as a number). */
function formDefinition(): Record<string, unknown> {
  const dims = Number(vector.value.dims.trim())
  return {
    fields: [
      {
        type: 'vector',
        path: vector.value.path.trim(),
        numDimensions: dims,
        similarity: vector.value.similarity,
        ...(vector.value.quantization ? { quantization: vector.value.quantization } : {}),
      },
      ...filters.value
        .map((p) => p.trim())
        .filter(Boolean)
        .map((path) => ({ type: 'filter', path })),
    ],
  }
}
/** From the form to JSON: the text shows exactly what the form would send. */
watch(vectorMode, (mode, before) => {
  if (mode === 'json' && before === 'form') text.value = toShell(withInt(formDefinition()), 2)
})
/** numDimensions is an integer to Atlas: an Int32, not a double. */
function withInt(definition: Record<string, unknown>): Record<string, unknown> {
  const fields = (definition.fields as Array<Record<string, unknown>>).map((f) =>
    typeof f.numDimensions === 'number' && Number.isInteger(f.numDimensions)
      ? { ...f, numDimensions: decodeValue({ $numberInt: String(f.numDimensions) }) }
      : f,
  )
  return { ...definition, fields }
}

/** The definition to send (decoded), or null with the reason shown. */
function definition(): Record<string, unknown> | null {
  textError.value = ''
  errors.value = []
  if (type.value === 'vectorSearch' && vectorMode.value === 'form' && !editing.value) {
    const d = formDefinition()
    const problem = vectorDefinitionProblem(d)
    if (problem) {
      errors.value = [problemText(problem)]
      return null
    }
    return withInt(d)
  }
  let value: unknown
  try {
    value = parseShellExpression(text.value)
  } catch (e) {
    textError.value =
      e instanceof QueryParseError
        ? t('query.syntaxError', { line: e.line, column: e.column, message: e.message })
        : String(e)
    return null
  }
  if (!isDocument(value)) {
    textError.value = t('searchIndexes.form.notDocument')
    return null
  }
  if (type.value === 'vectorSearch') {
    const problem = vectorDefinitionProblem(value)
    if (problem) {
      errors.value = [problemText(problem)]
      return null
    }
  }
  return value
}

async function save(): Promise<void> {
  if (busy.value) return
  const d = definition()
  if (!d) return
  const encoded = serializeValue(d) as Record<string, unknown>
  busy.value = true
  try {
    if (props.index) {
      await documentsApi.updateSearchIndex(props.target, props.index.name, encoded)
      toasts.push({ kind: 'success', message: t('searchIndexes.updated', { name: props.index.name }) })
    } else {
      await documentsApi.createSearchIndex(props.target, {
        name: name.value.trim(),
        type: type.value,
        definition: encoded,
      })
      toasts.push({ kind: 'success', message: t('searchIndexes.created', { name: name.value.trim() }) })
    }
    emit('saved')
    emit('close')
  } catch (e) {
    const reason = e instanceof ApiError ? (e.details as { reason?: unknown } | undefined)?.reason : undefined
    errors.value = [isVectorProblem(reason) ? problemText(reason) : describeError(e, t)]
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <DsDialog
    open
    :title="index ? t('searchIndexes.editTitle', { name: index.name }) : t('searchIndexes.createTitle')"
    size="lg"
    @close="emit('close')"
  >
    <form class="flex flex-col gap-4" novalidate @submit.prevent="save">
      <template v-if="!editing">
        <DsSegmented v-model="type" :label="t('searchIndexes.type')" :options="types" />
        <DsInput v-model="name" :label="t('searchIndexes.form.name')" autocomplete="off" mono required />
      </template>
      <template v-if="type === 'vectorSearch' && !editing">
        <DsSegmented v-model="vectorMode" size="sm" :label="t('searchIndexes.form.mode')" :options="modes" />
      </template>
      <div
        v-if="type === 'vectorSearch' && vectorMode === 'form' && !editing"
        data-vector-form
        class="grid gap-3 sm:grid-cols-2"
      >
        <DsInput
          v-model="vector.path"
          class="sm:col-span-2"
          :label="t('searchIndexes.form.path')"
          :hint="t('searchIndexes.form.pathHint')"
          autocomplete="off"
          mono
        />
        <DsInput
          v-model="vector.dims"
          :label="t('searchIndexes.form.dims')"
          :hint="t('searchIndexes.form.dimsHint', { max: MAX_VECTOR_DIMENSIONS })"
          inputmode="numeric"
          autocomplete="off"
        />
        <DsSelect
          v-model="vector.similarity"
          :label="t('searchIndexes.form.similarity')"
          :options="similarities"
        />
        <DsSelect
          v-model="vector.quantization"
          :label="t('searchIndexes.form.quantization')"
          :options="quantizations"
        />
        <fieldset class="flex flex-col gap-2 sm:col-span-2">
          <legend class="mb-1 text-small font-medium text-fg-muted">
            {{ t('searchIndexes.form.filters') }}
          </legend>
          <p class="text-small text-fg-subtle">{{ t('searchIndexes.form.filtersHint') }}</p>
          <div v-for="(_, i) in filters" :key="i" class="flex items-end gap-2">
            <DsInput
              v-model="filters[i]!"
              class="min-w-0 flex-1"
              :label="t('searchIndexes.form.filter', { n: i + 1 })"
              autocomplete="off"
              mono
            />
            <DsIconButton
              :icon="X"
              :label="t('searchIndexes.form.removeFilter', { n: i + 1 })"
              @click="filters.splice(i, 1)"
            />
          </div>
          <div>
            <DsButton size="sm" :icon="Plus" @click="filters.push('')">{{
              t('searchIndexes.form.addFilter')
            }}</DsButton>
          </div>
        </fieldset>
      </div>
      <DsCodeEditor
        v-else
        v-model="text"
        :label="t('searchIndexes.form.definition')"
        :hint="
          type === 'vectorSearch' ? t('searchIndexes.form.vectorHint') : t('searchIndexes.form.searchHint')
        "
        :error="textError"
        multiline
        :rows="12"
      />
      <DsFormErrors :messages="errors" />
      <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
    </form>
    <template #footer>
      <DsButton @click="emit('close')">{{ t('common.cancel') }}</DsButton>
      <DsButton variant="primary" :loading="busy" @click="save">
        {{ index ? t('searchIndexes.save') : t('searchIndexes.createButton') }}
      </DsButton>
    </template>
  </DsDialog>
</template>
