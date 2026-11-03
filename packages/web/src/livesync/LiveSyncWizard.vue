<script setup lang="ts">
import { afterRulesAdded } from '@/masking/refresh'
import { computed, reactive, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { AlertTriangle, Info } from 'lucide-vue-next'
import {
  START_MODES,
  parseQueryObject,
  serializeValue,
  type LiveSyncPlan,
} from '@mongo-manager/shared/browser'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import DsSelect from '@/ds/DsSelect.vue'
import DsInput from '@/ds/DsInput.vue'
import DsSuggestInput from '@/ds/DsSuggestInput.vue'
import { useCollectionNames, useDatabaseNames } from '@/connections/namespaceNames'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import DsTextarea from '@/ds/DsTextarea.vue'
import DsStepper, { type StepItem } from '@/ds/DsStepper.vue'
import DsChoiceCard from '@/ds/DsChoiceCard.vue'
import { connectionsApi, queryKeys } from '@/api/connections'
import { liveSyncApi, liveSyncKeys } from '@/api/liveSync'
import { useToastStore } from '@/stores/toasts'
import { useTabsStore } from '@/stores/tabs'
import type { LiveSyncPreset } from '@/stores/workspaceDialogs'
import { openLiveSyncsTab } from '@/workspace/openTabs'
import { formatBytes, formatDuration } from '@/format'
import { useLiveSyncWords } from './words'

/**
 * Phase 3e-2 spec §5: a new live sync — source, target, options, then the server's summary with its
 * warnings, each confirmable; or, with `review`, the summary a stopped sync needs before it carries on.
 */
const props = defineProps<{
  connectionId?: string
  db?: string
  coll?: string
  preset?: LiveSyncPreset
  review?: string
}>()
const emit = defineEmits<{ close: [] }>()
const { t, locale } = useI18n()
const id = useId()
const toasts = useToastStore()
const tabs = useTabsStore()
const queryClient = useQueryClient()
const words = useLiveSyncWords()

type Step = 'source' | 'target' | 'options' | 'summary'
const STEPS = computed<Step[]>(() =>
  props.review
    ? ['summary']
    : props.coll
      ? ['target', 'options', 'summary']
      : ['source', 'target', 'options', 'summary'],
)
const step = ref<Step>(STEPS.value[0]!)
const at = computed(() => STEPS.value.indexOf(step.value))
const next = () => (step.value = STEPS.value[Math.min(at.value + 1, STEPS.value.length - 1)]!)
const back = () => (step.value = STEPS.value[Math.max(at.value - 1, 0)]!)
// The stepper goes back only (todo steps are disabled): Next still checks each step on the way.
const stepItems = computed<StepItem[]>(() =>
  STEPS.value.map((s, i) => ({
    id: s,
    label: t(`liveSync.wizard.steps.${s}`),
    state: s === step.value ? 'current' : i < at.value ? 'done' : 'todo',
  })),
)
const ERROR_POLICIES = ['pause', 'skip'] as const

const { data: connections } = useQuery({
  queryKey: queryKeys.connections,
  queryFn: () => connectionsApi.list(),
})
const NEEDS = ['documents:write', 'databases:write', 'indexes:write', 'jobs:run'] as const
const sources = computed(() => (connections.value ?? []).filter((c) => c.export))
// The server checks again; this only keeps unusable targets out of the list (spec §3.1).
const targets = computed(() =>
  (connections.value ?? []).filter((c) => NEEDS.every((p) => c.permissions.includes(p as never))),
)
const sourceOptions = computed(() => sources.value.map((c) => ({ value: c.id, label: c.name })))
// The "pick one" prompt stands only until a target is picked, as a disabled placeholder would.
const targetOptions = computed(() => [
  ...(target.connectionId === '' ? [{ value: '', label: t('liveSync.wizard.pick') }] : []),
  ...targets.value.map((c) => ({
    value: c.id,
    label: t('liveSync.wizard.role', { name: c.name, role: c.access }),
  })),
])

const src = reactive({ connectionId: props.connectionId ?? '', db: props.db ?? '', coll: props.coll ?? '' })
const target = reactive({
  connectionId: props.preset?.target.connectionId ?? '',
  db: props.preset?.target.db ?? props.db ?? '',
  coll: props.preset?.target.coll ?? props.coll ?? '',
})
const chosen = ref<string[]>(props.preset?.collections ?? [])
const o = reactive({
  startMode: props.preset?.startMode ?? ('copy' as (typeof START_MODES)[number]),
  errorPolicy: props.preset?.errorPolicy ?? ('pause' as 'pause' | 'skip'),
  followNew: props.preset?.followNew ?? true,
  anonymous: props.preset?.anonymous ?? false,
  confirmTarget: '',
  confirmOverwrite: false,
  confirmOplog: false,
  confirmPersonal: false,
  confirmTtl: false,
  addRulesToTarget: false,
  /** W4.6: start at a time of the owner's choosing (a minute to 30 days ahead). */
  later: false,
  /** W4.6: two-way (a collection sync from now), its images and its confirmation. */
  twoWay: false,
  enablePreImages: false,
  confirmTwoWay: false,
  startAtText: '',
  filtered: props.preset?.filter !== undefined && props.preset.filter !== null,
  filterText: props.preset?.filter ? JSON.stringify(props.preset.filter) : '{}',
})
const isCollection = computed(() => src.coll !== '')
/** W4.6: a two-way sync — a collection sync, never a review of an existing one. */
const twoWayOn = computed(() => isCollection.value && !props.review && o.twoWay)
/** W4.6: the chosen start, in ms, or null when it is not a time a minute to 30 days ahead. */
const startAtMs = computed(() => {
  if (!o.later || !o.startAtText) return null
  const ms = new Date(o.startAtText).getTime()
  const now = Date.now()
  return Number.isFinite(ms) && ms >= now + 60_000 && ms <= now + 30 * 86_400_000 ? ms : null
})
/**
 * W4.6: the filter, read by the safe parser (shell syntax: ObjectId, ISODate…) and sent as canonical
 * EJSON; the server checks it as any query (and refuses one a masked sync could not keep masked).
 */
const parsedFilter = computed<{ ok: true; value: Record<string, unknown> } | { ok: false; reason: string }>(
  () => {
    try {
      return { ok: true, value: serializeValue(parseQueryObject(o.filterText)) as Record<string, unknown> }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  },
)
const sourceDatabases = useDatabaseNames(() => src.connectionId)
const { data: sourceCollections } = useQuery({
  queryKey: computed(() => queryKeys.collections(src.connectionId, src.db)),
  queryFn: () => connectionsApi.collections(src.connectionId, src.db),
  // Review of the branch: a database being typed is not read at each key — only one the connection
  // has (or the one the wizard was opened on).
  enabled: computed(
    () =>
      !isCollection.value &&
      src.connectionId !== '' &&
      src.db !== '' &&
      (src.db === props.db || sourceDatabases.value.includes(src.db)),
  ),
})
// Views follow only with an initial copy; system collections never (spec §1.1).
const collectionNames = computed(() =>
  (sourceCollections.value ?? [])
    .filter((c) => c.type !== 'view' && !c.name.startsWith('system.'))
    .map((c) => c.name),
)
const sourceRestricted = computed(
  () => (connections.value ?? []).find((c) => c.id === src.connectionId)?.restricted === true,
)
const followable = computed(() => !isCollection.value && chosen.value.length === 0)
// User report 2026-10-30: the chosen connection's databases and collections, offered by name; the
// target may still be a new one (typed).
const sourceCollectionNames = useCollectionNames(
  () => src.connectionId,
  () => src.db,
  { views: false },
)
const targetDatabases = useDatabaseNames(() => target.connectionId)
const targetCollections = useCollectionNames(
  () => target.connectionId,
  () => target.db,
  { views: false },
)

function body(): Record<string, unknown> {
  return {
    source: {
      connectionId: src.connectionId,
      db: src.db,
      ...(isCollection.value ? { coll: src.coll } : chosen.value.length ? { collections: chosen.value } : {}),
    },
    target: {
      connectionId: target.connectionId,
      db: target.db,
      ...(isCollection.value ? { coll: target.coll || src.coll } : {}),
    },
    // W4.6: a two-way sync starts from now (both sides already hold the same documents).
    startMode: twoWayOn.value ? 'from_now' : o.startMode,
    errorPolicy: o.errorPolicy,
    followNew: o.followNew && followable.value,
    anonymous: o.anonymous || sourceRestricted.value,
    confirmOverwrite: o.confirmOverwrite,
    confirmOplog: o.confirmOplog,
    confirmPersonal: o.confirmPersonal,
    confirmTtl: o.confirmTtl,
    addRulesToTarget: o.addRulesToTarget,
    ...(o.startMode === 'replace' && !twoWayOn.value ? { confirmTarget: o.confirmTarget } : {}),
    ...(props.preset?.replaces ? { replaces: props.preset.replaces } : {}),
    ...(isCollection.value && o.filtered && !twoWayOn.value && parsedFilter.value.ok
      ? { filter: parsedFilter.value.value }
      : {}),
    ...(!props.review && !twoWayOn.value && startAtMs.value !== null ? { startAt: startAtMs.value } : {}),
    ...(twoWayOn.value
      ? { twoWay: true, enablePreImages: o.enablePreImages, confirmTwoWay: o.confirmTwoWay }
      : {}),
  }
}
const confirmations = () => ({ confirmPersonal: o.confirmPersonal, addRulesToTarget: o.addRulesToTarget })

const plan = ref<LiveSyncPlan | null>(null)
const errors = ref<string[]>([])
const busy = ref(false)
let asked = 0
async function refreshPlan(): Promise<void> {
  const mine = ++asked
  errors.value = []
  try {
    const answer = props.review
      ? await liveSyncApi.review(src.connectionId, props.review, confirmations())
      : await liveSyncApi.plan(src.connectionId, body())
    if (mine === asked) plan.value = answer
  } catch (e) {
    if (mine !== asked) return
    plan.value = null
    errors.value = [words.error(e)]
  }
}
watch(
  step,
  (s) => {
    if (s === 'summary') void refreshPlan()
  },
  { immediate: true },
)
watch(
  () => [
    o.confirmOverwrite,
    o.confirmOplog,
    o.confirmPersonal,
    o.confirmTtl,
    o.addRulesToTarget,
    o.enablePreImages,
    o.confirmTwoWay,
  ],
  () => {
    if (step.value === 'summary') void refreshPlan()
  },
)

/** Refusals a box on this page answers; the others block the start until the settings change. */
const CONFIRMS = new Set([
  'confirm_overwrite',
  'confirm_oplog',
  'confirm_personal',
  'confirm_ttl',
  'confirm_target',
  // W4.6: answered by the two-way card's boxes.
  'confirm_two_way',
  'pre_images_off',
])
const blocking = computed(() => plan.value?.refusals.filter((r) => !CONFIRMS.has(r)) ?? [])
const has = (w: string) => (plan.value?.warnings as string[] | undefined)?.includes(w) ?? false
const ready = computed(() => plan.value !== null && plan.value.refusals.length === 0 && !busy.value)
const compact = (v: number) => new Intl.NumberFormat(locale.value, { notation: 'compact' }).format(v)
const estimate = computed(() => {
  const e = plan.value?.estimate
  if (!e || o.startMode === 'from_now') return null
  return t('liveSync.wizard.estimate', {
    documents: compact(e.documents),
    // Twelfth review of explain masking (I3): hidden where rules hide personal data from you.
    size: e.bytes === null ? t('overview.stats.hidden') : formatBytes(e.bytes, locale.value),
    time:
      e.seconds !== null
        ? formatDuration(e.seconds, locale.value)
        : e.bytes === null
          ? t('overview.stats.hidden')
          : '—',
  })
})
/** Two days or more read better in days ("about 400 days", not "9,600 hr"). */
const span = (seconds: number) =>
  seconds >= 2 * 86_400
    ? t('liveSync.wizard.days', {
        n: new Intl.NumberFormat(locale.value).format(Math.round(seconds / 86_400)),
      })
    : formatDuration(seconds, locale.value)
const windowText = computed(() =>
  plan.value?.oplogWindowSeconds
    ? t('liveSync.wizard.oplogWindow', { time: span(plan.value.oplogWindowSeconds) })
    : null,
)
const nameOf = (id: string) => (connections.value ?? []).find((c) => c.id === id)?.name ?? ''
const sides = computed(() => [
  {
    key: 'from',
    name: nameOf(src.connectionId),
    ns: isCollection.value ? `${src.db}.${src.coll}` : src.db,
  },
  {
    key: 'to',
    name: nameOf(target.connectionId),
    ns: isCollection.value ? `${target.db}.${target.coll || src.coll}` : target.db,
  },
])

async function start(): Promise<void> {
  if (!plan.value) return
  busy.value = true
  errors.value = []
  try {
    if (props.review)
      await liveSyncApi.confirm(src.connectionId, props.review, {
        ...confirmations(),
        planHash: plan.value.planHash,
      })
    else await liveSyncApi.create(src.connectionId, { ...body(), planHash: plan.value.planHash })
    toasts.push({
      kind: 'success',
      message: t(
        props.review
          ? 'liveSync.wizard.carriedOn'
          : o.later
            ? 'liveSync.wizard.scheduled'
            : 'liveSync.wizard.started',
      ),
    })
    if (o.addRulesToTarget) await afterRulesAdded(queryClient)
    else await queryClient.invalidateQueries({ queryKey: liveSyncKeys.all })
    openLiveSyncsTab(tabs)
    emit('close')
  } catch (e) {
    errors.value = [words.error(e)]
    await refreshPlan()
  } finally {
    busy.value = false
  }
}

const canNext = computed(() =>
  step.value === 'source'
    ? src.connectionId !== '' && src.db !== ''
    : step.value === 'target'
      ? target.connectionId !== '' && target.db !== ''
      : step.value === 'options'
        ? (twoWayOn.value || o.startMode !== 'replace' || o.confirmTarget !== '') &&
          (!isCollection.value || !o.filtered || parsedFilter.value.ok) &&
          (!o.later || startAtMs.value !== null)
        : false,
)
const title = computed(() =>
  props.review
    ? t('liveSync.wizard.reviewTitle')
    : t(isCollection.value ? 'liveSync.wizard.title' : 'liveSync.wizard.titleDatabase', {
        name: src.coll || src.db || '…',
      }),
)
const card = 'flex flex-col gap-2 rounded-xl border p-3 text-sm'
const warn = 'border-warning/30 bg-warning-soft/60'
</script>

<template>
  <DsDialog open :title="title" size="xl" @close="emit('close')">
    <div class="flex flex-col gap-4">
      <!-- A dialog, not a sheet: the steps stay in a row at every width. -->
      <DsStepper
        v-if="STEPS.length > 1"
        class="xl:flex-row!"
        :steps="stepItems"
        :label="t('liveSync.wizard.steps.label')"
        @select="(s) => (step = s as Step)"
      />
      <DsFormErrors :messages="errors" />

      <template v-if="step === 'source'">
        <div class="flex flex-wrap items-start gap-3">
          <DsSelect
            v-if="!connectionId"
            v-model="src.connectionId"
            :label="t('liveSync.wizard.sourceConnection')"
            :options="sourceOptions"
          />
          <DsSuggestInput
            v-if="!db"
            v-model.trim="src.db"
            :label="t('liveSync.wizard.database')"
            :suggestions="sourceDatabases"
          />
          <DsSuggestInput
            v-if="!db"
            v-model.trim="src.coll"
            :label="t('liveSync.wizard.collectionOptional')"
            :suggestions="sourceCollectionNames"
          />
        </div>
        <fieldset v-if="!isCollection && collectionNames.length" class="flex flex-col gap-2 text-ui">
          <legend class="font-medium">{{ t('liveSync.wizard.collections') }}</legend>
          <p class="text-small text-fg-subtle">{{ t('liveSync.wizard.allCollections') }}</p>
          <div class="grid max-h-56 grid-cols-2 gap-1 overflow-auto">
            <label
              v-for="name in collectionNames"
              :key="name"
              class="flex items-center gap-2 font-mono text-small"
            >
              <input v-model="chosen" type="checkbox" :value="name" class="size-4 accent-accent" />{{ name }}
            </label>
          </div>
          <DsCheckbox
            :model-value="o.followNew && followable"
            :disabled="!followable"
            :label="t('liveSync.wizard.followNew')"
            @update:model-value="o.followNew = $event"
          />
          <p v-if="!followable" class="text-small text-fg-subtle">
            {{ t('liveSync.wizard.followNewChosen') }}
          </p>
        </fieldset>
      </template>

      <template v-else-if="step === 'target'">
        <div class="flex flex-wrap items-start gap-3">
          <DsSelect
            v-model="target.connectionId"
            :label="t('liveSync.wizard.targetConnection')"
            :options="targetOptions"
          />
          <DsSuggestInput
            v-model.trim="target.db"
            :label="t('liveSync.wizard.database')"
            :suggestions="targetDatabases"
          />
          <DsSuggestInput
            v-if="isCollection"
            v-model.trim="target.coll"
            :label="t('liveSync.wizard.collection')"
            :suggestions="targetCollections"
          />
        </div>
        <p class="text-small text-fg-subtle">{{ t('liveSync.wizard.targetHelp') }}</p>
      </template>

      <template v-else-if="step === 'options'">
        <!-- W4.6: two-way — the target's changes come back; from now; no filter, no later start. -->
        <template v-if="isCollection && !review">
          <DsCheckbox v-model="o.twoWay" :label="t('liveSync.wizard.twoWay')" />
          <p v-if="o.twoWay" class="text-small text-fg-muted">{{ t('liveSync.wizard.twoWayStart') }}</p>
        </template>
        <fieldset v-if="!twoWayOn" class="grid gap-3 sm:grid-cols-2">
          <legend class="mb-2 text-ui font-medium">{{ t('liveSync.wizard.startMode') }}</legend>
          <DsChoiceCard
            v-for="m in START_MODES"
            :key="m"
            v-model="o.startMode"
            :name="`${id}-mode`"
            :value="m"
            :title="t(`liveSync.startMode.${m}`)"
            :help="t(`liveSync.wizard.startModeHelp.${m}`)"
          />
        </fieldset>
        <DsInput
          v-if="o.startMode === 'replace' && !twoWayOn"
          v-model.trim="o.confirmTarget"
          :label="t(isCollection ? 'liveSync.wizard.typeTarget' : 'liveSync.wizard.typeTargetDatabase')"
          autocomplete="off"
        />
        <fieldset v-if="!twoWayOn" class="grid gap-3 sm:grid-cols-2">
          <legend class="mb-2 text-ui font-medium">{{ t('liveSync.wizard.errorPolicy') }}</legend>
          <DsChoiceCard
            v-for="p in ERROR_POLICIES"
            :key="p"
            v-model="o.errorPolicy"
            :name="`${id}-err`"
            :value="p"
            :title="t(`liveSync.errorPolicy.${p}`)"
            :help="t(`liveSync.wizard.errorPolicyHelp.${p}`)"
          />
        </fieldset>
        <!-- W4.6: start now, or at a time (paused until then; planned again when it comes). -->
        <template v-if="!review && !twoWayOn">
          <DsCheckbox v-model="o.later" :label="t('liveSync.wizard.later')" />
          <template v-if="o.later">
            <DsInput
              v-model="o.startAtText"
              type="datetime-local"
              :label="t('liveSync.wizard.startAt')"
              :hint="t('liveSync.wizard.startAtHint')"
            />
            <p v-if="o.startAtText && startAtMs === null" class="text-small text-danger" role="alert">
              {{ t('liveSync.wizard.startAtInvalid') }}
            </p>
          </template>
        </template>
        <!-- W4.6: a collection sync of the documents a filter matches. -->
        <template v-if="isCollection && !twoWayOn">
          <DsCheckbox v-model="o.filtered" :label="t('liveSync.wizard.filtered')" />
          <template v-if="o.filtered">
            <DsTextarea
              v-model="o.filterText"
              :label="t('liveSync.wizard.filter')"
              :hint="t('liveSync.wizard.filterHint')"
              :rows="3"
              mono
            />
            <p v-if="!parsedFilter.ok" class="text-small text-danger" role="alert">
              {{ t('dataTransfer.copy.filterInvalid', { reason: parsedFilter.reason }) }}
            </p>
          </template>
        </template>
        <DsCheckbox
          :model-value="o.anonymous || sourceRestricted"
          :disabled="sourceRestricted"
          :label="t('liveSync.wizard.anonymous')"
          @update:model-value="o.anonymous = $event"
        />
        <p v-if="sourceRestricted" class="text-small text-fg-subtle">
          {{ t('liveSync.wizard.anonymousLocked') }}
        </p>
      </template>

      <template v-else>
        <p v-if="!plan && !errors.length" class="text-ui text-fg-subtle" role="status">
          {{ t('liveSync.wizard.planning') }}
        </p>
        <template v-if="plan">
          <p v-if="review" class="text-ui text-fg-muted">
            {{ t('liveSync.wizard.reviewHelp') }}
          </p>
          <dl
            class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-xl bg-subtle px-4 py-3 text-ui"
          >
            <template v-for="side in sides" :key="side.key">
              <dt class="text-small font-medium uppercase tracking-wide text-fg-subtle">
                {{ t(`liveSync.card.${side.key}`) }}
              </dt>
              <dd
                :data-from="side.key === 'from' ? '' : undefined"
                :data-to="side.key === 'to' ? '' : undefined"
                class="flex min-w-0 items-center gap-2"
              >
                <span class="sr-only">{{ t(`liveSync.card.${side.key}`) }}</span>
                <span class="shrink-0 text-fg">{{ side.name }}</span>
                <span class="truncate font-mono text-small text-fg-muted">{{ side.ns }}</span>
              </dd>
            </template>
          </dl>
          <ul v-if="!isCollection" class="flex flex-wrap gap-1.5 text-small">
            <li
              v-for="c in plan.copy.collections"
              :key="c.source"
              class="rounded-full bg-muted px-2 py-0.5 font-mono text-fg"
            >
              {{ c.source }}
            </li>
          </ul>
          <template v-for="c in plan.copy.collections" :key="`left-${c.source}`">
            <!-- Final reviews of the masking side channels (M-1, M-6): why a pair is left out, where
                 that is what refuses the sync (a series, a bucket, an encrypted one say their own). -->
            <p
              v-if="c.skipped && plan.leftOut?.includes(c.source)"
              data-skipped
              class="text-small text-warning"
            >
              {{ t('dataTransfer.copy.skipped', { name: c.source, reason: c.skipped }) }}
            </p>
            <p v-if="c.validatorLeftOut" class="text-small text-warning">
              {{ t('dataTransfer.copy.validatorLeftOut', { name: c.source }) }}
            </p>
            <p v-if="c.indexesLeftOut?.length" class="text-small text-warning">
              {{
                t('dataTransfer.copy.indexesLeftOut', { name: c.source, list: c.indexesLeftOut.join(', ') })
              }}
            </p>
          </template>
          <p v-if="plan.copy.viewsLeftOut?.length" class="text-small text-warning">
            {{ t('dataTransfer.copy.viewsLeftOut', { names: plan.copy.viewsLeftOut.join(', ') }) }}
          </p>
          <p v-if="estimate" class="text-ui text-fg">{{ estimate }}</p>
          <p v-if="windowText" class="text-small text-fg-subtle">{{ windowText }}</p>
          <p v-if="plan.masked" class="flex items-center gap-2 text-small text-fg-muted">
            <Info class="size-4" aria-hidden="true" />{{ t('liveSync.wizard.masked') }}
          </p>

          <!-- W4.6: a two-way sync's strong warning, and the pre- and post-images it needs. -->
          <div v-if="has('two_way')" :class="[card, warn]" data-test="two-way-warning">
            <p class="flex items-center gap-2 font-medium">
              <AlertTriangle class="size-4 text-warning" aria-hidden="true" />{{
                t('liveSync.warning.two_way')
              }}
            </p>
            <p class="text-small text-fg-muted">{{ t('liveSync.wizard.twoWayHelp') }}</p>
            <DsCheckbox v-model="o.enablePreImages" :label="t('liveSync.wizard.enablePreImages')" />
            <DsCheckbox v-model="o.confirmTwoWay" :label="t('liveSync.wizard.confirmTwoWay')" />
          </div>
          <div v-if="has('overwrite')" :class="[card, warn]">
            <p class="flex items-center gap-2 font-medium">
              <AlertTriangle class="size-4 text-warning" aria-hidden="true" />{{
                t('liveSync.warning.overwrite')
              }}
            </p>
            <DsCheckbox v-model="o.confirmOverwrite" :label="t('liveSync.wizard.confirmOverwrite')" />
          </div>
          <div v-if="has('oplog_window')" :class="[card, warn]">
            <p class="flex items-center gap-2 font-medium">
              <AlertTriangle class="size-4 text-warning" aria-hidden="true" />{{
                t('liveSync.warning.oplog_window')
              }}
            </p>
            <DsCheckbox v-model="o.confirmOplog" :label="t('liveSync.wizard.confirmOplog')" />
          </div>
          <p v-if="has('oplog_unknown')" class="flex items-center gap-2 text-small text-fg-muted">
            <Info class="size-4" aria-hidden="true" />{{ t('liveSync.warning.oplog_unknown') }}
          </p>
          <div v-if="plan.copy.missingRules.length" :class="[card, warn]">
            <p class="flex items-center gap-2 font-medium">
              <AlertTriangle class="size-4 text-warning" aria-hidden="true" />{{
                t('liveSync.warning.personal_unruled')
              }}
            </p>
            <ul class="font-mono text-small">
              <li v-for="r in plan.copy.missingRules" :key="String(r)">{{ r }}</li>
            </ul>
            <DsCheckbox v-model="o.confirmPersonal" :label="t('liveSync.wizard.confirmPersonal')" />
            <DsCheckbox
              v-if="plan.copy.mayAddRules"
              v-model="o.addRulesToTarget"
              :label="t('liveSync.wizard.addRules')"
            />
          </div>
          <div v-if="has('unique_masked')" :class="[card, 'border-line']">
            <p class="flex items-center gap-2 font-medium">
              <Info class="size-4" aria-hidden="true" />{{ t('liveSync.warning.unique_masked') }}
            </p>
          </div>
          <div v-if="has('ttl')" :class="[card, warn]">
            <p class="flex items-center gap-2 font-medium">
              <AlertTriangle class="size-4 text-warning" aria-hidden="true" />{{ t('liveSync.warning.ttl') }}
            </p>
            <DsCheckbox v-model="o.confirmTtl" :label="t('liveSync.wizard.confirmTtl')" />
          </div>
          <p
            v-if="plan.copy.deployment === 'unknown'"
            class="flex items-center gap-2 text-small text-warning"
            role="status"
          >
            <AlertTriangle class="size-4" aria-hidden="true" />{{ t('liveSync.warning.deployment_unknown') }}
          </p>
          <DsFormErrors :messages="blocking.map((r) => words.refusal(r))" />
        </template>
      </template>
    </div>

    <template #footer>
      <DsButton v-if="at > 0" variant="ghost" @click="back">{{ t('liveSync.wizard.back') }}</DsButton>
      <DsButton v-if="step !== 'summary'" variant="primary" :disabled="!canNext" @click="next">{{
        t('liveSync.wizard.next')
      }}</DsButton>
      <DsButton v-else variant="primary" :disabled="!ready" :loading="busy" @click="start">{{
        t(review ? 'liveSync.wizard.carryOn' : o.later ? 'liveSync.wizard.schedule' : 'liveSync.wizard.start')
      }}</DsButton>
    </template>
  </DsDialog>
</template>
