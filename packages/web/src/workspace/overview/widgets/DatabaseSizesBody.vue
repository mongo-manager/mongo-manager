<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import WidgetError from './WidgetError.vue'
import { widgetError } from './errors'
import { connectionsApi, queryKeys } from '@/api/connections'
import BarChart from '@/charts/BarChart.vue'
import DsSpinner from '@/ds/DsSpinner.vue'
import { formatBytes } from '@/format'

/** User review 2026-10-09: how much room each database of a connection takes on disk, as bars. */
const props = defineProps<{ connectionId: string }>()
const { t, locale } = useI18n()
const databases = useQuery({
  queryKey: computed(() => queryKeys.databases(props.connectionId)),
  queryFn: () => connectionsApi.databases(props.connectionId),
  refetchInterval: 300_000,
})
// A database whose size is hidden from you is left out of the chart.
const items = computed(() =>
  (databases.data.value?.databases ?? [])
    .flatMap((d) => (d.sizeOnDisk === null ? [] : [{ label: d.name, value: d.sizeOnDisk }]))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10),
)
const total = computed(() => databases.data.value?.totalSize ?? null)
/** Databases whose size is hidden from you: named in words, not drawn. */
const hidden = computed(
  () => (databases.data.value?.databases ?? []).filter((d) => d.sizeOnDisk === null).length,
)
const bytes = (v: number) => formatBytes(v, locale.value)
</script>

<template>
  <div class="flex flex-col gap-2">
    <div v-if="databases.isPending.value" class="flex items-center gap-2 py-2 text-ui text-fg-subtle">
      <DsSpinner :size="14" />{{ t('overview.status.waiting') }}
    </div>
    <WidgetError
      v-else-if="databases.isError.value"
      :text="t(`overview.errors.${widgetError(databases.error.value)}`)"
      :retry="() => void databases.refetch()"
    />
    <template v-else>
      <p v-if="total !== null" class="text-small text-fg-subtle">
        {{ t('overview.sizes.total', { size: bytes(total) }) }}
      </p>
      <BarChart
        v-if="items.length || !hidden"
        :label="t('overview.widgets.databaseSizes.title')"
        :items="items"
        :format="bytes"
      />
      <p v-if="hidden" class="text-small text-fg-subtle">
        {{ t('overview.sizes.someHidden', { n: hidden }, hidden) }}
      </p>
    </template>
  </div>
</template>
