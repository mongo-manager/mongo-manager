<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import {
  Braces,
  ListFilter,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Star,
  Workflow,
} from 'lucide-vue-next'
import DsCodeEditor from '@/ds/DsCodeEditor.vue'
import DsInput from '@/ds/DsInput.vue'
import DsSelect from '@/ds/DsSelect.vue'
import DsButton from '@/ds/DsButton.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import DsSpinner from '@/ds/DsSpinner.vue'
import type { Completion } from '@/ds/code/completion'
import type { CollectionTarget, RecentQuery } from '@/api/documents'
import { connectionsApi, queryKeys } from '@/api/connections'
import RecentQueries from './RecentQueries.vue'
import FilterBuilder from './FilterBuilder.vue'
import type { ValueType } from './filterModel'
import SaveItemDialog from '@/library/SaveItemDialog.vue'
import { useFavouriteSave } from './favourite'
import { useCollectionViewsStore } from '@/stores/collectionViews'
import { aiOffered, useAiRequest, useAiStatus } from '@/ai/useAi'
import { useAiWords } from '@/ai/words'
import { currentFor, insertResult } from '@/ai/insert'
import { findParts } from '@/library/openItem'
import { uiLanguageOf } from '@mongo-manager/shared/browser'
import {
  MAX_TIME_MS,
  PAGE_SIZES,
  buildQuery,
  emptyDraft,
  type FindQuery,
  type QueryDraft,
  type QueryField,
} from './queryBuild'

/**
 * UI redesign R1 revision 2 §4.2: the query composer. Query mode is the MQL filter with its options;
 * Ask mode turns words into a query in the same bar (the assistant writes, the user reviews and runs).
 */
const props = withDefaults(
  defineProps<{
    completions: readonly Completion[]
    target?: CollectionTarget
    /** The collection tab: Ask writes into its draft. Without it, Ask is not offered. */
    tabId?: string
    /** Field paths seen in the results (for the Ask examples). */
    fields?: readonly string[]
    /** The values seen for a field, offered where its value is written in the filter. */
    values?: (path: string) => readonly string[]
    /** The kind of value a field holds (the filter builder types its conditions by it). */
    types?: (path: string) => ValueType | undefined
  }>(),
  { target: undefined, tabId: undefined, fields: () => [], values: undefined, types: undefined },
)
const emit = defineEmits<{ apply: [query: FindQuery] }>()
const draft = defineModel<QueryDraft>({ required: true })
const { t, locale } = useI18n()

const FILTER_EXAMPLE = '{ status: "paid" }'
const d = draft.value
// User request 2026-11-02: the sort the tab opened with (newest first) opens no Options by itself.
const openingSort = props.tabId ? useCollectionViewsStore().stateFor(props.tabId).openingSort : null
const sortWritten = (sort: string) => sort.trim() !== '' && sort !== openingSort
const showOptions = ref(
  Boolean(d.projection || sortWritten(d.sort) || d.skip || d.collation || d.hint || d.maxTimeMS),
)
const errors = ref<Partial<Record<QueryField, string>>>({})
/** UI redesign R1 review: the filter as conditions, beside the text (both edit the same filter). */
const showBuilder = ref(false)
// W5: a page size opened from a shell query (its limit, say 7) is offered beside the usual ones.
const limits = computed(() =>
  [...new Set<number>([...PAGE_SIZES, draft.value.limit])]
    .sort((a, b) => a - b)
    .map((n) => ({ value: String(n), label: String(n) })),
)
const limit = computed({
  get: () => String(draft.value.limit),
  set: (value: string) => {
    draft.value.limit = Number(value)
  },
})
/** The options in use, counted on the Options button (the page size is always set). */
const optionsSet = computed(
  () =>
    (['projection', 'sort', 'skip', 'collation', 'hint', 'maxTimeMS'] as const).filter(
      (k) => draft.value[k].trim() !== '',
    ).length,
)

// ---- Phase 2c: the query as a favourite (its filter parts; skip and limit are page settings)
// Skip and the time limit are not saved, so they need not parse (final review 2c, Minor 20).
const built = computed(() => buildQuery({ ...draft.value, skip: '', maxTimeMS: '' }))
const favourite = useFavouriteSave(() => props.target)
/** A query with parameters may be saved before they have values: those have no default. */
const savable = computed(() => built.value.ok || built.value.field === 'params')
function startFavourite(): void {
  const result = built.value
  const kept = (names: string[]) =>
    Object.fromEntries(
      names.flatMap((n) => (Object.hasOwn(draft.value.params ?? {}, n) ? [[n, paramValue(n)]] : [])),
    )
  if (result.ok) favourite.start(result.template ?? result.query, kept(result.params))
  else if (result.field === 'params') favourite.start(result.template, kept(result.params))
}

// ---- Query parameters (spec 2026-10-28): a field for each {{name}} the parts hold
const paramErrors = ref<Record<string, string>>({})
/** The names last read: a part being typed (not parsing for now) keeps the fields it had. */
const paramNames = ref<string[]>([])
watch(
  built,
  (result) => {
    if (result.ok || result.field === 'params') paramNames.value = result.params
  },
  { immediate: true },
)
/** A query put in from elsewhere (a favourite) that waits for a value: its first empty field. */
function focusMissingParam(next: QueryDraft): void {
  const result = buildQuery({ ...next, skip: '', maxTimeMS: '' })
  if (result.ok || result.field !== 'params') return
  const name = result.params.find((n) => !own(next.params, n).trim())
  if (name === undefined) return
  void nextTick(() =>
    root.value?.querySelector<HTMLInputElement>(`[data-query-param="${CSS.escape(name)}"] input`)?.focus(),
  )
}
const paramLabel = (name: string) => `{{${name}}}`
/**
 * A parameter's value and error, by the objects' own keys only (final review I1): a parameter named
 * constructor or __proto__ is one like any other.
 */
const own = (record: Record<string, string> | undefined, name: string): string =>
  record && Object.hasOwn(record, name) && typeof record[name] === 'string' ? record[name] : ''
const paramValue = (name: string) => own(draft.value.params, name)
const paramError = (name: string) => own(paramErrors.value, name)
function setParam(name: string, value: string): void {
  draft.value.params = { ...(draft.value.params ?? {}), [name]: value }
  if (paramError(name)) paramErrors.value = { ...paramErrors.value, [name]: '' }
}

function run(current: QueryDraft = draft.value): void {
  const result = buildQuery(current)
  paramErrors.value = {}
  if (!result.ok && result.field === 'params') {
    errors.value = {}
    paramErrors.value = Object.fromEntries(
      Object.entries(result.errors).map(([name, error]) => [
        name,
        error === 'invalid'
          ? t('query.params.invalid', { name: paramLabel(name), message: result.messages[name] ?? '' })
          : t(error === 'too_large' ? 'query.params.tooLarge' : 'query.params.required', {
              name: paramLabel(name),
            }),
      ]),
    )
    return
  }
  if (!result.ok) {
    errors.value = {
      [result.field]:
        result.field === 'skip'
          ? t('query.invalidSkip')
          : result.field === 'maxTimeMS'
            ? t('query.invalidMaxTime', MAX_TIME_MS)
            : result.field === 'hint' && result.line === undefined
              ? t('query.invalidHint')
              : t('query.syntaxError', {
                  line: result.line ?? 1,
                  column: result.column ?? 1,
                  message: result.message,
                }),
    }
    if (result.field !== 'filter') showOptions.value = true
    return
  }
  errors.value = {}
  emit('apply', result.query)
}

// A draft put in from elsewhere (the Library) shows its options (final review 2c, Minor 17).
watch(
  () => draft.value,
  (next, before) => {
    if (next !== before && (next.projection || next.sort || next.collation || next.hint))
      showOptions.value = true
    if (next !== before) focusMissingParam(next)
  },
)

/**
 * A recent query or a favourite goes back into the bar as text, and runs — a favourite with
 * parameters with its defaults, or waiting for a value where one has none (final review I5).
 */
function useRecent(q: RecentQuery): void {
  let parts: ReturnType<typeof findParts>
  try {
    parts = findParts(q, draft.value.limit)
  } catch {
    return
  }
  const next: QueryDraft = { ...parts.draft, limit: draft.value.limit }
  draft.value = next
  if (next.projection || sortWritten(next.sort) || next.collation || next.hint) showOptions.value = true
  // One waiting for a value is focused by the draft's watch.
  if (parts.query !== null) run(next)
}

function reset(): void {
  // The model updates through the parent on the next render: run the new draft directly.
  // User request 2026-11-02: back to how the tab opened — newest first, when it opened so.
  const next = { ...emptyDraft(), sort: viewState?.openingSort ?? '', limit: draft.value.limit }
  draft.value = next
  errors.value = {}
  run(next)
}

// ---- Ask: words to a query (phase 4a-1's request, written into this tab's draft)
// Ask writes into a collection tab's draft: without one, nothing is asked of the server.
const askable = computed(() => !!props.target && !!props.tabId)
const status = useAiStatus(askable)
const { data: connections } = useQuery({
  queryKey: queryKeys.connections,
  queryFn: connectionsApi.list,
  enabled: askable,
})
const connection = computed(() => connections.value?.find((c) => c.id === props.target?.connectionId))
const askOffered = computed(() => askable.value && aiOffered(status.data.value, connection.value))
// Spec 4a-1 §2.4: a local-only connection uses the providers last found local (or not yet tried).
const provider = computed(() => {
  const list = (status.data.value?.providers ?? []).filter(
    (p) => connection.value?.aiPolicy !== 'local' || p.local !== false,
  )
  return list.find((p) => p.isDefault) ?? list[0]
})
// The mode and the words in Ask stay with the tab (a look at another section keeps them).
const viewState = props.tabId ? useCollectionViewsStore().stateFor(props.tabId) : null
const localAsk = ref<{ mode: 'query' | 'ask'; text: string }>({ mode: 'query', text: '' })
const askState = computed(() => viewState?.ask ?? localAsk.value)
const mode = computed({
  get: () => askState.value.mode,
  set: (next: 'query' | 'ask') => {
    askState.value.mode = next
  },
})
watch(askOffered, (offered) => {
  if (!offered) mode.value = 'query'
})
const modes = computed(() => [
  { value: 'query' as const, label: t('query.modes.query'), icon: Braces },
  { value: 'ask' as const, label: t('query.modes.ask'), icon: Sparkles },
])
const words = useAiWords()
const { run: askRun, send, stop } = useAiRequest()
const prompt = computed({
  get: () => askState.value.text,
  set: (text: string) => {
    askState.value.text = text
  },
})
const askId = useId()
const askField = ref<HTMLTextAreaElement | null>(null)
const generating = computed(() => askRun.state === 'sending' || askRun.state === 'streaming')
const askProblem = ref('')
/** UI redesign R1 review: words a find cannot answer, offered to Aggregations as they are. */
const needsPipeline = ref<string | null>(null)
function toPipeline(): void {
  if (!props.tabId || !needsPipeline.value) return
  const state_ = useCollectionViewsStore().stateFor(props.tabId)
  state_.aggregation.pendingAsk = needsPipeline.value
  state_.section = 'aggregations'
  needsPipeline.value = null
}
const canGenerate = computed(() => !!provider.value && !generating.value && prompt.value.trim() !== '')
const examples = computed(() => {
  const field = props.fields.find((f) => f !== '_id' && !f.includes('.'))
  return [t('query.ask.examples.newest'), ...(field ? [t('query.ask.examples.missing', { field })] : [])]
})

function generate(): void {
  if (!canGenerate.value || !props.target || !props.tabId) return
  askProblem.value = ''
  needsPipeline.value = null
  const current = currentFor(props.tabId, 'query')
  void send(props.target, {
    action: 'query',
    prompt: prompt.value.trim(),
    language: uiLanguageOf(locale.value),
    provider: provider.value!.id,
    ...(current ? { current } : {}),
  })
}
watch(
  () => askRun.state,
  async (state) => {
    if (state === 'error' && askRun.error)
      askProblem.value = words.reason(askRun.error.reason, askRun.error.retryAfterMs)
    if (state !== 'done' || !props.tabId) return
    const result = askRun.done?.result
    if (askRun.done?.reason === 'needs_pipeline') {
      needsPipeline.value = prompt.value.trim()
      return
    }
    if (!result || result.kind !== 'query') {
      const reason = askRun.done?.reason
      askProblem.value =
        reason === 'wrong_shape'
          ? t('ai.parse.wrong_shape', { kind: words.action('query') })
          : reason
            ? words.parse(reason)
            : t('query.ask.noQuery')
      return
    }
    const words_ = prompt.value.trim()
    if (!(await insertResult(props.tabId, result, t))) return
    const state_ = useCollectionViewsStore().stateFor(props.tabId)
    state_.intent = {
      prompt: words_,
      filter: state_.draft.filter,
      projection: state_.draft.projection,
      sort: state_.draft.sort,
    }
    if (state_.draft.projection || sortWritten(state_.draft.sort)) showOptions.value = true
    errors.value = {}
    mode.value = 'query'
    prompt.value = ''
  },
)
function onAskKey(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    generate()
  }
}

// ---- "/" puts the caret in the bar, unless something else is being typed in or a dialog is open.
const root = ref<HTMLFormElement | null>(null)
const filterInput = ref<InstanceType<typeof DsCodeEditor> | null>(null)
function focusBar(): void {
  if (mode.value === 'ask') askField.value?.focus()
  else filterInput.value?.focus()
}
function onSlash(event: KeyboardEvent): void {
  if (event.key !== '/' || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
  const el = event.target as HTMLElement | null
  if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return
  if (document.querySelector('[aria-modal="true"]') || !root.value?.isConnected) return
  // W6.1: with two tabs side by side, only the bar of the pane in use takes it.
  if (root.value.closest('[data-pane]')?.getAttribute('data-pane-focused') === 'false') return
  event.preventDefault()
  focusBar()
}
onMounted(() => document.addEventListener('keydown', onSlash))
onBeforeUnmount(() => document.removeEventListener('keydown', onSlash))
/** The panel's Ask again: the words go back into Ask mode, to be changed or sent again. */
function askAgain(words: string): void {
  if (!askOffered.value) return
  mode.value = 'ask'
  prompt.value = words
  void nextTick(() => askField.value?.focus())
}
defineExpose({ focus: focusBar, ask: askAgain })
</script>

<template>
  <form
    ref="root"
    role="search"
    :aria-label="t('query.filter')"
    class="flex flex-col gap-2 px-4 pt-3 pb-2"
    novalidate
    @submit.prevent="run()"
  >
    <div
      class="rounded-xl border bg-surface shadow-xs transition-[border-color,box-shadow] duration-160 ease-out-soft focus-within:ring-3"
      :class="
        errors.filter && mode === 'query'
          ? 'border-danger focus-within:ring-danger/20'
          : mode === 'ask'
            ? 'border-accent/50 focus-within:border-accent focus-within:ring-accent/15'
            : 'border-line-strong focus-within:border-focus focus-within:ring-focus/20'
      "
    >
      <div class="flex items-start gap-2 p-1.5">
        <DsSegmented
          v-if="askOffered"
          v-model="mode"
          class="mt-px shrink-0"
          size="sm"
          :label="t('query.modes.label')"
          :options="modes"
        />
        <span
          v-else
          class="mt-1.5 ml-1.5 grid size-5 shrink-0 place-items-center rounded-md bg-accent-soft text-accent-fg"
          aria-hidden="true"
        >
          <Braces class="size-3.5" />
        </span>
        <DsCodeEditor
          v-if="mode === 'query'"
          ref="filterInput"
          v-model="draft.filter"
          class="min-w-0 flex-1 [&_textarea]:py-1.5 [&_pre]:py-1.5"
          bare
          :label="t('query.filter')"
          hide-label
          keyshortcuts="/"
          :placeholder="t('query.filterPlaceholder', { example: FILTER_EXAMPLE })"
          :error="errors.filter"
          :completions="completions"
          :values="values"
          @submit="run()"
        />
        <div v-else class="min-w-0 flex-1">
          <label :for="askId" class="sr-only">{{ t('query.ask.label') }}</label>
          <textarea
            :id="askId"
            ref="askField"
            v-model="prompt"
            rows="1"
            class="field-sizing-content block max-h-36 min-h-8 w-full resize-none bg-transparent px-2 py-1.5 text-ui text-fg placeholder:text-fg-subtle focus:outline-none focus-visible:outline-none"
            :placeholder="t('ai.sheet.example.query')"
            :readonly="generating"
            :aria-busy="generating"
            @keydown="onAskKey"
          />
        </div>
        <div v-if="mode === 'query'" class="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            class="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-ui text-fg-muted transition-colors duration-120 hover:bg-subtle hover:text-fg"
            :class="showBuilder ? 'bg-subtle text-fg' : ''"
            :aria-expanded="showBuilder"
            :title="t('query.builder.label')"
            @click="showBuilder = !showBuilder"
          >
            <ListFilter class="size-4" aria-hidden="true" />
            <span class="sr-only md:not-sr-only">{{ t('query.builder.toggle') }}</span>
          </button>
          <button
            type="button"
            class="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-ui text-fg-muted transition-colors duration-120 hover:bg-subtle hover:text-fg data-[count]:after:ml-0.5 data-[count]:after:rounded-full data-[count]:after:bg-accent-soft data-[count]:after:px-1.5 data-[count]:after:text-caption data-[count]:after:leading-[18px] data-[count]:after:font-semibold data-[count]:after:text-accent-fg data-[count]:after:content-[attr(data-count)]"
            :class="showOptions ? 'bg-subtle text-fg' : ''"
            :aria-expanded="showOptions"
            :aria-label="optionsSet ? t('query.optionsSet', { count: optionsSet }) : undefined"
            :data-count="optionsSet || undefined"
            :title="t('query.options')"
            @click="showOptions = !showOptions"
          >
            <SlidersHorizontal class="size-4" aria-hidden="true" />
            <span class="hidden md:inline">{{ t('query.options') }}</span>
          </button>
          <button
            v-if="target"
            type="button"
            class="grid size-8 cursor-pointer place-items-center rounded-lg text-fg-muted transition-colors duration-120 hover:bg-subtle hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
            :aria-label="t('library.saveFavourite')"
            :title="t('library.saveFavourite')"
            :disabled="!savable"
            @click="startFavourite"
          >
            <Star class="size-4" aria-hidden="true" />
          </button>
          <RecentQueries v-if="target" :target="target" @pick="useRecent" />
          <button
            type="button"
            class="grid size-8 cursor-pointer place-items-center rounded-lg text-fg-muted transition-colors duration-120 hover:bg-subtle hover:text-fg"
            :title="t('query.reset')"
            @click="reset"
          >
            <RotateCcw class="size-4" aria-hidden="true" />
            <span class="sr-only">{{ t('query.reset') }}</span>
          </button>
          <DsButton type="submit" variant="primary" size="sm" class="ml-1" :title="t('query.findHint')">
            {{ t('query.find') }}
          </DsButton>
        </div>
        <div v-else class="flex shrink-0 items-center gap-1">
          <DsButton v-if="generating" size="sm" :icon="Square" @click="stop">{{
            t('ai.sheet.stop')
          }}</DsButton>
          <DsButton
            v-else
            variant="primary"
            size="sm"
            :icon="Sparkles"
            :disabled="!canGenerate"
            :title="t('query.ask.generateHint')"
            @click="generate"
          >
            {{ t('query.ask.generate') }}
          </DsButton>
        </div>
      </div>
      <div
        v-if="mode === 'ask'"
        class="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line px-3 py-2 text-small text-fg-subtle"
      >
        <p v-if="generating" class="flex items-center gap-1.5 text-fg-muted" role="status">
          <DsSpinner :size="12" />{{ t('query.ask.writing', { provider: provider?.name ?? '' }) }}
        </p>
        <div
          v-else-if="needsPipeline"
          role="status"
          class="flex min-w-0 flex-wrap items-center gap-2 text-fg"
        >
          <Workflow class="size-3.5 shrink-0 text-accent-fg" aria-hidden="true" />
          <span>{{ t('query.ask.needsPipeline') }}</span>
          <DsButton size="sm" variant="primary" :icon="Workflow" @click="toPipeline">
            {{ t('query.ask.toPipeline') }}
          </DsButton>
        </div>
        <p v-else-if="askProblem" role="alert" class="text-danger">{{ askProblem }}</p>
        <p v-else class="flex min-w-0 items-center gap-1.5">
          <ShieldCheck class="size-3.5 shrink-0 text-success" aria-hidden="true" />
          {{ t('query.ask.sends', { provider: provider?.name ?? '' }) }}
        </p>
        <div class="ml-auto flex flex-wrap gap-1.5">
          <button
            v-for="example in examples"
            :key="example"
            type="button"
            class="cursor-pointer rounded-full border border-line px-2.5 py-0.5 text-small text-fg-muted transition-colors duration-120 hover:border-accent/40 hover:bg-accent-soft hover:text-accent-fg"
            @click="((prompt = example), askField?.focus())"
          >
            {{ example }}
          </button>
        </div>
      </div>
    </div>
    <div
      v-if="mode === 'query' && paramNames.length > 0"
      data-query-params
      role="group"
      :aria-label="t('query.params.label')"
      class="flex animate-rise flex-wrap items-start gap-x-3 gap-y-2 rounded-xl border border-line bg-subtle/60 px-3 py-2.5"
    >
      <p class="w-full text-small text-fg-muted">{{ t('query.params.hint') }}</p>
      <div v-for="name in paramNames" :key="name" :data-query-param="name" class="w-48 max-w-full">
        <DsInput
          :model-value="paramValue(name)"
          size="sm"
          :label="paramLabel(name)"
          :placeholder="t('query.params.placeholder')"
          :error="paramError(name) || undefined"
          autocomplete="off"
          spellcheck="false"
          @update:model-value="setParam(name, String($event))"
        />
      </div>
    </div>
    <FilterBuilder
      v-if="showBuilder && mode === 'query'"
      v-model="draft.filter"
      class="animate-rise"
      :fields="fields"
      :types="types"
      :values="values"
    />
    <div
      v-if="showOptions && mode === 'query'"
      class="grid animate-rise gap-x-3 gap-y-2.5 rounded-xl border border-line bg-subtle/60 p-3 sm:grid-cols-[1fr_1fr_8rem_8rem]"
    >
      <DsCodeEditor
        v-model="draft.projection"
        :label="t('query.projection')"
        placeholder="{ name: 1 }"
        :error="errors.projection"
        :completions="completions"
        @submit="run()"
      />
      <DsCodeEditor
        v-model="draft.sort"
        :label="t('query.sort')"
        placeholder="{ _id: -1 }"
        :error="errors.sort"
        :completions="completions"
        @submit="run()"
      />
      <DsInput
        v-model="draft.skip"
        :label="t('query.skip')"
        inputmode="numeric"
        placeholder="0"
        :error="errors.skip"
        autocomplete="off"
      />
      <DsSelect v-model="limit" :label="t('query.limit')" :options="limits" />
      <DsCodeEditor
        v-model="draft.collation"
        :label="t('query.collation')"
        placeholder="{ locale: 'tr', strength: 1 }"
        :error="errors.collation"
        @submit="run()"
      />
      <DsCodeEditor
        v-model="draft.hint"
        :label="t('query.hint')"
        placeholder="{ qty: 1 } | qty_1"
        :error="errors.hint"
        :completions="completions"
        @submit="run()"
      />
      <DsInput
        v-model="draft.maxTimeMS"
        class="sm:col-span-2"
        :label="t('query.maxTimeMS')"
        inputmode="numeric"
        :placeholder="t('query.maxTimeDefault')"
        :error="errors.maxTimeMS"
        autocomplete="off"
      />
    </div>
    <SaveItemDialog
      v-if="favourite.open.value"
      :title="t('library.saveFavourite')"
      :busy="favourite.busy.value"
      :error="favourite.error.value"
      @save="favourite.save"
      @close="favourite.open.value = false"
    />
  </form>
</template>
