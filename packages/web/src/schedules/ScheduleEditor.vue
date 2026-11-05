<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { CalendarCheck, Lock, LockOpen } from 'lucide-vue-next'
import {
  describeCadence,
  isTimeZone,
  type PreflightFix,
  type ScheduleView,
} from '@mongo-manager/shared/browser'
import DsSheet from '@/ds/DsSheet.vue'
import DsStepper, { type StepItem } from '@/ds/DsStepper.vue'
import DsButton from '@/ds/DsButton.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import { ApiError } from '@/api/client'
import { connectionsApi, queryKeys } from '@/api/connections'
import { destinationKeys, destinationsApi } from '@/api/destinations'
import { backupApi, backupKeys } from '@/api/backup'
import { keysApi, scheduleKeys, schedulesApi } from '@/api/schedules'
import { formatBytes } from '@/format'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import WhereSection from '@/backup/WhereSection.vue'
import PreflightList from '@/backup/PreflightList.vue'
import WhatStep from './WhatStep.vue'
import WhenStep from './WhenStep.vue'
import ProtectionStep from './ProtectionStep.vue'
import RetentionStep from './RetentionStep.vue'
import DrillSetting from './DrillSetting.vue'
import {
  bodyOf,
  cadenceOf,
  cadenceState,
  comparable,
  draftFrom,
  newDraft,
  scopeReady,
  useSchedulePlan,
} from './useScheduleDraft'
import { useScheduleError, useScopeWords, zonedTime } from './words'
import { keptAges } from './retentionModel'
import { uiLanguageOf } from '@mongo-manager/shared/browser'

/** Phase 3d-3c spec §5: What → When → Protection → Where → Retention → Summary, a new schedule or its owner's edit. */
const props = defineProps<{ connectionId?: string; db?: string; coll?: string; scheduleId?: string }>()
const emit = defineEmits<{ close: [] }>()
const { t, locale } = useI18n()
const queryClient = useQueryClient()
const dialogs = useDialogStore()
const toasts = useToastStore()
const scheduleError = useScheduleError()
const scopeWords = useScopeWords()
const sheet = ref<InstanceType<typeof DsSheet> | null>(null)

const list = useQuery({
  queryKey: scheduleKeys.list,
  queryFn: () => schedulesApi.list(),
  enabled: Boolean(props.scheduleId),
})
const existing = computed<ScheduleView | null>(() =>
  props.scheduleId ? (list.data.value?.schedules.find((s) => s.id === props.scheduleId) ?? null) : null,
)
const state = reactive({
  draft: newDraft({ connectionId: props.connectionId, db: props.db, coll: props.coll }),
})
const snapshot = ref<string | null>(props.scheduleId ? null : comparable(state.draft))
watch(
  existing,
  (s) => {
    if (s && snapshot.value === null) {
      state.draft = draftFrom(s)
      snapshot.value = comparable(state.draft)
    }
  },
  { immediate: true },
)
const ready = computed(() => snapshot.value !== null)
/** Final review minor 20: a schedule deleted meanwhile (or never there) is said to be gone. */
const gone = computed(() => Boolean(props.scheduleId) && list.isSuccess.value && !existing.value)
const dirty = computed(() => ready.value && comparable(state.draft) !== snapshot.value)

const { data: keys } = useQuery({ queryKey: scheduleKeys.keys, queryFn: () => keysApi.list() })
const activeKey = computed(() => keys.value?.find((k) => k.state === 'active') ?? null)
const { data: destinations } = useQuery({
  queryKey: destinationKeys.mine,
  queryFn: () => destinationsApi.mine(),
})
const { data: connections } = useQuery({
  queryKey: queryKeys.connections,
  queryFn: () => connectionsApi.list(),
})
const { data: usage } = useQuery({ queryKey: backupKeys.usage, queryFn: () => backupApi.usage() })
const { plan, loading, personal } = useSchedulePlan(() => state.draft)

const chosen = computed(() =>
  (destinations.value ?? []).filter((d) => state.draft.destinations.includes(d.id)),
)
const encryptedOnlyNames = computed(() =>
  chosen.value.filter((d) => d.policy.encryptedOnly).map((d) => d.name),
)
const blocked = computed<'encryptedOnly' | 'personal' | 'checking' | null>(() =>
  encryptedOnlyNames.value.length
    ? 'encryptedOnly'
    : state.draft.anonymous
      ? null
      : personal.value === null
        ? 'checking'
        : personal.value
          ? 'personal'
          : null,
)
const coldNames = computed(() => chosen.value.filter((d) => d.coldStorage).map((d) => d.name))
const when = computed(() => cadenceState(state.draft, Date.now()))
const connectionName = computed(
  () => (connections.value ?? []).find((c) => c.id === state.draft.connectionId)?.name ?? '',
)
/** What the summary shows for a part not chosen yet. */
const NONE = '—'
// Final review minor 22 (spec §5): the space kept copies will take — one file times the copies the
// policy keeps — beside what is free.
const keepHelp = computed(() => {
  const free = formatBytes(Math.max(0, (usage.value?.quota ?? 0) - (usage.value?.used ?? 0)), locale.value)
  const file = plan.value?.estimate.fileBytes
  const kept = keptAges(
    state.draft.retention,
    cadenceOf(state.draft),
    state.draft.timeZone,
    Date.now(),
  )?.length
  return file && kept
    ? t(
        'schedules.editor.where.keepHelpUse',
        { size: formatBytes(file * kept, locale.value), count: kept, free },
        kept,
      )
    : t('schedules.editor.where.keepHelp', { free })
})

type Step = 'what' | 'when' | 'protection' | 'where' | 'retention' | 'summary'
const STEPS: Step[] = ['what', 'when', 'protection', 'where', 'retention', 'summary']
const step = ref<Step>('what')
// Editing: every step was filled already, so every step may be visited.
const visited = ref(new Set<Step>(props.scheduleId ? STEPS : ['what']))
/** W4.4: the drill setting, whose number must be within bounds before the schedule is saved. */
const drillSetting = ref<{ valid: boolean } | null>(null)
const valid = computed<Record<Step, boolean>>(() => ({
  what: scopeReady(state.draft) && state.draft.name.trim().length > 0,
  when: !when.value.problem && isTimeZone(state.draft.timeZone),
  protection: state.draft.format === 'mmbak' ? activeKey.value !== null : blocked.value === null,
  where: state.draft.destinations.length > 0,
  retention: drillSetting.value?.valid ?? true,
  summary: true,
}))
const canSave = computed(() => STEPS.every((s) => valid.value[s]))
const items = computed<StepItem[]>(() =>
  STEPS.map((s) => ({
    id: s,
    label: t(`schedules.editor.steps.${s}`),
    state: s === step.value ? 'current' : visited.value.has(s) ? (valid.value[s] ? 'done' : 'error') : 'todo',
  })),
)
function go(to: Step | number): void {
  const target = typeof to === 'number' ? STEPS[STEPS.indexOf(step.value) + to] : to
  if (!target) return
  step.value = target
  visited.value = new Set([...visited.value, target])
}
const goTo = (id: string) => go(id as Step)

function fix(kind: PreflightFix, names?: string[]): void {
  if (kind === 'encrypt') state.draft.format = 'mmbak'
  else if (kind === 'anonymous') state.draft.anonymous = true
  else if (kind === 'exclude' && names?.length && plan.value)
    state.draft.collections = plan.value.namespaces
      .filter((n) => !n.skipped && !names.includes(`${n.db}.${n.coll}`))
      .map((n) => n.coll)
}

const busy = ref(false)
const errors = ref<string[]>([])
async function save(confirmRemovals?: number): Promise<void> {
  busy.value = true
  errors.value = []
  const body = bodyOf(state.draft)
  try {
    const { connectionId: _connection, ...patch } = body
    const saved = existing.value
      ? await schedulesApi.update(existing.value.id, {
          ...patch,
          ...(confirmRemovals !== undefined ? { confirmRemovals } : {}),
        })
      : await schedulesApi.create(body)
    toasts.push({
      kind: 'success',
      message:
        !existing.value && saved.nextRunAt !== null
          ? t('schedules.editor.created', {
              name: saved.name,
              time: zonedTime(saved.nextRunAt, saved.timeZone, locale.value),
            })
          : t('schedules.editor.saved', { name: saved.name }),
    })
    await queryClient.invalidateQueries({ queryKey: scheduleKeys.all })
    emit('close')
  } catch (e) {
    const d = (e instanceof ApiError ? e.details : undefined) as
      { reason?: unknown; count?: unknown } | undefined
    if (d?.reason === 'retention_confirm' && typeof d.count === 'number' && confirmRemovals === undefined) {
      const count = d.count
      const ok = await dialogs.confirm({
        title: t('schedules.editor.retention.confirmTitle', { count }),
        message: t('schedules.editor.retention.confirmHelp', { count }),
        confirmLabel: t('schedules.editor.retention.confirm'),
        danger: true,
      })
      if (ok) return save(count)
    } else errors.value = [scheduleError(e)]
  } finally {
    busy.value = false
  }
}

const words = computed(() => describeCadence(cadenceOf(state.draft), uiLanguageOf(locale.value)) ?? '—')
const firstRun = computed(() =>
  when.value.runs[0] !== undefined ? zonedTime(when.value.runs[0], state.draft.timeZone, locale.value) : '—',
)
const whereWords = computed(
  () =>
    [
      ...chosen.value.map((d) => d.name),
      ...(state.draft.keepOnServer ? [t('schedules.editor.summary.server')] : []),
    ].join(', ') || '—',
)
const keptWords = computed(() => {
  const r = state.draft.retention
  return [
    t('schedules.editor.retention.tierLast', { count: r.last }, r.last),
    r.daily ? t('schedules.editor.retention.tierDaily', { count: r.daily }, r.daily) : null,
    r.weekly ? t('schedules.editor.retention.tierWeekly', { count: r.weekly }, r.weekly) : null,
    r.monthly ? t('schedules.editor.retention.tierMonthly', { count: r.monthly }, r.monthly) : null,
  ]
    .filter(Boolean)
    .join(' · ')
})
</script>

<template>
  <DsSheet
    ref="sheet"
    open
    :title="existing ? t('schedules.editor.editTitle', { name: existing.name }) : t('schedules.editor.title')"
    :subtitle="connectionName"
    :dirty="dirty"
    @close="emit('close')"
  >
    <template #stepper>
      <DsStepper :steps="items" :label="t('schedules.editor.stepsLabel')" @select="goTo" />
    </template>

    <p
      v-if="gone"
      role="status"
      class="rounded-xl border border-dashed border-line-strong p-6 text-ui text-fg-muted"
    >
      {{ t('schedules.editor.gone') }}
    </p>
    <div v-else-if="!ready" aria-busy="true">
      <span class="sr-only" role="status">{{ t('app.loading') }}</span>
      <DsSkeleton class="h-40 rounded-xl" />
    </div>
    <template v-else>
      <WhatStep v-if="step === 'what'" v-model:draft="state.draft" :locked="existing !== null" />
      <WhenStep v-else-if="step === 'when'" v-model:draft="state.draft" />
      <ProtectionStep
        v-else-if="step === 'protection'"
        v-model:draft="state.draft"
        :active-key="activeKey"
        :blocked="blocked"
        :encrypted-only-names="encryptedOnlyNames"
        @key-created="queryClient.invalidateQueries({ queryKey: scheduleKeys.keys })"
      />
      <div v-else-if="step === 'where'" class="flex flex-col gap-4">
        <p class="text-ui text-fg-muted">{{ t('schedules.editor.where.lead') }}</p>
        <p
          v-if="!destinations?.length"
          class="rounded-xl border border-dashed border-line-strong p-4 text-ui text-fg-subtle"
        >
          {{ t('schedules.editor.where.none') }}
        </p>
        <WhereSection
          v-else
          v-model="state.draft.destinations"
          :destinations="destinations"
          :delete-local="!state.draft.keepOnServer"
          :format="state.draft.format"
          :plain-personal="personal === true && !state.draft.anonymous"
          keep-mode
          :keep-help="keepHelp"
          @update:delete-local="(v: boolean) => (state.draft.keepOnServer = !v)"
          @fix="state.draft.format = 'mmbak'"
        />
      </div>
      <div v-else-if="step === 'retention'" class="flex flex-col gap-6">
        <RetentionStep v-model:draft="state.draft" :schedule-id="existing?.id" :cold-names="coldNames" />
        <DrillSetting ref="drillSetting" v-model:draft="state.draft" />
      </div>
      <div v-else class="flex flex-col gap-6">
        <dl data-test="summary" class="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-ui">
          <dt class="text-fg-subtle">{{ t('schedules.editor.summary.what') }}</dt>
          <dd class="font-medium text-fg">
            {{ connectionName }} ·
            {{ scopeReady(state.draft) ? scopeWords(bodyOf(state.draft).dump.scope) : NONE }}
          </dd>
          <dt class="text-fg-subtle">{{ t('schedules.editor.summary.when') }}</dt>
          <dd class="font-medium text-fg">{{ words }} ({{ state.draft.timeZone }})</dd>
          <dt class="text-fg-subtle">{{ t('schedules.editor.summary.first') }}</dt>
          <dd class="text-fg tabular-nums">{{ firstRun }}</dd>
          <dt class="text-fg-subtle">{{ t('schedules.editor.summary.protection') }}</dt>
          <dd class="flex items-center gap-1.5 text-fg">
            <template v-if="state.draft.format === 'mmbak'"
              ><Lock class="size-4 text-success" aria-hidden="true" />{{
                activeKey ? `${activeKey.name} · ${activeKey.fingerprint}` : NONE
              }}</template
            >
            <template v-else
              ><LockOpen class="size-4" aria-hidden="true" />{{
                t('schedules.editor.summary.plain', { format: state.draft.format })
              }}</template
            >
          </dd>
          <dt class="text-fg-subtle">{{ t('schedules.editor.summary.where') }}</dt>
          <dd class="text-fg">{{ whereWords }}</dd>
          <dt class="text-fg-subtle">{{ t('schedules.editor.summary.kept') }}</dt>
          <dd class="text-fg">{{ keptWords }}</dd>
          <dt class="text-fg-subtle">{{ t('schedules.drill.title') }}</dt>
          <dd class="text-fg">
            {{
              state.draft.drillOn
                ? t('schedules.drill.summary', { n: state.draft.drillEvery }, state.draft.drillEvery)
                : t('schedules.drill.off')
            }}
          </dd>
        </dl>
        <section class="flex flex-col gap-2">
          <h3 class="text-ui font-medium text-fg">
            {{ t('schedules.editor.summary.checks') }}
          </h3>
          <PreflightList :checks="plan?.checks ?? []" :loading="loading" @fix="fix" />
          <ul v-if="plan?.refusals.length" class="flex flex-col gap-1 text-ui text-danger">
            <li v-for="r in plan.refusals" :key="r">{{ t(`backup.refusal.${r}`) }}</li>
          </ul>
        </section>
      </div>
      <DsFormErrors v-if="errors.length" class="mt-4" :messages="errors" />
    </template>

    <template #summary>
      <div class="flex flex-col gap-4 text-ui">
        <p class="flex items-start gap-2 font-medium text-fg">
          <CalendarCheck class="mt-0.5 size-4 shrink-0 text-accent-fg" aria-hidden="true" />{{ words }}
        </p>
        <p class="text-fg-muted">
          {{ t('schedules.editor.summary.first') }}: <span class="tabular-nums">{{ firstRun }}</span>
        </p>
        <p class="text-fg-muted">{{ t('schedules.editor.summary.where') }}: {{ whereWords }}</p>
        <p class="text-fg-muted">{{ t('schedules.editor.summary.kept') }}: {{ keptWords }}</p>
      </div>
    </template>

    <template #footer>
      <DsButton v-if="step !== 'what'" variant="ghost" class="mr-auto" @click="go(-1)">{{
        t('common.back')
      }}</DsButton>
      <DsButton variant="ghost" @click="sheet?.requestClose()">{{ t('common.cancel') }}</DsButton>
      <DsButton v-if="step !== 'summary'" variant="secondary" :disabled="!valid[step]" @click="go(1)">{{
        t('schedules.editor.next')
      }}</DsButton>
      <DsButton variant="primary" :disabled="!canSave" :loading="busy" @click="save()">{{
        existing ? t('schedules.editor.save') : t('schedules.editor.create')
      }}</DsButton>
    </template>
  </DsSheet>
</template>
