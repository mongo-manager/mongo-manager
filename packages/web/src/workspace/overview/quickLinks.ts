// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookOpen, Keyboard, UserCog } from 'lucide-vue-next'
import { useTabsStore } from '@/stores/tabs'
import { useWorkspaceDialogs } from '@/stores/workspaceDialogs'
import { openAccountTab } from '@/workspace/openTabs'
import { openDocs } from '@/workspace/docs'
import { useShortcutsStore } from '@/stores/shortcuts'
import { keyLabel } from '@/workspace/shortcuts'

/** The Overview's quick actions: shortcuts, documentation, account (the widget and the first-run page). */
export function useQuickLinks() {
  const { t, locale } = useI18n()
  const tabs = useTabsStore()
  const dialogs = useWorkspaceDialogs()
  const shortcuts = useShortcutsStore()
  return computed(() => [
    {
      id: 'shortcuts',
      icon: Keyboard,
      title: t('home.shortcuts'),
      body: t('home.shortcutsBody'),
      // W5: as this user bound them.
      keys: (shortcuts.keysOf('shortcuts')[0] ?? []).map(keyLabel),
      run: () => dialogs.open({ kind: 'shortcuts' }),
    },
    {
      id: 'docs',
      icon: BookOpen,
      title: t('home.docs'),
      body: t('home.docsBody'),
      keys: [] as string[],
      run: () => openDocs(locale.value),
    },
    {
      id: 'account',
      icon: UserCog,
      title: t('home.account'),
      body: t('home.accountBody'),
      keys: [] as string[],
      run: () => openAccountTab(tabs),
    },
  ])
}
