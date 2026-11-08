<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { accountKeys, grantsApi, usersApi, type GrantRole, type UserInfo } from '@/api/account'
import { describeError } from '@/api/errors'
import { useToastStore } from '@/stores/toasts'
import { RotateCw } from 'lucide-vue-next'
import DsBadge from '@/ds/DsBadge.vue'
import DsButton from '@/ds/DsButton.vue'
import DsCard from '@/ds/DsCard.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import DsDataTable from '@/ds/DsDataTable.vue'
import DsSelect from '@/ds/DsSelect.vue'
import type { DsColumn } from '@/ds/table'

const props = defineProps<{ connection: { id: string; name: string } }>()
const { t } = useI18n()
const queryClient = useQueryClient()
const toasts = useToastStore()
/** Bumped after a refused change so the select shows the stored grant again. */
const version = ref(0)

const users = useQuery({ queryKey: accountKeys.users, queryFn: usersApi.list })
const grants = useQuery({
  queryKey: computed(() => accountKeys.grants(props.connection.id)),
  queryFn: () => grantsApi.list(props.connection.id),
})

/** UI redesign R3 leftovers: each user a row of the kit's data table, its options under its access. */
const columns = computed<DsColumn[]>(() => [
  { key: 'user', label: t('access.user'), width: '32%' },
  { key: 'access', label: t('access.title') },
])
const failed = computed(() => users.isError.value || grants.isError.value)
function retry(): void {
  void users.refetch()
  void grants.refetch()
}

const grantOf = (userId: string): GrantRole | 'inherit' =>
  grants.data.value?.find((g) => g.userId === userId)?.role ?? 'inherit'

const options = (user: UserInfo) => [
  { value: 'inherit', label: t('access.inherit', { role: t(`overview.roles.${user.role}`) }) },
  ...(['admin', 'editor', 'viewer'] as const).map((r) => ({ value: r, label: t(`overview.roles.${r}`) })),
  { value: 'none', label: t('access.none') },
]

async function change(user: UserInfo, value: string): Promise<void> {
  try {
    await grantsApi.set(props.connection.id, user.id, value === 'inherit' ? null : (value as GrantRole))
    await queryClient.invalidateQueries({ queryKey: accountKeys.grants(props.connection.id) })
    toasts.push({ kind: 'success', message: t('access.saved', { name: user.username }) })
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
    await queryClient.invalidateQueries({ queryKey: accountKeys.grants(props.connection.id) })
    version.value++
  }
}

/** Phase 3a-1: the shell is offered to an editor granted editor on this connection; admins have it. */
const grantFor = (userId: string) => grants.data.value?.find((g) => g.userId === userId)
const canOfferShell = (user: UserInfo) => user.role !== 'admin' && grantFor(user.id)?.role === 'editor'

async function toggleShell(user: UserInfo, shell: boolean): Promise<void> {
  const role = grantFor(user.id)?.role
  if (role !== 'editor') return
  try {
    await grantsApi.set(props.connection.id, user.id, role, { shell })
    await queryClient.invalidateQueries({ queryKey: accountKeys.grants(props.connection.id) })
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
    version.value++
  }
}

/** Phase 3b §2.2: an editor or viewer grant may hide the connection's personal data. */
const canOfferMasked = (user: UserInfo) => {
  const role = grantFor(user.id)?.role
  return user.role !== 'admin' && (role === 'editor' || role === 'viewer')
}

/** Phase 3d-1: a viewer may be granted file export on this connection; editors and admins have it. */
const canOfferExport = (user: UserInfo) => user.role !== 'admin' && grantFor(user.id)?.role === 'viewer'

async function toggleExport(user: UserInfo, on: boolean): Promise<void> {
  if (grantFor(user.id)?.role !== 'viewer') return
  try {
    await grantsApi.set(props.connection.id, user.id, 'viewer', { export: on })
    await queryClient.invalidateQueries({ queryKey: accountKeys.grants(props.connection.id) })
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
    version.value++
  }
}

async function toggleMasked(user: UserInfo, masked: boolean): Promise<void> {
  const role = grantFor(user.id)?.role
  if (role !== 'editor' && role !== 'viewer') return
  try {
    await grantsApi.set(props.connection.id, user.id, role, { masked })
    await queryClient.invalidateQueries({ queryKey: accountKeys.grants(props.connection.id) })
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
    version.value++
  }
}
</script>

<template>
  <DsCard :title="t('access.title')" :count="users.data.value?.length" data-access>
    <div class="flex flex-col gap-3">
      <p class="text-ui text-fg-muted">{{ t('access.intro') }}</p>
      <DsDataTable
        :label="t('access.title')"
        :columns="columns"
        :rows="users.data.value ?? []"
        :row-key="(user: UserInfo) => `${user.id}:${version}`"
        :loading="users.isPending.value || grants.isPending.value"
        :loading-label="t('app.loading')"
        :error="failed ? describeError(users.error.value ?? grants.error.value, t) : undefined"
      >
        <template #cell-user="{ row: user }">
          <span class="flex min-w-0 items-center gap-2 py-2">
            <span class="truncate font-medium text-fg" :title="user.username">{{ user.username }}</span>
            <DsBadge>{{ t(`overview.roles.${user.role}`) }}</DsBadge>
          </span>
        </template>
        <template #cell-access="{ row: user }">
          <div class="flex min-w-0 flex-col gap-2 py-2">
            <span v-if="user.role === 'admin'" class="text-small text-fg-subtle">{{
              t('access.adminAlways')
            }}</span>
            <!-- Not v-model: the stored grant stays the value until the server takes the change. -->
            <DsSelect
              v-else
              class="max-w-64"
              size="sm"
              :model-value="grantOf(user.id)"
              :label="t('access.roleFor', { name: user.username })"
              hide-label
              :options="options(user)"
              @update:model-value="change(user, $event)"
            />
            <DsCheckbox
              v-if="canOfferShell(user)"
              :model-value="grantFor(user.id)?.shell ?? false"
              :disabled="grantFor(user.id)?.masked ?? false"
              :label="t('access.shell')"
              :hint="t('access.shellWarning')"
              @update:model-value="toggleShell(user, $event)"
            />
            <DsCheckbox
              v-if="canOfferExport(user)"
              data-grant-export
              :model-value="grantFor(user.id)?.export ?? false"
              :label="t('access.export')"
              :hint="t('access.exportHint')"
              @update:model-value="toggleExport(user, $event)"
            />
            <DsCheckbox
              v-if="canOfferMasked(user)"
              data-grant-masked
              :model-value="grantFor(user.id)?.masked ?? false"
              :disabled="grantFor(user.id)?.shell ?? false"
              :label="t('access.masked')"
              :hint="grantFor(user.id)?.shell ? t('access.maskedNoShell') : t('access.maskedCovers')"
              @update:model-value="toggleMasked(user, $event)"
            />
          </div>
        </template>
        <template #retry>
          <DsButton size="sm" :icon="RotateCw" @click="retry">{{ t('common.retry') }}</DsButton>
        </template>
      </DsDataTable>
    </div>
  </DsCard>
</template>
