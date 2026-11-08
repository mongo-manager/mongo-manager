<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Minus, Plus, TriangleAlert } from 'lucide-vue-next'
import {
  RETENTION_PRESETS,
  intervalOf,
  presetOf,
  shortestKeepDays,
  type RetentionPolicy,
  type RetentionPreset,
  type SchedulePreview,
} from '@mongo-manager/shared/browser'
import DsChoiceCard from '@/ds/DsChoiceCard.vue'
import { schedulesApi } from '@/api/schedules'
import RetentionTimeline from './RetentionTimeline.vue'
import { cadenceOf, type ScheduleDraft } from './useScheduleDraft'

/** Spec §1.4, §5: preset cards, custom tiers, what stays, what a saved schedule would lose now, Cold Storage. */
const props = defineProps<{ scheduleId?: string; coldNames: string[] }>()
const draft = defineModel<ScheduleDraft>('draft', { required: true })
const { t } = useI18n()
const PRESETS: RetentionPreset[] = ['daily30', 'standard', 'long', 'custom']
const TIERS = [
  { key: 'last', min: 1, max: 100 },
  { key: 'daily', min: 0, max: 90 },
  { key: 'weekly', min: 0, max: 52 },
  { key: 'monthly', min: 0, max: 60 },
] as const
const preset = ref<RetentionPreset>(presetOf(draft.value.retention))
function choose(value: string): void {
  preset.value = value as RetentionPreset
  if (preset.value !== 'custom') draft.value.retention = { ...RETENTION_PRESETS[preset.value] }
}
function step(key: keyof RetentionPolicy, delta: number): void {
  const tier = TIERS.find((x) => x.key === key)!
  draft.value.retention = {
    ...draft.value.retention,
    [key]: Math.min(tier.max, Math.max(tier.min, draft.value.retention[key] + delta)),
  }
}
function set(key: keyof RetentionPolicy, value: string): void {
  const tier = TIERS.find((x) => x.key === key)!
  const n = Number.parseInt(value, 10)
  if (Number.isFinite(n))
    draft.value.retention = { ...draft.value.retention, [key]: Math.min(tier.max, Math.max(tier.min, n)) }
}

// Spec §1.4: how many backups the policy would remove now — for a saved schedule, from the server.
const removals = ref<SchedulePreview['removals'] | null>(null)
let timer: ReturnType<typeof setTimeout> | undefined
let inflight: AbortController | null = null
watch(
  () =>
    [
      props.scheduleId,
      JSON.stringify(draft.value.retention),
      draft.value.timeZone,
      JSON.stringify(draft.value.destinations),
      draft.value.keepOnServer,
    ] as const,
  ([scheduleId]) => {
    clearTimeout(timer)
    inflight?.abort()
    if (!scheduleId) {
      removals.value = null
      return
    }
    timer = setTimeout(async () => {
      const mine = new AbortController()
      inflight = mine
      try {
        const out = await schedulesApi.preview(
          {
            scheduleId,
            retention: draft.value.retention,
            timeZone: draft.value.timeZone,
            // Final review minor 8: where it goes and whether it keeps change what goes now too.
            destinations: draft.value.destinations,
            keepOnServer: draft.value.keepOnServer,
          },
          { signal: mine.signal },
        )
        if (inflight === mine) removals.value = out.removals
      } catch {
        if (inflight === mine) removals.value = null
      }
    }, 300)
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  clearTimeout(timer)
  inflight?.abort()
})
const total = computed(() => removals.value?.reduce((n, r) => n + r.count, 0) ?? null)
const interval = computed(() => {
  try {
    return intervalOf(cadenceOf(draft.value))
  } catch {
    return 86_400_000
  }
})
const cold = computed(() => {
  if (!props.coldNames.length) return null
  const days = shortestKeepDays(draft.value.retention, interval.value)
  return days < 30
    ? t(
        'schedules.editor.retention.cold',
        {
          names: props.coldNames.join(', '),
          days: Math.max(1, Math.floor(days)),
        },
        props.coldNames.length,
      )
    : null
})
</script>

<template>
  <div class="flex flex-col gap-5">
    <div
      class="grid gap-3 lg:grid-cols-2"
      role="radiogroup"
      :aria-label="t('schedules.editor.retention.presets')"
    >
      <DsChoiceCard
        v-for="p in PRESETS"
        :key="p"
        :model-value="preset"
        name="retention"
        :value="p"
        :title="t(`schedules.editor.retention.${p}`)"
        :help="t(`schedules.editor.retention.${p}Help`)"
        @update:model-value="choose"
      />
    </div>

    <div v-if="preset === 'custom'" class="grid gap-3 sm:grid-cols-2">
      <div
        v-for="tier in TIERS"
        :key="tier.key"
        class="flex items-center justify-between gap-3 rounded-xl border border-line px-4 py-3"
      >
        <span class="text-ui font-medium text-fg">{{
          t(`schedules.editor.retention.tier.${tier.key}`)
        }}</span>
        <div class="flex items-center gap-1">
          <button
            type="button"
            class="flex size-8 cursor-pointer items-center justify-center rounded-lg border border-line hover:bg-subtle focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            :aria-label="
              t('schedules.editor.retention.decrease', {
                tier: t(`schedules.editor.retention.tier.${tier.key}`),
              })
            "
            :disabled="draft.retention[tier.key] <= tier.min"
            @click="step(tier.key, -1)"
          >
            <Minus class="size-4" aria-hidden="true" />
          </button>
          <input
            type="number"
            inputmode="numeric"
            :min="tier.min"
            :max="tier.max"
            :value="draft.retention[tier.key]"
            :aria-label="t(`schedules.editor.retention.tier.${tier.key}`)"
            class="h-8 w-16 rounded-lg border border-line-strong bg-surface text-center text-ui tabular-nums focus:border-focus focus:ring-2 focus:ring-focus/30 focus:outline-none"
            @change="set(tier.key, ($event.target as HTMLInputElement).value)"
          />
          <button
            type="button"
            class="flex size-8 cursor-pointer items-center justify-center rounded-lg border border-line hover:bg-subtle focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            :aria-label="
              t('schedules.editor.retention.increase', {
                tier: t(`schedules.editor.retention.tier.${tier.key}`),
              })
            "
            :disabled="draft.retention[tier.key] >= tier.max"
            @click="step(tier.key, 1)"
          >
            <Plus class="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>

    <RetentionTimeline :retention="draft.retention" :cadence="cadenceOf(draft)" :time-zone="draft.timeZone" />

    <div aria-live="polite" class="flex flex-col gap-1 text-ui">
      <p v-if="total !== null" :class="total > 0 ? 'text-warning' : 'text-fg-muted'">
        {{
          total > 0
            ? t('schedules.editor.retention.removeNow', { count: total }, total)
            : t('schedules.editor.retention.removeNone')
        }}
      </p>
      <ul v-if="total" class="text-small text-fg-subtle">
        <li v-for="r in removals!.filter((x) => x.count)" :key="r.location">
          {{ r.name ?? t('schedules.card.server') }}: {{ r.count }}
        </li>
      </ul>
    </div>
    <p
      v-if="cold"
      role="note"
      class="flex gap-2 rounded-lg border border-warning/25 bg-warning-soft px-3 py-2 text-ui text-warning"
    >
      <TriangleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />{{ cold }}
    </p>
  </div>
</template>
