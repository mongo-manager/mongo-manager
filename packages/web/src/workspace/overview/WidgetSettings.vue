<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { METRICS, RANGES, type Metric, type Range } from '@mongo-manager/shared/browser'
import { connectionsApi, queryKeys } from '@/api/connections'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import DsSelect from '@/ds/DsSelect.vue'
import { useDashboardStore } from '@/stores/dashboard'
import type { WidgetDef } from './widgets/registry'
import KpiSettingsFields, { type KpiChoice } from './KpiSettingsFields.vue'

/**
 * User review 2026-10-09: a MongoDB widget's settings — the server it shows (only connections whose
 * server the user may watch: server:monitor) and, for a metric chart, the metric and the range. Asked
 * when the widget is added; changed later from its menu.
 */
const props = defineProps<{
  def: WidgetDef | null
  /** The widget's settings now; none when it is being added. */
  initial: Record<string, unknown> | null
  /** The widget whose settings these are; none when it is being added. */
  widgetId?: string | null
}>()
const emit = defineEmits<{ close: []; save: [settings: Record<string, unknown>] }>()
const { t } = useI18n()
const store = useDashboardStore()
const connections = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
const allowed = computed(() =>
  (connections.data.value ?? []).filter((c) =>
    c.permissions.includes(props.def?.permission ?? 'server:monitor'),
  ),
)
// User report 2026-10-27 ("aynı sunucu durumu Demo ekleyebiliyorum"): a server's widget is offered
// only for the servers without one (its own server stays its choice).
const watched = computed(() => {
  const def = props.def
  if (def?.settings !== 'connection') return allowed.value
  return allowed.value.filter(
    (c) => !store.shownBy({ type: def.type, settings: { connectionId: c.id } }, props.widgetId ?? undefined),
  )
})
const connectionId = ref('')
const metric = ref<Metric>('opcounters')
const range = ref<Range>('live')
const db = ref('')
watch(
  [() => props.def, () => props.initial, watched],
  () => {
    const initial = (props.initial ?? {}) as {
      connectionId?: string
      metric?: Metric
      range?: Range
      db?: string
    }
    const known = watched.value.some((c) => c.id === initial.connectionId)
    connectionId.value = known ? initial.connectionId! : (watched.value[0]?.id ?? '')
    metric.value = initial.metric ?? 'opcounters'
    range.value = initial.range ?? 'live'
    db.value = initial.db ?? ''
  },
  { immediate: true },
)
const adding = computed(() => props.initial === null)
// Widgets wave 2: a database of the server (index health), those with the widget already left out.
const databases = useQuery({
  queryKey: computed(() => queryKeys.databases(connectionId.value)),
  queryFn: () => connectionsApi.databases(connectionId.value),
  enabled: computed(() => props.def?.settings === 'database' && connectionId.value !== ''),
})
const databaseOptions = computed(() => {
  const def = props.def
  if (def?.settings !== 'database') return []
  return (databases.data.value?.databases ?? [])
    .map((d) => d.name)
    .filter(
      (name) =>
        !store.shownBy(
          { type: def.type, settings: { connectionId: connectionId.value, db: name } },
          props.widgetId ?? undefined,
        ),
    )
    .map((name) => ({ value: name, label: name }))
})
watch(databaseOptions, (options) => {
  if (props.def?.settings === 'database' && !options.some((o) => o.value === db.value))
    db.value = options[0]?.value ?? ''
})
/** A metric chart of this server, metric and range is on the dashboard already. */
const chartThere = computed(
  () =>
    props.def?.settings === 'metric' &&
    store.shownBy(
      {
        type: 'metric',
        settings: { connectionId: connectionId.value, metric: metric.value, range: range.value },
      },
      props.widgetId ?? undefined,
    ),
)
const options = computed(() => watched.value.map((c) => ({ value: c.id, label: c.name })))
const metrics = computed(() => METRICS.map((m) => ({ value: m, label: t(`overview.metrics.names.${m}`) })))
const ranges = computed(() => RANGES.map((r) => ({ value: r, label: t(`overview.metrics.rangeNames.${r}`) })))
// Widgets wave 2: a data KPI's collection, pipeline, display and refresh (null until all are chosen).
const kpi = ref<KpiChoice | null>(null)
const ready = computed(
  () =>
    !!connectionId.value &&
    !chartThere.value &&
    (props.def?.settings !== 'database' || !!db.value) &&
    (props.def?.settings !== 'pipeline' || kpi.value !== null),
)
function save(): void {
  if (!props.def || !ready.value) return
  emit(
    'save',
    props.def.settings === 'metric'
      ? { connectionId: connectionId.value, metric: metric.value, range: range.value }
      : props.def.settings === 'database'
        ? { connectionId: connectionId.value, db: db.value }
        : props.def.settings === 'pipeline'
          ? { connectionId: connectionId.value, ...kpi.value }
          : { connectionId: connectionId.value },
  )
}
</script>

<template>
  <DsDialog
    :open="def !== null"
    size="sm"
    :title="def ? t(def.title) : ''"
    :description="t('overview.dashboard.settingsDescription')"
    @close="emit('close')"
  >
    <form v-if="def" data-widget-settings class="flex flex-col gap-4" @submit.prevent="save">
      <p v-if="connections.data.value && !watched.length" role="status" class="text-ui text-fg-muted">
        {{ allowed.length ? t('overview.dashboard.everyServerHas') : t('overview.dashboard.noWatchable') }}
      </p>
      <template v-else>
        <DsSelect v-model="connectionId" :label="t('overview.dashboard.connection')" :options="options" />
        <template v-if="def.settings === 'database'">
          <DsSelect
            v-if="databaseOptions.length"
            v-model="db"
            :label="t('overview.dashboard.database')"
            :options="databaseOptions"
          />
          <p v-else-if="databases.data.value" role="status" class="text-ui text-fg-muted">
            {{ t('overview.dashboard.noDatabase') }}
          </p>
        </template>
        <KpiSettingsFields
          v-if="def.settings === 'pipeline' && connectionId"
          v-model="kpi"
          :type="def.type"
          :connection-id="connectionId"
          :initial="(initial as Partial<KpiChoice> | null) ?? null"
          :widget-id="widgetId ?? null"
        />
        <template v-if="def.settings === 'metric'">
          <DsSelect v-model="metric" :label="t('overview.dashboard.metric')" :options="metrics" />
          <DsSelect
            v-model="range"
            :label="t('overview.metrics.range')"
            :options="ranges"
            :error="chartThere ? t('overview.dashboard.chartThere') : undefined"
          />
        </template>
      </template>
      <div class="flex justify-end gap-2">
        <DsButton variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</DsButton>
        <DsButton variant="primary" type="submit" :disabled="!ready">
          {{ adding ? t('overview.dashboard.gallery.add') : t('common.save') }}
        </DsButton>
      </div>
    </form>
  </DsDialog>
</template>
