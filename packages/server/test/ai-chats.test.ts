// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { AI_CHAT_LIMITS, type AiChatTurnRecord } from '@mongo-manager/shared'
import { makeApp, type TestApp } from './helpers'
import { openStore } from '../src/store/db'
import { MIGRATIONS } from '../src/store/migrations'
import { createSecretBox, loadOrCreateKey } from '../src/crypto/secret-box'
import { rotateSecretKey } from '../src/crypto/rotate'
import { chatMessageContext, createChatStore, cutAnswer, titleOf, type ChatStore } from '../src/ai/chats'

const apps: TestApp[] = []
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close()
})

const record = (over: Partial<AiChatTurnRecord> = {}): AiChatTurnRecord => ({
  connectionId: 'c1',
  namespace: 'shop.orders',
  rulesVersion: 0,
  sources: [{ connectionId: 'c1', rulesVersion: 0 }],
  parts: { schema: true, current: false, indexes: true, validator: false, samples: 0 },
  provider: { id: 'p1', name: 'P', model: 'm', kind: 'openai' },
  local: true,
  usage: { input: 1, output: 1 },
  state: 'done',
  ...over,
})
const turn = (n: number, over: Partial<AiChatTurnRecord> = {}) => ({
  user: `question ${n}`,
  answer: `answer ${n}`,
  record: record(over),
})

/** Both backends against one contract (spec §6); `clock` moves time forward. */
async function backends() {
  const t = await makeApp({ auth: true })
  apps.push(t)
  const db = t.app.ctx.store.db
  const box = createSecretBox(randomBytes(32))
  const clock = { now: 1_000_000 }
  const owner = t.app.ctx.users.create({
    username: `o${Math.random()}`,
    passwordHash: 'x',
    role: 'editor',
  }).id
  const other = t.app.ctx.users.create({
    username: `p${Math.random()}`,
    passwordHash: 'x',
    role: 'editor',
  }).id
  return {
    t,
    db,
    owner,
    other,
    clock,
    sqlite: createChatStore(db, box, () => clock.now, 30),
    memory: createChatStore(db, box, () => clock.now, 0),
  }
}

for (const kind of ['sqlite', 'memory'] as const) {
  describe(`the ${kind} chat store (phase 4a-2 spec §2.4)`, () => {
    const setup = async () => {
      const b = await backends()
      return { ...b, store: b[kind] as ChatStore }
    }

    it('keeps turns in order for their owner only', async () => {
      const { store, owner, other } = await setup()
      const { id } = store.create(owner, 'Orders')
      store.append(owner, id, turn(1))
      store.append(owner, id, turn(2, { state: 'stopped' }))
      const chat = store.get(owner, id)!
      expect(chat.title).toBe('Orders')
      expect(chat.turns.map((x) => [x.user.text, x.answer.text, x.record.state])).toEqual([
        ['question 1', 'answer 1', 'done'],
        ['question 2', 'answer 2', 'stopped'],
      ])
      expect(store.get(other, id)).toBeUndefined()
      expect(store.list(other)).toEqual([])
      expect(() => store.append(other, id, turn(3))).toThrow(/not found/i)
      expect(store.rename(other, id, 'x')).toBe(false)
      expect(store.remove(other, id)).toBe(false)
      expect(store.list(owner)).toEqual([
        { id, title: 'Orders', namespace: 'shop.orders', messages: 4, updatedAt: expect.any(Number) },
      ])
    })

    it('lists the most recently used first and renames', async () => {
      const { store, owner, clock } = await setup()
      const a = store.create(owner, 'A').id
      clock.now += 10
      const b = store.create(owner, 'B').id
      clock.now += 10
      store.append(owner, a, turn(1))
      expect(store.list(owner).map((c) => c.id)).toEqual([a, b])
      expect(store.rename(owner, b, 'Bee')).toBe(true)
      expect(store.get(owner, b)!.title).toBe('Bee')
    })

    it('removes the least recently used beyond 50 chats', async () => {
      const { store, owner, clock } = await setup()
      const ids: string[] = []
      for (let i = 0; i < AI_CHAT_LIMITS.chatsPerUser; i++) {
        clock.now += 1
        ids.push(store.create(owner, `c${i}`).id)
      }
      clock.now += 1
      store.append(owner, ids[0]!, turn(1))
      clock.now += 1
      expect(store.create(owner, 'new').removed).toBe(1)
      const left = store.list(owner).map((c) => c.id)
      expect(left).toHaveLength(AI_CHAT_LIMITS.chatsPerUser)
      expect(left).toContain(ids[0])
      expect(left).not.toContain(ids[1])
    })

    it('refuses the 101st turn of a chat', async () => {
      const { store, owner } = await setup()
      const { id } = store.create(owner, 'Full')
      for (let i = 0; i < AI_CHAT_LIMITS.messagesPerChat / 2; i++) store.append(owner, id, turn(i))
      expect(() => store.append(owner, id, turn(999))).toThrow(/full/i)
    })

    it('removes other chats, least recently used first, beyond 16 MiB of text', async () => {
      const { store, owner, clock } = await setup()
      const old = store.create(owner, 'old').id
      store.append(owner, old, { ...turn(1), answer: 'o'.repeat(60 * 1024) })
      const big = 'x'.repeat(60 * 1024)
      clock.now += 1
      const current = store.create(owner, 'current').id
      for (let i = 0; i < 100; i++) {
        clock.now += 1
        store.append(owner, current, { ...turn(i), answer: big })
      }
      for (let k = 0; k < 2; k++) {
        clock.now += 1
        const more = store.create(owner, `more${k}`).id
        for (let i = 0; i < 100; i++) store.append(owner, more, { ...turn(i), answer: big })
      }
      const left = store.list(owner).map((c) => c.title)
      expect(left).not.toContain('old')
      expect(left).toContain('more1')
    })

    it('drops a failed or stopped last turn for a retry, never a done one', async () => {
      const { store, owner } = await setup()
      const { id } = store.create(owner, 'R')
      store.append(owner, id, turn(1))
      expect(store.dropFailedLast(owner, id)).toBe(false)
      store.append(owner, id, turn(2, { state: 'error', reason: 'timeout' }))
      expect(store.dropFailedLast(owner, id)).toBe(true)
      expect(store.get(owner, id)!.turns).toHaveLength(1)
    })

    it('deletes one or all of an owner’s chats', async () => {
      const { store, owner, other } = await setup()
      const a = store.create(owner, 'a').id
      store.create(owner, 'b')
      const theirs = store.create(other, 'c').id
      expect(store.remove(owner, a)).toBe(true)
      expect(store.removeAll(owner)).toBe(1)
      expect(store.list(owner)).toEqual([])
      expect(store.get(other, theirs)).toBeDefined()
    })

    it('forgets chats unused beyond the retention', async () => {
      const { store, owner, clock } = await setup()
      const { id } = store.create(owner, 'old')
      clock.now += kind === 'sqlite' ? 31 * 86_400_000 : AI_CHAT_LIMITS.memoryIdleMs + 1
      const fresh = store.create(owner, 'fresh').id
      expect(store.sweep()).toBe(1)
      expect(store.get(owner, id)).toBeUndefined()
      expect(store.get(owner, fresh)).toBeDefined()
    })

    it('keeps local mode’s chats apart from every user’s', async () => {
      const { store, owner } = await setup()
      const mine = store.create(null, 'local').id
      expect(store.get(owner, mine)).toBeUndefined()
      expect(store.list(null).map((c) => c.id)).toEqual([mine])
    })
  })
}

describe('a chat that is answering (final review minor 9)', () => {
  for (const days of [30, 0])
    it(`is never removed to make room (${days ? 'SQLite' : 'memory'})`, async () => {
      const { db, owner, clock } = await backends()
      const running = new Set<string>()
      const store = createChatStore(db, createSecretBox(randomBytes(32)), () => clock.now, days, running)
      const busy = store.create(owner, 'answering').id
      running.add(busy)
      for (let i = 0; i < AI_CHAT_LIMITS.chatsPerUser; i++) {
        clock.now += 1
        store.create(owner, `c${i}`)
      }
      expect(store.get(owner, busy)).toBeDefined()
      expect(store.list(owner)).toHaveLength(AI_CHAT_LIMITS.chatsPerUser)
    })
})

describe('the SQLite chat store’s sealing (spec §3, C2)', () => {
  it('stores no text in clear, and a body moved to another row does not open', async () => {
    const { sqlite, db, owner } = await backends()
    const { id } = sqlite.create(owner, 'Secret title')
    sqlite.append(owner, id, { ...turn(1), user: 'customer 4711', answer: 'answer about 4711' })
    const dump =
      JSON.stringify(db.prepare('SELECT * FROM ai_chat_messages').all()) +
      JSON.stringify(db.prepare('SELECT * FROM ai_chats').all())
    // CI 2026-10-20: the whole texts, with their spaces: '4711' alone turned up in a random user id.
    expect(dump).not.toContain('customer 4711')
    expect(dump).not.toContain('answer about 4711')
    expect(dump).not.toContain('Secret title')
    const rows = db.prepare('SELECT id, body FROM ai_chat_messages ORDER BY seq').all() as Array<{
      id: string
      body: string
    }>
    db.prepare('UPDATE ai_chat_messages SET body = ? WHERE id = ?').run(rows[0]!.body, rows[1]!.id)
    const chat = sqlite.get(owner, id)!
    expect(chat.turns[0]!.user.text).toBe('customer 4711')
    expect(chat.turns[0]!.answer.text).toBeNull()
    expect(chatMessageContext('m', 'c', null)).toBe('ai-chat-message:["m","c",null]')
  })

  it('deletes a user’s chats with the user', async () => {
    const { sqlite, owner, t } = await backends()
    sqlite.create(owner, 'gone')
    t.app.ctx.users.delete(owner)
    expect(sqlite.list(owner)).toEqual([])
  })

  it('removes stored chats when the retention becomes 0 (spec §2.4)', async () => {
    const { sqlite, db, owner } = await backends()
    sqlite.create(owner, 'stored')
    createChatStore(db, createSecretBox(randomBytes(32)), Date.now, 0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM ai_chats').get() as { n: number }).n).toBe(0)
  })
})

describe('titles and answers (spec §1.1, §2.4)', () => {
  it('takes the first line of the first message, at most 60 characters', () => {
    expect(titleOf('\n  Find   big orders \nand more')).toBe('Find big orders')
    expect(titleOf('ş'.repeat(70))).toBe(`${'ş'.repeat(59)}…`)
  })
  it('cuts an answer at 64 KiB on a character boundary', () => {
    expect(cutAnswer('short')).toEqual({ text: 'short', cut: false })
    const cut = cutAnswer('é'.repeat(40_000))
    expect(cut.cut).toBe(true)
    expect(Buffer.byteLength(cut.text)).toBeLessThanOrEqual(AI_CHAT_LIMITS.answerBytes)
    expect(cut.text.endsWith('�')).toBe(false)
  })
})

describe('migration 19 (spec §2.1)', () => {
  it('keeps existing providers and accepts the gemini kind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-m19-'))
    try {
      const before = await openStore(
        dir,
        MIGRATIONS.filter((m) => m.version <= 18),
      )
      before.db
        .prepare(
          `INSERT INTO ai_providers (id, name, kind, base_url, model, api_key, max_tokens, samples, enabled,
             is_default, created_at, updated_at) VALUES ('p', 'Kept', 'ollama', 'http://x', 'm', NULL, 2048, 1, 1, 1, 1, 1)`,
        )
        .run()
      expect(() => before.db.prepare("UPDATE ai_providers SET kind = 'gemini'").run()).toThrow()
      before.close()
      const after = await openStore(dir)
      try {
        const db: DatabaseSync = after.db
        expect(db.prepare('SELECT name, kind, is_default FROM ai_providers').all()).toEqual([
          { name: 'Kept', kind: 'ollama', is_default: 1 },
        ])
        db.prepare("UPDATE ai_providers SET kind = 'gemini'").run()
      } finally {
        after.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('key rotation re-seals chats (spec C2)', () => {
  it('re-seals titles and messages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-chat-rotate-'))
    try {
      const store = await openStore(dir)
      const chats = createChatStore(
        store.db,
        createSecretBox(loadOrCreateKey({ dataDir: dir })),
        Date.now,
        30,
      )
      const { id } = chats.create(null, 'Rotated')
      chats.append(null, id, turn(1))
      store.close()
      const result = await rotateSecretKey({ dataDir: dir })
      expect(result.aiChats).toBe(1)
      expect(result.aiChatMessages).toBe(2)
      const reopened = await openStore(dir)
      try {
        const box = createSecretBox(
          Buffer.from(readFileSync(join(dir, 'secret.key'), 'utf8').trim(), 'base64'),
        )
        const chat = createChatStore(reopened.db, box, Date.now, 30).get(null, id)!
        expect(chat.title).toBe('Rotated')
        expect(chat.turns[0]!.answer.text).toBe('answer 1')
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('MM_AI_CHAT_DAYS (spec §2.4)', () => {
  it('reads 0–365 and defaults to 30', async () => {
    const { resolveConfig } = await import('../src/config')
    expect(resolveConfig({ cli: { dataDir: 'x' } }).ai.chatDays).toBe(30)
    expect(resolveConfig({ cli: { dataDir: 'x' }, env: { MM_AI_CHAT_DAYS: '0' } }).ai.chatDays).toBe(0)
    expect(() => resolveConfig({ cli: { dataDir: 'x' }, env: { MM_AI_CHAT_DAYS: '366' } })).toThrow()
  })
})
