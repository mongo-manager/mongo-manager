<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { BellPlus, BellRing, FilePlus2, RotateCw, Zap } from 'lucide-vue-next'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsCard from '@/ds/DsCard.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsPageHeader from '@/ds/DsPageHeader.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import DsSwitch from '@/ds/DsSwitch.vue'
import { alertKeys, alertsApi } from '@/api/alerts'
import { connectionsApi, queryKeys } from '@/api/connections'
import { useSessionStore } from '@/stores/session'
import { useToastStore } from '@/stores/toasts'
import { adminErrorText } from '@/dbaccess/errors'
import EmailChannel from './EmailChannel.vue'
import WebhooksChannel from './WebhooksChannel.vue'
import RulesTable from './RulesTable.vue'
import RuleDialog from './RuleDialog.vue'
import AlertHistory from './AlertHistory.vue'
import ReportsTable from './ReportsTable.vue'

/**
 * W3.3: the Alerts page — whether the bell shows alerts to me (each user's own choice), and for
 * administrators the channels (e-mail, webhooks), the event rules of every connection, and the
 * history. A connection's thresholds are set on its own page (its Alerts section).
 */
const { t } = useI18n()
const session = useSessionStore()
const toasts = useToastStore()
const queryClient = useQueryClient()
const admin = computed(() => session.can('settings:manage'))
const optIn = useQuery({ queryKey: alertKeys.optIn, queryFn: alertsApi.optIn })
const channels = useQuery({ queryKey: alertKeys.channels, queryFn: alertsApi.channels, enabled: admin })
const rules = useQuery({ queryKey: alertKeys.rules(''), queryFn: () => alertsApi.rules(), enabled: admin })
const connections = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
const names = computed(() => Object.fromEntries((connections.data.value ?? []).map((c) => [c.id, c.name])))
const eventRules = computed(() => (rules.data.value ?? []).filter((r) => r.kind === 'event'))
const metricCount = computed(() => (rules.data.value ?? []).filter((r) => r.kind === 'metric').length)
const adding = ref(false)
/** Design 2026-10-25 (C7): the reports' table opens its own dialog. */
const reportsTable = ref<InstanceType<typeof ReportsTable> | null>(null)

async function setOptIn(on: boolean): Promise<void> {
  try {
    await alertsApi.setOptIn(on)
    await queryClient.invalidateQueries({ queryKey: alertKeys.optIn })
    await queryClient.invalidateQueries({ queryKey: alertKeys.active })
  } catch (e) {
    toasts.push({ kind: 'error', message: adminErrorText(e, t) })
  }
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <DsPageHeader :title="t('alerts.title')" :icon="BellRing" :description="t('alerts.subtitle')" />
    <div class="min-h-0 flex-1 overflow-auto">
      <div class="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 sm:p-6" data-alerts-page>
        <DsCallout v-if="optIn.data.value && !optIn.data.value.available" tone="warning">{{
          t('alerts.off')
        }}</DsCallout>
        <DsCard :title="t('alerts.mine.title')">
          <DsSkeleton v-if="optIn.isPending.value" class="h-10" />
          <DsSwitch
            v-else
            :model-value="optIn.data.value?.inApp ?? false"
            :label="t('alerts.mine.inApp')"
            :hint="t('alerts.mine.inAppHint')"
            data-alerts-opt-in
            @update:model-value="setOptIn"
          />
        </DsCard>
        <template v-if="admin">
          <DsCallout v-if="channels.isError.value" tone="danger">
            {{ adminErrorText(channels.error.value, t) }}
            <template #action>
              <DsButton size="sm" :icon="RotateCw" @click="channels.refetch()">{{
                t('common.retry')
              }}</DsButton>
            </template>
          </DsCallout>
          <div class="grid min-w-0 gap-4 xl:grid-cols-2">
            <DsCard :title="t('alerts.email.title')">
              <DsSkeleton v-if="channels.isPending.value" class="h-48" />
              <EmailChannel v-else :settings="channels.data.value?.email ?? null" />
            </DsCard>
            <DsCard :title="t('alerts.webhooks.title')" :count="channels.data.value?.webhooks.length">
              <DsSkeleton v-if="channels.isPending.value" class="h-48" />
              <WebhooksChannel v-else :webhooks="channels.data.value?.webhooks ?? []" />
            </DsCard>
          </div>
          <DsCard :title="t('alerts.rules.eventTitle')" :count="eventRules.length">
            <template #actions>
              <DsButton
                size="sm"
                variant="primary"
                :icon="BellPlus"
                data-add-event-rule
                @click="adding = true"
                >{{ t('alerts.rules.addEvent') }}</DsButton
              >
            </template>
            <p class="mb-3 text-small text-fg-subtle">
              {{ t('alerts.rules.eventIntro', { n: metricCount }) }}
            </p>
            <RulesTable
              :rules="eventRules"
              :loading="rules.isPending.value"
              :error="rules.isError.value ? adminErrorText(rules.error.value, t) : undefined"
              :label="t('alerts.rules.eventTitle')"
              :names="names"
            >
              <template #empty>
                <DsEmptyState
                  :icon="Zap"
                  :title="t('alerts.rules.noEventTitle')"
                  :description="t('alerts.rules.noEvent')"
                />
              </template>
            </RulesTable>
          </DsCard>
          <!-- Design 2026-10-25 (C7): scheduled reports, counts said on a cadence. -->
          <DsCard :title="t('alerts.reports.title')">
            <template #actions>
              <DsButton
                size="sm"
                variant="primary"
                :icon="FilePlus2"
                data-add-report
                @click="reportsTable?.add()"
                >{{ t('alerts.reports.add') }}</DsButton
              >
            </template>
            <p class="mb-3 text-small text-fg-subtle">{{ t('alerts.reports.intro') }}</p>
            <ReportsTable ref="reportsTable" :names="names" />
          </DsCard>
          <DsCard :title="t('alerts.history.title')">
            <AlertHistory />
          </DsCard>
        </template>
        <RuleDialog v-if="adding" kind="event" :connection-id="null" @close="adding = false" />
      </div>
    </div>
  </div>
</template>
