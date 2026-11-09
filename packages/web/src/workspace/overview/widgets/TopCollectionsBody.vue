<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import WidgetError from './WidgetError.vue'
import { widgetError } from './errors'
import { serverApi, serverKeys } from '@/api/server'
import BarChart from '@/charts/BarChart.vue'
import DsSpinner from '@/ds/DsSpinner.vue'

/** User review 2026-10-09: the collections a server spends its time on (since it started), as bars. */
const props = defineProps<{ connectionId: string }>()
const { t, locale } = useI18n()
const top = useQuery({
  queryKey: computed(() => serverKeys.top(props.connectionId)),
  queryFn: () => serverApi.top(props.connectionId),
  refetchInterval: 30_000,
})
const items = computed(() =>
  (top.data.value?.collections ?? []).slice(0, 8).map((c) => ({ label: c.ns, value: c.totalMs })),
)
const ms = (v: number) => t('overview.top.ms', { n: new Intl.NumberFormat(locale.value).format(v) })
</script>

<template>
  <div class="flex flex-col gap-2">
    <div v-if="top.isPending.value" class="flex items-center gap-2 py-2 text-ui text-fg-subtle">
      <DsSpinner :size="14" />{{ t('overview.status.waiting') }}
    </div>
    <WidgetError
      v-else-if="top.isError.value"
      :text="t(`overview.errors.${widgetError(top.error.value)}`)"
      :retry="() => void top.refetch()"
    />
    <p v-else-if="!items.length" class="py-1 text-small text-fg-subtle">{{ t('overview.top.none') }}</p>
    <BarChart v-else :label="t('overview.widgets.topCollections.title')" :items="items" :format="ms" />
  </div>
</template>
