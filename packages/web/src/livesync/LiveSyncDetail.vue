<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { deserializeValue, type LiveSyncEvent } from '@mongo-manager/shared/browser'
import DsDataTable from '@/ds/DsDataTable.vue'
import DsSheet from '@/ds/DsSheet.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import LagSparkline from './LagSparkline.vue'
import CompareSamples from '@/transfer/CompareSamples.vue'
import { samplesOf, type SampleSet } from '@/transfer/compareSamples'
import type { DsColumn } from '@/ds/table'
import { liveSyncApi, liveSyncKeys } from '@/api/liveSync'
import { describeError } from '@/api/errors'
import { formatCount } from '@/format'
import { idLabel } from '@/documents/values'
import { useLiveSyncWords } from './words'
import DsCallout from '@/ds/DsCallout.vue'
import DsButton from '@/ds/DsButton.vue'
import { Download, RotateCw } from 'lucide-vue-next'

/** Spec §5: a sync's settings, its activity log, and the last verification document by document. */
const props = defineProps<{ syncId: string }>()
const emit = defineEmits<{ close: [] }>()
const { t, locale } = useI18n()
const words = useLiveSyncWords()
const detail = useQuery({
  queryKey: computed(() => liveSyncKeys.detail(props.syncId)),
  queryFn: () => liveSyncApi.get(props.syncId),
  refetchInterval: 10_000,
})
const d = computed(() => detail.data.value)
/** W4.6: the last verification's samples, read when asked (they hold documents). */
const differs = computed(
  () =>
    d.value?.verify?.state === 'done' &&
    d.value.verify.pairs.some((p) => p.different + p.onlySource + p.onlyTarget > 0),
)
const samplesWanted = ref(false)
const samples = useQuery({
  queryKey: computed(() => [...liveSyncKeys.detail(props.syncId), 'samples', d.value?.verify?.finishedAt]),
  queryFn: () => liveSyncApi.verifySamples(props.syncId),
  enabled: samplesWanted,
  retry: false,
})
const sampleSets = computed<SampleSet[]>(() =>
  (samples.data.value?.pairs ?? []).map((p) => ({ coll: p.source, samples: p.samples })),
)
const sampleGroup = ref<'different' | 'onlySource' | 'onlyTarget'>('different')
const sampleGroups = computed(() =>
  (['different', 'onlySource', 'onlyTarget'] as const).map((g) => ({
    value: g,
    label: `${t(`liveSync.detail.counts.${g}`)} (${samplesOf(sampleSets.value, g).length})`,
  })),
)
/** W4.6: the lag history, over an hour, six or a day. */
const lagMinutes = ref<'60' | '360' | '1440'>('60')
const lagPeriods = computed(() => [
  { value: '60' as const, label: t('liveSync.detail.lagHour') },
  { value: '360' as const, label: t('liveSync.detail.lagSixHours') },
  { value: '1440' as const, label: t('liveSync.detail.lagDay') },
])
const lag = useQuery({
  queryKey: computed(() => [...liveSyncKeys.detail(props.syncId), 'lag', lagMinutes.value]),
  queryFn: () => liveSyncApi.lag(props.syncId, Number(lagMinutes.value)),
  refetchInterval: 30_000,
})
const lagPoints = computed(() => lag.data.value?.points ?? [])
const lagMaxMs = computed(() => Math.max(0, ...lagPoints.value.map((p) => p.lag)))
const seconds = (ms: number) =>
  new Intl.NumberFormat(locale.value, { style: 'unit', unit: 'second', maximumFractionDigits: 1 }).format(
    ms / 1000,
  )
const n = (v: number) => formatCount(v, locale.value)
const time = (at: number) =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'medium' }).format(at)
const events = computed(() => [...(d.value?.events ?? [])].reverse())
const eventText = (e: LiveSyncEvent): string => {
  if (e.kind === 'state' && e.state) {
    const why = e.reason
      ? words.reason({ state: e.state, reason: e.reason, pausedBy: null, detail: null })
      : null
    return why ? `${words.state(e.state)} — ${why}` : words.state(e.state)
  }
  if (e.kind === 'batch' && e.counts)
    return t('liveSync.event.batch', {
      inserted: n(e.counts.inserted ?? 0),
      replaced: n(e.counts.replaced ?? 0),
      deleted: n(e.counts.deleted ?? 0),
    })
  if (e.kind === 'verify') return t('liveSync.event.verify', { detail: e.detail ?? '' })
  // W4.6: the owner's space could not hold more refused documents.
  if (e.kind === 'error' && e.detail === 'rejected_file_full') return t('liveSync.event.rejectedFull')
  // W4.6: a two-way conflict: its _id, how, and which side's change won.
  if (e.kind === 'conflict' && e.detail) {
    const parts = e.detail.split(' · ')
    const winner = parts.pop()
    const how = parts.pop() === 'differed' ? 'differed' : 'both'
    // The side named: this sync's source when its own side won, else its target.
    const side = winner === d.value?.twoWay?.side ? d.value?.source : d.value?.target
    return t(`liveSync.event.conflict.${how}`, {
      id: parts.join(' · '),
      side: side ? `${side.connectionName || t('liveSync.card.hidden')} · ${side.db}.${side.coll ?? ''}` : '',
    })
  }
  return t(`liveSync.event.${e.kind}`, { detail: e.detail ?? '' })
}
/** UI redesign R3 leftovers: the verification's counts as the kit's data table. */
const COUNTS = ['same', 'different', 'onlySource', 'onlyTarget'] as const
type Pair = NonNullable<NonNullable<typeof d.value>['verify']>['pairs'][number]
// Review of the Monitoring redesign (I-1): on a narrow card the least needed columns leave first.
const count = (k: (typeof COUNTS)[number]) => t(`liveSync.detail.counts.${k}`)
const verifyColumns = computed<DsColumn[]>(() => [
  { key: 'source', label: t('liveSync.detail.collection'), mono: true },
  { key: 'same', label: count('same'), align: 'right', width: '6.5rem' },
  { key: 'different', label: count('different'), align: 'right', width: '6.5rem' },
  { key: 'onlySource', label: count('onlySource'), align: 'right', width: '6.5rem', hideBelow: 520 },
  { key: 'onlyTarget', label: count('onlyTarget'), align: 'right', width: '6.5rem', hideBelow: 520 },
])
// Ids come as canonical EJSON (types kept): shown as the documents view shows them.
const idText = (id: unknown) => idLabel(deserializeValue(id))
const settings = computed(() =>
  d.value
    ? [
        [
          'source',
          `${d.value.source.connectionName} · ${d.value.source.coll ? `${d.value.source.db}.${d.value.source.coll}` : d.value.source.db}`,
        ],
        [
          'target',
          `${d.value.target.connectionName} · ${d.value.target.coll ? `${d.value.target.db}.${d.value.target.coll}` : d.value.target.db}`,
        ],
        ['startMode', t(`liveSync.startMode.${d.value.startMode}`)],
        ['errorPolicy', t(`liveSync.errorPolicy.${d.value.errorPolicy}`)],
        ['followNew', t(d.value.followNew ? 'liveSync.detail.followNewOn' : 'liveSync.detail.followNewOff')],
        [
          'masked',
          t(
            d.value.anonymous
              ? 'liveSync.detail.anonymous'
              : d.value.masked
                ? 'liveSync.detail.masked'
                : 'liveSync.detail.unmasked',
          ),
        ],
        ...(d.value.filter ? [['filter', JSON.stringify(d.value.filter)]] : []),
        ['created', time(d.value.createdAt)],
      ]
    : [],
)
</script>

<template>
  <DsSheet
    open
    :title="d?.name ?? t('liveSync.detail.title')"
    :subtitle="t('liveSync.detail.subtitle')"
    @close="emit('close')"
  >
    <DsCallout v-if="detail.isError.value" tone="danger">
      {{ describeError(detail.error.value, t) }}
      <template #action>
        <DsButton size="sm" :icon="RotateCw" @click="detail.refetch()">{{ t('common.retry') }}</DsButton>
      </template>
    </DsCallout>
    <div v-else-if="d" class="flex flex-col gap-6">
      <section>
        <h3 class="mb-2 text-ui font-semibold text-fg">
          {{ t('liveSync.detail.settings') }}
        </h3>
        <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-ui">
          <template v-for="[k, v] in settings" :key="k">
            <dt class="text-fg-subtle">{{ t(`liveSync.detail.field.${k}`) }}</dt>
            <dd class="min-w-0 break-words text-fg">{{ v }}</dd>
          </template>
        </dl>
      </section>
      <section v-if="d.verify && d.verify.state !== 'running'">
        <h3 class="mb-2 text-ui font-semibold text-fg">
          {{ t('liveSync.detail.verify') }}
        </h3>
        <p v-if="d.verify.error" class="mb-2 text-small text-warning">
          {{
            t(`liveSync.detail.verifyError.${d.verify.error === 'not_settled' ? 'notSettled' : 'other'}`, {
              error: d.verify.error,
            })
          }}
        </p>
        <DsDataTable
          dense
          :label="t('liveSync.detail.verify')"
          :columns="verifyColumns"
          :rows="d.verify.pairs"
          :row-key="(p: Pair) => p.source"
        >
          <template #cell-source="{ row: p }">
            <span :title="p.source">{{ p.source }}</span>
          </template>
          <template v-for="k in COUNTS" :key="k" #[`cell-${k}`]="{ row: p }">{{ n(p[k]) }}</template>
        </DsDataTable>
        <template v-for="p in d.verify.pairs" :key="`ids-${p.source}`">
          <p v-if="p.ids.length" class="mt-2 text-small text-fg-muted">
            {{ t('liveSync.detail.differentIds', { name: p.source }) }}
            <span class="font-mono">{{ p.ids.map(idText).join(', ') }}</span>
          </p>
          <p v-if="p.unsettled" class="mt-1 text-small text-fg-subtle">
            {{ t('liveSync.detail.unsettled', { n: n(p.unsettled) }) }}
          </p>
        </template>
        <!-- W4.6: the samples and field changes, as the compare view shows them (the owner's only). -->
        <div v-if="d.mine && differs" class="mt-3 flex flex-col gap-3" data-test="verify-samples">
          <DsButton v-if="!samplesWanted" size="sm" class="self-start" @click="samplesWanted = true">{{
            t('liveSync.detail.showSamples')
          }}</DsButton>
          <template v-else>
            <DsCallout v-if="samples.isError.value" tone="warning">
              {{ describeError(samples.error.value, t) }}
            </DsCallout>
            <template v-else-if="samples.data.value">
              <DsSegmented
                v-model="sampleGroup"
                :label="t('liveSync.detail.sampleGroup')"
                :options="sampleGroups"
              />
              <CompareSamples :sets="sampleSets" :group="sampleGroup" :show-coll="sampleSets.length > 1" />
            </template>
          </template>
        </div>
      </section>
      <!-- W4.6: the lag history the server keeps, over the period chosen. -->
      <section data-test="lag-history">
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 class="text-ui font-semibold text-fg">{{ t('liveSync.detail.lag') }}</h3>
          <DsSegmented v-model="lagMinutes" :label="t('liveSync.detail.lagPeriod')" :options="lagPeriods" />
        </div>
        <LagSparkline v-if="lagPoints.length > 1" :points="lagPoints" :height="96" />
        <p v-else class="text-small text-fg-subtle">{{ t('liveSync.detail.lagNone') }}</p>
        <p v-if="lagPoints.length > 1" class="mt-1 text-small text-fg-muted">
          {{ t('liveSync.detail.lagMax', { s: seconds(lagMaxMs) }) }}
        </p>
      </section>
      <!-- W4.6: what the target refused under "skip and record", for the owner to download. -->
      <section v-if="d.mine && d.errorPolicy === 'skip' && d.counters.skipped > 0" data-test="rejected">
        <h3 class="mb-2 text-ui font-semibold text-fg">{{ t('liveSync.detail.rejected') }}</h3>
        <p class="mb-2 text-ui text-fg-muted">
          {{ t('liveSync.detail.rejectedHelp', { n: n(d.counters.skipped) }) }}
        </p>
        <a
          :href="liveSyncApi.rejectedUrl(d.id)"
          class="inline-flex items-center gap-1.5 text-ui font-medium text-accent-fg underline hover:no-underline"
          download
          ><Download class="size-4" aria-hidden="true" />{{ t('liveSync.detail.rejectedDownload') }}</a
        >
      </section>
      <section>
        <h3 class="mb-2 text-ui font-semibold text-fg">
          {{ t('liveSync.detail.activity') }}
        </h3>
        <ol class="flex flex-col gap-2 text-ui">
          <li v-for="(e, i) in events" :key="i" class="flex gap-3">
            <time
              class="w-40 shrink-0 text-small tabular-nums text-fg-subtle"
              :datetime="new Date(e.at).toISOString()"
              >{{ time(e.at) }}</time
            >
            <span class="min-w-0 break-words text-fg">{{ eventText(e) }}</span>
          </li>
        </ol>
      </section>
    </div>
  </DsSheet>
</template>
