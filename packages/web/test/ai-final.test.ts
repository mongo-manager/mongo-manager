import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick, watch } from 'vue'
import type { AiLine, AiStatus } from '@mongo-manager/shared'
import AiSheet from '../src/ai/AiSheet.vue'
import AiSettingsView from '../src/ai/AiSettingsView.vue'
import SafeMarkdown from '../src/ai/SafeMarkdown.vue'
import CollectionTab from '../src/workspace/tabs/CollectionTab.vue'
import { useAiRequest } from '../src/ai/useAi'
import { newCard } from '../src/aggregation/stages'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { useWorkspaceDialogs } from '../src/stores/workspaceDialogs'
import { useSessionStore } from '../src/stores/session'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, typeInto } from './support/dom'

/** Phase 4a-1 final review: each web finding, first seen failing. */
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  const session = useSessionStore()
  session.status = { mode: 'team' } as never
  session.me = {
    mode: 'team',
    user: { id: 'u1', username: 'root', role: 'admin' },
    permissions: ['settings:manage'],
  } as never
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const TAB = 'tab-final'
const target = { connectionId: 'c1', db: 'shop', coll: 'orders' }
const STATUS: AiStatus = {
  enabled: true,
  allowServerJs: false,
  providers: [
    {
      id: 'p1',
      name: 'Claude',
      kind: 'anthropic',
      model: 'claude-sonnet-5',
      local: null,
      samples: true,
      isDefault: true,
    },
  ],
  limits: { perMinute: 10, perDay: 200, perUser: 2, concurrent: 8 },
}
const CONN = {
  id: 'c1',
  name: 'Prod',
  aiPolicy: 'any',
  permissions: ['documents:read', 'ai:use'],
  settings: { hosts: [] },
}
const enc = new TextEncoder()
const CONTEXT: AiLine = {
  type: 'context',
  sent: {
    namespace: 'shop.orders',
    schema: { sampled: 200, count: 1000, more: 120, fields: [] },
    current: null,
    plan: null,
    indexes: null,
    validator: null,
    samples: [],
    leftOut: ['samples:2'],
  },
  provider: { id: 'p1', name: 'Claude', model: 'claude-sonnet-5', kind: 'anthropic' },
}
/** Answers with these lines (one network chunk), or a body that never ends. */
function answering(lines: AiLine[] | 'endless') {
  const { fetchMock } = mockApi({
    'GET ai/status': () => [200, STATUS],
    'GET connections': () => [200, [CONN]],
  })
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (!String(input).endsWith('/ai')) return fallback(input, init)
    return new Response(
      new ReadableStream({
        start(c) {
          if (lines === 'endless') {
            c.enqueue(enc.encode(`${JSON.stringify(CONTEXT)}\n`))
            init.signal?.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')))
            return
          }
          c.enqueue(enc.encode(lines.map((l) => JSON.stringify(l)).join('\n')))
          c.close()
        },
      }),
    )
  })
}
const sheet = (actions = ['query', 'explain']) =>
  mountApp(AiSheet, { props: { ...target, tabId: TAB, actions } })
async function send() {
  button('Send').click()
  await nextTick()
  await vi.waitFor(() => expect(() => button('Stop')).toThrow())
  await flushPromises()
}

describe('I4: nothing left the server', () => {
  it('says so beside the refusal', async () => {
    answering([CONTEXT, { type: 'error', reason: 'ai_local_only', nothingSent: true }])
    sheet(['describe'])
    await flushPromises()
    await send()
    expect(document.body.textContent).toContain('This connection allows local AI providers only.')
    expect(document.body.textContent).toContain('Nothing left the server.')
  })
})

describe('I5: the pipeline the tab holds is shown beside the suggestion', () => {
  it('shows the current stages under Now', async () => {
    answering([
      CONTEXT,
      {
        type: 'done',
        result: { kind: 'pipeline', stages: [{ $limit: { $numberInt: '5' } }] },
        warnings: [],
        usage: { input: 1, output: 1 },
        local: null,
      },
    ])
    const card = newCard('$match')
    card.text = '{ status: "paid" }'
    useCollectionViewsStore().stateFor(TAB).aggregation.cards = [card]
    sheet(['pipeline'])
    await flushPromises()
    await typeInto(byLabel<HTMLTextAreaElement>('What do you need?'), 'x')
    await send()
    expect(document.querySelector('[data-ai-now]')!.textContent).toContain('$match')
  })
})

describe('I6: the settings show the server’s limits', () => {
  it('says how many requests a person may make', async () => {
    mockApi({ 'GET ai/providers': () => [200, []], 'GET ai/status': () => [200, STATUS] })
    mountApp(AiSettingsView)
    await flushPromises()
    expect(document.body.textContent).toContain(
      '10 requests a minute and 200 a day per person, 2 at once; 8 at once on the server.',
    )
  })
})

describe('Minor 6: the answer is read in batches', () => {
  it('hands a network chunk of many lines over at once', async () => {
    answering([
      CONTEXT,
      ...Array.from({ length: 300 }, (_, i) => ({ type: 'text', delta: `w${i} ` }) as AiLine),
    ])
    let api!: ReturnType<typeof useAiRequest>
    mountApp(
      defineComponent({
        setup() {
          api = useAiRequest()
          return () => h('div')
        },
      }),
    )
    let updates = 0
    watch(
      () => api.run.text,
      () => void updates++,
    )
    await api.send(target, { action: 'describe' })
    await flushPromises()
    expect(api.run.text).toContain('w299')
    expect(updates).toBeLessThanOrEqual(3)
  })
})

describe('Minor 7: screen readers hear the end, not every word', () => {
  it('marks the pane busy while it streams and announces completion', async () => {
    answering([
      CONTEXT,
      { type: 'text', delta: 'Done.' },
      { type: 'done', result: null, warnings: [], usage: { input: 1, output: 1 }, local: null },
    ])
    sheet(['describe'])
    await flushPromises()
    const pane = document.querySelector('[data-ai-pane]')!
    expect(pane.getAttribute('aria-live')).toBeNull()
    await send()
    expect(document.querySelector('[role="status"]')!.textContent).toContain('The answer is ready.')
  })
})

describe('Minor 8: closing while it answers asks about the answer', () => {
  it('offers to stop the answer', async () => {
    answering('endless')
    sheet(['describe'])
    await flushPromises()
    button('Send').click()
    await nextTick()
    await vi.waitFor(() => button('Stop'))
    document
      .querySelector('[role="dialog"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(document.querySelector('[role="alertdialog"]')!.textContent).toContain(
      'Stop the answer and close?',
    )
    button('Stop').click()
  })
})

describe('Minor 9: Ctrl+Shift+I stays the browser’s', () => {
  it('opens the assistant on Ctrl+I only', async () => {
    mockApi({
      'GET ai/status': () => [200, STATUS],
      'GET connections': () => [200, [CONN]],
      'GET connections/c1/databases/shop/collections': () => [
        200,
        [{ name: 'orders', type: 'collection', options: {} }],
      ],
    })
    const { wrapper } = mountApp(CollectionTab, { props: { ...target, tabId: TAB } })
    await flushPromises()
    wrapper.element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'I', ctrlKey: true, shiftKey: true, bubbles: true }),
    )
    expect(useWorkspaceDialogs().current).toBeNull()
  })
})

describe('Minor 10: a refused copy says so', () => {
  it('shows that the copy failed', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
    })
    const { wrapper } = mountApp(SafeMarkdown, { props: { source: '```json\n{}\n```' } })
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(wrapper.get('button').text()).toContain('Copy failed')
  })
})

describe('Minor 15: what was left out is named', () => {
  it('counts the field paths and samples left out', async () => {
    answering([
      CONTEXT,
      { type: 'done', result: null, warnings: [], usage: { input: 1, output: 1 }, local: null },
    ])
    sheet(['describe'])
    await flushPromises()
    await send()
    const sent = document.querySelector('[data-ai-sent]')!.textContent!
    expect(sent).toContain('120 field paths')
    expect(sent).toContain('2 sample documents')
  })
})

describe('Minor 16: nothing to explain', () => {
  it('waits for a query or a pipeline before explaining', async () => {
    answering([CONTEXT])
    sheet(['explain'])
    await flushPromises()
    expect(button('Send').disabled).toBe(true)
    expect(document.body.textContent).toContain(
      'Write a query or a pipeline first: there is nothing to explain yet.',
    )
    useCollectionViewsStore().stateFor(TAB).draft.filter = '{ a: 1 }'
    await nextTick()
    expect(button('Send').disabled).toBe(false)
  })
})
