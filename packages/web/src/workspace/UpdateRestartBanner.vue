<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RefreshCw } from 'lucide-vue-next'
import DsButton from '@/ds/DsButton.vue'
import { useCollectionViewsStore } from '@/stores/collectionViews'
import { useTabWorkStore } from '@/stores/tabWork'
import { useUpdatesStore } from '@/stores/updates'

/**
 * The updater (2026-11-03): every signed-in page says the server is restarting into a new version.
 * User report 2026-11-05: once it runs the new version, the page loads it too — on its own when
 * nothing would be lost, once per version (a proxy still serving the old page must not make it
 * reload over and over); otherwise it says so and waits for Reload, which the browser's own
 * leave prompt guards.
 */
const RELOADED_KEY = 'mm.updates.reloaded'

const { t } = useI18n()
const store = useUpdatesStore()
const views = useCollectionViewsStore()
const work = useTabWorkStore()
const reload = () => window.location.reload()

const unsaved = computed(() => views.anyUnsaved() || work.any())

const reloadedFor = (): string | null => {
  try {
    return sessionStorage.getItem(RELOADED_KEY)
  } catch {
    return null
  }
}

watch(
  () => store.outdated,
  (version) => {
    if (!version || unsaved.value || reloadedFor() === version) return
    try {
      sessionStorage.setItem(RELOADED_KEY, version)
    } catch {
      // Without the note it could reload again: say it instead.
      return
    }
    reload()
  },
  { immediate: true },
)
</script>

<template>
  <div
    v-if="store.restarting"
    role="status"
    class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-info-soft px-4 py-2 text-ui text-fg"
    data-update-banner
  >
    <RefreshCw class="size-4 shrink-0 animate-spin text-info motion-reduce:animate-none" aria-hidden="true" />
    <span class="min-w-0 flex-1">{{
      store.slow ? t('about.updates.banner.slow') : t('about.updates.banner.restarting')
    }}</span>
    <DsButton v-if="store.slow" size="sm" @click="reload">{{ t('about.updates.banner.reload') }}</DsButton>
  </div>
  <div
    v-else-if="store.outdated"
    role="status"
    class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-info-soft px-4 py-2 text-ui text-fg"
    data-update-banner
  >
    <RefreshCw class="size-4 shrink-0 text-info" aria-hidden="true" />
    <span class="min-w-0 flex-1">{{
      unsaved
        ? t('about.updates.banner.outdatedUnsaved', { version: store.outdated })
        : t('about.updates.banner.outdated', { version: store.outdated })
    }}</span>
    <DsButton size="sm" @click="reload">{{ t('about.updates.banner.reload') }}</DsButton>
  </div>
</template>
