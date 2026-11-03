<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQueryClient } from '@tanstack/vue-query'
import { BellOff, BellRing, Pencil, Trash2 } from 'lucide-vue-next'
import type { AlertRuleView } from '@mongo-manager/shared/browser'
import DsBadge from '@/ds/DsBadge.vue'
import DsDataTable from '@/ds/DsDataTable.vue'
import DsMenu from '@/ds/DsMenu.vue'
import DsSwitch from '@/ds/DsSwitch.vue'
import type { DsMenuItem } from '@/ds/menu'
import type { DsColumn } from '@/ds/table'
import { alertKeys, alertsApi } from '@/api/alerts'
import { formatElapsed } from '@/jobs/elapsed'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import { adminErrorText } from '@/dbaccess/errors'
import { formatMetric } from './labels'
import RuleDialog from './RuleDialog.vue'

/**
 * W3.3: rules as a table — what each watches, whether it fires now (and since when), where it
 * sends, a switch to pause it, and a menu to change, snooze or delete it (asked first).
 */
const props = defineProps<{
  rules: readonly AlertRuleView[]
  loading: boolean
  error?: string
  label: string
  /** Connection names, for event rules on all or one connection. */
  names?: Record<string, string>
}>()
const { t, locale } = useI18n()
const dialogs = useDialogStore()
const toasts = useToastStore()
const queryClient = useQueryClient()
const editing = ref<AlertRuleView | null>(null)
const now = ref(Date.now())
const tick = setInterval(() => (now.value = Date.now()), 30_000)
onBeforeUnmount(() => clearInterval(tick))

const columns = computed<DsColumn[]>(() => [
  { key: 'what', label: t('alerts.rules.what') },
  { key: 'state', label: t('alerts.rules.state'), width: '11rem' },
  { key: 'channels', label: t('alerts.rules.channels'), width: '24%', hideBelow: 640 },
  { key: 'enabled', label: t('alerts.rules.enabled'), width: '6rem', hideLabel: true },
])
const what = (r: AlertRuleView) =>
  r.kind === 'metric' && r.metric
    ? t('alerts.rules.metricLine', {
        metric: t(`alerts.metrics.${r.metric}`),
        threshold: formatMetric(t, locale.value, r.metric, r.threshold),
        minutes: t('alerts.rules.sustainOption', { n: r.sustain }, r.sustain),
      })
    : t('alerts.rules.eventLine', {
        event: t(`alerts.events.${r.event}`),
        where: r.connectionId
          ? (props.names?.[r.connectionId] ?? r.connectionId)
          : t('alerts.rules.anyConnection'),
      })
const channelText = (r: AlertRuleView) =>
  [
    r.channels.inApp ? t('alerts.channels.inApp') : null,
    r.channels.email ? t('alerts.channels.email') : null,
    r.channels.webhooks.length
      ? t('alerts.channels.webhooks', { n: r.channels.webhooks.length }, r.channels.webhooks.length)
      : null,
  ]
    .filter(Boolean)
    .join(', ') || t('alerts.channels.none')
const snoozed = (r: AlertRuleView) => !!r.snoozedUntil && Date.parse(r.snoozedUntil) > now.value
const menu = (r: AlertRuleView): DsMenuItem[] => [
  { id: 'edit', label: t('alerts.rules.edit'), icon: Pencil },
  ...(snoozed(r)
    ? [{ id: 'wake', label: t('alerts.rules.wake'), icon: BellRing }]
    : [
        {
          id: 'snooze:60',
          label: t('alerts.rules.snoozeFor', { time: t('alerts.rules.hour') }),
          icon: BellOff,
        },
        {
          id: 'snooze:480',
          label: t('alerts.rules.snoozeFor', { time: t('alerts.rules.hours8') }),
          icon: BellOff,
        },
        {
          id: 'snooze:1440',
          label: t('alerts.rules.snoozeFor', { time: t('alerts.rules.day') }),
          icon: BellOff,
        },
      ]),
  { id: 'delete', label: t('alerts.rules.delete'), icon: Trash2, danger: true },
]
const refresh = () => queryClient.invalidateQueries({ queryKey: alertKeys.all })
async function act(work: () => Promise<unknown>, done: string): Promise<void> {
  try {
    await work()
    toasts.push({ kind: 'success', message: done })
    await refresh()
  } catch (e) {
    toasts.push({ kind: 'error', message: adminErrorText(e, t) })
  }
}
async function onMenu(r: AlertRuleView, id: string): Promise<void> {
  if (id === 'edit') editing.value = r
  else if (id === 'wake') await act(() => alertsApi.snooze(r.id, null), t('alerts.rules.woken'))
  else if (id.startsWith('snooze:'))
    await act(() => alertsApi.snooze(r.id, Number(id.slice(7))), t('alerts.rules.snoozed'))
  else if (id === 'delete') {
    const ok = await dialogs.confirm({
      title: t('alerts.rules.deleteTitle'),
      message: t('alerts.rules.deleteMessage', { what: what(r) }),
      confirmLabel: t('alerts.rules.delete'),
      danger: true,
    })
    if (ok) await act(() => alertsApi.deleteRule(r.id), t('alerts.rules.deleted'))
  }
}
const toggle = (r: AlertRuleView, on: boolean) =>
  act(
    () => alertsApi.patchRule(r.id, { enabled: on }),
    on ? t('alerts.rules.resumed') : t('alerts.rules.paused'),
  )
</script>

<template>
  <DsDataTable
    :label="label"
    :columns="columns"
    :rows="rules"
    :row-key="(r: AlertRuleView) => r.id"
    :loading="loading"
    :loading-label="t('app.loading')"
    :error="error"
    :actions-label="t('common.actions')"
  >
    <template #cell-what="{ row: r }">
      <span class="block py-1.5 text-fg">{{ what(r) }}</span>
    </template>
    <template #cell-state="{ row: r }">
      <span class="flex flex-wrap items-center gap-1">
        <DsBadge v-if="r.firing" tone="danger" data-firing>{{
          t('alerts.rules.firingSince', { time: formatElapsed(now - Date.parse(r.firing.since), locale) })
        }}</DsBadge>
        <DsBadge v-else-if="!r.enabled">{{ t('alerts.rules.pausedBadge') }}</DsBadge>
        <DsBadge v-else-if="r.kind === 'metric'" tone="success">{{ t('alerts.rules.quiet') }}</DsBadge>
        <DsBadge v-else tone="info">{{ t('alerts.rules.listening') }}</DsBadge>
        <DsBadge v-if="snoozed(r)" tone="warning">{{ t('alerts.rules.snoozedBadge') }}</DsBadge>
      </span>
    </template>
    <template #cell-channels="{ row: r }">
      <span class="text-small text-fg-muted">{{ channelText(r) }}</span>
    </template>
    <template #cell-enabled="{ row: r }">
      <DsSwitch
        :model-value="r.enabled"
        :label="t('alerts.rules.enabledFor', { what: what(r) })"
        class="[&_label]:sr-only"
        @update:model-value="toggle(r, $event)"
      />
    </template>
    <template #actions="{ row: r }">
      <DsMenu
        focusable
        touch
        :label="t('alerts.rules.actionsFor', { what: what(r) })"
        :items="menu(r)"
        @select="onMenu(r, $event)"
      />
    </template>
    <template #empty>
      <slot name="empty" />
    </template>
  </DsDataTable>
  <RuleDialog
    v-if="editing"
    :kind="editing.kind"
    :connection-id="editing.connectionId"
    :existing="editing"
    @close="editing = null"
  />
</template>
