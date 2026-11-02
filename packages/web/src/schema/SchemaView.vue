<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import MaskedBanner from '@/masking/MaskedBanner.vue'
import { provideMaskedPaths } from '@/masking/useMaskedPaths'
import { useQuery } from '@tanstack/vue-query'
import { ChevronRight, Copy, Download, Lock, RotateCw, ScanSearch } from 'lucide-vue-next'
import { copyName } from '@/workspace/copyName'
import type { FieldStats, SchemaType } from '@mongo-manager/shared'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsCard from '@/ds/DsCard.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsSelect from '@/ds/DsSelect.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import { documentKeys, documentsApi, type CollectionTarget } from '@/api/documents'
import { describeError } from '@/api/errors'
import { formatCount } from '@/format'
import { useCollectionViewsStore } from '@/stores/collectionViews'
import { useToastStore } from '@/stores/toasts'
import { buildQuery } from '@/documents/queryBuild'
import SchemaBars from './SchemaBars.vue'
import { addCondition, binCondition, queryPath, topCondition, typeCondition } from './conditions'

const SchemaExportDialog = defineAsyncComponent(() => import('./SchemaExportDialog.vue'))
// The map and its world outline load only when a field with places is opened.
const GeoMap = defineAsyncComponent(() => import('./geo/GeoMap.vue'))

/** A sampled schema analysis of one collection (phase 1i spec §5, §7), kept for the session. */
const props = defineProps<{
  target: CollectionTarget
  /** W2: the collection tab whose Documents filter a click on a value, range or area adds to. */
  tabId?: string
}>()

// W5 (spec 3c §7): the masking hint on every data screen, and the hidden paths for the locks.
const masking = provideMaskedPaths(
  computed(() => props.target.connectionId),
  computed(() => props.target.db),
  computed(() => props.target.coll),
)
const { t, locale } = useI18n()
const toasts = useToastStore()

const SIZES = [100, 1_000, 10_000] as const
const size = ref<number>(1_000)
const requested = ref(false)
/** The size of the last analysis asked for: choosing another size alone starts nothing. */
const analysed = ref<number>(1_000)
const exporting = ref(false)
const open = ref(new Set<string>())

const query = useQuery({
  queryKey: computed(() => documentKeys.schema(props.target, analysed.value)),
  // Leaving the tab cancels the request, and the server stops the analysis with it.
  queryFn: ({ signal }) => documentsApi.schema(props.target, analysed.value, signal),
  enabled: requested,
  staleTime: Infinity,
  retry: false,
})

function analyse(): void {
  if (requested.value && analysed.value === size.value) void query.refetch()
  analysed.value = size.value
  requested.value = true
}

const analysis = computed(() => query.data.value ?? null)
const percent = (n: number) => `${Math.round((n / Math.max(1, analysis.value?.sampled ?? 1)) * 100)}%`

/** "int 60%, string 40%": the types seen, most frequent first. */
function typeSplit(f: FieldStats): Array<{ type: SchemaType; share: number }> {
  const entries = Object.entries(f.types) as Array<[SchemaType, number]>
  const total = entries.reduce((n, [, c]) => n + c, 0) || 1
  return entries
    .map(([type, c]) => ({ type, share: Math.round((c / total) * 100) }))
    .sort((a, b) => b.share - a.share)
}

const typeText = (f: FieldStats) =>
  typeSplit(f)
    .map((p) => `${p.type} ${p.share}%`)
    .join(', ')

function toggle(path: string): void {
  const next = new Set(open.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  open.value = next
}

const n = (v: number) => formatCount(Math.round(v * 100) / 100, locale.value)
function histogram(f: FieldStats): Array<{ label: string; value: number; filterable: boolean }> {
  if (f.numbers) {
    const { min, max, bins } = f.numbers
    const step = (max - min) / bins.length
    return bins.map((value, i) => ({
      label: `${n(min + step * i)} – ${n(min + step * (i + 1))}`,
      value,
      filterable: true,
    }))
  }
  if (f.dates) {
    const min = Date.parse(f.dates.min)
    const step = (Date.parse(f.dates.max) - min) / f.dates.bins.length
    return f.dates.bins.map((value, i) => ({
      label: new Date(min + step * i).toLocaleDateString(locale.value),
      value,
      filterable: true,
    }))
  }
  return []
}
const topValues = (f: FieldStats) =>
  (f.top ?? []).map((v) => ({
    label: v.cut ? `${v.value}…` : v.value,
    value: v.count,
    filterable: topCondition(v) !== null,
  }))
const depth = (f: FieldStats) => f.keys.length - 1
/** A field's name as a query writes it: array elements are reached through the array's own name. */
const plainName = (f: FieldStats) => f.keys.filter((k): k is string => k !== null).join('.')

// ---- W2 (2026-10-16): click to filter — the condition goes into the tab's Documents filter, which runs.
const tab = computed(() => (props.tabId ? useCollectionViewsStore().stateFor(props.tabId) : null))
/** Where a click can filter: a tab to filter, and a path a query can name. */
const filterPath = (f: FieldStats) => (tab.value && !f.masked ? queryPath(f.keys) : null)
function addToFilter(f: FieldStats, condition: unknown): void {
  const state = tab.value
  const path = filterPath(f)
  if (!state || !path || condition === null) return
  const added = addCondition(state.draft.filter, path, condition)
  if ('error' in added) {
    toasts.push({ kind: 'error', message: t('schema.filter.fixFirst') })
    return
  }
  const draft = { ...state.draft, filter: added.text }
  const built = buildQuery(draft)
  if (!built.ok) {
    toasts.push({ kind: 'error', message: t('schema.filter.fixFirst') })
    return
  }
  state.draft = draft
  state.query = built.query
  state.page = 0
  state.section = 'documents'
}
/** W2 review (minor 13): a type as people say it, in their language ("Date", "Tarih"), not "date". */
const typeName = (type: SchemaType) => t(`schema.typeNames.${type}`)
const pickBin = (f: FieldStats, i: number) => addToFilter(f, binCondition(f, i))
function pickTop(f: FieldStats, i: number): void {
  const top = f.top?.[i]
  if (top) addToFilter(f, topCondition(top))
}
/** A map when most values with this field are places (one stray pair is not a map). */
const mapOf = (f: FieldStats) =>
  !f.masked && f.geo && f.geo.points.length > 0 && f.geo.count * 2 >= f.count ? f.geo : null
const geoKind = (geo: NonNullable<FieldStats['geo']>) =>
  geo.geojson === geo.count ? 'geojson' : geo.geojson === 0 ? 'legacy' : null

const sizeOptions = computed(() =>
  SIZES.map((s) => ({ value: String(s), label: t('schema.sampleOf', { n: formatCount(s, locale.value) }) })),
)
/** The select speaks text; the sample size is a number. */
const sizeText = computed({
  get: () => String(size.value),
  set: (text: string) => (size.value = Number(text)),
})
/** UI redesign R2 §3: each type drawn in its value colour (R1 §1.2), the rest neutral. */
const TYPE_COLOURS: Partial<Record<SchemaType, string>> = {
  string: 'bg-v-string',
  int: 'bg-v-number',
  long: 'bg-v-number',
  double: 'bg-v-number',
  decimal: 'bg-v-number',
  bool: 'bg-v-boolean',
  date: 'bg-v-date',
  timestamp: 'bg-v-date',
  objectId: 'bg-v-oid',
  null: 'bg-v-null',
}
const colourOf = (type: SchemaType) => TYPE_COLOURS[type] ?? 'bg-fg-subtle/50'
/** How often a field is there, 0–1 (an array's elements count their values, not documents). */
const presence = (f: FieldStats) => Math.min(1, f.count / Math.max(1, analysis.value?.sampled ?? 1))
</script>

<template>
  <section class="flex h-full min-h-0 flex-col gap-4 overflow-auto p-4">
    <MaskedBanner v-if="masking.hidden.value" />
    <DsCard :title="t('schema.title')" :count="analysis?.fields.length" actions-shown>
      <template #actions>
        <DsSelect
          v-model="sizeText"
          class="w-40"
          size="sm"
          hide-label
          :label="t('schema.sampleSize')"
          :options="sizeOptions"
        />
        <DsButton
          size="sm"
          variant="primary"
          :icon="ScanSearch"
          :loading="query.isFetching.value"
          @click="analyse()"
        >
          {{ t('schema.analyse') }}
        </DsButton>
        <DsButton v-if="analysis" size="sm" :icon="Download" @click="exporting = true">
          {{ t('schema.export') }}
        </DsButton>
      </template>
      <div class="flex flex-col gap-3">
        <p v-if="analysis" class="text-small text-fg-subtle">
          {{ t('schema.sampled', { n: formatCount(analysis.sampled, locale) }) }}
        </p>
        <DsCallout v-if="query.isError.value" tone="danger">
          {{ describeError(query.error.value, t) }}
          <template #action>
            <DsButton size="sm" :icon="RotateCw" @click="analyse()">{{ t('common.retry') }}</DsButton>
          </template>
        </DsCallout>
        <DsCallout v-if="analysis?.truncated" tone="warning">{{ t('schema.truncated') }}</DsCallout>
        <div v-if="!analysis && query.isFetching.value" class="flex flex-col gap-2" aria-hidden="true">
          <DsSkeleton v-for="i in 6" :key="i" class="h-7" />
        </div>
        <DsEmptyState
          v-else-if="!analysis && !query.isError.value"
          :icon="ScanSearch"
          :title="t('schema.emptyTitle')"
          :description="t('schema.intro')"
        />
        <div v-if="analysis" role="list" class="flex flex-col">
          <div
            class="grid grid-cols-[1.25rem_minmax(0,1fr)_9rem_minmax(0,16rem)] items-center gap-3 border-b border-line pb-2 text-small font-medium text-fg-subtle"
            aria-hidden="true"
          >
            <span />
            <span>{{ t('schema.field') }}</span>
            <span>{{ t('schema.presence') }}</span>
            <span>{{ t('schema.types') }}</span>
          </div>
          <div
            v-for="f in analysis.fields"
            :key="JSON.stringify(f.keys)"
            role="listitem"
            :data-field="f.path"
            class="border-b border-line"
          >
            <div
              class="grid min-h-8 grid-cols-[1.25rem_minmax(0,1fr)_9rem_minmax(0,16rem)] items-center gap-3 text-ui"
            >
              <button
                type="button"
                class="grid size-5 cursor-pointer place-items-center rounded text-fg-subtle hover:bg-subtle hover:text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
                :aria-expanded="open.has(f.path)"
                :aria-label="t('schema.details', { path: f.path })"
                @click="toggle(f.path)"
              >
                <ChevronRight
                  class="size-3.5 transition-transform duration-160"
                  :class="open.has(f.path) ? 'rotate-90' : ''"
                  aria-hidden="true"
                />
              </button>
              <span
                class="group/name flex min-w-0 items-center gap-1"
                :style="{ paddingLeft: `${depth(f) * 1}rem` }"
              >
                <span class="min-w-0 truncate font-mono text-[12.5px] text-fg" :title="f.path">{{
                  f.path
                }}</span>
                <!-- W1 (completion §2): the field's name as a query names it (items.sku, not items[].sku). -->
                <button
                  type="button"
                  data-copy-name
                  class="grid size-5 shrink-0 cursor-pointer place-items-center rounded text-fg-subtle opacity-0 group-hover/name:opacity-100 hover:bg-subtle hover:text-fg focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none pointer-coarse:opacity-100"
                  :aria-label="t('explorer.copyName.field', { name: plainName(f) })"
                  :title="t('explorer.copyName.field', { name: plainName(f) })"
                  @click="copyName(plainName(f), t)"
                >
                  <Copy class="size-3" aria-hidden="true" />
                </button>
              </span>
              <span class="flex items-center gap-2">
                <span class="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                  <span
                    class="block h-full rounded-full bg-accent"
                    :style="{ width: `${presence(f) * 100}%` }"
                  />
                </span>
                <span class="w-12 text-right text-small text-fg-muted tabular-nums">{{
                  f.keys.includes(null)
                    ? t('schema.values', { n: formatCount(f.count, locale) })
                    : percent(f.count)
                }}</span>
              </span>
              <span
                v-if="f.masked"
                data-schema-masked
                class="inline-flex min-w-0 items-center gap-1 truncate text-small text-fg-subtle"
              >
                <Lock class="size-3 shrink-0" aria-hidden="true" />{{ t('masking.schemaMasked') }}
              </span>
              <span v-else class="flex min-w-0 items-center gap-2">
                <span
                  class="flex h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted"
                  aria-hidden="true"
                >
                  <span
                    v-for="part in typeSplit(f)"
                    :key="part.type"
                    class="h-full"
                    :class="colourOf(part.type)"
                    :style="{ width: `${part.share}%` }"
                  />
                </span>
                <span class="truncate text-small text-fg-muted" :title="typeText(f)">{{ typeText(f) }}</span>
              </span>
            </div>
            <div v-if="open.has(f.path) && !f.masked" class="grid gap-3 pt-1 pb-3 pl-8 md:grid-cols-2">
              <div class="flex flex-wrap items-center gap-1.5 md:col-span-2">
                <span class="text-small text-fg-subtle">{{ t('schema.types') }}</span>
                <template v-for="part in typeSplit(f)" :key="part.type">
                  <button
                    v-if="filterPath(f) && typeCondition(part.type) !== null"
                    type="button"
                    data-schema-type
                    class="inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-full border border-line px-2 text-small text-fg-muted transition-colors duration-120 hover:border-accent/50 hover:bg-accent-soft hover:text-accent-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
                    :aria-label="t('schema.filter.addType', { type: typeName(part.type), path: f.path })"
                    :title="t('schema.filter.hint')"
                    @click="addToFilter(f, typeCondition(part.type))"
                  >
                    <span class="size-2 rounded-full" :class="colourOf(part.type)" aria-hidden="true" />
                    {{ typeName(part.type) }} {{ part.share }}%
                  </button>
                  <span
                    v-else
                    data-schema-type
                    class="inline-flex h-6 items-center gap-1.5 rounded-full border border-line px-2 text-small text-fg-muted"
                  >
                    <span class="size-2 rounded-full" :class="colourOf(part.type)" aria-hidden="true" />
                    {{ typeName(part.type) }} {{ part.share }}%
                  </span>
                </template>
              </div>
              <SchemaBars
                v-if="f.numbers || f.dates"
                :label="t('schema.histogram')"
                :items="histogram(f)"
                :can-filter="!!filterPath(f)"
                @pick="pickBin(f, $event)"
              />
              <SchemaBars
                v-if="f.top"
                :label="t('schema.topValues')"
                :items="topValues(f)"
                :can-filter="!!filterPath(f)"
                @pick="pickTop(f, $event)"
              />
              <GeoMap
                v-if="mapOf(f)"
                class="md:col-span-2"
                :path="f.path"
                :points="mapOf(f)!.points"
                :count="mapOf(f)!.count"
                :kind="geoKind(mapOf(f)!)"
                :can-filter="!!filterPath(f)"
                @filter="addToFilter(f, $event)"
              />
              <p v-if="f.arrays" class="text-small text-fg-muted">
                {{
                  t('schema.arrayLengths', {
                    min: f.arrays.minLength,
                    max: f.arrays.maxLength,
                    avg: n(f.arrays.avgLength),
                  })
                }}
              </p>
              <p
                v-if="!f.numbers && !f.dates && !f.top && !f.arrays && !mapOf(f)"
                class="text-small text-fg-subtle"
              >
                {{ t('schema.noDetails') }}
              </p>
            </div>
          </div>
        </div>
      </div>
    </DsCard>
    <SchemaExportDialog
      v-if="exporting && analysis"
      :analysis="analysis"
      :coll="target.coll"
      @close="exporting = false"
    />
  </section>
</template>
