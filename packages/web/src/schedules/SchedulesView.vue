<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { CalendarClock, Clock, Cloud, Plus, RotateCcw, Timer } from 'lucide-vue-next'
import type { RunMark, ScheduleView } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsPageHeader from '@/ds/DsPageHeader.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsSelect from '@/ds/DsSelect.vue'
import { scheduleKeys, schedulesApi } from '@/api/schedules'
import { describeError } from '@/api/errors'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import { useWorkspaceDialogs } from '@/stores/workspaceDialogs'
import { useJobsStore } from '@/jobs/store'
import ScheduleCard from './ScheduleCard.vue'
import RunHistory from './RunHistory.vue'
import { useScheduleError } from './words'

/** Phase 3d-3c spec §5: the Scheduled backups tab — cards, an owner filter for administrators, an explaining empty state. */
const { t } = useI18n()
const queryClient = useQueryClient()
const dialogs = useDialogStore()
const toasts = useToastStore()
const workspace = useWorkspaceDialogs()
const jobs = useJobsStore()
const scheduleError = useScheduleError()
const list = useQuery({
  queryKey: scheduleKeys.list,
  queryFn: () => schedulesApi.list(),
  refetchInterval: 30_000,
})
const refresh = () => queryClient.invalidateQueries({ queryKey: scheduleKeys.all })
// A scheduled job's end moves a card's strip at once.
const stopListening = jobs.onFinished((job) => {
  if (job.scheduleName) void refresh()
})
const now = ref(Date.now())
const clock = setInterval(() => (now.value = Date.now()), 30_000)
onBeforeUnmount(() => {
  stopListening()
  clearInterval(clock)
})

const all = computed(() => list.data.value?.schedules ?? [])
const owner = ref('')
const ownerOptions = computed(() => [
  { value: '', label: t('schedules.owner.all') },
  { value: 'mine', label: t('schedules.owner.mine') },
  ...[
    ...new Map(all.value.filter((s) => !s.mine).map((s) => [s.owner.id, s.owner.username ?? s.owner.id])),
  ].map(([value, label]) => ({ value, label })),
])
const shown = computed(() =>
  all.value.filter((s) => !owner.value || (owner.value === 'mine' ? s.mine : s.owner.id === owner.value)),
)
const history = ref<ScheduleView | null>(null)
const POINTS = [
  { key: 'when', icon: Clock },
  { key: 'where', icon: Cloud },
  { key: 'keep', icon: Timer },
] as const
const LEGEND: RunMark['outcome'][] = ['succeeded', 'partial', 'failed', 'skipped', 'missed']
const DOT: Record<string, string> = {
  succeeded: 'bg-success',
  partial: 'bg-warning',
  failed: 'bg-danger',
  skipped: 'bg-line-strong',
  missed: 'border border-dashed border-fg-subtle',
}

const create = () => workspace.open({ kind: 'backupSchedule' })
const edit = (s: ScheduleView) =>
  workspace.open({ kind: 'backupSchedule', scheduleId: s.id, connectionId: s.connectionId })
async function act(s: ScheduleView, what: 'run' | 'pause' | 'resume'): Promise<void> {
  try {
    if (what === 'run') {
      await schedulesApi.run(s.id)
      toasts.push({ kind: 'success', message: t('schedules.run.started', { name: s.name }) })
    } else if (what === 'pause') await schedulesApi.pause(s.id)
    else await schedulesApi.resume(s.id)
  } catch (e) {
    toasts.push({ kind: 'error', message: scheduleError(e) })
  } finally {
    await refresh()
  }
}
async function remove(s: ScheduleView): Promise<void> {
  const ok = await dialogs.confirm({
    title: t('schedules.deleteTitle', { name: s.name }),
    message: t('schedules.deleteHelp'),
    confirmLabel: t('schedules.deleteConfirm'),
    danger: true,
  })
  if (!ok) return
  try {
    await schedulesApi.remove(s.id)
  } catch (e) {
    toasts.push({ kind: 'error', message: scheduleError(e) })
  } finally {
    await refresh()
  }
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <DsPageHeader :title="t('schedules.title')" :icon="CalendarClock" :description="t('schedules.subtitle')">
      <template #actions>
        <DsSelect
          v-if="ownerOptions.length > 2"
          v-model="owner"
          class="w-48 max-w-full"
          size="sm"
          :label="t('schedules.owner.label')"
          hide-label
          :options="ownerOptions"
        />
        <DsButton v-if="all.length" size="sm" variant="primary" @click="create"
          ><Plus class="size-4" aria-hidden="true" />{{ t('schedules.new') }}</DsButton
        >
      </template>
    </DsPageHeader>
    <div class="min-h-0 flex-1 overflow-auto">
      <div class="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
        <DsCallout v-if="list.data.value && !list.data.value.enabled" tone="warning" role="status">{{
          t('schedules.off')
        }}</DsCallout>

        <div v-if="list.isPending.value" class="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-busy="true">
          <span class="sr-only" role="status">{{ t('app.loading') }}</span
          ><DsSkeleton v-for="n in 3" :key="n" class="h-64 rounded-card" />
        </div>
        <DsCallout v-else-if="list.isError.value" tone="danger"
          >{{ describeError(list.error.value, t)
          }}<template #action
            ><DsButton size="sm" :loading="list.isFetching.value" @click="list.refetch()"
              ><RotateCcw class="size-4" aria-hidden="true" />{{ t('common.retry') }}</DsButton
            ></template
          ></DsCallout
        >
        <section
          v-else-if="!all.length"
          class="flex flex-col items-center gap-6 rounded-card border border-dashed border-line-strong px-6 py-12 text-center"
        >
          <span class="flex size-12 items-center justify-center rounded-2xl bg-accent-soft">
            <CalendarClock class="size-6 text-accent-fg" aria-hidden="true" />
          </span>
          <div class="flex max-w-xl flex-col gap-2">
            <h3 class="text-title-s font-semibold text-fg">{{ t('schedules.empty.title') }}</h3>
            <p class="text-ui text-fg-subtle">{{ t('schedules.empty.help') }}</p>
          </div>
          <ul class="grid w-full max-w-3xl gap-3 text-left sm:grid-cols-3">
            <li
              v-for="p in POINTS"
              :key="p.key"
              class="flex gap-3 rounded-xl border border-line bg-surface p-4 text-ui"
            >
              <component :is="p.icon" class="mt-0.5 size-5 shrink-0 text-accent-fg" aria-hidden="true" />
              <span class="text-fg">{{ t(`schedules.empty.${p.key}`) }}</span>
            </li>
          </ul>
          <DsButton variant="primary" @click="create"
            ><Plus class="size-4" aria-hidden="true" />{{ t('schedules.empty.action') }}</DsButton
          >
        </section>
        <template v-else>
          <ul
            class="flex flex-wrap gap-3 text-small text-fg-subtle"
            :aria-label="t('schedules.strip.legend')"
          >
            <li v-for="o in LEGEND" :key="o" class="flex items-center gap-1.5">
              <span class="h-3 w-2 rounded-sm" :class="DOT[o]" aria-hidden="true" />{{
                t(`schedules.outcome.${o}`)
              }}
            </li>
          </ul>
          <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <ScheduleCard
              v-for="s in shown"
              :key="s.id"
              :schedule="s"
              :now="now"
              @run="act(s, 'run')"
              @pause="act(s, 'pause')"
              @resume="act(s, 'resume')"
              @edit="edit(s)"
              @history="history = s"
              @remove="remove(s)"
            />
          </div>
        </template>
        <RunHistory v-if="history" :schedule="history" @close="history = null" />
      </div>
    </div>
  </div>
</template>
