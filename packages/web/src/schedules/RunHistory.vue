<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { ShieldAlert, ShieldCheck, ShieldMinus } from 'lucide-vue-next'
import { describeCadence, type ScheduleRunView, type ScheduleView } from '@mongo-manager/shared/browser'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import DsSheet from '@/ds/DsSheet.vue'
import JobRow from '@/jobs/JobRow.vue'
import { useJobsStore } from '@/jobs/store'
import { scheduleKeys, schedulesApi } from '@/api/schedules'
import { formatBytes, formatDuration } from '@/format'
import { useRunReason, zonedTime } from './words'
import { useReasonText } from '@/destinations/errors'
import { uiLanguageOf } from '@mongo-manager/shared/browser'

/** Spec §5 run history: outcome, duration, size, copies, removals and reason; a failed run shows its job. */
const props = defineProps<{ schedule: ScheduleView }>()
const emit = defineEmits<{ close: [] }>()
const { t, locale } = useI18n()
const jobs = useJobsStore()
const reasonText = useRunReason()
// Short names review 13 (M-4): why a copy is not complete, as its destination said it.
const copyReason = useReasonText()
const runs = useQuery({
  queryKey: computed(() => scheduleKeys.runs(props.schedule.id)),
  queryFn: () => schedulesApi.runs(props.schedule.id),
  refetchInterval: 15_000,
})
const PILL: Record<ScheduleRunView['outcome'], string> = {
  succeeded: 'bg-success-soft text-success',
  partial: 'bg-warning-soft text-warning',
  failed: 'bg-danger-soft text-danger',
  skipped: 'bg-subtle text-fg-muted',
  missed: 'bg-subtle text-fg-muted',
  running: 'bg-accent-soft text-accent-fg',
  queued: 'bg-accent-soft text-accent-fg',
}
const COPY: Record<ScheduleRunView['copies'][number]['state'], string> = {
  complete: 'border-success/30 text-success',
  failed: 'border-danger/30 text-danger',
  missing: 'border-line text-fg-muted',
}
const DRILL = { passed: 'text-success', failed: 'text-danger', skipped: 'text-fg-muted' } as const
const DRILL_ICON = { passed: ShieldCheck, failed: ShieldAlert, skipped: ShieldMinus } as const
const took = (r: ScheduleRunView) =>
  r.startedAt !== null && r.finishedAt !== null
    ? formatDuration(Math.max(1, Math.round((r.finishedAt - r.startedAt) / 1000)), locale.value)
    : null
const jobsOf = (r: ScheduleRunView) =>
  r.outcome === 'succeeded'
    ? []
    : [r.dumpJobId, r.sendJobId].flatMap((id) => (id && jobs.byId[id] ? [jobs.byId[id]!] : []))
const removal = (x: ScheduleRunView['removals'][number]) =>
  [
    x.removed
      ? x.location === 'server'
        ? t('schedules.history.removedServer', { count: x.removed }, x.removed)
        : t('schedules.history.removed', { count: x.removed, name: x.name ?? '—' }, x.removed)
      : null,
    x.failed ? t('schedules.history.removeFailed', { count: x.failed }, x.failed) : null,
    x.waiting ? t('schedules.history.waiting', { count: x.waiting }, x.waiting) : null,
  ].filter(Boolean)
</script>

<template>
  <DsSheet
    open
    :title="t('schedules.history.title', { name: schedule.name })"
    :subtitle="`${describeCadence(schedule.cadence, uiLanguageOf(locale)) ?? ''} (${schedule.timeZone})`"
    @close="emit('close')"
  >
    <div v-if="runs.isPending.value" class="flex flex-col gap-3" aria-busy="true">
      <DsSkeleton v-for="n in 4" :key="n" class="h-16 rounded-xl" />
    </div>
    <p
      v-else-if="!runs.data.value?.length"
      class="rounded-xl border border-dashed border-line-strong p-6 text-center text-ui text-fg-subtle"
    >
      {{ t('schedules.history.empty') }}
    </p>
    <ol v-else class="flex flex-col divide-y divide-line">
      <li v-for="r in runs.data.value" :key="r.id" :data-run="r.id" class="flex flex-col gap-2 py-4">
        <div class="flex flex-wrap items-center gap-2 text-ui">
          <span class="rounded-full px-2 py-0.5 text-small font-medium" :class="PILL[r.outcome]">{{
            t(`schedules.outcome.${r.outcome}`)
          }}</span>
          <span class="font-medium text-fg tabular-nums">{{
            zonedTime(r.dueAt, schedule.timeZone, locale)
          }}</span>
          <span class="rounded-full border border-line px-2 py-0.5 text-small text-fg-muted">{{
            t(`schedules.kind.${r.kind}`)
          }}</span>
          <span v-if="took(r)" class="text-small text-fg-subtle">{{
            t('schedules.history.took', { time: took(r) })
          }}</span>
          <span v-if="r.size !== null" class="ml-auto text-small text-fg-subtle tabular-nums">{{
            formatBytes(r.size, locale)
          }}</span>
        </div>
        <p v-if="reasonText(r.reason)" class="text-ui text-fg">
          {{ reasonText(r.reason) }}
          <span v-if="r.message" class="block text-small text-fg-subtle">{{ r.message }}</span>
        </p>
        <p v-if="r.missed" class="text-small text-fg-subtle">
          {{
            r.missedMore
              ? t('schedules.history.missedMore', { count: r.missed })
              : t('schedules.history.missed', { count: r.missed }, r.missed)
          }}
        </p>
        <ul v-if="r.copies.length" class="flex flex-wrap gap-1.5" :aria-label="t('schedules.history.copies')">
          <li
            v-for="c in r.copies"
            :key="c.destinationId"
            class="rounded-full border px-2 py-0.5 text-small"
            :class="COPY[c.state]"
          >
            {{ c.name ?? '—' }} · {{ t(`schedules.history.copy.${c.state}`) }}
          </li>
        </ul>
        <!-- Short names review 14 (M4): why a copy is not complete, beneath the chips. -->
        <template v-for="c in r.copies" :key="`why-${c.destinationId}`">
          <p v-if="c.state !== 'complete' && c.reason" class="text-small text-fg-muted" data-copy-reason>
            {{ c.name ?? '—' }}: {{ copyReason(c.reason) }}
          </p>
        </template>
        <!-- W4.4: the run's restore drill. -->
        <p
          v-if="r.drill"
          data-test="drill"
          class="flex flex-wrap items-center gap-1.5 text-small"
          :class="DRILL[r.drill.state]"
        >
          <component :is="DRILL_ICON[r.drill.state]" class="size-3.5" aria-hidden="true" />
          {{ t(`schedules.drill.state.${r.drill.state}`) }}
          <template v-if="r.drill.reason">· {{ t(`schedules.drill.reason.${r.drill.reason}`) }}</template>
          <span v-if="r.drill.mismatched?.length" class="font-mono"
            >({{ r.drill.mismatched.join(', ') }})</span
          >
        </p>
        <ul v-if="r.removals.some((x) => removal(x).length)" class="text-small text-fg-subtle">
          <li v-for="x in r.removals.filter((y) => removal(y).length)" :key="x.location">
            {{ removal(x).join(' · ') }}
          </li>
        </ul>
        <ul v-if="jobsOf(r).length" class="mt-1 rounded-xl border border-line px-3">
          <JobRow v-for="j in jobsOf(r)" :key="j.id" :job="j" :now="Date.now()" />
        </ul>
      </li>
    </ol>
  </DsSheet>
</template>
