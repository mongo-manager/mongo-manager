<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { keyError as keyFieldError, keysOf } from '@/transfer/keyText'
import { afterRulesAdded } from '@/masking/refresh'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { FileArchive, Loader2, Lock, RotateCcw, RotateCw, ShieldAlert, ShieldCheck } from 'lucide-vue-next'
import type { ArchiveSummary, InspectResponse, RestoreMode, RestorePlan } from '@mongo-manager/shared/browser'
import DsSheet from '@/ds/DsSheet.vue'
import DsStepper, { type StepItem } from '@/ds/DsStepper.vue'
import DsButton from '@/ds/DsButton.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsSelect from '@/ds/DsSelect.vue'
import DsInput from '@/ds/DsInput.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import { ApiError } from '@/api/client'
import { connectionsApi, queryKeys } from '@/api/connections'
import { backupApi, backupKeys } from '@/api/backup'
import { transferApi } from '@/api/transfer'
import { destinationKeys, destinationsApi } from '@/api/destinations'
import { jobsApi } from '@/api/jobs'
import RemoteSourcePicker from './RemoteSourcePicker.vue'
import { useJobsStore } from '@/jobs/store'
import { useToastStore } from '@/stores/toasts'
import { formatBytes, formatCount, formatDuration } from '@/format'
import PreflightList from './PreflightList.vue'
import DsChoiceCard from '@/ds/DsChoiceCard.vue'
import DsProgress from '@/ds/DsProgress.vue'
import DropZone from './DropZone.vue'
import MappingTable, { type MappingRow } from './MappingTable.vue'
import { useResumableUpload } from './useResumableUpload'
import { useRestorePlan } from './useRestorePlan'
import { cannotReach } from '@/connections/reachability'
import { useBackupError } from './checkText'
import KitUnlock from './KitUnlock.vue'
import { keysApi, scheduleKeys } from '@/api/schedules'
import { useKeyError } from '@/account/kit'
import { readBusyWait } from './readBusy'
import { restoreImpact } from './restoreImpact'

/**
 * Phase 3d-3a spec §3.2, U4–U7: a file is inspected while it uploads; the mapping and mode follow
 * the plan live; replacing a non-empty target needs its name typed; a dry run can become the real run.
 */
const sheet = ref<InstanceType<typeof DsSheet> | null>(null)
const props = defineProps<{
  connectionId: string
  db?: string
  coll?: string
  backupId?: string
  /** Phase 3d-3b V7: a backup at a destination, fetched as soon as the sheet opens. */
  remote?: { destinationId: string; key: string; name: string }
}>()
const emit = defineEmits<{ close: [] }>()
const { t, locale } = useI18n()
const jobs = useJobsStore()
const toasts = useToastStore()
const upload = useResumableUpload()
const backupError = useBackupError()

type Step = 'source' | 'preview' | 'target' | 'mode' | 'summary'
const STEPS: Step[] = ['source', 'preview', 'target', 'mode', 'summary']
const MODES = ['insert', 'upsert', 'replace'] as const
const step = ref<Step>('source')
const target = ref(props.connectionId)
const source = ref<{ kind: 'upload'; uploadId: string } | { kind: 'backup'; backupId: string } | null>(
  props.backupId ? { kind: 'backup', backupId: props.backupId } : null,
)
const inspected = ref<InspectResponse | null>(null)
const password = ref('')
const passwordTry = ref('')
const passwordError = ref<string | null>(null)
// Phase 3d-3c: a recovery kit for a backup-key file (used for this restore; imported only on request).
const kit = ref('')
const importKit = ref(false)
const kitError = ref<string | null>(null)
const keyError = useKeyError()
const queryClient = useQueryClient()
const openedWith = computed(() =>
  inspected.value?.state === 'ready' ? (inspected.value.openedWith ?? null) : null,
)
const openedText = computed(() =>
  openedWith.value?.kind === 'key'
    ? t('backup.unlock.openedWithKey', {
        name: openedWith.value.name,
        fingerprint: openedWith.value.fingerprint,
      })
    : openedWith.value?.kind === 'kit'
      ? t('backup.unlock.openedWithKit', { fingerprint: openedWith.value.fingerprint })
      : null,
)
async function importOnce(): Promise<void> {
  if (!importKit.value || !kit.value) return
  importKit.value = false
  try {
    const key = await keysApi.import(kit.value)
    toasts.push({ kind: 'success', message: t('backup.unlock.imported', { name: key.name }) })
    await queryClient.invalidateQueries({ queryKey: scheduleKeys.keys })
  } catch (e) {
    // Already here under another name: nothing to do.
    const reason = e instanceof ApiError ? (e.details as { reason?: unknown } | undefined)?.reason : undefined
    if (reason !== 'key_exists') toasts.push({ kind: 'error', message: keyError(e) })
  }
}
function unlockWith(opener: { kit: string; importKey: boolean } | { password: string }): void {
  kitError.value = null
  if ('kit' in opener) {
    kit.value = opener.kit
    importKit.value = opener.importKey
  } else password.value = opener.password
  void inspectNow()
}
const rows = ref<MappingRow[]>([])
const mode = ref<RestoreMode>('insert')
const keys = ref('_id')
const indexes = ref(true)
const options = ref(true)
const engine = ref<'builtin' | 'tools'>('builtin')
const onError = ref<'continue' | 'stop'>('continue')
const confirmTtl = ref(false)
const confirmPersonal = ref(false)
const confirmMasked = ref(false)
const addRules = ref(false)
const typed = ref<Record<string, string>>({})
const busy = ref(false)
const errors = ref<string[]>([])
const fileName = ref('')
/** Jobs this sheet started: an upload they read is never discarded here. */
const startedJobs = new Set<string>()
let poll: ReturnType<typeof setTimeout> | undefined
let pollDelay = 1000
let lastReceived = -1

const { data: connections } = useQuery({
  queryKey: queryKeys.connections,
  queryFn: () => connectionsApi.list(),
})
const targets = computed(() =>
  (connections.value ?? []).filter(
    (c) => c.permissions.includes('documents:write') && c.permissions.includes('jobs:run'),
  ),
)
const targetOptions = computed(() => targets.value.map((c) => ({ value: c.id, label: c.name })))
/** W4.4: the target's databases, so "Into a new database" never picks one that exists. */
const { data: targetDatabases } = useQuery({
  queryKey: computed(() => queryKeys.databases(target.value)),
  queryFn: () => connectionsApi.databases(target.value),
  retry: false,
})
const takenDbs = computed(() => targetDatabases.value?.databases.map((d) => d.name) ?? [])
const { data: kept } = useQuery({ queryKey: backupKeys.list(), queryFn: () => backupApi.list() })
const summary = computed<ArchiveSummary | null>(() =>
  inspected.value?.state === 'ready' ? inspected.value.summary : null,
)
const { data: destinations } = useQuery({
  queryKey: destinationKeys.mine,
  queryFn: () => destinationsApi.mine(),
})
/** V7: where the file comes from — an upload, a kept backup, or a destination. */
type SourceTab = 'upload' | 'kept' | 'destination'
const sourceTab = ref<SourceTab>(props.remote ? 'destination' : 'upload')
/** Final review C21: the APG tabs pattern — only the tabs there is something behind, roving focus. */
const tabs = computed<SourceTab[]>(() => [
  'upload',
  ...(kept.value?.length ? (['kept'] as const) : []),
  ...(destinations.value?.length ? (['destination'] as const) : []),
])
const activeTab = computed<SourceTab>(() =>
  tabs.value.includes(sourceTab.value) ? sourceTab.value : 'upload',
)
const tabsId = useId()
const tabEls = ref<HTMLButtonElement[]>([])
async function moveTab(e: KeyboardEvent): Promise<void> {
  const list = tabs.value
  const i = list.indexOf(activeTab.value)
  const next =
    e.key === 'ArrowRight'
      ? (i + 1) % list.length
      : e.key === 'ArrowLeft'
        ? (i - 1 + list.length) % list.length
        : e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? list.length - 1
            : -1
  if (next < 0) return
  e.preventDefault()
  sourceTab.value = list[next]!
  await nextTick()
  tabEls.value.find((el) => el.dataset.tab === sourceTab.value)?.focus()
}
const fetchJobId = ref<string | null>(null)
const fetchJob = computed(() => (fetchJobId.value ? (jobs.byId[fetchJobId.value] ?? null) : null))
const fetching = computed(() => fetchJob.value?.state === 'running')
const fetchPct = computed(() => {
  const p = fetchJob.value?.progress
  return p?.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0
})
/**
 * Final review C3: the fetch request itself takes a moment — one at a time, the picker waits, and a
 * job that answers after the sheet closed is cancelled at once (nobody will restore its file).
 */
const fetchStarting = ref(false)
let alive = true
/** C28: false for a file without a manifest — nothing to check it against before it is restored. */
const fetchVerified = ref<boolean | null>(null)
async function fetchRemote(choice: { destinationId: string; key: string; name: string }): Promise<void> {
  if (fetchStarting.value || fetchJobId.value) return
  fetchStarting.value = true
  errors.value = []
  try {
    const { uploadId, job, verified } = await destinationsApi.fetch(choice.destinationId, {
      connectionId: target.value,
      key: choice.key,
    })
    if (!alive) {
      void jobsApi.cancel(job.id).catch(() => undefined)
      return
    }
    jobs.upsert(job)
    fetchJobId.value = job.id
    fetchVerified.value = verified ?? job.verified ?? null
    fileName.value = choice.name
    inspected.value = null
    rows.value = []
    source.value = { kind: 'upload', uploadId }
    void inspectNow()
  } catch (e) {
    if (alive) errors.value = backupError(e)
  } finally {
    fetchStarting.value = false
  }
}
const unverified = computed(() => fetchVerified.value === false || fetchJob.value?.verified === false)
// A download that fails or is cancelled ends the source: the file is gone (its job removed it).
watch(
  () => fetchJob.value?.state,
  (state) => {
    if (state !== 'failed' && state !== 'cancelled' && state !== 'interrupted') return
    clearTimeout(poll)
    const error = fetchJob.value?.error
    // C24: a cancelled download is said as cancelled; an empty error never ends a sentence.
    errors.value = [
      state === 'cancelled'
        ? t('backup.remote.fetchCancelled')
        : error
          ? t('backup.remote.fetchFailed', { error })
          : t('backup.remote.fetchFailedPlain'),
    ]
    fetchJobId.value = null
    fetchVerified.value = null
    source.value = null
    inspected.value = null
    step.value = 'source'
  },
)
onMounted(() => {
  if (props.remote) void fetchRemote(props.remote)
})
const sourceName = computed(
  () =>
    fileName.value ||
    kept.value?.find((k) => source.value?.kind === 'backup' && k.id === source.value.backupId)?.name ||
    '',
)

async function inspectNow(): Promise<void> {
  clearTimeout(poll)
  // C3: nothing is read, nor scheduled, once the sheet is gone.
  if (!source.value || !alive) return
  try {
    const r = await backupApi.inspect({
      source: source.value,
      ...(password.value ? { password: password.value } : {}),
      ...(kit.value ? { kit: kit.value } : {}),
    })
    if (!alive) return
    inspected.value = r
    errors.value = []
    passwordError.value = null
    kitError.value = null
    if (r.state === 'waiting') {
      // Final review I2: each inspection reads the file (and may derive a key): ask again soon while
      // it grows, less and less often while it does not.
      pollDelay = r.received > lastReceived ? 1000 : Math.min(8000, pollDelay * 1.5)
      lastReceived = r.received
      poll = setTimeout(inspectNow, pollDelay)
    }
    if (r.state === 'ready' && !rows.value.length) {
      if (r.openedWith?.kind === 'kit') void importOnce()
      const oneDb = r.summary.namespaces.every((x) => x.db === r.summary.namespaces[0]?.db)
      // W4.4 "Restore here…" on a collection: a backup of one collection goes into it, whatever its
      // name was; otherwise the namespace of the same name is the one chosen.
      const data = r.summary.namespaces.filter((x) => x.type !== 'view')
      const into = props.coll && props.db && data.length === 1 ? data[0] : undefined
      rows.value = r.summary.namespaces.map((n) => ({
        from: { db: n.db, coll: n.coll },
        // Opened on a database: a one-database backup goes there by default.
        to:
          n === into
            ? { db: props.db!, coll: props.coll! }
            : { db: props.db && oneDb ? props.db : n.db, coll: n.coll },
        type: n.type,
        on: !props.coll || n === into || (!into && n.coll === props.coll),
      }))
      if (step.value === 'source') step.value = 'preview'
    }
  } catch (e) {
    // The server is still reading this user's backup: ask again in a moment, the password kept.
    const wait = readBusyWait(e)
    if (wait !== null) {
      if (alive) poll = setTimeout(inspectNow, wait)
      return
    }
    const reason = e instanceof ApiError ? (e.details as { reason?: unknown } | undefined)?.reason : undefined
    if (kit.value && (reason === 'backup_key' || reason === 'kit_format' || reason === 'kit_checksum')) {
      // The kit form stays; the message says what happened.
      kit.value = ''
      kitError.value = keyError(e)
      return
    }
    if (password.value && (reason === 'backup_password' || (e instanceof ApiError && e.status === 429))) {
      // The password form stays; the message says what happened.
      password.value = ''
      passwordError.value =
        e instanceof ApiError && e.status === 429
          ? t('backup.password.throttled')
          : t('backup.password.wrong')
      // The keyboard goes back to the field, which says what happened (it is invalid and described).
      await nextTick()
      document.querySelector<HTMLInputElement>('[data-test="open-password"]')?.focus()
      return
    }
    errors.value = backupError(e)
  }
}

async function onFile(file: File): Promise<void> {
  fileName.value = file.name
  errors.value = []
  inspected.value = null
  rows.value = []
  // U4: inspect as soon as the server knows the upload, while it is still arriving.
  const stop = watch(
    upload.uploadId,
    (id) => {
      if (!id) return
      source.value = { kind: 'upload', uploadId: id }
      void inspectNow()
      stop()
    },
    { immediate: true },
  )
  try {
    await upload.start(file)
  } catch (e) {
    if (upload.state.value === 'error') errors.value = backupError(e)
  }
}
watch(
  source,
  (s) => {
    if (s?.kind === 'backup') void inspectNow()
  },
  { immediate: true },
)
function unlock(): void {
  if (!passwordTry.value) return
  password.value = passwordTry.value
  passwordTry.value = ''
  void inspectNow()
}
function chooseKept(id: string, name: string): void {
  source.value = { kind: 'backup', backupId: id }
  fileName.value = name
}

const uploadComplete = computed(
  () => source.value?.kind === 'backup' || upload.state.value === 'done' || fetchJob.value?.state === 'done',
)
const body = computed(() => {
  if (!source.value || !summary.value || !uploadComplete.value || !rows.value.some((r) => r.on)) return null
  return {
    source: source.value,
    ...(password.value ? { password: password.value } : {}),
    ...(kit.value ? { kit: kit.value } : {}),
    mapping: rows.value.filter((r) => r.on).map((r) => ({ from: r.from, to: r.to })),
    mode: mode.value,
    // Eighteenth review of explain masking (M-4): only where they are used, and checked.
    ...(mode.value === 'upsert' ? { keys: keysOf(keys.value) } : {}),
    indexes: indexes.value,
    options: options.value,
    engine: engine.value,
    onError: onError.value,
    confirmTtl: confirmTtl.value,
    confirmPersonal: confirmPersonal.value,
    confirmMasked: confirmMasked.value,
    addRulesToTarget: addRules.value,
    confirmNames: Object.entries(typed.value)
      .filter(([name, v]) => v === name)
      .map(([name]) => name),
  }
})
const { plan, loading, error: planError, refresh } = useRestorePlan(target, body)
// User report 2026-10-23: a target that cannot be reached is said as that, with Retry.
const unreachable = computed(() => cannotReach(planError.value))
const needNames = computed(() =>
  (plan.value?.namespaces ?? []).filter((n) => n.confirmName).map((n) => `${n.to.db}.${n.to.coll}`),
)
const ttlNames = computed(() => (plan.value?.namespaces ?? []).flatMap((n) => n.ttl).join(', '))
const badKey = computed(() => (mode.value === 'upsert' ? keyFieldError(keys.value, t) : undefined))
const ready = computed(
  () =>
    Boolean(plan.value) &&
    !loading.value &&
    // A plan that failed since keeps the last one shown: it no longer says what Start would do.
    !planError.value &&
    plan.value!.refusals.length === 0 &&
    !busy.value &&
    body.value !== null &&
    badKey.value === undefined,
)
const stepItems = computed<StepItem[]>(() =>
  STEPS.map((id, i) => ({
    id,
    label: t(`backup.steps.${id}`),
    state: id === step.value ? 'current' : i < STEPS.indexOf(step.value) ? 'done' : 'todo',
  })),
)
const canNext = computed(() =>
  step.value === 'source'
    ? Boolean(summary.value)
    : step.value === 'preview' || step.value === 'target'
      ? rows.value.some((r) => r.on)
      : true,
)
const go = (d: number) => {
  step.value = STEPS[Math.max(0, Math.min(STEPS.length - 1, STEPS.indexOf(step.value) + d))]!
}
const b = (n: number) => formatBytes(n, locale.value)
const uploadLine = computed(() =>
  upload.state.value === 'resuming'
    ? t('backup.restore.resuming')
    : t('backup.restore.uploading', {
        done: b(upload.sent.value),
        total: b(upload.total.value),
        speed: b(upload.speed.value),
        eta: upload.eta.value ? formatDuration(upload.eta.value, locale.value) : '…',
      }),
)
const percent = computed(() =>
  upload.total.value ? Math.round((upload.sent.value / upload.total.value) * 100) : 0,
)
/** U13: what was chosen, in words, on the summary step. */
const choices = computed(() => [
  { key: 'what', value: sourceName.value },
  {
    key: 'how',
    value: [
      t(`backup.restore.mode.${mode.value}`),
      t(`backup.engine.${engine.value}`),
      targets.value.find((c) => c.id === target.value)?.name ?? '',
    ]
      .filter(Boolean)
      .join(' · '),
  },
  {
    key: 'content',
    value: [
      indexes.value ? t('backup.content.indexes') : null,
      options.value ? t('backup.content.options') : null,
    ]
      .filter(Boolean)
      .join(' · '),
  },
  { key: 'onError', value: t(`backup.restore.onError.${onError.value}`) },
])
const impact = (n: RestorePlan['namespaces'][number]) =>
  restoreImpact(t, n, keys.value, (v) => formatCount(v, locale.value))

// U6: a finished dry run is shown here with a button that runs the real restore with the same settings.
const dryRunId = ref<string | null>(null)
const dryResult = ref<{ read: number; matching: number; rejected: number; expiring: number } | null>(null)
const stopListening = jobs.onFinished(async (job) => {
  if (job.id !== dryRunId.value) return
  const report = await transferApi.report(job.id).catch(() => null)
  if (report?.kind === 'restore')
    dryResult.value = {
      read: report.namespaces.reduce((s, n) => s + n.read, 0),
      matching: report.namespaces.reduce((s, n) => s + (n.wouldMatch ?? 0), 0),
      rejected: report.namespaces.reduce((s, n) => s + n.failed, 0),
      // Backup review M10: what a TTL index deletes as soon as it is written.
      expiring: report.namespaces.reduce((s, n) => s + (n.expiring ?? 0), 0),
    }
})

async function start(dryRun: boolean): Promise<void> {
  if (!ready.value) return
  busy.value = true
  errors.value = []
  try {
    const { job } = await backupApi.startRestore(target.value, {
      ...body.value!,
      dryRun,
      planHash: plan.value!.planHash,
    })
    startedJobs.add(job.id)
    if (dryRun) {
      dryRunId.value = job.id
      dryResult.value = null
    }
    jobs.upsert(job)
    if (addRules.value && !dryRun) await afterRulesAdded(queryClient)
    toasts.push({
      kind: 'info',
      message: t(dryRun ? 'backup.restore.dryRunStarted' : 'backup.restore.started'),
    })
    if (!dryRun) emit('close')
  } catch (e) {
    errors.value = backupError(e)
    if (e instanceof ApiError && e.status === 409) refresh()
  } finally {
    busy.value = false
  }
}

onBeforeUnmount(() => {
  alive = false
  clearTimeout(poll)
  stopListening()
  // A download nobody will restore: a running one is cancelled (its job removes the file), a finished one
  // discarded. Final review (B26): a failed one keeps its bytes — fetching the same backup again resumes it.
  if (fetchJobId.value && startedJobs.size === 0) {
    if (fetching.value) void jobsApi.cancel(fetchJobId.value).catch(() => undefined)
    else if (fetchJob.value?.state === 'done' && source.value?.kind === 'upload')
      void backupApi.discardUpload(source.value.uploadId).catch(() => undefined)
    return
  }
  // A half-sent file nobody will restore is removed now rather than at the end of its TTL.
  if (source.value?.kind === 'upload' && upload.state.value !== 'done' && startedJobs.size === 0) {
    const id = source.value.uploadId
    upload.abort()
    void backupApi.discardUpload(id).catch(() => undefined)
  }
})

const section = 'flex flex-col gap-3 rounded-2xl border border-line bg-surface p-5'
const unverifiedBox = 'flex items-start gap-2 rounded-xl bg-warning-soft px-3 py-2 text-sm text-warning'
const confirmBox =
  'flex flex-col gap-2 rounded-xl border border-warning/30 bg-warning-soft p-3 text-sm text-warning'
/** U12: Alt+arrows move between steps; Enter advances, or starts on the summary. */
function onKeydown(e: KeyboardEvent): void {
  if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
    e.preventDefault()
    if (e.key === 'ArrowLeft' || canNext.value) go(e.key === 'ArrowRight' ? 1 : -1)
  } else if (
    e.key === 'Enter' &&
    !(e.target instanceof HTMLButtonElement) &&
    !(e.target instanceof HTMLSelectElement) &&
    !(e.target instanceof HTMLElement && e.target.closest('form'))
  ) {
    e.preventDefault()
    if (step.value === 'summary') void start(false)
    else if (step.value !== 'source' && canNext.value) go(1)
  }
}
</script>

<template>
  <DsSheet
    ref="sheet"
    open
    :title="db ? t('backup.title.restoreInto', { name: db }) : t('backup.title.restore')"
    :subtitle="sourceName || undefined"
    :dirty="Boolean(source)"
    @close="emit('close')"
    @keydown="onKeydown"
  >
    <template #stepper>
      <DsStepper :steps="stepItems" :label="t('backup.steps.label')" @select="(id) => (step = id as Step)" />
    </template>

    <div class="flex flex-col gap-5">
      <DsFormErrors :messages="[...errors, ...(planError && !unreachable ? backupError(planError) : [])]" />
      <DsCallout v-if="unreachable" tone="danger" :title="t('backup.unreachable.title')">
        {{ t('backup.unreachable.restore') }}
        <template #action>
          <DsButton size="sm" :icon="RotateCw" :loading="loading" @click="refresh()">{{
            t('common.retry')
          }}</DsButton>
        </template>
      </DsCallout>

      <template v-if="step === 'source'">
        <div
          v-if="!source && tabs.length > 1"
          role="tablist"
          :aria-label="t('backup.restore.source.label')"
          class="flex gap-1 self-start rounded-xl bg-muted p-1"
          @keydown="moveTab"
        >
          <button
            v-for="tab in tabs"
            :id="`${tabsId}-${tab}`"
            :key="tab"
            ref="tabEls"
            type="button"
            role="tab"
            :data-tab="tab"
            :aria-selected="activeTab === tab"
            :aria-controls="`${tabsId}-panel`"
            :tabindex="activeTab === tab ? 0 : -1"
            :disabled="fetchStarting"
            class="cursor-pointer rounded-lg px-3 py-1.5 text-ui font-medium transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none disabled:cursor-default"
            :class="activeTab === tab ? 'bg-surface text-fg shadow-xs' : 'text-fg-muted hover:text-fg'"
            @click="sourceTab = tab"
          >
            {{ t(`backup.restore.source.${tab}`) }}
          </button>
        </div>
        <div
          v-if="!source"
          :id="`${tabsId}-panel`"
          :role="tabs.length > 1 ? 'tabpanel' : undefined"
          :aria-labelledby="tabs.length > 1 ? `${tabsId}-${activeTab}` : undefined"
          class="flex flex-col gap-3"
        >
          <DropZone v-if="activeTab === 'upload'" @file="onFile" />
          <template v-else-if="activeTab === 'destination' && destinations?.length">
            <p v-if="fetchStarting" role="status" class="flex items-center gap-2 text-ui text-fg-muted">
              <Loader2 class="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />{{
                t('backup.remote.starting')
              }}
            </p>
            <RemoteSourcePicker :destinations="destinations" :busy="fetchStarting" @pick="fetchRemote" />
          </template>
          <div v-else-if="activeTab === 'kept' && kept?.length" :class="section">
            <h3 class="font-medium text-fg">{{ t('backup.restore.kept') }}</h3>
            <ul class="flex flex-col gap-1">
              <li v-for="k in kept" :key="k.id">
                <button
                  type="button"
                  class="flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left text-ui transition-colors duration-150 hover:bg-subtle focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
                  @click="chooseKept(k.id, k.name)"
                >
                  <FileArchive class="size-4 text-fg-subtle" aria-hidden="true" />
                  <span class="flex-1 truncate font-mono">{{ k.name }}</span>
                  <span class="text-fg-subtle tabular-nums">{{ b(k.size) }}</span>
                </button>
              </li>
            </ul>
          </div>
        </div>
        <div v-else :class="section" aria-live="polite">
          <div class="flex items-center gap-3">
            <span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft">
              <FileArchive class="size-5 text-accent-fg" aria-hidden="true" />
            </span>
            <div class="min-w-0 flex-1">
              <p class="truncate font-medium text-fg">{{ sourceName }}</p>
              <p
                v-if="upload.state.value === 'uploading' || upload.state.value === 'resuming'"
                class="text-ui text-fg-subtle tabular-nums"
              >
                {{ uploadLine }}
              </p>
              <p v-else-if="fetching" class="text-ui text-fg-subtle tabular-nums">
                {{ t('backup.remote.waiting', { pct: fetchPct }) }}
              </p>
              <p v-else-if="inspected?.state === 'waiting'" class="text-ui text-fg-subtle">
                {{ t('backup.restore.waitingMore') }}
              </p>
              <p v-else-if="!inspected" class="text-ui text-fg-subtle">
                {{ t('backup.restore.reading') }}
              </p>
            </div>
            <Loader2
              v-if="
                inspected?.state !== 'ready' && inspected?.state !== 'password' && inspected?.state !== 'key'
              "
              class="size-5 animate-spin text-fg-subtle motion-reduce:animate-none"
              aria-hidden="true"
            />
          </div>
          <DsProgress
            v-if="upload.total.value && upload.state.value !== 'done'"
            :label="sourceName"
            :value="percent / 100"
          />
          <form
            v-if="inspected?.state === 'password'"
            class="flex flex-wrap items-start gap-2"
            @submit.prevent="unlock"
          >
            <!-- The button lines up with the field, not with the error under it (label 16px + gap 6px). -->
            <DsInput
              v-model="passwordTry"
              class="min-w-64 flex-1"
              :label="t('backup.password.open')"
              :icon="Lock"
              mono
              data-test="open-password"
              type="password"
              autocomplete="off"
              spellcheck="false"
              :error="passwordError ?? undefined"
            />
            <DsButton type="submit" variant="primary" class="mt-5.5">{{
              t('backup.password.unlock')
            }}</DsButton>
          </form>
          <KitUnlock
            v-if="inspected?.state === 'key'"
            :fingerprint="inspected.fingerprint"
            :password="inspected.password"
            :error="kitError"
            @unlock="unlockWith"
          />
          <p v-if="unverified" role="note" :class="unverifiedBox">
            <ShieldAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />{{
              t('backup.remote.unverified')
            }}
          </p>
          <p v-if="openedText" role="note" class="flex basis-full items-center gap-2 text-ui text-success">
            <ShieldCheck class="size-4 shrink-0" aria-hidden="true" />{{ openedText }}
          </p>
        </div>
      </template>

      <template v-else-if="step === 'preview' && summary">
        <div :class="section">
          <div class="flex flex-wrap items-center gap-2">
            <p v-if="openedText" role="note" class="flex basis-full items-center gap-2 text-ui text-success">
              <ShieldCheck class="size-4 shrink-0" aria-hidden="true" />{{ openedText }}
            </p>
            <span class="rounded-full bg-accent-soft px-2.5 py-0.5 text-small font-medium text-accent-fg">{{
              t(`backup.restore.container.${summary.container}`)
            }}</span>
            <span
              v-if="summary.mongoManager?.masked"
              class="rounded-full bg-warning-soft px-2.5 py-0.5 text-small text-warning"
              >{{ t('backup.restore.masked') }}</span
            >
            <span
              v-else-if="summary.mongoManager?.anonymous"
              class="rounded-full bg-muted px-2.5 py-0.5 text-small"
              >{{ t('backup.restore.anonymous') }}</span
            >
          </div>
          <p class="text-ui text-fg-subtle">
            {{
              t('backup.restore.from', {
                tool: summary.toolVersion ?? '?',
                server: summary.serverVersion ?? '?',
              })
            }}
          </p>
        </div>
        <p v-if="unverified" role="note" :class="unverifiedBox">
          <ShieldAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />{{ t('backup.remote.unverified') }}
        </p>
        <MappingTable v-model="rows" :plan="plan" :taken="takenDbs" />
      </template>

      <template v-else-if="step === 'target'">
        <DsSelect
          v-model="target"
          class="max-w-sm"
          :label="t('backup.restore.targetConnection')"
          :options="targetOptions"
        />
        <MappingTable v-model="rows" :plan="plan" :taken="takenDbs" />
        <p v-if="!uploadComplete" class="text-ui text-fg-subtle">
          {{ t('backup.restore.waitingPlan') }}
        </p>
      </template>

      <template v-else-if="step === 'mode'">
        <fieldset class="grid gap-3 lg:grid-cols-3">
          <legend class="sr-only">{{ t('backup.restore.mode.label') }}</legend>
          <DsChoiceCard
            v-for="m in MODES"
            :key="m"
            v-model="mode"
            name="restore-mode"
            :value="m"
            :title="t(`backup.restore.mode.${m}`)"
            :help="t(`backup.restore.mode.${m}Help`)"
          />
        </fieldset>
        <DsInput
          v-if="mode === 'upsert'"
          v-model="keys"
          class="max-w-sm"
          :label="t('backup.restore.keys')"
          :error="badKey"
          mono
        />
        <div :class="section">
          <DsCheckbox v-model="indexes" :label="t('backup.content.indexes')" />
          <DsCheckbox v-model="options" :label="t('backup.content.options')" />
          <fieldset class="flex flex-wrap gap-4 text-ui">
            <legend class="mb-1 font-medium">{{ t('backup.restore.onError.label') }}</legend>
            <label class="flex items-center gap-2"
              ><input v-model="onError" type="radio" value="continue" class="accent-accent" />{{
                t('backup.restore.onError.continue')
              }}</label
            >
            <label class="flex items-center gap-2"
              ><input v-model="onError" type="radio" value="stop" class="accent-accent" />{{
                t('backup.restore.onError.stop')
              }}</label
            >
          </fieldset>
        </div>
        <div v-if="plan" class="flex flex-col gap-3">
          <div v-if="ttlNames" :class="confirmBox">
            <span>{{ t('backup.check.ttl.warn', { names: ttlNames }) }}</span>
            <DsCheckbox
              v-model="confirmTtl"
              data-test="confirm-ttl"
              :label="t('backup.restore.confirmTtl')"
            />
          </div>
          <div v-if="plan.missingRules.length" :class="confirmBox">
            <ul class="font-mono text-small">
              <li v-for="r in plan.missingRules" :key="r">{{ r }}</li>
            </ul>
            <DsCheckbox v-model="confirmPersonal" :label="t('backup.restore.confirmPersonal')" />
            <DsCheckbox v-if="plan.mayAddRules" v-model="addRules" :label="t('backup.restore.addRules')" />
          </div>
          <div v-if="plan.refusals.includes('confirm_masked') || confirmMasked" :class="confirmBox">
            <DsCheckbox v-model="confirmMasked" :label="t('backup.restore.confirmMasked')" />
          </div>
          <div
            v-for="name in needNames"
            :key="name"
            class="rounded-xl border border-danger/25 bg-danger-soft p-3"
          >
            <DsInput
              :model-value="typed[name] ?? ''"
              :label="t('backup.restore.typeName', { name })"
              mono
              :data-test="`confirm-name-${name}`"
              autocomplete="off"
              spellcheck="false"
              @update:model-value="typed[name] = $event"
            />
          </div>
        </div>
      </template>

      <template v-else-if="step === 'summary'">
        <dl :class="section" class="grid gap-x-6 gap-y-2 text-ui sm:grid-cols-[auto_1fr]">
          <template v-for="c in choices" :key="c.key">
            <dt class="text-fg-subtle">{{ t(`backup.summary.${c.key}`) }}</dt>
            <dd class="min-w-0 truncate font-medium text-fg">{{ c.value }}</dd>
          </template>
        </dl>
        <ul v-if="plan" :class="section" class="divide-y divide-line">
          <li
            v-for="n in plan.namespaces"
            :key="`${n.to.db}.${n.to.coll}`"
            class="flex flex-wrap items-center gap-2 py-2 text-ui"
          >
            <span class="font-mono">{{ n.from.db }}.{{ n.from.coll }}</span>
            <span class="text-fg-subtle" aria-hidden="true">→</span>
            <span class="font-mono font-medium">{{ n.to.db }}.{{ n.to.coll }}</span>
            <span class="ml-auto text-fg-muted">{{ impact(n) }}</span>
          </li>
        </ul>
        <Transition
          enter-active-class="transition duration-200 motion-reduce:transition-none"
          enter-from-class="translate-y-1 opacity-0"
        >
          <div
            v-if="dryResult"
            class="flex flex-wrap items-center gap-3 rounded-2xl border border-success/25 bg-success-soft p-4 text-ui text-success"
            role="status"
          >
            <ShieldCheck class="size-5 text-success" aria-hidden="true" />
            <span class="flex-1">{{
              t('backup.restore.dryRunResult', {
                read: formatCount(dryResult.read, locale),
                matching: formatCount(dryResult.matching, locale),
                rejected: formatCount(dryResult.rejected, locale),
              })
            }}</span>
            <DsButton variant="primary" size="sm" :disabled="!ready" @click="start(false)"
              ><RotateCcw class="size-4" aria-hidden="true" />{{ t('backup.restore.promote') }}</DsButton
            >
            <span
              v-if="dryResult.expiring"
              class="basis-full text-small font-medium"
              data-test="dry-expiring"
              >{{
                t(
                  'backup.restore.dryRunExpiring',
                  { count: formatCount(dryResult.expiring, locale) },
                  dryResult.expiring,
                )
              }}</span
            >
            <span class="basis-full text-small opacity-80">{{ t('backup.restore.dryRunNote') }}</span>
          </div>
        </Transition>
      </template>
    </div>

    <template #summary>
      <div class="flex flex-col gap-4">
        <div
          v-if="fetching"
          role="status"
          class="flex flex-col gap-2 rounded-xl bg-surface p-3 text-ui shadow-xs"
        >
          <p class="text-fg tabular-nums">
            {{ t('backup.remote.waiting', { pct: fetchPct }) }}
          </p>
          <DsProgress :label="t('backup.remote.waiting', { pct: fetchPct })" :value="fetchPct / 100" />
        </div>
        <PreflightList :checks="plan?.checks ?? []" :loading="loading" />
        <ul v-if="plan?.refusals.length" class="flex flex-col gap-1 text-ui text-danger">
          <li v-for="r in plan.refusals" :key="r">{{ t(`backup.refusal.${r}`) }}</li>
        </ul>
      </div>
    </template>

    <template #footer>
      <DsButton v-if="step !== 'source'" variant="ghost" class="mr-auto" @click="go(-1)">{{
        t('dataTransfer.back')
      }}</DsButton>
      <DsButton variant="ghost" @click="sheet?.requestClose()">{{ t('dataTransfer.cancel') }}</DsButton>
      <DsButton v-if="step !== 'summary'" variant="primary" :disabled="!canNext" @click="go(1)">{{
        t('dataTransfer.next')
      }}</DsButton>
      <template v-else>
        <DsButton :disabled="!ready" @click="start(true)">{{ t('backup.restore.dryRun') }}</DsButton>
        <DsButton variant="primary" :disabled="!ready" :loading="busy" @click="start(false)">{{
          fetching ? t('backup.remote.waiting', { pct: fetchPct }) : t('backup.restore.start')
        }}</DsButton>
      </template>
    </template>
  </DsSheet>
</template>
