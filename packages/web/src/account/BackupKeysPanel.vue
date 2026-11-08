<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { KeyRound, Plus, RefreshCw, Upload } from 'lucide-vue-next'
import type { BackupKeyView, KeyState } from '@mongo-manager/shared/browser'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import DsButton from '@/ds/DsButton.vue'
import { keysApi, scheduleKeys } from '@/api/schedules'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import KeyCreateDialog from './KeyCreateDialog.vue'
import KitImportDialog from './KitImportDialog.vue'
import { useKeyError } from './kit'

/** Phase 3d-3c spec §5: the active key, retired and imported ones; create, rotate, import, retire, delete. */
const { t, locale } = useI18n()
const queryClient = useQueryClient()
const dialogs = useDialogStore()
const toasts = useToastStore()
const keyError = useKeyError()
const list = useQuery({ queryKey: scheduleKeys.keys, queryFn: () => keysApi.list() })
const active = computed(() => list.data.value?.find((k) => k.state === 'active') ?? null)
const others = computed(() => (list.data.value ?? []).filter((k) => k.state !== 'active'))
const creating = ref<null | 'create' | 'rotate'>(null)
const importing = ref(false)
/** Final review minor 11: a pending key's kit, confirmed later. */
const confirming = ref<BackupKeyView | null>(null)

const PILL: Record<KeyState, string> = {
  active: 'bg-success-soft text-success',
  retired: 'bg-subtle text-fg-muted',
  imported: 'bg-accent-soft text-accent-fg',
  pending: 'bg-warning-soft text-warning',
}
const date = (ms: number) => new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }).format(ms)
const uses = (k: BackupKeyView) =>
  t('keys.uses', {
    schedules: t('keys.usesSchedules', k.uses.schedules),
    backups: t('keys.usesBackups', k.uses.backups),
  })
const inUse = (k: BackupKeyView) => k.uses.schedules + k.uses.backups > 0

async function refresh(): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: scheduleKeys.keys })
  await queryClient.invalidateQueries({ queryKey: scheduleKeys.all })
}
async function act(run: () => Promise<unknown>): Promise<void> {
  try {
    await run()
  } catch (e) {
    toasts.push({ kind: 'error', message: keyError(e) })
  } finally {
    await refresh()
  }
}
async function rotate(): Promise<void> {
  const ok = await dialogs.confirm({
    title: t('keys.rotateTitle'),
    message: t('keys.rotateHelp', { name: active.value?.name ?? '' }),
    confirmLabel: t('keys.rotate'),
  })
  if (ok) creating.value = 'rotate'
}
async function retire(k: BackupKeyView): Promise<void> {
  const ok = await dialogs.confirm({
    title: t('keys.retireTitle', { name: k.name }),
    message: t('keys.retireHelp'),
    confirmLabel: t('keys.retire'),
    danger: true,
  })
  if (ok) await act(() => keysApi.retire(k.id))
}
async function remove(k: BackupKeyView): Promise<void> {
  const ok = await dialogs.confirm({
    title: t('keys.deleteTitle', { name: k.name }),
    message: t('keys.deleteHelp'),
    confirmLabel: t('keys.deleteConfirm'),
    danger: true,
  })
  if (ok) await act(() => keysApi.remove(k.id))
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <DsSkeleton v-if="list.isPending.value" class="h-20 rounded-xl" />
    <template v-else>
      <div
        v-if="active"
        data-key="active"
        class="flex flex-wrap items-start gap-3 rounded-card border border-accent/30 bg-accent-soft p-4"
      >
        <span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface shadow-xs">
          <KeyRound class="size-5 text-accent-fg" aria-hidden="true" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="flex flex-wrap items-center gap-2 font-medium text-fg">
            {{ active.name }}
            <span class="rounded-full px-2 py-0.5 text-small font-medium" :class="PILL.active">{{
              t('keys.state.active')
            }}</span>
          </p>
          <p class="font-mono text-ui text-fg">{{ active.fingerprint }}</p>
          <p class="text-small text-fg-subtle">
            {{ uses(active) }} · {{ t('keys.created', { date: date(active.createdAt) }) }}
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <DsButton size="sm" @click="rotate"
            ><RefreshCw class="size-4" aria-hidden="true" />{{ t('keys.rotate') }}</DsButton
          >
          <DsButton size="sm" variant="ghost" @click="retire(active)">{{ t('keys.retire') }}</DsButton>
        </div>
      </div>
      <div
        v-else
        class="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-line-strong p-4 text-ui text-fg-muted"
      >
        <KeyRound class="size-5 text-fg-subtle" aria-hidden="true" />
        <span class="min-w-0 flex-1">{{ t('keys.empty') }}</span>
        <DsButton size="sm" variant="primary" @click="creating = 'create'"
          ><Plus class="size-4" aria-hidden="true" />{{ t('keys.create') }}</DsButton
        >
      </div>

      <ul v-if="others.length" class="divide-y divide-line" :aria-label="t('keys.others')">
        <li v-for="k in others" :key="k.id" :data-key="k.id" class="flex flex-wrap items-center gap-3 py-3">
          <div class="min-w-0 flex-1">
            <p class="flex flex-wrap items-center gap-2 text-ui font-medium text-fg">
              {{ k.name }}
              <span class="rounded-full px-2 py-0.5 text-small font-medium" :class="PILL[k.state]">{{
                t(`keys.state.${k.state}`)
              }}</span>
            </p>
            <p class="text-small text-fg-subtle">
              <span class="font-mono">{{ k.fingerprint }}</span> ·
              {{ k.state === 'pending' ? t('keys.pendingHelp') : uses(k) }}
            </p>
          </div>
          <DsButton v-if="k.state === 'pending'" size="sm" variant="ghost" @click="confirming = k">{{
            t('keys.confirmPending')
          }}</DsButton>
          <DsButton
            v-if="k.state === 'retired' || k.state === 'imported'"
            size="sm"
            variant="ghost"
            @click="act(() => keysApi.activate(k.id))"
            >{{ t('keys.activate') }}</DsButton
          >
          <DsButton v-if="k.state === 'imported'" size="sm" variant="ghost" @click="retire(k)">{{
            t('keys.retire')
          }}</DsButton>
          <!-- Final review minor 12: focusable, and its reason read out, while it cannot delete. -->
          <DsButton
            size="sm"
            variant="ghost"
            class="aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
            :aria-disabled="inUse(k) || undefined"
            :aria-describedby="inUse(k) ? `key-blocked-${k.id}` : undefined"
            :title="inUse(k) ? t('keys.deleteBlocked') : undefined"
            @click="inUse(k) || remove(k)"
            >{{ t('keys.delete') }}</DsButton
          >
          <span v-if="inUse(k)" :id="`key-blocked-${k.id}`" class="sr-only">{{
            t('keys.deleteBlocked')
          }}</span>
        </li>
      </ul>

      <div class="flex flex-wrap gap-2">
        <DsButton size="sm" variant="ghost" @click="importing = true"
          ><Upload class="size-4" aria-hidden="true" />{{ t('keys.import') }}</DsButton
        >
      </div>
    </template>

    <KeyCreateDialog
      v-if="creating"
      :rotate="creating === 'rotate'"
      @close="creating = null"
      @done="refresh"
    />
    <KeyCreateDialog
      v-if="confirming"
      :pending="{ id: confirming.id, name: confirming.name }"
      @close="confirming = null"
      @done="refresh"
    />
    <KitImportDialog v-if="importing" @close="importing = false" @done="refresh" />
  </div>
</template>
