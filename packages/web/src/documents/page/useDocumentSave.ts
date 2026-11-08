// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { computed, markRaw, ref, shallowRef, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMutation } from '@tanstack/vue-query'
import { QueryParseError, documentDiff, type DocumentDiff } from '@mongo-manager/shared/browser'
import { ApiError } from '@/api/client'
import { describeError } from '@/api/errors'
import { documentsApi, type CollectionTarget } from '@/api/documents'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import { useCollectionViewsStore } from '@/stores/collectionViews'
import { stripMasked, useMaskedPath } from '@/masking/useMaskedPaths'
import { editorKey, type EditorMode } from '../rows'
import { useDocumentActions } from '../documentActions'
import { decodeDocument, encodeValue, isDocument, toShell } from '../values'
import { cautionText } from '../caution'
import { holdsMasked } from './draftOps'
import { UnknownStandIn, longValues, readEditText, writeEditText } from './editText'

const DOC_EXAMPLE = '{ field: value }'

/**
 * Document page design §6.5–§6.6: the save of a document's edits — edit (with the review of what will
 * be written), clone and insert. The inspector editor's logic (phase 1g-1), unchanged: the diff is
 * computed against the version opened, saves carry its hash, and a conflict never overwrites. The
 * unsaved text stays with the tab (reviewer B I1) until it is saved or let go.
 */
export function useDocumentSave(opts: {
  target: Ref<CollectionTarget>
  tabId: string
  mode: Ref<EditorMode>
  onDone: (kind: 'saved' | 'inserted') => void
}) {
  const { t } = useI18n()
  const dialogs = useDialogStore()
  const toasts = useToastStore()
  const actions = useDocumentActions(opts.target)
  /** Phase 3c §7: the paths the server hides from this user here. */
  const isMasked = useMaskedPath()
  const slot = useCollectionViewsStore().stateFor(opts.tabId).inspector

  /** A clone leaves out the hidden values: it could not write them back. */
  const cloneDropped = ref<string[]>([])
  const text = ref('')
  /** What counts as "unchanged" for the discard prompt; moves along when the current version is loaded. */
  const initial = ref('')
  const dirty = computed(() => text.value !== initial.value)
  const hash = ref('')
  /** The version being edited: the diff is computed against it (spec §4.2). */
  const base = ref<Record<string, unknown>>({})
  /**
   * Review 2026-11-07: the text last read that holds the version's value as it is (only its layout
   * differs), with that version. Such text is no unsaved change: a review of it has nothing to save.
   */
  const sameValue = shallowRef<{ text: string; base: Record<string, unknown> } | null>(null)
  /**
   * Unsaved changes: the text differs, unless it was read and holds the version's value as it is. A
   * text not read yet, or that does not parse, counts as changed: no real change is ever hidden.
   */
  const changed = computed(
    () => dirty.value && !(sameValue.value?.text === text.value && sameValue.value.base === base.value),
  )
  const error = ref('')
  const conflict = ref<'changed' | 'gone' | null>(null)
  /** Edit mode, after Save: the changes waiting for confirmation, and the edited document. */
  const review = ref<{
    diff: Exclude<DocumentDiff, { kind: 'none' }>
    document: Record<string, unknown>
  } | null>(null)
  const replaceInstead = ref(false)
  const replacing = computed(() => review.value?.diff.kind === 'replace' || replaceInstead.value)
  let draftKey = ''
  /**
   * User report 2026-11-05: the long strings of the document (an image as base64) by the stand-ins
   * the text shows for them — of the row and of the version edited, the stand-ins being their hashes.
   */
  const longs = shallowRef<ReadonlyMap<string, string>>(new Map())
  /** The value as the text writes it, and the text read back (throws UnknownStandIn). */
  const toText = (value: unknown): string => writeEditText(value, longs.value)
  const fromText = (source: string): unknown => readEditText(source, longs.value)

  function initialText(mode: EditorMode): string {
    if (mode.kind === 'edit') return toText(mode.row.value)
    if (mode.kind === 'clone') {
      const { _id: _ignored, ...rest } = mode.row.value
      const { value, dropped } = stripMasked(rest, isMasked.value)
      cloneDropped.value = dropped
      return toText(value)
    }
    return '{\n  \n}'
  }

  /** Starts on `mode`: its draft kept with the tab comes back as it was left. */
  function start(mode: EditorMode): void {
    draftKey = editorKey(mode)
    const restored = slot.draft?.key === draftKey ? slot.draft : null
    // A draft of another editor cannot be shown here: it was let go when its editor was left.
    if (!restored) slot.draft = null
    cloneDropped.value = restored?.dropped ?? []
    base.value = restored?.base ?? (mode.kind === 'edit' ? mode.row.value : {})
    longs.value = longValues(mode.kind === 'insert' ? {} : mode.row.value, base.value)
    text.value = restored?.text ?? initialText(mode)
    initial.value = restored?.initial ?? text.value
    hash.value = restored?.hash ?? (mode.kind === 'edit' ? mode.row.hash : '')
    error.value = ''
    conflict.value = null
    review.value = null
    replaceInstead.value = false
  }
  start(opts.mode.value)
  watch(
    () => editorKey(opts.mode.value),
    () => start(opts.mode.value),
  )

  watch([text, initial, hash, changed], () => {
    slot.draft = changed.value
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

  /**
   * Data review 2026-10-13 (M3): a field shown as a typed value it is not stored as — said before a
   * save of it is refused, and before a copy holds the shown value instead of the stored one.
   */
  const caution = computed(() => {
    const mode = opts.mode.value
    const c = mode.kind === 'insert' ? undefined : mode.row.caution
    return c ? cautionText(t, c, mode.kind === 'clone' ? 'clone' : 'edit') : ''
  })

  /** Notes what `source` reads as (edit mode): whether it is the version's value as it is. */
  function noteRead(source: string, value: unknown): void {
    if (opts.mode.value.kind !== 'edit') return
    const same =
      isDocument(value) &&
      (!('_id' in value) || toShell(value._id, 0) === toShell(base.value._id, 0)) &&
      documentDiff(base.value, value).kind === 'none'
    sameValue.value = same ? { text: source, base: base.value } : null
  }

  function parse(): unknown {
    try {
      return fromText(text.value)
    } catch (e) {
      error.value =
        e instanceof QueryParseError
          ? t('query.syntaxError', { line: e.line, column: e.column, message: e.message })
          : e instanceof UnknownStandIn
            ? t('documents.docPage.standInUnknown', { standIn: e.standIn })
            : String(e)
      return undefined
    }
  }

  /** Edit mode: checks the text and shows what would be written; nothing is sent yet. */
  function prepareEdit(): void {
    error.value = ''
    conflict.value = null
    const mode = opts.mode.value
    const value = parse()
    if (value === undefined || mode.kind !== 'edit') return
    if (!isDocument(value)) {
      error.value = t('editor.invalidDocument', { example: DOC_EXAMPLE })
      return
    }
    if ('_id' in value && toShell(value._id, 0) !== toShell(mode.row.value._id, 0)) {
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
    // Final review I3: a value set whole (an array) that holds a hidden one would write its stand-in;
    // a replace keeps hidden values as they are stored (the server puts them back).
    if (
      diff.kind === 'update' &&
      Object.entries(diff.set).some(([path, set]) => holdsMasked(set, path.split('.'), isMasked.value))
    ) {
      review.value = { diff: { kind: 'replace', reason: 'hidden', changes: diff.changes }, document: value }
      return
    }
    review.value = { diff, document: value }
  }

  const { mutate: save, isPending: pending } = useMutation({
    mutationFn: async (): Promise<'saved' | number | null> => {
      error.value = ''
      conflict.value = null
      const mode = opts.mode.value
      if (mode.kind === 'edit') {
        const ready = review.value
        if (!ready) return null
        if (ready.diff.kind === 'update' && !replaceInstead.value) {
          const set = encodeValue(ready.diff.set)
          await documentsApi.update(opts.target.value, mode.row.raw._id, set, ready.diff.unset, hash.value)
        } else {
          await documentsApi.replace(
            opts.target.value,
            mode.row.raw._id,
            encodeValue(ready.document),
            hash.value,
          )
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
        opts.target.value,
        documents.map((d) => encodeValue(d)),
      )
      return result.insertedIds.length
    },
    onSuccess: async (result) => {
      if (result === null) return
      // Saved: no longer unsaved — before the results come back with the saved version, so the page
      // made again on it does not take the saved text for unsaved edits of the old one (e2e 2026-11-04).
      initial.value = text.value
      review.value = null
      slot.draft = null
      await actions.refresh()
      toasts.push({
        kind: 'success',
        message: result === 'saved' ? t('editor.saved') : t('editor.inserted', { count: result }, result),
      })
      opts.onDone(result === 'saved' ? 'saved' : 'inserted')
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
    if (pending.value) return
    if (opts.mode.value.kind === 'edit' && !review.value) prepareEdit()
    else save()
  }

  function back(): void {
    review.value = null
    error.value = ''
  }

  async function reloadLatest(): Promise<void> {
    const mode = opts.mode.value
    if (mode.kind !== 'edit') return
    const ok = await dialogs.confirm({
      title: t('editor.reload'),
      message: t('editor.reloadConfirm'),
      confirmLabel: t('editor.reload'),
    })
    if (!ok) return
    try {
      const item = await documentsApi.get(opts.target.value, mode.row.raw._id)
      if ('document' in item) {
        base.value = decodeDocument(item.document)
        longs.value = longValues(mode.row.value, base.value)
        text.value = toText(base.value)
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
    // The text as it is now: one typed a moment ago has not been read yet.
    if (dirty.value && sameValue.value?.text !== text.value) {
      try {
        noteRead(text.value, fromText(text.value))
      } catch {
        // Does not parse: a change, asked about.
      }
    }
    if (
      changed.value &&
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

  return {
    text,
    initial,
    dirty,
    changed,
    noteRead,
    hash,
    base,
    error,
    conflict,
    caution,
    cloneDropped,
    review,
    replaceInstead,
    replacing,
    pending,
    parse,
    toText,
    fromText,
    prepareEdit,
    submit,
    back,
    reloadLatest,
    mayLeave,
  }
}
