<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { History, Trash2 } from 'lucide-vue-next'
import { serverApi, serverKeys, type HistoryRange } from '@/api/server'
import { describeError } from '@/api/errors'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import DsBadge from '@/ds/DsBadge.vue'
import DsMenu from '@/ds/DsMenu.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import type { DsMenuItem } from '@/ds/menu'
/**
 * Phase 3b spec §6: which span the charts show — live (the last 5 minutes, over the socket) or the
 * stored history — and, for a connection admin, the switch that records history and its delete.
 * UI redesign R3 §4: it sits in the connection header's actions while Performance is open; the
 * span is a segmented control, recording and deleting are a menu (delete in danger colour, asked
 * first), a failed recording is a warning badge.
 */
const props = defineProps<{ connectionId: string; canOperate: boolean; range: 'live' | HistoryRange }>()
const emit = defineEmits<{ 'update:range': [range: 'live' | HistoryRange] }>()
const { t } = useI18n()
const dialogs = useDialogStore()
const toasts = useToastStore()
const queryClient = useQueryClient()
const RANGES = ['live', '1h', '24h', '7d'] as const

const settings = useQuery({
  queryKey: serverKeys.historySettings(props.connectionId),
  queryFn: () => serverApi.historySettings(props.connectionId),
  refetchInterval: 60_000,
  retry: false,
})
const saving = ref(false)

const span = computed({
  get: () => props.range,
  set: (r: 'live' | HistoryRange) => emit('update:range', r),
})
const ranges = computed(() => RANGES.map((value) => ({ value, label: t(`history.ranges.${value}`) })))

const menu = computed<DsMenuItem[]>(() => {
  const s = settings.data.value
  if (!props.canOperate || !s) return []
  return [
    {
      id: 'record',
      label: s.enabled ? t('history.stop') : t('history.record'),
      hint: s.enabled ? undefined : t('history.recordHint'),
      icon: History,
      disabled: saving.value,
    },
    ...(s.samples > 0
      ? [{ id: 'delete', label: t('history.delete'), icon: Trash2, danger: true, separator: true }]
      : []),
  ]
})
function onMenu(id: string): void {
  if (id === 'record' && settings.data.value) void toggle(!settings.data.value.enabled)
  else if (id === 'delete') void remove()
}

async function refresh(): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ['connections', props.connectionId, 'server', 'history'] })
}

async function toggle(enabled: boolean): Promise<void> {
  saving.value = true
  try {
    await serverApi.setHistory(props.connectionId, enabled)
    toasts.push({ kind: 'success', message: t(enabled ? 'history.turnedOn' : 'history.turnedOff') })
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  } finally {
    saving.value = false
    await refresh()
  }
}

async function remove(): Promise<void> {
  const ok = await dialogs.confirm({
    title: t('history.deleteTitle'),
    message: t('history.deleteConfirm'),
    confirmLabel: t('history.delete'),
    danger: true,
  })
  if (!ok) return
  try {
    await serverApi.deleteHistory(props.connectionId)
    toasts.push({ kind: 'success', message: t('history.deleted') })
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  }
  await refresh()
}
</script>

<template>
  <div class="flex max-w-full min-w-0 flex-wrap items-center gap-1.5" data-history-controls>
    <DsBadge
      v-if="settings.data.value?.enabled && settings.data.value.lastError"
      tone="warning"
      :title="t('history.failed')"
      data-history-failed
    >
      <span aria-hidden="true">{{ t('history.failedShort') }}</span>
      <span class="sr-only">{{ t('history.failed') }}</span>
    </DsBadge>
    <DsSegmented v-model="span" size="sm" :label="t('history.range')" :options="ranges" />
    <DsMenu
      v-if="menu.length"
      :label="t('history.menu')"
      :icon="History"
      :items="menu"
      focusable
      size="header"
      @select="onMenu"
    />
  </div>
</template>
