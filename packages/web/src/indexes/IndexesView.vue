<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import MaskedBanner from '@/masking/MaskedBanner.vue'
import { provideMaskedPaths } from '@/masking/useMaskedPaths'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { JobView } from '@mongo-manager/shared'
import { ArrowDown, ArrowUp, Eye, EyeOff, ListTree, Plus, RotateCw, Trash2 } from 'lucide-vue-next'
import DsButton from '@/ds/DsButton.vue'
import DsCard from '@/ds/DsCard.vue'
import DsBadge from '@/ds/DsBadge.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsDataTable from '@/ds/DsDataTable.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsMenu from '@/ds/DsMenu.vue'
import DsProgress from '@/ds/DsProgress.vue'
import type { DsColumn } from '@/ds/table'
import type { DsMenuItem } from '@/ds/menu'
import { documentKeys, documentsApi, type CollectionTarget, type IndexInfo } from '@/api/documents'
import { connectionsApi, queryKeys } from '@/api/connections'
import { describeError } from '@/api/errors'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import { useJobsStore } from '@/jobs/store'
import { formatBytes, formatCount } from '@/format'
import { decodeValue, toShell } from '@/documents/values'

const IndexCreateDialog = defineAsyncComponent(() => import('./IndexCreateDialog.vue'))
// W2.6: Atlas Search and Vector Search indexes, below the others.
const SearchIndexesCard = defineAsyncComponent(() => import('./SearchIndexesCard.vue'))

const props = defineProps<{ target: CollectionTarget; canManage: boolean }>()

// W5 (spec 3c §7): the masking hint on every data screen, and the hidden paths for the locks.
const masking = provideMaskedPaths(
  computed(() => props.target.connectionId),
  computed(() => props.target.db),
  computed(() => props.target.coll),
)
const { t, locale } = useI18n()
const queryClient = useQueryClient()
const dialogs = useDialogStore()
const toasts = useToastStore()
const creating = ref(false)
const jobs = useJobsStore()

const { data, isPending, isError, error, refetch } = useQuery({
  queryKey: documentKeys.indexes(props.target),
  queryFn: () => documentsApi.indexes(props.target),
})
// UI redesign R2 §3: each index's size, from the collection's statistics (shared with its header).
const stats = useQuery({
  queryKey: queryKeys.collectionStats(props.target.connectionId, props.target.db, props.target.coll),
  queryFn: () =>
    connectionsApi.collectionStats(props.target.connectionId, props.target.db, props.target.coll),
})
const sizeOf = (index: IndexInfo) => {
  // Twelfth review of explain masking: hidden where personal data is hidden from you.
  if (stats.data.value?.sizesHidden) return t('overview.stats.hidden')
  const bytes = stats.data.value?.indexSizes?.[index.name]
  return bytes === undefined ? '' : formatBytes(bytes, locale.value)
}

// Builds run as background jobs (phase 1h): the list of this collection's builds is read once, and
// the jobs store, fed by the real-time channel, keeps it current. Nothing polls here.
const seed = useQuery({
  queryKey: documentKeys.indexJobs(props.target),
  queryFn: () => documentsApi.indexJobs(props.target),
  retry: false,
})
watch(
  () => seed.data.value?.jobs,
  (list) => {
    for (const job of list ?? []) if (!jobs.byId[job.id]) jobs.upsert(job)
  },
  { immediate: true },
)
const builds = computed(() =>
  jobs
    .forCollection(props.target.connectionId, props.target.db, props.target.coll)
    .filter((j) => j.kind === 'index.create'),
)
const running = computed(() => builds.value.filter((j) => j.state === 'running'))
const failed = computed(() => builds.value.filter((j) => j.state === 'failed'))

// A build that outlived a server restart has no job to report it any more, yet MongoDB may still be
// building it (spec §3, final review I4): follow it in $currentOp until MongoDB lists none.
const leftover = ref(false)
const unknown = computed(() => (leftover.value ? [] : builds.value.filter((j) => j.state === 'unknown')))
const orphanProgress = useQuery({
  queryKey: computed(() => [...documentKeys.indexJobs(props.target), 'progress']),
  queryFn: () => documentsApi.indexProgress(props.target),
  enabled: computed(() => unknown.value.length > 0),
  refetchInterval: 3000,
  retry: false,
})
watch(
  () => orphanProgress.data.value?.builds,
  async (list) => {
    if (list && list.length === 0) {
      leftover.value = true
      await refresh()
    }
  },
)
const orphan = computed(() => orphanProgress.data.value?.builds.find((b) => b.total) ?? null)
const orphanPercent = computed(() =>
  orphan.value?.total && orphan.value.done !== null
    ? Math.min(100, Math.floor((orphan.value.done / orphan.value.total) * 100))
    : null,
)
/** Percent of a build, once MongoDB reports how far its scan is. */
const percentOf = (job: JobView) =>
  job.progress && job.progress.total > 0
    ? Math.min(100, Math.floor((job.progress.done / job.progress.total) * 100))
    : null

const optionsOf = (index: IndexInfo) => decodeValue(index.options) as Record<string, unknown>
/** The index's keys one by one: a field and its direction, or its kind (text, 2dsphere, hashed). */
function keyParts(
  index: IndexInfo,
): { field: string; direction: 'asc' | 'desc' | null; kind: string | null }[] {
  const key = decodeValue(index.key) as Record<string, unknown>
  return Object.entries(key).map(([field, value]) => {
    const n = typeof value === 'number' ? value : Number((value as { valueOf(): unknown })?.valueOf?.())
    if (n === 1 || n === -1) return { field, direction: n === 1 ? 'asc' : 'desc', kind: null }
    return { field, direction: null, kind: String(value) }
  })
}
const keyText = (index: IndexInfo) => toShell(decodeValue(index.key), 0)
const isHidden = (index: IndexInfo) => optionsOf(index).hidden === true

/** A TTL in the largest whole unit it is (365 d, not 31536000 s). */
function ttlText(seconds: number): string {
  if (seconds > 0 && seconds % 86_400 === 0) return t('indexes.ttlDays', { n: seconds / 86_400 })
  if (seconds > 0 && seconds % 3_600 === 0) return t('indexes.ttlHours', { n: seconds / 3_600 })
  if (seconds > 0 && seconds % 60 === 0) return t('indexes.ttlMinutes', { n: seconds / 60 })
  return t('indexes.ttl', { seconds })
}

function properties(index: IndexInfo): string[] {
  const options = optionsOf(index)
  const list: string[] = []
  if (options.unique === true) list.push(t('indexes.unique'))
  if (options.sparse === true) list.push(t('indexes.sparse'))
  if (options.expireAfterSeconds !== undefined) list.push(ttlText(Number(options.expireAfterSeconds)))
  if (options.partialFilterExpression !== undefined) list.push(t('indexes.partial'))
  if (options.hidden === true) list.push(t('indexes.hidden'))
  return list
}

function usageText(index: IndexInfo): string {
  if (!index.usage) return t('indexes.noUsage')
  return t('indexes.usageValue', {
    ops: formatCount(index.usage.ops, locale.value),
    since: new Date(index.usage.since).toLocaleDateString(locale.value),
  })
}

/** Index changes also change the collection's index count and size. */
const refresh = () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: documentKeys.indexes(props.target) }),
    queryClient.invalidateQueries({
      queryKey: queryKeys.collectionStats(props.target.connectionId, props.target.db, props.target.coll),
    }),
  ])

async function toggleHidden(index: IndexInfo): Promise<void> {
  const hide = !isHidden(index)
  try {
    await documentsApi.hideIndex(props.target, index.name, hide)
    await refresh()
    toasts.push({
      kind: 'success',
      message: t(hide ? 'indexes.hiddenNow' : 'indexes.visibleNow', { name: index.name }),
    })
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  }
}

const columns = computed<DsColumn[]>(() => [
  { key: 'name', label: t('indexes.name'), mono: true },
  { key: 'keys', label: t('indexes.keys') },
  { key: 'properties', label: t('indexes.properties') },
  { key: 'size', label: t('indexes.size'), align: 'right', width: '6rem' },
  { key: 'usage', label: t('indexes.usage'), align: 'right', width: '11rem' },
])
const rowMenu = (index: IndexInfo): DsMenuItem[] => [
  isHidden(index)
    ? { id: 'unhide', label: t('indexes.unhide'), icon: Eye }
    : { id: 'hide', label: t('indexes.hide'), icon: EyeOff },
  { id: 'drop', label: t('indexes.drop'), icon: Trash2, danger: true },
]
function onRowMenu(index: IndexInfo, id: string): void {
  if (id === 'drop') void drop(index)
  else void toggleHidden(index)
}

async function drop(index: IndexInfo): Promise<void> {
  const ok = await dialogs.confirm({
    title: t('indexes.drop'),
    message: t('indexes.dropConfirm', { name: index.name }),
    confirmLabel: t('menu.drop'),
    danger: true,
  })
  if (!ok) return
  try {
    await documentsApi.dropIndex(props.target, index.name)
    await refresh()
    toasts.push({ kind: 'success', message: t('indexes.dropped', { name: index.name }) })
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  }
}
</script>

<template>
  <section class="flex h-full min-h-0 flex-col gap-4 overflow-auto p-4">
    <MaskedBanner v-if="masking.hidden.value" />
    <DsCard :title="t('indexes.title')" :count="data?.length" actions-shown>
      <template #actions>
        <DsButton v-if="canManage" size="sm" variant="primary" :icon="Plus" @click="creating = true">
          {{ t('indexes.create') }}
        </DsButton>
      </template>
      <div class="flex flex-col gap-3">
        <ul v-if="running.length > 0 || unknown.length > 0" class="flex flex-col gap-3" aria-live="polite">
          <li
            v-for="job in running"
            :key="job.id"
            class="flex flex-col gap-1.5 rounded-lg bg-subtle px-3 py-2.5"
          >
            <span class="text-ui text-fg">{{
              percentOf(job) === null || !job.progress
                ? t('indexes.buildingNamed', { name: job.target })
                : t('indexes.buildingProgress', {
                    name: job.target,
                    percent: percentOf(job),
                    done: job.progress.done,
                    total: job.progress.total,
                  })
            }}</span>
            <DsProgress
              :label="t('indexes.buildProgressFor', { name: job.target })"
              :value="percentOf(job) === null ? undefined : percentOf(job)! / 100"
              :value-text="percentOf(job) === null ? t('indexes.buildUnknown') : undefined"
            />
          </li>
          <li
            v-for="job in unknown"
            :key="job.id"
            class="flex flex-col gap-1.5 rounded-lg bg-subtle px-3 py-2.5"
          >
            <span class="text-ui text-fg">{{
              orphanPercent === null || !orphan
                ? t('indexes.buildingNamed', { name: job.target })
                : t('indexes.buildingProgress', {
                    name: job.target,
                    percent: orphanPercent,
                    done: orphan.done,
                    total: orphan.total,
                  })
            }}</span>
            <DsProgress
              :label="t('indexes.buildProgressFor', { name: job.target })"
              :value="orphanPercent === null ? undefined : orphanPercent / 100"
              :value-text="orphanPercent === null ? t('indexes.buildUnknown') : undefined"
            />
            <span class="text-small text-fg-subtle">{{ t('jobs.state.unknown') }}</span>
          </li>
        </ul>
        <DsCallout v-for="job in failed" :key="job.id" tone="danger">
          {{ t('indexes.buildFailed', { name: job.target, error: job.error ?? '' }) }}
        </DsCallout>
        <DsDataTable
          :label="t('indexes.title')"
          :error="isError ? describeError(error, t) : undefined"
          :columns="columns"
          :rows="data ?? []"
          :loading-label="t('app.loading')"
          :row-key="(index: IndexInfo) => index.name"
          :loading="isPending"
          :actions-label="t('documents.actionsColumn')"
        >
          <template #cell-name="{ row: index }">
            <span class="break-all">{{ index.name }}</span>
          </template>
          <template #cell-keys="{ row: index }">
            <span class="flex flex-wrap gap-1" :title="keyText(index)">
              <span
                v-for="part in keyParts(index)"
                :key="part.field"
                class="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-small [overflow-wrap:anywhere] text-fg"
              >
                {{ part.field }}
                <template v-if="part.direction">
                  <component
                    :is="part.direction === 'asc' ? ArrowUp : ArrowDown"
                    class="size-3 text-fg-subtle"
                    aria-hidden="true"
                  />
                  <span class="sr-only">{{
                    t(part.direction === 'asc' ? 'indexes.ascending' : 'indexes.descending')
                  }}</span>
                </template>
                <span v-else class="text-fg-subtle">{{ part.kind }}</span>
              </span>
            </span>
          </template>
          <template #cell-properties="{ row: index }">
            <span class="flex flex-wrap gap-1">
              <DsBadge v-for="property in properties(index)" :key="property">{{ property }}</DsBadge>
            </span>
          </template>
          <template #cell-size="{ row: index }">
            <span class="text-fg-muted">{{ sizeOf(index) }}</span>
          </template>
          <template #cell-usage="{ row: index }">
            <span class="text-small text-fg-subtle">{{ usageText(index) }}</span>
          </template>
          <template #actions="{ row: index }">
            <DsMenu
              v-if="canManage && index.name !== '_id_'"
              focusable
              touch
              :label="t('indexes.actionsFor', { name: index.name })"
              :items="rowMenu(index)"
              @select="onRowMenu(index, $event)"
            />
          </template>
          <template #retry>
            <DsButton size="sm" :icon="RotateCw" @click="refetch()">{{ t('common.retry') }}</DsButton>
          </template>
          <template #empty>
            <DsEmptyState :icon="ListTree" :title="t('indexes.emptyTitle')" :description="t('indexes.empty')">
              <template v-if="canManage" #actions>
                <DsButton variant="primary" :icon="Plus" @click="creating = true">{{
                  t('indexes.create')
                }}</DsButton>
              </template>
            </DsEmptyState>
          </template>
        </DsDataTable>
      </div>
    </DsCard>
    <SearchIndexesCard :target="target" :can-manage="canManage" />
    <IndexCreateDialog v-if="creating" :target="target" @close="creating = false" />
  </section>
</template>
