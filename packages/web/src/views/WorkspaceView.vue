<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue'
import AppSidebar from '@/workspace/AppSidebar.vue'
import ContextBar from '@/workspace/ContextBar.vue'
import UpdateRestartBanner from '@/workspace/UpdateRestartBanner.vue'
import AssistantLauncher from '@/ai/chat/AssistantLauncher.vue'
import { useCompactScreen } from '@/ai/chat/compact'
import { isOwnLayer } from '@/ai/chat/layers'
import { closePagePopup } from '@/ai/chat/focusPage'
import TabStrip from '@/workspace/TabStrip.vue'
import HomeView from '@/workspace/HomeView.vue'
import CommandPalette from '@/workspace/CommandPalette.vue'
import WorkspaceDialogs from '@/workspace/WorkspaceDialogs.vue'
import { useWorkspaceCommands } from '@/workspace/commands'
import { openJobsTab, openLibraryTab } from '@/workspace/openTabs'
import { useTabRouteSync } from '@/workspace/useTabRouteSync'
import { isTyping, matchesCombo, shortcutFires } from '@/workspace/shortcuts'
import { useShortcutsStore } from '@/stores/shortcuts'
import type { RebindableAction } from '@mongo-manager/shared/browser'
import { useWorkspaceDialogs } from '@/stores/workspaceDialogs'
import { useTabsStore } from '@/stores/tabs'
import { useLayoutStore } from '@/stores/layout'
import { placeOfTab, usePlacesStore } from '@/stores/places'
import { useSessionStore } from '@/stores/session'
import { useDialogStore } from '@/stores/dialogs'
import { useCollectionViewsStore } from '@/stores/collectionViews'
import { useTabSectionsStore } from '@/stores/tabSections'
import { pruneWatchFeeds, resetWatchFeeds, watchKeyOfTab } from '@/watch/feeds'
import { useLibraryCommands } from '@/library/commands'
import { ASSISTANT_PANEL_ID, useAssistantStore } from '@/ai/chat/store'
import { useAiStatus } from '@/ai/useAi'
import { useLeaveGuard } from '@/workspace/unsaved'
import { useQuery } from '@tanstack/vue-query'
import { pluginKeys, pluginsApi } from '@/api/plugins'
import { usePluginsStore } from '@/plugins/store'
import PluginCellHosts from '@/plugins/PluginCellHosts.vue'
import WorkspacePane from '@/workspace/WorkspacePane.vue'
import DsResizeHandle from '@/ds/DsResizeHandle.vue'
import { Columns2 } from 'lucide-vue-next'
import { draggingTab, useSplitView } from '@/workspace/split'
import type { PaneSide, WorkspaceTab } from '@/stores/tabs'

const tabs = useTabsStore()
const session = useSessionStore()
const dialogs = useDialogStore()
const workspaceDialogs = useWorkspaceDialogs()
const layout = useLayoutStore()
// Tabs restored from storage are only shown to the user who opened them — bound before the places,
// so another user's open tab is never recorded as this user's recent place (reviewer C I1).
if (session.me) tabs.bindUser(session.me.user.id)
// UI redesign R1 revision 2 §3.6: pins and recent places belong to the signed-in user.
const places = usePlacesStore()
if (session.me) places.bindUser(session.me.user.id)
watch(
  () => tabs.activeId,
  () => {
    const place = placeOfTab(tabs.active)
    if (place) places.visit(place)
  },
  { immediate: true },
)
// UI redesign R1 spec §5: the shell follows the window's width while it is shown.
layout.start()
// W6.1 review (minor 7): the tabs know whether the split can be shown, so the strip, closing and
// moving tabs act on the split as shown.
watch(
  () => layout.splitAllowed,
  (allowed) => tabs.setSplitAllowed(allowed),
  { immediate: true },
)

// Each tab kind renders its own view; the tab's params become the view's props.
/** Tabs kept mounted while open (shown by v-show below), not by the active one. */
const KEPT = ['shell', 'pluginPage', 'sqlTransfer']
/** Tabs whose view keeps state with the tab (its sections, SQL ↔ MongoDB's place): given its id. */
const TAB_ID_KINDS = ['collection', 'database', 'connection', 'sqlTransfer']
const TAB_VIEWS: Record<string, Component> = {
  connection: defineAsyncComponent(() => import('@/workspace/tabs/ConnectionTab.vue')),
  database: defineAsyncComponent(() => import('@/workspace/tabs/DatabaseTab.vue')),
  collection: defineAsyncComponent(() => import('@/workspace/tabs/CollectionTab.vue')),
  shell: defineAsyncComponent(() => import('@/workspace/tabs/ShellTab.vue')),
  account: defineAsyncComponent(() => import('@/account/AccountView.vue')),
  users: defineAsyncComponent(() => import('@/admin/UsersView.vue')),
  audit: defineAsyncComponent(() => import('@/admin/AuditView.vue')),
  plugins: defineAsyncComponent(() => import('@/admin/PluginsView.vue')),
  destinations: defineAsyncComponent(() => import('@/destinations/DestinationsView.vue')),
  alerts: defineAsyncComponent(() => import('@/alerts/AlertsView.vue')),
  aiSettings: defineAsyncComponent(() => import('@/ai/AiSettingsView.vue')),
  schedules: defineAsyncComponent(() => import('@/schedules/SchedulesView.vue')),
  liveSyncs: defineAsyncComponent(() => import('@/livesync/LiveSyncsView.vue')),
  jobs: defineAsyncComponent(() => import('@/jobs/JobsView.vue')),
  aiHistory: defineAsyncComponent(() => import('@/ai/history/AiHistoryView.vue')),
  library: defineAsyncComponent(() => import('@/library/LibraryView.vue')),
  pluginPage: defineAsyncComponent(() => import('@/plugins/PluginPage.vue')),
  pluginDetails: defineAsyncComponent(() => import('@/admin/PluginDetailsView.vue')),
  sqlTransfer: defineAsyncComponent(() => import('@/transfer/SqlTransferView.vue')),
  compare: defineAsyncComponent(() => import('@/transfer/CompareView.vue')),
  gridfs: defineAsyncComponent(() => import('@/gridfs/GridFsView.vue')),
  about: defineAsyncComponent(() => import('@/about/AboutView.vue')),
}

useWorkspaceCommands()
useLeaveGuard()
useTabRouteSync()

// Closing a tab forgets its query, page and section, and stops its Watch feed (phase 3e-1).
const views = useCollectionViewsStore()
const tabSections = useTabSectionsStore()
watch(
  () => tabs.tabs.map((t) => t.id),
  (ids) => {
    views.prune(new Set(ids))
    tabSections.prune(new Set(ids))
    pruneWatchFeeds(new Set(tabs.tabs.map(watchKeyOfTab).filter((k): k is string => k !== null)))
  },
)
onBeforeUnmount(resetWatchFeeds)
const paletteOpen = ref(false)
const paletteAsk = ref(false)
function openPalette(ask = false): void {
  paletteAsk.value = ask
  paletteOpen.value = true
}
// User review 2026-10-08: "Background jobs" opens its own page (the bell keeps the quick look).
const openJobs = () => openJobsTab(tabs)
const shellTabs = computed(() => tabs.tabs.filter((t) => t.kind === 'shell'))
/** Review I3 (2026-10-10): plugin pages stay too, their work kept; out of sight they act in nothing. */
const pluginPageTabs = computed(() => tabs.tabs.filter((t) => t.kind === 'pluginPage'))
const sqlTabs = computed(() => tabs.tabs.filter((t) => t.kind === 'sqlTransfer'))

// completion W6.1: split view — the tabs on screen, each in its pane (or the one in use alone).
const split = useSplitView()
const viewProps = (tab: WorkspaceTab) =>
  TAB_ID_KINDS.includes(tab.kind) ? { ...tab.params, tabId: tab.id } : tab.params
/** The views on screen that are not kept: the panes', or the tab in use (Overview has its own). */
const onScreen = computed<Array<{ tab: WorkspaceTab; side: PaneSide | null }>>(() => {
  const s = split.panes.value
  const on = s
    ? (['left', 'right'] as const).flatMap((side) => {
        const tab = tabs.tabs.find((t) => t.id === s[side])
        return tab ? [{ tab, side }] : []
      })
    : tabs.active && tabs.active.kind !== 'welcome'
      ? [{ tab: tabs.active, side: null }]
      : []
  return on.filter((v) => TAB_VIEWS[v.tab.kind] && !KEPT.includes(v.tab.kind))
})
/** The divider's place, as a percentage of the workspace's width. */
const percent = computed(() => Math.round((split.panes.value?.ratio ?? 0.5) * 1000) / 10)
const paneStyle = (side: PaneSide | null) =>
  side === 'left'
    ? { left: '0', width: `${percent.value}%` }
    : side === 'right'
      ? { left: `${percent.value}%`, right: '0' }
      : undefined
/** The workspace's width, so the divider moves by pixels as the other separators do. */
const main = ref<HTMLElement | null>(null)
const mainWidth = ref(0)
let resize: ResizeObserver | null = null
onMounted(() => {
  if (!main.value || typeof ResizeObserver === 'undefined') return
  resize = new ResizeObserver(([entry]) => {
    if (entry) mainWidth.value = entry.contentRect.width
  })
  resize.observe(main.value)
})
onBeforeUnmount(() => resize?.disconnect())
const width = computed(() => (mainWidth.value > 0 ? mainWidth.value : 1000))
/** Moved in memory while dragged; saved when let go (review minor 8). */
function onDivider(px: number): void {
  tabs.setSplitRatio(px / width.value, false)
}

/** A tab dragged from the strip: a drop zone over the workspace's right side opens it beside. */
const dropShown = computed(
  () =>
    draggingTab.value !== null &&
    layout.splitAllowed &&
    tabs.tabs.some((t) => t.id === draggingTab.value && t.kind !== 'welcome'),
)
const dropOver = ref(false)
const dropStyle = ref<Record<string, string>>({})
watch(dropShown, (shown) => {
  dropOver.value = false
  if (!shown) return
  const r = main.value?.getBoundingClientRect()
  if (!r) return
  dropStyle.value = {
    top: `${r.top + 8}px`,
    left: `${r.left + r.width * 0.6}px`,
    width: `${Math.max(0, r.width * 0.4 - 8)}px`,
    height: `${Math.max(0, r.height - 16)}px`,
  }
})
function onDropBeside(): void {
  const id = draggingTab.value
  draggingTab.value = null
  if (id) split.openBeside(id)
}
useLibraryCommands(paletteOpen)
// User request 2026-10-10: the Library is the Queries page, searching the active tab's connection.
const openLibrary = () => void openLibraryTab(tabs)

// User report 2026-10-25: the assistant is a window over the page, opened from its floating button.
const AssistantPanel = defineAsyncComponent(() => import('@/ai/chat/AssistantPanel.vue'))
const assistant = useAssistantStore()
if (session.me) assistant.bindUser(session.me.user.id)
// W5: the user's own shortcuts, read once they are known (the shipped keys meanwhile).
const shortcuts = useShortcutsStore()
watch(
  () => session.me?.user.id,
  (id) => {
    if (id) void shortcuts.load(id)
  },
  { immediate: true },
)
const aiStatus = useAiStatus()
const assistantOffered = computed(() => !!aiStatus.data.value?.enabled)
const toggleAssistant = (fromKeys = false) => {
  if (!assistantOffered.value) return
  // Review of the floating window (I4): open, with focus on the page under it, the keys go to it.
  // Third review (I-1): another modal dialog over the page keeps the keys to itself.
  const window_ = document.getElementById(ASSISTANT_PANEL_ID)
  const modal = [...document.querySelectorAll('[aria-modal="true"]')].some((d) => d !== window_)
  if (fromKeys && modal) return
  // From one of its own menus (on the body), the keys close it, and the menu with it.
  const active = document.activeElement as HTMLElement | null
  // Fourth review (M-A): a menu of the page is the page's — only the window's own close with it.
  const onPage = !!window_ && !window_.contains(active) && !isOwnLayer(window_, active)
  // Fifth and sixth reviews (7, I-3): a popup of the page is closed first, as its Escape closes it
  // (focus back at its trigger) — opening the window or entering it.
  if (fromKeys) closePagePopup(window_, (el) => isOwnLayer(window_, el))
  if (fromKeys && assistant.open && onPage) {
    // Re-review (I3): it remembers where focus came from, to give it back.
    window_!.dispatchEvent(new CustomEvent('mm-assistant-enter', { detail: document.activeElement }))
    return
  }
  // Closed, focus goes back where it was (the window does it).
  assistant.toggle()
}
// Kept once opened, hidden when closed (review of the floating window, I1); a new user's not yet.
const assistantKept = ref(false)
watch(
  () => session.me?.user.id,
  (id) => {
    // Fourth review (N-b): another user's assistant is theirs (nothing of the last kept).
    if (id) {
      assistant.bindUser(id)
      tabs.bindUser(id)
      places.bindUser(id)
    }
    // Third review (N-2): an open window stays mounted.
    assistantKept.value = assistantShown.value
  },
)
const compactScreen = useCompactScreen()
/** On a phone or a short screen the assistant is a dialog over everything else, out of reach. */
const assistantModal = computed(() => assistantShown.value && compactScreen.value)
// Phase 4b §3: the plugins that run, and a plugin's panel sharing the right side.
const plugins = usePluginsStore()
const runtimePlugins = useQuery({
  queryKey: pluginKeys.runtime,
  queryFn: pluginsApi.runtime,
  staleTime: 60_000,
})
watch(
  () => runtimePlugins.data.value,
  // Only a list that arrived: before it, a page named in a link is loading, not gone (review I1).
  (list) => {
    if (list) plugins.setRuntime(list)
  },
  { immediate: true },
)
const assistantShown = computed(() => assistant.open && assistantOffered.value)
// Third review (M-4): the narrow sidebar's overlay never stays over it (fourth, N-e: on any width).
watch(assistantShown, (shown) => {
  if (shown) layout.closeOverlay()
})
// Fourth review (M-D): the assistant turned off closes it — turned on again, it does not open by itself.
watch(
  () => aiStatus.data.value?.enabled,
  (enabled) => {
    // Fifth review (4): off from the start too (a window restored open never opens by itself later).
    if (enabled === false && assistant.open) assistant.hide()
  },
  { immediate: true },
)
watch(
  assistantShown,
  (shown) => {
    if (shown) assistantKept.value = true
  },
  { immediate: true },
)

/**
 * The global shortcuts, as this user bound them (W5: rebindable in Account → Shortcuts). A
 * combination without Mod or Alt never fires while typing.
 */
function hit(event: KeyboardEvent, action: RebindableAction): boolean {
  return shortcutFires(event, shortcuts.keysOf(action))
}

function onKeydown(event: KeyboardEvent): void {
  // Never stack the palette on top of a dialog: its commands could replace a half-edited form.
  const busy = dialogs.current !== null || workspaceDialogs.current !== null
  if (busy || event.isComposing) return
  if (hit(event, 'palette')) {
    event.preventDefault()
    paletteOpen.value = true
  } else if (
    hit(event, 'library') &&
    // Fifth review (1): under the assistant as a whole screen the page's keys move nothing.
    !assistantModal.value &&
    // Review M11: in a code editor these keys are its own (CodeMirror selects every match).
    !(event.target instanceof Element && event.target.closest('.cm-editor'))
  ) {
    event.preventDefault()
    openLibrary()
  } else if (hit(event, 'assistant')) {
    event.preventDefault()
    toggleAssistant(true)
  } else if (hit(event, 'navigator')) {
    // Third review (N-1): its key taken, though nothing moves under the assistant as a whole screen.
    event.preventDefault()
    if (!assistantModal.value) layout.toggleSidebar()
  } else if (hit(event, 'focusMode')) {
    // UI redesign R1 revision 2 §3.6: focus mode.
    event.preventDefault()
    if (!assistantModal.value) layout.toggleFocus()
  } else if (hit(event, 'pinPlace') && !isTyping(event.target) && !assistantModal.value) {
    // Pin or unpin the active tab's place.
    const place = placeOfTab(tabs.active)
    if (place) {
      event.preventDefault()
      places.togglePin(place)
    }
  } else if (hit(event, 'tabReorder') && !isTyping(event.target) && tabs.active && !assistantModal.value) {
    // UI redesign R1 plan ruling 8: the active tab moves left or right — in the strip as shown, past
    // a gathered group as one (review 2026-10-12, I1). The pair's first combination is ←.
    event.preventDefault()
    const [left] = shortcuts.keysOf('tabReorder')
    tabs.moveBy(tabs.activeId, left && matchesCombo(event, left) ? -1 : 1)
  } else if (
    hit(event, 'splitView') ||
    // W6.1: the key in the place of "\" where the layout types something else there — while the
    // user keeps the shipped keys (a binding of their own names its own key).
    (shortcuts.bindings.splitView === undefined &&
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.code === 'Backslash')
  ) {
    // W6.1: split view (VS Code's key); never over a dialog (busy, above), nor under the assistant
    // as a whole screen.
    event.preventDefault()
    if (!assistantModal.value) split.toggle()
  } else if (
    hit(event, 'shortcuts') &&
    // Ctrl/Cmd/Alt+? belong to the browser and assistive tools (as shipped, ? alone opens the sheet).
    !event.defaultPrevented &&
    !paletteOpen.value &&
    !isTyping(event.target)
  ) {
    event.preventDefault()
    workspaceDialogs.open({ kind: 'shortcuts' })
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  layout.stop()
})
</script>

<template>
  <div v-if="session.me" class="flex h-full bg-canvas text-fg">
    <AppSidebar
      v-if="layout.sidebarShown && !layout.narrow"
      :inert="assistantModal ? true : undefined"
      :assistant-offered="assistantOffered"
      @jobs="openJobs"
      @add="workspaceDialogs.open({ kind: 'connection' })"
      @import="workspaceDialogs.open({ kind: 'importConnections' })"
      @export="workspaceDialogs.open({ kind: 'exportConnections' })"
    />
    <!-- On a phone the assistant is a modal dialog: the page under it is out of reach (review, I4). -->
    <div
      class="flex min-w-0 flex-1 flex-col py-2 pr-2"
      :class="layout.sidebarShown && !layout.narrow ? '' : 'pl-2'"
      :inert="assistantModal ? true : undefined"
    >
      <div class="flex min-h-0 flex-1 gap-2">
        <section
          class="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-xs"
        >
          <ContextBar @palette="paletteOpen = true" />
          <UpdateRestartBanner />
          <TabStrip v-if="!layout.focusMode && tabs.tabs.some((t) => t.kind !== 'welcome')" />
          <!-- Review of R3–R5 (I-7): the screen's one h1 — Home has its own; a page's title is an h2. -->
          <h1 v-if="tabs.active && tabs.active.kind !== 'welcome'" class="sr-only">
            {{ $t('app.name') }}
          </h1>
          <!-- User report 2026-10-29: positioned, so what a page holds absolutely placed stays in it
               and never makes the window scroll. -->
          <main
            id="main"
            ref="main"
            data-region="main"
            class="relative min-h-0 min-w-0 flex-1"
            :class="split.panes.value ? 'overflow-hidden' : 'overflow-auto'"
          >
            <HomeView
              v-if="!split.panes.value && (!tabs.active || tabs.active.kind === 'welcome')"
              @palette="openPalette"
            />
            <!-- W6.1: the tab in use, or each pane's tab; a tab going into a pane keeps its view. -->
            <WorkspacePane
              v-for="v in onScreen"
              :key="v.tab.id"
              :tab="v.tab"
              :side="v.side"
              :focused="tabs.activeId === v.tab.id"
              :style="paneStyle(v.side)"
            >
              <component :is="TAB_VIEWS[v.tab.kind]" v-bind="viewProps(v.tab)" />
            </WorkspacePane>
            <div
              v-if="split.panes.value"
              class="absolute inset-y-0 z-10 w-px bg-line"
              :style="{ left: `${percent}%` }"
            >
              <DsResizeHandle
                data-split-divider
                edge="right"
                :value="Math.round(split.panes.value.ratio * width)"
                :min="Math.round(0.2 * width)"
                :max="Math.round(0.8 * width)"
                :value-text="`${Math.round(split.panes.value.ratio * 100)}%`"
                :label="$t('split.divider')"
                @update:value="onDivider"
                @commit="tabs.saveSplit()"
              />
            </div>
            <!-- Review I3 (2026-10-10): a shell tab stays mounted while it is open, its session and
                 variables with it; only the one on screen shows (W6.1: in its pane). -->
            <WorkspacePane
              v-for="s in shellTabs"
              v-show="split.shown(s.id)"
              :key="s.id"
              :tab="s"
              :side="split.paneOf(s.id)"
              :focused="tabs.activeId === s.id"
              :style="paneStyle(split.paneOf(s.id))"
            >
              <component :is="TAB_VIEWS.shell" v-bind="s.params" :tab-id="s.id" />
            </WorkspacePane>
            <!-- User request 2026-10-11: SQL ↔ MongoDB stays too — a file being prepared, a job running. -->
            <WorkspacePane
              v-for="q in sqlTabs"
              v-show="split.shown(q.id)"
              :key="q.id"
              :tab="q"
              :side="split.paneOf(q.id)"
              :focused="tabs.activeId === q.id"
              :style="paneStyle(split.paneOf(q.id))"
            >
              <component :is="TAB_VIEWS.sqlTransfer" v-bind="q.params" :tab-id="q.id" />
            </WorkspacePane>
            <WorkspacePane
              v-for="p in pluginPageTabs"
              v-show="split.shown(p.id)"
              :key="p.id"
              :tab="p"
              :side="split.paneOf(p.id)"
              :focused="tabs.activeId === p.id"
              :style="paneStyle(split.paneOf(p.id))"
            >
              <component :is="TAB_VIEWS.pluginPage" v-bind="p.params" :active="split.shown(p.id)" />
            </WorkspacePane>
          </main>
        </section>
      </div>
    </div>
    <!-- Over the page, never beside it: the page keeps its width (user report 2026-10-25). -->
    <AssistantPanel
      v-if="assistantKept && assistantOffered"
      v-show="assistantShown"
      :key="session.me?.user.id"
    />
    <AssistantLauncher v-if="assistantOffered" @toggle="toggleAssistant" />
    <div
      v-if="layout.narrow && layout.sidebarShown"
      class="fixed inset-0 z-[45]"
      @keydown.esc="layout.closeOverlay()"
    >
      <div
        class="absolute inset-0 animate-fade bg-[var(--ds-backdrop)]"
        aria-hidden="true"
        @click="layout.closeOverlay()"
      />
      <AppSidebar
        overlay
        :assistant-offered="assistantOffered"
        @jobs="openJobs"
        @add="workspaceDialogs.open({ kind: 'connection' })"
        @import="workspaceDialogs.open({ kind: 'importConnections' })"
        @export="workspaceDialogs.open({ kind: 'exportConnections' })"
      />
    </div>
    <!-- W6.1: a tab dragged to the workspace's right side opens beside (the tab menu and Mod+\ do it
         from the keyboard). -->
    <div
      v-if="dropShown"
      data-split-drop
      aria-hidden="true"
      class="fixed z-40 grid place-items-center rounded-xl border-2 border-dashed transition-colors duration-120"
      :class="dropOver ? 'border-accent bg-accent/15' : 'border-accent/60 bg-accent/5'"
      :style="dropStyle"
      @dragenter.prevent="dropOver = true"
      @dragover.prevent
      @dragleave="dropOver = false"
      @drop.prevent="onDropBeside"
    >
      <span
        class="pointer-events-none flex items-center gap-2 rounded-lg bg-raised px-3 py-1.5 text-ui font-medium text-fg shadow-float"
      >
        <Columns2 class="size-4 text-accent" aria-hidden="true" />
        {{ $t('split.dropHere') }}
      </span>
    </div>
    <CommandPalette :open="paletteOpen" :ask="paletteAsk" @close="paletteOpen = false" />
    <WorkspaceDialogs />
    <PluginCellHosts />
  </div>
</template>
