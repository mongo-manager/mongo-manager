<script setup lang="ts">
import { computed, defineAsyncComponent, ref, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import {
  ArrowRightLeft,
  BellRing,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock,
  Gauge,
  ListX,
  RefreshCw,
  RotateCcw,
  Sparkles,
  X,
  Zap,
} from 'lucide-vue-next'
import {
  NEXT_ACTION_LIMITS,
  objectKey,
  type NextActionKind,
  type Widget,
} from '@mongo-manager/shared/browser'
import DsMenu from '@/ds/DsMenu.vue'
import type { DsMenuItem } from '@/ds/menu'
import { connectionsApi, queryKeys } from '@/api/connections'
import { serverApi, serverKeys } from '@/api/server'
import { nextActionsApi, nextActionsKeys } from '@/api/nextActions'
import { useAiStatus } from '@/ai/useAi'
import { useAiWords } from '@/ai/words'
import { useAlertSignals } from '@/alerts/useAlertSignals'
import { useJobsStore } from '@/jobs/store'
import { useLiveSyncSignals } from '@/livesync/useLiveSyncs'
import { useScheduleSignals } from '@/schedules/useScheduleSignals'
import { useDashboardStore } from '@/stores/dashboard'
import { placeOfTab, usePlacesStore, type Place } from '@/stores/places'
import { useTabSectionsStore } from '@/stores/tabSections'
import { useTabsStore } from '@/stores/tabs'
import { useToastStore } from '@/stores/toasts'
import { ApiError } from '@/api/client'
import {
  openAlertsTab,
  openCollectionTab,
  openConnectionTab,
  openDatabaseTab,
  openJobsTab,
  openLiveSyncsTab,
  openSchedulesTab,
} from '../../openTabs'
import { factsOf, ordered, suggest, visible, type Step } from '../nextActions'
import WidgetFrame from './WidgetFrame.vue'
import { uiLanguageOf } from '@mongo-manager/shared/browser'

const IndexCreateDialog = defineAsyncComponent(() => import('@/indexes/IndexCreateDialog.vue'))

/**
 * completion W6.2: the next steps. Worked out without AI (see nextActions.ts), each a link that
 * does it, each dismissable (remembered with the dashboard, with Undo). "Order with AI", offered only
 * where the assistant is set up and kept off until the user turns it on, has the AI put the steps in
 * order and title them from their facts — names and counts, never a value — and never adds a step.
 */
const props = defineProps<{ widget: Widget }>()
const { t, locale } = useI18n()
const store = useDashboardStore()
const tabs = useTabsStore()
const places = usePlacesStore()
const jobs = useJobsStore()
const sections = useTabSectionsStore()
const toasts = useToastStore()
const aiWords = useAiWords()

/** The widget as the dashboard has it now (its settings change here). */
const live = computed(() => store.widgets.find((w) => w.id === props.widget.id) ?? props.widget)
const settings = computed(() => live.value.settings as { ai?: boolean; dismissed?: string[] })
function setSettings(next: { ai?: boolean; dismissed?: string[] }): void {
  // Review I2: whatever is kept fits the dashboard's limits, so a save is never refused for it.
  const { dismissed, ...rest } = next
  const kept = (dismissed ?? [])
    .filter((d) => d.length > 0 && d.length <= NEXT_ACTION_LIMITS.idChars)
    .slice(-NEXT_ACTION_LIMITS.dismissed)
  store.configure(props.widget.id, dismissed === undefined ? rest : { ...rest, dismissed: kept })
}

const connections = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
const connectionOf = (id: string | undefined) => connections.data.value?.find((c) => c.id === id)
const { alerts } = useAlertSignals()
const { attention: schedules } = useScheduleSignals()
const { attention: syncs } = useLiveSyncSignals()

/** The database used last, on a connection whose server the user may watch: its index advice. */
const adviceOn = computed(() => {
  for (const p of places.recent) {
    const c = connectionOf(p.params.connectionId)
    if (p.params.db && c?.permissions.includes('server:monitor'))
      return { connectionId: c.id, db: p.params.db }
  }
  return null
})
const advice = useQuery({
  queryKey: computed(() =>
    serverKeys.indexAdvice(adviceOn.value?.connectionId ?? '', adviceOn.value?.db ?? ''),
  ),
  queryFn: () => serverApi.indexAdvice(adviceOn.value!.connectionId, adviceOn.value!.db),
  enabled: computed(() => adviceOn.value !== null),
  // It reads the server's slow queries: once in a while is enough for a suggestion.
  staleTime: 10 * 60_000,
  retry: false,
})

const steps = computed(() =>
  suggest({
    now: Date.now(),
    firing: alerts.value.filter((a) => a.state === 'firing'),
    jobs: jobs.list,
    schedules: schedules.value,
    liveSyncs: syncs.value,
    recent: places.recent.filter((p) => connectionOf(p.params.connectionId)),
    open: new Set(tabs.tabs.flatMap((tab) => placeOfTab(tab)?.key ?? [])),
    advice:
      adviceOn.value && advice.data.value
        ? {
            ...adviceOn.value,
            advice: advice.data.value,
            canCreate:
              connectionOf(adviceOn.value.connectionId)?.permissions.includes('indexes:write') ?? false,
          }
        : null,
  }),
)
const shown = computed(() => visible(steps.value, settings.value.dismissed ?? []))

// The AI's order: asked only when turned on, and only with the facts of the steps shown.
const aiStatus = useAiStatus()
const aiOffered = computed(() => !!aiStatus.data.value?.enabled)
const aiOn = computed(() => aiOffered.value && settings.value.ai === true)
const request = computed(() => ({
  language: uiLanguageOf(locale.value),
  items: factsOf(shown.value),
}))
/**
 * Review minor 2: the AI is asked again only when the steps themselves change (their kinds and
 * names), or on "Reorder with AI" — never because a count moved or time passed.
 */
const signature = computed(() =>
  JSON.stringify([request.value.language, request.value.items.map(({ count: _count, ...same }) => same)]),
)
const rank = useQuery({
  queryKey: computed(() => nextActionsKeys.rank(signature.value)),
  queryFn: () => nextActionsApi.rank(request.value),
  enabled: computed(() => aiOn.value && request.value.items.length > 0),
  staleTime: Infinity,
  gcTime: 24 * 3_600_000,
  refetchOnWindowFocus: false,
  retry: false,
})
const list = computed(() => ordered(shown.value, aiOn.value ? (rank.data.value ?? null) : null))
const aiNote = computed(() => {
  if (!aiOn.value || shown.value.length === 0) return null
  if (rank.isError.value) {
    const e = rank.error.value
    const reason = e instanceof ApiError ? (e.details as { reason?: string } | undefined)?.reason : undefined
    return t('nextActions.ai.failed', {
      reason: reason ? aiWords.reason(reason) : t('nextActions.ai.noAnswer'),
    })
  }
  if (rank.isFetching.value && !rank.data.value) return t('nextActions.ai.ordering')
  const data = rank.data.value
  if (!data) return null
  if (data.reason === 'unreadable') return t('nextActions.ai.unreadable')
  if (data.reason === 'nothing_allowed') return t('nextActions.ai.nothingAllowed')
  return data.withheld.length
    ? t(
        'nextActions.ai.orderedSome',
        { provider: data.provider?.name ?? '', n: data.withheld.length },
        data.withheld.length,
      )
    : t('nextActions.ai.ordered', { provider: data.provider?.name ?? '' })
})

const ICONS: Record<NextActionKind, Component> = {
  alerts: BellRing,
  failedJobs: ListX,
  liveSyncs: ArrowRightLeft,
  schedules: CalendarClock,
  createIndex: Zap,
  slowQueries: Gauge,
  continue: Clock,
}
const TONES: Partial<Record<NextActionKind, string>> = {
  alerts: 'bg-danger-soft text-danger',
  failedJobs: 'bg-danger-soft text-danger',
  liveSyncs: 'bg-warning-soft text-warning',
  schedules: 'bg-warning-soft text-warning',
  createIndex: 'bg-accent-soft text-accent-fg',
  slowQueries: 'bg-info-soft text-info',
}
const placeName = (s: Step) =>
  s.facts.coll
    ? `${s.facts.db}.${s.facts.coll}`
    : (s.facts.db ?? connectionOf(s.facts.connectionId)?.name ?? '')
function titleOf(s: Step): string {
  const n = s.facts.count ?? 0
  switch (s.kind) {
    case 'createIndex':
      return t('nextActions.createIndex.title', {
        coll: s.facts.coll ?? '',
        fields: (s.facts.fields ?? []).join(', '),
      })
    case 'slowQueries':
      return t('nextActions.slowQueries.title', { n, db: s.facts.db ?? '' }, n)
    case 'continue':
      return t('nextActions.continue.title', { name: placeName(s) })
    default:
      return t(`nextActions.${s.kind}.title`, { n }, n)
  }
}
function hintOf(s: Step): string {
  const n = s.facts.count ?? 0
  if (s.kind === 'createIndex') return t('nextActions.createIndex.hint', { n }, n)
  if (s.kind === 'continue') return connectionOf(s.facts.connectionId)?.name ?? ''
  return t(`nextActions.${s.kind}.hint`)
}

const creating = ref<{ target: { connectionId: string; db: string; coll: string }; key: string } | null>(null)
function openPlace(p: Place): void {
  const c = connectionOf(p.params.connectionId)
  if (!c) return
  if (p.kind === 'connection') openConnectionTab(tabs, c)
  else if (p.kind === 'database') openDatabaseTab(tabs, c.id, p.params.db!)
  else openCollectionTab(tabs, c.id, p.params.db!, p.params.coll!)
}
function run(s: Step): void {
  const target = s.target
  switch (target.to) {
    case 'alerts':
      return void openAlertsTab(tabs)
    case 'jobs':
      jobs.focus(target.jobId)
      return void openJobsTab(tabs)
    case 'schedules':
      return void openSchedulesTab(tabs)
    case 'liveSyncs':
      return void openLiveSyncsTab(tabs)
    case 'createIndex':
      // The usual dialog with the key filled in: nothing is built until the user confirms there.
      creating.value = {
        target: { connectionId: target.connectionId, db: target.db, coll: target.coll },
        key: `{ ${target.key.map(([f, d]) => `${objectKey(f)}: ${d}`).join(', ')} }`,
      }
      return
    case 'performance': {
      const c = connectionOf(target.connectionId)
      if (!c) return
      sections.set(openConnectionTab(tabs, c), 'performance')
      return
    }
    case 'place':
      return openPlace(target.place)
  }
}

/** Dismissed: remembered with the dashboard (the oldest forgotten past 100), with Undo. */
function dismiss(s: Step): void {
  const before = settings.value
  setSettings({ ...before, dismissed: [...(before.dismissed ?? []), s.key].slice(-100) })
  toasts.push({
    kind: 'info',
    message: t('nextActions.dismissed', { title: titleOf(s) }),
    // Review minor 5: only the dismissal is taken back (the AI toggle may have changed since).
    actions: [
      {
        label: t('overview.dashboard.undo'),
        run: () =>
          setSettings({
            ...settings.value,
            dismissed: (settings.value.dismissed ?? []).filter((k) => k !== s.key),
          }),
      },
    ],
  })
}

const menu = computed<DsMenuItem[]>(() => [
  ...(aiOffered.value
    ? [{ id: 'ai', label: t('nextActions.ai.toggle'), icon: settings.value.ai ? Check : Sparkles }]
    : []),
  ...(aiOn.value && shown.value.length > 0
    ? [{ id: 'reorder', label: t('nextActions.ai.reorder'), icon: RefreshCw }]
    : []),
  ...(settings.value.dismissed?.length
    ? [{ id: 'restore', label: t('nextActions.restore'), icon: RotateCcw }]
    : []),
])
function onMenu(id: string): void {
  if (id === 'ai') setSettings({ ...settings.value, ai: !settings.value.ai })
  else if (id === 'reorder') void rank.refetch()
  else if (id === 'restore') {
    const { dismissed: _gone, ...rest } = settings.value
    setSettings(rest)
  }
}
</script>

<template>
  <WidgetFrame :title="t('overview.widgets.nextActions.title')" :count="list.length || undefined">
    <template v-if="menu.length" #actions>
      <span data-next-actions-menu>
        <DsMenu :label="t('nextActions.options')" :items="menu" focusable size="header" @select="onMenu" />
      </span>
    </template>
    <p
      v-if="!list.length"
      data-next-actions-quiet
      class="flex items-center gap-2 py-1 text-small text-fg-muted"
    >
      <CheckCircle2 class="size-4 shrink-0 text-success" aria-hidden="true" />
      {{ t('nextActions.quiet') }}
    </p>
    <ul v-else class="-mx-2 flex flex-col">
      <li
        v-for="{ step, title } in list"
        :key="step.key"
        :data-next-action="step.kind"
        class="group flex items-center gap-1 rounded-lg pr-1 transition-colors duration-120 hover:bg-subtle"
      >
        <button
          type="button"
          data-do
          class="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 text-left"
          @click="run(step)"
        >
          <span
            class="grid size-7 shrink-0 place-items-center rounded-md"
            :class="TONES[step.kind] ?? 'bg-subtle text-fg-muted'"
          >
            <component :is="ICONS[step.kind]" class="size-3.5" aria-hidden="true" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-ui font-medium text-fg">{{ title ?? titleOf(step) }}</span>
            <span class="block truncate text-small text-fg-subtle">{{
              title ? titleOf(step) : hintOf(step)
            }}</span>
          </span>
          <ChevronRight class="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
        </button>
        <button
          type="button"
          data-dismiss
          class="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-subtle opacity-0 transition-opacity duration-120 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-muted hover:text-fg focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
          :aria-label="t('nextActions.dismiss', { title: titleOf(step) })"
          :title="t('nextActions.dismissShort')"
          @click="dismiss(step)"
        >
          <X class="size-3.5" aria-hidden="true" />
        </button>
      </li>
    </ul>
    <p
      v-if="aiNote"
      data-next-actions-ai
      class="mt-2 flex items-center gap-1.5 text-small text-fg-subtle"
      aria-live="polite"
    >
      <Sparkles class="size-3.5 shrink-0" aria-hidden="true" />{{ aiNote }}
    </p>
    <IndexCreateDialog
      v-if="creating"
      :target="creating.target"
      :initial-key="creating.key"
      @close="creating = null"
    />
  </WidgetFrame>
</template>
