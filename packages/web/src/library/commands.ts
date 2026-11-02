import { computed, onBeforeUnmount, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQueryClient } from '@tanstack/vue-query'
import type { LibraryItem } from '@mongo-manager/shared/browser'
import { libraryApi } from '@/api/library'
import { queryKeys, type ConnectionDto } from '@/api/connections'
import { useCommandsStore, type Command } from '@/stores/commands'
import { ApiError } from '@/api/client'
import { useTabsStore } from '@/stores/tabs'
import { openLibraryItem } from './openItem'

/** How long a connection's list is reused before the palette asks again. */
export const PALETTE_CACHE_MS = 30_000
const PALETTE_LIMIT = 100
/** Answers that say the list is no longer the caller's to see. */
const GONE = new Set([401, 403, 404])

/**
 * Phase 2c spec §3: while the palette is open, saved favourites, pipelines and (phase 3a-2) shell
 * snippets are commands that open them. History stays on the Queries page. W5: those of every
 * connection open in a tab (the active one first), each connection a group of its own; a
 * connection whose tabs all close leaves the palette.
 */
export function useLibraryCommands(paletteOpen: Ref<boolean>): void {
  const { t } = useI18n()
  const commands = useCommandsStore()
  const tabs = useTabsStore()
  const queryClient = useQueryClient()
  /** The connections open in tabs, the active tab's first. */
  const open = computed(() => {
    const ids: string[] = []
    const add = (id: string | undefined) => {
      if (id && !ids.includes(id)) ids.push(id)
    }
    add(tabs.active?.params.connectionId)
    for (const tab of tabs.tabs) add(tab.params.connectionId)
    return ids
  })
  const registered = new Map<string, Array<() => void>>()
  const cachedAt = new Map<string, number>()
  const loading = new Set<string>()

  function unregister(id: string): void {
    for (const off of registered.get(id)?.splice(0) ?? []) off()
    registered.delete(id)
  }

  async function load(id: string): Promise<void> {
    if (loading.has(id)) return
    const at = cachedAt.get(id)
    if (at !== undefined && Date.now() - at < PALETTE_CACHE_MS) return
    loading.add(id)
    try {
      // One request per type, so a long history cannot crowd saved items out.
      // Phase 3a-2: shell snippets too (the server lists them only to those who may use the shell).
      const lists = await Promise.all(
        (['favourite', 'pipeline', 'snippet'] as const).map((type) =>
          libraryApi.search(id, { type, limit: PALETTE_LIMIT }),
        ),
      )
      // Its tabs closed while it loaded: nothing of it is listed.
      if (!open.value.includes(id)) return
      unregister(id)
      cachedAt.set(id, Date.now())
      registered.set(id, [
        commands.registerMany(lists.flatMap((list) => list.items).map((item) => command(id, item))),
      ])
    } catch (e) {
      // The palette still works without them; the Queries page shows the error. A list the server now
      // refuses (signed out, access taken away, the connection gone) is not shown from before (review).
      if (e instanceof ApiError && GONE.has(e.status)) {
        unregister(id)
        cachedAt.delete(id)
      }
    } finally {
      loading.delete(id)
    }
  }

  /** The connection's name as the app lists it (the tab's title before the list is known). */
  function connectionName(id: string): string {
    const listed = queryClient.getQueryData<ConnectionDto[]>(queryKeys.connections)?.find((c) => c.id === id)
    if (listed) return listed.name
    return tabs.tabs.find((tab) => tab.kind === 'connection' && tab.params.connectionId === id)?.title ?? id
  }

  function command(id: string, item: LibraryItem): Command {
    const key =
      item.type === 'favourite'
        ? 'library.palette.favourite'
        : item.type === 'snippet'
          ? 'library.palette.snippet'
          : 'library.palette.pipeline'
    return {
      id: `library.open:${id}:${item.type}:${item.id}`,
      title: () => t(key, { name: item.name ?? '', ns: `${item.db}.${item.coll}` }),
      keywords: `${item.tags.join(' ')} ${connectionName(id)}`,
      group: { id: `saved:${id}`, label: () => t('palette.groups.savedIn', { name: connectionName(id) }) },
      run: () => void openLibraryItem(id, item, { t, queryClient }).catch(() => undefined),
    }
  }

  watch(paletteOpen, (isOpen) => {
    if (isOpen) for (const id of open.value) void load(id)
  })
  watch(open, (ids) => {
    for (const id of [...registered.keys(), ...cachedAt.keys()])
      if (!ids.includes(id)) {
        unregister(id)
        cachedAt.delete(id)
      }
  })
  onBeforeUnmount(() => {
    for (const id of [...registered.keys()]) unregister(id)
  })
}
