<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { Ban, Check, TriangleAlert, X } from 'lucide-vue-next'
import DsSpinner from '@/ds/DsSpinner.vue'
import type { JobStatus } from './present'

/** User review 2026-10-08: a job's state at a glance — a coloured mark, its name for screen readers. */
withDefaults(defineProps<{ status: JobStatus; label: string; size?: 'sm' | 'md' }>(), { size: 'md' })
const TONES: Record<JobStatus, string> = {
  running: 'bg-info-soft text-info',
  done: 'bg-success-soft text-success',
  failed: 'bg-danger-soft text-danger',
  cancelled: 'bg-muted text-fg-subtle',
  warning: 'bg-warning-soft text-warning',
}
</script>

<template>
  <span
    role="img"
    :aria-label="label"
    :title="label"
    :data-status="status"
    class="grid shrink-0 place-items-center rounded-full"
    :class="[size === 'md' ? 'size-6' : 'size-5', TONES[status]]"
  >
    <DsSpinner v-if="status === 'running'" :size="size === 'md' ? 13 : 11" />
    <Check v-else-if="status === 'done'" :class="size === 'md' ? 'size-3.5' : 'size-3'" stroke-width="3" />
    <X v-else-if="status === 'failed'" :class="size === 'md' ? 'size-3.5' : 'size-3'" stroke-width="3" />
    <Ban v-else-if="status === 'cancelled'" :class="size === 'md' ? 'size-3.5' : 'size-3'" />
    <TriangleAlert v-else :class="size === 'md' ? 'size-3.5' : 'size-3'" />
  </span>
</template>
