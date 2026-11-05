<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import {
  ArchiveRestore,
  FileArchive,
  Hourglass,
  Lock,
  RotateCw,
  Snowflake,
  Sun,
  Trash2,
} from 'lucide-vue-next'
import type { DestinationSummary, RemoteBackup } from '@mongo-manager/shared/browser'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import DsButton from '@/ds/DsButton.vue'
import DsSelect from '@/ds/DsSelect.vue'
import { destinationKeys, destinationsApi } from '@/api/destinations'
import { useBackupError, useListingError } from './checkText'
import { useToastStore } from '@/stores/toasts'
import { useWorkspaceDialogs } from '@/stores/workspaceDialogs'
import { formatBytes, formatRelative } from '@/format'
import DsCallout from '@/ds/DsCallout.vue'

/** Phase 3d-3b V6: a destination's backups — what they are, who sent them, and what can be done. */
const props = defineProps<{
  destination: DestinationSummary
  connectionId: string
  db?: string
  canRestore: boolean
}>()
const { t, locale } = useI18n()
const toasts = useToastStore()
const dialogs = useWorkspaceDialogs()
const queryClient = useQueryClient()
const backupError = useBackupError()
const say = (e: unknown) => backupError(e).join(' ')
const listingError = useListingError()
const first = useQuery({
  queryKey: computed(() => destinationKeys.remote(props.destination.id)),
  queryFn: () => destinationsApi.remote(props.destination.id),
})
const more = ref<RemoteBackup[]>([])
const cursor = ref<string | null | undefined>(undefined)
const loadingMore = ref(false)
const nextCursor = computed(() =>
  cursor.value === undefined ? (first.data.value?.cursor ?? null) : cursor.value,
)
const pending = ref(new Set<string>())
/**
 * Final review C23: after a delete the first page is read again and the next pages shift — a backup
 * already loaded on a later page may come again: each key is listed once.
 */
const rows = computed(() => {
  const seen = new Set<string>()
  return [...(first.data.value?.items ?? []), ...more.value].filter((r) => {
    if (seen.has(r.key)) return false
    seen.add(r.key)
    return !r.copyId || !pending.value.has(r.copyId)
  })
})
const now = ref(Date.now())
const tick = setInterval(() => (now.value = Date.now()), 60_000)
onBeforeUnmount(() => clearInterval(tick))

async function loadMore(): Promise<void> {
  if (!nextCursor.value) return
  loadingMore.value = true
  try {
    const page = await destinationsApi.remote(props.destination.id, nextCursor.value)
    more.value = [...more.value, ...page.items]
    cursor.value = page.cursor
  } catch (e) {
    toasts.push({ kind: 'error', message: listingError(e) })
  } finally {
    loadingMore.value = false
  }
}
const restore = (r: RemoteBackup) =>
  dialogs.open({
    kind: 'backupRestore',
    connectionId: props.connectionId,
    ...(props.db ? { db: props.db } : {}),
    remote: { destinationId: props.destination.id, key: r.key, name: r.name },
  })
const deletable = (r: RemoteBackup) => Boolean(r.copyId) && (r.mine || props.destination.level === 'admin')

/** U10 for remote copies: the row goes at once; the delete is sent when the toast closes without Undo. */
function remove(r: RemoteBackup): void {
  const copyId = r.copyId!
  pending.value = new Set([...pending.value, copyId])
  let settled = false
  const unhide = () => {
    const next = new Set(pending.value)
    next.delete(copyId)
    pending.value = next
  }
  let sent = false
  const send = (leaving = false) => {
    if (settled) return
    settled = true
    sent = true
    void destinationsApi
      .removeRemote(props.destination.id, copyId, leaving ? { keepalive: true } : undefined)
      .then(() => queryClient.invalidateQueries({ queryKey: destinationKeys.all }))
      .catch((e) => {
        unhide()
        toasts.push({ kind: 'error', message: say(e) })
      })
  }
  const onLeave = () => send(true)
  /**
   * Final review C23: a page kept in the back-forward cache comes back with its toast — the delete
   * was sent when it left, so Undo has nothing left to undo; the list is read again instead.
   */
  const onBack = (e: PageTransitionEvent) => {
    if (!e.persisted || !sent) return
    window.removeEventListener('pageshow', onBack)
    toasts.dismiss(toastId)
    void queryClient.invalidateQueries({ queryKey: destinationKeys.all })
  }
  window.addEventListener('pagehide', onLeave, { once: true })
  window.addEventListener('pageshow', onBack)
  const toastId = toasts.push({
    kind: 'info',
    message: t('backup.remote.deleted', { name: props.destination.name }),
    timeoutMs: 5000,
    actions: [
      {
        label: t('backup.list.undo'),
        run: () => {
          if (sent) return
          settled = true
          unhide()
        },
      },
    ],
    onClose: (reason) => {
      window.removeEventListener('pagehide', onLeave)
      window.removeEventListener('pageshow', onBack)
      if (reason !== 'action') send()
    },
  })
}
/**
 * W4.5: an archived copy (S3 GLACIER or DEEP_ARCHIVE) is thawed first — a readable copy for some
 * days, at a speed the provider bills for. One row's form is open at a time.
 */
const thawOpen = ref<string | null>(null)
const thawDays = ref('3')
const thawTier = ref<'Expedited' | 'Standard' | 'Bulk'>('Standard')
const thawBusy = ref(false)
const DAYS = ['1', '3', '7', '14', '30']
const dayOptions = computed(() =>
  DAYS.map((d) => ({ value: d, label: t('backup.thaw.days', { n: Number(d) }, Number(d)) })),
)
/** W4.5: Azure rehydrates an Archive blob to Cool for good: no days, two priorities. */
const azure = computed(() => props.destination.type === 'azure')
const tierOptions = computed(() =>
  azure.value
    ? (['Standard', 'Expedited'] as const).map((v) => ({ value: v, label: t(`backup.thaw.azureTier.${v}`) }))
    : (['Standard', 'Bulk', 'Expedited'] as const).map((v) => ({
        value: v,
        label: t(`backup.thaw.tier.${v}`),
      })),
)
async function thaw(r: RemoteBackup): Promise<void> {
  thawBusy.value = true
  try {
    await destinationsApi.thaw(props.destination.id, {
      key: r.key,
      days: Number(thawDays.value),
      tier: thawTier.value,
    })
    thawOpen.value = null
    toasts.push({ kind: 'info', message: t('backup.thaw.started', { name: r.name }) })
    await queryClient.invalidateQueries({ queryKey: destinationKeys.remote(props.destination.id) })
  } catch (e) {
    toasts.push({ kind: 'error', message: say(e) })
  } finally {
    thawBusy.value = false
  }
}
const b = (n: number) => formatBytes(n, locale.value)
const when = (r: RemoteBackup) =>
  r.createdAt ? formatRelative(Math.min(0, r.createdAt - now.value), locale.value) : ''
const actionBase =
  'inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none'
const action = `${actionBase} text-fg-muted hover:bg-subtle`
const danger = `${actionBase} text-danger hover:bg-danger-soft`
const chip = 'rounded-full px-1.5 py-px text-[11px] font-medium'
</script>

<template>
  <div v-if="first.isPending.value" class="flex flex-col gap-2" aria-busy="true">
    <DsSkeleton v-for="n in 3" :key="n" class="h-11 rounded-lg" />
  </div>
  <DsCallout v-else-if="first.isError.value" tone="danger">
    {{ listingError(first.error.value) }}
    <template #action>
      <DsButton size="sm" :icon="RotateCw" @click="first.refetch()">{{ t('common.retry') }}</DsButton>
    </template>
  </DsCallout>
  <p
    v-else-if="!rows.length"
    class="rounded-xl border border-dashed border-line-strong px-6 py-8 text-center text-ui text-fg-subtle"
  >
    {{ t('backup.remote.empty') }}
  </p>
  <div v-else class="flex flex-col gap-3">
    <ul class="divide-y divide-line">
      <li
        v-for="r in rows"
        :key="r.key"
        data-remote-row
        class="group flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5"
      >
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <div class="flex min-w-0 items-center gap-2">
            <FileArchive class="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
            <span class="truncate font-mono text-small text-fg">{{ r.name }}</span>
            <Lock
              v-if="r.format === 'mmbak'"
              class="size-3.5 shrink-0 text-success"
              role="img"
              :aria-label="t('backup.list.filter.encrypted')"
            />
            <span v-if="r.state === 'incomplete'" :class="chip" class="bg-warning-soft text-warning">{{
              t('backup.remote.incomplete')
            }}</span>
            <span v-else-if="r.state === 'foreign'" :class="chip" class="bg-muted text-fg-muted">{{
              t('backup.remote.foreign')
            }}</span>
          </div>
          <p class="flex flex-wrap gap-x-3 text-small text-fg-subtle">
            <span v-if="r.scope">{{
              r.scope.kind === 'server' ? t('backup.scope.server') : r.scope.db
            }}</span>
            <span v-else>{{ t('backup.remote.unknownScope') }}</span>
            <span v-if="r.sender">{{ t('backup.remote.sender', { name: r.sender }) }}</span>
          </p>
          <p v-if="r.thaw === 'thawing'" class="flex items-center gap-1 text-small text-info" role="status">
            <Hourglass class="size-3.5" aria-hidden="true" />{{ t('backup.thaw.thawing') }}
          </p>
          <p v-else-if="r.thaw === 'thawed'" class="flex items-center gap-1 text-small text-success">
            <Sun class="size-3.5" aria-hidden="true" />{{ t('backup.thaw.thawed') }}
          </p>
          <p v-else-if="r.archived" class="flex items-center gap-1 text-small text-accent-fg">
            <Snowflake class="size-3.5" aria-hidden="true" />{{
              r.thaw === 'none' ? t('backup.thaw.archived') : t('backup.remote.archived')
            }}
          </p>
          <!-- W4.5: the thaw's days and speed, under its row. -->
          <div
            v-if="thawOpen === r.key"
            class="mt-2 flex flex-wrap items-end gap-2 rounded-lg border border-line p-3"
            data-test="thaw-form"
          >
            <DsSelect
              v-if="!azure"
              v-model="thawDays"
              size="sm"
              :label="t('backup.thaw.keep')"
              :options="dayOptions"
            />
            <DsSelect v-model="thawTier" size="sm" :label="t('backup.thaw.speed')" :options="tierOptions" />
            <DsButton size="sm" variant="primary" :loading="thawBusy" @click="thaw(r)">{{
              t('backup.thaw.start')
            }}</DsButton>
            <DsButton size="sm" variant="ghost" @click="thawOpen = null">{{ t('common.cancel') }}</DsButton>
            <p class="basis-full text-small text-fg-subtle">
              {{ azure ? t('backup.thaw.azureHelp') : t('backup.thaw.help') }}
            </p>
          </div>
        </div>
        <span class="text-ui text-fg tabular-nums">{{ b(r.size) }}</span>
        <span
          class="w-28 text-right text-ui whitespace-nowrap text-fg-subtle"
          :title="r.createdAt ? new Date(r.createdAt).toLocaleString(locale) : undefined"
          >{{ when(r) }}</span
        >
        <div
          class="flex gap-1 opacity-80 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100"
        >
          <button
            v-if="canRestore && !r.archived && r.state !== 'incomplete'"
            type="button"
            data-action="restore"
            :class="action"
            :aria-label="t('backup.list.actionOn', { action: t('backup.list.restore'), name: r.name })"
            @click="restore(r)"
          >
            <ArchiveRestore class="size-3.5" aria-hidden="true" />{{ t('backup.list.restore') }}
          </button>
          <button
            v-if="r.archived && r.thaw === 'none' && r.state !== 'incomplete'"
            type="button"
            data-action="thaw"
            :class="action"
            :aria-expanded="thawOpen === r.key"
            :aria-label="t('backup.list.actionOn', { action: t('backup.thaw.action'), name: r.name })"
            @click="thawOpen = thawOpen === r.key ? null : r.key"
          >
            <Sun class="size-3.5" aria-hidden="true" />{{ t('backup.thaw.action') }}
          </button>
          <button
            v-if="deletable(r)"
            type="button"
            data-action="delete"
            :class="danger"
            :aria-label="t('backup.list.actionOn', { action: t('backup.list.delete'), name: r.name })"
            @click="remove(r)"
          >
            <Trash2 class="size-3.5" aria-hidden="true" />{{ t('backup.list.delete') }}
          </button>
        </div>
      </li>
    </ul>
    <DsButton
      v-if="nextCursor"
      class="self-center"
      size="sm"
      variant="ghost"
      :loading="loadingMore"
      @click="loadMore"
    >
      {{ t('backup.remote.more') }}
    </DsButton>
  </div>
</template>
