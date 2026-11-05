<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, toRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Clipboard,
  CopyPlus,
  History,
  Info,
  Lock,
  Trash2,
} from 'lucide-vue-next'
import DsMenu from '@/ds/DsMenu.vue'
import DsTooltip from '@/ds/DsTooltip.vue'
import type { DsMenuItem } from '@/ds/menu'
import type { CollectionTarget } from '@/api/documents'
import { useCollectionViewsStore } from '@/stores/collectionViews'
import {
  editorKey,
  hasId,
  rowIdKey,
  type DocumentRow,
  type EditorMode,
  type InspectorMode,
  type Row,
  type RowAction,
} from '../rows'
import { rowId } from '../rowMenu'
import { loadFull, useDocumentNav } from './useDocumentNav'
import DocumentPageBody, { type DocumentView } from './DocumentPageBody.vue'

/**
 * Document page design §6.1–§6.3 (user request 2026-11-04): a document opened from the results fills
 * the collection's page — not a drawer beside them. Back returns to the results; prev and next (and
 * Alt+↑ / Alt+↓) walk them, over their pages. Insert and clone open here too. Leaving unsaved edits
 * asks first. A projected query's row is part of its document: the whole one is loaded (§6.4a).
 */
const props = withDefaults(
  defineProps<{
    target: CollectionTarget
    tabId: string
    rows: Row[]
    mode: InspectorMode
    canWrite: boolean
    fields: string[]
    total?: number
    hasMore?: boolean
    /** The skip of `rows` in the results. */
    skip?: number
    /** Rows of a projected query are part of their documents. */
    projected?: boolean
    /** Say why nothing can be changed (a collection the user may only read). */
    explainReadonly?: boolean
    /**
     * How a row is told apart (its _id by default). The shell's results are by their place: rows with
     * no _id, or one _id twice ($unwind), are each their own (review 2026-10-12, I3).
     */
    identify?: (row: DocumentRow) => string
    /** The name (aria-label) of what opened the page, given the focus back when it closes. */
    opener?: string | null
  }>(),
  {
    total: undefined,
    hasMore: false,
    skip: 0,
    projected: false,
    explainReadonly: true,
    identify: undefined,
    opener: null,
  },
)
const emit = defineEmits<{
  'update:mode': [mode: InspectorMode]
  close: []
  action: [kind: RowAction, row: Row]
}>()
const { t } = useI18n()
const state = useCollectionViewsStore().stateFor(props.tabId)
const idOf = (row: DocumentRow) => (props.identify ?? rowIdKey)(row)

const documents = computed(() => props.rows.filter((r): r is DocumentRow => r.kind === 'document'))
const found = computed(() => {
  const mode = props.mode
  return mode.kind === 'document' ? documents.value.find((r) => idOf(r) === mode.id) : undefined
})
/** The document as last seen: it stays shown (marked) when a save or a refresh takes it out of the results. */
const last = shallowRef<DocumentRow | null>(null)
watch(
  found,
  (row) => {
    if (row) last.value = row
  },
  { immediate: true },
)
const row = computed(() => (props.mode.kind === 'document' ? (found.value ?? last.value) : null))

// ---- §6.4a: the whole document behind a projected row
const full = shallowRef<DocumentRow | null>(null)
const fullError = ref('')
const loading = ref(false)
/**
 * Final review I4: bumped by a save — a projected row's hash is its part's, unchanged when a field
 * outside it was saved, so the whole document is loaded again on its new version.
 */
const fullVersion = ref(0)
const fullKey = computed(() =>
  props.projected && row.value ? `${idOf(row.value)}:${row.value.hash}:${fullVersion.value}` : null,
)
watch(
  fullKey,
  async (key) => {
    full.value = null
    fullError.value = ''
    if (!key || !row.value) return
    loading.value = true
    const result = await loadFull(props.target, row.value)
    // Another document (or version) was asked for meanwhile: that load says what is shown.
    if (fullKey.value !== key) return
    loading.value = false
    if ('error' in result) fullError.value = result.error
    else full.value = result
  },
  { immediate: true },
)
const editRow = computed(() => (props.projected ? full.value : row.value))
const shownRow = computed(() => editRow.value ?? row.value)

const editorMode = computed<EditorMode | null>(() => {
  const mode = props.mode
  if (mode.kind === 'insert') return { kind: 'insert' }
  if (mode.kind === 'clone') return { kind: 'clone', row: mode.row }
  return shownRow.value ? { kind: 'edit', row: shownRow.value } : null
})
const editable = computed(
  () => props.canWrite && !!editRow.value && hasId(editRow.value) && !(props.projected && !full.value),
)
/**
 * The body is made again for each version of the document: a save, a refresh with a newer copy, or the
 * whole document of a projected row each start it on that version (its base and hash). Unsaved text
 * kept with the tab comes back in it (useDocumentSave), and a save of it against a newer copy is told.
 */
const bodyKey = computed(() => {
  const mode = editorMode.value
  if (!mode) return ''
  return mode.kind === 'edit'
    ? `${editorKey(mode)}:${mode.row.hash}:${full.value ? 'full' : 'row'}`
    : editorKey(mode)
})
const view = computed<DocumentView>(() => (props.mode.kind === 'document' ? props.mode.tab : 'edit'))

// ---- the walk over the results
const body = ref<InstanceType<typeof DocumentPageBody> | null>(null)
const mayLeave = async (): Promise<boolean> => (body.value ? body.value.mayLeave() : true)
function open(id: string): void {
  emit('update:mode', { kind: 'document', id, tab: view.value })
}
const nav = useDocumentNav({
  state,
  rows: toRef(props, 'rows'),
  skip: toRef(props, 'skip'),
  total: toRef(props, 'total'),
  hasMore: toRef(props, 'hasMore'),
  identify: idOf,
  openId: computed(() => (props.mode.kind === 'document' ? props.mode.id : null)),
  mayLeave,
  open,
})
const heading = ref<HTMLElement | null>(null)
const root = ref<HTMLElement | null>(null)
/**
 * Review 2026-10-12 (M17): back from the page, the focus goes to what opened it — a row's button,
 * rendered again with the results, found by its name in the place the page stood.
 */
let place: HTMLElement | null = null
onUnmounted(() => {
  const opener = props.opener
  if (!opener || !place) return
  const where = place
  const refocus = (): boolean => {
    const active = document.activeElement
    if (active && active !== document.body) return true
    const el = [...where.querySelectorAll<HTMLElement>('[aria-label]')].find(
      (e) => e.getAttribute('aria-label') === opener,
    )
    el?.focus()
    return !!el
  }
  void nextTick(() => {
    if (!refocus()) setTimeout(refocus, 50)
  })
})
onMounted(() => {
  place = root.value?.parentElement ?? null
  const mode = props.mode
  if (mode.kind === 'document' && !(state.inspector.order ?? []).includes(mode.id)) nav.begin()
  void nextTick(() => heading.value?.focus({ preventScroll: true }))
})
const positionLabel = computed(() =>
  nav.position.value
    ? nav.total.value !== undefined
      ? t('documents.docPage.position', { n: nav.position.value, total: nav.total.value })
      : t('documents.docPage.positionUnknown', { n: nav.position.value })
    : '',
)

async function requestClose(): Promise<void> {
  if (await mayLeave()) emit('close')
}
function onView(next: DocumentView): void {
  const mode = props.mode
  if (mode.kind === 'document') emit('update:mode', { ...mode, tab: next })
}
async function onDone(kind: 'saved' | 'inserted'): Promise<void> {
  const mode = props.mode
  if (kind !== 'saved' || mode.kind !== 'document') return emit('close')
  emit('update:mode', { ...mode, tab: 'tree' })
  if (props.projected) fullVersion.value++
  // A save that took the document out of the query: the page goes on with its saved version.
  await nextTick()
  if (!found.value && last.value) {
    const saved = await loadFull(props.target, last.value)
    if (!('error' in saved)) last.value = saved
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey) return
  // From the header (where the focus lands on opening): back to the results. The views' own Escape
  // (a menu, the text field's first one, the review) is theirs and is not seen here.
  if (event.key === 'Escape' && !event.altKey) {
    event.preventDefault()
    void requestClose()
    return
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const el = event.target as HTMLElement
  // Plain arrows step only from the page's header; inside a view they move in it (the tree, the text).
  if (!event.altKey && !el.closest('[data-document-header]')) return
  if (!event.altKey && el.closest('[role="menu"], [role="listbox"]')) return
  event.preventDefault()
  void (event.key === 'ArrowDown' ? nav.next() : nav.prev())
}

const menu = computed<DsMenuItem[]>(() => [
  { id: 'copy', label: t('documents.docPage.copyJson'), icon: Clipboard },
  ...(props.canWrite ? [{ id: 'clone', label: t('documents.clone'), icon: CopyPlus }] : []),
  ...(props.canWrite && row.value && hasId(row.value)
    ? [{ id: 'delete', label: t('documents.delete'), icon: Trash2, danger: true, separator: true }]
    : []),
])
const title = computed(() => {
  const mode = props.mode
  if (mode.kind === 'insert') return t('editor.insert')
  if (mode.kind === 'clone') return t('editor.clone')
  return row.value ? t('documents.docPage.title', { id: rowId(row.value) }) : t('documents.inspector.title')
})
const fieldCount = computed(() => (shownRow.value ? Object.keys(shownRow.value.value).length : 0))

defineExpose({ mayLeave })

const iconButton =
  'grid size-8 cursor-pointer place-items-center rounded-lg text-fg-subtle transition-colors duration-120 hover:bg-subtle hover:text-fg disabled:cursor-not-allowed disabled:opacity-35'
</script>

<template>
  <section
    ref="root"
    data-document-page
    aria-labelledby="document-page-title"
    class="flex h-full min-h-0 flex-col bg-surface"
    @keydown="onKeydown"
  >
    <header
      data-document-header
      class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2"
    >
      <button
        type="button"
        class="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-ui text-fg-muted transition-colors duration-120 hover:bg-subtle hover:text-fg"
        aria-keyshortcuts="Escape"
        @click="requestClose"
      >
        <ArrowLeft class="size-4" aria-hidden="true" />{{ t('documents.docPage.back') }}
      </button>
      <h2
        id="document-page-title"
        ref="heading"
        tabindex="-1"
        class="min-w-0 flex-1 truncate font-mono text-title-s font-semibold text-fg outline-none"
        :title="title"
      >
        {{ title }}
      </h2>
      <template v-if="mode.kind === 'document' && row">
        <span
          v-if="positionLabel"
          data-position
          class="shrink-0 text-small whitespace-nowrap text-fg-subtle"
          >{{ positionLabel }}</span
        >
        <span class="hidden shrink-0 text-small text-fg-subtle sm:inline">{{
          t('documents.docPage.fieldCount', { count: fieldCount }, fieldCount)
        }}</span>
        <div class="flex shrink-0 items-center gap-0.5">
          <DsTooltip :text="t('documents.docPage.previous')">
            <button
              type="button"
              :class="iconButton"
              :aria-label="t('documents.docPage.previous')"
              aria-keyshortcuts="Alt+ArrowUp"
              :disabled="!nav.canPrev.value"
              @click="nav.prev()"
            >
              <ChevronUp class="size-4" aria-hidden="true" />
            </button>
          </DsTooltip>
          <DsTooltip :text="t('documents.docPage.next')">
            <button
              type="button"
              :class="iconButton"
              :aria-label="t('documents.docPage.next')"
              aria-keyshortcuts="Alt+ArrowDown"
              :disabled="!nav.canNext.value"
              @click="nav.next()"
            >
              <ChevronDown class="size-4" aria-hidden="true" />
            </button>
          </DsTooltip>
          <DsMenu
            focusable
            size="md"
            :label="t('documents.docPage.more')"
            :items="menu"
            @select="emit('action', $event as RowAction, shownRow!)"
          />
        </div>
      </template>
    </header>

    <div class="shrink-0 space-y-2 px-4 empty:hidden [&>*]:mt-2">
      <p
        v-if="mode.kind === 'document' && row && nav.stale.value"
        data-stale
        role="status"
        class="flex items-center gap-1.5 rounded-lg bg-warning-soft px-2.5 py-1.5 text-small text-warning"
      >
        <History class="size-3.5 shrink-0" aria-hidden="true" />{{ t('documents.docPage.stale') }}
      </p>
      <p
        v-if="mode.kind === 'document' && projected && (full || loading)"
        data-projection-note
        role="note"
        class="flex items-center gap-1.5 rounded-lg bg-subtle px-2.5 py-1.5 text-small text-fg-muted"
      >
        <Info class="size-3.5 shrink-0" aria-hidden="true" />{{
          loading ? t('documents.docPage.loading') : t('documents.docPage.projection')
        }}
      </p>
      <p
        v-if="mode.kind === 'document' && projected && fullError"
        role="alert"
        class="rounded-lg bg-warning-soft px-2.5 py-1.5 text-small text-warning"
      >
        {{ t('documents.docPage.projectionFailed', { reason: fullError }) }}
      </p>
      <p
        v-if="mode.kind === 'document' && !canWrite && explainReadonly"
        data-readonly-note
        role="note"
        class="flex items-center gap-1.5 rounded-lg bg-subtle px-2.5 py-1.5 text-small text-fg-muted"
      >
        <Lock class="size-3.5 shrink-0" aria-hidden="true" />{{ t('documents.docPage.readonly') }}
      </p>
      <p v-if="mode.kind === 'document' && !row" role="status" class="text-ui text-fg-muted">
        {{ t('documents.docPage.notInResults') }}
      </p>
    </div>

    <DocumentPageBody
      v-if="editorMode"
      :key="bodyKey"
      ref="body"
      :target="target"
      :tab-id="tabId"
      :mode="editorMode"
      :view="view"
      :editable="mode.kind === 'document' ? editable : true"
      :fields="fields"
      @update:view="onView"
      @done="onDone"
      @leave="requestClose"
    />
  </section>
</template>
