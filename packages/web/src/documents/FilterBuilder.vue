<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ListFilter, Plus, TriangleAlert, X } from 'lucide-vue-next'
import { parseQueryObject } from '@mongo-manager/shared/browser'
import DsSegmented from '@/ds/DsSegmented.vue'
import DsButton from '@/ds/DsButton.vue'
import {
  FILTER_OPS,
  NO_VALUE,
  VALUE_TYPES,
  emptyCondition,
  fromFilter,
  toFilter,
  type Condition,
  type FilterGroup,
  type ValueType,
} from './filterModel'
import DsSelect from '@/ds/DsSelect.vue'

/**
 * UI redesign R1 review ("sorgu filtreleme alanı çok eksik ve basit"): the filter as conditions — a
 * field, a condition and a typed value per row, joined by All or Any — written into the filter text as
 * it changes, and read back from it. A filter it cannot show is never rewritten.
 */
const props = withDefaults(
  defineProps<{
    fields?: readonly string[]
    /** The kind of value a field holds on the page (sets a new condition's type). */
    types?: (path: string) => ValueType | undefined
    /** The values seen for a field, as shell literals. */
    values?: (path: string) => readonly string[]
  }>(),
  { fields: () => [], types: undefined, values: undefined },
)
const filter = defineModel<string>({ required: true })
const { t } = useI18n()
const uid = useId()

/** What the builder last wrote: a change from anywhere else is read again. */
let written: string | null = null
const group = ref<FilterGroup>({ mode: 'and', conditions: [] })
const unsupported = ref(false)
function read(text: string): void {
  if (text.trim() === '') {
    group.value = { mode: group.value.mode, conditions: [emptyCondition()] }
    unsupported.value = false
    return
  }
  let parsed: FilterGroup | null
  try {
    parsed = fromFilter(parseQueryObject(text) as Record<string, unknown>)
  } catch {
    parsed = null
  }
  unsupported.value = parsed === null
  if (parsed) group.value = parsed.conditions.length ? parsed : { ...parsed, conditions: [emptyCondition()] }
}
watch(
  filter,
  (text) => {
    if (text !== written) read(text)
  },
  { immediate: true },
)

// A value not yet typed is not an error yet; one of the wrong kind is.
// Reviewer B Minor 6: a condition whose value is not typed yet is left out, so the text keeps
// following the others; one with a wrong value holds the text back and says so.
const complete = (c: Condition) => NO_VALUE.has(c.op) || c.type === 'null' || c.value.trim() !== ''
const built = computed(() =>
  toFilter({ ...group.value, conditions: group.value.conditions.filter(complete) }),
)
const failure = computed(() => (built.value.ok ? null : built.value))
function write(): void {
  const out = built.value
  if (!out.ok || out.text === filter.value) return
  written = out.text
  filter.value = out.text
}

function setField(c: Condition, field: string): void {
  c.field = field
  const known = props.types?.(field.trim())
  if (known && c.op !== 'exists' && c.op !== 'missing') c.type = known
  write()
}
function setOp(c: Condition, op: Condition['op']): void {
  c.op = op
  if (op === 'contains' || op === 'starts' || op === 'ends') c.type = 'string'
  write()
}
function add(): void {
  group.value.conditions.push(emptyCondition())
}
function remove(index: number): void {
  group.value.conditions.splice(index, 1)
  if (group.value.conditions.length === 0) group.value.conditions.push(emptyCondition())
  write()
}
function startOver(): void {
  group.value = { mode: 'and', conditions: [emptyCondition()] }
  unsupported.value = false
}
const mode = computed({
  get: () => group.value.mode,
  set: (next: 'and' | 'or') => {
    group.value.mode = next
    write()
  },
})
const modes = computed(() => [
  { value: 'and' as const, label: t('query.builder.all') },
  { value: 'or' as const, label: t('query.builder.any') },
])
/** Suggestions for a value box: the seen values, as typed (strings without their quotes). */
function suggestions(c: Condition): string[] {
  const seen = props.values?.(c.field.trim()) ?? []
  return seen.map((v) => {
    if (!v.startsWith('"')) return v
    try {
      return JSON.parse(v) as string
    } catch {
      return v
    }
  })
}
const control =
  'h-8 w-full min-w-0 rounded-lg border bg-surface px-2.5 text-ui text-fg shadow-xs transition-[border-color,box-shadow] duration-120 placeholder:text-fg-subtle hover:border-fg-subtle/60 focus:ring-3 focus-visible:outline-none disabled:bg-subtle disabled:text-fg-subtle'
const ok = 'border-line-strong focus:border-focus focus:ring-focus/20'
const bad = 'border-danger focus:ring-danger/20'
</script>

<template>
  <section
    :aria-label="t('query.builder.label')"
    data-filter-builder
    class="flex flex-col gap-2.5 rounded-xl border border-line bg-subtle/60 p-3"
  >
    <div v-if="unsupported" role="status" class="flex flex-wrap items-center gap-2 text-ui text-fg-muted">
      <TriangleAlert class="size-4 shrink-0 text-warning" aria-hidden="true" />
      <p class="min-w-0 flex-1">{{ t('query.builder.unsupported') }}</p>
      <DsButton size="sm" @click="startOver">{{ t('query.builder.startOver') }}</DsButton>
    </div>
    <template v-else>
      <div class="flex flex-wrap items-center gap-2 text-small text-fg-muted">
        <ListFilter class="size-4 text-fg-subtle" aria-hidden="true" />
        <span>{{ t('query.builder.match') }}</span>
        <DsSegmented v-model="mode" size="sm" :label="t('query.builder.match')" :options="modes" />
        <span>{{ t('query.builder.ofThese') }}</span>
      </div>
      <datalist :id="`${uid}-fields`">
        <option v-for="f in fields" :key="f" :value="f" />
      </datalist>
      <ol class="flex flex-col gap-2">
        <li
          v-for="(c, i) in group.conditions"
          :key="c.id"
          class="grid grid-cols-2 items-start gap-2 sm:grid-cols-[minmax(9rem,1.1fr)_minmax(8.5rem,0.9fr)_minmax(9rem,1.4fr)_7.5rem_2rem]"
        >
          <div>
            <label :for="`${uid}-${c.id}-field`" class="sr-only">{{
              t('query.builder.field', { n: i + 1 })
            }}</label>
            <input
              :id="`${uid}-${c.id}-field`"
              :value="c.field"
              :list="`${uid}-fields`"
              :class="[control, ok, 'font-mono text-[12.5px]']"
              :placeholder="t('query.builder.fieldPlaceholder')"
              autocomplete="off"
              spellcheck="false"
              @input="setField(c, ($event.target as HTMLInputElement).value)"
            />
          </div>
          <DsSelect
            :model-value="c.op"
            hide-label
            :label="t('query.builder.condition', { n: i + 1 })"
            :options="FILTER_OPS.map((op) => ({ value: op, label: t(`query.builder.ops.${op}`) }))"
            @update:model-value="setOp(c, $event as Condition['op'])"
          />
          <div>
            <label :for="`${uid}-${c.id}-value`" class="sr-only">{{
              t('query.builder.value', { n: i + 1 })
            }}</label>
            <input
              :id="`${uid}-${c.id}-value`"
              v-model="c.value"
              :list="`${uid}-${c.id}-values`"
              :class="[control, failure?.id === c.id ? bad : ok]"
              :disabled="NO_VALUE.has(c.op) || c.type === 'null'"
              :placeholder="
                c.op === 'in' || c.op === 'nin'
                  ? t('query.builder.listPlaceholder')
                  : t(`query.builder.placeholders.${c.type}`)
              "
              :aria-invalid="failure?.id === c.id ? 'true' : undefined"
              :aria-describedby="failure?.id === c.id ? `${uid}-${c.id}-error` : undefined"
              autocomplete="off"
              @input="write"
            />
            <datalist :id="`${uid}-${c.id}-values`">
              <option v-for="v in suggestions(c)" :key="v" :value="v" />
            </datalist>
            <p v-if="failure?.id === c.id" :id="`${uid}-${c.id}-error`" class="mt-1 text-small text-danger">
              {{ t(`query.builder.invalid.${failure.reason}`) }} {{ t('query.builder.notApplied') }}
            </p>
          </div>
          <DsSelect
            v-model="c.type"
            hide-label
            :label="t('query.builder.type', { n: i + 1 })"
            :disabled="NO_VALUE.has(c.op)"
            :options="VALUE_TYPES.map((type) => ({ value: type, label: t(`query.builder.types.${type}`) }))"
            @update:model-value="write"
          />
          <button
            type="button"
            class="grid size-8 cursor-pointer place-items-center rounded-lg text-fg-subtle transition-colors duration-120 hover:bg-muted hover:text-fg"
            :aria-label="t('query.builder.remove', { n: i + 1 })"
            @click="remove(i)"
          >
            <X class="size-4" aria-hidden="true" />
          </button>
        </li>
      </ol>
      <div>
        <DsButton size="sm" variant="ghost" :icon="Plus" @click="add">{{ t('query.builder.add') }}</DsButton>
      </div>
    </template>
  </section>
</template>
