import type { WorkspaceTab } from '@/stores/tabs'

/**
 * User request 2026-10-12: the collection tabs of a database are gathered into one tab of the
 * database while the user is elsewhere — on another database, or another page — and shown one by one
 * again when they come back to it (its group opened, or one of its collections opened). A database
 * with one collection tab open is never gathered; its own tab, when open, goes into the group too.
 *
 * Nothing is stored: whether a group is gathered follows from the tab in use, so it is gathered again
 * each time the user leaves. A tab of any kind on the database (its shell, a plugin page on it) keeps
 * its group open: the user is working on that database (review 2026-10-12, minor 21). The tabs keep
 * their order and their state; the group stands where its first tab is.
 */

/** The database a tab is on — a collection's, a shell's, a page's — or null for one on none. */
export function placeKey(tab: WorkspaceTab): string | null {
  const { connectionId, db } = tab.params
  return connectionId && db ? JSON.stringify([connectionId, db]) : null
}

/** The database a tab is grouped under: a collection's tab or the database's own; else null. */
export function groupKey(tab: WorkspaceTab): string | null {
  return tab.kind === 'collection' || tab.kind === 'database' ? placeKey(tab) : null
}

export interface TabGroup {
  key: string
  connectionId: string
  db: string
  /** Its tabs, in the strip's order: its collections' and the database's own. */
  members: WorkspaceTab[]
  /** How many of them are collections (a group needs two). */
  collections: number
}

export type StripItem = { kind: 'tab'; tab: WorkspaceTab } | { kind: 'group'; group: TabGroup }

/** The databases with two or more collection tabs open, by key. */
export function tabGroups(tabs: readonly WorkspaceTab[]): Map<string, TabGroup> {
  const all = new Map<string, TabGroup>()
  for (const tab of tabs) {
    const key = groupKey(tab)
    if (!key) continue
    let group = all.get(key)
    if (!group) {
      group = { key, connectionId: tab.params.connectionId!, db: tab.params.db!, members: [], collections: 0 }
      all.set(key, group)
    }
    group.members.push(tab)
    if (tab.kind === 'collection') group.collections++
  }
  return new Map([...all].filter(([, group]) => group.collections >= 2))
}

/**
 * What the strip shows, in order: each tab — or, for a database the user is not on, its group. The
 * tabs `shown` beside it (W6.1: the split's panes) keep their databases' groups open too.
 */
export function stripItems(
  tabs: readonly WorkspaceTab[],
  activeId: string,
  shown: readonly string[] = [],
): StripItem[] {
  const groups = tabGroups(tabs)
  const here = new Set(
    [activeId, ...shown].flatMap((id) => {
      const tab = tabs.find((t) => t.id === id)
      const key = tab ? placeKey(tab) : null
      return key ? [key] : []
    }),
  )
  const items: StripItem[] = []
  const placed = new Set<string>()
  for (const tab of tabs) {
    const key = groupKey(tab)
    const group = key && !here.has(key) ? groups.get(key) : undefined
    if (!group) items.push({ kind: 'tab', tab })
    else if (!placed.has(group.key)) {
      placed.add(group.key)
      items.push({ kind: 'group', group })
    }
  }
  return items
}
