<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMutation } from '@tanstack/vue-query'
import type { CreateIndex } from '@mongo-manager/shared'
import { QueryParseError, parseQueryObject, serializeValue } from '@mongo-manager/shared/browser'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import DsInput from '@/ds/DsInput.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import DsCodeEditor from '@/ds/DsCodeEditor.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import DsIconButton from '@/ds/DsIconButton.vue'
import DsSelect from '@/ds/DsSelect.vue'
import { ArrowDown, ArrowUp, ChevronDown, Plus, X } from 'lucide-vue-next'
import { KEY_KINDS, rowsToText, textToRows, type KeyKind, type KeyRow } from './keyRows'
import { documentsApi, type CollectionTarget } from '@/api/documents'
import { useFormErrors } from '@/connections/formErrors'
import { useToastStore } from '@/stores/toasts'
import { useJobsStore } from '@/jobs/store'
import { decodeValue, toShell, typeOf } from '@/documents/values'

const props = defineProps<{
  target: CollectionTarget
  /** Phase 2b: the key an explain suggested, as shell text. */
  initialKey?: string
  /** Phase 4a-1: options an assistant suggested (canonical EJSON), filled in for review. */
  initialOptions?: Record<string, unknown>
}>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const toasts = useToastStore()
const jobs = useJobsStore()
const { general, reset, showError } = useFormErrors({ flatten: true })

const KEY_EXAMPLE = '{ field: 1 }'
const WILDCARD_KEY = '{ "$**": 1 }'
const SPECIAL = new Set(['text', 'hashed', '2dsphere', '2d'])
const keys = ref(props.initialKey ?? '')

// UI redesign R2 §3: the keys as rows of field and kind, two-way with the text. While the text is
// not a plain key (being typed, or more than the rows can say), the rows wait and say so.
// Review of K+R2 (I1): the two follow each other by what they mean, never by a flag — the rows write
// the text only when they say something else, and the text is never rewritten as it is typed.
const meaning = (list: readonly KeyRow[]) => rowsToText(list)
// Each row keeps its own id across moves, so its controls (and the focus on them) go with it.
type Row = KeyRow & { id: number }
let nextId = 0
const withId = (r: KeyRow): Row => ({ ...r, id: nextId++ })
const rows = ref<Row[]>((textToRows(keys.value) ?? []).map(withId))
if (rows.value.length === 0) rows.value.push(withId({ field: '', kind: '1' }))
const rowsInSync = ref(textToRows(keys.value) !== null)
watch(
  rows,
  (next) => {
    // A field named twice cannot be written as a key (an object keeps one): the rows keep both and
    // say so, and the text waits for the rows to be right again.
    const fields = next.map((r) => r.field.trim()).filter(Boolean)
    if (new Set(fields).size !== fields.length) return
    const fromText = textToRows(keys.value)
    if (fromText === null || meaning(next) !== meaning(fromText)) keys.value = meaning(next)
    rowsInSync.value = true
  },
  { deep: true },
)
watch(keys, (text) => {
  const parsed = textToRows(text)
  rowsInSync.value = parsed !== null
  if (parsed && meaning(parsed) !== meaning(rows.value))
    rows.value = (parsed.length > 0 ? parsed : [{ field: '', kind: '1' as KeyKind }]).map(withId)
})
/** The fields named more than once (MongoDB refuses such a key). */
const duplicates = computed(() => {
  const seen = new Set<string>()
  const twice = new Set<string>()
  for (const r of rows.value) {
    const f = r.field.trim()
    if (!f) continue
    if (seen.has(f)) twice.add(f)
    seen.add(f)
  }
  return twice
})
const isRepeat = (index: number) => {
  const f = rows.value[index]!.field.trim()
  return f !== '' && duplicates.value.has(f) && rows.value.findIndex((r) => r.field.trim() === f) !== index
}
// The "named twice" message goes once nothing is named twice any more.
watch(duplicates, (twice) => {
  if (twice.size === 0 && errors.value.keys === t('indexes.namedTwice'))
    errors.value = { ...errors.value, keys: undefined }
})
// Its own rows only: another builder on the page numbers its rows alike (review of R3–R5, minor 7).
const rowList = ref<HTMLElement | null>(null)
/** What moving a field says to a screen reader (a polite live region). */
const moved = ref('')
async function moveRow(index: number, by: -1 | 1): Promise<void> {
  const to = index + by
  if (to < 0 || to >= rows.value.length) return
  const next = [...rows.value]
  ;[next[index], next[to]] = [next[to]!, next[index]!]
  rows.value = next
  const row = next[to]!
  moved.value = t('indexes.movedTo', { field: row.field.trim() || to + 1, n: to + 1 })
  // The keyboard stays with the field it moved: the same button, or its sibling at either end.
  await nextTick()
  const el = rowList.value?.querySelector(`[data-key-row="${row.id}"]`)
  const same = el?.querySelector<HTMLButtonElement>(`button[data-move="${by < 0 ? 'up' : 'down'}"]`)
  const other = el?.querySelector<HTMLButtonElement>(`button[data-move="${by < 0 ? 'down' : 'up'}"]`)
  ;(same && !same.disabled ? same : other)?.focus()
}
const moreId = useId()
const kindOptions = computed(() => KEY_KINDS.map((kind) => ({ value: kind, label: t(KIND_LABELS[kind]) })))
const KIND_LABELS: Record<KeyKind, string> = {
  '1': 'indexes.kindAsc',
  '-1': 'indexes.kindDesc',
  text: 'indexes.kindText',
  hashed: 'indexes.kindHashed',
  '2dsphere': 'indexes.kind2dsphere',
  '2d': 'indexes.kind2d',
}
function addRow(): void {
  rows.value.push(withId({ field: '', kind: '1' }))
}
function removeRow(index: number): void {
  rows.value.splice(index, 1)
  if (rows.value.length === 0) rows.value.push(withId({ field: '', kind: '1' }))
}
const name = ref('')
const unique = ref(false)
const sparse = ref(false)
const hidden = ref(false)
const ttl = ref('')
const partial = ref('')
const collation = ref('')
// Phase 4a-1: an assistant's suggestion arrives filled in; nothing is created until the user confirms.
{
  const o = props.initialOptions ? (decodeValue(props.initialOptions) as Record<string, unknown>) : {}
  if (typeof o.name === 'string') name.value = o.name
  if (o.unique === true) unique.value = true
  if (o.sparse === true) sparse.value = true
  if (o.hidden === true) hidden.value = true
  const seconds = Number(o.expireAfterSeconds)
  if (o.expireAfterSeconds !== undefined && Number.isFinite(seconds)) ttl.value = String(seconds)
  if (o.partialFilterExpression && typeof o.partialFilterExpression === 'object')
    partial.value = toShell(o.partialFilterExpression)
  if (o.collation && typeof o.collation === 'object') collation.value = toShell(o.collation)
}
const wildcard = ref('')
const weights = ref('')
const language = ref('')
// The less used options wait behind "More options", unless one is already filled in.
const more = ref(Boolean(ttl.value || partial.value || collation.value))
type Field = 'keys' | 'ttl' | 'partial' | 'collation' | 'wildcard' | 'weights' | 'language'
const errors = ref<Partial<Record<Field, string>>>({})
/** MongoDB's largest text index weight. */
const MAX_WEIGHT = 99999

const syntax = (e: unknown) =>
  e instanceof QueryParseError
    ? t('query.syntaxError', { line: e.line, column: e.column, message: e.message })
    : String(e)

function build(): CreateIndex | null {
  errors.value = {}
  let parsed: Record<string, unknown>
  try {
    parsed = parseQueryObject(keys.value)
  } catch (e) {
    errors.value.keys = syntax(e)
    return null
  }
  const key: Record<string, 1 | -1 | string> = {}
  for (const [field, raw] of Object.entries(parsed)) {
    const type = typeOf(raw)
    const n = type === 'int32' || type === 'double' ? Number((raw as { valueOf(): number }).valueOf()) : NaN
    if (n === 1 || n === -1) key[field] = n
    else if (typeof raw === 'string' && SPECIAL.has(raw)) key[field] = raw
    else {
      errors.value.keys = t('indexes.invalidKey', { example: KEY_EXAMPLE })
      return null
    }
  }
  if (Object.keys(key).length === 0) {
    errors.value.keys = t('indexes.invalidKey', { example: KEY_EXAMPLE })
    return null
  }
  const options: CreateIndex['options'] = {}
  if (name.value.trim()) options.name = name.value.trim()
  if (unique.value) options.unique = true
  if (sparse.value) options.sparse = true
  if (hidden.value) options.hidden = true
  if (ttl.value.trim()) {
    const seconds = Number(ttl.value.trim())
    if (!Number.isInteger(seconds) || seconds < 0) {
      errors.value.ttl = t('indexes.invalidTtl')
      return null
    }
    options.expireAfterSeconds = seconds
  }
  if (partial.value.trim()) {
    try {
      const filter = parseQueryObject(partial.value)
      if (Object.keys(filter).length > 0)
        options.partialFilterExpression = serializeValue(filter) as Record<string, unknown>
    } catch (e) {
      errors.value.partial = syntax(e)
      return null
    }
  }
  const parseDoc = (text: string, field: Field): Record<string, unknown> | null | undefined => {
    if (!text.trim()) return undefined
    try {
      return parseQueryObject(text)
    } catch (e) {
      errors.value[field] = syntax(e)
      return null
    }
  }
  const collationDoc = parseDoc(collation.value, 'collation')
  const wildcardDoc = parseDoc(wildcard.value, 'wildcard')
  const weightsDoc = parseDoc(weights.value, 'weights')
  if (collationDoc === null || wildcardDoc === null || weightsDoc === null) return null
  if (collationDoc && Object.keys(collationDoc).length > 0)
    options.collation = serializeValue(collationDoc) as Record<string, unknown>
  if (wildcardDoc && Object.keys(wildcardDoc).length > 0) {
    // Only a key with the all-fields wildcard ("$**", alone or compound) takes a projection;
    // MongoDB refuses one for a sub-path wildcard such as "a.$**".
    if (!Object.hasOwn(key, '$**')) {
      errors.value.wildcard = t('indexes.wildcardNeedsAll', { key: WILDCARD_KEY })
      return null
    }
    options.wildcardProjection = serializeValue(wildcardDoc) as Record<string, unknown>
  }
  const hasText = Object.values(key).includes('text')
  const lang = language.value.trim()
  const hasWeights = weightsDoc !== undefined && Object.keys(weightsDoc).length > 0
  if ((hasWeights || lang) && !hasText) {
    errors.value[hasWeights ? 'weights' : 'language'] = t('indexes.textOptionsNeedText')
    return null
  }
  if (hasWeights) {
    const parsed: Record<string, number> = {}
    for (const [field, raw] of Object.entries(weightsDoc!)) {
      const type = typeOf(raw)
      const n = type === 'int32' || type === 'double' ? Number((raw as { valueOf(): number }).valueOf()) : NaN
      if (!Number.isInteger(n) || n < 1 || n > MAX_WEIGHT) {
        errors.value.weights = t('indexes.invalidWeights', { max: MAX_WEIGHT })
        return null
      }
      parsed[field] = n
    }
    options.weights = parsed
  }
  if (lang) {
    if (lang.length > 64) {
      errors.value.language = t('indexes.invalidLanguage')
      return null
    }
    options.default_language = lang
  }
  return { key, options }
}

const { mutate: create, isPending } = useMutation({
  mutationFn: (body: CreateIndex) => documentsApi.createIndex(props.target, body),
  onMutate: reset,
  // The build runs on in the background (it can take hours): the indexes view follows it.
  onSuccess: ({ job }) => {
    jobs.upsert(job)
    toasts.push({ kind: 'info', message: t('indexes.buildStarted', { name: job.target }) })
    emit('close')
  },
  onError: showError,
})

function submit(): void {
  // Ctrl+Enter bypasses the disabled button: one create at a time.
  if (isPending.value) return
  // The rows say what is created: not while a field is named twice (the text cannot say that). It
  // says why, and takes the keyboard to the field named twice.
  if (rowsInSync.value && duplicates.value.size > 0) {
    errors.value = { keys: t('indexes.namedTwice') }
    const repeat = rows.value.find((_, i) => isRepeat(i))
    rowList.value?.querySelector<HTMLInputElement>(`[data-key-row="${repeat?.id}"] input`)?.focus()
    return
  }
  const body = build()
  // An error in a hidden option shows it.
  if (
    !body &&
    (errors.value.ttl ||
      errors.value.partial ||
      errors.value.collation ||
      errors.value.wildcard ||
      errors.value.weights ||
      errors.value.language)
  )
    more.value = true
  if (body) create(body)
}
</script>

<template>
  <DsDialog
    open
    :title="t('indexes.create')"
    :description="`${target.db}.${target.coll}`"
    size="lg"
    @close="emit('close')"
  >
    <div class="flex flex-col gap-5">
      <fieldset class="flex flex-col gap-2">
        <legend class="mb-2 text-small font-medium text-fg-muted">{{ t('indexes.fields') }}</legend>
        <ul v-if="rowsInSync" ref="rowList" class="flex flex-col gap-2">
          <li
            v-for="(row, i) in rows"
            :key="row.id"
            :data-key-row="row.id"
            class="grid grid-cols-[minmax(0,1fr)_minmax(7.5rem,11rem)_auto] items-start gap-2"
          >
            <DsInput
              v-model="row.field"
              :label="t('indexes.fieldN', { n: i + 1 })"
              hide-label
              mono
              :placeholder="t('indexes.fieldPlaceholder')"
              :error="isRepeat(i) ? t('indexes.duplicateField') : undefined"
              autocomplete="off"
            />
            <DsSelect
              v-model="row.kind"
              :label="t('indexes.kindN', { n: i + 1 })"
              hide-label
              :options="kindOptions"
            />
            <span class="flex items-center">
              <template v-if="rows.length > 1">
                <DsIconButton
                  data-move="up"
                  :icon="ArrowUp"
                  :label="t('indexes.moveUp', { n: i + 1 })"
                  :disabled="i === 0"
                  @click="moveRow(i, -1)"
                />
                <DsIconButton
                  data-move="down"
                  :icon="ArrowDown"
                  :label="t('indexes.moveDown', { n: i + 1 })"
                  :disabled="i === rows.length - 1"
                  @click="moveRow(i, 1)"
                />
              </template>
              <DsIconButton
                :icon="X"
                :label="t('indexes.removeField', { n: i + 1 })"
                :disabled="rows.length === 1 && !row.field"
                @click="removeRow(i)"
              />
            </span>
          </li>
        </ul>
        <p v-else class="rounded-lg bg-subtle px-3 py-2 text-small text-fg-muted">
          {{ t('indexes.keysAsText') }}
        </p>
        <p class="sr-only" aria-live="polite">{{ moved }}</p>
        <DsButton v-if="rowsInSync" class="self-start" size="sm" variant="ghost" :icon="Plus" @click="addRow">
          {{ t('indexes.addField') }}
        </DsButton>
        <DsCodeEditor
          v-model="keys"
          :label="t('indexes.keys')"
          :hint="t('indexes.keyHint')"
          :error="errors.keys"
          @submit="submit"
        />
      </fieldset>
      <DsInput v-model="name" :label="t('indexes.nameOptional')" autocomplete="off" mono />
      <div class="flex flex-wrap gap-x-6 gap-y-3">
        <DsCheckbox v-model="unique" :label="t('indexes.uniqueOption')" />
        <DsCheckbox v-model="sparse" :label="t('indexes.sparseOption')" />
        <DsCheckbox v-model="hidden" :label="t('indexes.hiddenOption')" />
      </div>
      <div class="border-t border-line pt-3">
        <button
          type="button"
          class="flex cursor-pointer items-center gap-1.5 rounded-md text-ui font-medium text-fg-muted hover:text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
          :aria-expanded="more"
          :aria-controls="moreId"
          @click="more = !more"
        >
          <ChevronDown
            class="size-4 transition-transform duration-160"
            :class="more ? '' : '-rotate-90'"
            aria-hidden="true"
          />
          {{ t('indexes.moreOptions') }}
        </button>
        <div v-show="more" :id="moreId" class="mt-4 flex flex-col gap-4">
          <DsInput
            v-model="ttl"
            :label="t('indexes.ttlOption')"
            inputmode="numeric"
            :error="errors.ttl"
            autocomplete="off"
          />
          <DsCodeEditor
            v-model="partial"
            :label="t('indexes.partialOption')"
            placeholder="{ active: true }"
            :error="errors.partial"
            @submit="submit"
          />
          <DsCodeEditor
            v-model="collation"
            :label="t('indexes.collationOption')"
            placeholder="{ locale: 'tr', strength: 2 }"
            :error="errors.collation"
            @submit="submit"
          />
          <DsCodeEditor
            v-model="wildcard"
            :label="t('indexes.wildcardOption')"
            :hint="t('indexes.wildcardHint', { key: WILDCARD_KEY })"
            placeholder="{ secret: 0 }"
            :error="errors.wildcard"
            @submit="submit"
          />
          <div class="grid gap-4 sm:grid-cols-[2fr_1fr]">
            <DsCodeEditor
              v-model="weights"
              :label="t('indexes.weightsOption')"
              placeholder="{ title: 10, body: 1 }"
              :error="errors.weights"
              @submit="submit"
            />
            <DsInput
              v-model="language"
              :label="t('indexes.languageOption')"
              placeholder="english"
              :error="errors.language"
              autocomplete="off"
            />
          </div>
        </div>
      </div>
      <DsFormErrors :messages="general" />
    </div>
    <template #footer>
      <DsButton @click="emit('close')">{{ t('common.cancel') }}</DsButton>
      <DsButton variant="primary" :loading="isPending" @click="submit">{{ t('collection.create') }}</DsButton>
    </template>
  </DsDialog>
</template>
