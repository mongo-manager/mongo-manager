<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onBeforeUpdate, onUpdated, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import {
  ChevronDown,
  Columns2,
  Database,
  PanelLeft,
  PanelRight,
  PanelRightClose,
  X,
  SquareX,
} from 'lucide-vue-next'
import { connectionsApi, queryKeys } from '@/api/connections'
import { useTabsStore, type WorkspaceTab } from '@/stores/tabs'
import { useShortcutsStore } from '@/stores/shortcuts'
import DsMenu from '@/ds/DsMenu.vue'
import type { DsMenuItem } from '@/ds/menu'
import { place } from '@/ds/position'
import { stripItems, type StripItem, type TabGroup } from './tabGroups'
import { tabTooltip, useTabIcon, useTabTitle } from './tabTitle'
import { useTabClose, useTabsClose } from './unsaved'
import { draggingTab, TAB_DRAG_TYPE, useSplitView } from './split'

/**
 * UI redesign R1 spec §3: the tab strip. One tab is in the Tab order (the active one); arrows move
 * between tabs, Delete closes, a middle click closes, dragging reorders, and "All tabs" lists every tab
 * when they no longer fit.
 *
 * User request 2026-10-12: the collection tabs of a database the user is not on stand as one tab of
 * the database (its name, how many tabs), where its first tab is. Opened — clicked, Enter on it, or one
 * of its collections opened anywhere — its tabs are shown one by one again; closed, all of them close.
 * The arrows stop on it without opening it (review 2026-10-12, I3); dragged, it moves as one.
 * User request 2026-10-13: clicked, it opens on the database itself, and a tooltip names its tabs. A
 * tab or a group is shown at once, never cross-faded: the fade to a page not loaded yet looked like a
 * reload, and a key pressed meanwhile went to the strip as it was.
 */
const tabs = useTabsStore()
const { t } = useI18n()
const titleOf = useTabTitle()
const iconOf = useTabIcon()
const strip = ref<HTMLElement | null>(null)
/** What is being dragged: a tab, or a gathered group. */
const dragging = ref<{ tab: string } | { group: string } | null>(null)
const closable = (tab: WorkspaceTab) => tab.kind !== 'welcome'
// W5: the keys that act on a tab — Delete closes it, Shift+F10 or the Menu key opens its menu (W6.1),
// and the active one moves, and opens beside, with the user's keys.
const shortcuts = useShortcutsStore()
const tabKeys = (tab: WorkspaceTab): string | undefined =>
  [
    closable(tab) ? 'Delete' : '',
    'Shift+F10 ContextMenu',
    tab.id === tabs.activeId ? `${shortcuts.aria('tabReorder')} ${shortcuts.aria('splitView')}` : '',
  ]
    .filter(Boolean)
    .join(' ') || undefined
const closeTab = useTabClose()
const closeTabs = useTabsClose()
const split = useSplitView()
// W6.1: the other pane's tab keeps its database's tabs shown one by one too.
const items = computed(() =>
  stripItems(
    tabs.tabs,
    tabs.activeId,
    split.panes.value ? [split.panes.value.left, split.panes.value.right] : [],
  ),
)
const groups = computed(() => items.value.flatMap((i) => (i.kind === 'group' ? [i.group] : [])))

// Connection names: for a group's tooltip, for groups of databases of the same name on two
// connections, and for the database a tab of "All tabs" is on. Asked only when there is one to name.
const naming = computed(() => tabs.tabs.some((tab) => tab.kind === 'collection' || tab.kind === 'database'))
const { data: connections } = useQuery({
  queryKey: queryKeys.connections,
  queryFn: connectionsApi.list,
  enabled: naming,
})
const connectionName = (id: string) => connections.value?.find((c) => c.id === id)?.name
/** Databases of the same name on two connections: their groups say which connection (review I6). */
const shared = computed(() => {
  const seen = new Map<string, number>()
  for (const g of groups.value) seen.set(g.db, (seen.get(g.db) ?? 0) + 1)
  return new Set([...seen].filter(([, n]) => n > 1).map(([db]) => db))
})
const groupName = (group: TabGroup) => {
  const connection = connectionName(group.connectionId)
  return shared.value.has(group.db) && connection ? `${connection} / ${group.db}` : group.db
}
const groupLabel = (group: TabGroup) => {
  const connection = connectionName(group.connectionId)
  return connection
    ? t('tabs.group.labelOn', { db: group.db, connection, n: group.members.length })
    : t('tabs.group.label', { db: group.db, n: group.members.length })
}
// A connection's name, once known; never its id (review 2026-10-12, minor 15).
const groupTooltip = (group: TabGroup) => {
  const connection = connectionName(group.connectionId)
  return connection
    ? t('tabs.group.tooltip', { connection, db: group.db, n: group.members.length })
    : t('tabs.group.tooltipBare', { db: group.db, n: group.members.length })
}
/** A tab of a group by name: a collection's, or the database's own page. */
const memberName = (tab: WorkspaceTab) =>
  tab.kind === 'database' ? t('tabs.group.databasePage') : (tab.params.coll ?? tab.title)
/** The tooltip naming a group's tabs (user request 2026-10-13), the most it lists. */
const TIP_NAMES = 12
/** What a screen reader is told of a group: its tabs by name (as many as the tooltip), and its keys. */
const groupDescription = (group: TabGroup) => {
  const names = group.members.slice(0, TIP_NAMES).map(memberName)
  if (group.members.length > TIP_NAMES)
    names.push(t('tabs.group.more', { n: group.members.length - TIP_NAMES }))
  return t('tabs.group.description', { names: names.join(', ') })
}
const tipKey = ref<string | null>(null)
const tipEl = ref<HTMLElement | null>(null)
const tipAt = ref({ top: 0, left: 0 })
let tipTimer: ReturnType<typeof setTimeout> | undefined
/** The group the tooltip is about, while it is still gathered. */
const tipGroup = computed(() => groups.value.find((g) => g.key === tipKey.value) ?? null)
function showTip(group: TabGroup, anchor: HTMLElement, delay: number): void {
  clearTimeout(tipTimer)
  tipTimer = setTimeout(async () => {
    // Its chip gone meanwhile (the group opened, closed, moved): nothing to name (review 2026-10-13, I1).
    if (!anchor.isConnected) return
    tipKey.value = group.key
    await nextTick()
    const box = tipEl.value?.getBoundingClientRect()
    if (box && anchor.isConnected) tipAt.value = place(anchor.getBoundingClientRect(), box, 'bottom-start', 6)
  }, delay)
}
function hideTip(): void {
  clearTimeout(tipTimer)
  tipKey.value = null
}
/**
 * The chip focused by the pointer (a click, a drag, a tap) never shows the tooltip — hovering does —
 * only the keyboard's focus does (review 2026-10-13, I1, M1).
 */
let pressed = false
function onChipPointerDown(): void {
  pressed = true
  hideTip()
}
function onChipFocus(group: TabGroup, anchor: HTMLElement): void {
  if (pressed) pressed = false
  else showTip(group, anchor, 150)
}
onBeforeUnmount(hideTip)
const allItems = computed(() =>
  tabs.tabs.map((tab) => {
    const connection = tab.params.connectionId ? connectionName(tab.params.connectionId) : undefined
    const db = tab.kind === 'collection' || tab.kind === 'database' ? tab.params.db : undefined
    return {
      id: tab.id,
      label: titleOf(tab),
      icon: iconOf(tab),
      // The database a tab is on, and its connection's name: tabs of two connections told apart.
      hint: db && connection ? `${connection} · ${db}` : db,
    }
  }),
)

// Phase 3e-1 UI review: the active tab is always fully visible in a strip that scrolls.
watch(
  () => tabs.activeId,
  async () => {
    await nextTick()
    strip.value
      ?.querySelector('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  },
  { immediate: true },
)

/** What a screen reader is told: a group gathered, or shown again. */
const announcement = ref('')
watch(
  () => groups.value.map((g) => g.key),
  (now, before) => {
    if (!before) return
    const names = (keys: string[]) => groups.value.filter((g) => keys.includes(g.key))
    const gathered = now.filter((k) => !before.includes(k))
    const opened = before.filter((k) => !now.includes(k))
    const said = [
      ...names(gathered).map((g) => t('tabs.group.collapsed', { db: g.db })),
      ...opened.map((k) => t('tabs.group.expanded', { db: (JSON.parse(k) as string[])[1] ?? '' })),
    ]
    if (said.length > 0) announcement.value = said.join(' ')
  },
)

/**
 * The focus never falls off the strip (review 2026-10-12, I5): an element of it that held the focus
 * and went (a group opened, a tab gathered) gives it to the tab shown.
 */
let hadFocus = false
onBeforeUpdate(() => {
  hadFocus = !!strip.value?.contains(document.activeElement)
})
onUpdated(() => {
  if (hadFocus && !strip.value?.contains(document.activeElement)) focusSelected()
})
const focusSelected = () =>
  strip.value?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()

/**
 * Opens a group on its database: its tabs shown at once — no cross-fade, the strip changing as the page
 * did looked like a reload (user report 2026-10-13) — the tab shown focused when the focus was in the
 * strip.
 */
async function openGroup(group: TabGroup): Promise<void> {
  const focused = !!strip.value?.contains(document.activeElement)
  hideTip()
  tabs.openGroup(group.key)
  await nextTick()
  if (focused) focusSelected()
}

/** Arrows: a tab is shown and focused; a group is focused, never opened (it opens with Enter). */
async function focusItem(position: number): Promise<void> {
  const list = items.value
  const item = list[(position + list.length) % list.length]
  if (!item) return
  if (item.kind === 'tab') {
    tabs.activate(item.tab.id)
    await nextTick()
    focusSelected()
  } else {
    // The chip may not be drawn yet (the group gathered just now).
    await nextTick()
    ;[...(strip.value?.querySelectorAll<HTMLElement>('[data-group]') ?? [])]
      .find((el) => el.dataset.group === item.group.key)
      ?.focus()
  }
}

function onKeydown(event: KeyboardEvent, drawnAt: number, item: StripItem): void {
  // Where it is now: a key pressed before the strip redrew (a group just gathered) moved from where it
  // was drawn (found by e2e 2026-10-13).
  const now = items.value.findIndex((i) =>
    i.kind === 'tab'
      ? item.kind === 'tab' && i.tab.id === item.tab.id
      : item.kind === 'group' && i.group.key === item.group.key,
  )
  const position = now >= 0 ? now : drawnAt
  if (event.key === 'ArrowRight') void focusItem(position + 1)
  else if (event.key === 'ArrowLeft') void focusItem(position - 1)
  else if (event.key === 'Home') void focusItem(0)
  else if (event.key === 'End') void focusItem(items.value.length - 1)
  else if (item.kind === 'group' && ['Enter', ' ', 'ArrowDown'].includes(event.key))
    void openGroup(item.group)
  else if (event.key === 'Escape' && item.kind === 'group' && tipKey.value) hideTip()
  else if (event.key === 'Delete' && item.kind === 'group') void closeGroup(item.group).then(focusAfterClose)
  else if (event.key === 'Delete' && item.kind === 'tab' && closable(item.tab))
    void closeTab(item.tab.id).then(focusAfterClose)
  else if (item.kind === 'tab' && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)))
    openTabMenu(item.tab.id)
  else return
  event.preventDefault()
}
const focusAfterClose = () => nextTick(focusSelected)

function closeGroup(group: TabGroup): ReturnType<typeof closeTabs> {
  hideTip()
  return closeTabs(
    group.members.map((m) => m.id),
    group.db,
  )
}

/** The place among the other tabs where a dropped tab or group goes: before the target's first tab. */
function onDrop(target: StripItem): void {
  const from = dragging.value
  dragging.value = null
  if (!from) return
  const targetIds = target.kind === 'tab' ? [target.tab.id] : target.group.members.map((m) => m.id)
  if ('tab' in from) {
    if (targetIds.includes(from.tab)) return
    const others = tabs.tabs.filter((t) => t.id !== from.tab)
    tabs.move(
      from.tab,
      others.findIndex((t) => targetIds.includes(t.id)),
    )
  } else {
    const group = groups.value.find((g) => g.key === from.group)
    if (!group || targetIds.some((id) => group.members.some((m) => m.id === id))) return
    const memberIds = new Set(group.members.map((m) => m.id))
    const others = tabs.tabs.filter((t) => !memberIds.has(t.id))
    tabs.moveGroup(
      from.group,
      others.findIndex((t) => targetIds.includes(t.id)),
    )
  }
}

/**
 * W6.1: a tab's menu — "Open beside" (Mod+\ for the tab in use), "Close pane" for a pane's tab, and
 * "Close tab". Opened from its button, a right click, Shift+F10 or the Menu key.
 */
const menus = new Map<string, InstanceType<typeof DsMenu>>()
/** The ref setter of a tab's menu (kept per tab, dropped when the tab goes). */
const menuRef = (id: string) => (el: unknown) => {
  if (el) menus.set(id, el as InstanceType<typeof DsMenu>)
  else menus.delete(id)
}
const openTabMenu = (id: string) => void menus.get(id)?.openMenu()
function tabMenu(tab: WorkspaceTab): DsMenuItem[] {
  const side = split.paneOf(tab.id)
  return [
    {
      id: 'beside',
      label: t('split.openBeside'),
      icon: Columns2,
      disabled: tab.kind === 'welcome',
      // W5: split view's keys as this user bound them.
      ...(tab.id === tabs.activeId ? { shortcut: shortcuts.keysOf('splitView')[0] } : {}),
    },
    ...(side ? [{ id: 'closePane', label: t('split.closePaneShort'), icon: PanelRightClose }] : []),
    ...(closable(tab) ? [{ id: 'close', label: t('tabs.menu.close'), icon: X, separator: true }] : []),
    // User request 2026-10-23: with many tabs open, this one stays and the others close.
    {
      id: 'closeOthers',
      label: t('tabs.menu.closeOthers'),
      icon: SquareX,
      disabled: othersThan(tab).length === 0,
      // Overview has no "Close tab" above it: this starts the group.
      ...(closable(tab) ? {} : { separator: true }),
    },
  ]
}
/** The tabs that close with "Close other tabs" on one: every other that can close. */
const othersThan = (tab: WorkspaceTab): string[] =>
  tabs.tabs.filter((other) => other.id !== tab.id && closable(other)).map((other) => other.id)
async function closeOthers(tab: WorkspaceTab): Promise<void> {
  hideTip()
  const others = othersThan(tab)
  await closeTabs(others)
  // Shown once the others closed (not when the question about them was answered no).
  if (!tabs.tabs.some((other) => others.includes(other.id))) tabs.activate(tab.id)
}
function onTabMenu(tab: WorkspaceTab, id: string): void {
  const side = split.paneOf(tab.id)
  if (id === 'beside') split.openBeside(tab.id)
  else if (id === 'closePane' && side) tabs.closePane(side)
  else if (id === 'close') void closeTab(tab.id)
  else if (id === 'closeOthers') void closeOthers(tab)
}
/** A tab dragged: the strip reorders it, the workspace's right edge opens it beside. */
function onTabDragStart(event: DragEvent, id: string): void {
  dragging.value = { tab: id }
  draggingTab.value = id
  event.dataTransfer?.setData(TAB_DRAG_TYPE, id)
}
function onTabDragEnd(): void {
  dragging.value = null
  draggingTab.value = null
}

/** A close button seen on hover or focus, always on a touch screen; hidden, it takes no tap (I4). */
const HIDDEN_CLOSE =
  'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100'
</script>

<template>
  <div data-region="tabs" class="flex h-9 shrink-0 items-stretch border-b border-line">
    <div
      ref="strip"
      role="tablist"
      :aria-label="t('tabs.list')"
      class="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none]"
      @mousedown.middle.prevent
    >
      <template v-for="(item, position) in items" :key="item.kind === 'tab' ? item.tab.id : item.group.key">
        <div
          v-if="item.kind === 'tab'"
          role="presentation"
          draggable="true"
          class="group relative flex max-w-[240px] min-w-0 shrink-0 items-center border-r border-line text-ui transition-colors duration-120 select-none"
          :class="[
            item.tab.id === tabs.activeId || split.paneOf(item.tab.id)
              ? 'bg-surface text-fg'
              : 'bg-canvas text-fg-muted hover:bg-subtle hover:text-fg',
            dragging && 'tab' in dragging && dragging.tab === item.tab.id ? 'opacity-50' : '',
          ]"
          @auxclick="($event as MouseEvent).button === 1 && closable(item.tab) && closeTab(item.tab.id)"
          @dragstart="onTabDragStart($event, item.tab.id)"
          @dragend="onTabDragEnd"
          @dragover.prevent
          @drop.prevent="onDrop(item)"
        >
          <span
            v-if="item.tab.id === tabs.activeId"
            class="absolute inset-x-0 top-0 h-0.5 bg-accent"
            aria-hidden="true"
          />
          <!-- W6.1: the other pane's tab, shown but not in use. -->
          <span
            v-else-if="split.paneOf(item.tab.id)"
            class="absolute inset-x-0 top-0 h-0.5 bg-line-strong"
            aria-hidden="true"
          />
          <!-- The close button sits beside the tab, never inside it (no nested controls). A collection
               tab shows the collection; its name says the database too. -->
          <div
            role="tab"
            :data-id="item.tab.id"
            :aria-selected="item.tab.id === tabs.activeId"
            :aria-label="item.tab.kind === 'collection' ? item.tab.title : undefined"
            :aria-keyshortcuts="tabKeys(item.tab)"
            :tabindex="item.tab.id === tabs.activeId ? 0 : -1"
            :aria-description="
              split.paneOf(item.tab.id) ? t(`split.inPane.${split.paneOf(item.tab.id)}`) : undefined
            "
            :title="tabTooltip(item.tab, item.tab.title || titleOf(item.tab))"
            class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 pr-1 pl-3 focus-visible:-outline-offset-2"
            @click="tabs.activate(item.tab.id)"
            @keydown="onKeydown($event, position, item)"
            @contextmenu.prevent="openTabMenu(item.tab.id)"
          >
            <component :is="iconOf(item.tab)" class="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
            <span data-title class="min-w-0 truncate">{{ titleOf(item.tab) }}</span>
            <component
              :is="split.paneOf(item.tab.id) === 'left' ? PanelLeft : PanelRight"
              v-if="split.paneOf(item.tab.id)"
              data-pane-marker
              class="size-3.5 shrink-0"
              :class="item.tab.id === tabs.activeId ? 'text-accent' : 'text-fg-subtle'"
              aria-hidden="true"
            />
          </div>
          <DsMenu
            :ref="menuRef(item.tab.id)"
            :label="
              t('tabs.menu.label', {
                title: item.tab.kind === 'collection' ? item.tab.title : titleOf(item.tab),
              })
            "
            :items="tabMenu(item.tab)"
            placement="bottom-start"
            :trigger-class="`grid size-5 shrink-0 cursor-pointer place-items-center rounded text-fg-subtle transition-opacity duration-120 hover:bg-muted hover:text-fg ${item.tab.id === tabs.activeId ? '' : HIDDEN_CLOSE}`"
            data-tab-menu
            @select="onTabMenu(item.tab, $event)"
          >
            <template #trigger><ChevronDown class="size-3.5" aria-hidden="true" /></template>
          </DsMenu>
          <button
            v-if="closable(item.tab)"
            type="button"
            tabindex="-1"
            class="mr-1.5 grid size-5 shrink-0 cursor-pointer place-items-center rounded text-fg-subtle transition-opacity duration-120 hover:bg-muted hover:text-fg"
            :class="item.tab.id === tabs.activeId ? '' : HIDDEN_CLOSE"
            :aria-label="
              t('tabs.close', { title: item.tab.kind === 'collection' ? item.tab.title : titleOf(item.tab) })
            "
            @click.stop="closeTab(item.tab.id)"
          >
            <X class="size-3.5" aria-hidden="true" />
          </button>
          <span v-else class="w-2" aria-hidden="true" />
        </div>
        <!-- A database's tabs, gathered while the user is elsewhere: one tab to open them again. -->
        <div
          v-else
          role="presentation"
          draggable="true"
          class="group relative flex shrink-0 items-center gap-0.5 border-r border-line bg-canvas px-1.5 text-ui select-none"
          :class="dragging && 'group' in dragging && dragging.group === item.group.key ? 'opacity-50' : ''"
          data-tab-group
          @auxclick="($event as MouseEvent).button === 1 && closeGroup(item.group)"
          @dragstart="((dragging = { group: item.group.key }), hideTip())"
          @dragend="dragging = null"
          @dragover.prevent
          @drop.prevent="onDrop(item)"
        >
          <div
            role="tab"
            :data-group="item.group.key"
            aria-selected="false"
            aria-expanded="false"
            tabindex="-1"
            :aria-label="groupLabel(item.group)"
            aria-keyshortcuts="Enter Delete"
            :aria-description="groupDescription(item.group)"
            class="flex h-6.5 max-w-[220px] min-w-0 cursor-pointer items-center gap-1.5 rounded-md bg-subtle pr-1 pl-2 text-fg ring-1 ring-line transition-colors duration-120 ring-inset hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            @click="openGroup(item.group)"
            @keydown="onKeydown($event, position, item)"
            @mouseenter="showTip(item.group, $event.currentTarget as HTMLElement, 400)"
            @mouseleave="hideTip"
            @focus="onChipFocus(item.group, $event.currentTarget as HTMLElement)"
            @blur="hideTip"
            @pointerdown="onChipPointerDown"
            @pointerup="pressed = false"
          >
            <Database class="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
            <span data-title class="min-w-0 truncate font-medium">{{ groupName(item.group) }}</span>
            <span
              class="grid h-4 min-w-4 shrink-0 place-items-center rounded-full bg-muted px-1 text-caption leading-none font-semibold text-fg-muted tabular-nums"
              aria-hidden="true"
              data-group-count
              >{{ item.group.members.length }}</span
            >
          </div>
          <button
            type="button"
            tabindex="-1"
            class="grid size-5 shrink-0 cursor-pointer place-items-center rounded text-fg-subtle transition-opacity duration-120 hover:bg-muted hover:text-fg"
            :class="HIDDEN_CLOSE"
            :aria-label="t('tabs.group.close', { db: item.group.db, n: item.group.members.length })"
            data-group-close
            @click.stop="closeGroup(item.group)"
          >
            <X class="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </template>
    </div>
    <!-- The tabs of the group pointed at or focused, by name (its description says them too). -->
    <Teleport to="body">
      <div
        v-if="tipGroup"
        ref="tipEl"
        role="tooltip"
        aria-hidden="true"
        data-group-tooltip
        class="pointer-events-none fixed z-[55] max-w-72 animate-fade rounded-md bg-tooltip px-2.5 py-1.5 text-small text-on-tooltip shadow-float"
        :style="{ top: `${tipAt.top}px`, left: `${tipAt.left}px` }"
      >
        <p class="font-medium break-all">{{ groupTooltip(tipGroup) }}</p>
        <ul class="mt-1 flex flex-col gap-0.5 opacity-90">
          <li v-for="tab in tipGroup.members.slice(0, TIP_NAMES)" :key="tab.id" class="truncate">
            {{ memberName(tab) }}
          </li>
          <li v-if="tipGroup.members.length > TIP_NAMES" class="opacity-75">
            {{ t('tabs.group.more', { n: tipGroup.members.length - TIP_NAMES }) }}
          </li>
        </ul>
      </div>
    </Teleport>
    <!-- A group gathered or shown again, said to a screen reader. -->
    <p class="sr-only" aria-live="polite" data-tab-announce>{{ announcement }}</p>
    <div v-if="tabs.tabs.length > 1" class="flex shrink-0 items-center border-l border-line px-1">
      <DsMenu
        :label="t('layout.allTabs')"
        :icon="ChevronDown"
        :items="allItems"
        focusable
        @select="tabs.activate"
      />
    </div>
  </div>
</template>
