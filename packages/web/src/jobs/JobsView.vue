<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { CircleX, FilterX, History, ListChecks, LoaderCircle, Search } from 'lucide-vue-next'
import { JOB_KINDS, type JobView } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsPageHeader from '@/ds/DsPageHeader.vue'
import DsSelect from '@/ds/DsSelect.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import DsDrawer from '@/ds/DsDrawer.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsInput from '@/ds/DsInput.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import { INSPECTOR_MAX, INSPECTOR_MIN, useLayoutStore } from '@/stores/layout'
import { useJobsStore } from './store'
import { useCancelJob } from './cancel'
import JobDetails from './JobDetails.vue'
import JobLine from './JobLine.vue'
import RunningJobCard from './RunningJobCard.vue'
import { DAY, filterJobs, jobCounts, type JobFilters } from './jobFilters'
import { dayOf, placeOf } from './present'
import { useJobWords } from './useJobWords'

/**
 * User review 2026-10-08 ("arka plan sayfasını beğenmedim, yeni baştan tasarla"): the background jobs
 * page — three summary cards that filter, the running jobs large at the top, the history grouped by
 * day in one line a job, and a job's details beside the list. Live, from the jobs channel.
 */
const w = useJobWords()
const store = useJobsStore()
const layout = useLayoutStore()
const cancel = useCancelJob()

/** The server lists at most this many of the newest jobs (routes/jobs.ts). */
const LISTED = 200

const filters = reactive<JobFilters>({
  state: 'all',
  kind: 'all',
  connectionId: 'all',
  mine: false,
  search: '',
  since: null,
})
const narrowed = computed(
  () =>
    filters.state !== 'all' ||
    filters.kind !== 'all' ||
    filters.connectionId !== 'all' ||
    filters.mine ||
    filters.since !== null ||
    filters.search.trim() !== '',
)
function clearFilters(): void {
  Object.assign(filters, {
    state: 'all',
    kind: 'all',
    connectionId: 'all',
    mine: false,
    search: '',
    since: null,
  })
}

// Running jobs tick on the server's clock; finished ones show fixed times.
const now = ref(store.serverNow())
const ticker = setInterval(() => (now.value = store.serverNow()), 1_000)
onBeforeUnmount(() => clearInterval(ticker))
watch(
  () => store.list,
  () => (now.value = store.serverNow()),
)

const kindName = (kind: JobView['kind']) => w.kind({ kind } as JobView)
const counts = computed(() => jobCounts(store.list, now.value))
const matching = computed(() => filterJobs(store.list, filters, kindName))
const running = computed(() => matching.value.filter((j) => j.state === 'running'))
const history = computed(() => matching.value.filter((j) => j.state !== 'running'))
/** The history by the day each job ended, newest first. */
const days = computed(() => {
  const groups: Array<{ key: string; label: string; jobs: JobView[] }> = []
  const ended = (j: JobView) => j.finishedAt ?? j.startedAt
  for (const job of [...history.value].sort((a, b) => ended(b) - ended(a))) {
    const day = dayOf(ended(job), now.value, w.locale.value)
    const label = day.label === 'today' || day.label === 'yesterday' ? w.t(`jobs.ui.${day.label}`) : day.label
    const last = groups.at(-1)
    if (last?.key === day.key) last.jobs.push(job)
    else groups.push({ key: day.key, label, jobs: [job] })
  }
  return groups
})

// ---- Summary cards: each one filters (and filters back off when chosen again).
type Card = 'running' | 'recent' | 'failed'
const card = computed<Card | null>(() =>
  filters.state === 'running' && filters.since === null
    ? 'running'
    : filters.since !== null && filters.state === 'failed'
      ? 'failed'
      : filters.since !== null && filters.state === 'all'
        ? 'recent'
        : null,
)
function choose(next: Card): void {
  if (card.value === next) {
    filters.state = 'all'
    filters.since = null
    return
  }
  filters.state = next === 'running' ? 'running' : next === 'failed' ? 'failed' : 'all'
  filters.since = next === 'running' ? null : now.value - DAY
}
const cards = computed(() => [
  {
    id: 'running' as const,
    icon: LoaderCircle,
    n: counts.value.running,
    label: w.t('jobs.ui.cards.running'),
    tone: 'text-info bg-info-soft',
  },
  {
    id: 'recent' as const,
    icon: History,
    n: counts.value.recent,
    label: w.t('jobs.ui.cards.recent'),
    tone: 'text-accent-fg bg-accent-soft',
  },
  {
    id: 'failed' as const,
    icon: CircleX,
    n: counts.value.failedRecently,
    label: w.t('jobs.ui.cards.failed'),
    tone: counts.value.failedRecently ? 'text-danger bg-danger-soft' : 'text-fg-subtle bg-muted',
  },
])

const states = computed(() => [
  { value: 'all' as const, label: w.t('jobs.ui.filter.all') },
  { value: 'done' as const, label: w.t('jobs.ui.filter.done') },
  { value: 'failed' as const, label: w.t('jobs.ui.filter.failed') },
  { value: 'cancelled' as const, label: w.t('jobs.ui.filter.cancelled') },
])
/** The history's state filter (the running jobs have their own section). */
const historyState = computed({
  get: () => (filters.state === 'running' ? 'all' : filters.state),
  set: (value: JobFilters['state']) => (filters.state = value),
})
const kinds = computed(() =>
  JOB_KINDS.map((kind) => ({ value: kind, label: kindName(kind) })).sort((a, b) =>
    a.label.localeCompare(b.label, w.locale.value),
  ),
)
const kindOptions = computed(() => [{ value: 'all', label: w.t('jobs.ui.filter.allKinds') }, ...kinds.value])
const connectionOptions = computed(() => [
  { value: 'all', label: w.t('jobs.ui.filter.allConnections') },
  ...jobConnections.value.map((c) => ({ value: c.id, label: c.name })),
])
const jobConnections = computed(() =>
  [...new Set(store.list.map((j) => j.connectionId))]
    .map((id) => ({ id, name: w.connection(id) }))
    .sort((a, b) => a.name.localeCompare(b.name, w.locale.value)),
)

// ---- One job's details, beside the list; the jobs panel can ask for one.
const selectedId = ref<string | null>(null)
const selected = computed(() => (selectedId.value ? (store.byId[selectedId.value] ?? null) : null))
const select = (job: JobView) => (selectedId.value = selectedId.value === job.id ? null : job.id)
watch(
  () => store.focused,
  (id) => {
    if (!id) return
    selectedId.value = id
    store.focus(null)
  },
  { immediate: true },
)
</script>

<template>
  <section class="flex h-full min-h-0" data-jobs-page :aria-label="w.t('jobs.title')">
    <div class="flex min-w-0 flex-1 flex-col">
      <DsPageHeader :title="w.t('jobs.title')" :icon="ListChecks">
        <template #actions>
          <DsInput
            v-model="filters.search"
            class="w-64 max-w-full"
            size="sm"
            :icon="Search"
            :label="w.t('jobs.ui.search')"
            hide-label
            clearable
            :placeholder="w.t('jobs.ui.search')"
          />
        </template>
      </DsPageHeader>
      <div class="min-h-0 flex-1 overflow-auto">
        <div class="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-5">
          <div class="grid gap-3 sm:grid-cols-3" role="group" :aria-label="w.t('jobs.ui.cards.label')">
            <button
              v-for="c in cards"
              :key="c.id"
              type="button"
              :data-card="c.id"
              :aria-pressed="card === c.id"
              class="flex cursor-pointer items-center gap-3 rounded-xl border bg-surface p-4 text-left shadow-xs transition-[border-color,box-shadow] duration-160 hover:border-fg-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              :class="card === c.id ? 'border-accent ring-3 ring-accent/15' : 'border-line'"
              @click="choose(c.id)"
            >
              <span
                class="grid size-10 shrink-0 place-items-center rounded-xl"
                :class="c.tone"
                aria-hidden="true"
              >
                <component
                  :is="c.icon"
                  class="size-5"
                  :class="c.id === 'running' && c.n ? 'animate-spin motion-reduce:animate-none' : ''"
                />
              </span>
              <span class="min-w-0">
                <span class="block text-title-l font-semibold text-fg tabular-nums">{{ c.n }}</span>
                <span class="block text-small text-fg-muted">{{ c.label }}</span>
              </span>
            </button>
          </div>

          <section v-if="running.length" aria-labelledby="jobs-running" class="flex flex-col gap-3">
            <h3 id="jobs-running" class="text-caption font-semibold tracking-wide text-fg-subtle uppercase">
              {{ w.t('jobs.ui.runningNow') }}
            </h3>
            <ul class="flex flex-col gap-3">
              <RunningJobCard
                v-for="job in running"
                :key="job.id"
                :job="job"
                :now="now"
                @cancel="cancel"
                @select="select"
              />
            </ul>
          </section>

          <section aria-labelledby="jobs-history" class="flex flex-col gap-3">
            <div class="flex flex-wrap items-center gap-2">
              <h3
                id="jobs-history"
                class="mr-2 text-caption font-semibold tracking-wide text-fg-subtle uppercase"
              >
                {{ w.t('jobs.ui.history') }}
              </h3>
              <DsSegmented
                v-model="historyState"
                size="sm"
                :label="w.t('jobs.ui.filter.label')"
                :options="states"
              />
              <DsSelect
                v-model="filters.kind"
                class="w-44"
                size="sm"
                :label="w.t('jobs.ui.filter.kind')"
                hide-label
                :options="kindOptions"
              />
              <DsSelect
                v-model="filters.connectionId"
                class="w-44"
                size="sm"
                :label="w.t('jobs.ui.filter.connection')"
                hide-label
                :options="connectionOptions"
              />
              <DsCheckbox v-model="filters.mine" class="px-1" :label="w.t('jobs.ui.filter.mine')" />
              <DsButton
                v-if="narrowed"
                size="sm"
                variant="ghost"
                :icon="FilterX"
                class="ml-auto"
                @click="clearFilters"
              >
                {{ w.t('jobs.ui.clear') }}
              </DsButton>
            </div>

            <DsEmptyState
              v-if="store.list.length === 0"
              :icon="ListChecks"
              :title="w.t('jobs.ui.emptyTitle')"
              :description="w.t('jobs.ui.emptyHint')"
            />
            <DsEmptyState
              v-else-if="history.length === 0 && running.length === 0"
              :icon="FilterX"
              :title="w.t('jobs.ui.noMatch')"
              :description="w.t('jobs.ui.noMatchHint')"
            >
              <template #actions>
                <DsButton size="sm" :icon="FilterX" @click="clearFilters">{{
                  w.t('jobs.ui.clear')
                }}</DsButton>
              </template>
            </DsEmptyState>
            <p v-else-if="history.length === 0" class="px-2 py-4 text-ui text-fg-subtle">
              {{ w.t('jobs.ui.noHistory') }}
            </p>
            <div v-for="day in days" :key="day.key" :data-day="day.key" class="flex flex-col">
              <h4 class="px-2 pb-1.5 text-small font-semibold text-fg-muted">{{ day.label }}</h4>
              <ul
                class="flex flex-col divide-y divide-line/60 rounded-xl border border-line bg-surface p-1 shadow-xs"
              >
                <JobLine
                  v-for="job in day.jobs"
                  :key="job.id"
                  :job="job"
                  :now="now"
                  :selected="selectedId === job.id"
                  @select="select"
                />
              </ul>
            </div>
            <p v-if="store.list.length >= LISTED" class="px-2 text-small text-fg-subtle">
              {{ w.t('jobs.ui.newestOnly', { n: LISTED }) }}
            </p>
          </section>
        </div>
      </div>
    </div>

    <DsDrawer
      v-if="selected"
      data-job-details
      open
      :title="w.t('jobs.ui.details')"
      :subtitle="placeOf(selected) ?? w.t('jobs.ui.wholeServer')"
      :width="layout.inspectorWidth"
      :min-width="INSPECTOR_MIN"
      :max-width="INSPECTOR_MAX"
      :resize-label="w.t('documents.inspector.resize')"
      :close-label="w.t('jobs.ui.closeDetails')"
      :overlay="layout.inspectorOverlay"
      @close="selectedId = null"
      @update:width="layout.setInspectorWidth"
    >
      <div class="h-full overflow-auto">
        <JobDetails :job="selected" :now="now" @cancel="cancel" />
      </div>
    </DsDrawer>
  </section>
</template>
