<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { Ellipsis, FilterX, History, RotateCw, Search, Trash2, Users } from 'lucide-vue-next'
import { AI_HISTORY_ACTIONS, type AiHistoryItem, type AiHistoryThread } from '@mongo-manager/shared/browser'
import DsPageHeader from '@/ds/DsPageHeader.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsCard from '@/ds/DsCard.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import DsButton from '@/ds/DsButton.vue'
import DsDataTable from '@/ds/DsDataTable.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsInput from '@/ds/DsInput.vue'
import DsMenu from '@/ds/DsMenu.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import DsSelect from '@/ds/DsSelect.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import type { DsMenuItem } from '@/ds/menu'
import type { DsColumn } from '@/ds/table'
import { aiHistoryApi, aiHistoryKeys, type AiHistoryFilter } from '@/api/aiHistory'
import { describeError } from '@/api/errors'
import { ApiError } from '@/api/client'
import { useSessionStore } from '@/stores/session'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import { dayOf } from '@/jobs/present'
import { useTabsStore } from '@/stores/tabs'
import { openAiSettingsTab } from '@/workspace/openTabs'
import RequestPage from './RequestPage.vue'
import HistoryLine from './HistoryLine.vue'
import { useHistoryWords } from './historyWords'
import { useSharing } from './sharing'

/**
 * User review 2026-10-09 ("AI yaptırdığımız işleri nerde görüyoruz … kaç token … maliyet"): the AI
 * history — the user's usage and cost over a period, by model (and, for an administrator, by user),
 * and each request by day; one opens as a page, its id in the tab and the URL (ai-history/<id>).
 */
const props = defineProps<{ requestId?: string }>()
const w = useHistoryWords()
const session = useSessionStore()
const dialogs = useDialogStore()
const toasts = useToastStore()
const queryClient = useQueryClient()
const admin = computed(() => session.can('settings:manage'))
const tabs = useTabsStore()

// ---- Usage over a period
const days = ref<'7' | '30' | '90'>('30')
const everyone = ref(false)
const periods = computed(() =>
  (['7', '30', '90'] as const).map((n) => ({ value: n, label: w.t('aiHistory.period', { n: Number(n) }) })),
)
const usage = useQuery({
  queryKey: computed(() => aiHistoryKeys.usage(Number(days.value), everyone.value && admin.value)),
  queryFn: () => aiHistoryApi.usage(Number(days.value), everyone.value && admin.value),
})
const totals = computed(() => usage.data.value?.totals ?? null)
type Usage = NonNullable<typeof usage.data.value>
type ByModel = Usage['byModel'][number]
type ByUser = NonNullable<Usage['byUser']>[number]
// Percentages, so the name keeps a share of a half-width card as of a full one.
const usageColumns = (first: DsColumn): DsColumn[] => [
  first,
  { key: 'requests', label: w.t('aiHistory.cards.requests'), align: 'right', width: '16%' },
  { key: 'tokens', label: w.t('aiHistory.tokens'), align: 'right', width: '28%' },
  { key: 'cost', label: w.t('aiHistory.cost'), align: 'right', width: '22%' },
]
const modelColumns = computed(() => usageColumns({ key: 'model', label: w.t('aiHistory.model') }))
const userColumns = computed(() => usageColumns({ key: 'user', label: w.t('aiHistory.user') }))
/** Shown while the totals load. */
const NONE = '—'
const kept = useQuery({ queryKey: aiHistoryKeys.settings, queryFn: aiHistoryApi.settings })
const sharing = useSharing()
const intro = computed(() =>
  [w.t(sharing.available.value ? 'aiHistory.introSharing' : 'aiHistory.intro'), keptLine.value]
    .filter(Boolean)
    .join(' '),
)
const keptLine = computed(() => {
  const s = kept.data.value
  if (!s) return null
  return s.keepContent
    ? w.t('aiHistory.keptFor', { days: s.days }, s.days)
    : w.t('aiHistory.keptNoWords', { days: s.days }, s.days)
})

// ---- The requests, newest first, a page at a time
const filter = reactive<AiHistoryFilter>({
  action: undefined,
  outcome: undefined,
  q: undefined,
  shared: undefined,
})
/** User review 2026-10-09: one's own requests, or what teammates shared (when there is a team). */
const scope = computed({
  get: () => (filter.shared ? 'shared' : 'mine'),
  set: (v: 'mine' | 'shared') => (filter.shared = v === 'shared' ? '1' : undefined),
})
const scopes = computed(() => [
  { value: 'mine' as const, label: w.t('aiHistory.share.mine') },
  { value: 'shared' as const, label: w.t('aiHistory.share.withMe') },
])
const search = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
watch(search, (text) => {
  clearTimeout(timer)
  timer = setTimeout(() => (filter.q = text.trim() || undefined), 250)
})
const items = ref<AiHistoryItem[]>([])
const now = ref(Date.now())
const next = ref<string | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
let asked = 0
/** The last read asked for, so Retry asks for it again (a page more, or the list from the top). */
let lastAsked: [more: boolean, again: boolean] = [false, false]
/**
 * A page more, or the list again from the top — counted again (`again`), as many as were showing
 * (up to 100), so "Show more" is not undone by a price entered or a step removed.
 */
async function load(more = false, again = false): Promise<void> {
  const size = again ? Math.min(100, Math.max(50, items.value.length)) : 50
  const ask = ++asked
  lastAsked = [more, again]
  const cursor = more ? (next.value ?? undefined) : undefined
  if (!more) next.value = null
  loading.value = true
  error.value = null
  try {
    const page = await aiHistoryApi.page({ ...filter }, cursor, size)
    if (ask !== asked) return
    now.value = Date.now()
    items.value = more ? [...items.value, ...page.items] : page.items
    next.value = page.next
  } catch (e) {
    if (ask === asked) error.value = describeError(e, w.t)
  } finally {
    if (ask === asked) loading.value = false
  }
}
watch(filter, () => void load(), { immediate: true, deep: true })
const retry = () => load(...lastAsked)
const actionOptions = computed(() => [
  { value: '', label: w.t('aiHistory.filter.allActions') },
  ...AI_HISTORY_ACTIONS.map((a) => ({ value: a as string, label: w.action(a) })),
])
const narrowed = computed(() => !!(filter.action || filter.outcome || filter.q))
function clear(): void {
  Object.assign(filter, { action: undefined, outcome: undefined, q: undefined })
  search.value = ''
}
const outcomes = computed(() => [
  { value: 'all' as const, label: w.t('aiHistory.filter.all') },
  { value: 'ok' as const, label: w.t('aiHistory.filter.ok') },
  { value: 'failed' as const, label: w.t('aiHistory.filter.failed') },
])
const outcome = computed({
  get: () => filter.outcome ?? 'all',
  set: (v: 'all' | 'ok' | 'failed') => (filter.outcome = v === 'all' ? undefined : v),
})
const groups = computed(() => {
  const out: Array<{ key: string; label: string; items: AiHistoryItem[] }> = []
  for (const item of items.value) {
    const day = dayOf(item.chain?.at ?? item.at, now.value, w.locale.value)
    const label = day.label === 'today' || day.label === 'yesterday' ? w.t(`jobs.ui.${day.label}`) : day.label
    const last = out.at(-1)
    if (last?.key === day.key) last.items.push(item)
    else out.push({ key: day.key, label, items: [item] })
  }
  return out
})

// ---- One request's details, and removing
/**
 * User review 2026-10-09 ("url ai-history/istekId olsun"): the request open is the tab's — and so the
 * URL's — read from the server by its id; a link opens it straight away. Without a tab of its own (a
 * test), the page keeps it itself.
 */
const openId = ref<string | null>(props.requestId ?? null)
watch(
  () => props.requestId,
  (id) => (openId.value = id ?? null),
)
const ownTab = computed(() => (tabs.active?.kind === 'aiHistory' ? tabs.active.id : null))
function show(id: string | null): void {
  openId.value = id
  if (ownTab.value) tabs.setView(ownTab.value, { requestId: id })
}
const opened = useQuery({
  queryKey: computed(() => aiHistoryKeys.item(openId.value ?? '')),
  queryFn: () => aiHistoryApi.get(openId.value!),
  enabled: computed(() => openId.value !== null),
  // Another step of the same chain chosen: the page stays while it is read — never another
  // request's page (page review I1: its Delete would remove that one).
  placeholderData: (previous) => {
    const thread = previous?.thread
    if (!thread || !previous) return undefined
    // A teammate's shared chain is read by its request (share review M7).
    const steps = queryClient.getQueryData<AiHistoryThread>(
      previous.mine === false ? aiHistoryKeys.chain(previous.id) : aiHistoryKeys.thread(thread),
    )?.steps
    return steps?.some((s) => s.id === openId.value) ? previous : undefined
  },
  // A request not there (deleted, past its days, another person's) is said at once.
  retry: (count, e) => !(e instanceof ApiError && e.status === 404) && count < 1,
})
const selected = computed(() => (openId.value ? (opened.data.value ?? null) : null))
const missing = computed(() => openId.value !== null && opened.isError.value)
/** A chain opens on its latest step; a request alone on itself. */
const select = (item: AiHistoryItem) => show(item.chain?.latest ?? item.id)
function close(): void {
  const open = selected.value
  show(null)
  // Back on the list, the focus returns to the line that was opened — or to the list's heading.
  const line = open?.thread ? `[data-thread="${open.thread}"]` : open ? `[data-request="${open.id}"]` : null
  void nextTick(() =>
    (
      (line ? document.querySelector<HTMLElement>(`${line} button`) : null) ??
      document.getElementById('ai-history-requests')
    )?.focus({ preventScroll: true }),
  )
}
/** Back to the list after deleting what was shown; the focus on the list's heading. */
function closeDeleted(): void {
  show(null)
  void nextTick(() => document.getElementById('ai-history-requests')?.focus({ preventScroll: true }))
}
// The history changed elsewhere (a price entered prices old requests, a setting forgot words, a
// request removed here): every AI history query is counted again, and the list is read again with it.
let reloading = false
const offCache = queryClient.getQueryCache().subscribe((event) => {
  const [a, b] = event.query.queryKey as unknown[]
  if (event.type !== 'updated' || event.action.type !== 'invalidate' || a !== 'ai' || b !== 'history') return
  if (reloading) return
  reloading = true
  queueMicrotask(() => {
    reloading = false
    void load(false, true)
  })
})
onBeforeUnmount(offCache)
const refresh = () => queryClient.invalidateQueries({ queryKey: aiHistoryKeys.all })
async function remove(item: AiHistoryItem): Promise<void> {
  const ok = await dialogs.confirm({
    title: w.t('aiHistory.removeTitle'),
    message: w.t('aiHistory.removeMessage'),
    confirmLabel: w.t('aiHistory.remove'),
    danger: true,
  })
  if (!ok) return
  try {
    await aiHistoryApi.remove(item.id)
    if (openId.value === item.id) closeDeleted()
    await refresh()
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, w.t) })
  }
}
/** User review 2026-10-09: one step of a chain, or the whole chain. */
async function removeStep(step: AiHistoryItem): Promise<void> {
  const ok = await dialogs.confirm({
    title: w.t('aiHistory.removeTitle'),
    message: w.t('aiHistory.removeMessage'),
    confirmLabel: w.t('aiHistory.remove'),
    danger: true,
  })
  if (!ok) return
  try {
    await aiHistoryApi.remove(step.id)
    // The step shown went: the chain's latest step left is shown, or the list when none is.
    if (openId.value === step.id) {
      const left = step.thread ? (await aiHistoryApi.thread(step.thread).catch(() => null))?.steps : null
      show(left?.at(-1)?.id ?? null)
    }
    await refresh()
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, w.t) })
  }
}
async function removeChain(item: AiHistoryItem): Promise<void> {
  const ok = await dialogs.confirm({
    title: w.t('aiHistory.chain.removeTitle'),
    message: w.t('aiHistory.chain.removeMessage'),
    confirmLabel: w.t('aiHistory.chain.remove'),
    danger: true,
  })
  if (!ok || !item.thread) return
  try {
    await aiHistoryApi.removeThread(item.thread)
    closeDeleted()
    await refresh()
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, w.t) })
  }
}
async function removeAll(): Promise<void> {
  const ok = await dialogs.confirm({
    title: w.t('aiHistory.removeAllTitle'),
    message: w.t('aiHistory.removeAllMessage'),
    confirmLabel: w.t('aiHistory.removeAll'),
    danger: true,
  })
  if (!ok) return
  try {
    await aiHistoryApi.removeAll()
    closeDeleted()
    await refresh()
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, w.t) })
  }
}

/** Spec §2: a destructive action lives in the list's "…" menu, never as a toolbar button. */
const listMenu = computed<DsMenuItem[]>(() => [
  { id: 'removeAll', label: w.t('aiHistory.removeAll'), icon: Trash2, danger: true },
])
function onListMenu(id: string): void {
  if (id === 'removeAll') void removeAll()
}
</script>

<template>
  <section class="flex h-full min-h-0" data-ai-history :aria-label="w.t('aiHistory.title')">
    <!-- Kept (hidden) while a request is open, so going back finds the list where it was. -->
    <div v-show="!openId" data-history-list class="flex min-h-0 min-w-0 flex-1 flex-col">
      <DsPageHeader :title="w.t('aiHistory.title')" :icon="History" :description="intro">
        <template #actions>
          <DsCheckbox v-if="admin" v-model="everyone" class="px-1" :label="w.t('aiHistory.everyone')" />
          <DsSegmented v-model="days" size="sm" :label="w.t('aiHistory.periodLabel')" :options="periods" />
        </template>
      </DsPageHeader>
      <div class="min-h-0 flex-1 overflow-auto">
        <div class="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-5">
          <!-- Spec §2: the usage as one card of figures (StatGrid's look; its figures carry marks and
               a link of their own, which StatGrid has no place for). -->
          <dl
            data-usage
            class="flex flex-wrap gap-px overflow-hidden rounded-card border border-line bg-line shadow-xs"
          >
            <div class="flex min-w-36 flex-1 basis-36 flex-col gap-1 bg-surface px-4 py-3">
              <dt class="truncate text-caption font-medium text-fg-subtle">
                {{ w.t('aiHistory.cards.requests') }}
              </dt>
              <dd data-usage-requests class="truncate text-title-m font-semibold text-fg tabular-nums">
                {{ totals ? w.exact(totals.requests) : NONE }}
              </dd>
            </div>
            <div class="flex min-w-36 flex-1 basis-36 flex-col gap-1 bg-surface px-4 py-3">
              <dt class="truncate text-caption font-medium text-fg-subtle">
                {{
                  totals
                    ? w.t('aiHistory.cards.tokensSplit', {
                        input: w.tokens(totals.input),
                        output: w.tokens(totals.output),
                      })
                    : w.t('aiHistory.cards.tokens')
                }}
              </dt>
              <dd data-usage-tokens class="truncate text-title-m font-semibold text-fg tabular-nums">
                {{ totals ? w.tokens(totals.input + totals.output) : NONE }}
              </dd>
            </div>
            <div class="flex min-w-36 flex-1 basis-36 flex-col gap-1 bg-surface px-4 py-3">
              <dt class="truncate text-caption font-medium text-fg-subtle">
                {{
                  totals && !totals.cost.length
                    ? w.t('aiHistory.cards.costUnpriced')
                    : w.t('aiHistory.cards.cost')
                }}
              </dt>
              <dd data-usage-cost class="truncate text-title-m font-semibold text-fg tabular-nums">
                {{ totals?.cost.length ? w.costs(totals.cost) : NONE }}
              </dd>
              <dd v-if="totals && !totals.cost.length && admin">
                <button
                  type="button"
                  data-set-prices
                  class="cursor-pointer rounded-sm text-small font-medium text-accent-fg hover:underline"
                  @click="openAiSettingsTab(tabs)"
                >
                  {{ w.t('aiHistory.cards.setPrices') }}
                </button>
              </dd>
            </div>
          </dl>

          <div
            v-if="usage.data.value && (usage.data.value.byModel.length || usage.data.value.byUser?.length)"
            class="grid gap-3"
            :class="{ 'xl:grid-cols-2': usage.data.value.byModel.length && usage.data.value.byUser?.length }"
          >
            <DsCard v-if="usage.data.value.byModel.length" :title="w.t('aiHistory.byModel')" data-by-model>
              <DsDataTable
                dense
                :label="w.t('aiHistory.byModel')"
                :columns="modelColumns"
                :rows="usage.data.value.byModel"
                :row-key="(m: ByModel) => `${m.provider}/${m.model}`"
              >
                <template #cell-model="{ row: m }">
                  <span class="flex min-w-0 items-baseline gap-1.5" :title="`${m.model} · ${m.provider}`">
                    <span class="truncate text-fg">{{ m.model }}</span>
                    <span class="truncate text-small text-fg-subtle">{{ m.provider }}</span>
                  </span>
                </template>
                <template #cell-requests="{ row: m }">{{ w.exact(m.requests) }}</template>
                <template #cell-tokens="{ row: m }"
                  >{{ w.tokens(m.input) }} → {{ w.tokens(m.output) }}</template
                >
                <template #cell-cost="{ row: m }">
                  <span class="block truncate">{{ w.costs(m.cost) }}</span>
                </template>
              </DsDataTable>
            </DsCard>
            <DsCard v-if="usage.data.value.byUser?.length" :title="w.t('aiHistory.byUser')" data-by-user>
              <DsDataTable
                dense
                :label="w.t('aiHistory.byUser')"
                :columns="userColumns"
                :rows="usage.data.value.byUser"
                :row-key="(u: ByUser) => u.userId ?? 'local'"
              >
                <template #cell-user="{ row: u }">
                  <span class="block truncate text-fg">{{ u.username ?? w.t('aiHistory.localUser') }}</span>
                </template>
                <template #cell-requests="{ row: u }">{{ w.exact(u.requests) }}</template>
                <template #cell-tokens="{ row: u }"
                  >{{ w.tokens(u.input) }} → {{ w.tokens(u.output) }}</template
                >
                <template #cell-cost="{ row: u }">
                  <span class="block truncate">{{ w.costs(u.cost) }}</span>
                </template>
              </DsDataTable>
            </DsCard>
          </div>

          <section aria-labelledby="ai-history-requests" class="flex flex-col gap-3">
            <div class="flex flex-wrap items-center gap-2">
              <h3
                id="ai-history-requests"
                tabindex="-1"
                class="mr-2 outline-none text-caption font-semibold tracking-wide text-fg-subtle uppercase"
              >
                {{ w.t('aiHistory.requests') }}
              </h3>
              <DsSegmented
                v-if="sharing.available.value"
                v-model="scope"
                size="sm"
                data-history-scope
                :label="w.t('aiHistory.share.scopeLabel')"
                :options="scopes"
              />
              <DsSegmented
                v-model="outcome"
                size="sm"
                :label="w.t('aiHistory.filter.label')"
                :options="outcomes"
              />
              <!-- A width of its own: a select sized by its parent shrinks to nothing in a wrapping row. -->
              <div class="w-40">
                <DsSelect
                  :model-value="filter.action ?? ''"
                  size="sm"
                  hide-label
                  :label="w.t('aiHistory.filter.action')"
                  :options="actionOptions"
                  @update:model-value="filter.action = $event || undefined"
                />
              </div>
              <div class="max-w-64 min-w-44 flex-1">
                <DsInput
                  v-model="search"
                  size="sm"
                  :icon="Search"
                  :label="w.t('aiHistory.search')"
                  hide-label
                  clearable
                  :placeholder="w.t('aiHistory.search')"
                />
              </div>
              <div class="ml-auto flex items-center gap-1">
                <DsButton v-if="narrowed" size="sm" variant="ghost" :icon="FilterX" @click="clear">{{
                  w.t('aiHistory.clear')
                }}</DsButton>
                <DsMenu
                  v-if="items.length && !narrowed && !filter.shared"
                  focusable
                  size="md"
                  :icon="Ellipsis"
                  :label="w.t('common.actions')"
                  :items="listMenu"
                  @select="onListMenu"
                />
              </div>
            </div>

            <DsCallout v-if="error" tone="danger">
              {{ error }}
              <template #action>
                <DsButton size="sm" :icon="RotateCw" @click="retry">{{ w.t('common.retry') }}</DsButton>
              </template>
            </DsCallout>
            <div
              v-else-if="loading && !items.length"
              class="flex flex-col gap-2 p-1"
              role="status"
              :aria-label="w.t('aiHistory.loading')"
            >
              <DsSkeleton v-for="n in 4" :key="n" class="h-10" />
            </div>
            <DsEmptyState
              v-else-if="!items.length && !narrowed && filter.shared"
              :icon="Users"
              :title="w.t('aiHistory.share.emptyTitle')"
              :description="w.t('aiHistory.share.emptyHint')"
            />
            <DsEmptyState
              v-else-if="!items.length && !narrowed"
              :icon="History"
              :title="w.t('aiHistory.emptyTitle')"
              :description="w.t('aiHistory.emptyHint')"
            />
            <DsEmptyState v-else-if="!items.length" :icon="FilterX" :title="w.t('aiHistory.noMatch')">
              <template #actions>
                <DsButton size="sm" :icon="FilterX" @click="clear">{{ w.t('aiHistory.clear') }}</DsButton>
              </template>
            </DsEmptyState>
            <div v-for="g in groups" :key="g.key" :data-day="g.key" class="flex flex-col">
              <h4 class="px-2 pb-1.5 text-small font-semibold text-fg-muted">{{ g.label }}</h4>
              <ul
                class="flex flex-col divide-y divide-line/60 rounded-xl border border-line bg-surface p-1 shadow-xs"
              >
                <HistoryLine
                  v-for="item in g.items"
                  :key="item.id"
                  :item="item"
                  :now="now"
                  @select="select"
                />
              </ul>
            </div>
            <DsButton v-if="next" size="sm" class="self-center" :disabled="loading" @click="load(true)">
              {{ filter.q ? w.t('aiHistory.searchOlder') : w.t('aiHistory.more') }}
            </DsButton>
          </section>
        </div>
      </div>
    </div>

    <div v-if="openId" class="min-w-0 flex-1 overflow-auto">
      <RequestPage
        :item="selected"
        :missing="missing"
        :shown-id="openId"
        @back="close"
        @choose="show"
        @remove="remove"
        @remove-step="removeStep"
        @remove-chain="removeChain"
      />
    </div>
  </section>
</template>
