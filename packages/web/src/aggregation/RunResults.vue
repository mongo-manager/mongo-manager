<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import {
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleStop,
  Download,
  Play,
  TriangleAlert,
  History,
} from 'lucide-vue-next'
import DsSegmented from '@/ds/DsSegmented.vue'
import DsSpinner from '@/ds/DsSpinner.vue'
import { useI18n } from 'vue-i18n'
import type { RunLine } from '@mongo-manager/shared/browser'
import { aggregateApi } from '@/api/aggregate'
import type { CollectionTarget, DocumentItem } from '@/api/documents'
import { describeError } from '@/api/errors'
import DocumentJsonList from '@/documents/DocumentJsonList.vue'
import DocumentTree from '@/documents/DocumentTree.vue'
import { arrangeColumns, columnsOf, toRows } from '@/documents/rows'
import DocumentTable from '@/documents/DocumentTable.vue'
import { formatElapsed } from '@/jobs/elapsed'
import { downloadJson } from '@/download'
import { readNdjson } from './ndjson'
import { useCollectionViewsStore } from '@/stores/collectionViews'
import DsCallout from '@/ds/DsCallout.vue'
import DsSelect from '@/ds/DsSelect.vue'

/**
 * Phase 2a spec §4.5: the full run, streamed. Rows show as their lines arrive; Stop aborts the
 * request (the server then kills the operation); the total is counted only on demand.
 */
const props = defineProps<{
  /** The tab whose view state keeps the last run (shown again for the same pipeline). */
  tabId?: string
  target: CollectionTarget
  stages: Record<string, unknown>[]
  disabled: boolean
  mode: 'json' | 'tree'
}>()
const { t, locale } = useI18n()

type State = 'idle' | 'running' | 'done' | 'stopped' | 'error'
const state = ref<State>('idle')
const items = shallowRef<DocumentItem[]>([])
const end = ref<{ count: number; truncated: boolean } | null>(null)
const error = ref<string | null>(null)
const elapsed = ref(0)
const total = ref<number | null>(null)
const counting = ref(false)
const countError = ref<string | null>(null)
let controller: AbortController | null = null
/** UI redesign R1 review: how many documents a run brings back (the server allows up to 10,000). */
const LIMITS = [1000, 5000, 10000] as const
const limit = ref<number>(1000)
// The kit's select speaks text; the limit stays a number.
const limitText = computed({
  get: () => String(limit.value),
  set: (v: string) => (limit.value = Number(v)),
})
/** Reviewer C I4: what the run shown used — its limit and its stages — not what is chosen since. */
const ranLimit = ref(limit.value)
const ranStages = ref('')
const stale = computed(() => state.value !== 'idle' && ranStages.value !== JSON.stringify(props.stages))

// UI redesign R1 review: back from another section, the last run of the same pipeline is shown again.
const memory = props.tabId ? useCollectionViewsStore().stateFor(props.tabId).aggregation.memory : null
const kept = memory?.run
if (kept && kept.stages === JSON.stringify(props.stages)) {
  state.value = kept.state
  items.value = kept.items
  end.value = kept.end
  error.value = kept.error
  elapsed.value = kept.elapsed
  total.value = kept.total
  ranLimit.value = limit.value = kept.limit
  ranStages.value = kept.stages
}
function remember(): void {
  if (!memory || (state.value !== 'done' && state.value !== 'stopped' && state.value !== 'error')) return
  memory.run = {
    stages: ranStages.value,
    state: state.value,
    items: items.value,
    end: end.value,
    error: error.value,
    elapsed: elapsed.value,
    total: total.value,
    limit: ranLimit.value,
  }
}
watch([state, total], remember)

async function run(): Promise<void> {
  controller?.abort()
  const mine = new AbortController()
  controller = mine
  items.value = []
  end.value = null
  error.value = null
  total.value = null
  countError.value = null
  state.value = 'running'
  ranLimit.value = limit.value
  ranStages.value = JSON.stringify(props.stages)
  const started = Date.now()
  try {
    const stream = await aggregateApi.run(
      props.target,
      { stages: props.stages, limit: limit.value },
      mine.signal,
    )
    await readNdjson(
      stream,
      (lines) => {
        // A stopped or replaced run adds nothing to what is shown now (final review 2a, I6).
        if (controller !== mine || mine.signal.aborted) return
        const docs: DocumentItem[] = []
        for (const line of lines as RunLine[]) {
          if ('end' in line) end.value = line.end
          else if ('error' in line) error.value = line.error.message
          else docs.push(line as DocumentItem)
        }
        if (docs.length) items.value = [...items.value, ...docs]
        elapsed.value = Date.now() - started
      },
      undefined,
      mine.signal,
    )
    if (controller !== mine || mine.signal.aborted) return
    // No end line: the server or the network cut the stream short (final review 2a, Minor 5).
    if (!end.value && !error.value) error.value = t('aggregation.run.incomplete')
    state.value = error.value ? 'error' : 'done'
  } catch (e) {
    if (controller !== mine) return
    if (mine.signal.aborted) {
      state.value = 'stopped'
      return
    }
    error.value = describeError(e, t)
    state.value = 'error'
  } finally {
    elapsed.value = Date.now() - started
  }
}

// A total counted for other stages would describe another pipeline (final review 2a, Minor 8).
watch(
  () => JSON.stringify(props.stages),
  () => {
    total.value = null
    countError.value = null
  },
)

/** How the results are shown: the builder's preview mode to start with, or a table (Minor 6). */
const view = ref<'json' | 'tree' | 'table'>(props.mode)
const views = computed(() => [
  { value: 'table' as const, label: t('aggregation.table') },
  { value: 'tree' as const, label: t('aggregation.tree') },
  { value: 'json' as const, label: t('aggregation.json') },
])
const columns = computed(() => arrangeColumns(columnsOf(rows.value), { order: [], hidden: [] }).shown)

function stop(): void {
  controller?.abort()
  state.value = 'stopped'
}

async function computeTotal(): Promise<void> {
  counting.value = true
  countError.value = null
  try {
    total.value = (await aggregateApi.count(props.target, props.stages)).count
  } catch (e) {
    countError.value = describeError(e, t)
  } finally {
    counting.value = false
  }
}

function exportJson(): void {
  const docs = items.value.flatMap((item) => ('document' in item ? [item.document] : []))
  downloadJson(docs, `${props.target.coll}-aggregation.json`)
}

onBeforeUnmount(() => controller?.abort())

const rows = computed(() => toRows(items.value, 0))
// UI redesign R1 review: a long result is read 50 at a time (the table scrolls all of them, virtually).
const PAGE = 50
const page = ref(0)
const pages = computed(() => Math.max(1, Math.ceil(rows.value.length / PAGE)))
const shown = computed(() => rows.value.slice(page.value * PAGE, page.value * PAGE + PAGE))
watch(items, () => {
  if (page.value >= pages.value) page.value = pages.value - 1
})
watch(state, (next) => {
  if (next === 'running') page.value = 0
})
const range = computed(() =>
  t('aggregation.run.range', {
    from: number(page.value * PAGE + 1),
    to: number(Math.min(rows.value.length, page.value * PAGE + PAGE)),
    total: number(rows.value.length),
  }),
)
defineExpose({ run, stop, state, count: computed(() => items.value.length) })
const number = (n: number) => new Intl.NumberFormat(locale.value).format(n)
</script>

<template>
  <section data-results class="flex h-full min-h-0 flex-col" :aria-label="t('aggregation.run.results')">
    <header class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2 text-ui">
      <p data-run-status class="flex items-center gap-2" aria-live="polite">
        <template v-if="state === 'running'">
          <DsSpinner :size="14" />
          <span class="font-medium text-fg">{{ t('aggregation.run.running') }}</span>
          <span class="text-fg-muted tabular-nums">{{ t('aggregation.documents', items.length) }}</span>
        </template>
        <template v-else-if="state === 'done'">
          <CircleCheck class="size-4 text-success" aria-hidden="true" />
          <span class="font-medium text-fg">{{ t('aggregation.run.done') }}</span>
          <span class="text-fg-muted tabular-nums">{{ t('aggregation.documents', items.length) }}</span>
        </template>
        <template v-else-if="state === 'stopped'">
          <CircleStop class="size-4 text-warning" aria-hidden="true" />
          <span class="font-medium text-fg">{{ t('aggregation.run.stopped') }}</span>
          <span class="text-fg-muted tabular-nums">{{ t('aggregation.documents', items.length) }}</span>
        </template>
        <template v-else-if="state === 'error'">
          <TriangleAlert class="size-4 text-danger" aria-hidden="true" />
          <span class="font-medium text-danger">{{ t('aggregation.run.failed') }}</span>
        </template>
        <span v-else class="text-fg-muted">{{ t('aggregation.run.notYet') }}</span>
        <span v-if="state !== 'idle'" class="text-fg-subtle tabular-nums"
          >· {{ formatElapsed(elapsed, locale) }}</span
        >
      </p>
      <span
        v-if="end?.truncated"
        class="rounded-full bg-warning-soft px-2 py-0.5 text-small font-medium text-warning"
        >{{ t('aggregation.run.truncatedAt', { n: number(ranLimit) }) }}</span
      >
      <template v-if="state !== 'idle' && state !== 'running' && !stale">
        <button
          v-if="total === null"
          type="button"
          class="inline-flex h-7 cursor-pointer items-center rounded-md px-2 text-small text-accent-fg hover:bg-accent-soft disabled:opacity-50"
          :disabled="counting || disabled"
          @click="computeTotal"
        >
          {{ t('aggregation.run.computeTotal') }}
        </button>
        <span v-else class="text-small text-fg-muted tabular-nums">{{
          t('aggregation.run.total', { n: number(total) })
        }}</span>
        <span v-if="countError" role="alert" class="text-small text-danger">{{ countError }}</span>
      </template>
      <div class="ml-auto flex flex-wrap items-center gap-2">
        <span class="text-small text-fg-subtle" aria-hidden="true">{{ t('aggregation.run.limit') }}</span>
        <DsSelect
          v-model="limitText"
          class="w-24"
          size="sm"
          hide-label
          :label="t('aggregation.run.limit')"
          :options="LIMITS.map((n) => ({ value: String(n), label: number(n) }))"
        />
        <DsSegmented v-model="view" size="sm" :label="t('aggregation.run.showAs')" :options="views" />
        <button
          v-if="items.length"
          type="button"
          class="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-small text-fg-muted hover:bg-subtle hover:text-fg"
          @click="exportJson"
        >
          <Download class="size-3.5" aria-hidden="true" />{{ t('aggregation.run.exportJson') }}
        </button>
      </div>
    </header>
    <p
      v-if="stale"
      data-run-stale
      class="flex items-center gap-2 border-b border-line bg-warning-soft px-4 py-1.5 text-small text-warning"
    >
      <History class="size-3.5 shrink-0" aria-hidden="true" />{{ t('aggregation.run.stale') }}
    </p>
    <DsCallout v-if="error" tone="danger" class="mx-4 mt-3 break-words">{{ error }}</DsCallout>
    <div
      v-if="state === 'idle'"
      class="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center"
    >
      <span
        class="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent-fg"
        aria-hidden="true"
      >
        <Play class="size-5" />
      </span>
      <p class="font-medium text-fg">{{ t('aggregation.run.emptyTitle') }}</p>
      <p class="max-w-sm text-ui text-fg-muted">{{ t('aggregation.run.emptyText') }}</p>
    </div>
    <div
      v-else-if="state !== 'error' && !rows.length"
      class="flex flex-1 items-center justify-center p-8 text-ui text-fg-muted"
    >
      {{ state === 'running' ? t('aggregation.run.waiting') : t('aggregation.run.none') }}
    </div>
    <template v-else-if="rows.length">
      <div v-if="view === 'table'" class="flex min-h-0 flex-1 flex-col">
        <DocumentTable
          :rows="rows"
          :columns="columns"
          :can-write="false"
          :row-height="32"
          :target="target"
          :inline-edit="false"
        />
      </div>
      <template v-else>
        <div class="min-h-0 flex-1 overflow-auto">
          <DocumentJsonList v-if="view === 'json'" :rows="shown" :can-write="false" />
          <DocumentTree v-else :rows="shown" :can-write="false" />
        </div>
        <footer
          class="flex items-center justify-end gap-1 border-t border-line px-4 py-1.5 text-small text-fg-muted pr-[max(1rem,var(--mm-launcher-clearance,0px))]"
        >
          <span class="mr-2 tabular-nums">{{ range }}</span>
          <button
            type="button"
            class="grid size-7 cursor-pointer place-items-center rounded-md hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-35"
            :aria-label="t('aggregation.run.previous')"
            :disabled="page === 0"
            @click="page--"
          >
            <ChevronLeft class="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="grid size-7 cursor-pointer place-items-center rounded-md hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-35"
            :aria-label="t('aggregation.run.next')"
            :disabled="page >= pages - 1"
            @click="page++"
          >
            <ChevronRight class="size-4" aria-hidden="true" />
          </button>
        </footer>
      </template>
    </template>
  </section>
</template>
