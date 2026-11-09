<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, defineAsyncComponent, markRaw, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { isWritePipeline, type SavedPipelineView } from '@mongo-manager/shared/browser'
import DsCodeEditor from '@/ds/DsCodeEditor.vue'
import type { CollectionTarget } from '@/api/documents'
import { aggregateApi, aggregateKeys } from '@/api/aggregate'
import { describeError } from '@/api/errors'
import { ApiError } from '@/api/client'
import { fieldPaths, toRows } from '@/documents/rows'
import type { DocumentItem } from '@/api/documents'
import { useCollectionViewsStore } from '@/stores/collectionViews'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import { useWorkspaceDialogs } from '@/stores/workspaceDialogs'
import { useQueryClient } from '@tanstack/vue-query'
import { connectionsApi, queryKeys } from '@/api/connections'
import DsButton from '@/ds/DsButton.vue'
import StageCard from './StageCard.vue'
import StagePicker from './StagePicker.vue'
import SaveItemDialog from '@/library/SaveItemDialog.vue'
import { saveError } from '@/library/errors'
import RunResults from './RunResults.vue'
import SavedPipelinesMenu from './SavedPipelinesMenu.vue'
import { stageCompletions } from './completions'
import { cardsFromStages, cardsKey, fromText, newCard, toText, type Card } from './stages'
import { usePreview } from './usePreview'
import { assistantOf, changesBetween, stepsFrom } from './steps'
import {
  Bookmark,
  Code2,
  CopyPlus,
  Database,
  Download,
  Eye,
  FileCode2,
  FilePlus2,
  Gauge,
  Lock,
  Play,
  Save,
  Square,
  Undo2,
  Workflow,
} from 'lucide-vue-next'
import DsTabs from '@/ds/DsTabs.vue'
import PipelineAsk from './PipelineAsk.vue'
import { provideMaskedPatterns } from '@/masking/useMaskedPaths'
import DsCallout from '@/ds/DsCallout.vue'
import DsSelect from '@/ds/DsSelect.vue'

const ExportDialog = defineAsyncComponent(() => import('./ExportDialog.vue'))

/** Phase 2a spec §4: the Aggregations section of a collection or view tab. */
const props = defineProps<{
  target: CollectionTarget
  tabId: string
  canWrite: boolean
  /** Phase 3d-1: may export the pipeline's results as a file. */
  canExport?: boolean
  /** W2.2: may change a view's definition (databases:write). */
  canWriteDatabase?: boolean
}>()
const ExportDataDialog = defineAsyncComponent(() => import('@/transfer/ExportDataDialog.vue'))
const exportingData = ref(false)
/** W4.3 (phase 3d-2 spec §3.1): the pipeline's results copied to a collection, here or elsewhere. */
const CopyWizard = defineAsyncComponent(() => import('@/transfer/CopyWizard.vue'))
const copyingData = ref(false)
const { t } = useI18n()
const tab = useCollectionViewsStore().stateFor(props.tabId)
const state = tab.aggregation
const dialogs = useDialogStore()
const toasts = useToastStore()
const workspaceDialogs = useWorkspaceDialogs()
const queryClient = useQueryClient()

const preview = usePreview({
  target: () => props.target,
  cards: () => state.cards,
  sample: () => state.sample,
  memory: {
    load: () => state.memory.preview,
    save: (m) => {
      state.memory.preview = m
    },
  },
  held: () => state.handed?.stages ?? null,
  release: () => {
    state.handed = null
  },
})
// Phase 3c §7: the output paths the preview says are hidden get locks and a hint (final review M4).
const masking = provideMaskedPatterns(preview.masked)
const pipeline = computed(() => preview.built.value)
const isWrite = computed(() => isWritePipeline(pipeline.value.values))
const exporting = ref(false)

// ---- $out / $merge (spec §4.5): previewed, confirmed, run once
async function runWrite(): Promise<void> {
  const stages = pipeline.value.stages
  try {
    const p = await aggregateApi.writePreview(props.target, stages)
    const ns = `${p.target.db}.${p.target.coll}`
    const n = p.estimatedCount ?? 0
    const message = !p.exists
      ? t('aggregation.write.create', { ns })
      : p.stage === '$out'
        ? t('aggregation.write.replace', { ns, n })
        : t('aggregation.write.merge', { ns, n })
    const ok = await dialogs.confirm({
      title: t('aggregation.write.title', { stage: p.stage }),
      message,
      confirmLabel: t('aggregation.write.confirm'),
      danger: true,
      ...(p.confirmRequired ? { requireText: p.target.coll } : {}),
    })
    if (!ok) return
    await aggregateApi.write(props.target, stages, p.token, p.confirmRequired ? p.target.coll : undefined)
    toasts.push({ kind: 'success', message: t('aggregation.write.done', { ns }) })
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  }
}

// ---- Saved pipelines (spec §4.6)
const refreshSaved = () => queryClient.invalidateQueries({ queryKey: aggregateKeys.pipelines(props.target) })
/** Phase 2c: Save as asks for a name, tags and sharing. */
const savingAs = ref(false)
const saveAsBusy = ref(false)
const saveAsError = ref('')
function saveAs(): void {
  saveAsError.value = ''
  savingAs.value = true
}
async function onSaveAs(item: { name: string; tags: string[]; shared: boolean }): Promise<void> {
  // One save at a time: a double click never makes two pipelines (final review 2c, Minor 14).
  if (saveAsBusy.value) return
  saveAsBusy.value = true
  saveAsError.value = ''
  try {
    const saved = await aggregateApi.pipelines.create(props.target, {
      name: item.name,
      stages: pipeline.value.stages,
      tags: item.tags,
      shared: item.shared,
      ...(assistantOf(state.steps) ? { assistant: assistantOf(state.steps) } : {}),
    })
    savingAs.value = false
    state.saved = { id: saved.id, name: saved.name, shared: saved.shared, tags: saved.tags }
    toasts.push({ kind: 'success', message: t('aggregation.saved.saved', { name: saved.name }) })
    await refreshSaved()
  } catch (e) {
    saveAsError.value = saveError(e, t)
  } finally {
    saveAsBusy.value = false
  }
}
async function save(): Promise<void> {
  const current = state.saved
  if (!current) {
    saveAs()
    return
  }
  try {
    await aggregateApi.pipelines.update(props.target, current.id, {
      name: current.name,
      stages: pipeline.value.stages,
      tags: current.tags ?? [],
      shared: current.shared,
      // Steps cleared here are cleared in the saved pipeline too (a save without them keeps them).
      assistant: assistantOf(state.steps) ?? { steps: [] },
    })
    toasts.push({ kind: 'success', message: t('aggregation.saved.saved', { name: current.name }) })
    await refreshSaved()
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  }
}

/** What a saved pipeline replaced, for Undo (a few seconds). */
interface Snapshot {
  cards: Card[]
  saved: typeof state.saved
  textMode: boolean
  text: string
  textBase: string
  intent: string | null
  steps: typeof state.steps
  stepAt: number | null
  aiThread: string | null
}
const undoCards = ref<Snapshot | null>(null)
let undoTimer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => clearTimeout(undoTimer))
function openSaved(saved: SavedPipelineView): void {
  const { cards, unreadable } = cardsFromStages(saved.stages)
  if (unreadable > 0) toasts.push({ kind: 'error', message: t('aggregation.saved.unreadable', unreadable) })
  keepForUndo()
  state.cards = cards
  state.textMode = false
  state.saved = saved.mine ? { id: saved.id, name: saved.name, shared: saved.shared, tags: saved.tags } : null
  state.steps = stepsFrom(saved.assistant)
  state.stepAt = null
  state.intent = state.steps.at(-1)?.prompt ?? null
  // A saved pipeline's changes start a chain of their own in the AI history.
  state.aiThread = null
  state.editingView = null
}
function undo(): void {
  const before = undoCards.value
  if (before) {
    state.cards = before.cards
    state.saved = before.saved
    state.textMode = before.textMode
    state.text = before.text
    state.textBase = before.textBase
    state.intent = before.intent
    state.steps = before.steps
    state.stepAt = before.stepAt
    state.aiThread = before.aiThread
  }
  undoCards.value = null
}
/** What the builder holds now, for Undo (a few seconds). */
function keepForUndo(): void {
  undoCards.value = {
    cards: state.cards,
    saved: state.saved,
    textMode: state.textMode,
    text: state.text,
    textBase: state.textBase,
    intent: state.intent,
    steps: state.steps,
    stepAt: state.stepAt,
    aiThread: state.aiThread,
  }
  clearTimeout(undoTimer)
  undoTimer = setTimeout(() => (undoCards.value = null), 10_000)
}
/** UI redesign R1 review: a new, empty pipeline — the one being built can be brought back with Undo. */
function startNew(): void {
  keepForUndo()
  state.cards = []
  state.saved = null
  state.textMode = false
  state.text = ''
  state.textBase = ''
  state.intent = null
  state.steps = []
  state.stepAt = null
  state.askMode = 'change'
  state.aiThread = null
  state.pane = 'pipeline'
  // A new pipeline is no longer the view's being edited.
  state.editingView = null
  textError.value = null
}

// ---- The assistant's answers (UI redesign R1 review): applied at once, Undo brings the last back.
const MAX_STEPS = 8
/** Stages the last answer changed, shown for a moment. */
const changedIds = ref<ReadonlySet<string>>(new Set())
/** Reviewer C Minor 12: the highlight is seen; this says it to a screen reader. */
const announce = ref('')
let changedTimer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => clearTimeout(changedTimer))
function applyAsked(answer: {
  stages: Record<string, unknown>[]
  prompt: string
  reply: string
  change: boolean
  thread: string
}): void {
  const { cards, unreadable } = cardsFromStages(answer.stages)
  if (unreadable > 0) toasts.push({ kind: 'error', message: t('aggregation.saved.unreadable', unreadable) })
  keepForUndo()
  const changes = changesBetween(state.cards, cards)
  const before = new Set(state.cards.map((c) => `${c.operator}\u0000${c.text}`))
  state.cards = cards
  state.textMode = false
  // The stages are now those of the request's chain (the AI history shows it with its first request).
  state.aiThread = answer.thread
  if (!answer.change) state.saved = null
  // A change after going back to an earlier step continues from that step.
  const kept = answer.change ? state.steps.slice(0, (state.stepAt ?? state.steps.length - 1) + 1) : []
  state.steps = [
    ...kept,
    {
      prompt: answer.prompt,
      reply: answer.reply,
      changes,
      cards: markRaw(cards.map((c) => ({ ...c }))),
    },
  ].slice(-MAX_STEPS)
  state.stepAt = null
  state.intent = answer.prompt
  state.pane = 'pipeline'
  changedIds.value = new Set(
    cards.filter((c) => !before.has(`${c.operator}\u0000${c.text}`)).map((c) => c.id),
  )
  clearTimeout(changedTimer)
  changedTimer = setTimeout(() => (changedIds.value = new Set()), 4000)
  announce.value = t('aggregation.ask.announce', changes.length)
}
/** Back to the stages of an earlier step (Undo returns to where the builder was). */
function restoreStep(index: number): void {
  const step = state.steps[index]
  if (!step) return
  keepForUndo()
  state.cards = step.cards.map((c) => ({ ...newCard(c.operator), text: c.text, enabled: c.enabled }))
  state.textMode = false
  state.stepAt = index === state.steps.length - 1 ? null : index
  state.intent = step.prompt
}
/** A deleted pipeline is no longer what these stages are saved as (Save would write to nothing). */
function onRemoved(id: string): void {
  if (state.saved?.id === id) state.saved = null
  // Reviewer C Minor 8: nor what Undo would bring back as such.
  if (undoCards.value?.saved?.id === id) undoCards.value = { ...undoCards.value, saved: null }
}
/** Reviewer C I3: a rename or share made in the menu is what the next Save keeps. */
function onUpdated(view: SavedPipelineView): void {
  const kept = { id: view.id, name: view.name, shared: view.shared, tags: view.tags }
  if (state.saved?.id === view.id) state.saved = kept
  if (undoCards.value?.saved?.id === view.id) undoCards.value = { ...undoCards.value, saved: kept }
}

// ---- "Why is it slow?" (phase 2b): Explain opens on this pipeline and runs it.
function whySlow(): void {
  tab.explain.source = 'aggregation'
  tab.explain.request++
  tab.section = 'explain'
}

// ---- W2.2 (2026-10-16): these stages written back to the view they were opened from
const updatingView = ref(false)
const disabledCards = computed(() => state.cards.filter((c) => !c.enabled).length)
async function updateView(): Promise<void> {
  const view = state.editingView
  if (!view || updatingView.value || pipeline.value.error || state.textMode) return
  if (isWrite.value) {
    toasts.push({ kind: 'error', message: t('aggregation.viewEdit.writes') })
    return
  }
  const ok = await dialogs.confirm({
    title: t('aggregation.viewEdit.confirmTitle', { view: view.name }),
    message: [
      t('aggregation.viewEdit.confirmMessage', {
        view: view.name,
        source: props.target.coll,
        n: pipeline.value.stages.length,
      }),
      ...(disabledCards.value ? [t('aggregation.viewEdit.disabledLeftOut', disabledCards.value)] : []),
    ].join(' '),
    confirmLabel: t('aggregation.viewEdit.update'),
  })
  if (!ok) return
  updatingView.value = true
  try {
    await connectionsApi.updateView(props.target.connectionId, props.target.db, view.name, {
      viewOn: props.target.coll,
      pipeline: pipeline.value.stages,
      confirm: view.name,
      base: view.base as { viewOn: string; pipeline: Record<string, unknown>[] },
    })
    // The view's definition and whatever was read through it are stale now.
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections(props.target.connectionId, props.target.db),
        exact: true,
      }),
      queryClient.invalidateQueries({
        queryKey: [...queryKeys.collections(props.target.connectionId, props.target.db), view.name],
      }),
    ])
    state.editingView = null
    toasts.push({ kind: 'success', message: t('aggregation.viewEdit.done', { view: view.name }) })
  } catch (e) {
    if (e instanceof ApiError && (e.details as { reason?: unknown } | undefined)?.reason === 'view_changed')
      await viewChanged(view.name)
    else toasts.push({ kind: 'error', message: describeError(e, t) })
  } finally {
    updatingView.value = false
  }
}
/**
 * W2 review (I1): the view was changed since this edit began. Nothing was written; asked, the
 * definition there is now replaces these stages (and is what the next Update view starts from).
 */
async function viewChanged(name: string): Promise<void> {
  const reload = await dialogs.confirm({
    title: t('aggregation.viewEdit.changedTitle'),
    message: t('aggregation.viewEdit.changed', { view: name }),
    confirmLabel: t('aggregation.viewEdit.reload'),
  })
  if (!reload) return
  try {
    // As stored (re-review minor 3): its types kept, as the server compares them.
    const now = await connectionsApi
      .viewDefinition(props.target.connectionId, props.target.db, name)
      .catch((e: unknown) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e)))
    const viewOn = now?.viewOn
    const stages = now?.pipeline ?? []
    if (typeof viewOn !== 'string') {
      state.editingView = null
      toasts.push({ kind: 'error', message: t('aggregation.viewEdit.gone', { view: name }) })
      return
    }
    const { cards, unreadable } = cardsFromStages(stages)
    if (unreadable > 0) {
      toasts.push({ kind: 'error', message: t('aggregation.viewEdit.unreadable', { view: name }) })
      return
    }
    keepForUndo()
    state.cards = cards
    state.textMode = false
    state.editingView = { name, base: { viewOn, pipeline: stages } }
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  }
}

// ---- A view from the pipeline (spec §4.6)
function createView(): void {
  const text = toText(state.cards)
  workspaceDialogs.open({
    kind: 'createCollection',
    connectionId: props.target.connectionId,
    db: props.target.db,
    view: { viewOn: props.target.coll, pipeline: 'text' in text ? text.text : '[]' },
  })
}

const MIN_SAMPLE = 1
const MAX_SAMPLE = 100_000
// UI redesign R1 review: the pipeline and its results are two views of the tab; Run shows the results.
const paneId = useId()
const runner = ref<{ run(): Promise<void>; stop(): void; state: string; count: number } | null>(null)
const running = computed(() => runner.value?.state === 'running')
const paneTabs = computed(() => [
  { value: 'pipeline' as const, label: t('aggregation.pipelineTab'), count: state.cards.length },
  {
    value: 'results' as const,
    label: t('aggregation.resultsTab'),
    ...(runner.value && runner.value.state !== 'idle' ? { count: runner.value.count } : {}),
  },
])
function runPipeline(): void {
  state.pane = 'results'
  void runner.value?.run()
}
// A pipeline handed over to run (the chat's Run) runs once here — never one that writes, nor one
// changed since it was handed over.
watch(
  () => state.runOnArrival,
  async (asked) => {
    if (asked === null) return
    state.runOnArrival = null
    await nextTick()
    if (asked !== cardsKey(state.cards) || state.textMode) return
    if (isWrite.value || pipeline.value.error || !pipeline.value.stages.length) return
    runPipeline()
  },
  { immediate: true },
)
/** What can be done with the pipeline's output, beside Run (or the write button). */
const outputActions = computed(() => {
  const blocked = !!pipeline.value.error || state.textMode
  return [
    {
      id: 'slow',
      label: t('explain.whySlow'),
      icon: Gauge,
      disabled: blocked || isWrite.value,
      run: whySlow,
    },
    {
      id: 'code',
      label: t('aggregation.export.open'),
      icon: FileCode2,
      disabled: blocked,
      run: () => (exporting.value = true),
    },
    ...(props.canExport
      ? [
          {
            id: 'data',
            label: t('dataTransfer.exportResults'),
            icon: Download,
            disabled: blocked || isWrite.value || pipeline.value.stages.length === 0,
            run: () => (exportingData.value = true),
          },
          // A copy reads like an export (data:export on the source); the wizard asks the target's rights.
          {
            id: 'copy',
            label: t('dataTransfer.copy.fromPipeline'),
            icon: CopyPlus,
            disabled: blocked || isWrite.value || pipeline.value.stages.length === 0,
            run: () => (copyingData.value = true),
          },
        ]
      : []),
    ...(props.canWrite && !isWrite.value
      ? [{ id: 'view', label: t('aggregation.createView'), icon: Eye, disabled: blocked, run: createView }]
      : []),
  ]
})
/** UI redesign R1 review: the stages most pipelines start with, one click each. */
const QUICK_STAGES = ['$match', '$lookup', '$group', '$project', '$sort', '$limit'] as const
const tool =
  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-ui text-fg-muted transition-colors duration-120 hover:bg-subtle hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent'
const control =
  'h-8 cursor-pointer rounded-lg border border-line-strong bg-surface px-2.5 text-ui text-fg shadow-xs transition-[border-color,box-shadow] duration-120 hover:border-fg-subtle/60 focus:border-focus focus:ring-3 focus:ring-focus/20 focus-visible:outline-none'

// ---- Cards
const indexOf = (id: string) => state.cards.findIndex((c) => c.id === id)

function add(operator: string): void {
  state.cards.push(newCard(operator))
}
function patch(id: string, changes: Partial<Card>): void {
  const card = state.cards[indexOf(id)]
  if (!card) return
  // A new operator on an untouched template starts from that operator's template.
  if (changes.operator && changes.operator !== card.operator && card.text === newCard(card.operator).text)
    changes = { ...changes, text: newCard(changes.operator).text }
  Object.assign(card, changes)
}
function move(id: string, delta: number): void {
  const from = indexOf(id)
  const to = from + delta
  if (from < 0 || to < 0 || to >= state.cards.length) return
  const [card] = state.cards.splice(from, 1)
  state.cards.splice(to, 0, card!)
}
function duplicate(id: string): void {
  const i = indexOf(id)
  const card = state.cards[i]
  if (card)
    state.cards.splice(i + 1, 0, { ...newCard(card.operator), text: card.text, enabled: card.enabled })
}
function remove(id: string): void {
  const i = indexOf(id)
  if (i >= 0) state.cards.splice(i, 1)
}

// ---- Drag and drop (native HTML5; buttons and Alt+arrows do the same from the keyboard)
const dragging = ref<string | null>(null)
function onDragStart(id: string, event: DragEvent): void {
  dragging.value = id
  try {
    event.dataTransfer?.setData('text/plain', id)
  } catch {
    // Some environments refuse data on synthetic events; the id is kept here.
  }
}
function onDrop(id: string): void {
  const from = dragging.value ? indexOf(dragging.value) : -1
  dragging.value = null
  const to = indexOf(id)
  if (from < 0 || to < 0 || from === to) return
  const [card] = state.cards.splice(from, 1)
  state.cards.splice(to, 0, card!)
}

// ---- Text mode (spec §4.3)
const textError = ref<string | null>(null)
const formatError = (e: { message: string; line?: number; column?: number }) =>
  e.line !== undefined
    ? t('aggregation.parseError', { message: e.message, line: e.line, column: e.column })
    : e.message
function toggleText(): void {
  if (!state.textMode) {
    const result = toText(state.cards)
    if ('error' in result) {
      textError.value = formatError(result.error)
      return
    }
    state.text = result.text
    state.textBase = result.text
    state.textMode = true
    textError.value = null
    return
  }
  if (state.text === state.textBase) {
    state.textMode = false
    textError.value = null
    return
  }
  const result = fromText(state.text, state.cards)
  if ('error' in result) {
    textError.value = formatError(result.error)
    return
  }
  state.cards = result.cards
  state.textMode = false
  textError.value = null
}

// ---- Sample (spec §4.4)
function setSampleMode(mode: string): void {
  state.sample = { ...state.sample, mode: mode as 'limit' | 'sample' }
}
function setSampleSize(event: Event): void {
  const n = Math.round(Number((event.target as HTMLInputElement).value))
  if (!Number.isFinite(n)) return
  state.sample = { ...state.sample, size: Math.min(MAX_SAMPLE, Math.max(MIN_SAMPLE, n)) }
}

// ---- Previews
const results = computed(() => preview.results.value)
/** The documents a stage receives: the previous enabled stage's preview, or the sample. */
function inputOf(id: string): DocumentItem[] {
  const map = preview.built.value.map
  const at = map.indexOf(id)
  const before = at > 0 ? results.value[map[at - 1]!] : undefined
  if (before && 'documents' in before) return before.documents as DocumentItem[]
  return at <= 0 ? (preview.sample.value?.documents ?? []) : []
}
const completionsFor = (id: string) => stageCompletions(fieldPaths(toRows(inputOf(id), 0)))
const failure = computed(() => (preview.failure.value ? describeError(preview.failure.value, t) : null))
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex shrink-0 flex-col gap-2 px-4 pt-3 pb-2">
      <PipelineAsk
        :target="target"
        :tab-id="tabId"
        :has-stages="state.cards.length > 0"
        @apply="applyAsked"
        @restore="restoreStep"
      />
      <p data-assistant-status role="status" class="sr-only">{{ announce }}</p>
      <p
        v-if="masking.hidden.value"
        data-masked-banner
        class="flex items-center gap-1.5 text-small text-fg-subtle"
      >
        <Lock class="size-3.5" aria-hidden="true" />{{ t('masking.banner') }}
      </p>
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-ui">
        <StagePicker v-if="!state.textMode" @pick="add" />
        <button
          type="button"
          :class="[tool, state.textMode ? 'bg-subtle text-fg' : '']"
          :aria-pressed="state.textMode"
          @click="toggleText"
        >
          <Code2 class="size-4" aria-hidden="true" />{{ t('aggregation.text') }}
        </button>
        <span class="mx-1 h-5 w-px bg-line" aria-hidden="true" />
        <span class="text-small text-fg-subtle">{{ t('aggregation.input') }}</span>
        <DsSelect
          :model-value="state.sample.mode"
          size="sm"
          hide-label
          :label="t('aggregation.sample')"
          :options="[
            { value: 'limit', label: t('aggregation.sampleFirst') },
            { value: 'sample', label: t('aggregation.sampleRandom') },
          ]"
          @update:model-value="setSampleMode"
        />
        <input
          type="number"
          :value="state.sample.size"
          :min="MIN_SAMPLE"
          :max="MAX_SAMPLE"
          :aria-label="t('aggregation.sampleSize')"
          :class="[control, 'w-24 tabular-nums']"
          @change="setSampleSize"
        />
        <span class="ml-1 text-small text-fg-subtle">{{ t('aggregation.previewAs') }}</span>
        <DsSelect
          v-model="state.previewMode"
          size="sm"
          hide-label
          :label="t('aggregation.previewAs')"
          :options="[
            { value: 'json', label: t('aggregation.json') },
            { value: 'tree', label: t('aggregation.tree') },
          ]"
        />
        <div class="ml-auto flex flex-wrap items-center gap-1.5">
          <span v-if="state.saved" class="flex items-center gap-1 text-small text-fg-muted">
            <Bookmark class="size-3.5" aria-hidden="true" />{{ state.saved.name }}
          </span>
          <button v-if="undoCards" type="button" :class="[tool, 'text-accent-fg']" @click="undo">
            <Undo2 class="size-4" aria-hidden="true" />{{ t('aggregation.saved.undo') }}
          </button>
          <button type="button" :class="tool" :title="t('aggregation.newHint')" @click="startNew">
            <FilePlus2 class="size-4" aria-hidden="true" />{{ t('aggregation.new') }}
          </button>
          <SavedPipelinesMenu :target="target" @open="openSaved" @removed="onRemoved" @updated="onUpdated" />
          <button type="button" :class="tool" :disabled="!!pipeline.error || state.textMode" @click="save">
            <Save class="size-4" aria-hidden="true" />{{ t('aggregation.saved.save') }}
          </button>
          <button type="button" :class="tool" :disabled="!!pipeline.error || state.textMode" @click="saveAs">
            {{ t('aggregation.saved.saveAs') }}
          </button>
        </div>
      </div>
    </div>
    <DsCallout v-if="textError" tone="danger" class="mx-4 mb-2">{{ textError }}</DsCallout>
    <div
      v-if="state.editingView"
      data-editing-view
      role="region"
      :aria-label="t('aggregation.viewEdit.region')"
      class="mx-4 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-accent/30 bg-accent-soft px-3 py-2 text-ui text-fg"
    >
      <Eye class="size-4 shrink-0 text-accent-fg" aria-hidden="true" />
      <span class="min-w-0 flex-1">{{
        t('aggregation.viewEdit.banner', { view: state.editingView.name, source: target.coll })
      }}</span>
      <DsButton
        v-if="canWriteDatabase"
        size="sm"
        variant="primary"
        :loading="updatingView"
        :disabled="!!pipeline.error || state.textMode || isWrite"
        @click="updateView"
      >
        {{ t('aggregation.viewEdit.update') }}
      </DsButton>
      <span v-else class="text-small text-fg-subtle">{{ t('aggregation.viewEdit.notAllowed') }}</span>
      <DsButton size="sm" variant="ghost" @click="state.editingView = null">
        {{ t('aggregation.viewEdit.stop') }}
      </DsButton>
    </div>
    <div
      v-if="state.handed"
      data-handed
      class="mx-4 mb-2 flex flex-wrap items-center gap-2 rounded-lg bg-warning-soft px-3 py-2 text-ui text-fg"
    >
      <span class="min-w-0 flex-1">{{ t('aggregation.handed', { plugin: state.handed.by }) }}</span>
      <button type="button" :class="tool" @click="state.handed = null">
        {{ t('aggregation.handedPreview') }}
      </button>
    </div>
    <DsCallout v-if="failure" tone="danger" class="mx-4 mb-2">{{ failure }}</DsCallout>
    <div class="flex shrink-0 flex-wrap items-center gap-x-2 border-t border-line px-4">
      <DsTabs
        v-model="state.pane"
        class="-mb-px"
        :label="t('aggregation.tabs')"
        :tabs="paneTabs"
        :id-prefix="paneId"
        :panel-id="`${paneId}-panel`"
      />
      <div class="ml-auto flex flex-wrap items-center gap-0.5 py-1.5">
        <button
          v-for="action in outputActions"
          :key="action.id"
          type="button"
          :class="tool"
          :disabled="action.disabled"
          @click="action.run"
        >
          <component :is="action.icon" class="size-4" aria-hidden="true" />{{ action.label }}
        </button>
        <template v-if="isWrite">
          <button
            v-if="canWrite"
            type="button"
            class="ml-1 inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-danger px-3 text-ui font-medium text-on-danger hover:opacity-90 disabled:opacity-50"
            :disabled="!!pipeline.error || state.textMode"
            @click="runWrite"
          >
            {{ t('aggregation.write.run') }}
          </button>
          <p v-else class="ml-1 text-small text-fg-subtle">{{ t('aggregation.write.notAllowed') }}</p>
        </template>
        <button
          v-else-if="running"
          type="button"
          class="ml-1 inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-danger/30 px-3 text-ui font-medium text-danger hover:bg-danger-soft"
          @click="runner?.stop()"
        >
          <Square class="size-3.5" aria-hidden="true" />{{ t('aggregation.run.stop') }}
        </button>
        <button
          v-else
          type="button"
          class="ml-1 inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-accent px-3.5 text-ui font-medium text-on-accent shadow-xs transition-colors duration-120 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="!!pipeline.error || pipeline.stages.length === 0 || state.textMode"
          @click="runPipeline"
        >
          <Play class="size-4" aria-hidden="true" />{{ t('aggregation.run.run') }}
        </button>
      </div>
    </div>
    <div
      :id="`${paneId}-panel`"
      role="tabpanel"
      :aria-labelledby="`${paneId}-${state.pane}`"
      class="flex min-h-0 flex-1 flex-col border-t border-line"
    >
      <div v-show="state.pane === 'pipeline'" class="min-h-0 flex-1 overflow-auto bg-canvas px-4 py-4">
        <DsCodeEditor
          v-if="state.textMode"
          v-model="state.text"
          :label="t('aggregation.pipeline')"
          multiline
          :rows="16"
        />
        <ol v-else class="flex flex-col" :aria-label="t('aggregation.pipeline')">
          <li class="flex items-center gap-2 pb-2">
            <span
              class="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-fg-muted"
              aria-hidden="true"
            >
              <Database class="size-3.5" />
            </span>
            <p data-preview-input class="text-small text-fg-muted">
              <span class="font-medium text-fg">{{ t('aggregation.input') }}:</span>
              <!-- User report 2026-11-07: the first documents only are drawn; "20+" when there are more. -->
              {{
                preview.sample.value
                  ? preview.sample.value.truncated || preview.sample.value.more
                    ? t('aggregation.documentsMore', { n: preview.sample.value.count })
                    : t('aggregation.documents', preview.sample.value.count)
                  : '…'
              }}
              <span class="text-fg-subtle">
                ·
                {{
                  state.sample.mode === 'limit' ? t('aggregation.sampleFirst') : t('aggregation.sampleRandom')
                }}
                ({{ state.sample.size }})</span
              >
            </p>
          </li>
          <li v-if="state.cards.length === 0" class="ml-3.5 border-l-2 border-dashed border-line-strong pl-6">
            <div
              class="flex flex-col items-start gap-3 rounded-xl border border-dashed border-line-strong bg-surface p-5"
            >
              <div class="flex items-center gap-2 text-fg">
                <Workflow class="size-5 text-accent-fg" aria-hidden="true" />
                <p class="font-medium">{{ t('aggregation.emptyTitle') }}</p>
              </div>
              <p class="max-w-prose text-ui text-fg-muted">{{ t('aggregation.start') }}</p>
              <div class="flex flex-wrap gap-1.5">
                <button
                  v-for="op in QUICK_STAGES"
                  :key="op"
                  type="button"
                  class="cursor-pointer rounded-full border border-line-strong bg-surface px-3 py-1 font-mono text-small text-fg transition-colors duration-120 hover:border-accent/50 hover:bg-accent-soft hover:text-accent-fg"
                  :aria-label="t('aggregation.addQuick', { operator: op })"
                  @click="add(op)"
                >
                  {{ op }}
                </button>
              </div>
            </div>
          </li>
          <li
            v-for="(card, i) in state.cards"
            :key="card.id"
            class="relative ml-3.5 border-l-2 pb-3 pl-6"
            :class="card.enabled ? 'border-accent/35' : 'border-dashed border-line-strong'"
          >
            <span
              class="absolute top-3 -left-[13px] grid size-6 place-items-center rounded-full text-caption font-semibold ring-4 ring-canvas"
              :class="card.enabled ? 'bg-accent text-on-accent' : 'bg-muted text-fg-subtle'"
              aria-hidden="true"
              >{{ i + 1 }}</span
            >
            <StageCard
              :card="card"
              :index="i"
              :total="state.cards.length"
              :result="results[card.id] ?? null"
              :loading="preview.pending.value.has(card.id)"
              :preview-mode="state.previewMode"
              :highlight="changedIds.has(card.id)"
              :completions="completionsFor(card.id)"
              @patch="patch(card.id, $event)"
              @move="move(card.id, $event)"
              @duplicate="duplicate(card.id)"
              @remove="remove(card.id)"
              @dragstart="onDragStart(card.id, $event)"
              @dragover.prevent
              @drop.prevent="onDrop(card.id)"
            />
          </li>
          <li
            v-if="state.cards.length"
            class="ml-3.5 flex flex-wrap items-center gap-1.5 border-l-2 border-dashed border-line-strong pb-1 pl-6"
          >
            <span class="text-small text-fg-subtle">{{ t('aggregation.next') }}</span>
            <button
              v-for="op in QUICK_STAGES"
              :key="op"
              type="button"
              class="cursor-pointer rounded-full border border-line px-2.5 py-0.5 font-mono text-small text-fg-muted transition-colors duration-120 hover:border-accent/50 hover:bg-accent-soft hover:text-accent-fg"
              :aria-label="t('aggregation.addQuick', { operator: op })"
              @click="add(op)"
            >
              {{ op }}
            </button>
          </li>
        </ol>
      </div>
      <div v-show="state.pane === 'results'" class="flex min-h-0 flex-1 flex-col bg-surface">
        <RunResults
          v-if="!isWrite"
          ref="runner"
          :tab-id="tabId"
          :target="target"
          :stages="pipeline.stages"
          :disabled="!!pipeline.error || pipeline.stages.length === 0 || state.textMode"
          :mode="state.previewMode"
        />
        <p v-else class="p-6 text-ui text-fg-muted">{{ t('aggregation.skippedWrite') }}</p>
      </div>
      <SaveItemDialog
        v-if="savingAs"
        :title="t('aggregation.saved.saveTitle')"
        :message="t('aggregation.saved.saveMessage')"
        :name="state.saved?.name ?? ''"
        :tags="state.saved?.tags ?? []"
        :busy="saveAsBusy"
        :error="saveAsError"
        @save="onSaveAs"
        @close="savingAs = false"
      />
      <ExportDataDialog
        v-if="exportingData"
        :connection-id="target.connectionId"
        :db="target.db"
        :coll="target.coll"
        :stages="pipeline.stages"
        @close="exportingData = false"
      />
      <CopyWizard
        v-if="copyingData"
        :connection-id="target.connectionId"
        :db="target.db"
        :coll="target.coll"
        :stages="pipeline.stages"
        @close="copyingData = false"
      />
      <ExportDialog
        v-if="exporting"
        :db="target.db"
        :coll="target.coll"
        :stages="pipeline.values"
        @close="exporting = false"
      />
    </div>
  </div>
</template>
