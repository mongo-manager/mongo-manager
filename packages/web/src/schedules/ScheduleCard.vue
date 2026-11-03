<script setup lang="ts">
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  CalendarClock,
  CirclePause,
  CirclePlay,
  Cloud,
  History,
  Lock,
  LockOpen,
  Pencil,
  Play,
  Server,
  Trash2,
  UserRound,
} from 'lucide-vue-next'
import { describeCadence, type ScheduleView } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsMenu from '@/ds/DsMenu.vue'
import type { DsMenuItem } from '@/ds/menu'
import { formatRelative } from '@/format'
import { useSessionStore } from '@/stores/session'
import RunStrip from './RunStrip.vue'
import { useRunReason, useScopeWords, zonedTime } from './words'
import { uiLanguageOf } from '@mongo-manager/shared/browser'

/** Spec §5: a schedule at a glance — what, when (in its zone), where, the last runs, and its actions. */
const props = defineProps<{ schedule: ScheduleView; now: number }>()
const emit = defineEmits<{ run: []; pause: []; resume: []; edit: []; history: []; remove: [] }>()
const { t, locale } = useI18n()
const scopeWords = useScopeWords()
const reasonText = useRunReason()
const titleId = useId()
const s = computed(() => props.schedule)
const words = computed(
  () => describeCadence(s.value.cadence, uiLanguageOf(locale.value)) ?? s.value.cadence.kind,
)
const next = computed(() =>
  s.value.nextRunAt === null
    ? null
    : {
        rel: formatRelative(s.value.nextRunAt - props.now, locale.value),
        abs: zonedTime(s.value.nextRunAt, s.value.timeZone, locale.value),
      },
)
// Final review I4 (spec §5 Signals): the last finished run failed or was partial — the same rule as
// the account menu's badge.
const lastDone = computed(() =>
  [...s.value.lastRuns].reverse().find((r) => r.outcome !== 'running' && r.outcome !== 'queued'),
)
const health = computed<'failing' | 'partial' | null>(() =>
  s.value.state !== 'active'
    ? null
    : lastDone.value?.outcome === 'failed'
      ? 'failing'
      : lastDone.value?.outcome === 'partial'
        ? 'partial'
        : null,
)
const healthNote = computed(() =>
  health.value
    ? t(`schedules.card.last.${health.value}`, { reason: reasonText(lastDone.value?.reason ?? null) ?? '' })
    : null,
)
const session = useSessionStore()
const administrator = computed(() => session.me?.mode === 'local' || session.me?.user.role === 'admin')
// Final review minor 24: an administrator's pause is an administrator's to lift.
const adminPause = computed(() => s.value.pause?.reason === 'admin' && !administrator.value)
const paused = computed(() =>
  s.value.pause
    ? [
        reasonText(s.value.pause.reason, s.value.pause.byName ?? ''),
        adminPause.value ? t('schedules.card.askAdmin') : null,
      ]
        .filter(Boolean)
        .join(' ')
    : null,
)
const items = computed<DsMenuItem[]>(() => [
  ...(s.value.mine ? [{ id: 'edit', label: t('schedules.card.edit'), icon: Pencil }] : []),
  ...(s.value.state === 'active'
    ? [{ id: 'pause', label: t('schedules.card.pause'), icon: CirclePause }]
    : adminPause.value
      ? []
      : [{ id: 'resume', label: t('schedules.card.resume'), icon: CirclePlay }]),
  { id: 'history', label: t('schedules.card.history'), icon: History },
  { id: 'remove', label: t('schedules.card.delete'), icon: Trash2, danger: true },
])
function select(id: string): void {
  if (id === 'edit') emit('edit')
  else if (id === 'pause') emit('pause')
  else if (id === 'resume') emit('resume')
  else if (id === 'history') emit('history')
  else if (id === 'remove') emit('remove')
}
const chip =
  'inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs text-fg-muted'
</script>

<template>
  <article
    :data-schedule="s.id"
    :aria-labelledby="titleId"
    class="flex flex-col gap-4 rounded-card border border-line bg-surface p-5 transition-shadow duration-150 hover:shadow-sm"
  >
    <header class="flex items-start gap-3">
      <span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft">
        <CalendarClock class="size-5 text-accent-fg" aria-hidden="true" />
      </span>
      <div class="min-w-0 flex-1">
        <h3 :id="titleId" class="truncate font-semibold text-fg">{{ s.name }}</h3>
        <p class="truncate text-ui text-fg-subtle">
          {{ s.connectionName ?? '—' }} · {{ scopeWords(s.dump.scope) }}
        </p>
      </div>
      <span
        class="shrink-0 rounded-full px-2 py-0.5 text-small font-medium"
        :class="
          health === 'failing'
            ? 'bg-danger-soft text-danger'
            : s.state === 'active' && !health
              ? 'bg-success-soft text-success'
              : 'bg-warning-soft text-warning'
        "
        >{{ health ? t(`schedules.state.${health}`) : t(`schedules.state.${s.state}`) }}</span
      >
      <DsMenu :label="t('schedules.card.more', { name: s.name })" :items="items" focusable @select="select" />
    </header>

    <div class="flex flex-col gap-1 text-ui">
      <p class="text-fg">
        {{ words }} <span class="text-fg-subtle">({{ s.timeZone }})</span>
      </p>
      <p v-if="next" class="text-fg-muted">
        {{ t('schedules.card.next', { relative: next.rel }) }} ·
        <span class="tabular-nums">{{ next.abs }}</span>
      </p>
      <p
        v-if="healthNote"
        role="note"
        class="rounded-lg px-3 py-2"
        :class="health === 'failing' ? 'bg-danger-soft text-danger' : 'bg-warning-soft text-warning'"
      >
        {{ healthNote }}
      </p>
      <p v-if="paused" role="note" class="rounded-lg bg-warning-soft px-3 py-2 text-warning">
        {{ paused }}
      </p>
    </div>

    <RunStrip :runs="s.lastRuns" :time-zone="s.timeZone" />

    <div class="flex flex-wrap items-center gap-1.5">
      <span v-for="d in s.destinations" :key="d.id" :class="chip"
        ><Cloud class="size-3" aria-hidden="true" />{{ d.name ?? '—' }}</span
      >
      <span v-if="s.keepOnServer" :class="chip"
        ><Server class="size-3" aria-hidden="true" />{{ t('schedules.card.server') }}</span
      >
      <span v-if="!s.mine" :class="chip"
        ><UserRound class="size-3" aria-hidden="true" />{{ s.owner.username ?? s.owner.id }}</span
      >
      <span v-if="s.format === 'mmbak' && s.key" :class="chip"
        ><Lock class="size-3 text-success" aria-hidden="true" /><span class="font-mono">{{
          s.key.fingerprint
        }}</span></span
      >
      <span v-else-if="s.format !== 'mmbak'" :class="chip"
        ><LockOpen class="size-3" aria-hidden="true" />{{ t('schedules.card.plain') }}</span
      >
    </div>

    <footer class="mt-auto flex flex-wrap items-center gap-2">
      <DsButton size="sm" @click="emit('run')"
        ><Play class="size-4" aria-hidden="true" />{{ t('schedules.card.runNow') }}</DsButton
      >
      <DsButton size="sm" variant="ghost" @click="emit('history')"
        ><History class="size-4" aria-hidden="true" />{{ t('schedules.card.history') }}</DsButton
      >
    </footer>
  </article>
</template>
