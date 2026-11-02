<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, ChevronDown, ChevronUp, Clipboard, CopyPlus, History, Trash2 } from 'lucide-vue-next'
import DsDrawer from '@/ds/DsDrawer.vue'
import DsTabs from '@/ds/DsTabs.vue'
import DsMenu from '@/ds/DsMenu.vue'
import DsTooltip from '@/ds/DsTooltip.vue'
import type { DsMenuItem } from '@/ds/menu'
import DsCodeView from '@/ds/DsCodeView.vue'
import type { CollectionTarget } from '@/api/documents'
import { INSPECTOR_MAX, INSPECTOR_MIN, useLayoutStore } from '@/stores/layout'
import { hasId, rowIdKey, type DocumentRow, type InspectorMode, type Row, type RowAction } from './rows'
import { rowId } from './rowMenu'
import { toShell } from './values'
import { HIDDEN_TOKEN, markHidden, useMaskedPath } from '@/masking/useMaskedPaths'
import TreeNode from './TreeNode.vue'
import DocumentEditPane from './DocumentEditPane.vue'

/**
 * UI redesign R1 revision 2 §4.5: the inspector — one document beside the results, as fields, as JSON
 * or in the editor; ↑ and ↓ walk the results; insert and clone open here too. Leaving unsaved edits
 * (another document, another tab, closing) asks first.
 */
const props = defineProps<{
  target: CollectionTarget
  tabId: string
  rows: Row[]
  mode: InspectorMode
  canWrite: boolean
  fields: string[]
  /** Over the page whatever the window's width (beside a pane too narrow to share, as the shell's). */
  floating?: boolean
  /**
   * How a row is told apart (its _id by default). The shell's results are by their place: rows with
   * no _id, or one _id twice ($unwind), are each their own (review 2026-10-12, I3).
   */
  identify?: (row: DocumentRow) => string
}>()
const idOf = (row: DocumentRow) => (props.identify ?? rowIdKey)(row)
const emit = defineEmits<{
  'update:mode': [mode: InspectorMode]
  close: []
  action: [kind: RowAction, row: Row]
}>()
const { t } = useI18n()
const layout = useLayoutStore()
/** The field name itself (not a word to translate). */
const ID_FIELD = '_id'

const documents = computed(() => props.rows.filter((r): r is DocumentRow => r.kind === 'document'))
const found = computed(() => {
  const mode = props.mode
  return mode.kind === 'document' ? documents.value.find((r) => idOf(r) === mode.id) : undefined
})
/** The document as last seen: it stays shown (marked) when a refresh takes it out of the results. */
const last = shallowRef<DocumentRow | null>(null)
watch(
  found,
  (row) => {
    if (row) last.value = row
  },
  { immediate: true },
)
const row = computed(() => (props.mode.kind === 'document' ? (found.value ?? last.value) : null))
const stale = computed(() => props.mode.kind === 'document' && !found.value && !!last.value)
const position = computed(() => (found.value ? documents.value.indexOf(found.value) : -1))

const title = computed(() =>
  props.mode.kind === 'insert'
    ? t('editor.insert')
    : props.mode.kind === 'clone'
      ? t('editor.clone')
      : t('documents.inspector.title'),
)
const tabs = computed(() => [
  { value: 'fields' as const, label: t('documents.inspector.fields') },
  { value: 'json' as const, label: t('documents.inspector.json') },
  // Reviewer B I3: a document without an _id cannot be written back.
  ...(props.canWrite && (!row.value || hasId(row.value))
    ? [{ value: 'edit' as const, label: t('documents.inspector.edit') }]
    : []),
])
const pane = ref<InstanceType<typeof DocumentEditPane> | null>(null)
async function mayLeave(): Promise<boolean> {
  return pane.value ? pane.value.mayLeave() : true
}
const tab = computed({
  get: () => (props.mode.kind === 'document' ? props.mode.tab : 'edit'),
  set: (next: 'fields' | 'json' | 'edit') => {
    const mode = props.mode
    if (mode.kind !== 'document' || next === mode.tab) return
    void (async () => {
      if (mode.tab === 'edit' && !(await mayLeave())) return
      emit('update:mode', { ...mode, tab: next })
    })()
  },
})

async function step(delta: number): Promise<void> {
  const mode = props.mode
  if (mode.kind !== 'document' || position.value < 0) return
  const next = documents.value[position.value + delta]
  if (!next || !(await mayLeave())) return
  emit('update:mode', { kind: 'document', id: idOf(next), tab: mode.tab })
}
async function requestClose(): Promise<void> {
  if (await mayLeave()) emit('close')
}
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  const el = event.target as HTMLElement
  if (el.closest('textarea, input, select, [contenteditable="true"], [role="menu"], [role="listbox"]')) return
  // Reviewer B Minor 11: inside the Fields or JSON pane the arrows scroll it (a long document).
  if (el.closest('[data-inspector-scroll]')) return
  event.preventDefault()
  void step(event.key === 'ArrowDown' ? 1 : -1)
}

const editorMode = computed(() => {
  const mode = props.mode
  if (mode.kind === 'insert') return { kind: 'insert' as const }
  if (mode.kind === 'clone') return { kind: 'clone' as const, row: mode.row }
  return row.value ? { kind: 'edit' as const, row: row.value } : null
})
// When the editor goes away its buttons take focus with them: the Fields tab gets it, so the
// keyboard (Escape, the arrows) stays in the inspector.
const tabsRef = ref<{ focusSelected: () => void } | null>(null)
function backToFields(): void {
  const mode = props.mode
  if (mode.kind !== 'document') return
  emit('update:mode', { ...mode, tab: 'fields' })
  void nextTick(() => nextTick(() => tabsRef.value?.focusSelected()))
}
function onDone(kind: 'saved' | 'inserted'): void {
  if (kind === 'saved' && props.mode.kind === 'document') backToFields()
  else emit('close')
}
function onCancel(): void {
  if (props.mode.kind === 'document') backToFields()
  else emit('close')
}

defineExpose({ mayLeave })

const json = computed(() => (row.value ? toShell(row.value.value) : ''))
// W5: the JSON tab shows hidden values with a lock and a label, as the table does; a copy keeps ***.
const isMasked = useMaskedPath()
const shownJson = computed(() => (row.value ? toShell(markHidden(row.value.value, isMasked.value)) : ''))
const hidden = computed(() => ({ token: HIDDEN_TOKEN, label: t('masking.hiddenValue') }))
const fieldCount = computed(() => (row.value ? Object.keys(row.value.value).length : 0))
const menu = computed<DsMenuItem[]>(() => [
  { id: 'copy', label: t('documents.copy'), icon: Clipboard },
  ...(props.canWrite ? [{ id: 'clone', label: t('documents.clone'), icon: CopyPlus }] : []),
  ...(props.canWrite && row.value && hasId(row.value)
    ? [{ id: 'delete', label: t('documents.delete'), icon: Trash2, danger: true, separator: true }]
    : []),
])
const copied = ref(false)
async function copyJson(): Promise<void> {
  try {
    await navigator.clipboard.writeText(json.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 1200)
  } catch {
    // the clipboard was refused; the text stays selectable
  }
}
const iconButton =
  'grid size-8 cursor-pointer place-items-center rounded-lg text-fg-subtle transition-colors duration-120 hover:bg-subtle hover:text-fg disabled:cursor-not-allowed disabled:opacity-35'
</script>

<template>
  <DsDrawer
    data-inspector
    open
    :title="title"
    :width="layout.inspectorWidth"
    :min-width="INSPECTOR_MIN"
    :max-width="INSPECTOR_MAX"
    :resize-label="t('documents.inspector.resize')"
    :close-label="t('documents.inspector.close')"
    :overlay="floating || layout.inspectorOverlay"
    @close="requestClose"
    @update:width="layout.setInspectorWidth"
    @keydown="onKeydown"
  >
    <template v-if="mode.kind === 'document' && row" #actions>
      <DsTooltip :text="t('documents.inspector.previous')">
        <button
          type="button"
          :class="iconButton"
          :aria-label="t('documents.inspector.previous')"
          :disabled="position <= 0"
          @click="step(-1)"
        >
          <ChevronUp class="size-4" aria-hidden="true" />
        </button>
      </DsTooltip>
      <DsTooltip :text="t('documents.inspector.next')">
        <button
          type="button"
          :class="iconButton"
          :aria-label="t('documents.inspector.next')"
          :disabled="position < 0 || position >= documents.length - 1"
          @click="step(1)"
        >
          <ChevronDown class="size-4" aria-hidden="true" />
        </button>
      </DsTooltip>
      <DsMenu
        focusable
        size="md"
        :label="t('documents.inspector.more', { id: rowId(row) })"
        :items="menu"
        @select="emit('action', $event as RowAction, row)"
      />
    </template>

    <div v-if="mode.kind === 'document' && row" class="flex h-full min-h-0 flex-col">
      <div class="flex shrink-0 flex-col gap-1 px-4 pt-3">
        <p data-inspector-id class="flex min-w-0 items-baseline gap-2 font-mono text-small">
          <span class="shrink-0 text-fg-subtle">{{ ID_FIELD }}</span>
          <span class="truncate text-v-oid" :title="rowId(row)">{{ rowId(row) }}</span>
          <span class="ml-auto shrink-0 font-sans text-caption text-fg-subtle">{{
            t('documents.inspector.fieldCount', { count: fieldCount }, fieldCount)
          }}</span>
        </p>
        <p
          v-if="stale"
          role="status"
          class="flex items-center gap-1.5 rounded-lg bg-warning-soft px-2.5 py-1.5 text-small text-warning"
        >
          <History class="size-3.5 shrink-0" aria-hidden="true" />{{ t('documents.inspector.stale') }}
        </p>
      </div>
      <DsTabs
        ref="tabsRef"
        v-model="tab"
        class="shrink-0 border-b border-line px-2"
        :label="t('documents.inspector.tabs')"
        :tabs="tabs"
        id-prefix="inspector"
      />
      <div class="min-h-0 flex-1">
        <div
          v-if="tab === 'fields'"
          data-inspector-scroll
          tabindex="0"
          :aria-label="t('documents.inspector.fields')"
          class="h-full overflow-auto px-2 py-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        >
          <ul>
            <TreeNode
              v-for="(value, name) in row.value"
              :key="String(name)"
              :name="String(name)"
              :value="value"
              :depth="0"
            />
          </ul>
        </div>
        <div
          v-else-if="tab === 'json'"
          data-inspector-scroll
          tabindex="0"
          :aria-label="t('documents.inspector.json')"
          class="relative h-full overflow-auto p-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        >
          <button
            type="button"
            class="absolute top-5 right-5 z-10 grid size-7 cursor-pointer place-items-center rounded-md bg-surface text-fg-subtle shadow-xs ring-1 ring-line hover:text-fg"
            :aria-label="t('documents.copy')"
            @click="copyJson"
          >
            <component :is="copied ? Check : Clipboard" class="size-3.5" aria-hidden="true" />
          </button>
          <div class="rounded-lg border border-line bg-subtle/60 p-3 font-mono text-[12.5px] leading-5">
            <DsCodeView :text="shownJson" :hidden="hidden" />
          </div>
        </div>
        <DocumentEditPane
          v-else-if="editorMode"
          :key="`edit:${mode.id}`"
          ref="pane"
          :target="target"
          :tab-id="tabId"
          :mode="editorMode"
          :fields="fields"
          @done="onDone"
          @cancel="onCancel"
        />
      </div>
    </div>
    <DocumentEditPane
      v-else-if="editorMode"
      :key="mode.kind === 'clone' ? `clone:${rowIdKey(mode.row)}` : mode.kind"
      ref="pane"
      :target="target"
      :tab-id="tabId"
      :mode="editorMode"
      :fields="fields"
      @done="onDone"
      @cancel="onCancel"
    />
  </DsDrawer>
</template>
