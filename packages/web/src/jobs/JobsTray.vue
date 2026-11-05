<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { JobView } from '@mongo-manager/shared'
import {
  ArrowRight,
  ArrowRightLeft,
  Bell,
  BellRing,
  CalendarClock,
  Check,
  ChevronRight,
  Zap,
} from 'lucide-vue-next'
import DsPopover from '@/ds/DsPopover.vue'
import DsSpinner from '@/ds/DsSpinner.vue'
import { useJobsStore } from './store'
import { useCancelJob } from './cancel'
import { useTabsStore } from '@/stores/tabs'
import { useScheduleSignals } from '@/schedules/useScheduleSignals'
import { useLiveSyncSignals } from '@/livesync/useLiveSyncs'
import { openJobsTab, openLiveSyncsTab, openSchedulesTab } from '@/workspace/openTabs'
import JobLine from './JobLine.vue'
import RunningJobCard from './RunningJobCard.vue'
import { kindKey } from './labels'
import { useAlertSignals } from '@/alerts/useAlertSignals'
import { alertTitle, reportCounts } from '@/alerts/labels'
import type { AlertView } from '@mongo-manager/shared/browser'
import { formatElapsed } from './elapsed'
import { openAlertsTab } from '@/workspace/openTabs'
import { useToastStore } from '@/stores/toasts'
import { useSessionStore } from '@/stores/session'
import { describeError } from '@/api/errors'

/**
 * User review 2026-10-08 ("dropdown tasarımını beğenmedim"): the panel is a quick look — the running
 * jobs with their progress, the last few that ended (how long they took, when they ended), and the
 * way to the jobs page, where a job's details and actions are.
 */
/** Finished jobs listed under the running ones; the rest are on the jobs page. */
const RECENT = 5
/** Running jobs shown at most; the rest are counted. */
const RUNNING = 3

const { t, locale } = useI18n()
const store = useJobsStore()
// W3.3: the alerts this user opted in to, on connections whose server they may watch.
const signals = useAlertSignals()
const alertsShown = computed(() => signals.alerts.value.slice(0, 6))
const toasts = useToastStore()
// W3 review (M8): administrators acknowledge for everyone; others dismiss from their own bell.
const session = useSessionStore()
const canAcknowledge = computed(() => session.can('settings:manage'))
async function acknowledge(id: string): Promise<void> {
  try {
    await (canAcknowledge.value ? signals.acknowledge(id) : signals.dismiss(id))
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  }
}
function openAlerts(): void {
  popover.value?.close(false)
  openAlertsTab(tabs)
}

const running = computed(() => store.running)
const recent = computed(() => store.list.filter((j) => j.state !== 'running').slice(0, RECENT))

// Elapsed times tick once a second, on the server's clock, and catch up at once when jobs change
// (final review Minor 4: after a long idle time "ended N ago" must not be stale).
const now = ref(store.serverNow())
const ticker = setInterval(() => (now.value = store.serverNow()), 1_000)
onBeforeUnmount(() => clearInterval(ticker))
watch(
  () => store.list,
  () => (now.value = store.serverNow()),
)
// The count is part of the button's name, so screen readers hear it too (Minor 8).
// UI redesign R1 revision 2 §3.2: the bell also carries what needs a person.
const tabs = useTabsStore()
const { attention: scheduleAttention } = useScheduleSignals()
const { attention: syncAttention } = useLiveSyncSignals()
const attention = computed(() =>
  [
    scheduleAttention.value
      ? {
          id: 'schedules',
          icon: CalendarClock,
          title: t('header.schedules'),
          text: t('header.schedulesAttention', { count: scheduleAttention.value }, scheduleAttention.value),
          open: () => openSchedulesTab(tabs),
        }
      : null,
    syncAttention.value
      ? {
          id: 'liveSyncs',
          icon: ArrowRightLeft,
          title: t('header.liveSyncs'),
          text: t('header.liveSyncsAttention', { count: syncAttention.value }, syncAttention.value),
          open: () => openLiveSyncsTab(tabs),
        }
      : null,
  ].filter((a) => a !== null),
)
const label = computed(() =>
  [
    running.value.length > 0 ? t('jobs.titleRunning', { n: running.value.length }) : t('jobs.title'),
    ...(signals.firing.value
      ? [t('alerts.firingCount', { count: signals.firing.value }, signals.firing.value)]
      : []),
    ...attention.value.map((a) => a.text),
  ].join(', '),
)

// Screen readers hear when a job ends, whether or not the panel is open.
const announcement = ref('')
const off = store.onFinished((job) => {
  now.value = store.serverNow()
  announcement.value = `${t(kindKey(job.kind))}: ${job.target}: ${
    job.state === 'failed' ? t('jobs.failedWith', { error: job.error ?? '' }) : t(`jobs.state.${job.state}`)
  }`
})
onBeforeUnmount(off)

const cancel = useCancelJob()

const popover = ref<{ show: () => void; close: (returnFocus?: boolean) => void } | null>(null)
function showAll(): void {
  popover.value?.close(false)
  openJobsTab(tabs)
}
/** A job chosen here opens on the jobs page, with its details. */
function show(job: JobView): void {
  store.focus(job.id)
  showAll()
}
/** UI redesign R1 revision 2 §3.1: the sidebar's "Background jobs" opens this panel. */
defineExpose({ open: () => popover.value?.show() })
/** Design 2026-10-25 (C7): a report's counts, one line. */
const reportLine = (a: AlertView) => reportCounts(t, locale.value, a)
</script>

<template>
  <DsPopover
    ref="popover"
    :label="label"
    placement="bottom-end"
    trigger-class="relative grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-120 hover:bg-subtle hover:text-fg"
    panel-class="w-[420px] max-w-[calc(100vw-2rem)] p-0!"
  >
    <template #trigger>
      <DsSpinner v-if="running.length > 0" :size="16" class="text-accent-fg" />
      <Bell v-else class="size-4" aria-hidden="true" />
      <span
        v-if="signals.firing.value > 0 && running.length === 0"
        data-test="alerts-dot"
        class="absolute top-1 right-1 size-2 rounded-full bg-danger ring-2 ring-surface"
        aria-hidden="true"
      />
      <span
        v-else-if="attention.length && running.length === 0"
        class="absolute top-1 right-1 size-2 rounded-full bg-warning ring-2 ring-surface"
        aria-hidden="true"
      />
      <span
        v-if="running.length > 0"
        data-test="jobs-badge"
        class="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] leading-4 font-semibold text-on-accent tabular-nums"
        >{{ running.length }}</span
      >
    </template>
    <div data-test="jobs-panel" class="flex max-h-[70vh] flex-col">
      <header class="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 tabindex="-1" class="text-ui font-semibold text-fg outline-none">{{ t('jobs.title') }}</h2>
        <button
          type="button"
          data-action="all-jobs"
          class="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-small font-medium text-accent-fg transition-colors duration-120 hover:bg-accent-soft"
          @click="showAll"
        >
          {{ t('jobs.showAll') }}<ArrowRight class="size-3.5" aria-hidden="true" />
        </button>
      </header>
      <div class="min-h-0 flex-1 overflow-auto px-2 py-2">
        <template v-if="alertsShown.length">
          <div class="flex items-center justify-between px-2 pt-1 pb-1.5">
            <h3 class="text-caption font-semibold tracking-wide text-fg-subtle uppercase">
              {{ t('alerts.title') }}
            </h3>
            <button
              type="button"
              class="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-small font-medium text-accent-fg transition-colors duration-120 hover:bg-accent-soft"
              @click="openAlerts"
            >
              {{ t('alerts.openPage') }}<ArrowRight class="size-3.5" aria-hidden="true" />
            </button>
          </div>
          <ul class="mb-2 flex flex-col gap-0.5" data-test="alerts-list">
            <li v-for="a in alertsShown" :key="a.id" class="flex items-center gap-2.5 rounded-lg px-2 py-2">
              <span
                class="grid size-7 shrink-0 place-items-center rounded-md"
                :class="a.state === 'firing' ? 'bg-danger-soft text-danger' : 'bg-info-soft text-info'"
              >
                <component :is="a.state === 'firing' ? BellRing : Zap" class="size-3.5" aria-hidden="true" />
              </span>
              <span class="min-w-0 flex-1">
                <span class="block text-ui font-medium text-fg">{{ alertTitle(t, locale, a) }}</span>
                <!-- Review of C7a (M2): a report's counts, where they are shown (administrators). -->
                <span v-if="reportLine(a)" class="block text-small text-fg" data-report-counts>{{
                  reportLine(a)
                }}</span>
                <span class="block text-small text-fg-subtle">{{
                  a.acknowledgedBy
                    ? t('alerts.bell.acknowledged', { user: a.acknowledgedBy })
                    : t('alerts.bell.since', { time: formatElapsed(now - Date.parse(a.startedAt), locale) })
                }}</span>
              </span>
              <button
                v-if="!a.acknowledgedAt || !canAcknowledge"
                type="button"
                class="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-small font-medium text-fg-muted transition-colors duration-120 hover:bg-subtle hover:text-fg"
                :aria-label="
                  t(canAcknowledge ? 'alerts.bell.acknowledgeNamed' : 'alerts.bell.dismissNamed', {
                    alert: alertTitle(t, locale, a),
                  })
                "
                @click="acknowledge(a.id)"
              >
                <Check class="size-3.5" aria-hidden="true" />{{
                  canAcknowledge ? t('alerts.bell.acknowledge') : t('alerts.bell.dismiss')
                }}
              </button>
            </li>
          </ul>
        </template>
        <template v-if="attention.length">
          <h3 class="px-2 pt-1 pb-1.5 text-caption font-semibold tracking-wide text-fg-subtle uppercase">
            {{ t('layout.needsAttention') }}
          </h3>
          <ul class="mb-2 flex flex-col gap-0.5">
            <li v-for="a in attention" :key="a.id">
              <button
                type="button"
                class="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors duration-120 hover:bg-subtle"
                @click="a.open()"
              >
                <span class="grid size-7 shrink-0 place-items-center rounded-md bg-warning-soft text-warning">
                  <component :is="a.icon" class="size-3.5" aria-hidden="true" />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block text-ui font-medium text-fg">{{ a.title }}</span>
                  <span class="block text-small text-fg-subtle">{{ a.text }}</span>
                </span>
                <ChevronRight class="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
              </button>
            </li>
          </ul>
        </template>
        <template v-if="running.length">
          <h3 class="px-2 pt-1 pb-1.5 text-caption font-semibold tracking-wide text-fg-subtle uppercase">
            {{ t('jobs.ui.runningNow') }}
          </h3>
          <ul class="mb-2 flex flex-col gap-1.5">
            <RunningJobCard
              v-for="job in running.slice(0, RUNNING)"
              :key="job.id"
              compact
              :job="job"
              :now="now"
              @cancel="cancel"
              @select="show"
            />
          </ul>
          <p v-if="running.length > RUNNING" class="px-2 pb-2 text-small text-fg-subtle">
            {{ t('jobs.ui.moreRunning', { n: running.length - RUNNING }) }}
          </p>
        </template>
        <template v-if="recent.length">
          <h3 class="px-2 pt-1 pb-1 text-caption font-semibold tracking-wide text-fg-subtle uppercase">
            {{ t('jobs.ui.recentlyEnded') }}
          </h3>
          <ul class="flex flex-col">
            <JobLine v-for="job in recent" :key="job.id" compact :job="job" :now="now" @select="show" />
          </ul>
        </template>
        <p
          v-if="!running.length && !recent.length && !alertsShown.length"
          class="px-2 py-6 text-center text-ui text-fg-subtle"
        >
          {{ t('jobs.empty') }}
        </p>
      </div>
    </div>
  </DsPopover>
  <span class="sr-only" aria-live="polite">{{ announcement }}</span>
</template>
