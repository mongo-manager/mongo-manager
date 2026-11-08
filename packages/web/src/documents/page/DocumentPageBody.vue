<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, toRef, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Braces, ChevronsDownUp, ChevronsUpDown, TriangleAlert } from 'lucide-vue-next'
import { QueryParseError, documentDiff, type FieldChange } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsChoiceCard from '@/ds/DsChoiceCard.vue'
import DsCodeEditor from '@/ds/DsCodeEditor.vue'
import DsCodeView from '@/ds/DsCodeView.vue'
import DsTabs from '@/ds/DsTabs.vue'
import DsTooltip from '@/ds/DsTooltip.vue'
import type { CollectionTarget } from '@/api/documents'
import { useCollectionViewsStore } from '@/stores/collectionViews'
import { useDialogStore } from '@/stores/dialogs'
import { HIDDEN_TOKEN, markHidden, useMaskedPath } from '@/masking/useMaskedPaths'
import type { EditorMode } from '../rows'
import { completionsFor } from '../completions'
import ReviewDiff from './ReviewDiff.vue'
import { isDocument, toJsonShell } from '../values'
import { fieldPlace, searchDocument, textMatches } from './search'
import { createHistory } from './history'
import { LONG_FROM, UnknownStandIn } from './editText'
import { useDocumentSave } from './useDocumentSave'
import DocumentTreeView from './DocumentTreeView.vue'
import DocumentSearchBar from './DocumentSearchBar.vue'
import PathBar from './PathBar.vue'

/**
 * Document page design §6.4–§6.8: one document's views — the tree (edited in place), the JSON, the
 * text editor — over one draft with one undo history, the search in it, the path of the selected
 * field, and the review before a save. The page around it walks the results; this part is made again
 * for each document (its key), its unsaved text kept with the tab by useDocumentSave.
 */
export type DocumentView = 'tree' | 'json' | 'edit'

const props = defineProps<{
  target: CollectionTarget
  tabId: string
  mode: EditorMode
  view: DocumentView
  /** Whether the tree and the text may change the document (rights, an _id, the whole document). */
  editable: boolean
  fields: string[]
  /**
   * A save or an insert done. A function, not an event (user report 2026-11-07): the results read
   * again after a save make this body again on the saved version, and an unmounted component's
   * events reach no one — the page stayed open on its editor.
   */
  onDone?: (kind: 'saved' | 'inserted') => void
}>()
const emit = defineEmits<{
  'update:view': [view: DocumentView]
  leave: []
}>()
const { t, locale } = useI18n()
const dialogs = useDialogStore()
const isMasked = useMaskedPath()
const slot = useCollectionViewsStore().stateFor(props.tabId).inspector

const save = useDocumentSave({
  target: toRef(props, 'target'),
  tabId: props.tabId,
  mode: toRef(props, 'mode'),
  onDone: (kind) => props.onDone?.(kind),
})
const writing = computed(() => props.mode.kind !== 'edit')
const canType = computed(() => writing.value || props.editable)

// ---- one draft: the text is the truth; the tree's edits are written into it
type Parsed = { ok: true; doc: Record<string, unknown> } | { ok: false; error: string }
function parseText(text: string): Parsed {
  try {
    const value = save.fromText(text)
    save.noteRead(text, value)
    return isDocument(value)
      ? { ok: true, doc: value }
      : { ok: false, error: t('editor.invalidDocument', { example: '{ field: value }' }) }
  } catch (e) {
    if (e instanceof UnknownStandIn)
      return { ok: false, error: t('documents.docPage.standInUnknown', { standIn: e.standIn }) }
    return { ok: false, error: e instanceof QueryParseError || e instanceof Error ? e.message : String(e) }
  }
}
const parsed = shallowRef<Parsed>(
  save.dirty.value ? parseText(save.text.value) : { ok: true, doc: save.base.value },
)
let lastGood = parsed.value.ok ? parsed.value.doc : save.base.value
/** The text the tree or the history wrote last: its parse is already known. */
let written: string | null = null
let parseTimer: ReturnType<typeof setTimeout> | undefined
const history = createHistory(save.text.value)
watch(save.text, (text) => {
  if (text === written) {
    written = null
    return
  }
  history.push(text)
  clearTimeout(parseTimer)
  parseTimer = setTimeout(() => {
    parsed.value = parseText(text)
  }, 150)
})
watch(parsed, (p) => {
  if (p.ok) lastGood = p.doc
})
// A reload of the latest version puts in a new base: the page shows it at once. Review 2026-11-07: and
// the history starts again on it — an undo past it would bring back text written on the old version,
// then saved with the new version's hash over the other user's change.
watch(save.base, (base) => {
  history.reset(save.text.value)
  if (!save.dirty.value) parsed.value = { ok: true, doc: base }
})
onBeforeUnmount(() => clearTimeout(parseTimer))

const shown = computed(() => (parsed.value.ok ? parsed.value.doc : lastGood))

/**
 * Final review I1: the text written here (the tree, an undo, a discard) is parsed now, and a parse
 * of what was typed before, still waiting, is let go — it would bring back the text just replaced.
 * `written` marks only a text that changes (an unchanged one fires no watcher to clear it).
 */
function setText(text: string): void {
  clearTimeout(parseTimer)
  if (text !== save.text.value) {
    written = text
    save.text.value = text
  }
}
/** The text parsed now (a view switch must not decide on a parse 150 ms old). */
function syncParse(): void {
  clearTimeout(parseTimer)
  parsed.value = parseText(save.text.value)
}
function writeDraft(doc: Record<string, unknown>): void {
  const text = save.toText(doc)
  if (text === save.text.value) return
  history.pushStep(text)
  setText(text)
  parsed.value = { ok: true, doc }
}
function applyHistory(text: string | null): void {
  if (text === null) return
  setText(text)
  parsed.value = parseText(text)
}
const undo = () => applyHistory(history.undo())
const redo = () => applyHistory(history.redo())
/** User report 2026-11-05: the text written again in shape (one undo step); a text that does not parse stays. */
function format(): void {
  syncParse()
  if (!parsed.value.ok) return
  const text = save.toText(parsed.value.doc)
  if (text !== save.text.value) {
    history.pushStep(text)
    setText(text)
  }
  editor.value?.focus()
}

/** How many fields the draft changes; null while the text does not parse, or for a new document. */
const changeCount = computed(() => {
  if (writing.value || !parsed.value.ok) return null
  const diff = documentDiff(save.base.value, parsed.value.doc)
  return diff.kind === 'none' ? 0 : diff.changes.length
})

// ---- the views
const tabs = computed(() => [
  { value: 'tree' as const, label: t('documents.docPage.viewTree') },
  { value: 'json' as const, label: t('documents.docPage.viewJson') },
  ...(canType.value ? [{ value: 'edit' as const, label: t('documents.docPage.viewEdit') }] : []),
])
const view = computed({
  get: () => (writing.value ? 'edit' : props.view === 'edit' && !canType.value ? 'tree' : props.view),
  set: (next: DocumentView) => {
    if (next !== 'edit') {
      syncParse()
      if (!parsed.value.ok) return
    }
    emit('update:view', next)
  },
})
const tree = ref<InstanceType<typeof DocumentTreeView> | null>(null)
const editor = ref<InstanceType<typeof DsCodeEditor> | null>(null)
const completions = computed(() => completionsFor('document', props.fields))
const selected = ref<readonly string[]>([])

async function editInText(path: readonly string[]): Promise<void> {
  emit('update:view', 'edit')
  await nextTick()
  // Review 2026-11-07: the field's value, found by its path through the text (fieldPlace).
  const place = fieldPlace(save.text.value, path)
  if (place) editor.value?.select(place[0], place[1])
  else editor.value?.focus()
}

// ---- the search, kept with the tab across documents
const search = slot.search
const query = ref(search.text)
let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(
  () => search.text,
  (text) => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => (query.value = text), 150)
  },
)
onBeforeUnmount(() => clearTimeout(searchTimer))
const current = ref(0)
// User report 2026-11-05: the keys quoted, as JSON writes them.
const shownJson = computed(() => toJsonShell(markHidden(shown.value, isMasked.value)))
/** Whether the text shows a long value by its stand-in: a note says what it is. */
const standsIn = computed(() => /⟨\d/.test(save.text.value))
const longFrom = computed(() => new Intl.NumberFormat(locale.value).format(LONG_FROM))
/** Matches over the text a view shows; a hidden value's stand-in is never one. */
function withoutHidden(text: string, ranges: Array<[number, number]>): Array<[number, number]> {
  if (!text.includes(HIDDEN_TOKEN)) return ranges
  const spans: Array<[number, number]> = []
  for (let at = text.indexOf(HIDDEN_TOKEN); at >= 0; at = text.indexOf(HIDDEN_TOKEN, at + 1))
    spans.push([at, at + HIDDEN_TOKEN.length])
  return ranges.filter(([from, to]) => !spans.some(([a, b]) => from < b && to > a))
}
const found = computed(() => {
  const q = query.value
  if (view.value === 'tree') {
    // The tree shows a word for a hidden value: the search finds that word, never the value.
    const r = searchDocument(shown.value, q, search.scope, isMasked.value, t('masking.hidden'))
    return { count: r.matches.length, capped: r.capped, doc: r.matches, text: [] as Array<[number, number]> }
  }
  const text = view.value === 'json' ? shownJson.value : save.text.value
  const r = textMatches(text, q, search.scope)
  const ranges = view.value === 'json' ? withoutHidden(text, r.ranges) : r.ranges
  return { count: ranges.length, capped: r.capped, doc: [], text: ranges }
})
watch([query, () => search.scope, view], () => (current.value = 0))
watch(
  () => found.value.count,
  (count) => {
    if (current.value >= count) current.value = 0
  },
)
function step(delta: number): void {
  const count = found.value.count
  if (!count) return
  current.value = (current.value + delta + count) % count
  if (view.value === 'edit') {
    const range = found.value.text[current.value]
    if (range) editor.value?.select(range[0], range[1], false)
  }
}
watch(
  () => [current.value, found.value] as const,
  ([at, f]) => {
    const match = f.doc[at]
    if (match) selected.value = match.path
  },
)
const searchBar = ref<InstanceType<typeof DocumentSearchBar> | null>(null)
const root = ref<HTMLElement | null>(null)

// ---- leaving, saving, the keyboard
async function discard(): Promise<void> {
  const ok = await dialogs.confirm({
    title: t('connection.discardTitle'),
    message: t('editor.unsaved'),
    confirmLabel: t('connection.discard'),
    danger: true,
  })
  if (!ok) return
  const text = save.initial.value
  history.pushStep(text)
  setText(text)
  parsed.value = parseText(text)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing) return
  const target = event.target as HTMLElement
  const typing = !!target.closest('input, textarea, select, [contenteditable="true"]')
  const mod = (event.ctrlKey || event.metaKey) && !event.altKey
  // Final review minor: the review shows what will be written — no undo changes the text under it.
  const reviewing = !!save.review.value
  if (mod && !typing && !reviewing && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    if (event.shiftKey) redo()
    else undo()
  } else if (mod && !typing && !reviewing && event.key.toLowerCase() === 'y') {
    event.preventDefault()
    redo()
  } else if (
    view.value === 'edit' &&
    !reviewing &&
    event.altKey &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    event.code === 'KeyF'
  ) {
    event.preventDefault()
    format()
  } else if (reviewing && mod && event.key === 'Enter') {
    // Review 2026-11-07: what the review shows is saved from the keyboard too.
    event.preventDefault()
    if (!save.pending.value) save.submit()
  } else if (event.key === 'Escape') {
    // Escape takes the review back first; then it leaves the page (which asks about unsaved edits).
    event.preventDefault()
    if (save.review.value) save.back()
    else emit('leave')
  }
}
/** Ctrl+F / ⌘F: this page's search, when the focus is in it or nowhere and this is the only page. */
function onWindowKeydown(event: KeyboardEvent): void {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'f')
    return
  const active = document.activeElement
  const nowhere = !active || active === document.body
  const pages = document.querySelectorAll('[data-document-page]').length
  const pageEl = root.value?.closest('[data-document-page]') ?? root.value
  // Final review minor: with the focus nowhere, only when the last click was in the page (not in a
  // pane beside it).
  if (!(pageEl?.contains(active) || (nowhere && pages === 1 && clickedInside !== false))) return
  event.preventDefault()
  searchBar.value?.focus()
}
/** Whether the last press was inside this page; null before any. */
let clickedInside: boolean | null = null
function onPointerdown(event: PointerEvent): void {
  const pageEl = root.value?.closest('[data-document-page]') ?? root.value
  clickedInside = !!pageEl?.contains(event.target as Node)
}
// Capturing: an editor in the tree that keeps its keys (@keydown.stop) still gives Ctrl+F to the page.
onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown, true)
  document.addEventListener('pointerdown', onPointerdown, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown, true)
  document.removeEventListener('pointerdown', onPointerdown, true)
})

// Final review I8: the JSON view scrolls to the match the search is at; the editor shows the first
// match of a new search (its selection, the focus left in the search box).
watch(
  () => [current.value, found.value, view.value] as const,
  async ([, , v]) => {
    if (v !== 'json') return
    await nextTick()
    root.value?.querySelector('[data-search-mark][data-current]')?.scrollIntoView?.({ block: 'center' })
  },
)
watch(query, async () => {
  if (view.value !== 'edit') return
  await nextTick()
  const range = found.value.text[0]
  if (range) editor.value?.select(range[0], range[1], false)
})

defineExpose({
  mayLeave: () => save.mayLeave(),
  focusSearch: () => searchBar.value?.focus(),
})

const hidden = computed(() => ({ token: HIDDEN_TOKEN, label: t('masking.hiddenValue') }))
// ---- The review: only the changed fields, or the whole document (user request 2026-11-07)
const writeName = useId()
const writeChoice = computed({
  get: () => (save.replaceInstead.value ? 'replace' : 'update'),
  set: (value: string) => (save.replaceInstead.value = value === 'replace'),
})
/** What the review shows: the fields written, or the whole document before and after. */
const reviewChanges = computed((): FieldChange[] => {
  const review = save.review.value
  if (!review) return []
  if (!save.replacing.value) return review.diff.changes
  return [{ path: '', before: save.base.value, after: review.document }]
})
/** The fields a replace writes again though they did not change, by name. */
const untouchedNames = computed(() => {
  const review = save.review.value
  if (!review) return []
  const changedTop = new Set(review.diff.changes.map((c) => c.path.split('.')[0]))
  return Object.keys(review.document).filter((k) => k !== '_id' && !changedTop.has(k))
})
const untouched = computed(() => untouchedNames.value.length)
/** The names shown in the note; the rest are counted. */
const NAMES_SHOWN = 8

const iconButton =
  'inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-small text-fg-muted transition-colors duration-120 hover:bg-subtle hover:text-fg'
</script>

<template>
  <div ref="root" class="flex min-h-0 flex-1 flex-col" @keydown="onKeydown">
    <div
      v-if="!save.review.value"
      class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2"
    >
      <DsTabs
        v-if="!writing"
        v-model="view"
        :label="t('documents.docPage.views')"
        :tabs="tabs"
        id-prefix="document-page"
      />
      <DocumentSearchBar
        ref="searchBar"
        v-model:text="search.text"
        v-model:scope="search.scope"
        :total="found.count"
        :current="current"
        :capped="found.capped"
        @next="step(1)"
        @prev="step(-1)"
      />
      <div v-if="view === 'tree' && !save.review.value" class="flex items-center gap-0.5">
        <button type="button" :class="iconButton" @click="tree?.openAll()">
          <ChevronsUpDown class="size-3.5" aria-hidden="true" />{{ t('documents.docPage.openAll') }}
        </button>
        <button type="button" :class="iconButton" @click="tree?.closeAll()">
          <ChevronsDownUp class="size-3.5" aria-hidden="true" />{{ t('documents.docPage.closeAll') }}
        </button>
      </div>
      <button
        v-else-if="view === 'edit' && !save.review.value"
        type="button"
        data-format
        :class="[iconButton, 'disabled:cursor-not-allowed disabled:opacity-50']"
        :disabled="!parsed.ok || !canType || save.pending.value"
        aria-keyshortcuts="Alt+Shift+F"
        :title="t('shortcuts.actions.documentFormat')"
        @click="format"
      >
        <Braces class="size-3.5" aria-hidden="true" />{{ t('documents.docPage.format') }}
      </button>
    </div>
    <p
      v-if="!parsed.ok && !writing"
      data-parse-blocks
      role="note"
      class="px-4 pt-2 text-small text-fg-subtle"
    >
      {{ t('documents.docPage.parseBlocks') }}
    </p>
    <PathBar
      v-if="view === 'tree' && !save.review.value"
      :path="selected"
      @go="(p) => (p.length ? tree?.reveal(p) : tree?.focusTree())"
    />

    <!--
      User request 2026-11-07: the review takes the page's width, its fields as a diff side by side,
      with a bar of its own; the views, the search and the tree's buttons, which do nothing here, go.
    -->
    <ReviewDiff
      v-if="save.review.value"
      class="flex-1"
      :changes="reviewChanges"
      :whole="save.replacing.value"
    >
      <template #summary>
        <h2 class="m-0 text-ui font-semibold text-fg">
          {{
            t(
              save.replacing.value ? 'editor.diff.replaceSummary' : 'editor.diff.updateSummary',
              { n: save.review.value.diff.changes.length },
              save.review.value.diff.changes.length,
            )
          }}
        </h2>
      </template>
      <template #notice>
        <!--
          User request 2026-11-07: what is written is a choice that changes the review, not a box
          ticked under it — only the changed fields, or the whole document shown as such.
        -->
        <fieldset
          v-if="save.review.value.diff.kind === 'update'"
          data-write-choice
          class="m-0 grid min-w-0 shrink-0 gap-3 border-0 p-0 sm:grid-cols-2"
        >
          <legend class="sr-only">{{ t('editor.diff.writeLabel') }}</legend>
          <DsChoiceCard
            v-model="writeChoice"
            :name="writeName"
            value="update"
            :title="t('editor.diff.writeChanged')"
            :help="
              t(
                'editor.diff.writeChangedHelp',
                { n: save.review.value.diff.changes.length },
                save.review.value.diff.changes.length,
              )
            "
            :badge="t('editor.diff.recommended')"
          />
          <DsChoiceCard
            v-model="writeChoice"
            :name="writeName"
            value="replace"
            :title="t('editor.diff.writeWhole')"
            :help="t('editor.diff.writeWholeHelp')"
          />
        </fieldset>
        <p
          v-if="save.review.value.diff.kind === 'replace'"
          role="note"
          class="flex shrink-0 gap-2 rounded-lg border border-warning/25 bg-warning-soft p-3 text-ui text-warning"
        >
          <TriangleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {{ t(`editor.replaceReason.${save.review.value.diff.reason}`) }}
        </p>
        <p
          v-else-if="save.replacing.value && untouched > 0"
          role="note"
          data-rewritten
          class="flex shrink-0 gap-2 rounded-lg border border-warning/25 bg-warning-soft p-3 text-ui text-warning"
        >
          <TriangleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span class="flex min-w-0 flex-col gap-1.5">
            {{ t('editor.diff.rewritten', { n: untouched }, untouched) }}
            <span class="flex flex-wrap gap-1">
              <code
                v-for="name in untouchedNames.slice(0, NAMES_SHOWN)"
                :key="name"
                class="rounded-md bg-raised/70 px-1.5 py-0.5 font-mono text-small text-fg"
                >{{ name }}</code
              >
              <span v-if="untouched > NAMES_SHOWN" class="self-center text-small">{{
                t('editor.diff.moreFields', { n: untouched - NAMES_SHOWN }, untouched - NAMES_SHOWN)
              }}</span>
            </span>
          </span>
        </p>
      </template>
    </ReviewDiff>
    <div v-else class="min-h-0 flex-1 overflow-auto" data-document-content>
      <div v-if="view === 'tree'" class="px-2 py-1">
        <DocumentTreeView
          ref="tree"
          :doc="shown"
          :base="writing ? shown : save.base.value"
          :editable="editable && parsed.ok"
          :matches="found.doc"
          :current="current"
          :is-masked="isMasked"
          @change="writeDraft"
          @edit-text="editInText"
          @select="(p) => (selected = p)"
        />
      </div>
      <div v-else-if="view === 'json'" class="p-4">
        <div class="rounded-lg border border-line bg-subtle/60 p-3 font-mono text-[12.5px] leading-5">
          <DsCodeView :text="shownJson" :hidden="hidden" :marks="found.text" :current-mark="current" />
        </div>
      </div>
      <div v-else class="flex h-full min-h-80 flex-col p-4">
        <DsCodeEditor
          ref="editor"
          v-model="save.text.value"
          :label="t('editor.text')"
          hide-label
          multiline
          fill
          history-keys
          :marks="found.text"
          :current-mark="current"
          :hint="mode.kind === 'insert' ? t('editor.insertHint') : undefined"
          :error="parsed.ok ? undefined : parsed.error"
          :completions="completions"
          :readonly="save.pending.value || !canType"
          @submit="save.submit"
          @undo="undo"
          @redo="redo"
        />
        <p v-if="standsIn" data-long-note role="note" class="mt-2 shrink-0 text-small text-fg-subtle">
          {{ t('documents.docPage.longNote', { n: longFrom }) }}
        </p>
      </div>
    </div>

    <div class="shrink-0 space-y-2 px-4 empty:hidden">
      <DsCallout v-if="save.error.value" tone="danger" class="mt-2">{{ save.error.value }}</DsCallout>
      <p
        v-if="save.caution.value"
        data-caution
        role="note"
        class="mt-2 flex items-start gap-2 rounded-lg border border-warning/25 bg-warning-soft px-3 py-2 text-ui text-warning"
      >
        <TriangleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>{{ save.caution.value }}</span>
      </p>
      <p
        v-if="!save.review.value && save.cloneDropped.value.length"
        data-clone-dropped
        class="mt-2 text-ui text-fg-muted"
      >
        {{ t('masking.cloneDropped', { fields: save.cloneDropped.value.join(', ') }) }}
      </p>
      <div
        v-if="save.conflict.value"
        role="alert"
        class="mt-2 rounded-lg border border-warning/25 bg-warning-soft p-3 text-ui text-warning"
      >
        <p>{{ save.conflict.value === 'changed' ? t('editor.conflict') : t('editor.gone') }}</p>
        <DsButton
          v-if="save.conflict.value === 'changed'"
          size="sm"
          class="mt-2"
          @click="save.reloadLatest"
          >{{ t('editor.reload') }}</DsButton
        >
      </div>
    </div>

    <footer
      v-if="save.review.value || save.changed.value || writing"
      data-document-footer
      class="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line bg-canvas px-4 py-3 pr-[max(1rem,var(--mm-launcher-clearance,0px))]"
    >
      <template v-if="save.review.value">
        <DsTooltip :text="t('editor.back')" :shortcut="['Escape']">
          <DsButton aria-keyshortcuts="Escape" @click="save.back">{{ t('editor.back') }}</DsButton>
        </DsTooltip>
        <DsTooltip
          :text="save.replacing.value ? t('editor.replaceButton') : t('editor.saveChanges')"
          :shortcut="['Ctrl', 'Enter']"
        >
          <DsButton
            variant="primary"
            aria-keyshortcuts="Control+Enter"
            :loading="save.pending.value"
            @click="save.submit"
          >
            {{ save.replacing.value ? t('editor.replaceButton') : t('editor.saveChanges') }}
          </DsButton>
        </DsTooltip>
      </template>
      <template v-else-if="writing">
        <DsButton @click="emit('leave')">{{ t('common.cancel') }}</DsButton>
        <DsButton variant="primary" :loading="save.pending.value" @click="save.submit">
          {{ t('editor.insertButton') }}
        </DsButton>
      </template>
      <template v-else>
        <p data-change-count role="status" class="mr-auto text-small text-fg-muted">
          {{
            changeCount
              ? t('documents.docPage.changes', { n: changeCount }, changeCount)
              : t('documents.docPage.changedUnparsed')
          }}
        </p>
        <DsButton @click="discard">{{ t('documents.docPage.discard') }}</DsButton>
        <DsTooltip :text="parsed.ok ? '' : t('documents.docPage.parseBlocks')">
          <DsButton variant="primary" :loading="save.pending.value" @click="save.submit">
            {{ t('documents.docPage.review') }}
          </DsButton>
        </DsTooltip>
      </template>
    </footer>
  </div>
</template>
