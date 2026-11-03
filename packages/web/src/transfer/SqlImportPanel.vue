<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  CircleStop,
  FileCode,
  Info,
  Search,
  XCircle,
} from 'lucide-vue-next'
import {
  SqlImportTableSchema,
  type SqlImportReport as Report,
  type SqlImportRequest,
  type SqlPreviewResponse,
  type SqlPreviewTable,
} from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsSwitch from '@/ds/DsSwitch.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import DsBadge from '@/ds/DsBadge.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import DsSpinner from '@/ds/DsSpinner.vue'
import DsProgress from '@/ds/DsProgress.vue'
import { describeError } from '@/api/errors'
import { connectionsApi, queryKeys } from '@/api/connections'
import { transferApi } from '@/api/transfer'
import { jobsApi } from '@/api/jobs'
import { useShownJob } from './shownJobs'
import { useJobsStore } from '@/jobs/store'
import { formatCount } from '@/format'
import SqlImportReport from './SqlImportReport.vue'
import TransferSteps from './TransferSteps.vue'
import { sampleText, skippedList, stripped, visible } from './sqlText'
import { useUpload } from './useUpload'

/**
 * SQL transfer spec §3, §5: a SQL dump's tables into collections of a database — upload, the tables
 * it holds (choose, rename the collection), options, a dry run, then one job. The dump is read on the
 * server, never run; the server checks everything again, this only guides. User request 2026-10-11:
 * a part of the SQL ↔ MongoDB page. User request 2026-10-12: one step at a time, never one long page —
 * the file, its tables, the options — and the job (a dry run, or the import) followed on a page of its
 * own, apart from the forms.
 */
/**
 * `db`: where it imports — null while a new database's name is not one yet (the panel stays, its
 * upload kept). `inSight`: in sight, how its jobs end said here (no toast besides). `work` says whether
 * leaving would lose something: an upload being prepared, or an import running.
 */
const props = defineProps<{ connectionId: string; db: string | null; inSight?: boolean }>()
const emit = defineEmits<{ work: [busy: boolean] }>()
const { t, te, locale } = useI18n()
const jobs = useJobsStore()
const id = useId()
const n = (v: number) => formatCount(v, locale.value)

interface Row {
  key: number
  table: SqlPreviewTable
  include: boolean
  collection: string
  open: boolean
}

const { progress, uploading, upload, abort } = useUpload()
const uploadId = ref<string | null>(null)
const fileName = ref('')
const reading = ref(false)
const handedOver = ref(false)
const preview = ref<SqlPreviewResponse | null>(null)
const rows = ref<Row[]>([])
const filter = ref('')
const primaryKeyAsId = ref(true)
const mode = ref<SqlImportRequest['mode']>('insert')
const onError = ref<SqlImportRequest['onError']>('continue')
const busy = ref(false)
const errors = ref<string[]>([])
const dryRunJob = ref<string | null>(null)
const report = ref<Report | null>(null)
/** The import itself, once started: its progress, then its report, here. */
const importJob = ref<string | null>(null)
const importReport = ref<Report | null>(null)
const fail = (e: unknown) => (errors.value = [describeError(e, t)])

type Step = 'file' | 'tables' | 'options' | 'run'
const STEPS: Step[] = ['file', 'tables', 'options', 'run']
const step = ref<Step>('file')
const steps = computed(() => STEPS.map((s) => ({ id: s, label: t(`sqlTransfer.steps.import.${s}`) })))
/**
 * Where a step's focus goes: its heading (or the file's input), said and in sight — only for a step
 * asked for here, never for one the page changed (another database; review 2026-10-12, I4).
 */
const heading = ref<HTMLElement | null>(null)
function go(to: Step): void {
  step.value = to
  void nextTick(() => heading.value?.focus())
}

const collections = useQuery({
  queryKey: computed(() => queryKeys.collections(props.connectionId, props.db ?? '')),
  queryFn: () => connectionsApi.collections(props.connectionId, props.db!),
  enabled: computed(() => preview.value !== null && props.db !== null),
})
const existing = computed(() => new Set((collections.data.value ?? []).map((c) => c.name)))
// User report 2026-10-30: the database's collections offered in each table's field (a new one is typed).
const existingNames = computed(() =>
  (collections.data.value ?? [])
    .filter((c) => c.type !== 'view' && !c.name.startsWith('system.'))
    .map((c) => c.name),
)

function discard(): void {
  // Review M18: a dry run still reading the upload keeps it (it expires on its own).
  if (uploadId.value && !handedOver.value && dryRunState.value !== 'running')
    void transferApi.discard(props.connectionId, uploadId.value).catch(() => undefined)
  uploadId.value = null
}

/** Another file, asked for here: its step, the focus on its input. */
function again(): void {
  reset()
  go('file')
}

function reset(): void {
  discard()
  // A dry run still running is let go with its file (review 2026-10-12, M4).
  if (dryRunJob.value && dryRunState.value === 'running')
    void jobsApi.cancel(dryRunJob.value).catch(() => undefined)
  preview.value = null
  rows.value = []
  report.value = null
  dryRunJob.value = null
  importJob.value = null
  importReport.value = null
  handedOver.value = false
  filter.value = ''
  step.value = 'file'
}

async function send(file: Blob, name: string): Promise<void> {
  errors.value = []
  reset()
  fileName.value = name
  try {
    uploadId.value = (await upload(props.connectionId, file, name)).uploadId
    reading.value = true
    const p = await transferApi.sqlPreview(props.connectionId, uploadId.value)
    preview.value = p
    const names = collectionNames(p.tables)
    rows.value = p.tables.map((table, key) => ({
      key,
      table,
      // Review M10: a table every row of which would fail is not chosen to begin with.
      include: !table.error,
      collection: names[key]!,
      open: false,
    }))
    go('tables')
  } catch (e) {
    fail(e)
    discard()
  } finally {
    reading.value = false
  }
}

/**
 * Each table's proposed collection: its name; "schema_name" for tables of one name in two schemas;
 * never one already proposed for another table (review M18: "_2", "_3"…).
 */
function collectionNames(tables: SqlPreviewTable[]): string[] {
  const named = new Map<string, number>()
  for (const t of tables) named.set(t.name, (named.get(t.name) ?? 0) + 1)
  const wants = tables.map((t) =>
    stripped(named.get(t.name)! > 1 && t.schema ? `${t.schema}_${t.name}` : t.name),
  )
  // A table keeps its own name first; a "schema_name" yields to a table really called so.
  const own = new Set(wants.filter((w, i) => w === stripped(tables[i]!.name)))
  const used = new Set<string>()
  return wants.map((want, i) => {
    let name = want
    const mine = want === stripped(tables[i]!.name)
    if (used.has(name) || (!mine && own.has(name))) {
      let k = 2
      while (used.has(`${want}_${k}`) || own.has(`${want}_${k}`)) k++
      name = `${want}_${k}`
    }
    used.add(name)
    return name
  })
}

function onFile(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) void send(file, file.name)
  // The same file can be chosen again after "Choose another file".
  input.value = ''
}
function onDrop(event: DragEvent): void {
  const file = event.dataTransfer?.files?.[0]
  if (file) void send(file, file.name)
}

/** Where a table's rows go, in words: why its collection name cannot be used, if it cannot. */
function nameProblem(row: Row): string | null {
  if (!row.include) return null
  const name = row.collection.trim()
  if (!name) return t('dataTransfer.sql.errors.required')
  if (SqlImportTableSchema.shape.collection.safeParse(name).success) return null
  if (name.includes('$') || name.includes('\0')) return t('dataTransfer.sql.errors.chars')
  if (name.startsWith('system.')) return t('dataTransfer.sql.errors.system')
  return t('dataTransfer.sql.errors.tooLong')
}
const chosen = computed(() => rows.value.filter((r) => r.include))
const valid = computed(() => chosen.value.length > 0 && chosen.value.every((r) => !nameProblem(r)))
const chosenRows = computed(() => chosen.value.reduce((s, r) => s + r.table.rows, 0))
/**
 * The steps one may go to: the tables and, once they can be imported, the options and a dry run's
 * page. None once the import runs: what it was given cannot change (a new file starts again).
 */
const reachable = computed<Step[]>(() => {
  // None while it is being started either (review 2026-10-12, M3).
  if (busy.value || importJob.value || !preview.value) return []
  const to: Step[] = ['tables']
  if (valid.value) to.push('options')
  if (dryRunJob.value) to.push('run')
  return to
})
/** Collections more than one chosen table goes into: allowed, said once. */
const shared = computed(() => {
  const count = new Map<string, number>()
  for (const r of chosen.value) {
    const name = r.collection.trim()
    if (name) count.set(name, (count.get(name) ?? 0) + 1)
  }
  return [...count].filter(([, c]) => c > 1).map(([name]) => name)
})

const shown = computed(() => {
  const q = filter.value.trim().toLowerCase()
  return q
    ? rows.value.filter(
        (r) => r.table.name.toLowerCase().includes(q) || r.collection.toLowerCase().includes(q),
      )
    : rows.value
})
const allOn = computed(() => shown.value.length > 0 && shown.value.every((r) => r.include))
const someOn = computed(() => !allOn.value && shown.value.some((r) => r.include))
function setAll(on: boolean): void {
  for (const r of shown.value) r.include = on
}

const dialectName = computed(() => {
  const d = preview.value?.dialect ?? ''
  return te(`dataTransfer.sql.dialects.${d}`) ? t(`dataTransfer.sql.dialects.${d}`) : d
})
const skipped = computed(() => (preview.value ? skippedList(preview.value.skipped, locale.value) : ''))

function keyLine(table: SqlPreviewTable): string {
  const pk = table.primaryKey
  if (!pk.length) return t('dataTransfer.sql.noPrimaryKey')
  if (pk.length === 1 && primaryKeyAsId.value) return t('dataTransfer.sql.pkAsId', { column: pk[0] })
  return t('dataTransfer.sql.primaryKey', { columns: pk.join(', ') })
}
const sampleColumns = (table: SqlPreviewTable) => [...new Set(table.samples.flatMap((s) => Object.keys(s)))]
/** Review M12: upsert and merge match on _id; a chosen table whose rows have none would fail them. */
const noKey = (r: Row) =>
  mode.value !== 'insert' &&
  primaryKeyAsId.value &&
  r.include &&
  r.table.primaryKey.length !== 1 &&
  !r.table.columns.some((c) => c.name === '_id')
/** The chosen tables upsert or merge would fail every row of, named with the options. */
const keyless = computed(() => rows.value.filter(noKey))
/**
 * Data review 2026-10-13 (M7): in upsert and merge, tables sharing a collection would replace each
 * other's rows of the same key — such a run is not started (the server refuses it too).
 */
const sharedKeyed = computed(() => (mode.value === 'insert' ? [] : shared.value))
const startable = computed(() => valid.value && !!props.db && !sharedKeyed.value.length)

const MODES = ['insert', 'upsert', 'merge'] as const
const modes = computed(() => MODES.map((m) => ({ value: m, label: t(`dataTransfer.modes.${m}`) })))
const onErrors = computed(() => [
  { value: 'continue' as const, label: t('dataTransfer.onErrorContinue') },
  { value: 'stop' as const, label: t('dataTransfer.onErrorStop') },
])

function body(dryRun: boolean): SqlImportRequest {
  return {
    uploadId: uploadId.value!,
    // Only the chosen tables: the server reads no other table's rows.
    tables: chosen.value.map((r) => ({
      table: r.table.key,
      collection: r.collection.trim(),
      include: true,
    })),
    primaryKeyAsId: primaryKeyAsId.value,
    mode: mode.value,
    onError: onError.value,
    dryRun,
  }
}

async function start(dryRun: boolean): Promise<void> {
  if (!startable.value || !uploadId.value || !props.db) return
  errors.value = []
  report.value = null
  busy.value = true
  try {
    const { job } = await transferApi.importSql(props.connectionId, props.db, body(dryRun))
    jobs.upsert(job)
    if (dryRun) dryRunJob.value = job.id
    else {
      handedOver.value = true
      importJob.value = job.id
    }
    go('run')
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

const dryRunState = computed(() => (dryRunJob.value ? jobs.byId[dryRunJob.value]?.state : undefined))
watch(dryRunState, async (state) => {
  if (!state || state === 'running' || !dryRunJob.value) return
  try {
    const r = await transferApi.report(dryRunJob.value)
    if (r.kind === 'importSql') report.value = r
  } catch (e) {
    fail(e)
  }
})

const importState = computed(() => (importJob.value ? jobs.byId[importJob.value] : undefined))
/** Running, done, or ended otherwise (failed, cancelled, interrupted) — never a spinner left on. */
const importPhase = computed<'running' | 'done' | 'ended' | null>(() => {
  if (!importJob.value) return null
  const state = importState.value?.state
  if (!state || state === 'running') return 'running'
  return state === 'done' ? 'done' : 'ended'
})
watch(importPhase, async (phase) => {
  if (!phase || phase === 'running' || !importJob.value) return
  try {
    // A failed or cancelled import has a report too: what it wrote before it ended.
    const r = await transferApi.report(importJob.value)
    if (r.kind === 'importSql') importReport.value = r
  } catch (e) {
    if (phase === 'done') fail(e)
  }
})
/** Why it ended before its end, in the user's words. */
const endedText = computed(() => {
  const state = importState.value?.state
  if (state === 'cancelled') return t('sqlTransfer.import.cancelled')
  if (state === 'interrupted') return t('sqlTransfer.import.interrupted')
  return importState.value?.error ?? t('sqlTransfer.import.failed')
})
const stopping = ref(false)
async function stop(): Promise<void> {
  if (!importJob.value) return
  stopping.value = true
  try {
    jobs.upsert((await jobsApi.cancel(importJob.value)).job)
  } catch (e) {
    fail(e)
  } finally {
    stopping.value = false
  }
}
// What leaving would lose: an upload read and not yet handed to an import, or the import running
// (its progress and report here; review 2026-10-11).
watch(
  () =>
    ((preview.value !== null || uploading.value || reading.value) && !importJob.value) ||
    importPhase.value === 'running',
  (busy) => emit('work', busy),
  { immediate: true },
)
const seen = computed(() => !!props.inSight)
useShownJob(dryRunJob, seen)
useShownJob(importJob, seen)
/** A dry run let go: stopped if it still runs, its page gone (the focus left where it is). */
function letGoDryRun(): void {
  if (!dryRunJob.value) return
  if (dryRunState.value === 'running') void jobsApi.cancel(dryRunJob.value).catch(() => undefined)
  dryRunJob.value = null
  report.value = null
  if (step.value === 'run' && !importJob.value) step.value = 'options'
}
// A dry run tells about the database it ran on: another chosen, it is let go (review 2026-10-11).
watch(() => props.db, letGoDryRun)
// And about the choices it ran with: another table, collection or option, it is let go too (review
// 2026-10-12, M5) — never an import started from a report about other choices.
watch(
  () =>
    JSON.stringify([
      chosen.value.map((r) => [r.table.key, r.collection.trim()]),
      primaryKeyAsId.value,
      mode.value,
      onError.value,
    ]),
  letGoDryRun,
)
/** The share of rows the running import has written, when it knows how many there are. */
const importPercent = computed(() => {
  const p = importState.value?.progress
  return p && p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : null
})

// Leaving the page: an upload not handed to a job goes (a running dry run keeps it).
onBeforeUnmount(() => {
  abort()
  discard()
})

const field =
  'h-8 w-full min-w-0 rounded-md border bg-surface px-2 font-mono text-small text-fg shadow-xs transition-[border-color,box-shadow] duration-120 placeholder:text-fg-subtle focus:ring-3 focus:outline-none disabled:cursor-not-allowed disabled:bg-subtle disabled:opacity-60'
</script>

<template>
  <section class="flex flex-col gap-5 text-ui" data-sql-import>
    <datalist :id="`${id}-collections`">
      <option v-for="name in existingNames" :key="name" :value="name" />
    </datalist>
    <TransferSteps
      :label="t('sqlTransfer.steps.label')"
      :steps="steps"
      :current="step"
      :reachable="reachable"
      @go="go"
    />
    <DsFormErrors :messages="errors" />

    <!-- The file: chosen, or the one read (the steps after it work on it). -->
    <div v-if="step === 'file'" class="flex flex-col gap-4" data-sql-step="file">
      <label
        class="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-line-strong p-8 text-center transition-colors duration-120 hover:border-accent hover:bg-subtle has-[input:focus-visible]:border-focus has-[input:focus-visible]:ring-3 has-[input:focus-visible]:ring-focus/20"
        @dragover.prevent
        @drop.prevent="onDrop"
      >
        <span class="grid size-10 place-items-center rounded-xl bg-accent-soft">
          <FileCode class="size-5 text-accent-fg" aria-hidden="true" />
        </span>
        <span class="font-medium text-fg">{{ t('dataTransfer.sql.chooseFile') }}</span>
        <span class="max-w-md text-small text-fg-subtle">{{ t('dataTransfer.sql.fileHint') }}</span>
        <input
          ref="heading"
          type="file"
          class="sr-only"
          accept=".sql,.gz,application/sql"
          :disabled="uploading || reading"
          @change="onFile"
        />
      </label>
      <DsProgress v-if="uploading" :label="t('dataTransfer.sql.uploading')" :value="progress / 100" />
      <p v-if="reading" role="status" class="flex items-center gap-2 text-fg-muted">
        <DsSpinner />{{ t('dataTransfer.sql.reading') }}
      </p>
    </div>

    <template v-else-if="preview">
      <div class="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-canvas px-3 py-2">
        <FileCode class="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
        <p class="min-w-0 flex-1 truncate text-fg">
          {{ t('dataTransfer.sql.fileLine', { name: fileName, dialect: dialectName }) }}
        </p>
        <DsBadge v-if="preview.gzip">{{ t('dataTransfer.sql.gzip') }}</DsBadge>
        <DsButton v-if="!importJob" size="sm" variant="ghost" :disabled="busy" @click="again">{{
          t('dataTransfer.sql.otherFile')
        }}</DsButton>
      </div>

      <!-- The tables: which ones, and the collection each goes into. -->
      <div v-if="step === 'tables'" class="flex flex-col gap-4" data-sql-step="tables">
        <DsCallout v-if="preview.truncated" tone="warning">{{ t('dataTransfer.sql.truncated') }}</DsCallout>
        <DsCallout v-if="preview.error" tone="warning">
          {{ t('dataTransfer.sql.report.dumpError', { reason: preview.error }) }}
        </DsCallout>
        <p v-if="skipped" class="flex items-start gap-2 text-small text-fg-muted" data-sql-skipped>
          <Info class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{{ t('dataTransfer.sql.skipped', { list: skipped }) }}</span>
        </p>
        <section v-if="rows.length" class="flex flex-col gap-2" :aria-labelledby="`${id}-tables`">
          <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
            <h3 :id="`${id}-tables`" ref="heading" tabindex="-1" class="font-semibold text-fg outline-none">
              {{ t('dataTransfer.sql.tables') }}
            </h3>
            <label class="flex cursor-pointer items-center gap-2 text-fg">
              <input
                type="checkbox"
                class="size-4 cursor-pointer accent-accent"
                :checked="allOn"
                :indeterminate="someOn"
                @change="setAll(($event.target as HTMLInputElement).checked)"
              />{{ t('dataTransfer.sql.allTables') }}
            </label>
            <div v-if="rows.length > 8" class="relative ml-auto w-full max-w-56">
              <Search
                class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg-subtle"
                aria-hidden="true"
              />
              <input
                v-model="filter"
                type="search"
                :aria-label="t('dataTransfer.sql.filter')"
                :placeholder="t('dataTransfer.sql.filter')"
                :class="[field, 'border-line-strong pl-7 font-sans focus:border-focus focus:ring-focus/20']"
              />
            </div>
          </div>

          <ul class="flex max-h-[42vh] flex-col gap-1.5 overflow-auto pr-0.5">
            <li
              v-for="r in shown"
              :key="r.key"
              class="rounded-lg border bg-surface transition-colors duration-120"
              :class="r.include ? 'border-line' : 'border-line opacity-60'"
            >
              <div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
                <input
                  v-model="r.include"
                  type="checkbox"
                  class="size-4 shrink-0 cursor-pointer accent-accent"
                  :aria-label="t('dataTransfer.sql.include', { table: visible(r.table.key) })"
                />
                <div class="min-w-0 flex-1 basis-40">
                  <p class="truncate font-mono font-medium text-fg" :title="visible(r.table.key)">
                    <span v-if="r.table.schema" class="text-fg-subtle">{{ visible(r.table.schema) }}.</span
                    >{{ visible(r.table.name) }}
                  </p>
                  <p class="flex flex-wrap gap-x-2 text-small text-fg-subtle tabular-nums">
                    <span>{{
                      t('dataTransfer.sql.columns', { n: n(r.table.columnCount) }, r.table.columnCount)
                    }}</span>
                    <span aria-hidden="true">·</span>
                    <span>{{ t('dataTransfer.sql.rows', { n: n(r.table.rows) }, r.table.rows) }}</span>
                    <span aria-hidden="true">·</span>
                    <span>{{ keyLine(r.table) }}</span>
                  </p>
                </div>
                <ArrowRight class="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
                <div class="flex min-w-0 flex-1 basis-52 flex-col gap-1">
                  <div class="flex items-center gap-2">
                    <input
                      v-model="r.collection"
                      type="text"
                      :list="`${id}-collections`"
                      :disabled="!r.include"
                      maxlength="255"
                      spellcheck="false"
                      autocomplete="off"
                      :aria-label="t('dataTransfer.sql.collectionFor', { table: visible(r.table.key) })"
                      :aria-invalid="nameProblem(r) ? 'true' : undefined"
                      :aria-describedby="nameProblem(r) ? `${id}-err-${r.key}` : undefined"
                      :class="[
                        field,
                        nameProblem(r)
                          ? 'border-danger focus:border-danger focus:ring-danger/20'
                          : 'border-line-strong focus:border-focus focus:ring-focus/20',
                      ]"
                    />
                    <DsBadge
                      v-if="r.include && !nameProblem(r) && collections.data.value"
                      :tone="existing.has(r.collection.trim()) ? 'neutral' : 'accent'"
                      :data-collection-state="r.table.name"
                    >
                      {{
                        existing.has(r.collection.trim())
                          ? t('dataTransfer.sql.exists')
                          : t('dataTransfer.sql.new')
                      }}
                    </DsBadge>
                  </div>
                  <p v-if="nameProblem(r)" :id="`${id}-err-${r.key}`" class="text-small text-danger">
                    {{ nameProblem(r) }}
                  </p>
                  <p v-if="r.table.error" class="text-small text-danger">{{ r.table.error }}</p>
                  <p v-if="noKey(r)" class="text-small text-warning">
                    {{ t('dataTransfer.sql.noKey', { table: visible(r.table.key) }) }}
                  </p>
                </div>
                <button
                  type="button"
                  class="grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-120 hover:bg-subtle hover:text-fg"
                  :aria-label="t('dataTransfer.sql.details', { table: visible(r.table.key) })"
                  :aria-expanded="r.open"
                  :aria-controls="`${id}-details-${r.key}`"
                  @click="r.open = !r.open"
                >
                  <ChevronDown
                    class="size-4 transition-transform duration-160 motion-reduce:transition-none"
                    :class="r.open ? 'rotate-180' : ''"
                    aria-hidden="true"
                  />
                </button>
              </div>
              <div
                v-if="r.open"
                :id="`${id}-details-${r.key}`"
                class="flex flex-col gap-3 border-t border-line bg-canvas px-3 py-3"
              >
                <div class="overflow-x-auto rounded-md border border-line bg-surface">
                  <table class="w-full text-small">
                    <thead class="bg-subtle text-fg-muted">
                      <tr>
                        <th scope="col" class="px-2 py-1 text-left font-medium">
                          {{ t('dataTransfer.sql.column') }}
                        </th>
                        <th scope="col" class="px-2 py-1 text-left font-medium">
                          {{ t('dataTransfer.sql.sqlType') }}
                        </th>
                        <th scope="col" class="px-2 py-1 text-left font-medium">
                          {{ t('dataTransfer.sql.kind') }}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="c in r.table.columns" :key="c.name" class="border-t border-line">
                        <td class="px-2 py-1 font-mono text-fg">
                          {{ visible(c.name) }}
                          <DsBadge
                            v-if="r.table.primaryKey.includes(c.name)"
                            tone="info"
                            class="ml-1"
                            :title="t('dataTransfer.sql.pkTitle')"
                            >{{ t('dataTransfer.sql.pk') }}</DsBadge
                          >
                        </td>
                        <td class="px-2 py-1 font-mono text-fg-muted">{{ visible(c.type) }}</td>
                        <td class="px-2 py-1 font-mono text-fg-muted">{{ c.kind }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p v-if="r.table.columnCount > r.table.columns.length" class="text-small text-fg-subtle">
                  {{
                    t(
                      'dataTransfer.sql.moreColumns',
                      { n: n(r.table.columnCount - r.table.columns.length) },
                      r.table.columnCount - r.table.columns.length,
                    )
                  }}
                </p>
                <div class="flex flex-col gap-1">
                  <p class="text-small font-medium text-fg-muted">{{ t('dataTransfer.sql.samples') }}</p>
                  <p v-if="!r.table.samples.length" class="text-small text-fg-subtle">
                    {{ t('dataTransfer.sql.noSamples') }}
                  </p>
                  <div v-else class="overflow-x-auto rounded-md border border-line bg-surface">
                    <table class="w-full text-small">
                      <thead class="bg-subtle text-fg-muted">
                        <tr>
                          <th
                            v-for="k in sampleColumns(r.table)"
                            :key="k"
                            scope="col"
                            class="px-2 py-1 text-left font-mono font-medium"
                          >
                            {{ visible(k) }}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="(s, i) in r.table.samples" :key="i" class="border-t border-line">
                          <td
                            v-for="k in sampleColumns(r.table)"
                            :key="k"
                            class="max-w-56 truncate px-2 py-1 font-mono text-fg"
                          >
                            {{ visible(sampleText(s[k])) }}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </li>
          </ul>
          <p v-if="!shown.length" class="text-small text-fg-subtle">{{ t('dataTransfer.sql.noMatch') }}</p>
          <p v-if="!chosen.length" class="text-small text-danger">
            {{ t('dataTransfer.sql.errors.noneChosen') }}
          </p>
          <p v-for="c in shared" :key="c" class="text-small text-fg-subtle">
            {{ t('dataTransfer.sql.shared', { coll: c }) }}
          </p>
        </section>
        <!-- No table: the note takes the focus the step's heading would (review 2026-10-12, M8). -->
        <div v-else ref="heading" tabindex="-1" class="outline-none">
          <DsCallout tone="info">{{ t('dataTransfer.sql.noTables') }}</DsCallout>
        </div>
      </div>

      <!-- The options: how the rows are written. -->
      <div v-else-if="step === 'options'" class="flex flex-col gap-4" data-sql-step="options">
        <h3 ref="heading" tabindex="-1" class="font-semibold text-fg outline-none">
          {{ t('dataTransfer.sql.options') }}
        </h3>
        <div
          class="flex max-w-3xl flex-col gap-5 rounded-xl border border-line bg-surface p-4"
          data-sql-import-form
        >
          <DsSwitch
            v-model="primaryKeyAsId"
            :label="t('dataTransfer.sql.pkAsIdLabel')"
            :hint="t('dataTransfer.sql.pkAsIdHint')"
          />
          <div class="flex flex-col gap-1.5">
            <span class="text-small font-medium text-fg">{{ t('dataTransfer.sql.modeLabel') }}</span>
            <DsSegmented
              v-model="mode"
              :label="t('dataTransfer.sql.modeLabel')"
              :options="modes"
              class="self-start"
            />
            <p class="text-small text-fg-subtle" aria-live="polite">
              {{ t(`dataTransfer.sql.modeHint.${mode}`) }}
            </p>
          </div>
          <DsCallout v-if="mode !== 'insert' && !primaryKeyAsId" tone="warning">
            {{ t('dataTransfer.sql.noIdWarning') }}
          </DsCallout>
          <div class="flex flex-col gap-1.5">
            <span class="text-small font-medium text-fg">{{ t('dataTransfer.sql.onErrorLabel') }}</span>
            <DsSegmented
              v-model="onError"
              :label="t('dataTransfer.sql.onErrorLabel')"
              :options="onErrors"
              class="self-start"
            />
          </div>
          <ul
            v-if="sharedKeyed.length"
            class="flex flex-col gap-1 text-small text-danger"
            role="alert"
            data-sql-shared-keyed
          >
            <li v-for="c in sharedKeyed" :key="c">{{ t('dataTransfer.sql.sharedKeyed', { coll: c }) }}</li>
          </ul>
          <ul v-if="keyless.length" class="flex flex-col gap-1 text-small text-warning" data-sql-no-key>
            <li v-for="r in keyless" :key="r.key">
              {{ t('dataTransfer.sql.noKey', { table: visible(r.table.key) }) }}
            </li>
          </ul>
        </div>
      </div>

      <!-- The job, followed on a page of its own: a dry run, or the import. -->
      <div v-else class="flex flex-col gap-4" data-sql-step="run">
        <h3 ref="heading" tabindex="-1" class="font-semibold text-fg outline-none">
          {{ importJob ? t('sqlTransfer.import.runTitle') : t('sqlTransfer.import.dryRunTitle') }}
        </h3>
        <div
          v-if="importJob"
          class="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4"
          data-sql-import-job
        >
          <div v-if="importPhase === 'running'" class="flex flex-wrap items-center gap-3">
            <p class="flex items-center gap-2 font-medium text-fg" role="status" aria-live="polite">
              <DsSpinner />{{ t('sqlTransfer.import.running') }}
              <span v-if="importPercent !== null" class="text-fg-subtle tabular-nums"
                >{{ importPercent }}%</span
              >
            </p>
            <DsButton class="ml-auto" size="sm" :loading="stopping" data-import-stop @click="stop">
              <CircleStop class="size-4" aria-hidden="true" />{{ t('sqlTransfer.stop') }}
            </DsButton>
          </div>
          <p
            v-else-if="importPhase === 'ended'"
            class="flex items-center gap-2 font-medium text-danger"
            role="alert"
            data-import-ended
          >
            <XCircle class="size-4" aria-hidden="true" />{{ endedText }}
          </p>
          <DsProgress
            v-if="importPhase === 'running' && importPercent !== null"
            :label="t('sqlTransfer.import.running')"
            :value="importPercent / 100"
          />
          <p
            v-if="importPhase === 'done' && importReport"
            class="flex items-center gap-2 font-medium text-fg"
            role="status"
          >
            <CheckCircle2 class="size-4 text-accent-fg" aria-hidden="true" />{{
              t('sqlTransfer.import.finished')
            }}
          </p>
          <SqlImportReport
            v-if="importReport && importPhase !== 'running'"
            :report="importReport"
            :job-id="importJob"
          />
          <DsButton v-if="importPhase === 'ended' || importReport" class="self-start" @click="again">{{
            t('sqlTransfer.import.another')
          }}</DsButton>
        </div>
        <template v-else>
          <p v-if="dryRunState === 'running'" class="flex items-center gap-2 text-fg-muted" role="status">
            <DsSpinner />{{ t('dataTransfer.dryRunning') }}
          </p>
          <SqlImportReport v-if="report && dryRunJob" :report="report" :job-id="dryRunJob" />
        </template>
      </div>

      <!-- What the step leads to, always at hand under a long list. -->
      <div
        v-if="step === 'run' ? !importJob : rows.length > 0"
        class="sticky bottom-0 -mx-1 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-canvas/95 px-1 py-3 backdrop-blur pr-[max(0.25rem,var(--mm-launcher-clearance,0px))]"
        data-sql-import-actions
      >
        <!-- What is chosen, said once: in the bar always in sight, never again over the list. -->
        <p class="mr-auto text-small text-fg-subtle tabular-nums" aria-live="polite">
          {{ t('dataTransfer.sql.chosen', { n: n(chosen.length), total: n(rows.length) }, rows.length) }}
          · {{ t('dataTransfer.sql.rows', { n: n(chosenRows) }, chosenRows) }}
        </p>
        <DsButton
          v-if="step !== 'tables'"
          variant="ghost"
          :disabled="busy"
          data-step-back
          @click="go(step === 'options' ? 'tables' : 'options')"
        >
          <template v-if="step === 'options'">{{ t('sqlTransfer.steps.back') }}</template>
          <template v-else>{{ t('sqlTransfer.steps.backToOptions') }}</template>
        </DsButton>
        <DsButton
          v-if="step === 'tables'"
          variant="primary"
          :disabled="!valid"
          data-step-next
          @click="go('options')"
        >
          {{ t('sqlTransfer.steps.next') }}<ArrowRight class="size-4" aria-hidden="true" />
        </DsButton>
        <template v-else>
          <DsButton v-if="step === 'options'" :loading="busy" :disabled="!startable" @click="start(true)">{{
            t('dataTransfer.dryRun')
          }}</DsButton>
          <DsButton variant="primary" :loading="busy" :disabled="!startable" @click="start(false)">
            {{ db ? t('sqlTransfer.import.start', { db }) : t('sqlTransfer.import.startUnnamed') }}
          </DsButton>
        </template>
      </div>
    </template>
  </section>
</template>
