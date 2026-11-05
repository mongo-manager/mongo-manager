// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { AI_CHAT_LIMITS, type AiChatSummary, type AiChatTurnRecord } from '@mongo-manager/shared'
import type { SecretBox } from '../crypto/secret-box'
import { Errors } from '../errors'
import { transaction } from '../store/db'

const DAY = 86_400_000

/** A chat's owner: the user's id, or null in local mode (plan ruling 1). */
export type ChatOwner = string | null

export const chatTitleContext = (chat: string, owner: ChatOwner) =>
  `ai-chat-title:${JSON.stringify([chat, owner])}`
export const chatMessageContext = (message: string, chat: string, owner: ChatOwner) =>
  `ai-chat-message:${JSON.stringify([message, chat, owner])}`

export interface StoredMessage {
  id: string
  /** null: it does not open with this server's key. */
  text: string | null
  createdAt: number
}
export interface StoredTurn {
  user: StoredMessage
  answer: StoredMessage
  record: AiChatTurnRecord
}
export interface StoredChat {
  id: string
  title: string | null
  turns: StoredTurn[]
  updatedAt: number
}
export interface NewTurn {
  user: string
  answer: string
  record: AiChatTurnRecord
  /** The messages' ids, when the caller named them first (the stream says the user's). */
  ids?: { user: string; answer: string }
}

/** Phase 4a-2 spec §2.4: one contract, two backends. Every call is scoped by owner. */
export interface ChatStore {
  readonly persistent: boolean
  list(owner: ChatOwner): AiChatSummary[]
  get(owner: ChatOwner, id: string): StoredChat | undefined
  /** A new chat; beyond 50 the least recently used go first (how many went is returned). */
  create(owner: ChatOwner, title: string): { id: string; removed: number }
  /** A whole turn; beyond 16 MiB the owner's other chats go, least recently used first. */
  append(owner: ChatOwner, id: string, turn: NewTurn): void
  /** Plan ruling 3: removes the last turn when it did not end done. */
  dropFailedLast(owner: ChatOwner, id: string): boolean
  rename(owner: ChatOwner, id: string, title: string): boolean
  remove(owner: ChatOwner, id: string): boolean
  removeAll(owner: ChatOwner): number
  /** Removes what is past the retention; how many chats went. */
  sweep(): number
}

/** Spec §1.1: the first line of the first message, at most 60 characters. */
export function titleOf(message: string): string {
  const line =
    message
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  const chars = [...line.replace(/\s+/g, ' ')]
  return chars.length > AI_CHAT_LIMITS.title
    ? `${chars.slice(0, AI_CHAT_LIMITS.title - 1).join('')}…`
    : chars.join('')
}

/** Spec §2.4: an answer within 64 KiB, cut on a character boundary. */
export function cutAnswer(text: string): { text: string; cut: boolean } {
  const bytes = Buffer.from(text)
  if (bytes.length <= AI_CHAT_LIMITS.answerBytes) return { text, cut: false }
  return {
    text: bytes.subarray(0, AI_CHAT_LIMITS.answerBytes).toString('utf8').replace(/�+$/, ''),
    cut: true,
  }
}

const full = () => Errors.conflict('This chat is full; start a new one', { reason: 'chat_full' })
const missing = () => Errors.notFound('Chat not found')

interface ChatRow {
  id: string
  title: string
  updated_at: number
}
interface MessageRow {
  id: string
  seq: number
  body: string
  meta: string | null
  created_at: number
}

class SqliteChatStore implements ChatStore {
  readonly persistent = true

  constructor(
    private readonly db: DatabaseSync,
    private readonly box: SecretBox,
    private readonly now: () => number,
    private readonly days: number,
    /** Final review minor 9: chats answering now are never removed to make room. */
    private readonly running: ReadonlySet<string>,
  ) {}

  private open(sealed: string, context: string): string | null {
    try {
      return this.box.open(sealed, context)
    } catch {
      return null
    }
  }

  private row(owner: ChatOwner, id: string): ChatRow | undefined {
    return this.db
      .prepare('SELECT id, title, updated_at FROM ai_chats WHERE id = ? AND user_id IS ?')
      .get(id, owner) as ChatRow | undefined
  }

  /** The owner's least recently used chat other than `keep`, removed. */
  private removeLeastRecent(owner: ChatOwner, keep: string | null): boolean {
    const r = this.db
      .prepare(
        `SELECT id FROM ai_chats WHERE user_id IS ? AND id IS NOT ?
           AND id NOT IN (SELECT value FROM json_each(?)) ORDER BY updated_at, created_at LIMIT 1`,
      )
      .get(owner, keep, JSON.stringify([...this.running])) as { id: string } | undefined
    if (!r) return false
    this.db.prepare('DELETE FROM ai_chats WHERE id = ?').run(r.id)
    return true
  }

  list(owner: ChatOwner): AiChatSummary[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.title, c.updated_at,
           (SELECT COUNT(*) FROM ai_chat_messages m WHERE m.chat_id = c.id) AS messages,
           (SELECT m.meta FROM ai_chat_messages m WHERE m.chat_id = c.id AND m.role = 'user'
              ORDER BY m.seq DESC LIMIT 1) AS last
         FROM ai_chats c WHERE c.user_id IS ? ORDER BY c.updated_at DESC, c.created_at DESC`,
      )
      .all(owner) as unknown as Array<ChatRow & { messages: number; last: string | null }>
    return rows.map((r) => ({
      id: r.id,
      title: this.open(r.title, chatTitleContext(r.id, owner)),
      namespace: r.last ? ((JSON.parse(r.last) as AiChatTurnRecord).namespace ?? null) : null,
      messages: r.messages,
      updatedAt: r.updated_at,
    }))
  }

  get(owner: ChatOwner, id: string): StoredChat | undefined {
    const chat = this.row(owner, id)
    if (!chat) return undefined
    const rows = this.db
      .prepare('SELECT id, seq, body, meta, created_at FROM ai_chat_messages WHERE chat_id = ? ORDER BY seq')
      .all(id) as unknown as MessageRow[]
    const turns: StoredTurn[] = []
    // A turn's two rows are written together (append), so they come in pairs.
    for (let i = 0; i + 1 < rows.length; i += 2) {
      const u = rows[i]!
      const a = rows[i + 1]!
      turns.push({
        user: {
          id: u.id,
          text: this.open(u.body, chatMessageContext(u.id, id, owner)),
          createdAt: u.created_at,
        },
        answer: {
          id: a.id,
          text: this.open(a.body, chatMessageContext(a.id, id, owner)),
          createdAt: a.created_at,
        },
        record: JSON.parse(u.meta ?? '{}') as AiChatTurnRecord,
      })
    }
    return {
      id,
      title: this.open(chat.title, chatTitleContext(id, owner)),
      turns,
      updatedAt: chat.updated_at,
    }
  }

  create(owner: ChatOwner, title: string): { id: string; removed: number } {
    const id = randomUUID()
    const t = this.now()
    return transaction(this.db, () => {
      let removed = 0
      const count = () =>
        (this.db.prepare('SELECT COUNT(*) AS n FROM ai_chats WHERE user_id IS ?').get(owner) as { n: number })
          .n
      while (count() >= AI_CHAT_LIMITS.chatsPerUser && this.removeLeastRecent(owner, null)) removed++
      const sealed = this.box.seal(title, chatTitleContext(id, owner))
      this.db
        .prepare(
          'INSERT INTO ai_chats (id, user_id, title, bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(id, owner, sealed, sealed.length, t, t)
      return { id, removed }
    })
  }

  append(owner: ChatOwner, id: string, turn: NewTurn): void {
    transaction(this.db, () => {
      if (!this.row(owner, id)) throw missing()
      const { n, seq } = this.db
        .prepare('SELECT COUNT(*) AS n, COALESCE(MAX(seq), 0) AS seq FROM ai_chat_messages WHERE chat_id = ?')
        .get(id) as { n: number; seq: number }
      if (n + 2 > AI_CHAT_LIMITS.messagesPerChat) throw full()
      const t = this.now()
      const insert = this.db.prepare(
        'INSERT INTO ai_chat_messages (id, chat_id, seq, role, body, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      let added = 0
      const rows = [
        { role: 'user', text: turn.user, meta: JSON.stringify(turn.record) },
        { role: 'assistant', text: turn.answer, meta: null },
      ] as const
      rows.forEach((r, i) => {
        const mid = (i === 0 ? turn.ids?.user : turn.ids?.answer) ?? randomUUID()
        const body = this.box.seal(r.text, chatMessageContext(mid, id, owner))
        added += body.length + (r.meta?.length ?? 0)
        insert.run(mid, id, seq + i + 1, r.role, body, r.meta, t)
      })
      this.db.prepare('UPDATE ai_chats SET bytes = bytes + ?, updated_at = ? WHERE id = ?').run(added, t, id)
      const total = () =>
        (
          this.db
            .prepare('SELECT COALESCE(SUM(bytes), 0) AS b FROM ai_chats WHERE user_id IS ?')
            .get(owner) as {
            b: number
          }
        ).b
      while (total() > AI_CHAT_LIMITS.bytesPerUser && this.removeLeastRecent(owner, id)) {
        // the least recently used chats go first
      }
    })
  }

  dropFailedLast(owner: ChatOwner, id: string): boolean {
    return transaction(this.db, () => {
      if (!this.row(owner, id)) return false
      const last = this.db
        .prepare(
          "SELECT seq, meta FROM ai_chat_messages WHERE chat_id = ? AND role = 'user' ORDER BY seq DESC LIMIT 1",
        )
        .get(id) as { seq: number; meta: string } | undefined
      if (!last || (JSON.parse(last.meta) as AiChatTurnRecord).state === 'done') return false
      const { b } = this.db
        .prepare(
          'SELECT COALESCE(SUM(LENGTH(body) + COALESCE(LENGTH(meta), 0)), 0) AS b FROM ai_chat_messages WHERE chat_id = ? AND seq >= ?',
        )
        .get(id, last.seq) as { b: number }
      this.db.prepare('DELETE FROM ai_chat_messages WHERE chat_id = ? AND seq >= ?').run(id, last.seq)
      this.db.prepare('UPDATE ai_chats SET bytes = MAX(0, bytes - ?) WHERE id = ?').run(b, id)
      return true
    })
  }

  rename(owner: ChatOwner, id: string, title: string): boolean {
    const sealed = this.box.seal(title, chatTitleContext(id, owner))
    return (
      this.db
        .prepare(
          'UPDATE ai_chats SET bytes = MAX(0, bytes - LENGTH(title)) + ?, title = ? WHERE id = ? AND user_id IS ?',
        )
        .run(sealed.length, sealed, id, owner).changes > 0
    )
  }

  remove(owner: ChatOwner, id: string): boolean {
    return this.db.prepare('DELETE FROM ai_chats WHERE id = ? AND user_id IS ?').run(id, owner).changes > 0
  }

  removeAll(owner: ChatOwner): number {
    return Number(this.db.prepare('DELETE FROM ai_chats WHERE user_id IS ?').run(owner).changes)
  }

  sweep(): number {
    return Number(
      this.db.prepare('DELETE FROM ai_chats WHERE updated_at < ?').run(this.now() - this.days * DAY).changes,
    )
  }
}

interface MemoryChat {
  id: string
  title: string
  turns: StoredTurn[]
  bytes: number
  createdAt: number
  updatedAt: number
}

/** Spec §2.4: `MM_AI_CHAT_DAYS=0` — nothing written; a chat goes 12 hours after its last turn. */
class MemoryChatStore implements ChatStore {
  readonly persistent = false
  private readonly owners = new Map<string, Map<string, MemoryChat>>()

  constructor(
    private readonly now: () => number,
    private readonly running: ReadonlySet<string>,
  ) {}

  private mine(owner: ChatOwner, create = false): Map<string, MemoryChat> | undefined {
    // Local mode's chats are kept under a key no user id can take.
    const key = owner ?? '\u0000local'
    let m = this.owners.get(key)
    if (!m && create) this.owners.set(key, (m = new Map()))
    return m
  }

  private leastRecent(m: Map<string, MemoryChat>, keep: string | null): string | undefined {
    let pick: MemoryChat | undefined
    for (const c of m.values())
      if (
        c.id !== keep &&
        !this.running.has(c.id) &&
        (!pick ||
          c.updatedAt < pick.updatedAt ||
          (c.updatedAt === pick.updatedAt && c.createdAt < pick.createdAt))
      )
        pick = c
    return pick?.id
  }

  list(owner: ChatOwner): AiChatSummary[] {
    return [...(this.mine(owner)?.values() ?? [])]
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
      .map((c) => ({
        id: c.id,
        title: c.title,
        namespace: c.turns.at(-1)?.record.namespace ?? null,
        messages: c.turns.length * 2,
        updatedAt: c.updatedAt,
      }))
  }

  get(owner: ChatOwner, id: string): StoredChat | undefined {
    const c = this.mine(owner)?.get(id)
    return c && { id: c.id, title: c.title, turns: [...c.turns], updatedAt: c.updatedAt }
  }

  create(owner: ChatOwner, title: string): { id: string; removed: number } {
    const m = this.mine(owner, true)!
    let removed = 0
    while (m.size >= AI_CHAT_LIMITS.chatsPerUser) {
      const old = this.leastRecent(m, null)
      if (!old) break
      m.delete(old)
      removed++
    }
    const t = this.now()
    const id = randomUUID()
    m.set(id, { id, title, turns: [], bytes: Buffer.byteLength(title), createdAt: t, updatedAt: t })
    return { id, removed }
  }

  append(owner: ChatOwner, id: string, turn: NewTurn): void {
    const m = this.mine(owner)
    const c = m?.get(id)
    if (!m || !c) throw missing()
    if ((c.turns.length + 1) * 2 > AI_CHAT_LIMITS.messagesPerChat) throw full()
    const t = this.now()
    c.turns.push({
      user: { id: turn.ids?.user ?? randomUUID(), text: turn.user, createdAt: t },
      answer: { id: turn.ids?.answer ?? randomUUID(), text: turn.answer, createdAt: t },
      record: turn.record,
    })
    c.bytes += Buffer.byteLength(turn.user) + Buffer.byteLength(turn.answer)
    c.updatedAt = t
    const total = () => [...m.values()].reduce((s, x) => s + x.bytes, 0)
    while (total() > AI_CHAT_LIMITS.bytesPerUser) {
      const old = this.leastRecent(m, id)
      if (!old) break
      m.delete(old)
    }
  }

  dropFailedLast(owner: ChatOwner, id: string): boolean {
    const c = this.mine(owner)?.get(id)
    const last = c?.turns.at(-1)
    if (!c || !last || last.record.state === 'done') return false
    c.turns.pop()
    c.bytes -= Buffer.byteLength(last.user.text ?? '') + Buffer.byteLength(last.answer.text ?? '')
    return true
  }

  rename(owner: ChatOwner, id: string, title: string): boolean {
    const c = this.mine(owner)?.get(id)
    if (!c) return false
    c.title = title
    return true
  }

  remove(owner: ChatOwner, id: string): boolean {
    return this.mine(owner)?.delete(id) ?? false
  }

  removeAll(owner: ChatOwner): number {
    const m = this.mine(owner)
    const n = m?.size ?? 0
    m?.clear()
    return n
  }

  sweep(): number {
    const before = this.now() - AI_CHAT_LIMITS.memoryIdleMs
    let n = 0
    for (const m of this.owners.values())
      for (const c of [...m.values()])
        if (c.updatedAt < before) {
          m.delete(c.id)
          n++
        }
    return n
  }
}

/** Spec §2.4: SQLite and sealed; with 0 days, memory only — and what an earlier setting stored goes. */
export function createChatStore(
  db: DatabaseSync,
  box: SecretBox,
  now: () => number,
  days: number,
  running: ReadonlySet<string> = new Set(),
): ChatStore {
  if (days === 0) {
    db.exec('DELETE FROM ai_chats')
    return new MemoryChatStore(now, running)
  }
  return new SqliteChatStore(db, box, now, days, running)
}
