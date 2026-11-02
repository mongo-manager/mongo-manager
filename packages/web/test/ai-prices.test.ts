import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { AiProviderView } from '@mongo-manager/shared'
import AiSettingsView from '../src/ai/AiSettingsView.vue'
import { useSessionStore } from '../src/stores/session'
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
  lastLocal: null,
  lastTestedAt: null,
  lastTest: null,
  price: null,
  ...over,
})
const SETTINGS = {
  'GET ai/history/settings': () => [200, { days: 90, keepContent: true }] as [number, unknown],
}

describe('AI prices (user, 2026-10-09: "sorgu maliyetleri … maliyetler çıkart")', () => {
  it('saves a price per million input and output tokens, in a currency; a decimal comma is a point', async () => {
    const { calls } = mockApi({
      ...SETTINGS,
      'GET ai/providers': () => [200, []],
      'POST ai/providers': (body) => [201, P(body as Partial<AiProviderView>)],
    })
    mountApp(AiSettingsView)
    await flushPromises()
    button('Add provider').click()
    await flushPromises()
    await typeInto(byLabel('Name'), 'Claude')
    await typeInto(byLabel('API key'), 'sk-ant-new')
    await typeInto(byLabel('Input price per 1M tokens'), '3')
    await typeInto(byLabel('Output price per 1M tokens'), '0,25')
    const currency = byLabel<HTMLSelectElement>('Currency')
    currency.value = 'EUR'
    currency.dispatchEvent(new Event('change'))
    await flushPromises()
    button('Save').click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
      price: { input: 3, output: 0.25, currency: 'EUR' },
    })
  })

  it('sends no price when none is typed, and refuses half a price or a word', async () => {
    const { calls } = mockApi({
      ...SETTINGS,
      'GET ai/providers': () => [200, []],
      'POST ai/providers': (body) => [201, P(body as Partial<AiProviderView>)],
    })
    mountApp(AiSettingsView)
    await flushPromises()
    button('Add provider').click()
    await flushPromises()
    await typeInto(byLabel('Name'), 'Claude')
    await typeInto(byLabel('API key'), 'sk-ant-new')
    await typeInto(byLabel('Input price per 1M tokens'), '3')
    expect(button('Save').disabled).toBe(true)
    expect(document.body.textContent).toContain('Enter both prices, or neither.')
    // The fields say they are wrong, and where the reason is.
    const input = byLabel('Input price per 1M tokens')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById(input.getAttribute('aria-describedby')!)!.textContent).toContain(
      'Enter both prices',
    )
    await typeInto(byLabel('Output price per 1M tokens'), 'free')
    expect(button('Save').disabled).toBe(true)
    await typeInto(byLabel('Output price per 1M tokens'), '-1')
    expect(button('Save').disabled).toBe(true)
    await typeInto(byLabel('Input price per 1M tokens'), '')
    await typeInto(byLabel('Output price per 1M tokens'), '')
    button('Save').click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'POST')!.body).not.toHaveProperty('price')
  })

  it('patches the price only when it changed, and clears it with null', async () => {
    const { calls } = mockApi({
      ...SETTINGS,
      'GET ai/providers': () => [200, [P({ price: { input: 3, output: 15, currency: 'USD' } })]],
      'PATCH ai/providers/p1': (body) => [200, P(body as Partial<AiProviderView>)],
    })
    mountApp(AiSettingsView)
    await flushPromises()
    // The card says what a million tokens cost.
    expect(document.querySelector('[data-provider-price]')!.textContent).toMatch(/\$3\.00.*\$15\.00/)
    button('Edit').click()
    await flushPromises()
    expect(byLabel<HTMLInputElement>('Input price per 1M tokens').value).toBe('3')
    await typeInto(byLabel('Model'), 'claude-opus-5-5')
    button('Save').click()
    await flushPromises()
    expect(calls.filter((c) => c.method === 'PATCH').at(-1)!.body).toEqual({ model: 'claude-opus-5-5' })
    button('Edit').click()
    await flushPromises()
    await typeInto(byLabel('Input price per 1M tokens'), '')
    await typeInto(byLabel('Output price per 1M tokens'), '')
    button('Save').click()
    await flushPromises()
    expect(calls.filter((c) => c.method === 'PATCH').at(-1)!.body).toEqual({ price: null })
  })

  it('has the AI history counted again once a provider is saved', async () => {
    mockApi({
      ...SETTINGS,
      'GET ai/providers': () => [200, [P()]],
      'PATCH ai/providers/p1': (body) => [200, P(body as Partial<AiProviderView>)],
    })
    const { queryClient } = mountApp(AiSettingsView)
    await flushPromises()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    button('Edit').click()
    await flushPromises()
    await typeInto(byLabel('Input price per 1M tokens'), '1')
    await typeInto(byLabel('Output price per 1M tokens'), '2')
    button('Save').click()
    await flushPromises()
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['ai', 'history'] })
  })
})

describe('AI history settings (user: "90 gün tutulsun, ayarlardan değiştirilebilir olsun")', () => {
  it('shows the days kept and saves a change, and keeping no words', async () => {
    const { calls } = mockApi({
      ...SETTINGS,
      'GET ai/providers': () => [200, []],
      'PUT ai/history/settings': (body) => [200, body],
    })
    mountApp(AiSettingsView)
    await flushPromises()
    const days = byLabel<HTMLInputElement>('Days kept')
    expect(days.value).toBe('90')
    await typeInto(days, '30')
    const keep = byLabel<HTMLInputElement>('Keep what was asked and answered')
    expect(keep.checked).toBe(true)
    keep.click()
    await flushPromises()
    button('Save history settings').click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ days: 30, keepContent: false })
  })

  it('saves on Enter only a change, and only once', async () => {
    const { calls } = mockApi({
      ...SETTINGS,
      'GET ai/providers': () => [200, []],
      'PUT ai/history/settings': (body) => [200, body],
    })
    mountApp(AiSettingsView)
    await flushPromises()
    const form = document.querySelector('[data-ai-history-settings] form') as HTMLFormElement
    form.dispatchEvent(new Event('submit'))
    await flushPromises()
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0)
    await typeInto(byLabel('Days kept'), '30')
    form.dispatchEvent(new Event('submit'))
    form.dispatchEvent(new Event('submit'))
    await flushPromises()
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1)
  })

  it('refuses days outside 1 to 3650', async () => {
    mockApi({ ...SETTINGS, 'GET ai/providers': () => [200, []] })
    mountApp(AiSettingsView)
    await flushPromises()
    await typeInto(byLabel('Days kept'), '0')
    expect(button('Save history settings').disabled).toBe(true)
    await typeInto(byLabel('Days kept'), '4000')
    expect(button('Save history settings').disabled).toBe(true)
  })
})
