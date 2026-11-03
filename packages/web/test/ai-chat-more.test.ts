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
import WorkspaceView from '../src/views/WorkspaceView.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import ToastHost from '../src/ds/DsToastHost.vue'
import { createAppRouter } from '../src/router'
import { useAssistantStore } from '../src/ai/chat/store'
import { useTabsStore } from '../src/stores/tabs'
import { useCollectionViewsStore, type ValidationDraft } from '../src/stores/collectionViews'
import { useDialogStore } from '../src/stores/dialogs'
import { useCommandsStore } from '../src/stores/commands'
import { i18n } from '../src/i18n'
import { mockApi, mountApp, type Handler } from './support/app'
import { button, byLabel, typeInto } from './support/dom'

/** Phase 4a-2 gate: the panel's remaining paths (samples, chips, indexes, warnings, Stop, failures). */
beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const PROVIDER = (id: string, name: string, samples = true) => ({
  id,
  name,
  kind: 'openai' as const,
  model: 'm',
  local: true,
  samples,
  isDefault: id === 'p1',
})
const STATUS = (providers = [PROVIDER('p1', 'Local')]): AiStatus => ({
  enabled: true,
  allowServerJs: false,
  providers,
  limits: { perMinute: 10, perDay: 200, perUser: 2, concurrent: 8 },
  chat: { days: 0, chats: 50, messages: 200 },
})
const CONN = {
  id: 'c1',
  name: 'Prod',
  aiPolicy: 'any',
  permissions: ['documents:read', 'ai:use', 'indexes:write'],
  settings: { hosts: [] },
}
const record = (
  state: AiChatTurnRecord['state'] = 'done',
  over: Partial<AiChatTurnRecord> = {},
): AiChatTurnRecord => ({
  connectionId: 'c1',
  namespace: 'shop.orders',
  rulesVersion: 0,
  sources: [{ connectionId: 'c1', rulesVersion: 0 }],
  parts: { schema: true, current: false, indexes: true, validator: false, samples: 2 },
  provider: { id: 'p1', name: 'Local', model: 'm', kind: 'openai' },
  local: true,
  usage: { input: 1, output: 1 },
  state,
  ...(state === 'done' ? {} : { reason: 'aborted' }),
  ...over,
})
const view = (answer: string, blocks: AiChatBlock[], r = record()): AiChatView => ({
  id: 'ch1',
  title: 'Orders',
  full: false,
  messages: [
    { id: 'u0', role: 'user', text: 'q', createdAt: 0, turn: r },
    { id: 'a0', role: 'assistant', text: answer, createdAt: 0, blocks },
  ],
})

async function panel(
  opts: { handlers?: Record<string, Handler>; lines?: AiChatLine[] | 'endless'; status?: AiStatus } = {},
) {
  const api = mockApi({
    'GET ai/status': () => [200, opts.status ?? STATUS()],
    'GET connections': () => [200, [CONN]],
    'GET ai/chats': () => [200, []],
    ...opts.handlers,
  })
  const bodies: unknown[] = []
  const fallback = api.fetchMock.getMockImplementation()!
  api.fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (!String(input).endsWith('/ai/chat')) return fallback(input, init)
    bodies.push(JSON.parse(String(init.body)))
    const enc = new TextEncoder()
    return new Response(
      new ReadableStream({
        start(c) {
          if (opts.lines === 'endless') {
            c.enqueue(enc.encode(`${JSON.stringify({ type: 'chat', id: 'ch1', title: 'q', turn: 'u0' })}\n`))
            init.signal?.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')))
            return
          }
          c.enqueue(enc.encode((opts.lines ?? []).map((l) => JSON.stringify(l)).join('\n')))
          c.close()
        },
      }),
    )
  })
  const tabs = useTabsStore()
  const tabId = tabs.open({
    kind: 'collection',
    title: 'orders',
    params: { connectionId: 'c1', db: 'shop', coll: 'orders' },
  })
  const store = useAssistantStore()
  store.show()
  mountApp(AssistantPanel)
  mountApp(DialogHost)
  mountApp(ToastHost)
  await flushPromises()
  return { ...api, bodies, tabs, tabId, store }
}
const composer = () => document.querySelector<HTMLTextAreaElement>('textarea')!
const enter = () =>
  composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
const labelled = (name: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!

describe('the panel’s parts and samples (phase 4a-2 spec §1.3)', () => {
  it('sends samples for one message only, with their count and the fields to hide', async () => {
    const { bodies } = await panel()
    button('Samples').click()
    await nextTick()
    const count = document.querySelector<HTMLSelectElement>('select[aria-label="Sample count"], select')!
    count.value = '2'
    count.dispatchEvent(new Event('change'))
    await typeInto(
      document.querySelector<HTMLInputElement>('input[aria-label="Hide these fields"], input[placeholder]')!,
      'email, card',
    )
    button('Validator').click()
    button('Indexes').click()
    await typeInto(composer(), 'show me some')
    enter()
    await flushPromises()
    expect(bodies[0]).toMatchObject({
      parts: { current: false, indexes: false, validator: true },
      samples: { count: 2, mask: ['email', 'card'] },
    })
    // Consent is per message: the chip is off again.
    expect(button('Samples').getAttribute('aria-pressed')).toBe('false')
  })

  it('keeps samples off when the provider may not receive them, and says why', async () => {
    await panel({ status: STATUS([PROVIDER('p1', 'Cloud', false)]) })
    expect(button('Samples').disabled).toBe(true)
    expect(document.body.textContent).toContain('This provider may not receive sample documents.')
  })

  it('sends with the provider chosen in the composer', async () => {
    const { bodies } = await panel({ status: STATUS([PROVIDER('p1', 'Local'), PROVIDER('p2', 'Other')]) })
    const select = byLabel<HTMLSelectElement>('Provider')
    select.value = 'p2'
    select.dispatchEvent(new Event('change'))
    await typeInto(composer(), 'hello')
    enter()
    await flushPromises()
    expect(bodies[0]).toMatchObject({ provider: 'p2' })
  })
})

describe('answers in the panel (spec §1.4, §5)', () => {
  it('names warnings, refuses server JavaScript in words, and opens the index dialog filled in', async () => {
    const answer = [
      '```json',
      '[{ "$out": "copy" }]',
      '```',
      '```json',
      '{ "filter": { "$where": "1" } }',
      '```',
      '```json',
      '{ "indexes": [{ "keys": { "qty": 1 } }] }',
      '```',
    ].join('\n')
    await panel({
      handlers: {
        'GET ai/chats/ch1': () => [
          200,
          view(
            answer,
            [
              {
                index: 0,
                result: { kind: 'pipeline', stages: [{ $out: 'copy' }] },
                warnings: ['write_stage'],
              },
              { index: 1, result: null, warnings: [], reason: 'server_js' },
              {
                index: 2,
                result: { kind: 'optimise', indexes: [{ keys: { qty: { $numberInt: '1' } }, options: {} }] },
                warnings: [],
              },
            ],
            record('done', { cut: true }),
          ),
        ],
        'GET connections/c1/databases/shop/collections/orders/indexes': () => [200, []],
      },
    })
    await useAssistantStore().openChat('ch1')
    await flushPromises()
    const text = document.body.textContent!
    expect(text).toContain('Uses server JavaScript, which this server does not allow.')
    expect(text).toContain('This answer was shortened to be kept.')
    expect(text).toContain('2 samples')
    button('Create index qty_1…').click()
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Create index'),
    )
  })

  it('shows the answer as it streams, stops it, and keeps what came', async () => {
    const stopped = view('', [], record('stopped'))
    const { store } = await panel({
      lines: 'endless',
      handlers: { 'GET ai/chats/ch1': () => [200, stopped] },
    })
    await typeInto(composer(), 'long one')
    enter()
    await flushPromises()
    expect(document.body.textContent).toContain('Thinking…')
    button('Stop').click()
    await vi.waitFor(() => expect(store.live).toBeNull(), { timeout: 4000 })
    expect(document.body.textContent).toContain('Stopped.')
    expect(button('Try again')).toBeTruthy()
  })

  it('says when a chat cannot be opened', async () => {
    await panel({ handlers: { 'GET ai/chats/ch1': () => [500, { code: 'INTERNAL', message: 'x' }] } })
    await useAssistantStore().openChat('ch1')
    await flushPromises()
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('This chat could not be opened.')
  })

  it('puts a validator in the draft once the Validation section has loaded it, or says it is not ready', async () => {
    const block: AiChatBlock = {
      index: 0,
      result: { kind: 'validation', validator: { $jsonSchema: { required: ['qty'] } } },
      warnings: [],
    }
    const { tabId } = await panel({
      handlers: {
        'GET ai/chats/ch1': () => [
          200,
          view('```json\n{ "$jsonSchema": { "required": ["qty"] } }\n```', [block]),
        ],
      },
    })
    await useAssistantStore().openChat('ch1')
    await flushPromises()
    vi.useFakeTimers()
    button('Put in the validator draft').click()
    await vi.advanceTimersByTimeAsync(5200)
    vi.useRealTimers()
    await flushPromises()
    expect(document.body.textContent).toContain('The validator draft is not ready yet')
    const state = useCollectionViewsStore().stateFor(tabId)
    expect(state.section).toBe('validation')
    state.validationDraft = {
      text: '',
      level: 'strict',
      action: 'error',
      base: '',
      tested: null,
      testedFor: '',
    } as ValidationDraft
    button('Put in the validator draft').click()
    await flushPromises()
    expect(state.validationDraft.text).toContain('required')
  })
})

describe('the panel’s frame (spec §5)', () => {
  it('resizes by pointer, Home and End, and closes from the composer with Escape', async () => {
    const { store } = await panel()
    const sep = document.querySelector<HTMLElement>('[role="separator"][tabindex="0"]')!
    sep.setPointerCapture = () => undefined
    const at = (type: string, clientX: number) =>
      sep.dispatchEvent(Object.assign(new MouseEvent(type, { clientX, bubbles: true }), { pointerId: 1 }))
    const width = store.width
    at('pointerdown', 600)
    at('pointermove', 560)
    at('pointerup', 560)
    expect(store.width).toBe(width + 40)
    sep.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    expect(store.width).toBe(320)
    sep.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    // A window over the page (user report 2026-10-25): up to the screen less its margins.
    expect(store.width).toBe(Math.max(320, window.innerWidth - 32))
    const toggle = document.createElement('button')
    toggle.id = 'assistant-toggle'
    document.body.append(toggle)
    composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(store.open).toBe(false)
    expect(document.activeElement).toBe(toggle)
  })

  it('fills the message box from a suggestion, and keeps chats in memory only says so', async () => {
    await panel({
      handlers: {
        'GET ai/chats': () => [
          200,
          [{ id: 'ch9', title: 'Old', namespace: null, messages: 2, updatedAt: Date.now() }],
        ],
      },
    })
    button('Find the documents where …').click()
    await nextTick()
    expect(composer().value).toBe('Find the documents where …')
    labelled('History').click()
    await flushPromises()
    expect(document.body.textContent).toContain('kept in the server’s memory only')
    await typeInto(document.querySelector<HTMLInputElement>('input[aria-label="Filter chats"]')!, 'zzz')
    expect(document.body.textContent).toContain('No chat matches.')
  })

  it('deletes every chat from History after asking, and the open one with it', async () => {
    const { calls, store } = await panel({
      handlers: {
        'GET ai/chats': () => [
          200,
          [{ id: 'ch1', title: 'Orders', namespace: 'shop.orders', messages: 2, updatedAt: Date.now() }],
        ],
        'GET ai/chats/ch1': () => [200, view('a', [])],
        'DELETE ai/chats': () => [200, { removed: 1 }],
        'DELETE ai/chats/ch1': () => [204],
      },
    })
    await store.openChat('ch1')
    labelled('History').click()
    await flushPromises()
    labelled('Delete Orders').click()
    await flushPromises()
    useDialogStore().settle(true)
    await flushPromises()
    expect(store.chatId).toBeNull()
    labelled('History').click()
    await flushPromises()
    button('Delete all chats').click()
    await flushPromises()
    useDialogStore().settle(true)
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE' && c.path === 'ai/chats')).toBe(true)
    expect(document.body.textContent).toContain('1 chat deleted.')
  })
})

describe('the palette’s assistant commands (spec §5)', () => {
  it('opens the assistant and starts a new chat', async () => {
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
    const commands = useCommandsStore()
    const assistant = useAssistantStore()
    await commands.commands.find((c) => c.id === 'assistant.open')!.run()
    expect(assistant.open).toBe(true)
    assistant.chatId = 'old'
    await commands.commands.find((c) => c.id === 'assistant.new')!.run()
    expect([assistant.open, assistant.chatId]).toEqual([true, null])
    // The opened panel reads its data before the test ends (fetch is still the stub).
    await flushPromises()
  })
})
