<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { ChevronRight } from 'lucide-vue-next'
import type { JobView } from '@mongo-manager/shared'
import JobStatusIcon from './JobStatusIcon.vue'
import JobSentence from './JobSentence.vue'
import { KIND_ICONS } from './present'
import { useJobWords } from './useJobWords'

/**
 * User review 2026-10-08: a finished job in one line — its state, its kind, where the work went, who
 * and which connection, how long it took and when it ended. A failure shows its error's first line.
 */
withDefaults(defineProps<{ job: JobView; now: number; selected?: boolean; compact?: boolean }>(), {
  selected: false,
  compact: false,
})
defineEmits<{ select: [job: JobView] }>()
const w = useJobWords()
const firstLine = (text: string) => text.split('\n')[0]
</script>

<template>
  <li :data-job="job.id">
    <button
      type="button"
      class="group flex w-full cursor-pointer items-start gap-3 rounded-lg px-2 py-2 text-left transition-colors duration-120 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
      :class="selected ? 'bg-accent-soft' : 'hover:bg-subtle'"
      :aria-current="selected ? 'true' : undefined"
      @click="$emit('select', job)"
    >
      <JobStatusIcon
        class="mt-0.5"
        :status="w.status(job)"
        :label="w.state(job)"
        :size="compact ? 'sm' : 'md'"
      />
      <span class="min-w-0 flex-1">
        <span class="flex min-w-0 items-center gap-2 text-ui text-fg">
          <component :is="KIND_ICONS[job.kind]" class="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
          <JobSentence class="min-w-0 text-[12.5px]" :job="job" />
        </span>
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
        <span v-if="job.error" class="mt-0.5 block truncate text-small text-danger" :title="job.error">
          {{ w.t('jobs.failedWith', { error: firstLine(job.error) }) }}
        </span>
      </span>
      <span
        class="mt-0.5 shrink-0 text-right text-small whitespace-nowrap text-fg-muted tabular-nums"
        :title="w.t('jobs.ui.tookAt', { time: w.took(job, now), at: w.ended(job, now) })"
      >
        {{ w.took(job, now) }}<span class="text-fg-subtle"> · {{ w.ended(job, now) }}</span>
      </span>
      <ChevronRight
        v-if="!compact"
        class="mt-1 size-4 shrink-0 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100"
        aria-hidden="true"
      />
    </button>
  </li>
</template>
