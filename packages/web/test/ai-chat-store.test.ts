// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { fencedBlocks, type AiChatLine, type AiChatView } from '@mongo-manager/shared'
import { parseMarkdown } from '../src/ai/markdown'
import { turnViews, useAssistantStore } from '../src/ai/chat/store'
import { mockApi } from './support/app'

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const enc = new TextEncoder()
const target = { connectionId: 'c1', db: 'shop', coll: 'orders', tabId: 't1' }
const record = (state: 'done' | 'error' | 'stopped' = 'done') => ({
  connectionId: 'c1',
  namespace: 'shop.orders',
  rulesVersion: 0,
  sources: [{ connectionId: 'c1', rulesVersion: 0 }],
  parts: { schema: true, current: false, indexes: true, validator: false, samples: 0 },
  provider: { id: 'p1', name: 'P', model: 'm', kind: 'openai' as const },
  local: true,
  usage: { input: 1, output: 1 },
  state,
  ...(state === 'done' ? {} : { reason: state === 'stopped' ? 'aborted' : 'timeout' }),
})
const view = (pairs: Array<[string, string, ReturnType<typeof record>]>): AiChatView => ({
  id: 'ch1',
  title: 'Orders',
  full: false,
  messages: pairs.flatMap(([q, a, r], i) => [
    { id: `u${i}`, role: 'user' as const, text: q, createdAt: i, turn: r },
    { id: `a${i}`, role: 'assistant' as const, text: a, createdAt: i, blocks: [] },
  ]),
})

/** The turn route answers these lines; the chat route answers `stored` afterwards. */
function server(lines: AiChatLine[] | 'endless', stored: () => AiChatView) {
  const { fetchMock, calls } = mockApi({ 'GET ai/chats/ch1': () => [200, stored()] })
  const fallback = fetchMock.getMockImplementation()!
  const bodies: unknown[] = []
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (!String(input).endsWith('/ai/chat')) return fallback(input, init)
    bodies.push(JSON.parse(String(init.body)))
    return new Response(
      new ReadableStream({
        start(c) {
          if (lines === 'endless') {
            c.enqueue(
              enc.encode(`${JSON.stringify({ type: 'chat', id: 'ch1', title: 'Orders', turn: 'u0' })}\n`),
            )
            init.signal?.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')))
            return
          }
          c.enqueue(enc.encode(lines.map((l) => JSON.stringify(l)).join('\n')))
          c.close()
        },
      }),
    )
  })
  return { bodies, calls }
}
const CONTEXT: AiChatLine = {
  type: 'context',
  sent: null,
  provider: { id: 'p1', name: 'P', model: 'm', kind: 'openai' },
  history: { sent: 0, leftOut: [] },
}

describe('the assistant’s store (phase 4a-2 spec §1.2)', () => {
  it('streams a turn, then shows the stored chat in its place', async () => {
    const { bodies } = server(
      [
        { type: 'chat', id: 'ch1', title: 'Orders', turn: 'u0' },
        CONTEXT,
        { type: 'text', delta: 'Hello' },
        { type: 'done', blocks: [], usage: { input: 1, output: 1 }, local: true },
      ],
      () => view([['hi', 'Hello', record()]]),
    )
    const store = useAssistantStore()
    await store.send('hi', target, { parts: { current: false, indexes: true, validator: false } }, 'en')
    await flushPromises()
    expect(bodies[0]).toEqual({
      message: 'hi',
      language: 'en',
      parts: { current: false, indexes: true, validator: false },
    })
    expect(store.chatId).toBe('ch1')
    expect(store.live).toBeNull()
    expect(store.chat!.messages.map((m) => m.text)).toEqual(['hi', 'Hello'])
    expect(store.version).toBeGreaterThan(0)
  })

  it('sends a general turn without parts, and the next one in the same chat', async () => {
    const { bodies } = server(
      [
        { type: 'chat', id: 'ch1', title: 'Orders', turn: 'u0' },
        CONTEXT,
        { type: 'done', blocks: [], usage: { input: 1, output: 1 }, local: null },
      ],
      () => view([['a', 'b', record()]]),
    )
    const store = useAssistantStore()
    await store.send('a', null, null, 'tr')
    await flushPromises()
    await store.send('c', null, null, 'tr')
    expect(bodies).toEqual([
      { message: 'a', language: 'tr' },
      { chat: 'ch1', message: 'c', language: 'tr' },
    ])
  })

  it('keeps a refused turn on screen with its reason, and nothing stored', async () => {
    mockApi({
      'POST ai/chat': () => [409, { code: 'CONFLICT', message: 'x', details: { reason: 'no_provider' } }],
    })
    const store = useAssistantStore()
    await store.send('a', null, null, 'en')
    expect(store.live).toMatchObject({ state: 'error', stored: false, error: { reason: 'no_provider' } })
    expect(store.chatId).toBeNull()
  })

  it('stops an answer and keeps what came', async () => {
    server('endless', () => view([['hi', '', record('stopped')]]))
    const store = useAssistantStore()
    const done = store.send('hi', null, null, 'en')
    await vi.waitFor(() => expect(store.chatId).toBe('ch1'))
    store.stop()
    await done
    expect(store.live?.state ?? 'replaced').not.toBe('streaming')
  })

  it('tries a stored failed turn again with retry, in its place', async () => {
    const { bodies } = server(
      [
        { type: 'chat', id: 'ch1', title: 'Orders', turn: 'u0' },
        CONTEXT,
        { type: 'done', blocks: [], usage: { input: 1, output: 1 }, local: true },
      ],
      () => view([['q', 'fixed', record()]]),
    )
    const store = useAssistantStore()
    store.chatId = 'ch1'
    store.chat = view([['q', '', record('error')]])
    await store.send('q', null, null, 'en', { retry: true })
    await flushPromises()
    expect(bodies[0]).toEqual({ chat: 'ch1', message: 'q', language: 'en', retry: true })
    expect(store.chat!.messages.map((m) => m.text)).toEqual(['q', 'fixed'])
  })

  // User report 2026-10-30: a reload with the chat open lost it from the panel (it was kept on the
  // server all along). The open chat's id is remembered — never its words — and opened again.
  it('opens the chat it had open again after a reload, by its id alone', async () => {
    const stored = view([['how many orders?', 'About 120.', record()]])
    const { calls } = mockApi({ 'GET ai/chats/ch1': () => [200, stored] })
    const store = useAssistantStore()
    store.bindUser('u1')
    store.show()
    await store.openChat('ch1')
    const saved = localStorage.getItem('mm.assistant.u1')!
    expect(JSON.parse(saved)).toMatchObject({ open: true, chat: 'ch1' })
    expect(saved).not.toContain('orders')
    setActivePinia(createPinia())
    const again = useAssistantStore()
    again.bindUser('u1')
    await flushPromises()
    expect(again.chatId).toBe('ch1')
    expect(again.chat?.messages.map((m) => m.text)).toEqual(['how many orders?', 'About 120.'])
    expect(calls.filter((c) => c.path === 'ai/chats/ch1')).toHaveLength(2)
    // Another user of this browser opens nothing of it.
    setActivePinia(createPinia())
    const other = useAssistantStore()
    other.bindUser('u2')
    other.show()
    await flushPromises()
    expect(other.chatId).toBeNull()
  })

  it('opens the remembered chat when the panel is opened, not before', async () => {
    localStorage.setItem('mm.assistant.u1', JSON.stringify({ open: false, chat: 'ch1' }))
    const { calls } = mockApi({ 'GET ai/chats/ch1': () => [200, view([])] })
    const store = useAssistantStore()
    store.bindUser('u1')
    await flushPromises()
    expect(calls.filter((c) => c.path === 'ai/chats/ch1')).toHaveLength(0)
    store.show()
    await flushPromises()
    expect(store.chatId).toBe('ch1')
    expect(calls.filter((c) => c.path === 'ai/chats/ch1')).toHaveLength(1)
  })

  it('starts a new chat when the remembered one is gone, and forgets it', async () => {
    localStorage.setItem('mm.assistant.u1', JSON.stringify({ open: true, chat: 'gone' }))
    mockApi({ 'GET ai/chats/gone': () => [404, { code: 'NOT_FOUND', message: 'Chat not found' }] })
    const store = useAssistantStore()
    store.bindUser('u1')
    await flushPromises()
    expect([store.chatId, store.chat, store.loadError]).toEqual([null, null, null])
    expect(JSON.parse(localStorage.getItem('mm.assistant.u1')!).chat).toBeNull()
  })

  it('reads no odd value as a chat to open', async () => {
    localStorage.setItem('mm.assistant.u1', JSON.stringify({ open: true, chat: '../../users' }))
    const { calls } = mockApi({})
    const store = useAssistantStore()
    store.bindUser('u1')
    await flushPromises()
    expect(store.chatId).toBeNull()
    expect(calls.filter((c) => c.path.startsWith('ai/chats'))).toEqual([])
  })

  it('remembers the open state and size per user in this browser, never chat content', () => {
    const store = useAssistantStore()
    store.bindUser('u1')
    store.show()
    store.setWidth(5000, 900)
    expect(store.width).toBe(900)
    store.setWidth(10, 900)
    expect(store.width).toBe(320)
    // The window's height and whether it is expanded too (user report 2026-10-25); never the draft.
    store.draft = 'secret words'
    store.setHeight(10, 900)
    expect(JSON.parse(localStorage.getItem('mm.assistant.u1')!)).toEqual({
      open: true,
      width: 320,
      height: 360,
      expanded: false,
      chat: null,
    })
    setActivePinia(createPinia())
    const again = useAssistantStore()
    again.bindUser('u1')
    expect([again.open, again.width]).toEqual([true, 320])
    again.bindUser('u2')
    expect(again.open).toBe(false)
  })

  it('forgets every chat on sign-out (C8)', () => {
    const store = useAssistantStore()
    store.bindUser('u1')
    store.chatId = 'ch1'
    store.chat = view([['secret', 'answer', record()]])
    store.reset()
    expect([store.chatId, store.chat, store.live, store.open]).toEqual([null, null, null, false])
    expect(Object.keys(localStorage).some((k) => (localStorage.getItem(k) ?? '').includes('secret'))).toBe(
      false,
    )
  })

  it('remembers the parts per tab; the current query follows the section until chosen', () => {
    const store = useAssistantStore()
    expect(store.partsFor('t1')).toEqual({ current: null, indexes: true, validator: false })
    store.partsFor('t1').indexes = false
    store.partsFor('t1').current = false
    expect(store.partsFor('t1')).toEqual({ current: false, indexes: false, validator: false })
    expect(store.partsFor('t2')).toEqual({ current: null, indexes: true, validator: false })
  })
})

describe('turn views (spec §5)', () => {
  it('pairs stored messages, and a retried live turn takes the failed one’s place', () => {
    const chat = view([
      ['a', 'b', record()],
      ['q', '', record('error')],
    ])
    expect(turnViews(chat, null).map((v) => [v.message, v.state])).toEqual([
      ['a', 'done'],
      ['q', 'error'],
    ])
    const live = {
      seq: 1,
      turnId: null,
      message: 'q',
      where: null,
      namespace: null,
      retry: true,
      stored: true,
      state: 'streaming' as const,
      text: 'x',
      sent: null,
      catalogue: null,
      connectionNames: null,
      provider: null,
      history: null,
      blocks: [],
      usage: null,
      local: null,
      error: null,
      agent: null,
      agentAsked: false,
    }
    expect(turnViews(chat, live).map((v) => [v.message, v.state])).toEqual([
      ['a', 'done'],
      ['q', 'streaming'],
    ])
    expect(turnViews(chat, null)[0]!.where).toEqual({ connectionId: 'c1', db: 'shop', coll: 'orders' })
  })
})

describe('the Markdown and the server count code blocks alike (plan ruling 6)', () => {
  it('finds the same blocks in the same order', () => {
    for (const text of [
      'a\n```json\n{}\n```\nb\n```\n[1]\n```',
      '- item\n  ```js\n  { a: 1 }\n  ```\n- next',
      '```JSON\n{ "x": 1 }',
      '```js\n1\n```js\n2\n```',
      'no blocks here',
    ]) {
      const md = parseMarkdown(text).filter((b) => b.kind === 'codeBlock')
      expect(
        md.map((b) => (b as { text: string }).text),
        text,
      ).toEqual(fencedBlocks(text).map((b) => b.text))
    }
  })
})
