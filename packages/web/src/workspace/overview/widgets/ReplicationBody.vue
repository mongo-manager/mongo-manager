<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { serverApi, serverKeys } from '@/api/server'
import DsSpinner from '@/ds/DsSpinner.vue'
import { formatBytes, formatRelative } from '@/format'
import WidgetError from './WidgetError.vue'
import { widgetError } from './errors'

/**
 * Widgets wave 2 (2026-10-27; Atlas's replication headroom and oplog GB/hour, PMM's ReplSet summary):
 * how long each secondary may fall further behind before it needs a full resync — the oplog window
 * less its lag — how fast the oplog fills, and when the primary was elected.
 */
const props = defineProps<{ connectionId: string }>()
const { t, locale } = useI18n()
const HOUR = 3600
const replica = useQuery({
  queryKey: computed(() => serverKeys.replica(props.connectionId)),
  queryFn: () => serverApi.replica(props.connectionId),
  refetchInterval: 30_000,
})
const set = computed(() => (replica.data.value?.mode === 'replicaSet' ? replica.data.value : null))
/** Red under an hour, amber under a day. */
type Level = 'ok' | 'short' | 'low' | 'unknown'
const level = (hours: number): Level => (hours < 1 ? 'low' : hours < 24 ? 'short' : 'ok')
function duration(hours: number): string {
  const minutes = Math.max(0, Math.round(hours * 60))
  if (minutes < 60) return t('overview.status.minutes', { m: minutes })
  const h = Math.floor(minutes / 60)
  if (h >= 48) return t('overview.status.daysHours', { d: Math.floor(h / 24), h: h % 24 })
  const m = minutes % 60
  return m ? t('overview.status.hoursMinutes', { h, m }) : t('overview.replication.hours', { h })
}
const secondaries = computed(() =>
  (set.value?.members ?? [])
    .filter((m) => m.state !== 'PRIMARY' && !m.arbiter)
    .map((m) => {
      const window = set.value?.oplogWindowHours ?? null
      const hours =
        m.healthy && m.lagSeconds !== null && window !== null ? window - m.lagSeconds / HOUR : null
      return {
        name: m.name,
        level: hours === null ? ('unknown' as const) : level(hours),
        text: hours === null ? t('overview.replication.unknown') : duration(hours),
      }
    }),
)
const MB = 1024 ** 2
const oplog = computed(() => {
  const o = set.value?.oplog
  if (!o) return null
  return {
    use: t('overview.replication.use', {
      used: formatBytes(o.usedMb * MB, locale.value),
      max: formatBytes(o.maxMb * MB, locale.value),
    }),
    rate:
      o.gbPerHour === null
        ? null
        : t('overview.replication.rate', {
            n: new Intl.NumberFormat(locale.value, { maximumFractionDigits: 2 }).format(o.gbPerHour),
          }),
  }
})
const elected = computed(() =>
  set.value?.lastElection
    ? t('overview.replication.elected', {
        when: formatRelative(Date.parse(set.value.lastElection) - Date.now(), locale.value),
      })
    : null,
)
const TONE = { ok: 'text-fg', short: 'text-warning', low: 'text-danger', unknown: 'text-fg-subtle' } as const
</script>

<template>
  <div class="flex flex-col gap-3">
    <div v-if="replica.isPending.value" class="flex items-center gap-2 py-2 text-ui text-fg-subtle">
      <DsSpinner :size="14" />{{ t('overview.status.waiting') }}
    </div>
    <WidgetError
      v-else-if="replica.isError.value"
      :text="t(`overview.errors.${widgetError(replica.error.value)}`)"
      :retry="() => void replica.refetch()"
    />
    <p v-else-if="!set" class="text-ui text-fg-muted">
      {{
        replica.data.value?.mode === 'sharded'
          ? t('overview.replica.sharded')
          : t('overview.replica.standalone')
      }}
    </p>
    <template v-else>
      <p class="flex flex-wrap gap-x-3 gap-y-1 text-small text-fg-subtle">
        <span v-if="set.oplogWindowHours !== null" class="font-medium text-fg">{{
          t('overview.replica.oplog', { h: Math.round(set.oplogWindowHours) })
        }}</span>
        <span v-if="oplog?.rate">{{ oplog.rate }}</span>
        <span v-if="oplog">{{ oplog.use }}</span>
        <span v-if="elected">{{ elected }}</span>
      </p>
      <p v-if="!secondaries.length" class="text-small text-fg-subtle">{{ t('overview.replication.none') }}</p>
      <template v-else>
        <p class="text-caption text-fg-subtle">{{ t('overview.replication.headroom') }}</p>
        <ul class="-mx-1 flex flex-col">
          <li
            v-for="m in secondaries"
            :key="m.name"
            :data-headroom="m.level"
            class="flex min-w-0 items-center gap-2.5 rounded-lg px-1 py-1.5"
          >
            <span class="min-w-0 flex-1 truncate font-mono text-small text-fg">{{ m.name }}</span>
            <span class="shrink-0 text-small font-medium tabular-nums" :class="TONE[m.level]">{{
              m.text
            }}</span>
          </li>
        </ul>
      </template>
    </template>
  </div>
</template>
