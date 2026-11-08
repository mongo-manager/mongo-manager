<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { ApiError } from '@/api/client'
import { serverApi, serverKeys } from '@/api/server'
import DsBadge from '@/ds/DsBadge.vue'
import DsSpinner from '@/ds/DsSpinner.vue'
import WidgetError from './WidgetError.vue'
import WidgetLink from './WidgetLink.vue'
import { widgetError } from './errors'
import { useOpenSection } from './openSection'

/**
 * Widgets wave 2 (2026-10-27; Atlas's shard data and document charts): a sharded cluster's balance —
 * each shard's chunks and collections, the balancer, the collections out of balance and the jumbo
 * chunks. A shard is named by its id, never by its hosts.
 */
const props = defineProps<{ connectionId: string }>()
const { t } = useI18n()
const open = useOpenSection()
/** The Sharding page's own mark of a collection out of balance (more than two chunks apart). */
const OUT_OF_BALANCE = 2
const sharding = useQuery({
  queryKey: computed(() => serverKeys.sharding(props.connectionId, '')),
  queryFn: () => serverApi.sharding(props.connectionId, ''),
  // Review of wave 2 (M5): a server that is not a mongos is not asked again.
  refetchInterval: (query) => (notSharded(query.state.error) ? false : 60_000),
  retry: (n, e) => !notSharded(e) && n < 2,
})
function notSharded(e: unknown): boolean {
  return e instanceof ApiError && (e.details as { reason?: unknown } | undefined)?.reason === 'not_sharded'
}
const view = computed(() => sharding.data.value ?? null)
const outOfBalance = computed(
  () => (view.value?.collections ?? []).filter((c) => c.imbalance > OUT_OF_BALANCE).length,
)
const jumbo = computed(() => (view.value?.collections ?? []).reduce((n, c) => n + c.jumbo, 0))
const balancer = computed(() => {
  const b = view.value?.balancer
  if (!b) return null
  if (b.mode === 'off') return t('overview.shards.balancerOff')
  return b.inRound ? t('overview.shards.balancing') : t('overview.shards.idle')
})
</script>

<template>
  <div class="flex flex-col gap-3">
    <div v-if="sharding.isPending.value" class="flex items-center gap-2 py-2 text-ui text-fg-subtle">
      <DsSpinner :size="14" />{{ t('overview.status.waiting') }}
    </div>
    <p
      v-else-if="sharding.isError.value && notSharded(sharding.error.value)"
      class="py-1 text-ui text-fg-muted"
    >
      {{ t('overview.shards.notSharded') }}
    </p>
    <WidgetError
      v-else-if="sharding.isError.value"
      :text="t(`overview.errors.${widgetError(sharding.error.value)}`)"
      :retry="() => void sharding.refetch()"
    />
    <template v-else-if="view">
      <p class="flex flex-wrap gap-x-3 gap-y-1 text-small text-fg-subtle">
        <span v-if="balancer" class="font-medium text-fg">{{ balancer }}</span>
        <span :class="outOfBalance ? 'text-warning' : ''">{{
          t('overview.shards.outOfBalance', { n: outOfBalance }, outOfBalance)
        }}</span>
        <span :class="jumbo ? 'text-warning' : ''">{{
          t('overview.shards.jumbo', { n: jumbo }, jumbo)
        }}</span>
      </p>
      <ul class="-mx-1 flex flex-col">
        <li
          v-for="s in view.shards"
          :key="s.id"
          data-shard
          class="flex min-w-0 items-center gap-2.5 rounded-lg px-1 py-1.5 text-small"
        >
          <span class="min-w-0 flex-1 truncate font-mono text-fg">{{ s.id }}</span>
          <DsBadge v-if="s.draining" tone="warning">{{ t('overview.shards.draining') }}</DsBadge>
          <span class="shrink-0 text-fg-muted tabular-nums">{{
            t('overview.shards.chunks', { n: s.chunks }, s.chunks)
          }}</span>
          <span class="shrink-0 text-fg-subtle tabular-nums">{{
            t('overview.shards.collections', { n: s.collections }, s.collections)
          }}</span>
        </li>
      </ul>
    </template>
    <WidgetLink v-if="view" @open="open(connectionId, 'sharding')">{{
      t('overview.shards.seeAll')
    }}</WidgetLink>
  </div>
</template>
