<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import {
  ALERT_CLEAR_RATIO,
  RULE_EVENTS,
  ALERT_METRICS,
  ALERT_UNITS,
  type RuleEvent,
  type AlertMetric,
  type AlertRuleView,
} from '@mongo-manager/shared/browser'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import DsInput from '@/ds/DsInput.vue'
import DsSelect from '@/ds/DsSelect.vue'
import { alertKeys, alertsApi } from '@/api/alerts'
import { useToastStore } from '@/stores/toasts'
import { adminErrorText } from '@/dbaccess/errors'
import { formatMetric } from './labels'

/**
 * W3.3: a rule — a metric of one connection above a threshold for so many minutes, or one of the
 * app's events (on one connection, or any) — and where it is sent: the bell, e-mail, webhooks.
 */
const props = defineProps<{
  kind: 'metric' | 'event'
  /** A metric rule's connection; an event rule's, or null for every connection. */
  connectionId: string | null
  existing?: AlertRuleView
}>()
const emit = defineEmits<{ close: [] }>()
const { t, locale } = useI18n()
const toasts = useToastStore()
const queryClient = useQueryClient()
const channels = useQuery({ queryKey: alertKeys.channels, queryFn: alertsApi.channels })

const DEFAULTS: Record<AlertMetric, number> = {
  connections: 500,
  opcounters: 5000,
  replicationLag: 30,
  cacheFill: 95,
  diskUse: 90,
  slowOps: 5,
}
const metric = ref<AlertMetric>(props.existing?.metric ?? 'connections')
const event = ref<RuleEvent>((props.existing?.event as RuleEvent | null) ?? 'backup.failed')
const threshold = ref(String(props.existing?.threshold ?? DEFAULTS[metric.value]))
const seconds = ref(String(props.existing?.slowOpSeconds ?? 10))
const sustain = ref(String(props.existing?.sustain ?? 2))
const inApp = ref(props.existing?.channels.inApp ?? true)
const email = ref(props.existing?.channels.email ?? false)
const webhooks = ref<string[]>([...(props.existing?.channels.webhooks ?? [])])
const errors = ref<string[]>([])
const saving = ref(false)

const metricOptions = computed(() =>
  ALERT_METRICS.map((m) => ({ value: m, label: t(`alerts.metrics.${m}`) })),
)
const eventOptions = computed(() => RULE_EVENTS.map((e) => ({ value: e, label: t(`alerts.events.${e}`) })))
const sustainOptions = computed(() =>
  [1, 2, 3, 5, 10, 15, 30].map((n) => ({
    value: String(n),
    label: t('alerts.rules.sustainOption', { n }, n),
  })),
)
function pickMetric(m: AlertMetric): void {
  metric.value = m
  if (!props.existing) threshold.value = String(DEFAULTS[m])
}
const unitWord = computed(() => t(`alerts.unitWords.${ALERT_UNITS[metric.value]}`))
const clearAt = computed(() => {
  const n = Number(threshold.value)
  return Number.isFinite(n) ? formatMetric(t, locale.value, metric.value, n * ALERT_CLEAR_RATIO) : '—'
})
const smtpReady = computed(() => !!channels.data.value?.email?.enabled)
const title = computed(() =>
  props.existing
    ? t('alerts.rules.editTitle')
    : props.kind === 'metric'
      ? t('alerts.rules.addMetric')
      : t('alerts.rules.addEvent'),
)
function toggleHook(id: string, on: boolean): void {
  webhooks.value = on ? [...webhooks.value, id] : webhooks.value.filter((w) => w !== id)
}

async function save(): Promise<void> {
  errors.value = []
  const n = Number(threshold.value)
  if (props.kind === 'metric' && (!Number.isFinite(n) || n < 0))
    errors.value.push(t('alerts.rules.thresholdInvalid'))
  const s = Number(seconds.value)
  if (props.kind === 'metric' && metric.value === 'slowOps' && (!Number.isInteger(s) || s < 1))
    errors.value.push(t('alerts.rules.secondsInvalid'))
  if (errors.value.length || saving.value) return
  saving.value = true
  const chosen = { inApp: inApp.value, email: email.value, webhooks: webhooks.value }
  try {
    if (props.existing)
      await alertsApi.patchRule(props.existing.id, {
        ...(props.kind === 'metric'
          ? {
              threshold: n,
              sustain: Number(sustain.value),
              ...(metric.value === 'slowOps' ? { slowOpSeconds: s } : {}),
            }
          : {}),
        channels: chosen,
      })
    else if (props.kind === 'metric')
      await alertsApi.createRule({
        kind: 'metric',
        connectionId: props.connectionId!,
        metric: metric.value,
        threshold: n,
        sustain: Number(sustain.value),
        ...(metric.value === 'slowOps' ? { slowOpSeconds: s } : {}),
        enabled: true,
        channels: chosen,
      })
    else
      await alertsApi.createRule({
        kind: 'event',
        connectionId: props.connectionId,
        event: event.value,
        enabled: true,
        channels: chosen,
      })
    await queryClient.invalidateQueries({ queryKey: alertKeys.all })
    toasts.push({ kind: 'success', message: t('alerts.rules.saved') })
    emit('close')
  } catch (e) {
    errors.value = [adminErrorText(e, t)]
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <DsDialog open :title="title" size="md" @close="emit('close')">
    <form class="flex flex-col gap-4" data-rule-dialog @submit.prevent="save">
      <DsFormErrors :messages="errors" />
      <template v-if="kind === 'metric'">
        <DsSelect
          :model-value="metric"
          :label="t('alerts.rules.metric')"
          :options="metricOptions"
          :disabled="!!existing"
          :hint="t(`alerts.metricHelp.${metric}`)"
          @update:model-value="pickMetric($event as AlertMetric)"
        />
        <div class="grid gap-3 sm:grid-cols-2">
          <DsInput
            v-model="threshold"
            inputmode="decimal"
            :label="t('alerts.rules.threshold', { unit: unitWord })"
            :hint="t('alerts.rules.clearsAt', { value: clearAt })"
          />
          <DsSelect v-model="sustain" :label="t('alerts.rules.sustain')" :options="sustainOptions" />
        </div>
        <DsInput
          v-if="metric === 'slowOps'"
          v-model="seconds"
          class="max-w-48"
          inputmode="numeric"
          :label="t('alerts.rules.slowSeconds')"
        />
      </template>
      <DsSelect
        v-else
        v-model="event"
        :label="t('alerts.rules.event')"
        :options="eventOptions"
        :disabled="!!existing"
      />
      <fieldset class="flex flex-col gap-2">
        <legend class="mb-1 text-small font-medium text-fg-muted">{{ t('alerts.rules.channels') }}</legend>
        <DsCheckbox
          v-model="inApp"
          :label="t('alerts.channels.inApp')"
          :hint="t('alerts.channels.inAppHint')"
        />
        <DsCheckbox
          v-model="email"
          :label="t('alerts.channels.email')"
          :disabled="!smtpReady && !email"
          :hint="
            smtpReady ? channels.data.value?.email?.recipients.join(', ') : t('alerts.channels.emailOff')
          "
        />
        <DsCheckbox
          v-for="w in channels.data.value?.webhooks ?? []"
          :key="w.id"
          :model-value="webhooks.includes(w.id)"
          :label="t('alerts.channels.webhook', { name: w.name })"
          :hint="w.enabled ? w.url : t('alerts.channels.webhookOff')"
          @update:model-value="toggleHook(w.id, $event)"
        />
      </fieldset>
      <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
    </form>
    <template #footer>
      <DsButton variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</DsButton>
      <DsButton variant="primary" :loading="saving" data-save-rule @click="save">{{
        t('common.save')
      }}</DsButton>
    </template>
  </DsDialog>
</template>
