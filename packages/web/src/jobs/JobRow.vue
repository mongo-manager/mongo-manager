<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { X } from 'lucide-vue-next'
import type { JobView } from '@mongo-manager/shared'
import { formatBytes, formatCount, formatDuration } from '@/format'
import { formatElapsed } from './elapsed'
import { kindKey } from './labels'
import { clock } from './present'
import { useSendFailure, type SendJobView } from './sendJob'
import JobActions from './JobActions.vue'
import DsProgress from '@/ds/DsProgress.vue'

const props = defineProps<{ job: JobView; now: number }>()
defineEmits<{ cancel: [job: JobView] }>()
const { t, locale } = useI18n()

const percent = computed(() => {
  const p = props.job.progress
  return p && p.total > 0 ? Math.min(100, Math.floor((p.done / p.total) * 100)) : null
})
const elapsed = computed(() => formatElapsed(props.now - props.job.startedAt, locale.value))
/**
 * User review 2026-10-08 ("Bitti'den sonra zaman sayacı göstermesi mantıksız"): a job that ended says
 * how long it took and when it ended, as a clock — never "N ago".
 */
const tookAt = computed(() =>
  props.job.finishedAt
    ? t('jobs.ui.tookAt', {
        time: formatElapsed(props.job.finishedAt - props.job.startedAt, locale.value),
        at: clock(props.job.finishedAt, props.now, locale.value),
      })
    : null,
)
const estimate = computed(() =>
  props.job.estimate === null
    ? null
    : new Intl.NumberFormat(locale.value, { notation: 'compact', maximumFractionDigits: 1 }).format(
        props.job.estimate,
      ),
)

/**
 * Phase 3d-3b: a send or a download reads as what it does to the file — and, once it ended, as what
 * it did (final review C24: a finished row no longer says "Sending").
 */
const title = computed(() => {
  const job = props.job
  const key =
    job.kind === 'backup.send' ? 'backup.send' : job.kind === 'backup.fetch' ? 'backup.remote' : null
  if (!key) return null
  const form = job.state === 'running' ? 'row' : job.state === 'done' ? 'rowDone' : 'rowEnded'
  return t(`${key}.${form}`, { name: job.target })
})
const where = computed(() => {
  const { db, coll } = props.job
  if (db === '*') return null
  return coll === '*' ? db : db + '.' + coll
})

const sendFailure = useSendFailure()
const outcome = computed(() => {
  const job = props.job as SendJobView
  if (job.state === 'failed' && job.kind === 'backup.send') return sendFailure.sentence(job)
  if (job.state === 'failed' && job.kind === 'backup.fetch')
    return job.error ? t('jobs.failedWith', { error: job.error }) : t('backup.remote.fetchFailedPlain')
  if (job.state === 'failed') return t('jobs.failedWith', { error: job.error ?? '' })
  // Short names review 14 (M3): a cancelled send that kept its only local copy says so.
  if (job.state === 'cancelled' && job.kind === 'backup.send' && job.localKept)
    return `${t('jobs.state.cancelled')} · ${t('backup.send.localKeptStopped')}`
  return t(`jobs.state.${job.state}`)
})

/**
 * Phase 3d-3b V8, final review C11: a transfer's bytes, its throughput and the time left — measured
 * here from the progress the server reports (a smoothed rate between updates).
 */
const transferKind = computed(() => props.job.kind === 'backup.send' || props.job.kind === 'backup.fetch')
const rate = ref<number | null>(null)
let sample: { at: number; done: number } | null = null
watch(
  () => props.job.progress?.done,
  (done) => {
    if (done === undefined || !transferKind.value) return
    const at = Date.now()
    if (sample && done > sample.done && at > sample.at) {
      const r = ((done - sample.done) * 1000) / (at - sample.at)
      rate.value = rate.value === null ? r : rate.value * 0.6 + r * 0.4
    }
    sample = { at, done }
  },
  { immediate: true },
)
const bytesLine = computed(() => {
  const p = props.job.progress
  if (!transferKind.value || !p || p.total <= 0) return null
  const b = (n: number) => formatBytes(n, locale.value)
  const parts = [`${b(p.done)} / ${b(p.total)}`]
  if (rate.value && rate.value > 0) {
    parts.push(t('jobs.speed', { speed: b(rate.value) }))
    parts.push(
      t('jobs.left', { time: formatDuration(Math.max(1, (p.total - p.done) / rate.value), locale.value) }),
    )
  }
  return parts.join(' · ')
})
/** Spec §4.2: a transfer queued behind others on its destinations says so, by name. */
const waiting = computed(() => {
  const names = props.job.waitingFor ?? []
  return props.job.state === 'running' && names.length
    ? t('jobs.waitingFor', {
        names: new Intl.ListFormat(locale.value, { type: 'conjunction' }).format(names),
      })
    : null
})
</script>

<template>
  <li :data-job="job.id" class="flex flex-col gap-1 border-b border-line py-2 last:border-0">
    <div class="flex items-start gap-2">
      <div class="min-w-0 flex-1">
        <p class="truncate text-ui font-medium">
          <template v-if="title">{{ title }}</template>
          <template v-else
            >{{ t(kindKey(job.kind)) }}: <span class="font-mono">{{ job.target }}</span></template
          >
        </p>
        <p v-if="job.scheduleName" class="truncate text-small text-accent-fg">
          {{ t('jobs.scheduled', { name: job.scheduleName }) }}
        </p>
        <p v-if="where" class="truncate text-small text-fg-subtle">{{ where }}</p>
      </div>
      <button
        v-if="job.cancellable"
        type="button"
        data-action="cancel"
        class="cursor-pointer rounded p-1 text-fg-subtle hover:bg-subtle"
        :aria-label="t('jobs.cancelNamed', { name: job.target })"
        :title="t('jobs.cancel')"
        @click="$emit('cancel', job)"
      >
        <X class="size-4" aria-hidden="true" />
      </button>
    </div>
    <template v-if="job.state === 'running'">
      <DsProgress
        :label="t('jobs.progressOf', { name: job.target })"
        :value="percent === null ? undefined : percent / 100"
        :value-text="percent === null ? t('jobs.stillRunning', { time: elapsed }) : undefined"
      />
      <p class="text-small text-fg-muted tabular-nums">
        <template v-if="waiting">{{ waiting }}</template>
        <template v-else-if="bytesLine && percent !== null">{{ percent }}% · {{ bytesLine }}</template>
        <template v-else-if="percent !== null && job.progress">
          {{ percent }}% · {{ formatCount(job.progress.done, locale) }} /
          {{ formatCount(job.progress.total, locale) }}
        </template>
        <template v-else>
          {{ t('jobs.stillRunning', { time: elapsed }) }}
          <template v-if="estimate"> · {{ t('jobs.aboutDocuments', { count: estimate }) }}</template>
        </template>
      </p>
    </template>
    <p v-else class="text-small" :class="job.state === 'done' ? 'text-success' : 'text-danger'">
      {{ outcome }}
      <template v-if="tookAt"> · {{ tookAt }}</template>
    </p>
    <JobActions :job="job" />
  </li>
</template>
