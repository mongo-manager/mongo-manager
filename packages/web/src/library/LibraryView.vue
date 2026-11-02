<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRef, watch, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import {
  BookMarked,
  History,
  Pencil,
  Pin,
  PinOff,
  Search,
  SquareCode,
  Star,
  Trash2,
  Workflow,
  X,
} from 'lucide-vue-next'
import { MAX_LIBRARY_PINS, type LibraryItem, type SnippetParam } from '@mongo-manager/shared/browser'
import { ApiError } from '@/api/client'
import { connectionsApi, queryKeys } from '@/api/connections'
import { favouritesApi, libraryApi } from '@/api/library'
import { snippetsApi } from '@/api/snippets'
import { aggregateApi } from '@/api/aggregate'
import { describeError } from '@/api/errors'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import DsCallout from '@/ds/DsCallout.vue'
import DsPageHeader from '@/ds/DsPageHeader.vue'
import DsBadge from '@/ds/DsBadge.vue'
import DsButton from '@/ds/DsButton.vue'
import DsChip from '@/ds/DsChip.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsIconButton from '@/ds/DsIconButton.vue'
import DsMenu from '@/ds/DsMenu.vue'
import DsInput from '@/ds/DsInput.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import DsSelect from '@/ds/DsSelect.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import SaveItemDialog from './SaveItemDialog.vue'
import SaveSnippetDialog, { type EditedSnippet } from '@/shell/SaveSnippetDialog.vue'
import { saveError } from './errors'
import { useLibraryStore, type LibraryTypeFilter } from './store'
import { openLibraryItem } from './openItem'

/**
 * Phase 2c spec §3: a connection's favourites, saved pipelines, shell snippets and history,
 * searchable. User request 2026-10-10: a page of its own ("Queries"), no longer a side panel — and
 * always on a connection, so it is never empty for want of one.
 */
type ItemType = LibraryItem['type']
type TypeFilter = LibraryTypeFilter
const TYPES: ItemType[] = ['favourite', 'pipeline', 'snippet', 'history']
const SEARCH_DELAY_MS = 300
/** Separates db and coll in the collection select (neither can hold a NUL). */
const SEP = '\u0000'
const TYPE_ICONS: Record<ItemType, Component> = {
  favourite: Star,
  pipeline: Workflow,
  snippet: SquareCode,
  history: History,
}
const TYPE_TONES: Record<ItemType, string> = {
  favourite: 'bg-warning-soft text-warning',
  pipeline: 'bg-accent-soft text-accent-fg',
  snippet: 'bg-info-soft text-info',
  history: 'bg-subtle text-fg-muted',
}

const { t, locale } = useI18n()
const library = useLibraryStore()
const dialogs = useDialogStore()
const toasts = useToastStore()
const queryClient = useQueryClient()
const searchField = ref<InstanceType<typeof DsInput> | null>(null)

const {
  data: connections,
  error: connectionsError,
  refetch: refetchConnections,
} = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
/** The connection searched is one of the list (review M3): none is searched before the list is known. */
const known = computed(
  () => !!connections.value && connections.value.some((c) => c.id === library.connectionId),
)

// What the page searched stays in the store (review M4): it shows again as it was left.
const q = toRef(library.filters, 'q')
const typeFilter = toRef(library.filters, 'type')
const type = computed<ItemType | null>(() => (typeFilter.value === 'all' ? null : typeFilter.value))
const tag = toRef(library.filters, 'tag')
const scope = toRef(library.filters, 'scope')
const namespaces = toRef(library.filters, 'namespaces')
const items = ref<LibraryItem[]>([])
const truncated = ref(false)
// Loading until the first answer: never "nothing saved" before anything was asked (review M3).
const loading = ref(true)
const error = ref('')
/** Every tag of what matches, from the server: choosing one keeps the others on offer. */
const tags = ref<string[]>([])

let controller: AbortController | undefined
let timer: ReturnType<typeof setTimeout> | undefined
/** What the search in flight asks: the same question asked again meanwhile is not sent twice. */
let asking = ''

async function search(): Promise<void> {
  clearTimeout(timer)
  const connectionId = known.value ? library.connectionId : null
  const question = JSON.stringify([connectionId, q.value.trim(), type.value, tag.value, scope.value])
  if (controller && !controller.signal.aborted && question === asking) return
  controller?.abort()
  error.value = ''
  truncated.value = false
  if (!connectionId) {
    items.value = []
    tags.value = []
    loading.value = false
    controller = undefined
    return
  }
  const mine = new AbortController()
  controller = mine
  asking = question
  loading.value = true
  const [db, coll] = scope.value ? scope.value.split(SEP) : []
  try {
    const result = await libraryApi.search(
      connectionId,
      {
        q: q.value.trim() || undefined,
        type: type.value ?? undefined,
        tags: tag.value ? [tag.value] : undefined,
        db,
        coll,
      },
      mine.signal,
    )
    if (mine.signal.aborted) return
    items.value = result.items
    truncated.value = result.truncated
    tags.value = result.tags ?? []
    if (!scope.value) {
      const seen = new Set(namespaces.value)
      for (const i of result.items) if (i.db && i.coll) seen.add(`${i.db}${SEP}${i.coll}`)
      namespaces.value = [...seen].sort((a, b) => a.localeCompare(b))
    }
  } catch (e) {
    if (mine.signal.aborted) return
    items.value = []
    error.value = describeError(e, t)
  } finally {
    if (controller === mine) {
      loading.value = false
      controller = undefined
    }
  }
}

function later(): void {
  clearTimeout(timer)
  timer = setTimeout(() => void search(), SEARCH_DELAY_MS)
}

watch(q, later)
watch([type, tag, scope], () => void search())
// Another connection: its rows go at once (review I6), with what belonged to the one it leaves.
watch(
  () => library.connectionId,
  (id) => {
    if (library.filters.connectionId !== id) {
      library.filters.connectionId = id
      tag.value = null
      scope.value = ''
      namespaces.value = []
      items.value = []
      tags.value = []
      truncated.value = false
    }
    void search()
  },
  { immediate: true },
)
// The page searches a connection there is: the one it was opened for, else the first one.
watch(
  connections,
  (list) => {
    if (!list) return
    if (!list.some((c) => c.id === library.connectionId)) library.connectionId = list[0]?.id ?? null
    void search()
  },
  { immediate: true },
)
onMounted(() => searchField.value?.focus())
onBeforeUnmount(() => {
  clearTimeout(timer)
  controller?.abort()
})

const connectionOptions = computed(() =>
  (connections.value ?? []).map((c) => ({ value: c.id, label: c.name })),
)
const connectionModel = computed({
  get: () => library.connectionId ?? '',
  set: (id: string) => (library.connectionId = id || null),
})
const connection = computed(() => (connections.value ?? []).find((c) => c.id === library.connectionId))
const isAdmin = computed(() => connection.value?.access === 'admin')
const typeOptions = computed(() => [
  { value: 'all' as TypeFilter, label: t('library.allTypes') },
  ...TYPES.map((kind) => ({ value: kind as TypeFilter, label: t(`library.typePlural.${kind}`) })),
])
/** The collections offered: those the items were about, and the one the page was opened from. */
const scopeOptions = computed(() => [
  { value: '', label: t('library.allCollections') },
  ...[
    ...new Set([
      ...namespaces.value,
      ...(library.origin ? [`${library.origin.db}${SEP}${library.origin.coll}`] : []),
      ...(scope.value ? [scope.value] : []),
    ]),
  ]
    .sort((a, b) => a.localeCompare(b))
    .map((ns) => ({ value: ns, label: ns.replace(SEP, '.') })),
])

/** Clearing is offered wherever history may be listed, even when none matches the search. */
const hasHistory = computed(
  () => library.connectionId !== null && (type.value === null || type.value === 'history'),
)

const time = (iso: string) =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))

/** Where a row opens, in words: a shell's code in the shell, any other in its collection. */
const openLabel = (item: LibraryItem) => t(item.kind === 'shell' ? 'library.openInShell' : 'library.open')
const saved = (item: LibraryItem) => item.type !== 'history'
// W5 review: what local mode saved (no owner) is a connection admin's to change, as the server allows.
const mayEdit = (item: LibraryItem) => saved(item) && (item.mine || (!!item.ownerless && isAdmin.value))
/** The owner, or a connection admin, as the server allows. */
const mayDelete = (item: LibraryItem) => saved(item) && (item.mine || isAdmin.value)
const targetOf = (item: LibraryItem) => ({
  connectionId: library.connectionId!,
  db: item.db,
  coll: item.coll,
})
const filtered = computed(
  () => q.value.trim() !== '' || type.value !== null || tag.value !== null || scope.value !== '',
)

async function open(item: LibraryItem): Promise<void> {
  if (!library.connectionId) return
  try {
    await openLibraryItem(library.connectionId, item, { t, queryClient })
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  }
}

// ---- W1 (completion §2): a saved query pinned by this user is listed first, here and on Home.
const pinnable = (item: LibraryItem): item is LibraryItem & { type: 'favourite' | 'pipeline' } =>
  item.type === 'favourite' || item.type === 'pipeline'
async function togglePin(item: LibraryItem): Promise<void> {
  if (!library.connectionId || !pinnable(item)) return
  try {
    await libraryApi.pin(library.connectionId, { type: item.type, id: item.id, pinned: !item.pinned })
    // W1 review (minor 13): Home's queries widget lists pins first: it reads them again.
    void queryClient.invalidateQueries({ queryKey: ['overview', 'library'] })
    await search()
  } catch (e) {
    const limit = e instanceof ApiError && (e.details as { reason?: unknown } | undefined)?.reason === 'limit'
    toasts.push({
      kind: 'error',
      message: limit
        ? t('explorer.pins.limit', { max: (e.details as { max?: number }).max ?? MAX_LIBRARY_PINS })
        : describeError(e, t),
    })
  }
}

async function removeEntry(item: LibraryItem): Promise<void> {
  if (!library.connectionId) return
  try {
    await libraryApi.removeHistory(library.connectionId, item.id)
    items.value = items.value.filter((i) => i !== item)
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  }
}

async function clearHistory(): Promise<void> {
  const connectionId = library.connectionId
  if (!connectionId) return
  const ok = await dialogs.confirm({
    title: t('library.clearHistory'),
    message: t('library.clearHistoryConfirm'),
    confirmLabel: t('library.clearHistory'),
    danger: true,
  })
  if (!ok) return
  try {
    await libraryApi.clearHistory(connectionId)
    // Review M9: only if the rows shown are still that connection's.
    if (library.connectionId === connectionId) items.value = items.value.filter((i) => i.type !== 'history')
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  }
}

// ---- Favourites, saved pipelines and snippets: rename, re-tag, share, delete (final review 2c, I2)
const editing = ref<LibraryItem | null>(null)
const editBusy = ref(false)
const editError = ref('')
const EDIT_TITLES: Record<ItemType, string> = {
  favourite: 'library.editFavourite',
  pipeline: 'library.editPipeline',
  snippet: 'library.editSnippet',
  history: 'library.editPipeline',
}

function edit(item: LibraryItem): void {
  editError.value = ''
  editing.value = item
}

async function onEdit(change: { name: string; tags: string[]; shared: boolean }): Promise<void> {
  const item = editing.value
  if (!item || editBusy.value) return
  editBusy.value = true
  editError.value = ''
  try {
    if (item.type === 'favourite')
      await favouritesApi.update(targetOf(item), item.id, {
        name: change.name,
        tags: change.tags,
        query: item.body as never,
        shared: change.shared,
      })
    else
      await aggregateApi.pipelines.update(targetOf(item), item.id, {
        name: change.name,
        stages: item.body as unknown[],
        tags: change.tags,
        shared: change.shared,
      })
    editing.value = null
    await search()
  } catch (e) {
    editError.value = saveError(e, t)
  } finally {
    editBusy.value = false
  }
}

/** W5: a snippet is edited whole (its code and parameters too), in the snippet dialog. */
const editedSnippet = computed<EditedSnippet | null>(() => {
  const item = editing.value
  if (item?.type !== 'snippet') return null
  const body = item.body as { code: string; params: SnippetParam[] }
  return {
    id: item.id,
    name: item.name ?? '',
    tags: item.tags,
    code: body.code,
    params: body.params,
    shared: item.shared,
  }
})

async function onSnippetSaved(): Promise<void> {
  editing.value = null
  await search()
}

async function remove(item: LibraryItem): Promise<void> {
  const ok = await dialogs.confirm({
    title: t('library.deleteTitle'),
    message: t('library.deleteMessage', { name: item.name ?? '' }),
    confirmLabel: t('library.delete'),
    danger: true,
  })
  if (!ok) return
  try {
    if (item.type === 'favourite') await favouritesApi.remove(targetOf(item), item.id)
    else if (item.type === 'snippet') await snippetsApi.remove(library.connectionId!, item.id)
    else await aggregateApi.pipelines.remove(targetOf(item), item.id)
    items.value = items.value.filter((i) => i !== item)
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  }
}
</script>

<template>
  <section data-library-page class="flex h-full min-h-0 flex-col" :aria-label="t('tabs.library')">
    <DsPageHeader :title="t('tabs.library')" :icon="BookMarked" :description="t('library.intro')">
      <template #actions>
        <div v-if="connectionOptions.length" class="w-56 max-w-full">
          <DsSelect
            v-model="connectionModel"
            :label="t('library.connection')"
            hide-label
            size="sm"
            :options="connectionOptions"
          />
        </div>
        <!-- Review of R3–R5 (I-4): clearing every entry is in the header's "…", in danger colour. -->
        <DsMenu
          v-if="hasHistory"
          focusable
          size="header"
          :label="t('library.moreActions')"
          :items="[{ id: 'clear', label: t('library.clearHistory'), icon: Trash2, danger: true }]"
          @select="(id: string) => id === 'clear' && clearHistory()"
        />
      </template>
    </DsPageHeader>
    <div class="min-h-0 flex-1 overflow-auto">
      <div class="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-5">
        <DsEmptyState
          v-if="connections && !connections.length"
          :icon="BookMarked"
          :title="t('library.noConnections')"
          :description="t('library.noConnectionsHint')"
        />

        <template v-else>
          <div class="flex flex-col gap-3 rounded-xl border border-line bg-surface p-3 shadow-xs">
            <div class="flex flex-wrap items-center gap-2">
              <div class="min-w-56 flex-1">
                <DsInput
                  ref="searchField"
                  v-model="q"
                  type="search"
                  :label="t('library.search')"
                  hide-label
                  :icon="Search"
                  clearable
                  :placeholder="t('library.search')"
                  autocomplete="off"
                  maxlength="200"
                />
              </div>
              <div class="w-56">
                <DsSelect
                  v-model="scope"
                  :label="t('library.collections')"
                  hide-label
                  :options="scopeOptions"
                />
              </div>
            </div>
            <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
              <DsSegmented
                v-model="typeFilter"
                size="sm"
                :label="t('library.types')"
                :options="typeOptions"
              />
              <div
                v-if="tags.length"
                class="flex flex-wrap items-center gap-1.5"
                role="group"
                :aria-label="t('library.tags')"
              >
                <DsChip
                  v-for="name in tags"
                  :key="name"
                  :label="`#${name}`"
                  :pressed="tag === name"
                  :data-tag="name"
                  @click="tag = tag === name ? null : name"
                />
              </div>
            </div>
          </div>

          <div :aria-busy="loading">
            <DsCallout v-if="error" tone="danger">{{ error }}</DsCallout>
            <DsCallout v-else-if="connectionsError" tone="danger"
              >{{ describeError(connectionsError, t)
              }}<template #action
                ><DsButton size="sm" @click="refetchConnections()">{{
                  t('library.retry')
                }}</DsButton></template
              ></DsCallout
            >
            <ul
              v-else-if="!connections || (loading && !items.length)"
              data-library-loading
              class="flex flex-col divide-y divide-line rounded-xl border border-line bg-surface"
              :aria-label="t('library.loading')"
            >
              <li v-for="i in 4" :key="i" class="flex items-center gap-3 p-3">
                <DsSkeleton class="size-8 shrink-0 rounded-lg" />
                <span class="flex flex-1 flex-col gap-1.5">
                  <DsSkeleton class="h-3.5 w-40" />
                  <DsSkeleton class="h-3 w-72 max-w-full" />
                </span>
              </li>
            </ul>
            <DsEmptyState
              v-else-if="!items.length"
              :icon="filtered ? Search : BookMarked"
              :title="filtered ? t('library.empty') : t('library.nothingYet')"
              :description="filtered ? t('library.emptyHint') : t('library.nothingYetHint')"
            />
            <ul
              v-else
              class="flex flex-col divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface"
            >
              <li
                v-for="item in items"
                :key="`${item.type}:${item.id}`"
                data-library-item
                :data-type="item.type"
                class="group flex items-start gap-3 px-3 py-2.5 transition-colors duration-120 hover:bg-subtle"
              >
                <span
                  class="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg"
                  :class="TYPE_TONES[item.type]"
                  :title="t(`library.type.${item.type}`)"
                >
                  <component :is="TYPE_ICONS[item.type]" class="size-4" aria-hidden="true" />
                  <span class="sr-only">{{ t(`library.type.${item.type}`) }}</span>
                </span>
                <button
                  type="button"
                  data-action="open"
                  class="flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-md text-left"
                  @click="open(item)"
                >
                  <span class="min-w-0 flex-1">
                    <span class="sr-only">{{ openLabel(item) }}: </span>
                    <!-- The badges first: a long query is cut short, never pushing them to a line of their own. -->
                    <span class="flex min-w-0 items-center gap-2">
                      <DsBadge v-if="item.pinned" tone="accent" class="shrink-0" data-pinned>
                        <Pin class="size-3" aria-hidden="true" />{{ t('explorer.pins.pinned') }}
                      </DsBadge>
                      <DsBadge class="shrink-0">{{ t(`library.kind.${item.kind}`) }}</DsBadge>
                      <DsBadge v-if="item.shared" tone="accent" class="shrink-0">{{
                        t('library.shared')
                      }}</DsBadge>
                      <span v-if="item.name" class="min-w-0 truncate text-ui font-medium text-fg">{{
                        item.name
                      }}</span>
                      <span
                        v-else
                        class="min-w-0 truncate font-mono text-small text-fg"
                        :title="item.preview"
                        >{{ item.preview }}</span
                      >
                    </span>
                    <span
                      v-if="item.name"
                      class="mt-0.5 block truncate font-mono text-small text-fg-muted"
                      :title="item.preview"
                      >{{ item.preview }}</span
                    >
                    <span
                      class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-small text-fg-subtle"
                    >
                      <span v-if="item.kind !== 'shell'" class="font-mono"
                        >{{ item.db }}.{{ item.coll }}</span
                      >
                      <span v-if="item.kind !== 'shell'" aria-hidden="true">·</span>
                      <span>{{ time(item.at) }}</span>
                      <template v-if="item.count && item.count > 1">
                        <span aria-hidden="true">·</span>
                        <span>{{ t('library.times', { n: item.count }) }}</span>
                      </template>
                      <span
                        v-for="name in item.tags"
                        :key="name"
                        class="rounded bg-muted px-1.5 font-mono text-[11.5px]"
                        >#{{ name }}</span
                      >
                    </span>
                  </span>
                  <!-- Seen, not a control of its own: the whole row opens it (review M8). -->
                  <span
                    aria-hidden="true"
                    class="mt-0.5 inline-flex h-7 shrink-0 items-center rounded-md border border-line-strong bg-surface px-2.5 text-small font-medium text-fg shadow-xs transition-colors duration-120 group-hover:border-accent group-hover:text-accent-fg max-sm:hidden"
                    >{{ t('library.openShort') }}</span
                  >
                </button>
                <span class="flex shrink-0 items-center gap-1">
                  <DsIconButton
                    v-if="pinnable(item)"
                    size="sm"
                    :icon="item.pinned ? PinOff : Pin"
                    :active="item.pinned"
                    data-action="pin"
                    :label="
                      t(item.pinned ? 'explorer.pins.unpin' : 'explorer.pins.pin', { name: item.name ?? '' })
                    "
                    @click="togglePin(item)"
                  />
                  <DsIconButton
                    v-if="mayEdit(item)"
                    size="sm"
                    :icon="Pencil"
                    data-action="edit"
                    :label="t('library.editNamed', { name: item.name })"
                    @click="edit(item)"
                  />
                  <DsIconButton
                    v-if="mayDelete(item)"
                    size="sm"
                    :icon="Trash2"
                    data-action="delete"
                    :label="t('library.deleteNamed', { name: item.name })"
                    @click="remove(item)"
                  />
                  <DsIconButton
                    v-if="item.type === 'history'"
                    size="sm"
                    :icon="X"
                    data-action="remove"
                    :label="t('library.removeEntry', { what: `${item.db}.${item.coll} ${item.preview}` })"
                    @click="removeEntry(item)"
                  />
                </span>
              </li>
            </ul>
            <p v-if="truncated" class="mt-2 text-small text-fg-subtle">{{ t('library.truncated') }}</p>
          </div>
        </template>
      </div>
    </div>
    <SaveSnippetDialog
      v-if="editedSnippet"
      :connection-id="library.connectionId!"
      code=""
      :snippet="editedSnippet"
      @saved="onSnippetSaved"
      @close="editing = null"
    />
    <SaveItemDialog
      v-else-if="editing"
      :title="t(EDIT_TITLES[editing.type])"
      :name="editing.name"
      :tags="editing.tags"
      :shared="editing.shared"
      :busy="editBusy"
      :error="editError"
      @save="onEdit"
      @close="editing = null"
    />
  </section>
</template>
