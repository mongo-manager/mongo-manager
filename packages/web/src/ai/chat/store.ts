import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  agentToolKind,
  type AiAgentConnectionInfo,
  type AiAgentNote,
  type AiAgentOpen,
  type AiAgentPolicy,
  type AiAgentStep,
  type AiAgentStepRecord,
  type AiAgentTurnBody,
  type AiChatTurnRecord,
} from '@mongo-manager/shared/browser'
import type {
  AiChatBlock,
  AiChatCollectionTurnBody,
  AiChatHistoryInfo,
  AiChatLine,
  AiChatProviderRef,
  AiChatView,
  AiSent,
  UiLanguage,
} from '@mongo-manager/shared/browser'
import { ApiError } from '@/api/client'
import { aiChatApi } from '@/api/aiChat'
import { aiAgentApi, type AgentDecisionBody, type AgentDecisionResult } from '@/api/aiAgent'
import { isCompactNow } from './compact'

/** The floating button and the window it controls (aria-controls, and where focus goes back). */
export const ASSISTANT_TOGGLE_ID = 'assistant-toggle'
export const ASSISTANT_PANEL_ID = 'assistant-panel'
/** Spec §5: from 320 px to half the window. */
export const ASSISTANT_MIN = 320
/** User report 2026-10-25: the floating window's least height. */
export const ASSISTANT_MIN_HEIGHT = 360
/** The room the floating button keeps at the bottom right (1rem from the edge, 2.75rem, a gap). */
export const LAUNCHER_CLEARANCE = '4.5rem'
/**
 * What the window leaves of the screen, in px (its CSS says the same): 16 px each side; the button's
 * 72 px below; above, the page's 8 px, the header's 48 px and its border, and a gap — the header's
 * jobs and account stay in reach.
 */
export const WINDOW_MARGIN_X = 32
export const WINDOW_MARGIN_Y = 136
/** The window's bottom: over the floating button (16 px from the edge, 44 px, a 12 px gap). */
export const WINDOW_BOTTOM = 72

/** The collection a turn is about (the active collection tab). */
export interface ChatTarget {
  connectionId: string
  db: string
  coll: string
  tabId: string
}
export type ChatExtras = Pick<AiChatCollectionTurnBody, 'parts' | 'current' | 'samples'>
/** Samples for the next message only (spec §1.3: consent per message). */
export interface SampleChoice {
  on: boolean
  count: '1' | '2' | '3' | '4' | '5'
  hide: string
}
/** The parts chosen on a tab; `current: null` follows whether the section holds a query. */
export interface ChatParts {
  current: boolean | null
  indexes: boolean
  validator: boolean
}
/** Where a turn's code goes (C7): the turn's own collection. */
export interface TurnWhere {
  connectionId: string
  db: string
  coll: string
}

/** W6.3: an agent turn's steps and what went with it. */
export interface AgentTurn {
  /** The run its changes are answered against (live turns only). */
  run: string | null
  steps: AiAgentStep[]
  notes: AiAgentNote[]
  /** The connections named to the model (live: the list; stored: how many). */
  connections: AiAgentConnectionInfo[] | number | null
  documents: boolean
  fallback: boolean
}

export interface LiveTurn {
  /** Final review I3: each live turn has its own key, so one is never drawn in another's place. */
  seq: number
  /** The user's message id once the server named it (the chat line). */
  turnId: string | null
  message: string
  where: TurnWhere | null
  namespace: string | null
  /** Sent with retry: it takes the place of the failed turn. */
  retry: boolean
  /** The server stored it (its chat line came): Retry sends it again with retry. */
  stored: boolean
  state: 'sending' | 'streaming' | 'done' | 'error' | 'stopped'
  text: string
  sent: AiSent | null
  /** A general turn: how many collection names went with it (user request 2026-10-10). */
  catalogue: number | null
  /** How many connection names went with it (a general turn's or one about a collection). */
  connectionNames: number | null
  provider: AiChatProviderRef | null
  history: AiChatHistoryInfo | null
  blocks: AiChatBlock[]
  usage: { input: number; output: number } | null
  local: boolean | null
  error: { reason: string; retryAfterMs?: number; nothingSent?: boolean } | null
  /** W6.3: an agent turn (null: a chat turn). */
  agent: AgentTurn | null
  /** User report 2026-10-25: a plain turn asked for a change the agent makes. */
  agentAsked: boolean
}

/**
 * User report 2026-10-25: the line a plain answer ends with when the agent makes the change asked —
 * the panel's, never drawn; while it streams in, a start of it at the end of a line is not drawn either.
 */
export function withoutAgentLine(text: string): string {
  // Review of the chat entry (M1): the last line looked at, no pattern (a long answer never slows it).
  const end = text.trimEnd()
  const at = end.lastIndexOf('\n')
  const line = end.slice(at + 1).trim()
  // The whole line, or its start while it streams in — from "[[" on (a list's "[" is left alone).
  if (line.length >= 2 && '[[agent]]'.startsWith(line)) return at < 0 ? '' : end.slice(0, at).trimEnd()
  return text
}

/** One turn as the panel draws it, stored or live. */
export interface TurnView {
  key: string
  message: string | null
  answer: string | null
  record: AiChatTurnRecord | null
  where: TurnWhere | null
  namespace: string | null
  blocks: AiChatBlock[]
  state: LiveTurn['state']
  error: LiveTurn['error']
  provider: AiChatProviderRef | null
  local: boolean | null
  live: boolean
  sent: AiSent | null
  catalogue: number | null
  connectionNames: number | null
  history: AiChatHistoryInfo | null
  agent: AgentTurn | null
  agentAsked: boolean
}

/** Design 2026-10-25 (B7): what an agent's turn is about — a tab, a connection's section, an app page. */
export type AgentFocus = NonNullable<AiAgentTurnBody['focus']>

/** Review of B5 (I1): what a step's read was, kept in memory beside a stored turn. */
export interface KeptResults {
  tool: AiAgentStep['tool']
  results?: AiAgentStep['results']
}

/** W6.3: a stored agent turn's steps, as the panel draws them (names are found by the panel). */
export function storedAgent(r: AiChatTurnRecord): AgentTurn | null {
  if (!r.agent) return null
  return {
    run: null,
    steps: storedSteps(r.agent.steps),
    notes: r.agent.fallback ? ['tools_unsupported'] : [],
    connections: r.agent.connections,
    documents: r.agent.documents,
    fallback: !!r.agent.fallback,
  }
}

/** Stored steps as steps (the chat's, and an AI history request's: user report 2026-10-25). */
export function storedSteps(steps: readonly AiAgentStepRecord[]): AiAgentStep[] {
  return steps.map((s, i): AiAgentStep => {
    const dot = s.namespace ? s.namespace.indexOf('.') : -1
    return {
      id: `stored-${i}`,
      tool: s.tool,
      kind: agentToolKind(s.tool),
      place: s.connectionId
        ? {
            connectionId: s.connectionId,
            connection: '',
            ...(s.namespace ? { db: dot < 0 ? s.namespace : s.namespace.slice(0, dot) } : {}),
            ...(s.namespace && dot >= 0 ? { coll: s.namespace.slice(dot + 1) } : {}),
          }
        : null,
      state: s.state,
      ...(s.sent ? { sent: s.sent } : {}),
      ...(s.documents ? { documents: s.documents } : {}),
      ...(s.summary ? { summary: s.summary } : {}),
      ...(s.reason ? { reason: s.reason } : {}),
      // C4: a stored turn's plan and backups, as the live turn showed them.
      ...(s.plan ? { plan: s.plan } : {}),
      ...(s.planItem !== undefined ? { planItem: s.planItem } : {}),
      ...(s.backup ? { backup: s.backup } : {}),
    }
  })
}

const whereOf = (r: AiChatTurnRecord): TurnWhere | null => {
  if (!r.connectionId || !r.namespace) return null
  const at = r.namespace.indexOf('.')
  return { connectionId: r.connectionId, db: r.namespace.slice(0, at), coll: r.namespace.slice(at + 1) }
}

/**
 * Review of B5 (I1): a stored turn's steps drawn with the reads they made, kept in this browser's memory
 * since the turn ran (the server never keeps them) — each matched by its place in the turn and its tool.
 */
function withResults(agent: AgentTurn | null, kept: readonly KeptResults[] | null): AgentTurn | null {
  if (!agent || !kept) return agent
  return {
    ...agent,
    steps: agent.steps.map((s, i) => {
      const k = kept[i]
      return k && k.tool === s.tool && s.state === 'done' ? { ...s, results: k.results } : s
    }),
  }
}

/** Spec §5: the stored turns, then the live one (a retried turn replaces the failed one it follows). */
export function turnViews(
  chat: AiChatView | null,
  live: LiveTurn | null,
  sentOf: (userMessageId: string) => AiSent | null = () => null,
  resultsOf: (userMessageId: string) => readonly KeptResults[] | null = () => null,
): TurnView[] {
  const out: TurnView[] = []
  const m = chat?.messages ?? []
  // Final review I2: what a turn sent is kept beside it in memory once it is stored.
  for (let i = 0; i + 1 < m.length; i += 2) {
    const u = m[i]!
    const a = m[i + 1]!
    const r = u.turn!
    out.push({
      key: u.id,
      message: u.text,
      answer: a.text,
      record: r,
      where: whereOf(r),
      namespace: r.namespace,
      blocks: a.blocks ?? [],
      state: r.state,
      error:
        r.state === 'error'
          ? { reason: r.reason ?? 'provider_error', ...(r.nothingSent ? { nothingSent: true } : {}) }
          : null,
      provider: r.provider,
      local: r.local,
      live: false,
      sent: sentOf(u.id),
      catalogue: r.catalogue ?? null,
      connectionNames: r.connectionNames ?? null,
      history: r.history ?? null,
      agent: withResults(storedAgent(r), resultsOf(u.id)),
      agentAsked: !!r.agentAsked,
    })
  }
  if (live) {
    if (live.retry && out.length && out.at(-1)!.state !== 'done') out.pop()
    out.push({
      key: `live-${live.seq}`,
      message: live.message,
      answer: withoutAgentLine(live.text),
      record: null,
      where: live.where,
      namespace: live.namespace,
      blocks: live.blocks,
      state: live.state,
      error: live.error,
      provider: live.provider,
      local: live.local,
      live: true,
      sent: live.sent,
      catalogue: live.catalogue,
      connectionNames: live.connectionNames,
      history: live.history,
      agent: live.agent,
      agentAsked: live.agentAsked,
    })
  }
  return out
}

const storageKey = (user: string) => `mm.assistant.${user}`
const DEFAULT_WIDTH = 400
const DEFAULT_HEIGHT = 640

/** The browser's IANA time zone, where it says one. */
function timeZoneOfBrowser(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}
/** Phase 4a-2 spec §5: the panel's state; chat content lives in memory only (C8). */
export const useAssistantStore = defineStore('assistant', () => {
  const open = ref(false)
  const width = ref(DEFAULT_WIDTH)
  const height = ref(DEFAULT_HEIGHT)
  /** The window at its largest (user report 2026-10-25). */
  const expanded = ref(false)
  /** What is being typed: kept while the window is closed, in memory only (C8). */
  const draft = ref('')
  const user = ref<string | null>(null)
  const chatId = ref<string | null>(null)
  const chat = ref<AiChatView | null>(null)
  const live = ref<LiveTurn | null>(null)
  const loading = ref(false)
  const loadError = ref<string | null>(null)
  const providerId = ref<string | null>(null)
  /** Bumped when the list of chats changes (the history menu reads it again). */
  const version = ref(0)
  /** Plan ruling 10: per tab; `current: null` follows whether the section holds a query. */
  const parts = reactive<Record<string, ChatParts>>({})
  /** Final review I2: what each stored turn of this chat sent (memory only; the server never keeps it). */
  const sentByTurn = reactive(new Map<string, AiSent>())
  /** Review of B5 (I1): the reads each stored turn's steps made (memory only; the server never keeps them). */
  const resultsByTurn = reactive(new Map<string, KeptResults[]>())
  /** Final review minor 17: a new chat's title while its first answer streams. */
  const pendingTitle = ref<string | null>(null)
  /** Final review I3: a stopped turn is read back before the next one may go (the server frees it). */
  const settling = ref(false)
  /**
   * W6.3: agent mode — the person's own switch, kept on the server (null until read). `agentAvailable`:
   * the switch is offered (the assistant is on and the person may use it somewhere).
   */
  const agentMode = ref<boolean | null>(null)
  const agentAvailable = ref(false)
  /** Design 2026-10-25 (A2): what an administrator allows the agent here (null until read). */
  const agentPolicy = ref<AiAgentPolicy['policy'] | null>(null)
  /** The person may use the assistant at all (the switch is shown, if not always to turn). */
  const agentAssistant = ref(false)
  let controller: AbortController | null = null
  let seq = 0
  /** W6.3: what the panel does when the agent opens a tab (set by the panel). */
  let onOpen: ((target: AiAgentOpen) => void) | null = null
  let onStep: ((step: AiAgentStep) => void) | null = null

  const busy = computed(
    () => live.value?.state === 'sending' || live.value?.state === 'streaming' || settling.value,
  )
  const sentOf = (id: string) => sentByTurn.get(id) ?? null
  const resultsOf = (id: string) => resultsByTurn.get(id) ?? null

  // Plan ruling 15: the window's place only (open, its size), per user; never chat content. User
  // report 2026-10-30: and which chat is open — its id alone, the server keeps its words — so a
  // reload opens it again instead of an empty one.
  function persist(): void {
    if (!user.value) return
    try {
      localStorage.setItem(
        storageKey(user.value),
        JSON.stringify({
          open: open.value,
          width: width.value,
          height: height.value,
          expanded: expanded.value,
          chat: chatId.value,
        }),
      )
    } catch {
      // Storage refused (private mode): the panel still works.
    }
  }
  /** This chat's memory: what was sent, the pending title. */
  function forgetChat(): void {
    sentByTurn.clear()
    resultsByTurn.clear()
    pendingTitle.value = null
  }
  /** The chat open before a reload, opened again when the panel shows. */
  let remembered: string | null = null
  function restore(): void {
    const id = remembered
    remembered = null
    if (!id || chatId.value || live.value) return
    void openChat(id).then(() => {
      // Gone (deleted, or past its days): a new chat, as if none had been open.
      if (chatId.value === id && loadError.value === 'NOT_FOUND') {
        newChat()
        persist()
      }
    })
  }
  function bindUser(id: string): void {
    // Final review C1: another user (after a session expired, without a reload) sees nothing of the last.
    if (user.value !== id) {
      stop()
      chatId.value = null
      chat.value = null
      live.value = null
      providerId.value = null
      loadError.value = null
      agentMode.value = null
      agentAvailable.value = false
      agentPolicy.value = null
      agentAssistant.value = false
      for (const k of Object.keys(parts)) delete parts[k]
      draft.value = ''
      // Fifth review of the floating window (8): never another's question sent as this user.
      pendingQuestion.value = null
      forgetChat()
    }
    user.value = id
    remembered = null
    open.value = false
    width.value = DEFAULT_WIDTH
    height.value = DEFAULT_HEIGHT
    expanded.value = false
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey(id)) ?? 'null') as {
        open?: unknown
        width?: unknown
        height?: unknown
        expanded?: unknown
        chat?: unknown
      } | null
      if (saved && typeof saved === 'object') {
        // Review of the floating window (minor): never opened by itself over a whole phone screen.
        open.value = saved.open === true && !isCompactNow()
        if (typeof saved.width === 'number' && Number.isFinite(saved.width))
          width.value = Math.max(ASSISTANT_MIN, Math.round(saved.width))
        if (typeof saved.height === 'number' && Number.isFinite(saved.height))
          height.value = Math.max(ASSISTANT_MIN_HEIGHT, Math.round(saved.height))
        expanded.value = saved.expanded === true
        remembered =
          typeof saved.chat === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(saved.chat) ? saved.chat : null
      }
    } catch {
      // Unreadable: the defaults stand.
    }
    if (open.value) restore()
  }
  function show(): void {
    open.value = true
    restore()
    persist()
  }
  /**
   * A question asked from the palette or the home page: the panel sends it as soon as it can,
   * through its own checks, or leaves it in the composer saying why (user report 2026-10-10).
   */
  const pendingQuestion = ref<string | null>(null)
  function ask(question: string): void {
    pendingQuestion.value = question
    show()
  }
  function takeQuestion(): string | null {
    const q = pendingQuestion.value
    pendingQuestion.value = null
    return q
  }
  function hide(): void {
    open.value = false
    persist()
  }
  function toggle(): void {
    if (open.value) hide()
    else show()
  }
  function setWidth(px: number, max: number): void {
    width.value = Math.round(Math.min(Math.max(px, ASSISTANT_MIN), Math.max(ASSISTANT_MIN, max)))
    persist()
  }
  function setHeight(px: number, max: number): void {
    height.value = Math.round(
      Math.min(Math.max(px, ASSISTANT_MIN_HEIGHT), Math.max(ASSISTANT_MIN_HEIGHT, max)),
    )
    persist()
  }
  function setExpanded(on: boolean): void {
    expanded.value = on
    persist()
  }
  function partsFor(tabId: string): ChatParts {
    parts[tabId] ??= { current: null, indexes: true, validator: false }
    return parts[tabId]!
  }

  function stop(): void {
    controller?.abort()
    controller = null
    const turn = live.value
    if (turn && (turn.state === 'sending' || turn.state === 'streaming')) {
      turn.state = 'stopped'
      // The server stores the stopped turn as it notices the client left; read it back shortly — also
      // when it had not named the turn yet (final review minor 14), and before another may go (I3).
      if (chatId.value) {
        settling.value = true
        void settle(turn, 8).finally(() => (settling.value = false))
      }
    }
  }
  function newChat(): void {
    stop()
    forgetChat()
    chatId.value = null
    chat.value = null
    live.value = null
    loadError.value = null
    remembered = null
    persist()
  }
  async function openChat(id: string): Promise<void> {
    stop()
    forgetChat()
    chatId.value = id
    chat.value = null
    live.value = null
    loading.value = true
    loadError.value = null
    persist()
    try {
      const view = await aiChatApi.get(id)
      if (chatId.value === id) chat.value = view
    } catch (e) {
      if (chatId.value === id) loadError.value = e instanceof ApiError ? e.code : 'unreachable'
    } finally {
      if (chatId.value === id) loading.value = false
    }
  }

  /**
   * The stored chat takes the turn's place once it holds it. Final review I3: the chat is updated even
   * when a newer turn is live by then (only that turn's own live view is cleared), and never with an
   * older read than the one shown.
   */
  async function settle(turn: LiveTurn, tries = 1): Promise<void> {
    const id = chatId.value
    if (!id) return
    const before = chat.value?.messages.length ?? 0
    const expected = turn.retry ? before : before + 2
    for (let i = 0; i < tries; i++) {
      if (i) await new Promise((r) => setTimeout(r, 300))
      let view: AiChatView
      try {
        view = await aiChatApi.get(id)
      } catch {
        return
      }
      if (chatId.value !== id) return
      const holds = turn.turnId
        ? view.messages.some((m) => m.id === turn.turnId)
        : view.messages.length >= expected
      if (holds) {
        if (turn.turnId && turn.sent) sentByTurn.set(turn.turnId, turn.sent)
        if (turn.turnId && turn.agent?.steps.some((s) => s.results))
          resultsByTurn.set(
            turn.turnId,
            turn.agent.steps.map((s) => ({ tool: s.tool, ...(s.results ? { results: s.results } : {}) })),
          )
        if (view.messages.length >= (chat.value?.messages.length ?? 0)) chat.value = view
        if (live.value === turn) live.value = null
        version.value++
        return
      }
    }
  }

  function apply(turn: LiveTurn, line: AiChatLine): void {
    switch (line.type) {
      case 'chat':
        turn.stored = true
        turn.turnId = line.turn
        if (turn.agent && line.run) turn.agent.run = line.run
        if (!chatId.value) {
          chatId.value = line.id
          pendingTitle.value = line.title
          version.value++
          persist()
        }
        break
      case 'context':
        Object.assign(turn, {
          sent: line.sent,
          catalogue: line.catalogue ?? null,
          connectionNames: line.connectionNames ?? null,
          provider: line.provider,
          history: line.history,
          state: 'streaming',
        })
        if (turn.agent && line.agent) {
          turn.agent.connections = line.agent.connections
          turn.agent.documents = line.agent.documents
        }
        break
      case 'text':
        turn.text += line.delta
        break
      case 'done':
        Object.assign(turn, {
          blocks: line.blocks,
          usage: line.usage,
          local: line.local,
          state: 'done',
          agentAsked: !!line.agentAsked,
        })
        break
      case 'error':
        turn.error = {
          reason: line.reason,
          ...(line.retryAfterMs !== undefined ? { retryAfterMs: line.retryAfterMs } : {}),
          ...(line.nothingSent ? { nothingSent: true } : {}),
        }
        turn.state = 'error'
        break
      // W6.3: an agent's step, sent again whenever it changes (its id stays).
      case 'step': {
        if (!turn.agent) break
        const at = turn.agent.steps.findIndex((s) => s.id === line.step.id)
        if (at < 0) turn.agent.steps.push(line.step)
        else turn.agent.steps[at] = line.step
        // Second re-review (minor 3): a change ended by an administrator's policy — the switch says so.
        if (line.step.reason?.startsWith('agent_policy_')) void loadAgentMode()
        if (line.step.state === 'done') onStep?.(line.step)
        break
      }
      case 'note':
        if (turn.agent && !turn.agent.notes.includes(line.note)) turn.agent.notes.push(line.note)
        if (turn.agent && line.note === 'tools_unsupported') turn.agent.fallback = true
        break
      case 'open':
        onOpen?.(line.target)
        break
      case 'ping':
        break
    }
  }

  /** W6.3: the agent's options for one turn. */
  interface AgentSend {
    focus: AgentFocus | null
    documents: boolean
  }

  /** Spec §1.2: one turn at a time; a refused turn stays on screen with its reason (nothing stored). */
  async function send(
    message: string,
    target: ChatTarget | null,
    extras: ChatExtras | null,
    language: UiLanguage,
    opts: { retry?: boolean; agent?: AgentSend } = {},
  ): Promise<void> {
    if (busy.value) return
    const mine = new AbortController()
    controller = mine
    const agent = opts.agent
    const turn = reactive<LiveTurn>({
      seq: ++seq,
      turnId: null,
      message,
      where:
        !agent && target ? { connectionId: target.connectionId, db: target.db, coll: target.coll } : null,
      namespace: !agent && target ? `${target.db}.${target.coll}` : null,
      retry: !!opts.retry,
      stored: false,
      state: 'sending',
      text: '',
      sent: null,
      catalogue: null,
      connectionNames: null,
      provider: null,
      history: null,
      blocks: [],
      usage: null,
      local: null,
      error: null,
      agent: agent
        ? { run: null, steps: [], notes: [], connections: null, documents: agent.documents, fallback: false }
        : null,
      agentAsked: false,
    }) as LiveTurn
    live.value = turn
    const common = {
      ...(chatId.value ? { chat: chatId.value } : {}),
      message,
      language,
      ...(providerId.value ? { provider: providerId.value } : {}),
      ...(opts.retry ? { retry: true } : {}),
    }
    const onLine = (line: AiChatLine) => controller === mine && apply(turn, line)
    try {
      const zone = timeZoneOfBrowser()
      if (agent)
        await aiAgentApi.send(
          {
            ...common,
            documents: agent.documents,
            ...(agent.focus ? { focus: agent.focus } : {}),
            // Design 2026-10-25 (A4): the times the person gives are in their own zone.
            ...(zone ? { timeZone: zone } : {}),
          },
          onLine,
          mine.signal,
        )
      else
        await aiChatApi.send(
          target ? { connectionId: target.connectionId, db: target.db, coll: target.coll } : null,
          { ...common, ...(target && extras ? extras : {}) },
          onLine,
          mine.signal,
        )
      if (controller === mine && (turn.state === 'sending' || turn.state === 'streaming')) {
        turn.error = { reason: 'provider_error' }
        turn.state = 'error'
      }
    } catch (e) {
      if (mine.signal.aborted || controller !== mine) return
      const d = (e instanceof ApiError ? e.details : undefined) as
        { reason?: string; retryAfterMs?: number } | undefined
      turn.error = {
        reason: d?.reason ?? (e instanceof ApiError ? e.code : 'unreachable'),
        ...(d?.retryAfterMs !== undefined ? { retryAfterMs: d.retryAfterMs } : {}),
      }
      turn.state = 'error'
      // Design 2026-10-25 (A2): turned off for this person or by an administrator meanwhile — the
      // switch says so at once (another tab's change, a policy set while this one was open).
      if (d?.reason === 'agent_off' || d?.reason?.startsWith('agent_policy_')) void loadAgentMode()
      return
    } finally {
      if (controller === mine) controller = null
    }
    if (turn.stored) await settle(turn)
  }

  /**
   * W6.3: the person's answer to a change on its card. The change runs on the server through its
   * route, as them; the turn's own lines then say how it ended.
   */
  async function decide(
    step: AiAgentStep,
    body: Omit<AgentDecisionBody, 'call'>,
  ): Promise<AgentDecisionResult> {
    const run = live.value?.agent?.run
    if (!run) return { state: 'cancelled' }
    try {
      return await aiAgentApi.decide(run, { call: step.id, ...body })
    } catch (e) {
      // Re-review of A1/A2 (M6): refused for the person's switch or the policy — the switch says so.
      const reason = (e instanceof ApiError ? (e.details as { reason?: string } | undefined) : undefined)
        ?.reason
      if (reason === 'agent_off' || reason?.startsWith('agent_policy_')) void loadAgentMode()
      throw e
    }
  }

  /** W6.3: agent mode as the server keeps it for this person. */
  async function loadAgentMode(): Promise<void> {
    try {
      const p = await aiAgentApi.preference()
      agentMode.value = p.on
      agentAvailable.value = p.available
      agentPolicy.value = p.policy
      agentAssistant.value = p.assistant
    } catch {
      agentMode.value = false
      agentAvailable.value = false
      agentPolicy.value = null
      agentAssistant.value = false
    }
  }
  async function setAgentMode(on: boolean): Promise<void> {
    const before = agentMode.value
    agentMode.value = on
    try {
      const p = await aiAgentApi.setPreference(on)
      agentMode.value = p.on
      agentAvailable.value = p.available
      agentPolicy.value = p.policy
      agentAssistant.value = p.assistant
    } catch (e) {
      agentMode.value = before
      throw e
    }
  }
  /** Design 2026-10-25 (A5): a step that ended, for what the app shows of it. */
  function setStepHandler(handler: ((step: AiAgentStep) => void) | null): void {
    onStep = handler
  }
  function setOpenHandler(handler: ((target: AiAgentOpen) => void) | null): void {
    onOpen = handler
  }

  /** C8: sign-out leaves no chat behind. */
  function reset(): void {
    stop()
    open.value = false
    pendingQuestion.value = null
    width.value = DEFAULT_WIDTH
    height.value = DEFAULT_HEIGHT
    expanded.value = false
    draft.value = ''
    user.value = null
    chatId.value = null
    chat.value = null
    live.value = null
    loading.value = false
    loadError.value = null
    providerId.value = null
    settling.value = false
    agentMode.value = null
    agentAvailable.value = false
    agentPolicy.value = null
    agentAssistant.value = false
    for (const k of Object.keys(parts)) delete parts[k]
    forgetChat()
  }

  return {
    open,
    width,
    height,
    expanded,
    draft,
    chatId,
    chat,
    live,
    loading,
    loadError,
    providerId,
    version,
    pendingTitle,
    sentOf,
    resultsOf,
    busy,
    agentMode,
    agentPolicy,
    agentAssistant,
    agentAvailable,
    bindUser,
    show,
    hide,
    toggle,
    pendingQuestion,
    ask,
    takeQuestion,
    setWidth,
    setHeight,
    setExpanded,
    partsFor,
    newChat,
    openChat,
    send,
    decide,
    loadAgentMode,
    setAgentMode,
    setOpenHandler,
    setStepHandler,
    stop,
    reset,
  }
})
