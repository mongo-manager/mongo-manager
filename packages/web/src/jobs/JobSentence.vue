<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowRight } from 'lucide-vue-next'
import type { JobView } from '@mongo-manager/shared'
import { jobSentence } from './present'

/** "shop.orders → orders.json": where a job's work went, read in one line (user review 2026-10-08). */
const props = defineProps<{ job: JobView }>()
const { t } = useI18n()
const sides = computed(() => {
  const { from, to } = jobSentence(props.job)
  return {
    from: from ?? t('jobs.ui.wholeServer'),
    to:
      to ??
      (props.job.kind === 'backup.send'
        ? t('jobs.ui.toDestinations')
        : props.job.kind === 'backup.fetch'
          ? t('jobs.ui.toServer')
          : t('jobs.ui.wholeServer')),
  }
})
</script>

<template>
  <span class="flex min-w-0 items-center gap-1.5 font-mono">
    <span class="min-w-0 truncate" :title="sides.from">{{ sides.from }}</span>
    <ArrowRight class="size-3.5 shrink-0 text-fg-subtle" :aria-label="t('jobs.ui.to')" />
    <span class="min-w-0 truncate" :title="sides.to">{{ sides.to }}</span>
  </span>
</template>
