<script setup lang="ts">
import { BACKUP_SYSTEM_DATABASES } from '@mongo-manager/shared/browser'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import {
  ArchiveRestore,
  HardDriveDownload,
  ArrowRightLeft,
  Clock,
  Copy,
  Database,
  FolderOpen,
  Download,
  Eye,
  FileCode,
  CopyPlus,
  GitCompare,
  Pencil,
  Plus,
  RefreshCw,
  SquareTerminal,
  Table,
  Trash2,
  Upload,
} from 'lucide-vue-next'
import { connectionsApi, queryKeys, type CollectionInfo, type ConnectionDto } from '@/api/connections'
import { describeError } from '@/api/errors'
import type { DsMenuItem as MenuItem } from '@/ds/menu'
import { treeKey, useTreeStore } from '@/stores/tree'
import { useTabsStore } from '@/stores/tabs'
import { useWorkspaceDialogs } from '@/stores/workspaceDialogs'
import { usePluginsStore } from '@/plugins/store'
import { useConnectionActions } from '@/connections/actions'
import { openCollectionTab, openConnectionShell, openDatabaseTab, openGridFsTab } from '../openTabs'
import { Pin, PinOff } from 'lucide-vue-next'
import { collectionPlace, databasePlace, usePlacesStore } from '@/stores/places'
import TreeRow from './TreeRow.vue'
import TreeStatus from './TreeStatus.vue'
import { copyName } from '../copyName'

const props = defineProps<{ connection: ConnectionDto; db: string; level: number }>()
const { t } = useI18n()
const tree = useTreeStore()
const plugins = usePluginsStore()
const tabs = useTabsStore()
const places = usePlacesStore()
const dialogs = useWorkspaceDialogs()
const actions = useConnectionActions()

const key = computed(() => treeKey('d', props.connection.id, props.db))
const canWrite = computed(() => props.connection.permissions.includes('databases:write'))
// Phase 3d-3a: a dump reads the data out as an export does; a restore writes documents.
// Menu sweep 2026-10-08: admin, local and config are never backed up nor a restore's target (the
// server refuses them), so they are not offered.
const userDb = computed(() => !BACKUP_SYSTEM_DATABASES.includes(props.db))
const canDump = computed(
  () => userDb.value && Boolean(props.connection.export) && props.connection.permissions.includes('jobs:run'),
)
const canRestore = computed(
  () =>
    userDb.value &&
    props.connection.permissions.includes('documents:write') &&
    props.connection.permissions.includes('jobs:run'),
)
const { data, isPending, isError, error, refetch } = useQuery({
  queryKey: computed(() => queryKeys.collections(props.connection.id, props.db)),
  queryFn: () => connectionsApi.collections(props.connection.id, props.db),
  enabled: computed(() => tree.isExpanded(key.value)),
})

/**
 * Phase 4b §1: a GridFS bucket — a `<x>.files` with its `<x>.chunks` — shows as one files node; the
 * pair stays in the database's collection list.
 */
const BUCKET = /^[A-Za-z0-9_-]{1,64}$/
const buckets = computed(() => {
  const names = new Set((data.value ?? []).map((c) => c.name))
  return [...names]
    .filter(
      (n) => n.endsWith('.files') && names.has(`${n.slice(0, -6)}.chunks`) && BUCKET.test(n.slice(0, -6)),
    )
    .map((n) => n.slice(0, -6))
    .sort()
})
const collections = computed(() => {
  const inBuckets = new Set(buckets.value.flatMap((b) => [`${b}.files`, `${b}.chunks`]))
  return (data.value ?? []).filter((c) => !inBuckets.has(c.name))
})
const shellItem = computed<MenuItem[]>(() =>
  props.connection.shell ? [{ id: 'shell', label: t('menu.openShell'), icon: SquareTerminal }] : [],
)
const dbMenu = computed<MenuItem[]>(() => [
  { id: 'open', label: t('menu.open') },
  {
    id: 'pin',
    label: places.isPinned(databasePlace(props.connection.id, props.db).key)
      ? t('layout.unpin')
      : t('layout.pin'),
    icon: places.isPinned(databasePlace(props.connection.id, props.db).key) ? PinOff : Pin,
  },
  ...(canWrite.value ? [{ id: 'newCollection', label: t('menu.newCollection'), icon: Plus }] : []),
  { id: 'refresh', label: t('menu.refresh'), icon: RefreshCw },
  // W1 (completion §2): the plain name, as typed in a query or the shell.
  { id: 'copyName', label: t('explorer.copyName.action'), icon: Copy },
  // User request 2026-10-11: a shell on this database.
  ...shellItem.value,
  // Phase 3d-2: copying or comparing reads the database out, as an export does.
  ...(props.connection.export
    ? [
        { id: 'copyDatabase', label: t('dataTransfer.copy.menuDatabase'), icon: CopyPlus },
        { id: 'compareDatabase', label: t('dataTransfer.compare.menuDatabase'), icon: GitCompare },
        { id: 'liveSyncDatabase', label: t('liveSync.menu.database'), icon: ArrowRightLeft },
      ]
    : []),
  ...(canDump.value
    ? [{ id: 'backupDatabase', label: t('backup.menu.dumpDatabase'), icon: HardDriveDownload }]
    : []),
  ...(canRestore.value
    ? [{ id: 'restoreHere', label: t('backup.menu.restoreHere'), icon: ArchiveRestore }]
    : []),
  // SQL transfer: a dump's tables into this database's collections (documents:write and jobs:run,
  // as a restore; never a system database).
  // User request 2026-11-02: with the SQL → MongoDB plugin only, as its page.
  ...(canRestore.value && plugins.sqlOffered
    ? [{ id: 'importSql', label: t('dataTransfer.sql.menu'), icon: FileCode }]
    : []),
  // User request 2026-10-11: SQL ↔ MongoDB's export, on this database.
  ...(userDb.value && props.connection.export && plugins.sqlOffered
    ? [{ id: 'exportSql', label: t('sqlTransfer.exportMenu'), icon: FileCode }]
    : []),
  ...(canWrite.value ? [{ id: 'drop', label: t('menu.drop'), icon: Trash2, danger: true }] : []),
])

// Phase 3d-1: import needs documents:write and a collection (not a view); export needs the flag.
const canImport = computed(() => props.connection.permissions.includes('documents:write'))
const canExport = computed(() => props.connection.export ?? false)
const collectionMenu = (c: CollectionInfo): MenuItem[] => [
  { id: 'open', label: t('menu.open') },
  { id: 'copyName', label: t('explorer.copyName.action'), icon: Copy },
  ...shellItem.value,
  {
    id: 'pin',
    label: places.isPinned(collectionPlace(props.connection.id, props.db, c.name).key)
      ? t('layout.unpin')
      : t('layout.pin'),
    icon: places.isPinned(collectionPlace(props.connection.id, props.db, c.name).key) ? PinOff : Pin,
  },
  ...(canImport.value && c.type !== 'view'
    ? [{ id: 'import', label: t('dataTransfer.import'), icon: Upload }]
    : []),
  ...(canExport.value ? [{ id: 'export', label: t('dataTransfer.export'), icon: Download }] : []),
  ...(canExport.value
    ? [
        { id: 'copy', label: t('dataTransfer.copy.menu'), icon: CopyPlus },
        { id: 'compare', label: t('dataTransfer.compare.menu'), icon: GitCompare },
        // Phase 3e-2: a view has no change stream of its own.
        ...(c.type !== 'view'
          ? [{ id: 'liveSync', label: t('liveSync.menu.collection'), icon: ArrowRightLeft }]
          : []),
      ]
    : []),
  ...(canDump.value && c.type !== 'view'
    ? [{ id: 'backupCollection', label: t('backup.menu.dumpCollection'), icon: HardDriveDownload }]
    : []),
  // W4.4: a backup restored into this collection (a one-collection backup goes into it by name).
  ...(canRestore.value && c.type !== 'view'
    ? [{ id: 'restoreHere', label: t('backup.menu.restoreHere'), icon: ArchiveRestore }]
    : []),
  ...(canWrite.value
    ? [
        // Menu sweep 2026-10-08: MongoDB cannot rename a view ("cannot rename view").
        ...(c.type !== 'view' ? [{ id: 'rename', label: t('menu.rename'), icon: Pencil }] : []),
        { id: 'duplicate', label: t('menu.duplicate'), icon: CopyPlus },
        { id: 'drop', label: t('menu.drop'), icon: Trash2, danger: true },
      ]
    : []),
]

const openDb = () => openDatabaseTab(tabs, props.connection.id, props.db)

function onDbSelect(id: string): void {
  if (id === 'open') openDb()
  else if (id === 'shell') openConnectionShell(tabs, props.connection, props.db)
  else if (id === 'pin') places.togglePin(databasePlace(props.connection.id, props.db))
  else if (id === 'copyName') void copyName(props.db, t)
  else if (id === 'newCollection')
    dialogs.open({ kind: 'createCollection', connectionId: props.connection.id, db: props.db })
  else if (id === 'refresh') void actions.refreshDatabase(props.connection.id, props.db)
  else if (id === 'drop') void actions.dropDatabase(props.connection.id, props.db)
  else if (id === 'copyDatabase' || id === 'compareDatabase')
    dialogs.open({
      kind: 'copyData',
      connectionId: props.connection.id,
      db: props.db,
      compare: id === 'compareDatabase',
    })
  else if (id === 'liveSyncDatabase')
    dialogs.open({ kind: 'liveSync', connectionId: props.connection.id, db: props.db })
  else if (id === 'backupDatabase')
    dialogs.open({ kind: 'backupDump', connectionId: props.connection.id, db: props.db })
  else if (id === 'restoreHere')
    dialogs.open({ kind: 'backupRestore', connectionId: props.connection.id, db: props.db })
  else if (id === 'importSql') dialogs.openImportSql(props.connection.id, props.db)
  else if (id === 'exportSql') dialogs.openExportSql(props.connection.id, props.db)
}

function onCollectionSelect(c: CollectionInfo, id: string): void {
  if (id === 'open') openCollectionTab(tabs, props.connection.id, props.db, c.name)
  else if (id === 'shell') openConnectionShell(tabs, props.connection, props.db)
  else if (id === 'pin') places.togglePin(collectionPlace(props.connection.id, props.db, c.name))
  else if (id === 'copyName') void copyName(c.name, t)
  else if (id === 'import' || id === 'export')
    dialogs.open({
      kind: id === 'import' ? 'importData' : 'exportData',
      connectionId: props.connection.id,
      db: props.db,
      coll: c.name,
    })
  else if (id === 'liveSync')
    dialogs.open({ kind: 'liveSync', connectionId: props.connection.id, db: props.db, coll: c.name })
  else if (id === 'backupCollection')
    dialogs.open({ kind: 'backupDump', connectionId: props.connection.id, db: props.db, coll: c.name })
  else if (id === 'restoreHere')
    dialogs.open({ kind: 'backupRestore', connectionId: props.connection.id, db: props.db, coll: c.name })
  else if (id === 'rename')
    dialogs.open({ kind: 'renameCollection', connectionId: props.connection.id, db: props.db, coll: c.name })
  else if (id === 'copy' || id === 'compare')
    dialogs.open({
      kind: 'copyData',
      connectionId: props.connection.id,
      db: props.db,
      coll: c.name,
      compare: id === 'compare',
    })
  else if (id === 'duplicate')
    dialogs.open({
      kind: 'duplicateCollection',
      connectionId: props.connection.id,
      db: props.db,
      coll: c.name,
    })
  else if (id === 'drop')
    void actions.dropCollection(props.connection.id, props.db, c.name, c.type === 'view')
}

const typeLabel = (type: string): string | undefined =>
  type === 'view' ? t('tree.types.view') : type === 'timeseries' ? t('tree.types.timeseries') : undefined
</script>

<template>
  <TreeRow
    :node-key="key"
    :label="db"
    :level="level"
    expandable
    :menu-items="dbMenu"
    :menu-label="t('menu.actions', { name: db })"
    :current="
      tabs.active?.kind === 'database' &&
      tabs.active.params.connectionId === connection.id &&
      tabs.active.params.db === db
    "
    @open="openDb"
    @select="onDbSelect"
  >
    <template #icon><Database class="size-4 shrink-0 text-fg-subtle" aria-hidden="true" /></template>
    <TreeStatus v-if="isPending" :level="level + 1" loading :text="t('tree.loading')" />
    <TreeStatus
      v-else-if="isError"
      :level="level + 1"
      error
      :text="describeError(error, t)"
      @retry="refetch()"
    />
    <TreeStatus v-else-if="data?.length === 0" :level="level + 1" :text="t('tree.noCollections')" />
    <TreeRow
      v-for="b in buckets"
      :key="`gridfs:${b}`"
      :node-key="treeKey('b', connection.id, db, b)"
      :label="b"
      :level="level + 1"
      :current="
        tabs.active?.kind === 'gridfs' &&
        tabs.active.params.connectionId === connection.id &&
        tabs.active.params.db === db &&
        tabs.active.params.bucket === b
      "
      @open="openGridFsTab(tabs, connection.id, db, b)"
    >
      <template #icon><FolderOpen class="size-4 shrink-0 text-fg-subtle" aria-hidden="true" /></template>
      <template #badges>
        <span class="text-caption text-fg-subtle">{{ t('gridfs.treeBadge') }}</span>
      </template>
    </TreeRow>
    <TreeRow
      v-for="c in collections"
      :key="c.name"
      :node-key="treeKey('k', connection.id, db, c.name)"
      :label="c.name"
      :level="level + 1"
      :menu-items="collectionMenu(c)"
      :menu-label="t('menu.actions', { name: c.name })"
      :current="
        tabs.active?.kind === 'collection' &&
        tabs.active.params.connectionId === connection.id &&
        tabs.active.params.db === db &&
        tabs.active.params.coll === c.name
      "
      @open="openCollectionTab(tabs, connection.id, db, c.name)"
      @select="onCollectionSelect(c, $event)"
    >
      <template #icon>
        <Eye v-if="c.type === 'view'" class="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
        <Clock
          v-else-if="c.type === 'timeseries'"
          class="size-4 shrink-0 text-fg-subtle"
          aria-hidden="true"
        />
        <Table v-else class="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
      </template>
      <template v-if="typeLabel(c.type)" #badges>
        <span class="text-caption text-fg-subtle">{{ typeLabel(c.type) }}</span>
      </template>
    </TreeRow>
  </TreeRow>
</template>
