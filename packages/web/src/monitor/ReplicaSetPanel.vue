<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { RotateCw } from 'lucide-vue-next'
import LineChart from '@/charts/LineChart.vue'
import { ApiError } from '@/api/client'
import { serverApi, serverKeys, type ReplicaMember } from '@/api/server'
import { describeError } from '@/api/errors'
import { formatElapsed } from '@/jobs/elapsed'
import DsBadge from '@/ds/DsBadge.vue'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsCard from '@/ds/DsCard.vue'
import DsDataTable from '@/ds/DsDataTable.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import DsStatusDot from '@/ds/DsStatusDot.vue'
import type { DsColumn } from '@/ds/table'
import ShardingPanel from './ShardingPanel.vue'

/**
 * Phase 1j spec §3: which member is primary, which are down, and how far behind each is. Polled
 * every 5 s while shown; the lag chart keeps the last 150 polls (12.5 minutes). UI redesign R3 §4:
 * a card with the set's figures, the members as a data table (state as a status dot with its words,
 * lag as a badge in the threshold's tone) and the lag chart.
 */
const props = defineProps<{ connectionId: string }>()
const { t, locale } = useI18n()

/** Shown where there is no value (no lag for an arbiter, no heartbeat to itself). */
const NONE = '—'
const HISTORY = 150
const WARN_S = 10
const BAD_S = 60

const query = useQuery({
  queryKey: serverKeys.replica(props.connectionId),
  queryFn: () => serverApi.replica(props.connectionId),
  refetchInterval: 5_000,
  retry: false,
})
const data = computed(() => query.data.value ?? null)
const set = computed(() => (data.value?.mode === 'replicaSet' ? data.value : null))

const refused = computed(() => {
  const e = query.error.value
  return (
    e instanceof ApiError && (e.details as { reason?: unknown } | undefined)?.reason === 'mongo_not_permitted'
  )
})

type Tone = 'primary' | 'secondary' | 'arbiter' | 'down' | 'other'
function tone(m: ReplicaMember): Tone {
  if (!m.healthy) return 'down'
  if (m.state === 'PRIMARY') return 'primary'
  if (m.state === 'SECONDARY') return 'secondary'
  if (m.arbiter) return 'arbiter'
  return 'other'
}
/** The dot's colour per state: a member that serves (primary, secondary) is the live colour. */
const DOTS: Record<Tone, 'connected' | 'connecting' | 'error' | 'idle'> = {
  primary: 'connected',
  secondary: 'connected',
  arbiter: 'idle',
  down: 'error',
  other: 'connecting',
}

const lagLevel = (lag: number | null) =>
  lag === null ? 'none' : lag > BAD_S ? 'bad' : lag > WARN_S ? 'warn' : 'ok'
const LAG_TONES = { ok: 'neutral', warn: 'warning', bad: 'danger', none: 'neutral' } as const

// "3 s ago" stays current between polls; heartbeats are seconds apart, so every 5 s is enough.
const now = ref(Date.now())
const ticker = setInterval(() => (now.value = Date.now()), 5_000)
onBeforeUnmount(() => clearInterval(ticker))
const ago = (iso: string | null) =>
  iso ? t('replica.ago', { time: formatElapsed(now.value - Date.parse(iso), locale.value) }) : NONE

// A failed poll leaves the last answer on screen, marked as such: it is not the current state.
const stale = computed(() => set.value !== null && query.isError.value)
const answeredAt = computed(() => new Date(query.dataUpdatedAt.value).toISOString())

// Lag history per data-bearing member; a member that was down, or a poll that failed, is a gap.
const history = ref<Record<string, Array<number | null>>>({})
watch(
  () => query.errorUpdatedAt.value,
  (at) => {
    if (!at) return
    history.value = Object.fromEntries(
      Object.entries(history.value).map(([name, points]) => [name, [...points, null].slice(-HISTORY)]),
    )
  },
)
watch(
  () => query.dataUpdatedAt.value,
  () => {
    const s = set.value
    if (!s) return
    const next: Record<string, Array<number | null>> = {}
    for (const m of s.members.filter((x) => !x.arbiter)) {
      next[m.name] = [...(history.value[m.name] ?? []), m.lagSeconds].slice(-HISTORY)
    }
    history.value = next
  },
  { immediate: true },
)
const lagSeries = computed(() => Object.entries(history.value).map(([name, points]) => ({ name, points })))
const seconds = (v: number) => t('performance.seconds', { n: v })

const summary = computed(() => {
  const s = set.value
  if (!s) return []
  return [
    { key: 'set', label: t('replica.set'), value: s.set, mono: true },
    ...(s.primary
      ? [{ key: 'primary', label: t('replica.primaryLabel'), value: s.primary, mono: true }]
      : []),
    {
      key: 'majority',
      label: t('replica.majorityLag'),
      value: s.majorityLagSeconds === null ? NONE : seconds(s.majorityLagSeconds),
      mono: false,
    },
    {
      key: 'oplog',
      label: t('replica.oplogWindow'),
      value: s.oplogWindowHours === null ? NONE : t('replica.hours', { n: s.oplogWindowHours }),
      mono: false,
    },
  ]
})
// Review of the Monitoring redesign (I-1): on a narrow card the least needed columns leave first.
// The state's dot and words stay; health is said by the state's words where its column has left.
const columns = computed<DsColumn[]>(() => [
  { key: 'member', label: t('replica.columns.member'), mono: true },
  { key: 'state', label: t('replica.columns.state'), width: '10rem' },
  { key: 'health', label: t('replica.columns.health'), width: '5.5rem', hideBelow: 480 },
  { key: 'lag', label: t('replica.columns.lag'), align: 'right', width: '6rem' },
  { key: 'ping', label: t('replica.columns.ping'), align: 'right', width: '5.5rem', hideBelow: 560 },
  { key: 'heartbeat', label: t('replica.columns.heartbeat'), width: '8rem', hideBelow: 680 },
  { key: 'syncSource', label: t('replica.columns.syncSource'), mono: true, hideBelow: 800 },
  { key: 'priority', label: t('replica.columns.priority'), align: 'right', width: '5.5rem', hideBelow: 900 },
])
</script>

<template>
  <!-- Phase 3b §5: a mongos shows the sharding overview instead. -->
  <ShardingPanel v-if="data?.mode === 'sharded'" :connection-id="connectionId" />
  <DsCard
    v-else
    :title="t('replica.title')"
    :count="set?.members.length"
    data-replica
    :data-stale="stale ? '' : undefined"
  >
    <div class="flex flex-col gap-3">
      <DsCallout v-if="refused" tone="danger">{{ t('performance.errors.NOT_PERMITTED') }}</DsCallout>
      <DsCallout v-else-if="query.isError.value" tone="danger">
        {{ describeError(query.error.value, t) }}
        <template #action>
          <DsButton size="sm" :icon="RotateCw" @click="query.refetch()">{{ t('common.retry') }}</DsButton>
        </template>
      </DsCallout>
      <div
        v-if="query.isPending.value"
        class="flex flex-col gap-2"
        role="status"
        :aria-label="t('app.loading')"
      >
        <DsSkeleton class="h-12" />
        <DsSkeleton v-for="n in 3" :key="n" class="h-6" />
      </div>
      <DsCallout v-else-if="data?.mode === 'standalone'" tone="info">{{ t('replica.standalone') }}</DsCallout>
      <template v-if="set">
        <DsCallout v-if="stale" tone="warning">{{ t('replica.stale', { time: ago(answeredAt) }) }}</DsCallout>
        <DsCallout v-if="!set.primary" tone="danger">{{ t('replica.noPrimary') }}</DsCallout>
        <dl class="flex flex-wrap gap-px overflow-hidden rounded-lg border border-line bg-line">
          <div
            v-for="item in summary"
            :key="item.key"
            class="flex min-w-32 flex-1 basis-32 flex-col gap-0.5 bg-surface px-3 py-2"
          >
            <dt class="truncate text-caption font-medium text-fg-subtle">{{ item.label }}</dt>
            <dd
              class="truncate text-title-s font-semibold text-fg tabular-nums"
              :class="item.mono ? 'font-mono text-[13px]' : ''"
              :title="item.value"
            >
              {{ item.value }}
            </dd>
          </div>
        </dl>
        <DsDataTable
          :label="t('replica.caption', { set: set.set })"
          :columns="columns"
          :rows="set.members"
          :row-key="(m: ReplicaMember) => m.name"
        >
          <template #cell-member="{ row: m }">
            <span class="flex min-w-0 items-center gap-1.5" :data-member="m.name">
              <span class="truncate" :title="m.name">{{ m.name }}</span>
              <DsBadge v-if="m.self" tone="accent">{{ t('replica.self') }}</DsBadge>
              <DsBadge v-if="m.hidden">{{ t('replica.hidden') }}</DsBadge>
            </span>
          </template>
          <template #cell-state="{ row: m }">
            <span class="flex min-w-0 items-center gap-2" :data-tone="tone(m)">
              <DsStatusDot :state="DOTS[tone(m)]" :label="m.state" />
              <!-- The dot says the state to a screen reader; the words are for the eye. -->
              <span
                class="truncate text-small font-medium"
                :class="tone(m) === 'down' ? 'text-danger' : 'text-fg'"
                aria-hidden="true"
                :title="m.lastHeartbeatMessage ?? m.state"
                >{{ m.state }}</span
              >
            </span>
            <span v-if="m.lastHeartbeatMessage" class="sr-only">{{ m.lastHeartbeatMessage }}</span>
          </template>
          <template #cell-health="{ row: m }">
            <span data-health :class="m.healthy ? 'text-fg-muted' : 'font-semibold text-danger'">{{
              m.healthy ? t('replica.up') : t('replica.down')
            }}</span>
          </template>
          <template #cell-lag="{ row: m }">
            <span :data-lag="lagLevel(m.lagSeconds)">
              <template v-if="m.lagSeconds === null">{{ NONE }}</template>
              <DsBadge v-else :tone="LAG_TONES[lagLevel(m.lagSeconds)]">{{ seconds(m.lagSeconds) }}</DsBadge>
            </span>
          </template>
          <template #cell-ping="{ row: m }">
            <span class="text-fg-muted">{{
              m.pingMs === null ? NONE : t('performance.milliseconds', { n: m.pingMs })
            }}</span>
          </template>
          <template #cell-heartbeat="{ row: m }">
            <span class="text-fg-muted">{{ ago(m.lastHeartbeat) }}</span>
          </template>
          <template #cell-syncSource="{ row: m }">
            <span class="text-fg-muted" :title="m.syncSource ?? undefined">{{ m.syncSource ?? NONE }}</span>
          </template>
          <template #cell-priority="{ row: m }">
            <span class="text-fg-muted">{{ m.priority ?? NONE }}</span>
          </template>
        </DsDataTable>
        <ul
          v-if="set.members.some((m) => m.lastHeartbeatMessage)"
          class="flex flex-col gap-1"
          aria-hidden="true"
        >
          <li
            v-for="m in set.members.filter((x) => x.lastHeartbeatMessage)"
            :key="m.name"
            class="text-small break-words text-danger"
          >
            <span class="font-mono">{{ m.name }}</span
            >: {{ m.lastHeartbeatMessage }}
          </li>
        </ul>
        <div class="border-t border-line pt-3">
          <LineChart :label="t('replica.lagChart')" :series="lagSeries" :format="seconds" />
        </div>
      </template>
    </div>
  </DsCard>
</template>
