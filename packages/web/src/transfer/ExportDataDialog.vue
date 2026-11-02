<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { ArrowDown, ArrowUp, Brackets, Lock } from 'lucide-vue-next'
import {
  EXPORT_FORMATS,
  type ArrayColumns,
  type ExportFormat,
  type ExportRequest,
  type PresetInput,
} from '@mongo-manager/shared/browser'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import DsSelect from '@/ds/DsSelect.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import { describeError } from '@/api/errors'
import { transferApi } from '@/api/transfer'
import { documentKeys, documentsApi } from '@/api/documents'
import DsInput from '@/ds/DsInput.vue'
import { schemaColumns } from './schemaColumns'
import { provideMaskedPaths } from '@/masking/useMaskedPaths'
import { useJobsStore } from '@/jobs/store'
import { useToastStore } from '@/stores/toasts'
import { formatCount } from '@/format'
import type { ExportQuery } from '@/api/transfer'
import PresetPicker from './PresetPicker.vue'

/**
 * Phase 3d-1 spec §9: export the current query, the whole collection or a pipeline as a file. The job
 * runs on the server; the file is offered for download when it is ready.
 */
const props = defineProps<{
  connectionId: string
  db: string
  coll: string
  query?: ExportQuery
  stages?: unknown[]
  /** Field paths seen in the documents shown, proposed as CSV/xlsx columns. */
  fields?: string[]
  /** The format asked for (the assistant's "download as Excel"), else CSV. */
  format?: Exclude<ExportFormat, 'sql'>
}>()
const emit = defineEmits<{ close: [] }>()
const { t, locale } = useI18n()
const jobs = useJobsStore()
const toasts = useToastStore()
const target = computed(() => ({ connectionId: props.connectionId, db: props.db, coll: props.coll }))
const masking = provideMaskedPaths(
  computed(() => props.connectionId),
  computed(() => props.db),
  computed(() => props.coll),
)

type SourceKind = 'query' | 'collection' | 'pipeline'
const source = ref<SourceKind>(props.stages ? 'pipeline' : props.query ? 'query' : 'collection')
/**
 * User request 2026-10-11: SQL is exported on the SQL ↔ MongoDB page, never from a collection's own
 * Export (a preset saved with SQL loads as CSV).
 */
const FORMATS = EXPORT_FORMATS.filter((f) => f !== 'sql')
const format = ref<ExportFormat>(props.format ?? 'csv')
/** The formats written as columns: their columns can be chosen and ordered. */
const tabular = computed(() => format.value === 'csv' || format.value === 'xlsx')
const gzip = ref(false)
const csv = reactive<ExportRequest['csv']>({
  delimiter: ',',
  header: true,
  lineEnding: 'crlf',
  bom: true,
  formulaGuard: true,
})
const json = reactive<ExportRequest['json']>({ pretty: true, ejson: 'canonical' })
/** W4.2: arrays in CSV and Excel — a JSON cell, a column per element, or the elements joined. */
const arrays = reactive<{ mode: ArrayColumns['mode']; max: string; separator: string }>({
  mode: 'json',
  max: '10',
  separator: '; ',
})
const columns = ref<Array<{ path: string; on: boolean; array?: boolean }>>(
  (props.fields ?? []).map((path) => ({ path, on: true })),
)
/**
 * W4.2: without fields handed over (opened from the tree, the palette or a query without shown
 * documents), the columns are proposed from a schema sample — the guarded schema route, so a
 * restricted user's personal fields come back marked. A pipeline's output is not the collection's:
 * its columns come from its first documents, on the server.
 */
const sampleWanted = computed(() => !props.fields?.length && source.value !== 'pipeline' && tabular.value)
const schema = useQuery({
  queryKey: computed(() => [...documentKeys.schema(target.value, 100), 'export']),
  queryFn: () => documentsApi.schema(target.value, 100),
  enabled: sampleWanted,
  retry: false,
  staleTime: 60_000,
})
watch(
  () => schema.data.value,
  (analysis) => {
    if (!analysis || props.fields?.length || columns.value.length) return
    columns.value = schemaColumns(analysis).map((c) => ({ path: c.path, on: true, array: c.array }))
  },
  { immediate: true },
)
const hasArrays = computed(() => columns.value.some((c) => c.array))
const busy = ref(false)
const errors = ref<string[]>([])

const filter = computed(() => (source.value === 'query' ? (props.query?.filter ?? {}) : {}))
const count = useQuery({
  queryKey: computed(() => ['transfer', 'estimate', target.value, source.value, filter.value]),
  queryFn: () => documentsApi.count(target.value, filter.value, {}),
  enabled: computed(() => source.value !== 'pipeline'),
})
const about = computed(() => {
  const c = count.data.value
  const n = c?.count ?? c?.atLeast
  return n === null || n === undefined ? null : formatCount(n, locale.value)
})

function move(i: number, by: -1 | 1): void {
  const j = i + by
  if (j < 0 || j >= columns.value.length) return
  const list = [...columns.value]
  ;[list[i], list[j]] = [list[j]!, list[i]!]
  columns.value = list
}

function onKey(event: KeyboardEvent, i: number): void {
  if (!event.altKey) return
  if (event.key === 'ArrowUp') move(i, -1)
  else if (event.key === 'ArrowDown') move(i, 1)
  else return
  event.preventDefault()
}

/** The array option as sent; a bound outside 1–100 or an empty separator falls back to the default. */
function arraysOut(): ExportRequest['arrays'] {
  const max = Math.round(Number(arrays.max))
  return {
    mode: tabular.value ? arrays.mode : 'json',
    max: Number.isFinite(max) && max >= 1 && max <= 100 ? max : 10,
    separator: arrays.separator && arrays.separator.length <= 16 ? arrays.separator : '; ',
  }
}

function request(): ExportRequest {
  const q = props.query
  const src: ExportRequest['source'] =
    source.value === 'pipeline'
      ? { kind: 'pipeline', stages: (props.stages ?? []) as Array<Record<string, unknown>> }
      : source.value === 'collection' || !q
        ? { kind: 'collection' }
        : {
            kind: 'query',
            filter: q.filter,
            skip: q.skip ?? 0,
            ...(q.projection ? { projection: q.projection } : {}),
            ...(q.sort ? { sort: q.sort } : {}),
            ...(q.collation ? { collation: q.collation } : {}),
            ...(q.hint !== undefined ? { hint: q.hint } : {}),
            ...(q.limit ? { limit: q.limit } : {}),
          }
  const chosen = columns.value.filter((c) => c.on).map((c) => c.path)
  return {
    source: src,
    format: format.value,
    gzip: gzip.value,
    csv: { ...csv },
    json: { ...json },
    arrays: arraysOut(),
    // Not a SQL export: the server's defaults, unused.
    sql: { dialect: 'postgres', rowsPerInsert: 100, transaction: true, jsonAsText: false },
    ...(tabular.value && chosen.length ? { fields: chosen } : {}),
  }
}

async function start(): Promise<void> {
  errors.value = []
  busy.value = true
  try {
    const { job } = await transferApi.startExport(props.connectionId, props.db, props.coll, request())
    jobs.upsert(job)
    toasts.push({ kind: 'info', message: t('dataTransfer.exportStarted') })
    emit('close')
  } catch (e) {
    errors.value = [describeError(e, t)]
  } finally {
    busy.value = false
  }
}

function applyPreset(saved: PresetInput['body']): void {
  if (saved.format && saved.format !== 'sql') format.value = saved.format
  if (saved.gzip !== undefined) gzip.value = saved.gzip
  if (saved.csv) Object.assign(csv, saved.csv)
  if (saved.json) Object.assign(json, saved.json)
  if (saved.arrays?.mode) arrays.mode = saved.arrays.mode
  if (saved.arrays?.max) arrays.max = String(saved.arrays.max)
  if (saved.arrays?.separator) arrays.separator = saved.arrays.separator
  if (saved.fields) {
    const known = new Set(saved.fields)
    columns.value = [
      ...saved.fields.map((path) => ({ path, on: true })),
      ...columns.value.filter((c) => !known.has(c.path)).map((c) => ({ ...c, on: false })),
    ]
  }
}
const currentPreset = (): PresetInput['body'] => {
  const r = request()
  return {
    format: r.format,
    gzip: r.gzip,
    csv: r.csv,
    json: r.json,
    arrays: r.arrays,
    ...(r.fields ? { fields: r.fields } : {}),
  }
}

const locked = (path: string) => masking.matcher.value(path.split('.'))
const formatOptions = computed(() =>
  FORMATS.map((f) => ({ value: f, label: t(`dataTransfer.formatNames.${f}`) })),
)
const sourceOptions = computed(() => [
  ...(props.query ? [{ value: 'query' as const, label: t('dataTransfer.source.query') }] : []),
  { value: 'collection' as const, label: t('dataTransfer.source.collection') },
  ...(props.stages ? [{ value: 'pipeline' as const, label: t('dataTransfer.source.pipeline') }] : []),
])
const delimiterOptions = computed(() => [
  { value: ',', label: t('dataTransfer.delimiters.comma') },
  { value: ';', label: t('dataTransfer.delimiters.semicolon') },
  { value: '\t', label: t('dataTransfer.delimiters.tab') },
  { value: '|', label: t('dataTransfer.delimiters.pipe') },
])
const lineEndingOptions = computed(() => [
  { value: 'crlf' as const, label: t('dataTransfer.lineEndings.crlf') },
  { value: 'lf' as const, label: t('dataTransfer.lineEndings.lf') },
])
const arrayOptions = computed(() =>
  (['json', 'index', 'join'] as const).map((m) => ({ value: m, label: t(`dataTransfer.arrays.${m}`) })),
)
const ejsonOptions = computed(() => [
  { value: 'canonical' as const, label: t('dataTransfer.ejsonCanonical') },
  { value: 'relaxed' as const, label: t('dataTransfer.ejsonRelaxed') },
])
</script>

<template>
  <DsDialog open :title="t('dataTransfer.exportTitle', { coll })" size="xl" @close="emit('close')">
    <div class="flex flex-col gap-4 text-ui">
      <DsFormErrors :messages="errors" />
      <!-- Short names, no explanation: a segmented control (the group carries the name). -->
      <div class="flex flex-col items-start gap-1.5">
        <span class="font-medium" aria-hidden="true">{{ t('dataTransfer.source.label') }}</span>
        <DsSegmented v-model="source" :label="t('dataTransfer.source.label')" :options="sourceOptions" />
      </div>
      <p v-if="about" class="text-small text-fg-subtle">{{ t('dataTransfer.about', { n: about }) }}</p>
      <p
        v-if="masking.hidden.value"
        class="flex items-center gap-1 text-small text-warning"
        data-export-masked
      >
        <Lock class="size-3.5" aria-hidden="true" />{{ t('dataTransfer.maskedNotice') }}
      </p>
      <div class="flex flex-wrap items-end gap-3">
        <DsSelect v-model="format" :label="t('dataTransfer.format')" :options="formatOptions" />
        <DsCheckbox v-model="gzip" :label="t('dataTransfer.gzip')" />
      </div>
      <div v-if="format === 'csv'" class="flex flex-wrap items-end gap-3">
        <DsSelect v-model="csv.delimiter" :label="t('dataTransfer.delimiter')" :options="delimiterOptions" />
        <DsSelect
          v-model="csv.lineEnding"
          :label="t('dataTransfer.lineEnding')"
          :options="lineEndingOptions"
        />
        <DsCheckbox v-model="csv.header" :label="t('dataTransfer.headerRow')" />
        <DsCheckbox v-model="csv.bom" :label="t('dataTransfer.bom')" />
        <!-- Data review 2026-10-13 (M8): the ' a spreadsheet needs, which another program keeps; said
             in words under it, for every reader (review Minor 11). -->
        <DsCheckbox
          v-model="csv.formulaGuard"
          class="basis-full"
          data-formula-guard
          :label="t('dataTransfer.formulaGuard')"
          :hint="t('dataTransfer.formulaGuardHint')"
        />
      </div>
      <div v-if="format === 'json'" class="flex flex-wrap items-end gap-3">
        <DsCheckbox v-model="json.pretty" :label="t('dataTransfer.pretty')" />
        <DsSelect v-model="json.ejson" :label="t('dataTransfer.ejson')" :options="ejsonOptions" />
      </div>
      <!-- W4.2: how arrays become cells; the server samples the documents for one column per element. -->
      <div v-if="tabular" class="flex flex-wrap items-end gap-3" data-test="array-options">
        <DsSelect
          v-model="arrays.mode"
          :label="t('dataTransfer.arrays.label')"
          :options="arrayOptions"
          :hint="t(`dataTransfer.arrays.${arrays.mode}Hint`)"
        />
        <DsInput
          v-if="arrays.mode === 'index'"
          v-model="arrays.max"
          type="number"
          :label="t('dataTransfer.arrays.max')"
          class="w-40"
        />
        <DsInput
          v-if="arrays.mode === 'join'"
          v-model="arrays.separator"
          :label="t('dataTransfer.arrays.separator')"
          mono
          class="w-40"
        />
      </div>
      <fieldset v-if="tabular" class="flex flex-col gap-1">
        <legend class="mb-1 font-medium">{{ t('dataTransfer.columns') }}</legend>
        <p v-if="schema.isFetching.value && !columns.length" class="text-small text-fg-subtle" role="status">
          {{ t('dataTransfer.columnsSampling') }}
        </p>
        <p v-else-if="!columns.length" class="text-small text-fg-subtle">
          {{ t('dataTransfer.columnsFromFirst') }}
        </p>
        <p v-else-if="!props.fields?.length && source !== 'pipeline'" class="text-small text-fg-subtle">
          {{ t('dataTransfer.columnsFromSample') }}
          <template v-if="hasArrays && arrays.mode === 'index'">{{
            t('dataTransfer.arrays.expanded')
          }}</template>
        </p>
        <ul class="max-h-56 overflow-auto rounded-md border border-line">
          <li
            v-for="(c, i) in columns"
            :key="c.path"
            class="flex items-center gap-2 border-b border-line px-2 py-1 last:border-0"
            tabindex="0"
            :aria-label="t('dataTransfer.columnMove', { field: c.path })"
            @keydown="onKey($event, i)"
          >
            <input
              v-model="c.on"
              type="checkbox"
              class="size-4 accent-accent"
              :aria-label="t('dataTransfer.columnInclude', { field: c.path })"
            />
            <span class="flex-1 truncate font-mono text-small">{{ c.path }}</span>
            <Brackets
              v-if="c.array"
              class="size-3.5 text-fg-subtle"
              :aria-label="t('dataTransfer.arrays.column')"
            />
            <Lock
              v-if="locked(c.path)"
              class="size-3.5 text-warning"
              :aria-label="t('dataTransfer.personalLocked')"
            />
            <button
              type="button"
              class="cursor-pointer rounded p-0.5 hover:bg-subtle"
              :aria-label="t('dataTransfer.columnUp', { field: c.path })"
              @click="move(i, -1)"
            >
              <ArrowUp class="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="cursor-pointer rounded p-0.5 hover:bg-subtle"
              :aria-label="t('dataTransfer.columnDown', { field: c.path })"
              @click="move(i, 1)"
            >
              <ArrowDown class="size-3.5" aria-hidden="true" />
            </button>
          </li>
        </ul>
      </fieldset>
      <PresetPicker
        kind="export"
        :namespace="`${db}.${coll}`"
        :current="currentPreset"
        @apply="applyPreset"
      />
    </div>
    <template #footer>
      <DsButton variant="ghost" @click="emit('close')">{{ t('dataTransfer.cancel') }}</DsButton>
      <DsButton variant="primary" :loading="busy" @click="start">{{ t('dataTransfer.export') }}</DsButton>
    </template>
  </DsDialog>
</template>
