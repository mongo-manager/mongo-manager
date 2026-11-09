// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { computed, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { pluginKeys, pluginsApi } from '@/api/plugins'
import {
  ArrowLeftRight,
  ArrowRightLeft,
  BookMarked,
  CalendarClock,
  BellRing,
  CloudUpload,
  Database,
  FolderOpen,
  GitCompareArrows,
  History,
  House,
  Info,
  ListChecks,
  Puzzle,
  ScrollText,
  Server,
  Sparkles,
  SquareTerminal,
  Table,
  UserCog,
  Users,
} from 'lucide-vue-next'
import { useTabsStore, type WorkspaceTab } from '@/stores/tabs'
import { localized, usePluginsStore } from '@/plugins/store'
import { pluginIcon } from '@/plugins/icons'

/** Tabs that exist once and are named by their kind, in the current language. */
const SINGLETONS = new Set([
  'welcome',
  'account',
  'users',
  'audit',
  'plugins',
  'destinations',
  'alerts',
  'schedules',
  'liveSyncs',
  'aiSettings',
  'jobs',
  'aiHistory',
  'library',
  'sqlTransfer',
  'about',
])

const ICONS: Record<string, Component> = {
  welcome: House,
  connection: Server,
  database: Database,
  collection: Table,
  gridfs: FolderOpen,
  shell: SquareTerminal,
  compare: GitCompareArrows,
  account: UserCog,
  users: Users,
  audit: ScrollText,
  plugins: Puzzle,
  destinations: CloudUpload,
  alerts: BellRing,
  schedules: CalendarClock,
  liveSyncs: ArrowRightLeft,
  aiSettings: Sparkles,
  jobs: ListChecks,
  aiHistory: History,
  library: BookMarked,
  pluginPage: Puzzle,
  pluginDetails: Puzzle,
  sqlTransfer: ArrowLeftRight,
  // User request 2026-10-31.
  about: Info,
}

export const tabIcon = (kind: string): Component => ICONS[kind] ?? Table

/** A tab's title as shown: a collection tab shows its collection, the database is in the breadcrumbs. */
export function useTabTitle(): (tab: WorkspaceTab) => string {
  const { t, locale } = useI18n()
  const plugins = usePluginsStore()
  // A details tab is named after its plugin: the list, read only while such a tab is open.
  const tabs = useTabsStore()
  const manage = useQuery({
    queryKey: pluginKeys.manage,
    queryFn: pluginsApi.manage,
    enabled: computed(() => tabs.tabs.some((t) => t.kind === 'pluginDetails')),
  })
  return (tab) => {
    if (tab.kind === 'pluginDetails') {
      const found = manage.data.value?.plugins.find((p) => p.id === tab.params.pluginId)
      return found?.manifest ? localized(found.manifest.name, locale.value) : t('plugins.details.title')
    }
    if (tab.kind === 'pluginPage') {
      const page = plugins.pageOf(tab.params.plugin ?? '', tab.params.contribution ?? '')
      return page ? localized(page.title, locale.value) : t('plugins.page.title')
    }
    return SINGLETONS.has(tab.kind)
      ? t(`tabs.${tab.kind}`)
      : tab.kind === 'collection' && tab.params.coll
        ? tab.params.coll
        : tab.title
  }
}

/** A tab's icon: a plugin page has its plugin's own (review M4). */
export function useTabIcon(): (tab: WorkspaceTab) => Component {
  const plugins = usePluginsStore()
  return (tab) => {
    if (tab.kind !== 'pluginPage') return tabIcon(tab.kind)
    return pluginIcon(plugins.pageOf(tab.params.plugin ?? '', tab.params.contribution ?? '')?.icon)
  }
}

/** What a tab's tooltip says: a plugin page names the collection it is on. */
export function tabTooltip(tab: WorkspaceTab, title: string): string {
  return tab.kind === 'pluginPage' && tab.params.db && tab.params.coll
    ? `${title} — ${tab.params.db}.${tab.params.coll}`
    : title
}
