<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { ArrowRightLeft, Plus, RotateCcw, ShieldCheck, Timer, Waypoints } from 'lucide-vue-next'
import type { LiveSyncView } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsPageHeader from '@/ds/DsPageHeader.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import { liveSyncApi, liveSyncKeys } from '@/api/liveSync'
import { connectionsApi, queryKeys } from '@/api/connections'
import { describeError } from '@/api/errors'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import { useSessionStore } from '@/stores/session'
import { useWorkspaceDialogs } from '@/stores/workspaceDialogs'
import { useJobsStore } from '@/jobs/store'
import LiveSyncCard from './LiveSyncCard.vue'
import LiveSyncDetail from './LiveSyncDetail.vue'
import LiveSyncFinish from './LiveSyncFinish.vue'
import { applyUpdate, useLiveSyncs } from './useLiveSyncs'
import { useLiveSyncWords, type CardAction } from './words'

/** Phase 3e-2 spec §5: the Live syncs tab — a card per sync, kept current by the livesync channel. */
const { t } = useI18n()
const queryClient = useQueryClient()
const dialogs = useDialogStore()
const toasts = useToastStore()
const session = useSessionStore()
const workspace = useWorkspaceDialogs()
const jobs = useJobsStore()
const words = useLiveSyncWords()
const { list, syncs, lagOf } = useLiveSyncs()
const { data: connections } = useQuery({
  queryKey: queryKeys.connections,
  queryFn: () => connectionsApi.list(),
})
const colors = computed(() => Object.fromEntries((connections.value ?? []).map((c) => [c.id, c.color])))
const administrator = computed(() => session.me?.mode === 'local' || session.me?.user.role === 'admin')
const now = ref(Date.now())
const clock = setInterval(() => (now.value = Date.now()), 5_000)
onBeforeUnmount(() => clearInterval(clock))
const mineActive = computed(
  () => syncs.value.filter((s) => s.mine && !['completed', 'failed', 'stopped'].includes(s.state)).length,
)
const detailOf = ref<string | null>(null)
const finishing = ref<LiveSyncView | null>(null)
const busy = ref(false)
const POINTS = [
  { key: 'mirror', icon: Waypoints },
  { key: 'migrate', icon: Timer },
  { key: 'safe', icon: ShieldCheck },
] as const

const refresh = () => queryClient.invalidateQueries({ queryKey: liveSyncKeys.all })
const create = () => workspace.open({ kind: 'liveSync' })
const progressOf = (s: LiveSyncView) => (s.copyJobId ? (jobs.byId[s.copyJobId]?.progress ?? null) : null)

async function run(call: () => Promise<LiveSyncView | void>): Promise<void> {
  busy.value = true
  try {
    const updated = await call()
    if (updated) applyUpdate(queryClient, updated)
  } catch (e) {
    toasts.push({ kind: 'error', message: words.error(e) })
  } finally {
    busy.value = false
    await refresh()
  }
}

async function act(s: LiveSyncView, action: CardAction): Promise<void> {
  switch (action) {
    case 'pause':
      return run(() => liveSyncApi.pause(s.id))
    case 'resume':
      return run(() => liveSyncApi.resume(s.id))
    case 'verify':
      return run(() => liveSyncApi.verify(s.id))
    case 'skip':
      return run(() => liveSyncApi.skip(s.id))
    case 'finish':
      finishing.value = s
      return
    case 'details':
      detailOf.value = s.id
      return
    case 'applySchema':
    case 'ignoreSchema': {
      const ignore = action === 'ignoreSchema'
      const ok = await dialogs.confirm({
        title: t(ignore ? 'liveSync.schema.ignoreTitle' : 'liveSync.schema.applyTitle'),
        message: t(ignore ? 'liveSync.schema.ignoreHelp' : 'liveSync.schema.applyHelp'),
        confirmLabel: t(ignore ? 'liveSync.action.ignoreSchema' : 'liveSync.action.applySchema'),
      })
      if (ok) await run(() => liveSyncApi.applySchema(s.id, ignore))
      return
    }
    case 'stop': {
      const ok = await dialogs.confirm({
        title: t('liveSync.stop.title', { name: s.name }),
        message: t('liveSync.stop.help'),
        confirmLabel: t('liveSync.stop.confirm'),
        danger: true,
      })
      if (ok) await run(() => liveSyncApi.stop(s.id))
      return
    }
    case 'remove': {
      const ok = await dialogs.confirm({
        title: t('liveSync.remove.title', { name: s.name }),
        message: t('liveSync.remove.help'),
        confirmLabel: t('liveSync.remove.confirm'),
        danger: true,
      })
      if (ok) await run(() => liveSyncApi.remove(s.id))
      return
    }
    case 'review':
      workspace.open({
        kind: 'liveSync',
        review: s.id,
        connectionId: s.source.connectionId,
        db: s.source.db,
        ...(s.source.coll ? { coll: s.source.coll } : {}),
      })
      return
    case 'startAgain':
      workspace.open({
        kind: 'liveSync',
        connectionId: s.source.connectionId,
        db: s.source.db,
        ...(s.source.coll ? { coll: s.source.coll } : {}),
        preset: {
          target: {
            connectionId: s.target.connectionId,
            db: s.target.db,
            ...(s.target.coll ? { coll: s.target.coll } : {}),
          },
          // Final review m16: the target holds the old sync's documents: merge into them, and
          // replace the old sync (it no longer counts toward the limits).
          startMode: 'merge',
          replaces: s.id,
          errorPolicy: s.errorPolicy,
          followNew: s.followNew,
          anonymous: s.anonymous,
          ...(s.source.collections ? { collections: s.source.collections } : {}),
          ...(s.filter ? { filter: s.filter } : {}),
        },
      })
  }
}

async function finish(verify: boolean): Promise<void> {
  const s = finishing.value
  if (!s) return
  await run(() => liveSyncApi.finish(s.id, verify))
  finishing.value = null
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <DsPageHeader
      :title="t('liveSync.title')"
      :icon="ArrowRightLeft"
      :facts="list.data.value ? [t('liveSync.used', { used: mineActive, max: list.data.value.perUser })] : []"
      :description="t('liveSync.subtitle')"
    >
      <template #actions>
        <DsButton v-if="syncs.length && list.data.value?.enabled" size="sm" variant="primary" @click="create"
          ><Plus class="size-4" aria-hidden="true" />{{ t('liveSync.new') }}</DsButton
        >
      </template>
    </DsPageHeader>
    <div class="min-h-0 flex-1 overflow-auto">
      <div class="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
        <DsCallout v-if="list.data.value && !list.data.value.enabled" tone="warning" role="status">{{
          t('liveSync.off')
        }}</DsCallout>

        <div v-if="list.isPending.value" class="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-busy="true">
          <span class="sr-only" role="status">{{ t('app.loading') }}</span
          ><DsSkeleton v-for="n in 3" :key="n" class="h-72 rounded-card" />
        </div>
        <DsCallout v-else-if="list.isError.value" tone="danger"
          >{{ describeError(list.error.value, t)
          }}<template #action
            ><DsButton size="sm" :loading="list.isFetching.value" @click="list.refetch()"
              ><RotateCcw class="size-4" aria-hidden="true" />{{ t('common.retry') }}</DsButton
            ></template
          ></DsCallout
        >
        <section
          v-else-if="!syncs.length"
          class="flex flex-col items-center gap-6 rounded-card border border-dashed border-line-strong px-6 py-12 text-center"
        >
          <span class="flex size-12 items-center justify-center rounded-2xl bg-accent-soft">
            <ArrowRightLeft class="size-6 text-accent-fg" aria-hidden="true" />
          </span>
          <div class="flex max-w-xl flex-col gap-2">
            <h3 class="text-title-s font-semibold text-fg">{{ t('liveSync.empty.title') }}</h3>
            <p class="text-ui text-fg-subtle">{{ t('liveSync.empty.help') }}</p>
          </div>
          <ul class="grid w-full max-w-3xl gap-3 text-left sm:grid-cols-3">
            <li
              v-for="p in POINTS"
              :key="p.key"
              class="flex gap-3 rounded-xl border border-line bg-surface p-4 text-ui"
            >
              <component :is="p.icon" class="mt-0.5 size-5 shrink-0 text-accent-fg" aria-hidden="true" />
              <span class="text-fg">{{ t(`liveSync.empty.${p.key}`) }}</span>
            </li>
          </ul>
          <DsButton v-if="list.data.value?.enabled" variant="primary" @click="create"
            ><Plus class="size-4" aria-hidden="true" />{{ t('liveSync.empty.action') }}</DsButton
          >
        </section>
        <div v-else class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <LiveSyncCard
            v-for="s in syncs"
            :key="s.id"
            :sync="s"
            :now="now"
            :administrator="administrator"
            :colors="colors"
            :progress="progressOf(s)"
            :lag="lagOf(s.id)"
            @act="act(s, $event)"
          />
        </div>
        <LiveSyncDetail v-if="detailOf" :sync-id="detailOf" @close="detailOf = null" />
        <LiveSyncFinish
          v-if="finishing"
          :sync="finishing"
          :busy="busy"
          @close="finishing = null"
          @finish="finish"
        />
      </div>
    </div>
  </div>
</template>
