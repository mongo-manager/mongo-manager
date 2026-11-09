<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowRightLeft, CalendarClock, CheckCircle2, ChevronRight } from 'lucide-vue-next'
import { useScheduleSignals } from '@/schedules/useScheduleSignals'
import { useLiveSyncSignals } from '@/livesync/useLiveSyncs'
import { useTabsStore } from '@/stores/tabs'
import { openLiveSyncsTab, openSchedulesTab } from '../openTabs'
import WidgetFrame from './widgets/WidgetFrame.vue'

/**
 * UI redesign R1 revision 2 §3.5: schedules and live syncs that need a person. User review 2026-10-09:
 * it stays where the user put it, saying all is well when none do (it vanished on "Done" before, and
 * the widgets beside it moved).
 */
const { t } = useI18n()
const tabs = useTabsStore()
const { attention: schedules } = useScheduleSignals()
const { attention: syncs } = useLiveSyncSignals()
const rows = computed(() =>
  [
    schedules.value
      ? {
          id: 'schedules',
          icon: CalendarClock,
          title: t('header.schedules'),
          text: t('header.schedulesAttention', { count: schedules.value }, schedules.value),
          open: () => openSchedulesTab(tabs),
        }
      : null,
    syncs.value
      ? {
          id: 'liveSyncs',
          icon: ArrowRightLeft,
          title: t('header.liveSyncs'),
          text: t('header.liveSyncsAttention', { count: syncs.value }, syncs.value),
          open: () => openLiveSyncsTab(tabs),
        }
      : null,
  ].filter((r) => r !== null),
)
</script>

<template>
  <WidgetFrame :title="t('layout.needsAttention')" :count="rows.length || undefined">
    <p v-if="!rows.length" data-attention-quiet class="flex items-center gap-2 py-1 text-small text-fg-muted">
      <CheckCircle2 class="size-4 shrink-0 text-success" aria-hidden="true" />
      {{ t('overview.widgets.attention.quiet') }}
    </p>
    <ul v-else class="-mx-2 flex flex-col">
      <li v-for="r in rows" :key="r.id">
        <button
          type="button"
          class="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors duration-120 hover:bg-subtle"
          @click="r.open()"
        >
          <span class="grid size-7 shrink-0 place-items-center rounded-md bg-warning-soft text-warning">
            <component :is="r.icon" class="size-3.5" aria-hidden="true" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block text-ui font-medium text-fg">{{ r.title }}</span>
            <span class="block text-small text-fg-subtle">{{ r.text }}</span>
          </span>
          <ChevronRight class="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
        </button>
      </li>
    </ul>
  </WidgetFrame>
</template>
