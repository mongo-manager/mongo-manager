import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { AiLine, AiStatus } from '@mongo-manager/shared'
import AiSheet from '../src/ai/AiSheet.vue'
import CollectionTab from '../src/workspace/tabs/CollectionTab.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import WorkspaceDialogs from '../src/workspace/WorkspaceDialogs.vue'
import { actionsFor, insertResult } from '../src/ai/insert'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { useWorkspaceDialogs } from '../src/stores/workspaceDialogs'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, check, typeInto } from './support/dom'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const TAB = 'tab-ai'
const target = { connectionId: 'c1', db: 'shop', coll: 'orders' }
const STATUS = (over: Partial<AiStatus> = {}): AiStatus => ({
  enabled: true,
  allowServerJs: false,
  providers: [
    {
      id: 'p1',
      name: 'Claude',
      kind: 'anthropic',
      model: 'claude-sonnet-5',
      local: false,
      samples: false,
      isDefault: true,
    },
    {
      id: 'p2',
      name: 'Ollama',
      kind: 'ollama',
      model: 'llama3.3',
      local: true,
      samples: true,
      isDefault: false,
    },
  ],
  limits: { perMinute: 10, perDay: 200, perUser: 2, concurrent: 8 },
  ...over,
})
const CONN = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  name: 'Prod',
  aiPolicy: 'any',
  permissions: ['documents:read', 'documents:write', 'ai:use', 'indexes:write', 'databases:write'],
  export: true,
  settings: { hosts: [] },
  ...over,
})
const enc = new TextEncoder()
/** The action's answer as a stream of lines; the request's body is kept. */
function answering(lines: AiLine[]) {
  const seen: { body?: Record<string, unknown> } = {}
  const { fetchMock, calls } = mockApi({
    'GET ai/status': () => [200, STATUS()],
    'GET connections': () => [200, [CONN()]],
  })
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (String(input).endsWith('/ai')) {
      seen.body = JSON.parse(String(init.body))
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(lines.map((l) => JSON.stringify(l)).join('\n')))
            c.close()
          },
        }),
        { status: 200 },
      )
    }
    return fallback(input, init)
  })
  return { seen, calls }
}
const CONTEXT: AiLine = {
  type: 'context',
  sent: {
    namespace: 'shop.orders',
    schema: null,
    current: null,
    plan: null,
    indexes: null,
    validator: null,
    samples: [],
    leftOut: [],
  },
  provider: { id: 'p1', name: 'Claude', model: 'claude-sonnet-5', kind: 'anthropic' },
}
/** Sends and waits for the answer to end (the stream yields to the browser after every line). */
async function send() {
  button('Send').click()
  // Stop shows while the answer comes (after the next render), and goes when it has ended.
  await nextTick()
  button('Stop')
  await vi.waitFor(() => expect(() => button('Stop')).toThrow())
  await flushPromises()
}
const sheet = (actions = ['query', 'explain']) =>
  mountApp(AiSheet, { props: { connectionId: 'c1', db: 'shop', coll: 'orders', tabId: TAB, actions } })

describe('the Ask AI sheet (phase 4a-1 spec §6)', () => {
  it('sends the words and the current query, streams the answer, and inserts the query after asking', async () => {
    const { seen } = answering([
      CONTEXT,
      { type: 'text', delta: 'Orders over **5**:\n```json\n{ "filter": { "qty": { "$gt": 5 } } }\n```' },
      {
        type: 'done',
        result: { kind: 'query', filter: { qty: { $gt: { $numberInt: '5' } } } },
        warnings: [],
        usage: { input: 30, output: 9 },
        local: false,
      },
    ])
    const state = useCollectionViewsStore().stateFor(TAB)
    state.draft.filter = '{ status: "new" }'
    mountApp(DialogHost)
    sheet()
    await flushPromises()
    await typeInto(byLabel<HTMLTextAreaElement>('What do you need?'), 'orders over five')
    await send()
    expect(seen.body).toMatchObject({
      action: 'query',
      prompt: 'orders over five',
      language: 'en',
      provider: 'p1',
      current: { filter: { status: 'new' } },
    })
    expect(document.body.textContent).toContain('Orders over')
    expect(document.querySelector('[data-ai-answer] strong')?.textContent).toBe('5')
    expect(document.body.textContent).toContain('Cloud')
    button('Insert').click()
    await flushPromises()
    ;[...document.querySelectorAll('[role="dialog"] button')]
      .find((b) => b.textContent?.trim() === 'Replace')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(state.draft.filter).toBe('{ qty: { $gt: 5 } }')
    expect(state.section).toBe('documents')
  })

  it('shows what was sent, the warnings, and a parse failure in words; nothing to insert then', async () => {
    answering([
      {
        ...CONTEXT,
        sent: { ...(CONTEXT as { sent: object }).sent, samples: ['{"note":"x"}'], leftOut: ['samples:1'] },
      } as AiLine,
      { type: 'text', delta: 'No code.' },
      {
        type: 'done',
        result: null,
        warnings: [],
        reason: 'unparsable',
        usage: { input: 1, output: 1 },
        local: null,
      },
    ])
    sheet()
    await flushPromises()
    await typeInto(byLabel<HTMLTextAreaElement>('What do you need?'), 'x')
    await send()
    expect(document.body.textContent).toContain('The answer holds no code the editor can read.')
    expect(document.querySelector('[data-ai-sent]')!.textContent).toContain('note')
    expect(() => button('Insert')).toThrow()
  })

  it('offers samples only for providers that may receive them, and sends the fields to hide', async () => {
    const { seen } = answering([
      CONTEXT,
      { type: 'done', result: null, warnings: [], usage: { input: 1, output: 1 }, local: true },
    ])
    sheet(['describe'])
    await flushPromises()
    expect(byLabel('Include sample documents').disabled).toBe(true)
    expect(document.body.textContent).toContain('This provider may not receive sample documents.')
    const provider = byLabel<HTMLSelectElement>('Provider')
    provider.value = 'p2'
    provider.dispatchEvent(new Event('change'))
    await flushPromises()
    await check(byLabel('Include sample documents'))
    await typeInto(byLabel('Hide these fields'), 'phone, address.street')
    await send()
    expect(seen.body).toMatchObject({
      action: 'describe',
      provider: 'p2',
      samples: { count: 3, mask: ['phone', 'address.street'] },
    })
  })

  // Review 2026-10-13 (web): the sheet opened again for another collection kept its consent to send
  // that collection's documents, and the fields to hide named for the first one.
  it('asks again before sending samples of another collection', async () => {
    answering([
      CONTEXT,
      { type: 'done', result: null, warnings: [], usage: { input: 1, output: 1 }, local: true },
    ])
    const { wrapper } = sheet(['describe'])
    await flushPromises()
    const provider = byLabel<HTMLSelectElement>('Provider')
    provider.value = 'p2'
    provider.dispatchEvent(new Event('change'))
    await flushPromises()
    await check(byLabel('Include sample documents'))
    await typeInto(byLabel('Hide these fields'), 'phone')
    await wrapper.setProps({ coll: 'customers' })
    await flushPromises()
    expect(byLabel<HTMLInputElement>('Include sample documents').checked).toBe(false)
    await check(byLabel('Include sample documents'))
    expect(byLabel<HTMLInputElement>('Hide these fields').value).toBe('')
  })

  // Review of the web fixes (minor 1): opened again from the palette or the assistant for another
  // collection, the sheet was the same — its answer (inserted into the new tab), task and words too.
  it('starts anew when Ask AI opens for another collection', async () => {
    answering([
      CONTEXT,
      { type: 'text', delta: 'An answer for orders' },
      { type: 'done', result: null, warnings: [], usage: { input: 1, output: 1 }, local: true },
    ])
    mountApp(WorkspaceDialogs)
    const dialogs = useWorkspaceDialogs()
    const open = (coll: string) =>
      dialogs.open({ kind: 'ai', connectionId: 'c1', db: 'shop', coll, tabId: TAB, actions: ['describe'] })
    open('orders')
    await vi.waitFor(() => button('Send'), { timeout: 5_000 })
    await flushPromises()
    await send()
    expect(document.body.textContent).toContain('An answer for orders')
    open('customers')
    await flushPromises()
    await vi.waitFor(() => button('Send'), { timeout: 5_000 })
    expect(document.body.textContent).not.toContain('An answer for orders')
  })

  it('says a refusal in words, with when to try again', async () => {
    mockApi({
      'GET ai/status': () => [200, STATUS()],
      'GET connections': () => [200, [CONN()]],
      'POST connections/c1/databases/shop/collections/orders/ai': () => [
        429,
        { code: 'RATE_LIMITED', message: 'x', details: { retryAfterMs: 12_000 } },
      ],
    })
    sheet(['describe'])
    await flushPromises()
    await send()
    expect(document.body.textContent).toContain('Too many requests. Try again in 12 s.')
  })

  it('lists only local providers on a local-only connection', async () => {
    mockApi({
      'GET ai/status': () => [200, STATUS()],
      'GET connections': () => [200, [CONN({ aiPolicy: 'local' })]],
    })
    sheet(['describe'])
    await flushPromises()
    const options = [...byLabel<HTMLSelectElement>('Provider').options].map((o) => o.value)
    expect(options).toEqual(['p2'])
  })
})

describe('the sheet’s layout (phase 4a-1 UI review)', () => {
  it('keeps the answer beside the request, saying where it will appear before one is asked', async () => {
    answering([
      CONTEXT,
      { type: 'text', delta: 'Done.' },
      {
        type: 'done',
        result: {
          kind: 'query',
          filter: { qty: { $gt: { $numberInt: '5' } } },
          sort: { qty: { $numberInt: '-1' } },
        },
        warnings: [],
        usage: { input: 1, output: 1 },
        local: true,
      },
    ])
    sheet()
    await flushPromises()
    const pane = () => document.querySelector('[data-ai-pane]')!
    expect(pane().textContent).toContain('The answer appears here')
    await typeInto(byLabel<HTMLTextAreaElement>('What do you need?'), 'x')
    await send()
    expect(pane().querySelector('[data-ai-answer]')).not.toBeNull()
    // Each part of a suggestion is named, on one line, as the query bar holds it.
    expect(pane().textContent).toContain('filter: { qty: { $gt: 5 } }')
    expect(pane().textContent).toContain('sort: { qty: -1 }')
  })

  it('shows an error as an alert with its icon', async () => {
    answering([CONTEXT, { type: 'error', reason: 'unreachable' }])
    sheet(['describe'])
    await flushPromises()
    await send()
    const alert = document.querySelector('[data-ai-pane] [role="alert"]')!
    expect(alert.textContent).toContain('The provider cannot be reached.')
    expect(alert.querySelector('svg')).not.toBeNull()
  })
})

describe('insertion (phase 4a-1 spec §1.2)', () => {
  it('sets a pipeline as stage cards, asking first when the tab has some', async () => {
    mountApp(DialogHost)
    const state = useCollectionViewsStore().stateFor(TAB)
    const t = (k: string) => i18n.global.t(k)
    expect(
      await insertResult(TAB, { kind: 'pipeline', stages: [{ $match: { a: { $numberInt: '1' } } }] }, t),
    ).toBe(true)
    expect(state.aggregation.cards.map((c) => c.operator)).toEqual(['$match'])
    const p = insertResult(TAB, { kind: 'pipeline', stages: [{ $limit: { $numberInt: '5' } }] }, t)
    await flushPromises()
    ;[...document.querySelectorAll('[role="dialog"] button')]
      .find((b) => b.textContent?.trim() === 'Cancel')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(await p).toBe(false)
    expect(state.aggregation.cards.map((c) => c.operator)).toEqual(['$match'])
  })

  it('fills the validation draft, only once the section has loaded it', async () => {
    const state = useCollectionViewsStore().stateFor(TAB)
    const t = (k: string) => i18n.global.t(k)
    const validator = { $jsonSchema: { required: ['a'] } }
    expect(await insertResult(TAB, { kind: 'validation', validator }, t)).toBe(false)
    state.validationDraft = {
      text: '',
      level: 'strict',
      action: 'error',
      base: 'v1',
      tested: null,
      testedFor: '',
    }
    expect(await insertResult(TAB, { kind: 'validation', validator }, t)).toBe(true)
    expect(state.validationDraft.text).toContain('$jsonSchema')
  })

  it('follows the section with the actions it offers', () => {
    expect(actionsFor('documents', false)).toEqual(['query', 'explain'])
    expect(actionsFor('aggregations', false)).toEqual(['pipeline', 'explain'])
    expect(actionsFor('explain', false)).toEqual(['optimise', 'explain'])
    expect(actionsFor('validation', false)).toEqual(['validation'])
    expect(actionsFor('schema', false)).toEqual(['describe'])
    expect(actionsFor('indexes', false)).toEqual(['query', 'describe'])
    // Review of the branch (M7): a collection's backups, as its rules, are only described.
    expect(actionsFor('backups', false)).toEqual(['describe'])
  })
})

describe('Ask AI in the collection tab (plan ruling 17)', () => {
  it('opens from the header and from Mod+I, and is not offered where the policy is off', async () => {
    mockApi({
      'GET ai/status': () => [200, STATUS()],
      'GET connections': () => [200, [CONN()]],
      'GET connections/c1/databases/shop/collections': () => [
        200,
        [{ name: 'orders', type: 'collection', options: {} }],
      ],
    })
    const { wrapper } = mountApp(CollectionTab, { props: { ...target, tabId: TAB } })
    await flushPromises()
    const ask = button('Ask AI')
    // WCAG 2.5.3: its accessible name holds the words it shows.
    expect(ask.getAttribute('aria-label') ?? ask.textContent).toContain('Ask AI')
    ask.click()
    expect(useWorkspaceDialogs().current).toMatchObject({
      kind: 'ai',
      tabId: TAB,
      actions: ['query', 'explain'],
    })
    useWorkspaceDialogs().close()
    wrapper.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', ctrlKey: true, bubbles: true }))
    expect(useWorkspaceDialogs().current).toMatchObject({ kind: 'ai' })
    wrapper.unmount()
    useWorkspaceDialogs().close()
    mockApi({
      'GET ai/status': () => [200, STATUS()],
      'GET connections': () => [200, [CONN({ aiPolicy: 'off' })]],
      'GET connections/c1/databases/shop/collections': () => [
        200,
        [{ name: 'orders', type: 'collection', options: {} }],
      ],
    })
    mountApp(CollectionTab, { props: { ...target, tabId: TAB } })
    await flushPromises()
    expect(() => button('Ask AI')).toThrow()
  })
})
