<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Download, FileQuestion } from 'lucide-vue-next'
import { isSpoofingChar, type GridFsFile } from '@mongo-manager/shared/browser'
import DsSpinner from '@/ds/DsSpinner.vue'
import { ApiError } from '@/api/client'
import { gridfsApi, type GridFsPreviewKind } from '@/api/gridfs'
import { explainError } from '@/api/reasons'
import { formatBytes } from '@/format'
import { readable } from './readable'

/**
 * User request 2026-10-10: a GridFS file's preview — an image, a sound or a video the server
 * recognised by its bytes, shown from a blob the app fetched itself; else the start of its text,
 * always as text. Nothing in a file ever runs here.
 */
const props = defineProps<{
  connectionId: string
  db: string
  bucket: string
  file: GridFsFile & { id: string }
  /** The name as shown (what hides or fakes its form made visible). */
  name: string
}>()
const { t, locale } = useI18n()

type Shown =
  | { state: 'loading' }
  | { state: 'media'; kind: Exclude<GridFsPreviewKind, 'text'>; url: string }
  | { state: 'text'; text: string; truncated: boolean; hidden: boolean }
  | { state: 'none'; reason: 'no_preview' | 'too_large' | 'failed'; message?: string }
const shown = ref<Shown>({ state: 'loading' })
let url: string | null = null
let controller: AbortController | null = null
const release = () => {
  if (url) URL.revokeObjectURL(url)
  url = null
}

/**
 * Characters that hide or reverse text, spelled out as [U+XXXX] (preview review M4): what is shown
 * is what the bytes say. Line breaks and tabs stay as they are.
 */
function visibleText(text: string): { text: string; hidden: boolean } {
  let hidden = false
  const out = [...text]
    .map((c) => {
      const code = c.codePointAt(0)!
      if (c === '\n' || c === '\r' || c === '\t' || !isSpoofingChar(code)) return c
      hidden = true
      return `[U+${code.toString(16).toUpperCase().padStart(4, '0')}]`
    })
    .join('')
  return { text: out, hidden }
}

/** A file the browser cannot show after all (a broken image, an unplayable video). */
const unplayable = () => {
  release()
  shown.value = { state: 'none', reason: 'no_preview' }
}

// A file is read a moment after it is chosen: held arrow keys ask for the one they stop on (M9).
const DELAY_MS = 150
let timer: ReturnType<typeof setTimeout> | undefined
watch(
  () => props.file.id,
  (id) => {
    controller?.abort()
    clearTimeout(timer)
    release()
    shown.value = { state: 'loading' }
    timer = setTimeout(() => void load(id), DELAY_MS)
  },
  { immediate: true },
)
async function load(id: string): Promise<void> {
  const mine = new AbortController()
  controller = mine
  try {
    const preview = await gridfsApi.preview(props.connectionId, props.db, props.bucket, id, mine.signal)
    if (mine.signal.aborted) return
    if (preview.kind === 'text') {
      const text = await preview.blob.text()
      // Another file may have been chosen while this one was read (M1).
      if (mine.signal.aborted) return
      shown.value = { state: 'text', ...visibleText(text), truncated: preview.truncated }
      return
    }
    url = URL.createObjectURL(preview.blob)
    shown.value = { state: 'media', kind: preview.kind, url }
  } catch (e) {
    if (mine.signal.aborted) return
    const reason = e instanceof ApiError ? (e.details as { reason?: unknown } | undefined)?.reason : undefined
    shown.value =
      reason === 'no_preview' || reason === 'too_large'
        ? { state: 'none', reason }
        : { state: 'none', reason: 'failed', message: explainError(e, t) }
  }
}
onBeforeUnmount(() => {
  clearTimeout(timer)
  controller?.abort()
  release()
})

/** A detail that is not known (or hidden). */
const NONE = '—'
const download = () => gridfsApi.downloadHref(props.connectionId, props.db, props.bucket, props.file.id)
const when = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
    : '—'
const metadata = (m: Record<string, unknown> | null) =>
  m && typeof m === 'object' ? JSON.stringify(readable(m), null, 2) : null
</script>

<template>
  <div
    id="gridfs-preview-panel"
    data-gridfs-preview-panel
    tabindex="-1"
    class="flex flex-col gap-4 p-4 outline-none"
  >
    <div
      class="grid min-h-48 place-items-center overflow-hidden rounded-xl border border-line bg-subtle"
      :aria-busy="shown.state === 'loading'"
    >
      <div v-if="shown.state === 'loading'" class="flex items-center gap-2 p-6 text-ui text-fg-subtle">
        <DsSpinner :size="14" />{{ t('gridfs.preview.loading') }}
      </div>
      <img
        v-else-if="shown.state === 'media' && shown.kind === 'image'"
        :src="shown.url"
        :alt="name"
        class="max-h-[60vh] max-w-full object-contain"
        @error="unplayable"
      />
      <video
        v-else-if="shown.state === 'media' && shown.kind === 'video'"
        :src="shown.url"
        controls
        preload="metadata"
        class="max-h-[60vh] w-full bg-black"
        :aria-label="name"
        @error="unplayable"
      />
      <audio
        v-else-if="shown.state === 'media' && shown.kind === 'audio'"
        :src="shown.url"
        controls
        preload="metadata"
        class="m-6 w-[calc(100%-3rem)]"
        :aria-label="name"
        @error="unplayable"
      />
      <div
        v-else-if="shown.state === 'text'"
        role="region"
        :aria-label="t('gridfs.preview.textOf', { name })"
        class="w-full self-stretch"
      >
        <p v-if="shown.hidden" class="border-b border-line px-3 py-1.5 text-small text-warning">
          {{ t('gridfs.preview.hidden') }}
        </p>
        <pre
          class="max-h-[60vh] overflow-auto p-3 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-fg [overflow-wrap:anywhere]"
          tabindex="0"
          >{{ shown.text }}</pre>
        <p v-if="shown.truncated" class="border-t border-line px-3 py-1.5 text-small text-fg-muted">
          {{ t('gridfs.preview.truncated') }}
        </p>
      </div>
      <div v-else-if="shown.state === 'none'" class="flex flex-col items-center gap-2 p-6 text-center">
        <FileQuestion class="size-6 text-fg-subtle" aria-hidden="true" />
        <p class="text-ui font-medium text-fg">
          {{ shown.reason === 'failed' ? shown.message : t(`gridfs.preview.${shown.reason}`) }}
        </p>
        <p v-if="shown.reason !== 'failed'" class="text-small text-fg-muted">
          {{ t('gridfs.preview.downloadHint') }}
        </p>
      </div>
    </div>

    <a
      :href="download()"
      download
      class="inline-flex items-center justify-center gap-2 self-start rounded-md border border-line-strong bg-surface px-3 py-1.5 text-ui font-medium text-fg hover:bg-subtle focus-visible:outline-2 focus-visible:outline-focus"
    >
      <Download class="size-4" aria-hidden="true" />{{ t('gridfs.preview.download') }}
    </a>

    <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-small">
      <dt class="text-fg-subtle">{{ t('gridfs.name') }}</dt>
      <dd class="font-medium break-all text-fg">{{ name }}</dd>
      <dt class="text-fg-subtle">{{ t('gridfs.size') }}</dt>
      <dd class="text-fg tabular-nums">
        {{ file.length === null ? NONE : formatBytes(file.length, locale) }}
      </dd>
      <dt class="text-fg-subtle">{{ t('gridfs.type') }}</dt>
      <dd class="font-mono text-fg">{{ file.contentType ?? NONE }}</dd>
      <dt class="text-fg-subtle">{{ t('gridfs.uploadedAt') }}</dt>
      <dd class="text-fg">{{ when(file.uploadDate) }}</dd>
    </dl>
    <div v-if="metadata(file.metadata)">
      <h3 class="mb-1 text-small font-medium text-fg-subtle">{{ t('gridfs.metadataColumn') }}</h3>
      <pre
        class="max-h-64 overflow-auto rounded-lg border border-line bg-subtle p-2.5 font-mono text-[12px] whitespace-pre-wrap text-fg"
        >{{ metadata(file.metadata) }}</pre>
    </div>
  </div>
</template>
