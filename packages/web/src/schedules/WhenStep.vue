<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, X } from 'lucide-vue-next'
import { describeCadence, isTimeZone } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsInput from '@/ds/DsInput.vue'
import DsSelect from '@/ds/DsSelect.vue'
import { formatRelative } from '@/format'
import { cadenceOf, cadenceState, type CadenceKind, type ScheduleDraft } from './useScheduleDraft'
import { useCronWords, zonedTime } from './words'
import { uiLanguageOf } from '@mongo-manager/shared/browser'

/** Spec §1.3, §5: preset chips, times, weekdays, the zone, an advanced cron field, and the next five runs. */
const draft = defineModel<ScheduleDraft>('draft', { required: true })
const { t, locale } = useI18n()
const cronWords = useCronWords()
const zonesId = useId()
const KINDS: CadenceKind[] = ['hourly', 'daily', 'weekly', 'monthly', 'cron']
const DAYS = [1, 2, 3, 4, 5, 6, 7]
const MONTH_DAYS = Array.from({ length: 28 }, (_, i) => i + 1)
const ZONES = (() => {
  try {
    return Intl.supportedValuesOf('timeZone')
  } catch {
    return ['UTC']
  }
})()
const zoneValid = computed(() => isTimeZone(draft.value.timeZone))
const state = computed(() =>
  zoneValid.value ? cadenceState(draft.value, Date.now()) : { problem: null, runs: [] },
)
const words = computed(() => describeCadence(cadenceOf(draft.value), uiLanguageOf(locale.value)))
const problem = computed(() => {
  const p = state.value.problem
  if (!p) return null
  if (p.reason === 'cron') return cronWords(p)
  if (p.reason === 'min_gap') return t('schedules.editor.when.problem.min_gap', { minutes: p.minutes })
  return t('schedules.editor.when.problem.never')
})
// Final review minor 13: one polite announcement once typing settles, not one per keystroke.
const announced = ref('')
let settle: ReturnType<typeof setTimeout> | undefined
watch(
  () => [words.value, problem.value].filter(Boolean).join('. '),
  (now) => {
    clearTimeout(settle)
    settle = setTimeout(() => (announced.value = now), 800)
  },
)
onBeforeUnmount(() => clearTimeout(settle))
const dayName = (d: number, weekday: 'short' | 'long') =>
  new Intl.DateTimeFormat(locale.value, { weekday, timeZone: 'UTC' }).format(Date.UTC(2024, 0, d))
function toggleDay(d: number): void {
  const days = draft.value.days.includes(d)
    ? draft.value.days.filter((x) => x !== d)
    : [...draft.value.days, d]
  // At least one day: the last one stays chosen.
  if (days.length) draft.value.days = days.sort((a, b) => a - b)
}
function addTime(): void {
  if (draft.value.times.length >= 4) return
  const free =
    ['14:00', '08:00', '20:00', '02:00', '12:00'].find((x) => !draft.value.times.includes(x)) ?? '12:00'
  draft.value.times = [...draft.value.times, free]
}
function setTime(i: number, value: string): void {
  if (!value) return
  draft.value.times = draft.value.times.map((x, j) => (j === i ? value : x))
}
function removeTime(i: number): void {
  if (draft.value.times.length > 1) draft.value.times = draft.value.times.filter((_, j) => j !== i)
}
function setMonthDay(value: string): void {
  draft.value.monthDay = value === 'last' ? 'last' : Number(value)
}
// The kit's select speaks strings; the draft keeps numbers.
const every = computed({
  get: () => String(draft.value.every),
  set: (v: string) => (draft.value.every = Number(v)),
})
const minute = computed({
  get: () => String(draft.value.minute),
  set: (v: string) => (draft.value.minute = Number(v)),
})
const everyOptions = computed(() =>
  Array.from({ length: 24 }, (_, i) => ({
    value: String(i + 1),
    label: t('schedules.editor.when.hoursOption', { count: i + 1 }, i + 1),
  })),
)
const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, m) => ({
  value: String(m),
  label: `:${String(m).padStart(2, '0')}`,
}))
const monthDayOptions = computed(() => [
  ...MONTH_DAYS.map((n) => ({ value: String(n), label: String(n) })),
  { value: 'last', label: t('schedules.editor.when.lastDay') },
])
</script>

<template>
  <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_17rem]">
    <div class="flex flex-col gap-5">
      <fieldset>
        <legend class="mb-2 text-ui font-medium text-fg">
          {{ t('schedules.editor.when.presets') }}
        </legend>
        <div class="flex flex-wrap gap-2">
          <label
            v-for="k in KINDS"
            :key="k"
            class="cursor-pointer rounded-full border border-line px-3 py-1.5 text-ui text-fg transition-colors duration-150 hover:bg-subtle has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:checked]:text-accent-fg has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus"
          >
            <input v-model="draft.kind" type="radio" name="cadence" :value="k" class="sr-only" />{{
              t(`schedules.editor.when.${k}`)
            }}
          </label>
        </div>
      </fieldset>

      <div v-if="draft.kind === 'hourly'" class="flex flex-wrap items-end gap-3">
        <DsSelect v-model="every" :label="t('schedules.editor.when.every')" :options="everyOptions" />
        <DsSelect v-model="minute" :label="t('schedules.editor.when.atMinute')" :options="MINUTE_OPTIONS" />
      </div>

      <!-- UI review: one group of times side by side, each named by its place. -->
      <fieldset v-else-if="draft.kind === 'daily'" data-times class="flex flex-col gap-1.5">
        <legend class="mb-1.5 text-ui font-medium text-fg">
          {{ t('schedules.editor.when.times') }}
        </legend>
        <div class="flex flex-wrap items-center gap-2">
          <div v-for="(time, i) in draft.times" :key="i" class="flex items-center gap-0.5">
            <!-- Set on change, not per keystroke: a half-typed time is not a time. -->
            <DsInput
              :model-value="time"
              type="time"
              step="60"
              class="w-32"
              :aria-label="t('schedules.editor.when.timeN', { n: i + 1 })"
              @change="setTime(i, ($event.target as HTMLInputElement).value)"
            />
            <DsButton
              v-if="draft.times.length > 1"
              size="sm"
              variant="ghost"
              :aria-label="t('schedules.editor.when.removeTime', { time })"
              @click="removeTime(i)"
              ><X class="size-4" aria-hidden="true"
            /></DsButton>
          </div>
          <DsButton v-if="draft.times.length < 4" size="sm" variant="ghost" @click="addTime"
            ><Plus class="size-4" aria-hidden="true" />{{ t('schedules.editor.when.addTime') }}</DsButton
          >
        </div>
      </fieldset>

      <div v-else-if="draft.kind === 'weekly'" class="flex flex-col gap-3">
        <div role="group" :aria-label="t('schedules.editor.when.days')" class="flex flex-wrap gap-1.5">
          <button
            v-for="d in DAYS"
            :key="d"
            type="button"
            :aria-pressed="draft.days.includes(d)"
            :aria-label="dayName(d, 'long')"
            class="h-9 min-w-12 cursor-pointer rounded-lg border border-line px-2 text-ui text-fg transition-colors duration-150 hover:bg-subtle focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:text-on-accent"
            @click="toggleDay(d)"
          >
            {{ dayName(d, 'short') }}
          </button>
        </div>
        <DsInput
          v-model="draft.weeklyTime"
          class="w-32 self-start"
          :label="t('schedules.editor.when.time')"
          type="time"
          step="60"
        />
      </div>

      <div v-else-if="draft.kind === 'monthly'" class="flex flex-wrap items-end gap-3">
        <DsSelect
          :model-value="String(draft.monthDay)"
          :label="t('schedules.editor.when.day')"
          :options="monthDayOptions"
          @update:model-value="setMonthDay"
        />
        <DsInput
          v-model="draft.monthlyTime"
          class="w-32"
          :label="t('schedules.editor.when.time')"
          type="time"
          step="60"
        />
      </div>

      <DsInput
        v-else
        v-model="draft.expression"
        :label="t('schedules.editor.when.cronLabel')"
        :hint="t('schedules.editor.when.cronHelp')"
        mono
        :maxlength="200"
      />

      <DsInput
        v-model.trim="draft.timeZone"
        :label="t('schedules.editor.when.zone')"
        :list="zonesId"
        :error="zoneValid ? undefined : t('schedules.editor.when.zoneInvalid')"
        autocomplete="off"
        spellcheck="false"
      />
      <datalist :id="zonesId">
        <option v-for="z in ZONES" :key="z" :value="z" />
      </datalist>
    </div>

    <aside class="flex flex-col gap-3 self-start rounded-xl bg-subtle p-4">
      <h4 class="text-small font-medium tracking-wide text-fg-subtle uppercase">
        {{ t('schedules.editor.when.words') }}
      </h4>
      <p data-test="words" class="text-ui font-medium text-fg">{{ words ?? '—' }}</p>
      <p v-if="problem" class="text-ui text-danger">{{ problem }}</p>
      <template v-if="state.runs.length">
        <h4 class="text-small font-medium tracking-wide text-fg-subtle uppercase">
          {{ t('schedules.editor.when.next') }}
        </h4>
        <ol class="flex flex-col gap-1 text-ui tabular-nums">
          <li v-for="r in state.runs" :key="r" data-run class="text-fg">
            {{ zonedTime(r, draft.timeZone, locale) }}
            <span class="text-small text-fg-subtle">· {{ formatRelative(r - Date.now(), locale) }}</span>
          </li>
        </ol>
      </template>
    </aside>
    <p data-test="when-live" class="sr-only" aria-live="polite">{{ announced }}</p>
  </div>
</template>
