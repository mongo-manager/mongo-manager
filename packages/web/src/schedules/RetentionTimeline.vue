<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Cadence, RetentionPolicy } from '@mongo-manager/shared/browser'
import { keptAges } from './retentionModel'

/**
 * Spec §5 "a timeline preview of what stays": the cadence's backups over the policy's horizon, run
 * through the same retention the server applies; the kept ones on a log time axis (now at the right).
 * Older days are one backup each — only a day's newest can stay past the "last" tier.
 */
const props = defineProps<{ retention: RetentionPolicy; cadence: Cadence; timeZone: string }>()
const { t, locale } = useI18n()
const HOUR = 3_600_000
const DAY = 24 * HOUR

const model = computed(() => {
  const kept = keptAges(props.retention, props.cadence, props.timeZone, Date.now())
  if (!kept) return null
  const maxAge = Math.max(DAY, ...kept)
  const left = (age: number) => 100 - (Math.log1p(age / HOUR) / Math.log1p(maxAge / HOUR)) * 100
  const ticks = [
    { key: 'day', age: DAY },
    { key: 'week', age: 7 * DAY },
    { key: 'month', age: 30 * DAY },
    { key: 'year', age: 365 * DAY },
  ].filter((x) => x.age < maxAge)
  return {
    dots: kept.map(left),
    ticks: ticks.map((x) => ({ key: x.key, left: left(x.age) })),
    count: kept.length,
  }
})

const caption = computed(() => {
  const r = props.retention
  const parts = [
    t('schedules.editor.retention.tierLast', { count: r.last }, r.last),
    r.daily ? t('schedules.editor.retention.tierDaily', { count: r.daily }, r.daily) : null,
    r.weekly ? t('schedules.editor.retention.tierWeekly', { count: r.weekly }, r.weekly) : null,
    r.monthly ? t('schedules.editor.retention.tierMonthly', { count: r.monthly }, r.monthly) : null,
  ].filter((p): p is string => p !== null)
  const tiers =
    parts.length > 1 && (locale.value === 'en' || locale.value === 'tr')
      ? `${parts.slice(0, -1).join(', ')} ${locale.value === 'tr' ? 've' : 'and'} ${parts.at(-1)}`
      : new Intl.ListFormat(locale.value, { type: 'conjunction' }).format(parts)
  return t(
    'schedules.editor.retention.keeps',
    { count: model.value?.count ?? 0, tiers },
    model.value?.count ?? 0,
  )
})
</script>

<template>
  <figure class="rounded-xl border border-line p-4">
    <figcaption class="text-ui font-medium text-fg">
      {{ t('schedules.editor.retention.timeline') }}
    </figcaption>
    <div v-if="model" class="relative mt-5 mb-6 h-6" aria-hidden="true">
      <div class="absolute inset-x-0 top-1/2 h-px bg-muted" />
      <span
        v-for="(left, i) in model.dots"
        :key="i"
        class="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent"
        :style="{ left: `${left}%` }"
      />
      <span
        v-for="tick in model.ticks"
        :key="tick.key"
        class="absolute top-full mt-1 -translate-x-1/2 text-[11px] whitespace-nowrap text-fg-subtle"
        :style="{ left: `${tick.left}%` }"
        >{{ t(`schedules.editor.retention.ticks.${tick.key}`) }}</span
      >
      <span class="absolute top-full right-0 mt-1 text-[11px] text-fg-subtle">{{
        t('schedules.editor.retention.now')
      }}</span>
    </div>
    <p data-test="keeps" class="text-ui text-fg-muted">{{ caption }}</p>
  </figure>
</template>
