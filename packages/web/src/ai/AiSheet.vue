<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, defineAsyncComponent, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import {
  BookOpenText,
  Braces,
  Cloud,
  Gauge,
  HardDrive,
  MessageSquareText,
  ShieldCheck,
  Sparkles,
  Square,
  TriangleAlert,
  Workflow,
} from 'lucide-vue-next'
import { formatShell, type AiAction, type AiResult } from '@mongo-manager/shared/browser'
import DsCallout from '@/ds/DsCallout.vue'
import DsSheet from '@/ds/DsSheet.vue'
import DsButton from '@/ds/DsButton.vue'
import DsSelect from '@/ds/DsSelect.vue'
import DsTextarea from '@/ds/DsTextarea.vue'
import DsInput from '@/ds/DsInput.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import DsSpinner from '@/ds/DsSpinner.vue'
import { connectionsApi, queryKeys } from '@/api/connections'
import { decodeValue, toShell } from '@/documents/values'
import { useCollectionViewsStore } from '@/stores/collectionViews'
import { useToastStore } from '@/stores/toasts'
import SafeMarkdown from './SafeMarkdown.vue'
import { useAiRequest, useAiStatus } from './useAi'
import { useAiWords } from './words'
import { currentFor, insertResult } from './insert'
import { toPipeline } from '@/aggregation/stages'
import { uiLanguageOf } from '@mongo-manager/shared/browser'

const IndexCreateDialog = defineAsyncComponent(() => import('@/indexes/IndexCreateDialog.vue'))

/** Phase 4a-1 spec §1.2, §6: ask, see what is sent and the answer as it comes, insert when it is right. */
const props = defineProps<{
  connectionId: string
  db: string
  coll: string
  tabId: string
  actions: AiAction[]
  /** UI redesign R1 review: opened by a shortcut (Explain this pipeline), the request goes at once. */
  sendNow?: boolean
}>()
const emit = defineEmits<{ close: [] }>()
const { t, locale } = useI18n()
const words = useAiWords()
const toasts = useToastStore()
const target = computed(() => ({ connectionId: props.connectionId, db: props.db, coll: props.coll }))
const status = useAiStatus()
const { data: connections } = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
const connection = computed(() => connections.value?.find((c) => c.id === props.connectionId))
const { run, send, stop, reset } = useAiRequest()

const action = ref<AiAction>(props.actions[0] ?? 'describe')
// UI redesign R1 review: each task keeps its own words, and an answer belongs to the task it was for.
const prompts = reactive<Partial<Record<AiAction, string>>>({})
const prompt = computed({
  get: () => prompts[action.value] ?? '',
  set: (text: string) => {
    prompts[action.value] = text
  },
})
watch(action, () => reset())
/** What each task is, at a glance. */
const TASK_ICONS: Record<AiAction, typeof Braces> = {
  query: Braces,
  pipeline: Workflow,
  explain: MessageSquareText,
  optimise: Gauge,
  validation: ShieldCheck,
  describe: BookOpenText,
}
const prompted = computed(() => ['query', 'pipeline', 'validation'].includes(action.value))
// Spec §2.4: a local-only connection lists the providers last found local (or not yet tried).
const providers = computed(() =>
  (status.data.value?.providers ?? []).filter(
    (p) => connection.value?.aiPolicy !== 'local' || p.local !== false,
  ),
)
const providerId = ref('')
watch(
  providers,
  (list) => {
    if (!list.some((p) => p.id === providerId.value))
      providerId.value = (list.find((p) => p.isDefault) ?? list[0])?.id ?? ''
  },
  { immediate: true },
)
const provider = computed(() => providers.value.find((p) => p.id === providerId.value))
const providerOptions = computed(() =>
  providers.value.map((p) => ({
    value: p.id,
    label: `${p.name} · ${p.model}${p.local === true ? ` · ${t('ai.sheet.local')}` : p.local === false ? ` · ${t('ai.sheet.cloud')}` : ''}`,
  })),
)
const withSamples = ref(false)
const sampleCount = ref<'1' | '2' | '3' | '4' | '5'>('3')
const hide = ref('')
const hidePaths = computed(() =>
  hide.value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50),
)
watch(provider, (p) => {
  if (!p?.samples) withSamples.value = false
})
// Review 2026-10-13 (web): consent to send documents, and the fields to hide, are for one
// collection — opened again for another, the sheet asks again.
watch(
  () => [props.connectionId, props.db, props.coll],
  () => {
    withSamples.value = false
    hide.value = ''
  },
)

const current = computed(() => currentFor(props.tabId, action.value))
/** Explain and Make it faster work on the query or pipeline in the tab: shown, so it is clear which. */
const subject = computed(() => {
  const c = current.value
  if (!c || (action.value !== 'explain' && action.value !== 'optimise')) return ''
  if (c.pipeline) return toShell(decodeValue(c.pipeline))
  return named([
    ['filter', c.filter ? toShell(decodeValue(c.filter), 0) : ''],
    ['projection', c.projection ? toShell(decodeValue(c.projection), 0) : ''],
    ['sort', c.sort ? toShell(decodeValue(c.sort), 0) : ''],
  ])
})
const onPipeline = computed(() => useCollectionViewsStore().stateFor(props.tabId).section === 'aggregations')
const taskText = (a: AiAction) =>
  t(`ai.sheet.task.${(a === 'explain' || a === 'optimise') && onPipeline.value ? `${a}Pipeline` : a}`)
const busy = computed(() => run.state === 'sending' || run.state === 'streaming')
// Final review minor 16: explaining or speeding up nothing spends a request on nothing.
const needsCurrent = computed(
  () => (action.value === 'explain' || action.value === 'optimise') && !current.value,
)
const canSend = computed(
  () =>
    !!provider.value && !busy.value && !needsCurrent.value && (!prompted.value || prompt.value.trim() !== ''),
)
// Final review minor 6: the answer is drawn at most once a frame while it streams.
const shownText = ref('')
let frame: number | null = null
watch(
  () => run.text,
  (text) => {
    if (!busy.value || typeof requestAnimationFrame === 'undefined') {
      shownText.value = text
      return
    }
    frame ??= requestAnimationFrame(() => {
      frame = null
      shownText.value = run.text
    })
  },
)
watch(busy, (b) => {
  if (!b) shownText.value = run.text
})
// Final review minor 7: one announcement when the answer ends (the pane itself is not live).
const announcement = computed(() =>
  run.state === 'done'
    ? t('ai.sheet.doneStatus')
    : run.state === 'error' && run.error
      ? words.reason(run.error.reason, run.error.retryAfterMs)
      : '',
)
// Final review minor 15: what the caps left out, in words.
const leftOutWords = computed(() => {
  const sent = run.sent
  if (!sent) return ''
  const parts: string[] = []
  const paths = sent.schema?.more ?? 0
  if (paths) parts.push(t('ai.sheet.left.paths', { n: paths }, paths))
  const samples = Number(sent.leftOut.find((l) => l.startsWith('samples:'))?.split(':')[1] ?? 0)
  if (samples) parts.push(t('ai.sheet.left.samples', { n: samples }, samples))
  return parts.length ? t('ai.sheet.left.list', { list: parts.join(', ') }) : ''
})

function submit(): void {
  if (!canSend.value) return
  void send(target.value, {
    action: action.value,
    prompt: prompt.value.trim(),
    language: uiLanguageOf(locale.value),
    provider: providerId.value,
    ...(current.value ? { current: current.value } : {}),
    ...(withSamples.value ? { samples: { count: Number(sampleCount.value), mask: hidePaths.value } } : {}),
  })
}
// A shortcut asks at once, as soon as a provider is known (the status may still be loading).
if (props.sendNow) {
  const off = watch(
    canSend,
    (ok) => {
      if (!ok) return
      queueMicrotask(() => off())
      submit()
    },
    { immediate: true },
  )
}
function onPromptKey(e: KeyboardEvent): void {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    submit()
  }
}

const result = computed<AiResult | null>(() => run.done?.result ?? null)
const state = useCollectionViewsStore().stateFor(props.tabId)
/** UI review: each part of a query named, on one line, as the query bar holds it. */
const named = (parts: Array<[string, string]>) =>
  parts
    .filter(([, text]) => text.trim())
    .map(([name, text]) => `${name}: ${text}`)
    .join('\n')
const before = computed(() => {
  const r = result.value
  if (!r) return ''
  if (r.kind === 'query')
    return named([
      ['filter', state.draft.filter],
      ['projection', state.draft.projection],
      ['sort', state.draft.sort],
    ])
  if (r.kind === 'validation') return state.validationDraft?.text ?? ''
  // Final review I5: the stages the tab holds, which Insert replaces.
  if (r.kind === 'pipeline') {
    const agg = state.aggregation
    if (agg.textMode) return agg.text
    const built = toPipeline(agg.cards)
    return built.stages.length ? toShell(decodeValue(built.stages)) : ''
  }
  return ''
})
const after = computed(() => {
  const r = result.value
  if (!r) return ''
  const line = (v: Record<string, unknown> | undefined) =>
    v && Object.keys(v).length ? toShell(decodeValue(v), 0) : ''
  if (r.kind === 'query')
    return named([
      ['filter', line(r.filter) || '{}'],
      ['projection', line(r.projection)],
      ['sort', line(r.sort)],
    ])
  if (r.kind === 'pipeline') return toShell(decodeValue(r.stages))
  if (r.kind === 'validation') return toShell(decodeValue(r.validator))
  return ''
})
const insertable = computed(
  () =>
    !!result.value &&
    result.value.kind !== 'optimise' &&
    (result.value.kind !== 'validation' || !!state.validationDraft),
)
async function insert(): Promise<void> {
  if (!result.value) return
  if (await insertResult(props.tabId, result.value, t)) {
    toasts.push({ kind: 'success', message: t('ai.sheet.inserted') })
    emit('close')
  }
}

// Spec §1.1: each suggested index opens the indexes dialog, filled in (never created by itself).
const canIndex = computed(() => connection.value?.permissions.includes('indexes:write') ?? false)
const creating = ref<{ key: string; options: Record<string, unknown> } | null>(null)
const parseWords = computed(() =>
  run.done?.reason === 'wrong_shape'
    ? t('ai.parse.wrong_shape', { kind: words.action(action.value) })
    : run.done?.reason
      ? words.parse(run.done.reason)
      : null,
)
const sentText = computed(() => (run.sent ? JSON.stringify(run.sent, null, 2) : ''))
const examples: Record<AiAction, string> = {
  query: 'ai.sheet.example.query',
  pipeline: 'ai.sheet.example.pipeline',
  explain: 'ai.sheet.example.explain',
  optimise: 'ai.sheet.example.optimise',
  validation: 'ai.sheet.example.validation',
  describe: 'ai.sheet.example.describe',
}
const chips = computed(() => [
  t('ai.sheet.chip.schema', { ns: `${props.db}.${props.coll}` }),
  ...(current.value ? [t(current.value.pipeline ? 'ai.sheet.chip.pipeline' : 'ai.sheet.chip.query')] : []),
  ...(action.value === 'optimise' ? [t('ai.sheet.chip.plan')] : []),
  ...(action.value === 'validation' ? [t('ai.sheet.chip.validator')] : []),
  ...(withSamples.value ? [t('ai.sheet.chip.samples', { count: Number(sampleCount.value) })] : []),
])
</script>

<template>
  <DsSheet
    open
    :title="t('ai.sheet.title')"
    :subtitle="`${db}.${coll}`"
    :dirty="busy"
    :dirty-text="t('ai.sheet.stopAsk')"
    :discard-text="t('ai.sheet.stopClose')"
    @close="emit('close')"
  >
    <div class="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <div class="flex min-w-0 flex-col gap-5">
        <div
          v-if="actions.length > 1"
          role="radiogroup"
          :aria-label="t('ai.sheet.actionLabel')"
          class="grid gap-2 sm:grid-cols-2"
        >
          <button
            v-for="a in actions"
            :key="a"
            type="button"
            role="radio"
            :aria-checked="action === a"
            :disabled="busy && action !== a"
            class="flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-left transition-[border-color,background-color,box-shadow] duration-150 focus-visible:ring-3 focus-visible:ring-focus/25 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            :class="
              action === a
                ? 'border-accent bg-accent-soft ring-3 ring-accent/10'
                : 'border-line-strong bg-surface hover:border-fg-subtle/50 hover:bg-subtle'
            "
            @click="action = a"
          >
            <span
              class="grid size-8 shrink-0 place-items-center rounded-lg"
              :class="action === a ? 'bg-accent text-on-accent' : 'bg-muted text-fg-muted'"
              aria-hidden="true"
            >
              <component :is="TASK_ICONS[a]" class="size-4" />
            </span>
            <span class="flex min-w-0 flex-col gap-0.5">
              <span class="text-ui font-medium" :class="action === a ? 'text-accent-fg' : 'text-fg'">{{
                words.action(a)
              }}</span>
              <span class="text-small text-fg-muted">{{ taskText(a) }}</span>
            </span>
          </button>
        </div>
        <p v-else class="text-ui text-fg-muted">{{ taskText(action) }}</p>

        <div
          v-if="action === 'explain' || action === 'optimise'"
          data-ai-subject
          class="flex flex-col gap-1.5"
        >
          <span class="text-small font-medium text-fg">{{ t('ai.sheet.subject') }}</span>
          <pre
            v-if="subject"
            class="max-h-40 overflow-auto rounded-lg border border-line bg-subtle px-3 py-2 font-mono text-[12.5px] leading-5 break-words whitespace-pre-wrap text-fg"
            >{{ subject }}</pre>
          <p
            v-else
            class="rounded-lg border border-dashed border-line-strong px-3 py-2 text-small text-fg-muted"
          >
            {{ t('ai.sheet.needQuery') }}
          </p>
        </div>

        <div @keydown="onPromptKey">
          <DsTextarea
            v-model="prompt"
            :rows="3"
            :label="prompted ? t('ai.sheet.prompt') : t('ai.sheet.promptOptional')"
            :placeholder="t(examples[action])"
          />
        </div>

        <div class="flex flex-col gap-4">
          <DsSelect v-model="providerId" :label="t('ai.sheet.provider')" :options="providerOptions" />
          <div class="flex flex-col gap-1.5">
            <span class="text-ui font-medium text-fg">{{ t('ai.sheet.sends') }}</span>
            <ul class="flex flex-wrap gap-1.5" :aria-label="t('ai.sheet.sends')">
              <li v-for="c in chips" :key="c" class="rounded-full bg-muted px-2.5 py-1 text-small text-fg">
                {{ c }}
              </li>
            </ul>
          </div>
        </div>
        <p v-if="connection?.aiPolicy === 'local'" class="text-small text-fg-subtle">
          {{ t('ai.sheet.localOnly') }}
        </p>

        <fieldset class="flex flex-col gap-3 rounded-xl border border-line p-4">
          <legend class="px-1 text-ui font-medium text-fg">
            {{ t('ai.sheet.samplesTitle') }}
          </legend>
          <DsCheckbox
            v-model="withSamples"
            :label="t('ai.sheet.samples')"
            :disabled="!provider?.samples"
            :hint="t('ai.sheet.samplesHint')"
          />
          <p v-if="provider && !provider.samples" class="text-small text-fg-subtle">
            {{ t('ai.reason.samples_refused') }}
          </p>
          <div v-if="withSamples" class="grid gap-3 sm:grid-cols-[8rem_1fr]">
            <DsSelect
              v-model="sampleCount"
              :label="t('ai.sheet.count')"
              :options="(['1', '2', '3', '4', '5'] as const).map((n) => ({ value: n, label: n }))"
            />
            <DsInput v-model="hide" :label="t('ai.sheet.hide')" :hint="t('ai.sheet.hideHint')" mono />
          </div>
        </fieldset>
      </div>

      <section
        data-ai-pane
        :aria-busy="busy"
        class="flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-subtle/60 p-4 lg:sticky lg:top-0 lg:max-h-[calc(100dvh-13rem)] lg:self-start lg:overflow-y-auto"
      >
        <div v-if="run.state === 'idle'" class="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <span class="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent-fg">
            <Sparkles class="size-5" aria-hidden="true" />
          </span>
          <p class="font-medium text-fg">{{ t('ai.sheet.waiting') }}</p>
          <p class="max-w-sm text-ui text-fg-muted">{{ t('ai.sheet.waitingHint') }}</p>
        </div>
        <template v-else>
          <div class="flex items-center gap-2 text-ui text-fg-muted">
            <DsSpinner v-if="busy" />
            <Sparkles v-else class="size-4 text-accent-fg" aria-hidden="true" />
            <span v-if="run.provider">{{ run.provider.name }} · {{ run.provider.model }}</span>
            <span
              v-if="run.done && run.done.local !== null"
              class="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-small"
            >
              <component :is="run.done.local ? HardDrive : Cloud" class="size-3" aria-hidden="true" />
              {{ run.done.local ? t('ai.sheet.local') : t('ai.sheet.cloud') }}
            </span>
          </div>
          <div v-if="run.text" data-ai-answer class="rounded-xl border border-line bg-surface p-4">
            <SafeMarkdown :source="shownText" />
          </div>
          <DsCallout v-if="run.error" tone="danger">
            <p>{{ words.reason(run.error.reason, run.error.retryAfterMs) }}</p>
            <p v-if="run.error.nothingSent" class="mt-0.5 text-small opacity-80">
              {{ t('ai.sheet.notSent') }}
            </p>
          </DsCallout>
          <ul v-if="parseWords || run.done?.warnings.length" class="flex flex-col gap-2">
            <li
              v-for="w in [
                ...(parseWords ? [parseWords] : []),
                ...(run.done?.warnings ?? []).map((c) => words.warning(c)),
              ]"
              :key="w"
              class="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning-soft px-3 py-2.5 text-ui text-warning"
            >
              <TriangleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{{ w }}</span>
            </li>
          </ul>
          <div v-if="after" class="grid gap-3 sm:grid-cols-2">
            <div>
              <p class="mb-1 text-small font-medium tracking-wide text-fg-subtle uppercase">
                {{ t('ai.sheet.now') }}
              </p>
              <pre
                data-ai-now
                class="min-h-12 overflow-x-auto rounded-lg bg-subtle p-3 font-mono text-small"
                >{{ before || '—' }}</pre>
            </div>
            <div>
              <p class="mb-1 text-small font-medium tracking-wide text-fg-subtle uppercase">
                {{ t('ai.sheet.suggested') }}
              </p>
              <pre class="min-h-12 overflow-x-auto rounded-lg bg-accent-soft p-3 font-mono text-small">{{
                after
              }}</pre>
            </div>
          </div>
          <ul v-if="result?.kind === 'optimise'" class="flex flex-col gap-2">
            <li
              v-for="(ix, i) in result.indexes"
              :key="i"
              class="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2"
            >
              <code class="font-mono text-small">{{ formatShell(decodeValue(ix.keys), { indent: 0 }) }}</code>
              <DsButton
                v-if="canIndex"
                size="sm"
                @click="creating = { key: toShell(decodeValue(ix.keys)), options: ix.options }"
                >{{ t('ai.sheet.createIndex') }}</DsButton
              >
            </li>
          </ul>
          <details v-if="run.sent" data-ai-sent class="text-ui">
            <summary class="cursor-pointer text-fg-muted">
              {{ t('ai.sheet.sent') }}
            </summary>
            <p v-if="leftOutWords" class="mt-1 text-small text-fg-subtle">{{ leftOutWords }}</p>
            <pre class="mt-2 max-h-80 overflow-auto rounded-lg bg-subtle p-3 font-mono text-small">{{
              sentText
            }}</pre>
          </details>
          <p v-if="run.done" class="text-small text-fg-subtle">
            {{ t('ai.sheet.tokens', { input: run.done.usage.input, output: run.done.usage.output }) }}
          </p>
        </template>
        <p class="sr-only" role="status">{{ announcement }}</p>
      </section>
    </div>

    <template #footer>
      <p class="mr-auto text-small text-fg-subtle">
        {{ needsCurrent ? t('ai.sheet.needQuery') : t('ai.sheet.never') }}
      </p>
      <DsButton v-if="busy" @click="stop"
        ><Square class="size-4" aria-hidden="true" />{{ t('ai.sheet.stop') }}</DsButton
      >
      <DsButton v-else-if="insertable" variant="primary" @click="insert">{{ t('ai.sheet.insert') }}</DsButton>
      <DsButton
        :variant="insertable && !busy ? 'secondary' : 'primary'"
        :disabled="!canSend"
        @click="submit"
        >{{ run.state === 'idle' ? t('ai.sheet.send') : t('ai.sheet.again') }}</DsButton
      >
    </template>
  </DsSheet>
  <IndexCreateDialog
    v-if="creating"
    :target="target"
    :initial-key="creating.key"
    :initial-options="creating.options"
    @close="creating = null"
  />
</template>
