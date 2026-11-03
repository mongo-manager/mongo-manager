<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Download } from 'lucide-vue-next'
import { transferApi } from '@/api/transfer'
import { backupApi } from '@/api/backup'
import { useJobsStore } from '@/jobs/store'

/**
 * User request 2026-10-26 ("back it up and download it"): the file a step's job made — a backup, an
 * export — downloaded from the step once the job is done, as the jobs page and its toast offer it.
 * The person's own job only; nothing while it runs, nor for a job that failed or a file gone. The
 * download is the app's own route (its checks and audit), never a link the model gave.
 */
const props = defineProps<{ job: string }>()
const { t } = useI18n()
const jobs = useJobsStore()
const view = computed(() => jobs.byId[props.job])
/** Review (nit 5): only a job that makes a file is asked about. */
const FILE_KINDS = new Set(['backup.dump', 'data.export'])
const done = computed(
  () => view.value?.mine === true && view.value.state === 'done' && FILE_KINDS.has(view.value.kind),
)
const backupId = ref<string | null>(null)
const exportUntil = ref<number | null>(null)
/** Review (nit 6): an export's file kept until then — its link goes when it expires. */
const expired = ref(false)
let expiry: ReturnType<typeof setTimeout> | null = null
let retry: ReturnType<typeof setTimeout> | null = null
let tries = 0
async function read(): Promise<void> {
  const kind = view.value?.kind
  const r = await transferApi.report(props.job).catch(() => null)
  if (!r) {
    // Review (nit 6): read again a few times (the report may not be there yet, or the call failed).
    if (++tries < 3) retry = setTimeout(() => void read(), 2000 * tries)
    return
  }
  if (kind === 'backup.dump' && r.kind === 'dump' && r.backupId) backupId.value = r.backupId
  if (kind === 'data.export' && r.kind === 'export') {
    exportUntil.value = r.expiresAt
    const left = r.expiresAt - Date.now()
    if (left <= 0) expired.value = true
    // setTimeout holds at most about 24.8 days; a file kept longer keeps its link that long.
    else if (left < 2_147_483_647) expiry = setTimeout(() => (expired.value = true), left)
  }
}
watch(
  done,
  (ok) => {
    if (ok && !backupId.value && exportUntil.value === null) void read()
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  if (expiry) clearTimeout(expiry)
  if (retry) clearTimeout(retry)
})
const href = computed(() =>
  backupId.value
    ? backupApi.downloadUrl(backupId.value)
    : exportUntil.value !== null && !expired.value
      ? transferApi.fileUrl(props.job)
      : null,
)
/** Review (nit 8): which file, where a turn shows several. */
const label = computed(() => (backupId.value ? t('ai.agent.downloadBackup') : t('ai.agent.downloadExport')))
</script>

<template>
  <a
    v-if="href"
    :href="href"
    download
    :aria-label="label"
    class="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md bg-accent px-2 text-small font-medium text-on-accent hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
    data-agent-download
  >
    <Download class="size-3.5" aria-hidden="true" />{{ t('ai.agent.download') }}
  </a>
</template>
