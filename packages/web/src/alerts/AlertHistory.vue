<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { History, RotateCw } from 'lucide-vue-next'
import type { AlertView } from '@mongo-manager/shared/browser'
import DsBadge from '@/ds/DsBadge.vue'
import DsButton from '@/ds/DsButton.vue'
import DsDataTable from '@/ds/DsDataTable.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import type { DsColumn } from '@/ds/table'
import { alertKeys, alertsApi } from '@/api/alerts'
import { adminErrorText } from '@/dbaccess/errors'
import { reportCounts, alertTitle, deliveryError } from './labels'

/**
 * W3.3: what fired and what happened — each alert with when it started and ended, who acknowledged
 * it, and how each e-mail and webhook went (attempts, the reason a delivery failed).
 */
const props = defineProps<{ connectionId?: string }>()
const { t, locale } = useI18n()
const state = ref<'' | 'firing' | 'resolved' | 'event'>('')
const states = computed(() => [
  { value: '' as const, label: t('alerts.history.all') },
  { value: 'firing' as const, label: t('alerts.history.firing') },
  { value: 'resolved' as const, label: t('alerts.history.resolved') },
  { value: 'event' as const, label: t('alerts.history.events') },
])
const history = useQuery({
  queryKey: computed(() => alertKeys.history(`${props.connectionId ?? ''}:${state.value}`)),
  queryFn: () => alertsApi.history({ connectionId: props.connectionId, state: state.value, limit: 100 }),
  refetchInterval: 60_000,
})
const columns = computed<DsColumn[]>(() => [
  { key: 'alert', label: t('alerts.history.alert') },
  { key: 'when', label: t('alerts.history.when'), width: '13rem', hideBelow: 560 },
  { key: 'deliveries', label: t('alerts.history.deliveries'), width: '26%', hideBelow: 720 },
])
const date = (iso: string) =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
const stateTone = { firing: 'danger', resolved: 'success', event: 'info' } as const
</script>

<template>
  <div class="flex flex-col gap-3">
    <DsSegmented v-model="state" size="sm" :label="t('alerts.history.filter')" :options="states" />
    <DsDataTable
      :label="t('alerts.history.title')"
      :columns="columns"
      :rows="history.data.value ?? []"
      :row-key="(a: AlertView) => a.id"
      :loading="history.isPending.value"
      :loading-label="t('app.loading')"
      :error="history.isError.value ? adminErrorText(history.error.value, t) : undefined"
    >
      <template #cell-alert="{ row: a }">
        <span class="flex min-w-0 flex-col gap-1 py-1.5">
          <span class="flex flex-wrap items-center gap-1.5">
            <DsBadge :tone="stateTone[a.state as keyof typeof stateTone]">{{
              t(`alerts.states.${a.state}`)
            }}</DsBadge>
            <DsBadge v-if="a.snoozed" tone="warning">{{ t('alerts.rules.snoozedBadge') }}</DsBadge>
            <span class="text-fg">{{ alertTitle(t, locale, a) }}</span>
          </span>
          <!-- Review of C7a (M2): a report's counts by their labels, never its id. -->
          <span v-if="reportCounts(t, locale, a)" class="text-small text-fg" data-report-counts>{{
            reportCounts(t, locale, a)
          }}</span>
          <span
            v-else-if="Object.keys(a.detail).length"
            class="font-mono text-small break-all text-fg-subtle"
            >{{
              Object.entries(a.detail)
                .map(([k, v]) => `${k}: ${v}`)
                .join(' · ')
            }}</span
          >
          <span v-if="a.acknowledgedBy" class="text-small text-fg-subtle">{{
            t('alerts.history.acknowledgedBy', { user: a.acknowledgedBy })
          }}</span>
        </span>
      </template>
      <template #cell-when="{ row: a }">
        <span class="flex flex-col text-small text-fg-muted">
          <span>{{ date(a.startedAt) }}</span>
          <span v-if="a.resolvedAt" class="text-fg-subtle">{{
            t('alerts.history.until', { time: date(a.resolvedAt) })
          }}</span>
        </span>
      </template>
      <template #cell-deliveries="{ row: a }">
        <ul class="flex flex-col gap-0.5 py-1.5 text-small">
          <li v-for="(d, i) in a.deliveries" :key="i" :class="d.ok ? 'text-fg-muted' : 'text-danger'">
            {{
              d.ok
                ? t(
                    'alerts.history.sent',
                    { channel: d.target ?? t('alerts.channels.email'), n: d.attempts },
                    d.attempts,
                  )
                : t('alerts.history.failed', {
                    channel: d.target ?? t('alerts.channels.email'),
                    why: deliveryError(t, d.channel, d.error),
                  })
            }}
          </li>
          <li v-if="!a.deliveries.length" class="text-fg-subtle">{{ t('alerts.history.noDeliveries') }}</li>
        </ul>
      </template>
      <template #retry>
        <DsButton size="sm" :icon="RotateCw" @click="history.refetch()">{{ t('common.retry') }}</DsButton>
      </template>
      <template #empty>
        <DsEmptyState
          :icon="History"
          :title="t('alerts.history.emptyTitle')"
          :description="t('alerts.history.empty')"
        />
      </template>
    </DsDataTable>
  </div>
</template>
