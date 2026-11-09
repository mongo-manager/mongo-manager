<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { EyeOff, Lock, Minimize2, Search, ShieldCheck } from 'lucide-vue-next'
import { connectionsApi, queryKeys } from '@/api/connections'
import { useSessionStore } from '@/stores/session'
import { useTabsStore } from '@/stores/tabs'
import { useLayoutStore } from '@/stores/layout'
import { keyLabel } from './shortcuts'
import { useShortcutsStore } from '@/stores/shortcuts'
import { useHiddenHere } from '@/masking/hiddenHere'
import DsBadge from '@/ds/DsBadge.vue'
import DsButton from '@/ds/DsButton.vue'
import DsKbd from '@/ds/DsKbd.vue'
import JobsTray from '@/jobs/JobsTray.vue'
import { useJobsLive } from '@/jobs/live'
import AccountMenu from './AccountMenu.vue'
import Breadcrumbs from './Breadcrumbs.vue'

/**
 * UI redesign R1 revision 2 §3.2: the context bar — where the user is and what holds there (badges),
 * then search, notifications and the account. The assistant opens from its own floating button
 * (user report 2026-10-25), not from here.
 */
defineEmits<{ palette: [] }>()
const { t } = useI18n()
const session = useSessionStore()
const tabs = useTabsStore()
const layout = useLayoutStore()
// W5: the keys as this user bound them.
const shortcuts = useShortcutsStore()
const paletteKeys = computed(() => (shortcuts.keysOf('palette')[0] ?? []).map(keyLabel))
const connections = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
const connection = computed(() =>
  connections.data.value?.find((c) => c.id === tabs.active?.params.connectionId),
)
// User report 2026-10-27: "personal data hidden" where the rules reach the tab, not on every one of
// the connection's databases.
const hiddenHere = useHiddenHere(
  computed(() => {
    const p = tabs.active?.params
    return connection.value && p
      ? { connectionId: connection.value.id, db: p.db, coll: p.coll, bucket: p.bucket }
      : null
  }),
  computed(() => connection.value?.restricted === true),
)
/** Read-only once, whether the connection or the caller is read-only. */
const readOnly = computed(() => !!connection.value?.readOnly || !!session.me?.readOnly)
// Phase 1h: the bar is shown only when signed in, so the jobs socket lives exactly as long.
useJobsLive()
const jobs = ref<{ open: () => void } | null>(null)
defineExpose({ openJobs: () => jobs.value?.open() })
</script>

<template>
  <header data-region="topbar" class="flex h-12 shrink-0 items-center gap-2 border-b border-line pr-2 pl-3">
    <Breadcrumbs />
    <div class="flex shrink-0 items-center gap-1.5 max-lg:hidden">
      <DsBadge v-if="readOnly" tone="warning"
        ><Lock class="size-3" aria-hidden="true" />{{ t('header.readOnly') }}</DsBadge
      >
      <DsBadge v-if="hiddenHere" tone="info"
        ><EyeOff class="size-3" aria-hidden="true" />{{ t('layout.personalDataHidden') }}</DsBadge
      >
      <DsBadge v-if="connection"
        ><ShieldCheck class="size-3" aria-hidden="true" />{{
          t(`overview.roles.${connection.access}`)
        }}</DsBadge
      >
    </div>
    <div class="flex-1" />
    <DsButton
      v-if="layout.focusMode"
      size="sm"
      variant="ghost"
      :icon="Minimize2"
      :aria-label="t('layout.exitFocus')"
      :aria-keyshortcuts="shortcuts.aria('focusMode')"
      @click="layout.toggleFocus()"
      >{{ t('layout.exitFocusShort') }}</DsButton
    >
    <!-- User report 2026-11-07: short of room, the search box narrows (to a point) before the
         breadcrumb is cut short. -->
    <button
      type="button"
      class="flex h-8 w-72 min-w-0 shrink-[100] cursor-pointer md:min-w-40 items-center gap-2 rounded-lg border border-line bg-canvas px-2.5 text-ui text-fg-subtle transition-colors duration-120 hover:border-line-strong hover:text-fg-muted max-md:w-8 max-md:justify-center max-md:px-0"
      :aria-keyshortcuts="shortcuts.aria('palette')"
      @click="$emit('palette')"
    >
      <Search class="size-3.5 shrink-0" aria-hidden="true" />
      <span class="min-w-0 flex-1 truncate text-left max-md:sr-only">{{ t('header.search') }}</span>
      <span class="flex gap-0.5 max-md:hidden" aria-hidden="true">
        <DsKbd v-for="k in paletteKeys" :key="k">{{ k }}</DsKbd>
      </span>
    </button>
    <DsBadge v-if="session.status?.mode === 'local'" class="max-md:hidden">{{
      t('header.localMode')
    }}</DsBadge>
    <JobsTray ref="jobs" />
    <AccountMenu />
  </header>
</template>
