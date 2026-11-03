<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, CircleDashed, LoaderCircle, SkipForward, X } from 'lucide-vue-next'
import type { JobKindName, JobPart, JobParts } from '@mongo-manager/shared/browser'
import { formatCount } from '@/format'

/**
 * W4.3, W4.4 (phase 3d-2 spec §3.3, U8): a running job's parts — "3 of 12 collections · orders 40%",
 * and, in the large card, each part with its own state and progress. Live only: the report tells
 * how it ended.
 */
const props = withDefaults(defineProps<{ parts: JobParts; kind: JobKindName; compact?: boolean }>(), {
  compact: false,
})
const { t, locale } = useI18n()
/** Copies count collections; backups count namespaces. */
const noun = computed(() => (props.kind.startsWith('backup.') ? 'namespaces' : 'collections'))
const percent = (p: JobPart) =>
  p.total && p.total > 0 ? Math.min(100, Math.floor((p.done / p.total) * 100)) : null
/** Every part counts documents (a dump's and a restore's namespaces as a copy's collections). */
const amount = (n: number) => formatCount(n, locale.value)
const MAIN = new Set(['copy', 'dump', 'restore'])
const running = computed(() => props.parts.items.filter((p) => p.state === 'running'))
const summary = computed(() => {
  const head = t(
    `jobs.parts.${noun.value}`,
    {
      done: formatCount(props.parts.finished, locale.value),
      total: formatCount(props.parts.count, locale.value),
    },
    props.parts.count,
  )
  const now = running.value[0]
  const pct = now ? percent(now) : null
  const current = now ? (pct === null ? now.name : `${now.name} ${pct}%`) : null
  // The main work goes without saying; the steps around it are named (views, indexes, verify…).
  const phase =
    props.parts.phase && !MAIN.has(props.parts.phase) ? t(`jobs.parts.phases.${props.parts.phase}`) : null
  return [head, phase, current].filter(Boolean).join(' · ')
})
const ICONS = { waiting: CircleDashed, running: LoaderCircle, done: Check, failed: X, skipped: SkipForward }
const TONES = {
  waiting: 'text-fg-subtle',
  running: 'text-info',
  done: 'text-accent-fg',
  failed: 'text-danger',
  skipped: 'text-fg-subtle',
}
const hidden = computed(() => props.parts.count - props.parts.items.length)
</script>

<template>
  <div data-test="job-parts" class="flex flex-col gap-1.5 text-small">
    <p class="text-fg-muted tabular-nums">{{ summary }}</p>
    <ul
      v-if="!compact && parts.items.length > 1"
      class="flex max-h-48 flex-col gap-1 overflow-auto"
      :aria-label="t(`jobs.parts.${noun}Label`)"
    >
      <li
        v-for="p in parts.items"
        :key="p.name"
        :data-part="p.name"
        :data-state="p.state"
        class="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2"
      >
        <component
          :is="ICONS[p.state]"
          class="size-3.5"
          :class="[TONES[p.state], p.state === 'running' ? 'animate-spin motion-reduce:animate-none' : '']"
          :aria-label="t(`jobs.parts.states.${p.state}`)"
        />
        <span class="truncate font-mono" :title="p.name">{{ p.name }}</span>
        <span class="text-fg-subtle tabular-nums">
          <template v-if="p.state === 'running' && percent(p) !== null">{{ percent(p) }}%</template>
          <template v-else-if="p.state === 'done' && p.done">{{ amount(p.done) }}</template>
          <template v-else>{{ t(`jobs.parts.states.${p.state}`) }}</template>
        </span>
      </li>
      <li v-if="hidden > 0" class="text-fg-subtle">{{ t('jobs.parts.more', { n: hidden }, hidden) }}</li>
    </ul>
  </div>
</template>
