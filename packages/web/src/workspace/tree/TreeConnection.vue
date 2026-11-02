<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import {
  ArchiveRestore,
  Copy,
  HardDriveDownload,
  Lock,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Server,
  SquareTerminal,
  Star,
  Trash2,
} from 'lucide-vue-next'
import { connectionsApi, queryKeys, type ConnectionDto } from '@/api/connections'
import { describeError } from '@/api/errors'
import type { DsMenuItem as MenuItem } from '@/ds/menu'
import { treeKey, useTreeStore } from '@/stores/tree'
import { useTabsStore } from '@/stores/tabs'
import { useSessionStore } from '@/stores/session'
import { useWorkspaceDialogs } from '@/stores/workspaceDialogs'
import { useConnectionActions } from '@/connections/actions'
import { COLOR_CLASSES } from '@/connections/colors'
import { useConnected, useLastUnreachable } from '@/connections/reachability'
import { openConnectionShell, openConnectionTab } from '../openTabs'
import { Pin, PinOff } from 'lucide-vue-next'
import { connectionPlace, usePlacesStore } from '@/stores/places'
import TreeRow from './TreeRow.vue'
import TreeStatus from './TreeStatus.vue'
import TreeDatabase from './TreeDatabase.vue'

const props = defineProps<{ connection: ConnectionDto; level: number }>()
const { t } = useI18n()
const tree = useTreeStore()
const tabs = useTabsStore()
const places = usePlacesStore()
const session = useSessionStore()
const dialogs = useWorkspaceDialogs()
const actions = useConnectionActions()

const key = computed(() => treeKey('c', props.connection.id))
const canManage = computed(() => session.can('connections:manage'))
const canWrite = computed(() => props.connection.permissions.includes('databases:write'))
// Phase 3d-3a: a dump reads the data out as an export does; a restore writes documents.
const canDump = computed(
  () => Boolean(props.connection.export) && props.connection.permissions.includes('jobs:run'),
)
const canRestore = computed(
  () =>
    props.connection.permissions.includes('documents:write') &&
    props.connection.permissions.includes('jobs:run'),
)
const { data, isPending, isError, error, refetch } = useQuery({
  queryKey: computed(() => queryKeys.databases(props.connection.id)),
  queryFn: () => connectionsApi.databases(props.connection.id),
  enabled: computed(() => tree.isExpanded(key.value)),
})
/**
 * User report 2026-10-23: what needs the server (a new database, a backup, a restore, the shell) is
 * offered only while connected to it (reachability.ts): as Compass, a connection not connected
 * (nothing read yet, connecting, or out of reach) offers only what needs no server.
 */
const connected = useConnected(() => props.connection.id)
// Third review (I2): while a read runs again, the last "cannot be reached" stays, with Retry.
const lastUnreachable = useLastUnreachable(() => props.connection.id)
const shownError = computed(() => (isError.value ? error.value : lastUnreachable.value))

const menuItems = computed<MenuItem[]>(() => [
  { id: 'open', label: t('menu.open') },
  {
    id: 'pin',
    label: places.isPinned(connectionPlace(props.connection).key) ? t('layout.unpin') : t('layout.pin'),
    icon: places.isPinned(connectionPlace(props.connection).key) ? PinOff : Pin,
  },
  ...(canManage.value
    ? [
        { id: 'edit', label: t('menu.edit'), icon: Pencil },
        { id: 'duplicate', label: t('menu.duplicate'), icon: Copy },
      ]
    : []),
  { id: 'test', label: t('menu.test'), icon: PlugZap },
  // User request 2026-10-11: the shell, where people look for it.
  ...(connected.value && props.connection.shell
    ? [{ id: 'shell', label: t('menu.openShell'), icon: SquareTerminal }]
    : []),
  ...(canManage.value
    ? [
        {
          id: 'favorite',
          label: props.connection.favorite ? t('menu.unfavorite') : t('menu.favorite'),
          icon: Star,
        },
      ]
    : []),
  ...(connected.value && canWrite.value
    ? [{ id: 'newDatabase', label: t('menu.newDatabase'), icon: Plus }]
    : []),
  { id: 'refresh', label: t('menu.refresh'), icon: RefreshCw },
  ...(connected.value && canDump.value
    ? [{ id: 'backupServer', label: t('backup.menu.dumpServer'), icon: HardDriveDownload }]
    : []),
  ...(connected.value && canRestore.value
    ? [{ id: 'restore', label: t('backup.menu.restore'), icon: ArchiveRestore }]
    : []),
  ...(canManage.value ? [{ id: 'delete', label: t('menu.delete'), icon: Trash2, danger: true }] : []),
])

const open = () => openConnectionTab(tabs, props.connection)

function onSelect(id: string): void {
  const c = props.connection
  if (id === 'open') open()
  else if (id === 'pin') places.togglePin(connectionPlace(c))
  else if (id === 'edit') dialogs.open({ kind: 'connection', connection: c })
  else if (id === 'duplicate') dialogs.open({ kind: 'connection', connection: c, duplicate: true })
  else if (id === 'test') void actions.testSaved(c)
  else if (id === 'shell') openConnectionShell(tabs, c)
  else if (id === 'favorite') void actions.toggleFavorite(c)
  else if (id === 'newDatabase') dialogs.open({ kind: 'createDatabase', connectionId: c.id })
  else if (id === 'refresh') void actions.refreshConnection(c.id)
  else if (id === 'delete') void actions.deleteConnection(c)
  else if (id === 'backupServer') dialogs.open({ kind: 'backupDump', connectionId: c.id })
  else if (id === 'restore') dialogs.open({ kind: 'backupRestore', connectionId: c.id })
}
</script>

<template>
  <TreeRow
    :node-key="key"
    :label="connection.name"
    :level="level"
    expandable
    :menu-items="menuItems"
    :menu-label="t('menu.actions', { name: connection.name })"
    test-id="connection"
    :current="tabs.active?.kind === 'connection' && tabs.active.params.connectionId === connection.id"
    @open="open"
    @select="onSelect"
  >
    <template #icon>
      <span
        class="size-2 shrink-0 rounded-full"
        :class="connection.color ? COLOR_CLASSES[connection.color] : 'bg-transparent'"
        aria-hidden="true"
      />
      <Server class="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
    </template>
    <template #badges>
      <Lock v-if="connection.readOnly" class="size-3.5 text-fg-subtle" :aria-label="t('header.readOnly')" />
      <Star v-if="connection.favorite" class="size-3.5 fill-warning text-warning" aria-hidden="true" />
    </template>
    <TreeStatus v-if="isPending && !shownError" :level="level + 1" loading :text="t('tree.loading')" />
    <TreeStatus
      v-else-if="shownError"
      :level="level + 1"
      error
      :text="describeError(shownError, t)"
      @retry="refetch()"
    />
    <TreeStatus v-else-if="data?.databases.length === 0" :level="level + 1" :text="t('tree.noDatabases')" />
    <TreeDatabase
      v-for="d in (connected && data?.databases) || []"
      :key="d.name"
      :connection="connection"
      :db="d.name"
      :level="level + 1"
    />
  </TreeRow>
</template>
