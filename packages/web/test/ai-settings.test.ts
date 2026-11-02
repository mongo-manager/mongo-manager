/* eslint-disable vue/one-component-per-file -- each test mounts its own small host */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, reactive } from 'vue'
import GeneralSection from '../src/connections/sections/GeneralSection.vue'
import { provideConnectionForm } from '../src/connections/formContext'
import { isRenderedConnectionField } from '../src/connections/fieldPaths'
import { createPinia, setActivePinia } from 'pinia'
import type { AiProviderView } from '@mongo-manager/shared'
import AiSettingsView from '../src/ai/AiSettingsView.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import ToastHost from '../src/ds/DsToastHost.vue'
import { useSessionStore } from '../src/stores/session'
import {
  emptyForm,
  formFromDto,
  inputFromForm,
  patchFromForm,
  settingsFromForm,
} from '../src/connections/formModel'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, check, typeInto } from './support/dom'

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
  lastLocal: false,
  lastTestedAt: Date.UTC(2026, 9, 6, 9),
  lastTest: 'ok',
  price: null,
  ...over,
})

describe('Settings → AI assistant (phase 4a-1 spec §6)', () => {
  it('shows each provider’s kind, model, place, samples, default and last test', async () => {
    mockApi({
      'GET ai/providers': () => [
        200,
        [
          P(),
          P({
            id: 'p2',
            name: 'Ollama',
            kind: 'ollama',
            model: 'llama3.3',
            keyStored: false,
            isDefault: false,
            lastLocal: true,
            samples: true,
            lastTest: 'unreachable',
          }),
        ],
      ],
    })
    mountApp(AiSettingsView)
    await flushPromises()
    const cards = [...document.querySelectorAll('[data-provider]')]
    expect(cards).toHaveLength(2)
    for (const part of ['Claude', 'claude-sonnet-5', 'Cloud', 'Default', 'Answered (Oct 6, 2026'])
      expect(cards[0]!.textContent, part).toContain(part)
    expect(cards[1]!.textContent).toMatch(/Ollama.*Local.*Samples allowed.*cannot be reached/s)
    // UI review: names and models wrap instead of being cut.
    for (const el of cards[0]!.querySelectorAll('h3, h3 + p')) expect(el.className).not.toContain('truncate')
  })

  it('adds a provider with a write-only key, and never shows a stored one', async () => {
    const { calls } = mockApi({
      'GET ai/providers': () => [200, []],
      'POST ai/providers': (body) => [201, P({ ...(body as object) })],
    })
    mountApp(AiSettingsView)
    mountApp(DialogHost)
    await flushPromises()
    button('Add provider').click()
    await flushPromises()
    // UI review: the editor's fields sit two to a row on a wide screen.
    expect(document.querySelector('[data-ai-editor]')!.className).toContain('sm:grid-cols-2')
    await typeInto(byLabel('Name'), 'Claude')
    await typeInto(byLabel('API key'), 'sk-ant-new')
    button('Save').click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
      name: 'Claude',
      kind: 'anthropic',
      apiKey: 'sk-ant-new',
      maxTokens: 2048,
    })
    expect(document.body.innerHTML).not.toContain('sk-ant-new')
  })

  it('asks for the key again when the address changes, and sends no key otherwise', async () => {
    const { calls } = mockApi({
      'GET ai/providers': () => [200, [P()]],
      'PATCH ai/providers/p1': (body) => [200, P(body as Partial<AiProviderView>)],
    })
    mountApp(AiSettingsView)
    await flushPromises()
    button('Edit').click()
    await flushPromises()
    await typeInto(byLabel('Model'), 'claude-opus-5-5')
    button('Save').click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ model: 'claude-opus-5-5' })
    button('Edit').click()
    await flushPromises()
    await typeInto(byLabel('Address'), 'https://gw.example/anthropic')
    expect(document.body.textContent).toContain('Enter the key again: it belongs to the previous address.')
    expect(button('Save').disabled).toBe(true)
  })

  it('tests a provider and says the outcome in words', async () => {
    mockApi({
      'GET ai/providers': () => [200, [P()]],
      'POST ai/providers/p1/test': () => [200, { outcome: 'key_refused', local: false, ms: 120 }],
    })
    mountApp(AiSettingsView)
    mountApp(ToastHost)
    await flushPromises()
    button('Test').click()
    await flushPromises()
    expect(document.body.textContent).toContain('The provider refused its key.')
  })
})

const DTO = {
  id: 'c1',
  name: 'C',
  group: null,
  color: null,
  favorite: false,
  readOnly: false,
  aiPolicy: 'any',
  settings: settingsFromForm(emptyForm()),
  uri: '',
  createdAt: 0,
  updatedAt: 0,
  lastUsedAt: null,
  access: 'admin',
  permissions: [],
}

describe('the connection’s AI policy (phase 4a-1 spec §2.4)', () => {
  it('is any by default and travels with create and patch', () => {
    const f = emptyForm()
    expect(f.aiPolicy).toBe('any')
    f.aiPolicy = 'local'
    expect(inputFromForm(f)).toMatchObject({ aiPolicy: 'local' })
    expect(patchFromForm(f)).toMatchObject({ aiPolicy: 'local' })
    const dto = {
      id: 'c1',
      name: 'C',
      group: null,
      color: null,
      favorite: false,
      readOnly: false,
      aiPolicy: 'off',
      settings: settingsFromForm(emptyForm()),
      uri: '',
      createdAt: 0,
      updatedAt: 0,
      lastUsedAt: null,
      access: 'admin',
      permissions: [],
    }
    expect(formFromDto(dto as never).aiPolicy).toBe('off')
  })
})

describe('choosing a model from the provider’s list (user, 2026-10-09)', () => {
  it('fetches the models with the saved key, and fills the model in from the list', async () => {
    const { calls } = mockApi({
      'GET ai/providers': () => [200, [P()]],
      'POST ai/models': () => [
        200,
        {
          outcome: 'ok',
          models: [
            { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
            { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
          ],
        },
      ],
      'PATCH ai/providers/p1': (body) => [200, P(body as Partial<AiProviderView>)],
    })
    mountApp(AiSettingsView)
    await flushPromises()
    button('Edit').click()
    await flushPromises()
    button('Fetch models').click()
    await flushPromises()
    // The saved key is the server's to use: the browser sends which provider, never a key.
    expect(calls.find((c) => c.path === 'ai/models')!.body).toEqual({
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      providerId: 'p1',
    })
    ;(document.querySelector('button[aria-label="Choose a model"]') as HTMLButtonElement).click()
    await flushPromises()
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) =>
      o.textContent?.includes('Claude Opus 5.5'),
    )!
    option.click()
    await flushPromises()
    expect(byLabel<HTMLInputElement>('Model').value).toBe('claude-opus-5-5')
    button('Save').click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ model: 'claude-opus-5-5' })
  })

  it('sends a newly typed key for the list, and says why no list came', async () => {
    const { calls } = mockApi({
      'GET ai/providers': () => [200, []],
      'POST ai/models': () => [200, { outcome: 'key_refused', models: [] }],
    })
    mountApp(AiSettingsView)
    await flushPromises()
    button('Add provider').click()
    await flushPromises()
    await typeInto(byLabel('API key'), 'sk-ant-typed')
    button('Fetch models').click()
    await flushPromises()
    expect(calls.find((c) => c.path === 'ai/models')!.body).toMatchObject({
      kind: 'anthropic',
      apiKey: 'sk-ant-typed',
    })
    expect(document.querySelector('[data-models-error]')!.textContent).toMatch(/key/i)
    expect(document.querySelector('button[aria-label="Choose a model"]')).toBeNull()
  })
})

// Design 2026-10-25 (C5): the agent's tools an administrator turns off on a connection.
describe('the agent’s tools on a connection (C5)', () => {
  it('lists each tool, reads and changes apart, and sends the ones turned off with the save', async () => {
    const form = reactive(emptyForm())
    const Host = defineComponent({
      setup() {
        provideConnectionForm({
          form,
          errorFor: () => undefined,
          secretHint: () => undefined,
          connectionString: {} as never,
          editing: true,
          focusName: false,
          openSection: () => {},
        })
        return () => h(GeneralSection)
      },
    })
    mountApp(Host)
    await flushPromises()
    const tools = document.querySelector<HTMLDetailsElement>('[data-agent-tools]')!
    expect(tools.querySelector('[data-agent-tools-count]')!.textContent).toContain('All on')
    const box = (tool: string) =>
      tools.querySelector<HTMLInputElement>(`[data-agent-tool="${tool}"] input[type="checkbox"]`)!
    expect(box('find_documents').checked).toBe(true)
    // Review of C5 (I3): a tool that names no connection has nothing to turn off here.
    expect(tools.querySelector('[data-agent-tool="list_connections"]')).toBeNull()
    expect(tools.querySelector('[data-agent-tool="plan_changes"]')).toBeNull()
    // Review of C5 (minor 4): in the agent's order whatever the clicks' (a form toggled back is unchanged).
    await check(box('drop_collection'), false)
    await check(box('find_documents'), false)
    expect(tools.querySelector('[data-agent-tools-count]')!.textContent).toContain('2 off')
    expect(patchFromForm(form)).toMatchObject({ aiAgentToolsOff: ['find_documents', 'drop_collection'] })
    expect(inputFromForm(form)).toMatchObject({ aiAgentToolsOff: ['find_documents', 'drop_collection'] })
    await check(box('find_documents'), true)
    expect(patchFromForm(form)).toMatchObject({ aiAgentToolsOff: ['drop_collection'] })
    // Changes are moot while the agent may change nothing here.
    form.aiAgentWrites = false
    await flushPromises()
    expect(box('drop_collection').disabled).toBe(true)
    expect(box('find_documents').disabled).toBe(false)
    // Review of C5 (minor 5): said why.
    const why = tools.querySelector<HTMLElement>('[data-agent-tools-writes-off]')!
    expect(why.closest('fieldset')!.getAttribute('aria-describedby')).toBe(why.id)
    // As the connection keeps them.
    expect(
      formFromDto({ ...(DTO as object), aiAgentToolsOff: ['list_users'] } as never).aiAgentToolsOff,
    ).toEqual(['list_users'])
  })
})

// Second review of C5 (M2): a save refused for one of the tools opens the list and says why.
describe('the agent’s tools refused on a save (second review of C5)', () => {
  it('opens the list and shows the error of one of its items', async () => {
    const form = reactive(emptyForm())
    const errors = reactive<Record<string, string>>({})
    const Host = defineComponent({
      setup() {
        provideConnectionForm({
          form,
          errorFor: (key) => errors[key],
          secretHint: () => undefined,
          connectionString: {} as never,
          editing: true,
          focusName: false,
          openSection: () => {},
        })
        return () => h(GeneralSection)
      },
    })
    mountApp(Host)
    await flushPromises()
    const tools = document.querySelector<HTMLDetailsElement>('[data-agent-tools]')!
    expect(tools.open).toBe(false)
    errors['aiAgentToolsOff.2'] = 'Invalid option'
    await flushPromises()
    expect(tools.open).toBe(true)
    expect(tools.querySelector('[data-agent-tools-error]')!.textContent).toContain('Invalid option')
    expect(isRenderedConnectionField('aiAgentToolsOff.2')).toBe(true)
  })
})
