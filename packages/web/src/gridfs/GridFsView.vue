<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/vue-query'
import { useKeepPreviousShown } from '@/masking/rulesEpoch'
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Ellipsis,
  FileText,
  FolderOpen,
  Pencil,
  RotateCw,
  Search,
  Tags,
  Trash2,
  Upload,
  X,
} from 'lucide-vue-next'
import { isSpoofingChar, type GridFsFile } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsDataTable from '@/ds/DsDataTable.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsInput from '@/ds/DsInput.vue'
import DsMenu from '@/ds/DsMenu.vue'
import DsSelect from '@/ds/DsSelect.vue'
import type { DsMenuItem } from '@/ds/menu'
import type { DsColumn } from '@/ds/table'
import { gridfsApi, gridfsKeys, type GridFsListFilter } from '@/api/gridfs'
import { connectionsApi, queryKeys } from '@/api/connections'
import { ApiError } from '@/api/client'
import { describeError } from '@/api/errors'
import { explainError } from '@/api/reasons'
import { formatBytes } from '@/format'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import MetadataDialog from './MetadataDialog.vue'
import GridFsPreview from './GridFsPreview.vue'
import DsDrawer from '@/ds/DsDrawer.vue'
import DsIconButton from '@/ds/DsIconButton.vue'
import DsProgress from '@/ds/DsProgress.vue'
import { INSPECTOR_MAX, INSPECTOR_MIN, useLayoutStore } from '@/stores/layout'
import { uploadToBucket } from './upload'
import { readable } from './readable'

/**
 * Phase 4b §1: a GridFS bucket's files — listed, searched by the start of a name, sorted; downloaded
 * as attachments; uploaded with progress, renamed, described and deleted, as the user may. A
 * restricted user lists them masked, and nothing more, where personal data rules reach this bucket
 * (user report 2026-10-27: rules elsewhere on the connection leave it free; the server says which).
 */
const props = defineProps<{ connectionId: string; db: string; bucket: string }>()
const PAGE = 50
const { t, locale } = useI18n()
const queryClient = useQueryClient()
const dialogs = useDialogStore()
const toasts = useToastStore()
const layout = useLayoutStore()

const connections = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
const connection = computed(() => connections.data.value?.find((c) => c.id === props.connectionId) ?? null)

const search = ref('')
// No sort asked for: the newest first, or the stored order where upload dates are personal data.
const filter = reactive<GridFsListFilter>({ q: undefined, sort: undefined, dir: 'desc' })
let timer: ReturnType<typeof setTimeout> | undefined
watch(search, (text) => {
  clearTimeout(timer)
  timer = setTimeout(() => (filter.q = text.trim() || undefined), 250)
})
const sorts = computed(() => [
  { value: 'uploadDate' as const, label: t('gridfs.sort.uploadDate') },
  { value: 'filename' as const, label: t('gridfs.sort.filename') },
  { value: 'length' as const, label: t('gridfs.sort.length') },
])
const sort = computed({
  get: () => filter.sort ?? 'uploadDate',
  set: (v: 'uploadDate' | 'filename' | 'length') => {
    filter.sort = v === 'uploadDate' ? undefined : v
    // Names read best from A; dates and sizes, the newest and largest first.
    filter.dir = v === 'filename' ? 'asc' : 'desc'
  },
})

const keepPreviousShown = useKeepPreviousShown()
const pages = useInfiniteQuery({
  queryKey: computed(() => gridfsKeys.files(props.connectionId, props.db, props.bucket, { ...filter })),
  queryFn: ({ pageParam }) =>
    gridfsApi.files(props.connectionId, props.db, props.bucket, { ...filter }, pageParam, PAGE),
  initialPageParam: 0,
  getNextPageParam: (last) => last.next ?? undefined,
  // A new order or search keeps the files shown until the new ones come (an open preview stays).
  placeholderData: keepPreviousShown,
})
const files = computed(() => pages.data.value?.pages.flatMap((p) => p.files) ?? [])
/** Rules reach this bucket and hide values from this user; until the server says, assumed so. */
const restricted = computed(
  () => connection.value?.restricted === true && (pages.data.value?.pages[0]?.locked ?? true),
)
const mayRead = computed(
  () => !!connection.value?.permissions.includes('documents:read') && !restricted.value,
)
const mayWrite = computed(
  () => !!connection.value?.permissions.includes('documents:write') && !restricted.value,
)
/** UI redesign R3 leftovers: the files as the kit's data table; a file hidden from this user has no id. */
const fileRows = computed(() => files.value.map((f, i) => ({ f, key: f.id ?? `hidden-${i}` })))
type FileRow = (typeof fileRows.value)[number]
// Review of the Monitoring redesign (I-1): on a narrow card the least needed columns leave first.
const fileColumns = computed<DsColumn[]>(() => [
  { key: 'name', label: t('gridfs.name') },
  { key: 'size', label: t('gridfs.size'), align: 'right', width: '6.5rem' },
  { key: 'type', label: t('gridfs.type'), mono: true, width: '10rem', hideBelow: 700 },
  { key: 'uploaded', label: t('gridfs.uploadedAt'), width: '11rem', hideBelow: 520 },
  { key: 'metadata', label: t('gridfs.metadataColumn'), mono: true, width: '24%', hideBelow: 900 },
])
const refresh = () =>
  queryClient.invalidateQueries({ queryKey: gridfsKeys.all(props.connectionId, props.db) })

const hidden = (f: GridFsFile, field: string) => f.masked.includes(field)
const size = (f: GridFsFile) =>
  f.length === null ? (hidden(f, 'length') ? t('gridfs.hidden') : '') : formatBytes(f.length, locale.value)
const when = (f: GridFsFile) =>
  f.uploadDate
    ? new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(f.uploadDate),
      )
    : hidden(f, 'uploadDate')
      ? t('gridfs.hidden')
      : ''
const type = (f: GridFsFile) => f.contentType ?? (hidden(f, 'contentType') ? t('gridfs.hidden') : '')
/**
 * A name as shown: what would fake its form (a direction override, a control) made visible, for
 * names written by other tools (4b review M4).
 */
const shownName = (name: string) =>
  [...name].map((c) => (isSpoofingChar(c.codePointAt(0)!) ? '\uFFFD' : c)).join('')
/** The metadata as read, its content type left to its own column; hidden where it is personal data. */
const preview = (f: GridFsFile) => {
  const m = f.metadata
  if (!m || typeof m !== 'object' || Array.isArray(m)) return hidden(f, 'metadata') ? t('gridfs.hidden') : ''
  const { contentType: _type, ...rest } = m
  if (!Object.keys(rest).length) return ''
  const text = JSON.stringify(readable(rest))
  return text.length > 80 ? `${text.slice(0, 79)}…` : text
}
const download = (id: string) => gridfsApi.downloadHref(props.connectionId, props.db, props.bucket, id)

// ---- Uploads: every picked file listed at once, sent one after another.
interface UploadRow {
  key: number
  name: string
  percent: number
  state: 'waiting' | 'sending' | 'error'
  error: string | null
}
const uploads = ref<UploadRow[]>([])
const picked = new Map<number, File>()
let counter = 0
let sending: { key: number; abort: () => void } | null = null
let pumping = false
let closed = false
const input = ref<HTMLInputElement | null>(null)
function upload(list: FileList | File[] | null): void {
  const rows = [...(list ?? [])].map((file) => {
    const key = ++counter
    picked.set(key, file)
    return { key, name: file.name, percent: 0, state: 'waiting' as const, error: null }
  })
  uploads.value = [...uploads.value, ...rows]
  // The picker is free again at once: the same files may be picked again.
  if (input.value) input.value.value = ''
  void pump()
}
async function pump(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    for (;;) {
      const entry = uploads.value.find((u) => u.state === 'waiting')
      if (!entry || closed) break
      await send(entry)
    }
  } finally {
    pumping = false
  }
}
async function send(entry: UploadRow): Promise<void> {
  const file = picked.get(entry.key)!
  const row = () => uploads.value.find((u) => u.key === entry.key)
  row()!.state = 'sending'
  const job = uploadToBucket(
    (type) => gridfsApi.uploadHref(props.connectionId, props.db, props.bucket, file.name, type),
    file,
    (percent) => {
      const r = row()
      if (r) r.percent = percent
    },
  )
  sending = { key: entry.key, abort: job.abort }
  try {
    await job.done
    drop(entry.key)
    toasts.push({ kind: 'success', message: t('gridfs.uploaded', { name: file.name }) })
  } catch (e) {
    if (e instanceof ApiError && e.code === 'CANCELLED') drop(entry.key)
    else {
      const r = row()
      if (r) Object.assign(r, { state: 'error', error: explainError(e, t) })
      picked.delete(entry.key)
    }
  } finally {
    sending = null
  }
  if (!closed) await refresh()
}
function drop(key: number): void {
  picked.delete(key)
  uploads.value = uploads.value.filter((u) => u.key !== key)
}
/** Cancel a waiting or a sending file; dismiss a failed one. */
function stop(u: UploadRow): void {
  if (u.state === 'sending' && sending?.key === u.key) sending.abort()
  else drop(u.key)
}
// Leaving the page stops what it started: the file being sent, the files waiting, the search timer.
// ---- Previews (user request 2026-10-10): one file at a time, the others a step away.
const previewId = ref<string | null>(null)
const previewable = computed(() =>
  mayRead.value ? files.value.filter((f): f is GridFsFile & { id: string } => f.id !== null) : [],
)
const previewIndex = computed(() => previewable.value.findIndex((f) => f.id === previewId.value))
const previewed = computed(() => previewable.value[previewIndex.value] ?? null)
async function step(by: number): Promise<void> {
  // The last file shown and more on the server: their next page first (preview review M7).
  if (by > 0 && previewIndex.value === previewable.value.length - 1 && pages.hasNextPage.value)
    await pages.fetchNextPage()
  const next = previewable.value[previewIndex.value + by]
  if (!next) return
  previewId.value = next.id
  // A button that turns disabled (the first or last file) would drop the focus: the panel keeps it.
  await nextTick()
  const focused = document.activeElement as HTMLButtonElement | null
  if (!focused || focused === document.body || focused.disabled)
    document.getElementById('gridfs-preview-panel')?.focus()
}
/**
 * Left and right change the file — on the panel itself, never while resizing it, seeking a sound
 * or a video, or reading a text (preview review I1).
 */
function onPanelKey(event: KeyboardEvent): void {
  if ((event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || event.defaultPrevented) return
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  const target = event.target as HTMLElement
  if (target.closest('[role="separator"], video, audio, pre, input, textarea, select')) return
  event.preventDefault()
  void step(event.key === 'ArrowLeft' ? -1 : 1)
}
// A file gone from the list (deleted, searched away) closes its preview. A new order or search keeps
// the files shown until the new ones come (keepPreviousData), so an open preview stays meanwhile.
watch(previewed, (f) => {
  if (!f && previewId.value) previewId.value = null
})

onBeforeUnmount(() => {
  closed = true
  clearTimeout(timer)
  sending?.abort()
})

// ---- Changes
const editing = ref<GridFsFile | null>(null)
const menuFor = (): DsMenuItem[] => [
  { id: 'rename', label: t('gridfs.rename'), icon: Pencil },
  { id: 'metadata', label: t('gridfs.editMetadata'), icon: Tags },
  { id: 'delete', label: t('gridfs.delete'), icon: Trash2, danger: true, separator: true },
]
async function run(action: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await action()
    toasts.push({ kind: 'success', message })
    await refresh()
  } catch (e) {
    toasts.push({ kind: 'error', message: explainError(e, t) })
  }
}
async function onSelect(f: GridFsFile, id: string): Promise<void> {
  if (id === 'rename') {
    const name = await dialogs.prompt({
      title: t('gridfs.rename'),
      message: t('gridfs.renameMessage', { name: shownName(f.filename) }),
      confirmLabel: t('gridfs.rename'),
      input: { type: 'text', label: t('gridfs.newName'), value: f.filename },
    })
    if (name && name !== f.filename)
      await run(
        () => gridfsApi.patch(props.connectionId, props.db, props.bucket, f.id!, { filename: name }),
        t('gridfs.renamed', { name }),
      )
  } else if (id === 'metadata') editing.value = f
  else if (id === 'delete') {
    const ok = await dialogs.confirm({
      title: t('gridfs.deleteTitle'),
      message: t('gridfs.deleteMessage', { name: shownName(f.filename) }),
      confirmLabel: t('gridfs.delete'),
      danger: true,
    })
    if (ok)
      await run(
        () => gridfsApi.remove(props.connectionId, props.db, props.bucket, f.id!),
        t('gridfs.deleted', { name: f.filename }),
      )
  }
}
async function saveMetadata(metadata: Record<string, unknown> | null): Promise<void> {
  const f = editing.value
  if (!f) return
  editing.value = null
  await run(
    // Data review 2026-10-13 (M3): only from the version shown; a change in between is refused.
    () =>
      gridfsApi.patch(props.connectionId, props.db, props.bucket, f.id!, {
        metadata,
        ...(f.version ? { version: f.version } : {}),
      }),
    t('gridfs.metadata.saved', { name: f.filename }),
  )
}
</script>

<template>
  <section data-gridfs class="flex h-full min-h-0">
    <div class="min-w-0 flex-1 overflow-auto">
      <div class="mx-auto flex max-w-6xl flex-col gap-5 px-6 py-5">
        <header class="flex flex-wrap items-center gap-3">
          <span
            class="grid size-9 place-items-center rounded-xl bg-accent-soft text-accent-fg"
            aria-hidden="true"
          >
            <FolderOpen class="size-[18px]" />
          </span>
          <div class="min-w-0 flex-1 basis-60">
            <h2 class="truncate text-title-l font-semibold text-fg">{{ bucket }}</h2>
            <p class="text-small text-fg-subtle">{{ t('gridfs.subtitle', { db }) }}</p>
          </div>
          <template v-if="mayWrite">
            <input
              ref="input"
              type="file"
              multiple
              data-gridfs-upload
              class="sr-only"
              :aria-label="t('gridfs.upload')"
              @change="upload(($event.target as HTMLInputElement).files)"
            />
            <DsButton variant="primary" :icon="Upload" @click="input?.click()">{{
              t('gridfs.upload')
            }}</DsButton>
          </template>
        </header>

        <DsCallout v-if="restricted" data-gridfs-restricted tone="info">{{
          t('gridfs.restricted')
        }}</DsCallout>

        <ul v-if="uploads.length" class="flex flex-col gap-2" :aria-label="t('gridfs.uploads')">
          <li
            v-for="u in uploads"
            :key="u.key"
            class="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-2.5 shadow-xs"
          >
            <FileText class="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
            <div class="min-w-0 flex-1">
              <span class="block truncate text-ui text-fg">{{ shownName(u.name) }}</span>
              <span v-if="u.error" role="alert" class="block text-small text-danger">{{ u.error }}</span>
              <DsProgress
                v-else
                class="mt-1.5"
                :label="t('gridfs.uploading', { name: u.name })"
                :value="u.percent / 100"
              />
            </div>
            <span v-if="u.state === 'waiting'" class="text-small text-fg-subtle">{{
              t('gridfs.waiting')
            }}</span>
            <DsButton size="sm" variant="ghost" :icon="X" @click="stop(u)">
              {{ u.state === 'error' ? t('gridfs.dismiss') : t('common.cancel') }}
            </DsButton>
          </li>
        </ul>

        <div class="flex flex-wrap items-end gap-3">
          <div class="max-w-80 min-w-56 flex-1">
            <DsInput
              v-model="search"
              :icon="Search"
              clearable
              :label="t('gridfs.search')"
              hide-label
              :placeholder="t('gridfs.search')"
            />
          </div>
          <div class="w-44">
            <DsSelect v-model="sort" :label="t('gridfs.sortBy')" hide-label :options="sorts" />
          </div>
        </div>

        <div class="rounded-xl border border-line bg-surface p-1 shadow-xs">
          <DsDataTable
            :label="t('gridfs.files')"
            :columns="fileColumns"
            :rows="fileRows"
            :row-key="(r: FileRow) => r.key"
            :loading="pages.isPending.value"
            :loading-label="t('tree.loading')"
            :error="pages.isError.value && !files.length ? describeError(pages.error.value, t) : undefined"
            :actions-label="t('documents.actionsColumn')"
            actions-width="5.5rem"
            actions-visible
          >
            <template #cell-name="{ row: { f } }">
              <span class="flex min-w-0 items-center gap-2" data-gridfs-file>
                <FileText class="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
                <button
                  v-if="mayRead && f.id"
                  type="button"
                  data-gridfs-preview
                  class="cursor-pointer truncate rounded-sm text-left font-medium text-fg hover:text-accent-fg hover:underline focus-visible:outline-2 focus-visible:outline-focus"
                  :title="t('gridfs.preview.open', { name: shownName(f.filename) })"
                  :aria-expanded="previewId === f.id"
                  aria-controls="gridfs-preview-panel"
                  @click="previewId = f.id"
                >
                  {{ shownName(f.filename) }}
                </button>
                <span v-else class="truncate font-medium text-fg" :title="shownName(f.filename)">{{
                  shownName(f.filename)
                }}</span>
              </span>
            </template>
            <template #cell-size="{ row: { f } }">
              <span class="text-fg-muted">{{ size(f) }}</span>
            </template>
            <template #cell-type="{ row: { f } }">
              <span class="text-fg-subtle" :title="type(f)">{{ type(f) }}</span>
            </template>
            <template #cell-uploaded="{ row: { f } }">
              <span class="text-fg-muted">{{ when(f) }}</span>
            </template>
            <template #cell-metadata="{ row: { f } }">
              <span class="text-small text-fg-subtle" :title="preview(f)" data-gridfs-metadata-preview>{{
                preview(f)
              }}</span>
            </template>
            <template #actions="{ row: { f } }">
              <span class="flex items-center justify-end gap-1">
                <a
                  v-if="mayRead && f.id"
                  data-gridfs-download
                  :href="download(f.id)"
                  download
                  class="grid size-7 place-items-center rounded-md text-fg-subtle hover:bg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:size-11"
                  :aria-label="t('gridfs.download', { name: shownName(f.filename) })"
                  :title="t('gridfs.download', { name: shownName(f.filename) })"
                >
                  <Download class="size-4" aria-hidden="true" />
                </a>
                <DsMenu
                  v-if="mayWrite && f.id"
                  focusable
                  touch
                  :icon="Ellipsis"
                  :label="t('gridfs.actions', { name: shownName(f.filename) })"
                  :items="menuFor()"
                  @select="onSelect(f, $event)"
                />
              </span>
            </template>
            <template #retry>
              <DsButton size="sm" :icon="RotateCw" @click="pages.refetch()">{{ t('common.retry') }}</DsButton>
            </template>
            <template #empty>
              <DsEmptyState
                :icon="FolderOpen"
                :title="filter.q ? t('gridfs.noMatch') : t('gridfs.empty')"
                :description="filter.q || !mayWrite ? undefined : t('gridfs.emptyHint')"
              />
            </template>
          </DsDataTable>
        </div>
        <DsCallout v-if="pages.isFetchNextPageError.value" data-gridfs-more-error tone="danger">
          {{ describeError(pages.error.value, t) }}
          <template #action>
            <DsButton size="sm" :icon="RotateCw" @click="pages.fetchNextPage()">{{
              t('common.retry')
            }}</DsButton>
          </template>
        </DsCallout>
        <DsButton
          v-if="pages.hasNextPage.value"
          size="sm"
          class="self-center"
          :loading="pages.isFetchingNextPage.value"
          @click="pages.fetchNextPage()"
        >
          {{ t('gridfs.more') }}
        </DsButton>
      </div>
    </div>
    <DsDrawer
      v-if="previewed"
      open
      :title="t('gridfs.preview.title')"
      :subtitle="shownName(previewed.filename)"
      :width="layout.inspectorWidth"
      :min-width="INSPECTOR_MIN"
      :max-width="INSPECTOR_MAX"
      :resize-label="t('documents.inspector.resize')"
      :close-label="t('gridfs.preview.close')"
      :overlay="layout.inspectorOverlay"
      @close="previewId = null"
      @update:width="layout.setInspectorWidth"
      @keydown="onPanelKey"
    >
      <template #actions>
        <DsIconButton
          :icon="ChevronLeft"
          :label="t('gridfs.preview.previous')"
          size="sm"
          :disabled="previewIndex <= 0"
          @click="step(-1)"
        />
        <DsIconButton
          :icon="ChevronRight"
          :label="t('gridfs.preview.next')"
          size="sm"
          :disabled="previewIndex >= previewable.length - 1 && !pages.hasNextPage.value"
          @click="step(1)"
        />
      </template>
      <GridFsPreview
        :connection-id="connectionId"
        :db="db"
        :bucket="bucket"
        :file="previewed"
        :name="shownName(previewed.filename)"
      />
    </DsDrawer>
    <MetadataDialog
      :open="!!editing"
      :name="editing?.filename ?? ''"
      :metadata="editing?.metadata ?? null"
      :caution="editing?.caution ?? null"
      @close="editing = null"
      @save="saveMetadata"
    />
  </section>
</template>
