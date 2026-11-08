<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RunMark } from '@mongo-manager/shared/browser'
import { zonedTime } from './words'

/** Spec §5: the last 14 runs as coloured marks, oldest first; each says what happened and when. */
const props = defineProps<{ runs: RunMark[]; timeZone: string }>()
const { t, locale } = useI18n()
const SLOTS = 14
const shown = computed(() => props.runs.slice(-SLOTS))
const empty = computed(() => SLOTS - shown.value.length)
const TONE: Record<RunMark['outcome'], string> = {
  succeeded: 'bg-success',
  partial: 'bg-warning',
  failed: 'bg-danger',
  skipped: 'bg-line-strong',
  missed: 'border border-dashed border-fg-subtle',
  running: 'animate-pulse bg-accent motion-reduce:animate-none',
  queued: 'border border-accent',
}
const label = (m: RunMark) =>
  t('schedules.strip.mark', {
    outcome: t(`schedules.outcome.${m.outcome}`),
    time: zonedTime(m.dueAt, props.timeZone, locale.value),
  })
</script>

<template>
  <div class="flex items-end gap-1">
    <span v-for="n in empty" :key="`e${n}`" aria-hidden="true" class="h-5 w-2.5 rounded-sm bg-muted" />
    <ol class="flex items-end gap-1" :aria-label="t('schedules.strip.label')">
      <li v-for="m in shown" :key="m.id" class="flex">
        <span
          role="img"
          :aria-label="label(m)"
          :title="label(m)"
          :data-outcome="m.outcome"
          class="h-5 w-2.5 rounded-sm"
          :class="TONE[m.outcome]"
        />
      </li>
    </ol>
  </div>
</template>
