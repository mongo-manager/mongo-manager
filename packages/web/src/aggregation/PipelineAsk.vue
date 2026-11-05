<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, onMounted, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import {
  ChevronDown,
  ChevronRight,
  Gauge,
  History,
  MessageSquareText,
  ShieldCheck,
  Sparkles,
  Square,
  Undo2,
  X,
} from 'lucide-vue-next'
import DsButton from '@/ds/DsButton.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import DsSpinner from '@/ds/DsSpinner.vue'
import type { CollectionTarget } from '@/api/documents'
import { connectionsApi, queryKeys } from '@/api/connections'
import { useCollectionViewsStore } from '@/stores/collectionViews'
import { useWorkspaceDialogs } from '@/stores/workspaceDialogs'
import { useDialogStore } from '@/stores/dialogs'
import { aiOffered, useAiRequest, useAiStatus } from '@/ai/useAi'
import { useAiWords } from '@/ai/words'
import { currentFor } from '@/ai/insert'
import { replyOf } from './steps'
import DsCodeBlock from '@/ds/DsCodeBlock.vue'
import { toPipeline } from './stages'
import { decodeValue, toShell } from '@/documents/values'
import { AI_LIMITS } from '@mongo-manager/shared/browser'
import { randomId } from '@/uuid'
import { uiLanguageOf } from '@mongo-manager/shared/browser'

/**
 * UI redesign R1 review ("yazdığı pipeline editleyebilmesi lazım"): the result described in words
 * becomes the builder's stages — written, never run — and then changed step by step: "also show the
 * product names", "only the last 30 days". Each step is kept, to go back to; Start over writes anew.
 */
const props = defineProps<{ target: CollectionTarget; tabId: string; hasStages: boolean }>()
const emit = defineEmits<{
  /** The stages the assistant wrote, for the words, as a change or anew. */
  apply: [
    answer: {
      stages: Record<string, unknown>[]
      prompt: string
      reply: string
      change: boolean
      thread: string
    },
  ]
  /** Back to the version of an earlier step. */
  restore: [index: number]
}>()
const { t, locale } = useI18n()
const tab = useCollectionViewsStore().stateFor(props.tabId)
const agg = tab.aggregation
const status = useAiStatus()
const { data: connections } = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
const connection = computed(() => connections.value?.find((c) => c.id === props.target.connectionId))
const offered = computed(() => aiOffered(status.data.value, connection.value))
// Spec 4a-1 §2.4: a local-only connection uses the providers last found local (or not yet tried).
const provider = computed(() => {
  const list = (status.data.value?.providers ?? []).filter(
    (p) => connection.value?.aiPolicy !== 'local' || p.local !== false,
  )
  return list.find((p) => p.isDefault) ?? list[0]
})
const words = useAiWords()
const { run, send, stop } = useAiRequest()
// Kept with the tab: a look at another section does not lose the words being written.
const prompt = computed({
  get: () => agg.askDraft,
  set: (text: string) => {
    agg.askDraft = text
  },
})
/** A change to the stages there are, or a new pipeline. */
const changing = computed(() => props.hasStages && agg.askMode === 'change')
const modes = computed(() => [
  { value: 'change' as const, label: t('aggregation.ask.modeChange') },
  { value: 'new' as const, label: t('aggregation.ask.modeNew') },
])
const id = useId()
const busy = computed(() => run.state === 'sending' || run.state === 'streaming')
const problem = computed(() => {
  if (run.state === 'error' && run.error) return words.reason(run.error.reason, run.error.retryAfterMs)
  if (run.state !== 'done' || run.done?.result?.kind === 'pipeline') return ''
  const reason = run.done?.reason
  return reason === 'wrong_shape'
    ? t('ai.parse.wrong_shape', { kind: words.action('pipeline') })
    : reason
      ? words.parse(reason)
      : t('aggregation.ask.noPipeline')
})
const canGenerate = computed(() => !!provider.value && !busy.value && prompt.value.trim() !== '')
/** What was asked last (the answer belongs to it). */
let asked: { prompt: string; change: boolean; thread: string } | null = null

function generate(): void {
  if (!canGenerate.value) return
  const change = changing.value
  const current = currentFor(props.tabId, 'pipeline')
  // Reviewer C Minor 7: the steps up to the version shown — not those gone back on.
  const history = agg.steps
    .slice(0, currentStep.value + 1)
    .map((s) => s.prompt)
    .slice(-AI_LIMITS.history)
  const refine = change && !!current
  // A change continues the chain of the pipeline shown; a new pipeline starts one (the AI history
  // shows each chain together). It becomes the pipeline's only once its stages are written.
  const thread = refine && agg.aiThread ? agg.aiThread : randomId()
  asked = { prompt: prompt.value.trim(), change: refine, thread }
  void send(props.target, {
    action: 'pipeline',
    prompt: asked.prompt,
    language: uiLanguageOf(locale.value),
    provider: provider.value!.id,
    ...(current ? { current } : {}),
    ...(asked.change ? { refine: true, history } : {}),
    thread,
  })
}
const confirms = useDialogStore()
watch(
  () => run.state,
  async (state) => {
    const result = run.done?.result
    if (state !== 'done' || !asked || !result || result.kind !== 'pipeline') return
    const answer = { ...asked, reply: replyOf(run.text) }
    asked = null
    // Final review I2: hidden values ("***") carried back would be matched or written as they are.
    if (
      run.done?.warnings.includes('masked_values') &&
      !(await confirms.confirm({
        title: t('aggregation.ask.maskedTitle'),
        message: words.warning('masked_values'),
        confirmLabel: t('aggregation.ask.maskedConfirm'),
      }))
    )
      return
    emit('apply', {
      stages: result.stages,
      prompt: answer.prompt,
      reply: answer.reply,
      change: answer.change,
      thread: answer.thread,
    })
    prompt.value = ''
    agg.askMode = 'change'
  },
)
function onKey(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    generate()
  }
}

// Words handed over from Documents ("this needs a pipeline"): asked at once, as a new pipeline.
onMounted(() => {
  const pending = agg.pendingAsk
  if (!pending) return
  agg.pendingAsk = null
  agg.askMode = 'new'
  prompt.value = pending
  if (canGenerate.value) generate()
  else {
    const off = watch(canGenerate, (ok) => {
      if (!ok) return
      off()
      generate()
    })
  }
})

const dialogs = useWorkspaceDialogs()
function openAssistant(action: 'explain' | 'optimise'): void {
  dialogs.open({
    kind: 'ai',
    connectionId: props.target.connectionId,
    db: props.target.db,
    coll: props.target.coll,
    tabId: props.tabId,
    actions: [action],
    send: true,
  })
}
/** The step whose version the builder shows (the last, unless one was gone back to). */
const currentStep = computed(() => agg.stepAt ?? agg.steps.length - 1)
/** UI redesign R1 review: the steps in detail — words, reply, changes, stages — to go back to. */
const showDetails = ref(false)
const openStages = ref<number | null>(null)
const stagesText = (i: number) => {
  const step = agg.steps[i]
  return step ? toShell(decodeValue(toPipeline(step.cards).stages)) : ''
}
const CHANGE_MARK = { added: '+', changed: '~', removed: '−' } as const
const chip =
  'inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-small text-fg-muted transition-colors duration-120 hover:border-accent/40 hover:bg-accent-soft hover:text-accent-fg'
</script>

<template>
  <section
    v-if="offered"
    :aria-label="t('aggregation.ask.title')"
    class="rounded-xl border border-accent/40 bg-surface shadow-xs transition-[border-color,box-shadow] duration-160 ease-out-soft focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/15"
  >
    <div class="flex items-start gap-2 p-1.5">
      <DsSegmented
        v-if="hasStages"
        v-model="agg.askMode"
        class="mt-px shrink-0"
        size="sm"
        :label="t('aggregation.ask.mode')"
        :options="modes"
      />
      <span
        v-else
        class="mt-1 ml-1 grid size-6 shrink-0 place-items-center rounded-md bg-accent-soft text-accent-fg"
        aria-hidden="true"
      >
        <Sparkles class="size-3.5" />
      </span>
      <div class="min-w-0 flex-1">
        <label :for="id" class="sr-only">{{
          changing ? t('aggregation.ask.changeLabel') : t('aggregation.ask.label')
        }}</label>
        <textarea
          :id="id"
          v-model="prompt"
          rows="1"
          class="field-sizing-content block max-h-36 min-h-8 w-full resize-none bg-transparent px-1.5 py-1.5 text-ui text-fg placeholder:text-fg-subtle focus:outline-none focus-visible:outline-none"
          :placeholder="changing ? t('aggregation.ask.changePlaceholder') : t('ai.sheet.example.pipeline')"
          :readonly="busy"
          :aria-busy="busy"
          @keydown="onKey"
        />
      </div>
      <DsButton v-if="busy" size="sm" :icon="Square" @click="stop">{{ t('ai.sheet.stop') }}</DsButton>
      <DsButton
        v-else
        variant="primary"
        size="sm"
        :icon="Sparkles"
        :disabled="!canGenerate"
        :title="t('aggregation.ask.generateHint')"
        @click="generate"
      >
        {{ changing ? t('aggregation.ask.change') : t('query.ask.generate') }}
      </DsButton>
    </div>
    <div
      v-if="hasStages && agg.steps.length"
      class="flex min-w-0 items-center gap-1 border-t border-line px-3 py-1.5 text-small"
    >
      <ol
        data-pipeline-steps
        class="flex min-w-0 flex-1 flex-wrap items-center gap-1"
        :aria-label="t('aggregation.ask.steps')"
      >
        <li v-for="(step, i) in agg.steps" :key="i" class="flex min-w-0 items-center gap-1">
          <ChevronRight v-if="i > 0" class="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
          <button
            type="button"
            class="flex max-w-[22rem] min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left transition-colors duration-120 hover:bg-subtle"
            :class="i === currentStep ? 'font-medium text-fg' : 'text-fg-muted'"
            :aria-current="i === currentStep ? 'step' : undefined"
            :aria-label="t('aggregation.ask.goBack', { n: i + 1, words: step.prompt })"
            :title="step.prompt"
            @click="emit('restore', i)"
          >
            <span
              class="grid size-4 shrink-0 place-items-center rounded-full text-[10px] font-semibold"
              :class="i === currentStep ? 'bg-accent text-on-accent' : 'bg-muted text-fg-muted'"
              aria-hidden="true"
              >{{ i + 1 }}</span
            >
            <span class="truncate">{{ step.prompt }}</span>
          </button>
        </li>
      </ol>
      <button
        type="button"
        class="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-fg-muted hover:bg-subtle hover:text-fg"
        :aria-expanded="showDetails"
        @click="showDetails = !showDetails"
      >
        <History class="size-3.5" aria-hidden="true" />{{ t('aggregation.ask.details') }}
        <ChevronDown
          class="size-3.5 transition-transform duration-160"
          :class="showDetails ? 'rotate-180' : ''"
          aria-hidden="true"
        />
      </button>
      <button
        type="button"
        class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-fg-subtle hover:bg-subtle hover:text-fg"
        :aria-label="t('aggregation.ask.forget')"
        :title="t('aggregation.ask.forget')"
        @click="((agg.steps = []), (agg.intent = null), (agg.stepAt = null), (agg.aiThread = null))"
      >
        <X class="size-3.5" aria-hidden="true" />
      </button>
    </div>
    <ol
      v-if="hasStages && agg.steps.length && showDetails"
      data-pipeline-history
      class="flex max-h-96 flex-col gap-2 overflow-auto border-t border-line bg-canvas/60 px-3 py-2.5"
      :aria-label="t('aggregation.ask.steps')"
    >
      <li
        v-for="(step, i) in agg.steps"
        :key="i"
        class="flex flex-col gap-1.5 rounded-lg border bg-surface p-2.5"
        :class="i === currentStep ? 'border-accent/50' : 'border-line'"
      >
        <div class="flex min-w-0 items-start gap-2">
          <span
            class="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold"
            :class="i === currentStep ? 'bg-accent text-on-accent' : 'bg-muted text-fg-muted'"
            aria-hidden="true"
            >{{ i + 1 }}</span
          >
          <div class="min-w-0 flex-1">
            <p class="text-ui font-medium break-words text-fg">{{ step.prompt }}</p>
            <p v-if="step.reply" class="mt-0.5 text-small break-words text-fg-muted">{{ step.reply }}</p>
          </div>
          <span
            v-if="i === currentStep"
            class="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-caption font-medium text-accent-fg"
            >{{ t('aggregation.ask.current') }}</span
          >
        </div>
        <ul
          v-if="step.changes.length"
          class="flex flex-wrap gap-1 pl-7"
          :aria-label="t('aggregation.ask.changes')"
        >
          <li
            v-for="(c, k) in step.changes"
            :key="k"
            :data-change="c.kind"
            class="rounded-md px-1.5 py-0.5 font-mono text-[11.5px]"
            :class="
              c.kind === 'added'
                ? 'bg-success-soft text-success'
                : c.kind === 'removed'
                  ? 'bg-danger-soft text-danger'
                  : 'bg-warning-soft text-warning'
            "
            :title="t(`aggregation.ask.change_${c.kind}`, { operator: c.operator, n: c.n })"
          >
            {{ CHANGE_MARK[c.kind] }} {{ c.operator }} <span class="opacity-70">#{{ c.n }}</span>
          </li>
        </ul>
        <div class="flex flex-wrap items-center gap-1 pl-7">
          <button
            v-if="i !== currentStep"
            type="button"
            class="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-small text-accent-fg hover:bg-accent-soft"
            @click="emit('restore', i)"
          >
            <Undo2 class="size-3.5" aria-hidden="true" />{{ t('aggregation.ask.backHere') }}
          </button>
          <button
            type="button"
            class="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-small text-fg-muted hover:bg-subtle hover:text-fg"
            :aria-expanded="openStages === i"
            @click="openStages = openStages === i ? null : i"
          >
            {{ t('aggregation.ask.showStages') }}
            <ChevronDown class="size-3.5" :class="openStages === i ? 'rotate-180' : ''" aria-hidden="true" />
          </button>
        </div>
        <div v-if="openStages === i" class="pl-7">
          <DsCodeBlock :code="stagesText(i)" :copy-label="t('aggregation.ask.copyStages', { n: i + 1 })" />
        </div>
      </li>
    </ol>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line px-3 py-2 text-small">
      <p v-if="busy" role="status" class="flex items-center gap-1.5 text-fg-muted">
        <DsSpinner :size="12" />{{
          changing
            ? t('aggregation.ask.changing', { provider: provider?.name ?? '' })
            : t('aggregation.ask.writing', { provider: provider?.name ?? '' })
        }}
      </p>
      <p v-else-if="problem" role="alert" class="text-danger">{{ problem }}</p>
      <p v-else class="flex min-w-0 items-center gap-1.5 text-fg-subtle">
        <ShieldCheck class="size-3.5 shrink-0 text-success" aria-hidden="true" />
        {{ t('aggregation.ask.sends', { provider: provider?.name ?? '' }) }}
      </p>
      <div v-if="hasStages" class="ml-auto flex flex-wrap gap-1.5">
        <button type="button" :class="chip" @click="openAssistant('explain')">
          <MessageSquareText class="size-3.5" aria-hidden="true" />{{ t('aggregation.ask.explain') }}
        </button>
        <button type="button" :class="chip" @click="openAssistant('optimise')">
          <Gauge class="size-3.5" aria-hidden="true" />{{ t('aggregation.ask.faster') }}
        </button>
      </div>
    </div>
  </section>
</template>
