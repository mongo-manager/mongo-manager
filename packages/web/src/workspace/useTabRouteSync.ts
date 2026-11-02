import { watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { connectionsApi, queryKeys } from '@/api/connections'
import { useSessionStore } from '@/stores/session'
import { useTabsStore, type WorkspaceTab } from '@/stores/tabs'
import { useToastStore } from '@/stores/toasts'
import { tabInputFromRoute, tabLocation } from './tabRoutes'

/**
 * Keeps the URL and the active tab in step (spec §6.2: tabs persisted in the URL).
 * - The URL opens its tab: at load, from a pasted link, and on back or forward. A connection
 *   that is not in the user's list (no access, deleted, list unavailable) opens nothing, and
 *   neither do the users and audit screens without their permission.
 * - Activating a tab pushes its path, so the browser history walks through the tabs; a link
 *   written differently is replaced by the tab's own path, adding no history step.
 * A URL is only a request to show something: every read is still decided by the server.
 */
export function useTabRouteSync(): void {
  const route = useRoute()
  const router = useRouter()
  const tabs = useTabsStore()
  const session = useSessionStore()
  const toasts = useToastStore()
  const { t } = useI18n()
  const { data: connections, isError } = useQuery({
    queryKey: queryKeys.connections,
    queryFn: connectionsApi.list,
  })

  /** False while a link waits for the connection list; the tabs do not overwrite the URL meanwhile. */
  let applied = false
  /** Only the first visit to the root shows the tab restored from an earlier session. */
  let first = true
  /** The canonical path a link is being replaced with, not to be pushed as well. */
  let replacing: string | null = null

  /** The path of a tab, or null for a tab that cannot have one (never throws). */
  function pathOf(tab: WorkspaceTab | null): string | null {
    if (!tab) return null
    try {
      return router.resolve(tabLocation(tab)).fullPath
    } catch {
      return null
    }
  }

  function refuse(): void {
    applied = true
    toasts.push({ kind: 'error', message: t('workspace.linkUnavailable') })
    void router.replace({ name: 'workspace' })
  }

  const allowed = (kind: string): boolean =>
    kind === 'users'
      ? session.status?.mode === 'team' && session.can('users:manage')
      : kind === 'audit'
        ? session.can('audit:read')
        : kind === 'destinations' || kind === 'aiSettings' || kind === 'plugins' || kind === 'pluginDetails'
          ? session.can('settings:manage')
          : true

  function applyRoute(): void {
    const input = tabInputFromRoute(route)
    const wasFirst = first
    first = false
    if (!input) {
      applied = true
      // Opening the app at its root shows the tab restored from the last visit; going back to the
      // root later (history) leaves the tabs as they are.
      const restored = tabs.active && tabs.active.kind !== 'welcome' ? pathOf(tabs.active) : null
      if (wasFirst && restored) void router.replace(restored)
      return
    }
    if (!allowed(input.kind)) return refuse()
    const connectionId = input.params?.connectionId
    if (connectionId !== undefined) {
      const list = connections.value
      if (!list) {
        if (isError.value) refuse() // The list cannot be read: nothing to check the link against.
        return // Otherwise wait for it: the connection's name and whether it may be shown.
      }
      const found = list.find((c) => c.id === connectionId)
      if (!found) return refuse()
      if (input.kind === 'connection') input.title = found.name
    }
    applied = true
    tabs.open(input)
    const canonical = pathOf(tabs.active)
    // The tab's path changes to this one (a link to no AI history request shows the list): the
    // replace below says so, the tab watcher must not push it as a step of its own (page review M1).
    // The same tab written differently (escapes, a trailing slash) resolves to the same params,
    // which the router treats as no move at all: force the canonical path in place.
    if (canonical && canonical !== route.fullPath) {
      replacing = canonical
      void router.replace({ path: canonical, force: true }).finally(() => {
        if (replacing === canonical) replacing = null
      })
    }
  }

  watch(
    [() => route.fullPath, connections, isError],
    () => {
      // A route that already shows the active tab needs nothing.
      if (applied && pathOf(tabs.active) === route.fullPath) return
      applyRoute()
    },
    { immediate: true },
  )

  // W6.1 review (minor 9): the tab in use before the last change, and the split's two tabs then, to
  // tell a move between panes that were already side by side (re-review minor 2: opening beside, or
  // putting another tab in a pane, is a step of its own).
  const pairOf = () => (tabs.split ? `${tabs.split.left}\n${tabs.split.right}` : '')
  let pairBefore = pairOf()
  let before = tabs.activeId
  watch(
    () => tabs.activeId,
    (_id, old) => (before = old),
    { flush: 'sync' },
  )

  // The user chose a tab, or what a tab shows changed (an AI history request opened): its URL.
  watch(
    () => pathOf(tabs.active),
    () => {
      const previous = before
      const pairThen = pairBefore
      before = tabs.activeId
      pairBefore = pairOf()
      // The user chose a tab: a link still waiting for the list is dropped, never opened later.
      applied = true
      const target = pathOf(tabs.active)
      if (target !== null && target === replacing) {
        replacing = null
        return
      }
      if (!target || target === route.fullPath) return
      // The route already names this tab, only written differently: applyRoute replaces it.
      const resolved = router.resolve(target)
      const same =
        resolved.name === route.name && JSON.stringify(resolved.params) === JSON.stringify(route.params)
      // W6.1 review (minor 9): going from one pane to the other is no step in the history.
      const panes = tabs.panes
      const paneSwitch =
        !!panes &&
        pairThen === pairBefore &&
        previous !== tabs.activeId &&
        [panes.left, panes.right].includes(previous)
      if (!same) void (paneSwitch ? router.replace(target) : router.push(target))
    },
  )
}
