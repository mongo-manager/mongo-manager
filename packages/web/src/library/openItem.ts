// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { QueryClient } from '@tanstack/vue-query'
import { fillParams, paramsOf, serializeValue, type LibraryItem } from '@mongo-manager/shared/browser'
import { emptyDraft, type FindQuery, type QueryDraft } from '@/documents/queryBuild'
import { decodeValue, toQueryShell } from '@/documents/values'
import { documentKeys } from '@/api/documents'
import { cardsFromStages } from '@/aggregation/stages'
import { useCollectionViewsStore } from '@/stores/collectionViews'
import { useDialogStore } from '@/stores/dialogs'
import { useTabsStore } from '@/stores/tabs'
import { useToastStore } from '@/stores/toasts'
import { useShellInbox } from '@/stores/shellInbox'
import { queryKeys, type ConnectionDto } from '@/api/connections'
import { openCollectionTab, openShellTab } from '@/workspace/openTabs'

type Doc = Record<string, unknown>
type Translate = (key: string, values?: Record<string, unknown> | number) => string
const isDoc = (v: unknown): v is Doc => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * A find's parts as the query bar shows them, and as they run. Throws on a part it cannot read.
 * Query parameters (spec 2026-10-28): a template's {{parameters}} go in the bar as written, its
 * defaults in their fields; it runs with them filled in, or not at all (`query` null) while one has
 * no default.
 */
export function findParts(body: unknown, limit: number): { draft: QueryDraft; query: FindQuery | null } {
  const parts = isDoc(body) ? body : {}
  const shell = (v: unknown) => (isDoc(v) ? toQueryShell(decodeValue(v), 0) : '')
  const filter = isDoc(parts.filter) ? parts.filter : {}
  const hint = typeof parts.hint === 'string' ? parts.hint : isDoc(parts.hint) ? parts.hint : undefined
  const query: FindQuery = { filter, skip: 0, limit }
  if (isDoc(parts.projection)) query.projection = parts.projection
  if (isDoc(parts.sort)) query.sort = parts.sort
  if (isDoc(parts.collation)) query.collation = parts.collation
  if (hint !== undefined) query.hint = hint
  const draft: QueryDraft = {
    ...emptyDraft(),
    limit,
    filter: Object.keys(filter).length > 0 ? shell(filter) : '',
    projection: shell(parts.projection),
    sort: shell(parts.sort),
    collation: shell(parts.collation),
    hint: typeof hint === 'string' ? hint : shell(hint),
  }
  const names = paramsOf(query)
  if (names.length === 0) return { draft, query }
  const given = isDoc(parts.params) ? parts.params : {}
  const defaults = Object.fromEntries(
    names.flatMap((n) => (typeof given[n] === 'string' ? [[n, given[n] as string]] : [])),
  )
  draft.params = defaults
  const decoded = Object.fromEntries(
    (['filter', 'projection', 'sort', 'collation', 'hint'] as const).flatMap((k) =>
      isDoc(query[k]) ? [[k, decodeValue(query[k])]] : [],
    ),
  )
  const filled = fillParams(decoded, defaults)
  if (!filled.ok) return { draft, query: null }
  const value = filled.value as Record<string, unknown>
  const run: FindQuery = { ...query }
  for (const [k, v] of Object.entries(value))
    (run as unknown as Record<string, unknown>)[k] = serializeValue(v) as Record<string, unknown>
  return { draft, query: run }
}

/**
 * Phase 2c: opens a library item in its collection's tab. A find runs in Documents (again, when it
 * is the query already shown); a pipeline replaces the Aggregations cards, after asking when the
 * tab already has some. The collection may have been dropped since: the tab opens and shows what
 * the server answers. An item that cannot be read says so, and changes nothing.
 */
export async function openLibraryItem(
  connectionId: string,
  item: LibraryItem,
  deps: {
    t: Translate
    queryClient?: QueryClient
    explain?: boolean
    /** W5: where Documents starts and its page size (a shell result's skip and limit). */
    paging?: { skip?: number; limit?: number }
  },
): Promise<boolean> {
  const { t } = deps
  const toasts = useToastStore()
  if (item.kind === 'shell') return openSnippet(connectionId, item, deps.queryClient)
  if (item.kind === 'find') {
    let parts: ReturnType<typeof findParts>
    try {
      parts = findParts(item.body, 20)
    } catch {
      toasts.push({ kind: 'error', message: t('library.unreadable') })
      return false
    }
    const tabId = openCollectionTab(useTabsStore(), connectionId, item.db, item.coll)
    const state = useCollectionViewsStore().stateFor(tabId)
    const limit = deps.paging?.limit ?? state.draft.limit
    const skip = deps.paging?.skip ?? 0
    state.section = 'documents'
    state.draft = { ...parts.draft, limit, skip: skip > 0 ? String(skip) : '' }
    // A parameter with no default: the template waits in the bar for its value.
    if (parts.query === null) {
      toasts.push({ kind: 'info', message: t('library.paramsNeeded', { name: item.name ?? '' }) })
      return true
    }
    state.query = { ...parts.query, limit, skip }
    state.page = 0
    // The same query as the one shown would come from the cache: it runs again (final review 2c, Minor 17).
    void deps.queryClient?.invalidateQueries({
      queryKey: documentKeys.all({ connectionId, db: item.db, coll: item.coll }),
    })
    if (deps.explain) askExplain(state, 'documents')
    return true
  }
  const { cards, unreadable } = cardsFromStages(item.body)
  const tabId = openCollectionTab(useTabsStore(), connectionId, item.db, item.coll)
  const state = useCollectionViewsStore().stateFor(tabId)
  const agg = state.aggregation
  const hasWork = agg.cards.length > 0 || (agg.textMode && agg.text.trim() !== '')
  if (hasWork) {
    const ok = await useDialogStore().confirm({
      title: t('library.replaceTitle'),
      message: t('library.replaceMessage', { ns: `${item.db}.${item.coll}` }),
      confirmLabel: t('library.replace'),
    })
    if (!ok) return false
  }
  if (unreadable > 0) toasts.push({ kind: 'error', message: t('aggregation.saved.unreadable', unreadable) })
  agg.cards = cards
  agg.textMode = false
  agg.saved =
    item.type === 'pipeline' && item.mine && item.name
      ? { id: item.id, name: item.name, shared: item.shared, tags: item.tags }
      : null
  state.section = 'aggregations'
  if (deps.explain) askExplain(state, 'aggregation')
  return true
}

/**
 * Phase 3a-2 spec §3.5: a snippet opens in its connection's shell — the one already open, else a new
 * one on the connection's default database (or test). The tab takes it from the inbox and shows the
 * parameter form; nothing runs.
 */
function openSnippet(connectionId: string, item: LibraryItem, queryClient?: QueryClient): boolean {
  useShellInbox().deliver(connectionId, item.id)
  const tabs = useTabsStore()
  const isShellOf = (tab: { kind: string; params: Record<string, string> } | null) =>
    tab?.kind === 'shell' && tab.params.connectionId === connectionId
  // The active shell of this connection first, else any of its shells.
  const open = isShellOf(tabs.active) ? tabs.active : tabs.tabs.find(isShellOf)
  if (open) {
    tabs.activate(open.id)
    return true
  }
  const connection = queryClient
    ?.getQueryData<ConnectionDto[]>(queryKeys.connections)
    ?.find((c) => c.id === connectionId)
  const db = connection?.settings.defaultDatabase || 'test'
  openShellTab(tabs, connectionId, db, `${connection?.name ?? connectionId} · ${db}`)
  return true
}

/** Phase 3b §3.2: the tab shows its Explain section and explains the query just set (a new request). */
function askExplain(
  state: ReturnType<ReturnType<typeof useCollectionViewsStore>['stateFor']>,
  source: 'documents' | 'aggregation',
): void {
  state.explain.source = source
  state.explain.request++
  state.section = 'explain'
}
