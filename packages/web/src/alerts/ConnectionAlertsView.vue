<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { BellPlus, Gauge, Zap } from 'lucide-vue-next'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsCard from '@/ds/DsCard.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import { alertKeys, alertsApi } from '@/api/alerts'
import { useTabsStore } from '@/stores/tabs'
import { openAlertsTab } from '@/workspace/openTabs'
import { adminErrorText } from '@/dbaccess/errors'
import RulesTable from './RulesTable.vue'
import RuleDialog from './RuleDialog.vue'
import AlertHistory from './AlertHistory.vue'

/**
 * W3.3: a connection's alerts, for administrators — thresholds on its server's metrics, the app's
 * events on it, and what fired. Channels (e-mail, webhooks) are set once, on the Alerts page.
 */
const props = defineProps<{ connectionId: string; connectionName: string }>()
const { t } = useI18n()
const tabs = useTabsStore()
const rules = useQuery({
  queryKey: computed(() => alertKeys.rules(props.connectionId)),
  queryFn: () => alertsApi.rules(props.connectionId),
  refetchInterval: 60_000,
})
const optIn = useQuery({ queryKey: alertKeys.optIn, queryFn: alertsApi.optIn })
const metricRules = computed(() => (rules.data.value ?? []).filter((r) => r.kind === 'metric'))
const eventRules = computed(() => (rules.data.value ?? []).filter((r) => r.kind === 'event'))
const adding = ref<'metric' | 'event' | null>(null)
const error = computed(() => (rules.isError.value ? adminErrorText(rules.error.value, t) : undefined))
const names = computed(() => ({ [props.connectionId]: props.connectionName }))
</script>

<template>
  <section class="flex max-w-6xl flex-col gap-4 p-4" data-connection-alerts>
    <DsCallout v-if="optIn.data.value && !optIn.data.value.available" tone="warning">{{
      t('alerts.off')
    }}</DsCallout>
    <DsCallout v-else-if="optIn.data.value && !optIn.data.value.inApp" tone="info">
      {{ t('alerts.optInHint') }}
      <template #action>
        <DsButton size="sm" @click="openAlertsTab(tabs)">{{ t('alerts.openPage') }}</DsButton>
      </template>
    </DsCallout>
    <DsCard :title="t('alerts.rules.metricTitle')" :count="metricRules.length">
      <template #actions>
        <DsButton
          size="sm"
          variant="primary"
          :icon="BellPlus"
          data-add-metric-rule
          @click="adding = 'metric'"
          >{{ t('alerts.rules.addMetric') }}</DsButton
        >
      </template>
      <p class="mb-3 text-small text-fg-subtle">{{ t('alerts.rules.metricIntro') }}</p>
      <RulesTable
        :rules="metricRules"
        :loading="rules.isPending.value"
        :error="error"
        :label="t('alerts.rules.metricTitle')"
        :names="names"
      >
        <template #empty>
          <DsEmptyState
            :icon="Gauge"
            :title="t('alerts.rules.noMetricTitle')"
            :description="t('alerts.rules.noMetric')"
          />
        </template>
      </RulesTable>
    </DsCard>
    <DsCard :title="t('alerts.rules.eventTitle')" :count="eventRules.length">
      <template #actions>
        <DsButton size="sm" :icon="BellPlus" @click="adding = 'event'">{{
          t('alerts.rules.addEvent')
        }}</DsButton>
      </template>
      <RulesTable
        :rules="eventRules"
        :loading="rules.isPending.value"
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
    <DsCard :title="t('alerts.history.title')">
      <AlertHistory :connection-id="connectionId" />
    </DsCard>
    <RuleDialog v-if="adding" :kind="adding" :connection-id="connectionId" @close="adding = null" />
  </section>
</template>
