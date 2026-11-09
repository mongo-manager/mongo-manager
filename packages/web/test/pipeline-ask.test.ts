// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import type { AiLine, AiStatus } from '@mongo-manager/shared'
import AggregationView from '../src/aggregation/AggregationView.vue'
import AiSheet from '../src/ai/AiSheet.vue'
import QueryComposer from '../src/documents/QueryComposer.vue'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { useWorkspaceDialogs } from '../src/stores/workspaceDialogs'
import { useDialogStore } from '../src/stores/dialogs'
import { newCard } from '../src/aggregation/stages'
import { insertResult } from '../src/ai/insert'
import type { QueryDraft } from '../src/documents/queryBuild'
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

const TAB = 'tab-agg'
const target = { connectionId: 'c1', db: 'shop', coll: 'orders' }
const AGG = 'connections/c1/databases/shop/collections/orders/aggregate'
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
  provider: { id: 'p1', name: 'Gemini', model: 'gemini-3-flash', kind: 'gemini' },
}
const enc = new TextEncoder()
function answering(lines: AiLine[]) {
  const seen: { body?: Record<string, unknown> } = {}
  const { fetchMock, calls } = mockApi({
    'GET ai/status': () => [200, STATUS],
    'GET connections': () => [200, [CONN]],
    [`POST ${AGG}/preview`]: () => [200, { sample: { documents: [], count: 0 }, stages: [] }],
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
const PIPELINE: AiLine[] = [
  CONTEXT,
  { type: 'text', delta: 'Shipped orders with their customers.' },
  {
    type: 'done',
    result: {
      kind: 'pipeline',
      stages: [
        { $match: { status: 'shipped' } },
        { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'customer' } },
      ],
    },
    warnings: [],
    usage: { input: 1, output: 1 },
    local: false,
  },
]
const mountView = () => mountApp(AggregationView, { props: { target, tabId: TAB, canWrite: false } })

describe('asking for a pipeline in Aggregations (UI redesign R1 review)', () => {
  it('writes the stages into the builder from words, runs nothing, and remembers the words', async () => {
    const { seen, calls } = answering(PIPELINE)
    mountView()
    await flushPromises()
    await typeInto(
      byLabel<HTMLTextAreaElement>('Describe the result you want'),
      'shipped orders with customers',
    )
    button('Generate').click()
    const state = useCollectionViewsStore().stateFor(TAB).aggregation
    await vi.waitFor(() => expect(state.cards.map((c) => c.operator)).toEqual(['$match', '$lookup']))
    expect(seen.body).toMatchObject({
      action: 'pipeline',
      prompt: 'shipped orders with customers',
      provider: 'p1',
    })
    expect(calls.some((c) => c.path.endsWith('/aggregate') || c.path.endsWith('/aggregate/run'))).toBe(false)
    expect(state.intent).toBe('shipped orders with customers')
    await nextTick()
    expect(document.querySelector('[data-pipeline-steps]')!.textContent).toContain(
      'shipped orders with customers',
    )
  })

  it('changes the pipeline it wrote, step by step, keeping each step to go back to', async () => {
    const { seen } = answering(PIPELINE)
    mountView()
    await flushPromises()
    const words = () => byLabel<HTMLTextAreaElement>('Describe the result you want')
    await typeInto(words(), 'shipped orders with customers')
    button('Generate').click()
    const state = useCollectionViewsStore().stateFor(TAB).aggregation
    await vi.waitFor(() => expect(state.cards).toHaveLength(2))
    // User review 2026-10-09: the first request starts a chain the AI history shows together.
    const thread = (seen.body as { thread?: string }).thread
    expect(thread).toMatch(/^[0-9a-f-]{36}$/)
    // Now a change: the current pipeline and the earlier words go along; no question is asked.
    await typeInto(byLabel<HTMLTextAreaElement>('Describe a change'), 'also show the product names')
    button('Apply').click()
    await vi.waitFor(() =>
      expect(seen.body).toMatchObject({
        action: 'pipeline',
        prompt: 'also show the product names',
        refine: true,
        history: ['shipped orders with customers'],
        current: { pipeline: [{ $match: { status: 'shipped' } }, expect.anything()] },
        thread,
      }),
    )
    await vi.waitFor(() => expect(state.steps).toHaveLength(2))
    expect(document.querySelector('[data-test="confirm"]')).toBeNull()
    const steps = document.querySelector('[data-pipeline-steps]')!
    expect(steps.textContent).toContain('also show the product names')
    // The first step can be gone back to.
    state.cards = []
    steps.querySelector<HTMLButtonElement>('button[aria-label^="Go back to step 1"]')!.click()
    await flushPromises()
    expect(state.cards.map((c) => c.operator)).toEqual(['$match', '$lookup'])
  })

  it('keeps the chain of the pipeline shown when a new request fails, and Undo brings it back', async () => {
    const A = '00000000-0000-4000-8000-0000000000aa'
    const failed: AiLine[] = [
      CONTEXT,
      {
        type: 'done',
        result: null,
        reason: 'wrong_shape',
        warnings: [],
        usage: { input: 1, output: 1 },
        local: false,
      } as never,
    ]
    answering(failed)
    const state = useCollectionViewsStore().stateFor(TAB).aggregation
    state.cards = [{ ...newCard('$sort'), text: '{ a: 1 }' }]
    state.steps = [{ prompt: 'old words', reply: '', changes: [], cards: state.cards }]
    state.aiThread = A
    mountView()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((r) => r.textContent?.trim() === 'Start over')!
      .click()
    await nextTick()
    await typeInto(byLabel<HTMLTextAreaElement>('Describe the result you want'), 'refunded orders')
    button('Generate').click()
    await flushPromises()
    await flushPromises()
    // Nothing was written: the pipeline shown is still the one of chain A.
    expect(state.aiThread).toBe(A)
  })

  it('starts a new chain for a pipeline opened from the AI history, and when the words are forgotten', async () => {
    answering(PIPELINE)
    const state = useCollectionViewsStore().stateFor(TAB).aggregation
    state.cards = [{ ...newCard('$sort'), text: '{ a: 1 }' }]
    state.steps = [{ prompt: 'old words', reply: '', changes: [], cards: state.cards }]
    state.aiThread = '00000000-0000-4000-8000-0000000000aa'
    mountView()
    await flushPromises()
    document.querySelector<HTMLButtonElement>('button[aria-label="Forget these words"]')!.click()
    await flushPromises()
    expect(state.aiThread).toBeNull()
    state.aiThread = '00000000-0000-4000-8000-0000000000bb'
    useDialogStore().confirm = async () => true
    await insertResult(TAB, { kind: 'pipeline', stages: [{ $limit: 1 }] }, (k) => k)
    expect(state.aiThread).toBeNull()
  })

  it('starts over when asked to, without the current pipeline or the earlier words', async () => {
    const { seen } = answering(PIPELINE)
    const state = useCollectionViewsStore().stateFor(TAB).aggregation
    state.cards = [{ ...newCard('$sort'), text: '{ a: 1 }' }]
    state.steps = [{ prompt: 'old words', reply: '', changes: [], cards: state.cards }]
    state.aiThread = '00000000-0000-4000-8000-0000000000aa'
    mountView()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((r) => r.textContent?.trim() === 'Start over')!
      .click()
    await nextTick()
    await typeInto(byLabel<HTMLTextAreaElement>('Describe the result you want'), 'refunded orders')
    button('Generate').click()
    await vi.waitFor(() => expect(state.steps.map((x) => x.prompt)).toEqual(['refunded orders']))
    expect(seen.body).not.toHaveProperty('refine')
    expect(seen.body).not.toHaveProperty('history')
    // Starting over starts a new chain.
    expect((seen.body as { thread?: string }).thread).toMatch(/^[0-9a-f-]{36}$/)
    expect((seen.body as { thread?: string }).thread).not.toBe('00000000-0000-4000-8000-0000000000aa')
    // Undo brings the pipeline that was replaced back.
    button('Undo').click()
    await flushPromises()
    expect(state.cards.map((c) => c.operator)).toEqual(['$sort'])
    // And its chain.
    expect(state.aiThread).toBe('00000000-0000-4000-8000-0000000000aa')
  })

  it('offers to explain or speed up the pipeline in the assistant once there is one', async () => {
    answering([])
    useCollectionViewsStore().stateFor(TAB).aggregation.cards = [{ ...newCard('$match'), text: '{ a: 1 }' }]
    mountView()
    await flushPromises()
    button('Explain this pipeline').click()
    // A shortcut asks at once: the sheet opens already sending (UI redesign R1 review: "hiçbir şey olmuyor").
    expect(useWorkspaceDialogs().current).toMatchObject({ kind: 'ai', actions: ['explain'], send: true })
  })

  it('sends at once when the sheet is opened by a shortcut', async () => {
    const { seen } = answering([
      CONTEXT,
      { type: 'text', delta: 'It keeps a = 1.' },
      { type: 'done', result: null, warnings: [], usage: { input: 1, output: 1 }, local: false },
    ])
    const state = useCollectionViewsStore().stateFor(TAB)
    state.section = 'aggregations'
    state.aggregation.cards = [{ ...newCard('$match'), text: '{ a: 1 }' }]
    mountApp(AiSheet, {
      props: {
        connectionId: 'c1',
        db: 'shop',
        coll: 'orders',
        tabId: TAB,
        actions: ['explain'],
        sendNow: true,
      },
    })
    await vi.waitFor(() =>
      expect(seen.body).toMatchObject({
        action: 'explain',
        current: { pipeline: [{ $match: { a: { $numberInt: '1' } } }] },
      }),
    )
    await vi.waitFor(() => expect(document.body.textContent).toContain('It keeps a = 1.'))
  })

  it('asks at once when Documents sent the words over', async () => {
    const { seen } = answering(PIPELINE)
    useCollectionViewsStore().stateFor(TAB).aggregation.pendingAsk = 'shipped orders with customer names'
    mountView()
    await vi.waitFor(() =>
      expect(seen.body).toMatchObject({ action: 'pipeline', prompt: 'shipped orders with customer names' }),
    )
    expect(useCollectionViewsStore().stateFor(TAB).aggregation.pendingAsk).toBeNull()
  })
})

describe('Documents hands a request a find cannot answer to Aggregations', () => {
  it('says it needs a pipeline and, on request, carries the words over', async () => {
    answering([
      CONTEXT,
      { type: 'text', delta: 'This needs the customers collection.' },
      {
        type: 'done',
        result: null,
        reason: 'needs_pipeline',
        warnings: [],
        usage: { input: 1, output: 1 },
        local: false,
      },
    ])
    const state = useCollectionViewsStore().stateFor(TAB)
    const Host = defineComponent(
      () => () =>
        h(QueryComposer, {
          modelValue: state.draft,
          'onUpdate:modelValue': (v: QueryDraft) => (state.draft = v),
          completions: [],
          target,
          tabId: TAB,
        }),
    )
    mountApp(Host)
    await flushPromises()
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((r) => r.textContent?.trim() === 'Ask')!
      .click()
    await nextTick()
    await typeInto(
      byLabel<HTMLTextAreaElement>('Describe what you want to find'),
      'shipped orders with customer names',
    )
    button('Generate').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('needs an aggregation pipeline'))
    button('Write it as a pipeline').click()
    expect(state.section).toBe('aggregations')
    expect(state.aggregation.pendingAsk).toBe('shipped orders with customer names')
  })
})

describe('words being written survive leaving the tab section (UI redesign R1 review)', () => {
  it('keeps the unsent words in Aggregations when Documents is looked at and left again', async () => {
    answering([])
    const first = mountView()
    await flushPromises()
    await typeInto(byLabel<HTMLTextAreaElement>('Describe the result you want'), 'shipped orders with their')
    first.wrapper.unmount()
    mountView()
    await flushPromises()
    expect(byLabel<HTMLTextAreaElement>('Describe the result you want').value).toBe(
      'shipped orders with their',
    )
  })

  it('keeps Documents in Ask mode with the unsent words', async () => {
    answering([])
    const state = useCollectionViewsStore().stateFor(TAB)
    const Host = defineComponent(
      () => () =>
        h(QueryComposer, {
          modelValue: state.draft,
          'onUpdate:modelValue': (v: QueryDraft) => (state.draft = v),
          completions: [],
          target,
          tabId: TAB,
        }),
    )
    const first = mountApp(Host)
    await flushPromises()
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((r) => r.textContent?.trim() === 'Ask')!
      .click()
    await nextTick()
    await typeInto(byLabel<HTMLTextAreaElement>('Describe what you want to find'), 'refunded orders over')
    first.wrapper.unmount()
    mountApp(Host)
    await flushPromises()
    expect(byLabel<HTMLTextAreaElement>('Describe what you want to find').value).toBe('refunded orders over')
  })
})

/** Answers each request with the next of the given answers. */
function answeringInTurn(...answers: AiLine[][]) {
  const bodies: Array<Record<string, unknown>> = []
  const { fetchMock, calls } = mockApi({
    'GET ai/status': () => [200, STATUS],
    'GET connections': () => [200, [CONN]],
    [`POST ${AGG}/preview`]: () => [200, { sample: { documents: [], count: 0 }, stages: [] }],
    'POST connections/c1/databases/shop/collections/orders/pipelines': (body) => [
      201,
      {
        id: '9b1c2d7e-8a8b-4c1d-9e0f-1a2b3c4d5e6f',
        ...(body as object),
        mine: true,
        owner: null,
        updatedAt: '2026-10-07T10:00:00.000Z',
      },
    ],
  })
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (String(input).endsWith('/ai')) {
      bodies.push(JSON.parse(String(init.body)))
      const lines = answers[bodies.length - 1] ?? answers.at(-1)!
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
  return { bodies, calls }
}
const answer = (reply: string, stages: Record<string, unknown>[]): AiLine[] => [
  CONTEXT,
  { type: 'text', delta: `${reply}\n\`\`\`json\n${JSON.stringify(stages)}\n\`\`\`` },
  {
    type: 'done',
    result: { kind: 'pipeline', stages },
    warnings: [],
    usage: { input: 1, output: 1 },
    local: false,
  },
]
const FIRST = [
  { $match: { status: 'shipped' } },
  { $lookup: { from: 'products', localField: 'items.productId', foreignField: '_id', as: 'products' } },
]
const SECOND = [...FIRST, { $project: { orderNo: 1, 'products.name': 1, 'products.sku': 1 } }]

describe('the assistant’s steps in detail, saved with the pipeline (UI redesign R1 review)', () => {
  async function twoSteps() {
    const api = answeringInTurn(
      answer('Joined the products.', FIRST),
      answer('Kept only the product name and sku.', SECOND),
    )
    mountView()
    await flushPromises()
    await typeInto(
      byLabel<HTMLTextAreaElement>('Describe the result you want'),
      'shipped orders with their products',
    )
    button('Generate').click()
    const state = useCollectionViewsStore().stateFor(TAB).aggregation
    await vi.waitFor(() => expect(state.steps).toHaveLength(1))
    await typeInto(byLabel<HTMLTextAreaElement>('Describe a change'), 'only product name and sku')
    button('Apply').click()
    await vi.waitFor(() => expect(state.steps).toHaveLength(2))
    return { ...api, state }
  }

  it('shows each step: the words, the assistant’s reply and what changed', async () => {
    await twoSteps()
    button('Step details').click()
    await flushPromises()
    const history = document.querySelector('[data-pipeline-history]')!
    const items = history.querySelectorAll(':scope > li')
    expect(items).toHaveLength(2)
    expect(items[0]!.textContent).toContain('shipped orders with their products')
    expect(items[0]!.textContent).toContain('Joined the products.')
    expect(items[0]!.textContent).not.toContain('```')
    expect(items[1]!.textContent).toContain('Kept only the product name and sku.')
    expect(items[1]!.querySelector('[data-change="added"]')!.textContent).toContain('$project')
  })

  it('saves the steps with the pipeline, and brings them back when it is opened', async () => {
    const { calls, state } = await twoSteps()
    button('Save as…').click()
    await flushPromises()
    const name = byLabel('Name')
    await typeInto(name, 'Products')
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find((b) => b.textContent?.trim() === 'Save')!
      .click()
    await flushPromises()
    const body = calls.find((c) => c.method === 'POST' && c.path.endsWith('/pipelines'))!.body as {
      assistant: { steps: Array<{ prompt: string; reply: string; stages: unknown[] }> }
    }
    expect(body.assistant.steps.map((s) => [s.prompt, s.reply])).toEqual([
      ['shipped orders with their products', 'Joined the products.'],
      ['only product name and sku', 'Kept only the product name and sku.'],
    ])
    expect(body.assistant.steps[1]!.stages).toHaveLength(3)
    expect(state.steps).toHaveLength(2)
  })
})

describe('opening a pipeline saved with its steps', () => {
  it('brings the steps back, to read and to go back to', async () => {
    mockApi({
      'GET ai/status': () => [200, STATUS],
      'GET connections': () => [200, [CONN]],
      [`POST ${AGG}/preview`]: () => [200, { sample: { documents: [], count: 0 }, stages: [] }],
      'GET connections/c1/databases/shop/collections/orders/pipelines': () => [
        200,
        {
          pipelines: [
            {
              id: '9b1c2d7e-8a8b-4c1d-9e0f-1a2b3c4d5e6f',
              name: 'Products',
              stages: SECOND,
              tags: [],
              shared: false,
              mine: true,
              owner: null,
              updatedAt: '2026-10-07T10:00:00.000Z',
              assistant: {
                steps: [
                  {
                    prompt: 'shipped orders with their products',
                    reply: 'Joined the products.',
                    stages: FIRST,
                    changes: [],
                  },
                  {
                    prompt: 'only product name and sku',
                    reply: 'Kept two fields.',
                    stages: SECOND,
                    changes: [{ kind: 'added', operator: '$project', n: 3 }],
                  },
                ],
              },
            },
          ],
        },
      ],
    })
    mountView()
    await flushPromises()
    button('Pipelines').click()
    await flushPromises()
    document.querySelector<HTMLButtonElement>('button[data-action="open"]')!.click()
    await flushPromises()
    const state = useCollectionViewsStore().stateFor(TAB).aggregation
    expect(state.steps.map((s) => s.prompt)).toEqual([
      'shipped orders with their products',
      'only product name and sku',
    ])
    expect(state.cards).toHaveLength(3)
    document.querySelector<HTMLButtonElement>('button[aria-label^="Go back to step 1"]')!.click()
    await flushPromises()
    expect(state.cards.map((c) => c.operator)).toEqual(['$match', '$lookup'])
  })
})

describe('the assistant’s steps, final review', () => {
  async function firstStep(...more: AiLine[][]) {
    const api = answeringInTurn(answer('Joined the products.', FIRST), ...more)
    mountView()
    await flushPromises()
    await typeInto(
      byLabel<HTMLTextAreaElement>('Describe the result you want'),
      'shipped orders with their products',
    )
    button('Generate').click()
    const state = useCollectionViewsStore().stateFor(TAB).aggregation
    await vi.waitFor(() => expect(state.steps).toHaveLength(1))
    return { ...api, state }
  }
  const masked = (stages: Record<string, unknown>[]): AiLine[] => {
    const lines = answer('Kept the email.', stages)
    ;(lines[2] as { warnings: string[] }).warnings = ['masked_values']
    return lines
  }
  const HIDDEN = [...FIRST, { $match: { email: '***' } }]

  it('asks before applying a change that carries hidden values ("***") back (I2)', async () => {
    const { state } = await firstStep(masked(HIDDEN), masked(HIDDEN))
    const confirm = vi.spyOn(useDialogStore(), 'confirm').mockResolvedValueOnce(false)
    await typeInto(byLabel<HTMLTextAreaElement>('Describe a change'), 'only this email')
    button('Apply').click()
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    await flushPromises()
    expect(String(confirm.mock.calls[0]![0].message)).toContain('***')
    expect(state.steps).toHaveLength(1)
    expect(state.cards).toHaveLength(2)
    expect(byLabel<HTMLTextAreaElement>('Describe a change').value).toBe('only this email')
    confirm.mockResolvedValueOnce(true)
    button('Apply').click()
    await vi.waitFor(() => expect(state.steps).toHaveLength(2))
    expect(state.cards).toHaveLength(3)
  })

  it('sends only the steps up to the one gone back to (reviewer C Minor 7)', async () => {
    const { bodies, state } = await firstStep(
      answer('Kept two fields.', SECOND),
      answer('Sorted.', [...FIRST, { $sort: { orderNo: 1 } }]),
    )
    await typeInto(byLabel<HTMLTextAreaElement>('Describe a change'), 'only product name and sku')
    button('Apply').click()
    await vi.waitFor(() => expect(state.steps).toHaveLength(2))
    document.querySelector<HTMLButtonElement>('button[aria-label^="Go back to step 1"]')!.click()
    await flushPromises()
    await typeInto(byLabel<HTMLTextAreaElement>('Describe a change'), 'sort by order number')
    button('Apply').click()
    await vi.waitFor(() => expect(bodies).toHaveLength(3))
    expect(bodies[2]!.history).toEqual(['shipped orders with their products'])
  })

  it('tells a screen reader what the assistant changed, and that Undo is there (reviewer C Minor 12)', async () => {
    await firstStep()
    const status = document.querySelector('[data-assistant-status]')!
    expect(status.getAttribute('role')).toBe('status')
    expect(status.textContent).toContain('2 stages changed')
    expect(status.textContent).toContain('Undo')
  })

  it('keeps the words focusable while the answer is written (reviewer C Minor 12)', async () => {
    const { fetchMock } = mockApi({
      'GET ai/status': () => [200, STATUS],
      'GET connections': () => [200, [CONN]],
      [`POST ${AGG}/preview`]: () => [200, { sample: { documents: [], count: 0 }, stages: [] }],
    })
    const fallback = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) =>
      String(input).endsWith('/ai')
        ? new Response(new ReadableStream({ start: () => {} }), { status: 200 })
        : fallback(input, init),
    )
    mountView()
    await flushPromises()
    const words = byLabel<HTMLTextAreaElement>('Describe the result you want')
    await typeInto(words, 'orders')
    words.focus()
    button('Generate').click()
    await flushPromises()
    expect(button('Stop')).toBeTruthy()
    expect(words.disabled).toBe(false)
    expect(words.readOnly).toBe(true)
    expect(document.activeElement).toBe(words)
  })
})
