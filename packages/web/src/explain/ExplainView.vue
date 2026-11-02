<script setup lang="ts">
import { ChevronRight, Copy, Gauge, Play } from 'lucide-vue-next'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsCard from '@/ds/DsCard.vue'
import MaskedBanner from '@/masking/MaskedBanner.vue'
import { provideMaskedPaths } from '@/masking/useMaskedPaths'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsSelect from '@/ds/DsSelect.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  deserializeValue,
  formatShell,
  isWritePipeline,
  type ExplainRequest,
  type ExplainResult,
} from '@mongo-manager/shared/browser'
import type { CollectionTarget } from '@/api/documents'
import { explainApi } from '@/api/explain'
import { describeError } from '@/api/errors'
import { useCollectionViewsStore } from '@/stores/collectionViews'
import { useToastStore } from '@/stores/toasts'
import { toPipeline } from '@/aggregation/stages'
import PlanTree from './PlanTree.vue'
import StatGrid from '@/workspace/tabs/StatGrid.vue'

const IndexCreateDialog = defineAsyncComponent(() => import('@/indexes/IndexCreateDialog.vue'))

/**
 * Phase 2b spec §3.1: how MongoDB runs the Documents query or the Aggregations pipeline of this
 * tab, with warnings in words and an index to create when one would help.
 */
const props = defineProps<{ target: CollectionTarget; tabId: string; canManageIndexes: boolean }>()

// W5 (spec 3c §7): the masking hint on every data screen, and the hidden paths for the locks.
const masking = provideMaskedPaths(
  computed(() => props.target.connectionId),
  computed(() => props.target.db),
  computed(() => props.target.coll),
)
const { t, locale } = useI18n()
const toasts = useToastStore()
const view = useCollectionViewsStore().stateFor(props.tabId)
const state = view.explain

// Kept with the tab: coming back to Explain shows the last result without running it again (I5).
const result = computed({
  get: () => state.result,
  set: (value: ExplainResult | null) => (state.result = value),
})
const error = ref<string | null>(null)
const running = ref(false)
const creating = ref(false)
let controller: AbortController | null = null
onBeforeUnmount(() => controller?.abort())

/** What will be explained, or why nothing can be. */
const request = computed((): { body: ExplainRequest } | { problem: string } => {
  if (state.source === 'documents') {
    const q = view.query
    return {
      body: {
        kind: 'find',
        filter: q.filter,
        ...(q.projection ? { projection: q.projection } : {}),
        ...(q.sort ? { sort: q.sort } : {}),
        ...(q.collation ? { collation: q.collation } : {}),
        ...(q.hint !== undefined ? { hint: q.hint } : {}),
        skip: q.skip,
        limit: q.limit,
        verbosity: state.verbosity,
      },
    }
  }
  const built = toPipeline(view.aggregation.cards)
  if (built.error) return { problem: t('explain.pipelineInvalid') }
  if (isWritePipeline(built.values)) return { problem: t('explain.pipelineWrites') }
  return { body: { kind: 'aggregate', stages: built.stages, verbosity: state.verbosity } }
})

async function explain(): Promise<void> {
  const r = request.value
  if ('problem' in r) return
  controller?.abort()
  const mine = new AbortController()
  controller = mine
  running.value = true
  error.value = null
  try {
    const answer = await explainApi.explain(props.target, r.body, mine.signal)
    if (controller === mine) {
      result.value = answer
      state.resultFor = JSON.stringify(r.body)
    }
  } catch (e) {
    if (controller === mine && !mine.signal.aborted) error.value = describeError(e, t)
  } finally {
    if (controller === mine) running.value = false
  }
}

// "Why is it slow?" asks for an explain as the section opens.
function onRequest(): void {
  if (state.request > state.handled) {
    state.handled = state.request
    void explain()
  }
}
/** The result was for another query, source or detail than the one explained now (M9). */
const stale = computed(() => {
  const r = request.value
  return !!result.value && (!('body' in r) || JSON.stringify(r.body) !== state.resultFor)
})
onMounted(onRequest)
watch(() => state.request, onRequest)

const number = (n: number | undefined) =>
  n === undefined ? '—' : new Intl.NumberFormat(locale.value).format(n)
const timeText = computed(() =>
  result.value?.summary.executionTimeMillis === undefined
    ? number(undefined)
    : t('explain.ms', { n: number(result.value.summary.executionTimeMillis) }),
)
const keyText = computed(() => {
  const key = result.value?.suggestion?.key
  return key
    ? `{ ${key.map(([f, d]) => `${/^[A-Za-z_$][\w$]*$/.test(f) ? f : JSON.stringify(f)}: ${d}`).join(', ')} }`
    : ''
})
const rawText = computed(() => {
  if (!result.value) return ''
  try {
    return formatShell(deserializeValue(result.value.raw), { indent: 2 })
  } catch {
    return JSON.stringify(result.value.raw, null, 2)
  }
})
// A run stopped at its time limit (code 50) says whether only the plan came back; one MongoDB
// stopped otherwise, or without saying why, says just that it stopped. A scan without execution
// numbers is named without a count. Any other warning reads as it always does.
const warningKey = (w: ExplainResult['warnings'][number]): string => {
  const d = w.detail ?? {}
  if (w.code === 'INCOMPLETE') {
    if (d.planOnly === true) return 'INCOMPLETE_PLAN_ONLY'
    return d.code === 50 ? 'INCOMPLETE' : 'INCOMPLETE_STOPPED'
  }
  return w.code === 'COLLSCAN' && d.uncounted === true ? 'COLLSCAN_UNCOUNTED' : w.code
}
const warningText = (w: ExplainResult['warnings'][number]) =>
  t(`explain.warnings.${warningKey(w)}`, {
    stage: w.stage ?? '',
    ...Object.fromEntries(
      Object.entries(w.detail ?? {}).map(([k, v]) => [k, typeof v === 'number' ? number(v) : String(v)]),
    ),
  })

async function copyRaw(): Promise<void> {
  try {
    await navigator.clipboard.writeText(rawText.value)
    toasts.push({ kind: 'success', message: t('aggregation.export.copied') })
  } catch {
    toasts.push({ kind: 'error', message: t('aggregation.export.copyFailed') })
  }
}

const sourceOptions = computed(() => [
  { value: 'documents' as const, label: t('explain.fromDocuments') },
  { value: 'aggregation' as const, label: t('explain.fromAggregation') },
])
const verbosityOptions = computed(() =>
  (['queryPlanner', 'executionStats', 'allPlansExecution'] as const).map((v) => ({
    value: v,
    label: t(`explain.verbosities.${v}`),
  })),
)
/** UI redesign R2 §3: the summary as one card of figures. */
const figures = computed(() => {
  const r = result.value
  if (!r) return []
  // The plan alone: the run stopped before giving any figure.
  const measured = r.incomplete?.planOnly
    ? [{ label: t('explain.summary.figures'), value: t('explain.summary.notMeasured') }]
    : [
        { label: t('explain.summary.returned'), value: number(r.summary.nReturned) },
        { label: t('explain.summary.keys'), value: number(r.summary.totalKeysExamined) },
        { label: t('explain.summary.docs'), value: number(r.summary.totalDocsExamined) },
        { label: t('explain.summary.time'), value: timeText.value },
      ]
  return [
    ...measured,
    { label: t('explain.summary.engine'), value: t(`explain.engines.${r.engine}`) },
    ...(r.summary.planCacheUsed !== undefined
      ? [
          {
            label: t('explain.summary.planCache'),
            value: r.summary.planCacheUsed
              ? t('explain.summary.planCacheUsed')
              : t('explain.summary.planCacheNotUsed'),
          },
        ]
      : []),
  ]
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex flex-wrap items-end gap-3 border-b border-line px-4 py-2.5">
      <DsSelect
        v-model="state.source"
        class="w-52"
        size="sm"
        :label="t('explain.source')"
        :options="sourceOptions"
      />
      <DsSelect
        v-model="state.verbosity"
        class="w-52"
        size="sm"
        :label="t('explain.verbosity')"
        :options="verbosityOptions"
      />
      <DsButton
        size="sm"
        variant="primary"
        :icon="Play"
        :loading="running"
        :disabled="'problem' in request"
        @click="explain"
      >
        {{ t('explain.run') }}
      </DsButton>
      <span v-if="'problem' in request" class="pb-1.5 text-small text-fg-subtle">{{ request.problem }}</span>
    </div>
    <div class="min-h-0 flex-1 overflow-auto p-4">
      <MaskedBanner v-if="masking.hidden.value" class="mb-3" />
      <DsCallout v-if="error" tone="danger">{{ error }}</DsCallout>
      <div
        v-else-if="running && !result"
        class="flex flex-col gap-3"
        role="status"
        :aria-label="t('explain.running')"
      >
        <DsSkeleton class="h-20" />
        <DsSkeleton class="h-48" />
      </div>
      <DsEmptyState
        v-else-if="!result"
        :icon="Gauge"
        :title="t('explain.emptyTitle')"
        :description="t('explain.intro')"
      />
      <div v-if="result" class="flex max-w-6xl flex-col gap-4">
        <DsCallout v-if="stale" data-explain-stale tone="info">{{ t('explain.stale') }}</DsCallout>
        <StatGrid data-explain-summary :items="figures" :aria-label="t('explain.summaryTitle')" />
        <ul v-if="result.warnings.length" data-explain-warnings class="flex flex-col gap-2">
          <li v-for="(w, i) in result.warnings" :key="i">
            <DsCallout tone="warning">{{ warningText(w) }}</DsCallout>
          </li>
        </ul>
        <DsCard v-if="result.suggestion" data-suggestion :title="t('explain.suggestionTitle')" actions-shown>
          <template #actions>
            <DsButton v-if="canManageIndexes" size="sm" variant="primary" @click="creating = true">
              {{ t('explain.createIndex') }}
            </DsButton>
          </template>
          <div class="flex flex-col gap-1.5 text-ui">
            <p class="text-fg-muted">{{ t('explain.suggestion') }}</p>
            <code class="w-fit rounded-md bg-muted px-2 py-1 font-mono text-[12.5px] text-fg">{{
              keyText
            }}</code>
            <p class="text-small text-fg-subtle">
              {{
                t('explain.esr', {
                  equality: result.suggestion.reason.equality.join(', ') || '—',
                  sort: result.suggestion.reason.sort.join(', ') || '—',
                  range: result.suggestion.reason.range.join(', ') || '—',
                })
              }}
            </p>
            <p v-if="result.suggestion.reason.inWithSort" class="text-small text-fg-subtle">
              {{ t('explain.inWithSort') }}
            </p>
          </div>
        </DsCard>
        <DsCard v-if="result.winning" :title="t('explain.winning')">
          <PlanTree
            :root="result.winning"
            :label="t('explain.winning')"
            :total-ms="result.summary.executionTimeMillis"
          />
        </DsCard>
        <DsCallout v-else tone="info">{{ t('explain.unknownShape') }}</DsCallout>
        <DsCard
          v-for="shard in result.shards ?? []"
          :key="shard.shard"
          :title="t('explain.shard', { name: shard.shard })"
        >
          <PlanTree
            v-if="shard.winning"
            :root="shard.winning"
            :label="t('explain.shard', { name: shard.shard })"
          />
        </DsCard>
        <DsCard
          v-if="result.pipeline.length"
          :title="t('explain.pipelineTitle')"
          :count="result.pipeline.length"
        >
          <ol data-explain-pipeline class="flex flex-col">
            <li
              v-for="(s, i) in result.pipeline"
              :key="i"
              class="flex flex-wrap items-baseline gap-3 border-b border-line py-2 text-ui last:border-b-0"
            >
              <span class="w-5 text-small text-fg-subtle tabular-nums">{{ i + 1 }}</span>
              <span class="font-mono font-semibold text-fg">{{ s.stage }}</span>
              <span v-if="s.nReturned !== undefined" class="text-small text-fg-muted">{{
                t('explain.returned', { n: number(s.nReturned) })
              }}</span>
              <span v-if="s.executionTimeMillisEstimate !== undefined" class="text-small text-fg-muted">{{
                t('explain.ms', { n: number(s.executionTimeMillisEstimate) })
              }}</span>
            </li>
          </ol>
        </DsCard>
        <details
          v-if="result.rejected.length"
          data-rejected
          class="group/details rounded-card border border-line bg-surface shadow-xs"
        >
          <summary
            class="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 text-ui font-semibold text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none [&::-webkit-details-marker]:hidden"
          >
            <ChevronRight
              class="size-3.5 text-fg-subtle transition-transform duration-160 group-open/details:rotate-90"
              aria-hidden="true"
            />
            {{ t('explain.rejected', result.rejected.length) }}
          </summary>
          <div class="flex flex-col gap-3 px-4 pb-4">
            <PlanTree
              v-for="(plan, i) in result.rejected"
              :key="i"
              :root="plan"
              :label="t('explain.rejectedPlan', { n: i + 1 })"
            />
          </div>
        </details>
        <details
          data-raw
          :open="!result.winning"
          class="group/details rounded-card border border-line bg-surface shadow-xs"
        >
          <summary
            class="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 text-ui font-semibold text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none [&::-webkit-details-marker]:hidden"
          >
            <ChevronRight
              class="size-3.5 text-fg-subtle transition-transform duration-160 group-open/details:rotate-90"
              aria-hidden="true"
            />
            {{ t('explain.raw') }}
          </summary>
          <div class="flex flex-col gap-2 px-4 pb-4">
            <pre class="max-h-96 overflow-auto rounded-lg bg-subtle p-3 font-mono text-small text-fg">{{
              rawText
            }}</pre>
            <DsButton class="self-start" size="sm" :icon="Copy" @click="copyRaw">{{
              t('aggregation.export.copy')
            }}</DsButton>
          </div>
        </details>
      </div>
    </div>
    <IndexCreateDialog v-if="creating" :target="target" :initial-key="keyText" @close="creating = false" />
  </div>
</template>
