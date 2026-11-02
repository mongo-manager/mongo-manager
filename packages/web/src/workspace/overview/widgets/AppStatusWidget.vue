<script setup lang="ts">
import { computed, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { ArrowRightLeft, CalendarClock, ChevronRight, HardDrive, ListChecks } from 'lucide-vue-next'
import { RUNNING_STATES } from '@mongo-manager/shared/browser'
import { liveSyncApi, liveSyncKeys } from '@/api/liveSync'
import { scheduleKeys, schedulesApi } from '@/api/schedules'
import { backupApi } from '@/api/backup'
import { useJobsStore } from '@/jobs/store'
import { useTabsStore } from '@/stores/tabs'
import { formatBytes, formatRelative } from '@/format'
import { openJobsTab, openLiveSyncsTab, openSchedulesTab } from '../../openTabs'
import WidgetFrame from './WidgetFrame.vue'
import DsProgress from '@/ds/DsProgress.vue'

/**
 * User review 2026-10-09 ("sunucu durumu … widgetlar"): what Mongo Manager itself is doing for the
 * user — background jobs, live syncs, backup schedules (their own) and the room their backups take on
 * this server. Each line opens its page; a line it may not read is left out.
 */
const { t, locale } = useI18n()
const tabs = useTabsStore()
const jobs = useJobsStore()
const syncs = useQuery({
  queryKey: liveSyncKeys.list,
  queryFn: () => liveSyncApi.list(),
  refetchInterval: 60_000,
})
const schedules = useQuery({
  queryKey: scheduleKeys.list,
  queryFn: () => schedulesApi.list(),
  refetchInterval: 60_000,
})
const usage = useQuery({
  queryKey: ['backups', 'usage'],
  queryFn: () => backupApi.usage(),
  refetchInterval: 60_000,
})

interface Row {
  id: string
  icon: Component
  title: string
  text: string
  warn: boolean
  open?: () => void
}

const RUNNING: readonly string[] = RUNNING_STATES
const rows = computed<Row[]>(() => {
  const out: Row[] = []
  const running = jobs.running.length
  out.push({
    id: 'jobs',
    icon: ListChecks,
    title: t('jobs.title'),
    text: running ? t('overview.app.running', { count: running }, running) : t('overview.app.nothingRunning'),
    warn: false,
    open: () => openJobsTab(tabs),
  })
  if (syncs.data.value) {
    const mine = syncs.data.value.syncs.filter((s) => s.mine)
    const live = mine.filter((s) => RUNNING.includes(s.state)).length
    const attention = mine.filter((s) => s.state === 'attention' || s.state === 'failed').length
    out.push({
      id: 'liveSyncs',
      icon: ArrowRightLeft,
      title: t('header.liveSyncs'),
      text: mine.length
        ? [
            t('overview.app.running', { count: live }, live),
            ...(attention ? [t('overview.app.attention', { count: attention }, attention)] : []),
          ].join(' · ')
        : t('overview.app.noneSetUp'),
      warn: attention > 0,
      open: () => openLiveSyncsTab(tabs),
    })
  }
  if (schedules.data.value) {
    const mine = schedules.data.value.schedules.filter((s) => s.mine)
    const active = mine.filter((s) => s.state === 'active')
    const attention = mine.filter(
      (s) =>
        s.state === 'paused' ||
        ['failed', 'partial'].includes(
          [...s.lastRuns].reverse().find((r) => r.outcome !== 'running' && r.outcome !== 'queued')?.outcome ??
            '',
        ),
    ).length
    const next = Math.min(...active.map((s) => s.nextRunAt ?? Infinity))
    out.push({
      id: 'schedules',
      icon: CalendarClock,
      title: t('header.schedules'),
      text: mine.length
        ? [
            t('overview.app.active', { count: active.length }, active.length),
            ...(attention ? [t('overview.app.attention', { count: attention }, attention)] : []),
            ...(Number.isFinite(next)
              ? [t('overview.app.next', { when: formatRelative(next - Date.now(), locale.value) })]
              : []),
          ].join(' · ')
        : t('overview.app.noneSetUp'),
      warn: attention > 0,
      open: () => openSchedulesTab(tabs),
    })
  }
  return out
})
/** The backups kept on this server, of the room they may take (none: no limit). */
const room = computed(() => {
  const u = usage.data.value
  if (!u) return null
  const used = formatBytes(u.used, locale.value)
  if (!(u.quota > 0)) return { text: used, percent: null }
  const percent = Math.min(100, Math.round((u.used / u.quota) * 100))
  return { text: t('overview.app.of', { used, quota: formatBytes(u.quota, locale.value) }), percent }
})
</script>

<template>
  <WidgetFrame :title="t('overview.widgets.appStatus.title')">
    <ul class="-mx-2 flex flex-col">
      <li v-for="r in rows" :key="r.id" :data-app-row="r.id">
        <button
          type="button"
          class="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors duration-120 hover:bg-subtle"
          @click="r.open?.()"
        >
          <span
            class="grid size-7 shrink-0 place-items-center rounded-md"
            :class="r.warn ? 'bg-warning-soft text-warning' : 'bg-subtle text-fg-muted'"
          >
            <component :is="r.icon" class="size-3.5" aria-hidden="true" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block text-ui font-medium text-fg">{{ r.title }}</span>
            <span class="block truncate text-small text-fg-subtle">{{ r.text }}</span>
          </span>
          <ChevronRight class="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
        </button>
      </li>
      <li v-if="room" data-app-row="backups" class="flex items-center gap-2.5 px-2 py-2">
        <span class="grid size-7 shrink-0 place-items-center rounded-md bg-subtle text-fg-muted">
          <HardDrive class="size-3.5" aria-hidden="true" />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block text-ui font-medium text-fg">{{ t('overview.app.backups') }}</span>
          <span class="block text-small text-fg-subtle">{{ room.text }}</span>
          <DsProgress
            v-if="room.percent !== null"
            class="mt-1.5"
            meter
            :label="t('overview.app.backups')"
            :value="room.percent / 100"
            :tone="room.percent >= 90 ? 'danger' : room.percent >= 75 ? 'warning' : 'accent'"
          />
        </span>
      </li>
    </ul>
  </WidgetFrame>
</template>
