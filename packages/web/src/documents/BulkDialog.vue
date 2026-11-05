<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref, toRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMutation } from '@tanstack/vue-query'
import {
  QueryParseError,
  parseQueryObject,
  parseShellExpression,
  serializeValue,
} from '@mongo-manager/shared/browser'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import DsInput from '@/ds/DsInput.vue'
import DsCodeEditor from '@/ds/DsCodeEditor.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import { ApiError } from '@/api/client'
import { describeError } from '@/api/errors'
import { documentsApi, type BulkBody, type BulkPreview, type CollectionTarget } from '@/api/documents'
import { useToastStore } from '@/stores/toasts'
import { useDialogStore } from '@/stores/dialogs'
import { formatCount } from '@/format'
import { completionsFor } from './completions'
import { useDocumentActions } from './documentActions'
import { isDocument } from './values'
import BulkSamples from './BulkSamples.vue'

const props = defineProps<{
  target: CollectionTarget
  operation: 'update' | 'delete'
  initialFilter: string
  fields: string[]
}>()
const emit = defineEmits<{ close: [] }>()
const { t, locale } = useI18n()
const dialogs = useDialogStore()
const n = (value: number) => formatCount(value, locale.value)
const toasts = useToastStore()
const actions = useDocumentActions(toRef(props, 'target'))

const UPDATE_EXAMPLE = '{ $set: { field: value } }'
const filter = ref(props.initialFilter)
const update = ref('{ $set: {  } }')
const initialUpdate = update.value
/** Bumped on every edit; a preview answer for an older text is ignored. */
let edits = 0
const confirmText = ref('')
const preview = ref<BulkPreview | null>(null)
const errors = ref<{ filter?: string; update?: string; general: string[] }>({ general: [] })

// Any change after a preview makes it describe something else: preview again (Review Focus 4).
watch([filter, update], () => {
  edits++
  preview.value = null
  confirmText.value = ''
})

const syntax = (e: unknown) =>
  e instanceof QueryParseError
    ? t('query.syntaxError', { line: e.line, column: e.column, message: e.message })
    : String(e)

function body(): BulkBody | null {
  errors.value = { general: [] }
  let parsedFilter: Record<string, unknown>
  try {
    parsedFilter = serializeValue(parseQueryObject(filter.value)) as Record<string, unknown>
  } catch (e) {
    errors.value.filter = syntax(e)
    return null
  }
  if (props.operation === 'delete') return { filter: parsedFilter, operation: 'delete' }
  let value: unknown
  try {
    value = parseShellExpression(update.value)
  } catch (e) {
    errors.value.update = syntax(e)
    return null
  }
  const operatorDoc =
    isDocument(value) && Object.keys(value).length > 0 && Object.keys(value).every((k) => k.startsWith('$'))
  const pipeline = Array.isArray(value) && value.length > 0 && value.every(isDocument)
  if (!operatorDoc && !pipeline) {
    errors.value.update = t('bulk.invalidUpdate')
    return null
  }
  const encoded = serializeValue(value) as Record<string, unknown> | Record<string, unknown>[]
  return { filter: parsedFilter, operation: 'update', update: encoded }
}

/** Server refusals with a reason are explained in the user's language, with localized numbers. */
function explain(e: unknown): string {
  if (!(e instanceof ApiError)) return describeError(e, t)
  const details = (e.details ?? {}) as { reason?: unknown; from?: unknown; to?: unknown }
  if (details.reason === 'count_changed')
    return t('bulk.reasons.countChanged', { from: n(Number(details.from)), to: n(Number(details.to)) })
  if (details.reason === 'preview_expired') return t('bulk.reasons.expired')
  if (details.reason === 'preview_changed' || details.reason === 'preview_invalid') return t('bulk.stale')
  return e.code === 'CONFLICT' || e.code === 'VALIDATION_ERROR' ? e.message : describeError(e, t)
}
const showError = (e: unknown) => {
  errors.value = { general: [explain(e)] }
}

const { mutate: runPreview, isPending: previewing } = useMutation({
  mutationFn: async (payload: BulkBody) => {
    const edit = edits // captured before the request: an answer for older text is ignored
    return { result: await documentsApi.bulkPreview(props.target, payload), edit }
  },
  onSuccess: ({ result, edit }) => {
    if (edit === edits) preview.value = result
  },
  onError: showError,
})

const { mutate: execute, isPending: running } = useMutation({
  mutationFn: ({ payload, token }: { payload: BulkBody; token: BulkPreview }) =>
    documentsApi.bulkExecute(
      props.target,
      payload,
      token.filterHash,
      token.requiresConfirmation ? confirmText.value : undefined,
    ),
  onSuccess: async (result) => {
    await actions.refresh()
    const message =
      props.operation === 'delete'
        ? t('bulk.deleted', { count: n(result.deleted ?? 0) }, result.deleted ?? 0)
        : t(
            'bulk.updated',
            { modified: n(result.modified ?? 0), matched: n(result.matched ?? 0) },
            result.matched ?? 0,
          )
    toasts.push({ kind: 'success', message })
    emit('close')
  },
  onError: (e) => {
    preview.value = null
    showError(e)
  },
})

// Ctrl+Enter reaches these without the disabled buttons: never send a request twice.
function onPreview(): void {
  if (previewing.value || running.value) return
  const payload = body()
  if (payload) runPreview(payload)
}

function onRun(): void {
  if (running.value || !canRun.value) return
  const payload = body()
  if (payload && preview.value) execute({ payload, token: preview.value })
}

async function requestClose(): Promise<void> {
  if (filter.value === props.initialFilter && update.value === initialUpdate) return emit('close')
  const discard = await dialogs.confirm({
    title: t('connection.discardTitle'),
    message: t('bulk.unsaved'),
    confirmLabel: t('connection.discard'),
    danger: true,
  })
  if (discard) emit('close')
}

const canRun = computed(
  () =>
    preview.value !== null &&
    (!preview.value.requiresConfirmation || confirmText.value === props.target.coll),
)
const completions = computed(() => completionsFor('update', props.fields))
</script>

<template>
  <DsDialog open :title="t(`bulk.${operation}`)" size="md" @close="requestClose">
    <div class="flex flex-col gap-4">
      <DsCodeEditor
        v-model="filter"
        :label="t('bulk.filter')"
        :error="errors.filter"
        :completions="completions"
        @submit="onPreview"
      />
      <DsCodeEditor
        v-if="operation === 'update'"
        v-model="update"
        :label="t('bulk.change')"
        multiline
        :rows="5"
        :hint="t('bulk.changeHint', { example: UPDATE_EXAMPLE })"
        :error="errors.update"
        :completions="completions"
        @submit="onPreview"
      />
      <div v-if="preview" role="status" class="rounded-lg bg-subtle p-3 text-ui">
        <p>{{ t('bulk.matched', { matched: n(preview.matched), total: n(preview.total) }) }}</p>
        <template v-if="preview.requiresConfirmation">
          <p class="mt-2 font-medium text-danger">{{ t('bulk.all', { name: target.coll }) }}</p>
          <DsInput
            v-model="confirmText"
            class="mt-2"
            :label="t('common.typeToConfirm', { name: target.coll })"
            autocomplete="off"
            mono
          />
        </template>
      </div>
      <BulkSamples v-if="preview?.samples" :samples="preview.samples" :operation="operation" />
      <DsFormErrors :messages="errors.general" />
    </div>
    <template #footer>
      <DsButton @click="requestClose">{{ t('common.cancel') }}</DsButton>
      <DsButton :loading="previewing" @click="onPreview">{{ t('bulk.preview') }}</DsButton>
      <DsButton
        :variant="operation === 'delete' ? 'danger' : 'primary'"
        :loading="running"
        :disabled="!canRun"
        @click="onRun"
      >
        {{ t('bulk.run') }}
      </DsButton>
    </template>
  </DsDialog>
</template>
