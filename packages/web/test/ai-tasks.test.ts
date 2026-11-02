import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { AiLine, AiStatus } from '@mongo-manager/shared'
import AiSheet from '../src/ai/AiSheet.vue'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, typeInto } from './support/dom'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const TAB = 'tab-tasks'
const STATUS: AiStatus = {
  enabled: true,
  allowServerJs: false,
  providers: [
    {
      id: 'p1',
      name: 'Gemini',
      kind: 'gemini',
      model: 'gemini-3-flash',
      local: false,
      samples: false,
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
  export: true,
  settings: { hosts: [] },
}
const enc = new TextEncoder()
function answering(lines: AiLine[]) {
  const { fetchMock } = mockApi({
    'GET ai/status': () => [200, STATUS],
    'GET connections': () => [200, [CONN]],
  })
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) =>
    String(input).endsWith('/ai')
      ? new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(enc.encode(lines.map((l) => JSON.stringify(l)).join('\n')))
              c.close()
            },
          }),
          { status: 200 },
        )
      : fallback(input, init),
  )
}
const sheet = () =>
  mountApp(AiSheet, {
    props: { connectionId: 'c1', db: 'shop', coll: 'orders', tabId: TAB, actions: ['query', 'explain'] },
  })
const task = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((r) => r.textContent?.includes(name))!

describe('the assistant’s tasks (UI redesign R1 review: "Sorgu yaz ve Açıkla … anlamadım")', () => {
  it('says what each task does and what it needs', async () => {
    answering([])
    sheet()
    await flushPromises()
    expect(task('Write a query').textContent).toContain('Describe what to find')
    expect(task('Explain it').textContent).toContain('the query in the bar')
  })

  it('keeps each task’s own words: what was written for one is not left in another', async () => {
    answering([])
    sheet()
    await flushPromises()
    await typeInto(byLabel<HTMLTextAreaElement>('What do you need?'), 'big orders first')
    task('Explain it').click()
    await nextTick()
    expect(byLabel<HTMLTextAreaElement>('Anything to add? (optional)').value).toBe('')
    task('Write a query').click()
    await nextTick()
    expect(byLabel<HTMLTextAreaElement>('What do you need?').value).toBe('big orders first')
  })

  it('shows the query Explain will explain, or that there is none yet', async () => {
    answering([])
    sheet()
    await flushPromises()
    task('Explain it').click()
    await nextTick()
    expect(document.body.textContent).toContain('Write a query or a pipeline first')
    useCollectionViewsStore().stateFor(TAB).draft.filter = '{ status: "paid" }'
    await nextTick()
    expect(document.querySelector('[data-ai-subject]')!.textContent).toContain('{ status: "paid" }')
  })

  it('clears the last answer when another task is chosen', async () => {
    answering([
      {
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
        provider: { id: 'p1', name: 'Gemini', model: 'gemini-3-flash', kind: 'gemini' },
      },
      { type: 'text', delta: 'Paid orders.' },
      {
        type: 'done',
        result: { kind: 'query', filter: { status: 'paid' } },
        warnings: [],
        usage: { input: 1, output: 1 },
        local: false,
      },
    ])
    sheet()
    await flushPromises()
    await typeInto(byLabel<HTMLTextAreaElement>('What do you need?'), 'paid')
    button('Send').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('Paid orders.'))
    task('Explain it').click()
    await nextTick()
    expect(document.body.textContent).not.toContain('Paid orders.')
    expect(document.body.textContent).toContain('The answer appears here')
  })
})

describe('a request the server refuses (UI redesign R1 review: a stale server said "the provider’s answer could not be used")', () => {
  it('says the server refused it and to reload, not that the provider failed', async () => {
    mockApi({
      'GET ai/status': () => [200, STATUS],
      'GET connections': () => [200, [CONN]],
      'POST connections/c1/databases/shop/collections/orders/ai': () => [
        400,
        {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
          details: [{ path: '', message: 'Unrecognized keys' }],
        },
      ],
    })
    sheet()
    await flushPromises()
    await typeInto(byLabel<HTMLTextAreaElement>('What do you need?'), 'paid')
    button('Send').click()
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('The server did not accept the request'),
    )
    expect(document.body.textContent).not.toContain('could not be used')
  })
})
