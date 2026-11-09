<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import WidgetError from './WidgetError.vue'
import { widgetError } from './errors'
import { serverApi, serverKeys, type ServerSample } from '@/api/server'
import DsSpinner from '@/ds/DsSpinner.vue'
import { formatBytes } from '@/format'
import { useSharedMonitor } from './sharedMonitor'
import Sparkline from './Sparkline.vue'

/**
 * User review 2026-10-09 ("Mongo durumu, sunucu durumu"): one server at a glance — its role, version,
 * uptime, connections, memory, cache and queues, with the last minutes as small lines. Live when the
 * socket can follow it; otherwise read every 30 s.
 */
const props = defineProps<{ connectionId: string }>()
const { t, locale } = useI18n()
const monitor = useSharedMonitor(() => props.connectionId)
const polled = useQuery({
  queryKey: computed(() => serverKeys.status(props.connectionId)),
  queryFn: () => serverApi.status(props.connectionId),
  enabled: computed(() => !monitor.live.value && !monitor.paused.value),
  refetchInterval: 30_000,
})
const replica = useQuery({
  queryKey: computed(() => serverKeys.replica(props.connectionId)),
  queryFn: () => serverApi.replica(props.connectionId),
  refetchInterval: 30_000,
})
const samples = computed<ServerSample[]>(() =>
  monitor.live.value || (monitor.paused.value && monitor.samples.value.length)
    ? monitor.samples.value
    : polled.data.value
      ? [polled.data.value]
      : [],
)
const last = computed(() => samples.value.at(-1) ?? null)
const recent = computed(() => samples.value.slice(-60))

const role = computed(() => {
  const r = replica.data.value
  if (!r) return null
  if (r.mode === 'standalone') return t('overview.status.standalone')
  if (r.mode === 'sharded') return t('overview.status.sharded')
  return t('overview.status.replicaSet', { set: r.set })
})
function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86_400)
  const h = Math.floor((seconds % 86_400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d) return t('overview.status.daysHours', { d, h })
  if (h) return t('overview.status.hoursMinutes', { h, m })
  return t('overview.status.minutes', { m })
}
/** A value the server does not report (no cache: another storage engine; memory on some systems). */
const NONE = '—'
const cachePercent = (s: ServerSample) =>
  s.cache && s.cache.maxBytes > 0 ? Math.round((s.cache.usedBytes / s.cache.maxBytes) * 100) : null
const errorText = computed(() => {
  const e = monitor.live.value
    ? monitor.error.value
    : polled.isError.value
      ? widgetError(polled.error.value)
      : null
  return e ? t(`overview.errors.${e}`) : null
})
/** Polled (not live): Retry asks again; the live monitor goes on trying by itself. */
const retry = computed(() => (monitor.live.value ? undefined : () => void polled.refetch()))
</script>

<template>
  <div class="flex flex-col gap-3">
    <WidgetError v-if="errorText && !last" :text="errorText" :retry="retry" />
    <div v-else-if="!last" class="flex items-center gap-2 py-2 text-ui text-fg-subtle">
      <DsSpinner :size="14" />{{ t('overview.status.waiting') }}
    </div>
    <template v-else>
      <p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui text-fg">
        <span v-if="role" class="font-medium">{{ role }}</span>
        <span
          v-if="last.version"
          class="rounded-md bg-subtle px-1.5 py-px font-mono text-small text-fg-muted"
          >{{ t('overview.status.version', { version: last.version }) }}</span
        >
        <span v-if="last.uptimeSec !== undefined" class="text-small text-fg-subtle">
          {{ t('overview.status.upFor', { time: uptime(last.uptimeSec) }) }}
        </span>
        <span v-if="!monitor.live.value" class="text-small text-fg-subtle"
          >· {{ t('overview.status.notLive') }}</span
        >
      </p>
      <dl class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div data-stat="connections" class="min-w-0">
          <dt class="text-small text-fg-subtle">{{ t('overview.status.connections') }}</dt>
          <dd class="text-ui font-semibold text-fg tabular-nums">
            {{
              t('overview.status.of', {
                n: last.connections.current,
                total: last.connections.current + last.connections.available,
              })
            }}
          </dd>
          <Sparkline :points="recent.map((s) => s.connections.current)" />
        </div>
        <div data-stat="memory" class="min-w-0">
          <dt class="text-small text-fg-subtle">{{ t('overview.status.memory') }}</dt>
          <dd class="text-ui font-semibold text-fg tabular-nums">
            {{ last.memory.residentMb > 0 ? formatBytes(last.memory.residentMb * 1024 ** 2, locale) : NONE }}
          </dd>
          <Sparkline :points="recent.map((s) => s.memory.residentMb || null)" />
        </div>
        <div data-stat="cache" class="min-w-0">
          <dt class="text-small text-fg-subtle">{{ t('overview.status.cache') }}</dt>
          <dd class="text-ui font-semibold text-fg tabular-nums">
            {{ cachePercent(last) === null ? NONE : t('overview.status.percent', { n: cachePercent(last) }) }}
          </dd>
          <Sparkline :points="recent.map(cachePercent)" />
        </div>
        <div data-stat="queues" class="min-w-0">
          <dt class="text-small text-fg-subtle">{{ t('overview.status.queues') }}</dt>
          <dd class="text-ui font-semibold text-fg tabular-nums">
            {{ last.queues.readers }} / {{ last.queues.writers }}
          </dd>
          <Sparkline :points="recent.map((s) => s.queues.readers + s.queues.writers)" />
        </div>
      </dl>
      <WidgetError v-if="errorText" :text="errorText" :retry="retry" />
    </template>
  </div>
</template>
