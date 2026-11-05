<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { alertKeys, alertsApi } from '@/api/alerts'
import { alertTitle } from '@/alerts/labels'
import DsSpinner from '@/ds/DsSpinner.vue'
import DsStatusDot from '@/ds/DsStatusDot.vue'
import { formatRelative } from '@/format'
import { useTabsStore } from '@/stores/tabs'
import { openAlertsTab } from '../../openTabs'
import WidgetError from './WidgetError.vue'
import WidgetFrame from './WidgetFrame.vue'
import WidgetLink from './WidgetLink.vue'
import { widgetError } from './errors'

/**
 * Widgets wave 2 (2026-10-27; Atlas's cluster alert badges, Datadog's monitors): the alerts firing now
 * that the user's bell shows — the server already keeps to those they may see and have not
 * dismissed. Alerts turned off, or the bell off for the user, is said.
 */
const { t, locale } = useI18n()
const tabs = useTabsStore()
const optIn = useQuery({ queryKey: alertKeys.optIn, queryFn: alertsApi.optIn })
const active = useQuery({
  queryKey: alertKeys.active,
  queryFn: alertsApi.active,
  refetchInterval: 30_000,
  refetchIntervalInBackground: false,
  retry: false,
})
const firing = computed(() =>
  (active.data.value ?? [])
    .filter((a) => a.state === 'firing')
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, 6),
)
const off = computed<'alerts' | 'bell' | null>(() => {
  if (!optIn.data.value) return null
  if (!optIn.data.value.available) return 'alerts'
  return optIn.data.value.inApp ? null : 'bell'
})
const since = (at: string) => formatRelative(Date.parse(at) - Date.now(), locale.value)
</script>

<template>
  <WidgetFrame :title="t('overview.widgets.alerts.title')" :count="firing.length || undefined">
    <div class="flex flex-col gap-2">
      <div
        v-if="optIn.isPending.value || active.isPending.value"
        class="flex items-center gap-2 py-2 text-ui text-fg-subtle"
      >
        <DsSpinner :size="14" />{{ t('overview.status.waiting') }}
      </div>
      <p v-else-if="off" class="py-1 text-small text-fg-subtle">{{ t(`overview.alerts.off.${off}`) }}</p>
      <WidgetError
        v-else-if="active.isError.value"
        :text="t(`overview.errors.${widgetError(active.error.value)}`)"
        :retry="() => void active.refetch()"
      />
      <p v-else-if="!firing.length" class="py-1 text-small text-fg-subtle">{{ t('overview.alerts.none') }}</p>
      <ul v-else class="-mx-1 flex flex-col">
        <li
          v-for="a in firing"
          :key="a.id"
          data-alert
          class="flex min-w-0 items-center gap-2.5 rounded-lg px-1 py-1.5"
        >
          <DsStatusDot state="error" :label="t('overview.alerts.firing')" />
          <span class="min-w-0 flex-1 truncate text-small text-fg">{{ alertTitle(t, locale, a) }}</span>
          <span class="shrink-0 text-caption text-fg-subtle">{{ since(a.startedAt) }}</span>
        </li>
      </ul>
      <WidgetLink @open="openAlertsTab(tabs)">{{ t('overview.alerts.seeAll') }}</WidgetLink>
    </div>
  </WidgetFrame>
</template>
