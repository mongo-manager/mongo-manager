<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { uiLanguageOf } from '@mongo-manager/shared/browser'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { ArrowDown, Maximize2, Minimize2, Pencil, Sparkles, SquarePen, X } from 'lucide-vue-next'
import type {
  AiAgentOpen,
  AiAgentPlace,
  AiAgentStep,
  AiChatBlock,
  AiChatTarget,
  AiResult,
} from '@mongo-manager/shared/browser'
import { connectionsApi, queryKeys } from '@/api/connections'
import { aiChatApi } from '@/api/aiChat'
import { decodeValue, toShell } from '@/documents/values'
import { useTabsStore } from '@/stores/tabs'
import { useTabSectionsStore } from '@/stores/tabSections'
import { AI_AGENT_APP_PAGES, AI_AGENT_PAGES, type AiAgentPage } from '@mongo-manager/shared/browser'
import type { AgentFocus } from './store'
import { useCollectionViewsStore } from '@/stores/collectionViews'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import DsButton from '@/ds/DsButton.vue'
import { describeError } from '@/api/errors'
import { currentFor } from '../insert'
import { useAiStatus } from '../useAi'
import { useAiWords } from '../words'
import { useWorkspaceDialogs } from '@/stores/workspaceDialogs'
import {
  ASSISTANT_MIN,
  ASSISTANT_MIN_HEIGHT,
  ASSISTANT_PANEL_ID,
  ASSISTANT_TOGGLE_ID,
  turnViews,
  useAssistantStore,
  WINDOW_BOTTOM,
  WINDOW_MARGIN_X,
  WINDOW_MARGIN_Y,
  type ChatTarget,
  type SampleChoice,
  type TurnView,
} from './store'
import { chatTargetOf, insertFromChat, runPipelineIn, runQueryIn, showIn, tabForTurn } from './target'
import ChatTurn from './ChatTurn.vue'
import { useCompactScreen } from './compact'
import { isOwnLayer } from './layers'
import { focusPage } from './focusPage'
import ChatContextBar from './ChatContextBar.vue'
import ChatComposer from './ChatComposer.vue'
import ChatHistoryMenu from './ChatHistoryMenu.vue'
import AgentContextBar from './AgentContextBar.vue'
import DsSwitch from '@/ds/DsSwitch.vue'
import { openCollectionTab, openConnectionTab, openDatabaseTab } from '@/workspace/openTabs'
import DsCallout from '@/ds/DsCallout.vue'

const IndexCreateDialog = defineAsyncComponent(() => import('@/indexes/IndexCreateDialog.vue'))

/** Phase 4a-2 spec §5: the assistant beside the workspace, following the active tab. */
const { t, locale } = useI18n()
const store = useAssistantStore()
const tabs = useTabsStore()
const views = useCollectionViewsStore()
const dialogs = useDialogStore()
const toasts = useToastStore()
const words = useAiWords()
const status = useAiStatus()
const { data: connections } = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
const queryClient = useQueryClient()

const active = computed(() => chatTargetOf(tabs.active))
const connection = computed(() => connections.value?.find((c) => c.id === active.value?.connectionId))
// Final review minor 18: why a collection tab's data does not go, in words.
const notice = computed(() => {
  const a = active.value
  if (!a) return null
  const ns = `${a.db}.${a.coll}`
  if (!connections.value) return t('ai.chat.context.loading')
  const c = connection.value
  if (!c) return t('ai.chat.block.connectionGone')
  if (c.aiPolicy === 'off') return t('ai.chat.context.off', { connection: c.name })
  if (!c.permissions.includes('ai:use') || !c.permissions.includes('documents:read'))
    return t('ai.chat.context.noRights', { ns })
  return null
})
// Spec §1.2: data goes only from a collection whose connection allows it and the caller may read.
const target = computed(() =>
  active.value &&
  connection.value &&
  connection.value.aiPolicy !== 'off' &&
  connection.value.permissions.includes('ai:use') &&
  connection.value.permissions.includes('documents:read')
    ? active.value
    : null,
)
const section = computed(() => (active.value ? views.stateFor(active.value.tabId).section : null))
// Spec §1.3: the query or pipeline follows the section, as 4a-1's explain action reads it.
const current = computed(() => (target.value ? currentFor(target.value.tabId, 'explain') : undefined))
const parts = computed({
  get: () => (target.value ? store.partsFor(target.value.tabId) : null),
  set: () => undefined,
})
const providers = computed(() => status.data.value?.providers ?? [])
const provider = computed(
  () =>
    providers.value.find((p) => p.id === store.providerId) ??
    providers.value.find((p) => p.isDefault) ??
    providers.value[0],
)
const providerOptions = computed(() =>
  providers.value.map((p) => ({
    value: p.id,
    label: `${p.name} · ${p.model}${p.local === true ? ` · ${t('ai.sheet.local')}` : p.local === false ? ` · ${t('ai.sheet.cloud')}` : ''}`,
  })),
)
const chosenProvider = computed({
  get: () => provider.value?.id ?? null,
  set: (id: string | null) => void (store.providerId = id),
})
const samples = ref<SampleChoice>({ on: false, count: '3', hide: '' })
const samplesRefused = computed(() =>
  !provider.value?.samples
    ? t('ai.reason.samples_refused')
    : connection.value?.aiPolicy === 'local' && provider.value.local === false
      ? t('ai.sheet.localOnly')
      : null,
)
watch(samplesRefused, (r) => {
  if (r) samples.value.on = false
})

/**
 * W6.3: agent mode — the assistant works with the person's connections through the app, and every
 * change waits for their click on its card. The person's own switch, kept on the server.
 */
// Review of A2 (I1): the person's own switch counts only where the agent is available — off on the
// server, a message goes to the plain assistant.
const agentOn = computed(() => store.agentAvailable && store.agentMode === true)
/** Documents' values may go to the provider with this message (consent per message, as samples). */
const documents = ref(false)
const documentsRefused = computed(() => (provider.value?.samples ? null : t('ai.reason.samples_refused')))
watch(documentsRefused, (r) => {
  if (r) documents.value = false
})
/** The tab the person looks at: named to the agent (never read). */
/** Design 2026-10-25 (B7): the app's pages the agent is told the person is on. */
const APP_PAGES: ReadonlySet<string> = new Set(AI_AGENT_APP_PAGES)
const tabSections = useTabSectionsStore()
const agentFocus = computed<AgentFocus | null>(() => {
  const tab = tabs.active
  // B7: an app page is the focus by itself (its tab names no connection).
  if (tab && APP_PAGES.has(tab.kind)) return { page: tab.kind as AiAgentPage }
  const p = tab?.params
  const connectionId = p?.connectionId
  if (!tab || !connectionId || !connections.value?.some((c) => c.id === connectionId)) return null
  // A connection's or a database's page says the section it shows (review of B7, M6: as shown, not as
  // kept — a section the page cannot show now falls back to its overview).
  const section =
    tab.kind === 'connection' || tab.kind === 'database'
      ? tabSections.getValue(tab.id, 'shown', '') || null
      : null
  const page =
    section && (AI_AGENT_PAGES as readonly string[]).includes(section) ? (section as AiAgentPage) : null
  return {
    connectionId,
    ...(p.db ? { db: p.db } : {}),
    ...(p.db && p.coll ? { coll: p.coll } : {}),
    ...(page ? { page } : {}),
  }
})
const pageWords = (page: AiAgentPage) =>
  APP_PAGES.has(page) ? t(`tabs.${page}`) : t(`performance.sections.${page}`)
const focusWords = computed(() => {
  const f = agentFocus.value
  if (!f) return null
  if (!f.connectionId) return f.page ? pageWords(f.page) : null
  const name = connectionName(f.connectionId)
  if (f.db) return t('ai.chat.context.about', { ns: f.coll ? `${f.db}.${f.coll}` : f.db, connection: name })
  // The overview is the connection itself.
  return f.page && f.page !== 'overview'
    ? t('ai.chat.context.about', { ns: pageWords(f.page), connection: name })
    : name
})
async function toggleAgent(on: boolean): Promise<void> {
  try {
    await store.setAgentMode(on)
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  }
}
/**
 * Design 2026-10-25 (A5): a connection a step found answering is read again by the app, as opening it
 * would — so the sidebar and every command see it connected. Only after a step that opened it (a check
 * that found it answering, a read or a change of its data; re-review of A5, M-b: never the app's own
 * lists of jobs and backups, which open nothing), and only where the app has not read it yet or its
 * last read failed (W1: the sidebar holds a query, pending, for every connection not expanded).
 */
const OPENS = new Set<string>([
  // C2 (review, M3): it reads the connection as a run does.
  'distinct_values',
  'check_connection',
  'list_databases',
  'list_collections',
  'collection_stats',
  'find_documents',
  'count_documents',
  'analyze_schema',
  'list_indexes',
  'explain_query',
  'run_aggregation',
  'create_database',
  'create_collection',
  'insert_documents',
  'update_documents',
  'delete_documents',
  'create_index',
  'drop_index',
  'drop_collection',
  'drop_database',
])
function stepDone(step: AiAgentStep): void {
  const id = step.place?.connectionId
  if (!id || !OPENS.has(step.tool) || step.summary?.connected === false) return
  if (queryClient.getQueryState(queryKeys.databases(id))?.status === 'success') return
  // Review of A5 (M4): a read failing now is the sidebar's to say, never an unexpected error.
  queryClient
    .fetchQuery({ queryKey: queryKeys.databases(id), queryFn: () => connectionsApi.databases(id) })
    .catch(() => undefined)
}
/** W6.3: a tab the agent opened, or the place a step touched. */
function openTarget(target: AiAgentOpen): void {
  const c = connections.value?.find((x) => x.id === target.connectionId)
  if (!c) {
    toasts.push({ kind: 'error', message: t('ai.chat.block.connectionGone') })
    return
  }
  if (target.db && target.coll) {
    const tabId = openCollectionTab(tabs, c.id, target.db, target.coll)
    if (target.section) views.stateFor(tabId).section = target.section
    // Design 2026-10-25 (A1): what the person asked to see, run there with their rights.
    if (target.show)
      void showIn(tabId, target.show, t).then((outcome) => {
        if (outcome === 'invalid') toasts.push({ kind: 'error', message: t('ai.chat.block.invalid') })
      })
  } else if (target.db) openDatabaseTab(tabs, c.id, target.db)
  else openConnectionTab(tabs, c)
}
const openPlace = (p: AiAgentPlace) =>
  openTarget({
    connectionId: p.connectionId,
    ...(p.db ? { db: p.db } : {}),
    ...(p.coll ? { coll: p.coll } : {}),
  })

// User report 2026-10-25: what is being typed outlives the window closed and opened again.
const draft = computed({ get: () => store.draft, set: (v: string) => (store.draft = v) })
const turns = computed<TurnView[]>(() => turnViews(store.chat, store.live, store.sentOf, store.resultsOf))
const full = computed(() => !!store.chat?.full)
const title = computed(() =>
  store.chat
    ? (store.chat.title ?? t('ai.chat.unreadableTitle'))
    : store.chatId
      ? (store.pendingTitle ?? '')
      : t('ai.chat.untitled'),
)
const blocked = computed(() =>
  full.value ? t('ai.chat.full') : !provider.value ? t('ai.reason.no_provider') : null,
)
const placeholder = computed(() =>
  agentOn.value
    ? t('ai.agent.placeholder')
    : target.value
      ? t('ai.chat.composer.placeholder', { ns: `${target.value.db}.${target.value.coll}` })
      : t('ai.chat.composer.placeholderGeneral'),
)
const suggestions = computed(() => {
  const s = section.value
  if (agentOn.value) return ['agent1', 'agent2', 'agent3']
  if (!target.value) return ['general1', 'general2', 'general3']
  if (s === 'aggregations') return ['aggregations', 'schema', 'explain']
  if (s === 'schema') return ['schema', 'documents', 'validation']
  if (s === 'validation') return ['validation', 'schema', 'documents']
  if (s === 'explain') return ['explain', 'documents', 'schema']
  return ['documents', 'schema', 'explain']
})

// Spec §1.3: "Why is this query slow?" opens 4a-1's Make it faster on the Explain section (plans are
// not chat context); the other suggestions fill the message box.
function suggest(s: string): void {
  const tgt = target.value
  if (s === 'explain' && tgt && current.value) {
    views.stateFor(tgt.tabId).section = 'explain'
    useWorkspaceDialogs().open({
      kind: 'ai',
      connectionId: tgt.connectionId,
      db: tgt.db,
      coll: tgt.coll,
      tabId: tgt.tabId,
      actions: ['optimise', 'explain'],
    })
    return
  }
  draft.value = s.startsWith('agent') ? t(`ai.agent.suggest.${s}`) : t(`ai.chat.suggest.${s}`)
  composer.value?.focus()
}

const hidePaths = (text: string) =>
  text
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 50)

/** The connection a turn was about still exists (final review minor 7). */
const exists = (connectionId: string) => !!connections.value?.some((c) => c.id === connectionId)
/** Whether the user may export from a connection: its exports on, and the rights to run them. */
function canExport(connectionId: string, kind: 'query' | 'pipeline'): boolean {
  const c = connections.value?.find((x) => x.id === connectionId)
  if (!c?.export || !c.permissions.includes('jobs:run')) return false
  return kind === 'query' || c.permissions.includes('aggregation:run')
}

async function send(
  message: string,
  opts: {
    retry?: boolean
    target?: ChatTarget | null
    keepDraft?: boolean
    agent?: boolean
    /** A handoff's own place, and no documents' values (review of the chat entry, M3). */
    handoff?: { focus: AgentFocus | null }
  } = {},
): Promise<void> {
  const text = message.trim()
  if (!text || store.busy || blocked.value) return
  // Third review of the window (I-2): a message sent follows its answer, whatever place was kept.
  kept = null
  // W6.3: an agent turn names the tab in view, and carries documents only with this message's consent.
  if (opts.agent ?? agentOn.value) {
    const allow = !opts.handoff && documents.value && !documentsRefused.value
    store.providerId = provider.value?.id ?? null
    if (!opts.keepDraft) draft.value = ''
    documents.value = false
    follow.value = true
    await store.send(text, null, null, uiLanguageOf(locale.value), {
      retry: !!opts.retry,
      agent: { focus: opts.handoff ? opts.handoff.focus : agentFocus.value, documents: allow },
    })
    return
  }
  const tgt = opts.target === undefined ? target.value : opts.target
  const p = tgt ? store.partsFor(tgt.tabId) : null
  const now = tgt ? currentFor(tgt.tabId, 'explain') : undefined
  const extras =
    tgt && p
      ? {
          parts: { current: (p.current ?? true) && !!now, indexes: p.indexes, validator: p.validator },
          ...((p.current ?? true) && now ? { current: now } : {}),
          ...(samples.value.on && tgt === target.value
            ? { samples: { count: Number(samples.value.count), mask: hidePaths(samples.value.hide) } }
            : {}),
        }
      : null
  store.providerId = provider.value?.id ?? null
  // Final review minor 12: Retry leaves what is being typed alone.
  if (!opts.keepDraft) draft.value = ''
  // Spec §1.3: samples are consented to per message.
  samples.value.on = false
  follow.value = true
  await store.send(text, tgt, extras, uiLanguageOf(locale.value), { retry: !!opts.retry })
}
/**
 * User report 2026-10-25 ("ajan modu aktif değilse çalışmıyor"): a change the plain assistant cannot
 * make, asked of the agent — agent mode turned on, the same words sent as an agent turn of this chat.
 */
async function askAgent(turn: TurnView): Promise<void> {
  if (!turn.message) return
  if (!agentOn.value) await toggleAgent(true)
  // About the turn's own collection, wherever the person is now (review of the chat entry, M3).
  const w = turn.where
  // Re-review (I1): exactly the place the server takes (a key more is refused).
  const focus = w ? { connectionId: w.connectionId, db: w.db, coll: w.coll } : null
  if (agentOn.value) await send(turn.message, { agent: true, keepDraft: true, handoff: { focus } })
}
/** Final review minor 13: a turn is tried again about its own collection (or as general help). */
function retry(turn: TurnView): void {
  if (!turn.message) return
  let tgt: ChatTarget | null = null
  if (turn.where) {
    if (!exists(turn.where.connectionId)) {
      toasts.push({ kind: 'error', message: t('ai.chat.block.connectionGone') })
      return
    }
    tgt = tabForTurn(turn.where, active.value)
  }
  void send(turn.message, {
    retry: !!turn.record || !!store.live?.stored,
    target: tgt,
    keepDraft: true,
    // W6.3: an agent turn is tried again as an agent turn (agent mode still on: the server checks) —
    // the agent turned off meanwhile, as the plain assistant (re-review, nit).
    agent: !!turn.agent && agentOn.value,
  })
}

/**
 * The collection tab a block goes to: the collection it names (a general turn's, user request
 * 2026-10-10), else its turn's, else the active one — or none, said so.
 */
function tabForBlock(turn: TurnView, block: AiChatBlock): ChatTarget | null | 'gone' | 'unresolved' {
  // Review I3: a block that named a collection it was not given goes nowhere — never into the open one.
  if (block.unresolved) return 'unresolved'
  const where = block.target ?? turn.where
  if (where && !exists(where.connectionId)) return 'gone'
  return tabForTurn(where, active.value)
}
/** Why a block cannot go anywhere, said once. */
function refuse(tab: ReturnType<typeof tabForBlock>): tab is null | 'gone' | 'unresolved' {
  if (tab === 'gone') toasts.push({ kind: 'error', message: t('ai.chat.block.connectionGone') })
  else if (tab === 'unresolved') toasts.push({ kind: 'error', message: t('ai.chat.block.unresolved') })
  else if (!tab) toasts.push({ kind: 'error', message: t('ai.chat.block.needTab') })
  else return false
  return true
}
async function insert(turn: TurnView, result: AiResult, block: AiChatBlock): Promise<void> {
  const tab = tabForBlock(turn, block)
  if (refuse(tab)) return
  const outcome = await insertFromChat(tab.tabId, result, t)
  if (outcome === 'inserted')
    toasts.push({ kind: 'success', message: t('ai.chat.block.inserted', { ns: `${tab.db}.${tab.coll}` }) })
  else if (outcome === 'not_ready') toasts.push({ kind: 'error', message: t('ai.chat.block.notReady') })
}
/**
 * User request 2026-10-10: the query run in its collection, opened from wherever the user is; a
 * pipeline too, in the builder (user report 2026-10-13: one Run for both).
 */
async function run(turn: TurnView, result: AiResult, block: AiChatBlock): Promise<void> {
  if (result.kind !== 'query' && result.kind !== 'pipeline') return insert(turn, result, block)
  // A pipeline that writes is only put in the builder, for the user to run there: nothing to ask.
  if (block.warnings.includes('write_stage')) return insert(turn, result, block)
  const tab = tabForBlock(turn, block)
  if (refuse(tab)) return
  // Server JavaScript (allowed here) runs only after the user says so.
  if (
    block.warnings.includes('server_js') &&
    !(await dialogs.confirm({
      title: t('ai.chat.block.serverJsTitle'),
      message: t('ai.chat.block.serverJsRun'),
      confirmLabel: t('ai.chat.block.run'),
    }))
  )
    return
  if (result.kind === 'pipeline') return void (await runPipelineIn(tab.tabId, result, t))
  const outcome = await runQueryIn(tab.tabId, result, t)
  if (outcome === 'invalid') toasts.push({ kind: 'error', message: t('ai.chat.block.invalid') })
}
/**
 * User request 2026-10-13 ("excel olarak yada json olarak indir"): a block's output asked for as a
 * file opens its export in its collection, the query or pipeline and the format set; the user starts it.
 */
async function exportBlock(turn: TurnView, result: AiResult, block: AiChatBlock): Promise<void> {
  if (!block.export || (result.kind !== 'query' && result.kind !== 'pipeline')) return
  // Said, not a dialog the server refuses (review 2026-10-13, M2): checked before a tab opens.
  const where = block.unresolved ? null : (block.target ?? turn.where ?? active.value)
  if (where && !canExport(where.connectionId, result.kind)) {
    toasts.push({ kind: 'error', message: t('ai.chat.block.exportNotAllowed') })
    return
  }
  const tab = tabForBlock(turn, block)
  if (refuse(tab)) return
  // The export counts the documents as it opens: server JavaScript is asked about first, as Run does
  // (review 2026-10-13, I3).
  if (
    block.warnings.includes('server_js') &&
    !(await dialogs.confirm({
      title: t('ai.chat.block.serverJsTitle'),
      message: t('ai.chat.block.serverJsExport'),
      confirmLabel: t(`ai.chat.block.export.${block.export}`),
    }))
  )
    return
  const { connectionId, db, coll } = tab
  useWorkspaceDialogs().open({
    kind: 'exportData',
    connectionId,
    db,
    coll,
    ...(result.kind === 'pipeline'
      ? { stages: result.stages }
      : {
          query: {
            filter: result.filter,
            ...(result.projection ? { projection: result.projection } : {}),
            ...(result.sort ? { sort: result.sort } : {}),
          },
        }),
    format: block.export,
  })
}
const creating = ref<{
  target: { connectionId: string; db: string; coll: string }
  key: string
  options: Record<string, unknown>
} | null>(null)
function createIndex(
  turn: TurnView,
  ix: { keys: Record<string, unknown>; options: Record<string, unknown> },
  block: AiChatBlock,
): void {
  // Review I4: in the collection the block names, as Run and Put are.
  const tab = tabForBlock(turn, block)
  if (refuse(tab)) return
  creating.value = {
    target: { connectionId: tab.connectionId, db: tab.db, coll: tab.coll },
    key: toShell(decodeValue(ix.keys)),
    options: ix.options,
  }
}
const canIndex = (turn: TurnView, target: AiChatTarget | null) => {
  const id = target?.connectionId ?? turn.where?.connectionId ?? active.value?.connectionId
  return !!connections.value?.find((c) => c.id === id)?.permissions.includes('indexes:write')
}
const connectionName = (id: string) =>
  connections.value === undefined
    ? ''
    : (connections.value.find((c) => c.id === id)?.name ?? t('ai.agent.connectionNotListed'))

async function rename(): Promise<void> {
  const id = store.chatId
  if (!id) return
  const next = await dialogs.prompt({
    title: t('ai.chat.renameTitle'),
    message: '',
    confirmLabel: t('ai.chat.rename'),
    input: {
      type: 'text',
      label: t('ai.chat.renameLabel'),
      value: store.chat?.title ?? '',
      autocomplete: 'off',
    },
  })
  const title = next?.trim().slice(0, 60)
  if (!title) return
  try {
    await aiChatApi.rename(id, title)
  } catch (e) {
    // Final review minor 19: deleted elsewhere, or the network: said, not thrown away.
    toasts.push({ kind: 'error', message: describeError(e, t) })
    return
  }
  if (store.chat && store.chatId === id) store.chat.title = title
  store.version++
}

// Spec §5: the view follows the end unless the reader scrolled up.
const log = ref<HTMLElement | null>(null)
const follow = ref(true)
function onScroll(): void {
  const el = log.value
  if (el) follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 48
}
function toEnd(): void {
  const el = log.value
  if (el) el.scrollTop = el.scrollHeight
  follow.value = true
}
watch(
  () => [turns.value.length, store.live?.text.length, store.live?.state],
  () => {
    if (follow.value) void nextTick(toEnd)
  },
)

// One announcement when an answer ends (4a-1 final review minor 7); the log itself is not live.
const announcement = ref('')
watch(
  () => [store.live, store.live?.state] as const,
  ([live, s]) => {
    // Final review I4: cleared when a turn starts, so the same words are announced again.
    if (s === 'sending') announcement.value = ''
    else if (s === 'done') announcement.value = t('ai.chat.doneStatus')
    else if (s === 'error' && live?.error)
      announcement.value = words.reason(live.error.reason, live.error.retryAfterMs)
  },
)
// W6.3: a change waiting for the person is said once, as it appears.
watch(
  () => store.live?.agent?.steps.find((s) => s.state === 'awaiting')?.id,
  (id) => {
    if (id) announcement.value = t('ai.agent.awaitingStatus')
  },
)

// User report 2026-10-25: a window over the page, from 320 × 360 px to the screen less its margins,
// by pointer (its left edge, its top edge, their corner) or arrow keys.
const viewport = () =>
  typeof window === 'undefined' ? { w: 1280, h: 800 } : { w: window.innerWidth, h: window.innerHeight }
// Review of the floating window (minor): the bounds said to a screen reader follow the screen.
const screen = ref(viewport())
const maxWidth = () => Math.max(ASSISTANT_MIN, screen.value.w - WINDOW_MARGIN_X)
const maxHeight = () => Math.max(ASSISTANT_MIN_HEIGHT, screen.value.h - WINDOW_MARGIN_Y)
// Third review (M-1): the size as drawn on this screen — said, and stepped or dragged from; the
// size given stays saved as it was (a larger screen draws it again).
const drawnWidth = () => Math.min(store.width, maxWidth())
const drawnHeight = () => Math.min(store.height, maxHeight())
/** A phone, or a screen too short: the whole screen, as a modal dialog (review, I4). */
const compact = useCompactScreen()
function onSeparatorKey(e: KeyboardEvent): void {
  const step = e.shiftKey ? 64 : 16
  // Fourth review (N-c): a step past the screen's bound changes nothing, so saves nothing.
  if (e.key === 'ArrowLeft') {
    if (drawnWidth() < maxWidth()) store.setWidth(drawnWidth() + step, maxWidth())
  } else if (e.key === 'ArrowRight') store.setWidth(drawnWidth() - step, maxWidth())
  else if (e.key === 'Home') store.setWidth(ASSISTANT_MIN, maxWidth())
  else if (e.key === 'End') store.setWidth(maxWidth(), maxWidth())
  else return
  e.preventDefault()
}
function onHeightKey(e: KeyboardEvent): void {
  const step = e.shiftKey ? 64 : 16
  if (e.key === 'ArrowUp') {
    if (drawnHeight() < maxHeight()) store.setHeight(drawnHeight() + step, maxHeight())
  } else if (e.key === 'ArrowDown') store.setHeight(drawnHeight() - step, maxHeight())
  else if (e.key === 'Home') store.setHeight(ASSISTANT_MIN_HEIGHT, maxHeight())
  else if (e.key === 'End') store.setHeight(maxHeight(), maxHeight())
  else return
  e.preventDefault()
}
/** Dragged leftwards it widens, upwards it grows (the window keeps its bottom right corner). */
function onPointerDown(e: PointerEvent, sides: { width?: boolean; height?: boolean }): void {
  const el = e.currentTarget as HTMLElement
  // Review of the floating window (minor): no text selected while dragging.
  e.preventDefault()
  el.setPointerCapture?.(e.pointerId)
  const { clientX: startX, clientY: startY } = e
  const startWidth = drawnWidth()
  const startHeight = drawnHeight()
  const move = (ev: PointerEvent) => {
    if (sides.width) store.setWidth(startWidth + (startX - ev.clientX), maxWidth())
    if (sides.height) store.setHeight(startHeight + (startY - ev.clientY), maxHeight())
  }
  // Ended however it ends: released, cancelled (a touch taken by the browser), or its capture lost.
  const up = () => {
    el.removeEventListener('pointermove', move)
    for (const end of ENDS) el.removeEventListener(end, up)
  }
  el.addEventListener('pointermove', move)
  for (const end of ENDS) el.addEventListener(end, up)
}
const ENDS = ['pointerup', 'pointercancel', 'lostpointercapture'] as const
const composer = ref<InstanceType<typeof ChatComposer> | null>(null)
/**
 * Final review minor 15: closing gives focus back — where it was when the window opened (review of
 * the floating window, I4), else to the button that opens it.
 */
let returnTo: HTMLElement | null = null
function close(): void {
  store.hide()
}
const self = () => document.getElementById(ASSISTANT_PANEL_ID)
/**
 * Where the log was read when it closed (null: at its end, following) — for that chat and its turns
 * as they were, until something is sent (third review, I-2).
 */
let kept: { at: number; chat: string | null; turns: number } | null = null
function opened(): void {
  const active = document.activeElement as HTMLElement | null
  returnTo = active && active !== document.body && !self()?.contains(active) ? active : null
  void nextTick(() => {
    composer.value?.focus()
    // Re-review (minor): where it was read, as it was left — the same chat, nothing new in it.
    const back = kept
    kept = null
    if (back && log.value && back.chat === store.chatId && back.turns === turns.value.length) {
      log.value.scrollTop = back.at
      follow.value = false
    } else toEnd()
    placeToasts()
  })
}
/** Re-review (I3): the keys took focus in from the page — out again, it goes back there. */
function enteredFrom(e: Event): void {
  const from = (e as CustomEvent<HTMLElement | null>).detail
  // Third review (M-2): never the page's blank space (the body).
  if (from && from !== document.body && !self()?.contains(from)) returnTo = from
  composer.value?.focus()
}
/** On screen to take focus (a hidden tab's element is not), else the floating button. */
// Fourth review (I-A): asked once the page is drawn again (no longer inert on a phone).
const shown = (el: HTMLElement | null) =>
  !!el?.isConnected &&
  !el.matches(':disabled') &&
  !el.closest('[inert]') &&
  (typeof el.checkVisibility === 'function' ? el.checkVisibility() : true)
const history = ref<InstanceType<typeof ChatHistoryMenu> | null>(null)
function closed(): void {
  const launcher = document.getElementById(ASSISTANT_TOGGLE_ID)
  const from = returnTo
  returnTo = null
  kept = follow.value
    ? null
    : { at: log.value?.scrollTop ?? 0, chat: store.chatId, turns: turns.value.length }
  const active = document.activeElement as HTMLElement | null
  // From inside the window, or one of its own layers (on the body; the keys leave another modal
  // dialog alone): focus goes back. Closed from the page, it stays where it is.
  const ours =
    !active ||
    active === document.body ||
    !!self()?.contains(active) ||
    isOwnLayer(self(), active) ||
    (creating.value !== null && !!active.closest('[aria-modal="true"]'))
  // Third review (I-1): its own layers go with it — the history menu, a dialog it opened.
  history.value?.close()
  creating.value = null
  placeToasts()
  if (ours)
    void nextTick(() => {
      const back = shown(from) ? from : launcher
      back?.focus()
      // M-5: where focus could not land (a browser that cannot tell), the button.
      if (document.activeElement !== back) launcher?.focus()
    })
}
// Review of the floating window (I1): kept once opened, hidden when closed — what the agent opens
// meanwhile still opens, and what is typed, scrolled or chosen here stays.
watch(
  () => store.open,
  (open) => (open ? opened() : closed()),
)
// A window over the page: Escape from the composer closes it, on any width (user report 2026-10-25).
const leave = close
function onPanelKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && !e.defaultPrevented && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault()
    close()
  }
}
/**
 * A question asked from the palette or the home page is sent at once (user report 2026-10-10:
 * Enter there is "ask", not "type it again here") — as soon as the providers are known and no
 * answer is running, through the same checks as the composer's own Enter. One that cannot be sent
 * (no provider, the chat full) waits in the composer, the reason shown.
 */
const asked = ref<string | null>(null)
watch(
  () => store.pendingQuestion,
  (q) => {
    if (q === null) return
    asked.value = store.takeQuestion()
  },
  { immediate: true },
)
watch(
  [asked, () => status.isPending.value, () => store.busy, blocked],
  () => {
    const q = asked.value
    if (q === null || status.isPending.value || store.busy) return
    asked.value = null
    if (blocked.value) {
      draft.value = q
      void nextTick(() => composer.value?.focus())
      return
    }
    void send(q)
  },
  { immediate: true },
)
// The window's size as drawn: one at its largest, or as set, never past the screen's margins (in px,
// as its bounds are counted).
const frame = computed(() => {
  const w = `calc(100vw - ${WINDOW_MARGIN_X}px)`
  const h = `calc(100dvh - ${WINDOW_MARGIN_Y}px)`
  return {
    '--aw': store.expanded ? `min(960px, ${w})` : `min(${store.width}px, ${w})`,
    '--ah': store.expanded ? h : `min(${store.height}px, ${h})`,
    '--ab': `${WINDOW_BOTTOM}px`,
  }
})
/**
 * Toasts keep out of the window's way (DsToastHost): to its left where they fit, else at the top in the
 * middle — never over its message box (review of the floating window, I2); none of it once it is closed.
 */
const TOAST_WIDTH = 360
/** Room above the window for a few toasts. */
const TOAST_ROOM = 240
const TOAST_VARS = [
  '--mm-toast-right',
  '--mm-toast-top',
  '--mm-toast-bottom',
  '--mm-toast-overflow',
  '--mm-toast-push',
] as const
let frameWatch: ResizeObserver | null = null
function placeToasts(): void {
  const style = document.documentElement.style
  for (const v of TOAST_VARS) style.removeProperty(v)
  const width = store.open ? (self()?.getBoundingClientRect().width ?? 0) : 0
  if (!width) return
  const right = width + 32
  if (screen.value.w - right >= TOAST_WIDTH + 16) style.setProperty('--mm-toast-right', `${right}px`)
  else {
    const top = self()?.getBoundingClientRect().top ?? 0
    // Fifth review (2, 3, 9): their room bounded both ways, it scrolls (the newest kept in view).
    style.setProperty('--mm-toast-overflow', 'auto')
    // Third review (M-3): above it where a few fit, growing up from it; else under its own header
    // (48 px and a gap) — never down over its message box.
    if (top >= TOAST_ROOM) {
      style.setProperty('--mm-toast-bottom', `${Math.round(screen.value.h - top + 8)}px`)
      // Sixth review (I-1, M-1): pushed down to the window (the first one's top margin, any browser).
      style.setProperty('--mm-toast-push', 'auto')
      // Fourth review (M-B): kept on screen, however many (the stack scrolls).
      style.setProperty('--mm-toast-top', '16px')
    } else {
      // Sixth review (I-1, I-2): from under its header down, to the screen's foot (never a room too
      // small to show one), not pushed down over its newest turn.
      style.setProperty('--mm-toast-top', `${Math.round(top + 56)}px`)
      // Seventh review (M-1): down to its message box (its field's top, less a gap), one toast's room
      // (80 px) kept at least — never over the field being typed in.
      const field = self()?.querySelector('textarea')?.getBoundingClientRect().top ?? screen.value.h
      const room = Math.min(screen.value.h - field + 20, screen.value.h - (top + 56) - 80)
      style.setProperty('--mm-toast-bottom', `${Math.round(Math.max(16, room))}px`)
    }
    style.setProperty('--mm-toast-right', `${Math.max(16, Math.round((screen.value.w - TOAST_WIDTH) / 2))}px`)
  }
}
// I3: the screen resized — the size kept within it, the toasts placed again.
function onResize(): void {
  screen.value = viewport()
  // Re-review (minor): the size given stays (what is drawn and said is bounded by the screen).
  if (store.open) placeToasts()
}
onMounted(() => {
  const frameEl = self()
  if (frameEl && typeof ResizeObserver !== 'undefined') {
    frameWatch = new ResizeObserver(() => placeToasts())
    frameWatch.observe(frameEl)
  }

  window.addEventListener('resize', onResize)
  if (store.open) opened()
  // W6.3: the person's agent mode, and the tabs the agent opens.
  if (store.agentMode === null) void store.loadAgentMode()
  store.setOpenHandler(openTarget)
  store.setStepHandler(stepDone)
})
onBeforeUnmount(() => {
  // Fifth review (5): gone with focus in it (the assistant turned off, another user): focus goes
  // where it came from, else to the page.
  const active = document.activeElement
  if (active && (self()?.contains(active) || isOwnLayer(self(), active))) {
    // Never the floating button: it goes with the window when the assistant is turned off.
    if (shown(returnTo) && returnTo?.id !== ASSISTANT_TOGGLE_ID) returnTo!.focus()
    else focusPage()
  }
  window.removeEventListener('resize', onResize)
  frameWatch?.disconnect()
  for (const v of TOAST_VARS) document.documentElement.style.removeProperty(v)
  store.setOpenHandler(null)
  store.setStepHandler(null)
})
</script>

<template>
  <!-- A window over the page; on a phone or a short screen the whole of it, as a modal dialog. -->
  <!-- Clipped, never scrolled (overflow: clip): a scroll meant for its log — a control brought into
       view, a find on the page — once moved the whole window up, its header out of sight. -->
  <!-- A div: a dialog's role is not an aside's. Not aria-modal on a phone: the rest of the page is
       inert there, and its own menus (on the body) stay in reach (re-review, I4). -->
  <div
    :id="ASSISTANT_PANEL_ID"
    :role="compact ? 'dialog' : 'complementary'"
    :aria-label="t('ai.chat.title')"
    class="fixed z-40 flex min-h-0 min-w-0 animate-rise flex-col overflow-clip bg-surface text-fg"
    :class="
      compact
        ? 'inset-0'
        : 'right-4 bottom-(--ab) h-(--ah) w-(--aw) rounded-2xl shadow-dialog ring-1 ring-line'
    "
    :style="frame"
    :data-expanded="store.expanded ? 'true' : undefined"
    @keydown="onPanelKey"
    @mm-assistant-enter="enteredFrom"
  >
    <div
      v-if="!store.expanded && !compact"
      role="separator"
      tabindex="0"
      aria-orientation="vertical"
      :aria-label="t('ai.chat.resize')"
      :aria-valuenow="drawnWidth()"
      :aria-valuemin="ASSISTANT_MIN"
      :aria-valuemax="maxWidth()"
      class="absolute inset-y-0 left-0 z-10 w-1.5 cursor-ew-resize touch-none transition-colors duration-150 hover:bg-accent/20 focus-visible:bg-accent/40 focus-visible:outline-none"
      @keydown="onSeparatorKey"
      @pointerdown="onPointerDown($event, { width: true })"
    />
    <div
      v-if="!store.expanded && !compact"
      role="separator"
      tabindex="0"
      aria-orientation="horizontal"
      :aria-label="t('ai.chat.resizeHeight')"
      :aria-valuenow="drawnHeight()"
      :aria-valuemin="ASSISTANT_MIN_HEIGHT"
      :aria-valuemax="maxHeight()"
      class="absolute inset-x-0 top-0 z-10 h-1.5 cursor-ns-resize touch-none transition-colors duration-150 hover:bg-accent/20 focus-visible:bg-accent/40 focus-visible:outline-none"
      @keydown="onHeightKey"
      @pointerdown="onPointerDown($event, { height: true })"
    />
    <!-- Their corner, for a pointer: both at once (the keys have the two edges). -->
    <div
      v-if="!store.expanded && !compact"
      class="absolute top-0 left-0 z-20 size-3 cursor-nwse-resize touch-none"
      aria-hidden="true"
      @pointerdown="onPointerDown($event, { width: true, height: true })"
    />
    <header class="flex h-12 shrink-0 items-center gap-1 border-b border-line px-3">
      <Sparkles class="size-4 shrink-0 text-accent-fg" aria-hidden="true" />
      <h2 class="min-w-0 flex-1 truncate text-ui font-semibold text-fg">{{ title }}</h2>
      <button
        v-if="store.chatId && store.chat"
        type="button"
        class="inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-fg-subtle hover:bg-subtle hover:text-fg"
        :aria-label="t('ai.chat.rename')"
        :title="t('ai.chat.rename')"
        @click="rename"
      >
        <Pencil class="size-4" aria-hidden="true" />
      </button>
      <ChatHistoryMenu ref="history" />
      <button
        type="button"
        class="inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-fg-subtle hover:bg-subtle hover:text-fg"
        :aria-label="t('ai.chat.newChat')"
        :title="t('ai.chat.newChat')"
        @click="store.newChat()"
      >
        <SquarePen class="size-4" aria-hidden="true" />
      </button>
      <button
        v-if="!compact"
        type="button"
        class="inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-fg-subtle hover:bg-subtle hover:text-fg"
        :aria-label="store.expanded ? t('ai.chat.restore') : t('ai.chat.expand')"
        :title="store.expanded ? t('ai.chat.restore') : t('ai.chat.expand')"
        @click="store.setExpanded(!store.expanded)"
      >
        <Minimize2 v-if="store.expanded" class="size-4" aria-hidden="true" />
        <Maximize2 v-else class="size-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-fg-subtle hover:bg-subtle hover:text-fg"
        :aria-label="t('ai.chat.close')"
        :title="t('ai.chat.close')"
        @click="close"
      >
        <X class="size-4" aria-hidden="true" />
      </button>
    </header>

    <div
      ref="log"
      role="log"
      aria-live="off"
      :aria-label="t('ai.chat.log')"
      :aria-busy="store.busy"
      class="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      @scroll="onScroll"
    >
      <p v-if="store.loading" class="text-ui text-fg-subtle">{{ t('ai.chat.loading') }}</p>
      <DsCallout v-else-if="store.loadError" tone="danger">{{ t('ai.chat.loadFailed') }}</DsCallout>
      <div v-else-if="!turns.length" class="flex flex-col items-center gap-3 px-2 py-10 text-center">
        <span class="grid size-10 place-items-center rounded-full bg-accent/10 text-accent-fg"
          ><Sparkles class="size-5" aria-hidden="true"
        /></span>
        <p class="text-ui font-medium text-fg">
          {{
            agentOn
              ? t('ai.agent.empty.title')
              : target
                ? t('ai.chat.empty.title', { ns: `${target.db}.${target.coll}` })
                : t('ai.chat.empty.titleGeneral')
          }}
        </p>
        <p class="max-w-xs text-small text-fg-subtle">
          {{ agentOn ? t('ai.agent.empty.hint') : t('ai.chat.empty.hint') }}
        </p>
        <div class="flex w-full flex-col gap-1.5">
          <button
            v-for="s in suggestions"
            :key="s"
            type="button"
            class="cursor-pointer rounded-lg border border-line px-3 py-2 text-left text-ui text-fg transition-colors duration-150 hover:border-accent hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
            @click="suggest(s)"
          >
            {{ s.startsWith('agent') ? t(`ai.agent.suggest.${s}`) : t(`ai.chat.suggest.${s}`) }}
          </button>
        </div>
      </div>
      <div v-else class="flex flex-col gap-5">
        <template v-for="(turn, i) in turns" :key="turn.key">
          <p
            v-if="i > 0 && turn.namespace !== turns[i - 1]!.namespace"
            class="flex items-center gap-2 text-small text-fg-subtle"
            role="separator"
          >
            <span class="h-px flex-1 bg-muted" />
            {{
              turn.namespace
                ? t('ai.chat.divider.about', { ns: turn.namespace })
                : t('ai.chat.divider.general')
            }}
            <span class="h-px flex-1 bg-muted" />
          </p>
          <ChatTurn
            :turn="turn"
            :last="i === turns.length - 1"
            :busy="store.busy"
            :can-index="(target) => canIndex(turn, target)"
            :connection-name="connectionName"
            :can-ask-agent="store.agentAvailable && store.agentPolicy !== 'read' && i === turns.length - 1"
            @insert="(r, block) => insert(turn, r, block)"
            @run="(r, block) => run(turn, r, block)"
            @export="(r, block) => void exportBlock(turn, r, block)"
            @index="(ix, block) => createIndex(turn, ix, block)"
            @retry="retry(turn)"
            @ask-agent="askAgent(turn)"
            @open="openPlace"
          />
        </template>
      </div>
    </div>
    <button
      v-if="!follow && turns.length"
      type="button"
      class="absolute right-4 bottom-44 inline-flex cursor-pointer items-center gap-1 rounded-full border border-line bg-surface px-3 py-1 text-small shadow-sm hover:bg-subtle"
      @click="toEnd"
    >
      <ArrowDown class="size-3.5" aria-hidden="true" />{{ t('ai.chat.jump') }}
    </button>
    <p class="sr-only" role="status">{{ announcement }}</p>

    <footer class="flex shrink-0 flex-col gap-2 border-t border-line p-3">
      <div v-if="full" class="flex items-center justify-between gap-2 text-small text-fg-muted">
        <span>{{ t('ai.chat.full') }}</span>
        <DsButton size="sm" @click="store.newChat()">{{ t('ai.chat.newChat') }}</DsButton>
      </div>
      <!-- UI review of wave B: on, the switch is one line (what it does is on its tooltip and its cards),
           so the conversation keeps the window's height. -->
      <DsSwitch
        v-if="store.agentAvailable || (store.agentAssistant && store.agentPolicy === 'off')"
        :model-value="agentOn"
        :label="t('ai.agent.mode')"
        :hint="
          store.agentPolicy === 'off'
            ? t('ai.agent.policyOff')
            : store.agentPolicy === 'read'
              ? t('ai.agent.policyRead')
              : agentOn
                ? undefined
                : t('ai.agent.modeOff')
        "
        :title="agentOn ? t('ai.agent.modeOn') : undefined"
        :disabled="store.busy || !store.agentAvailable"
        data-agent-mode
        @update:model-value="(on: boolean) => void toggleAgent(on)"
      />
      <AgentContextBar
        v-if="agentOn"
        v-model:documents="documents"
        :focus="focusWords"
        :documents-refused="documentsRefused"
      />
      <ChatContextBar
        v-else
        v-model:parts="parts"
        v-model:samples="samples"
        :namespace="target ? `${target.db}.${target.coll}` : null"
        :connection-name="connection?.name ?? null"
        :notice="notice"
        :has-current="!!current"
        :pipeline="!!current && 'pipeline' in current"
        :samples-refused="samplesRefused"
      />
      <ChatComposer
        ref="composer"
        v-model="draft"
        v-model:provider="chosenProvider"
        :busy="store.busy"
        :blocked="blocked"
        :providers="providerOptions"
        :placeholder="placeholder"
        @send="send(draft)"
        @stop="store.stop()"
        @leave="leave"
      />
    </footer>
    <IndexCreateDialog
      v-if="creating"
      :target="creating.target"
      :initial-key="creating.key"
      :initial-options="creating.options"
      @close="creating = null"
    />
  </div>
</template>
