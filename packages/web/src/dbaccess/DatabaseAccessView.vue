<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { KeyRound, Pencil, Plus, RotateCw, Search, ShieldCheck, Trash2, UserRound } from 'lucide-vue-next'
import {
  BUILTIN_ROLE_NAMES,
  EXTERNAL_DB,
  type DbRoleView,
  type DbUserView,
} from '@mongo-manager/shared/browser'
import DsBadge from '@/ds/DsBadge.vue'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsCard from '@/ds/DsCard.vue'
import DsDataTable from '@/ds/DsDataTable.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsInput from '@/ds/DsInput.vue'
import DsMenu from '@/ds/DsMenu.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import DsSelect from '@/ds/DsSelect.vue'
import type { DsMenuItem } from '@/ds/menu'
import type { DsColumn } from '@/ds/table'
import { accessKeys, databaseAccessApi } from '@/api/databaseAccess'
import { connectionsApi, queryKeys } from '@/api/connections'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import UserEditor from './UserEditor.vue'
import RoleEditor from './RoleEditor.vue'
import { adminErrorText } from './errors'

/**
 * W3.1 (Atlas "Database Access"): MongoDB's users and custom roles on this connection. Users with
 * their roles as chips and the account the connection signs in with marked; custom roles with
 * what they allow. Adding and editing open a sheet; dropping asks for the name typed. What MongoDB
 * would not list to the connection's account is said, never shown as an empty deployment.
 */
const props = defineProps<{ connectionId: string; readOnly: boolean }>()
const { t } = useI18n()
const dialogs = useDialogStore()
const toasts = useToastStore()
const queryClient = useQueryClient()

type View = 'users' | 'roles'
const view = ref<View>('users')
const db = ref('')
const filter = ref('')
const views = computed(() => [
  { value: 'users' as const, label: t('dbAccess.tabs.users'), icon: UserRound },
  { value: 'roles' as const, label: t('dbAccess.tabs.roles'), icon: ShieldCheck },
])
const databasesQuery = useQuery({
  queryKey: computed(() => queryKeys.databases(props.connectionId)),
  queryFn: () => connectionsApi.databases(props.connectionId),
  // Third review (I1): opened only once connected; when to read them again is the connection's.
  refetchOnMount: false,
  retryOnMount: false,
})
const databases = computed(() => (databasesQuery.data.value?.databases ?? []).map((d) => d.name))
const dbOptions = computed(() => [
  { value: '', label: t('dbAccess.allDatabases') },
  ...[...new Set(['admin', ...databases.value])]
    .filter((d) => d !== 'local' && d !== 'config')
    .map((d) => ({ value: d, label: d })),
  ...(view.value === 'users' ? [{ value: EXTERNAL_DB, label: EXTERNAL_DB }] : []),
])

const users = useQuery({
  queryKey: computed(() => accessKeys.users(props.connectionId, db.value)),
  queryFn: () => databaseAccessApi.users(props.connectionId, db.value),
  enabled: computed(() => view.value === 'users'),
})
const roleDb = computed(() => (db.value === EXTERNAL_DB ? '' : db.value))
const roles = useQuery({
  queryKey: computed(() => accessKeys.roles(props.connectionId, roleDb.value)),
  queryFn: () => databaseAccessApi.roles(props.connectionId, roleDb.value),
})
const customRoles = computed(() => roles.data.value?.roles ?? [])

const needle = computed(() => filter.value.trim().toLowerCase())
const shownUsers = computed(() =>
  (users.data.value?.users ?? []).filter(
    (u) =>
      !needle.value ||
      `${u.user} ${u.db} ${u.roles.map((r) => r.role).join(' ')}`.toLowerCase().includes(needle.value),
  ),
)
const shownRoles = computed(() =>
  customRoles.value.filter((r) => !needle.value || `${r.role} ${r.db}`.toLowerCase().includes(needle.value)),
)

const userColumns = computed<DsColumn[]>(() => [
  { key: 'user', label: t('dbAccess.users.name'), width: '26%' },
  { key: 'db', label: t('dbAccess.users.authDb'), mono: true, width: '14%', hideBelow: 560 },
  { key: 'roles', label: t('dbAccess.users.roles') },
  { key: 'mechanisms', label: t('dbAccess.users.mechanisms'), width: '11rem', hideBelow: 760 },
])
const roleColumns = computed<DsColumn[]>(() => [
  { key: 'role', label: t('dbAccess.customRoles.name'), width: '26%' },
  { key: 'privileges', label: t('dbAccess.privileges.title') },
  { key: 'inherits', label: t('dbAccess.customRoles.inherits'), width: '30%', hideBelow: 640 },
])

const editingUser = ref<{ existing?: DbUserView } | null>(null)
const editingRole = ref<{ existing?: DbRoleView } | null>(null)

const userMenu = (u: DbUserView): DsMenuItem[] =>
  props.readOnly
    ? []
    : [
        { id: 'edit', label: t('dbAccess.users.edit'), icon: Pencil },
        ...(u.db !== EXTERNAL_DB
          ? [{ id: 'password', label: t('dbAccess.users.changePassword'), icon: KeyRound }]
          : []),
        { id: 'drop', label: t('dbAccess.users.drop'), icon: Trash2, danger: true },
      ]
const roleMenu = (): DsMenuItem[] =>
  props.readOnly
    ? []
    : [
        { id: 'edit', label: t('dbAccess.customRoles.edit'), icon: Pencil },
        { id: 'drop', label: t('dbAccess.customRoles.drop'), icon: Trash2, danger: true },
      ]

async function dropUser(u: DbUserView): Promise<void> {
  const ok = await dialogs.confirm({
    title: t('dbAccess.users.dropTitle', { user: u.user }),
    message: u.own
      ? t('dbAccess.users.dropOwn', { user: u.user })
      : t('dbAccess.users.dropMessage', { user: u.user, db: u.db }),
    confirmLabel: t('dbAccess.users.drop'),
    danger: true,
    requireText: u.user,
  })
  if (!ok) return
  try {
    await databaseAccessApi.dropUser(props.connectionId, u.db, u.user, u.own)
    toasts.push({ kind: 'success', message: t('dbAccess.users.dropped', { user: u.user }) })
    await queryClient.invalidateQueries({ queryKey: accessKeys.all(props.connectionId) })
  } catch (e) {
    toasts.push({ kind: 'error', message: adminErrorText(e, t) })
  }
}

async function dropRole(r: DbRoleView): Promise<void> {
  const ok = await dialogs.confirm({
    title: t('dbAccess.customRoles.dropTitle', { role: r.role }),
    message: r.own
      ? t('dbAccess.customRoles.dropOwn', { role: r.role })
      : t('dbAccess.customRoles.dropMessage', { role: r.role, db: r.db }),
    confirmLabel: t('dbAccess.customRoles.drop'),
    danger: true,
    requireText: r.role,
  })
  if (!ok) return
  try {
    await databaseAccessApi.dropRole(props.connectionId, r.db, r.role, r.own)
    toasts.push({ kind: 'success', message: t('dbAccess.customRoles.dropped', { role: r.role }) })
    await queryClient.invalidateQueries({ queryKey: accessKeys.all(props.connectionId) })
  } catch (e) {
    toasts.push({ kind: 'error', message: adminErrorText(e, t) })
  }
}

function onUserMenu(u: DbUserView, id: string): void {
  if (id === 'edit' || id === 'password') editingUser.value = { existing: u }
  else if (id === 'drop') void dropUser(u)
}
function onRoleMenu(r: DbRoleView, id: string): void {
  if (id === 'edit') editingRole.value = { existing: r }
  else if (id === 'drop') void dropRole(r)
}
const add = () => (view.value === 'users' ? (editingUser.value = {}) : (editingRole.value = {}))
const builtin = (role: string) => BUILTIN_ROLE_NAMES.has(role)
const privilegeText = (r: DbRoleView) =>
  (r.privileges ?? []).map((p) => {
    const res = p.resource
    const where =
      'cluster' in res
        ? t('dbAccess.privileges.clusterWord')
        : 'anyResource' in res
          ? t('dbAccess.privileges.anyWord')
          : `${res.db || '*'}.${res.collection || '*'}`
    return `${where}: ${p.actions.join(', ')}`
  })
const current = computed(() => (view.value === 'users' ? users : roles))
</script>

<template>
  <section class="flex max-w-6xl flex-col gap-4 p-4" data-database-access>
    <div class="flex flex-wrap items-end gap-3">
      <DsSegmented v-model="view" :label="t('dbAccess.tabs.label')" :options="views" />
      <DsSelect
        v-model="db"
        class="w-48 max-w-full"
        size="sm"
        :label="t('dbAccess.database')"
        :options="dbOptions"
      />
      <DsInput
        v-model="filter"
        class="w-56 max-w-full"
        size="sm"
        type="search"
        :icon="Search"
        :label="t('dbAccess.search')"
        hide-label
        :placeholder="t('dbAccess.search')"
      />
      <DsButton
        v-if="!readOnly"
        class="ml-auto"
        size="sm"
        variant="primary"
        :icon="Plus"
        data-add
        @click="add"
        >{{ view === 'users' ? t('dbAccess.users.add') : t('dbAccess.customRoles.add') }}</DsButton
      >
    </div>
    <DsCallout v-if="readOnly" tone="info">{{ t('dbAccess.readOnly') }}</DsCallout>
    <DsCallout v-if="view === 'users' && users.data.value?.refused" tone="warning" data-refused>{{
      t('dbAccess.users.refused')
    }}</DsCallout>
    <DsCallout v-if="view === 'roles' && roles.data.value?.refused.length" tone="warning" data-refused>{{
      t('dbAccess.customRoles.refused', { dbs: roles.data.value.refused.join(', ') })
    }}</DsCallout>

    <DsCard
      v-if="view === 'users'"
      :title="t('dbAccess.users.title')"
      :count="users.data.value?.more ? `${shownUsers.length}+` : shownUsers.length"
    >
      <DsDataTable
        :label="t('dbAccess.users.title')"
        :columns="userColumns"
        :rows="shownUsers"
        :row-key="(u: DbUserView) => `${u.db}/${u.user}`"
        :loading="users.isPending.value"
        :loading-label="t('app.loading')"
        :error="users.isError.value ? adminErrorText(users.error.value, t) : undefined"
        :actions-label="t('common.actions')"
      >
        <template #cell-user="{ row: u }">
          <span class="flex min-w-0 items-center gap-2 py-1.5">
            <span class="truncate font-mono text-fg" :title="u.user">{{ u.user }}</span>
            <DsBadge v-if="u.own" tone="accent">{{ t('dbAccess.users.own') }}</DsBadge>
          </span>
        </template>
        <template #cell-db="{ row: u }">
          <span class="text-fg-muted">{{ u.db }}</span>
        </template>
        <template #cell-roles="{ row: u }">
          <span v-if="!u.roles.length" class="text-small text-fg-subtle">{{ t('dbAccess.roles.none') }}</span>
          <span v-else class="flex flex-wrap gap-1 py-1.5">
            <DsBadge
              v-for="r in u.roles"
              :key="`${r.role}@${r.db}`"
              :tone="builtin(r.role) ? 'neutral' : 'info'"
              >{{ t('dbAccess.roles.on', { role: r.role, db: r.db }) }}</DsBadge
            >
          </span>
        </template>
        <template #cell-mechanisms="{ row: u }">
          <span class="text-small text-fg-subtle">{{
            u.db === '$external' ? t('dbAccess.users.externalAuth') : u.mechanisms.join(', ')
          }}</span>
        </template>
        <template #actions="{ row: u }">
          <DsMenu
            v-if="userMenu(u).length"
            focusable
            touch
            :label="t('dbAccess.users.actionsFor', { user: u.user })"
            :items="userMenu(u)"
            @select="onUserMenu(u, $event)"
          />
        </template>
        <template #retry>
          <DsButton size="sm" :icon="RotateCw" @click="current.refetch()">{{ t('common.retry') }}</DsButton>
        </template>
        <template #empty>
          <DsEmptyState
            :icon="UserRound"
            :title="t('dbAccess.users.emptyTitle')"
            :description="t('dbAccess.users.empty')"
          >
            <template v-if="!readOnly && !needle" #actions>
              <DsButton variant="primary" :icon="Plus" @click="editingUser = {}">{{
                t('dbAccess.users.add')
              }}</DsButton>
            </template>
          </DsEmptyState>
        </template>
      </DsDataTable>
    </DsCard>

    <DsCard v-else :title="t('dbAccess.customRoles.title')" :count="shownRoles.length">
      <p class="mb-3 text-small text-fg-subtle">{{ t('dbAccess.customRoles.intro') }}</p>
      <DsDataTable
        :label="t('dbAccess.customRoles.title')"
        :columns="roleColumns"
        :rows="shownRoles"
        :row-key="(r: DbRoleView) => `${r.db}/${r.role}`"
        :loading="roles.isPending.value"
        :loading-label="t('app.loading')"
        :error="roles.isError.value ? adminErrorText(roles.error.value, t) : undefined"
        :actions-label="t('common.actions')"
      >
        <template #cell-role="{ row: r }">
          <span class="flex min-w-0 flex-col py-1.5">
            <span class="truncate font-mono text-fg">{{ r.role }}</span>
            <span class="text-small text-fg-subtle">{{ r.db }}</span>
          </span>
        </template>
        <template #cell-privileges="{ row: r }">
          <ul class="flex flex-col gap-0.5 py-1.5 font-mono text-small text-fg-muted">
            <li v-for="(line, i) in privilegeText(r)" :key="i" class="break-words">{{ line }}</li>
            <li v-if="!r.privileges?.length" class="font-sans text-fg-subtle">
              {{ t('dbAccess.privileges.none') }}
            </li>
          </ul>
        </template>
        <template #cell-inherits="{ row: r }">
          <span class="flex flex-wrap gap-1 py-1.5">
            <DsBadge v-for="x in r.roles" :key="`${x.role}@${x.db}`">{{
              t('dbAccess.roles.on', { role: x.role, db: x.db })
            }}</DsBadge>
            <span v-if="!r.roles.length" class="text-small text-fg-subtle">{{
              t('dbAccess.roles.none')
            }}</span>
          </span>
        </template>
        <template #actions="{ row: r }">
          <DsMenu
            v-if="roleMenu().length"
            focusable
            touch
            :label="t('dbAccess.customRoles.actionsFor', { role: r.role })"
            :items="roleMenu()"
            @select="onRoleMenu(r, $event)"
          />
        </template>
        <template #retry>
          <DsButton size="sm" :icon="RotateCw" @click="current.refetch()">{{ t('common.retry') }}</DsButton>
        </template>
        <template #empty>
          <DsEmptyState
            :icon="ShieldCheck"
            :title="t('dbAccess.customRoles.emptyTitle')"
            :description="t('dbAccess.customRoles.empty')"
          >
            <template v-if="!readOnly && !needle" #actions>
              <DsButton variant="primary" :icon="Plus" @click="editingRole = {}">{{
                t('dbAccess.customRoles.add')
              }}</DsButton>
            </template>
          </DsEmptyState>
        </template>
      </DsDataTable>
    </DsCard>

    <UserEditor
      v-if="editingUser"
      v-bind="editingUser"
      :connection-id="connectionId"
      :databases="databases"
      :custom-roles="customRoles"
      @close="editingUser = null"
    />
    <RoleEditor
      v-if="editingRole"
      v-bind="editingRole"
      :connection-id="connectionId"
      :databases="databases"
      :custom-roles="customRoles"
      @close="editingRole = null"
    />
  </section>
</template>
