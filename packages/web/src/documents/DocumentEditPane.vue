<script setup lang="ts">
import { computed, markRaw, ref, toRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMutation } from '@tanstack/vue-query'
import { TriangleAlert } from 'lucide-vue-next'
import {
  QueryParseError,
  documentDiff,
  parseShellExpression,
  type DocumentDiff,
} from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import DsCodeEditor from '@/ds/DsCodeEditor.vue'
import { ApiError } from '@/api/client'
import { describeError } from '@/api/errors'
import { documentsApi, type CollectionTarget } from '@/api/documents'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import { editorKey, type EditorMode } from './rows'
import { useCollectionViewsStore } from '@/stores/collectionViews'
import { completionsFor } from './completions'
import { useDocumentActions } from './documentActions'
import DiffList from './DiffList.vue'
import { decodeDocument, encodeValue, isDocument, toShell } from './values'
import { stripMasked, useMaskedPath } from '@/masking/useMaskedPaths'
import { cautionText } from './caution'
import DsCallout from '@/ds/DsCallout.vue'

/**
 * UI redesign R1 revision 2 §4.5: the document editor inside the inspector — edit (with the review of
 * what will be written), clone and insert. Phase 1g-1's logic, unchanged: the diff is computed against
 * the version opened, saves carry its hash, and a conflict never overwrites.
 */
const props = defineProps<{ target: CollectionTarget; tabId: string; mode: EditorMode; fields: string[] }>()
const emit = defineEmits<{ done: [kind: 'saved' | 'inserted']; cancel: [] }>()
const { t } = useI18n()
const dialogs = useDialogStore()
const toasts = useToastStore()
const actions = useDocumentActions(toRef(props, 'target'))

const DOC_EXAMPLE = '{ field: value }'

/** Phase 3c §7: the paths the server hides from this user here. */
const isMasked = useMaskedPath()
/** A clone leaves out the hidden values: it could not write them back. */
const cloneDropped = ref<string[]>([])

function initialText(): string {
  const mode = props.mode
  if (mode.kind === 'edit') return toShell(mode.row.value)
  if (mode.kind === 'clone') {
    const { _id: _ignored, ...rest } = mode.row.value
    const { value, dropped } = stripMasked(rest, isMasked.value)
    cloneDropped.value = dropped
    return toShell(value)
  }
  return '{\n  \n}'
}

// Reviewer B I1: unsaved edits kept with the tab come back as they were left.
const slot = useCollectionViewsStore().stateFor(props.tabId).inspector
const draftKey = editorKey(props.mode)
const restored = slot.draft?.key === draftKey ? slot.draft : null
// A draft of another editor cannot be shown here: it was let go when its editor was left.
if (!restored) slot.draft = null
else cloneDropped.value = restored.dropped
const text = ref(restored?.text ?? initialText())
// What counts as "unchanged" for the discard prompt; moves along when the current version is loaded.
const initial = ref(restored?.initial ?? text.value)
const dirty = computed(() => text.value !== initial.value)
const hash = ref(restored?.hash ?? (props.mode.kind === 'edit' ? props.mode.row.hash : ''))
/** The version being edited: the diff is computed against it (spec §4.2). */
const base = ref<Record<string, unknown>>(
  restored?.base ?? (props.mode.kind === 'edit' ? props.mode.row.value : {}),
)
watch([text, initial, hash], () => {
  slot.draft = dirty.value
    ? markRaw({
        key: draftKey,
        text: text.value,
        initial: initial.value,
        hash: hash.value,
        base: base.value,
        dropped: cloneDropped.value,
      })
    : null
})
const error = ref('')
const conflict = ref<'changed' | 'gone' | null>(null)
/**
 * Data review 2026-10-13 (M3): a field shown as a typed value it is not stored as — said before a
 * save of it is refused, and before a copy holds the shown value instead of the stored one.
 */
const caution = computed(() => {
  const mode = props.mode
  const c = mode.kind === 'insert' ? undefined : mode.row.caution
  return c ? cautionText(t, c, mode.kind === 'clone' ? 'clone' : 'edit') : ''
})
/** Edit mode, after Save: the changes waiting for confirmation, and the edited document. */
const review = ref<{
  diff: Exclude<DocumentDiff, { kind: 'none' }>
  document: Record<string, unknown>
} | null>(null)
const replaceInstead = ref(false)
const replacing = computed(() => review.value?.diff.kind === 'replace' || replaceInstead.value)
const completions = computed(() => completionsFor('document', props.fields))

function parse(): unknown {
  try {
    return parseShellExpression(text.value)
  } catch (e) {
    error.value =
      e instanceof QueryParseError
        ? t('query.syntaxError', { line: e.line, column: e.column, message: e.message })
        : String(e)
    return undefined
  }
}

/** Edit mode: checks the text and shows what would be written; nothing is sent yet. */
function prepareEdit(): void {
  error.value = ''
  conflict.value = null
  const value = parse()
  if (value === undefined || props.mode.kind !== 'edit') return
  if (!isDocument(value)) {
    error.value = t('editor.invalidDocument', { example: DOC_EXAMPLE })
    return
  }
  if ('_id' in value && toShell(value._id, 0) !== toShell(props.mode.row.value._id, 0)) {
    error.value = t('editor.idChanged')
    return
  }
  const diff = documentDiff(base.value, value)
  if (diff.kind === 'none') {
    error.value = t('editor.noChanges')
    return
  }
  // Phase 3c §7: a hidden value cannot be changed; the server would refuse it anyway.
  const hidden =
    diff.kind === 'update'
      ? [...Object.keys(diff.set), ...diff.unset].find((path) => isMasked.value(path.split('.')))
      : undefined
  if (hidden) {
    error.value = t('masking.editBlocked', { field: hidden })
    return
  }
  replaceInstead.value = false
  review.value = { diff, document: value }
}

const { mutate: save, isPending } = useMutation({
  mutationFn: async (): Promise<'saved' | number | null> => {
    error.value = ''
    conflict.value = null
    const mode = props.mode
    if (mode.kind === 'edit') {
      const pending = review.value
      if (!pending) return null
      if (pending.diff.kind === 'update' && !replaceInstead.value) {
        const set = encodeValue(pending.diff.set)
        await documentsApi.update(props.target, mode.row.raw._id, set, pending.diff.unset, hash.value)
      } else {
        await documentsApi.replace(props.target, mode.row.raw._id, encodeValue(pending.document), hash.value)
      }
      return 'saved'
    }
    const value = parse()
    if (value === undefined) return null
    const documents = Array.isArray(value) ? value : [value]
    if (documents.length === 0 || !documents.every(isDocument)) {
      error.value = t('editor.invalidDocuments')
      return null
    }
    const result = await documentsApi.insert(
      props.target,
      documents.map((d) => encodeValue(d)),
    )
    return result.insertedIds.length
  },
  onSuccess: async (result) => {
    if (result === null) return
    await actions.refresh()
    toasts.push({
      kind: 'success',
      message: result === 'saved' ? t('editor.saved') : t('editor.inserted', { count: result }, result),
    })
    initial.value = text.value
    slot.draft = null
    emit('done', result === 'saved' ? 'saved' : 'inserted')
  },
  onError: (e) => {
    if (e instanceof ApiError && e.code === 'DOCUMENT_CHANGED') conflict.value = 'changed'
    else if (e instanceof ApiError && e.code === 'NOT_FOUND') conflict.value = 'gone'
    else if (e instanceof ApiError && e.code === 'VALIDATION_ERROR') error.value = e.message
    else error.value = describeError(e, t)
  },
})

/** Ctrl+Enter bypasses the disabled button: never start a second save while one is running. */
function submit(): void {
  if (isPending.value) return
  if (props.mode.kind === 'edit' && !review.value) prepareEdit()
  else save()
}

function back(): void {
  review.value = null
  error.value = ''
}

async function reloadLatest(): Promise<void> {
  if (props.mode.kind !== 'edit') return
  const ok = await dialogs.confirm({
    title: t('editor.reload'),
    message: t('editor.reloadConfirm'),
    confirmLabel: t('editor.reload'),
  })
  if (!ok) return
  try {
    const item = await documentsApi.get(props.target, props.mode.row.raw._id)
    if ('document' in item) {
      base.value = decodeDocument(item.document)
      text.value = toShell(base.value)
      initial.value = text.value
      hash.value = item.hash
      conflict.value = null
      review.value = null
    } else {
      error.value = t('documents.unsupported', { reason: item.unsupported.reason })
    }
  } catch (e) {
    if (e instanceof ApiError && e.code === 'NOT_FOUND') conflict.value = 'gone'
    else error.value = describeError(e, t)
  }
}

/** Whether the edits may be left: true when there are none, or the user lets them go. */
async function mayLeave(): Promise<boolean> {
  if (
    dirty.value &&
    !(await dialogs.confirm({
      title: t('connection.discardTitle'),
      message: t('editor.unsaved'),
      confirmLabel: t('connection.discard'),
      danger: true,
    }))
  )
    return false
  slot.draft = null
  return true
}
async function cancel(): Promise<void> {
  if (await mayLeave()) emit('cancel')
}
defineExpose({ mayLeave, dirty })
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="min-h-0 flex-1 overflow-auto p-4">
      <template v-if="review">
        <p
          v-if="review.diff.kind === 'replace'"
          role="note"
          class="mb-3 flex gap-2 rounded-lg border border-warning/25 bg-warning-soft p-3 text-ui text-warning"
        >
          <TriangleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {{ t(`editor.replaceReason.${review.diff.reason}`) }}
        </p>
        <p v-else class="mb-3 text-ui text-fg-muted">{{ t('editor.reviewIntro') }}</p>
        <DiffList :changes="review.diff.changes" />
        <DsCheckbox
          v-if="review.diff.kind === 'update'"
          v-model="replaceInstead"
          class="mt-3"
          :label="t('editor.replaceInstead')"
          :hint="t('editor.replaceInsteadHint')"
        />
        <DsCallout v-if="error" tone="danger" class="mt-3">{{ error }}</DsCallout>
      </template>
      <DsCodeEditor
        v-else
        v-model="text"
        :label="t('editor.text')"
        hide-label
        multiline
        :rows="22"
        :hint="mode.kind === 'insert' ? t('editor.insertHint') : undefined"
        :error="error"
        :completions="completions"
        :readonly="isPending"
        @submit="submit"
      />
      <p
        v-if="caution"
        data-caution
        role="note"
        class="mt-3 flex items-start gap-2 rounded-lg border border-warning/25 bg-warning-soft px-3 py-2 text-ui text-warning"
      >
        <TriangleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>{{ caution }}</span>
      </p>
      <p v-if="!review && cloneDropped.length" data-clone-dropped class="mt-3 text-ui text-fg-muted">
        {{ t('masking.cloneDropped', { fields: cloneDropped.join(', ') }) }}
      </p>
      <div
        v-if="conflict"
        role="alert"
        class="mt-3 rounded-lg border border-warning/25 bg-warning-soft p-3 text-ui text-warning"
      >
        <p>{{ conflict === 'changed' ? t('editor.conflict') : t('editor.gone') }}</p>
        <DsButton v-if="conflict === 'changed'" size="sm" class="mt-2" @click="reloadLatest">{{
          t('editor.reload')
        }}</DsButton>
      </div>
    </div>
    <footer
      class="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-canvas px-4 py-3 pr-[max(1rem,var(--mm-launcher-clearance,0px))]"
    >
      <template v-if="review">
        <DsButton @click="back">{{ t('editor.back') }}</DsButton>
        <DsButton variant="primary" :loading="isPending" @click="submit">
          {{ replacing ? t('editor.replaceButton') : t('editor.saveChanges') }}
        </DsButton>
      </template>
      <template v-else>
        <DsButton @click="cancel">{{ t('common.cancel') }}</DsButton>
        <DsButton variant="primary" :loading="isPending" @click="submit">
          {{ mode.kind === 'edit' ? t('editor.save') : t('editor.insertButton') }}
        </DsButton>
      </template>
    </footer>
  </div>
</template>
