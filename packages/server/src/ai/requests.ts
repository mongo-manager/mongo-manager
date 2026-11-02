import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  AI_AGENT_LIMITS,
  AI_HISTORY_DEFAULTS,
  AiHistorySettingsSchema,
  type AiAgentPlan,
  type AiAgentStepRecord,
  type AiCurrency,
  type AiHistoryAction,
  type AiHistoryChain,
  type AiHistoryContent,
  type AiHistoryItem,
  type AiHistoryPage,
  type AiHistoryQuery,
  type AiHistorySettings,
  type AiKind,
  type AiPrice,
  type AiUsage,
  type AiUsageCount,
} from '@mongo-manager/shared'
import type { SecretBox } from '../crypto/secret-box'
import type { SettingsRepo } from '../store/settings'
import type { ChatOwner } from './chats'
import { isAdminOnlyNs } from '../connections/access'

/**
 * User review 2026-10-09 ("AI yaptırdığımız işleri nerde görüyoruz … kaç token … maliyet"): every AI
 * request, kept for its owner. The words asked and answered, the result and what was sent are sealed
 * per row; the tokens, the time and the cost are in clear for the usage sums (an administrator's view
 * of everyone's usage never opens anyone's words). Kept for the days an administrator sets.
 */
const DAY = 86_400_000
const SETTINGS_KEY = 'ai.history'
/** A search opens at most this many rows a page; the next page goes on from there. */
const SEARCH_SCAN = 2000
const PREVIEW = 200
/** Each part of what is kept, at most (the answer as a chat keeps it; the context as it was capped). */
const PART_BYTES = 64 * 1024
/**
 * The words one user's history keeps, sealed, at most: past it the oldest requests lose their words
 * (never their tokens, time or cost). Without it a user could fill the disk: a day's quota of requests
 * of up to four 64 KiB parts each, kept for months.
 */
const WORDS_PER_USER = 32 * 1024 * 1024

export const aiRequestContext = (id: string, owner: ChatOwner) => `ai-request:${JSON.stringify([id, owner])}`
/** The preview's own context: one sealed column never opens as the other. */
export const aiRequestPreviewContext = (id: string, owner: ChatOwner) =>
  `ai-request-preview:${JSON.stringify([id, owner])}`

export interface AiHistoryOptions {
  /** Sealed words one user keeps, at most. */
  wordsPerUser?: number
  /** Rows a search opens a page, at most. */
  searchScan?: number
  /** Chats are kept on disk (MM_AI_CHAT_DAYS above 0): a chat's words here live as long as the chat. */
  chatsKept?: boolean
}

interface Row {
  id: string
  user_id: string | null
  at: number
  action: string
  chat_id: string | null
  connection_id: string | null
  namespace: string | null
  provider_id: string | null
  provider_name: string
  provider_kind: string
  model: string
  outcome: string
  input: number
  output: number
  ms: number
  cost: number | null
  currency: string | null
  content: string | null
  preview: string | null
  thread_id: string | null
  step: number | null
  /** Share review C1: the connections its answer drew on (JSON), null when not known. */
  sources: string | null
  /** Share review I2: it touched a credential collection. */
  credential: number
  /** Read with the row: shared with the team, and its owner's name. */
  shared?: number
  owner_name?: string | null
}

/**
 * User review 2026-10-09, share review C1/I2: what a teammate's shared entry drew on — every
 * connection its answer did (a chat turn's history's too), and whether a credential collection.
 * The route decides who may read it (permissions live there); the repo only asks.
 */
export interface Place {
  connections: string[]
  credential: boolean
}
export type MayRead = (place: Place) => boolean
/**
 * The connections a teammate may read shared entries of (unmasked), those they are an admin of
 * (credential collections), and whether entries that drew on none (a general chat turn).
 */
export interface SharedAccess {
  readable: string[]
  admin: string[]
  noConnection: boolean
}

/** Where a row's answer drew on; null when not known (it is then never another's to read). */
function placeOf(row: Row): Place | null {
  if (row.sources === null) return null
  try {
    const parsed = JSON.parse(row.sources) as unknown
    if (!Array.isArray(parsed) || !parsed.every((c) => typeof c === 'string')) return null
    return { connections: parsed as string[], credential: row.credential === 1 }
  } catch {
    return null
  }
}

/**
 * The entry a row is shared as: a request alone, or its chain — but a chat's turn on its own (review of
 * the chat entry, C1, I2): a chat is one entry for its owner only, each turn shared alone, so a turn on
 * a connection a teammate may not read is never theirs through another.
 */
const entryOf = (alias: string) =>
  `(CASE WHEN ${alias}.action = 'chat' THEN ${alias}.id ELSE COALESCE(${alias}.thread_id, ${alias}.id) END)`
/** Whether a row's entry (a request alone, its chain, or a chat's turn) is shared. */
const SHARED = `EXISTS (SELECT 1 FROM ai_request_shares s
  WHERE s.user_id = r.user_id AND s.entry = ${entryOf('r')})`
/**
 * Re-review of the chat entry (M5): a row a teammate may read, by its own place — the connections
 * it drew on readable to them (a credential collection's administered), one without any only where
 * chats without a connection are theirs. Its three parameters: readableParams().
 */
const readableBy = (a: string) => `(${a}.sources IS NOT NULL
  -- Third review (nit 4): a chain's steps only, never a chat's turn under the same id.
  AND ${a}.action <> 'chat'
  AND NOT EXISTS (SELECT 1 FROM json_each(${a}.sources) j WHERE j.value NOT IN (SELECT value FROM json_each(?)))
  AND (${a}.credential = 0
    OR NOT EXISTS (SELECT 1 FROM json_each(${a}.sources) j WHERE j.value NOT IN (SELECT value FROM json_each(?))))
  AND (json_array_length(${a}.sources) > 0 OR ? = 1))`
const readableParams = (s: SharedAccess) => [
  JSON.stringify(s.readable),
  JSON.stringify(s.admin),
  s.noConnection ? 1 : 0,
]
/**
 * Re-review of the chat entry (M7): its owner's chat is shared where any turn of it is (each turn
 * shared alone).
 */
// Third review (nits 5, 6): from the chat's turns (by the chain's index), as of the page's time.
const ANY_TURN_SHARED = `CASE WHEN r.action = 'chat' AND r.thread_id IS NOT NULL
  THEN EXISTS (SELECT 1 FROM ai_requests y JOIN ai_request_shares s ON s.user_id = y.user_id AND s.entry = y.id
    WHERE y.user_id IS r.user_id AND y.thread_id = r.thread_id AND y.action = 'chat' AND y.at <= ?)
  ELSE ${SHARED} END`
/** A row's owner may still sign in: a disabled account's shares stop with it. */
const OWNER_ACTIVE = 'EXISTS (SELECT 1 FROM users u WHERE u.id = r.user_id AND u.disabled = 0)'
/** A row with whether it is shared and its owner's name. */
const WITH_SHARE = `r.*, ${SHARED} AS shared, (SELECT username FROM users u WHERE u.id = r.user_id) AS owner_name`

export interface NewAiRequest {
  owner: ChatOwner
  action: AiHistoryAction
  chatId?: string | null
  connectionId: string | null
  namespace: string | null
  provider: { id: string; name: string; kind: AiKind; model: string }
  outcome: string
  usage: { input: number; output: number }
  ms: number
  price: AiPrice | null
  /** Null: the words must not be kept (chats kept in memory only); the usage still counts. */
  content: AiHistoryContent | null
  /** The chain the browser says it belongs to (its own chains only, on one collection). */
  thread?: string | null
  /** Share review C1: every connection the answer drew on; by default its own. */
  sources?: string[]
  /** Share review I2: it may carry a credential collection's data; by default from its namespace. */
  credential?: boolean
}

/** A part within its bytes, cut on a character boundary. */
function bounded(text: string): string {
  const bytes = Buffer.from(text)
  return bytes.length <= PART_BYTES ? text : bytes.subarray(0, PART_BYTES).toString('utf8').replace(/�+$/, '')
}
function boundedJson(value: unknown): unknown {
  if (value === undefined) return undefined
  const text = JSON.stringify(value)
  return text !== undefined && Buffer.byteLength(text) <= PART_BYTES ? value : { cut: true }
}
const round = (n: number) => Math.round(n * 1e6) / 1e6
const previewOf = (prompt: string) => [...prompt].slice(0, PREVIEW).join('')
/**
 * User report 2026-10-25: an agent turn's steps, kept as its chat keeps them — these fields only (never
 * a value, nor a route's words), and no more than a turn may have. Review of the history's steps (M1,
 * M2): names within their bounds, and no job's id (the owner's: a teammate may read the request).
 */
function keptSteps(steps: readonly AiAgentStepRecord[]): AiAgentStepRecord[] {
  return steps.slice(0, AI_AGENT_LIMITS.callsPerTurn).map((s) => {
    const summary = s.summary
      ? Object.fromEntries(
          Object.entries(s.summary)
            .filter(([k]) => k !== 'job' && k !== 'sendJob')
            .map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 511) : v]),
        )
      : null
    return {
      tool: s.tool,
      connectionId: s.connectionId,
      namespace: s.namespace === null ? null : s.namespace.slice(0, 511),
      state: s.state,
      ...(s.sent ? { sent: s.sent } : {}),
      // A count within what one step may send, never a value.
      ...(Number.isSafeInteger(s.documents) && s.documents! > 0 ? { documents: s.documents } : {}),
      ...(summary && Object.keys(summary).length ? { summary } : {}),
      ...(s.reason ? { reason: s.reason.slice(0, 64) } : {}),
      // Final review of wave C (nit 5): the plan as the chat keeps it, within its bounds; the backup
      // (its job is the owner's) never.
      ...(s.plan ? { plan: keptPlan(s.plan) } : {}),
      ...(typeof s.planItem === 'number' ? { planItem: s.planItem } : {}),
    }
  })
}
const keptPlan = (p: AiAgentPlan): AiAgentPlan => ({
  title: p.title.slice(0, 120),
  changes: p.changes
    .slice(0, AI_AGENT_LIMITS.planChanges)
    .map((x) => ({ tool: x.tool, about: x.about.slice(0, 200) })),
})

/** AI history review I4: sample documents are real (masked) values; only how many went is kept. */
function withoutSamples(sent: unknown): { sent: unknown; samples: number } {
  if (!sent || typeof sent !== 'object' || !Array.isArray((sent as { samples?: unknown }).samples))
    return { sent, samples: 0 }
  const samples = (sent as { samples: unknown[] }).samples.length
  return { sent: { ...(sent as object), samples: [] }, samples }
}
/**
 * What a page lists: a request alone, or the first step left of a chain, with its latest activity.
 * Without the words a page reads the preview (the words only for a row kept before it had one).
 */
const entries = (words: boolean, whose: string, shared = false) => {
  // A teammate's shared list: a chat's turn is an entry alone (review of the chat entry, C1).
  const alone = shared ? "r.thread_id IS NULL OR r.action = 'chat'" : 'r.thread_id IS NULL'
  return `
  SELECT r.rowid AS seq, r.id, r.user_id, r.at, r.action, r.chat_id, r.connection_id, r.namespace,
    r.provider_id, r.provider_name, r.provider_kind, r.model, r.outcome, r.input, r.output, r.ms, r.cost,
    r.currency, r.preview, r.thread_id, r.step, ${shared ? SHARED : ANY_TURN_SHARED} AS shared,
    (SELECT username FROM users u WHERE u.id = r.user_id) AS owner_name,
    ${words ? 'r.content' : 'CASE WHEN r.preview IS NULL THEN r.content END'} AS content,
    CASE WHEN ${alone} THEN (CASE WHEN r.at <= ? THEN r.at END)
      ELSE (SELECT MAX(x.at) FROM ai_requests x
            WHERE x.user_id IS r.user_id AND x.thread_id = r.thread_id AND x.at <= ?
            -- Re-review (M5): a teammate's order by the steps they may read.
            ${shared ? `AND ${readableBy('x')}` : ''})
    END AS last
  FROM ai_requests r
  WHERE ${whose} AND (${alone} OR r.rowid = COALESCE(
    -- Review of the chat entry (M10): a chat is listed by its first turn whose words are kept — each
    -- arm by the chain's index (re-review, M9).
    (SELECT x.rowid FROM ai_requests x WHERE x.user_id IS r.user_id AND x.thread_id = r.thread_id
       AND (x.action <> 'chat' OR x.preview IS NOT NULL) ORDER BY x.step, x.rowid LIMIT 1),
    (SELECT x.rowid FROM ai_requests x WHERE x.user_id IS r.user_id AND x.thread_id = r.thread_id
       ORDER BY x.step, x.rowid LIMIT 1)))`
}
/**
 * The entries' order is their latest activity as of the first page (chains review M6): a chain that
 * gains a step while the pages are read keeps its place, and what came after is on the next visit.
 */
/** A condition met by any step of an entry (the request itself, or any step of its chain). */
const anyStep = (condition: string, shared = false) =>
  `EXISTS (SELECT 1 FROM ai_requests x WHERE x.user_id IS e.user_id
     AND (x.rowid = e.seq OR (e.thread_id IS NOT NULL${shared ? " AND e.action <> 'chat'" : ''}
       AND x.thread_id = e.thread_id${shared ? ` AND ${readableBy('x')}` : ''})) AND ${condition})`
type Entry = Row & { seq: number; last: number }
const FORGET = 'content = NULL, preview = NULL, bytes = 0'
/** A chain, by its owner and id (two users' chains may share an id: it comes from the browser). */
const chainKey = (owner: ChatOwner, thread: string) => `${owner ?? ''}\u0000${thread}`

/** A chain's sums from its steps (of two or more), as chains() sums them. */
function sumsOf(steps: AiHistoryItem[]): AiHistoryChain | null {
  if (steps.length < 2) return null
  const costs = new Map<string, number>()
  for (const s of steps)
    if (s.cost) costs.set(s.cost.currency, (costs.get(s.cost.currency) ?? 0) + s.cost.amount)
  return {
    steps: steps.length,
    at: Math.max(...steps.map((s) => s.at)),
    usage: {
      input: steps.reduce((n, s) => n + s.usage.input, 0),
      output: steps.reduce((n, s) => n + s.usage.output, 0),
    },
    ms: steps.reduce((n, s) => n + s.ms, 0),
    cost: [...costs].map(([currency, amount]) => ({
      amount: round(amount),
      currency: currency as AiCurrency,
    })),
    outcome: steps.at(-1)!.outcome,
    latest: steps.at(-1)!.id,
  }
}

export class AiHistoryRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly box: SecretBox,
    private readonly settingsRepo: SettingsRepo,
    private readonly now: () => number,
    options: AiHistoryOptions = {},
  ) {
    this.wordsPerUser = options.wordsPerUser ?? WORDS_PER_USER
    this.searchScan = options.searchScan ?? SEARCH_SCAN
    this.chatsKept = options.chatsKept ?? true
    // Security audit 2026-10-16 (minor): entries kept before the local database counted as admin-only
    // (isAdminOnlyNs) are marked now, so a shared one reaches that connection's admins only.
    this.db
      .prepare(
        "UPDATE ai_requests SET credential = 1 WHERE credential = 0 AND (namespace = 'local' OR namespace LIKE 'local.%')",
      )
      .run()
  }
  private readonly wordsPerUser: number
  private readonly searchScan: number
  private readonly chatsKept: boolean

  settings(): AiHistorySettings {
    return this.settingsRepo.get(SETTINGS_KEY, AiHistorySettingsSchema, AI_HISTORY_DEFAULTS)
  }

  /** AI history review I2: keeping no words forgets the words already kept, at once. */
  setSettings(value: AiHistorySettings): AiHistorySettings {
    this.settingsRepo.set(SETTINGS_KEY, value)
    if (!value.keepContent)
      this.db
        .prepare(`UPDATE ai_requests SET ${FORGET} WHERE content IS NOT NULL OR preview IS NOT NULL`)
        .run()
    return value
  }

  record(entry: NewAiRequest): string {
    const id = randomUUID()
    const { keepContent } = this.settings()
    const words = keepContent ? entry.content : null
    const { sent, samples } = withoutSamples(words?.sent)
    const content = words
      ? this.box.seal(
          JSON.stringify({
            prompt: bounded(words.prompt),
            answer: bounded(words.answer),
            result: boundedJson(words.result),
            sent: boundedJson(sent),
            ...(samples ? { samples } : {}),
            ...(words.steps?.length ? { steps: keptSteps(words.steps) } : {}),
          }),
          aiRequestContext(id, entry.owner),
        )
      : null
    const preview = words
      ? this.box.seal(previewOf(words.prompt), aiRequestPreviewContext(id, entry.owner))
      : null
    // A chain is the owner's own, on one collection: a chain id seen elsewhere starts nothing. User
    // reports 2026-10-25: a chat's turns are one chain, whatever each was about — the chat's own id,
    // the server's (never another request's, nor another chat's).
    let thread: string | null = null
    let step: number | null = null
    const chat = entry.action === 'chat'
    // Review of the chat entry (M7): a request never takes a chat's id, even before its first turn.
    const chatsId =
      !chat &&
      !!entry.thread &&
      !!this.db
        // Re-review (I2): by the chat's own key, the owner's — never a scan (a kept turn's chain is
        // refused below already).
        .prepare('SELECT 1 FROM ai_chats WHERE id = ? AND user_id IS ?')
        .get(entry.thread, entry.owner)
    if (entry.thread && !chatsId && (!chat || entry.thread === entry.chatId)) {
      const previous = this.db
        .prepare(
          'SELECT step, namespace, connection_id, action, chat_id FROM ai_requests WHERE user_id IS ? AND thread_id = ? ORDER BY step DESC LIMIT 1',
        )
        .get(entry.owner, entry.thread) as
        | {
            step: number
            namespace: string | null
            connection_id: string | null
            action: string
            chat_id: string | null
          }
        | undefined
      if (!previous) [thread, step] = [entry.thread, 1]
      else if (
        chat
          ? previous.action === 'chat' && previous.chat_id === entry.chatId
          : previous.action !== 'chat' &&
            previous.namespace === entry.namespace &&
            previous.connection_id === entry.connectionId
      )
        [thread, step] = [entry.thread, previous.step + 1]
    }
    const cost = entry.price
      ? round((entry.usage.input * entry.price.input + entry.usage.output * entry.price.output) / 1e6)
      : null
    this.db
      .prepare(
        `INSERT INTO ai_requests (id, user_id, at, action, chat_id, connection_id, namespace, provider_id,
           provider_name, provider_kind, model, outcome, input, output, ms, cost, currency, content, preview,
           bytes, thread_id, step, sources, credential)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        entry.owner,
        this.now(),
        entry.action,
        entry.chatId ?? null,
        entry.connectionId,
        entry.namespace,
        entry.provider.id,
        entry.provider.name,
        entry.provider.kind,
        entry.provider.model,
        entry.outcome,
        entry.usage.input,
        entry.usage.output,
        Math.max(0, Math.round(entry.ms)),
        cost,
        entry.price ? entry.price.currency : null,
        content,
        preview,
        (content?.length ?? 0) + (preview?.length ?? 0),
        thread,
        step,
        JSON.stringify([...new Set(entry.sources ?? (entry.connectionId ? [entry.connectionId] : []))]),
        (entry.credential ?? isAdminOnlyNs(entry.namespace)) ? 1 : 0,
      )
    if (content !== null) this.trimWords(entry.owner)
    // A chat this turn's chat pushed out (the per-user cap) takes its words here with it.
    if (entry.action === 'chat') this.forgetChats(entry.owner)
    return id
  }

  /**
   * AI history review I1: a chat's words here live as long as the chat — gone with it when it is
   * deleted, swept or pushed out, and never kept when chats live in memory only.
   */
  forgetChats(owner?: ChatOwner): number {
    const gone = this.chatsKept
      ? ' AND NOT EXISTS (SELECT 1 FROM ai_chats c WHERE c.id = ai_requests.chat_id)'
      : ''
    const scope = owner === undefined ? '' : ' AND user_id IS ?'
    const statement = this.db.prepare(
      `UPDATE ai_requests SET ${FORGET} WHERE action = 'chat' AND (content IS NOT NULL OR preview IS NOT NULL)${gone}${scope}`,
    )
    return Number((owner === undefined ? statement.run() : statement.run(owner)).changes)
  }

  /** Drops the oldest words past the owner's share; their requests stay, with tokens and cost. */
  private trimWords(owner: ChatOwner): void {
    const { total } = this.db
      .prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM ai_requests WHERE user_id IS ?')
      .get(owner) as { total: number }
    let over = total - this.wordsPerUser
    if (over <= 0) return
    const oldest = this.db
      .prepare(
        'SELECT rowid AS seq, bytes AS size FROM ai_requests WHERE user_id IS ? AND bytes > 0 ORDER BY at, rowid',
      )
      .iterate(owner) as Iterable<{ seq: number; size: number }>
    const drop = this.db.prepare(`UPDATE ai_requests SET ${FORGET} WHERE rowid = ?`)
    const seqs: number[] = []
    for (const row of oldest) {
      if (over <= 0) break
      seqs.push(row.seq)
      over -= row.size
    }
    for (const seq of seqs) drop.run(seq)
  }

  private open(row: Row): AiHistoryContent | null {
    if (row.content === null) return null
    try {
      return JSON.parse(this.box.open(row.content, aiRequestContext(row.id, row.user_id))) as AiHistoryContent
    } catch {
      return null
    }
  }

  /** The preview, sealed apart; a row kept before it had one shows its words' beginning. */
  private openPreview(row: Row): string | null {
    if (row.preview !== null) {
      try {
        return this.box.open(row.preview, aiRequestPreviewContext(row.id, row.user_id))
      } catch {
        return null
      }
    }
    const content = this.open(row)
    return content ? previewOf(content.prompt) : null
  }

  private toItem(row: Row, preview: string | null, viewer: ChatOwner = row.user_id): AiHistoryItem {
    const mine = row.user_id === viewer
    // Review of the chat entry (C1, M6): a teammate is shared a chat's turn alone, never its chat.
    const alone = !mine && row.action === 'chat'
    return {
      id: row.id,
      at: row.at,
      action: row.action as AiHistoryAction,
      // The chat is its owner's: a teammate never gets its id.
      chatId: mine ? row.chat_id : null,
      connectionId: row.connection_id,
      namespace: row.namespace,
      provider: {
        id: row.provider_id,
        name: row.provider_name,
        kind: row.provider_kind as AiKind,
        model: row.model,
      },
      outcome: row.outcome,
      usage: { input: row.input, output: row.output },
      ms: row.ms,
      cost:
        row.cost === null || row.currency === null
          ? null
          : { amount: row.cost, currency: row.currency as AiCurrency },
      preview,
      thread: alone ? null : row.thread_id,
      step: alone ? null : row.step,
      chain: null,
      mine,
      shared: !!row.shared,
      sharedBy: mine ? null : (row.owner_name ?? null),
      shareable: mine && row.sources !== null,
    }
  }

  /** The sums of the chains on a page (only chains of more than one step). */
  private chains(
    pairs: Array<[ChatOwner, string]>,
    asOf: number,
    reading: Array<string | number> = [],
  ): Map<string, AiHistoryChain> {
    const out = new Map<string, AiHistoryChain>()
    if (!pairs.length) return out
    // Each chain is its owner's: another user's steps under the same chain id never count.
    const rows = (
      this.db
        .prepare(
          `SELECT id, user_id, thread_id, at, input, output, ms, cost, currency, outcome FROM ai_requests
         WHERE at <= ? AND (${pairs.map(() => '(user_id IS ? AND thread_id = ?)').join(' OR ')})
         ${reading.length ? `AND ${readableBy('ai_requests')}` : ''}
         ORDER BY step, rowid`,
        )
        .all(asOf, ...pairs.flatMap(([o, t]) => [o, t]), ...reading) as unknown as Array<
        Pick<Row, 'id' | 'at' | 'input' | 'output' | 'ms' | 'cost' | 'currency' | 'outcome'> & {
          user_id: string | null
          thread_id: string
        }
      >
    ).map((r) => ({ ...r, thread_id: chainKey(r.user_id, r.thread_id) }))
    const costs = new Map<string, Map<string, number>>()
    for (const r of rows) {
      const c = out.get(r.thread_id) ?? {
        steps: 0,
        at: 0,
        usage: { input: 0, output: 0 },
        ms: 0,
        cost: [],
        outcome: 'ok',
        latest: r.id,
      }
      c.steps += 1
      c.at = Math.max(c.at, r.at)
      c.usage.input += r.input
      c.usage.output += r.output
      c.ms += r.ms
      c.outcome = r.outcome
      c.latest = r.id
      if (r.cost !== null && r.currency !== null) {
        const sums = costs.get(r.thread_id) ?? new Map<string, number>()
        sums.set(r.currency, (sums.get(r.currency) ?? 0) + r.cost)
        costs.set(r.thread_id, sums)
      }
      out.set(r.thread_id, c)
    }
    for (const [thread, c] of out) {
      if (c.steps < 2) out.delete(thread)
      else
        c.cost = [...(costs.get(thread) ?? new Map<string, number>())].map(([currency, amount]) => ({
          amount: round(amount),
          currency: currency as AiCurrency,
        }))
    }
    return out
  }

  /**
   * A page's items, each chain's first step carrying the chain's sums — summed as of the time its
   * order is (page review M2), so a chain and its place agree. Each item comes with its owner.
   */
  private withChains(
    rows: Array<[ChatOwner, AiHistoryItem]>,
    asOf = this.now(),
    reading: Array<string | number> = [],
  ): AiHistoryItem[] {
    const pairs = new Map<string, [ChatOwner, string]>()
    for (const [owner, i] of rows) if (i.thread) pairs.set(chainKey(owner, i.thread), [owner, i.thread])
    const sums = this.chains([...pairs.values()], asOf, reading)
    return rows.map(([owner, i]) => ({
      ...i,
      chain: i.thread ? (sums.get(chainKey(owner, i.thread)) ?? null) : null,
    }))
  }

  /** A chain's steps, in order, with what was asked and answered; [] when it is not the owner's. */
  thread(owner: ChatOwner, thread: string): AiHistoryItem[] {
    const rows = this.db
      .prepare(
        `SELECT ${WITH_SHARE} FROM ai_requests r WHERE r.user_id IS ? AND r.thread_id = ? ORDER BY r.step, r.rowid`,
      )
      .all(owner, thread) as unknown as Row[]
    return rows.map((row) => {
      const content = this.open(row)
      return { ...this.toItem(row, content ? previewOf(content.prompt) : null), content }
    })
  }

  /**
   * A request the viewer may read: their own, or a teammate's in an entry its owner shares (and still
   * may sign in), on a connection the viewer may read (`mayRead`; none: their own only).
   */
  private readable(viewer: ChatOwner, id: string, mayRead?: MayRead): Row | undefined {
    const own = this.db
      .prepare(`SELECT ${WITH_SHARE} FROM ai_requests r WHERE r.id = ? AND r.user_id IS ?`)
      .get(id, viewer) as Row | undefined
    if (own || !mayRead || viewer === null) return own
    const row = this.db
      .prepare(
        `SELECT ${WITH_SHARE} FROM ai_requests r
         WHERE r.id = ? AND r.user_id IS NOT ? AND ${SHARED} AND ${OWNER_ACTIVE}`,
      )
      .get(id, viewer) as Row | undefined
    const place = row ? placeOf(row) : null
    return row && place && mayRead(place) ? row : undefined
  }

  /**
   * The rows of the chain a readable row is in that its viewer may read: all of an owner's; of a
   * teammate's, a chat's turn alone, of another chain the steps they may read, each by its own place.
   */
  private stepsReadable(row: Row, viewer: ChatOwner, mayRead?: MayRead): Row[] {
    const mine = row.user_id === viewer
    const rows =
      row.thread_id && (mine || row.action !== 'chat')
        ? (this.db
            .prepare(
              `SELECT ${WITH_SHARE} FROM ai_requests r WHERE r.user_id IS ? AND r.thread_id = ? ORDER BY r.step, r.rowid`,
            )
            .all(row.user_id, row.thread_id) as unknown as Row[])
        : [row]
    if (mine) return rows
    return rows.filter((step) => {
      const place = placeOf(step)
      // Third review (nit 4): a chat's turn under the same id is never a step of another chain.
      return (step.id === row.id || step.action !== 'chat') && !!place && !!mayRead && mayRead(place)
    })
  }

  /** The steps of the entry a request is in (its chain, or itself), for whoever may read it. */
  chainOf(viewer: ChatOwner, id: string, mayRead?: MayRead): AiHistoryItem[] {
    const row = this.readable(viewer, id, mayRead)
    if (!row) return []
    return this.stepsReadable(row, viewer, mayRead).map((step) => {
      const content = this.open(step)
      return { ...this.toItem(step, content ? previewOf(content.prompt) : null, viewer), content }
    })
  }

  /**
   * Shares (or takes back) the owner's entry a request is in; undefined when it is not theirs,
   * 'unknown' when what its answer drew on is not known (an older chat turn: never shared).
   */
  share(owner: ChatOwner, id: string, on: boolean): { shared: boolean } | 'unknown' | undefined {
    if (owner === null) return undefined
    const row = this.db
      .prepare('SELECT id, action, thread_id, sources FROM ai_requests WHERE id = ? AND user_id = ?')
      .get(id, owner) as
      { id: string; action: string; thread_id: string | null; sources: string | null } | undefined
    if (!row) return undefined
    if (on && row.sources === null) return 'unknown'
    // Review of the chat entry (I2): a chat's turn is shared alone, never the chat (nor its later turns).
    const entry = row.action === 'chat' ? row.id : (row.thread_id ?? row.id)
    if (on)
      this.db
        .prepare('INSERT OR IGNORE INTO ai_request_shares (user_id, entry, at) VALUES (?, ?, ?)')
        .run(owner, entry, this.now())
    else this.db.prepare('DELETE FROM ai_request_shares WHERE user_id = ? AND entry = ?').run(owner, entry)
    return { shared: on }
  }

  /** Shares whose entry has no request left (removed, or past the days kept) go too. */
  private dropOrphanShares(): void {
    this.db
      .prepare(
        `DELETE FROM ai_request_shares
         WHERE NOT EXISTS (SELECT 1 FROM ai_requests r WHERE r.user_id = ai_request_shares.user_id
             AND r.id = ai_request_shares.entry AND (r.action = 'chat' OR r.thread_id IS NULL))
           AND NOT EXISTS (SELECT 1 FROM ai_requests r WHERE r.user_id = ai_request_shares.user_id
             AND r.thread_id = ai_request_shares.entry AND r.action <> 'chat')`,
      )
      .run()
  }

  removeThread(owner: ChatOwner, thread: string): number {
    const removed = Number(
      this.db.prepare('DELETE FROM ai_requests WHERE user_id IS ? AND thread_id = ?').run(owner, thread)
        .changes,
    )
    this.dropOrphanShares()
    return removed
  }

  /**
   * A page of the owner's entries — or, with `shared`, of the entries teammates share that the owner
   * may read (their connections; chats without one only when `noConnection`).
   */
  list(owner: ChatOwner, q: AiHistoryQuery, shared?: SharedAccess): AiHistoryPage {
    const [cursorLast, cursorSeq, cursorAsOf] = (q.before ?? '').split(':').map(Number)
    const asOf = q.before && cursorAsOf ? cursorAsOf : this.now()
    const where: string[] = ['e.last IS NOT NULL']
    // Nothing the asker may read: no page to look for (share review, optional).
    if (shared && !shared.readable.length && !shared.noConnection) return { items: [], next: null }
    const marks = (list: string[]) => list.map(() => '?').join(', ')
    const whose = shared
      ? // Read from the shares (share review M5): only shared entries are looked at, each by its place.
        `r.rowid IN (SELECT x.rowid FROM ai_request_shares s JOIN ai_requests x
                       ON x.user_id = s.user_id AND x.id = s.entry
                       AND (x.action = 'chat' OR x.thread_id IS NULL) WHERE s.user_id IS NOT ?
                     UNION
                     SELECT x.rowid FROM ai_request_shares s JOIN ai_requests x
                       ON x.user_id = s.user_id AND x.thread_id = s.entry AND x.action <> 'chat'
                     WHERE s.user_id IS NOT ?)
         AND ${OWNER_ACTIVE} AND r.sources IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM json_each(r.sources) j WHERE j.value NOT IN (${marks(shared.readable)}))
         AND (r.credential = 0
              OR NOT EXISTS (SELECT 1 FROM json_each(r.sources) j WHERE j.value NOT IN (${marks(shared.admin)})))
         AND (json_array_length(r.sources) > 0 OR ? = 1)`
      : 'r.user_id IS ?'
    const reading = shared ? readableParams(shared) : []
    const args: Array<string | number | null> = shared
      ? [
          asOf,
          asOf,
          ...reading,
          owner,
          owner,
          ...shared.readable,
          ...shared.admin,
          shared.noConnection ? 1 : 0,
        ]
      : // The owner's: as of the page's time for a chat's shares too (ANY_TURN_SHARED's placeholder).
        [asOf, asOf, asOf, owner]
    const add = (clause: string, ...values: Array<string | number>) => {
      where.push(clause)
      args.push(...values)
    }
    /** A condition met by any step a teammate may read (its own parameters after the place's). */
    const step = (condition: string, ...values: Array<string | number>) =>
      add(anyStep(condition, !!shared), ...reading, ...values)
    // A chain is listed when any of its steps is what is asked for.
    if (q.action) step('x.action = ?', q.action)
    // "Needs a pipeline" is an answer (the audit counts it a success), not a failure.
    if (q.outcome === 'ok') step("x.outcome IN ('ok', 'needs_pipeline')")
    if (q.outcome === 'failed') step("x.outcome NOT IN ('ok', 'needs_pipeline')")
    if (q.providerId) step('x.provider_id = ?', q.providerId)
    if (q.connectionId) step('x.connection_id = ?', q.connectionId)
    if (q.before) {
      // The cursor is the last entry's latest activity and insertion order (and the time it is as of).
      add('(e.last < ? OR (e.last = ? AND e.seq < ?))', cursorLast!, cursorLast!, cursorSeq!)
    }
    const cursor = (e: Entry) => `${e.last}:${e.seq}:${asOf}`
    const words = q.q?.toLocaleLowerCase()
    const sql = `SELECT * FROM (${entries(!!words, whose, !!shared)}) e WHERE ${where.join(' AND ')}
      ORDER BY e.last DESC, e.seq DESC LIMIT ?`
    if (!words) {
      const rows = this.db.prepare(sql).all(...args, q.limit + 1) as unknown as Entry[]
      const page = rows.slice(0, q.limit)
      const last = page.at(-1)
      return {
        items: this.withChains(
          page.map((row) => [row.user_id, this.toItem(row, this.openPreview(row), owner)]),
          asOf,
          reading,
        ),
        next: rows.length > q.limit && last ? cursor(last) : null,
      }
    }
    // AI history review I3, M6, chains review M4: a search opens rows one at a time and stops once the
    // page is full or its budget of rows is spent (a chain's steps count too); the next page goes on
    // after the last entry it finished, and is offered only when there is one. The first entry of a
    // page is always finished, so a chain longer than the budget is still searched, once.
    // Page review I2: each entry spends at least one of the budget, so no more than one row past it is
    // ever read — and the database sorts no more than that (never the owner's whole history).
    const rows = this.db.prepare(sql).iterate(...args, this.searchScan + 1) as Iterable<Entry>
    // Re-review (M5): a teammate's search opens only the steps they may read.
    const stepsOf = this.db.prepare(
      `SELECT * FROM ai_requests WHERE user_id IS ? AND thread_id = ? AND id <> ?
       ${shared ? `AND ${readableBy('ai_requests')}` : ''} ORDER BY step, rowid`,
    )
    const items: Array<[ChatOwner, AiHistoryItem]> = []
    let budget = this.searchScan
    let done: Entry | null = null
    let more = false
    // Review of the history's steps (N1): an agent turn's found by where its steps worked too.
    const matches = (c: AiHistoryContent | null) =>
      !!c &&
      [
        c.prompt,
        c.answer,
        ...(c.steps ?? []).map((s) => `${s.tool.replaceAll('_', ' ')} ${s.namespace ?? ''}`),
      ]
        .join('\n')
        .toLocaleLowerCase()
        .includes(words)
    entries: for (const row of rows) {
      if (budget <= 0) {
        more = true
        break
      }
      const content = this.open(row)
      budget -= 1
      let found = matches(content)
      // Review of the chat entry (I1): a teammate searches the turn shared, never the chat's others.
      if (row.thread_id !== null && !found && !(shared && row.action === 'chat')) {
        for (const other of stepsOf.iterate(
          row.user_id,
          row.thread_id,
          row.id,
          ...reading,
        ) as Iterable<Row>) {
          if (budget <= 0 && done !== null) {
            // Not this page's first entry: left whole for the next page.
            more = true
            break entries
          }
          budget -= 1
          if ((found = matches(this.open(other)))) break
        }
      }
      if (found) {
        if (items.length === q.limit) {
          more = true
          break
        }
        items.push([
          row.user_id,
          this.toItem(row, content ? previewOf(content.prompt) : this.openPreview(row), owner),
        ])
      }
      done = row
    }
    const next = more && done ? cursor(done) : null
    return { items: this.withChains(items, asOf, reading), next }
  }

  /** A request with its words: the owner's, or a teammate's shared one the viewer may read (`mayRead`). */
  get(owner: ChatOwner, id: string, mayRead?: MayRead): AiHistoryItem | undefined {
    const row = this.readable(owner, id, mayRead)
    if (!row) return undefined
    const content = this.open(row)
    // Read alone (a link to it), a step of a chain says its chain's sums too — a teammate's from the
    // steps they may read (re-review of the chat entry, M5).
    const item = this.toItem(row, content ? previewOf(content.prompt) : null, owner)
    if (row.user_id !== owner) {
      // Third review (minor 2): from the numbers only — no step's words opened to sum them.
      const steps = item.thread ? this.stepsReadable(row, owner, mayRead) : []
      return { ...item, chain: sumsOf(steps.map((s) => this.toItem(s, null, owner))), content }
    }
    const [summed] = this.withChains([[row.user_id, item]])
    return { ...summed!, content }
  }

  remove(owner: ChatOwner, id: string): boolean {
    const removed =
      this.db.prepare('DELETE FROM ai_requests WHERE id = ? AND user_id IS ?').run(id, owner).changes > 0
    if (removed) this.dropOrphanShares()
    return removed
  }

  removeAll(owner: ChatOwner): number {
    const removed = Number(this.db.prepare('DELETE FROM ai_requests WHERE user_id IS ?').run(owner).changes)
    if (owner !== null) this.db.prepare('DELETE FROM ai_request_shares WHERE user_id = ?').run(owner)
    return removed
  }

  /**
   * User review 2026-10-09 ("fiyat girdim ama hala fiyat gir yazıyor"): a price entered after the
   * provider was used prices its requests that had none; a cost already counted never changes.
   */
  priceUnpriced(provider: { id: string; kind: AiKind; model: string }, price: AiPrice): number {
    // Only what was asked of the model and kind the price is for (AI chains review I1): requests a
    // provider answered with another model (or as another kind) before it was changed stay unpriced.
    return Number(
      this.db
        .prepare(
          `UPDATE ai_requests SET cost = ROUND((input * ? + output * ?) / 1000000.0, 6), currency = ?
           WHERE provider_id = ? AND provider_kind = ? AND model = ? AND cost IS NULL`,
        )
        .run(price.input, price.output, price.currency, provider.id, provider.kind, provider.model).changes,
    )
  }

  /** Removes what is past the days kept, and the words of chats gone; how many requests went. */
  sweep(): number {
    const { days } = this.settings()
    const removed = Number(
      this.db.prepare('DELETE FROM ai_requests WHERE at < ?').run(this.now() - days * DAY).changes,
    )
    this.forgetChats()
    if (removed) this.dropOrphanShares()
    return removed
  }

  /**
   * The last days' usage: the owner's, or every user's (owner 'all'), by model and by user; with a
   * time zone (minutes east of UTC), by day in it too.
   */
  usage(owner: ChatOwner | 'all', days: number, tz?: number): AiUsage {
    const since = this.now() - days * DAY
    const scope = owner === 'all' ? 'at >= ?' : 'at >= ? AND user_id IS ?'
    const args = owner === 'all' ? [since] : [since, owner]
    // `key` and `select` are this method's own SQL; values (the offset too) are always bound.
    const group = (key: string, select: string, bound: number[] = []) =>
      this.db
        .prepare(
          `SELECT ${select}, currency, COUNT(*) AS requests, SUM(input) AS input, SUM(output) AS output,
             SUM(cost) AS cost
           FROM ai_requests WHERE ${scope} GROUP BY ${key}, currency`,
        )
        .all(...bound, ...args) as unknown as Array<
        Record<string, unknown> & {
          currency: string | null
          requests: number
          input: number
          output: number
          cost: number | null
        }
      >
    const merge = <K extends string>(
      rows: ReturnType<typeof group>,
      keyOf: (r: Record<string, unknown>) => K,
    ) => {
      const out = new Map<K, AiUsageCount & { row: Record<string, unknown> }>()
      for (const r of rows) {
        const k = keyOf(r)
        const sum = out.get(k) ?? { requests: 0, input: 0, output: 0, cost: [], row: r }
        sum.requests += Number(r.requests)
        sum.input += Number(r.input ?? 0)
        sum.output += Number(r.output ?? 0)
        if (r.currency !== null && r.cost !== null)
          sum.cost.push({ amount: round(Number(r.cost)), currency: r.currency as AiCurrency })
        out.set(k, sum)
      }
      return out
    }
    const strip = ({ row: _row, ...count }: AiUsageCount & { row: unknown }) => count
    const totals = merge(group("'all'", "'all' AS k"), () => 'all').get('all')
    // A provider is counted once, under its current name (renamed or not); a removed one under its last.
    const current = new Map(
      (
        this.db.prepare('SELECT id, name FROM ai_providers').all() as unknown as Array<{
          id: string
          name: string
        }>
      ).map((p) => [p.id, p.name]),
    )
    const byModel = [
      ...merge(
        group(
          'COALESCE(provider_id, provider_name), provider_kind, model',
          'provider_id, provider_name, provider_kind, model, MAX(at) AS latest',
        ),
        (r) => JSON.stringify([r.provider_id ?? r.provider_name, r.provider_kind, r.model]),
      ).values(),
    ].map((s) => ({
      ...strip(s),
      provider:
        (s.row.provider_id ? current.get(String(s.row.provider_id)) : undefined) ??
        String(s.row.provider_name),
      kind: s.row.provider_kind as AiKind,
      model: String(s.row.model),
    }))
    const usage: AiUsage = {
      since,
      totals: totals ? strip(totals) : { requests: 0, input: 0, output: 0, cost: [] },
      byModel: byModel.sort((a, b) => b.requests - a.requests),
    }
    if (tz !== undefined) {
      if (!Number.isInteger(tz) || Math.abs(tz) > 840) throw new RangeError('tz')
      usage.byDay = [
        ...merge(group('day', "date((at + ?) / 1000, 'unixepoch') AS day", [tz * 60_000]), (r) =>
          String(r.day),
        ).values(),
      ]
        .map((s) => ({ ...strip(s), day: String(s.row.day) }))
        .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    }
    if (owner === 'all') {
      const names = new Map(
        (
          this.db.prepare('SELECT id, username FROM users').all() as unknown as Array<{
            id: string
            username: string
          }>
        ).map((u) => [u.id, u.username]),
      )
      usage.byUser = [...merge(group('user_id', 'user_id'), (r) => String(r.user_id ?? '')).values()]
        .map((s) => {
          const userId = (s.row.user_id as string | null) ?? null
          return { ...strip(s), userId, username: userId ? (names.get(userId) ?? null) : null }
        })
        .sort((a, b) => b.requests - a.requests)
    }
    return usage
  }
}

/** A provider's price, kept beside it (removed with it). */
export class AiPriceRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {}

  get(providerId: string): AiPrice | null {
    const r = this.db
      .prepare('SELECT input, output, currency FROM ai_prices WHERE provider_id = ?')
      .get(providerId) as { input: number; output: number; currency: string } | undefined
    return r ? { input: r.input, output: r.output, currency: r.currency as AiCurrency } : null
  }

  set(providerId: string, price: AiPrice | null): void {
    if (price === null) {
      this.db.prepare('DELETE FROM ai_prices WHERE provider_id = ?').run(providerId)
      return
    }
    this.db
      .prepare(
        `INSERT INTO ai_prices (provider_id, input, output, currency, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider_id) DO UPDATE SET input = excluded.input, output = excluded.output,
           currency = excluded.currency, updated_at = excluded.updated_at`,
      )
      .run(providerId, price.input, price.output, price.currency, this.now())
  }
}
