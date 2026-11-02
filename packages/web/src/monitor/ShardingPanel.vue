<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { Filter, Info, Layers, RotateCw, X } from 'lucide-vue-next'
import { serverApi, serverKeys, type ShardingDetail, type ShardingView } from '@/api/server'
import { describeError } from '@/api/errors'
import { formatBytes } from '@/format'
import DsBadge from '@/ds/DsBadge.vue'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsCard from '@/ds/DsCard.vue'
import DsDataTable from '@/ds/DsDataTable.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsIconButton from '@/ds/DsIconButton.vue'
import NamespaceNameInput from '@/connections/NamespaceNameInput.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import type { DsColumn } from '@/ds/table'
/**
 * Phase 3b spec §5: a read-only overview of a sharded cluster — shards, the balancer, the mongos
 * routers and the sharded collections with their chunk spread; one collection's sizes and jumbo
 * chunks on demand. Nothing here changes the cluster. UI redesign R3 §4: two cards — the cluster
 * (figures, shards, routers) and its sharded collections — with data tables.
 */
const props = defineProps<{ connectionId: string }>()
const { t, locale } = useI18n()
const nsInput = ref('')
const ns = ref('')
const overview = useQuery({
  queryKey: computed(() => serverKeys.sharding(props.connectionId, ns.value)),
  queryFn: () => serverApi.sharding(props.connectionId, ns.value),
  refetchInterval: 30_000,
  retry: false,
})
const view = computed(() => overview.data.value ?? null)
const refused = computed(() => Object.entries(view.value?.refused ?? {}))
const detail = ref<ShardingDetail | null>(null)
const detailError = ref<string | null>(null)
const keyText = (key: Record<string, number | string>) =>
  Object.entries(key)
    .map(([f, d]) => `${f}: ${d}`)
    .join(', ')
const text = (v: unknown) => JSON.stringify(v)
const NONE = '—'
const bytes = (n: number | null) => (n === null ? NONE : formatBytes(n, locale.value))

type Shard = ShardingView['shards'][number]
type Router = ShardingView['mongos'][number]
type Collection = ShardingView['collections'][number]
type DetailShard = ShardingDetail['shards'][number]

const figures = computed(() => {
  const v = view.value
  if (!v) return []
  const b = v.balancer
  return [
    { key: 'shards', label: t('sharding.figures.shards'), value: String(v.shards.length), note: '' },
    {
      key: 'collections',
      label: t('sharding.figures.collections'),
      value: v.more ? `${v.collections.length}+` : String(v.collections.length),
      note: '',
    },
    {
      key: 'balancer',
      label: t('sharding.balancer'),
      value: b ? t('sharding.balancerMode', { mode: b.mode }) : '—',
      note: b
        ? [
            b.inRound ? t('sharding.inRound') : t('sharding.idle'),
            ...(b.window ? [t('sharding.window', { start: b.window.start, stop: b.window.stop })] : []),
          ].join(' · ')
        : '',
    },
    { key: 'routers', label: t('sharding.figures.routers'), value: String(v.mongos.length), note: '' },
  ]
})
// Review of the Monitoring redesign (I-1): on a narrow card the least needed columns leave first.
const shardColumns = computed<DsColumn[]>(() => [
  { key: 'id', label: t('sharding.shard'), mono: true, width: '22%' },
  { key: 'hosts', label: t('sharding.hosts'), mono: true },
  {
    key: 'collections',
    label: t('sharding.collectionsColumn'),
    align: 'right',
    width: '7.5rem',
    hideBelow: 520,
  },
  { key: 'chunks', label: t('sharding.chunks'), align: 'right', width: '6rem' },
  { key: 'zones', label: t('sharding.zonesColumn'), width: '18%', hideBelow: 640 },
])
const routerColumns = computed<DsColumn[]>(() => [
  { key: 'host', label: t('sharding.host'), mono: true },
  { key: 'version', label: t('sharding.version'), width: '7rem' },
  { key: 'state', label: t('sharding.state'), width: '40%' },
])
const collectionColumns = computed<DsColumn[]>(() => [
  { key: 'ns', label: t('sharding.collection'), mono: true, width: '30%' },
  { key: 'key', label: t('sharding.key'), mono: true, width: '22%' },
  { key: 'spread', label: t('sharding.spread') },
])
const detailColumns = computed<DsColumn[]>(() => [
  { key: 'shard', label: t('sharding.shard'), mono: true },
  { key: 'size', label: t('sharding.size'), align: 'right', width: '8rem' },
  { key: 'count', label: t('sharding.documentsColumn'), align: 'right', width: '9rem' },
])

async function openDetail(collection: string): Promise<void> {
  detailError.value = null
  try {
    detail.value = await serverApi.shardingDetail(props.connectionId, collection)
  } catch (e) {
    detail.value = null
    detailError.value = describeError(e, t)
  }
}
</script>

<template>
  <DsCard :title="t('sharding.title')" data-sharding>
    <div class="flex flex-col gap-3">
      <DsCallout v-if="overview.isError.value" tone="danger">
        {{ describeError(overview.error.value, t) }}
        <template #action>
          <DsButton size="sm" :icon="RotateCw" @click="overview.refetch()">{{ t('common.retry') }}</DsButton>
        </template>
      </DsCallout>
      <DsCallout v-for="[part] in refused" :key="part" tone="warning" :data-sharding-refused="part">
        {{ t('sharding.refused', { part: t(`sharding.parts.${part}`) }) }}
      </DsCallout>
      <div
        v-if="overview.isPending.value"
        class="flex flex-col gap-2"
        role="status"
        :aria-label="t('app.loading')"
      >
        <DsSkeleton class="h-14" />
        <DsSkeleton v-for="n in 3" :key="n" class="h-6" />
      </div>
      <template v-if="view">
        <dl class="flex flex-wrap gap-px overflow-hidden rounded-lg border border-line bg-line">
          <div
            v-for="item in figures"
            :key="item.key"
            class="flex min-w-32 flex-1 basis-32 flex-col gap-0.5 bg-surface px-3 py-2"
          >
            <dt class="truncate text-caption font-medium text-fg-subtle">{{ item.label }}</dt>
            <dd class="flex min-w-0 flex-col">
              <span class="truncate text-title-s font-semibold text-fg tabular-nums">{{ item.value }}</span>
              <span v-if="item.note" class="truncate text-small text-fg-muted" :title="item.note">{{
                item.note
              }}</span>
            </dd>
          </div>
        </dl>
        <div class="grid min-w-0 gap-4 xl:grid-cols-5">
          <section class="flex min-w-0 flex-col gap-1.5 xl:col-span-3">
            <h4 class="text-small font-semibold text-fg-muted">{{ t('sharding.shards') }}</h4>
            <DsDataTable
              :label="t('sharding.shards')"
              :columns="shardColumns"
              :rows="view.shards"
              :row-key="(s: Shard) => s.id"
            >
              <template #cell-id="{ row: s }">
                <span class="flex min-w-0 items-center gap-1.5">
                  <span class="truncate">{{ s.id }}</span>
                  <DsBadge v-if="s.draining" tone="warning" :data-shard-draining="s.id">{{
                    t('sharding.draining')
                  }}</DsBadge>
                </span>
              </template>
              <template #cell-hosts="{ row: s }">
                <span class="text-fg-muted" :title="s.hosts">{{ s.hosts }}</span>
              </template>
              <template #cell-zones="{ row: s }">
                <span class="text-fg-muted" :title="s.tags.join(', ')">{{
                  s.tags.length ? s.tags.join(', ') : NONE
                }}</span>
              </template>
              <template #empty>
                <p class="py-3 text-small text-fg-subtle">{{ t('sharding.noShards') }}</p>
              </template>
            </DsDataTable>
          </section>
          <section class="flex min-w-0 flex-col gap-1.5 xl:col-span-2">
            <h4 class="text-small font-semibold text-fg-muted">{{ t('sharding.mongos') }}</h4>
            <DsDataTable
              :label="t('sharding.mongos')"
              :columns="routerColumns"
              :rows="view.mongos"
              :row-key="(m: Router) => m.host"
            >
              <template #cell-host="{ row: m }">
                <span :title="m.host">{{ m.host }}</span>
              </template>
              <template #cell-version="{ row: m }">
                <span class="text-fg-muted">{{ m.version ?? '—' }}</span>
              </template>
              <template #cell-state="{ row: m }">
                <DsBadge
                  v-if="m.stale"
                  tone="warning"
                  :data-mongos-stale="m.host"
                  :title="t('sharding.stale')"
                  >{{ t('sharding.stale') }}</DsBadge
                >
                <DsBadge v-else tone="success">{{ t('sharding.alive') }}</DsBadge>
              </template>
              <template #empty>
                <p class="py-3 text-small text-fg-subtle">{{ t('sharding.noRouters') }}</p>
              </template>
            </DsDataTable>
          </section>
        </div>
      </template>
    </div>
  </DsCard>
  <DsCard
    v-if="view"
    :title="t('sharding.collectionsTitle')"
    :count="view.collections.length"
    data-sharding-collections
  >
    <div class="flex flex-col gap-3">
      <form
        class="flex flex-wrap items-end gap-3 rounded-lg bg-subtle p-3"
        data-sharding-filter
        @submit.prevent="ns = nsInput.trim()"
      >
        <!-- User report 2026-10-30: the connection's databases, then a database's collections. -->
        <NamespaceNameInput
          v-model="nsInput"
          kind="namespace"
          :connection-id="connectionId"
          class="w-full max-w-64 min-w-0 sm:w-64"
          size="sm"
          mono
          maxlength="255"
          autocomplete="off"
          :label="t('sharding.ns')"
          data-sharding-ns
        />
        <DsButton type="submit" size="sm" :icon="Filter">{{ t('sharding.apply') }}</DsButton>
      </form>
      <DsDataTable
        :label="t('sharding.collectionsTitle')"
        :columns="collectionColumns"
        :rows="view.collections"
        :row-key="(c: Collection) => c.ns"
        :current="detail?.ns"
        :actions-label="t('sharding.details')"
      >
        <template #cell-ns="{ row: c }">
          <span class="flex min-w-0 items-center gap-1.5">
            <span class="truncate" :title="c.ns">{{ c.ns }}</span>
            <DsBadge v-if="c.unique">{{ t('sharding.unique') }}</DsBadge>
            <DsBadge v-if="!c.balancing" tone="warning">{{ t('sharding.notBalancing') }}</DsBadge>
          </span>
        </template>
        <template #cell-key="{ row: c }">
          <span :title="keyText(c.key)">{{ keyText(c.key) }}</span>
        </template>
        <template #cell-spread="{ row: c }">
          <span class="flex min-w-0 items-center gap-2">
            <span class="min-w-0 truncate font-mono text-[12.5px] text-fg-muted">
              <span v-for="(n, shard) in c.chunks" :key="shard" class="mr-2">{{ shard }}: {{ n }}</span>
            </span>
            <DsBadge :tone="c.imbalance > 2 ? 'warning' : 'neutral'">{{
              t('sharding.imbalance', { n: c.imbalance })
            }}</DsBadge>
            <DsBadge v-if="c.jumbo" tone="danger">{{ t('sharding.jumbo', { n: c.jumbo }) }}</DsBadge>
          </span>
        </template>
        <template #actions="{ row: c }">
          <DsIconButton
            size="sm"
            :icon="Info"
            :label="t('sharding.detailsOf', { ns: c.ns })"
            :data-sharding-detail="c.ns"
            @click="openDetail(c.ns)"
          />
        </template>
        <template #empty>
          <DsEmptyState :icon="Layers" :title="t('sharding.noCollections')" />
        </template>
      </DsDataTable>
      <DsCallout v-if="view.more" tone="info">{{ t('sharding.more') }}</DsCallout>
      <DsCallout v-if="detailError" tone="danger">{{ detailError }}</DsCallout>
      <section
        v-if="detail"
        class="flex flex-col gap-2 rounded-lg border border-line bg-subtle p-3"
        data-sharding-details
      >
        <div class="flex items-center gap-2">
          <h4 class="min-w-0 flex-1 truncate font-mono text-ui font-semibold text-fg">{{ detail.ns }}</h4>
          <DsIconButton size="sm" :icon="X" :label="t('sharding.closeDetails')" @click="detail = null" />
        </div>
        <DsDataTable
          :label="t('sharding.detailsOf', { ns: detail.ns })"
          :columns="detailColumns"
          :rows="detail.shards"
          :row-key="(s: DetailShard) => s.shard"
        >
          <template #cell-size="{ row: s }">{{
            detail.sizesHidden ? t('overview.stats.hidden') : bytes(s.size)
          }}</template>
          <template #cell-count="{ row: s }">{{ s.count ?? '—' }}</template>
        </DsDataTable>
        <template v-if="detail.jumbo.length">
          <h5 class="mt-1 text-small font-semibold text-fg-muted">{{ t('sharding.jumboChunks') }}</h5>
          <ul class="flex flex-col gap-1">
            <li v-for="(j, i) in detail.jumbo" :key="i" class="font-mono text-[12.5px] break-all text-fg">
              {{ j.shard }}: {{ text(j.min) }} → {{ text(j.max) }}
            </li>
          </ul>
        </template>
      </section>
    </div>
  </DsCard>
</template>
