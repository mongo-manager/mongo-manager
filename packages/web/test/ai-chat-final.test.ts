// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import {
  PERMISSIONS,
  type AiChatBlock,
  type AiChatLine,
  type AiChatTurnRecord,
  type AiChatView,
  type AiStatus,
} from '@mongo-manager/shared'
import AssistantPanel from '../src/ai/chat/AssistantPanel.vue'
import AiSettingsView from '../src/ai/AiSettingsView.vue'
import AccountView from '../src/account/AccountView.vue'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import ToastHost from '../src/ds/DsToastHost.vue'
import { createAppRouter } from '../src/router'
import { useAssistantStore } from '../src/ai/chat/store'
import { useAiWords } from '../src/ai/words'
import { useTabsStore } from '../src/stores/tabs'
import { useDialogStore } from '../src/stores/dialogs'
import { useSessionStore } from '../src/stores/session'
import { i18n } from '../src/i18n'
import { mockApi, mountApp, type Handler } from './support/app'
import { button, typeInto } from './support/dom'

/** Phase 4a-2 final review: each web finding, first seen failing. */
beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const STATUS = (days = 30): AiStatus => ({
  enabled: true,
  allowServerJs: false,
  providers: [
    { id: 'p1', name: 'Local', kind: 'openai', model: 'm', local: true, samples: true, isDefault: true },
  ],
  limits: { perMinute: 10, perDay: 200, perUser: 2, concurrent: 8 },
  chat: { days, chats: 50, messages: 200 },
})
const CONN = (permissions = ['documents:read', 'ai:use', 'indexes:write']) => ({
  id: 'c1',
  name: 'Prod',
  aiPolicy: 'any',
  permissions,
  settings: { hosts: [] },
})
const record = (over: Partial<AiChatTurnRecord> = {}): AiChatTurnRecord => ({
  connectionId: 'c1',
  namespace: 'shop.orders',
  rulesVersion: 0,
  sources: [{ connectionId: 'c1', rulesVersion: 0 }],
  parts: { schema: true, current: false, indexes: true, validator: false, samples: 0 },
  provider: { id: 'p1', name: 'Local', model: 'm', kind: 'openai' },
  local: true,
  usage: { input: 1, output: 1 },
  state: 'done',
  ...over,
})
type Turn = { id: string; q: string; a: string; r: AiChatTurnRecord; blocks?: AiChatBlock[] }
const view = (turns: Turn[], title = 'Orders'): AiChatView => ({
  id: 'ch1',
  title,
  full: false,
  messages: turns.flatMap((t) => [
    { id: t.id, role: 'user' as const, text: t.q, createdAt: 0, turn: t.r },
    { id: `${t.id}a`, role: 'assistant' as const, text: t.a, createdAt: 0, blocks: t.blocks ?? [] },
  ]),
})
const SENT = {
  namespace: 'shop.orders',
  schema: { sampled: 1, count: 1, more: 0, fields: [] },
  current: null,
  plan: null,
  indexes: [],
  validator: null,
  samples: [],
  leftOut: [],
}
const answer = (turn: string, text: string, history = { sent: 0, leftOut: [] as string[] }): AiChatLine[] => [
  { type: 'chat', id: 'ch1', title: 'Orders', turn },
  { type: 'context', sent: SENT, provider: { id: 'p1', name: 'Local', model: 'm', kind: 'openai' }, history },
  { type: 'text', delta: text },
  { type: 'done', blocks: [], usage: { input: 1, output: 1 }, local: true },
]

/** The panel beside a collection tab; each turn request answers the next of `answers` ('endless' never ends). */
async function panel(
  opts: {
    handlers?: Record<string, Handler>
    answers?: Array<AiChatLine[] | 'endless' | 'silent' | 'refused'>
    coll?: string
    connection?: ReturnType<typeof CONN>
    status?: AiStatus
  } = {},
) {
  const api = mockApi({
    'GET ai/status': () => [200, opts.status ?? STATUS()],
    'GET connections': () => [200, [opts.connection ?? CONN()]],
    'GET ai/chats': () => [200, []],
    ...opts.handlers,
  })
  const turns: Array<{ url: string; body: Record<string, unknown> }> = []
  const answers = [...(opts.answers ?? [])]
  const fallback = api.fetchMock.getMockImplementation()!
  api.fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (!String(input).endsWith('/ai/chat')) return fallback(input, init)
    turns.push({ url: String(input), body: JSON.parse(String(init.body)) })
    const lines = answers.shift() ?? []
    if (lines === 'refused')
      return new Response(
        JSON.stringify({ code: 'CONFLICT', message: 'busy', details: { reason: 'chat_busy' } }),
        {
          status: 409,
          headers: { 'content-type': 'application/json' },
        },
      )
    const enc = new TextEncoder()
    return new Response(
      new ReadableStream({
        start(c) {
          if (lines === 'endless' || lines === 'silent') {
            if (lines === 'endless')
              c.enqueue(
                enc.encode(`${JSON.stringify({ type: 'chat', id: 'ch1', title: 'Orders', turn: 'u9' })}\n`),
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
  const tabs = useTabsStore()
  const tabId = tabs.open({
    kind: 'collection',
    title: opts.coll ?? 'orders',
    params: { connectionId: 'c1', db: 'shop', coll: opts.coll ?? 'orders' },
  })
  const store = useAssistantStore()
  store.show()
  mountApp(AssistantPanel)
  mountApp(DialogHost)
  mountApp(ToastHost)
  await flushPromises()
  return { ...api, turns, tabs, tabId, store }
}
const composer = () => document.querySelector<HTMLTextAreaElement>('textarea')!
const send = async (text: string) => {
  await typeInto(composer(), text)
  composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await flushPromises()
}
const labelled = (name: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!
const text = () => document.body.textContent ?? ''

describe('Critical 1: another user never sees the previous user’s chat', () => {
  it('forgets the chat when a different user is bound (a session that expired, then another sign-in)', () => {
    const store = useAssistantStore()
    store.bindUser('u1')
    store.chatId = 'ch1'
    store.chat = view([{ id: 'u0', q: 'secret', a: 'answer', r: record() }])
    store.providerId = 'p1'
    store.bindUser('u2')
    expect([store.chatId, store.chat, store.live, store.providerId]).toEqual([null, null, null, null])
    // The same user signing in again keeps nothing either way to leak: the binding is theirs.
    store.chatId = 'mine'
    store.bindUser('u2')
    expect(store.chatId).toBe('mine')
  })
})

describe('Important 2: what was sent and what the history left out stay after the answer ends', () => {
  it('keeps them beside the stored turn', async () => {
    const stored = view([
      { id: 'u0', q: 'q', a: 'one', r: record({ history: { sent: 1, leftOut: ['history:rules:1'] } }) },
    ])
    await panel({
      answers: [answer('u0', 'one', { sent: 1, leftOut: ['history:rules:1'] })],
      handlers: { 'GET ai/chats/ch1': () => [200, stored] },
    })
    await send('q')
    await vi.waitFor(() => expect(useAssistantStore().live).toBeNull())
    expect(text()).toContain('Left out of the history: 1 from before a personal-data rule change.')
    expect(text()).toContain('What was sent')
  })
})

describe('Important 3: a turn sent while the previous one is being read back is not lost', () => {
  it('keeps the first turn on screen when the second is refused before it starts', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const one = view([{ id: 'u0', q: 'first', a: 'one', r: record() }])
    const { store } = await panel({
      answers: [answer('u0', 'one'), 'refused'],
      handlers: {
        'GET ai/chats/ch1': async () => {
          await gate
          return [200, one]
        },
      },
    })
    await send('first')
    expect(store.busy).toBe(false)
    await send('second')
    release()
    await flushPromises()
    expect(text()).toContain('one')
    expect(text()).toContain('This chat is still answering.')
    expect(document.querySelectorAll('[data-turn]')).toHaveLength(2)
  })
})

describe('Important 4: every answer is announced', () => {
  it('announces the second answer too', async () => {
    const seen: string[] = []
    const { store } = await panel({
      answers: [answer('u0', 'one'), answer('u1', 'two')],
      handlers: {
        'GET ai/chats/ch1': () => [200, view([{ id: 'u0', q: 'a', a: 'one', r: record() }])],
      },
    })
    const status = document.querySelector('[role="status"]')!
    new MutationObserver(() => seen.push(status.textContent ?? '')).observe(status, {
      childList: true,
      characterData: true,
      subtree: true,
    })
    await send('a')
    await send('b')
    await flushPromises()
    expect(store.busy).toBe(false)
    expect(seen.filter((s) => s === 'The answer is ready.').length).toBe(2)
  })
})

describe('Minor 5: the privacy line says how long chats are kept', () => {
  for (const [days, words] of [
    [30, 'for 30 days after their last message'],
    [1, 'for 1 day after their last message'],
    [0, 'in the server’s memory only, for 12 hours'],
  ] as const)
    it(`with ${days} days`, async () => {
      mockApi({ 'GET ai/providers': () => [200, []], 'GET ai/status': () => [200, STATUS(days)] })
      mountApp(AiSettingsView)
      await flushPromises()
      expect(text()).toContain(words)
    })
})

describe('Minor 6: the new reason has words', () => {
  it('says an earlier message keeps the chat local', () => {
    let words!: ReturnType<typeof useAiWords>
    mountApp({ setup: () => ((words = useAiWords()), () => null) })
    expect(words.reason('history_local')).toContain('stays with local providers')
    i18n.global.locale.value = 'tr'
    expect(words.reason('history_local')).toContain('yalnızca yerel')
  })
})

describe('Minor 7: code from a turn whose connection is gone', () => {
  it('says so instead of opening a tab for nothing', async () => {
    const block: AiChatBlock = { index: 0, result: { kind: 'query', filter: {} }, warnings: [] }
    const { tabs, tabId } = await panel({
      handlers: {
        'GET ai/chats/ch1': () => [
          200,
          view([
            {
              id: 'u0',
              q: 'q',
              a: '```json\n{}\n```',
              r: record({ connectionId: 'gone', sources: [{ connectionId: 'gone', rulesVersion: 0 }] }),
              blocks: [block],
            },
          ]),
        ],
      },
    })
    await useAssistantStore().openChat('ch1')
    await flushPromises()
    button('Run').click()
    await flushPromises()
    expect(text()).toContain('The connection this message was about no longer exists.')
    expect(tabs.active!.id).toBe(tabId)
  })
})

describe('Minor 8: chats can be deleted from the account page, AI right or not', () => {
  it('deletes all my chats after asking', async () => {
    const { calls } = mockApi({ 'DELETE ai/chats': () => [200, { removed: 2 }] })
    useSessionStore().status = { mode: 'local' } as never
    mountApp(AccountView)
    mountApp(DialogHost)
    mountApp(ToastHost)
    await flushPromises()
    button('Delete my AI chats').click()
    await flushPromises()
    useDialogStore().settle(true)
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE' && c.path === 'ai/chats')).toBe(true)
    expect(text()).toContain('2 chats deleted.')
  })
})

describe('Minor 11: History renames any chat and counts days in words', () => {
  it('renames a chat from its row', async () => {
    const { calls } = await panel({
      status: STATUS(1),
      handlers: {
        'GET ai/chats': () => [
          200,
          [{ id: 'ch2', title: 'Shards', namespace: null, messages: 2, updatedAt: Date.now() }],
        ],
        'PATCH ai/chats/ch2': () => [200, { id: 'ch2', title: 'Keys' }],
      },
    })
    labelled('History').click()
    await flushPromises()
    expect(text()).toContain('1 day after their last message')
    expect(text()).toContain('16 MB')
    labelled('Rename Shards').click()
    await flushPromises()
    const dialogs = useDialogStore()
    dialogs.current!.value = 'Keys'
    dialogs.settle(true)
    await flushPromises()
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({
      path: 'ai/chats/ch2',
      body: { title: 'Keys' },
    })
  })
})

describe('Minor 12 and 13: Retry keeps the draft and the failed turn’s collection', () => {
  it('sends the failed words about their own collection, leaving what is being typed', async () => {
    const failed = view([
      { id: 'u0', q: 'about orders', a: '', r: record({ state: 'error', reason: 'timeout' }) },
    ])
    const { turns } = await panel({
      coll: 'other',
      answers: [[]],
      handlers: { 'GET ai/chats/ch1': () => [200, failed] },
    })
    await useAssistantStore().openChat('ch1')
    await flushPromises()
    await typeInto(composer(), 'half a thought')
    button('Try again').click()
    await flushPromises()
    expect(turns[0]!.url).toMatch(/collections\/orders\/ai\/chat$/)
    expect(turns[0]!.body).toMatchObject({ message: 'about orders', retry: true })
    expect(composer().value).toBe('half a thought')
  })
})

describe('Minor 14: Stop before the server named the turn still reads the chat back', () => {
  it('reads the open chat after a stop', async () => {
    const { calls, store } = await panel({
      answers: ['silent'],
      handlers: { 'GET ai/chats/ch1': () => [200, view([{ id: 'u0', q: 'q', a: '', r: record() }])] },
    })
    await store.openChat('ch1')
    await flushPromises()
    const before = calls.filter((c) => c.path === 'ai/chats/ch1').length
    await typeInto(composer(), 'x')
    composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await nextTick()
    button('Stop').click()
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.path === 'ai/chats/ch1').length).toBeGreaterThan(before),
    )
  })
})

describe('Minor 15: focus and keys', () => {
  it('gives focus back to the floating button when it closes', async () => {
    const toggle = document.createElement('button')
    toggle.id = 'assistant-toggle'
    document.body.append(toggle)
    await panel()
    labelled('Close the assistant').click()
    await flushPromises()
    expect(document.activeElement).toBe(toggle)
  })

  it('closes the window with Escape (a narrow one too)', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('max-width'),
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }))
    const { store } = await panel()
    composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(store.open).toBe(false)
  })

  it('opens with Mod+. also where "." needs Shift', async () => {
    mockApi({
      'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [
        200,
        {
          mode: 'team',
          user: { id: 'u1', username: 'ada', role: 'admin' },
          permissions: [...PERMISSIONS],
          csrfToken: 'c',
          readOnly: false,
          twoFactor: { enabled: false, totp: false, passkeys: 0, recoveryCodesRemaining: 0 },
        },
      ],
      'GET connections': () => [200, []],
      'GET ai/status': () => [200, STATUS()],
      'GET ai/chats': () => [200, []],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    mountApp(WorkspaceView, { plugins: [router] })
    await flushPromises()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '.', ctrlKey: true, shiftKey: true }))
    await flushPromises()
    expect(useAssistantStore().open).toBe(true)
  })
})

describe('Minor 16: the width stays within the window', () => {
  it('clamps a width saved on a wider screen', async () => {
    const store = useAssistantStore()
    store.bindUser('u1')
    store.setWidth(5000, 5000)
    await panel()
    // A window over the page now (user report 2026-10-25): the screen less its margins — drawn and
    // said so, the width given kept (third review of the window, M-1).
    const sep = document.querySelector('[role="separator"][aria-orientation="vertical"]')!
    expect(Number(sep.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(window.innerWidth - 32)
    expect(store.width).toBe(5000)
  })
})

describe('Minor 17: a new chat has its title while the first answer streams', () => {
  it('shows the title from the first line', async () => {
    await panel({ answers: ['endless'] })
    await send('orders please')
    expect(document.querySelector('h2')!.textContent).toBe('Orders')
  })
})

describe('Minor 18: the context bar says why a collection’s data does not go', () => {
  it('names a missing right', async () => {
    await panel({ connection: CONN(['documents:read']) })
    expect(text()).toContain(
      'You may not send data from shop.orders to the assistant: this message goes without it.',
    )
  })
})

describe('Minor 19: a failed delete or rename says so', () => {
  it('shows the error of a delete', async () => {
    await panel({
      handlers: {
        'GET ai/chats': () => [
          200,
          [{ id: 'ch2', title: 'Old', namespace: null, messages: 2, updatedAt: Date.now() }],
        ],
        'DELETE ai/chats/ch2': () => [404, { code: 'NOT_FOUND', message: 'Chat not found' }],
      },
    })
    labelled('History').click()
    await flushPromises()
    labelled('Delete Old').click()
    await flushPromises()
    useDialogStore().settle(true)
    await flushPromises()
    expect(text()).toContain('It no longer exists.')
  })
})
