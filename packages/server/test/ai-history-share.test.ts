// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { AiHistoryItem, AiHistoryPage, AiHistoryThread } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, teamHarness } from './support/data'
import { H } from './helpers'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../src/store/db'
import { MIGRATIONS } from '../src/store/migrations'
import type { NewAiRequest } from '../src/ai/requests'

let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
})
afterAll(async () => {
  await mongo?.stop()
})
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c()
})

type Method = 'GET' | 'POST' | 'DELETE'

/**
 * User review 2026-10-09 ("isterse AI geçmişini paylaşabilsin … ekip modu … birden fazla ekip üyesi"):
 * an owner shares an entry; a teammate sees it only while they may read its connection unmasked.
 */
async function team() {
  const h = await teamHarness(mongo)
  closers.push(h.t.close)
  const { ctx } = h.t.app
  const as = (role: 'admin' | 'editor' | 'viewer') => {
    const user = ctx.users.create({
      username: `u-${role}-${randomUUID().slice(0, 6)}`,
      passwordHash: 'x',
      role,
    })
    const { sessionId, session } = ctx.sessions.create(user.id, {})
    const call = (method: Method, url: string, payload?: unknown) =>
      h.t.app.inject({
        method,
        url: `/api/${url}`,
        headers: { ...H, 'x-csrf-token': session.csrfToken },
        cookies: { mm_sid: sessionId },
        ...(payload !== undefined ? { payload: payload as object } : {}),
      })
    return { id: user.id, username: user.username, sessionId, call }
  }
  const record = (owner: string | null, over: Partial<NewAiRequest> = {}) =>
    ctx.ai.history.record({
      owner,
      action: 'query',
      connectionId: h.connectionId,
      namespace: 'shop.orders',
      provider: { id: randomUUID(), name: 'P', kind: 'openai', model: 'm' },
      outcome: 'ok',
      usage: { input: 1, output: 1 },
      ms: 5,
      price: null,
      content: { prompt: 'find the big orders', answer: '{ total: { $gt: 100 } }' },
      ...over,
    })
  return { h, ctx, as, record }
}

describe('sharing an AI request with the team', () => {
  it('shows a shared request to a teammate who may read its connection, read-only, with who shared it', async () => {
    const { as, record } = await team()
    const ada = as('editor')
    const bob = as('viewer')
    const id = record(ada.id)
    expect((await ada.call('GET', 'ai/history/sharing')).json()).toEqual({ available: true })
    const shared = await ada.call('POST', `ai/history/${id}/share`)
    expect(shared.statusCode).toBe(200)
    expect(shared.json()).toMatchObject({ shared: true })
    const seen = (await bob.call('GET', `ai/history/${id}`)).json() as AiHistoryItem
    expect(seen.content?.prompt).toBe('find the big orders')
    expect(seen).toMatchObject({ mine: false, sharedBy: ada.username, shared: true })
    const mine = (await ada.call('GET', `ai/history/${id}`)).json() as AiHistoryItem
    expect(mine).toMatchObject({ mine: true, sharedBy: null, shared: true })
    const page = (await bob.call('GET', 'ai/history?shared=1')).json() as AiHistoryPage
    expect(page.items.map((i) => i.id)).toEqual([id])
    // The teammate's own list stays theirs.
    expect(((await bob.call('GET', 'ai/history')).json() as AiHistoryPage).items).toEqual([])
    const chain = (await bob.call('GET', `ai/history/${id}/chain`)).json() as AiHistoryThread
    expect(chain.steps.map((s) => s.id)).toEqual([id])
  })

  it('answers a request not shared exactly like a missing one', async () => {
    const { as, record } = await team()
    const ada = as('editor')
    const bob = as('editor')
    const id = record(ada.id)
    for (const url of [`ai/history/${id}`, `ai/history/${id}/chain`, `ai/history/${randomUUID()}`])
      expect((await bob.call('GET', url)).statusCode).toBe(404)
    expect(((await bob.call('GET', 'ai/history?shared=1')).json() as AiHistoryPage).items).toEqual([])
  })

  it('never shows it to a teammate who may not read the connection, or sees it masked', async () => {
    const { as, record, ctx, h } = await team()
    const ada = as('editor')
    const hidden = as('editor')
    const masked = as('editor')
    ctx.grants.set(h.connectionId, hidden.id, 'none')
    // A masked grant needs a role granted first.
    ctx.grants.set(h.connectionId, masked.id, 'editor')
    ctx.grants.setMasked(h.connectionId, masked.id, true)
    const id = record(ada.id)
    await ada.call('POST', `ai/history/${id}/share`)
    for (const who of [hidden, masked]) {
      expect((await who.call('GET', `ai/history/${id}`)).statusCode).toBe(404)
      expect((await who.call('GET', `ai/history/${id}/chain`)).statusCode).toBe(404)
      expect(((await who.call('GET', 'ai/history?shared=1')).json() as AiHistoryPage).items).toEqual([])
    }
    // A connection gone: no one but its owner.
    const bob = as('editor')
    expect((await bob.call('GET', `ai/history/${id}`)).statusCode).toBe(200)
    ctx.connections.delete(h.connectionId)
    expect((await bob.call('GET', `ai/history/${id}`)).statusCode).toBe(404)
    expect((await ada.call('GET', `ai/history/${id}`)).statusCode).toBe(200)
  })

  it('shares a chat without a connection only with those who may use the AI', async () => {
    const { as, record } = await team()
    const ada = as('editor')
    const editor = as('editor')
    const viewer = as('viewer')
    const id = record(ada.id, { action: 'chat', connectionId: null, namespace: null, chatId: randomUUID() })
    await ada.call('POST', `ai/history/${id}/share`)
    expect((await editor.call('GET', `ai/history/${id}`)).statusCode).toBe(200)
    expect((await viewer.call('GET', `ai/history/${id}`)).statusCode).toBe(404)
  })

  it('stops showing it once the owner takes the share back, and audits both', async () => {
    const { as, record, ctx } = await team()
    const ada = as('editor')
    const bob = as('editor')
    const id = record(ada.id)
    await ada.call('POST', `ai/history/${id}/share`)
    const back = await ada.call('DELETE', `ai/history/${id}/share`)
    expect(back.statusCode).toBe(200)
    expect(back.json()).toMatchObject({ shared: false })
    expect((await bob.call('GET', `ai/history/${id}`)).statusCode).toBe(404)
    const actions = ctx.audit.list({ userId: ada.id }).map((e) => e.action)
    expect(actions).toEqual(expect.arrayContaining(['ai.history.share', 'ai.history.unshare']))
  })

  it('lets only the owner share, take back or remove it — a teammate gets a missing one', async () => {
    const { as, record } = await team()
    const ada = as('editor')
    const bob = as('admin')
    const id = record(ada.id)
    // An administrator is no exception.
    expect((await bob.call('POST', `ai/history/${id}/share`)).statusCode).toBe(404)
    expect((await bob.call('GET', `ai/history/${id}`)).statusCode).toBe(404)
    await ada.call('POST', `ai/history/${id}/share`)
    expect((await bob.call('DELETE', `ai/history/${id}/share`)).statusCode).toBe(404)
    expect((await bob.call('DELETE', `ai/history/${id}`)).statusCode).toBe(404)
    expect((await bob.call('GET', `ai/history/${id}`)).statusCode).toBe(200)
  })

  it('shares a whole chain, its later steps too, and never another user’s steps under the same chain id', async () => {
    const { as, record } = await team()
    const ada = as('editor')
    const bob = as('editor')
    const carol = as('editor')
    const thread = randomUUID()
    const first = record(ada.id, { action: 'pipeline', thread })
    await ada.call('POST', `ai/history/${first}/share`)
    const second = record(ada.id, {
      action: 'pipeline',
      thread,
      content: { prompt: 'and by month', answer: 'x' },
    })
    // Bob reuses Ada's chain id for his own (unshared) request.
    record(bob.id, { action: 'pipeline', thread, content: { prompt: 'bob secret', answer: 'y' } })
    const chain = (await carol.call('GET', `ai/history/${second}/chain`)).json() as AiHistoryThread
    expect(chain.steps.map((s) => s.id)).toEqual([first, second])
    expect(JSON.stringify(chain)).not.toContain('bob secret')
    const page = (await carol.call('GET', 'ai/history?shared=1')).json() as AiHistoryPage
    expect(page.items.map((i) => i.id)).toEqual([first])
    expect(page.items[0]!.chain?.steps).toBe(2)
  })

  it('is not offered in local mode, nor while the owner is the only active user', async () => {
    const local = await dataHarness(mongo)
    closers.push(local.t.close)
    const call = (method: Method, url: string) =>
      local.t.app.inject({ method, url: `/api/${url}`, headers: local.headers })
    const id = local.t.app.ctx.ai.history.record({
      owner: null,
      action: 'query',
      connectionId: local.connectionId,
      namespace: 'shop.orders',
      provider: { id: randomUUID(), name: 'P', kind: 'openai', model: 'm' },
      outcome: 'ok',
      usage: { input: 1, output: 1 },
      ms: 5,
      price: null,
      content: { prompt: 'p', answer: 'a' },
    })
    expect((await call('GET', 'ai/history/sharing')).json()).toEqual({ available: false })
    expect((await call('POST', `ai/history/${id}/share`)).statusCode).toBe(409)

    const { as, record, ctx } = await team()
    const ada = as('admin')
    const other = as('editor')
    ctx.users.setDisabled(other.id, true)
    // The harness signs no one else in: Ada is the only active user.
    const mine = record(ada.id)
    expect((await ada.call('GET', 'ai/history/sharing')).json()).toEqual({ available: false })
    expect((await ada.call('POST', `ai/history/${mine}/share`)).statusCode).toBe(409)
  })

  it('forgets the share with the request, and refuses a bad id', async () => {
    const { as, record, ctx } = await team()
    const ada = as('editor')
    const bob = as('editor')
    const id = record(ada.id)
    await ada.call('POST', `ai/history/${id}/share`)
    expect((await ada.call('DELETE', `ai/history/${id}`)).statusCode).toBe(204)
    const left = ctx.ai.history as unknown as { db: import('node:sqlite').DatabaseSync }
    expect((left.db.prepare('SELECT COUNT(*) AS n FROM ai_request_shares').get() as { n: number }).n).toBe(0)
    expect((await bob.call('GET', `ai/history/${id}`)).statusCode).toBe(404)
    expect((await ada.call('POST', 'ai/history/not-an-id/share')).statusCode).toBe(400)
  })

  it('stops showing a disabled user’s shares', async () => {
    const { as, record, ctx } = await team()
    const ada = as('editor')
    const bob = as('editor')
    const id = record(ada.id)
    await ada.call('POST', `ai/history/${id}/share`)
    ctx.users.setDisabled(ada.id, true)
    expect((await bob.call('GET', `ai/history/${id}`)).statusCode).toBe(404)
    expect(((await bob.call('GET', 'ai/history?shared=1')).json() as AiHistoryPage).items).toEqual([])
    ctx.users.setDisabled(ada.id, false)
    expect((await bob.call('GET', `ai/history/${id}`)).statusCode).toBe(200)
  })

  it('reads a shared chat turn only with every connection its answer drew on (share review C1)', async () => {
    const { as, record, ctx, h } = await team()
    const ada = as('editor')
    const allowed = as('editor')
    const masked = as('editor')
    const none = as('editor')
    ctx.grants.set(h.connectionId, masked.id, 'editor')
    ctx.grants.setMasked(h.connectionId, masked.id, true)
    ctx.grants.set(h.connectionId, none.id, 'none')
    // A general turn (no connection of its own) whose history came from the connection.
    const id = record(ada.id, {
      action: 'chat',
      chatId: randomUUID(),
      connectionId: null,
      namespace: null,
      sources: [h.connectionId],
      credential: false,
      content: { prompt: 'and their emails?', answer: 'ada@example.com' },
    })
    expect((await ada.call('POST', `ai/history/${id}/share`)).statusCode).toBe(200)
    expect((await allowed.call('GET', `ai/history/${id}`)).statusCode).toBe(200)
    for (const who of [masked, none]) {
      expect((await who.call('GET', `ai/history/${id}`)).statusCode).toBe(404)
      expect(((await who.call('GET', 'ai/history?shared=1')).json() as AiHistoryPage).items).toEqual([])
    }
  })

  it('never shares an earlier chat turn whose sources were not kept', async () => {
    const { as, record, ctx } = await team()
    const ada = as('editor')
    const bob = as('editor')
    const id = record(ada.id, { action: 'chat', chatId: randomUUID(), connectionId: null, namespace: null })
    const db = (ctx.ai.history as unknown as { db: import('node:sqlite').DatabaseSync }).db
    db.prepare('UPDATE ai_requests SET sources = NULL WHERE id = ?').run(id)
    expect(((await ada.call('GET', `ai/history/${id}`)).json() as AiHistoryItem).shareable).toBe(false)
    expect((await ada.call('POST', `ai/history/${id}/share`)).statusCode).toBe(409)
    // Shared before (by any means): still no one else's.
    db.prepare('INSERT INTO ai_request_shares (user_id, entry, at) VALUES (?, ?, 0)').run(ada.id, id)
    expect((await bob.call('GET', `ai/history/${id}`)).statusCode).toBe(404)
  })

  it('shows what touched credential collections only to the connection’s admins (share review I2)', async () => {
    const { as, record, ctx, h } = await team()
    const owner = as('admin')
    const editor = as('editor')
    const connectionAdmin = as('editor')
    ctx.grants.set(h.connectionId, connectionAdmin.id, 'admin')
    const id = record(owner.id, { namespace: 'admin.system.users' })
    await owner.call('POST', `ai/history/${id}/share`)
    expect((await editor.call('GET', `ai/history/${id}`)).statusCode).toBe(404)
    expect(((await editor.call('GET', 'ai/history?shared=1')).json() as AiHistoryPage).items).toEqual([])
    expect((await connectionAdmin.call('GET', `ai/history/${id}`)).statusCode).toBe(200)
    expect(
      ((await connectionAdmin.call('GET', 'ai/history?shared=1')).json() as AiHistoryPage).items,
    ).toHaveLength(1)
    // A chat that carried one.
    const chat = record(owner.id, {
      action: 'chat',
      chatId: randomUUID(),
      connectionId: null,
      namespace: null,
      sources: [h.connectionId],
      credential: true,
    })
    await owner.call('POST', `ai/history/${chat}/share`)
    expect((await editor.call('GET', `ai/history/${chat}`)).statusCode).toBe(404)
    expect((await connectionAdmin.call('GET', `ai/history/${chat}`)).statusCode).toBe(200)
  })

  it('lets the owner take a share back even when no teammate is left (share review I3)', async () => {
    const { as, record, ctx } = await team()
    const ada = as('editor')
    const bob = as('editor')
    const id = record(ada.id)
    await ada.call('POST', `ai/history/${id}/share`)
    ctx.users.setDisabled(bob.id, true)
    expect((await ada.call('DELETE', `ai/history/${id}/share`)).statusCode).toBe(200)
    ctx.users.setDisabled(bob.id, false)
    expect((await bob.call('GET', `ai/history/${id}`)).statusCode).toBe(404)
  })

  it('never gives a teammate the owner’s chat id, and refuses a share without the CSRF token', async () => {
    const { as, record, h } = await team()
    const ada = as('editor')
    const bob = as('editor')
    const id = record(ada.id, {
      action: 'chat',
      chatId: randomUUID(),
      sources: [h.connectionId],
      credential: false,
    })
    await ada.call('POST', `ai/history/${id}/share`)
    expect(((await bob.call('GET', `ai/history/${id}`)).json() as AiHistoryItem).chatId).toBeNull()
    // Signed in, but no CSRF token: refused before anything is done.
    const bare = await h.t.app.inject({
      method: 'POST',
      url: `/api/ai/history/${id}/share`,
      headers: H,
      cookies: { mm_sid: bob.sessionId },
    })
    expect(bare.statusCode).toBe(403)
  })

  it('upgrades a store at version 25: what each kept request drew on, an older chat turn left unknown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-ai-sources-'))
    closers.push(async () => rmSync(dir, { recursive: true, force: true }))
    const before = await openStore(
      dir,
      MIGRATIONS.filter((m) => m.version <= 25),
    )
    const row = (id: string, action: string, connection: string | null, namespace: string | null) =>
      before.db
        .prepare(
          `INSERT INTO ai_requests (id, user_id, at, action, connection_id, namespace, provider_name,
             provider_kind, model, outcome) VALUES (?, NULL, 1, ?, ?, ?, 'P', 'openai', 'm', 'ok')`,
        )
        .run(id, action, connection, namespace)
    row('query', 'query', 'c1', 'shop.orders')
    row('users', 'query', 'c1', 'admin.system.users')
    row('chat', 'chat', null, null)
    before.close()
    const after = await openStore(dir)
    closers.push(async () => after.close())
    expect(after.db.prepare('SELECT id, sources, credential FROM ai_requests ORDER BY id').all()).toEqual([
      { id: 'chat', sources: null, credential: 0 },
      { id: 'query', sources: '["c1"]', credential: 0 },
      { id: 'users', sources: '["c1"]', credential: 1 },
    ])
  })
})

// Review of the chat entry (C1, I1, I2, M6): a chat is one entry for its owner only; a teammate is
// shared a turn, never the chat — nor a turn of it on a connection they may not read, nor its words
// through a search, nor its id.
describe('a chat shared with the team', () => {
  it('shares the turn shared, alone: never the chat’s other turns, nor what they hold', async () => {
    const { as, record, ctx, h } = await team()
    const ada = as('editor')
    const bob = as('editor')
    ctx.grants.set(h.connectionId, bob.id, 'none')
    // A chat kept by the assistant (a turn of a chat gone keeps no words).
    const chat = ctx.ai.chats.create(ada.id, 'hello').id
    const turn = (prompt: string, onConnection: boolean) =>
      record(ada.id, {
        action: 'chat',
        chatId: chat,
        thread: chat,
        connectionId: onConnection ? h.connectionId : null,
        namespace: onConnection ? 'shop.orders' : null,
        sources: onConnection ? [h.connectionId] : [],
        content: { prompt, answer: `${prompt} answered` },
      })
    const first = turn('hello', false)
    const second = turn('the secret payroll of shop', true)
    const third = turn('thanks', false)
    // One entry for its owner, every turn in it.
    const own = (await ada.call('GET', 'ai/history')).json() as AiHistoryPage
    expect(own.items).toHaveLength(1)
    expect(own.items[0]!.chain?.steps).toBe(3)
    expect((await ada.call('POST', `ai/history/${first}/share`)).statusCode).toBe(200)
    const shared = (await bob.call('GET', 'ai/history?shared=1')).json() as AiHistoryPage
    expect(shared.items.map((i) => i.id)).toEqual([first])
    // Alone: no chain, no chat id behind it.
    expect(shared.items[0]).toMatchObject({ chain: null, thread: null, chatId: null, step: null })
    const chain = (await bob.call('GET', `ai/history/${first}/chain`)).json() as AiHistoryThread
    expect(chain.steps.map((st) => st.id)).toEqual([first])
    for (const other of [second, third])
      expect((await bob.call('GET', `ai/history/${other}`)).statusCode).toBe(404)
    // Nor what another turn says, by a search — which its owner finds.
    const searched = (await bob.call('GET', 'ai/history?shared=1&q=payroll')).json() as AiHistoryPage
    expect(searched.items).toEqual([])
    const found = (await ada.call('GET', 'ai/history?q=payroll')).json() as AiHistoryPage
    expect(found.items).toHaveLength(1)
    // Another turn shared on its own is listed on its own.
    await ada.call('POST', `ai/history/${third}/share`)
    const both = (await bob.call('GET', 'ai/history?shared=1')).json() as AiHistoryPage
    expect(both.items.map((i) => i.id).sort()).toEqual([first, third].sort())
    // Its owner's line says a turn of it is shared, whichever (re-review, M7): the first taken back,
    // the third still shared.
    await ada.call('DELETE', `ai/history/${first}/share`)
    expect(((await ada.call('GET', 'ai/history')).json() as AiHistoryPage).items[0]!.shared).toBe(true)
    // A share keyed by the chat itself (made before turns were shared alone) shows nothing.
    const db = (ctx.ai.history as unknown as { db: import('node:sqlite').DatabaseSync }).db
    db.prepare('DELETE FROM ai_request_shares').run()
    db.prepare('INSERT INTO ai_request_shares (user_id, entry, at) VALUES (?, ?, 0)').run(ada.id, chat)
    expect(((await bob.call('GET', 'ai/history?shared=1')).json() as AiHistoryPage).items).toEqual([])
  })

  // C1, beside a chat: a chain's steps are each read as they were asked — one that drew on a
  // connection a teammate may not read is not theirs, whatever the chain's first step allows.
  it('shows a teammate only the steps of a shared chain they may read', async () => {
    const { as, record, ctx, h } = await team()
    const ada = as('editor')
    const bob = as('editor')
    const other = ctx.connections.create(
      {
        name: 'Other',
        favorite: false,
        readOnly: false,
        settings: ctx.connections.get(h.connectionId)!.settings,
      },
      null,
    ).id
    ctx.grants.set(other, bob.id, 'none')
    const thread = randomUUID()
    const first = record(ada.id, { thread, sources: [h.connectionId] })
    const second = record(ada.id, {
      thread,
      sources: [h.connectionId, other],
      content: { prompt: 'the hidden step', answer: 'x' },
    })
    await ada.call('POST', `ai/history/${first}/share`)
    const chain = (await bob.call('GET', `ai/history/${first}/chain`)).json() as AiHistoryThread
    expect(chain.steps.map((st) => st.id)).toEqual([first])
    expect((await bob.call('GET', `ai/history/${second}`)).statusCode).toBe(404)
    // Read alone, no sums of steps they may not read (re-review, M5).
    expect(((await bob.call('GET', `ai/history/${first}`)).json() as AiHistoryItem).chain).toBeNull()
    // Nor its sums, its latest step, or its words through a search (re-review, M5).
    const listed = ((await bob.call('GET', 'ai/history?shared=1')).json() as AiHistoryPage).items
    expect(listed.map((i) => i.id)).toEqual([first])
    expect(listed[0]!.chain?.latest ?? first).toBe(first)
    expect(JSON.stringify(listed)).not.toContain(second)
    // Third review (minor 1): nor through a search, a filter, or a page and its cursor.
    const searched = (await bob.call('GET', 'ai/history?shared=1&q=hidden')).json() as AiHistoryPage
    expect(searched.items).toEqual([])
    const page = (await bob.call('GET', 'ai/history?shared=1&action=query&limit=1')).json() as AiHistoryPage
    expect(page.items.map((i) => i.id)).toEqual([first])
    expect(page.next).toBeNull()
  })
})
