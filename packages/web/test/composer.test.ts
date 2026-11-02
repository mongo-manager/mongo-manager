import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import type { AiLine, AiStatus } from '@mongo-manager/shared'
import QueryComposer from '../src/documents/QueryComposer.vue'
import QueryPanel from '../src/documents/QueryPanel.vue'
import { emptyDraft, type FindQuery, type QueryDraft } from '../src/documents/queryBuild'
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

const TAB = 'tab-composer'
const target = { connectionId: 'c1', db: 'shop', coll: 'orders' }
const STATUS = (): AiStatus => ({
  enabled: true,
  allowServerJs: false,
  providers: [
    {
      id: 'p1',
      name: 'Claude',
      kind: 'anthropic',
      model: 'm',
      local: false,
      samples: false,
      isDefault: true,
    },
  ],
  limits: { perMinute: 10, perDay: 200, perUser: 2, concurrent: 8 },
})
const CONN = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  name: 'Prod',
  aiPolicy: 'any',
  permissions: ['documents:read', 'ai:use'],
  export: true,
  settings: { hosts: [] },
  ...over,
})
const enc = new TextEncoder()
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
  provider: { id: 'p1', name: 'Claude', model: 'm', kind: 'anthropic' },
}
function withAi(lines: AiLine[], conn = CONN()) {
  const seen: { body?: Record<string, unknown> } = {}
  const { fetchMock } = mockApi({
    'GET ai/status': () => [200, STATUS()],
    'GET connections': () => [200, [conn]],
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
  return seen
}

function mountComposer(initial: Partial<QueryDraft> = {}) {
  const state = useCollectionViewsStore().stateFor(TAB)
  state.draft = { ...emptyDraft(), ...initial }
  const applied: FindQuery[] = []
  const Host = defineComponent(
    () => () =>
      h(QueryComposer, {
        modelValue: state.draft,
        'onUpdate:modelValue': (v: QueryDraft) => (state.draft = v),
        completions: [],
        target,
        tabId: TAB,
        fields: ['_id', 'status', 'total'],
        onApply: (q: FindQuery) => applied.push(q),
      }),
  )
  const mounted = mountApp(Host)
  return { state, applied, ...mounted }
}

describe('the query composer (spec rev. 2 §4.2)', () => {
  it('counts the options that are set on the Options button', async () => {
    mockApi({ 'GET ai/status': () => [200, STATUS()], 'GET connections': () => [200, [CONN()]] })
    mountComposer({ sort: '{ total: -1 }', skip: '10' })
    await flushPromises()
    const options = button('Options')
    expect(options.getAttribute('aria-label')).toBe('Options, 2 set')
    expect(options.dataset.count).toBe('2')
  })

  it('offers Ask only where the assistant may be used here', async () => {
    mockApi({
      'GET ai/status': () => [200, STATUS()],
      'GET connections': () => [200, [CONN({ aiPolicy: 'off' })]],
    })
    mountComposer()
    await flushPromises()
    expect(document.querySelector('[role="radio"]')).toBeNull()
  })

  it('turns words into a query in the bar, without running it, and remembers the words', async () => {
    const seen = withAi([
      CONTEXT,
      { type: 'text', delta: 'ok' },
      {
        type: 'done',
        result: {
          kind: 'query',
          filter: { total: { $gt: { $numberInt: '5' } } },
          sort: { total: { $numberInt: '-1' } },
        },
        warnings: [],
        usage: { input: 1, output: 1 },
        local: false,
      },
    ])
    const { state, applied } = mountComposer()
    await flushPromises()
    const ask = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
      (r) => r.textContent?.trim() === 'Ask',
    )!
    ask.click()
    await nextTick()
    // Nothing leaves the server unless the user says so: the words are what is sent, with the field names.
    expect(document.body.textContent).toContain('Field names and your current query go to Claude')
    await typeInto(byLabel<HTMLTextAreaElement>('Describe what you want to find'), 'big orders first')
    button('Generate').click()
    await vi.waitFor(() => expect(state.draft.filter).toBe('{ total: { $gt: 5 } }'))
    await flushPromises()
    expect(seen.body).toMatchObject({ action: 'query', prompt: 'big orders first', provider: 'p1' })
    expect(seen.body).not.toHaveProperty('samples')
    expect(state.draft.sort).toBe('{ total: -1 }')
    expect(applied).toHaveLength(0)
    expect(state.intent).toMatchObject({ prompt: 'big orders first' })
    // Back in Query mode, with the generated filter in the field.
    expect(byLabel<HTMLTextAreaElement>('Filter').value).toBe('{ total: { $gt: 5 } }')
  })

  it('focuses the filter on / when nothing else is being typed in', async () => {
    mockApi({ 'GET ai/status': () => [200, STATUS()], 'GET connections': () => [200, [CONN()]] })
    mountComposer()
    await flushPromises()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(byLabel('Filter'))
    const other = document.createElement('input')
    document.body.append(other)
    other.focus()
    const typed = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })
    other.dispatchEvent(typed)
    expect(typed.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(other)
  })

  // W6.1: two collections side by side — "/" goes to the bar of the pane in use only.
  it('leaves / to the pane in use when two tabs are side by side', async () => {
    mockApi({ 'GET ai/status': () => [200, STATUS()], 'GET connections': () => [200, [CONN()]] })
    mountComposer()
    await flushPromises()
    const pane = document.createElement('section')
    pane.dataset.pane = 'right'
    pane.dataset.paneFocused = 'false'
    document.body.append(pane)
    pane.append(byLabel('Filter').closest('form')!)
    const slash = () => {
      const e = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })
      document.body.dispatchEvent(e)
      return e
    }
    expect(slash().defaultPrevented).toBe(false)
    expect(document.activeElement).not.toBe(byLabel('Filter'))
    pane.dataset.paneFocused = 'true'
    expect(slash().defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(byLabel('Filter'))
  })
})

describe('the structured query panel (spec rev. 2 §4.3)', () => {
  const query: FindQuery = {
    filter: { status: 'A' },
    sort: { total: { $numberInt: '-1' } },
    skip: 0,
    limit: 20,
  }

  it('lists only the parts that are set, with the words they came from', () => {
    mountApp(QueryPanel, { props: { query, coll: 'orders', intent: 'paid orders' } })
    const parts = [...document.querySelectorAll('[data-query-part]')].map((p) =>
      p.getAttribute('data-query-part'),
    )
    expect(parts).toEqual(['filter', 'sort', 'limit'])
    expect(document.body.textContent).toContain('paid orders')
  })

  it('copies the query as a shell command, quoting the collection name safely', async () => {
    const write = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: write } })
    mountApp(QueryPanel, { props: { query, coll: 'or"ders', intent: null } })
    document.querySelector<HTMLButtonElement>('button[aria-label="Copy as shell command"]')!.click()
    await flushPromises()
    expect(write).toHaveBeenCalledWith(
      'db.getCollection("or\\"ders").find({ status: "A" }).sort({ total: -1 }).limit(20)',
    )
  })
})

describe('the composer without a collection tab', () => {
  it('asks the server nothing (Ask needs a tab to write into)', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    mountApp(QueryComposer, {
      props: { modelValue: emptyDraft(), 'onUpdate:modelValue': () => {}, completions: [] },
    })
    await flushPromises()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('the Ask words while the answer is written (reviewer B Minor 11)', () => {
  it('stay focused and readable, not disabled', async () => {
    const { fetchMock } = mockApi({
      'GET ai/status': () => [200, STATUS()],
      'GET connections': () => [200, [CONN()]],
    })
    const fallback = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) =>
      String(input).endsWith('/ai')
        ? new Response(new ReadableStream({ start: () => {} }), { status: 200 })
        : fallback(input, init),
    )
    mountComposer()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((r) => r.textContent?.trim() === 'Ask')!
      .click()
    await nextTick()
    const words = byLabel<HTMLTextAreaElement>('Describe what you want to find')
    await typeInto(words, 'big orders first')
    words.focus()
    button('Generate').click()
    await flushPromises()
    expect(words.disabled).toBe(false)
    expect(words.readOnly).toBe(true)
    expect(document.activeElement).toBe(words)
  })
})
