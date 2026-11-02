<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import {
  Ellipsis,
  KeyRound,
  Plus,
  RotateCw,
  ShieldMinus,
  ShieldOff,
  ShieldPlus,
  Trash2,
  UserCheck,
  UserX,
  Users,
} from 'lucide-vue-next'
import { ROLES, type Role } from '@mongo-manager/shared/browser'
import DsPageHeader from '@/ds/DsPageHeader.vue'
import DsBadge from '@/ds/DsBadge.vue'
import DsButton from '@/ds/DsButton.vue'
import DsDataTable from '@/ds/DsDataTable.vue'
import DsMenu from '@/ds/DsMenu.vue'
import DsSelect from '@/ds/DsSelect.vue'
import DsTabs from '@/ds/DsTabs.vue'
import type { DsMenuItem } from '@/ds/menu'
import type { DsColumn } from '@/ds/table'
import { accountKeys, twoFactorRequiredOf, usersApi, type UserInfo } from '@/api/account'
import { describeError } from '@/api/errors'
import { explainError } from '@/api/reasons'
import { useDialogStore } from '@/stores/dialogs'
import { useSessionStore } from '@/stores/session'
import { useToastStore } from '@/stores/toasts'
import { STEP_UP_DECLINED, withStepUp } from '@/account/stepUp'
import AdminPolicyCard from './AdminPolicyCard.vue'
import SessionPolicyCard from './SessionPolicyCard.vue'
import SignInBansCard from './SignInBansCard.vue'
import PanelAccessCard from './PanelAccessCard.vue'
import UsersActivity from './UsersActivity.vue'

const UserCreateDialog = defineAsyncComponent(() => import('./UserCreateDialog.vue'))

/**
 * The users of a team (phase 1g), redesigned (phase 4c §5): roles, 2FA (an authenticator app or a
 * passkey), status and actions; the administrators' 2FA requirement (§4); each user's activity (§3).
 */
const { t, locale } = useI18n()
const queryClient = useQueryClient()
const dialogs = useDialogStore()
const session = useSessionStore()
const toasts = useToastStore()
const creating = ref(false)
// User review 2026-10-30: the users, how sign-in is protected, and what they did — each its own tab.
const view = ref<'list' | 'security' | 'activity'>('list')
const views = computed(() => [
  { value: 'list' as const, label: t('users.tabs.list') },
  { value: 'security' as const, label: t('users.tabs.security') },
  { value: 'activity' as const, label: t('users.tabs.activity') },
])
/** Bumped after a refused change so the role select shows the stored value again. */
const version = ref(0)

const { data, isPending, isError, error, refetch } = useQuery({
  queryKey: accountKeys.users,
  queryFn: usersApi.list,
})
/** Required 2FA (2026-10-28): who must have 2FA, by their flag or the policy (the card's query). */
const policy = useQuery({ queryKey: accountKeys.policy, queryFn: usersApi.policy })
const required = (u: UserInfo) => twoFactorRequiredOf(u, policy.data.value)
const selfId = computed(() => session.me?.user.id)
/** The team at a glance, over the table. */
const stats = computed(() => {
  const all = data.value ?? []
  return [
    { key: 'total', value: all.length },
    { key: 'admins', value: all.filter((u) => u.role === 'admin' && !u.disabled).length },
    { key: 'twoFactor', value: all.filter((u) => hasTwoFactor(u)).length },
    { key: 'disabled', value: all.filter((u) => u.disabled).length },
  ]
})
const roles = computed(() => ROLES.map((r) => ({ value: r, label: t(`overview.roles.${r}`) })))
const columns = computed<DsColumn[]>(() => [
  { key: 'username', label: t('users.username') },
  { key: 'role', label: t('users.role'), width: '11rem' },
  { key: 'twoFactor', label: t('users.twoFactor'), width: '10rem' },
  { key: 'status', label: t('users.status'), width: '7rem' },
  { key: 'created', label: t('users.created'), width: '9rem' },
])
const date = (ms: number) => new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }).format(ms)
/** Phase 4c §5: an authenticator app or a passkey (an older server says the app alone). */
const hasTwoFactor = (u: UserInfo) => u.twoFactor ?? u.totpEnabled

const explain = (e: unknown): string => explainError(e, t)

/**
 * Security audit 2026-10-16: an action that hands out a lasting way in is confirmed with the
 * administrator's own password, and with a second factor proved lately when they have one.
 */
async function run(action: () => Promise<unknown>, success: string, stepUp = false): Promise<void> {
  try {
    if ((await (stepUp ? withStepUp(action) : action())) === STEP_UP_DECLINED) {
      version.value++
      return
    }
    await queryClient.invalidateQueries({ queryKey: accountKeys.users })
    toasts.push({ kind: 'success', message: success })
  } catch (e) {
    version.value++
    toasts.push({ kind: 'error', message: explain(e) })
  }
}

/** The administrator's own password for a change, or null when they did not give it. */
const ownPassword = (message: string, confirmLabel: string, danger = false) =>
  dialogs.prompt({
    title: t('users.confirmTitle'),
    message,
    confirmLabel,
    danger,
    input: { type: 'password', label: t('users.yourPassword'), autocomplete: 'current-password' },
  })

async function changeRole(user: UserInfo, role: Role): Promise<void> {
  const name = user.username
  const currentPassword = await ownPassword(
    t('users.confirmRole', { name, role: t(`overview.roles.${role}`) }),
    t('users.confirm'),
  )
  // Not given: the select shows the stored role again.
  if (!currentPassword) {
    version.value++
    return
  }
  await run(() => usersApi.update(user.id, { role, currentPassword }), t('users.updated', { name }), true)
}

const menuFor = (user: UserInfo): DsMenuItem[] => [
  { id: 'password', label: t('users.resetPassword'), icon: KeyRound },
  // An older server has no such flag (final review, minor 8).
  ...(user.requireTwoFactor === undefined
    ? []
    : [
        user.requireTwoFactor
          ? { id: 'unrequire2fa', label: t('users.stopRequiring2fa'), icon: ShieldMinus }
          : { id: 'require2fa', label: t('users.require2fa'), icon: ShieldPlus },
      ]),
  { id: '2fa', label: t('users.reset2fa'), icon: ShieldOff },
  user.disabled
    ? { id: 'enable', label: t('users.enable'), icon: UserCheck }
    : { id: 'disable', label: t('users.disable'), icon: UserX },
  { id: 'delete', label: t('users.delete'), icon: Trash2, danger: true, separator: true },
]

async function onSelect(user: UserInfo, action: string): Promise<void> {
  const name = user.username
  if (action === 'password') {
    const password = await dialogs.prompt({
      title: t('users.resetPassword'),
      message: t('users.resetPasswordMessage', { name }),
      confirmLabel: t('users.resetPassword'),
      input: {
        type: 'password',
        label: t('users.newPassword'),
        autocomplete: 'new-password',
        strength: { username: user.username },
      },
    })
    if (!password) return
    const currentPassword = await ownPassword(
      t('users.confirmPasswordReset', { name }),
      t('users.resetPassword'),
    )
    if (currentPassword)
      await run(
        () => usersApi.resetPassword(user.id, password, currentPassword),
        t('users.passwordReset', { name }),
        true,
      )
  } else if (action === '2fa') {
    const currentPassword = await ownPassword(t('users.reset2faConfirm', { name }), t('users.reset2fa'), true)
    if (currentPassword)
      await run(() => usersApi.reset2fa(user.id, currentPassword), t('users.twoFactorReset', { name }), true)
  } else if (action === 'require2fa') {
    // Required 2FA (2026-10-28): it takes no way in away from anyone else, so a confirmation is enough.
    const ok = await dialogs.confirm({
      title: t('users.require2faTitle'),
      message: t('users.require2faConfirm', { name }),
      confirmLabel: t('users.require2fa'),
    })
    if (ok)
      await run(
        () => usersApi.update(user.id, { requireTwoFactor: true }),
        t('users.required2faOn', { name }),
      )
  } else if (action === 'unrequire2fa') {
    // A weaker sign-in for that account: the administrator's own password, and a fresh second factor.
    const currentPassword = await ownPassword(
      t('users.stopRequiring2faConfirm', { name }),
      t('users.stopRequiring2fa'),
      true,
    )
    // Final review (minor 8): the policy may still require it — said, not "no longer required".
    const stillCovered = twoFactorRequiredOf({ role: user.role }, policy.data.value)
    if (currentPassword)
      await run(
        () => usersApi.update(user.id, { requireTwoFactor: false, currentPassword }),
        t(stillCovered ? 'users.required2faOffCovered' : 'users.required2faOff', { name }),
        true,
      )
  } else if (action === 'disable') {
    await run(() => usersApi.update(user.id, { disabled: true }), t('users.updated', { name }))
  } else if (action === 'enable') {
    // Review of the audit fixes (important 3): an account enabled again is a way in again.
    const currentPassword = await ownPassword(t('users.confirmEnable', { name }), t('users.enable'))
    if (currentPassword)
      await run(
        () => usersApi.update(user.id, { disabled: false, currentPassword }),
        t('users.updated', { name }),
        true,
      )
  } else if (action === 'delete') {
    const ok = await dialogs.confirm({
      title: t('users.deleteTitle'),
      message: t('users.deleteConfirm', { name }),
      confirmLabel: t('users.delete'),
      danger: true,
      requireText: name,
    })
    if (ok) await run(() => usersApi.remove(user.id), t('users.deleted', { name }))
  }
}
</script>

<template>
  <section data-admin-page class="flex h-full min-h-0 flex-col">
    <DsPageHeader :title="t('tabs.users')" :icon="Users" :description="t('users.subtitle')">
      <template #actions>
        <DsButton size="sm" variant="primary" :icon="Plus" @click="creating = true">{{
          t('users.create')
        }}</DsButton>
      </template>
      <template #tabs>
        <DsTabs
          v-model="view"
          :label="t('tabs.users')"
          :tabs="views"
          id-prefix="users-view"
          panel-id="users-panel"
        />
      </template>
    </DsPageHeader>
    <div class="min-h-0 flex-1 overflow-auto">
      <div class="mx-auto flex max-w-6xl flex-col gap-5 px-6 py-5">
        <!-- Named by the tab shown: DsTabs gives each tab the id of its prefix and value (users-view-list). -->
        <div
          id="users-panel"
          role="tabpanel"
          :aria-labelledby="`users-view-${view}`"
          class="flex flex-col gap-4"
        >
          <template v-if="view === 'list'">
            <dl v-if="data" class="grid grid-cols-2 gap-3 sm:grid-cols-4" data-users-stats>
              <div
                v-for="s in stats"
                :key="s.key"
                class="flex flex-col gap-0.5 rounded-xl border border-line bg-surface px-4 py-3 shadow-xs"
                :data-stat="s.key"
              >
                <dt class="text-small text-fg-subtle">{{ t(`users.stats.${s.key}`) }}</dt>
                <dd class="text-lg font-semibold text-fg tabular-nums">{{ s.value }}</dd>
              </div>
            </dl>
            <div>
              <DsDataTable
                :label="t('tabs.users')"
                :columns="columns"
                :rows="data ?? []"
                :row-key="(user: UserInfo) => `${user.id}:${version}`"
                :loading="isPending"
                :loading-label="t('app.loading')"
                :error="isError ? describeError(error, t) : undefined"
                :actions-label="t('documents.actionsColumn')"
              >
                <template #cell-username="{ row: user }">
                  <span class="flex min-w-0 items-center gap-1">
                    <span class="truncate font-medium text-fg">{{ user.username }}</span>
                    <DsBadge v-if="user.id === selfId" tone="accent">{{ t('users.you') }}</DsBadge>
                  </span>
                </template>
                <template #cell-role="{ row: user }">
                  <span v-if="user.id === selfId" class="text-fg-muted">{{
                    t(`overview.roles.${user.role}`)
                  }}</span>
                  <!-- Not v-model: a refused change keeps the stored role (the row is drawn again). -->
                  <DsSelect
                    v-else
                    :model-value="user.role"
                    size="sm"
                    hide-label
                    :label="t('users.roleOf', { name: user.username })"
                    :options="roles"
                    @update:model-value="changeRole(user, $event)"
                  />
                </template>
                <template #cell-twoFactor="{ row: user }">
                  <span data-two-factor class="inline-flex flex-wrap items-center gap-1">
                    <DsBadge :tone="hasTwoFactor(user) ? 'accent' : 'neutral'">{{
                      hasTwoFactor(user) ? t('security.on') : t('security.off')
                    }}</DsBadge>
                    <span
                      v-if="required(user)"
                      data-two-factor-required
                      :title="hasTwoFactor(user) ? t('users.required') : t('users.requiredPending')"
                    >
                      <DsBadge :tone="hasTwoFactor(user) ? 'neutral' : 'warning'">{{
                        hasTwoFactor(user) ? t('users.required') : t('users.requiredPendingShort')
                      }}</DsBadge>
                    </span>
                  </span>
                </template>
                <template #cell-status="{ row: user }">
                  <DsBadge :tone="user.disabled ? 'danger' : 'neutral'">{{
                    user.disabled ? t('users.disabled') : t('users.active')
                  }}</DsBadge>
                </template>
                <template #cell-created="{ row: user }">
                  <span class="whitespace-nowrap text-fg-subtle">{{ date(user.createdAt) }}</span>
                </template>
                <template #actions="{ row: user }">
                  <DsMenu
                    v-if="user.id !== selfId"
                    focusable
                    touch
                    :icon="Ellipsis"
                    :label="t('users.actions', { name: user.username })"
                    :items="menuFor(user)"
                    @select="onSelect(user, $event)"
                  />
                </template>
                <template #retry>
                  <DsButton size="sm" :icon="RotateCw" @click="refetch()">{{ t('common.retry') }}</DsButton>
                </template>
              </DsDataTable>
            </div>
          </template>
          <!-- How signing in is protected: one column of full-width cards, read top to bottom. -->
          <div
            v-else-if="view === 'security'"
            class="mx-auto flex w-full max-w-4xl flex-col gap-4"
            data-users-security
          >
            <AdminPolicyCard />
            <SessionPolicyCard />
            <PanelAccessCard />
            <SignInBansCard />
          </div>
          <UsersActivity v-else />
        </div>
      </div>
    </div>
    <UserCreateDialog v-if="creating" @close="creating = false" />
  </section>
</template>
