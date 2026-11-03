<script setup lang="ts">
import { shortcutFires } from '@/workspace/shortcuts'
import { useShortcutsStore } from '@/stores/shortcuts'
import { BACKUP_SYSTEM_DATABASES } from '@mongo-manager/shared/browser'
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import {
  ArrowRightLeft,
  Copy,
  CopyPlus,
  Database,
  FolderX,
  Plus,
  ServerOff,
  X,
  Eye,
  ArchiveRestore,
  HardDriveDownload,
  Layers,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Settings2,
  Trash2,
  Workflow,
} from 'lucide-vue-next'
import { copyName } from '../copyName'
import { connectionsApi, queryKeys } from '@/api/connections'
import { useCollectionViewsStore, type CollectionSection } from '@/stores/collectionViews'
import { collectionPlace, usePlacesStore } from '@/stores/places'
import { useWorkspaceDialogs } from '@/stores/workspaceDialogs'
import { useConnectionActions } from '@/connections/actions'
import { useConnectionState } from '@/connections/reachability'
import { formatBytes, formatCount } from '@/format'
import DsTabs from '@/ds/DsTabs.vue'
import DsMenu from '@/ds/DsMenu.vue'
import DsBadge from '@/ds/DsBadge.vue'
import DsButton from '@/ds/DsButton.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsSpinner from '@/ds/DsSpinner.vue'
import { useCollectionPresence } from '@/connections/presence'
import { useTabsStore } from '@/stores/tabs'
import { openDatabaseTab } from '@/workspace/openTabs'
import type { DsMenuItem } from '@/ds/menu'
import DocumentsView from '@/documents/DocumentsView.vue'
import { NEWEST_FIRST, NEWEST_FIRST_SORT, hasQueryParts } from '@/documents/queryBuild'
import { usePreferencesStore } from '@/stores/preferences'
import CollectionOverview, { type ViewOptions } from './CollectionOverview.vue'
import AskAiButton from '@/ai/AskAiButton.vue'
import PluginFrame from '@/plugins/PluginFrame.vue'
import {
  frameKey,
  localized,
  usePluginsStore,
  type Contribution as PluginContribution,
} from '@/plugins/store'
import { showDocumentById } from '@/documents/showDocument'
import { actionsFor } from '@/ai/insert'
import { editViewPipeline } from '@/aggregation/viewEdit'
import PersonalDataCard from './PersonalDataCard.vue'

const IndexesView = defineAsyncComponent(() => import('@/indexes/IndexesView.vue'))
const SchemaView = defineAsyncComponent(() => import('@/schema/SchemaView.vue'))
const AggregationView = defineAsyncComponent(() => import('@/aggregation/AggregationView.vue'))
const ExplainView = defineAsyncComponent(() => import('@/explain/ExplainView.vue'))
const ValidationView = defineAsyncComponent(() => import('@/validation/ValidationView.vue'))
const WatchView = defineAsyncComponent(() => import('@/watch/WatchView.vue'))
const BackupsCard = defineAsyncComponent(() => import('@/backup/BackupsCard.vue'))

const props = defineProps<{ connectionId: string; db: string; coll: string; tabId?: string }>()
const { t, locale } = useI18n()
const state = useCollectionViewsStore().stateFor(
  props.tabId ?? `${props.connectionId}/${props.db}/${props.coll}`,
)
const target = computed(() => ({ connectionId: props.connectionId, db: props.db, coll: props.coll }))

const { data: connections } = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
const { data: collections } = useQuery({
  queryKey: computed(() => queryKeys.collections(props.connectionId, props.db)),
  queryFn: () => connectionsApi.collections(props.connectionId, props.db),
})
const connection = computed(() => connections.value?.find((c) => c.id === props.connectionId))
// User review 2026-10-09: a collection (or a connection) that is not there says so; MongoDB reads a
// missing collection as an empty one, which would show an empty, writable collection (and an Insert
// that makes it).
const { presence, settled } = useCollectionPresence(
  () => props.connectionId,
  () => props.db,
  () => props.coll,
)
const gone = computed(() => presence.value === 'noConnection' || presence.value === 'noCollection')
// A list slow to come keeps no one waiting: after a moment the tab opens read-only as it did (writes
// wait for the collection's type, Minor 7), and says the collection is missing if the list says so.
const waited = ref(false)
const waitTimer = setTimeout(() => (waited.value = true), 1500)
onBeforeUnmount(() => clearTimeout(waitTimer))
const waiting = computed(() => !settled.value && !waited.value)
const workspaceTabs = useTabsStore()
function closeTab(): void {
  if (props.tabId) workspaceTabs.close(props.tabId)
}
const permissions = computed(() => connection.value?.permissions ?? [])
const info = computed(() => collections.value?.find((c) => c.name === props.coll))
// Until the collection's type is known, treat it as a (read-only) view: never offer writes too early.
const isView = computed(() => collections.value === undefined || info.value?.type === 'view')
/**
 * User request 2026-11-02: a collection opens with its newest documents first, decided once, as the
 * documents are first shown (the collection's type known by then): only a plain collection — a view
 * or a time series has no index on _id to sort by — and only a query still empty; never again once
 * the user cleared it. Said in the draft's sort, where it is changed like any other.
 */
const preferences = usePreferencesStore()
watch(
  waiting,
  (still) => {
    if (still || !state.opening) return
    state.opening = false
    if (!preferences.newestFirst || info.value?.type !== 'collection') return
    if (hasQueryParts(state.query) || state.draft.sort.trim()) return
    state.query = { ...state.query, sort: NEWEST_FIRST_SORT }
    state.draft = { ...state.draft, sort: NEWEST_FIRST }
    state.openingSort = NEWEST_FIRST
  },
  { immediate: true, flush: 'sync' },
)
const canWriteDocuments = computed(() => permissions.value.includes('documents:write'))
// Phase 3d-1: the server says whether this caller may export here (a viewer may hold the grant).
const canExport = computed(() => connection.value?.export ?? false)
const canManageIndexes = computed(() => permissions.value.includes('indexes:write') && !isView.value)

// Phase 3e-1: Watch, for those who may read documents. A view has no change stream of its own: its
// Watch says so and offers the collection it reads (final review M5).
const canWatch = computed(() => permissions.value.includes('documents:read'))
const canManagePersonal = computed(() => permissions.value.includes('connections:manage'))
// User reports 2026-10-23: what needs the server is shown only while connected to it (reachability.ts).
const { connected } = useConnectionState(() => props.connectionId)
const viewOn = computed(() => {
  const i = info.value
  return i?.type === 'view' && typeof i.options.viewOn === 'string' ? i.options.viewOn : undefined
})
// W2.4: what the collection was made with, said in its header.
const collationLocale = computed(() => {
  const c = info.value?.options.collation as { locale?: unknown } | undefined
  return typeof c?.locale === 'string' && c.locale !== 'simple' ? c.locale : null
})
const preImagesOn = computed(
  () =>
    (info.value?.options.changeStreamPreAndPostImages as { enabled?: unknown } | undefined)?.enabled === true,
)
const plugins = usePluginsStore()
const pluginTab = computed(() =>
  current.value.startsWith('plugin:') ? plugins.byKey(current.value) : undefined,
)
function openFromPlugin(id: unknown): void {
  if (showDocumentById(state, id)) state.section = 'documents'
}
const sections = computed<CollectionSection[]>(() => [
  ...(isView.value
    ? (['documents', 'aggregations', 'explain', 'schema', 'overview'] as const)
    : (['documents', 'aggregations', 'explain', 'schema', 'indexes', 'validation', 'overview'] as const)),
  // Third review (M2): a change stream needs the server, as on the database's and connection's pages.
  ...(canWatch.value && connected.value ? (['watch'] as const) : []),
  // User request 2026-10-23: what of this collection holds personal data, for the connection's
  // administrators. Not on a view (its source's rules hide its values), nor on a database or a
  // collection named * (a rule's wildcard: its rules would be every collection's).
  ...(canManagePersonal.value && !isView.value && connected.value && props.db !== '*' && props.coll !== '*'
    ? (['personalData'] as const)
    : []),
  // User request 2026-10-30: the backups that hold this collection, as on its database's page — for
  // one who may take or restore them (never a view, nor a system database's collection).
  ...((canDump.value || canRestore.value) && !isView.value && connected.value && props.coll !== '*'
    ? (['backups'] as const)
    : []),
  // Phase 4b §3: plugins' tabs come after the app's own — on views too (user request 2026-10-10):
  // the frame lets a plugin read a view and refuses it any write.
  ...plugins.collectionTabs.map((c) => c.key as CollectionSection),
])
const current = computed(() => (sections.value.includes(state.section) ? state.section : 'documents'))
const sectionTabsEl = ref<{ focusSelected: () => void } | null>(null)
const section = computed({
  get: () => current.value,
  set: (next: CollectionSection) => {
    state.section = next
  },
})
/** The overview's note goes with it: the focus goes to the tab it opened (review 2026-10-26). */
function seeRules(): void {
  section.value = 'personalData'
  void nextTick(() => sectionTabsEl.value?.focusSelected())
}
/**
 * User report 2026-10-16: a plugin tab's page that asked to (ui.keepOpen) stays while another section
 * shows — out of sight, where the frame refuses whatever it would show — so a value search's results
 * are still there after one of them was opened in Documents. Any other page is loaded again each time
 * it is shown, as before. A page is its plugin's version and permissions: an update loads it again
 * (frameKey, shared with the plugin pages).
 */
const keeping = ref<string[]>([])
function keep(tab: PluginContribution, on: boolean): void {
  const key = frameKey(tab)
  keeping.value = on ? [...new Set([...keeping.value, key])] : keeping.value.filter((k) => k !== key)
}
// A plugin gone (disabled, removed, updated) is forgotten: back, it is loaded only when its tab is shown.
watch(
  () => plugins.collectionTabs.map(frameKey),
  (present) => {
    const still = keeping.value.filter((key) => present.includes(key))
    if (still.length !== keeping.value.length) keeping.value = still
  },
)
const pluginFrames = computed(() =>
  plugins.collectionTabs.filter(
    (tab) =>
      sections.value.includes(tab.key as CollectionSection) &&
      (tab.key === pluginTab.value?.key || keeping.value.includes(frameKey(tab))),
  ),
)

// UI redesign R1 revision 2 §4.1: the header says what the collection holds (a view has no stats).
const { data: stats } = useQuery({
  queryKey: computed(() => queryKeys.collectionStats(props.connectionId, props.db, props.coll)),
  queryFn: () => connectionsApi.collectionStats(props.connectionId, props.db, props.coll),
  enabled: computed(() => collections.value !== undefined && !isView.value && presence.value === 'present'),
})
const facts = computed(() => {
  const s = stats.value
  if (!s) return []
  return [
    t('collection.header.documents', { n: formatCount(s.count, locale.value) }, s.count),
    // A size hidden where personal data is hidden from you is left out.
    ...(s.size === null ? [] : [formatBytes(s.size, locale.value)]),
    t('collection.header.indexes', { n: formatCount(s.nindexes, locale.value) }, s.nindexes),
  ]
})
const tabs = computed(() =>
  sections.value.map((s) => ({
    value: s,
    label: s.startsWith('plugin:')
      ? localized(plugins.byKey(s)?.title ?? { en: s }, locale.value)
      : t(`documents.sections.${s}`),
    ...(s === 'indexes' && stats.value ? { count: stats.value.nindexes } : {}),
  })),
)

// The collection's own actions (the data ones are on the results toolbar).
const places = usePlacesStore()
const dialogs = useWorkspaceDialogs()
const actions = useConnectionActions()
const place = computed(() => collectionPlace(props.connectionId, props.db, props.coll))
const canWriteDatabase = computed(() => permissions.value.includes('databases:write'))
// Menu sweep 2026-10-08: a system database's collections are never backed up (the server refuses).
const canDump = computed(
  () =>
    canExport.value && permissions.value.includes('jobs:run') && !BACKUP_SYSTEM_DATABASES.includes(props.db),
)
// W4.4: as the database's "Restore here…" (documents:write and jobs:run; never a system database).
const canRestore = computed(
  () =>
    permissions.value.includes('documents:write') &&
    permissions.value.includes('jobs:run') &&
    !BACKUP_SYSTEM_DATABASES.includes(props.db),
)
const menu = computed<DsMenuItem[]>(() => {
  const pinned = places.isPinned(place.value.key)
  return [
    {
      id: 'pin',
      label: pinned ? t('layout.unpin') : t('layout.pin'),
      icon: pinned ? PinOff : Pin,
      // W5: the tab's own place pins with the user's keys too.
      shortcut: shortcuts.keysOf('pinPlace')[0],
    },
    // W1 (completion §2): the plain name, as typed in a query or the shell.
    { id: 'copyName', label: t('explorer.copyName.action'), icon: Copy },
    { id: 'refresh', label: t('menu.refresh'), icon: RefreshCw },
    ...(canExport.value && !isView.value && connected.value
      ? [{ id: 'liveSync', label: t('liveSync.menu.collection'), icon: ArrowRightLeft }]
      : []),
    ...(canDump.value && !isView.value && connected.value
      ? [{ id: 'backup', label: t('backup.menu.dumpCollection'), icon: HardDriveDownload }]
      : []),
    // W4.4: a backup restored into this collection.
    ...(canRestore.value && !isView.value && connected.value
      ? [{ id: 'restoreHere', label: t('backup.menu.restoreHere'), icon: ArchiveRestore }]
      : []),
    ...(canWriteDatabase.value && connected.value
      ? [
          // Menu sweep 2026-10-08: MongoDB cannot rename a view.
          ...(isView.value ? [] : [{ id: 'rename', label: t('menu.rename'), icon: Pencil }]),
          // W2: a collection's options (pre/post images); a view's pipeline, in the builder.
          ...(isView.value
            ? viewOn.value
              ? [{ id: 'editView', label: t('collection.view.edit'), icon: Workflow }]
              : []
            : [{ id: 'edit', label: t('collection.edit.menu'), icon: Settings2 }]),
          { id: 'duplicate', label: t('menu.duplicate'), icon: CopyPlus },
          { id: 'drop', label: t('menu.drop'), icon: Trash2, danger: true },
        ]
      : []),
  ]
})
function onMenu(id: string): void {
  const where = { connectionId: props.connectionId, db: props.db, coll: props.coll }
  if (id === 'pin') places.togglePin(place.value)
  else if (id === 'copyName') void copyName(props.coll, t)
  else if (id === 'refresh') void actions.refreshDatabase(props.connectionId, props.db)
  else if (id === 'liveSync') dialogs.open({ kind: 'liveSync', ...where })
  else if (id === 'backup') dialogs.open({ kind: 'backupDump', ...where })
  else if (id === 'restoreHere') dialogs.open({ kind: 'backupRestore', ...where })
  else if (id === 'rename') dialogs.open({ kind: 'renameCollection', ...where })
  else if (id === 'edit') dialogs.open({ kind: 'editCollection', ...where, tabId: tabId.value })
  else if (id === 'editView') void editView()
  else if (id === 'duplicate') dialogs.open({ kind: 'duplicateCollection', ...where })
  else if (id === 'drop') void actions.dropCollection(props.connectionId, props.db, props.coll, isView.value)
}

/** W2.2: the view's pipeline, opened in its source's aggregation builder to edit. */
async function editView(): Promise<void> {
  if (!viewOn.value) return
  // The definition is read as stored there (re-review minor 3: its types kept).
  await editViewPipeline({ connectionId: props.connectionId, db: props.db, name: props.coll }, t)
}

const askAi = ref<InstanceType<typeof AskAiButton> | null>(null)
const shortcuts = useShortcutsStore()
/** Phase 4a-1 plan ruling 17: Mod+I asks the assistant from anywhere in the tab. */
function onTabKey(event: KeyboardEvent): void {
  // Ctrl+Shift+I stays the browser's (its developer tools; final review minor 9): bindings never take it.
  // W5: the keys are the user's own (Account → Shortcuts); never while typing a plain key or while an
  // input method composes (review I4).
  if (shortcutFires(event, shortcuts.keysOf('askAi'))) {
    event.preventDefault()
    askAi.value?.open()
  }
}

const tabsId = useId()
const tabId = computed(() => props.tabId ?? `${props.connectionId}/${props.db}/${props.coll}`)
</script>

<template>
  <div v-if="gone" data-collection-missing class="h-full overflow-auto">
    <DsEmptyState
      v-if="presence === 'noConnection'"
      :icon="ServerOff"
      :title="t('collection.missing.noConnectionTitle')"
      :description="t('collection.missing.noConnection')"
    >
      <template #actions>
        <DsButton v-if="tabId" :icon="X" @click="closeTab">{{ t('collection.missing.close') }}</DsButton>
      </template>
    </DsEmptyState>
    <DsEmptyState
      v-else
      :icon="FolderX"
      :title="t('collection.missing.title', { db, coll })"
      :description="t('collection.missing.body')"
    >
      <template #actions>
        <DsButton
          v-if="canWriteDatabase"
          variant="primary"
          :icon="Plus"
          @click="dialogs.open({ kind: 'createCollection', connectionId, db, name: coll })"
        >
          {{ t('collection.missing.create', { coll }) }}
        </DsButton>
        <DsButton :icon="Database" @click="openDatabaseTab(workspaceTabs, connectionId, db)">
          {{ t('collection.missing.openDatabase', { db }) }}
        </DsButton>
        <DsButton v-if="tabId" variant="ghost" :icon="X" @click="closeTab">
          {{ t('collection.missing.close') }}
        </DsButton>
      </template>
    </DsEmptyState>
  </div>
  <div
    v-else-if="waiting"
    role="status"
    class="grid h-full place-items-center"
    :aria-label="t('app.loading')"
  >
    <DsSpinner :size="18" />
  </div>
  <div v-else class="flex h-full min-h-0 flex-col" @keydown="onTabKey">
    <header class="shrink-0 border-b border-line px-4 pt-3">
      <div class="flex items-start gap-3">
        <span
          class="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-fg"
          aria-hidden="true"
        >
          <component :is="info?.type === 'view' ? Eye : Layers" class="size-[18px]" />
        </span>
        <div class="min-w-0 flex-1">
          <h2 class="flex min-w-0 items-center gap-2 text-title-m font-semibold text-fg">
            <span class="truncate" :title="`${db}.${coll}`"
              ><span class="sr-only">{{ db }}.</span>{{ coll }}</span
            >
            <DsBadge v-if="info?.type === 'view'">{{ t('collection.kinds.view') }}</DsBadge>
            <DsBadge v-else-if="info?.type === 'timeseries'">{{ t('collection.kinds.timeseries') }}</DsBadge>
            <DsBadge v-if="stats?.capped">{{ t('collection.header.capped') }}</DsBadge>
            <DsBadge v-if="collationLocale" :title="t('collection.collation.title')">{{
              t('collection.header.collation', { locale: collationLocale })
            }}</DsBadge>
            <DsBadge v-if="preImagesOn">{{ t('collection.header.preImages') }}</DsBadge>
          </h2>
          <p class="flex min-w-0 flex-wrap items-center gap-x-1.5 text-small text-fg-subtle">
            <span class="truncate font-mono" aria-hidden="true">{{ db }}</span>
            <template v-for="fact in facts" :key="fact">
              <span aria-hidden="true">·</span>
              <span class="tabular-nums">{{ fact }}</span>
            </template>
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <AskAiButton
            ref="askAi"
            :connection-id="connectionId"
            :db="db"
            :coll="coll"
            :tab-id="tabId"
            :actions="actionsFor(current, isView)"
          />
          <DsMenu
            :label="t('collection.header.more', { name: coll })"
            :items="menu"
            focusable
            size="md"
            @select="onMenu"
          />
        </div>
      </div>
      <DsTabs
        ref="sectionTabsEl"
        v-model="section"
        class="mt-1.5 -mb-px"
        :label="t('documents.sections.label')"
        :tabs="tabs"
        :id-prefix="tabsId"
        :panel-id="`${tabsId}-panel`"
      />
    </header>
    <div
      :id="`${tabsId}-panel`"
      role="tabpanel"
      :aria-labelledby="`${tabsId}-${current}`"
      class="min-h-0 flex-1"
    >
      <DocumentsView
        v-if="current === 'documents'"
        :target="target"
        :tab-id="tabId"
        :can-write="canWriteDocuments"
        :is-view="isView"
        :can-export="canExport"
      />
      <AggregationView
        v-else-if="current === 'aggregations'"
        :target="target"
        :tab-id="tabId"
        :can-write="canWriteDocuments"
        :can-write-database="canWriteDatabase"
        :can-export="canExport"
      />
      <ExplainView
        v-else-if="current === 'explain'"
        :target="target"
        :tab-id="tabId"
        :can-manage-indexes="canManageIndexes"
      />
      <SchemaView v-else-if="current === 'schema'" :target="target" :tab-id="tabId" />
      <ValidationView
        v-else-if="current === 'validation'"
        :target="target"
        :tab-id="tabId"
        :can-write="permissions.includes('databases:write')"
      />
      <IndexesView v-else-if="current === 'indexes'" :target="target" :can-manage="canManageIndexes" />
      <div v-else-if="current === 'personalData' && connection" class="h-full overflow-auto p-4">
        <PersonalDataCard
          class="max-w-6xl"
          :connection="connection"
          :scope="{ db, coll }"
          :suggested="state.personalSuggested ?? null"
          @dismiss-suggested="state.personalSuggested = null"
        />
      </div>
      <div v-else-if="current === 'backups'" class="h-full overflow-auto p-4">
        <BackupsCard class="max-w-6xl" :connection-id="connectionId" :db="db" :coll="coll" />
      </div>
      <WatchView
        v-else-if="current === 'watch'"
        :target="{ connectionId, scope: 'collection', db, coll }"
        :can-export="canExport"
        :view-on="viewOn"
        :can-change-options="canWriteDatabase && !isView"
      />
      <div v-else-if="!pluginTab" class="h-full overflow-auto">
        <CollectionOverview
          :connection-id="connectionId"
          :db="db"
          :coll="coll"
          :view="info?.type === 'view' ? (info.options as ViewOptions) : null"
          :can-see-rules="sections.includes('personalData')"
          @edit-view="editView"
          @see-rules="seeRules"
        />
      </div>
      <div
        v-for="tab in pluginFrames"
        v-show="tab.key === pluginTab?.key"
        :key="frameKey(tab)"
        data-plugin-tab
        class="flex h-full min-h-0 flex-col"
      >
        <PluginFrame
          :plugin="tab.plugin"
          kind="collectionTab"
          :contribution="tab.id"
          :target="target"
          :filter="state.query.filter"
          :inactive="tab.key !== pluginTab?.key"
          @open-document="openFromPlugin"
          @keep="(on: boolean) => keep(tab, on)"
        />
      </div>
    </div>
  </div>
</template>
