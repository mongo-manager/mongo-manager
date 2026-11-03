import type { AiAgentStepRecord } from './aiAgent'
import { z } from 'zod'
import { AI_ACTIONS, type AiCurrency, type AiKind } from './ai'

/**
 * User review 2026-10-09 ("AI yaptırdığımız işleri nerde görüyoruz … kaç token … maliyet"): every AI
 * request kept for its owner — what was asked and answered (sealed), the tokens, the time and the
 * cost from the provider's price — for as long as an administrator sets (90 days by default).
 */

// completion W6.2: the Overview's next steps, ordered by the AI (kept without words).
export const AI_HISTORY_ACTIONS = [...AI_ACTIONS, 'chat', 'nextActions'] as const
export type AiHistoryAction = (typeof AI_HISTORY_ACTIONS)[number]

/** A page cursor: the latest time and insertion order of the last entry seen, and the time it is as of. */
const Cursor = z.string().regex(/^\d{1,15}:\d{1,15}(:\d{1,15})?$/)

export const AiHistoryQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: Cursor.optional(),
  action: z.enum(AI_HISTORY_ACTIONS).optional(),
  outcome: z.enum(['ok', 'failed']).optional(),
  providerId: z.uuid().optional(),
  connectionId: z.string().min(1).max(64).optional(),
  q: z.string().min(1).max(200).optional(),
  /** User review 2026-10-09: the entries teammates shared (and the asker may read), not their own. */
  shared: z.enum(['1']).optional(),
})
export type AiHistoryQuery = z.infer<typeof AiHistoryQuerySchema>

export interface AiCost {
  amount: number
  currency: AiCurrency
}

/** What was asked and answered: its owner's to read. */
export interface AiHistoryContent {
  prompt: string
  answer: string
  /** The parsed result (a query, a pipeline, a validator…), when there was one. */
  result?: unknown
  /** What left the server for the provider (schema, current query…), without the sample documents. */
  sent?: unknown
  /** How many sample documents went to the provider; their values are never kept. */
  samples?: number
  /**
   * User report 2026-10-25: an agent turn's steps, as its chat keeps them — tools, places and
   * outcomes (the changes it proposed among them), never values.
   */
  steps?: AiAgentStepRecord[]
}

export interface AiHistoryItem {
  id: string
  at: number
  action: AiHistoryAction
  /** A chat turn's chat. */
  chatId: string | null
  connectionId: string | null
  namespace: string | null
  provider: { id: string | null; name: string; kind: AiKind; model: string }
  /** "ok" or the reason it failed (the AI reasons, "aborted"…). */
  outcome: string
  usage: { input: number; output: number }
  ms: number
  cost: AiCost | null
  /** The request's first words; null when content is not kept. */
  preview: string | null
  /** Only when one item is read; null when content is not kept. */
  content?: AiHistoryContent | null
  /** User review 2026-10-09: the chain it belongs to (a pipeline and the changes asked of it after). */
  thread: string | null
  /** Its place in the chain, from 1. */
  step: number | null
  /** On a page, a chain's first step carries the chain's sums; null for a request alone. */
  chain?: AiHistoryChain | null
  /** User review 2026-10-09: the asker's own (false: a teammate shared it, read-only). */
  mine?: boolean
  /** Shared with the team (the whole entry: a chain with all its steps). */
  shared?: boolean
  /** Who shared it, when it is not the asker's. */
  sharedBy?: string | null
  /** Its owner may share it: what its answer drew on is known (an older chat turn's is not). */
  shareable?: boolean
}

/** Whether the asker may share: team mode, with another active user (user review 2026-10-09). */
export interface AiHistorySharing {
  available: boolean
}

/** A chain of requests, summed: its steps, latest activity, tokens, time, cost and latest outcome. */
export interface AiHistoryChain {
  steps: number
  /** When its latest step was asked. */
  at: number
  usage: { input: number; output: number }
  ms: number
  cost: AiCost[]
  /** The latest step's outcome. */
  outcome: string
  /** The latest step's id (a chain opens on it). */
  latest: string
}

/** A chain's steps, in order, with what was asked and answered. */
export interface AiHistoryThread {
  steps: AiHistoryItem[]
}

export interface AiHistoryPage {
  items: AiHistoryItem[]
  /** The cursor of the next page, or null. */
  next: string | null
}

export const AiHistorySettingsSchema = z.strictObject({
  days: z.number().int().min(1).max(3650),
  keepContent: z.boolean(),
})
export type AiHistorySettings = z.infer<typeof AiHistorySettingsSchema>
export const AI_HISTORY_DEFAULTS: AiHistorySettings = { days: 90, keepContent: true }

export const AiUsageQuerySchema = z.strictObject({
  days: z.coerce.number().int().min(1).max(3650).default(30),
  /** An administrator's view of every user (never anyone's words). */
  all: z.enum(['1']).optional(),
  /** The asker's offset from UTC in minutes (e.g. 180 east): with it, the usage by day is given too. */
  tz: z.coerce.number().int().min(-840).max(840).optional(),
})

export interface AiUsageCount {
  requests: number
  input: number
  output: number
  /** One sum per currency (providers may be priced in different ones). */
  cost: AiCost[]
}
export interface AiUsage {
  since: number
  totals: AiUsageCount
  byModel: Array<AiUsageCount & { provider: string; kind: AiKind; model: string }>
  /** By day in the asker's time zone (YYYY-MM-DD), oldest first; days without requests left out. */
  byDay?: Array<AiUsageCount & { day: string }>
  /** All users (administrators, with all=1). */
  byUser?: Array<AiUsageCount & { userId: string | null; username: string | null }>
}
