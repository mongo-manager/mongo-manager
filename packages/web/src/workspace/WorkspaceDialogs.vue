<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import DuplicateCollectionDialog from '@/connections/DuplicateCollectionDialog.vue'
import ShortcutSheet from './ShortcutSheet.vue'
import { defineAsyncComponent } from 'vue'
import type { ConnectionDto } from '@/api/connections'
import { useWorkspaceDialogs } from '@/stores/workspaceDialogs'
import { useTabsStore } from '@/stores/tabs'
import { openConnectionTab } from './openTabs'
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { BackupView } from '@mongo-manager/shared/browser'
import { backupApi, backupKeys } from '@/api/backup'
import { openBackupsSection } from '@/backup/openBackups'
import { useToastStore } from '@/stores/toasts'

// Dialogs load on first use; the workspace bundle stays small.
const ConnectionDialog = defineAsyncComponent(() => import('@/connections/ConnectionDialog.vue'))
const DatabaseCreateDialog = defineAsyncComponent(() => import('@/connections/DatabaseCreateDialog.vue'))
const CollectionCreateDialog = defineAsyncComponent(() => import('@/connections/CollectionCreateDialog.vue'))
const RenameCollectionDialog = defineAsyncComponent(() => import('@/connections/RenameCollectionDialog.vue'))
const CollectionEditDialog = defineAsyncComponent(() => import('@/connections/CollectionEditDialog.vue'))
const ImportWizard = defineAsyncComponent(() => import('@/transfer/ImportWizard.vue'))
const ExportDataDialog = defineAsyncComponent(() => import('@/transfer/ExportDataDialog.vue'))
const CopyWizard = defineAsyncComponent(() => import('@/transfer/CopyWizard.vue'))
const LiveSyncWizard = defineAsyncComponent(() => import('@/livesync/LiveSyncWizard.vue'))
const AiSheet = defineAsyncComponent(() => import('@/ai/AiSheet.vue'))
const BackupDumpSheet = defineAsyncComponent(() => import('@/backup/BackupDumpSheet.vue'))
const BackupRestoreSheet = defineAsyncComponent(() => import('@/backup/BackupRestoreSheet.vue'))
const BackupSendSheet = defineAsyncComponent(() => import('@/backup/BackupSendSheet.vue'))
const ScheduleEditor = defineAsyncComponent(() => import('@/schedules/ScheduleEditor.vue'))
const ExportConnectionsDialog = defineAsyncComponent(
  () => import('@/connections/ExportConnectionsDialog.vue'),
)
const ImportConnectionsDialog = defineAsyncComponent(
  () => import('@/connections/ImportConnectionsDialog.vue'),
)

const dialogs = useWorkspaceDialogs()
const tabs = useTabsStore()

const queryClient = useQueryClient()
const toasts = useToastStore()
const { t } = useI18n()

/**
 * Phase 3d-3b: the backup a send dialog is for, from its connection's list — the Backups card's cache
 * when it has one, read otherwise (final review C26: a dialog with no cached list showed nothing).
 */
const sendTarget = computed(() => (dialogs.current?.kind === 'backupSend' ? dialogs.current : null))
const sendList = useQuery({
  queryKey: computed(() => backupKeys.list(sendTarget.value?.connectionId)),
  queryFn: () => backupApi.list(sendTarget.value!.connectionId),
  enabled: computed(() => Boolean(sendTarget.value)),
})
const sendBackup = computed<BackupView | null>(
  () => sendList.data.value?.find((b) => b.id === sendTarget.value?.backupId) ?? null,
)
// Gone meanwhile: the dialog closes and says why.
watch(
  () => [sendTarget.value, sendList.isSuccess.value, sendBackup.value] as const,
  ([target, loaded, backup]) => {
    if (!target || !loaded || backup) return
    dialogs.close()
    toasts.push({ kind: 'error', message: t('destinations.reason.backup_gone') })
  },
)

/** U2's "Manage backups": the connection's tab, scrolled to its Backups section. */
async function manageBackups(connectionId: string): Promise<void> {
  dialogs.close()
  await openBackupsSection(queryClient, tabs, connectionId)
}

function onConnectionSaved(connection: ConnectionDto, created: boolean): void {
  if (created) openConnectionTab(tabs, connection)
  else
    tabs.retitle((t) => t.kind === 'connection' && t.params.connectionId === connection.id, connection.name)
}
</script>

<template>
  <template v-if="dialogs.current">
    <!-- Keyed: another connection (or a new one) always gets a fresh form. -->
    <ConnectionDialog
      v-if="dialogs.current.kind === 'connection'"
      :key="`${dialogs.current.connection?.id ?? 'new'}:${dialogs.current.duplicate ? 'copy' : 'edit'}`"
      :connection="dialogs.current.connection"
      :duplicate="dialogs.current.duplicate"
      @saved="onConnectionSaved"
      @close="dialogs.close()"
    />
    <DatabaseCreateDialog
      v-else-if="dialogs.current.kind === 'createDatabase'"
      :connection-id="dialogs.current.connectionId"
      @close="dialogs.close()"
    />
    <CollectionCreateDialog
      v-else-if="dialogs.current.kind === 'createCollection'"
      :connection-id="dialogs.current.connectionId"
      :db="dialogs.current.db"
      :view="dialogs.current.view"
      :name="dialogs.current.name"
      @close="dialogs.close()"
    />
    <RenameCollectionDialog
      v-else-if="dialogs.current.kind === 'renameCollection'"
      :connection-id="dialogs.current.connectionId"
      :db="dialogs.current.db"
      :coll="dialogs.current.coll"
      @close="dialogs.close()"
    />
    <CollectionEditDialog
      v-else-if="dialogs.current.kind === 'editCollection'"
      :connection-id="dialogs.current.connectionId"
      :db="dialogs.current.db"
      :coll="dialogs.current.coll"
      :tab-id="dialogs.current.tabId"
      @close="dialogs.close()"
    />
    <DuplicateCollectionDialog
      v-else-if="dialogs.current.kind === 'duplicateCollection'"
      :connection-id="dialogs.current.connectionId"
      :db="dialogs.current.db"
      :coll="dialogs.current.coll"
      @close="dialogs.close()"
    />
    <ImportWizard
      v-else-if="dialogs.current.kind === 'importData'"
      :key="dialogs.current.file?.id ?? 'import'"
      :connection-id="dialogs.current.connectionId"
      :db="dialogs.current.db"
      :coll="dialogs.current.coll"
      :preset="dialogs.current.file"
      @close="dialogs.close()"
    />
    <ExportDataDialog
      v-else-if="dialogs.current.kind === 'exportData'"
      :connection-id="dialogs.current.connectionId"
      :db="dialogs.current.db"
      :coll="dialogs.current.coll"
      :query="dialogs.current.query"
      :stages="dialogs.current.stages"
      :format="dialogs.current.format"
      @close="dialogs.close()"
    />
    <CopyWizard
      v-else-if="dialogs.current.kind === 'copyData'"
      :connection-id="dialogs.current.connectionId"
      :db="dialogs.current.db"
      :coll="dialogs.current.coll"
      :compare="dialogs.current.compare ?? false"
      @close="dialogs.close()"
    />
    <!-- Keyed: Ask AI opened again for another tab or collection starts anew (its answer, task and
         words belong to the first; review 2026-10-13). -->
    <AiSheet
      v-else-if="dialogs.current.kind === 'ai'"
      :key="`ai:${dialogs.current.connectionId}/${dialogs.current.db}/${dialogs.current.coll}/${dialogs.current.tabId}`"
      :connection-id="dialogs.current.connectionId"
      :db="dialogs.current.db"
      :coll="dialogs.current.coll"
      :tab-id="dialogs.current.tabId"
      :actions="dialogs.current.actions"
      :send-now="dialogs.current.send ?? false"
      @close="dialogs.close()"
    />
    <LiveSyncWizard
      v-else-if="dialogs.current.kind === 'liveSync'"
      :connection-id="dialogs.current.connectionId"
      :db="dialogs.current.db"
      :coll="dialogs.current.coll"
      :preset="dialogs.current.preset"
      :review="dialogs.current.review"
      @close="dialogs.close()"
    />
    <BackupDumpSheet
      v-else-if="dialogs.current.kind === 'backupDump'"
      :connection-id="dialogs.current.connectionId"
      :db="dialogs.current.db"
      :coll="dialogs.current.coll"
      @close="dialogs.close()"
      @manage="manageBackups((dialogs.current as { connectionId: string }).connectionId)"
    />
    <BackupRestoreSheet
      v-else-if="dialogs.current.kind === 'backupRestore'"
      :connection-id="dialogs.current.connectionId"
      :db="dialogs.current.db"
      :coll="dialogs.current.coll"
      :backup-id="dialogs.current.backupId"
      :remote="dialogs.current.remote"
      @close="dialogs.close()"
    />
    <BackupSendSheet
      v-else-if="dialogs.current.kind === 'backupSend' && sendBackup"
      :backup="sendBackup"
      @close="dialogs.close()"
    />
    <ScheduleEditor
      v-else-if="dialogs.current.kind === 'backupSchedule'"
      :key="
        dialogs.current.scheduleId ??
        `new:${dialogs.current.connectionId ?? ''}:${dialogs.current.db ?? ''}:${dialogs.current.coll ?? ''}`
      "
      :connection-id="dialogs.current.connectionId"
      :db="dialogs.current.db"
      :coll="dialogs.current.coll"
      :schedule-id="dialogs.current.scheduleId"
      @close="dialogs.close()"
    />
    <ExportConnectionsDialog
      v-else-if="dialogs.current.kind === 'exportConnections'"
      @close="dialogs.close()"
    />
    <ImportConnectionsDialog
      v-else-if="dialogs.current.kind === 'importConnections'"
      @close="dialogs.close()"
    />
    <ShortcutSheet v-else-if="dialogs.current.kind === 'shortcuts'" @close="dialogs.close()" />
  </template>
</template>
