<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { RefreshCw } from 'lucide-vue-next'
import DsButton from '@/ds/DsButton.vue'
import { useUpdatesStore } from '@/stores/updates'

/** The updater (2026-11-03): every signed-in page says the server is restarting into a new version. */
const { t } = useI18n()
const store = useUpdatesStore()
const reload = () => window.location.reload()
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
</template>
