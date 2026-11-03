<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, nextTick, ref, watch } from 'vue'
import type { OperationsQuery } from '@mongo-manager/shared/browser'
import { useQuery } from '@tanstack/vue-query'
import { connectionsApi, queryKeys } from '@/api/connections'
import { Activity, Code, Lock, OctagonX, Pause, Play, RotateCw } from 'lucide-vue-next'
import { serverApi, serverKeys, type OperationView } from '@/api/server'
import { describeError } from '@/api/errors'
import { ApiError } from '@/api/client'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import DsBadge from '@/ds/DsBadge.vue'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsCard from '@/ds/DsCard.vue'
import DsCodeBlock from '@/ds/DsCodeBlock.vue'
import DsDataTable from '@/ds/DsDataTable.vue'
import DsDialog from '@/ds/DsDialog.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsMenu from '@/ds/DsMenu.vue'
import type { DsMenuItem } from '@/ds/menu'
import { focusAfterRemoval, type DsColumn } from '@/ds/table'
import OperationsFilter from './OperationsFilter.vue'

/**
 * The slowest running operations (phase 1i spec §4), filtered (phase 3b §4); the command for every
 * monitor, masked by the server when needed; kill only for connection admins. UI redesign R3 §4: a
 * card with a data table; a row's command and Kill are in its "…" menu (Kill in danger colour, asked
 * first), never a red button on every row.
 */
const props = defineProps<{ connectionId: string; canOperate: boolean }>()
const { t } = useI18n()
const dialogs = useDialogStore()
const toasts = useToastStore()

const { data: connections } = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
const readOnly = computed(
  () => connections.value?.find((c) => c.id === props.connectionId)?.readOnly ?? false,
)
const SYSTEM_DB = /^(admin|local|config)(\.|$)/
/** The server refuses these: system namespaces and mongo-manager's own operations (jobs tray). */
function killable(op: OperationView): boolean {
  if (!props.canOperate || readOnly.value || SYSTEM_DB.test(op.ns) || op.killable === false) return false
  try {
    const comment = op.command ? (JSON.parse(op.command) as { comment?: unknown }).comment : undefined
    return !(typeof comment === 'string' && /^mm[-:]/.test(comment))
  } catch {
    // A command cut at 4 KB is not JSON any more; the server still decides.
    return true
  }
}

/** The filter, kept for this connection while the browser tab lives (phase 3b §4). */
const storageKey = `mm:ops-filter:${props.connectionId}`
function storedFilter(): OperationsQuery {
  try {
    const raw = sessionStorage.getItem(storageKey)
    return raw ? (JSON.parse(raw) as OperationsQuery) : {}
  } catch {
    return {}
  }
}
const filter = ref<OperationsQuery>(storedFilter())
watch(filter, (f) => {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(f))
  } catch {
    // Storage may be unavailable; the filter still applies for this view.
  }
})
const paused = ref(false)

const { data, isPending, isError, error, refetch } = useQuery({
  queryKey: computed(() => serverKeys.operations(props.connectionId, filter.value)),
  queryFn: () => serverApi.operations(props.connectionId, filter.value),
  refetchInterval: computed(() => (paused.value ? false : 5_000)),
})

// Review of the Monitoring redesign (I-1): on a narrow card the least needed columns leave first.
const columns = computed<DsColumn[]>(() => [
  { key: 'op', label: t('performance.opColumns.op'), width: '9rem' },
  { key: 'ns', label: t('performance.opColumns.ns'), mono: true },
  { key: 'running', label: t('performance.opColumns.running'), align: 'right', width: '7.5rem' },
  { key: 'plan', label: t('performance.opColumns.plan'), mono: true, width: '24%', hideBelow: 600 },
])

const rowMenu = (op: OperationView): DsMenuItem[] => [
  ...(op.command ? [{ id: 'command', label: t('performance.showCommand'), icon: Code }] : []),
  ...(killable(op)
    ? [{ id: 'kill', label: t('performance.kill'), icon: OctagonX, danger: true, separator: !!op.command }]
    : []),
]
function onRowMenu(op: OperationView, id: string): void {
  if (id === 'command') shown.value = op
  else if (id === 'kill') void kill(op)
}
/** The operation whose command is open in the dialog. */
const shown = ref<OperationView | null>(null)

async function kill(op: OperationView): Promise<void> {
  const ok = await dialogs.confirm({
    title: t('performance.killTitle'),
    message: t('performance.killConfirm', { op: op.op, ns: op.ns, opid: op.opid }),
    confirmLabel: t('performance.kill'),
    danger: true,
  })
  if (!ok) return
  const index = data.value?.operations.findIndex((o) => o.opid === op.opid) ?? -1
  try {
    await serverApi.kill(props.connectionId, op.opid, {
      ns: op.ns,
      op: op.op,
      ...(op.startedAt !== undefined ? { startedAt: op.startedAt } : {}),
      ...(op.member ? { member: op.member } : {}),
    })
    toasts.push({ kind: 'success', message: t('performance.killed', { opid: op.opid }) })
  } catch (e) {
    // Third review of B3 (M6): another operation under that opid, or one gone, in their own words.
    const reason = e instanceof ApiError ? (e.details as { reason?: unknown } | undefined)?.reason : undefined
    const own =
      reason === 'operation_changed' ||
      reason === 'operation_finished' ||
      reason === 'operation_not_primary' ||
      reason === 'operation_unconfirmed'
    toasts.push({
      kind: 'error',
      message: own ? t(`performance.killRefused.${reason}`) : describeError(e, t),
    })
  }
  await refetch()
  // The killed operation's row has left: focus goes on, not to the page's body.
  if (!data.value?.operations.some((o) => o.opid === op.opid)) {
    await nextTick()
    focusAfterRemoval(card.value?.$el, index)
  }
}
const card = ref<{ $el: Element } | null>(null)
</script>

<template>
  <DsCard
    ref="card"
    :title="t('performance.operations')"
    :count="data ? (data.more ? `${data.operations.length}+` : data.operations.length) : undefined"
    actions-shown
    data-operations
  >
    <template #actions>
      <DsButton
        size="sm"
        variant="ghost"
        :icon="paused ? Play : Pause"
        data-ops-pause
        :aria-pressed="paused"
        @click="paused = !paused"
      >
        {{ paused ? t('operationsFilter.resume') : t('operationsFilter.pause') }}
      </DsButton>
    </template>
    <div class="flex flex-col gap-3">
      <OperationsFilter v-model="filter" :connection-id="connectionId" />
      <DsCallout v-if="data?.scope === 'own'" tone="warning" data-ops-own-only>
        {{ t('operationsFilter.ownOnly') }}
      </DsCallout>
      <DsDataTable
        :label="t('performance.operations')"
        :columns="columns"
        :rows="data?.operations ?? []"
        :row-key="(op: OperationView) => op.opid"
        :loading="isPending"
        :loading-label="t('app.loading')"
        :error="isError ? describeError(error, t) : undefined"
        :actions-label="t('documents.actionsColumn')"
      >
        <template #cell-op="{ row: op }">
          <span class="flex min-w-0 items-center gap-1.5" :data-op="op.opid">
            <span class="truncate">{{ op.op }}</span>
            <Lock
              v-if="op.waitingForLock"
              class="size-3.5 shrink-0 text-warning"
              role="img"
              :aria-label="t('performance.waitingForLock')"
            />
          </span>
        </template>
        <template #cell-ns="{ row: op }">
          <span :title="op.ns">{{ op.ns }}</span>
        </template>
        <template #cell-running="{ row: op }">
          <span class="font-mono text-[12.5px]">{{ t('performance.seconds', { n: op.secsRunning }) }}</span>
        </template>
        <template #cell-plan="{ row: op }">
          <DsBadge v-if="op.planSummary?.startsWith('COLLSCAN')" tone="warning" :title="op.planSummary">{{
            op.planSummary
          }}</DsBadge>
          <span v-else class="text-fg-muted" :title="op.planSummary ?? undefined">{{
            op.planSummary ?? ''
          }}</span>
        </template>
        <template #actions="{ row: op }">
          <DsMenu
            v-if="rowMenu(op).length"
            focusable
            touch
            :label="t('performance.actionsFor', { opid: op.opid })"
            :items="rowMenu(op)"
            @select="onRowMenu(op, $event)"
          />
        </template>
        <template #retry>
          <DsButton size="sm" :icon="RotateCw" @click="refetch()">{{ t('common.retry') }}</DsButton>
        </template>
        <template #empty>
          <DsEmptyState
            :icon="Activity"
            :title="t('performance.noOperations')"
            :description="t('performance.noOperationsHint')"
          />
        </template>
      </DsDataTable>
      <DsCallout v-if="data?.more" tone="info" data-ops-more>{{ t('operationsFilter.more') }}</DsCallout>
    </div>
    <DsDialog
      :open="shown !== null"
      size="lg"
      :title="t('performance.commandOf', { opid: shown?.opid ?? '' })"
      :description="shown ? `${shown.op} · ${shown.ns}` : undefined"
      @close="shown = null"
    >
      <DsCodeBlock
        v-if="shown?.command"
        full
        :code="shown.command"
        :label="t('performance.command')"
        :copy-label="t('performance.copyCommand')"
      />
    </DsDialog>
  </DsCard>
</template>
