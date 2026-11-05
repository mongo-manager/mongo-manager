<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { Plus, Trash2, Upload } from 'lucide-vue-next'
import {
  FIELD_TYPES,
  TEXT_ENCODINGS,
  TRANSFER_FORMATS,
  type Constant,
  type ConvertedSample,
  type Dialect,
  type FieldType,
  type ImportReport as Report,
  type ImportRequest,
  type MappingEntry,
  type PresetInput,
  type TextEncodingName,
  type TransferFormat,
  type TransferPreviewResponse,
} from '@mongo-manager/shared/browser'
import DsCallout from '@/ds/DsCallout.vue'
import DsIconButton from '@/ds/DsIconButton.vue'
import { documentKeys, documentsApi } from '@/api/documents'
import { keysCovered } from './keyIndex'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import { keyError, keysOf } from './keyText'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import DsSelect from '@/ds/DsSelect.vue'
import DsInput from '@/ds/DsInput.vue'
import DsTextarea from '@/ds/DsTextarea.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import DsStepper, { type StepItem } from '@/ds/DsStepper.vue'
import DsChoiceCard from '@/ds/DsChoiceCard.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import DsProgress from '@/ds/DsProgress.vue'
import { describeError } from '@/api/errors'
import { transferApi } from '@/api/transfer'
import { provideMaskedPaths } from '@/masking/useMaskedPaths'
import { useJobsStore } from '@/jobs/store'
import { useToastStore } from '@/stores/toasts'
import MappingTable from './MappingTable.vue'
import ImportReport from './ImportReport.vue'
import PresetPicker from './PresetPicker.vue'
import { useUpload } from './useUpload'

/**
 * Phase 3d-1 spec §9: import a file (or pasted text) into a collection — source, settings, mapping,
 * then mode with a dry run. The server checks everything again; this only guides.
 */
const props = defineProps<{
  connectionId: string
  db: string
  coll: string
  /** Plugins wave 3: documents a plugin handed over, read as the file chosen. */
  preset?: { id?: string; name: string; text: string; from: string }
}>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const jobs = useJobsStore()
const toasts = useToastStore()
const id = useId()
const masking = provideMaskedPaths(
  computed(() => props.connectionId),
  computed(() => props.db),
  computed(() => props.coll),
)
const segments = (path: string) => path.replace(/\[(\d+)\]/g, '.$1').split('.')
const locked = (path: string) => masking.matcher.value(segments(path))

type Step = 'source' | 'settings' | 'mapping' | 'mode'
const STEPS: Step[] = ['source', 'settings', 'mapping', 'mode']
const step = ref<Step>('source')
const { progress, uploading, upload, abort } = useUpload()
const uploadId = ref<string | null>(null)
const handedOver = ref(false)
const preview = ref<TransferPreviewResponse | null>(null)
const format = ref<TransferFormat>('csv')
const dialect = reactive<{
  delimiter: ',' | ';' | '\t' | '|'
  header: boolean
  sheet: string | null
  encoding: TextEncodingName
}>({
  delimiter: ',',
  header: true,
  sheet: null,
  encoding: 'utf8',
})
const entries = ref<MappingEntry[]>([])
/** W4.1: constant fields — the import time, or a literal of a mapping type ("null" needs no value). */
type ConstantType = 'now' | Exclude<FieldType, 'keep'>
interface ConstantRow {
  key: number
  path: string
  type: ConstantType
  value: string
}
const constantRows = ref<ConstantRow[]>([])
let constantKey = 0
const CONSTANT_TYPES: ConstantType[] = ['now', ...FIELD_TYPES.filter((ty) => ty !== 'keep')]
const addConstant = () => constantRows.value.push({ key: ++constantKey, path: '', type: 'string', value: '' })
const removeConstant = (key: number) =>
  (constantRows.value = constantRows.value.filter((row) => row.key !== key))
const allowUnusual = ref(false)
const mode = ref<ImportRequest['mode']>('insert')
const keys = ref('_id')
const updateOnly = ref(false)
const onError = ref<ImportRequest['onError']>('continue')
const pasted = ref('')
const busy = ref(false)
const errors = ref<string[]>([])
const dryRunJob = ref<string | null>(null)
const report = ref<Report | null>(null)

const tabular = computed(() => format.value === 'csv' || format.value === 'xlsx')
const fail = (e: unknown) => (errors.value = [describeError(e, t)])

function fromPreview(p: TransferPreviewResponse): MappingEntry[] {
  return p.fields.map((f) => ({
    source: f.source,
    path: f.suggestedPath,
    type: f.suggestedType,
    include: !f.unusual && !locked(f.suggestedPath),
    empty: 'skip',
    onError: 'error',
  }))
}

/** The dialect the server reads the file with (no empty values). */
function dialectOut(): Dialect {
  if (format.value === 'xlsx')
    return { header: dialect.header, ...(dialect.sheet ? { sheet: dialect.sheet } : {}) }
  if (format.value === 'csv')
    return { delimiter: dialect.delimiter, header: dialect.header, encoding: dialect.encoding }
  return { encoding: dialect.encoding }
}

/**
 * One preview at a time: the server reads one per user and refuses a second meanwhile. A change
 * made while one runs is read after it; of several such changes only the latest is, and an answer
 * that a newer request replaced is not shown.
 */
let previews: Promise<void> = Promise.resolve()
let latest = 0
function loadPreview(body: { format?: TransferFormat; dialect?: Dialect } = {}): Promise<void> {
  const ticket = ++latest
  const run = previews.then(async () => {
    if (ticket !== latest || !uploadId.value) return
    const p = await transferApi.preview(props.connectionId, uploadId.value, body)
    if (ticket !== latest) return
    preview.value = p
    format.value = p.format
    Object.assign(dialect, p.dialect)
    entries.value = fromPreview(p)
  })
  previews = run.catch(() => undefined)
  return run
}

async function send(file: Blob, name: string): Promise<void> {
  errors.value = []
  try {
    if (uploadId.value) void transferApi.discard(props.connectionId, uploadId.value).catch(() => undefined)
    uploadId.value = (await upload(props.connectionId, file, name)).uploadId
    await loadPreview()
    step.value = 'settings'
  } catch (e) {
    fail(e)
  }
}

// Plugins wave 3 (spec §1.2): a plugin's documents are this wizard's file, read at once; the user
// still checks, maps and starts the import.
onMounted(() => {
  if (props.preset)
    void send(new Blob([props.preset.text], { type: 'application/x-ndjson' }), props.preset.name)
})

function onFile(event: Event): void {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file) void send(file, file.name)
}

function sendPasted(): void {
  void send(new Blob([pasted.value]), 'pasted.txt')
}

function onDrop(event: DragEvent): void {
  const file = event.dataTransfer?.files?.[0]
  if (file) void send(file, file.name)
}

async function reread(): Promise<void> {
  errors.value = []
  try {
    await loadPreview({ format: format.value, dialect: dialectOut() })
  } catch (e) {
    fail(e)
  }
}
function setSheet(sheet: string): void {
  dialect.sheet = sheet
  void reread()
}

/** JSON keeps every field as read unless the mapping was changed. */
const mappingChanged = computed(() =>
  entries.value.some((e) => !e.include || e.path !== e.source || e.type !== 'keep' || e.empty !== 'skip'),
)
const constants = computed<Constant[]>(() =>
  constantRows.value
    .filter((row) => row.path.trim())
    .map((row): Constant => {
      const path = row.path.trim()
      if (row.type === 'now') return { path, now: true }
      return { path, type: row.type, value: row.type === 'null' ? '' : row.value }
    }),
)
/** A constant on a personal path: the server refuses it (403), so the wizard does not go on. */
const constantLocked = (row: ConstantRow) => !!row.path.trim() && locked(row.path.trim())
const anyConstantLocked = computed(() => constantRows.value.some(constantLocked))

/**
 * W4.1: the mapping step's samples as the import would write them, converted by the server's own
 * rules. Only the latest answer is kept; a failure leaves the samples as read.
 */
const converted = ref<Record<string, ConvertedSample[]>>({})
let convertTicket = 0
const convertBody = computed(() => {
  const shown = entries.value.filter((e) => e.include && e.type !== 'keep')
  const samples = new Map(preview.value?.fields.map((f) => [f.source, f.samples.slice(0, 5)]) ?? [])
  return shown.map((e) => ({ source: e.source, type: e.type, values: samples.get(e.source) ?? [] }))
})
watch(
  [convertBody, step, allowUnusual],
  async ([body, current]) => {
    if (current !== 'mapping') return
    const ticket = ++convertTicket
    const items = body.filter((b) => b.values.length).slice(0, 500)
    if (!items.length) return void (converted.value = {})
    try {
      const out = await transferApi.convertSamples(props.connectionId, {
        items: items.map(({ type, values }) => ({ type, values })),
        allowUnusualKeys: allowUnusual.value,
      })
      if (ticket !== convertTicket) return
      converted.value = Object.fromEntries(items.map((item, i) => [item.source, out.items[i] ?? []]))
    } catch {
      if (ticket === convertTicket) converted.value = {}
    }
  },
  { deep: true },
)

/** W4.1: an upsert or merge whose key fields no index starts with scans the collection per record. */
const indexes = useQuery({
  queryKey: computed(() =>
    documentKeys.indexes({ connectionId: props.connectionId, db: props.db, coll: props.coll }),
  ),
  queryFn: () => documentsApi.indexes({ connectionId: props.connectionId, db: props.db, coll: props.coll }),
  enabled: computed(() => step.value === 'mode' && mode.value !== 'insert'),
  retry: false,
})
const keyList = computed(() => keysOf(keys.value))
// Eighteenth review of explain masking (M-5): the form says it before anything is sent.
const badKey = computed(() => (mode.value !== 'insert' ? keyError(keys.value, t) : undefined))
const keyUncovered = computed(
  () =>
    mode.value !== 'insert' &&
    keyList.value.length > 0 &&
    indexes.data.value !== undefined &&
    !keysCovered(keyList.value, indexes.data.value),
)

const ENCODING_LABEL = (e: TextEncodingName) => t(`dataTransfer.encodings.${e}`)
const encodingOptions = computed(() => TEXT_ENCODINGS.map((e) => ({ value: e, label: ENCODING_LABEL(e) })))
const suggestion = computed(() => {
  const s = preview.value?.suggestedEncoding
  return s && s !== dialect.encoding ? s : null
})
function useSuggested(): void {
  if (!suggestion.value) return
  dialect.encoding = suggestion.value
  void reread()
}

function body(dryRun: boolean): ImportRequest {
  return {
    uploadId: uploadId.value!,
    format: format.value,
    dialect: dialectOut(),
    ...(tabular.value || mappingChanged.value ? { mapping: entries.value } : {}),
    constants: constants.value,
    mode: mode.value,
    // Eighteenth review of explain masking (M-4): an insert names no key; the checked ones otherwise.
    keys: mode.value !== 'insert' ? keyList.value : ['_id'],
    updateOnly: updateOnly.value,
    onError: onError.value,
    dryRun,
    allowUnusualKeys: allowUnusual.value,
  }
}

async function start(dryRun: boolean): Promise<void> {
  errors.value = []
  report.value = null
  busy.value = true
  try {
    const { job } = await transferApi.startImport(props.connectionId, props.db, props.coll, body(dryRun))
    jobs.upsert(job)
    if (dryRun) dryRunJob.value = job.id
    else {
      handedOver.value = true
      toasts.push({ kind: 'info', message: t('dataTransfer.importStarted') })
      emit('close')
    }
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
    if (r.kind === 'import') report.value = r
  } catch (e) {
    fail(e)
  }
})

function applyPreset(saved: PresetInput['body']): void {
  // SQL transfer: settings made for a SQL export are no file import's (a dump has its own import).
  if (saved.format === 'sql') return
  if (saved.mapping) {
    const bySource = new Map(saved.mapping.map((m) => [m.source, m]))
    entries.value = entries.value.map((e) => {
      const m = bySource.get(e.source)
      return m && !locked(m.path) ? { ...m } : e
    })
  }
  // A copy preset's "replace" is not an import mode (phase 3d-2).
  if (saved.mode && saved.mode !== 'replace') mode.value = saved.mode
  // Nineteenth review of explain masking (M-2): a preset whose keys were dropped means _id.
  if (saved.keys?.length) keys.value = saved.keys.join(', ')
  else if (saved.mode === 'upsert' || saved.mode === 'merge') keys.value = '_id'
}
const currentPreset = (): PresetInput['body'] => ({
  mapping: entries.value,
  mode: mode.value,
  // An insert names no key: a preset of one overwrites none typed (nineteenth review, nit).
  ...(mode.value !== 'insert' ? { keys: body(false).keys } : {}),
  ...(format.value === 'csv' ? { dialect: dialectOut() } : {}),
})

function close(): void {
  abort()
  if (uploadId.value && !handedOver.value)
    void transferApi.discard(props.connectionId, uploadId.value).catch(() => undefined)
  emit('close')
}
onBeforeUnmount(() => abort())

const next = () => (step.value = STEPS[Math.min(STEPS.indexOf(step.value) + 1, STEPS.length - 1)]!)
const back = () => (step.value = STEPS[Math.max(STEPS.indexOf(step.value) - 1, 0)]!)
// The stepper goes back only (todo steps are disabled): the file must be read before its settings.
const stepItems = computed<StepItem[]>(() =>
  STEPS.map((s, i) => ({
    id: s,
    label: t(`dataTransfer.steps.${s}`),
    state: s === step.value ? 'current' : i < STEPS.indexOf(step.value) ? 'done' : 'todo',
  })),
)
const MODES = ['insert', 'upsert', 'merge'] as const
const onErrorOptions = computed(() => [
  { value: 'continue' as const, label: t('dataTransfer.onErrorContinue') },
  { value: 'stop' as const, label: t('dataTransfer.onErrorStop') },
])
const columns = computed(() => preview.value?.fields.map((f) => f.source) ?? [])
const cell = (v: unknown) => (v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v))
const formatOptions = computed(() =>
  TRANSFER_FORMATS.map((f) => ({ value: f, label: t(`dataTransfer.formatNames.${f}`) })),
)
const delimiterOptions = computed(() => [
  { value: ',' as const, label: t('dataTransfer.delimiters.comma') },
  { value: ';' as const, label: t('dataTransfer.delimiters.semicolon') },
  { value: '\t' as const, label: t('dataTransfer.delimiters.tab') },
  { value: '|' as const, label: t('dataTransfer.delimiters.pipe') },
])
</script>

<template>
  <DsDialog open :title="t('dataTransfer.importTitle', { coll })" size="xl" @close="close">
    <div class="flex flex-col gap-4">
      <!-- A dialog, not a sheet: the steps stay in a row at every width. -->
      <DsStepper
        class="xl:flex-row!"
        :steps="stepItems"
        :label="t('dataTransfer.steps.label')"
        @select="(s) => (step = s as Step)"
      />
      <DsFormErrors :messages="errors" />
      <DsCallout v-if="preset" tone="info" data-import-from-plugin>
        {{ t('dataTransfer.fromPlugin', { from: preset.from }) }}
      </DsCallout>

      <template v-if="step === 'source'">
        <label
          :for="`${id}-file`"
          class="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-line-strong p-6 text-center text-ui hover:border-accent"
          @dragover.prevent
          @drop.prevent="onDrop"
        >
          <Upload class="size-6 text-fg-subtle" aria-hidden="true" />
          <span>{{ t('dataTransfer.chooseFile') }}</span>
          <span class="text-small text-fg-subtle">{{ t('dataTransfer.formats') }}</span>
        </label>
        <input
          :id="`${id}-file`"
          type="file"
          class="sr-only"
          accept=".csv,.tsv,.txt,.json,.ndjson,.jsonl,.xlsx,.gz"
          @change="onFile"
        />
        <DsProgress v-if="uploading" :label="t('dataTransfer.uploading')" :value="progress / 100" />
        <DsTextarea v-model="pasted" :label="t('dataTransfer.pasteText')" :rows="5" mono />
        <div>
          <DsButton :disabled="!pasted.trim() || uploading" @click="sendPasted">
            {{ t('dataTransfer.usePasted') }}
          </DsButton>
        </div>
      </template>

      <template v-else-if="step === 'settings' && preview">
        <!-- Read again once the model holds the change: v-model's listener runs before reread. -->
        <div class="flex flex-wrap items-end gap-3">
          <DsSelect
            v-model="format"
            :label="t('dataTransfer.format')"
            :options="formatOptions"
            @update:model-value="reread"
          />
          <DsSelect
            v-if="format === 'csv'"
            v-model="dialect.delimiter"
            :label="t('dataTransfer.delimiter')"
            :options="delimiterOptions"
            @update:model-value="reread"
          />
          <DsSelect
            v-if="format !== 'xlsx'"
            v-model="dialect.encoding"
            :label="t('dataTransfer.encoding')"
            :options="encodingOptions"
            @update:model-value="reread"
          />
          <DsSelect
            v-if="format === 'xlsx' && preview.sheets.length > 1"
            :model-value="dialect.sheet ?? preview.sheets[0]!"
            :label="t('dataTransfer.sheet')"
            :options="preview.sheets.map((s) => ({ value: s, label: s }))"
            @update:model-value="setSheet"
          />
          <DsCheckbox
            v-if="tabular"
            v-model="dialect.header"
            :label="t('dataTransfer.headerRow')"
            @update:model-value="reread"
          />
        </div>
        <!-- W4.1: a guessed encoding is offered, never applied by itself. -->
        <DsCallout v-if="suggestion && format !== 'xlsx'" tone="warning" data-test="encoding-suggestion">
          {{ t('dataTransfer.encodingSuggested', { name: ENCODING_LABEL(suggestion) }) }}
          <template #action>
            <DsButton size="sm" @click="useSuggested">
              {{ t('dataTransfer.encodingUse', { name: ENCODING_LABEL(suggestion) }) }}
            </DsButton>
          </template>
        </DsCallout>
        <ul v-if="preview.warnings.length" class="list-disc pl-5 text-small text-warning">
          <li v-for="w in preview.warnings" :key="w">{{ w }}</li>
        </ul>
        <div class="max-h-64 overflow-auto rounded-md border border-line">
          <table class="w-full text-small">
            <thead class="sticky top-0 bg-subtle">
              <tr>
                <th v-for="c in columns" :key="c" class="p-1.5 text-left font-mono font-medium">{{ c }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in preview.records.slice(0, 20)" :key="i" class="border-t border-line">
                <td v-for="c in columns" :key="c" class="max-w-48 truncate p-1.5 font-mono">
                  {{ cell(r[c]) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <template v-else-if="step === 'mapping' && preview">
        <p class="text-small text-fg-subtle">
          {{ tabular ? t('dataTransfer.mapping.hintTable') : t('dataTransfer.mapping.hintDocs') }}
        </p>
        <MappingTable v-model="entries" :fields="preview.fields" :locked="locked" :converted="converted" />
        <!-- W4.1: constant fields, each with its own type (the server converts and checks it again). -->
        <section class="flex flex-col gap-2 text-ui" :aria-label="t('dataTransfer.constants.title')">
          <h3 class="font-medium">{{ t('dataTransfer.constants.title') }}</h3>
          <p v-if="!constantRows.length" class="text-small text-fg-subtle">
            {{ t('dataTransfer.constants.none') }}
          </p>
          <div
            v-for="(row, i) in constantRows"
            :key="row.key"
            class="flex flex-wrap items-end gap-2"
            data-test="constant-row"
          >
            <DsInput
              v-model="row.path"
              hide-label
              :label="t('dataTransfer.constants.path', { n: i + 1 })"
              :placeholder="t('dataTransfer.constants.pathPlaceholder')"
              mono
              :error="constantLocked(row) ? t('dataTransfer.personalLocked') : undefined"
            />
            <DsSelect
              v-model="row.type"
              hide-label
              :label="t('dataTransfer.constants.type', { n: i + 1 })"
              :options="
                CONSTANT_TYPES.map((ty) => ({
                  value: ty,
                  label: ty === 'now' ? t('dataTransfer.constants.now') : t(`dataTransfer.types.${ty}`),
                }))
              "
            />
            <DsInput
              v-if="row.type !== 'now' && row.type !== 'null'"
              v-model="row.value"
              hide-label
              :label="t('dataTransfer.constants.value', { n: i + 1 })"
              :placeholder="t(`dataTransfer.constants.placeholders.${row.type}`)"
              mono
            />
            <DsIconButton
              :label="t('dataTransfer.constants.remove', { n: i + 1 })"
              :icon="Trash2"
              @click="removeConstant(row.key)"
            />
          </div>
          <div>
            <DsButton size="sm" variant="ghost" :icon="Plus" @click="addConstant">
              {{ t('dataTransfer.constants.add') }}
            </DsButton>
          </div>
        </section>
        <DsCheckbox v-model="allowUnusual" :label="t('dataTransfer.allowUnusual')" />
        <PresetPicker
          kind="import"
          :namespace="`${db}.${coll}`"
          :current="currentPreset"
          @apply="applyPreset"
        />
      </template>

      <template v-else-if="step === 'mode'">
        <fieldset class="grid gap-3 sm:grid-cols-3">
          <legend class="mb-2 text-ui font-medium">{{ t('dataTransfer.modes.label') }}</legend>
          <DsChoiceCard
            v-for="m in MODES"
            :key="m"
            v-model="mode"
            :name="`${id}-mode`"
            :value="m"
            :title="t(`dataTransfer.modes.${m}`)"
            :help="t(`dataTransfer.modes.${m}Hint`)"
            :disabled="m === 'upsert' && masking.hidden.value"
            :reason="t('dataTransfer.upsertRestricted')"
          />
        </fieldset>
        <template v-if="mode !== 'insert'">
          <DsInput v-model="keys" :label="t('dataTransfer.keys')" :error="badKey" mono />
          <DsCallout v-if="keyUncovered" tone="warning" data-test="key-index-warning">
            {{ t('dataTransfer.keyIndexMissing', { keys: keyList.join(', ') }) }}
          </DsCallout>
          <!-- Upsert and merge alike (data review 2026-10-13): never a choice sent while hidden. -->
          <DsCheckbox v-model="updateOnly" :label="t('dataTransfer.updateOnly')" />
        </template>
        <!-- Two short words, no explanation: a segmented control (the group carries the name). -->
        <div class="flex flex-col items-start gap-1.5 text-ui">
          <span class="font-medium" aria-hidden="true">{{ t('dataTransfer.onErrorLabel') }}</span>
          <DsSegmented v-model="onError" :label="t('dataTransfer.onErrorLabel')" :options="onErrorOptions" />
        </div>
        <p v-if="dryRunState === 'running'" class="text-ui text-fg-subtle" role="status">
          {{ t('dataTransfer.dryRunning') }}
        </p>
        <ImportReport v-if="report && dryRunJob" :report="report" :job-id="dryRunJob" />
      </template>
    </div>
    <template #footer>
      <DsButton v-if="step !== 'source'" variant="ghost" @click="back">{{ t('dataTransfer.back') }}</DsButton>
      <DsButton
        v-if="step === 'settings' || step === 'mapping'"
        variant="primary"
        :disabled="step === 'mapping' && anyConstantLocked"
        @click="next"
      >
        {{ t('dataTransfer.next') }}
      </DsButton>
      <template v-if="step === 'mode'">
        <DsButton :loading="busy" :disabled="!!badKey" @click="start(true)">{{
          t('dataTransfer.dryRun')
        }}</DsButton>
        <DsButton variant="primary" :loading="busy" :disabled="!!badKey" @click="start(false)">{{
          t('dataTransfer.import')
        }}</DsButton>
      </template>
    </template>
  </DsDialog>
</template>
