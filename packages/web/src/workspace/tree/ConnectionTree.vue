<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Folder, FolderOpen } from 'lucide-vue-next'
import type { ConnectionDto } from '@/api/connections'
import { treeKey, useTreeStore } from '@/stores/tree'
import { useTabsStore } from '@/stores/tabs'
import TreeRow from './TreeRow.vue'
import TreeConnection from './TreeConnection.vue'

const props = defineProps<{ connections: ConnectionDto[] }>()
const tree = useTreeStore()
const root = ref<HTMLElement | null>(null)
const seenGroups = new Set<string>()

const sorted = (list: ConnectionDto[]) =>
  [...list].sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name))

const groups = computed(() => {
  const byName = new Map<string, ConnectionDto[]>()
  for (const c of props.connections) if (c.group) byName.set(c.group, [...(byName.get(c.group) ?? []), c])
  return [...byName.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, list]) => ({ name, key: treeKey('g', name), connections: sorted(list) }))
})
const ungrouped = computed(() => sorted(props.connections.filter((c) => !c.group)))

// Groups start expanded the first time they appear.
watch(
  groups,
  (list) => {
    for (const g of list) {
      if (seenGroups.has(g.key)) continue
      seenGroups.add(g.key)
      tree.setExpanded(g.key, true)
    }
  },
  { immediate: true },
)

// User review 2026-10-08 ("sayfayı yeniledim … bağlantılar kapalı"): the tree opens to the open tab's
// connection, database or collection — on load too — once per tab, so a branch the user closes
// while on that tab stays closed.
const tabs = useTabsStore()
let revealed: string | null = null
watch(
  () => [tabs.active, props.connections] as const,
  ([tab, connections]) => {
    const p = tab?.params
    if (revealed === (tab?.id ?? null)) return
    if (!tab || !p?.connectionId || !['connection', 'database', 'collection', 'gridfs'].includes(tab.kind)) {
      revealed = tab?.id ?? null
      return
    }
    const connection = connections.find((c) => c.id === p.connectionId)
    // Not listed yet: the connections load after the tab is restored, and this runs again then.
    if (!connection) return
    revealed = tab.id
    if (connection.group) tree.setExpanded(treeKey('g', connection.group), true)
    if (tab.kind !== 'connection') tree.setExpanded(treeKey('c', connection.id), true)
    // Phase 4b §1: a GridFS bucket's tab too.
    if ((tab.kind === 'collection' || tab.kind === 'gridfs') && p.db)
      tree.setExpanded(treeKey('d', connection.id, p.db), true)
  },
  { immediate: true },
)

const items = () => Array.from(root.value?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])

// Roving tabindex: exactly one rendered item is tabbable.
watch(
  () => [props.connections, tree.expanded, tree.focused] as const,
  async () => {
    await nextTick()
    const all = items()
    if (!all.some((el) => el.dataset.key === tree.focused)) tree.focused = all[0]?.dataset.key ?? null
  },
  { immediate: true },
)

// When the focused row disappears (deleted, dropped, collapsed by a refetch), keep keyboard users
// in the tree: focus the row that took its place instead of leaving focus on <body>.
let lastFocused: HTMLElement | null = null
let lastIndex = 0
function onFocusin(event: FocusEvent): void {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]')
  if (!target) return
  lastFocused = target
  lastIndex = items().indexOf(target)
}
let observer: MutationObserver | undefined
onMounted(() => {
  observer = new MutationObserver(() => {
    if (!lastFocused || lastFocused.isConnected) return
    const active = document.activeElement
    if (active && active !== document.body) return
    const all = items()
    lastFocused = null
    all[Math.min(lastIndex, all.length - 1)]?.focus()
  })
  if (root.value) observer.observe(root.value, { childList: true, subtree: true })
})
onBeforeUnmount(() => observer?.disconnect())

function onKeydown(event: KeyboardEvent): void {
  const all = items()
  const index = all.indexOf(document.activeElement as HTMLElement)
  if (index < 0) return
  const move = (i: number) => all[Math.max(0, Math.min(all.length - 1, i))]?.focus()
  if (event.key === 'ArrowDown') move(index + 1)
  else if (event.key === 'ArrowUp') move(index - 1)
  else if (event.key === 'Home') move(0)
  else if (event.key === 'End') move(all.length - 1)
  else return
  event.preventDefault()
}
</script>

<template>
  <ul
    ref="root"
    role="tree"
    :aria-label="$t('tree.label')"
    class="px-2 pb-2"
    @keydown="onKeydown"
    @focusin="onFocusin"
  >
    <TreeRow v-for="g in groups" :key="g.key" :node-key="g.key" :label="g.name" :level="1" expandable>
      <template #icon>
        <FolderOpen v-if="tree.isExpanded(g.key)" class="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
        <Folder v-else class="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
      </template>
      <TreeConnection v-for="c in g.connections" :key="c.id" :connection="c" :level="2" />
    </TreeRow>
    <TreeConnection v-for="c in ungrouped" :key="c.id" :connection="c" :level="1" />
  </ul>
</template>
