import { z } from 'zod'
import { UiLanguageSchema } from '../languages'
import {
  AiCurrentSchema,
  AiSamplesSchema,
  type AiKind,
  type AiReason,
  type AiResult,
  type AiSent,
  type AiWarning,
} from './ai'
import type {
  AiAgentConnectionInfo,
  AiAgentNote,
  AiAgentOpen,
  AiAgentStep,
  AiAgentStepRecord,
} from './aiAgent'

/** Phase 4a-2 spec §2.2, §2.4. */
export const AI_CHAT_LIMITS = {
  message: 8000,
  title: 60,
  answerBytes: 64 * 1024,
  messagesPerChat: 200,
  chatsPerUser: 50,
  bytesPerUser: 16 * 1024 * 1024,
  historyTurns: 20,
  historyBytes: 24 * 1024,
  blocks: 10,
  memoryIdleMs: 12 * 60 * 60 * 1000,
} as const

/** Spec §1.3: what a collection turn may carry besides the schema summary (plan ruling 10). */
export const AI_CHAT_PARTS = ['current', 'indexes', 'validator'] as const
export type AiChatPart = (typeof AI_CHAT_PARTS)[number]

const TurnFields = {
  /** Absent: a new chat. */
  chat: z.uuid().optional(),
  message: z.string().trim().min(1).max(AI_CHAT_LIMITS.message),
  language: UiLanguageSchema.default('en'),
  provider: z.uuid().optional(),
  /** Plan ruling 3: the last turn did not end well; it is removed and its words sent again. */
  retry: z.boolean().default(false),
}
/** A turn without collection context (`POST /api/ai/chat`). */
export const AiChatTurnSchema = z.strictObject(TurnFields)
/** A turn about one collection (`POST …/collections/:coll/ai/chat`). */
export const AiChatCollectionTurnSchema = z.strictObject({
  ...TurnFields,
  parts: z
    .strictObject({
      current: z.boolean().default(false),
      indexes: z.boolean().default(true),
      validator: z.boolean().default(false),
    })
    .default({ current: false, indexes: true, validator: false }),
  current: AiCurrentSchema.optional(),
  samples: AiSamplesSchema.optional(),
})
export const AiChatRenameSchema = z.strictObject({
  title: z.string().trim().min(1).max(AI_CHAT_LIMITS.title),
})
export type AiChatTurn = z.output<typeof AiChatTurnSchema>
export type AiChatCollectionTurn = z.output<typeof AiChatCollectionTurnSchema>
export type AiChatTurnBody = z.input<typeof AiChatTurnSchema>
export type AiChatCollectionTurnBody = z.input<typeof AiChatCollectionTurnSchema>

export interface AiChatProviderRef {
  id: string
  name: string
  model: string
  kind: AiKind
}

/** Spec §1.1: what a turn was about and how it went — stored in clear, never the context itself. */
export interface AiChatTurnRecord {
  connectionId: string | null
  /** "db.coll", or null for a general turn. */
  namespace: string | null
  /** The connection's personal-data rules version when the turn was made (spec §2.2). */
  rulesVersion: number | null
  /**
   * Plan ruling 18: every connection whose data this turn's answer may carry — its own, and those of
   * the earlier turns sent with it — with the rules version each was masked under.
   */
  sources: Array<{ connectionId: string; rulesVersion: number }>
  /**
   * Third review of the connection names (I-2): connections only named that the answer names — no
   * source (a name carries no data), but checked for their policy before the turn goes on: one
   * turned off, or local-only for a cloud provider, keeps the turn back.
   */
  named?: string[]
  /**
   * Share review C1: the answer may carry a credential collection's data — its own collection is one,
   * or an earlier turn sent with it did (a turn kept before this mark counts as one).
   */
  credential?: boolean
  parts: { schema: boolean; current: boolean; indexes: boolean; validator: boolean; samples: number }
  provider: AiChatProviderRef
  local: boolean | null
  usage: { input: number; output: number }
  state: 'done' | 'stopped' | 'error'
  reason?: string
  /** The answer was shortened to be stored (spec §2.4). */
  cut?: true
  /** Refused before anything was written to the provider (4a-1 final review I4), kept with the turn. */
  nothingSent?: true
  /** Final review Important 2: what the history sent and left out (causes and counts, never content). */
  history?: AiChatHistoryInfo
  /** User report 2026-10-25: a plain turn asked for a change the agent makes. */
  agentAsked?: true
  /**
   * User request 2026-10-10: the collections a general turn's blocks named, from the list it was
   * given — kept so that "Run query" still knows where to go when the chat is opened again. An agent
   * turn's: the collections its steps used, by the names its blocks may give them (design 2026-10-25).
   */
  targets?: Record<string, AiChatTarget>
  /** A general turn: how many collection names were sent with it (names only). */
  catalogue?: number
  /** How many connection names were sent with it (a general turn's or one about a collection; names only). */
  connectionNames?: number
  /** W6.3: an agent turn's steps (tools, places and outcomes; never values). */
  agent?: AiChatAgentRecord
}

/** W6.3: what a stored agent turn did. */
export interface AiChatAgentRecord {
  steps: AiAgentStepRecord[]
  /** How many connections were named to the model (names only). */
  connections: number
  /** Documents' values were allowed this turn (the person's consent). */
  documents: boolean
  /** The provider could not call tools: the turn ran as a plain chat turn. */
  fallback?: true
}

/** A collection an answer's block is about (a general turn names it from the list it was given). */
export interface AiChatTarget {
  connectionId: string
  db: string
  coll: string
}

/** Spec §1.4: a recognised code block of an answer; `index` counts every fenced block. */
export interface AiChatBlock {
  index: number
  result: AiResult | null
  warnings: AiWarning[]
  /** Plan ruling 7: refused by the server's JavaScript setting. */
  reason?: 'server_js'
  /** The collection the block is about, when a general turn named one it was given. */
  target?: AiChatTarget
  /**
   * Review I3: the block named a collection that was not in the list (or that two shared): it goes
   * nowhere — never into whatever collection happens to be open.
   */
  unresolved?: true
  /**
   * User request 2026-10-13 ("excel olarak yada json olarak indir"): the block's output asked for as
   * a file, offered as an export of the query or pipeline.
   */
  export?: AiChatExport
}

/** The files a block's output may be asked for in. */
export const AI_CHAT_EXPORTS = ['xlsx', 'csv', 'json'] as const
export type AiChatExport = (typeof AI_CHAT_EXPORTS)[number]

export interface AiChatSummary {
  id: string
  /** null: it does not open with this server's key. */
  title: string | null
  namespace: string | null
  messages: number
  updatedAt: number
}

export interface AiChatMessageView {
  id: string
  role: 'user' | 'assistant'
  /** null: unreadable (sealed with another key). */
  text: string | null
  createdAt: number
  /** On the user's message: the turn's record. */
  turn?: AiChatTurnRecord
  /** On the answer: its recognised code blocks. */
  blocks?: AiChatBlock[]
}

export interface AiChatView {
  id: string
  title: string | null
  messages: AiChatMessageView[]
  /** 200 messages: a new turn is refused (`chat_full`). */
  full: boolean
}

/** Spec §2.2: how many earlier turns travelled, and what was left out ("history:access:1"…). */
export interface AiChatHistoryInfo {
  sent: number
  leftOut: string[]
}

/** The NDJSON lines of a turn (spec §2.5). */
export type AiChatLine =
  | {
      type: 'chat'
      id: string
      title: string
      /** The user's message id once stored (final review I2). */ turn: string
      /** W6.3: an agent turn's run, which its changes are confirmed against. */
      run?: string
    }
  | {
      type: 'context'
      sent: AiSent | null
      provider: AiChatProviderRef
      history: AiChatHistoryInfo
      /** A general turn: how many collection names were sent (names only, never their data). */
      catalogue?: number
      /** How many connection names were sent (with a general turn or one about a collection; names only). */
      connectionNames?: number
      /** W6.3: an agent turn — the connections named to the model, and whether documents may go. */
      agent?: { connections: AiAgentConnectionInfo[]; documents: boolean }
    }
  | { type: 'text'; delta: string }
  | {
      type: 'done'
      blocks: AiChatBlock[]
      usage: { input: number; output: number }
      local: boolean | null
      /** User report 2026-10-25: a plain turn asked for a change — the agent does it. */
      agentAsked?: true
    }
  | { type: 'error'; reason: AiReason; retryAfterMs?: number; nothingSent?: true }
  /** W6.3: a step of an agent turn, sent again whenever it changes (same id). */
  | { type: 'step'; step: AiAgentStep }
  /** W6.3: a tab the agent opened in the app (UI only). */
  | { type: 'open'; target: AiAgentOpen }
  | { type: 'note'; note: AiAgentNote }
  /** W6.3: written while a change waits for the person, so that proxies keep the answer open. */
  | { type: 'ping' }
