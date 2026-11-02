<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import type { CompareReport } from '@mongo-manager/shared/browser'
import { Clock, GitCompareArrows } from 'lucide-vue-next'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsCard from '@/ds/DsCard.vue'
import DsDataTable from '@/ds/DsDataTable.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsPageHeader from '@/ds/DsPageHeader.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import type { DsColumn } from '@/ds/table'
import { ApiError } from '@/api/client'
import { describeError } from '@/api/errors'
import { connectionsApi, queryKeys } from '@/api/connections'
import { transferApi, transferKeys } from '@/api/transfer'
import { formatCount } from '@/format'
import SyncDialog from './SyncDialog.vue'
import CompareSamples from './CompareSamples.vue'
import { samplesOf, type SampleSet } from './compareSamples'

/** Phase 3d-2 spec §3.2: a comparison's results as a workspace tab — counts, samples, field diffs. */
const props = defineProps<{ jobId: string }>()
const { t, locale } = useI18n()
const n = (v: number) => formatCount(v, locale.value)

const { data, error, isPending } = useQuery({
  queryKey: computed(() => transferKeys.report(props.jobId)),
  queryFn: () => transferApi.report(props.jobId),
  retry: false,
})
const report = computed<CompareReport | null>(() => (data.value?.kind === 'compare' ? data.value : null))
const expired = computed(() => error.value instanceof ApiError && error.value.status === 404)
const { data: connections } = useQuery({
  queryKey: queryKeys.connections,
  queryFn: () => connectionsApi.list(),
})
const connectionName = (id: string) => (connections.value ?? []).find((c) => c.id === id)?.name ?? id
const side = (s: CompareReport['source']) =>
  `${connectionName(s.connectionId)} · ${s.db}${s.coll ? `.${s.coll}` : ''}`

type Group = 'onlySource' | 'onlyTarget' | 'different' | 'same'
const GROUPS: Group[] = ['onlySource', 'onlyTarget', 'different', 'same']
type CompareCollection = CompareReport['collections'][number]
const DOT: Record<Group, string> = {
  onlySource: 'bg-info',
  onlyTarget: 'bg-warning',
  different: 'bg-danger',
  same: 'bg-success',
}
const columns = computed<DsColumn[]>(() => [
  { key: 'source', label: t('dataTransfer.compare.collection') },
  ...GROUPS.map((g): DsColumn => ({
    key: g,
    label: t(`dataTransfer.compare.${g}`),
    align: 'right',
    width: '7rem',
  })),
])
const total = (g: Group) => report.value?.collections.reduce((sum, c) => sum + c[g], 0) ?? 0
const group = ref<Group | null>(null)
const shown = computed<Group>(
  () =>
    group.value ?? (['different', 'onlySource', 'onlyTarget'] as Group[]).find((g) => total(g) > 0) ?? 'same',
)

const sets = computed<SampleSet[]>(() =>
  (report.value?.collections ?? []).map((c) => ({ coll: c.source, samples: c.samples })),
)
const samples = computed(() => samplesOf(sets.value, shown.value))
const syncOpen = ref(false)
</script>

<template>
  <section class="flex h-full min-h-0 flex-col" data-compare>
    <DsPageHeader
      :title="
        report
          ? t('dataTransfer.compare.tabTitle', { source: side(report.source), target: side(report.target) })
          : t('dataTransfer.compare.start')
      "
      :icon="GitCompareArrows"
    >
      <template v-if="report" #actions>
        <DsButton variant="primary" size="sm" :disabled="!report.complete" @click="syncOpen = true">{{
          t('dataTransfer.compare.sync')
        }}</DsButton>
      </template>
    </DsPageHeader>
    <div class="min-h-0 flex-1 overflow-auto">
      <div class="mx-auto flex max-w-6xl flex-col gap-5 px-6 py-5">
        <div v-if="isPending" class="grid gap-3 sm:grid-cols-4" aria-busy="true">
          <span class="sr-only" role="status">{{ t('app.loading') }}</span>
          <DsSkeleton v-for="i in 4" :key="i" class="h-[76px] rounded-card" />
        </div>
        <DsEmptyState v-else-if="expired" :icon="Clock" :title="t('dataTransfer.compare.expired')" />
        <DsCallout v-else-if="error" tone="danger">{{ describeError(error, t) }}</DsCallout>
        <template v-else-if="report">
          <DsCallout v-if="!report.complete" tone="warning" role="status">
            {{ t('dataTransfer.compare.partial') }}
          </DsCallout>
          <DsCallout v-if="report.masked" tone="info">{{ t('dataTransfer.compare.maskedNotice') }}</DsCallout>
          <!-- The four groups: each is a count and the filter for the samples below. -->
          <div class="grid gap-3 sm:grid-cols-4" role="group" :aria-label="t('dataTransfer.compare.groups')">
            <button
              v-for="g in GROUPS"
              :key="g"
              type="button"
              :data-count="g"
              :aria-pressed="shown === g"
              class="flex cursor-pointer flex-col items-start gap-0.5 rounded-card border bg-surface p-4 text-left shadow-xs transition-[border-color,box-shadow] duration-160 hover:border-fg-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              :class="shown === g ? 'border-accent ring-3 ring-accent/15' : 'border-line'"
              @click="group = g"
            >
              <span class="text-title-l font-semibold text-fg tabular-nums">{{ n(total(g)) }}</span>
              <span class="flex items-center gap-1.5 text-small text-fg-muted">
                <span class="size-2 rounded-full" :class="DOT[g]" aria-hidden="true" />
                {{ t(`dataTransfer.compare.${g}`) }}
              </span>
            </button>
          </div>
          <DsCard
            v-if="report.collections.length > 1"
            :title="t('overview.collections')"
            :count="report.collections.length"
          >
            <DsDataTable
              :label="t('overview.collections')"
              :columns="columns"
              :rows="report.collections"
              :row-key="(c: CompareCollection) => c.source"
              dense
            >
              <template #cell-source="{ row: c }">
                <span class="block truncate font-mono" :title="c.source">{{ c.source }}</span>
                <span v-if="c.failure" class="ml-2 text-small text-danger">{{ c.failure }}</span>
              </template>
              <template v-for="g in GROUPS" :key="g" #[`cell-${g}`]="{ row: c }">{{ n(c[g]) }}</template>
            </DsDataTable>
          </DsCard>
          <DsCard :title="t(`dataTransfer.compare.${shown}`)" :count="samples.length">
            <CompareSamples :sets="sets" :group="shown" :show-coll="report.collections.length > 1" />
          </DsCard>
          <SyncDialog v-if="syncOpen" :report="report" :job-id="jobId" @close="syncOpen = false" />
        </template>
      </div>
    </div>
  </section>
</template>
