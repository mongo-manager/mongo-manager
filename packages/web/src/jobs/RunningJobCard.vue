<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { X } from 'lucide-vue-next'
import type { JobView } from '@mongo-manager/shared'
import DsTooltip from '@/ds/DsTooltip.vue'
import DsProgress from '@/ds/DsProgress.vue'
import { formatBytes, formatCount } from '@/format'
import { formatElapsed } from './elapsed'
import JobSentence from './JobSentence.vue'
import JobPartsList from './JobPartsList.vue'
import { KIND_ICONS, progressUnit } from './present'
import { useJobsStore } from './store'
import { useJobWords } from './useJobWords'

/**
 * User review 2026-10-08: a running job, large — a progress bar, how much of how much, how long so
 * far, the time left and the pace once known, what it waits for, and Cancel where the user may.
 */
const props = withDefaults(defineProps<{ job: JobView; now: number; compact?: boolean }>(), {
  compact: false,
})
defineEmits<{ cancel: [job: JobView]; select: [job: JobView] }>()
const w = useJobWords()
const store = useJobsStore()

const percent = computed(() => {
  const p = props.job.progress
  return p && p.total > 0 ? Math.min(100, Math.floor((p.done / p.total) * 100)) : null
})
const unit = computed(() => progressUnit(props.job.kind))
const amount = (n: number) =>
  unit.value === 'bytes' ? formatBytes(n, w.locale.value) : formatCount(n, w.locale.value)
/** "12,400 / 19,300 documents", "2.1 MB / 8 MB". */
const counted = computed(() => {
  const p = props.job.progress
  if (!p || p.total <= 0) return null
  const pair = `${amount(p.done)} / ${amount(p.total)}`
  return unit.value === 'documents' ? w.t('jobs.ui.documentsOf', { pair }, p.total) : pair
})
const left = computed(() => {
  const s = store.timeLeft(props.job.id)
  return s === null
    ? null
    : w.t('jobs.ui.left', { time: formatElapsed(Math.max(1, s) * 1000, w.locale.value) })
})
const pace = computed(() => {
  const r = store.rateOf(props.job.id)
  if (!r) return null
  return unit.value === 'bytes'
    ? w.t('jobs.speed', { speed: formatBytes(r, w.locale.value) })
    : w.t('jobs.ui.pace', { n: formatCount(Math.round(r), w.locale.value) })
})
const waiting = computed(() => {
  const names = props.job.waitingFor ?? []
  return names.length
    ? w.t('jobs.waitingFor', {
        names: new Intl.ListFormat(w.locale.value, { type: 'conjunction' }).format(names),
      })
    : null
})
const estimate = computed(() =>
  props.job.estimate === null
    ? null
    : new Intl.NumberFormat(w.locale.value, { notation: 'compact', maximumFractionDigits: 1 }).format(
        props.job.estimate,
      ),
)
</script>

<template>
  <li
    :data-job="job.id"
    data-running
    class="flex flex-col gap-2"
    :class="
      compact ? 'rounded-lg bg-subtle px-3 py-2.5' : 'rounded-xl border border-line bg-surface p-4 shadow-xs'
    "
  >
    <div class="flex items-start gap-3">
      <span
        class="grid shrink-0 place-items-center rounded-lg bg-info-soft text-info"
        :class="compact ? 'size-7' : 'size-9'"
        aria-hidden="true"
      >
        <component :is="KIND_ICONS[job.kind]" :class="compact ? 'size-3.5' : 'size-4'" />
      </span>
      <button
        type="button"
        class="min-w-0 flex-1 cursor-pointer rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        @click="$emit('select', job)"
      >
        <JobSentence class="text-ui font-medium text-fg" :job="job" />
        <span class="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-small text-fg-subtle">
          <span>{{ w.kind(job) }}</span>
          <template v-if="!compact">
            <span aria-hidden="true">·</span>
            <span class="truncate">{{ w.connection(job.connectionId) }}</span>
            <span aria-hidden="true">·</span>
            <span>{{ w.who(job) }}</span>
          </template>
          <template v-if="job.scheduleName">
            <span aria-hidden="true">·</span>
            <span class="truncate text-accent-fg">{{ job.scheduleName }}</span>
          </template>
        </span>
      </button>
      <DsTooltip v-if="job.cancellable" :text="w.t('jobs.cancel')">
        <button
          type="button"
          data-action="cancel"
          class="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-subtle transition-colors duration-120 hover:bg-danger-soft hover:text-danger"
          :aria-label="w.t('jobs.cancelNamed', { name: job.target })"
          @click="$emit('cancel', job)"
        >
          <X class="size-4" aria-hidden="true" />
        </button>
      </DsTooltip>
    </div>
    <DsProgress
      :label="w.t('jobs.progressOf', { name: job.target })"
      :value="percent === null ? undefined : percent / 100"
      :value-text="percent === null ? w.t('jobs.stillRunning', { time: w.took(job, now) }) : undefined"
      :size="compact ? 'sm' : 'md'"
    />
    <p class="flex flex-wrap items-center gap-x-2 text-small text-fg-muted tabular-nums">
      <template v-if="waiting">{{ waiting }}</template>
      <template v-else-if="percent !== null">
        <span class="font-semibold text-fg">{{ percent }}%</span>
        <span v-if="counted">{{ counted }}</span>
        <span>· {{ w.took(job, now) }}</span>
        <span v-if="left" class="text-fg">· {{ left }}</span>
        <span v-if="pace && !compact">· {{ pace }}</span>
      </template>
      <template v-else>
        <span>{{ w.t('jobs.stillRunning', { time: w.took(job, now) }) }}</span>
        <span v-if="estimate">· {{ w.t('jobs.aboutDocuments', { count: estimate }) }}</span>
      </template>
    </p>
    <JobPartsList v-if="job.parts" :parts="job.parts" :kind="job.kind" :compact="compact" />
  </li>
</template>
