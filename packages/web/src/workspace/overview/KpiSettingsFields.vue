<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { KPI_DISPLAYS, KPI_REFRESHES, type KpiRefresh, type WidgetType } from '@mongo-manager/shared/browser'
import { connectionsApi, queryKeys } from '@/api/connections'
import { aggregateApi, aggregateKeys } from '@/api/aggregate'
import DsSelect from '@/ds/DsSelect.vue'
import { useDashboardStore } from '@/stores/dashboard'

/** What a data KPI shows: a collection's saved pipeline, how, and how often it runs again. */
export interface KpiChoice {
  db: string
  coll: string
  pipelineId: string
  display: (typeof KPI_DISPLAYS)[number]
  refresh: KpiRefresh
}

/**
 * Widgets wave 2 (2026-10-27): a data KPI's settings past its server — database, collection, one of
 * the collection's saved pipelines (those already shown that way left out), display and refresh. The
 * choice is null until every one is made.
 */
const props = defineProps<{
  type: WidgetType
  connectionId: string
  initial: Partial<KpiChoice> | null
  widgetId?: string | null
}>()
const choice = defineModel<KpiChoice | null>({ required: true })
const { t } = useI18n()
const store = useDashboardStore()
const db = ref('')
const coll = ref('')
const pipelineId = ref('')
const display = ref<KpiChoice['display']>('number')
const refresh = ref<KpiRefresh>('manual')
watch(
  () => props.initial,
  (initial) => {
    db.value = initial?.db ?? ''
    coll.value = initial?.coll ?? ''
    pipelineId.value = initial?.pipelineId ?? ''
    display.value = initial?.display ?? 'number'
    refresh.value = initial?.refresh ?? 'manual'
  },
  { immediate: true },
)
const databases = useQuery({
  queryKey: computed(() => queryKeys.databases(props.connectionId)),
  queryFn: () => connectionsApi.databases(props.connectionId),
  enabled: computed(() => props.connectionId !== ''),
})
const collections = useQuery({
  queryKey: computed(() => queryKeys.collections(props.connectionId, db.value)),
  queryFn: () => connectionsApi.collections(props.connectionId, db.value),
  enabled: computed(() => props.connectionId !== '' && db.value !== ''),
})
const target = computed(() => ({ connectionId: props.connectionId, db: db.value, coll: coll.value }))
const pipelines = useQuery({
  queryKey: computed(() => aggregateKeys.pipelines(target.value)),
  queryFn: () => aggregateApi.pipelines.list(target.value),
  enabled: computed(() => props.connectionId !== '' && db.value !== '' && coll.value !== ''),
})
const named = (names: string[]) => names.map((n) => ({ value: n, label: n }))
const databaseOptions = computed(() => named((databases.data.value?.databases ?? []).map((d) => d.name)))
const collectionOptions = computed(() => named((collections.data.value ?? []).map((c) => c.name)))
/** A pipeline already shown this way on the Overview (a widget is there once). */
const shown = (id: string, how: KpiChoice['display']) =>
  store.shownBy(
    {
      type: props.type,
      settings: {
        connectionId: props.connectionId,
        db: db.value,
        coll: coll.value,
        pipelineId: id,
        display: how,
      },
    },
    props.widgetId ?? undefined,
  )
// Review of wave 2 (M7): every pipeline is listed; one shown this way already is said, and never
// switched quietly for another when the display changes.
const pipelineOptions = computed(() =>
  (pipelines.data.value?.pipelines ?? []).map((p) => ({ value: p.id, label: p.name })),
)
const taken = computed(() => pipelineId.value !== '' && shown(pipelineId.value, display.value))
const displays = computed(() =>
  KPI_DISPLAYS.map((d) => ({ value: d, label: t(`overview.kpi.displays.${d}`) })),
)
const refreshes = computed(() =>
  KPI_REFRESHES.map((r) => ({ value: r, label: t(`overview.kpi.refreshes.${r}`) })),
)
/**
 * A choice no longer offered (another server, another collection) falls to the first one that is —
 * at once when the list is already known (review of wave 2, M7: read before, by the sidebar).
 */
const keep = (value: { value: string }, options: Array<{ value: string }>, set: (v: string) => void) => {
  if (!options.some((o) => o.value === value.value)) set(options[0]?.value ?? '')
}
watch(databaseOptions, (o) => keep(db, o, (v) => (db.value = v)), { immediate: true })
watch(collectionOptions, (o) => keep(coll, o, (v) => (coll.value = v)), { immediate: true })
// A new pipeline choice starts on the first one not shown this way yet.
watch(
  pipelineOptions,
  (o) => {
    if (o.some((x) => x.value === pipelineId.value)) return
    pipelineId.value = (o.find((x) => !shown(x.value, display.value)) ?? o[0])?.value ?? ''
  },
  { immediate: true },
)
watch(
  [db, coll, pipelineId, display, refresh, pipelineOptions, taken],
  () => {
    const offered = pipelineOptions.value.some((o) => o.value === pipelineId.value)
    choice.value =
      db.value && coll.value && pipelineId.value && offered && !taken.value
        ? {
            db: db.value,
            coll: coll.value,
            pipelineId: pipelineId.value,
            display: display.value,
            refresh: refresh.value,
          }
        : null
  },
  { immediate: true },
)
</script>

<template>
  <DsSelect
    v-if="databaseOptions.length"
    v-model="db"
    :label="t('overview.dashboard.database')"
    :options="databaseOptions"
  />
  <template v-if="db">
    <DsSelect
      v-if="collectionOptions.length"
      v-model="coll"
      :label="t('overview.kpi.collection')"
      :options="collectionOptions"
    />
    <p v-else-if="collections.data.value" role="status" class="text-ui text-fg-muted">
      {{ t('overview.kpi.noCollection') }}
    </p>
  </template>
  <template v-if="coll">
    <DsSelect
      v-if="pipelineOptions.length"
      v-model="pipelineId"
      :label="t('overview.kpi.pipeline')"
      :options="pipelineOptions"
      :error="taken ? t('overview.kpi.taken') : undefined"
    />
    <p v-else-if="pipelines.data.value" role="status" class="text-ui text-fg-muted">
      {{ t('overview.kpi.noPipeline') }}
    </p>
  </template>
  <DsSelect v-model="display" :label="t('overview.kpi.display')" :options="displays" />
  <DsSelect
    v-model="refresh"
    :label="t('overview.kpi.refreshEvery')"
    :options="refreshes"
    :hint="t('overview.kpi.refreshHint')"
  />
</template>
