<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, ref, watch, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import {
  Copy,
  CopyPlus,
  Database,
  Eye,
  HardDriveDownload,
  Layers,
  Pencil,
  Plus,
  RotateCw,
  SquareTerminal,
  Table,
  Trash2,
} from 'lucide-vue-next'
import { copyName } from '../copyName'
import { BACKUP_SYSTEM_DATABASES } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsBadge from '@/ds/DsBadge.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsCard from '@/ds/DsCard.vue'
import DsDataTable from '@/ds/DsDataTable.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsMenu from '@/ds/DsMenu.vue'
import DsPageHeader from '@/ds/DsPageHeader.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import DsTabs from '@/ds/DsTabs.vue'
import type { DsMenuItem } from '@/ds/menu'
import type { DsColumn } from '@/ds/table'
import { connectionsApi, queryKeys } from '@/api/connections'
import { describeError } from '@/api/errors'
import { formatBytes, formatCount } from '@/format'
import { useConnectionActions } from '@/connections/actions'
import { useConnectionState } from '@/connections/reachability'
import { useTabsStore } from '@/stores/tabs'
import { useWorkspaceDialogs } from '@/stores/workspaceDialogs'
import { openCollectionTab, openConnectionShell } from '../openTabs'
import StatGrid from './StatGrid.vue'
import BackupsCard from '@/backup/BackupsCard.vue'
import PersonalDataCard from './PersonalDataCard.vue'
import { useTabSectionsStore } from '@/stores/tabSections'

const WatchView = defineAsyncComponent(() => import('@/watch/WatchView.vue'))
// W6.4: the data model, loaded when its section opens.
const ModelView = defineAsyncComponent(() => import('@/model/ModelView.vue'))

const props = defineProps<{ connectionId: string; db: string; tabId?: string }>()
const { t, locale } = useI18n()
const tabs = useTabsStore()
const dialogs = useWorkspaceDialogs()
const actions = useConnectionActions()

const { data: connections } = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
const canWrite = computed(
  () =>
    connections.value?.find((c) => c.id === props.connectionId)?.permissions.includes('databases:write') ??
    false,
)
const showBackups = computed(() => {
  const c = connections.value?.find((x) => x.id === props.connectionId)
  if (!c?.permissions.includes('jobs:run')) return false
  return Boolean(c.export) || c.permissions.includes('documents:write')
})
// Phase 3e-1: Overview and, for those who may read documents, Watch; the open one kept with the tab.
const tabSections = useTabSectionsStore()
const stateKey = computed(() => props.tabId ?? `database:${props.connectionId}/${props.db}`)
const connection = computed(() => connections.value?.find((c) => c.id === props.connectionId))
const canWatch = computed(() => connection.value?.permissions.includes('documents:read') ?? false)
const canExport = computed(() => connection.value?.export ?? false)
type Section = 'overview' | 'model' | 'watch' | 'backups' | 'personalData'
// W6.4: the Model section, for those who may read documents (as the schema analysis).
// User reports 2026-10-23: what needs the server is shown only while connected to it (reachability.ts).
const { connected } = useConnectionState(() => props.connectionId)
// User request 2026-10-24: the connection's administrators set what of this database is personal data.
const canManage = computed(() => connection.value?.permissions.includes('connections:manage') ?? false)
const SECTIONS = computed<Section[]>(() => [
  'overview',
  ...(connected.value
    ? [
        ...(canWatch.value ? (['model', 'watch'] as const) : []),
        // User request 2026-10-24: Backups and Personal data are tabs beside these, as on the connection.
        ...(showBackups.value ? (['backups'] as const) : []),
        // A rule's * is no database's name (review of the tabs, M5).
        ...(canManage.value && props.db !== '*' ? (['personalData'] as const) : []),
      ]
    : []),
])
const section = computed<Section>(() => {
  const s = tabSections.get(stateKey.value, 'overview') as Section
  return SECTIONS.value.includes(s) ? s : 'overview'
})
// Design 2026-10-25 (B7; review M6): the section shown, for the assistant's focus.
watch(section, (s) => tabSections.setValue(stateKey.value, 'shown', s), { immediate: true })
const ids = useId()
// UI redesign R3 §4: the sections as the kit's tabs (arrow keys, Home and End are theirs).
const sectionModel = computed({
  get: () => section.value,
  set: (next: Section) => tabSections.set(stateKey.value, next),
})
const sectionTabsEl = ref<{ focusSelected: () => void } | null>(null)
/** The note's button goes with the overview: the focus goes to the tab it opened (review 2026-10-26). */
function seeRules(): void {
  sectionModel.value = 'personalData'
  void nextTick(() => sectionTabsEl.value?.focusSelected())
}
const sectionTabs = computed(() =>
  SECTIONS.value.map((s) => ({ value: s, label: t(`database.sections.${s}`) })),
)
const stats = useQuery({
  queryKey: computed(() => queryKeys.databaseStats(props.connectionId, props.db)),
  queryFn: () => connectionsApi.databaseStats(props.connectionId, props.db),
})
const collections = useQuery({
  queryKey: computed(() => queryKeys.collections(props.connectionId, props.db)),
  queryFn: () => connectionsApi.collections(props.connectionId, props.db),
})

const statItems = computed(() => {
  const s = stats.data.value
  if (!s) return []
  const n = (v: number) => formatCount(v, locale.value)
  // A size hidden where personal data is hidden from you says so.
  const b = (v: number | null) => (v === null ? t('overview.stats.hidden') : formatBytes(v, locale.value))
  return [
    { label: t('overview.stats.collections'), value: n(s.collections) },
    { label: t('overview.stats.views'), value: n(s.views) },
    { label: t('overview.stats.objects'), value: n(s.objects) },
    { label: t('overview.stats.indexes'), value: n(s.indexes) },
    { label: t('overview.stats.dataSize'), value: b(s.dataSize) },
    { label: t('overview.stats.storageSize'), value: b(s.storageSize) },
    { label: t('overview.stats.indexSize'), value: b(s.indexSize) },
  ]
})

// UI redesign R3 §4: the database's header — its facts, one primary action, the rest in "…".
// Review of R3 (minor 5): counted from the list the card shows, collections and views apart.
const facts = computed(() => {
  const list = collections.data.value
  const s = stats.data.value
  if (!list && !s) return []
  const views = list?.filter((c) => c.type === 'view').length ?? 0
  const colls = (list?.length ?? 0) - views
  return [
    ...(list ? [t('database.collectionsCount', { n: formatCount(colls, locale.value) }, colls)] : []),
    ...(list && views > 0 ? [t('database.viewsCount', { n: formatCount(views, locale.value) }, views)] : []),
    ...(s && s.dataSize !== null ? [formatBytes(s.dataSize, locale.value)] : []),
  ]
})
const canDump = computed(
  () =>
    Boolean(connection.value?.export) &&
    (connection.value?.permissions.includes('jobs:run') ?? false) &&
    !BACKUP_SYSTEM_DATABASES.includes(props.db),
)
const headerMenu = computed<DsMenuItem[]>(() => [
  // W1 (completion §2): the plain name, as typed in a query or the shell.
  { id: 'copyName', label: t('explorer.copyName.action'), icon: Copy },
  ...(canDump.value && connected.value
    ? [{ id: 'backup', label: t('backup.menu.dumpDatabase'), icon: HardDriveDownload }]
    : []),
  { id: 'refresh', label: t('menu.refresh'), icon: RotateCw },
  ...(canWrite.value && connected.value
    ? [{ id: 'drop', label: t('database.drop'), icon: Trash2, danger: true }]
    : []),
])
function onHeaderMenu(id: string): void {
  if (id === 'copyName') void copyName(props.db, t)
  else if (id === 'backup')
    dialogs.open({ kind: 'backupDump', connectionId: props.connectionId, db: props.db })
  else if (id === 'refresh') void actions.refreshDatabase(props.connectionId, props.db)
  else if (id === 'drop') void actions.dropDatabase(props.connectionId, props.db)
}

const columns = computed<DsColumn[]>(() => [
  { key: 'name', label: t('overview.name') },
  { key: 'type', label: t('overview.type'), width: '10rem' },
])
type CollectionRow = { name: string; type: string }
const rowMenu = (c: CollectionRow): DsMenuItem[] => [
  { id: 'open', label: t('database.openCollection'), icon: Table },
  { id: 'copyName', label: t('explorer.copyName.action'), icon: Copy },
  ...(canWrite.value && connected.value
    ? [
        ...(c.type === 'view' ? [] : [{ id: 'rename', label: t('menu.rename'), icon: Pencil }]),
        { id: 'duplicate', label: t('menu.duplicate'), icon: CopyPlus },
        { id: 'drop', label: t('menu.drop'), icon: Trash2, danger: true },
      ]
    : []),
]
function onRowMenu(c: CollectionRow, id: string): void {
  const where = { connectionId: props.connectionId, db: props.db, coll: c.name }
  if (id === 'open') openCollectionTab(tabs, props.connectionId, props.db, c.name)
  else if (id === 'copyName') void copyName(c.name, t)
  else if (id === 'rename') dialogs.open({ kind: 'renameCollection', ...where })
  else if (id === 'duplicate') dialogs.open({ kind: 'duplicateCollection', ...where })
  else if (id === 'drop') void actions.dropCollection(props.connectionId, props.db, c.name, c.type === 'view')
}

const typeLabel = (type: string): string =>
  type === 'view'
    ? t('tree.types.view')
    : type === 'timeseries'
      ? t('tree.types.timeseries')
      : t('collection.kinds.collection')
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <DsPageHeader :title="db" :icon="Database" :facts="facts">
      <template #actions>
        <!-- User request 2026-10-11: a shell on this database, its own page, kept while open. -->
        <DsButton
          v-if="connection?.shell && connected"
          data-open-shell
          size="sm"
          :icon="SquareTerminal"
          :title="t('shell.openOn', { db })"
          @click="connection && openConnectionShell(tabs, connection, db)"
        >
          {{ t('shell.section') }}
        </DsButton>
        <DsButton
          v-if="canWrite && connected"
          size="sm"
          variant="primary"
          :icon="Plus"
          @click="dialogs.open({ kind: 'createCollection', connectionId, db })"
        >
          {{ t('menu.newCollection') }}
        </DsButton>
        <DsMenu
          :label="t('database.more', { name: db })"
          :items="headerMenu"
          focusable
          size="header"
          @select="onHeaderMenu"
        />
      </template>
      <template v-if="SECTIONS.length > 1" #tabs>
        <DsTabs
          ref="sectionTabsEl"
          v-model="sectionModel"
          :label="t('database.sections.label')"
          :tabs="sectionTabs"
          :id-prefix="ids"
          :panel-id="`${ids}-panel`"
        />
      </template>
    </DsPageHeader>
    <div
      :id="`${ids}-panel`"
      :role="SECTIONS.length > 1 ? 'tabpanel' : undefined"
      :aria-labelledby="SECTIONS.length > 1 ? `${ids}-${section}` : undefined"
      class="min-h-0 flex-1 overflow-auto"
    >
      <WatchView
        v-if="section === 'watch'"
        :target="{ connectionId, scope: 'database', db }"
        :can-export="canExport"
      />
      <ModelView v-else-if="section === 'model'" :connection-id="connectionId" :db="db" />
      <!-- Phase 3d-3a: this database's backups, and the way to take or restore one. -->
      <section v-else-if="section === 'backups'" class="flex max-w-6xl flex-col gap-4 p-4">
        <BackupsCard :connection-id="connectionId" :db="db" />
      </section>
      <section v-else-if="section === 'personalData' && connection" class="flex max-w-6xl flex-col gap-4 p-4">
        <PersonalDataCard :connection="connection" :scope="{ db }" />
      </section>
      <section v-else class="flex max-w-6xl flex-col gap-4 p-4">
        <DsCallout v-if="stats.isError.value" tone="danger">{{
          describeError(stats.error.value, t)
        }}</DsCallout>
        <StatGrid v-else-if="statItems.length > 0" :items="statItems" />
        <DsSkeleton v-else class="h-[68px] rounded-card" />
        <!-- 2026-10-26 (user report): why the sizes say Hidden, and, for an administrator, where the rules are. -->
        <p v-if="stats.data.value?.sizesHidden" class="text-small text-fg-subtle" data-sizes-hidden>
          {{ t('overview.stats.sizesHidden') }}
          <button
            v-if="SECTIONS.includes('personalData')"
            type="button"
            class="cursor-pointer rounded-sm font-medium text-accent-fg hover:underline focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
            @click="seeRules"
          >
            {{ t('overview.stats.seeRules') }}
          </button>
        </p>
        <DsCard :title="t('overview.collections')" :count="collections.data.value?.length">
          <DsDataTable
            :label="t('overview.collections')"
            :error="collections.isError.value ? describeError(collections.error.value, t) : undefined"
            :columns="columns"
            :rows="collections.data.value ?? []"
            :loading-label="t('app.loading')"
            :row-key="(c: CollectionRow) => c.name"
            :loading="collections.isPending.value"
            :actions-label="t('documents.actionsColumn')"
          >
            <template #cell-name="{ row: c }">
              <button
                type="button"
                class="inline-flex max-w-full cursor-pointer items-center gap-2 rounded-md text-left text-fg hover:text-accent-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
                @click="openCollectionTab(tabs, connectionId, db, c.name)"
              >
                <component
                  :is="c.type === 'view' ? Eye : Layers"
                  class="size-3.5 shrink-0 text-fg-subtle"
                  aria-hidden="true"
                />
                <span class="truncate">{{ c.name }}</span>
              </button>
            </template>
            <template #cell-type="{ row: c }">
              <DsBadge :tone="c.type === 'collection' ? 'neutral' : 'info'">{{ typeLabel(c.type) }}</DsBadge>
            </template>
            <template #actions="{ row: c }">
              <DsMenu
                focusable
                touch
                :label="t('database.actionsFor', { name: c.name })"
                :items="rowMenu(c)"
                @select="onRowMenu(c, $event)"
              />
            </template>
            <template #retry>
              <DsButton size="sm" :icon="RotateCw" @click="collections.refetch()">{{
                t('common.retry')
              }}</DsButton>
            </template>
            <template #empty>
              <DsEmptyState
                :icon="Layers"
                :title="t('database.emptyTitle')"
                :description="t('database.empty')"
              >
                <template v-if="canWrite" #actions>
                  <DsButton
                    variant="primary"
                    :icon="Plus"
                    @click="dialogs.open({ kind: 'createCollection', connectionId, db })"
                  >
                    {{ t('menu.newCollection') }}
                  </DsButton>
                </template>
              </DsEmptyState>
            </template>
          </DsDataTable>
        </DsCard>
      </section>
    </div>
  </div>
</template>
