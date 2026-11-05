<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { CirclePause, CirclePlay, Layers, MapPin, Plus, RotateCw, Trash2 } from 'lucide-vue-next'
import type { ZonesView } from '@mongo-manager/shared/browser'
import DsBadge from '@/ds/DsBadge.vue'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsCard from '@/ds/DsCard.vue'
import DsChip from '@/ds/DsChip.vue'
import DsDataTable from '@/ds/DsDataTable.vue'
import DsIconButton from '@/ds/DsIconButton.vue'
import DsInput from '@/ds/DsInput.vue'
import DsSelect from '@/ds/DsSelect.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import DsTextarea from '@/ds/DsTextarea.vue'
import type { DsColumn } from '@/ds/table'
import { serverApi, serverKeys } from '@/api/server'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import { adminErrorText } from '@/dbaccess/errors'
import ChunkDistribution from './ChunkDistribution.vue'
import ShardingPanel from './ShardingPanel.vue'
import ShardCollectionSheet from './ShardCollectionSheet.vue'

/**
 * W3.2: the Sharding section of a mongos connection — the balancer (on, off, its window), how the
 * chunks lie across the shards, the zones (shards in each, key ranges), and "Shard a collection".
 * Changes need databases:admin and a connection that is not read-only; the cluster overview (shards,
 * routers, collections) stays below for everyone who may watch the server.
 */
const props = defineProps<{ connectionId: string; canManage: boolean; readOnly: boolean }>()
const { t } = useI18n()
const dialogs = useDialogStore()
const toasts = useToastStore()
const queryClient = useQueryClient()
const manage = computed(() => props.canManage && !props.readOnly)

const overview = useQuery({
  queryKey: computed(() => serverKeys.sharding(props.connectionId, '')),
  queryFn: () => serverApi.sharding(props.connectionId, ''),
  refetchInterval: 30_000,
  retry: false,
})
const view = computed(() => overview.data.value ?? null)
const zones = useQuery({
  queryKey: computed(() => serverKeys.zones(props.connectionId)),
  queryFn: () => serverApi.zones(props.connectionId),
  enabled: computed(() => props.canManage),
  retry: false,
})
const refresh = () =>
  queryClient.invalidateQueries({ queryKey: ['connections', props.connectionId, 'server', 'sharding'] })
const busy = ref(false)
async function run(work: () => Promise<unknown>, done: string): Promise<boolean> {
  busy.value = true
  try {
    await work()
    toasts.push({ kind: 'success', message: done })
    await refresh()
    return true
  } catch (e) {
    toasts.push({ kind: 'error', message: adminErrorText(e, t) })
    return false
  } finally {
    busy.value = false
  }
}

// The balancer.
const balancer = computed(() => view.value?.balancer ?? null)
const balancerOn = computed(() => balancer.value !== null && balancer.value.mode !== 'off')
async function toggleBalancer(): Promise<void> {
  if (balancerOn.value) {
    const ok = await dialogs.confirm({
      title: t('shardingAdmin.balancer.stopTitle'),
      message: t('shardingAdmin.balancer.stopMessage'),
      confirmLabel: t('shardingAdmin.balancer.stop'),
      danger: true,
    })
    if (!ok) return
    await run(() => serverApi.balancer(props.connectionId, 'stop'), t('shardingAdmin.balancer.stopped'))
  } else await run(() => serverApi.balancer(props.connectionId, 'start'), t('shardingAdmin.balancer.started'))
}
const windowStart = ref('')
const windowStop = ref('')
watch(
  () => balancer.value?.window,
  (w) => {
    windowStart.value = w?.start ?? ''
    windowStop.value = w?.stop ?? ''
  },
  { immediate: true },
)
const windowValid = computed(
  () => /^\d\d:\d\d$/.test(windowStart.value) && /^\d\d:\d\d$/.test(windowStop.value),
)
const saveWindow = () =>
  run(
    () => serverApi.balancerWindow(props.connectionId, { start: windowStart.value, stop: windowStop.value }),
    t('shardingAdmin.balancer.windowSaved'),
  )
const clearWindow = () =>
  run(() => serverApi.balancerWindow(props.connectionId, null), t('shardingAdmin.balancer.windowCleared'))

// Zones.
const newZone = ref<Record<string, string>>({})
async function addShardZone(shard: string): Promise<void> {
  const zone = (newZone.value[shard] ?? '').trim()
  if (!zone) return
  if (
    await run(
      () => serverApi.zoneShard(props.connectionId, { shard, zone, action: 'add' }),
      t('shardingAdmin.zones.added', { shard, zone }),
    )
  )
    newZone.value = { ...newZone.value, [shard]: '' }
}
async function removeShardZone(shard: string, zone: string): Promise<void> {
  const ok = await dialogs.confirm({
    title: t('shardingAdmin.zones.removeTitle', { shard, zone }),
    message: t('shardingAdmin.zones.removeMessage', { shard, zone }),
    confirmLabel: t('shardingAdmin.zones.remove'),
    danger: true,
  })
  if (ok)
    await run(
      () => serverApi.zoneShard(props.connectionId, { shard, zone, action: 'remove' }),
      t('shardingAdmin.zones.removed', { shard, zone }),
    )
}
type Range = ZonesView['ranges'][number]
const rangeColumns = computed<DsColumn[]>(() => [
  { key: 'ns', label: t('shardingAdmin.zones.ns'), mono: true, width: '24%' },
  { key: 'min', label: t('shardingAdmin.zones.min'), mono: true },
  { key: 'max', label: t('shardingAdmin.zones.max'), mono: true },
  { key: 'zone', label: t('shardingAdmin.zones.zone'), width: '8rem' },
])
const range = ref({ ns: '', min: '', max: '', zone: '' })
const shardedNs = computed(() => (view.value?.collections ?? []).map((c) => c.ns))
const nsOptions = computed(() => [
  { value: '', label: t('shardingAdmin.zones.chooseNs') },
  ...shardedNs.value.map((ns) => ({ value: ns, label: ns })),
])
const zoneOptions = computed(() => [
  { value: '', label: t('shardingAdmin.zones.chooseZone') },
  ...(zones.data.value?.zones ?? []).map((z) => ({ value: z, label: z })),
])
// A chosen collection fills the bounds with its key's fields, MinKey to MaxKey.
watch(
  () => range.value.ns,
  (ns) => {
    const key = view.value?.collections.find((c) => c.ns === ns)?.key
    if (!key) return
    const bound = (k: string) =>
      JSON.stringify(Object.fromEntries(Object.keys(key).map((f) => [f, { [k]: 1 }])))
    range.value.min = bound('$minKey')
    range.value.max = bound('$maxKey')
  },
)
const rangeReady = computed(
  () => !!(range.value.ns && range.value.min.trim() && range.value.max.trim() && range.value.zone),
)
async function addRange(): Promise<void> {
  if (!rangeReady.value) return
  const { ns, min, max, zone } = range.value
  if (
    await run(
      () => serverApi.zoneRange(props.connectionId, { ns, min: min.trim(), max: max.trim(), zone }),
      t('shardingAdmin.zones.rangeAdded', { zone }),
    )
  )
    range.value = { ns: '', min: '', max: '', zone: '' }
}
async function removeRange(r: Range): Promise<void> {
  const ok = await dialogs.confirm({
    title: t('shardingAdmin.zones.rangeRemoveTitle', { zone: r.zone }),
    message: t('shardingAdmin.zones.rangeRemoveMessage', { ns: r.ns, zone: r.zone }),
    confirmLabel: t('shardingAdmin.zones.remove'),
    danger: true,
  })
  if (ok)
    await run(
      () => serverApi.zoneRange(props.connectionId, { ns: r.ns, min: r.min, max: r.max, zone: null }),
      t('shardingAdmin.zones.rangeRemoved', { zone: r.zone }),
    )
}
const sharding = ref(false)
</script>

<template>
  <div class="flex max-w-6xl flex-col gap-4 p-4" data-sharding-admin>
    <DsCallout v-if="readOnly && canManage" tone="info">{{ t('shardingAdmin.readOnly') }}</DsCallout>
    <DsCallout v-if="overview.isError.value" tone="danger">
      {{ adminErrorText(overview.error.value, t) }}
      <template #action>
        <DsButton size="sm" :icon="RotateCw" @click="overview.refetch()">{{ t('common.retry') }}</DsButton>
      </template>
    </DsCallout>
    <div class="grid min-w-0 gap-4 lg:grid-cols-2">
      <DsCard :title="t('shardingAdmin.balancer.title')" data-balancer>
        <DsSkeleton v-if="overview.isPending.value" class="h-24" />
        <div v-else class="flex flex-col gap-4">
          <div class="flex flex-wrap items-center gap-2">
            <DsBadge v-if="balancer" :tone="balancerOn ? 'success' : 'warning'">{{
              balancerOn ? t('shardingAdmin.balancer.on') : t('shardingAdmin.balancer.off')
            }}</DsBadge>
            <DsBadge v-else tone="warning">{{ t('shardingAdmin.balancer.unknown') }}</DsBadge>
            <span v-if="balancer" class="text-small text-fg-muted">{{
              balancer.inRound ? t('sharding.inRound') : t('sharding.idle')
            }}</span>
            <DsButton
              v-if="manage && balancer"
              class="ml-auto"
              size="sm"
              :variant="balancerOn ? 'secondary' : 'primary'"
              :icon="balancerOn ? CirclePause : CirclePlay"
              :loading="busy"
              data-balancer-toggle
              @click="toggleBalancer"
              >{{
                balancerOn ? t('shardingAdmin.balancer.stop') : t('shardingAdmin.balancer.start')
              }}</DsButton
            >
          </div>
          <form class="flex flex-col gap-2" @submit.prevent="saveWindow">
            <p class="text-small font-medium text-fg-muted">{{ t('shardingAdmin.balancer.window') }}</p>
            <p class="text-small text-fg-subtle">{{ t('shardingAdmin.balancer.windowHelp') }}</p>
            <div class="flex flex-wrap items-end gap-2">
              <DsInput
                v-model="windowStart"
                class="w-32"
                size="sm"
                type="time"
                :label="t('shardingAdmin.balancer.from')"
                :disabled="!manage"
              />
              <DsInput
                v-model="windowStop"
                class="w-32"
                size="sm"
                type="time"
                :label="t('shardingAdmin.balancer.to')"
                :disabled="!manage"
              />
              <template v-if="manage">
                <DsButton size="sm" type="submit" :disabled="!windowValid" :loading="busy">{{
                  t('common.save')
                }}</DsButton>
                <DsButton v-if="balancer?.window" size="sm" variant="ghost" @click="clearWindow">{{
                  t('shardingAdmin.balancer.always')
                }}</DsButton>
              </template>
            </div>
          </form>
        </div>
      </DsCard>
      <DsCard :title="t('shardingAdmin.distribution.title')" :count="view?.collections.length">
        <template v-if="manage" #actions>
          <DsButton size="sm" variant="primary" :icon="Layers" data-shard-open @click="sharding = true">{{
            t('shardingAdmin.shard.title')
          }}</DsButton>
        </template>
        <DsSkeleton v-if="overview.isPending.value" class="h-24" />
        <ChunkDistribution v-else-if="view" :view="view" />
      </DsCard>
    </div>
    <DsCard v-if="canManage" :title="t('shardingAdmin.zones.title')" data-zones>
      <div class="flex flex-col gap-4">
        <p class="text-small text-fg-subtle">{{ t('shardingAdmin.zones.intro') }}</p>
        <DsCallout v-if="zones.isError.value" tone="danger">{{
          adminErrorText(zones.error.value, t)
        }}</DsCallout>
        <DsCallout v-for="(why, part) in zones.data.value?.refused ?? {}" :key="part" tone="warning">{{
          t('sharding.refused', { part: t(`shardingAdmin.zones.parts.${part}`) })
        }}</DsCallout>
        <ul class="grid gap-2 md:grid-cols-2">
          <li
            v-for="s in zones.data.value?.shards ?? []"
            :key="s.id"
            class="flex flex-col gap-2 rounded-lg border border-line p-3"
          >
            <span class="flex items-center gap-2 font-mono text-ui text-fg"
              ><MapPin class="size-3.5 text-fg-subtle" aria-hidden="true" />{{ s.id }}</span
            >
            <span class="flex flex-wrap gap-1.5">
              <DsChip
                v-for="z in s.zones"
                :key="z"
                :label="z"
                :removable="manage"
                :remove-label="t('shardingAdmin.zones.removeFrom', { shard: s.id, zone: z })"
                @remove="removeShardZone(s.id, z)"
              />
              <span v-if="!s.zones.length" class="text-small text-fg-subtle">{{
                t('shardingAdmin.zones.noZones')
              }}</span>
            </span>
            <form v-if="manage" class="flex items-end gap-2" @submit.prevent="addShardZone(s.id)">
              <DsInput
                :model-value="newZone[s.id] ?? ''"
                class="min-w-0 flex-1"
                size="sm"
                maxlength="64"
                :label="t('shardingAdmin.zones.addTo', { shard: s.id })"
                hide-label
                :placeholder="t('shardingAdmin.zones.zoneName')"
                @update:model-value="newZone = { ...newZone, [s.id]: $event }"
              />
              <DsButton size="sm" type="submit" :icon="Plus" :disabled="!(newZone[s.id] ?? '').trim()">{{
                t('shardingAdmin.zones.add')
              }}</DsButton>
            </form>
          </li>
        </ul>
        <section class="flex flex-col gap-2">
          <h4 class="text-small font-semibold text-fg-muted">{{ t('shardingAdmin.zones.ranges') }}</h4>
          <DsDataTable
            :label="t('shardingAdmin.zones.ranges')"
            :columns="rangeColumns"
            :rows="zones.data.value?.ranges ?? []"
            :row-key="(r: Range) => `${r.ns} ${r.min}`"
            :loading="zones.isPending.value"
            :loading-label="t('app.loading')"
            :actions-label="t('common.actions')"
          >
            <template #cell-min="{ row: r }"
              ><span class="break-all text-fg-muted">{{ r.min }}</span></template
            >
            <template #cell-max="{ row: r }"
              ><span class="break-all text-fg-muted">{{ r.max }}</span></template
            >
            <template #cell-zone="{ row: r }"
              ><DsBadge tone="info">{{ r.zone }}</DsBadge></template
            >
            <template v-if="manage" #actions="{ row: r }">
              <DsIconButton
                size="sm"
                :icon="Trash2"
                :label="t('shardingAdmin.zones.rangeRemove', { zone: r.zone, ns: r.ns })"
                @click="removeRange(r)"
              />
            </template>
            <template #empty>
              <p class="py-3 text-small text-fg-subtle">{{ t('shardingAdmin.zones.noRanges') }}</p>
            </template>
          </DsDataTable>
          <form
            v-if="manage"
            class="grid gap-2 rounded-lg bg-subtle p-3 md:grid-cols-2"
            data-zone-range
            @submit.prevent="addRange"
          >
            <DsSelect
              v-model="range.ns"
              size="sm"
              :label="t('shardingAdmin.zones.ns')"
              :options="nsOptions"
            />
            <DsSelect
              v-model="range.zone"
              size="sm"
              :label="t('shardingAdmin.zones.zone')"
              :options="zoneOptions"
            />
            <DsTextarea
              v-model="range.min"
              :rows="2"
              mono
              :label="t('shardingAdmin.zones.min')"
              :hint="t('shardingAdmin.zones.boundHint')"
            />
            <DsTextarea v-model="range.max" :rows="2" mono :label="t('shardingAdmin.zones.max')" />
            <div class="md:col-span-2">
              <DsButton size="sm" type="submit" :icon="Plus" :disabled="!rangeReady" :loading="busy">{{
                t('shardingAdmin.zones.addRange')
              }}</DsButton>
            </div>
          </form>
        </section>
      </div>
    </DsCard>
    <ShardingPanel :connection-id="connectionId" />
    <ShardCollectionSheet
      v-if="sharding"
      :connection-id="connectionId"
      :sharded="shardedNs"
      @close="sharding = false"
    />
  </div>
</template>
