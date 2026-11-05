<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookOpen, Info, LogOut, UserCog, Users } from 'lucide-vue-next'
import DsMenu from '@/ds/DsMenu.vue'
import type { DsMenuItem } from '@/ds/menu'
import { useSessionStore } from '@/stores/session'
import { useTabsStore } from '@/stores/tabs'
import { useUpdatesStore } from '@/stores/updates'
import { useSignOut } from '@/auth/signOut'
import { openDocs } from './docs'
import { openAboutTab, openAccountTab, openUsersTab } from './openTabs'

/**
 * UI redesign R1 revision 2 §3.2: the account menu at the context bar's right — the account's own
 * places and Sign out. Administration lives in the sidebar.
 */
const { t, locale } = useI18n()
const session = useSessionStore()
const tabs = useTabsStore()
const signOut = useSignOut()
const username = computed(() => session.me?.user.username ?? '')
const initial = computed(() => (username.value.trim()[0] ?? '?').toLocaleUpperCase(locale.value))
const team = computed(() => session.status?.mode === 'team')
// The updater (2026-11-03): a new version an administrator can install is marked here and on About.
const updates = useUpdatesStore()
const newVersion = computed(() => (updates.hasUpdate ? t('about.updates.menu.available') : undefined))
// What the server last found, without asking GitHub: an administrator's menu shows it at once.
onMounted(() => {
  if (session.can('settings:manage') && !updates.status) void updates.load()
})

const items = computed<DsMenuItem[]>(() => [
  { id: 'account', label: t('header.settings'), icon: UserCog },
  // Local mode has no user accounts.
  ...(team.value && session.can('users:manage')
    ? [{ id: 'users', label: t('header.users'), icon: Users }]
    : []),
  { id: 'docs', label: t('header.docs'), icon: BookOpen },
  // User request 2026-10-31: the About page, for everyone.
  {
    id: 'about',
    label: t('header.about'),
    icon: Info,
    ...(newVersion.value ? { badge: { text: t('about.updates.menu.badge'), label: newVersion.value } } : {}),
  },
  ...(team.value && session.me
    ? [{ id: 'signOut', label: t('header.logout'), icon: LogOut, separator: true }]
    : []),
])

function select(id: string): void {
  if (id === 'account') openAccountTab(tabs)
  else if (id === 'users') openUsersTab(tabs)
  else if (id === 'docs') openDocs(locale.value)
  else if (id === 'about') openAboutTab(tabs)
  else if (id === 'signOut') void signOut()
}
</script>

<template>
  <DsMenu
    focusable
    :label="t('header.accountMenu', { name: username })"
    :alert="newVersion"
    :items="items"
    placement="bottom-end"
    trigger-class="relative grid size-8 shrink-0 cursor-pointer place-items-center rounded-full transition-[box-shadow] duration-120 hover:ring-2 hover:ring-line-strong"
    @select="select"
  >
    <template #trigger>
      <span
        class="grid size-7 place-items-center rounded-full bg-accent text-small font-semibold text-on-accent"
      >
        {{ initial }}
      </span>
      <span
        v-if="newVersion"
        class="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-accent ring-2 ring-surface"
        aria-hidden="true"
        data-update-dot
      />
    </template>
  </DsMenu>
</template>
