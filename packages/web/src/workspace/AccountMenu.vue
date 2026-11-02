<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookOpen, Info, LogOut, UserCog, Users } from 'lucide-vue-next'
import DsMenu from '@/ds/DsMenu.vue'
import type { DsMenuItem } from '@/ds/menu'
import { useSessionStore } from '@/stores/session'
import { useTabsStore } from '@/stores/tabs'
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

const items = computed<DsMenuItem[]>(() => [
  { id: 'account', label: t('header.settings'), icon: UserCog },
  // Local mode has no user accounts.
  ...(team.value && session.can('users:manage')
    ? [{ id: 'users', label: t('header.users'), icon: Users }]
    : []),
  { id: 'docs', label: t('header.docs'), icon: BookOpen },
  // User request 2026-10-31: the About page, for everyone.
  { id: 'about', label: t('header.about'), icon: Info },
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
    </template>
  </DsMenu>
</template>
