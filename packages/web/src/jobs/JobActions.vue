<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { ArchiveRestore, Download, FileText, FolderOpen, GitCompareArrows, RotateCcw } from 'lucide-vue-next'
import type { JobView, TransferReport } from '@mongo-manager/shared'
import { transferApi } from '@/api/transfer'
import { backupApi, backupKeys } from '@/api/backup'
import { destinationsApi } from '@/api/destinations'
import { describeError } from '@/api/errors'
import ImportReport from '@/transfer/ImportReport.vue'
import ExportExpiry from '@/transfer/ExportExpiry.vue'
import { useTabsStore } from '@/stores/tabs'
import { useToastStore } from '@/stores/toasts'
import { useWorkspaceDialogs } from '@/stores/workspaceDialogs'
import { openCollectionTab, openCompareTab, openDatabaseTab } from '@/workspace/openTabs'
import { restoreTarget, type RestoreTarget } from './restoreTarget'
import { useBackupError } from '@/backup/checkText'
import { useJobsStore } from './store'
import { useSendStartError } from './sendJob'

/**
 * What a finished job of the user's own offers: its file, its report, a restore of its backup, its
 * comparison, a retry of the copies a send could not make. As links in a job row, as buttons in the
 * jobs page's details (user review 2026-10-08). The checks are the server's; this only offers.
 */
const props = withDefaults(defineProps<{ job: JobView; variant?: 'links' | 'buttons' }>(), {
  variant: 'links',
})
const { t } = useI18n()

const TRANSFER_KINDS = new Set([
  'data.import',
  'data.importSql',
  'data.export',
  'data.copy',
  'data.compare',
  'data.sync',
])
const transfer = computed(() => TRANSFER_KINDS.has(props.job.kind))
const backup = computed(
  () =>
    props.job.kind === 'backup.dump' ||
    props.job.kind === 'backup.restore' ||
    props.job.kind === 'backup.drill',
)
const offered = computed(
  () => (transfer.value || backup.value) && props.job.mine && props.job.state !== 'running',
)

// A finished backup of one's own offers the file, a restore of it, and its report.
const dialogs = useWorkspaceDialogs()
const backupId = ref<string | null>(null)
/** Why the send queued after this dump could not start, in words. */
const sendError = ref<string | null>(null)
const sendStartError = useSendStartError()
watch(
  () => [props.job.kind, props.job.state, props.job.mine] as const,
  async ([kind, state, mine]) => {
    if (kind !== 'backup.dump' || state !== 'done' || !mine || backupId.value) return
    const r = await transferApi.report(props.job.id).catch(() => null)
    if (r?.kind === 'dump') {
      backupId.value = r.backupId
      sendError.value = r.sendError ? sendStartError(r.sendError) : null
    }
  },
  { immediate: true },
)
// W4.2: a finished export says until when its file can be downloaded, and offers none once it expired.
const exportExpiresAt = ref<number | null>(null)
watch(
  () => [props.job.kind, props.job.state, props.job.mine] as const,
  async ([kind, state, mine]) => {
    if (kind !== 'data.export' || state !== 'done' || !mine || exportExpiresAt.value !== null) return
    const r = await transferApi.report(props.job.id).catch(() => null)
    if (r?.kind === 'export') exportExpiresAt.value = r.expiresAt
  },
  { immediate: true },
)
const exportExpired = computed(() => exportExpiresAt.value !== null && exportExpiresAt.value <= Date.now())
// W4.4 (U8): a finished restore opens what it wrote.
const restored = ref<RestoreTarget | null>(null)
watch(
  () => [props.job.kind, props.job.state, props.job.mine] as const,
  async ([kind, state, mine]) => {
    if (kind !== 'backup.restore' || state !== 'done' || !mine || restored.value) return
    const r = await transferApi.report(props.job.id).catch(() => null)
    if (r?.kind === 'restore') restored.value = restoreTarget(r)
  },
  { immediate: true },
)
function openRestored(): void {
  const target = restored.value
  if (!target) return
  if (target.kind === 'collection') openCollectionTab(tabs, props.job.connectionId, target.db, target.coll)
  else openDatabaseTab(tabs, props.job.connectionId, target.db)
}
const restoreBackup = () =>
  backupId.value &&
  dialogs.open({ kind: 'backupRestore', connectionId: props.job.connectionId, backupId: backupId.value })
const tabs = useTabsStore()
const openComparison = () =>
  openCompareTab(tabs, props.job.id, `${props.job.db}.${props.job.coll} ⇄ ${props.job.target}`)
const report = ref<TransferReport | null>(null)
const reportError = ref('')
async function showReport(): Promise<void> {
  if (report.value) {
    report.value = null
    return
  }
  try {
    report.value = await transferApi.report(props.job.id)
  } catch (e) {
    reportError.value = describeError(e, t)
  }
}

// A failed send offers Retry for its failed copies, found in its connection's backup list.
const queryClient = useQueryClient()
const toasts = useToastStore()
const jobs = useJobsStore()
const backupError = useBackupError()
const failedSend = computed(
  () => props.job.kind === 'backup.send' && props.job.state === 'failed' && props.job.mine,
)
const backups = useQuery({
  queryKey: computed(() => backupKeys.list(props.job.connectionId)),
  queryFn: () => backupApi.list(props.job.connectionId),
  enabled: failedSend,
})
const retryable = computed(() => {
  if (!failedSend.value) return []
  const found = backups.data.value?.find((b) => b.name === props.job.target)
  return (found?.copies ?? []).filter((c) => c.state === 'failed')
})
const retrying = ref(false)
async function retry(): Promise<void> {
  retrying.value = true
  try {
    for (const copy of retryable.value) {
      const { job } = await destinationsApi.retryCopy(copy.id)
      jobs.upsert(job)
    }
    toasts.push({ kind: 'info', message: t('backup.send.started') })
    await queryClient.invalidateQueries({ queryKey: backupKeys.all })
  } catch (e) {
    toasts.push({ kind: 'error', message: backupError(e).join(' ') })
  } finally {
    retrying.value = false
  }
}

// W4.4: "Open report" on a toast opens this job's report here.
watch(
  () => [jobs.reportWanted, offered.value] as const,
  ([wanted, shown]) => {
    if (wanted !== props.job.id || !shown) return
    jobs.reportShown()
    if (!report.value) void showReport()
  },
  { immediate: true },
)

const buttons = computed(() => props.variant === 'buttons')
const link = 'cursor-pointer text-accent-fg underline-offset-2 hover:underline'
const button =
  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-ui font-medium text-fg shadow-xs transition-colors duration-120 hover:bg-subtle disabled:cursor-default disabled:opacity-60'
const primary =
  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-accent px-3 text-ui font-medium text-on-accent shadow-xs transition-colors duration-120 hover:bg-accent-hover'
defineExpose({ offered })
</script>

<template>
  <div v-if="offered || retryable.length || sendError" data-job-actions class="flex flex-col gap-2">
    <div v-if="offered" class="flex flex-wrap items-center" :class="buttons ? 'gap-2' : 'gap-3 text-small'">
      <template v-if="backupId">
        <a :href="backupApi.downloadUrl(backupId)" :class="buttons ? primary : link" download>
          <Download v-if="buttons" class="size-4" aria-hidden="true" />{{ t('backup.list.download') }}
        </a>
        <button type="button" :class="buttons ? button : link" @click="restoreBackup">
          <ArchiveRestore v-if="buttons" class="size-4" aria-hidden="true" />{{ t('backup.list.restore') }}
        </button>
      </template>
      <a
        v-if="job.kind === 'data.export' && job.state === 'done' && !exportExpired"
        :href="transferApi.fileUrl(job.id)"
        :class="buttons ? primary : link"
        download
      >
        <Download v-if="buttons" class="size-4" aria-hidden="true" />{{ t('dataTransfer.download') }}
      </a>
      <ExportExpiry
        v-if="job.kind === 'data.export' && exportExpiresAt !== null"
        :expires-at="exportExpiresAt"
      />
      <button v-if="restored" type="button" :class="buttons ? primary : link" @click="openRestored">
        <FolderOpen v-if="buttons" class="size-4" aria-hidden="true" />{{
          restored.kind === 'collection' ? t('jobs.openCollection') : t('jobs.openDatabase')
        }}
      </button>
      <button
        v-if="job.kind === 'data.compare' && job.state === 'done'"
        type="button"
        :class="buttons ? primary : link"
        @click="openComparison"
      >
        <GitCompareArrows v-if="buttons" class="size-4" aria-hidden="true" />{{
          t('dataTransfer.compare.open')
        }}
      </button>
      <button
        v-else
        type="button"
        :class="buttons ? button : link"
        :aria-expanded="report !== null"
        @click="showReport"
      >
        <FileText v-if="buttons" class="size-4" aria-hidden="true" />{{ t('dataTransfer.report.show') }}
      </button>
      <span v-if="reportError" class="text-small text-danger">{{ reportError }}</span>
    </div>
    <p v-if="sendError" role="alert" class="text-small text-danger">{{ sendError }}</p>
    <div v-if="retryable.length" class="flex flex-wrap items-center gap-3 text-small">
      <button type="button" :class="buttons ? button : link" :disabled="retrying" @click="retry">
        <RotateCcw v-if="buttons" class="size-4" aria-hidden="true" />{{ t('backup.copies.retry') }}
      </button>
    </div>
    <ImportReport v-if="report" :report="report" :job-id="job.id" class="pt-1" />
  </div>
</template>
