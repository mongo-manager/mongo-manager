import type { useTabsStore } from '@/stores/tabs'
import { useLibraryStore } from '@/library/store'
import { targetKey, usePluginsStore } from '@/plugins/store'

type Tabs = ReturnType<typeof useTabsStore>

export const openConnectionTab = (tabs: Tabs, c: { id: string; name: string }): string =>
  tabs.open({ kind: 'connection', title: c.name, params: { connectionId: c.id } })

export const openDatabaseTab = (tabs: Tabs, connectionId: string, db: string): string =>
  tabs.open({ kind: 'database', title: db, params: { connectionId, db } })

export const openCollectionTab = (tabs: Tabs, connectionId: string, db: string, coll: string): string =>
  tabs.open({ kind: 'collection', title: `${db}.${coll}`, params: { connectionId, db, coll } })

/** User requests 2026-10-11, 2026-10-12: SQL ↔ MongoDB — import into, or export from, one database. */
export const openSqlTransferTab = (
  tabs: Tabs,
  view: { part?: 'import' | 'export'; connectionId?: string; db?: string; coll?: string } = {},
): string => {
  // With nothing asked, the page as it was left (review 2026-10-11: never another place).
  const open = tabs.tabs.find((t) => t.kind === 'sqlTransfer')
  if (open && !view.part && !view.connectionId) {
    tabs.activate(open.id)
    return open.id
  }
  const id = tabs.open({ kind: 'sqlTransfer', title: '' })
  if (view.part || view.connectionId)
    tabs.setView(id, {
      part: view.part ?? 'import',
      connectionId: view.connectionId ?? null,
      db: view.db ?? null,
      coll: view.coll ?? null,
    })
  return id
}

/** Phase 3a-1: a shell on a connection's database. */
export const openShellTab = (tabs: Tabs, connectionId: string, db: string, name: string): string =>
  tabs.open({ kind: 'shell', title: `Shell: ${name}`, params: { connectionId, db } })

/** A database name a shell can be on (MongoDB's own limits). */
const SHELL_DB = /^[^/\\. "$*<>:|?]{1,63}$/

/**
 * The database a connection's shell starts on (user request 2026-10-11): the one its address names,
 * else `test`, as mongosh does.
 */
export function shellDatabaseOf(uri: string): string {
  const named = /^mongodb(?:\+srv)?:\/\/[^/?#]*\/([^/?#]+)/i.exec(uri)?.[1]
  if (!named) return 'test'
  try {
    const db = decodeURIComponent(named)
    return SHELL_DB.test(db) ? db : 'test'
  } catch {
    return 'test'
  }
}

/** A shell on a connection: on the database given, else the one its address names. */
export const openConnectionShell = (
  tabs: Tabs,
  c: { id: string; name: string; uri: string },
  db: string = shellDatabaseOf(c.uri),
): string => openShellTab(tabs, c.id, db, `${c.name} · ${db}`)

/** Singleton tabs: one per kind; the tab bar translates their titles. */
export const openAccountTab = (tabs: Tabs): string => tabs.open({ kind: 'account', title: '' })
export const openUsersTab = (tabs: Tabs): string => tabs.open({ kind: 'users', title: '' })
export const openAuditTab = (tabs: Tabs): string => tabs.open({ kind: 'audit', title: '' })
/** Phase 4b §2: plugins (administrators). */
export const openPluginsTab = (tabs: Tabs): string => tabs.open({ kind: 'plugins', title: '' })
/** Phase 3d-3b: the administrators' backup destinations. */
export const openDestinationsTab = (tabs: Tabs): string => tabs.open({ kind: 'destinations', title: '' })
/** W3.3: alerts — the bell's opt-in, and for administrators rules, channels and history. */
export const openAlertsTab = (tabs: Tabs): string => tabs.open({ kind: 'alerts', title: '' })
/** Phase 4a-1: the administrators' AI providers. */
export const openAiSettingsTab = (tabs: Tabs): string => tabs.open({ kind: 'aiSettings', title: '' })

/** Phase 3d-3c: scheduled backups. */
export const openSchedulesTab = (tabs: Tabs): string => tabs.open({ kind: 'schedules', title: '' })

/** Phase 3e-2: live syncs. */
export const openLiveSyncsTab = (tabs: Tabs): string => tabs.open({ kind: 'liveSyncs', title: '' })

/** User review 2026-10-08: the background jobs page. */
export const openJobsTab = (tabs: Tabs): string => tabs.open({ kind: 'jobs', title: '' })

/** User review 2026-10-09: the AI history — what was asked and answered, tokens and cost. */
export const openAiHistoryTab = (tabs: Tabs): string => tabs.open({ kind: 'aiHistory', title: '' })

/** User request 2026-10-31: the About page — version, author, project, license. */
export const openAboutTab = (tabs: Tabs): string => tabs.open({ kind: 'about', title: '' })

/** Phase 3d-2: a comparison's results; the title names both sides. */
export const openCompareTab = (tabs: Tabs, jobId: string, title: string): string =>
  tabs.open({ kind: 'compare', title, params: { jobId } })

/** Phase 4b §1: a GridFS bucket's files. */
export const openGridFsTab = (tabs: Tabs, connectionId: string, db: string, bucket: string): string =>
  tabs.open({ kind: 'gridfs', title: bucket, params: { connectionId, db, bucket } })

/**
 * User request 2026-10-10: the Queries page (the Library); from a connection's place it searches
 * that connection.
 */
export function openLibraryTab(tabs: Tabs): string {
  const from = tabs.active
  useLibraryStore().show(
    from?.params.connectionId ?? null,
    from?.kind === 'collection' ? from.params : undefined,
  )
  return tabs.open({ kind: 'library', title: '' })
}

/**
 * User request 2026-10-10: a plugin's sidebar entry opens its page — on the collection of the tab it
 * was opened from; from anywhere else the page stays as it was.
 */
export function openPluginPage(tabs: Tabs, page: { plugin: { id: string }; id: string }): string {
  const from = tabs.active
  const on =
    from?.kind === 'collection' && from.params.connectionId && from.params.db && from.params.coll
      ? { connectionId: from.params.connectionId, db: from.params.db, coll: from.params.coll }
      : null
  const existing = tabs.tabs.find(
    (t) => t.kind === 'pluginPage' && t.params.plugin === page.plugin.id && t.params.contribution === page.id,
  )
  if (existing && !on) {
    tabs.activate(existing.id)
    return existing.id
  }
  // Put there by the user's click: it opens without asking (review I2).
  if (on) usePluginsStore().choose(targetKey(page.plugin.id, page.id, on))
  return tabs.open({
    kind: 'pluginPage',
    title: '',
    params: { plugin: page.plugin.id, contribution: page.id, ...(on ?? {}) },
  })
}

/** User request 2026-10-10: a plugin's own page of details. */
export const openPluginDetailsTab = (tabs: Tabs, pluginId: string): string =>
  tabs.open({ kind: 'pluginDetails', title: '', params: { pluginId } })
