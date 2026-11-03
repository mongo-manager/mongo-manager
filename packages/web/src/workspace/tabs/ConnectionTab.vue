<script setup lang="ts">
import { MIN_MONGODB_VERSION } from '@mongo-manager/shared/browser'
import { computed, defineAsyncComponent, watch, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMutation, useQuery } from '@tanstack/vue-query'
import {
  Copy,
  Database,
  HardDriveDownload,
  Pencil,
  PlugZap,
  Plus,
  RotateCw,
  Server,
  SquareTerminal,
  Trash2,
} from 'lucide-vue-next'
import { copyName } from '../copyName'
import { BACKUP_SYSTEM_DATABASES } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsBadge from '@/ds/DsBadge.vue'
import DsStatusDot from '@/ds/DsStatusDot.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsCard from '@/ds/DsCard.vue'
import DsDataTable from '@/ds/DsDataTable.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsMenu from '@/ds/DsMenu.vue'
import DsPageHeader from '@/ds/DsPageHeader.vue'
import DsTabs from '@/ds/DsTabs.vue'
import type { DsMenuItem } from '@/ds/menu'
import type { DsColumn } from '@/ds/table'
import { connectionsApi, queryKeys, type TestResult } from '@/api/connections'
import { describeError } from '@/api/errors'
import { formatBytes } from '@/format'
import { COLOR_CLASSES } from '@/connections/colors'
import TestResultView from '@/connections/TestResultView.vue'
import { useSessionStore } from '@/stores/session'
import { useTabsStore } from '@/stores/tabs'
import { useToastStore } from '@/stores/toasts'
import { useWorkspaceDialogs } from '@/stores/workspaceDialogs'
import { useConnectionActions } from '@/connections/actions'
import { useConnectionCapabilities } from '@/connections/capabilities'
import { isLoopback, unreachableKind } from '@/connections/dockerHost'
import { rereadWhileUnreachable, useConnected, useLastUnreachable } from '@/connections/reachability'
import { openConnectionShell, openDatabaseTab, shellDatabaseOf } from '../openTabs'
import AccessCard from './AccessCard.vue'
import OidcCard from '@/connections/OidcCard.vue'
import PersonalDataCard from './PersonalDataCard.vue'
import BackupsCard from '@/backup/BackupsCard.vue'
import DrillLeftovers from '@/backup/DrillLeftovers.vue'
import PerformanceView from '@/monitor/PerformanceView.vue'
import HistoryControls from '@/monitor/HistoryControls.vue'
import type { HistoryRange } from '@/api/server'
import { useTabSectionsStore } from '@/stores/tabSections'
import { alertKeys, alertsApi } from '@/api/alerts'
import { backupApi } from '@/api/backup'

const WatchView = defineAsyncComponent(() => import('@/watch/WatchView.vue'))
// W3: MongoDB's users and roles, sharding management, alerts.
const DatabaseAccessView = defineAsyncComponent(() => import('@/dbaccess/DatabaseAccessView.vue'))
const ShardingAdminView = defineAsyncComponent(() => import('@/monitor/ShardingAdminView.vue'))
const ConnectionAlertsView = defineAsyncComponent(() => import('@/alerts/ConnectionAlertsView.vue'))
// W8: client-side encryption's data keys and encrypted collections.
const EncryptionView = defineAsyncComponent(() => import('@/encryption/EncryptionView.vue'))

const props = defineProps<{ connectionId: string; tabId?: string }>()
const { t, locale } = useI18n()
const session = useSessionStore()
const tabs = useTabsStore()
const toasts = useToastStore()
const dialogs = useWorkspaceDialogs()
const actions = useConnectionActions()

const { data: connections } = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
const connection = computed(() => connections.value?.find((c) => c.id === props.connectionId))
/** User request 2026-10-11: the database its shell opens on (the address's, else test). */
const shellDb = computed(() => shellDatabaseOf(connection.value?.uri ?? ''))
const canWrite = computed(() => connection.value?.permissions.includes('databases:write') ?? false)
// Phase 1i: the Performance section, for those who may watch this connection's server.
const canMonitor = computed(() => connection.value?.permissions.includes('server:monitor') ?? false)
const canOperate = computed(() => connection.value?.permissions.includes('server:operations') ?? false)
// Phase 3e-1: Watch after Performance, for those who may read documents; kept with the tab.
// W3: Users & roles (databases:admin, never for a user whose personal data is hidden), Sharding (a
// mongos), Alerts (administrators of the app).
type Section =
  | 'overview'
  | 'performance'
  | 'watch'
  | 'databaseAccess'
  | 'encryption'
  | 'sharding'
  | 'alerts'
  | 'backups'
  | 'personalData'
const tabSections = useTabSectionsStore()
const stateKey = computed(() => props.tabId ?? `connection:${props.connectionId}`)
const canWatch = computed(() => connection.value?.permissions.includes('documents:read') ?? false)
const canAdminDb = computed(
  () => (connection.value?.permissions.includes('databases:admin') ?? false) && !connection.value?.restricted,
)
/**
 * User report 2026-10-30: MongoDB's users and roles are kept only from one an administrator hides
 * personal data from — not from one who hides it from themselves (an older server: as before).
 */
const canManageAccounts = computed(
  () =>
    (connection.value?.permissions.includes('databases:admin') ?? false) &&
    !(connection.value?.accountsRestricted ?? connection.value?.restricted),
)
// W3.4: the connection's live health (ping, version, topology, alerts firing), cached by the server.
const health = useQuery({
  queryKey: computed(() => alertKeys.healthOf(props.connectionId)),
  queryFn: () => alertsApi.healthOf(props.connectionId),
  refetchInterval: 30_000,
  retry: false,
})
const sharded = computed(() => health.data.value?.topology === 'sharded')
const { data, isPending, isError, error, refetch } = useQuery({
  queryKey: computed(() => queryKeys.databases(props.connectionId)),
  queryFn: () => connectionsApi.databases(props.connectionId),
  refetchInterval: rereadWhileUnreachable,
})
/**
 * User reports 2026-10-23: what needs the server (its sections, backups, a new database, the shell)
 * is shown only while connected to it (reachability.ts): neither while connecting nor while it
 * cannot be reached. The overview stays, with the error, Retry and Edit.
 */
const connected = useConnected(() => props.connectionId)
// Third review (I2): while a read runs again, the last "cannot be reached" stays, with Retry and Edit.
const lastUnreachable = useLastUnreachable(() => props.connectionId)
const shownError = computed(() => (isError.value ? error.value : lastUnreachable.value))
const canBackUp = computed(
  () =>
    (connection.value?.permissions.includes('jobs:run') ?? false) &&
    Boolean(connection.value?.export || connection.value?.permissions.includes('documents:write')),
)
// User request 2026-10-23: the connection's personal-data rules, for its administrators.
const canManage = computed(() => connection.value?.permissions.includes('connections:manage') ?? false)
// The same query as DrillLeftovers': read for the tab only where it alone would show it.
const leftovers = useQuery({
  queryKey: computed(() => ['backup', 'drill-leftovers', props.connectionId]),
  queryFn: () => backupApi.drillLeftovers(props.connectionId),
  enabled: computed(() => connected.value && canManage.value && !canBackUp.value),
})
const sectionsOfServer = computed<Section[]>(() => [
  ...(canMonitor.value ? (['performance'] as const) : []),
  ...(canWatch.value ? (['watch'] as const) : []),
  ...(canManageAccounts.value ? (['databaseAccess'] as const) : []),
  // W8: where the connection has client-side encryption, for its administrators.
  ...(canAdminDb.value && connection.value?.settings?.encryption?.enabled ? (['encryption'] as const) : []),
  ...(sharded.value && (canMonitor.value || canAdminDb.value) ? (['sharding'] as const) : []),
  ...(session.can('settings:manage') ? (['alerts'] as const) : []),
  // User request 2026-10-23: Backups and Personal data are tabs beside these, no longer on the overview.
  // A drill's leftovers are its administrators', whether or not they may back up (review of the
  // tabs, M7): for those who may not, the tab is there while there are some (final review).
  ...(canBackUp.value || (canManage.value && (leftovers.data.value?.databases.length ?? 0) > 0)
    ? (['backups'] as const)
    : []),
  ...(canManage.value ? (['personalData'] as const) : []),
])
const SECTIONS = computed<Section[]>(() => ['overview', ...(connected.value ? sectionsOfServer.value : [])])
const section = computed<Section>({
  get: () => {
    const s = tabSections.get(stateKey.value, 'overview') as Section
    return SECTIONS.value.includes(s) ? s : 'overview'
  },
  set: (s) => tabSections.set(stateKey.value, s),
})
// Design 2026-10-25 (B7; review M6): the section shown, for the assistant's focus.
watch(section, (s) => tabSections.setValue(stateKey.value, 'shown', s), { immediate: true })
// UI redesign R3 §4: Performance's time span is chosen in this header, and kept while the tab lives.
const RANGES = ['live', '1h', '24h', '7d'] as const
const performanceRange = computed<'live' | HistoryRange>({
  get: () => {
    const r = tabSections.getValue(stateKey.value, 'range', 'live')
    return (RANGES as readonly string[]).includes(r) ? (r as 'live' | HistoryRange) : 'live'
  },
  set: (r) => tabSections.setValue(stateKey.value, 'range', r),
})
const ids = useId()
const sectionTabId = (s: Section) => `${ids}-${s}`
const panelId = `${ids}-panel`
// UI redesign R3 §4: the sections as the kit's tabs (arrow keys, Home and End are theirs).
const sectionTabs = computed(() =>
  SECTIONS.value.map((s) => ({ value: s, label: t(`performance.sections.${s}`) })),
)

// UI redesign R3 §4: the connection's header — one primary action, the rest in "…".
const facts = computed(() => {
  const h = health.data.value
  return [
    ...(h?.state === 'ok' && h.version ? [t('health.version', { version: h.version })] : []),
    ...(h?.state === 'ok' && h.topology ? [t(`connection.topology.${h.topology}`)] : []),
    // No total when a database's size is hidden: it would tell that size.
    ...(connected.value && data.value && data.value.totalSize !== null
      ? [t('overview.totalSize', { size: formatBytes(data.value.totalSize, locale.value) })]
      : []),
  ]
})
const healthDot = computed(() => {
  const state = health.data.value?.state
  return state === 'ok'
    ? 'connected'
    : state === 'down'
      ? 'error'
      : state === 'idle' || state === 'per_person'
        ? 'idle'
        : 'connecting'
})
const healthText = computed(() => {
  const h = health.data.value
  if (!h) return t('health.checking')
  if (h.state === 'ok') return t('health.ok', { ms: h.latencyMs ?? 0 })
  if (h.state === 'per_person') return t('health.perPerson')
  return h.state === 'down' ? t('health.down') : t('health.idle')
})
const headerMenu = computed<DsMenuItem[]>(() => [
  // One test at a time (review of R3: the old button was busy while it ran).
  { id: 'test', label: t('menu.test'), icon: PlugZap, disabled: testing.value },
  ...(connection.value && session.can('connections:manage')
    ? [{ id: 'edit', label: t('menu.edit'), icon: Pencil }]
    : []),
  ...(connected.value && canBackUp.value && connection.value?.export
    ? [{ id: 'backup', label: t('backup.menu.dumpServer'), icon: HardDriveDownload }]
    : []),
  { id: 'refresh', label: t('menu.refresh'), icon: RotateCw },
])
function onHeaderMenu(id: string): void {
  if (id === 'test') test()
  else if (id === 'edit' && connection.value)
    dialogs.open({ kind: 'connection', connection: connection.value })
  else if (id === 'backup') dialogs.open({ kind: 'backupDump', connectionId: props.connectionId })
  // The same refresh as the tree's: the databases and everything read under them.
  else if (id === 'refresh') void actions.refreshConnection(props.connectionId)
}
// Review of R3 (I-3): each database's own menu — open it, back it up, drop it — as the tree offers.
const rowMenu = (d: DatabaseRow): DsMenuItem[] => [
  { id: 'open', label: t('database.openCollection'), icon: Database },
  // W1 (completion §2): the plain name, as typed in a query or the shell.
  { id: 'copyName', label: t('explorer.copyName.action'), icon: Copy },
  ...(canBackUp.value && connection.value?.export && !BACKUP_SYSTEM_DATABASES.includes(d.name)
    ? [{ id: 'backup', label: t('backup.menu.dumpDatabase'), icon: HardDriveDownload }]
    : []),
  ...(canWrite.value ? [{ id: 'drop', label: t('database.drop'), icon: Trash2, danger: true }] : []),
]
function onRowMenu(d: DatabaseRow, id: string): void {
  if (id === 'open') openDatabaseTab(tabs, props.connectionId, d.name)
  else if (id === 'copyName') void copyName(d.name, t)
  else if (id === 'backup') dialogs.open({ kind: 'backupDump', connectionId: props.connectionId, db: d.name })
  else if (id === 'drop') void actions.dropDatabase(props.connectionId, d.name)
}
const columns = computed<DsColumn[]>(() => [
  { key: 'name', label: t('overview.name') },
  { key: 'size', label: t('overview.size'), align: 'right', width: '9rem' },
])
type DatabaseRow = { name: string; sizeOnDisk: number | null; empty: boolean }

const testResult = ref<TestResult | null>(null)
/**
 * User report 2026-11-02: in Docker, localhost is Mongo Manager's own container. A failure to reach
 * such a connection says so (the server's offer asked only then), and opens it to change the host.
 */
const loopbackFailed = computed(
  () =>
    (connection.value?.settings?.hosts ?? []).some((h) => isLoopback(h.host)) &&
    (unreachableKind((shownError.value as { details?: { kind?: unknown } } | null)?.details?.kind) ||
      (testResult.value?.ok === false && unreachableKind(testResult.value.error.kind))),
)
const capabilities = useConnectionCapabilities(loopbackFailed)
const dockerLoopback = computed(
  () => loopbackFailed.value && capabilities.data.value?.distribution === 'docker',
)
const announcement = computed(() => {
  if (testing.value) return t('overview.testing')
  const r = testResult.value
  if (!r) return ''
  return r.ok
    ? t('connection.testOk', {
        version: r.serverVersion,
        topology: t(`connection.topology.${r.topology}`),
        ms: r.latencyMs,
      })
    : `${t(`mongo.kinds.${r.error.kind}`, { min: MIN_MONGODB_VERSION })} ${r.error.message}`
})
const { mutate: test, isPending: testing } = useMutation({
  mutationFn: () => connectionsApi.testSaved(props.connectionId),
  onSuccess: (result) => {
    testResult.value = result
    // A server that answers again is read again, so what needs it is offered (user report 2026-10-23).
    if (result.ok && isError.value) void refetch()
  },
  onError: (e) => toasts.push({ kind: 'error', message: describeError(e, t) }),
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <!-- Review of R3–R5, minor 3: there before a test starts, so its start and its end are heard. -->
    <p class="sr-only" role="status" aria-live="polite">{{ announcement }}</p>
    <DsPageHeader
      :title="connection?.name ?? ''"
      :context="connection?.uri"
      :context-title="connection?.uri"
      :facts="facts"
    >
      <template #icon>
        <span
          class="relative mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-fg"
          aria-hidden="true"
        >
          <Server class="size-[18px]" />
          <span
            v-if="connection?.color"
            class="absolute -right-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-surface"
            :class="COLOR_CLASSES[connection.color]"
          />
        </span>
      </template>
      <template #badges>
        <DsBadge v-if="connection">{{
          t('overview.access', { role: t(`overview.roles.${connection.access}`) })
        }}</DsBadge>
        <DsBadge v-if="connection?.readOnly" tone="warning">{{ t('header.readOnly') }}</DsBadge>
        <span class="inline-flex items-center gap-1.5 text-small text-fg-muted" data-health>
          <DsStatusDot :state="healthDot" :label="healthText" /><span aria-hidden="true">{{
            healthText
          }}</span>
        </span>
        <DsBadge v-if="health.data.value?.alertsFiring" tone="danger" data-alerts-firing>{{
          t('alerts.firingCount', { count: health.data.value.alertsFiring }, health.data.value.alertsFiring)
        }}</DsBadge>
      </template>
      <template #actions>
        <HistoryControls
          v-if="canMonitor && section === 'performance'"
          v-model:range="performanceRange"
          :connection-id="connectionId"
          :can-operate="canOperate"
        />
        <!-- User request 2026-10-11: the shell beside the sections; its own page, kept while open. -->
        <DsButton
          v-if="connected && connection?.shell"
          data-open-shell
          size="sm"
          :icon="SquareTerminal"
          :title="t('shell.openOn', { db: shellDb })"
          @click="connection && openConnectionShell(tabs, connection)"
        >
          {{ t('shell.section') }}
        </DsButton>
        <DsButton
          v-if="connected && canWrite"
          size="sm"
          variant="primary"
          :icon="Plus"
          @click="dialogs.open({ kind: 'createDatabase', connectionId })"
        >
          {{ t('menu.newDatabase') }}
        </DsButton>
        <DsMenu
          :label="t('overview.connectionMore', { name: connection?.name ?? '' })"
          :items="headerMenu"
          focusable
          size="header"
          @select="onHeaderMenu"
        />
      </template>
      <template v-if="SECTIONS.length > 1" #tabs>
        <DsTabs
          v-model="section"
          :label="t('performance.sections.label')"
          :tabs="sectionTabs"
          :id-prefix="ids"
          :panel-id="panelId"
        />
      </template>
    </DsPageHeader>
    <div
      :id="panelId"
      :role="SECTIONS.length > 1 ? 'tabpanel' : undefined"
      :aria-labelledby="SECTIONS.length > 1 ? sectionTabId(section) : undefined"
      class="flex min-h-0 flex-1 flex-col overflow-auto"
    >
      <DatabaseAccessView
        v-if="section === 'databaseAccess' && canManageAccounts"
        :connection-id="connectionId"
        :read-only="connection?.readOnly ?? false"
      />
      <EncryptionView
        v-else-if="section === 'encryption' && canAdminDb"
        :connection-id="connectionId"
        :read-only="connection?.readOnly ?? false"
      />
      <ShardingAdminView
        v-else-if="section === 'sharding'"
        :connection-id="connectionId"
        :can-manage="canAdminDb"
        :read-only="connection?.readOnly ?? false"
      />
      <ConnectionAlertsView
        v-else-if="section === 'alerts'"
        :connection-id="connectionId"
        :connection-name="connection?.name ?? ''"
      />
      <WatchView
        v-else-if="section === 'watch'"
        :target="{ connectionId, scope: 'deployment' }"
        :can-export="connection?.export ?? false"
      />
      <!-- User request 2026-10-23: the connection's backups, and the way to take or restore one. -->
      <section v-else-if="section === 'backups'" class="flex max-w-6xl flex-col gap-4 p-4">
        <BackupsCard v-if="canBackUp" :connection-id="connectionId" />
        <!-- W4 re-review (minor): a drill's scratch database left behind, for the connection's admins. -->
        <DrillLeftovers v-if="canManage" :connection-id="connectionId" />
      </section>
      <!-- Phase 3b: personal-data rules, for the connection's admins. User request 2026-10-13: in local
           mode too — they hide the values from the local user as well. -->
      <section v-else-if="section === 'personalData' && connection" class="flex max-w-6xl flex-col gap-4 p-4">
        <PersonalDataCard :connection="connection" />
      </section>
      <PerformanceView
        v-else-if="canMonitor && section === 'performance'"
        :connection-id="connectionId"
        :can-operate="canOperate"
        :read-only="connection?.readOnly ?? false"
        :restricted="connection?.restricted ?? false"
        :can-create-indexes="connection?.permissions.includes('indexes:write') ?? false"
        :range="performanceRange"
      />
      <section v-else class="flex max-w-6xl flex-col gap-4 p-4">
        <div v-if="testing || testResult" class="flex flex-col gap-2">
          <DsCallout v-if="testing" tone="info">{{ t('overview.testing') }}</DsCallout>
          <TestResultView v-else-if="testResult" :result="testResult" :announce="false" />
        </div>
        <DsCallout v-if="dockerLoopback && connection" tone="warning" data-docker-localhost>
          <span class="flex flex-col items-start gap-2">
            {{ t('connection.dockerLocalhost') }}
            <DsButton
              v-if="session.can('connections:manage')"
              size="sm"
              @click="dialogs.open({ kind: 'connection', connection })"
            >
              {{ t('connection.edit') }}
            </DsButton>
          </span>
        </DsCallout>
        <DsCard :title="t('overview.databases')" :count="data?.databases.length">
          <DsDataTable
            :label="t('overview.databases')"
            :error="shownError ? describeError(shownError, t) : undefined"
            :actions-label="t('documents.actionsColumn')"
            :columns="columns"
            :rows="data?.databases ?? []"
            :loading-label="t('app.loading')"
            :row-key="(d: DatabaseRow) => d.name"
            :loading="isPending && !shownError"
          >
            <template #cell-name="{ row: d }">
              <button
                type="button"
                class="inline-flex max-w-full cursor-pointer items-center gap-2 rounded-md text-left text-fg hover:text-accent-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
                @click="openDatabaseTab(tabs, connectionId, d.name)"
              >
                <Database class="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
                <span class="truncate">{{ d.name }}</span>
              </button>
              <DsBadge v-if="d.empty" class="ml-2">{{ t('overview.emptyBadge') }}</DsBadge>
            </template>
            <template #cell-size="{ row: d }">
              <span class="text-fg-muted">{{
                d.sizeOnDisk === null ? t('overview.stats.hidden') : formatBytes(d.sizeOnDisk, locale)
              }}</span>
            </template>
            <template #retry>
              <DsButton size="sm" :icon="RotateCw" @click="refetch()">{{ t('common.retry') }}</DsButton>
              <!-- Review of the short connection form (2026-10-16): a wrong string is fixed from here. -->
              <DsButton
                v-if="connection && session.can('connections:manage')"
                size="sm"
                :icon="Pencil"
                data-edit-connection
                @click="dialogs.open({ kind: 'connection', connection })"
                >{{ t('connection.edit') }}</DsButton
              >
            </template>
            <template #actions="{ row: d }">
              <DsMenu
                focusable
                touch
                :label="t('database.actionsFor', { name: d.name })"
                :items="rowMenu(d)"
                @select="onRowMenu(d, $event)"
              />
            </template>
            <template #empty>
              <DsEmptyState
                :icon="Database"
                :title="t('overview.noDatabasesTitle')"
                :description="t('overview.noDatabases')"
              >
                <template v-if="canWrite" #actions>
                  <DsButton
                    variant="primary"
                    :icon="Plus"
                    @click="dialogs.open({ kind: 'createDatabase', connectionId })"
                  >
                    {{ t('menu.newDatabase') }}
                  </DsButton>
                </template>
              </DsEmptyState>
            </template>
          </DsDataTable>
        </DsCard>
        <!-- W7: this person's OIDC sign-in on the connection (and, for its administrators, everyone's). -->
        <OidcCard
          v-if="
            connection?.settings?.auth?.mechanism === 'MONGODB-OIDC' &&
            !connection.settings.auth.oidc?.environment
          "
          :connection="connection"
        />
        <AccessCard
          v-if="connection && session.status?.mode === 'team' && session.can('users:manage')"
          :connection="connection"
        />
      </section>
    </div>
  </div>
</template>
