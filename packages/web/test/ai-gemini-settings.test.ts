import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AiProviderEditor from '../src/ai/AiProviderEditor.vue'
import AiSettingsView from '../src/ai/AiSettingsView.vue'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, typeInto } from './support/dom'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  document.body.innerHTML = ''
})

describe('Gemini in the provider editor (phase 4a-2 spec §2.7)', () => {
  it('offers Gemini with its address, asks for a key and a model, and refuses a model name that is not one segment', async () => {
    const { calls } = mockApi({
      'POST ai/providers': (body) => [201, { id: 'g', ...(body as object), keyStored: true }],
    })
    mountApp(AiProviderEditor, { props: { provider: null } })
    await typeInto(byLabel<HTMLInputElement>('Name'), 'Gemini')
    const kind = byLabel<HTMLSelectElement>('Kind')
    kind.value = 'gemini'
    kind.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(byLabel<HTMLInputElement>('Address').value).toBe('https://generativelanguage.googleapis.com')
    expect(byLabel<HTMLInputElement>('Model').value).toBe('')
    expect(button('Save').disabled).toBe(true)
    await typeInto(byLabel<HTMLInputElement>('Model'), '../files')
    await typeInto(byLabel<HTMLInputElement>('API key'), 'g-key')
    expect(document.body.textContent).toContain('The model name may hold letters, digits')
    expect(button('Save').disabled).toBe(true)
    await typeInto(byLabel<HTMLInputElement>('Model'), 'gemini-2.5-pro')
    expect(button('Save').disabled).toBe(false)
    button('Save').click()
    await flushPromises()
    expect(calls.at(-1)!.body).toMatchObject({
      kind: 'gemini',
      model: 'gemini-2.5-pro',
      apiKey: 'g-key',
      samples: false,
    })
  })

  it('the settings say chats are kept, sealed, for the server’s retention', async () => {
    mockApi({
      'GET ai/providers': () => [200, []],
      'GET ai/status': () => [
        200,
        {
          enabled: false,
          allowServerJs: false,
          providers: [],
          limits: { perMinute: 1, perDay: 1, perUser: 1, concurrent: 1 },
        },
      ],
    })
    mountApp(AiSettingsView)
    await flushPromises()
    // User review 2026-10-09: every request is now kept in the AI history, so the old claim is gone.
    expect(document.body.textContent).toContain(
      'Each request is kept in the AI history, encrypted and for its owner only',
    )
    expect(document.body.textContent).toContain('chats are kept the same way')
    expect(document.body.textContent).not.toContain('One-shot requests are not stored')
    expect(document.body.textContent).not.toContain('Prompts and answers are not stored')
    expect(document.body.textContent).toContain('Gemini')
  })
})
