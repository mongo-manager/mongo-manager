<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import type { LatencyOfKind } from '@mongo-manager/shared/browser'
import { serverApi, serverKeys } from '@/api/server'
import DsSpinner from '@/ds/DsSpinner.vue'
import WidgetError from './WidgetError.vue'
import WidgetLink from './WidgetLink.vue'
import { widgetError } from './errors'
import { useOpenSection } from './openSection'

/**
 * Widgets wave 2 (2026-10-27; Atlas Namespace Insights): the busiest collections' read and write
 * latency — average and the 95th percentile's bucket — since the server started.
 */
const props = defineProps<{ connectionId: string }>()
const { t, locale } = useI18n()
const open = useOpenSection()
const latency = useQuery({
  queryKey: computed(() => serverKeys.collectionLatency(props.connectionId)),
  queryFn: () => serverApi.collectionLatency(props.connectionId),
  refetchInterval: 60_000,
})
const ms = (n: number) =>
  t('overview.latency.ms', { n: new Intl.NumberFormat(locale.value, { maximumFractionDigits: 2 }).format(n) })
function said(k: LatencyOfKind | null): { avg: string; p95: string | null } {
  if (!k) return { avg: t('overview.latency.unknown'), p95: null }
  if (!k.ops || k.avgMs === null) return { avg: '—', p95: null }
  return { avg: ms(k.avgMs), p95: k.p95Ms === null ? null : t('overview.latency.p95', { ms: ms(k.p95Ms) }) }
}
const rows = computed(() =>
  (latency.data.value?.collections ?? []).map((c) => ({
    ns: c.ns,
    reads: said(c.reads),
    writes: said(c.writes),
  })),
)
</script>

<template>
  <div class="flex flex-col gap-2">
    <div v-if="latency.isPending.value" class="flex items-center gap-2 py-2 text-ui text-fg-subtle">
      <DsSpinner :size="14" />{{ t('overview.status.waiting') }}
    </div>
    <WidgetError
      v-else-if="latency.isError.value"
      :text="t(`overview.errors.${widgetError(latency.error.value)}`)"
      :retry="() => void latency.refetch()"
    />
    <p v-else-if="!rows.length" class="py-1 text-small text-fg-subtle">{{ t('overview.top.none') }}</p>
    <table v-else class="w-full table-fixed text-small">
      <thead>
        <tr class="text-left text-caption text-fg-subtle">
          <th scope="col" class="w-2/5 py-1 font-medium">{{ t('overview.latency.collection') }}</th>
          <th scope="col" class="py-1 font-medium">{{ t('overview.latency.reads') }}</th>
          <th scope="col" class="py-1 font-medium">{{ t('overview.latency.writes') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.ns" data-latency class="border-t border-line align-top">
          <th scope="row" class="truncate py-1.5 pr-2 text-left font-mono font-normal text-fg">{{ r.ns }}</th>
          <td v-for="(k, i) in [r.reads, r.writes]" :key="i" class="py-1.5 tabular-nums">
            <span class="block text-fg">{{ k.avg }}</span>
            <span v-if="k.p95" class="block text-caption text-fg-subtle">{{ k.p95 }}</span>
          </td>
        </tr>
      </tbody>
    </table>
    <WidgetLink @open="open(connectionId, 'performance')">{{ t('overview.operations.seeAll') }}</WidgetLink>
  </div>
</template>
