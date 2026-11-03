import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AgentModeSetting from '../src/account/AgentModeSetting.vue'
import AiAgentPolicySettings from '../src/ai/AiAgentPolicySettings.vue'
import ToastHost from '../src/ds/DsToastHost.vue'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { useDialogStore } from '../src/stores/dialogs'

/** The AI database manager (design 2026-10-25, A2): the switch in settings, and the server's policy. */
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const preference = (on: boolean, available: boolean, policy: 'off' | 'read' | 'full', assistant = true) => ({
  on,
  available,
  assistant,
  policy,
})

describe('the person’s agent switch in Account → Preferences', () => {
  it('is offered where the agent is available, and saved at once', async () => {
    let on = false
    const { calls } = mockApi({
      'GET me/ai-agent': () => [200, preference(on, true, 'full')],
      'PUT me/ai-agent': (body) => {
        on = (body as { on: boolean }).on
        return [200, preference(on, true, 'full')]
      },
    })
    mountApp(AgentModeSetting)
    await flushPromises()
    const input = document.querySelector<HTMLInputElement>('[data-agent-mode-setting] input')!
    expect(input.checked).toBe(false)
    input.click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({ path: 'me/ai-agent', body: { on: true } })
    expect(input.checked).toBe(true)
  })

  // Review of A2 (minor 12): the switch is shown turned off and not to be turned, with the reason.
  it('says an administrator turned it off, the switch off and disabled', async () => {
    mockApi({ 'GET me/ai-agent': () => [200, preference(true, false, 'off')] })
    mountApp(AgentModeSetting)
    await flushPromises()
    const input = document.querySelector<HTMLInputElement>('[data-agent-mode-setting] input')!
    expect(input.disabled).toBe(true)
    expect(input.checked).toBe(false)
    expect(document.body.textContent).toContain('An administrator turned agent mode off on this server.')
  })

  it('says the agent may only read here', async () => {
    mockApi({ 'GET me/ai-agent': () => [200, preference(true, true, 'read')] })
    mountApp(AgentModeSetting)
    await flushPromises()
    expect(document.body.textContent).toContain('read only')
  })

  // Review of A2 (minor 11): where the assistant itself is not available, nothing — off or not.
  it('shows nothing where the assistant is not available', async () => {
    mockApi({ 'GET me/ai-agent': () => [200, preference(false, false, 'off', false)] })
    mountApp(AgentModeSetting)
    await flushPromises()
    expect(document.querySelector('[data-agent-mode-setting]')).toBeNull()
  })
})

describe('the agent’s policy in AI settings, an administrator’s', () => {
  it('shows the policy and saves a change at once', async () => {
    let policy = 'full'
    const { calls } = mockApi({
      'GET ai/agent-policy': () => [200, { policy }],
      'PUT ai/agent-policy': (body) => {
        policy = (body as { policy: string }).policy
        return [200, { policy }]
      },
    })
    mountApp(AiAgentPolicySettings)
    mountApp(ToastHost)
    await flushPromises()
    const radios = [...document.querySelectorAll<HTMLButtonElement>('[data-agent-policy] [role="radio"]')]
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true'])
    // Review of A2 (I3): narrowing it for everyone is asked first — a click or an arrow key alike.
    radios[1]!.click()
    await vi.waitFor(() => expect(useDialogStore().current).not.toBeNull())
    useDialogStore().settle(true)
    await flushPromises()
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
      path: 'ai/agent-policy',
      body: { policy: 'read' },
    })
    expect(document.body.textContent).toContain('Saved.')
  })

  it('changes nothing when the narrowing is not confirmed, an arrow key included', async () => {
    const { calls } = mockApi({ 'GET ai/agent-policy': () => [200, { policy: 'full' }] })
    mountApp(AiAgentPolicySettings)
    await flushPromises()
    const full = document.querySelector<HTMLButtonElement>(
      '[data-agent-policy] [role="radio"][aria-checked="true"]',
    )!
    full.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await vi.waitFor(() => expect(useDialogStore().current).not.toBeNull())
    useDialogStore().settle(false)
    await flushPromises()
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
    const checked = [...document.querySelectorAll('[data-agent-policy] [role="radio"]')].map((r) =>
      r.getAttribute('aria-checked'),
    )
    expect(checked).toEqual(['false', 'false', 'true'])
  })

  it('widens it again without asking, and says a failure', async () => {
    const { calls } = mockApi({
      'GET ai/agent-policy': () => [200, { policy: 'off' }],
      'PUT ai/agent-policy': () => [500, { code: 'INTERNAL', message: 'Not saved' }],
    })
    mountApp(AiAgentPolicySettings)
    mountApp(ToastHost)
    await flushPromises()
    const radios = [...document.querySelectorAll<HTMLButtonElement>('[data-agent-policy] [role="radio"]')]
    radios[2]!.click()
    await flushPromises()
    expect(useDialogStore().current).toBeNull()
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1)
    expect(document.body.textContent).not.toContain('Saved.')
    // Second re-review (minor 7): the failure is said.
    expect(document.querySelector('[data-toast][role="alert"]')).not.toBeNull()
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
  })

  // Re-review (nit): a second choice while the question is open is not a second question.
  it('asks once while a narrowing is being asked', async () => {
    const { calls } = mockApi({
      'GET ai/agent-policy': () => [200, { policy: 'full' }],
      'PUT ai/agent-policy': () => [200, { policy: 'read' }],
    })
    mountApp(AiAgentPolicySettings)
    await flushPromises()
    const radios = [...document.querySelectorAll<HTMLButtonElement>('[data-agent-policy] [role="radio"]')]
    radios[1]!.click()
    await vi.waitFor(() => expect(useDialogStore().current).not.toBeNull())
    radios[0]!.click()
    await flushPromises()
    useDialogStore().settle(true)
    await flushPromises()
    expect(useDialogStore().current).toBeNull()
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([{ policy: 'read' }])
  })
})
