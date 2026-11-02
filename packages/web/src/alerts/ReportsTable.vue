<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { FileBarChart, Pencil, Play, Trash2 } from 'lucide-vue-next'
import { describeCadence, type ReportValue, type ReportView } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsDataTable from '@/ds/DsDataTable.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsMenu from '@/ds/DsMenu.vue'
import DsSwitch from '@/ds/DsSwitch.vue'
import type { DsMenuItem } from '@/ds/menu'
import type { DsColumn } from '@/ds/table'
import { alertKeys, alertsApi } from '@/api/alerts'
import { formatCount, formatRelative } from '@/format'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import { adminErrorText } from '@/dbaccess/errors'
import { ApiError } from '@/api/client'
import ReportDialog from './ReportDialog.vue'
import { uiLanguageOf } from '@mongo-manager/shared/browser'

/**
 * Design 2026-10-25 (C7): the scheduled reports — each one's connection, when it runs next, what its
 * last run counted — run now, changed, turned off or deleted here.
 */
const props = defineProps<{ names: Record<string, string> }>()
const { t, te, locale } = useI18n()
const dialogs = useDialogStore()
const toasts = useToastStore()
const queryClient = useQueryClient()
const reports = useQuery({ queryKey: alertKeys.reports, queryFn: alertsApi.reports })
const editing = ref<ReportView | 'new' | null>(null)
const running = ref(new Set<string>())

const columns = computed<DsColumn[]>(() => [
  { key: 'what', label: t('alerts.reports.what') },
  { key: 'last', label: t('alerts.reports.last'), width: '34%', hideBelow: 640 },
  { key: 'enabled', label: t('alerts.reports.enabled'), width: '6rem', hideLabel: true },
])
const lang = computed(() => uiLanguageOf(locale.value))
const when = (r: ReportView) => describeCadence(r.cadence, lang.value)
const next = (r: ReportView) =>
  !r.enabled || !r.nextRunAt
    ? t('alerts.reports.notScheduled')
    : r.nextRunAt <= Date.now()
      ? t('alerts.reports.dueNow')
      : formatRelative(r.nextRunAt - Date.now(), locale.value)
const value = (v: ReportValue) =>
  v.count === null
    ? t('alerts.reports.notCounted', {
        label: v.label,
        reason: t(`alerts.reports.reasons.${v.reason ?? 'failed'}`),
      })
    : t(v.atLeast ? 'alerts.reports.valueAtLeast' : 'alerts.reports.value', {
        label: v.label,
        n: formatCount(v.count, locale.value),
      })
const menu = (): DsMenuItem[] => [
  { id: 'edit', label: t('alerts.reports.edit'), icon: Pencil },
  { id: 'delete', label: t('alerts.reports.delete'), icon: Trash2, danger: true },
]
const refresh = () => queryClient.invalidateQueries({ queryKey: alertKeys.all })
async function act(work: () => Promise<unknown>, done: string): Promise<void> {
  try {
    await work()
    toasts.push({ kind: 'success', message: done })
    await refresh()
  } catch (e) {
    toasts.push({ kind: 'error', message: refusal(e) })
  }
}
/** Review of C7a (M8): the server's refusal in words — the count it is about by its place. */
function refusal(e: unknown): string {
  const d =
    e instanceof ApiError ? (e.details as { reason?: unknown; measure?: unknown } | undefined) : undefined
  const reason = typeof d?.reason === 'string' && te(`alerts.reports.reasons.${d.reason}`) ? d.reason : null
  if (!reason) return adminErrorText(e, t)
  const words = t(`alerts.reports.reasons.${reason}`)
  return typeof d?.measure === 'number'
    ? t('alerts.reports.refusedAt', { n: d.measure + 1, reason: words })
    : t('alerts.reports.refused', { reason: words })
}
async function run(r: ReportView): Promise<void> {
  if (running.value.has(r.id)) return
  running.value = new Set([...running.value, r.id])
  try {
    try {
      const { sent } = await alertsApi.runReport(r.id)
      // Re-review of C7 (minor 5): sent, or only kept — one toast saying which.
      toasts.push(
        sent
          ? { kind: 'success', message: t('alerts.reports.ran', { name: r.name }) }
          : { kind: 'info', message: t('alerts.reports.notSent') },
      )
      await refresh()
    } catch (e) {
      toasts.push({ kind: 'error', message: refusal(e) })
    }
  } finally {
    const left = new Set(running.value)
    left.delete(r.id)
    running.value = left
  }
}
async function onMenu(r: ReportView, id: string): Promise<void> {
  if (id === 'edit') editing.value = r
  else if (id === 'delete') {
    const ok = await dialogs.confirm({
      title: t('alerts.reports.deleteTitle'),
      message: t('alerts.reports.deleteMessage', { name: r.name }),
      confirmLabel: t('alerts.reports.delete'),
      danger: true,
    })
    if (ok) await act(() => alertsApi.deleteReport(r.id), t('alerts.reports.deleted'))
  }
}
const toggle = (r: ReportView, on: boolean) =>
  act(
    () => alertsApi.patchReport(r.id, { enabled: on }),
    on ? t('alerts.reports.resumed') : t('alerts.reports.paused'),
  )
defineExpose({ add: () => (editing.value = 'new') })
</script>

<template>
  <DsDataTable
    :label="t('alerts.reports.title')"
    :columns="columns"
    :rows="reports.data.value ?? []"
    :row-key="(r: ReportView) => r.id"
    :loading="reports.isPending.value"
    :loading-label="t('app.loading')"
    :error="reports.isError.value ? adminErrorText(reports.error.value, t) : undefined"
    :actions-label="t('common.actions')"
    actions-width="9.5rem"
    data-reports
  >
    <template #cell-what="{ row: r }">
      <span class="flex flex-col gap-0.5 py-1.5">
        <span class="font-medium text-fg">{{ r.name }}</span>
        <span class="text-small text-fg-muted">
          {{ props.names[r.connectionId] ?? r.connectionId }} · {{ when(r) }} ·
          {{ t('alerts.reports.next', { when: next(r) }) }}
        </span>
      </span>
    </template>
    <template #cell-last="{ row: r }">
      <span v-if="r.lastRun" class="flex flex-col gap-0.5 py-1.5 text-small" data-report-last>
        <span v-for="v in r.lastRun.values" :key="v.label" class="text-fg">{{ value(v) }}</span>
        <span class="text-fg-subtle">{{ formatRelative(r.lastRun.at - Date.now(), locale) }}</span>
      </span>
      <span v-else class="text-small text-fg-subtle">{{ t('alerts.reports.neverRan') }}</span>
    </template>
    <template #cell-enabled="{ row: r }">
      <DsSwitch
        :model-value="r.enabled"
        :label="t('alerts.reports.enabledFor', { name: r.name })"
        class="[&_label]:sr-only"
        @update:model-value="toggle(r, $event)"
      />
    </template>
    <template #actions="{ row: r }">
      <span class="flex items-center gap-1">
        <DsButton
          size="sm"
          variant="ghost"
          :icon="Play"
          :loading="running.has(r.id)"
          :aria-label="t('alerts.reports.runFor', { name: r.name })"
          data-report-run
          @click="run(r)"
          >{{ t('alerts.reports.run') }}</DsButton
        >
        <DsMenu
          focusable
          touch
          :label="t('alerts.reports.actionsFor', { name: r.name })"
          :items="menu()"
          @select="onMenu(r, $event)"
        />
      </span>
    </template>
    <template #empty>
      <DsEmptyState
        :icon="FileBarChart"
        :title="t('alerts.reports.noneTitle')"
        :description="t('alerts.reports.none')"
      />
    </template>
  </DsDataTable>
  <ReportDialog v-if="editing" :existing="editing === 'new' ? undefined : editing" @close="editing = null" />
</template>
