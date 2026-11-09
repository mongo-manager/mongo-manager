<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { keyError, keysOf } from './keyText'
import { afterRulesAdded } from '@/masking/refresh'
import { computed, onBeforeUnmount, reactive, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { AlertTriangle, Info } from 'lucide-vue-next'
import {
  COPY_MODES,
  parseQueryObject,
  serializeValue,
  type CopyMode,
  type CopyPlan,
  type PresetInput,
} from '@mongo-manager/shared/browser'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import DsSelect from '@/ds/DsSelect.vue'
import DsInput from '@/ds/DsInput.vue'
import DsSuggestInput from '@/ds/DsSuggestInput.vue'
import { useCollectionNames, useDatabaseNames } from '@/connections/namespaceNames'
import DsTextarea from '@/ds/DsTextarea.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import DsStepper, { type StepItem } from '@/ds/DsStepper.vue'
import DsChoiceCard from '@/ds/DsChoiceCard.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import { describeError } from '@/api/errors'
import { connectionsApi, queryKeys } from '@/api/connections'
import { transferApi, type ExportQuery } from '@/api/transfer'
import { useJobsStore } from '@/jobs/store'
import { useToastStore } from '@/stores/toasts'
import { useWorkspaceDialogs } from '@/stores/workspaceDialogs'
import { formatBytes, formatCount } from '@/format'
import PresetPicker from './PresetPicker.vue'

/**
 * Phase 3d-2 spec §3.1–3.2: copy a collection (or a database) to the same or another connection,
 * or, with `compare`, start a comparison with a target. The server plans the copy (target state,
 * path, personal data, TTL indexes, refusals); the start echoes the plan's hash.
 */
const props = defineProps<{
  connectionId: string
  db: string
  coll?: string
  query?: ExportQuery
  stages?: unknown[]
  compare?: boolean
}>()
const queryClient = useQueryClient()
const emit = defineEmits<{ close: [] }>()
const { t, locale } = useI18n()
const jobs = useJobsStore()
const toasts = useToastStore()
const id = useId()

type Step = 'source' | 'target' | 'options' | 'summary' | 'compare'
const STEPS = computed<Step[]>(() =>
  props.compare
    ? props.coll
      ? ['target', 'compare']
      : ['source', 'target', 'compare']
    : ['source', 'target', 'options', 'summary'],
)
const step = ref<Step>(STEPS.value[0]!)
const next = () =>
  (step.value = STEPS.value[Math.min(STEPS.value.indexOf(step.value) + 1, STEPS.value.length - 1)]!)
const back = () => (step.value = STEPS.value[Math.max(STEPS.value.indexOf(step.value) - 1, 0)]!)
const isLast = computed(() => STEPS.value.indexOf(step.value) === STEPS.value.length - 1)
// The stepper goes back only (todo steps are disabled), as Back does.
const stepItems = computed<StepItem[]>(() =>
  STEPS.value.map((s, i) => ({
    id: s,
    label: t(`dataTransfer.copy.steps.${s}`),
    state: s === step.value ? 'current' : i < STEPS.value.indexOf(step.value) ? 'done' : 'todo',
  })),
)

// Plan ruling 10: the connections the caller may write to (compare: read); the server checks again.
const { data: connections } = useQuery({
  queryKey: queryKeys.connections,
  queryFn: () => connectionsApi.list(),
})
const NEEDS = computed(() => (props.compare ? ['documents:read'] : ['documents:write', 'jobs:run']))
const targets = computed(() =>
  (connections.value ?? []).filter((c) => NEEDS.value.every((p) => c.permissions.includes(p as never))),
)
const targetOptions = computed(() =>
  targets.value.map((c) => ({
    value: c.id,
    label: t('dataTransfer.copy.role', { name: c.name, role: c.access }),
  })),
)
const { data: sourceCollections } = useQuery({
  queryKey: computed(() => queryKeys.collections(props.connectionId, props.db)),
  queryFn: () => connectionsApi.collections(props.connectionId, props.db),
  enabled: computed(() => !props.coll),
})
// Final review M4: a database copy chooses its views one by one too (a comparison compares collections).
const collectionNames = computed(() =>
  (sourceCollections.value ?? [])
    .filter((c) => (props.compare ? c.type !== 'view' : true) && !c.name.startsWith('system.'))
    .map((c) => ({ name: c.name, view: c.type === 'view' })),
)
// Final review M5: personal values hidden on the source: the copy is anonymous, whatever is ticked.
const sourceRestricted = computed(
  () => (connections.value ?? []).find((c) => c.id === props.connectionId)?.restricted === true,
)

const sourceKind = ref<'collection' | 'query' | 'filter' | 'pipeline'>(
  props.stages ? 'pipeline' : props.query ? 'query' : 'collection',
)
/**
 * W4.3 (phase 3d-2 spec §3.1): a filter typed here, read by the safe parser (shell syntax: ObjectId,
 * ISODate…) and sent as canonical EJSON; the server's gate checks it as any query.
 */
const ownFilter = ref('{}')
const parsedFilter = computed<{ ok: true; value: Record<string, unknown> } | { ok: false; reason: string }>(
  () => {
    try {
      return { ok: true, value: serializeValue(parseQueryObject(ownFilter.value)) as Record<string, unknown> }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  },
)
const sourceBlocked = computed(
  () => step.value === 'source' && sourceKind.value === 'filter' && !parsedFilter.value.ok,
)

/** W4.3: the source's estimated size — the collection's, or the database's. */
const collectionStats = useQuery({
  queryKey: computed(() => ['copy', 'source-size', props.connectionId, props.db, props.coll ?? null]),
  queryFn: async () => {
    if (props.coll) {
      const s = await connectionsApi.collectionStats(props.connectionId, props.db, props.coll)
      return { count: s.count, bytes: s.size }
    }
    const s = await connectionsApi.databaseStats(props.connectionId, props.db)
    return { count: s.objects, bytes: s.dataSize }
  },
  enabled: computed(() => !props.compare),
  retry: false,
})
const sourceSize = computed(() => {
  const s = collectionStats.data.value
  if (!s || !Number.isFinite(s.count)) return null
  // A size hidden where personal data is hidden from you: the count alone.
  const size = s.bytes !== null && Number.isFinite(s.bytes) ? formatBytes(s.bytes, locale.value) : null
  return size
    ? t('dataTransfer.copy.sourceSize', { n: n(s.count), size }, s.count)
    : t('dataTransfer.copy.sourceCount', { n: n(s.count) }, s.count)
})
const chosen = ref<string[]>([])
const target = reactive({ connectionId: props.connectionId, db: props.db, coll: props.coll ?? '' })
// User report 2026-10-30: the target connection's databases and collections, offered by name (a copy
// may still make a new one: it is typed). Never a view: nothing is copied into, or compared with, one.
const targetDatabases = useDatabaseNames(() => target.connectionId)
const targetCollections = useCollectionNames(
  () => target.connectionId,
  () => target.db,
  { views: false },
)
const o = reactive({
  mode: 'insert' as CopyMode,
  keys: '_id',
  updateOnly: false,
  onError: 'continue' as 'stop' | 'continue',
  indexes: true,
  validator: true,
  options: true,
  anonymous: false,
  views: true,
  confirmTtl: false,
  confirmPersonal: false,
  addRulesToTarget: false,
})
const filterText = ref('{}')
const ignoreText = ref('')
const plan = ref<CopyPlan | null>(null)
const busy = ref(false)
const errors = ref<string[]>([])

const source = () =>
  sourceKind.value === 'pipeline'
    ? { kind: 'pipeline', stages: props.stages ?? [] }
    : sourceKind.value === 'query'
      ? { kind: 'query', ...props.query }
      : sourceKind.value === 'filter' && parsedFilter.value.ok
        ? { kind: 'query', filter: parsedFilter.value.value }
        : { kind: 'collection' }

function body(dryRun: boolean): Record<string, unknown> {
  const common = {
    mode: o.mode,
    // Eighteenth review of explain masking (M-4): only where they are used, and checked.
    ...(o.mode === 'upsert' || o.mode === 'merge' ? { keys: keysOf(o.keys) } : {}),
    updateOnly: o.updateOnly,
    onError: o.onError,
    indexes: o.indexes,
    validator: o.validator,
    options: o.options,
    anonymous: o.anonymous || sourceRestricted.value,
    confirmTtl: o.confirmTtl,
    confirmPersonal: o.confirmPersonal,
    addRulesToTarget: o.addRulesToTarget,
    dryRun,
  }
  return props.coll
    ? { ...common, source: source(), target: { ...target } }
    : {
        ...common,
        target: { connectionId: target.connectionId, db: target.db },
        views: o.views,
        ...(chosen.value.length ? { collections: chosen.value } : {}),
      }
}

async function refreshPlan(): Promise<void> {
  errors.value = []
  try {
    plan.value = await transferApi.copyPlan(props.connectionId, props.db, props.coll ?? null, body(false))
  } catch (e) {
    plan.value = null
    errors.value = [describeError(e, t)]
  }
}
watch(step, (s) => {
  if (s === 'summary') void refreshPlan()
})
watch(
  () => [o.confirmTtl, o.confirmPersonal, o.addRulesToTarget, o.anonymous],
  () => {
    if (step.value === 'summary') void refreshPlan()
  },
)

/**
 * W4.3 (phase 3d-2 spec §3.1 step 2): as a target is chosen or typed, the plan says whether it exists
 * and how many documents it holds, what the mode does to it, and what the server would refuse. Only
 * the latest answer is shown; a refused plan (no right there) is said as such.
 */
type TargetCheck = { state: 'ok'; plan: CopyPlan } | { state: 'error'; message: string } | null
const targetCheck = ref<TargetCheck>(null)
let checkTicket = 0
let checkTimer: ReturnType<typeof setTimeout> | undefined
watch(
  () => [step.value, target.connectionId, target.db, target.coll, o.mode] as const,
  ([s]) => {
    clearTimeout(checkTimer)
    if (s !== 'target' || props.compare) return
    const ticket = ++checkTicket
    if (!target.db || (props.coll && !target.coll)) return void (targetCheck.value = null)
    checkTimer = setTimeout(async () => {
      try {
        const answer = await transferApi.copyPlan(
          props.connectionId,
          props.db,
          props.coll ?? null,
          body(false),
        )
        if (ticket === checkTicket) targetCheck.value = { state: 'ok', plan: answer }
      } catch (e) {
        if (ticket === checkTicket) targetCheck.value = { state: 'error', message: describeError(e, t) }
      }
    }, 300)
  },
  { immediate: true },
)
onBeforeUnmount(() => clearTimeout(checkTimer))
const targetConnection = computed(() => targets.value.find((c) => c.id === target.connectionId) ?? null)
const targetRefusals = computed(() =>
  targetCheck.value?.state === 'ok' ? targetCheck.value.plan.refusals.filter((r) => !CONFIRMS.has(r)) : [],
)
const existing = computed(() =>
  targetCheck.value?.state === 'ok' ? targetCheck.value.plan.collections.filter((c) => c.exists) : [],
)

// Final review M5: a deployment that cannot be told apart, with the same names, may be the source.
const maybeSource = computed(
  () =>
    plan.value?.deployment === 'unknown' &&
    target.db === props.db &&
    (!props.coll || target.coll === props.coll),
)

// Final review I8: copy settings as a preset (kind "copy"), like the import and export wizards.
const presetNamespace = computed(() => `${props.db}.${props.coll ?? '*'}`)
const currentPreset = (): PresetInput['body'] => ({
  mode: o.mode,
  keys: body(false).keys as string[],
  copy: {
    indexes: o.indexes,
    validator: o.validator,
    options: o.options,
    anonymous: o.anonymous,
    views: o.views,
    onError: o.onError,
    updateOnly: o.updateOnly,
  },
})
function applyPreset(saved: PresetInput['body']): void {
  if (saved.mode) o.mode = saved.mode
  // Nineteenth review of explain masking (M-2): a preset whose keys were dropped means _id.
  if (saved.keys?.length) o.keys = saved.keys.join(', ')
  else if (saved.mode === 'upsert' || saved.mode === 'merge') o.keys = '_id'
  const c = saved.copy ?? {}
  for (const k of ['indexes', 'validator', 'options', 'anonymous', 'views', 'updateOnly'] as const)
    if (typeof c[k] === 'boolean') o[k] = c[k]
  if (c.onError) o.onError = c.onError
}

const CONFIRMS = new Set(['confirm_ttl', 'confirm_personal'])
const blocking = computed(() => plan.value?.refusals.filter((r) => !CONFIRMS.has(r)) ?? [])
const ttlIndexes = computed(() => plan.value?.collections.flatMap((c) => c.ttlIndexes) ?? [])
const badKey = computed(() => (o.mode === 'upsert' || o.mode === 'merge' ? keyError(o.keys, t) : undefined))
const ready = computed(
  () => plan.value !== null && plan.value.refusals.length === 0 && !busy.value && badKey.value === undefined,
)

async function start(dryRun: boolean): Promise<void> {
  if (!plan.value) return
  busy.value = true
  errors.value = []
  try {
    const { job } = await transferApi.startCopy(props.connectionId, props.db, props.coll ?? null, {
      ...body(dryRun),
      planHash: plan.value.planHash,
    })
    jobs.upsert(job)
    if (o.addRulesToTarget && !dryRun) await afterRulesAdded(queryClient)
    toasts.push({
      kind: 'info',
      message: t(dryRun ? 'dataTransfer.copy.dryRunStarted' : 'dataTransfer.copy.started'),
    })
    emit('close')
  } catch (e) {
    errors.value = [describeError(e, t)]
    await refreshPlan()
  } finally {
    busy.value = false
  }
}

async function startCompare(): Promise<void> {
  errors.value = []
  let filter: Record<string, unknown>
  try {
    const parsed = JSON.parse(filterText.value || '{}') as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('not an object')
    filter = parsed as Record<string, unknown>
  } catch {
    errors.value = [t('dataTransfer.compare.invalidFilter')]
    return
  }
  const ignore = ignoreText.value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  busy.value = true
  try {
    const request = props.coll
      ? { target: { ...target }, filter, ignore }
      : {
          target: { connectionId: target.connectionId, db: target.db },
          ignore,
          ...(chosen.value.length ? { collections: chosen.value } : {}),
        }
    const { job } = await transferApi.startCompare(props.connectionId, props.db, props.coll ?? null, request)
    jobs.upsert(job)
    toasts.push({ kind: 'info', message: t('dataTransfer.compare.started') })
    emit('close')
  } catch (e) {
    errors.value = [describeError(e, t)]
  } finally {
    busy.value = false
  }
}

const workspace = useWorkspaceDialogs()
/** Phase 3e-2 spec §5: the same copy, then every change kept — the live sync wizard, pre-filled. */
function keepInSync(): void {
  workspace.open({
    kind: 'liveSync',
    connectionId: props.connectionId,
    db: props.db,
    ...(props.coll ? { coll: props.coll } : {}),
    preset: {
      target: {
        connectionId: target.connectionId,
        db: target.db,
        ...(props.coll ? { coll: target.coll } : {}),
      },
      startMode: o.mode === 'replace' ? 'replace' : o.mode === 'insert' ? 'copy' : 'merge',
      errorPolicy: o.onError === 'stop' ? 'pause' : 'skip',
      anonymous: o.anonymous,
      ...(chosen.value.length
        ? { collections: chosen.value.filter((n) => !collectionNames.value.find((c) => c.name === n)?.view) }
        : {}),
    },
  })
}

const n = (v: number) => formatCount(v, locale.value)
const title = computed(() => {
  const name = props.coll ?? props.db
  if (props.compare)
    return t(props.coll ? 'dataTransfer.compare.title' : 'dataTransfer.compare.titleDatabase', { name })
  return t(props.coll ? 'dataTransfer.copy.title' : 'dataTransfer.copy.titleDatabase', { name })
})
const card = 'flex flex-col gap-2 rounded-lg border p-3 text-sm'
const sourceKindOptions = computed(() => [
  { value: 'collection' as const, label: t('dataTransfer.copy.sourceKinds.collection') },
  ...(props.query ? [{ value: 'query' as const, label: t('dataTransfer.copy.sourceKinds.query') }] : []),
  { value: 'filter' as const, label: t('dataTransfer.copy.sourceKinds.filter') },
  ...(props.stages
    ? [{ value: 'pipeline' as const, label: t('dataTransfer.copy.sourceKinds.pipeline') }]
    : []),
])
const onErrorOptions = computed(() => [
  { value: 'continue' as const, label: t('dataTransfer.onErrorContinue') },
  { value: 'stop' as const, label: t('dataTransfer.onErrorStop') },
])
</script>

<template>
  <DsDialog open :title="title" size="xl" @close="emit('close')">
    <div class="flex flex-col gap-4">
      <!-- A dialog, not a sheet: the steps stay in a row at every width. Named "Steps", not the
           import's "Import steps" it borrowed before. -->
      <DsStepper
        class="xl:flex-row!"
        :steps="stepItems"
        :label="t('backup.steps.label')"
        @select="(s) => (step = s as Step)"
      />
      <DsFormErrors :messages="errors" />

      <template v-if="step === 'source'">
        <!-- Short names, no explanation: a segmented control, named by the step. -->
        <DsSegmented
          v-if="coll"
          v-model="sourceKind"
          class="self-start"
          :label="t('dataTransfer.copy.steps.source')"
          :options="sourceKindOptions"
        />
        <template v-if="coll && sourceKind === 'filter'">
          <DsTextarea
            v-model="ownFilter"
            :label="t('dataTransfer.copy.filter')"
            :hint="t('dataTransfer.copy.filterHint')"
            :rows="3"
            mono
          />
          <p v-if="!parsedFilter.ok" class="text-small text-danger" role="alert">
            {{ t('dataTransfer.copy.filterInvalid', { reason: parsedFilter.reason }) }}
          </p>
        </template>
        <p v-if="sourceSize" class="text-small text-fg-subtle" data-test="source-size">
          {{ sourceSize }}
          <template v-if="coll && sourceKind !== 'collection'">{{
            t('dataTransfer.copy.sourceWhole')
          }}</template>
        </p>
        <fieldset v-else class="flex flex-col gap-2 text-ui">
          <legend class="font-medium">{{ t('dataTransfer.copy.collections') }}</legend>
          <p class="text-small text-fg-subtle">{{ t('dataTransfer.copy.allCollections') }}</p>
          <div class="grid max-h-56 grid-cols-2 gap-1 overflow-auto">
            <label
              v-for="c in collectionNames"
              :key="c.name"
              class="flex items-center gap-2 font-mono text-small"
            >
              <input v-model="chosen" type="checkbox" :value="c.name" class="size-4 accent-accent" />
              {{ c.name }}
              <span v-if="c.view" class="rounded-full bg-muted px-1.5 font-sans text-[10px] text-fg-muted">{{
                t('dataTransfer.copy.viewTag')
              }}</span>
            </label>
          </div>
          <DsCheckbox v-if="!compare" v-model="o.views" :label="t('dataTransfer.copy.views')" />
        </fieldset>
      </template>

      <template v-else-if="step === 'target'">
        <div class="flex flex-wrap items-start gap-3">
          <DsSelect
            v-model="target.connectionId"
            data-test="target-connection"
            :label="t('dataTransfer.copy.targetConnection')"
            :options="targetOptions"
          />
          <DsSuggestInput
            v-model.trim="target.db"
            :label="t('dataTransfer.copy.database')"
            :suggestions="targetDatabases"
          />
          <DsSuggestInput
            v-if="coll"
            v-model.trim="target.coll"
            :label="t('dataTransfer.copy.collection')"
            :suggestions="targetCollections"
          />
        </div>
        <!-- W4.3: the target as it is now, checked as it is typed (the plan route; the start checks again). -->
        <div
          v-if="targetCheck"
          data-test="target-check"
          :data-state="targetCheck.state"
          role="status"
          :class="[
            card,
            targetCheck.state === 'error' || targetRefusals.length ? 'border-danger/30' : 'border-line',
          ]"
        >
          <template v-if="targetCheck.state === 'error'">
            <p class="flex items-center gap-2 text-danger">
              <AlertTriangle class="size-4" aria-hidden="true" />{{ targetCheck.message }}
            </p>
          </template>
          <template v-else>
            <p v-if="coll && targetCheck.plan.collections[0]" class="font-mono">
              {{ target.db }}.{{ targetCheck.plan.collections[0].target }}:
              <span class="font-sans">{{
                targetCheck.plan.collections[0].exists
                  ? t('dataTransfer.copy.exists', { n: n(targetCheck.plan.collections[0].count ?? 0) })
                  : t('dataTransfer.copy.new')
              }}</span>
            </p>
            <p v-else-if="!coll">
              {{
                t(
                  'dataTransfer.copy.existingOf',
                  { n: existing.length, total: targetCheck.plan.collections.length },
                  existing.length,
                )
              }}
            </p>
            <p v-if="existing.length" class="text-fg-muted">
              {{ t(`dataTransfer.copy.targetEffect.${o.mode}`) }}
            </p>
            <p v-if="targetConnection" class="text-fg-muted">
              {{
                t('dataTransfer.copy.targetRole', {
                  role: targetConnection.access,
                  name: targetConnection.name,
                })
              }}
            </p>
            <p v-for="r in targetRefusals" :key="r" class="flex items-center gap-2 text-danger">
              <AlertTriangle class="size-4" aria-hidden="true" />{{ t(`dataTransfer.copy.refusal.${r}`) }}
            </p>
          </template>
        </div>
      </template>

      <template v-else-if="step === 'options'">
        <fieldset class="grid gap-3 sm:grid-cols-2">
          <legend class="mb-2 text-ui font-medium">{{ t('dataTransfer.copy.mode') }}</legend>
          <DsChoiceCard
            v-for="m in COPY_MODES"
            :key="m"
            v-model="o.mode"
            :name="`${id}-mode`"
            :value="m"
            :title="t(`dataTransfer.copy.modes.${m}`)"
            :help="t(`dataTransfer.copy.modeHelp.${m}`)"
          />
        </fieldset>
        <div v-if="o.mode === 'upsert' || o.mode === 'merge'" class="flex flex-wrap items-end gap-3 text-ui">
          <DsInput v-model="o.keys" :label="t('dataTransfer.copy.keys')" :error="badKey" />
          <!-- Upsert and merge alike (data review 2026-10-13): never a choice sent while hidden. -->
          <DsCheckbox v-model="o.updateOnly" :label="t('dataTransfer.copy.updateOnly')" />
        </div>
        <div class="grid gap-2 text-ui sm:grid-cols-2">
          <DsCheckbox v-model="o.indexes" :label="t('dataTransfer.copy.indexes')" />
          <DsCheckbox v-model="o.validator" :label="t('dataTransfer.copy.validator')" />
          <DsCheckbox v-model="o.options" :label="t('dataTransfer.copy.options')" />
          <DsCheckbox
            data-test="copy-anonymous"
            :model-value="o.anonymous || sourceRestricted"
            :disabled="sourceRestricted"
            :label="t('dataTransfer.copy.anonymous')"
            @update:model-value="o.anonymous = $event"
          />
        </div>
        <p v-if="sourceRestricted" class="text-small text-fg-subtle">
          {{ t('dataTransfer.copy.anonymousLocked') }}
        </p>
        <!-- Two short words, no explanation: a segmented control (the group carries the name). -->
        <div class="flex flex-col items-start gap-1.5 text-ui">
          <span class="font-medium" aria-hidden="true">{{ t('dataTransfer.onErrorLabel') }}</span>
          <DsSegmented
            v-model="o.onError"
            :label="t('dataTransfer.onErrorLabel')"
            :options="onErrorOptions"
          />
        </div>
        <PresetPicker
          kind="copy"
          :namespace="presetNamespace"
          :current="currentPreset"
          @apply="applyPreset"
        />
      </template>

      <template v-else-if="step === 'summary'">
        <p v-if="!plan && !errors.length" class="text-ui text-fg-subtle" role="status">…</p>
        <template v-if="plan">
          <ul class="flex flex-col gap-1 text-ui">
            <li v-for="c in plan.collections" :key="c.source" class="flex flex-wrap items-center gap-2">
              <span class="font-mono">{{ c.source }} → {{ target.db }}.{{ c.target }}</span>
              <span class="text-small text-fg-subtle">
                {{
                  c.exists
                    ? t('dataTransfer.copy.exists', { n: n(c.count ?? 0) })
                    : t('dataTransfer.copy.new')
                }}
              </span>
              <span class="rounded-full bg-muted px-2 py-0.5 text-small">
                {{ t(`dataTransfer.copy.path.${c.path}`) }}
              </span>
              <!-- W8: a Queryable Encryption collection is refused; a CSFLE one goes as stored. -->
              <span
                v-if="c.encrypted === 'queryable'"
                data-encrypted="queryable"
                class="text-small text-danger"
              >
                {{ t('dataTransfer.copy.encryptedQueryable', { name: c.source }) }}
              </span>
              <span v-else-if="c.skipped" class="text-small text-warning">
                {{ t('dataTransfer.copy.skipped', { name: c.source, reason: c.skipped }) }}
              </span>
              <span
                v-if="c.encrypted === 'ciphertext'"
                data-encrypted="ciphertext"
                class="basis-full text-small text-warning"
              >
                {{ t('dataTransfer.copy.encryptedCiphertext', { name: c.source }) }}
              </span>
              <span v-if="c.sharded && o.mode === 'replace'" class="text-small text-danger">
                {{ t('dataTransfer.copy.sharded', { name: c.target }) }}
              </span>
              <span v-if="c.validatorLeftOut" class="basis-full text-small text-warning">
                {{ t('dataTransfer.copy.validatorLeftOut', { name: c.source }) }}
              </span>
              <span v-if="c.indexesLeftOut?.length" class="basis-full text-small text-warning">
                {{
                  t('dataTransfer.copy.indexesLeftOut', { name: c.source, list: c.indexesLeftOut.join(', ') })
                }}
              </span>
            </li>
          </ul>
          <p v-if="plan.viewsLeftOut?.length" class="text-small text-warning">
            {{ t('dataTransfer.copy.viewsLeftOut', { names: plan.viewsLeftOut.join(', ') }) }}
          </p>
          <p v-if="maybeSource" class="flex items-center gap-2 text-small text-warning" role="status">
            <AlertTriangle class="size-4" aria-hidden="true" />{{ t('dataTransfer.copy.maybeSource') }}
          </p>
          <p v-if="plan.views.length" class="text-small text-fg-subtle">
            {{ t('dataTransfer.copy.viewsList', { names: plan.views.join(', ') }) }}
          </p>
          <p v-if="plan.masked" class="flex items-center gap-2 text-small text-fg-muted">
            <Info class="size-4" aria-hidden="true" />{{ t('dataTransfer.copy.maskedNotice') }}
          </p>
          <div v-if="ttlIndexes.length" :class="[card, 'border-warning/30']">
            <p class="flex items-center gap-2 font-medium">
              <AlertTriangle class="size-4 text-warning" aria-hidden="true" />{{
                t('dataTransfer.copy.ttlTitle')
              }}
            </p>
            <p class="font-mono text-small">{{ ttlIndexes.join(', ') }}</p>
            <DsCheckbox
              v-model="o.confirmTtl"
              data-test="confirm-ttl"
              :label="t('dataTransfer.copy.confirmTtl')"
            />
          </div>
          <div v-if="plan.missingRules.length" :class="[card, 'border-warning/30']">
            <p class="flex items-center gap-2 font-medium">
              <AlertTriangle class="size-4 text-warning" aria-hidden="true" />{{
                t('dataTransfer.copy.personalTitle')
              }}
            </p>
            <ul class="font-mono text-small">
              <li v-for="r in plan.missingRules" :key="r">{{ r }}</li>
            </ul>
            <DsCheckbox
              v-model="o.confirmPersonal"
              data-test="confirm-personal"
              :label="t('dataTransfer.copy.confirmPersonal')"
            />
            <DsCheckbox
              v-if="plan.mayAddRules"
              v-model="o.addRulesToTarget"
              :label="t('dataTransfer.copy.addRules')"
            />
          </div>
          <p v-if="plan.collections.some((c) => c.fullSort)" class="text-small text-fg-subtle">
            {{ t('dataTransfer.copy.fullSort') }}
          </p>
          <DsFormErrors :messages="blocking.map((r) => t(`dataTransfer.copy.refusal.${r}`))" />
        </template>
      </template>

      <template v-else-if="step === 'compare'">
        <DsTextarea
          v-if="coll"
          v-model="filterText"
          :label="t('dataTransfer.compare.filter')"
          :rows="3"
          mono
        />
        <DsInput
          v-model="ignoreText"
          data-test="compare-ignore"
          :label="t('dataTransfer.compare.ignore')"
          placeholder="updatedAt"
        />
      </template>
    </div>

    <template #footer>
      <DsButton v-if="STEPS.indexOf(step) > 0" variant="ghost" @click="back">{{
        t('dataTransfer.back')
      }}</DsButton>
      <DsButton v-if="!isLast" variant="primary" :disabled="sourceBlocked" @click="next">{{
        t('dataTransfer.next')
      }}</DsButton>
      <template v-else-if="compare">
        <DsButton variant="primary" :loading="busy" @click="startCompare">{{
          t('dataTransfer.compare.start')
        }}</DsButton>
      </template>
      <template v-else>
        <DsButton v-if="sourceKind === 'collection'" variant="ghost" @click="keepInSync">{{
          t('liveSync.menu.fromCopy')
        }}</DsButton>
        <DsButton :disabled="!ready" @click="start(true)">{{ t('dataTransfer.dryRun') }}</DsButton>
        <DsButton variant="primary" :disabled="!ready" :loading="busy" @click="start(false)">{{
          t('dataTransfer.copy.start')
        }}</DsButton>
      </template>
    </template>
  </DsDialog>
</template>
