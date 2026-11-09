<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Activity,
  ArrowRightLeft,
  ArrowLeftRight,
  BellRing,
  BookMarked,
  Bot,
  CalendarClock,
  CloudUpload,
  Database,
  History,
  House,
  ListChecks,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Puzzle,
  ScrollText,
  SlidersHorizontal,
  Sun,
  Workflow,
} from 'lucide-vue-next'
import DsIconButton from '@/ds/DsIconButton.vue'
import DsPopover from '@/ds/DsPopover.vue'
import DsResizeHandle from '@/ds/DsResizeHandle.vue'
import DsTooltip from '@/ds/DsTooltip.vue'
import { useSessionStore } from '@/stores/session'
import { useTabsStore } from '@/stores/tabs'
import { useLayoutStore, SIDEBAR_ID, SIDEBAR_MAX, SIDEBAR_MIN } from '@/stores/layout'
import { usePreferencesStore } from '@/stores/preferences'
import { useShortcutsStore } from '@/stores/shortcuts'
import { useScheduleSignals } from '@/schedules/useScheduleSignals'
import { useLiveSyncSignals } from '@/livesync/useLiveSyncs'
import { useAlertSignals } from '@/alerts/useAlertSignals'
import ProductMark from './ProductMark.vue'
import SidebarItem from './sidebar/SidebarItem.vue'
import SidebarGroup from './sidebar/SidebarGroup.vue'
import PinnedSection from './sidebar/PinnedSection.vue'
import ConnectionsSection from './sidebar/ConnectionsSection.vue'
import PreferencesPanel from './sidebar/PreferencesPanel.vue'
import type { SidebarEntry } from './sidebar/types'
import {
  openAiHistoryTab,
  openAiSettingsTab,
  openAlertsTab,
  openAuditTab,
  openDestinationsTab,
  openLiveSyncsTab,
  openPluginsTab,
  openLibraryTab,
  openPluginPage,
  openSchedulesTab,
  openSqlTransferTab,
} from './openTabs'
import { localized, usePluginsStore } from '@/plugins/store'
import { pluginIcon } from '@/plugins/icons'

/**
 * UI redesign R1 revision 2 §3.1: the application sidebar — labelled navigation, pinned places and the
 * connections, collapsing to an icon rail (Mod+B). `overlay` is its form below 1024 px.
 */
const props = withDefaults(
  defineProps<{
    /** The assistant is on: its history is offered (the assistant itself from its floating button). */
    assistantOffered?: boolean
    overlay?: boolean
  }>(),
  { assistantOffered: false, overlay: false },
)
const emit = defineEmits<{
  jobs: []
  add: []
  import: []
  export: []
}>()
const { t, locale } = useI18n()
const session = useSessionStore()
const plugins = usePluginsStore()
const tabs = useTabsStore()
const layout = useLayoutStore()
const preferences = usePreferencesStore()
// W5: the keys as this user bound them.
const shortcuts = useShortcutsStore()
const { attention: scheduleAttention } = useScheduleSignals()
const { attention: syncAttention } = useLiveSyncSignals()
// W3.3: alerts firing now that this user sees in the bell.
const { firing: alertsFiring } = useAlertSignals()
/** In the overlay the sidebar is always the full one. */
const collapsed = computed(() => layout.sidebarCollapsed && !props.overlay)
const kind = computed(() => tabs.active?.kind)

const automations = computed<SidebarEntry[]>(() => [
  {
    id: 'schedules',
    label: t('header.schedules'),
    icon: CalendarClock,
    active: kind.value === 'schedules',
    badge: scheduleAttention.value || undefined,
    badgeLabel: scheduleAttention.value
      ? t('header.schedulesAttention', { count: scheduleAttention.value }, scheduleAttention.value)
      : undefined,
  },
  {
    id: 'liveSyncs',
    label: t('header.liveSyncs'),
    icon: ArrowRightLeft,
    active: kind.value === 'liveSyncs',
    badge: syncAttention.value || undefined,
    badgeLabel: syncAttention.value
      ? t('header.liveSyncsAttention', { count: syncAttention.value }, syncAttention.value)
      : undefined,
  },
])
const activity = computed<SidebarEntry[]>(() => [
  { id: 'jobs', label: t('jobs.title'), icon: ListChecks, active: kind.value === 'jobs' },
  {
    id: 'alerts',
    label: t('alerts.title'),
    icon: BellRing,
    active: kind.value === 'alerts',
    badge: alertsFiring.value || undefined,
    badgeLabel: alertsFiring.value
      ? t('alerts.firingCount', { count: alertsFiring.value }, alertsFiring.value)
      : undefined,
  },
  ...(session.can('audit:read')
    ? [{ id: 'audit', label: t('header.audit'), icon: ScrollText, active: kind.value === 'audit' }]
    : []),
])
const integrations = computed<SidebarEntry[]>(() =>
  session.can('settings:manage')
    ? [
        {
          id: 'destinations',
          label: t('header.destinations'),
          icon: CloudUpload,
          active: kind.value === 'destinations',
        },
        { id: 'aiSettings', label: t('layout.aiProviders'), icon: Bot, active: kind.value === 'aiSettings' },
        {
          id: 'plugins',
          label: t('header.plugins'),
          icon: Puzzle,
          active: kind.value === 'plugins' || kind.value === 'pluginDetails',
        },
      ]
    : [],
)

function select(id: string): void {
  if (id === 'schedules') openSchedulesTab(tabs)
  else if (id === 'liveSyncs') openLiveSyncsTab(tabs)
  else if (id === 'audit') openAuditTab(tabs)
  else if (id === 'jobs') emit('jobs')
  else if (id === 'destinations') openDestinationsTab(tabs)
  else if (id === 'alerts') openAlertsTab(tabs)
  else if (id === 'aiSettings') openAiSettingsTab(tabs)
  else if (id === 'plugins') openPluginsTab(tabs)
  if (props.overlay) layout.closeOverlay()
}
/** User request 2026-10-10: a plugin's entry opens its page, as the others (closing the overlay). */
function openPlugin(page: { plugin: { id: string }; id: string }): void {
  openPluginPage(tabs, page)
  if (props.overlay) layout.closeOverlay()
}
/** User request 2026-10-10: Queries is a page, opened as the others (closing the overlay too). */
function openQueries(): void {
  openLibraryTab(tabs)
  if (props.overlay) layout.closeOverlay()
}
function openHistory(): void {
  openAiHistoryTab(tabs)
  if (props.overlay) layout.closeOverlay()
}
function home(): void {
  tabs.home()
  if (props.overlay) layout.closeOverlay()
}
</script>

<template>
  <nav
    :id="SIDEBAR_ID"
    data-region="sidebar"
    :aria-label="t('layout.app')"
    class="relative flex h-full min-h-0 shrink-0 flex-col bg-canvas"
    :class="
      overlay
        ? 'fixed top-2 bottom-2 left-2 z-30 w-[min(300px,calc(100vw-1rem))] animate-rise overflow-hidden rounded-2xl shadow-dialog ring-1 ring-line'
        : ''
    "
    :style="overlay ? undefined : { width: collapsed ? '60px' : `${layout.sidebarWidth}px` }"
  >
    <header
      class="flex h-12 shrink-0 items-center gap-2"
      :class="collapsed ? 'justify-center px-0' : 'pr-2 pl-3.5'"
    >
      <ProductMark :size="collapsed ? 28 : 26" :label="collapsed ? t('app.name') : undefined" />
      <template v-if="!collapsed">
        <span class="min-w-0 flex-1 truncate text-title-s font-semibold tracking-tight text-fg">{{
          t('app.name')
        }}</span>
        <DsIconButton
          v-if="!overlay"
          :icon="PanelLeftClose"
          size="sm"
          :label="t('layout.collapseSidebar')"
          :shortcut="shortcuts.keysOf('navigator')[0]"
          :aria-controls="SIDEBAR_ID"
          aria-expanded="true"
          @click="layout.toggleSidebar()"
        />
      </template>
    </header>

    <div
      class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-2"
      :class="collapsed ? 'items-center px-0' : 'px-2'"
    >
      <ul class="flex flex-col gap-0.5" :class="collapsed ? 'items-center' : ''">
        <li v-if="collapsed">
          <SidebarItem
            collapsed
            :icon="PanelLeftOpen"
            :label="t('layout.expandSidebar')"
            :shortcut="shortcuts.keysOf('navigator')[0]"
            aria-expanded="false"
            :aria-controls="SIDEBAR_ID"
            @click="layout.toggleSidebar()"
          />
        </li>
        <li>
          <SidebarItem
            :collapsed="collapsed"
            :icon="House"
            :label="t('layout.overview')"
            :active="kind === 'welcome'"
            @click="home"
          />
        </li>
        <li>
          <SidebarItem
            :collapsed="collapsed"
            :icon="BookMarked"
            :label="t('layout.queries')"
            :active="kind === 'library'"
            :shortcut="shortcuts.keysOf('library')[0]"
            @click="openQueries"
          />
        </li>
        <!-- User request 2026-10-11: SQL import and export; with the SQL → MongoDB plugin (2026-11-02). -->
        <li v-if="plugins.sqlOffered">
          <SidebarItem
            :collapsed="collapsed"
            :icon="ArrowLeftRight"
            :label="t('sqlTransfer.title')"
            :active="kind === 'sqlTransfer'"
            data-sidebar-sql
            @click="openSqlTransferTab(tabs)"
          />
        </li>
        <!-- The assistant opens over the page, not as one: from its floating button (user report
             2026-10-25). Its history is a page, and stays. -->
        <li v-if="assistantOffered">
          <SidebarItem
            :collapsed="collapsed"
            :icon="History"
            :label="t('aiHistory.title')"
            :active="kind === 'aiHistory'"
            data-sidebar-ai-history
            @click="openHistory"
          />
        </li>
        <li v-for="p in plugins.sidebarPanels" :key="p.key">
          <SidebarItem
            :collapsed="collapsed"
            :icon="pluginIcon(p.icon)"
            :label="localized(p.title, locale)"
            :active="
              tabs.active?.kind === 'pluginPage' &&
              tabs.active.params.plugin === p.plugin.id &&
              tabs.active.params.contribution === p.id
            "
            data-sidebar-plugin-page
            @click="openPlugin(p)"
          />
        </li>
        <li>
          <SidebarGroup
            id="automations"
            :collapsed="collapsed"
            :icon="Workflow"
            :label="t('layout.automations')"
            :items="automations"
            @select="select"
          />
        </li>
        <li>
          <SidebarGroup
            id="activity"
            :collapsed="collapsed"
            :icon="Activity"
            :label="t('layout.activity')"
            :items="activity"
            @select="select"
          />
        </li>
        <li v-if="integrations.length">
          <SidebarGroup
            id="integrations"
            :collapsed="collapsed"
            :icon="Plug"
            :label="t('layout.integrations')"
            :items="integrations"
            @select="select"
          />
        </li>
      </ul>

      <template v-if="!collapsed">
        <PinnedSection />
        <ConnectionsSection @add="emit('add')" @import="emit('import')" @export="emit('export')" />
      </template>
      <SidebarItem
        v-else
        collapsed
        :icon="Database"
        :label="t('layout.showConnections')"
        @click="layout.toggleSidebar()"
      />
    </div>

    <footer
      class="flex shrink-0 gap-1 border-t border-line py-2"
      :class="collapsed ? 'flex-col items-center px-0' : 'items-center px-2'"
    >
      <DsIconButton
        :icon="preferences.dark ? Sun : Moon"
        :label="preferences.dark ? t('layout.themeToLight') : t('layout.themeToDark')"
        placement="right-start"
        @click="preferences.toggleTheme()"
      />
      <DsTooltip :text="t('layout.preferences')" placement="right-start">
        <DsPopover
          :label="t('layout.preferences')"
          placement="top-start"
          trigger-class="grid size-8 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-120 hover:bg-muted hover:text-fg"
        >
          <template #trigger><SlidersHorizontal class="size-4" aria-hidden="true" /></template>
          <PreferencesPanel />
        </DsPopover>
      </DsTooltip>
    </footer>

    <DsResizeHandle
      v-if="!collapsed && !overlay"
      :value="layout.sidebarWidth"
      :min="SIDEBAR_MIN"
      :max="SIDEBAR_MAX"
      edge="right"
      :label="t('layout.resizeSidebar')"
      @update:value="layout.setSidebarWidth"
    />
  </nav>
</template>
