// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { DatabaseNameSchema } from '@mongo-manager/shared/browser'
import { groupKey, placeKey, stripItems, tabGroups, type TabGroup } from '@/workspace/tabGroups'

export interface WorkspaceTab {
  id: string
  kind: string
  title: string
  params: Record<string, string>
}
export type TabInput = { kind: string; title: string; params?: Record<string, string> }

const KEY = 'mm:tabs'
const WELCOME: WorkspaceTab = { id: 'welcome', kind: 'welcome', title: '', params: {} }

/**
 * User review 2026-10-09 ("url ai-history/istekId olsun"): what a tab shows inside it, not which tab
 * it is — the same tab moves from one to another, and its URL says which.
 */
const VIEW_PARAMS: Record<string, readonly string[]> = {
  aiHistory: ['requestId'],
  // Phase 4c §3: the audit log opened on one user (from their activity).
  audit: ['userId'],
  // User request 2026-10-10: a plugin's page, on the collection it was opened from.
  pluginPage: ['connectionId', 'db', 'coll'],
  // User request 2026-10-11: SQL ↔ MongoDB, on the connection and database it works in.
  sqlTransfer: ['part', 'connectionId', 'db', 'coll'],
}
/** A view param's value is an id the app wrote (a UUID); anything else is dropped (page review M5). */
const VIEW_VALUE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** A name (a database, a collection, a connection id): 1–255 characters, no NUL. */
const NAME_VALUE = { test: (v: string) => v.length > 0 && v.length <= 255 && !v.includes('\0') }
/** SQL ↔ MongoDB's params: which part, a connection's id, names. */
const SQL_VALUES: Record<string, { test(v: string): boolean }> = {
  part: /^(import|export)$/,
  connectionId: NAME_VALUE,
  db: { test: (v) => DatabaseNameSchema.safeParse(v).success },
  coll: NAME_VALUE,
}
/** What a kind's view params may hold. */
const viewValue = (kind: string, key = '') =>
  kind === 'pluginPage' ? NAME_VALUE : kind === 'sqlTransfer' ? (SQL_VALUES[key] ?? VIEW_VALUE) : VIEW_VALUE
/** The collection a plugin page is on. */
const PAGE_TARGET = ['connectionId', 'db', 'coll'] as const
/** The tab with only the view params it may have — a plugin page's collection only whole (review M2). */
function cleanView(tab: WorkspaceTab): WorkspaceTab {
  // The SQL plugin's page moved into the app (2026-10-11): a kept one is SQL ↔ MongoDB's.
  if (
    tab.kind === 'pluginPage' &&
    tab.params.plugin === 'sql-to-mongodb' &&
    tab.params.contribution === 'sql'
  )
    return cleanView({
      // The page's own id: one page, whichever way it was opened (review 2026-10-11).
      id: identity('sqlTransfer', {}),
      kind: 'sqlTransfer',
      title: '',
      params: { part: 'import', ...pick(tab.params) },
    })
  const view = VIEW_PARAMS[tab.kind]
  if (!view) return tab
  const params = Object.fromEntries(
    Object.entries(tab.params).filter(([k, v]) => !view.includes(k) || viewValue(tab.kind, k).test(v)),
  )
  if (tab.kind === 'pluginPage' && !PAGE_TARGET.every((k) => params[k]))
    for (const k of PAGE_TARGET) delete params[k]
  return { ...tab, params }
}
/** A moved SQL page's place: its connection and database, if it had them. */
const pick = (p: Record<string, string>) => ({
  ...(p.connectionId ? { connectionId: p.connectionId } : {}),
  ...(p.connectionId && p.db ? { db: p.db } : {}),
})
/** A plugin page's ids, as plugins name them (review M1): a kept page with others is dropped. */
const PLUGIN_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/
const CONTRIBUTION_ID = /^[a-z][a-z0-9-]*$/
const KIND_CHECK: Record<string, (params: Record<string, string>) => boolean> = {
  pluginDetails: (p) => p.pluginId!.length <= 64 && PLUGIN_ID.test(p.pluginId!),
  pluginPage: (p) =>
    p.plugin!.length <= 64 &&
    PLUGIN_ID.test(p.plugin!) &&
    p.contribution!.length <= 32 &&
    CONTRIBUTION_ID.test(p.contribution!),
}

const identity = (kind: string, params: Record<string, string>) =>
  `${kind}:${Object.keys(params)
    .filter((k) => !VIEW_PARAMS[kind]?.includes(k))
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&')}`

/** The params each kind of tab needs; a stored tab without them is dropped, never shown. */
const REQUIRED: Record<string, string[]> = {
  /** Overview, brought back beside other tabs (user review 2026-10-08: it must survive a reload). */
  welcome: [],
  connection: ['connectionId'],
  database: ['connectionId', 'db'],
  collection: ['connectionId', 'db', 'coll'],
  shell: ['connectionId', 'db'],
  /** Phase 3d-2: a comparison's results. */
  compare: ['jobId'],
  account: [],
  users: [],
  audit: [],
  /** Phase 4b §2: plugins (administrators). */
  plugins: [],
  /** Phase 3d-3b: backup destinations (administrators). */
  destinations: [],
  /** W3.3: alerts (everyone; administrators set rules and channels). */
  alerts: [],
  /** Phase 4a-1: AI providers (administrators). */
  aiSettings: [],
  /** Phase 3d-3c: scheduled backups (everyone; administrators see all). */
  schedules: [],
  /** Phase 3e-2: live syncs (everyone; administrators see all). */
  liveSyncs: [],
  /** User review 2026-10-08: the background jobs page (each user sees the jobs they may see). */
  jobs: [],
  /** User review 2026-10-09: the AI history (each user sees their own requests). */
  aiHistory: [],
  /** User request 2026-10-10: the Queries page (the Library), once a side panel. */
  library: [],
  /** User request 2026-10-10: a plugin's sidebar entry, a page (its collection is a view param). */
  pluginPage: ['plugin', 'contribution'],
  /** User request 2026-10-10: a plugin's details (administrators). */
  pluginDetails: ['pluginId'],
  /** User request 2026-10-11: SQL ↔ MongoDB (its connection and database are view params). */
  sqlTransfer: [],
  /** User request 2026-10-31: the About page. */
  about: [],
}

function validTab(t: unknown): t is WorkspaceTab {
  const tab = t as Partial<WorkspaceTab> | null
  if (!tab || typeof tab.id !== 'string' || typeof tab.kind !== 'string' || typeof tab.title !== 'string')
    return false
  const required = REQUIRED[tab.kind]
  const params = tab.params as Record<string, unknown> | undefined
  if (!required || typeof params !== 'object' || params === null || Array.isArray(params)) return false
  if (!Object.values(params).every((v) => typeof v === 'string')) return false
  if (!required.every((k) => typeof params[k] === 'string' && params[k] !== '')) return false
  return KIND_CHECK[tab.kind]?.(params as Record<string, string>) ?? true
}

/**
 * completion W6.1: two tabs side by side. One tab strip; the tab in use (`activeId`) is always the
 * focused pane's, so everything that follows the tab in use (the URL, the breadcrumbs, the palette)
 * follows the focused pane. Overview is never in a pane.
 */
export type PaneSide = 'left' | 'right'
export interface SplitState {
  left: string
  right: string
  focus: PaneSide
  /** The left pane's share of the width, 0.2–0.8. */
  ratio: number
}
export const SPLIT_MIN = 0.2
export const SPLIT_MAX = 0.8
const clampRatio = (n: number) => Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, n))

/** A stored split, kept only when it names two different open tabs, neither Overview. */
function keptSplit(raw: unknown, tabs: readonly WorkspaceTab[], activeId: string): SplitState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const s = raw as Record<string, unknown>
  const open = (id: unknown): id is string =>
    typeof id === 'string' && tabs.some((t) => t.id === id && t.kind !== 'welcome')
  if (!open(s.left) || !open(s.right) || s.left === s.right) return null
  if (s.focus !== 'left' && s.focus !== 'right') return null
  if (typeof s.ratio !== 'number' || !Number.isFinite(s.ratio)) return null
  // The pane in use is the one showing the active tab; a split without it is not restored — but for
  // Overview, which hides the split without ending it (review I3).
  const focus =
    activeId === s.left ? 'left' : activeId === s.right ? 'right' : activeId === WELCOME.id ? s.focus : null
  return focus ? { left: s.left, right: s.right, focus, ratio: clampRatio(s.ratio) } : null
}

interface Loaded {
  tabs: WorkspaceTab[]
  activeId: string
  owner: string | null
  /** A database's group key → the tab of it last in use (user request 2026-10-12). */
  lastIn: Record<string, string>
  split: SplitState | null
}

/**
 * The collection tab last in use of each database, for its group: only a key of a tab still open,
 * pointing at a collection of that database — whatever else storage holds is dropped.
 */
function keptLastIn(raw: unknown, tabs: readonly WorkspaceTab[]): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const kept: Record<string, string> = {}
  for (const [key, id] of Object.entries(raw as Record<string, unknown>)) {
    const tab = typeof id === 'string' ? tabs.find((t) => t.id === id) : undefined
    if (tab && tab.kind === 'collection' && groupKey(tab) === key) kept[key] = tab.id
  }
  return kept
}

function load(): Loaded {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? 'null') as {
      tabs?: unknown
      activeId?: unknown
      owner?: unknown
    } | null
    const owner = typeof parsed?.owner === 'string' ? parsed.owner : null
    const storedLastIn = (parsed as { lastIn?: unknown } | null)?.lastIn
    // A tab kept under another id (a moved plugin page) is still the one that was active.
    const renamed = new Map<string, string>()
    const tabs = Array.isArray(parsed?.tabs)
      ? (parsed.tabs as unknown[])
          .filter(validTab)
          .map((t) => {
            const clean = t.kind === 'welcome' ? WELCOME : cleanView(t)
            renamed.set(t.id, clean.id)
            return clean
          })
          // One SQL ↔ MongoDB page, even when a moved plugin page joins one kept.
          .filter(
            (t, i, all) => t.kind !== 'sqlTransfer' || all.findIndex((o) => o.kind === 'sqlTransfer') === i,
          )
      : []
    if (tabs.length > 0) {
      const wanted = typeof parsed?.activeId === 'string' ? renamed.get(parsed.activeId) : undefined
      const activeId = wanted && tabs.some((t) => t.id === wanted) ? wanted : tabs[0]!.id
      const split = keptSplit((parsed as { split?: unknown } | null)?.split, tabs, activeId)
      return { tabs, activeId, owner, lastIn: keptLastIn(storedLastIn, tabs), split }
    }
  } catch {
    // corrupt or blocked storage: start fresh
  }
  return { tabs: [WELCOME], activeId: WELCOME.id, owner: null, lastIn: {}, split: null }
}

export const useTabsStore = defineStore('tabs', () => {
  const initial = load()
  const tabs = ref<WorkspaceTab[]>(initial.tabs)
  const activeId = ref(initial.activeId)
  const active = computed(() => tabs.value.find((t) => t.id === activeId.value) ?? null)
  let owner = initial.owner
  let lastIn = initial.lastIn
  /** W6.1: the two tabs side by side, or null — kept while hidden (Overview, a narrow window). */
  const split = ref<SplitState | null>(initial.split)
  /** Whether the window is wide enough to show it (the layout tells; review minor 7). */
  const splitAllowed = ref(true)
  /**
   * The split as shown: none while Overview is in use or the window is narrow (review I3, minor 7) —
   * then it is left as it was, and the strip, closing and moving tabs act as without one.
   */
  const panes = computed<SplitState | null>(() => {
    const s = split.value
    const id = activeId.value
    return s && splitAllowed.value && (id === s.left || id === s.right) ? s : null
  })
  /** The tabs in use lately, newest first (memory only): what goes beside the tab opened beside. */
  let used: string[] = []

  // The collection in use is the one its database's group gives when the tab in use closes — the one
  // in use when the page loads too (review 2026-10-12, minor 10 and 11). Saved with whatever changed
  // the tab.
  watch(
    activeId,
    (id) => {
      const tab = tabs.value.find((t) => t.id === id)
      const key = tab?.kind === 'collection' ? groupKey(tab) : null
      if (key) lastIn = { ...lastIn, [key]: id }
      used = [id, ...used.filter((u) => u !== id)].slice(0, 20)
    },
    { flush: 'sync', immediate: true },
  )

  /**
   * The split as the tabs now stand: it ends when a pane's tab is gone; hidden (Overview, a narrow
   * window), it is left as it was; shown, the tab in use is the focused pane's — a tab activated
   * elsewhere is shown in the focused pane, one shown in a pane focuses it.
   */
  function fixSplit(): void {
    const s = split.value
    if (!s) return
    const open = (id: string) => tabs.value.some((t) => t.id === id)
    const active = tabs.value.find((t) => t.id === activeId.value)
    if (!open(s.left) || !open(s.right) || s.left === s.right || !active) split.value = null
    else if (active.kind === 'welcome' || !splitAllowed.value) return
    else if (active.id === s.left) split.value = s.focus === 'left' ? s : { ...s, focus: 'left' }
    else if (active.id === s.right) split.value = s.focus === 'right' ? s : { ...s, focus: 'right' }
    else split.value = { ...s, [s.focus]: active.id }
  }

  /** The tabs the panes show (none without a split): the strip never gathers their groups. */
  const shownIds = (): string[] => (panes.value ? [panes.value.left, panes.value.right] : [])

  /** The pane a tab is shown in, or null (none while the split is hidden). */
  const paneOf = (id: string): PaneSide | null =>
    panes.value?.left === id ? 'left' : panes.value?.right === id ? 'right' : null

  /** The layout says whether the window is wide enough; shown again, the split takes the tab in use. */
  function setSplitAllowed(allowed: boolean): void {
    if (splitAllowed.value === allowed) return
    splitAllowed.value = allowed
    if (allowed && split.value) persist()
  }

  /** The open tabs used lately, newest first, without Overview (review minor 6). */
  const recentTabs = (): string[] =>
    used.filter((id) => tabs.value.some((t) => t.id === id && t.kind !== 'welcome'))

  /** The other pane's tab, when the tabs closing take one pane's tab and not the other's. */
  function otherPane(closing: ReadonlySet<string>): string | null {
    const s = panes.value
    if (!s) return null
    if (closing.has(s.left) && !closing.has(s.right)) return s.right
    if (closing.has(s.right) && !closing.has(s.left)) return s.left
    return null
  }

  /** A database whose tabs are all closed is forgotten. */
  const forgetClosed = () => (lastIn = keptLastIn(lastIn, tabs.value))

  function persist(): void {
    // Every change ends here: the split follows it (W6.1).
    fixSplit()
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          // Overview alone is the empty workspace (nothing to keep); beside other tabs it is kept, in
          // its place, so a reload shows it again (user review 2026-10-08).
          tabs: tabs.value.length === 1 && tabs.value[0]!.kind === 'welcome' ? [] : tabs.value,
          activeId: activeId.value,
          owner,
          lastIn,
          // W6.1: restored after a reload as the tabs are.
          split: split.value,
        }),
      )
    } catch {
      // storage blocked: tabs just are not restored
    }
  }

  function open(input: TabInput): string {
    // What a link gives is checked as what is kept (review M3) — a moved page opened where it is now.
    const clean = cleanView({
      id: '',
      kind: input.kind,
      title: input.title,
      params: input.params ?? {},
    })
    const { kind, title, params } = clean
    const id = identity(kind, params)
    if (!tabs.value.some((t) => t.id === id)) {
      // Overview alone is the empty workspace, replaced by the first tab; beside others it stays.
      const kept = tabs.value.length === 1 && tabs.value[0]!.kind === 'welcome' ? [] : tabs.value
      tabs.value = [...kept, { id, kind, title, params }]
    } else if (VIEW_PARAMS[kind]) {
      // The same tab, asked to show something else in it (or its first view again).
      tabs.value = tabs.value.map((t) => (t.id === id ? { ...t, params } : t))
    }
    activeId.value = id
    persist()
    return id
  }

  /** What a tab shows inside it changes in place (its view params only; null removes one). */
  function setView(id: string, view: Record<string, string | null>): void {
    tabs.value = tabs.value.map((t) => {
      const allowed = VIEW_PARAMS[t.kind]
      if (t.id !== id || !allowed) return t
      const params = { ...t.params }
      for (const [key, value] of Object.entries(view)) {
        if (!allowed.includes(key)) continue
        if (value === null || !viewValue(t.kind, key).test(value)) delete params[key]
        else params[key] = value
      }
      return { ...t, params }
    })
    persist()
  }

  /** The tab a group gives: its collection last in use, else its first collection, of those staying. */
  function groupTarget(group: TabGroup, staying: (id: string) => boolean): WorkspaceTab | undefined {
    const members = group.members.filter((t) => staying(t.id))
    return (
      members.find((t) => t.id === lastIn[group.key]) ??
      members.find((t) => t.kind === 'collection') ??
      members[0]
    )
  }

  /**
   * The tab shown when the one in use closes: the nearest tab the strip shows of the same database
   * (review 2026-10-13, M3: closing the database's tab a group opened on left it, and its tabs
   * gathered at once), else the nearest, left first; a gathered group only when there is none —
   * opened on its collection last in use (review 2026-10-12, I2). Worked out before the tabs go.
   */
  function successor(closing: ReadonlySet<string>): string {
    // W6.1: a pane's tab closing leaves the other pane's tab in use.
    const other = otherPane(closing)
    if (other) return other
    const items = stripItems(tabs.value, activeId.value, shownIds())
    const at = items.findIndex((i) => i.kind === 'tab' && i.tab.id === activeId.value)
    const staying = (id: string) => !closing.has(id)
    const order = [...items.slice(0, Math.max(0, at)).reverse(), ...items.slice(at + 1)]
    const here = active.value ? placeKey(active.value) : null
    const shown = order.flatMap((item) => (item.kind === 'tab' && staying(item.tab.id) ? [item.tab] : []))
    const next = (here ? shown.find((tab) => placeKey(tab) === here) : undefined) ?? shown[0]
    if (next) return next.id
    for (const item of order) {
      const target = item.kind === 'group' ? lastInUse(item.group.key, staying) : undefined
      if (target) return target
    }
    return WELCOME.id
  }

  function close(id: string): void {
    if (!tabs.value.some((t) => t.id === id)) return
    const next = activeId.value === id ? successor(new Set([id])) : activeId.value
    const remaining = tabs.value.filter((t) => t.id !== id)
    tabs.value = remaining.length > 0 ? remaining : [WELCOME]
    activeId.value = next
    forgetClosed()
    persist()
  }

  function activate(id: string): void {
    if (tabs.value.some((t) => t.id === id)) {
      activeId.value = id
      persist()
    }
  }

  /** UI redesign R1 revision 2 §3.1: Overview comes back, first in the strip, and is shown. */
  function home(): void {
    if (!tabs.value.some((t) => t.kind === 'welcome')) tabs.value = [WELCOME, ...tabs.value]
    activeId.value = WELCOME.id
    persist()
  }

  /** Puts a tab at another place in the strip (UI redesign R1 plan ruling 8). */
  function move(id: string, toIndex: number): void {
    const from = tabs.value.findIndex((t) => t.id === id)
    if (from < 0) return
    const next = [...tabs.value]
    const [tab] = next.splice(from, 1)
    next.splice(Math.max(0, Math.min(next.length, toIndex)), 0, tab!)
    tabs.value = next
    persist()
  }

  /**
   * A tab one place left or right in the strip as it is shown (Ctrl/Cmd+Shift+arrows): past a gathered
   * group as one, never into it (review 2026-10-12, I1: it went inside, and nothing was seen to move).
   */
  function moveBy(id: string, step: -1 | 1): void {
    const items = stripItems(tabs.value, activeId.value, shownIds())
    const at = items.findIndex((i) => i.kind === 'tab' && i.tab.id === id)
    const neighbour = at < 0 ? undefined : items[at + step]
    if (!neighbour) return
    const others = tabs.value.filter((t) => t.id !== id)
    const ids = neighbour.kind === 'tab' ? [neighbour.tab.id] : neighbour.group.members.map((m) => m.id)
    const to =
      step === 1
        ? others.findLastIndex((t) => ids.includes(t.id)) + 1
        : others.findIndex((t) => ids.includes(t.id))
    move(id, to)
  }

  /** A group's tabs moved together, in their order, to a place among the others (a group dragged). */
  function moveGroup(key: string, toIndex: number): void {
    const group = tabGroups(tabs.value).get(key)
    if (!group) return
    const ids = new Set(group.members.map((m) => m.id))
    const others = tabs.value.filter((t) => !ids.has(t.id))
    const at = Math.max(0, Math.min(others.length, toIndex))
    tabs.value = [...others.slice(0, at), ...group.members, ...others.slice(at)]
    persist()
  }

  /** Closes every tab matching the predicate (e.g. all tabs of a deleted connection). */
  /**
   * Closes the tabs on a place that is gone. A plugin page is not closed with the collection it was
   * on: it leaves it, its own work kept (review I4).
   */
  function closeWhere(predicate: (tab: WorkspaceTab) => boolean): void {
    const before = tabs.value
    const remaining = before.flatMap((t) =>
      !predicate(t)
        ? [t]
        : t.kind === 'pluginPage'
          ? [
              {
                ...t,
                params: Object.fromEntries(
                  Object.entries(t.params).filter(([k]) => !(PAGE_TARGET as readonly string[]).includes(k)),
                ),
              },
            ]
          : [],
    )
    if (remaining.length === before.length && remaining.every((t, i) => t === before[i])) return
    const kept = new Set(remaining.map((t) => t.id))
    const next = kept.has(activeId.value)
      ? activeId.value
      : successor(new Set(before.filter((t) => !kept.has(t.id)).map((t) => t.id)))
    tabs.value = remaining.length > 0 ? remaining : [WELCOME]
    activeId.value = tabs.value.some((t) => t.id === next) ? next : tabs.value.at(-1)!.id
    forgetClosed()
    persist()
  }

  /** The tab a group gives when the tab in use closes: its collection last in use, else its first. */
  function lastInUse(key: string, staying: (id: string) => boolean = () => true): string | undefined {
    const group = tabGroups(tabs.value).get(key)
    return group ? groupTarget(group, staying)?.id : undefined
  }

  /**
   * User request 2026-10-13 ("shop içerisinde gruplandı tıkladığımda shop açılsın"): a database's
   * group, opened, shows the database itself — its own tab, opened at the group's place when it is
   * not — and so its tabs one by one again. A group that is not there does nothing.
   */
  function openGroup(key: string): void {
    const group = tabGroups(tabs.value).get(key)
    if (!group) return
    const own = group.members.find((t) => t.kind === 'database')
    if (own) return activate(own.id)
    const params = { connectionId: group.connectionId, db: group.db }
    const id = identity('database', params)
    const at = tabs.value.indexOf(group.members[0]!)
    const tab: WorkspaceTab = { id, kind: 'database', title: group.db, params }
    tabs.value = [...tabs.value.slice(0, at), tab, ...tabs.value.slice(at)]
    activeId.value = id
    persist()
  }

  /** Tabs closed together, each with its place, to put them back (Undo). */
  type Closed = Array<{ tab: WorkspaceTab; index: number }>

  /**
   * Closes these tabs together (a group's); the tab in use stays when it is not one of them. Returns
   * what was closed, for `restore`.
   */
  function closeMany(ids: readonly string[]): Closed {
    const closing = new Set(ids)
    const closed = tabs.value.flatMap((tab, index) => (closing.has(tab.id) ? [{ tab, index }] : []))
    if (closed.length === 0) return []
    const next = closing.has(activeId.value) ? successor(closing) : activeId.value
    const remaining = tabs.value.filter((t) => !closing.has(t.id))
    tabs.value = remaining.length > 0 ? remaining : [WELCOME]
    activeId.value = tabs.value.some((t) => t.id === next) ? next : tabs.value[0]!.id
    forgetClosed()
    persist()
    return closed
  }

  /** Puts closed tabs back where they were (review 2026-10-12, minor 19: a group closed for good). */
  function restore(closed: Closed): void {
    const next =
      tabs.value.length === 1 && tabs.value[0]!.kind === 'welcome' && closed.length > 0 ? [] : [...tabs.value]
    for (const { tab, index } of [...closed].sort((a, b) => a.index - b.index))
      if (!next.some((t) => t.id === tab.id)) next.splice(Math.min(index, next.length), 0, tab)
    tabs.value = next
    if (!next.some((t) => t.id === activeId.value)) activeId.value = next[0]!.id
    persist()
  }

  /**
   * A tab replaced in its place by another (a renamed collection's): shown only if it was (review
   * 2026-10-12, minor 18: it moved to the end and was shown, its group opened). Returns the new id.
   */
  function replace(id: string, input: TabInput): string {
    const clean = cleanView({ id: '', kind: input.kind, title: input.title, params: input.params ?? {} })
    const fresh = { ...clean, id: identity(clean.kind, clean.params) }
    const index = tabs.value.findIndex((t) => t.id === id)
    if (index < 0) return open(input)
    const next = tabs.value.filter((t) => t.id !== fresh.id || t.id === id)
    next.splice(
      next.findIndex((t) => t.id === id),
      1,
      fresh,
    )
    const wasActive = activeId.value === id
    tabs.value = next
    // W6.1: a pane showing it shows the new one.
    const side = split.value?.left === id ? 'left' : split.value?.right === id ? 'right' : null
    if (side && split.value) split.value = { ...split.value, [side]: fresh.id }
    if (wasActive) activeId.value = fresh.id
    forgetClosed()
    persist()
    return fresh.id
  }

  /**
   * W6.1: shows a tab beside the one in use. Without a split, the tab in use (or, when that is the
   * tab asked for or Overview, the last other one in use) stays on the left and the tab goes on
   * the right; with one, the tab goes into the other pane. The pane it is in gets the focus. False
   * when there is nothing to put beside it (it is then only shown); Overview is never put in a pane.
   */
  function openBeside(id: string): boolean {
    const tab = tabs.value.find((t) => t.id === id)
    if (!tab || tab.kind === 'welcome') return false
    const s = split.value
    if (s) {
      if (s.left !== id && s.right !== id) split.value = { ...s, [s.focus === 'left' ? 'right' : 'left']: id }
      activate(id)
      return true
    }
    const usable = (other: string) =>
      other !== id && tabs.value.some((t) => t.id === other && t.kind !== 'welcome')
    const partner =
      used.find(usable) ?? tabs.value.find((t) => t.kind !== 'welcome' && t.id !== id)?.id ?? null
    if (!partner) {
      activate(id)
      return false
    }
    split.value = { left: partner, right: id, focus: 'right', ratio: 0.5 }
    activate(id)
    return true
  }

  /** W6.1: the pane in use, and so its tab. */
  function focusPane(side: PaneSide): void {
    const s = split.value
    if (s && s.focus !== side) activate(s[side])
  }

  /** W6.1: a pane closed; its tab stays open in the strip and the other pane's is in use. */
  function closePane(side: PaneSide): void {
    const s = split.value
    if (!s) return
    const kept = s[side === 'left' ? 'right' : 'left']
    split.value = null
    activate(kept)
  }

  /** W6.1: where the divider is, as the left pane's share of the width. */
  /**
   * W6.1: where the divider is, as the left pane's share of the width. Review minor 8: while it is
   * dragged it changes in memory only (`save` false); `saveSplit` keeps it once it is let go.
   */
  function setSplitRatio(ratio: number, save = true): void {
    if (!split.value || !Number.isFinite(ratio)) return
    split.value = { ...split.value, ratio: clampRatio(ratio) }
    if (save) persist()
  }
  const saveSplit = (): void => persist()

  /** Renames matching tabs (e.g. after a connection was renamed). */
  function retitle(predicate: (tab: WorkspaceTab) => boolean, title: string): void {
    if (!tabs.value.some(predicate)) return
    tabs.value = tabs.value.map((t) => (predicate(t) ? { ...t, title } : t))
    persist()
  }

  /** Back to a single welcome tab and forget the stored ones (sign-out). */
  function reset(): void {
    tabs.value = [WELCOME]
    activeId.value = WELCOME.id
    owner = null
    lastIn = {}
    split.value = null
    used = []
    try {
      localStorage.removeItem(KEY)
    } catch {
      // storage blocked: nothing stored anyway
    }
  }

  /** Tabs belong to one user: restored tabs of anyone else are discarded, never shown. */
  function bindUser(userId: string): void {
    if (owner === userId) return
    reset()
    owner = userId
  }

  return {
    tabs,
    activeId,
    active,
    open,
    setView,
    close,
    closeMany,
    closeWhere,
    openGroup,
    lastInUse,
    restore,
    replace,
    moveBy,
    moveGroup,
    retitle,
    activate,
    move,
    home,
    reset,
    bindUser,
    split,
    panes,
    paneOf,
    setSplitAllowed,
    recentTabs,
    saveSplit,
    openBeside,
    focusPane,
    closePane,
    setSplitRatio,
  }
})
