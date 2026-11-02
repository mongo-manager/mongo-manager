import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import type { AiLine, AiProviderView, AiStatus } from '@mongo-manager/shared'
import AiSettingsView from '../src/ai/AiSettingsView.vue'
import AiProviderEditor from '../src/ai/AiProviderEditor.vue'
import AiSheet from '../src/ai/AiSheet.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import ToastHost from '../src/ds/DsToastHost.vue'
import { currentFor, insertResult } from '../src/ai/insert'
import { newCard } from '../src/aggregation/stages'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { useSessionStore } from '../src/stores/session'
import { useTabsStore } from '../src/stores/tabs'
import { useWorkspaceDialogs } from '../src/stores/workspaceDialogs'
import { useCommandsStore } from '../src/stores/commands'
import { useWorkspaceCommands } from '../src/workspace/commands'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, typeInto } from './support/dom'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  const session = useSessionStore()
  session.status = { mode: 'team' } as never
  session.me = {
    mode: 'team',
    user: { id: 'u1', username: 'root', role: 'admin' },
    permissions: ['settings:manage', 'ai:use'],
  } as never
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const P = (over: Partial<AiProviderView> = {}): AiProviderView => ({
  id: 'p1',
  name: 'Claude',
  kind: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-5',
  keyStored: true,
  maxTokens: 2048,
  samples: false,
  enabled: true,
  isDefault: true,
  lastLocal: null,
  lastTestedAt: null,
  lastTest: null,
  price: null,
  ...over,
})
const dialogButton = async (label: string) => {
  ;[...document.querySelectorAll('[role="dialog"] button')]
    .find((b) => b.textContent?.trim() === label)!
    .dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await flushPromises()
}

// Review of R3–R5 (I-4): what deletes is in a "…" menu, in danger colour, never a button of its own.
async function fromMenu(trigger: string, entry: string) {
  document.querySelector<HTMLButtonElement>(`button[aria-label="${trigger}"]`)!.click()
  await flushPromises()
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (m) => m.textContent?.trim() === entry,
  )!
  expect(item.className).toContain('text-danger')
  item.click()
  await flushPromises()
}

describe('Settings → AI assistant, more (phase 4a-1 spec §6)', () => {
  it('removes a provider after asking, makes another the default, and says a failure in words', async () => {
    const { calls } = mockApi({
      'GET ai/providers': () => [
        200,
        [P(), P({ id: 'p2', name: 'Ollama', kind: 'ollama', isDefault: false })],
      ],
      'DELETE ai/providers/p1': () => [204],
      'PATCH ai/providers/p2': () => [200, P({ id: 'p2', isDefault: true })],
      'POST ai/providers/p2/test': () => [500, { code: 'INTERNAL', message: 'x' }],
    })
    mountApp(AiSettingsView)
    mountApp(DialogHost)
    mountApp(ToastHost)
    await flushPromises()
    const cards = () => [...document.querySelectorAll<HTMLElement>('[data-provider]')]
    expect([...cards()[0]!.querySelectorAll('button')].map((b) => b.textContent?.trim())).not.toContain(
      'Remove',
    )
    await fromMenu('More actions for Claude', 'Remove')
    await dialogButton('Remove')
    ;[...cards()[1]!.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Make default')!
      .click()
    await flushPromises()
    ;[...cards()[1]!.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Test')!.click()
    await flushPromises()
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(
      expect.arrayContaining([
        'DELETE ai/providers/p1',
        'PATCH ai/providers/p2',
        'POST ai/providers/p2/test',
      ]),
    )
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ isDefault: true })
    expect(document.body.textContent).toContain('Something went wrong (INTERNAL).')
  })

  // Review of R3–R5, minor 20: at the limit, Add is off and the page says why.
  it('says why no provider can be added at the limit', async () => {
    mockApi({
      'GET ai/providers': () => [
        200,
        Array.from({ length: 10 }, (_, i) => P({ id: `p${i}`, isDefault: i === 0 })),
      ],
    })
    mountApp(AiSettingsView)
    await flushPromises()
    const add = [...document.querySelectorAll<HTMLButtonElement>('header button')].find((b) =>
      b.textContent?.includes('Add'),
    )!
    expect(add.disabled).toBe(true)
    expect(document.body.textContent).toContain('10 providers at most')
  })

  it('says when the providers cannot be read', async () => {
    mockApi({ 'GET ai/providers': () => [500, { code: 'INTERNAL', message: 'x' }] })
    mountApp(AiSettingsView)
    await flushPromises()
    expect(document.querySelector('[role="alert"]')!.textContent).toContain(
      'Something went wrong (INTERNAL).',
    )
  })
})

describe('the provider editor, more (phase 4a-1 spec §2.1)', () => {
  it('follows the kind’s defaults for a new provider', async () => {
    mockApi({})
    mountApp(AiProviderEditor, { props: { provider: null } })
    await flushPromises()
    const kind = byLabel<HTMLSelectElement>('Kind')
    kind.value = 'ollama'
    kind.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(byLabel('Address').value).toBe('http://localhost:11434')
    expect(byLabel('Model').value).toBe('')
    expect(byLabel('May receive sample documents').checked).toBe(true)
    // Ollama asks for no key.
    expect(() => byLabel('API key')).toThrow()
  })

  it('sends only what changed, removes a key on request, and says a refusal', async () => {
    const { calls } = mockApi({
      'PATCH ai/providers/p1': () => [
        400,
        { code: 'VALIDATION_ERROR', message: 'x', details: { reason: 'name_taken' } },
      ],
    })
    mountApp(AiProviderEditor, {
      props: { provider: P({ kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt' }) },
    })
    await flushPromises()
    await typeInto(byLabel('Longest answer (tokens)'), '4096')
    byLabel('May receive sample documents').click()
    byLabel('Offer this provider').click()
    await flushPromises()
    button('Save').click()
    await flushPromises()
    expect(calls.at(-1)!.body).toEqual({ maxTokens: 4096, samples: true, enabled: false })
    expect(document.body.textContent).toContain('A provider with this name already exists.')
  })

  it('refuses an answer length outside its bounds', async () => {
    mockApi({})
    mountApp(AiProviderEditor, { props: { provider: P() } })
    await flushPromises()
    await typeInto(byLabel('Longest answer (tokens)'), '100')
    expect(button('Save').disabled).toBe(true)
  })
})

const TAB = 'tab-more'
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
  permissions: ['documents:read', 'ai:use', 'indexes:write'],
  settings: { hosts: [] },
}
const enc = new TextEncoder()
function answering(lines: AiLine[]) {
  const seen: { body?: Record<string, unknown> } = {}
  const { fetchMock } = mockApi({
    'GET ai/status': () => [200, STATUS],
    'GET connections': () => [200, [CONN]],
  })
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (!String(input).endsWith('/ai')) return fallback(input, init)
    seen.body = JSON.parse(String(init.body))
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(lines.map((l) => JSON.stringify(l)).join('\n')))
          c.close()
        },
      }),
    )
  })
  return seen
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
async function settle() {
  await nextTick()
  await vi.waitFor(() => expect(() => button('Stop')).toThrow())
  await flushPromises()
}

describe('the sheet, more (phase 4a-1 spec §6)', () => {
  it('sends with Ctrl+Enter, offers each suggested index, and opens the index dialog filled in', async () => {
    const seen = answering([
      CONTEXT,
      { type: 'text', delta: 'An index helps.' },
      {
        type: 'done',
        result: {
          kind: 'optimise',
          indexes: [{ keys: { qty: { $numberInt: '1' } }, options: { name: 'by_qty', unique: true } }],
        },
        warnings: ['dropped_keys'],
        usage: { input: 1, output: 1 },
        local: false,
      },
    ])
    // A query to speed up (final review minor 16: nothing is sent without one).
    useCollectionViewsStore().stateFor(TAB).draft.filter = '{ qty: { $gt: 5 } }'
    mountApp(AiSheet, { props: { ...target, tabId: TAB, actions: ['optimise', 'explain'] } })
    await flushPromises()
    const prompt = byLabel<HTMLTextAreaElement>('Anything to add? (optional)')
    prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    await settle()
    expect(seen.body).toMatchObject({ action: 'optimise' })
    expect(document.body.textContent).toContain('Parts the editor cannot hold were left out.')
    button('Create index…').click()
    await flushPromises()
    await vi.waitFor(() => expect(byLabel(i18n.global.t('indexes.nameOptional')).value).toBe('by_qty'))
  })

  it('says a wrong shape with the action’s words, and stops when asked', async () => {
    answering([
      CONTEXT,
      {
        type: 'done',
        result: null,
        warnings: [],
        reason: 'wrong_shape',
        usage: { input: 1, output: 1 },
        local: null,
      },
    ])
    mountApp(AiSheet, { props: { ...target, tabId: TAB, actions: ['pipeline'] } })
    await flushPromises()
    await typeInto(byLabel<HTMLTextAreaElement>('What do you need?'), 'x')
    button('Send').click()
    await settle()
    expect(document.body.textContent).toContain('The answer’s code is not a Write a pipeline.')
  })
})

describe('insertion, more (phase 4a-1 spec §1.2)', () => {
  const t = (k: string) => i18n.global.t(k)

  it('sends the cards for a pipeline action, the query for others, and nothing it cannot read', () => {
    const state = useCollectionViewsStore().stateFor(TAB)
    expect(currentFor(TAB, 'query')).toBeUndefined()
    state.draft.filter = '{ a: '
    expect(currentFor(TAB, 'query')).toBeUndefined()
    state.draft.filter = '{ a: 1 }'
    state.draft.sort = '{ a: -1 }'
    expect(currentFor(TAB, 'explain')).toEqual({
      filter: { a: { $numberInt: '1' } },
      sort: { a: { $numberInt: '-1' } },
    })
    expect(currentFor(TAB, 'describe')).toBeUndefined()
    expect(currentFor(TAB, 'pipeline')).toBeUndefined()
    const card = newCard('$limit')
    card.text = '5'
    state.aggregation.cards = [card]
    state.section = 'aggregations'
    expect(currentFor(TAB, 'explain')).toEqual({ pipeline: [{ $limit: { $numberInt: '5' } }] })
    state.section = 'explain'
    state.explain.source = 'aggregation'
    expect(currentFor(TAB, 'optimise')).toEqual({ pipeline: [{ $limit: { $numberInt: '5' } }] })
  })

  it('asks before replacing a query or a validator draft, and leaves them when told no', async () => {
    mountApp(DialogHost)
    const state = useCollectionViewsStore().stateFor(TAB)
    state.draft.filter = '{ old: 1 }'
    const p = insertResult(TAB, { kind: 'query', filter: { b: { $numberInt: '2' } } }, t)
    await flushPromises()
    await dialogButton('Cancel')
    expect(await p).toBe(false)
    expect(state.draft.filter).toBe('{ old: 1 }')
    state.validationDraft = {
      text: '{ $jsonSchema: {} }',
      level: 'strict',
      action: 'error',
      base: 'v',
      tested: null,
      testedFor: '',
    }
    const v = insertResult(TAB, { kind: 'validation', validator: { $jsonSchema: { required: ['a'] } } }, t)
    await flushPromises()
    await dialogButton('Replace')
    expect(await v).toBe(true)
    expect(state.validationDraft.text).toContain('required')
    expect(state.validationDraft.text).toContain('"a"')
    expect(await insertResult(TAB, { kind: 'optimise', indexes: [] }, t)).toBe(false)
  })
})

describe('the palette (phase 4a-1)', () => {
  it('asks the assistant about the active collection tab, and opens the settings', async () => {
    mockApi({ 'GET ai/status': () => [200, STATUS], 'GET connections': () => [200, [CONN]] })
    mountApp(
      defineComponent({
        setup() {
          useWorkspaceCommands()
          return () => h('div')
        },
      }),
    )
    await flushPromises()
    const tabs = useTabsStore()
    const id = tabs.open({ kind: 'collection', title: 'shop.orders', params: target })
    useCollectionViewsStore().stateFor(id).section = 'schema'
    const command = (cid: string) => useCommandsStore().commands.find((c) => c.id === cid)!
    await command('ai.ask').run()
    expect(useWorkspaceDialogs().current).toMatchObject({ kind: 'ai', tabId: id, actions: ['describe'] })
    await command('aiSettings').run()
    expect(useTabsStore().active?.kind).toBe('aiSettings')
  })
})
