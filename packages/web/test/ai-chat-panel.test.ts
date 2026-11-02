import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import {
  PERMISSIONS,
  type AiChatLine,
  type AiChatTurnRecord,
  type AiChatView,
  type AiStatus,
} from '@mongo-manager/shared'
import AssistantPanel from '../src/ai/chat/AssistantPanel.vue'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import ToastHost from '../src/ds/DsToastHost.vue'
import { createAppRouter } from '../src/router'
import { useAssistantStore } from '../src/ai/chat/store'
import { useTabsStore } from '../src/stores/tabs'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { useDialogStore } from '../src/stores/dialogs'
import { useWorkspaceDialogs } from '../src/stores/workspaceDialogs'
import { i18n } from '../src/i18n'
import { mockApi, mountApp, type Handler } from './support/app'
import { button, byLabel, typeInto } from './support/dom'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const STATUS: AiStatus = {
  enabled: true,
  allowServerJs: false,
  providers: [
    {
      id: 'p1',
      name: 'Claude',
      kind: 'anthropic',
      model: 'claude-sonnet-5',
      local: false,
      samples: true,
      isDefault: true,
    },
  ],
  limits: { perMinute: 10, perDay: 200, perUser: 2, concurrent: 8 },
  chat: { days: 30, chats: 50, messages: 200 },
}
const CONN = (aiPolicy = 'any', exports = true) => ({
  id: 'c1',
  name: 'Prod',
  aiPolicy,
  export: exports,
  permissions: ['documents:read', 'ai:use', 'indexes:write', 'aggregation:run', 'jobs:run'],
  settings: { hosts: [] },
})
const record = (namespace: string | null, state: 'done' | 'error' = 'done'): AiChatTurnRecord => ({
  connectionId: namespace ? 'c1' : null,
  namespace,
  rulesVersion: namespace ? 0 : null,
  sources: namespace ? [{ connectionId: 'c1', rulesVersion: 0 }] : [],
  parts: { schema: !!namespace, current: false, indexes: !!namespace, validator: false, samples: 0 },
  provider: { id: 'p1', name: 'Claude', model: 'claude-sonnet-5', kind: 'anthropic' as const },
  local: false,
  usage: { input: 1, output: 1 },
  state,
  ...(state === 'error' ? { reason: 'timeout' } : {}),
})
const QUERY_ANSWER =
  'First Python:\n```python\nprint(1)\n```\nThen:\n```json\n{ "filter": { "qty": { "$gt": 5 } } }\n```'
const chatView = (
  pairs: Array<[string, string, ReturnType<typeof record>, AiChatView['messages'][number]['blocks']?]>,
  full = false,
): AiChatView => ({
  id: 'ch1',
  title: 'Orders',
  full,
  messages: pairs.flatMap(([q, a, r, blocks], i) => [
    { id: `u${i}`, role: 'user' as const, text: q, createdAt: i, turn: r },
    { id: `a${i}`, role: 'assistant' as const, text: a, createdAt: i, blocks: blocks ?? [] },
  ]),
})
const QUERY_BLOCKS = [
  {
    index: 1,
    result: { kind: 'query' as const, filter: { qty: { $gt: { $numberInt: '5' } } } },
    warnings: [],
  },
]

/** The panel beside an open collection tab; `lines` answer a turn. */
async function panel(
  opts: {
    handlers?: Record<string, Handler>
    lines?: AiChatLine[]
    coll?: string
    policy?: string
    exports?: boolean
  } = {},
) {
  const api = mockApi({
    'GET ai/status': () => [200, STATUS],
    'GET connections': () => [200, [CONN(opts.policy, opts.exports ?? true)]],
    'GET ai/chats': () => [200, []],
    ...opts.handlers,
  })
  const bodies: Array<{ url: string; body: unknown }> = []
  const fallback = api.fetchMock.getMockImplementation()!
  api.fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (!String(input).endsWith('/ai/chat')) return fallback(input, init)
    bodies.push({ url: String(input), body: JSON.parse(String(init.body)) })
    const enc = new TextEncoder()
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(enc.encode((opts.lines ?? []).map((l) => JSON.stringify(l)).join('\n')))
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
  return { ...api, bodies, tabs, tabId, store }
}
const composer = () => byLabel<HTMLTextAreaElement>('Message the assistant')
/** An icon button, by its accessible name. */
const labelled = (name: string) => {
  const found = document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)
  if (!found) throw new Error(`No button labelled "${name}"`)
  return found
}
/** A button whose text starts with `text` (a list row also shows its collection and time). */
const starting = (text: string) => {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(text))
  if (!found) throw new Error(`No button starting "${text}"`)
  return found
}
const enter = (el: HTMLElement, init: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }))

describe('the Assistant panel (phase 4a-2 spec §5)', () => {
  it('names the active collection and sends its parts and current query on Enter', async () => {
    const { bodies, tabId } = await panel({ lines: [] })
    useCollectionViewsStore().stateFor(tabId).draft.filter = '{ qty: { $gt: 5 } }'
    await nextTick()
    expect(document.body.textContent).toContain('shop.orders on Prod')
    await typeInto(composer(), 'why so slow?')
    enter(composer(), { shiftKey: true })
    enter(composer(), { isComposing: true })
    await flushPromises()
    expect(bodies).toHaveLength(0)
    enter(composer())
    await flushPromises()
    expect(bodies[0]!.url).toMatch(/connections\/c1\/databases\/shop\/collections\/orders\/ai\/chat$/)
    expect(bodies[0]!.body).toMatchObject({
      message: 'why so slow?',
      language: 'en',
      provider: 'p1',
      parts: { current: true, indexes: true, validator: false },
      current: { filter: { qty: { $gt: { $numberInt: '5' } } } },
    })
  })

  it('sends a question asked from the palette or the home page at once (user report 2026-10-10)', async () => {
    // Asked before the panel was there: it opens, and the question goes as soon as it can.
    useAssistantStore().ask('which orders are late?')
    const { bodies, store } = await panel({ lines: [] })
    await flushPromises()
    expect(bodies).toHaveLength(1)
    expect(bodies[0]!.body).toMatchObject({ message: 'which orders are late?', provider: 'p1' })
    expect(composer().value).toBe('')
    // And again, with the panel open.
    store.ask('and the early ones?')
    await flushPromises()
    await flushPromises()
    expect(bodies.map((b) => (b.body as { message: string }).message)).toEqual([
      'which orders are late?',
      'and the early ones?',
    ])
  })

  it('keeps a question it cannot send in the composer, saying why (no provider)', async () => {
    useAssistantStore().ask('which orders are late?')
    const { bodies } = await panel({
      handlers: { 'GET ai/status': () => [200, { ...STATUS, providers: [] }] },
    })
    await flushPromises()
    expect(bodies).toHaveLength(0)
    expect(composer().value).toBe('which orders are late?')
  })

  it('sends a general turn when the connection’s assistant is off, and says so', async () => {
    const { bodies } = await panel({ policy: 'off' })
    expect(document.body.textContent).toContain('The assistant is off for Prod')
    await typeInto(composer(), 'what is a shard key?')
    enter(composer())
    await flushPromises()
    expect(bodies[0]!.url).toMatch(/\/api\/ai\/chat$/)
    expect(bodies[0]!.body).not.toHaveProperty('parts')
  })

  it('puts each action under its own block', async () => {
    await panel({
      handlers: {
        'GET ai/chats/ch1': () => [200, chatView([['q', QUERY_ANSWER, record('shop.orders'), QUERY_BLOCKS]])],
      },
    })
    await useAssistantStore().openChat('ch1')
    await flushPromises()
    const blocks = [...document.querySelectorAll('[data-code-block]')]
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.querySelector('[data-block-actions]')).toBeNull()
    expect(blocks[1]!.querySelector('[data-block-actions]')!.textContent).toContain('Run')
  })

  it('runs in the turn’s own collection, opening its tab', async () => {
    const { tabs } = await panel({
      coll: 'other',
      handlers: {
        'GET ai/chats/ch1': () => [200, chatView([['q', QUERY_ANSWER, record('shop.orders'), QUERY_BLOCKS]])],
      },
    })
    await useAssistantStore().openChat('ch1')
    await flushPromises()
    button('Run').click()
    await flushPromises()
    expect(tabs.active!.params).toMatchObject({ db: 'shop', coll: 'orders' })
    const state = useCollectionViewsStore().stateFor(tabs.active!.id)
    expect(state.draft.filter).toContain('qty')
    expect(state.query.filter).toEqual({ qty: { $gt: { $numberInt: '5' } } })
  })

  // Review of fa862922 (I1): connection names go too (collections or not); what was sent says so.
  it('says the connection names sent with a general turn, with or without collections', async () => {
    await panel({
      handlers: {
        'GET ai/chats/ch1': () => [
          200,
          chatView([
            ['first', 'a', { ...record(null), catalogue: 0, connectionNames: 2 }],
            ['second', 'b', { ...record(null), catalogue: 5, connectionNames: 3 }],
          ]),
        ],
      },
    })
    await useAssistantStore().openChat('ch1')
    await flushPromises()
    expect(document.body.textContent).toContain('Sent: your words and the names of 2 connections (no data)')
    expect(document.body.textContent).toContain(
      'Sent: your words and names only (no data) — connections: 3, collections: 5',
    )
    expect(document.body.textContent).not.toContain('Sent: your words only')
  })

  // Fifth review of the connection names (M5): a turn about a collection says the names went too.
  it('says the connection names sent with a turn about a collection', async () => {
    await panel({
      handlers: {
        'GET ai/chats/ch1': () => [
          200,
          chatView([['q', 'a', { ...record('shop.orders'), connectionNames: 3 }]]),
        ],
      },
    })
    await useAssistantStore().openChat('ch1')
    await flushPromises()
    expect(document.body.textContent).toContain('the names of 3 connections')
  })

  // Third review of the connection names (M-1): an agent turn answered as the plain assistant (its
  // model cannot call tools) says what went as a general turn does.
  it('says what an agent turn answered as the plain assistant sent', async () => {
    await panel({
      handlers: {
        'GET ai/chats/ch1': () => [
          200,
          chatView([
            [
              'q',
              'a',
              {
                ...record(null),
                catalogue: 5,
                connectionNames: 3,
                agent: { steps: [], connections: 3, documents: false, fallback: true },
              },
            ],
          ]),
        ],
      },
    })
    await useAssistantStore().openChat('ch1')
    await flushPromises()
    expect(document.body.textContent).toContain(
      'Sent: your words and names only (no data) — connections: 3, collections: 5',
    )
  })

  describe('a query naming its collection (user request 2026-10-10: run it from anywhere)', () => {
    const target = { connectionId: 'c1', db: 'shop', coll: 'orders' }
    const named = () => [{ ...QUERY_BLOCKS[0]!, target }]

    it('runs a general turn’s query in the collection it names, opening that collection', async () => {
      const { tabs } = await panel({
        handlers: {
          'GET ai/chats/ch1': () => [
            200,
            chatView([['q', QUERY_ANSWER, { ...record(null), catalogue: 5 }, named()]]),
          ],
        },
      })
      tabs.close(tabs.active!.id)
      await useAssistantStore().openChat('ch1')
      await flushPromises()
      expect(document.querySelector('[data-block-target]')!.textContent).toContain('Prod · shop.orders')
      // What was sent says so: the words, and collection names — no data.
      expect(document.body.textContent).toContain(
        'Sent: your words and the names of 5 collections with their connections (no data)',
      )
      button('Run').click()
      await flushPromises()
      expect(tabs.active!.params).toMatchObject(target)
      const state = useCollectionViewsStore().stateFor(tabs.active!.id)
      expect(state.section).toBe('documents')
      expect(state.query.filter).toEqual({ qty: { $gt: { $numberInt: '5' } } })
      expect(state.draft.filter).toContain('qty')
    })

    it('asks before running a query that uses server JavaScript, and runs nothing on No (review I5)', async () => {
      const { tabs } = await panel({
        handlers: {
          'GET ai/chats/ch1': () => [
            200,
            chatView([
              ['q', QUERY_ANSWER, record(null), [{ ...QUERY_BLOCKS[0]!, target, warnings: ['server_js'] }]],
            ]),
          ],
        },
      })
      await useAssistantStore().openChat('ch1')
      await flushPromises()
      button('Run').click()
      await flushPromises()
      expect(document.body.textContent).toContain('This code runs JavaScript on the MongoDB server')
      ;(document.querySelector('[data-test="cancel"]') as HTMLButtonElement).click()
      await flushPromises()
      expect(useCollectionViewsStore().stateFor(tabs.active!.id).query.filter).toEqual({})
    })

    it('says so when the collection a query names is on a connection since removed', async () => {
      const { tabs } = await panel({
        handlers: {
          'GET ai/chats/ch1': () => [
            200,
            chatView([
              [
                'q',
                QUERY_ANSWER,
                record(null),
                [{ ...QUERY_BLOCKS[0]!, target: { ...target, connectionId: 'gone' } }],
              ],
            ]),
          ],
        },
      })
      const open = tabs.active!.id
      await useAssistantStore().openChat('ch1')
      await flushPromises()
      button('Run').click()
      await flushPromises()
      expect(document.body.textContent).toContain('The connection this message was about no longer exists.')
      expect(tabs.active!.id).toBe(open)
      expect(useCollectionViewsStore().stateFor(open).query.filter).toEqual({})
    })

    it('never runs a query naming a collection it was not given in the open one (review I3)', async () => {
      const { tabs } = await panel({
        handlers: {
          'GET ai/chats/ch1': () => [
            200,
            chatView([
              ['q', QUERY_ANSWER, record(null), [{ ...QUERY_BLOCKS[0]!, unresolved: true as const }]],
            ]),
          ],
        },
      })
      const open = tabs.active!.id
      await useAssistantStore().openChat('ch1')
      await flushPromises()
      button('Run').click()
      await flushPromises()
      expect(document.body.textContent).toContain('names a collection the assistant was not given')
      expect(tabs.active!.id).toBe(open)
      expect(useCollectionViewsStore().stateFor(open).query.filter).toEqual({})
    })

    it('asks before replacing the query bar’s work, and keeps its other parts (review I5)', async () => {
      const { tabs } = await panel({
        handlers: {
          'GET ai/chats/ch1': () => [200, chatView([['q', QUERY_ANSWER, record(null), named()]])],
        },
      })
      const state = useCollectionViewsStore().stateFor(tabs.active!.id)
      state.draft = { ...state.draft, filter: '{ a: 1 }', collation: '{ locale: "tr" }' }
      await useAssistantStore().openChat('ch1')
      await flushPromises()
      button('Run').click()
      await flushPromises()
      ;(document.querySelector('[data-test="cancel"]') as HTMLButtonElement).click()
      await flushPromises()
      expect(state.draft.filter).toBe('{ a: 1 }')
      expect(state.query.filter).toEqual({})
      button('Run').click()
      await flushPromises()
      ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
      await flushPromises()
      expect(state.query.filter).toEqual({ qty: { $gt: { $numberInt: '5' } } })
      expect(state.query.collation).toEqual({ locale: 'tr' })
    })

    it('creates a suggested index in the collection the block names (review I4)', async () => {
      const { calls } = await panel({
        handlers: {
          'GET ai/chats/ch1': () => [
            200,
            chatView([
              [
                'q',
                'Index:\n```json\n{ "indexes": [{ "keys": { "qty": 1 } }] }\n```',
                record(null),
                [
                  {
                    index: 0,
                    result: {
                      kind: 'optimise' as const,
                      indexes: [{ keys: { qty: { $numberInt: '1' } }, options: {} }],
                    },
                    warnings: [],
                    target: { connectionId: 'c1', db: 'shop', coll: 'other' },
                  },
                ],
              ],
            ]),
          ],
        },
      })
      await useAssistantStore().openChat('ch1')
      await flushPromises()
      starting('Create index').click()
      await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
      button('Create').click()
      await vi.waitFor(() =>
        expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/collections/other/indexes'))).toBe(
          true,
        ),
      )
    })

    it('runs a collection turn’s query in its own collection', async () => {
      const { tabs } = await panel({
        coll: 'other',
        handlers: {
          'GET ai/chats/ch1': () => [
            200,
            chatView([['q', QUERY_ANSWER, record('shop.orders'), QUERY_BLOCKS]]),
          ],
        },
      })
      await useAssistantStore().openChat('ch1')
      await flushPromises()
      button('Run').click()
      await flushPromises()
      expect(tabs.active!.params).toMatchObject(target)
      expect(useCollectionViewsStore().stateFor(tabs.active!.id).query.filter).toEqual({
        qty: { $gt: { $numberInt: '5' } },
      })
    })
  })

  it('says a general turn’s code needs a collection tab when none is active', async () => {
    const { tabs } = await panel({
      handlers: {
        'GET ai/chats/ch1': () => [200, chatView([['q', QUERY_ANSWER, record(null), QUERY_BLOCKS]])],
      },
    })
    tabs.close(tabs.active!.id)
    await useAssistantStore().openChat('ch1')
    await flushPromises()
    button('Run').click()
    await flushPromises()
    expect(document.body.textContent).toContain('Open a collection tab to use this.')
  })

  it('says what was left out of the history, and what was sent', async () => {
    await panel({
      lines: [
        { type: 'chat', id: 'ch1', title: 't', turn: 'u0' },
        {
          type: 'context',
          sent: {
            namespace: 'shop.orders',
            schema: { sampled: 1, count: 1, more: 0, fields: [] },
            current: null,
            plan: null,
            indexes: [],
            validator: null,
            samples: [],
            leftOut: [],
          },
          provider: { id: 'p1', name: 'Claude', model: 'claude-sonnet-5', kind: 'anthropic' },
          history: { sent: 1, leftOut: ['history:rules:1', 'history:local:2'] },
        },
        { type: 'text', delta: 'Hi' },
      ],
      handlers: { 'GET ai/chats/ch1': () => [404, { code: 'NOT_FOUND', message: 'x' }] },
    })
    await typeInto(composer(), 'x')
    enter(composer())
    await flushPromises()
    expect(document.body.textContent).toContain(
      'Left out of the history: 1 from before a personal-data rule change, 2 from or naming connections that stay with local providers (local-only, or since deleted).',
    )
    expect(document.body.textContent).toContain('What was sent')
  })

  it('offers Retry on a failed last turn and sends it again in its place', async () => {
    const { bodies } = await panel({
      lines: [],
      handlers: { 'GET ai/chats/ch1': () => [200, chatView([['ask', '', record('shop.orders', 'error')]])] },
    })
    await useAssistantStore().openChat('ch1')
    await flushPromises()
    expect(document.body.textContent).toContain('The provider took too long to answer.')
    button('Try again').click()
    await flushPromises()
    expect(bodies[0]!.body).toMatchObject({ chat: 'ch1', message: 'ask', retry: true })
  })

  it('says nothing left the server for a stored refused turn, and claims nothing was sent', async () => {
    const view = chatView([
      ['ask', '', { ...record('shop.orders', 'error'), reason: 'address_refused', nothingSent: true }],
    ])
    await panel({ handlers: { 'GET ai/chats/ch1': () => [200, view] } })
    await useAssistantStore().openChat('ch1')
    await flushPromises()
    expect(document.body.textContent).toContain('Nothing left the server.')
    expect(document.body.textContent).not.toContain('Sent:')
  })

  it('says how long ago each chat in History was used', async () => {
    const list = [
      {
        id: 'ch1',
        title: 'Orders',
        namespace: 'shop.orders',
        messages: 2,
        updatedAt: Date.now() - 2 * 86_400_000,
      },
    ]
    await panel({ handlers: { 'GET ai/chats': () => [200, list] } })
    labelled('History').click()
    await flushPromises()
    expect(document.body.textContent).toContain('2 days ago')
  })

  it('shows an unreadable message and a full chat in words', async () => {
    const view = chatView([['q', 'a', record('shop.orders')]], true)
    view.messages[1]!.text = null
    await panel({ handlers: { 'GET ai/chats/ch1': () => [200, view] } })
    await useAssistantStore().openChat('ch1')
    await flushPromises()
    expect(document.body.textContent).toContain('This message cannot be read')
    expect(document.body.textContent).toContain('This chat is full (200 messages).')
    expect(button('Send').disabled).toBe(true)
  })

  it('opens Make it faster for "Why is this query slow?" when there is a query', async () => {
    const { tabId } = await panel()
    useCollectionViewsStore().stateFor(tabId).draft.filter = '{ qty: 1 }'
    await nextTick()
    button('Why is this query slow?').click()
    await flushPromises()
    expect(useWorkspaceDialogs().current).toMatchObject({ kind: 'ai', actions: ['optimise', 'explain'] })
    expect(useCollectionViewsStore().stateFor(tabId).section).toBe('explain')
  })

  it('resizes by keyboard within its bounds', async () => {
    const { store } = await panel()
    const sep = document.querySelector<HTMLElement>('[role="separator"]')!
    const width = store.width
    sep.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(store.width).toBe(width + 16)
    for (let i = 0; i < 100; i++)
      sep.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(store.width).toBe(320)
    await nextTick()
    expect(sep.getAttribute('aria-valuenow')).toBe('320')
  })

  it('reads the list again each time History opens (chats made in another tab show up)', async () => {
    let reads = 0
    await panel({ handlers: { 'GET ai/chats': () => [200, (reads++, [])] } })
    const before = reads
    labelled('History').click()
    await flushPromises()
    expect(reads).toBe(before + 1)
  })

  it('lists, filters, opens, renames and deletes chats from History', async () => {
    const list = [
      { id: 'ch1', title: 'Orders by status', namespace: 'shop.orders', messages: 4, updatedAt: Date.now() },
      { id: 'ch2', title: 'Shard keys', namespace: null, messages: 2, updatedAt: Date.now() - 86_400_000 },
    ]
    const { calls } = await panel({
      handlers: {
        'GET ai/chats': () => [200, list],
        'GET ai/chats/ch2': () => [
          200,
          { ...chatView([['s', 'a', record(null)]]), id: 'ch2', title: 'Shard keys' },
        ],
        'PATCH ai/chats/ch2': () => [200, { id: 'ch2', title: 'Keys' }],
        'DELETE ai/chats/ch1': () => [204],
        'DELETE ai/chats': () => [200, { removed: 1 }],
      },
    })
    labelled('History').click()
    await flushPromises()
    expect(document.body.textContent).toContain(
      'Chats are kept encrypted, for you only, 30 days after their last message',
    )
    await typeInto(document.querySelector<HTMLInputElement>('input[aria-label="Filter chats"]')!, 'shard')
    expect(document.body.textContent).not.toContain('Orders by status')
    starting('Shard keys').click()
    await flushPromises()
    expect(useAssistantStore().chatId).toBe('ch2')
    const dialogs = useDialogStore()
    labelled('Rename').click()
    await flushPromises()
    dialogs.current!.value = 'Keys'
    dialogs.settle(true)
    await flushPromises()
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ title: 'Keys' })
    labelled('History').click()
    await flushPromises()
    ;(document.querySelector('button[aria-label="Delete Orders by status"]') as HTMLButtonElement).click()
    await flushPromises()
    dialogs.settle(true)
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE' && c.path === 'ai/chats/ch1')).toBe(true)
  })
})

describe('the panel in the workspace (spec §5)', () => {
  const ME = {
    mode: 'team',
    user: { id: 'u1', username: 'ada', role: 'admin' },
    permissions: [...PERMISSIONS],
    csrfToken: 'csrf-1',
    readOnly: false,
    twoFactor: { enabled: false, totp: false, passkeys: 0, recoveryCodesRemaining: 0 },
  }
  async function workspace() {
    mockApi({
      'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [200, ME],
      'GET connections': () => [200, []],
      'GET ai/status': () => [200, STATUS],
      'GET ai/chats': () => [200, []],
      'GET library': () => [200, []],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    mountApp(WorkspaceView, { plugins: [router] })
    await flushPromises()
  }

  it('opens with its floating button and Mod+. (the Library is a page)', async () => {
    await workspace()
    const assistant = useAssistantStore()
    // User report 2026-10-25: a button floating over the page, not in the header.
    const toggle = document.getElementById('assistant-toggle')!
    expect(toggle.closest('[data-region="topbar"]')).toBeNull()
    toggle.click()
    await flushPromises()
    expect(document.querySelector('[role="complementary"][aria-label="Assistant"]')).not.toBeNull()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '.', ctrlKey: true }))
    await flushPromises()
    expect(assistant.open).toBe(false)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '.', ctrlKey: true }))
    await flushPromises()
    expect(assistant.open).toBe(true)
    // Opening the Queries page leaves the assistant where it is.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'L', ctrlKey: true, shiftKey: true }))
    await flushPromises()
    expect(assistant.open).toBe(true)
    expect(JSON.parse(localStorage.getItem('mm.assistant.u1')!)).toMatchObject({ open: true })
  })
})

// User report 2026-10-13: "çok karışık 3 adet buton var kullanıcı hangisini kullanacak" — one action under
// each block, Run taking a query or a pipeline to its collection and running it; a file asked for is
// offered as its export.
describe('one action under each block', () => {
  const target = { connectionId: 'c1', db: 'shop', coll: 'orders' }
  const fence = (code: string) => '```json\n' + code + '\n```'
  const ANSWER = [
    fence('{ "filter": {} }'),
    fence('[{ "$match": {} }]'),
    fence('{ "$jsonSchema": {} }'),
    fence('[{ "$match": {} }]'),
    fence('{ "filter": {} }'),
  ].join('\n')
  const STAGES = [{ $match: {} }]
  const BLOCKS = [
    { index: 0, result: { kind: 'query' as const, filter: {} }, warnings: [], target },
    { index: 1, result: { kind: 'pipeline' as const, stages: STAGES }, warnings: [], target },
    { index: 2, result: { kind: 'validation' as const, validator: { $jsonSchema: {} } }, warnings: [] },
    {
      index: 3,
      result: { kind: 'pipeline' as const, stages: STAGES },
      warnings: [],
      target,
      export: 'xlsx' as const,
    },
    {
      index: 4,
      result: {
        kind: 'query' as const,
        filter: {},
        projection: { a: { $numberInt: '1' } },
        sort: { b: { $numberInt: '-1' } },
      },
      warnings: [],
      target,
      export: 'json' as const,
    },
  ]
  async function open() {
    const p = await panel({
      handlers: { 'GET ai/chats/ch1': () => [200, chatView([['q', ANSWER, record(null), BLOCKS]])] },
    })
    await useAssistantStore().openChat('ch1')
    await flushPromises()
    return p
  }
  const actions = () =>
    [...document.querySelectorAll('[data-block-actions]')].map((a) =>
      [...a.querySelectorAll('button')].map((b) => b.textContent!.trim()),
    )
  const press = (block: number) =>
    document.querySelectorAll('[data-block-actions]')[block]!.querySelector('button')!.click()

  it('offers Run for a query and a pipeline, the validator its draft, a file its download', async () => {
    await open()
    expect(actions()).toEqual([
      ['Run'],
      ['Run'],
      ['Put in the validator draft'],
      ['Download as Excel'],
      ['Download as JSON'],
    ])
  })

  it('runs a pipeline in the collection it names, from anywhere, its results shown', async () => {
    const { tabs } = await open()
    tabs.close(tabs.active!.id)
    await flushPromises()
    press(1)
    await flushPromises()
    expect(tabs.active!.params).toMatchObject(target)
    const state = useCollectionViewsStore().stateFor(tabs.active!.id)
    expect(state.section).toBe('aggregations')
    expect(state.aggregation.cards.map((c) => c.operator)).toEqual(['$match'])
    expect(state.aggregation.runOnArrival).toBe('[["$match","{}",true]]')
  })

  it('runs nothing when the pipeline already there is kept', async () => {
    const { tabs, tabId } = await open()
    const agg = useCollectionViewsStore().stateFor(tabId).aggregation
    agg.cards = [{ id: 'k', operator: '$limit', text: '5', enabled: true, collapsed: false }]
    press(1)
    await flushPromises()
    useDialogStore().settle(false)
    await flushPromises()
    expect(tabs.active!.id).toBe(tabId)
    expect(agg.cards.map((c) => c.operator)).toEqual(['$limit'])
    expect(agg.runOnArrival).toBeNull()
  })

  it('opens the export of a block asked for as a file, in its collection and format', async () => {
    await open()
    press(3)
    await flushPromises()
    expect(useWorkspaceDialogs().current).toEqual({
      kind: 'exportData',
      ...target,
      stages: STAGES,
      format: 'xlsx',
    })
    useWorkspaceDialogs().close()
    press(4)
    await flushPromises()
    expect(useWorkspaceDialogs().current).toEqual({
      kind: 'exportData',
      ...target,
      query: { filter: {}, projection: { a: { $numberInt: '1' } }, sort: { b: { $numberInt: '-1' } } },
      format: 'json',
    })
  })

  // Review 2026-10-13 (I3, M3): a file of code using server JavaScript is asked about first, as Run is —
  // the export counts its documents as soon as it opens.
  it('asks before opening the export of code that uses server JavaScript', async () => {
    const js = [{ ...BLOCKS[4]!, index: 0, warnings: ['server_js' as const] }]
    await panel({
      handlers: {
        'GET ai/chats/ch1': () => [200, chatView([['q', fence('{ "filter": {} }'), record(null), js]])],
      },
    })
    await useAssistantStore().openChat('ch1')
    await flushPromises()
    press(0)
    await flushPromises()
    expect(document.body.textContent).toContain(i18n.global.t('ai.chat.block.serverJsExport'))
    useDialogStore().settle(false)
    await flushPromises()
    expect(useWorkspaceDialogs().current).toBeNull()
    press(0)
    await flushPromises()
    useDialogStore().settle(true)
    await flushPromises()
    expect(useWorkspaceDialogs().current).toMatchObject({ kind: 'exportData', format: 'json' })
  })

  // Review 2026-10-13 (M3): a pipeline that writes is only put in the builder, so nothing is asked.
  it('puts a writing pipeline in the builder without asking, to run there', async () => {
    const write = [
      {
        index: 0,
        result: { kind: 'pipeline' as const, stages: [{ $match: {} }, { $out: 'copy' }] },
        warnings: ['write_stage' as const, 'server_js' as const],
        target,
      },
    ]
    const { tabs } = await panel({
      handlers: {
        'GET ai/chats/ch1': () => [200, chatView([['q', fence('[{ "$match": {} }]'), record(null), write]])],
      },
    })
    await useAssistantStore().openChat('ch1')
    await flushPromises()
    press(0)
    await flushPromises()
    expect(document.body.textContent).not.toContain(i18n.global.t('ai.chat.block.serverJsTitle'))
    const agg = useCollectionViewsStore().stateFor(tabs.active!.id).aggregation
    expect(agg.cards.map((c) => c.operator)).toEqual(['$match', '$out'])
    expect(agg.runOnArrival).toBeNull()
  })

  it('asks before running a pipeline that uses server JavaScript, in words for code', async () => {
    const js = [{ ...BLOCKS[1]!, index: 0, warnings: ['server_js' as const] }]
    const { tabs } = await panel({
      handlers: {
        'GET ai/chats/ch1': () => [200, chatView([['q', fence('[{ "$match": {} }]'), record(null), js]])],
      },
    })
    await useAssistantStore().openChat('ch1')
    await flushPromises()
    press(0)
    await flushPromises()
    expect(document.body.textContent).toContain(i18n.global.t('ai.chat.block.serverJsRun'))
    expect(i18n.global.t('ai.chat.block.serverJsRun')).toMatch(/^This code runs JavaScript/)
    useDialogStore().settle(true)
    await flushPromises()
    expect(useCollectionViewsStore().stateFor(tabs.active!.id).aggregation.runOnArrival).not.toBeNull()
  })

  it.each([
    ['jobs:run', 4],
    ['aggregation:run', 3],
  ])('says so instead of opening an export without the right %s', async (missing, block) => {
    const conn = CONN()
    await panel({
      handlers: {
        'GET connections': () => [
          200,
          [{ ...conn, permissions: conn.permissions.filter((p) => p !== missing) }],
        ],
        'GET ai/chats/ch1': () => [200, chatView([['q', ANSWER, record(null), BLOCKS]])],
      },
    })
    await useAssistantStore().openChat('ch1')
    await flushPromises()
    press(block)
    await flushPromises()
    expect(useWorkspaceDialogs().current).toBeNull()
    expect(document.body.textContent).toContain(i18n.global.t('ai.chat.block.exportNotAllowed'))
  })

  // Review 2026-10-13 (M2): no export where the connection allows none — said, not a dialog that fails.
  it('says so instead of opening an export the connection does not allow', async () => {
    await panel({
      exports: false,
      handlers: { 'GET ai/chats/ch1': () => [200, chatView([['q', ANSWER, record(null), BLOCKS]])] },
    })
    await useAssistantStore().openChat('ch1')
    await flushPromises()
    press(3)
    await flushPromises()
    expect(useWorkspaceDialogs().current).toBeNull()
    expect(document.body.textContent).toContain(i18n.global.t('ai.chat.block.exportNotAllowed'))
  })
})
