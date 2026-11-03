<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQueryClient } from '@tanstack/vue-query'
import { CornerDownLeft, Database, Search, Server, Sparkles, Table } from 'lucide-vue-next'
import type { CollectionInfo, ConnectionDto, DatabaseList } from '@/api/connections'
import { commandTitle, useCommandsStore, type Command } from '@/stores/commands'
import { useTabsStore } from '@/stores/tabs'
import { useShortcutsStore } from '@/stores/shortcuts'
import { usePlacesStore, type Place } from '@/stores/places'
import { useAssistantStore } from '@/ai/chat/store'
import { useAiStatus } from '@/ai/useAi'
import { useModalFocus } from '@/ds/modalFocus'
import DsKbd from '@/ds/DsKbd.vue'
import { keyLabel } from './shortcuts'
import { openCollectionTab, openConnectionTab, openDatabaseTab } from './openTabs'
import { PALETTE_GROUPS, PALETTE_KEYS, paletteFits, paletteGroup, paletteIcon } from './paletteGroups'

/**
 * UI redesign R1 revision 2 §3.4, §3.6: the palette — it goes anywhere (what the tree has loaded,
 * pinned and recent places) and runs commands; with the assistant offered, Tab switches it to Ask.
 */
const props = withDefaults(defineProps<{ open: boolean; ask?: boolean }>(), { ask: false })
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const store = useCommandsStore()
const tabs = useTabsStore()
const places = usePlacesStore()
const assistant = useAssistantStore()
const queryClient = useQueryClient()
// W5: the keys beside a command, as this user bound them.
const shortcuts = useShortcutsStore()
const aiStatus = useAiStatus()
const askOffered = computed(() => !!aiStatus.data.value?.enabled)
/** The footer's key caps: symbols, the same in every language. */
const KEYS = { up: '↑', down: '↓', enter: '↵', escape: 'Esc', tab: 'Tab' }
const query = ref('')
const index = ref(0)
const mode = ref<'go' | 'ask'>('go')
const panel = ref<HTMLElement | null>(null)
const listId = useId()

interface Entry {
  id: string
  title: string
  hint?: string
  icon: Component
  keys?: string[]
  run: () => void | Promise<void>
}
interface Group {
  id: string
  /** Its name, read with it; the group's own title unless said otherwise. */
  label?: string
  items: Entry[]
}

// What the tree has loaded, read from the query cache (nothing new is asked of the server).
const cacheVersion = ref(0)
const unsubscribe = queryClient.getQueryCache().subscribe(() => cacheVersion.value++)
onBeforeUnmount(unsubscribe)
const ICONS = { connection: Server, database: Database, collection: Table } as const

function connectionsCached(): ConnectionDto[] {
  return queryClient.getQueryData<ConnectionDto[]>(['connections']) ?? []
}
function cachedPlaces(): Place[] {
  void cacheVersion.value
  const conns = connectionsCached()
  const byId = new Map(conns.map((c) => [c.id, c]))
  const out: Place[] = conns.map((c) => ({
    key: `connection:${c.id}`,
    kind: 'connection',
    title: c.name,
    params: { connectionId: c.id },
  }))
  for (const q of queryClient.getQueryCache().findAll({ queryKey: ['connections'] })) {
    const key = q.queryKey as unknown[]
    const id = key[1]
    if (typeof id !== 'string' || !byId.has(id) || key[2] !== 'databases') continue
    if (key.length === 3) {
      for (const d of (q.state.data as DatabaseList | undefined)?.databases ?? [])
        out.push({
          key: `database:${id}/${d.name}`,
          kind: 'database',
          title: d.name,
          params: { connectionId: id, db: d.name },
        })
    } else if (key.length === 5 && key[4] === 'collections' && typeof key[3] === 'string') {
      const db = key[3]
      for (const c of (q.state.data as CollectionInfo[] | undefined) ?? [])
        out.push({
          key: `collection:${id}/${db}/${c.name}`,
          kind: 'collection',
          title: `${db}.${c.name}`,
          params: { connectionId: id, db, coll: c.name },
        })
    }
  }
  return out
}

function openPlace(p: Place): void {
  const c = connectionsCached().find((x) => x.id === p.params.connectionId) ?? {
    id: p.params.connectionId!,
    name: p.title,
  }
  if (p.kind === 'connection') openConnectionTab(tabs, c)
  else if (p.kind === 'database') openDatabaseTab(tabs, c.id, p.params.db!)
  else openCollectionTab(tabs, c.id, p.params.db!, p.params.coll!)
}
function placeEntry(p: Place): Entry {
  const conn = connectionsCached().find((c) => c.id === p.params.connectionId)
  return {
    id: `place:${p.key}`,
    title:
      p.kind === 'collection'
        ? (p.params.coll ?? p.title)
        : p.kind === 'connection'
          ? (conn?.name ?? p.title)
          : p.title,
    hint:
      p.kind === 'collection'
        ? `${conn?.name ?? ''} · ${p.params.db}`
        : p.kind === 'database'
          ? conn?.name
          : undefined,
    icon: ICONS[p.kind],
    run: () => openPlace(p),
  }
}
/** At most this many commands a group, and saved items of one connection. */
const GROUP_LIMIT = 50
const SAVED_LIMIT = 20
const matches = (text: string, q: string) => text.toLocaleLowerCase().includes(q)
const score = (text: string, q: string) => (text.toLocaleLowerCase().startsWith(q) ? 2 : 1)

const groups = computed<Group[]>(() => {
  const q = query.value.trim().toLocaleLowerCase()
  // Review I3: each group is cut on its own (never one cut for all), so a long list of one connection
  // cannot push the active connection's items out, and a refreshed list reorders nothing.
  const commands = store
    .search(query.value)
    .filter((c) => paletteFits(c, tabs.active) && c.when?.() !== false)
  const entry = (c: Command): Entry => ({
    id: c.id,
    title: commandTitle(c),
    icon: paletteIcon(c),
    keys: PALETTE_KEYS[c.id] ? shortcuts.keysOf(PALETTE_KEYS[c.id]!)[0] : undefined,
    run: () => c.run(),
  })
  const commandGroups: Group[] = PALETTE_GROUPS.flatMap((g) => {
    const inGroup = commands.filter((c) => paletteGroup(c) === g)
    // W5: saved items come in a group per connection, the active one's first.
    const own = new Map<string, Group>()
    const plain: Group = { id: g, items: [] }
    const out: Group[] = [plain]
    for (const c of inGroup) {
      if (!c.group) {
        plain.items.push(entry(c))
        continue
      }
      let group = own.get(c.group.id)
      if (!group) {
        group = { id: c.group.id, label: c.group.label(), items: [] }
        own.set(c.group.id, group)
        out.push(group)
      }
      group.items.push(entry(c))
    }
    const first = `saved:${tabs.active?.params.connectionId ?? ''}`
    const named = out
      .slice(1)
      .sort(
        (x, y) =>
          Number(y.id === first) - Number(x.id === first) || (x.label ?? '').localeCompare(y.label ?? ''),
      )
    plain.items = plain.items.slice(0, GROUP_LIMIT)
    for (const group of named) group.items = group.items.slice(0, SAVED_LIMIT)
    return [plain, ...named]
  })
  let placeGroups: Group[]
  if (!q) {
    placeGroups = [
      { id: 'pinned', items: places.pins.slice(0, 5).map(placeEntry) },
      { id: 'places', items: places.recent.slice(0, 5).map(placeEntry) },
    ]
  } else {
    const seen = new Set<string>()
    const found = [...places.pins, ...places.recent, ...cachedPlaces()]
      .filter((p) => {
        if (seen.has(p.key)) return false
        seen.add(p.key)
        const name = p.kind === 'collection' ? (p.params.coll ?? '') : p.title
        return matches(name, q) || matches(p.title, q)
      })
      .sort(
        (a, b) =>
          score(b.kind === 'collection' ? (b.params.coll ?? '') : b.title, q) -
          score(a.kind === 'collection' ? (a.params.coll ?? '') : a.title, q),
      )
      .slice(0, 8)
    placeGroups = [{ id: 'goto', items: found.map(placeEntry) }]
  }
  return [...placeGroups, ...commandGroups].filter((g) => g.items.length > 0)
})
/** The entries in screen order: the arrows follow what is seen. */
const flat = computed<Entry[]>(() => groups.value.flatMap((g) => g.items))
const optionId = (i: number) => `${listId}-${i}`
const position = (entry: Entry) => flat.value.indexOf(entry)

watch(query, () => (index.value = 0))
watch(
  () => props.open,
  (open) => {
    if (!open) return
    query.value = ''
    mode.value = props.ask && askOffered.value ? 'ask' : 'go'
  },
  { immediate: true },
)
// Focuses the input on open, keeps Tab inside and returns focus to the opener.
const { trapTab } = useModalFocus(panel, () => props.open)

async function runAt(i: number): Promise<void> {
  const entry = flat.value[i]
  if (!entry) return
  emit('close')
  await entry.run()
}
/** Ask: the question goes to the assistant, which sends it (through its own checks) as soon as it can. */
function askAssistant(): void {
  const question = query.value.trim()
  if (!question) return
  emit('close')
  assistant.ask(question)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Tab' && !event.shiftKey && askOffered.value) {
    event.preventDefault()
    mode.value = mode.value === 'ask' ? 'go' : 'ask'
    return
  }
  if (trapTab(event)) return
  if (mode.value === 'ask') {
    if (event.key === 'Enter') askAssistant()
    else if (event.key === 'Escape') emit('close')
    else return
    event.preventDefault()
    return
  }
  if (event.key === 'ArrowDown') index.value = Math.min(index.value + 1, flat.value.length - 1)
  else if (event.key === 'ArrowUp') index.value = Math.max(index.value - 1, 0)
  else if (event.key === 'Enter') void runAt(index.value)
  else if (event.key === 'Escape') emit('close')
  else return
  event.preventDefault()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
      <div
        class="absolute inset-0 animate-fade bg-[var(--ds-backdrop)]"
        aria-hidden="true"
        @click="emit('close')"
      />
      <div
        ref="panel"
        role="dialog"
        aria-modal="true"
        :aria-label="t('palette.title')"
        :data-mode="mode"
        class="relative flex max-h-[70vh] w-full max-w-[680px] animate-pop flex-col overflow-hidden rounded-2xl bg-raised text-fg shadow-dialog"
        @keydown="onKeydown"
      >
        <div class="flex items-center gap-3 border-b border-line px-4">
          <component
            :is="mode === 'ask' ? Sparkles : Search"
            class="size-4 shrink-0"
            :class="mode === 'ask' ? 'text-accent-fg' : 'text-fg-subtle'"
            aria-hidden="true"
          />
          <input
            v-model="query"
            role="combobox"
            :aria-expanded="mode === 'go'"
            :aria-label="mode === 'ask' ? t('palette.askLabel') : t('palette.title')"
            :aria-controls="listId"
            :aria-activedescendant="mode === 'go' && flat.length > 0 ? optionId(index) : undefined"
            :placeholder="mode === 'ask' ? t('palette.askPlaceholder') : t('palette.placeholder')"
            class="h-14 min-w-0 flex-1 bg-transparent text-[15px] text-fg placeholder:text-fg-subtle focus:outline-none"
          />
          <span
            v-if="askOffered"
            class="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-caption font-medium"
            :class="mode === 'ask' ? 'bg-accent-soft text-accent-fg' : 'text-fg-subtle'"
            aria-hidden="true"
            ><DsKbd>{{ KEYS.tab }}</DsKbd
            >{{ mode === 'ask' ? t('palette.modeCommands') : t('palette.modeAsk') }}</span
          >
        </div>
        <div v-if="mode === 'ask'" class="flex items-start gap-3 px-5 py-6 text-ui text-fg-muted">
          <span class="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-fg">
            <Sparkles class="size-4" aria-hidden="true" />
          </span>
          <div class="min-w-0">
            <p class="font-medium text-fg">{{ t('palette.askTitle') }}</p>
            <p class="mt-0.5 text-small text-fg-subtle">{{ t('palette.askHint') }}</p>
          </div>
          <CornerDownLeft class="ml-auto size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
        </div>
        <div
          v-else
          :id="listId"
          role="listbox"
          :aria-label="t('palette.title')"
          class="min-h-0 flex-1 overflow-auto p-1.5"
        >
          <div
            v-for="g in groups"
            :key="g.id"
            role="group"
            :aria-label="g.label ?? t(`palette.groups.${g.id}`)"
            class="mb-1"
          >
            <div class="flex items-center justify-between gap-2 px-2.5 pt-2 pb-1">
              <p class="text-caption font-medium text-fg-subtle" aria-hidden="true">
                {{ g.label ?? t(`palette.groups.${g.id}`) }}
              </p>
              <!-- User request 2026-10-10: Recent can be cleared (by keyboard: the command of the same name). -->
              <button
                v-if="g.id === 'places'"
                type="button"
                tabindex="-1"
                data-clear-recent
                class="rounded-md px-1.5 text-caption text-fg-subtle hover:bg-subtle hover:text-fg"
                :title="t('palette.commands.clearRecent')"
                @mousedown.prevent
                @click="places.clearRecent()"
              >
                {{ t('palette.clearRecent') }}
              </button>
            </div>
            <div
              v-for="entry in g.items"
              :id="optionId(position(entry))"
              :key="entry.id"
              role="option"
              :aria-selected="position(entry) === index"
              class="flex h-9 cursor-pointer items-center gap-3 rounded-lg px-2.5 text-ui"
              :class="position(entry) === index ? 'bg-subtle text-fg' : 'text-fg-muted'"
              @mousemove="index = position(entry)"
              @click="runAt(position(entry))"
            >
              <span
                class="grid size-6 shrink-0 place-items-center rounded-md ring-1 ring-inset"
                :class="
                  position(entry) === index
                    ? 'bg-accent-soft text-accent-fg ring-accent/20'
                    : 'bg-subtle text-fg-subtle ring-line'
                "
              >
                <component :is="entry.icon" class="size-3.5" aria-hidden="true" />
              </span>
              <span class="min-w-0 flex-1 truncate">{{ entry.title }}</span>
              <span v-if="entry.hint" class="shrink-0 truncate text-small text-fg-subtle">{{
                entry.hint
              }}</span>
              <span v-if="entry.keys" class="flex shrink-0 gap-0.5">
                <DsKbd v-for="k in entry.keys" :key="k">{{ keyLabel(k) }}</DsKbd>
              </span>
            </div>
          </div>
          <p v-if="flat.length === 0" class="px-4 py-8 text-center text-ui text-fg-subtle">
            {{ t('palette.empty') }}
          </p>
        </div>
        <footer
          class="flex items-center gap-4 border-t border-line bg-canvas px-4 py-2 text-caption text-fg-subtle"
          aria-hidden="true"
        >
          <span v-if="mode === 'go'" class="flex items-center gap-1"
            ><DsKbd>{{ KEYS.up }}</DsKbd
            ><DsKbd>{{ KEYS.down }}</DsKbd
            >{{ t('palette.hintMove') }}</span
          >
          <span class="flex items-center gap-1"
            ><DsKbd>{{ KEYS.enter }}</DsKbd
            >{{ mode === 'ask' ? t('palette.hintAsk') : t('palette.hintRun') }}</span
          >
          <span class="flex items-center gap-1"
            ><DsKbd>{{ KEYS.escape }}</DsKbd
            >{{ t('palette.hintClose') }}</span
          >
        </footer>
      </div>
    </div>
  </Teleport>
</template>
