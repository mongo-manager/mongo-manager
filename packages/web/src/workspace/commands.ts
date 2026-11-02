import { BACKUP_SYSTEM_DATABASES } from '@mongo-manager/shared/browser'
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { connectedNow } from '@/connections/reachability'
import { connectionsApi, queryKeys } from '@/api/connections'
import { useSignOut } from '@/auth/signOut'
import { useCommandsStore } from '@/stores/commands'
import { useCollectionViewsStore } from '@/stores/collectionViews'
import { useTabSectionsStore } from '@/stores/tabSections'
import { usePreferencesStore } from '@/stores/preferences'
import { LOCALES, LOCALE_NAMES } from '@/i18n'
import { useSessionStore } from '@/stores/session'
import { useTabsStore } from '@/stores/tabs'
import { useToastStore } from '@/stores/toasts'
import { usePlacesStore } from '@/stores/places'
import { useWorkspaceDialogs } from '@/stores/workspaceDialogs'
import { aiApi, aiKeys } from '@/api/ai'
import { aiOffered } from '@/ai/useAi'
import { actionsFor } from '@/ai/insert'
import { useAssistantStore } from '@/ai/chat/store'
import { localized, usePluginsStore } from '@/plugins/store'
import {
  openAboutTab,
  openAccountTab,
  openLibraryTab,
  openPluginPage,
  openSchedulesTab,
  openLiveSyncsTab,
  openJobsTab,
  openAiHistoryTab,
  openAuditTab,
  openConnectionTab,
  openConnectionShell,
  openSqlTransferTab,
  openUsersTab,
  openAiSettingsTab,
  openPluginsTab,
  openDestinationsTab,
  openAlertsTab,
} from './openTabs'

/** Registers the workspace's palette commands for as long as the calling component lives. */
export function useWorkspaceCommands(): void {
  const { t, locale } = useI18n()
  const commands = useCommandsStore()
  const preferences = usePreferencesStore()
  const session = useSessionStore()
  const tabs = useTabsStore()
  const toasts = useToastStore()
  const places = usePlacesStore()
  const dialogs = useWorkspaceDialogs()
  const plugins = usePluginsStore()
  const views = useCollectionViewsStore()
  const tabSections = useTabSectionsStore()
  const signOut = useSignOut()
  const { data: connections } = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
  const queryClient = useQueryClient()
  /**
   * A connection's rights. A command run right after the page loads, before the list arrived, waits
   * for it (it did nothing at all; phase 3e-2 final gate).
   */
  const connectionOf = async (id: string) => {
    const list =
      connections.value ??
      (await queryClient.fetchQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list }))
    return (list ?? []).find((c) => c.id === id)
  }
  /**
   * User reports 2026-10-23: nothing that works on the server opens while the app is not connected
   * to it (reachability.ts); it says so, by the connection's name (second review, M1).
   */
  const refusedNotConnected = async (connection: { id: string; name: string }): Promise<boolean> => {
    // Saying so while it reads, and no longer once it answered (fourth review, M3).
    const reading = () => {
      const id = toasts.push({ kind: 'info', message: t('health.connecting', { name: connection.name }) })
      return () => toasts.dismiss(id)
    }
    if (await connectedNow(queryClient, connection.id, reading)) return false
    toasts.push({ kind: 'error', message: t('health.noConnection', { name: connection.name }) })
    return true
  }
  const fixed: Array<() => void> = []
  let perConnection: Array<() => void> = []

  onMounted(() => {
    fixed.push(
      commands.register({
        id: 'theme',
        title: () => t('palette.commands.toggleTheme'),
        run: () => preferences.toggleTheme(),
      }),
      // Languages (2026-10-29): one command a language, each named in its own language.
      ...LOCALES.map((locale) =>
        commands.register({
          id: `language.${locale}`,
          title: () => `${t('palette.commands.switchLanguage')}: ${LOCALE_NAMES[locale]}`,
          // Review of the languages (minor 6): "language" in every language, so it is found in each.
          keywords: `language dil 语言 言語 idioma 언어 Sprache langue язык ${locale} ${LOCALE_NAMES[locale]}`,
          when: () => preferences.locale !== locale,
          run: () => void preferences.setLocale(locale),
        }),
      ),
      commands.register({
        id: 'account',
        title: () => t('palette.commands.account'),
        keywords: 'profile password 2fa hesap şifre',
        run: () => void openAccountTab(tabs),
      }),
      commands.register({
        id: 'library',
        title: () => t('palette.commands.library'),
        keywords: 'library queries favourites pipelines snippets history sorgular kitaplık favoriler geçmiş',
        run: () => void openLibraryTab(tabs),
      }),
      commands.register({
        id: 'schedules',
        title: () => t('palette.commands.schedules'),
        keywords: 'schedule scheduled backup cron retention zamanlanmış yedek',
        run: () => void openSchedulesTab(tabs),
      }),
      commands.register({
        id: 'jobs',
        title: () => t('palette.commands.jobs'),
        keywords: 'jobs background export import backup progress arka plan işler ilerleme',
        run: () => void openJobsTab(tabs),
      }),
      commands.register({
        id: 'aiHistory',
        title: () => t('palette.commands.aiHistory'),
        keywords: 'ai history usage tokens cost price prompt answer yapay zeka geçmiş kullanım maliyet token',
        run: () => void openAiHistoryTab(tabs),
      }),
      commands.register({
        id: 'liveSyncs',
        title: () => t('palette.commands.liveSyncs'),
        keywords: 'live sync mirror migrate replicate canlı senkron eşitle taşı',
        run: () => void openLiveSyncsTab(tabs),
      }),
      // User request 2026-10-31: the About page, for everyone.
      commands.register({
        id: 'about',
        title: () => t('palette.commands.about'),
        keywords: 'about version license author github info hakkında sürüm lisans yazar',
        run: () => void openAboutTab(tabs),
      }),
    )
    if (session.status?.mode === 'team' && session.can('users:manage')) {
      fixed.push(
        commands.register({
          id: 'users',
          title: () => t('palette.commands.users'),
          keywords: 'users kullanıcılar',
          run: () => void openUsersTab(tabs),
        }),
      )
    }
    // W3.3: alerts, for everyone (the bell's opt-in; rules and channels for administrators).
    fixed.push(
      commands.register({
        id: 'alerts',
        title: () => t('palette.commands.alerts'),
        keywords: 'alerts notifications thresholds webhook email smtp uyarılar bildirim eşik',
        run: () => void openAlertsTab(tabs),
      }),
    )
    if (session.can('settings:manage')) {
      fixed.push(
        commands.register({
          id: 'destinations',
          title: () => t('palette.commands.destinations'),
          keywords: 'backup destinations s3 drive webdav folder hedef yedek',
          run: () => void openDestinationsTab(tabs),
        }),
        // Phase 4a-1: the AI providers.
        commands.register({
          id: 'aiSettings',
          title: () => t('palette.commands.aiSettings'),
          keywords: 'ai assistant providers anthropic claude openai ollama llm yapay zeka sağlayıcı',
          run: () => void openAiSettingsTab(tabs),
        }),
        // Phase 4b §2: plugins.
        commands.register({
          id: 'plugins',
          title: () => t('palette.commands.plugins'),
          keywords: 'plugins extensions map eklenti uzantı harita',
          run: () => void openPluginsTab(tabs),
        }),
      )
    }
    if (session.can('audit:read')) {
      fixed.push(
        commands.register({
          id: 'audit',
          title: () => t('palette.commands.audit'),
          keywords: 'audit log denetim',
          run: () => void openAuditTab(tabs),
        }),
      )
    }
    fixed.push(
      // User request 2026-10-10: the palette's Recent, forgotten (listed only while it holds any).
      commands.register({
        id: 'places.clearRecent',
        title: () => t('palette.commands.clearRecent'),
        keywords: 'recent history forget clear son açılanlar geçmiş temizle unut',
        when: () => places.recent.length > 0,
        run: () => places.clearRecent(),
      }),
      commands.register({
        id: 'shortcuts',
        title: () => t('shortcuts.title'),
        keywords: 'keyboard keys kısayol klavye ?',
        run: () => dialogs.open({ kind: 'shortcuts' }),
      }),
      // Phase 3a-1: open a shell on the active tab's connection and database, when allowed. User
      // request 2026-10-11: on a connection's tab too (its address's database), and saying why not.
      commands.register({
        id: 'shell.open',
        title: () => t('palette.commands.openShell'),
        keywords: 'shell mongosh terminal konsol kabuk',
        run: async () => {
          const params = tabs.active?.params
          if (!params?.connectionId) return
          const connection = await connectionOf(params.connectionId)
          if (!connection) return
          if (!connection.shell)
            return void toasts.push({
              kind: 'error',
              message: t('shell.notAllowed', { name: connection.name }),
            })
          if (await refusedNotConnected(connection)) return
          openConnectionShell(tabs, connection, params.db || undefined)
        },
      }),
      // Phase 3e-1: the active tab's Watch section (collection, database or connection).
      commands.register({
        id: 'watch.open',
        title: () => t('palette.commands.watch'),
        keywords: 'watch change stream live feed changes oplog izle değişiklik canlı akış',
        run: async () => {
          const tab = tabs.active
          const p = tab?.params
          if (!tab || !p?.connectionId) return
          const connection = await connectionOf(p.connectionId)
          if (!connection?.permissions.includes('documents:read')) return
          if (await refusedNotConnected(connection)) return
          if (tab.kind === 'collection') views.stateFor(tab.id).section = 'watch'
          else if (tab.kind === 'database' || tab.kind === 'connection') tabSections.set(tab.id, 'watch')
        },
      }),
      // Phase 3d-1: import into, or export, the active tab's collection, when allowed there.
      commands.register({
        id: 'data.import',
        title: () => t('palette.commands.importData'),
        keywords: 'import csv json excel xlsx içe aktar yükle',
        run: async () => {
          const p = tabs.active?.kind === 'collection' ? tabs.active.params : undefined
          if (!p?.connectionId || !p.db || !p.coll) return
          const connection = await connectionOf(p.connectionId)
          if (!connection?.permissions.includes('documents:write')) return
          if (await refusedNotConnected(connection)) return
          dialogs.open({ kind: 'importData', connectionId: p.connectionId, db: p.db, coll: p.coll })
        },
      }),
      // SQL transfer: a SQL dump's tables into the active tab's database.
      commands.register({
        id: 'data.importSql',
        title: () => t('palette.commands.importSql'),
        // User request 2026-11-02: with the SQL → MongoDB plugin only.
        when: () => plugins.sqlOffered,
        keywords: 'sql dump mysqldump pg_dump postgres mysql sqlite import içe aktar döküm',
        run: async () => {
          const p = tabs.active?.params
          if (!p?.connectionId || !p.db || BACKUP_SYSTEM_DATABASES.includes(p.db)) return
          const connection = await connectionOf(p.connectionId)
          if (
            !connection?.permissions.includes('documents:write') ||
            !connection.permissions.includes('jobs:run')
          )
            return
          if (await refusedNotConnected(connection)) return
          dialogs.openImportSql(p.connectionId, p.db)
        },
      }),
      // User request 2026-10-11: the SQL ↔ MongoDB page from anywhere, and an export of the active
      // tab's database (one database at a time: user request 2026-10-12).
      commands.register({
        id: 'sql.open',
        title: () => t('sqlTransfer.title'),
        when: () => plugins.sqlOffered,
        keywords: 'sql import export dump mysql postgres sqlite içe dışa aktar',
        run: () => void openSqlTransferTab(tabs),
      }),
      commands.register({
        id: 'data.exportSql',
        title: () => t('palette.commands.exportSql'),
        when: () => plugins.sqlOffered,
        keywords: 'sql export dump mysql postgres sqlite dışa aktar',
        run: async () => {
          const p = tabs.active?.params
          if (!p?.connectionId) return
          const connection = await connectionOf(p.connectionId)
          if (!connection?.export) return
          if (await refusedNotConnected(connection)) return
          // The tab's database (with its collection chosen); from a connection, the page picks one.
          const db = p.db && !BACKUP_SYSTEM_DATABASES.includes(p.db) ? p.db : null
          void openSqlTransferTab(tabs, {
            part: 'export',
            connectionId: p.connectionId,
            ...(db ? { db } : {}),
            ...(db && p.coll ? { coll: p.coll } : {}),
          })
        },
      }),
      commands.register({
        id: 'data.export',
        title: () => t('palette.commands.exportData'),
        keywords: 'export csv json excel xlsx dışa aktar indir',
        run: async () => {
          const p = tabs.active?.kind === 'collection' ? tabs.active.params : undefined
          if (!p?.connectionId || !p.db || !p.coll) return
          const connection = await connectionOf(p.connectionId)
          if (!connection?.export) return
          if (await refusedNotConnected(connection)) return
          dialogs.open({ kind: 'exportData', connectionId: p.connectionId, db: p.db, coll: p.coll })
        },
      }),
      // Phase 3d-3a: back up, or restore into, the active tab's connection, database or collection.
      commands.register({
        id: 'backup.dump',
        title: () => t('palette.commands.backupDump'),
        keywords: 'backup dump mongodump archive yedek yedekle',
        run: async () => {
          const p = tabs.active?.params
          if (!p?.connectionId) return
          const connection = await connectionOf(p.connectionId)
          if (!connection?.export || !connection.permissions.includes('jobs:run')) return
          if (await refusedNotConnected(connection)) return
          // A system database is never backed up: from its tab, the server's backup is offered.
          const db = p.db && !BACKUP_SYSTEM_DATABASES.includes(p.db) ? p.db : undefined
          dialogs.open({
            kind: 'backupDump',
            connectionId: p.connectionId,
            ...(db ? { db } : {}),
            ...(db && p.coll ? { coll: p.coll } : {}),
          })
        },
      }),
      commands.register({
        id: 'backup.restore',
        title: () => t('palette.commands.backupRestore'),
        keywords: 'restore mongorestore archive geri yükle yedek',
        run: async () => {
          const p = tabs.active?.params
          if (!p?.connectionId) return
          const connection = await connectionOf(p.connectionId)
          if (
            !connection?.permissions.includes('documents:write') ||
            !connection.permissions.includes('jobs:run')
          )
            return
          if (await refusedNotConnected(connection)) return
          const db = p.db && !BACKUP_SYSTEM_DATABASES.includes(p.db) ? p.db : undefined
          dialogs.open({ kind: 'backupRestore', connectionId: p.connectionId, ...(db ? { db } : {}) })
        },
      }),
      // Phase 3d-2: copy or compare the active tab's collection (reading it out, as an export).
      ...(['copy', 'compare'] as const).map((what) =>
        commands.register({
          id: `data.${what}`,
          title: () => t(what === 'copy' ? 'palette.commands.copyData' : 'palette.commands.compareData'),
          keywords: what === 'copy' ? 'copy clone kopyala çoğalt' : 'compare diff sync karşılaştır eşitle',
          run: async () => {
            const p = tabs.active?.kind === 'collection' ? tabs.active.params : undefined
            if (!p?.connectionId || !p.db || !p.coll) return
            const connection = await connectionOf(p.connectionId)
            if (!connection?.export) return
            if (await refusedNotConnected(connection)) return
            dialogs.open({
              kind: 'copyData',
              connectionId: p.connectionId,
              db: p.db,
              coll: p.coll,
              compare: what === 'compare',
            })
          },
        }),
      ),
      // Phase 3e-2: keep the active tab's collection in sync on another connection.
      commands.register({
        id: 'data.liveSync',
        title: () => t('palette.commands.liveSync'),
        keywords: 'live sync mirror migrate keep in sync canlı senkron eşitle taşı',
        run: async () => {
          const p = tabs.active?.kind === 'collection' ? tabs.active.params : undefined
          if (!p?.connectionId || !p.db || !p.coll) return
          const connection = await connectionOf(p.connectionId)
          if (!connection?.export) return
          if (await refusedNotConnected(connection)) return
          dialogs.open({ kind: 'liveSync', connectionId: p.connectionId, db: p.db, coll: p.coll })
        },
      }),
      // Phase 4a-1: ask the assistant about the active collection tab.
      commands.register({
        id: 'ai.ask',
        title: () => t('palette.commands.askAi'),
        keywords: 'ai assistant ask query pipeline explain llm claude yapay zeka asistan sor',
        run: async () => {
          const tab = tabs.active
          const p = tab?.kind === 'collection' ? tab.params : undefined
          if (!tab || !p?.connectionId || !p.db || !p.coll) return
          const connection = await connectionOf(p.connectionId)
          const status = await queryClient.fetchQuery({ queryKey: aiKeys.status, queryFn: aiApi.status })
          if (!aiOffered(status, connection)) return
          if (connection && (await refusedNotConnected(connection))) return
          const section = useCollectionViewsStore().stateFor(tab.id).section
          dialogs.open({
            kind: 'ai',
            connectionId: p.connectionId,
            db: p.db,
            coll: p.coll,
            tabId: tab.id,
            actions: actionsFor(section, false),
          })
        },
      }),
      // Phase 4a-2: the assistant's panel, and a new chat in it.
      commands.register({
        id: 'assistant.open',
        title: () => t('palette.commands.assistant'),
        keywords: 'ai assistant chat sohbet asistan yapay zeka',
        run: async () => {
          const status = await queryClient.fetchQuery({ queryKey: aiKeys.status, queryFn: aiApi.status })
          if (status?.enabled) useAssistantStore().show()
        },
      }),
      commands.register({
        id: 'assistant.new',
        title: () => t('palette.commands.newChat'),
        keywords: 'ai new chat yeni sohbet',
        run: async () => {
          const status = await queryClient.fetchQuery({ queryKey: aiKeys.status, queryFn: aiApi.status })
          if (!status?.enabled) return
          const assistant = useAssistantStore()
          assistant.newChat()
          assistant.show()
        },
      }),
    )
    if (session.status?.mode === 'team') {
      fixed.push(
        commands.register({ id: 'logout', title: () => t('palette.commands.logout'), run: () => signOut() }),
      )
    }
    if (session.can('connections:manage')) {
      fixed.push(
        commands.register({
          id: 'connection.new',
          title: () => t('palette.commands.newConnection'),
          keywords: 'add connection bağlantı ekle',
          run: () => dialogs.open({ kind: 'connection' }),
        }),
        commands.register({
          id: 'connections.import',
          title: () => t('palette.commands.importConnections'),
          keywords: 'import içe aktar',
          run: () => dialogs.open({ kind: 'importConnections' }),
        }),
        commands.register({
          id: 'connections.export',
          title: () => t('palette.commands.exportConnections'),
          keywords: 'export dışa aktar',
          run: () => dialogs.open({ kind: 'exportConnections' }),
        }),
      )
    }
  })

  watch(
    connections,
    (list) => {
      for (const off of perConnection.splice(0)) off()
      perConnection = (list ?? []).flatMap((c) => [
        commands.register({
          id: `connection.open:${c.id}`,
          title: () => t('palette.commands.openConnection', { name: c.name }),
          keywords: c.group ?? '',
          run: () => {
            openConnectionTab(tabs, c)
          },
        }),
        // User request 2026-10-11: a shell on any connection one may, from anywhere.
        ...(c.shell
          ? [
              commands.register({
                id: `shell.open:${c.id}`,
                title: () => t('palette.commands.openShellOn', { name: c.name }),
                keywords: `shell mongosh terminal konsol kabuk ${c.group ?? ''}`,
                run: async () => {
                  if (!(await refusedNotConnected(c))) openConnectionShell(tabs, c)
                },
              }),
            ]
          : []),
      ])
    },
    { immediate: true },
  )

  // User request 2026-10-10 (review M10): each plugin page is a place to go, as the app's own.
  let perPluginPage: Array<() => void> = []
  watch(
    () => plugins.sidebarPanels,
    (pages) => {
      for (const off of perPluginPage.splice(0)) off()
      perPluginPage = pages.map((page) =>
        commands.register({
          id: `plugin.page:${page.plugin.id}:${page.id}`,
          title: () => t('plugins.page.command', { title: localized(page.title, locale.value) }),
          keywords: 'plugin eklenti',
          run: () => void openPluginPage(tabs, page),
        }),
      )
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    for (const off of [...fixed.splice(0), ...perConnection.splice(0), ...perPluginPage.splice(0)]) off()
  })
}
