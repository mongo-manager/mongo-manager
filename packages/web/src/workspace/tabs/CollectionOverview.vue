<script lang="ts">
/** A view's definition, as listCollections gives it. */
export interface ViewOptions {
  viewOn?: string
  pipeline?: unknown[]
}
</script>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { CopyPlus, Eye, Table, Workflow } from 'lucide-vue-next'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsCard from '@/ds/DsCard.vue'
import DsCodeBlock from '@/ds/DsCodeBlock.vue'
import { useTabsStore } from '@/stores/tabs'
import { openCollectionTab } from '@/workspace/openTabs'
import { decodeValue, toShell } from '@/documents/values'
import { connectionsApi, queryKeys } from '@/api/connections'
import { describeError } from '@/api/errors'
import { formatBytes, formatCount } from '@/format'
import { useWorkspaceDialogs } from '@/stores/workspaceDialogs'
import StatGrid from './StatGrid.vue'
import BarChart from '@/charts/BarChart.vue'
import { documentKeys, documentsApi } from '@/api/documents'

const props = withDefaults(
  defineProps<{
    connectionId: string
    db: string
    coll: string
    /** Menu sweep 2026-10-08: a view has no size or indexes; it is shown by what it is. */
    view?: ViewOptions | null
    /** 2026-10-26: the collection's Personal data section is there to go to (its administrators). */
    canSeeRules?: boolean
  }>(),
  { view: null, canSeeRules: false },
)
/** W2.2: the view's pipeline, to edit in the aggregation builder (the tab opens it). */
const emit = defineEmits<{ editView: []; seeRules: [] }>()
const isView = computed(() => props.view !== null)
const tabs = useTabsStore()
const definition = computed(() => (props.view?.pipeline ? toShell(decodeValue(props.view.pipeline)) : '[]'))
const target = computed(() => ({ connectionId: props.connectionId, db: props.db, coll: props.coll }))
const viewCount = useQuery({
  queryKey: computed(() => documentKeys.count(target.value, {})),
  queryFn: () => documentsApi.count(target.value, {}, {}),
  enabled: isView,
})
const { t, locale } = useI18n()
const dialogs = useWorkspaceDialogs()

const { data: connections } = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
const canWrite = computed(
  () =>
    connections.value?.find((c) => c.id === props.connectionId)?.permissions.includes('databases:write') ??
    false,
)
const { data, isError, error } = useQuery({
  queryKey: computed(() => queryKeys.collectionStats(props.connectionId, props.db, props.coll)),
  queryFn: () => connectionsApi.collectionStats(props.connectionId, props.db, props.coll),
  enabled: computed(() => !isView.value),
})

const statItems = computed(() => {
  const s = data.value
  if (!s) return []
  const n = (v: number) => formatCount(v, locale.value)
  // A size hidden where personal data is hidden from you (it would tell what is hidden) says so.
  const b = (v: number | null) => (v === null ? t('overview.stats.hidden') : formatBytes(v, locale.value))
  return [
    { label: t('overview.stats.count'), value: n(s.count) },
    { label: t('overview.stats.dataSize'), value: b(s.size) },
    { label: t('overview.stats.storageSize'), value: b(s.storageSize) },
    { label: t('overview.stats.avgObjSize'), value: b(s.avgObjSize) },
    { label: t('overview.stats.indexes'), value: n(s.nindexes) },
    { label: t('overview.stats.indexSize'), value: b(s.totalIndexSize) },
    { label: t('overview.stats.capped'), value: s.capped ? t('overview.yes') : t('overview.no') },
  ]
})

// Phase 1i: charts. Index use comes from the indexes route ($indexStats), shared with the Indexes tab.
const indexes = useQuery({
  queryKey: computed(() =>
    documentKeys.indexes({ connectionId: props.connectionId, db: props.db, coll: props.coll }),
  ),
  queryFn: () => documentsApi.indexes({ connectionId: props.connectionId, db: props.db, coll: props.coll }),
  retry: false,
  enabled: computed(() => !isView.value),
})
const bytes = (v: number) => formatBytes(v, locale.value)
const sizeItems = computed(() => {
  const s = data.value
  if (!s || s.size === null || s.totalIndexSize === null) return []
  return [
    { label: t('overview.stats.dataSize'), value: s.size },
    { label: t('overview.stats.indexSize'), value: s.totalIndexSize },
  ]
})
const indexSizeItems = computed(() =>
  Object.entries(data.value?.indexSizes ?? {}).map(([label, value]) => ({ label, value })),
)
const usageItems = computed(() =>
  (indexes.data.value ?? []).filter((i) => i.usage).map((i) => ({ label: i.name, value: i.usage!.ops })),
)
</script>

<template>
  <section v-if="view" data-view-overview class="flex max-w-5xl flex-col gap-4 p-4">
    <div class="flex flex-col gap-4 rounded-card border border-line bg-surface p-4 shadow-xs">
      <div class="flex items-start gap-3">
        <span
          class="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-fg"
          aria-hidden="true"
        >
          <Eye class="size-[18px]" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="text-title-s font-semibold text-fg">
            {{
              view.viewOn ? t('overview.view.title', { source: view.viewOn }) : t('overview.view.titleBare')
            }}
          </p>
          <p class="mt-1 text-ui text-fg-muted">{{ t('overview.view.explain') }}</p>
          <p class="mt-2 text-ui text-fg tabular-nums">
            <template v-if="viewCount.data.value && viewCount.data.value.count !== null">{{
              t(
                'overview.view.documents',
                { n: formatCount(viewCount.data.value.count, locale) },
                viewCount.data.value.count,
              )
            }}</template>
            <span v-else-if="viewCount.isError.value" class="text-fg-subtle">{{
              t('overview.view.countFailed')
            }}</span>
          </p>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <DsButton
          v-if="view.viewOn"
          size="sm"
          variant="primary"
          :icon="Table"
          @click="openCollectionTab(tabs, connectionId, db, view.viewOn)"
        >
          {{ t('overview.view.open', { source: view.viewOn }) }}
        </DsButton>
        <template v-if="canWrite">
          <DsButton v-if="view.viewOn" size="sm" :icon="Workflow" data-edit-view @click="emit('editView')">
            {{ t('collection.view.edit') }}
          </DsButton>
          <DsButton
            size="sm"
            :icon="CopyPlus"
            @click="dialogs.open({ kind: 'duplicateCollection', connectionId, db, coll })"
          >
            {{ t('overview.view.duplicate') }}
          </DsButton>
        </template>
      </div>
    </div>
    <DsCard :title="t('overview.view.definition')">
      <!-- Not read yet (the list kept for its names after values were hidden): said, not shown as []. -->
      <p
        v-if="view && !view.pipeline && view.viewOn"
        class="text-ui text-fg-muted"
        data-view-definition-unread
      >
        {{ t('overview.view.definitionUnread') }}
      </p>
      <!-- Given by name only (a user who may list some collections): no read again will show it. -->
      <p v-else-if="view && !view.pipeline" class="text-ui text-fg-muted" data-view-definition-unavailable>
        {{ t('overview.view.definitionUnavailable') }}
      </p>
      <DsCodeBlock
        v-else
        :code="definition"
        :label="t('overview.view.definition')"
        :copy-label="t('overview.view.copyDefinition')"
      />
    </DsCard>
  </section>
  <section v-else class="flex max-w-6xl flex-col gap-4 p-4">
    <DsCallout v-if="isError" tone="danger">{{ describeError(error, t) }}</DsCallout>
    <StatGrid v-else :items="statItems" />
    <!-- Twelfth review of explain masking: said once, where the size charts would be. -->
    <p v-if="data?.sizesHidden" class="text-small text-fg-subtle" data-sizes-hidden>
      {{ t('overview.stats.sizesHidden') }}
      <button
        v-if="canSeeRules"
        type="button"
        class="cursor-pointer rounded-sm font-medium text-accent-fg hover:underline focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
        @click="emit('seeRules')"
      >
        {{ t('overview.stats.seeRules') }}
      </button>
    </p>
    <div v-if="data" class="grid gap-4 lg:grid-cols-3">
      <template v-if="!data.sizesHidden">
        <div class="rounded-card border border-line bg-surface p-4 shadow-xs">
          <BarChart :label="t('overview.charts.sizes')" :items="sizeItems" :format="bytes" />
        </div>
        <div class="rounded-card border border-line bg-surface p-4 shadow-xs">
          <BarChart :label="t('overview.charts.indexSizes')" :items="indexSizeItems" :format="bytes" />
        </div>
      </template>
      <div class="rounded-card border border-line bg-surface p-4 shadow-xs">
        <BarChart
          :label="t('overview.charts.indexUse')"
          :items="usageItems"
          :format="(v: number) => formatCount(v, locale)"
        />
      </div>
    </div>
  </section>
</template>
