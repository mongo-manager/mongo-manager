<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { ArrowLeftRight, Database, Download, Puzzle, Server, Upload } from 'lucide-vue-next'
import { BACKUP_SYSTEM_DATABASES, DatabaseNameSchema } from '@mongo-manager/shared/browser'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import DsBadge from '@/ds/DsBadge.vue'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsSelect from '@/ds/DsSelect.vue'
import DsInput from '@/ds/DsInput.vue'
import DsPageHeader from '@/ds/DsPageHeader.vue'
import DsTabs from '@/ds/DsTabs.vue'
import { connectionsApi, queryKeys, type DatabaseList } from '@/api/connections'
import { describeError } from '@/api/errors'
import { useDialogStore } from '@/stores/dialogs'
import { usePlacesStore } from '@/stores/places'
import { useSessionStore } from '@/stores/session'
import { usePluginsStore } from '@/plugins/store'
import { useTabsStore } from '@/stores/tabs'
import { useTabWorkStore } from '@/stores/tabWork'
import { useWorkspaceDialogs } from '@/stores/workspaceDialogs'
import SqlExportPanel from './SqlExportPanel.vue'
import SqlImportPanel from './SqlImportPanel.vue'
import { useSplitView } from '@/workspace/split'

/**
 * User requests 2026-10-11: SQL ↔ MongoDB, a page of its own for SQL import and export — never a
 * query. Where it works is always in sight (the connection and its one database, in its address too):
 * a dump's tables into collections, or collections out as one file.
 * Kept while its tab is open: an upload being prepared or a job running is not lost on a glance away.
 */
type Part = 'import' | 'export'
const props = defineProps<{
  tabId?: string
  part?: string
  connectionId?: string
  db?: string
  coll?: string
}>()
const { t } = useI18n()
// Its own ids: the page stays open per tab, so two copies may be in the page (review minor 15).
const uid = useId()
const tabs = useTabsStore()
const places = usePlacesStore()
const session = useSessionStore()
const plugins = usePluginsStore()
const dialogs = useDialogStore()
const workspaceDialogs = useWorkspaceDialogs()
const work = useTabWorkStore()
/** The page in sight: its tab on screen (a kept page stays mounted behind others; W6.1: or in a pane). */
const split = useSplitView()
const visible = computed(() => !props.tabId || split.shown(props.tabId))

const connections = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
const list = computed(() => connections.data.value ?? [])
const part = computed<Part>(() => (props.part === 'export' ? 'export' : 'import'))
/** The export part, mounted once seen and kept then (a running export's progress stays). */
const exportSeen = ref(part.value === 'export')
watch(part, (p) => {
  if (p === 'export') exportSeen.value = true
})

/** The connection: the address's, else the last one worked in, else the first. */
const connectionId = computed(() => {
  const ids = new Set(list.value.map((c) => c.id))
  if (props.connectionId && ids.has(props.connectionId)) return props.connectionId
  const recent = places.recent.find((p) => ids.has(p.params.connectionId ?? ''))
  return recent?.params.connectionId ?? list.value[0]?.id ?? null
})
const connection = computed(() => list.value.find((c) => c.id === connectionId.value) ?? null)

const databases = useQuery({
  queryKey: computed(() => queryKeys.databases(connectionId.value ?? '')),
  queryFn: () => connectionsApi.databases(connectionId.value!),
  enabled: computed(() => connectionId.value !== null),
})
/**
 * The connection's own list, read by its key: right after another connection is chosen, the query's
 * data is still the one before for a moment, and a database judged against it went elsewhere.
 */
const queryClient = useQueryClient()
const listed = computed(() => {
  void databases.data.value
  return connectionId.value
    ? (queryClient.getQueryData<DatabaseList>(queryKeys.databases(connectionId.value)) ?? null)
    : null
})
const names = computed(() => (listed.value?.databases ?? []).map((d) => d.name))
/** The databases one may export: never a system one. */
const userNames = computed(() => names.value.filter((n) => !BACKUP_SYSTEM_DATABASES.includes(n)))

/** A database typed for an import (it is created by the import); an import's only. */
const NEW = '\u0000new'
const typed = ref('')
const typing = ref(false)
const typedError = computed(() => {
  const name = typed.value.trim()
  if (!name) return t('sqlTransfer.target.newRequired')
  if (!DatabaseNameSchema.safeParse(name).success || BACKUP_SYSTEM_DATABASES.includes(name))
    return t('sqlTransfer.target.newInvalid')
  // MongoDB refuses a database whose name differs from another's by case only.
  const twin = names.value.find((n) => n !== name && n.toLowerCase() === name.toLowerCase())
  return twin ? t('sqlTransfer.target.newCase', { name: twin }) : null
})
/** The database: the address's, else the last one worked in here, else the first not a system one. */
const db = computed<string | null>(() => {
  if (typing.value && part.value === 'import') return typedError.value ? null : typed.value.trim()
  // A system database is never exported (review 2026-10-11): an export asked for one works elsewhere.
  const usable = !!props.db && !(part.value === 'export' && BACKUP_SYSTEM_DATABASES.includes(props.db))
  if (usable && (names.value.includes(props.db!) || !listed.value)) return props.db!
  // The last place worked in, else the first database: an export's never a system one (review I1).
  const choices = part.value === 'export' ? userNames.value : names.value
  const recent = places.recent.find(
    (p) => p.params.connectionId === connectionId.value && choices.includes(p.params.db ?? ''),
  )
  return (
    recent?.params.db ?? userNames.value[0] ?? (part.value === 'export' ? null : (names.value[0] ?? null))
  )
})
/**
 * What an export reads: one database, never a system one (user request 2026-10-12: one database at
 * a time, for an import and an export alike).
 */
const exportDb = computed(() => (db.value && !BACKUP_SYSTEM_DATABASES.includes(db.value) ? db.value : null))

/**
 * What is chosen is kept in the tab's address (and so shown, reloaded, shared); a collection given
 * by whoever opened the page is kept only until the place or the part changes (review 2026-10-11).
 */
function show(view: {
  part?: Part
  connectionId?: string | null
  db?: string | null
  keepColl?: boolean
}): void {
  if (!props.tabId) return
  tabs.setView(props.tabId, {
    part: view.part ?? part.value,
    connectionId: view.connectionId === undefined ? connectionId.value : view.connectionId,
    // While a new name is typed, the address keeps the database it was on (review 2026-10-11).
    db: view.db === undefined ? (typing.value ? (props.db ?? null) : db.value) : view.db,
    coll: view.keepColl ? (props.coll ?? null) : null,
  })
}
watch(
  [connectionId, () => (typing.value ? null : db.value)],
  ([c, d]) => {
    if (c && (c !== props.connectionId || (d && d !== props.db)))
      show({ connectionId: c, db: d, keepColl: true })
  },
  { immediate: true },
)
/**
 * Work the import would lose (a file read, an import running): another connection asks first, however
 * it was asked for — this page's choice, the tree, the palette, a plugin, the browser's Back (review
 * 2026-10-11). Declined, the page goes back to where it was. The import panel is the connection's.
 */
const importWork = ref(false)
watch(importWork, (busy) => props.tabId && work.set(props.tabId, busy))
onBeforeUnmount(() => props.tabId && work.set(props.tabId, false))
const importConnection = ref<string | null>(null)
/** Where the page was while on the import's connection: what a declined change goes back to. */
let lastPlace: Record<string, string | null> | null = null
watch(
  () => [props.part, props.connectionId, props.db] as const,
  ([p, c, d]) => {
    if (c && c === importConnection.value) lastPlace = { part: p ?? null, connectionId: c, db: d ?? null }
  },
  { immediate: true },
)
let asking = false
/** Set while the page puts its place back: not a change asked from outside. */
let restoring = false
watch(
  connectionId,
  async (next) => {
    if (!next || next === importConnection.value) return
    if (!importConnection.value || !importWork.value) {
      importConnection.value = next
      lastPlace = { part: props.part ?? null, connectionId: next, db: props.db ?? null }
      return
    }
    if (asking) return
    asking = true
    const leave = await dialogs.confirm({
      title: t('sqlTransfer.leave.title'),
      message: t('sqlTransfer.leave.message'),
      confirmLabel: t('sqlTransfer.leave.confirm'),
      danger: true,
    })
    asking = false
    if (leave) {
      typing.value = false
      importConnection.value = connectionId.value
    } else if (props.tabId && lastPlace) {
      restoring = true
      tabs.setView(props.tabId, { ...lastPlace, coll: null })
    }
  },
  { immediate: true },
)
// Another place asked from outside (the tree, the palette, Back) ends a new name being typed.
watch(
  () => [props.connectionId, props.db] as const,
  () => {
    if (restoring) restoring = false
    else typing.value = false
  },
)
function pickConnection(value: string): void {
  if (value !== connectionId.value) show({ connectionId: value, db: null })
}
function pickDatabase(value: string): void {
  if (value === NEW) {
    typing.value = true
    typed.value = ''
    return
  }
  typing.value = false
  show({ db: value })
}
const connectionModel = computed({
  get: () => connectionId.value ?? '',
  set: (v: string) => pickConnection(v),
})
const databaseModel = computed({
  get: () => (typing.value && part.value === 'import' ? NEW : (db.value ?? '')),
  set: (v: string) => pickDatabase(v),
})
const connectionOptions = computed(() => list.value.map((c) => ({ value: c.id, label: c.name })))
const databaseOptions = computed(() => [
  // The address's database while the list loads, so the choice never shows empty.
  ...(db.value && !names.value.includes(db.value) && !typing.value
    ? [{ value: db.value, label: db.value }]
    : []),
  // An export never offers a system database (the server refuses one).
  ...(part.value === 'export' ? userNames.value : names.value).map((n) => ({ value: n, label: n })),
  ...(part.value === 'import' ? [{ value: NEW, label: t('sqlTransfer.target.newDatabase') }] : []),
])
const partModel = computed<Part>({
  get: () => part.value,
  set: (p) => {
    if (p !== part.value) show({ part: p })
  },
})
const parts = computed(() => [
  { value: 'import' as const, label: t('sqlTransfer.parts.import') },
  { value: 'export' as const, label: t('sqlTransfer.parts.export') },
])

const may = (p: NonNullable<typeof connection.value>['permissions'][number]) =>
  connection.value?.permissions.includes(p) ?? false
/** The server runs read-only, or this connection is: nothing can be written. */
const readOnly = computed(() => !!session.me?.readOnly || !!connection.value?.readOnly)
/** Why no import can run on this connection, if none can (the server checks again). */
const importBlocked = computed(() => {
  if (!connection.value) return null
  if (session.me?.readOnly) return t('sqlTransfer.import.readOnlyServer')
  if (connection.value.readOnly) return t('sqlTransfer.import.readOnlyConnection')
  if (!may('documents:write') || !may('jobs:run')) return t('sqlTransfer.import.notAllowed')
  return null
})
/** A system database takes no import: said, the file being prepared kept for another database. */
const systemDb = computed(() => !!db.value && BACKUP_SYSTEM_DATABASES.includes(db.value))
const exportBlocked = computed(() =>
  connection.value && !connection.value.export ? t('sqlTransfer.export.notAllowed') : null,
)
/** What the part does, said with its database, or before one is chosen. */
const importLead = computed(() =>
  db.value ? t('sqlTransfer.import.lead', { db: db.value }) : t('sqlTransfer.import.leadNone'),
)
const exportLead = computed(() =>
  exportDb.value ? t('sqlTransfer.export.lead', { db: exportDb.value }) : t('sqlTransfer.export.leadNone'),
)
</script>

<template>
  <section data-sql-transfer class="flex h-full min-h-0 flex-col">
    <DsPageHeader
      :title="t('sqlTransfer.title')"
      :icon="ArrowLeftRight"
      :description="t('sqlTransfer.subtitle')"
    />
    <div class="min-h-0 flex-1 overflow-auto">
      <div class="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-6">
        <!-- User request 2026-11-02: a tab left open while the SQL → MongoDB plugin was turned off. -->
        <div v-if="!plugins.runtimeKnown" aria-busy="true" class="flex flex-col gap-3">
          <span class="sr-only" role="status">{{ t('app.loading') }}</span
          ><DsSkeleton v-for="i in 3" :key="i" class="h-20 rounded-card" />
        </div>
        <DsEmptyState
          v-else-if="!plugins.sqlOffered"
          data-sql-plugin-off
          :icon="Puzzle"
          :title="t('sqlTransfer.pluginOff')"
          :description="t('sqlTransfer.pluginOffHint')"
        />
        <div v-else-if="connections.isPending.value" aria-busy="true" class="flex flex-col gap-3">
          <span class="sr-only" role="status">{{ t('app.loading') }}</span
          ><DsSkeleton v-for="i in 3" :key="i" class="h-20 rounded-card" />
        </div>
        <DsCallout v-else-if="connections.isError.value" tone="danger" data-sql-connections-error>
          <span class="flex flex-wrap items-center gap-3">
            {{ describeError(connections.error.value, t) }}
            <DsButton size="sm" @click="connections.refetch()">{{ t('tree.retry') }}</DsButton>
          </span>
        </DsCallout>
        <DsEmptyState
          v-else-if="!list.length"
          :icon="Server"
          :title="t('sqlTransfer.noConnections')"
          :description="t('sqlTransfer.noConnectionsHint')"
        >
          <template v-if="session.can('connections:manage')" #actions>
            <DsButton variant="primary" @click="workspaceDialogs.open({ kind: 'connection' })">{{
              t('sqlTransfer.addConnection')
            }}</DsButton>
          </template>
        </DsEmptyState>

        <template v-else>
          <!-- Where it works, always in sight. -->
          <section
            class="grid gap-4 rounded-xl border border-line bg-surface p-4 shadow-xs sm:grid-cols-2"
            :aria-label="t('sqlTransfer.target.label')"
            data-sql-target
          >
            <div class="flex min-w-0 flex-col gap-1.5">
              <DsSelect
                v-model="connectionModel"
                :label="t('sqlTransfer.target.connection')"
                :options="connectionOptions"
                data-sql-connection
              />
              <p v-if="readOnly" class="flex items-center gap-1.5 text-small text-warning" data-sql-read-only>
                <DsBadge tone="warning">{{ t('header.readOnly') }}</DsBadge>
                {{
                  connection?.export
                    ? t('sqlTransfer.target.readOnly')
                    : t('sqlTransfer.target.readOnlyNothing')
                }}
              </p>
            </div>
            <div class="flex min-w-0 flex-col gap-1.5">
              <DsSelect
                v-model="databaseModel"
                :label="t('sqlTransfer.target.database')"
                :options="databaseOptions"
                :error="databases.isError.value ? describeError(databases.error.value, t) : undefined"
                data-sql-database
              />
              <template v-if="typing && part === 'import'">
                <DsInput
                  v-model="typed"
                  size="sm"
                  mono
                  maxlength="63"
                  spellcheck="false"
                  autocomplete="off"
                  :label="t('sqlTransfer.target.newName')"
                  hide-label
                  :placeholder="t('sqlTransfer.target.newName')"
                  :error="typedError || undefined"
                  data-sql-new-database
                />
              </template>
            </div>
          </section>

          <div class="flex flex-col gap-4">
            <DsTabs
              v-model="partModel"
              :label="t('sqlTransfer.parts.label')"
              :tabs="parts"
              :id-prefix="`${uid}-part`"
              :panel-id="`${uid}-part-panel`"
            />
            <div
              :id="`${uid}-part-panel`"
              role="tabpanel"
              :aria-labelledby="`${uid}-part-${part}`"
              class="flex flex-col gap-4"
            >
              <!-- Both parts stay while the page is open: an import being prepared survives a look at Export. -->
              <div v-show="part === 'import'" class="flex flex-col gap-4" data-sql-part="import">
                <p class="flex items-center gap-2 text-small text-fg-subtle">
                  <Upload class="size-3.5" aria-hidden="true" />{{ importLead }}
                </p>
                <DsCallout v-if="importBlocked" tone="warning" data-sql-blocked>{{
                  importBlocked
                }}</DsCallout>
                <template v-else-if="connectionId">
                  <DsCallout v-if="systemDb" tone="warning" data-sql-blocked>{{
                    t('sqlTransfer.import.systemDb')
                  }}</DsCallout>
                  <!-- One panel per connection (an upload is the connection's): a database chosen or typed keeps it. -->
                  <SqlImportPanel
                    v-if="importConnection"
                    :key="importConnection"
                    :connection-id="importConnection"
                    :db="systemDb || importConnection !== connectionId ? null : db"
                    :in-sight="visible && part === 'import'"
                    @work="importWork = $event"
                  />
                </template>
              </div>
              <div
                v-if="exportSeen"
                v-show="part === 'export'"
                class="flex flex-col gap-4"
                data-sql-part="export"
              >
                <p class="flex items-center gap-2 text-small text-fg-subtle">
                  <Download class="size-3.5" aria-hidden="true" />{{ exportLead }}
                </p>
                <DsCallout v-if="exportBlocked" tone="warning" data-sql-blocked>{{
                  exportBlocked
                }}</DsCallout>
                <DsEmptyState
                  v-else-if="listed && !exportDb"
                  :icon="Database"
                  :title="t('sqlTransfer.export.noDatabases')"
                  :description="t('sqlTransfer.export.noDatabasesHint')"
                />
                <SqlExportPanel
                  v-else-if="connectionId && exportDb"
                  :key="connectionId"
                  :connection-id="connectionId"
                  :db="exportDb"
                  :preselect="coll"
                  :in-sight="visible && part === 'export'"
                />
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>
