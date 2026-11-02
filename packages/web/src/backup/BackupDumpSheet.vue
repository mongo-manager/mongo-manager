<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import {
  Archive,
  Clock,
  Database,
  HardDrive,
  Layers,
  Lock,
  RotateCw,
  Server,
  Sparkles,
} from 'lucide-vue-next'
import {
  MIN_BACKUP_PASSWORD,
  MMBAK_CHUNK_MB,
  type BackupEngine,
  type BackupFormat,
  type PreflightFix,
} from '@mongo-manager/shared/browser'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import DsSheet from '@/ds/DsSheet.vue'
import DsStepper, { type StepItem } from '@/ds/DsStepper.vue'
import DsButton from '@/ds/DsButton.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import DsCallout from '@/ds/DsCallout.vue'
import { connectionsApi, queryKeys } from '@/api/connections'
import { backupApi, backupKeys } from '@/api/backup'
import { destinationKeys, destinationsApi } from '@/api/destinations'
import { useSessionStore } from '@/stores/session'
import WhereSection from './WhereSection.vue'
import { describeError } from '@/api/errors'
import { useJobsStore } from '@/jobs/store'
import { useToastStore } from '@/stores/toasts'
import { useTabsStore } from '@/stores/tabs'
import { openBackupsOf } from './openBackups'
import { formatBytes, formatCount, formatDuration } from '@/format'
import PreflightList from './PreflightList.vue'
import PasswordField from './PasswordField.vue'
import DsChoiceCard from '@/ds/DsChoiceCard.vue'
import { useDumpPlan } from './useDumpPlan'
import { cannotReach } from '@/connections/reachability'
import { useBackupError } from './checkText'
import { ApiError } from '@/api/client'
import DsSelect from '@/ds/DsSelect.vue'

/**
 * Phase 3d-3a spec §3.1, U1–U3, U7, U11–U14: one screen with the recommended backup for where it
 * was opened; "Customize…" opens the steps in place. The plan and its checks follow every change.
 */
const sheet = ref<InstanceType<typeof DsSheet> | null>(null)
const props = defineProps<{ connectionId: string; db?: string; coll?: string }>()
const emit = defineEmits<{ close: []; manage: [] }>()
const { t, locale } = useI18n()
const jobs = useJobsStore()
const toasts = useToastStore()
const tabs = useTabsStore()
const queryClient = useQueryClient()

type Step = 'scope' | 'engine' | 'content' | 'format' | 'where' | 'summary'
const STEPS: Step[] = ['scope', 'engine', 'content', 'format', 'where', 'summary']
const FORMATS = ['mmbak', 'gzip', 'archive'] as const
const view = ref<'quick' | 'steps'>('quick')
const step = ref<Step>('scope')
const s = reactive({
  scope: (props.coll ? 'collection' : props.db ? 'database' : 'server') as
    'collection' | 'database' | 'server',
  chosen: [] as string[],
  databases: [] as string[],
  views: true,
  engine: 'builtin' as BackupEngine,
  indexes: true,
  options: true,
  anonymous: false,
  format: 'gzip' as BackupFormat,
  // Null: the server's default part size (MM_BACKUP_CHUNK_MB); a number once the user chooses one.
  chunkMb: null as (typeof MMBAK_CHUNK_MB)[number] | null,
  // Phase 3d-3b V5: where it goes besides this server.
  destinations: [] as string[],
  deleteLocal: false,
})
const password = ref('')
const repeat = ref('')
const filter = ref('')
const busy = ref(false)
const errors = ref<string[]>([])

const { data: usage } = useQuery({ queryKey: backupKeys.usage, queryFn: () => backupApi.usage() })
const session = useSessionStore()
const { data: destinations } = useQuery({
  queryKey: destinationKeys.mine,
  queryFn: () => destinationsApi.mine(),
})
// V5: the last choice is remembered per user (a convenience: storage may be refused).
const whereKey = `mm:backup-where:${session.me?.user.id ?? 'anon'}`
let remembered = false
watch(destinations, (list) => {
  if (remembered || !list) return
  remembered = true
  try {
    const ids = JSON.parse(localStorage.getItem(whereKey) ?? '[]') as unknown
    if (Array.isArray(ids)) s.destinations = list.filter((d) => ids.includes(d.id)).map((d) => d.id)
  } catch {
    // nothing remembered
  }
})
/**
 * Phase 3d-3b final review C2: the choice is remembered when a backup starts with it. A remembered
 * destination the format rules out is dropped from the choice by Where (and comes back with Encrypt);
 * remembering on every change would have forgotten it there.
 */
function rememberWhere(): void {
  try {
    localStorage.setItem(whereKey, JSON.stringify(s.destinations))
  } catch {
    // storage refused: the choice is just not remembered
  }
}
const defaultChunk = computed(() => usage.value?.chunkMb ?? 64)
const { data: connections } = useQuery({
  queryKey: queryKeys.connections,
  queryFn: () => connectionsApi.list(),
})
const connection = computed(() => connections.value?.find((c) => c.id === props.connectionId))
const restricted = computed(() => connection.value?.restricted === true)
const { data: collections } = useQuery({
  queryKey: computed(() => queryKeys.collections(props.connectionId, props.db ?? '')),
  queryFn: () => connectionsApi.collections(props.connectionId, props.db!),
  enabled: computed(() => Boolean(props.db)),
})
const { data: databases } = useQuery({
  queryKey: computed(() => queryKeys.databases(props.connectionId)),
  queryFn: () => connectionsApi.databases(props.connectionId),
  enabled: computed(() => s.scope === 'server'),
})
const dbNames = computed(() =>
  (databases.value?.databases ?? [])
    .map((d) => d.name)
    .filter((n) => !['admin', 'local', 'config'].includes(n)),
)
const ownCollections = computed(() => (collections.value ?? []).filter((c) => !c.name.startsWith('system.')))
const visibleCollections = computed(() =>
  ownCollections.value.filter((c) => c.name.toLowerCase().includes(filter.value.trim().toLowerCase())),
)

const body = computed(() => ({
  scope:
    s.scope === 'collection'
      ? { kind: 'collection', db: props.db, coll: props.coll }
      : s.scope === 'database'
        ? {
            kind: 'database',
            db: props.db,
            views: s.views,
            ...(s.chosen.length ? { collections: s.chosen } : {}),
          }
        : { kind: 'server', ...(s.databases.length ? { databases: s.databases } : {}) },
  engine: s.engine,
  indexes: s.indexes,
  options: s.options,
  // A restricted caller's backup is masked whatever they ask; the box says so.
  anonymous: s.anonymous || restricted.value,
  format: s.format,
  ...(s.chunkMb !== null ? { chunkMb: s.chunkMb } : {}),
  ...(s.destinations.length ? { destinations: s.destinations, deleteLocal: s.deleteLocal } : {}),
}))
const { plan, loading, error: planError, refresh } = useDumpPlan(props.connectionId, body)
// User report 2026-10-23: a server that cannot be reached is said as that, with Retry, not as a form.
const unreachable = computed(() => cannotReach(planError.value))
const backupError = useBackupError()

// U12: "dirty" means changed by the user, measured against the settings the sheet opened with.
const snapshot = () => JSON.stringify([s, password.value, repeat.value])
const baseline = ref<string | null>(null)
const opened = snapshot()
watch(plan, (p) => {
  // U1: the first answer's recommendation becomes the starting settings, once — unless the user
  // already chose something while it was on its way: their choice stands.
  if (!p || baseline.value !== null) return
  if (snapshot() !== opened) {
    baseline.value = opened
    return
  }
  s.format = p.recommended.format
  s.engine = p.recommended.engine
  baseline.value = snapshot()
})
const dirty = computed(() => baseline.value !== null && snapshot() !== baseline.value)

const passwordOk = computed(
  () =>
    s.format !== 'mmbak' || (password.value.length >= MIN_BACKUP_PASSWORD && password.value === repeat.value),
)
const ready = computed(
  () =>
    Boolean(plan.value) &&
    !loading.value &&
    // A plan that failed since keeps the last one shown: it no longer says what Start would do.
    !planError.value &&
    plan.value!.refusals.length === 0 &&
    passwordOk.value &&
    !busy.value,
)
const included = computed(() => plan.value?.namespaces.filter((n) => !n.skipped) ?? [])
/** V5: an unencrypted, unmasked backup of personal data may not leave the server (the server decides too). */
const plainPersonal = computed(() => included.value.some((n) => n.personal.length > 0) && !plan.value?.masked)
const chosenNames = computed(() =>
  (destinations.value ?? []).filter((d) => s.destinations.includes(d.id)).map((d) => d.name),
)
/** The steps shown: Where only when there is somewhere to send to. */
const steps = computed(() => STEPS.filter((x) => x !== 'where' || (destinations.value?.length ?? 0) > 0))
const scopeLine = computed(() =>
  t('backup.scope.summary', {
    collections: t('backup.scope.countCollections', included.value.filter((n) => n.type !== 'view').length),
    views: t('backup.scope.countViews', included.value.filter((n) => n.type === 'view').length),
    // Twelfth review of explain masking (I3): hidden where rules hide personal data from you.
    size:
      plan.value?.estimate.bytes === null ? t('overview.stats.hidden') : b(plan.value?.estimate.bytes ?? 0),
  }),
)
const b = (n: number) => formatBytes(n, locale.value)
const fileSize = computed(() =>
  !plan.value
    ? '—'
    : plan.value.estimate.fileBytes === null
      ? t('overview.stats.hidden')
      : b(plan.value.estimate.fileBytes),
)
// A tiny backup takes under a second: that is still a time, not "unknown".
const duration = computed(() =>
  plan.value && plan.value.estimate.seconds !== null
    ? formatDuration(plan.value.estimate.seconds, locale.value)
    : '—',
)
/** U13: what was chosen, in words, on the summary step. */
const choices = computed(() => [
  { key: 'what', value: `${t(`backup.scope.${s.scope}`)} · ${scopeLine.value}` },
  { key: 'how', value: t(`backup.engine.${s.engine}`) },
  { key: 'protection', value: t(`backup.format.${s.format}`) },
  ...((destinations.value?.length ?? 0) > 0
    ? [
        {
          key: 'where',
          value: chosenNames.value.length ? chosenNames.value.join(', ') : t('backup.where.server'),
        },
      ]
    : []),
  {
    key: 'content',
    value: [
      s.indexes ? t('backup.content.indexes') : null,
      s.options ? t('backup.content.options') : null,
      s.scope === 'database' && s.views ? t('backup.content.views') : null,
      s.anonymous || restricted.value ? t('backup.content.anonymous') : null,
    ]
      .filter(Boolean)
      .join(' · '),
  },
])
const title = computed(() =>
  s.scope === 'collection'
    ? t('backup.title.dumpCollection', { name: `${props.db}.${props.coll}` })
    : s.scope === 'database'
      ? t('backup.title.dumpDatabase', { name: props.db })
      : t('backup.title.dumpServer', { name: connection.value?.name ?? '' }),
)
const toolsReason = computed(() =>
  plan.value?.tools.available
    ? undefined
    : t(`backup.engine.reason.${plan.value?.tools.reason ?? 'missing'}`),
)
const stepItems = computed<StepItem[]>(() =>
  steps.value.map((id, i) => ({
    id,
    label: t(`backup.steps.${id}`),
    state: id === step.value ? 'current' : i < steps.value.indexOf(step.value) ? 'done' : 'todo',
  })),
)
const go = (d: number) => {
  const list = steps.value
  step.value = list[Math.max(0, Math.min(list.length - 1, list.indexOf(step.value) + d))]!
}
function customize(at: Step = 'scope'): void {
  view.value = 'steps'
  step.value = at
}

/** An empty list means "all"; unchecking one from "all" lists the others. */
function toggle(name: string, on: boolean): void {
  const all = ownCollections.value.map((c) => c.name)
  const list = s.chosen.length ? s.chosen : all
  const next = on ? [...new Set([...list, name])] : list.filter((n) => n !== name)
  s.chosen = next.length === all.length ? [] : next
}

function fix(kind: PreflightFix, names?: string[]): void {
  if (kind === 'encrypt') s.format = 'mmbak'
  else if (kind === 'anonymous') s.anonymous = true
  else if (kind === 'deleteOld') emit('manage')
  else if (kind === 'exclude' && names?.length && s.scope === 'database') {
    const all = ownCollections.value.map((c) => c.name)
    s.chosen = (s.chosen.length ? s.chosen : all).filter((n) => !names.includes(`${props.db}.${n}`))
  }
}

async function start(): Promise<void> {
  if (!ready.value) return
  busy.value = true
  errors.value = []
  try {
    const { job } = await backupApi.startDump(props.connectionId, {
      ...body.value,
      planHash: plan.value!.planHash,
      ...(s.format === 'mmbak' ? { password: password.value } : {}),
    })
    jobs.upsert(job)
    rememberWhere()
    toasts.push({
      kind: 'info',
      message: chosenNames.value.length
        ? t(
            'backup.where.started',
            {
              names: new Intl.ListFormat(locale.value, { type: 'conjunction' }).format(chosenNames.value),
            },
            chosenNames.value.length,
          )
        : t('backup.started'),
    })
    emit('close')
    // Where the backup lands, by the scope taken (a collection's sheet may back up its database).
    void openBackupsOf(queryClient, tabs, props.connectionId, {
      ...(s.scope !== 'server' && props.db ? { db: props.db } : {}),
      ...(s.scope === 'collection' && props.coll ? { coll: props.coll } : {}),
    })
  } catch (e) {
    errors.value = backupError(e)
    // The server saw something the plan did not: plan again so what is shown is current.
    if (e instanceof ApiError && e.status === 409) refresh()
  } finally {
    busy.value = false
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.altKey && view.value === 'steps' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
    e.preventDefault()
    go(e.key === 'ArrowRight' ? 1 : -1)
  } else if (
    e.key === 'Enter' &&
    !(e.target instanceof HTMLButtonElement) &&
    !(e.target instanceof HTMLSelectElement)
  ) {
    e.preventDefault()
    if (view.value === 'quick' || step.value === 'summary') void start()
    else go(1)
  }
}
const section = 'flex flex-col gap-3 rounded-2xl border border-line bg-surface p-5'
const chip = 'rounded-full bg-subtle px-1.5 text-[11px] text-fg-muted'
const checkRow =
  'flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors duration-150 hover:bg-subtle'
</script>

<template>
  <DsSheet
    ref="sheet"
    open
    :title="title"
    :subtitle="connection?.name"
    :dirty="dirty"
    @close="emit('close')"
    @keydown="onKeydown"
  >
    <template v-if="view === 'steps' && !unreachable" #stepper>
      <DsStepper :steps="stepItems" :label="t('backup.steps.label')" @select="(id) => (step = id as Step)" />
    </template>

    <div class="flex flex-col gap-5">
      <DsFormErrors
        :messages="[...errors, ...(planError && !unreachable ? [describeError(planError, t)] : [])]"
      />
      <!-- Review (M4): a plan that failed for another reason is planned again from here too. -->
      <div v-if="planError && !unreachable" class="-mt-3">
        <DsButton size="sm" :icon="RotateCw" :loading="loading" @click="refresh()">{{
          t('common.retry')
        }}</DsButton>
      </div>

      <DsCallout v-if="unreachable" tone="danger" :title="t('backup.unreachable.title')">
        {{ t('backup.unreachable.dump') }}
        <template #action>
          <DsButton size="sm" :icon="RotateCw" :loading="loading" @click="refresh()">{{
            t('common.retry')
          }}</DsButton>
        </template>
      </DsCallout>
      <!-- U1: the quick path. -->
      <template v-else-if="view === 'quick'">
        <div
          class="flex items-start gap-3 rounded-card border border-accent/30 bg-gradient-to-br from-accent-soft to-surface p-5"
        >
          <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface shadow-xs">
            <Sparkles class="size-5 text-accent-fg" aria-hidden="true" />
          </span>
          <div class="flex flex-col gap-0.5">
            <h3 class="font-semibold text-fg">{{ t('backup.quick.heading') }}</h3>
            <p class="text-ui text-fg-muted">
              {{ t(`backup.quick.because.${plan?.recommended.reason ?? 'none'}`) }}
            </p>
          </div>
        </div>
        <section :class="section">
          <div class="flex items-center gap-3">
            <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
              <component
                :is="s.scope === 'server' ? Server : s.scope === 'database' ? Database : Layers"
                class="size-5 text-fg-muted"
                aria-hidden="true"
              />
            </span>
            <div class="min-w-0 flex-1">
              <p class="font-medium text-fg">{{ t(`backup.scope.${s.scope}`) }}</p>
              <p class="text-ui text-fg-subtle" aria-live="polite">{{ scopeLine }}</p>
            </div>
            <DsButton size="sm" variant="ghost" @click="customize('scope')">{{
              t('backup.quick.change')
            }}</DsButton>
          </div>
        </section>
        <section :class="section">
          <h3 class="flex items-center gap-2 font-medium text-fg">
            <Lock class="size-4 text-fg-subtle" aria-hidden="true" />{{ t('backup.steps.format') }}
          </h3>
          <div class="grid gap-3 lg:grid-cols-3" role="radiogroup" :aria-label="t('backup.steps.format')">
            <DsChoiceCard
              v-for="f in FORMATS"
              :key="f"
              v-model="s.format"
              name="format"
              :value="f"
              :title="t(`backup.format.${f}`)"
              :help="t(`backup.format.${f}Help`)"
              :code="t(`backup.format.${f}Code`)"
              :badge="plan?.recommended.format === f ? t('backup.format.recommended') : undefined"
            />
          </div>
          <Transition
            enter-active-class="transition duration-200 motion-reduce:transition-none"
            enter-from-class="-translate-y-1 opacity-0"
          >
            <PasswordField v-if="s.format === 'mmbak'" v-model:password="password" v-model:repeat="repeat" />
          </Transition>
        </section>
        <section v-if="destinations?.length" :class="section">
          <h3 class="font-medium text-fg">{{ t('backup.where.title') }}</h3>
          <WhereSection
            v-model="s.destinations"
            v-model:delete-local="s.deleteLocal"
            :destinations="destinations"
            :format="s.format"
            :plain-personal="plainPersonal"
            @fix="fix"
          />
        </section>
      </template>

      <!-- The steps (U3: advanced settings live here). -->
      <template v-else-if="step === 'scope'">
        <div class="grid gap-3 lg:grid-cols-3" role="radiogroup" :aria-label="t('backup.steps.scope')">
          <DsChoiceCard
            v-if="coll"
            v-model="s.scope"
            name="scope"
            value="collection"
            :title="t('backup.scope.collection')"
            :help="`${db}.${coll}`"
          />
          <DsChoiceCard
            v-if="db"
            v-model="s.scope"
            name="scope"
            value="database"
            :title="t('backup.scope.database')"
            :help="db!"
          />
          <DsChoiceCard
            v-model="s.scope"
            name="scope"
            value="server"
            :title="t('backup.scope.server')"
            :help="t('backup.scope.systemNote')"
          />
        </div>
        <div v-if="s.scope === 'database'" :class="section">
          <div class="flex flex-wrap items-center gap-2">
            <input
              v-model="filter"
              type="search"
              :placeholder="t('backup.scope.search')"
              :aria-label="t('backup.scope.search')"
              class="h-9 min-w-56 flex-1 rounded-lg border border-line-strong bg-surface px-3 text-ui focus:border-focus focus:ring-2 focus:ring-focus/30 focus:outline-none"
            />
            <DsButton size="sm" variant="ghost" @click="s.chosen = []">{{ t('backup.scope.all') }}</DsButton>
          </div>
          <ul class="grid max-h-80 gap-1 overflow-auto sm:grid-cols-2">
            <li v-for="c in visibleCollections" :key="c.name">
              <label :class="checkRow">
                <input
                  type="checkbox"
                  class="size-4 accent-accent"
                  :checked="!s.chosen.length || s.chosen.includes(c.name)"
                  @change="toggle(c.name, ($event.target as HTMLInputElement).checked)"
                />
                <span class="truncate font-mono">{{ c.name }}</span>
                <span v-if="c.type === 'view'" :class="chip">{{ t('backup.scope.view') }}</span>
                <span v-else-if="c.type === 'timeseries'" :class="chip">{{
                  t('backup.scope.timeseries')
                }}</span>
              </label>
            </li>
          </ul>
        </div>
        <div v-else-if="s.scope === 'server'" :class="section">
          <h3 class="font-medium">{{ t('backup.scope.databases') }}</h3>
          <ul class="grid gap-1 sm:grid-cols-3">
            <li v-for="d in dbNames" :key="d">
              <label :class="checkRow">
                <input v-model="s.databases" type="checkbox" :value="d" class="size-4 accent-accent" />
                <span class="font-mono">{{ d }}</span>
              </label>
            </li>
          </ul>
          <p class="text-small text-fg-subtle">{{ t('backup.scope.systemNote') }}</p>
        </div>
      </template>
      <div
        v-else-if="step === 'engine'"
        class="grid gap-3 lg:grid-cols-2"
        role="radiogroup"
        :aria-label="t('backup.steps.engine')"
      >
        <DsChoiceCard
          v-model="s.engine"
          name="engine"
          value="builtin"
          :title="t('backup.engine.builtin')"
          :help="t('backup.engine.builtinHelp')"
          :badge="plan?.recommended.engine === 'builtin' ? t('backup.format.recommended') : undefined"
        />
        <DsChoiceCard
          v-model="s.engine"
          name="engine"
          value="tools"
          :title="t('backup.engine.tools')"
          :help="t('backup.engine.toolsHelp')"
          :disabled="!plan?.tools.available"
          :reason="toolsReason"
        />
      </div>
      <div v-else-if="step === 'content'" :class="section">
        <label class="flex items-center gap-3 text-ui"
          ><input v-model="s.indexes" type="checkbox" class="size-4 accent-accent" />{{
            t('backup.content.indexes')
          }}</label
        >
        <label class="flex items-center gap-3 text-ui"
          ><input v-model="s.options" type="checkbox" class="size-4 accent-accent" />{{
            t('backup.content.options')
          }}</label
        >
        <label v-if="s.scope === 'database'" class="flex items-center gap-3 text-ui"
          ><input v-model="s.views" type="checkbox" class="size-4 accent-accent" />{{
            t('backup.content.views')
          }}</label
        >
        <label class="flex items-start gap-3 text-ui">
          <input
            type="checkbox"
            data-test="backup-anonymous"
            class="mt-0.5 size-4 accent-accent"
            :checked="s.anonymous || restricted"
            :disabled="restricted || s.engine === 'tools'"
            @change="s.anonymous = ($event.target as HTMLInputElement).checked"
          />
          <span>
            <span class="font-medium">{{ t('backup.content.anonymous') }}</span>
            <span class="block text-fg-subtle">{{
              restricted ? t('backup.content.anonymousLocked') : t('backup.content.anonymousHelp')
            }}</span>
          </span>
        </label>
        <!-- Backup review M11: what a backup is not. -->
        <p class="text-small text-fg-subtle" data-test="backup-limits">{{ t('backup.content.limits') }}</p>
      </div>
      <template v-else-if="step === 'format'">
        <div class="grid gap-3 lg:grid-cols-3" role="radiogroup" :aria-label="t('backup.steps.format')">
          <DsChoiceCard
            v-for="f in FORMATS"
            :key="f"
            v-model="s.format"
            name="format-steps"
            :value="f"
            :title="t(`backup.format.${f}`)"
            :help="t(`backup.format.${f}Help`)"
            :code="t(`backup.format.${f}Code`)"
            :badge="plan?.recommended.format === f ? t('backup.format.recommended') : undefined"
          />
        </div>
        <template v-if="s.format === 'mmbak'">
          <PasswordField v-model:password="password" v-model:repeat="repeat" />
          <DsSelect
            class="max-w-xs"
            :label="t('backup.format.chunk')"
            :model-value="String(s.chunkMb ?? defaultChunk)"
            :options="
              MMBAK_CHUNK_MB.map((n) => ({
                value: String(n),
                label:
                  n === defaultChunk
                    ? t('backup.format.chunkDefault', { n })
                    : t('backup.format.chunkOption', { n }),
              }))
            "
            @update:model-value="s.chunkMb = Number($event) as (typeof MMBAK_CHUNK_MB)[number]"
          />
        </template>
      </template>
      <section v-else-if="step === 'where'" :class="section">
        <WhereSection
          v-model="s.destinations"
          v-model:delete-local="s.deleteLocal"
          :destinations="destinations ?? []"
          :format="s.format"
          :plain-personal="plainPersonal"
          @fix="fix"
        />
      </section>
      <template v-else>
        <dl :class="section" class="grid gap-x-6 gap-y-2 text-ui sm:grid-cols-[auto_1fr]">
          <template v-for="c in choices" :key="c.key">
            <dt class="text-fg-subtle">{{ t(`backup.summary.${c.key}`) }}</dt>
            <dd class="font-medium text-fg">{{ c.value }}</dd>
          </template>
        </dl>
        <div :class="section">
          <ul class="divide-y divide-line text-ui">
            <li
              v-for="n in plan?.namespaces ?? []"
              :key="`${n.db}.${n.coll}`"
              class="flex flex-wrap items-center gap-2 py-2"
            >
              <span class="font-mono">{{ n.db }}.{{ n.coll }}</span>
              <span v-if="n.type !== 'collection'" :class="chip">{{ t(`backup.scope.${n.type}`) }}</span>
              <span v-if="n.documents !== null" class="ml-auto text-fg-subtle tabular-nums">{{
                t('backup.summary.documents', { count: formatCount(n.documents, locale) })
              }}</span>
              <span v-if="n.skipped" class="basis-full text-small text-warning">{{ n.skipped }}</span>
              <span v-if="n.note" class="basis-full text-small text-fg-subtle">{{ n.note }}</span>
            </li>
          </ul>
        </div>
      </template>
    </div>

    <template v-if="!unreachable" #summary>
      <div class="flex flex-col gap-5">
        <div class="grid grid-cols-2 gap-3">
          <div class="rounded-xl bg-surface p-3 shadow-xs">
            <p class="flex items-center gap-1 text-small text-fg-subtle">
              <HardDrive class="size-3" aria-hidden="true" />{{ t('backup.summary.fileSize') }}
            </p>
            <p class="text-xl font-semibold text-fg tabular-nums" aria-live="polite">
              <DsSkeleton v-if="!plan && loading" class="mt-1 block h-6 w-20 rounded-md" />
              <template v-else>{{ fileSize }}</template>
            </p>
          </div>
          <div class="rounded-xl bg-surface p-3 shadow-xs">
            <p class="flex items-center gap-1 text-small text-fg-subtle">
              <Clock class="size-3" aria-hidden="true" />{{ t('backup.summary.time') }}
            </p>
            <p class="text-xl font-semibold text-fg tabular-nums">
              <DsSkeleton v-if="!plan && loading" class="mt-1 block h-6 w-20 rounded-md" />
              <span
                v-else-if="plan && plan.estimate.seconds === null"
                class="mt-1 block text-small leading-snug font-normal text-fg-subtle"
                >{{
                  plan.estimate.bytes === null ? t('overview.stats.hidden') : t('backup.summary.timeUnknown')
                }}</span
              >
              <template v-else>{{ duration }}</template>
            </p>
          </div>
        </div>
        <PreflightList :checks="plan?.checks ?? []" :loading="loading" @fix="fix" />
        <ul v-if="plan?.refusals.length" class="flex flex-col gap-1 text-ui text-danger">
          <li v-for="r in plan.refusals" :key="r">{{ t(`backup.refusal.${r}`) }}</li>
        </ul>
      </div>
    </template>

    <template #footer>
      <!-- Review (N1): nothing to customize or step through behind the callout. -->
      <template v-if="!unreachable">
        <DsButton v-if="view === 'quick'" variant="ghost" class="mr-auto" @click="customize()">{{
          t('backup.quick.customize')
        }}</DsButton>
        <DsButton v-else-if="step !== 'scope'" variant="ghost" class="mr-auto" @click="go(-1)">{{
          t('dataTransfer.back')
        }}</DsButton>
      </template>
      <DsButton variant="ghost" @click="sheet?.requestClose()">{{ t('dataTransfer.cancel') }}</DsButton>
      <DsButton
        v-if="view === 'steps' && step !== 'summary' && !unreachable"
        variant="secondary"
        @click="go(1)"
        >{{ t('dataTransfer.next') }}</DsButton
      >
      <DsButton variant="primary" :disabled="!ready" :loading="busy" @click="start"
        ><Archive class="size-4" aria-hidden="true" />{{ t('backup.start') }}</DsButton
      >
    </template>
  </DsSheet>
</template>
